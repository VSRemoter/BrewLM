//! `brewsandbox://localhost/` (macOS/Linux) or `http://brewsandbox.localhost/`
//! (Windows): the frame AI-built interactive pages run in.
//!
//! The app's own Content-Security-Policy (tauri.conf.json) blocks inline
//! scripts, and a `srcdoc` frame would inherit it, so the pages couldn't run.
//! This serves the web app's frame (public/sandbox.html) from its own origin
//! with its own policy instead, the same one app.brewlm.com sends for it
//! (public/_headers): inline script and style only, no network. The app
//! frames it sandboxed (opaque origin), waits for "ready", then posts the page.

use tauri::http::{header, Request, Response};

const SANDBOX_HTML: &str = include_str!("../../public/sandbox.html");

/// Keep in step with `/sandbox` in public/_headers (src/lib/csp.test.ts checks).
pub const SANDBOX_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

pub fn serve(_request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("Content-Security-Policy", SANDBOX_CSP)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .body(SANDBOX_HTML.as_bytes().to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_the_frame_with_a_no_network_policy() {
        let res = serve(&Request::builder().uri("brewsandbox://localhost/").body(Vec::new()).unwrap());
        assert!(String::from_utf8_lossy(res.body()).contains("brewlm-sandbox-ready"));
        let csp = res.headers().get("Content-Security-Policy").unwrap().to_str().unwrap();
        assert!(csp.contains("connect-src 'none'"));
    }
}
