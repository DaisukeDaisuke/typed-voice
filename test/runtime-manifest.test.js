import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateVoiceManifest } from "../src/engine/asset-store.js";

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("full-finetune manifestは固定HF commitのFP32 split runtimeを起動可能として記述する", async () => {
  const manifest = validateVoiceManifest(await readJson("../public/voice-manifest.json"));
  assert.equal(manifest.preparable, true);
  assert.equal(manifest.installable, true);
  assert.equal(manifest.voice.source.repo, "kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune");
  assert.equal(manifest.runtimeSource.repo, "RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx");
  assert.match(manifest.runtimeSource.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.runtime.generation.numStep, 16);
  assert.equal(manifest.runtime.generation.positionTemperature, 5);
  assert.equal(manifest.runtime.headDim, 128);
  assert.equal(manifest.assets.length, 10);
  assert.equal(manifest.assets.every((asset) => asset.role === "runtime"), true);
  assert.equal(manifest.assets.every((asset) => asset.source.repo === manifest.runtimeSource.repo), true);
  assert.equal(manifest.assets.every((asset) => asset.source.revision === manifest.runtimeSource.revision), true);
  assert.equal(manifest.assets.some((asset) => asset.source.path.endsWith(".safetensors")), false);
  const assetPaths = new Set(manifest.assets.map((asset) => asset.localPath));
  for (const session of Object.values(manifest.runtime.sessions)) {
    assert.equal(assetPaths.has(session.model), true);
    for (const external of session.externalData ?? []) assert.equal(assetPaths.has(external.localPath), true);
  }
});
