# Browser patches

## VOICEVOX Kanalizer

`third_party/kanalizer` is a Git submodule pinned to upstream commit
`98758acdc6cb80611958ade58cb05191e2658462`.

`kanalizer-browser.patch` contains only the browser-specific delta used by
`typed-voice`:

- build the Rust library as a `cdylib` for `wasm-bindgen`;
- accept externally supplied Safetensors model bytes instead of embedding or
  downloading the model at Rust build time;
- expose the converter through a small `wasm-bindgen` class;
- disable the upstream model build script and omit direct CLI-only dependencies from the browser build; and
- use a size-oriented release profile for the iPad/browser target.

The patch is authored in the detached `kanalizer-patch-worktree` and should be
regenerated with Git itself (for example,
`git -C kanalizer-patch-worktree diff --binary --no-ext-diff --no-color > patches/kanalizer-browser.patch`).

`scripts/build-kanalizer-wasm.sh` verifies the pinned upstream commit, creates a
temporary detached Git worktree, applies the patch with `git apply`, builds the
WASM package, and removes the temporary worktree. Because the patch changes the
direct dependency set, the script refreshes only the temporary worktree's lock
graph from the pinned upstream `Cargo.lock`, then performs the actual build with
`--locked`. The checked-out submodule is therefore kept clean.

`scripts/generate-kanalizer-rust-licenses.sh` uses the same patched temporary
worktree, `external_model` feature, and `wasm32-unknown-unknown` target to
regenerate `licenses/KANALIZER-RUST-LICENSES.md` with `cargo-about` whenever the
submodule revision or browser patch changes. Its disposable license-only
manifest excludes the upstream Python workspace member and dev/build-only
dependencies, so the notice describes dependencies of the distributed browser
WASM rather than test, CLI, or model-downloader tooling.

The Kanalizer model is not part of this patch or the generated WASM. The browser
downloads the pinned upstream model during the online offline-setup phase and
stores the verified bytes in Cache Storage for later offline use.

Kanalizer remains subject to its upstream MIT License. See
`third_party/kanalizer/LICENSE`, `THIRD_PARTY_NOTICES.md`, and the files under
`licenses/`.
