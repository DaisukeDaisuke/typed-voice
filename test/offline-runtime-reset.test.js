import test from "node:test";
import assert from "node:assert/strict";
import {
  clearTypedVoiceAssetMetadata,
  clearTypedVoiceCacheStorage,
  findTypedVoiceServiceWorkerRegistration,
  isTypedVoiceOwnedCacheName,
  OfflineRuntimeResetUiController,
  resetTypedVoiceOfflineRuntime,
} from "../src/app/offline-runtime-reset.js";

function createDb() {
  const stores = {
    assets: [{ key: "voice:model" }],
    sessions: [{ id: "conversation-1" }],
    settings: [{ key: "speechSpeed", value: 1 }],
  };
  const objectStoreNames = Object.keys(stores);
  objectStoreNames.contains = (name) => Object.hasOwn(stores, name);
  return {
    stores,
    objectStoreNames,
    transaction(name) {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            clear() {
              stores[name] = [];
              queueMicrotask(() => transaction.oncomplete?.());
            },
          };
        },
      };
      return transaction;
    },
  };
}

test("typed-voice所有Cacheだけを判定する", () => {
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-model-assets-v2"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-kanalizer-model-v1"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-source-2026-08-17-45"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-huggingface-resolve-2026-08-17-45"), true);
  assert.equal(isTypedVoiceOwnedCacheName("desmume_webassembly-cache-v1"), false);
  assert.equal(isTypedVoiceOwnedCacheName("other-app-cache"), false);
});

test("Cache Storage削除はdesmume_webassemblyなど他アプリを巻き込まない", async () => {
  const names = new Set([
    "typed-voice-model-assets-v2",
    "typed-voice-source-old",
    "desmume_webassembly-cache-v1",
    "other-app-cache",
  ]);
  const deleted = [];
  await clearTypedVoiceCacheStorage({
    async keys() { return [...names]; },
    async delete(name) { deleted.push(name); names.delete(name); return true; },
  });
  assert.deepEqual(new Set(deleted), new Set(["typed-voice-model-assets-v2", "typed-voice-source-old"]));
  assert.equal(names.has("desmume_webassembly-cache-v1"), true);
  assert.equal(names.has("other-app-cache"), true);
});

test("assets metadataだけを消して会話や設定を保持する", async () => {
  const db = createDb();
  await clearTypedVoiceAssetMetadata(db);
  assert.deepEqual(db.stores.assets, []);
  assert.deepEqual(db.stores.sessions, [{ id: "conversation-1" }]);
  assert.deepEqual(db.stores.settings, [{ key: "speechSpeed", value: 1 }]);
});

test("typed-voiceのService Workerだけを登録解除対象にする", async () => {
  const registration = {
    active: { scriptURL: "https://example.test/typed-voice/app-service-worker.js?source-cache=x" },
    waiting: null,
    installing: null,
  };
  const found = await findTypedVoiceServiceWorkerRegistration({
    baseUrl: "https://example.test/typed-voice/",
    serviceWorkerContainer: { async getRegistration() { return registration; } },
  });
  assert.equal(found, registration);

  await assert.rejects(() => findTypedVoiceServiceWorkerRegistration({
    baseUrl: "https://example.test/typed-voice/",
    serviceWorkerContainer: {
      async getRegistration() {
        return { active: { scriptURL: "https://example.test/desmume_webassembly/sw.js" } };
      },
    },
  }), /typed-voice以外/);
});

test("高度な削除はService Worker・typed-voice Cache・assets metadataだけを削除する", async () => {
  const db = createDb();
  const names = new Set(["typed-voice-model-assets-v2", "desmume_webassembly-cache-v1"]);
  let unregistered = false;
  const result = await resetTypedVoiceOfflineRuntime({
    db,
    baseUrl: "https://example.test/typed-voice/",
    cachesImpl: {
      async keys() { return [...names]; },
      async delete(name) { names.delete(name); return true; },
    },
    serviceWorkerContainer: {
      async getRegistration() {
        return {
          active: { scriptURL: "https://example.test/typed-voice/app-service-worker.js?source-cache=x" },
          async unregister() { unregistered = true; return true; },
        };
      },
    },
  });
  assert.equal(unregistered, true);
  assert.deepEqual(result.deletedCaches, ["typed-voice-model-assets-v2"]);
  assert.deepEqual(db.stores.assets, []);
  assert.deepEqual(db.stores.sessions, [{ id: "conversation-1" }]);
  assert.equal(names.has("desmume_webassembly-cache-v1"), true);
});

test("フリーズUIだけを表示するとアプリ本体をinertにして再登録ボタンだけ残す", () => {
  const reset = { addEventListener() {} };
  const status = { textContent: "" };
  const reload = {
    focused: false,
    addEventListener() {},
    focus() { this.focused = true; },
  };
  const app = { inert: false };
  const freeze = { hidden: true, inert: false };
  const elements = new Map([
    ["offline-runtime-reset", reset],
    ["offline-runtime-reset-status", status],
    ["offline-reset-freeze", freeze],
    ["offline-reset-reload", reload],
  ]);
  const classes = new Set();
  const documentRef = {
    body: { children: [app, freeze] },
    documentElement: { classList: { add(name) { classes.add(name); } } },
    getElementById(id) { return elements.get(id) ?? null; },
  };

  const controller = new OfflineRuntimeResetUiController(documentRef, { locationRef: { reload() {} } });
  controller.showFreeze();

  assert.equal(freeze.hidden, false);
  assert.equal(freeze.inert, false);
  assert.equal(app.inert, true);
  assert.equal(reload.focused, true);
  assert.equal(classes.has("offline-runtime-frozen"), true);
});
