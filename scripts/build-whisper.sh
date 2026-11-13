#!/usr/bin/env bash
# Builds whisper.cpp's command-line transcriber as a Tauri sidecar
# (src-tauri/binaries/whisper-cli-<target-triple>) for built-in transcription
# (Settings → Local Models → Transcription → Built in). Run before
# `tauri build` / `tauri dev`, locally or in CI. whisper.cpp is MIT ©
# The ggml authors — see README.
#
# One self-contained program per platform: static libraries, no SDL, no curl.
#   macOS:   arm64 with Metal (shaders embedded) and x86_64 with Accelerate,
#            plus a universal binary for `--target universal-apple-darwin`.
#   Linux:   x86_64, CPU (AVX2), or Vulkan with WHISPER_VULKAN=1.
#   Windows: x86_64, CPU (AVX2), static C runtime; Vulkan with WHISPER_VULKAN=1.
#
# WHISPER_ONLY_HOST=1 builds just this machine's architecture (dev, CI checks).
set -euo pipefail

VERSION="${WHISPER_VERSION:-v1.9.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="$ROOT/src-tauri/whisper-src"
SRC="$SRC_ROOT/whisper.cpp-${VERSION#v}"
OUT="$ROOT/src-tauri/binaries"
mkdir -p "$OUT" "$SRC_ROOT"

if [ ! -f "$SRC/CMakeLists.txt" ]; then
  echo "Downloading whisper.cpp ${VERSION} source"
  curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${VERSION}.tar.gz" | tar -xz -C "$SRC_ROOT"
fi

JOBS="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# Haswell-era (2013+) x86 features, fixed rather than "native" so the program
# runs on other machines than the build machine.
X86_FLAGS=(-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON)
VULKAN=()
if [ "${WHISPER_VULKAN:-0}" = "1" ]; then VULKAN=(-DGGML_VULKAN=ON); fi

build() { # build-dir, extra cmake args...
  local dir="$1"
  shift
  cmake -S "$SRC" -B "$dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF \
    -DWHISPER_FFMPEG=OFF \
    "$@" >/dev/null
  cmake --build "$dir" --config Release --target whisper-cli -j "$JOBS"
}

case "$(uname -s)" in
  Darwin)
    host="$(uname -m)"
    if [ "${WHISPER_ONLY_HOST:-0}" != "1" ] || [ "$host" = "arm64" ]; then
      build "$SRC/build-arm64" -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
        -DGGML_NATIVE=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
      cp "$SRC/build-arm64/bin/whisper-cli" "$OUT/whisper-cli-aarch64-apple-darwin"
    fi
    if [ "${WHISPER_ONLY_HOST:-0}" != "1" ] || [ "$host" = "x86_64" ]; then
      # Intel Macs: Metal is slower than the CPU with Accelerate on most of them.
      build "$SRC/build-x86_64" -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
        -DGGML_METAL=OFF "${X86_FLAGS[@]}"
      cp "$SRC/build-x86_64/bin/whisper-cli" "$OUT/whisper-cli-x86_64-apple-darwin"
    fi
    if [ -f "$OUT/whisper-cli-aarch64-apple-darwin" ] && [ -f "$OUT/whisper-cli-x86_64-apple-darwin" ]; then
      lipo -create "$OUT/whisper-cli-aarch64-apple-darwin" "$OUT/whisper-cli-x86_64-apple-darwin" \
        -output "$OUT/whisper-cli-universal-apple-darwin"
    fi
    ;;
  Linux)
    build "$SRC/build-linux" "${X86_FLAGS[@]}" "${VULKAN[@]}"
    cp "$SRC/build-linux/bin/whisper-cli" "$OUT/whisper-cli-x86_64-unknown-linux-gnu"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    # Static C runtime: the program needs no Visual C++ redistributable.
    build "$SRC/build-windows" "${X86_FLAGS[@]}" "${VULKAN[@]}" -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
    cp "$SRC/build-windows/bin/Release/whisper-cli.exe" "$OUT/whisper-cli-x86_64-pc-windows-msvc.exe"
    ;;
  *)
    echo "build-whisper.sh: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

chmod +x "$OUT"/whisper-cli-* 2>/dev/null || true
echo "Done:"
ls -lh "$OUT"/whisper-cli-*
