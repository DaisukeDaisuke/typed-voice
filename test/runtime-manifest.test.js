import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateVoiceManifest } from "../src/engine/asset-store.js";

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("full-finetune manifestは未変換の品質候補としてruntime取得を禁止する", async () => {
  const manifest = validateVoiceManifest(await readJson("../public/voice-manifest.json"));
  assert.equal(manifest.installable, false);
  assert.equal(manifest.voice.source.repo, "kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune");
  assert.equal(manifest.assets.length, 0);
});

test("reference manifestはruntimeが参照する全local assetを固定hash付きで宣言する", async () => {
  const manifest = validateVoiceManifest(await readJson("../public/omnivoice-reference-manifest.json"));
  const localPaths = new Set(manifest.assets.map((asset) => asset.localPath));
  assert.equal(manifest.installable, true);
  assert.equal(localPaths.has("tokenizer/tokenizer.json"), true);
  assert.equal(localPaths.has("tokenizer/tokenizer_config.json"), true);
  assert.equal(localPaths.has("tokenizer/config.json"), true);
  for (const session of Object.values(manifest.runtime.sessions)) {
    assert.equal(localPaths.has(session.model), true, `missing model asset: ${session.model}`);
    for (const external of session.externalData || []) {
      assert.equal(localPaths.has(external.localPath), true, `missing external data asset: ${external.localPath}`);
    }
  }
});
