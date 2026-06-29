//! Proxy error response builders and middleware.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{Request, StatusCode};
use axum::response::Response;
use serde_json::json;
use tower::{Layer, Service};

use crate::error::GatewayError;
use crate::types::ProviderId;

const FALLBACK_BODY: &[u8] =
    b"{\"error\":{\"type\":\"internal\",\"message\":\"failed to build error response\"}}";

/// 503 Service Unavailable response for a provider concurrency limit.
pub fn concurrency_error(provider: &ProviderId) -> Response {
    json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({
            "error": {
                "type": "concurrency_limit",
                "message": format!("concurrency limit exceeded for provider {provider}"),
            }
        }),
        Some("30"),
    )
}

/// Response with the given upstream status and an `upstream_error` JSON body.
pub fn upstream_error(status: StatusCode, message: &str) -> Response {
    json_response(
        status,
        json!({
            "error": {
                "type": "upstream_error",
                "message": message,
            }
        }),
        None,
    )
}

/// 504 Gateway Timeout response for a provider timeout.
pub fn timeout_error(provider: &ProviderId) -> Response {
    json_response(
        StatusCode::GATEWAY_TIMEOUT,
        json!({
            "error": {
                "type": "timeout",
                "message": format!("upstream timeout for provider {provider}"),
            }
        }),
        None,
    )
}

/// 404 Not Found response with a `not_found` JSON body.
pub fn not_found(path: &str) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({
            "error": {
                "type": "not_found",
                "message": format!("unknown path: {path}"),
            }
        }),
        None,
    )
}

fn json_response(
    status: StatusCode,
    body: serde_json::Value,
    retry_after: Option<&'static str>,
) -> Response {
    let bytes = match serde_json::to_vec(&body) {
        Ok(v) => v,
        Err(_) => FALLBACK_BODY.to_vec(),
    };

    let mut response = match Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )
        .body(Body::from(bytes))
    {
        Ok(resp) => resp,
        Err(_) => return Response::new(Body::from(FALLBACK_BODY)),
    };

    if let Some(secs) = retry_after {
        response.headers_mut().insert(
            header::RETRY_AFTER,
            // Literal value is always a valid header value.
            HeaderValue::from_static(secs),
        );
    }

    response
}

/// 400 Bad Request response for a dashboard-killed request.
///
/// Body: `{"error":{"type":"request_cancelled","message":"Request killed from umans dashboard"}}`
/// Header: `X-Umans-Stop-Reason: cancelled`
pub fn cancelled_error() -> Response {
    let mut resp = json_response(
        StatusCode::BAD_REQUEST,
        json!({
            "error": {
                "type": "request_cancelled",
                "message": "Request killed from umans dashboard",
            }
        }),
        None,
    );
    resp.headers_mut().insert(
        HeaderName::from_static("x-umans-stop-reason"),
        HeaderValue::from_static("cancelled"),
    );
    resp
}

fn map_gateway_error(err: GatewayError) -> Response {
    match err {
        GatewayError::ConcurrencyLimit { provider } => {
            concurrency_error(&ProviderId::new(provider))
        }
        GatewayError::Timeout(provider) => timeout_error(&ProviderId::new(provider)),
        GatewayError::UnknownProvider(path) => not_found(&path),
        GatewayError::Validation(message) => not_found(&message),
        GatewayError::Upstream(message) => upstream_error(StatusCode::BAD_GATEWAY, &message),
        GatewayError::Io(_) | GatewayError::Config(_) | GatewayError::UnknownModel { .. } => {
            upstream_error(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
        }
        GatewayError::Cancelled => cancelled_error(),
    }
}

/// Axum integration: map [`GatewayError`] to a JSON response so handlers can
/// return `Result<Response, GatewayError>` directly. Mirrors [`ErrorMiddleware`]
/// (the Tower-side equivalent used in service pipelines).
impl axum::response::IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        map_gateway_error(self)
    }
}

/// [`Layer`] that installs [`ErrorMiddleware`] over a service whose errors are
/// [`GatewayError`]. The middleware converts every error into an OpenAI-style
/// JSON response.
#[derive(Clone, Copy, Debug, Default)]
pub struct ErrorLayer;

impl<S> Layer<S> for ErrorLayer
where
    S: Service<Request<Body>, Response = Response, Error = GatewayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Service = ErrorMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ErrorMiddleware { inner }
    }
}

/// Tower service that catches [`GatewayError`] from the inner service and maps
/// each variant to an appropriate JSON response.
#[derive(Clone)]
pub struct ErrorMiddleware<S> {
    inner: S,
}

impl<S> Service<Request<Body>> for ErrorMiddleware<S>
where
    S: Service<Request<Body>, Response = Response, Error = GatewayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        match self.inner.poll_ready(cx) {
            Poll::Ready(Ok(())) => Poll::Ready(Ok(())),
            // Readiness failures are surfaced as an error response on the next call.
            Poll::Ready(Err(_)) => Poll::Ready(Ok(())),
            Poll::Pending => Poll::Pending,
        }
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);

        Box::pin(async move {
            Ok(match inner.call(req).await {
                Ok(response) => response,
                Err(err) => map_gateway_error(err),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::future::ready;
    use std::io;

    use http_body_util::BodyExt;
    use serde_json::Value;

    use super::*;

    async fn body_json(resp: Response) -> Value {
        let bytes = resp
            .into_body()
            .collect()
            .await
            .expect("body collection should succeed")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("body should be valid JSON")
    }

    #[test]
    fn concurrency_error_returns_503() {
        let resp = concurrency_error(&ProviderId::new("openai"));

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            resp.headers().get(header::RETRY_AFTER),
            Some(&HeaderValue::from_static("30"))
        );
    }

    #[tokio::test]
    async fn concurrency_error_body_shape() {
        let resp = concurrency_error(&ProviderId::new("openai"));
        let json = body_json(resp).await;

        assert_eq!(json["error"]["type"], "concurrency_limit");
        assert!(json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("openai"));
        assert_eq!(
            json["error"].as_object().unwrap().len(),
            2,
            "error object should contain only type and message"
        );
    }

    #[tokio::test]
    async fn upstream_error_body_shape() {
        let resp = upstream_error(StatusCode::BAD_GATEWAY, "upstream broke");

        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/json"))
        );

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "upstream_error");
        assert_eq!(json["error"]["message"], "upstream broke");
    }

    #[tokio::test]
    async fn timeout_error_returns_504() {
        let resp = timeout_error(&ProviderId::new("anthropic"));

        assert_eq!(resp.status(), StatusCode::GATEWAY_TIMEOUT);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "timeout");
        assert!(json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("anthropic"));
    }

    #[tokio::test]
    async fn not_found_returns_404() {
        let resp = not_found("/missing");

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "not_found");
        assert!(json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("/missing"));
    }

    #[derive(Clone, Copy)]
    struct OkSvc;

    impl Service<Request<Body>> for OkSvc {
        type Response = Response;
        type Error = GatewayError;
        type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, _: Request<Body>) -> Self::Future {
            ready(Ok(Response::new(Body::from("ok"))))
        }
    }

    #[derive(Clone, Copy)]
    struct ErrSvc(fn() -> GatewayError);

    impl Service<Request<Body>> for ErrSvc {
        type Response = Response;
        type Error = GatewayError;
        type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, _: Request<Body>) -> Self::Future {
            ready(Err((self.0)()))
        }
    }

    #[tokio::test]
    async fn middleware_passes_through_ok_responses() {
        let mut svc = ErrorLayer.layer(OkSvc);
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp
            .into_body()
            .collect()
            .await
            .expect("body collection should succeed")
            .to_bytes();
        assert_eq!(std::str::from_utf8(&body).unwrap(), "ok");
    }

    #[tokio::test]
    async fn middleware_maps_concurrency_limit() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| GatewayError::ConcurrencyLimit {
            provider: "openai".into(),
        }));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            resp.headers().get(header::RETRY_AFTER),
            Some(&HeaderValue::from_static("30"))
        );

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "concurrency_limit");
    }

    #[tokio::test]
    async fn middleware_maps_timeout() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| GatewayError::Timeout("anthropic".into())));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::GATEWAY_TIMEOUT);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "timeout");
    }

    #[tokio::test]
    async fn middleware_maps_unknown_provider_to_not_found() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| GatewayError::UnknownProvider("/ghost".into())));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "not_found");
    }

    #[tokio::test]
    async fn middleware_maps_validation_to_not_found() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| GatewayError::Validation("bad path".into())));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "not_found");
    }

    #[tokio::test]
    async fn middleware_maps_upstream_to_bad_gateway() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| GatewayError::Upstream("boom".into())));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "upstream_error");
        assert_eq!(json["error"]["message"], "boom");
    }

    #[tokio::test]
    async fn middleware_maps_io_to_upstream() {
        let mut svc = ErrorLayer.layer(ErrSvc(|| {
            GatewayError::Io(io::Error::other("disk full"))
        }));
        let resp = svc
            .call(Request::new(Body::empty()))
            .await
            .expect("infallible result");

        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let json = body_json(resp).await;
        assert_eq!(json["error"]["type"], "upstream_error");
    }
}
