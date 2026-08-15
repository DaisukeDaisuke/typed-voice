#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPER_WASM_DIR="$ROOT_DIR/third_party/piper-plus/src/rust/piper-wasm"
OUT_DIR="$ROOT_DIR/third_party/piper-plus/src/wasm/openjtalk-web/dist/rust-wasm"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required to build Piper Plus G2P WASM." >&2
  echo "Run this build in the Codespace/CI environment where wasm-pack is installed." >&2
  exit 1
fi

cd "$PIPER_WASM_DIR"
wasm-pack build \
  --target web \
  --release \
  --features multilingual \
  --out-dir "$OUT_DIR"

ORT_DIST_DIR="$ROOT_DIR/node_modules/onnxruntime-web/dist"
if [[ ! -d "$ORT_DIST_DIR" ]]; then
  echo "onnxruntime-web is not installed. Run npm install first." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/public"
cp "$ORT_DIST_DIR"/*.wasm "$ROOT_DIR/public/"