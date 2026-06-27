use rust_embed::Embed;

/// Embedded static assets (compiled into the binary, no CDN).
#[derive(Embed)]
#[folder = "../../static/"]
pub struct Asset;

/// Serve a static asset by path. Returns (content, mime_type) or None if absent.
/// Strips a leading '/' so both "htmx.min.js" and "/htmx.min.js" resolve.
pub fn serve_static(path: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = path.trim_start_matches('/');
    let file = Asset::get(path)?;
    let mime = mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream");
    Some((file.data.to_vec(), mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn htmx_asset_exists() {
        assert!(Asset::get("htmx.min.js").is_some());
    }

    #[test]
    fn sse_asset_exists() {
        assert!(Asset::get("sse.js").is_some());
    }

    #[test]
    fn serve_htmx_returns_content_and_js_mime() {
        let (content, mime) = serve_static("htmx.min.js").expect("htmx");
        assert!(!content.is_empty());
        assert!(mime.contains("javascript"), "got: {mime}");
    }

    #[test]
    fn serve_sse_with_leading_slash() {
        let (content, _) = serve_static("/sse.js").expect("sse");
        assert!(!content.is_empty());
    }

    #[test]
    fn serve_missing_returns_none() {
        assert!(serve_static("nonexistent.xyz").is_none());
    }
}
