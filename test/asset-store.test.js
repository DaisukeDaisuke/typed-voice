import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHuggingFaceResolveUrl,
  validateVoiceManifest,
  verifyAssetBytes,
} from "../src/engine/asset-store.js";

const manifest = {
  schemaVersion: 1,
  id: "voice",
  provider: "huggingface",
  repo: "owner/repo",
  revision: "0123456789abcdef",
  files: {
    model: {
      path: "model.onnx",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    config: { path: "config.json" },
  },
};

test("manifestからbranchではなく固定revisionのResolver URLを作る", () => {
  validateVoiceManifest(manifest);
  assert.equal(
    buildHuggingFaceResolveUrl(manifest, manifest.files.model.path),
    "https://huggingface.co/owner/repo/resolve/0123456789abcdef/model.onnx"
  );
});

test("SHA-256が一致するモデルだけ受理する", async () => {
  const bytes = new TextEncoder().encode("abc").buffer;
  assert.equal(await verifyAssetBytes(bytes, manifest.files.model.sha256), manifest.files.model.sha256);
});

test("SHA-256不一致を拒否する", async () => {
  const bytes = new TextEncoder().encode("abd").buffer;
  await assert.rejects(() => verifyAssetBytes(bytes, manifest.files.model.sha256), /SHA-256 mismatch/);
});