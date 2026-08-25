#!/usr/bin/env bash
# Downloads cloudflared binaries and lays them out as Tauri sidecars
# (binaries/cloudflared-<target-triple>). Run before `tauri build`, locally
# or in CI. cloudflared is BSD-3-Clause © Cloudflare — see README.
set -euo pipefail

VERSION="${CLOUDFLARED_VERSION:-2026.8.2}"
BASE="https://github.com/cloudflare/cloudflared/releases/download/${VERSION}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/binaries"
mkdir -p "$OUT"

fetch_tgz() { # url, out-name
  curl -fsSL "$1" -o /tmp/cf-dl.tgz
  tar -xzf /tmp/cf-dl.tgz -C "$OUT"
  mv "$OUT/cloudflared" "$OUT/$2"
}
fetch_bin() { # url, out-name
  curl -fsSL "$1" -o "$OUT/$2"
  chmod +x "$OUT/$2"
}

echo "Fetching cloudflared ${VERSION} sidecars → ${OUT}"
fetch_tgz "$BASE/cloudflared-darwin-arm64.tgz" "cloudflared-aarch64-apple-darwin"
fetch_tgz "$BASE/cloudflared-darwin-amd64.tgz" "cloudflared-x86_64-apple-darwin"
fetch_bin "$BASE/cloudflared-linux-amd64"      "cloudflared-x86_64-unknown-linux-gnu"
fetch_bin "$BASE/cloudflared-windows-amd64.exe" "cloudflared-x86_64-pc-windows-msvc.exe"
# Universal macOS builds (`--target universal-apple-darwin`) require a single
# binary named cloudflared-universal-apple-darwin — lipo the two arch slices
# together. lipo only exists on macOS, so skip this elsewhere (only the
# macOS CI lane ever needs it).
if command -v lipo >/dev/null 2>&1; then
  lipo -create \
    "$OUT/cloudflared-aarch64-apple-darwin" \
    "$OUT/cloudflared-x86_64-apple-darwin" \
    -output "$OUT/cloudflared-universal-apple-darwin"
fi
chmod +x "$OUT"/cloudflared-* || true
echo "Done:"; ls -lh "$OUT"
