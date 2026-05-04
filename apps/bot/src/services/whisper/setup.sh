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

# Build if binary doesn't exist
if [ ! -f "$WHISPER_DIR/main" ]; then
  echo "[whisper] Building whisper.cpp..."
  cd "$WHISPER_DIR"
  make
fi

# Download tiny model if not present (~75MB)
if [ ! -f "$MODELS_DIR/ggml-tiny.bin" ]; then
  echo "[whisper] Downloading ggml-tiny.bin model..."
  curl -L -o "$MODELS_DIR/ggml-tiny.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
fi

echo "[whisper] Setup complete. Binary: $WHISPER_DIR/main"
echo "[whisper] Model: $MODELS_DIR/ggml-tiny.bin"
