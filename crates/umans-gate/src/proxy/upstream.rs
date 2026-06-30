//! Upstream provider client — hyper-rustls + pooled hyper-util client.
//!
//! Request and response bodies stream chunk-by-chunk: the caller's body is
//! boxed into a `BoxBody` (no buffering into a single `Bytes`), and the
//! upstream response is returned with its `hyper::body::Incoming` intact for
//! the caller to drain incrementally.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::BodyExt;
use hyper::body::{Body, Incoming};
use hyper::{HeaderMap, Method, Request, StatusCode};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use url::Url;

use crate::error::{GatewayError, Result};

/// Boxed error alias for request bodies (accepts axum::Error, hyper::Error, etc.).
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Pooled HTTPS client backed by hyper-rustls (webpki roots, http1 only).
///
/// Pool: idle timeout 90s, max 32 idle per host.
pub struct UpstreamClient {
    client: Client<HttpsConnector<HttpConnector>, UnsyncBoxBody<Bytes, BoxError>>,
}

/// Forwarded upstream response — status, headers, streaming body.
pub struct UpstreamResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Incoming,
    pub version: hyper::Version,
}

impl UpstreamClient {
    /// Build a pooled client: webpki roots, http1 only, 90s idle, 32/host.
    pub fn new() -> Self {
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .build();

        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(32)
            .build(https);

        Self { client }
    }
}

/// Hop-by-hop headers to strip per RFC 7230 §6.1.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "trailer",
];

fn host_for_url(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

impl UpstreamClient {
    /// Forward a request to `uri`, streaming the body without buffering.
    ///
    /// The request body is boxed (`BoxBody<Bytes, hyper::Error>`) so any
    /// `Body<Data = Bytes, Error = hyper::Error>` is accepted. The response
    /// body (`hyper::body::Incoming`) is returned un-drained for streaming.
    ///
    /// Before forwarding, hop-by-hop headers are stripped (including any
    /// headers named in the incoming `Connection` header), and the `Host`
    /// header is rewritten to the host of `upstream_url`.
    pub async fn forward(
        &self,
        method: Method,
        uri: String,
        upstream_url: &Url,
        headers: HeaderMap,
        body: impl Body<Data = Bytes, Error: Into<BoxError>> + Send + 'static,
    ) -> Result<UpstreamResponse> {
        let body = body.map_err(|e| -> BoxError { e.into() }).boxed_unsync();
        let mut req = Request::new(body);
        *req.method_mut() = method;
        *req.uri_mut() = uri
            .parse()
            .map_err(|e| GatewayError::Upstream(format!("invalid uri: {e}")))?;
        *req.headers_mut() = sanitize_headers(headers, upstream_url);

        let resp = self
            .client
            .request(req)
            .await
            .map_err(|e| GatewayError::Upstream(format!("{e}")))?;

        let (parts, incoming) = resp.into_parts();
        Ok(UpstreamResponse {
            status: parts.status,
            headers: parts.headers,
            body: incoming,
            version: parts.version,
        })
    }
}

fn sanitize_headers(mut headers: HeaderMap, upstream_url: &Url) -> HeaderMap {
    let mut to_remove: Vec<hyper::header::HeaderName> = Vec::new();
    let mut connection_listed: Vec<String> = Vec::new();

    for (name, value) in headers.iter() {
        let name_lower = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&name_lower.as_str()) {
            to_remove.push(name.clone());
        }
        if name_lower == "connection" {
            if let Ok(value_str) = value.to_str() {
                for token in value_str.split(',') {
                    connection_listed.push(token.trim().to_ascii_lowercase());
                }
            }
        }
    }

    for token in connection_listed {
        if let Ok(name) = token.parse::<hyper::header::HeaderName>() {
            to_remove.push(name);
        }
    }

    for name in to_remove {
        headers.remove(name);
    }

    headers.insert(
        hyper::header::HOST,
        host_for_url(upstream_url)
            .parse()
            .expect("valid host header value"),
    );

    headers
}

impl Default for UpstreamClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use url::Url;

    fn spawn_capture(listener: TcpListener, response: &'static [u8]) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let captured = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = tx.send(captured);
            sock.write_all(response).await.unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        rx
    }

    fn has_header(captured: &str, name: &str) -> bool {
        let lower = captured.to_ascii_lowercase();
        let prefix = format!("\r\n{}: ", name.to_ascii_lowercase());
        lower.contains(&prefix) || lower.starts_with(&format!("{}: ", name.to_ascii_lowercase()))
    }

    fn header_value<'a>(captured: &'a str, name: &str) -> Option<&'a str> {
        let lower_name = name.to_ascii_lowercase();
        for line in captured.split("\r\n") {
            if let Some((k, v)) = line.split_once(": ") {
                if k.eq_ignore_ascii_case(&lower_name) {
                    return Some(v);
                }
            }
        }
        None
    }

    #[test]
    fn new_builds_client() {
        let _client = UpstreamClient::new();
    }

    #[test]
    fn default_equals_new() {
        let _a = UpstreamClient::default();
    }

    #[tokio::test]
    async fn forward_streams_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_capture(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let client = UpstreamClient::new();
        let body = http_body_util::Empty::<Bytes>::new();
        let uri = format!("http://127.0.0.1:{port}/");
        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let resp = client
            .forward(Method::GET, uri, &upstream_url, HeaderMap::new(), body)
            .await
            .expect("forward succeeds");

        assert_eq!(resp.status, StatusCode::OK);
        assert_eq!(resp.headers.get("content-length").unwrap(), "5");

        let collected = resp.body.collect().await.expect("body drains");
        let bytes = collected.to_bytes();
        assert_eq!(&bytes[..], b"hello");
        let _ = rx.await.unwrap();
    }

    #[tokio::test]
    async fn hop_by_hop_stripped() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_capture(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let mut headers = HeaderMap::new();
        headers.insert("Connection", "keep-alive".parse().unwrap());
        headers.insert("Keep-Alive", "timeout=30".parse().unwrap());
        headers.insert("Transfer-Encoding", "chunked".parse().unwrap());
        headers.insert("TE", "trailers".parse().unwrap());
        headers.insert("Upgrade", "h2c".parse().unwrap());
        headers.insert("Proxy-Authenticate", "Basic".parse().unwrap());
        headers.insert("Proxy-Authorization", "Basic xxx".parse().unwrap());
        headers.insert("Trailer", "X-Trailer".parse().unwrap());
        headers.insert("Authorization", "Bearer sk-test".parse().unwrap());

        let client = UpstreamClient::new();
        let body = http_body_util::Empty::<Bytes>::new();
        let uri = format!("http://127.0.0.1:{port}/v1/chat/completions");
        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let resp = client
            .forward(Method::POST, uri, &upstream_url, headers, body)
            .await
            .expect("forward succeeds");

        assert_eq!(resp.status, StatusCode::OK);

        let captured = rx.await.unwrap();
        for name in HOP_BY_HOP {
            assert!(
                !has_header(&captured, name),
                "hop-by-hop header {name} should be stripped"
            );
        }
        assert!(
            has_header(&captured, "authorization"),
            "authorization should be preserved"
        );
    }

    #[tokio::test]
    async fn host_rewritten() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_capture(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let mut headers = HeaderMap::new();
        headers.insert("Host", "localhost:8080".parse().unwrap());

        let client = UpstreamClient::new();
        let body = http_body_util::Empty::<Bytes>::new();
        let uri = format!("http://127.0.0.1:{port}/v1/models/info");
        let upstream_url = Url::parse("https://api.code.umans.ai").unwrap();
        let resp = client
            .forward(Method::GET, uri, &upstream_url, headers, body)
            .await
            .expect("forward succeeds");

        assert_eq!(resp.status, StatusCode::OK);

        let captured = rx.await.unwrap();
        assert_eq!(
            header_value(&captured, "Host"),
            Some("api.code.umans.ai"),
            "Host should be rewritten to upstream_url host"
        );
    }

    #[tokio::test]
    async fn auth_preserved() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_capture(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let mut headers = HeaderMap::new();
        headers.insert("Authorization", "Bearer sk-test123".parse().unwrap());
        headers.insert("Content-Type", "application/json".parse().unwrap());
        headers.insert("Content-Length", "0".parse().unwrap());

        let client = UpstreamClient::new();
        let body = http_body_util::Empty::<Bytes>::new();
        let uri = format!("http://127.0.0.1:{port}/v1/chat/completions");
        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let resp = client
            .forward(Method::POST, uri, &upstream_url, headers, body)
            .await
            .expect("forward succeeds");

        assert_eq!(resp.status, StatusCode::OK);

        let captured = rx.await.unwrap();
        assert_eq!(
            header_value(&captured, "Authorization"),
            Some("Bearer sk-test123")
        );
        assert!(has_header(&captured, "content-type"));
        assert!(has_header(&captured, "content-length"));
    }

    #[tokio::test]
    async fn connection_listed_headers_stripped() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_capture(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let mut headers = HeaderMap::new();
        headers.insert(
            "Connection",
            "X-Custom-Hop-Header, keep-alive".parse().unwrap(),
        );
        headers.insert("X-Custom-Hop-Header", "value".parse().unwrap());
        headers.insert("Keep-Alive", "timeout=30".parse().unwrap());
        headers.insert("X-Preserved-Header", "preserved".parse().unwrap());

        let client = UpstreamClient::new();
        let body = http_body_util::Empty::<Bytes>::new();
        let uri = format!("http://127.0.0.1:{port}/");
        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let resp = client
            .forward(Method::GET, uri, &upstream_url, headers, body)
            .await
            .expect("forward succeeds");

        assert_eq!(resp.status, StatusCode::OK);

        let captured = rx.await.unwrap();
        assert!(!has_header(&captured, "x-custom-hop-header"));
        assert!(!has_header(&captured, "keep-alive"));
        assert!(!has_header(&captured, "connection"));
        assert!(has_header(&captured, "x-preserved-header"));
    }
}
