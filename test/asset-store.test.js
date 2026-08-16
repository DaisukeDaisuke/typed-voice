import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPreparedVoiceAssets,
  buildHuggingFaceResolveUrl,
  buildVirtualAssetUrl,
  prepareVoiceAssets,
  validateVoiceManifest,
  verifyAssetBytes,
} from "../src/engine/asset-store.js";

const asset = {
  id: "model",
  localPath: "models/model.onnx",
  byteSize: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  xxh3_128: "06b05ab6733a618578af5f94892f3950",
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
  runtime: {
    tokenizerDirectory: "tokenizer",
    sessions: {
      audioEmbeddings: { model: "models/model.onnx" },
      llm: { model: "models/model.onnx" },
      audioHeads: { model: "models/model.onnx" },
      higgsDecoder: { model: "models/model.onnx" },
    },
  },
  assets: [
    asset,
    {
      ...asset,
      id: "tokenizer-json",
      localPath: "tokenizer/tokenizer.json",
      source: { ...asset.source, path: "folder/tokenizer.json" },
    },
    {
      ...asset,
      id: "tokenizer-config",
      localPath: "tokenizer/tokenizer_config.json",
      source: { ...asset.source, path: "folder/tokenizer_config.json" },
    },
  ],
};

function createFakeDb(records) {
  return {
    transaction() {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            get(key) {
              const request = { result: records.get(key) };
              queueMicrotask(() => transaction.oncomplete?.());
              return request;
            },
            delete(key) {
              records.delete(key);
              const request = { result: undefined };
              queueMicrotask(() => transaction.oncomplete?.());
              return request;
            },
            put(record) {
              records.set(record.key, record);
              const request = { result: record.key };
              queueMicrotask(() => transaction.oncomplete?.());
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
}

function createFakeCache(entries) {
  return {
    async match(url) {
      return entries.get(url)?.clone();
    },
    async delete(url) {
      return entries.delete(url);
    },
    async put(url, response) {
      entries.set(url, response.clone());
    },
  };
}

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

test("XXH3-128一致時だけdownload bytesを受理する", async () => {
  const bytes = new TextEncoder().encode("abc").buffer;
  assert.equal(await verifyAssetBytes(bytes, asset.xxh3_128), asset.xxh3_128);
  await assert.rejects(
    () => verifyAssetBytes(new TextEncoder().encode("abd").buffer, asset.xxh3_128),
    /XXH3-128 mismatch/
  );
});

test("初回downloadもXXH3-128で検証してmetadataへ記録する", async () => {
  const baseUrl = "https://example.test/typed-voice/";
  const entries = new Map();
  const records = new Map();
  const progress = [];
  const result = await prepareVoiceAssets(manifest, {
    baseUrl,
    cachesImpl: { open: async () => createFakeCache(entries) },
    db: createFakeDb(records),
    fetchImpl: async () => new Response(new TextEncoder().encode("abc"), {
      status: 200,
      headers: { "content-length": "3" },
    }),
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.totalBytes, 9);
  assert.equal(entries.size, 3);
  assert.equal(records.size, 3);
  for (const currentAsset of manifest.assets) {
    const record = records.get(`${manifest.id}:${currentAsset.id}`);
    assert.equal(record.xxh3_128, currentAsset.xxh3_128);
    assert.equal(record.sha256, currentAsset.sha256);
  }
  assert.equal(progress.some((value) => value.phase === "downloading"), true);
});

test("再ロード時の初期化はCache本体をXXH3-128再検証し破損資産を破棄する", async () => {
  const baseUrl = "https://example.test/typed-voice/";
  const entries = new Map();
  const records = new Map();
  for (const currentAsset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, currentAsset.localPath, baseUrl);
    entries.set(virtualUrl, new Response(new TextEncoder().encode("abc")));
    records.set(`${manifest.id}:${currentAsset.id}`, {
      key: `${manifest.id}:${currentAsset.id}`,
      manifestId: manifest.id,
      assetId: currentAsset.id,
      virtualUrl,
      sha256: currentAsset.sha256,
      xxh3_128: currentAsset.xxh3_128,
      byteSize: currentAsset.byteSize,
    });
  }

  const corruptAsset = manifest.assets[0];
  const corruptUrl = buildVirtualAssetUrl(manifest.id, corruptAsset.localPath, baseUrl);
  entries.set(corruptUrl, new Response(new TextEncoder().encode("abd")));
  const progress = [];

  await assert.rejects(
    () => assertPreparedVoiceAssets(manifest, {
      baseUrl,
      cachesImpl: { open: async () => createFakeCache(entries) },
      db: createFakeDb(records),
      onProgress: (value) => progress.push(value),
    }),
    /missing or corrupt/
  );
  assert.equal(entries.has(corruptUrl), false);
  assert.equal(records.has(`${manifest.id}:${corruptAsset.id}`), false);
  assert.equal(progress.some((value) => value.phase === "verifying-cache"), true);
});

test("旧SHA metadataだけのCacheも再downloadせずXXH3-128へ昇格する", async () => {
  const baseUrl = "https://example.test/typed-voice/";
  const entries = new Map();
  const records = new Map();
  for (const currentAsset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, currentAsset.localPath, baseUrl);
    entries.set(virtualUrl, new Response(new TextEncoder().encode("abc")));
    records.set(`${manifest.id}:${currentAsset.id}`, {
      key: `${manifest.id}:${currentAsset.id}`,
      manifestId: manifest.id,
      assetId: currentAsset.id,
      virtualUrl,
      sha256: currentAsset.sha256,
      byteSize: currentAsset.byteSize,
    });
  }

  let fetchCount = 0;
  await prepareVoiceAssets(manifest, {
    baseUrl,
    cachesImpl: { open: async () => createFakeCache(entries) },
    db: createFakeDb(records),
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("download must not happen");
    },
  });
  assert.equal(fetchCount, 0);
  for (const currentAsset of manifest.assets) {
    assert.equal(records.get(`${manifest.id}:${currentAsset.id}`).xxh3_128, currentAsset.xxh3_128);
  }
});
