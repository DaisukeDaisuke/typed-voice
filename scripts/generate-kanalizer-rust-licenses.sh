#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/third_party/kanalizer"
PATCH="$ROOT/patches/kanalizer-browser.patch"
OUT="$ROOT/licenses/KANALIZER-RUST-LICENSES.md"
EXPECTED_COMMIT="98758acdc6cb80611958ade58cb05191e2658462"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.85.0}"

if [[ ! -e "$UPSTREAM/.git" ]]; then
  echo "Kanalizer submodule is unavailable: $UPSTREAM" >&2
  echo "Run: git submodule update --init --recursive third_party/kanalizer" >&2
  exit 1
fi

if ! command -v cargo-about >/dev/null 2>&1; then
  echo "cargo-about is required to regenerate Kanalizer Rust license notices." >&2
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

# cargo-about follows declared dev/build dependencies even though they are not
# linked into the distributed browser WASM. Build a license-only manifest view
# in the disposable worktree so the notice describes the shipped artifact, not
# upstream tests, CLI helpers, Python bindings, or the model downloader.
sed -i \
  's/members = \["crates\/kanalizer-rs", "crates\/kanalizer-py"\]/members = ["crates\/kanalizer-rs"]/' \
  "$BUILD_WORKTREE/infer/Cargo.toml"
awk '
  /^\[dev-dependencies\]$/ { skip = 1; next }
  /^\[build-dependencies\]$/ { skip = 1; next }
  /^\[[^]]+\]$/ { skip = 0 }
  !skip { print }
' "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml" \
  > "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml.licenses"
mv \
  "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml.licenses" \
  "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml"

cargo metadata \
  --format-version 1 \
  --manifest-path "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml" \
  --no-default-features \
  --features external_model \
  >/dev/null

cargo-about generate \
  --locked \
  --no-default-features \
  --features external_model \
  --target wasm32-unknown-unknown \
  --fail \
  --manifest-path "$BUILD_WORKTREE/infer/crates/kanalizer-rs/Cargo.toml" \
  --config "$BUILD_WORKTREE/infer/tools/about.toml" \
  --output-file "$OUT" \
  "$BUILD_WORKTREE/infer/tools/about.hbs.md"
