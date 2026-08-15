import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateVoiceManifest } from "../src/engine/asset-store.js";

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("full-finetune manifestは未変換の品質候補としてruntime取得を禁止する", async () => {
  const manifest = validateVoiceManifest(await readJson("../public/voice-manifest.json"));
  assert.equal(manifest.preparable, true);
  assert.equal(manifest.installable, false);
  assert.equal(manifest.voice.source.repo, "kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune");
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].role, "conversion-source");
  assert.equal(manifest.assets[0].source.path, "model.safetensors");
  assert.equal(manifest.assets[0].sha256, manifest.voice.source.modelSha256);
  assert.equal(manifest.assets[0].byteSize, manifest.voice.source.modelByteSize);
});
