#!/bin/bash
# Setup whisper.cpp locally (same pattern as OpenClaw/zeroclaw)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHISPER_DIR="$SCRIPT_DIR/whisper.cpp"
MODELS_DIR="$SCRIPT_DIR/models"

mkdir -p "$MODELS_DIR"

# Clone whisper.cpp if not present
if [ ! -d "$WHISPER_DIR" ]; then
  echo "[whisper] Cloning whisper.cpp..."
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

# Build whisper.cpp binary
if [ ! -f "$WHISPER_DIR/main" ]; then
  echo "[whisper] Building whisper.cpp..."

  # Try cmake first (modern whisper.cpp)
  if command -v cmake >/dev/null 2>&1; then
    echo "[whisper] Trying cmake build..."
    if cmake -B build . >/dev/null 2>&1 && cmake --build build --config Release >/dev/null 2>&1; then
      cp build/bin/main "$WHISPER_DIR/main" 2>/dev/null || cp build/main "$WHISPER_DIR/main" 2>/dev/null
      echo "[whisper] cmake build succeeded."
    fi
  fi

  # Fallback: pure make (older whisper.cpp)
  if [ ! -f "$WHISPER_DIR/main" ]; then
    echo "[whisper] Trying make build..."
    if make main >/dev/null 2>&1; then
      echo "[whisper] make build succeeded."
    fi
  fi

  # Fallback: direct g++ compile
  if [ ! -f "$WHISPER_DIR/main" ]; then
    echo "[whisper] Trying direct g++ compile..."
    g++ -O3 -std=c++11 -I. examples/main.cpp whisper.cpp ggml/src/ggml.c ggml/src/ggml-alloc.c ggml/src/ggml-backend.c ggml/src/ggml-quants.c -o main -lm 2>/dev/null || true
  fi

  if [ ! -f "$WHISPER_DIR/main" ]; then
    echo "[whisper] WARNING: Could not build whisper.cpp. Voice notes will be unavailable."
    exit 0  # Don't fail the build — bot works without voice
  fi
fi

# Download tiny model if not present (~75MB)
if [ ! -f "$MODELS_DIR/ggml-tiny.bin" ]; then
  echo "[whisper] Downloading ggml-tiny.bin model..."
  curl -L --max-time 120 -o "$MODELS_DIR/ggml-tiny.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin" || {
      echo "[whisper] WARNING: Model download failed. Voice notes will be unavailable."
      exit 0
    }
fi

echo "[whisper] Setup complete."
