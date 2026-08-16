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
# Windows: cloudflared ships only an .msi on GitHub releases; until that is
# unpacked in CI, Windows builds fall back to `cloudflared` on PATH
# (`winget install cloudflare.cloudflared`). See find_cloudflared().
chmod +x "$OUT"/cloudflared-* || true
echo "Done:"; ls -lh "$OUT"
