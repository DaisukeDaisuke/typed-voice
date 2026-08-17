#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

KANALIZER_DATASET_REVISION="21fc9ccf25d3b18030d3e0db3bf5994229fae697"
WASM_PACK_VERSION="0.15.0"

printf '\n[typed-voice] Initializing Kanalizer submodule...\n'
git submodule update --init third_party/kanalizer

printf '\n[typed-voice] Installing Node dependencies...\n'
npm ci

if ! command -v wasm-pack >/dev/null 2>&1 || [[ "$(wasm-pack --version 2>/dev/null || true)" != "wasm-pack ${WASM_PACK_VERSION}" ]]; then
  printf '\n[typed-voice] Installing wasm-pack %s...\n' "$WASM_PACK_VERSION"
  case "$(uname -m)" in
    x86_64)
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      archive="wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz"
      curl -L --fail --retry 3 \
        "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${archive}" \
        -o "$tmp/wasm-pack.tar.gz"
      tar -xzf "$tmp/wasm-pack.tar.gz" -C "$tmp"
      sudo install \
        "$tmp/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack" \
        /usr/local/bin/wasm-pack
      rm -rf "$tmp"
      trap - EXIT
      ;;
    *)
      cargo install wasm-pack --version "$WASM_PACK_VERSION" --locked
      ;;
  esac
fi

printf '\n[typed-voice] Building patched Kanalizer browser WASM...\n'
npm run build:kanalizer-wasm

cache_dir="$HOME/.cache/typed-voice"
dataset="$cache_dir/kanalizer-dataset-v3-${KANALIZER_DATASET_REVISION}.jsonl"
mkdir -p "$cache_dir"
if [[ ! -s "$dataset" ]]; then
  printf '\n[typed-voice] Downloading pinned Kanalizer dataset v3...\n'
  tmp_dataset="${dataset}.tmp"
  rm -f "$tmp_dataset"
  curl -L --fail --retry 3 \
    "https://huggingface.co/datasets/VOICEVOX/kanalizer-dataset/resolve/${KANALIZER_DATASET_REVISION}/dataset/dataset.jsonl" \
    -o "$tmp_dataset"
  mv "$tmp_dataset" "$dataset"
fi

printf '\n[typed-voice] Building Kanalizer dictionary...\n'
node scripts/build-kanalizer-dictionary.mjs "$dataset" src/kanalizer-dictionary

printf '\n[typed-voice] Ready. Run: npm run dev -- --host 0.0.0.0\n'
