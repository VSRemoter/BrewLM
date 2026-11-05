use std::hash::{Hash, Hasher};

/// The paired phone's renderer (scripts/build-phone-render.mjs writes it to
/// phone-render/ on npm install and before every dev/build) is embedded by the
/// sharing server. A plain `cargo` build without it gets empty stand-ins, and
/// the phone page falls back to its own simple formatting.
fn phone_assets() {
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for name in ["render.js.gz", "render.css.gz", "mermaid.js.gz"] {
        let src = std::path::Path::new("phone-render").join(name);
        println!("cargo:rerun-if-changed={}", src.display());
        let bytes = std::fs::read(&src).unwrap_or_default();
        bytes.hash(&mut hasher);
        std::fs::write(out.join(name), bytes).unwrap();
    }
    // Cache-busting version for the asset URLs.
    println!("cargo:rustc-env=PHONE_ASSETS_V={:x}", hasher.finish());
}

fn main() {
    phone_assets();
    tauri_build::build()
}
