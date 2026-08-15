import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHuggingFaceResolveUrl,
  buildVirtualAssetUrl,
  validateVoiceManifest,
  verifyAssetBytes,
} from "../src/engine/asset-store.js";

const asset = {
  id: "model",
  localPath: "models/model.onnx",
  byteSize: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  source: {
    provider: "huggingface",
    repo: "owner/repo",
    revision: "0123456789abcdef",
    path: "folder/model.onnx",
  },
};

const manifest = {
  schemaVersion: 2,
  id: "voice",
  installable: true,
  voice: {
    engine: "omnivoice",
    source: { repo: "owner/repo", revision: "0123456789abcdef" },
  },
  assets: [asset],
};

test("installable manifestはimmutable revisionと完全なasset情報を受理する", () => {
  assert.equal(validateVoiceManifest(manifest), manifest);
  assert.equal(
    buildHuggingFaceResolveUrl(asset),
    "https://huggingface.co/owner/repo/resolve/0123456789abcdef/folder/model.onnx"
  );
  assert.equal(
    buildVirtualAssetUrl("voice", "models/model.onnx", "https://example.test/typed-voice/"),
    "https://example.test/typed-voice/__typed_voice_assets/voice/models/model.onnx"
  );
});

test("branch名をasset revisionに使うmanifestを拒否する", () => {
  const invalid = structuredClone(manifest);
  invalid.assets[0].source.revision = "main";
  assert.throws(() => validateVoiceManifest(invalid), /immutable revision/);
});

test("SHA-256一致時だけdownload bytesを受理する", async () => {
  const bytes = new TextEncoder().encode("abc").buffer;
  assert.equal(await verifyAssetBytes(bytes, asset.sha256), asset.sha256);
  await assert.rejects(
    () => verifyAssetBytes(new TextEncoder().encode("abd").buffer, asset.sha256),
    /SHA-256 mismatch/
  );
});
