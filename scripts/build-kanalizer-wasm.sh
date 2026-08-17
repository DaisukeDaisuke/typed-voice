#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src/kanalizer-wasm"
UPSTREAM="$ROOT/third_party/kanalizer"
PATCH="$ROOT/patches/kanalizer-browser.patch"
EXPECTED_COMMIT="98758acdc6cb80611958ade58cb05191e2658462"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.85.0}"

if [[ ! -e "$UPSTREAM/.git" ]]; then
  echo "Kanalizer submodule is unavailable: $UPSTREAM" >&2
  echo "Run: git submodule update --init --recursive third_party/kanalizer" >&2
  exit 1
fi

ACTUAL_COMMIT="$(git -C "$UPSTREAM" rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "Unexpected Kanalizer revision: $ACTUAL_COMMIT" >&2
  echo "Expected: $EXPECTED_COMMIT" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
BUILD_WORKTREE="$TMP_ROOT/kanalizer"

cleanup() {
  git -C "$UPSTREAM" worktree remove --force "$BUILD_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

git -C "$UPSTREAM" worktree add --detach "$BUILD_WORKTREE" "$EXPECTED_COMMIT"
git -C "$BUILD_WORKTREE" apply --check "$PATCH"
git -C "$BUILD_WORKTREE" apply "$PATCH"

# The browser patch changes kanalizer-rs' direct dependency set, so refresh only
# the temporary worktree's lock graph from the pinned upstream Cargo.lock before
# enforcing --locked for the actual build. The checked-out submodule stays clean.
cargo metadata \
  --format-version 1 \
  --manifest-path "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml" \
  --no-default-features \
  --features external_model \
  >/dev/null

rm -rf "$OUT"
cd "$BUILD_WORKTREE/infer"
wasm-pack build \
  --release \
  --target web \
  --no-opt \
  --out-dir pkg-browser \
  --out-name kanalizer_browser \
  --no-typescript \
  crates/kanalizer-rs \
  --locked \
  --no-default-features \
  --features external_model

mkdir -p "$OUT"
cp -a "$BUILD_WORKTREE/infer/crates/kanalizer-rs/pkg-browser/." "$OUT/"

