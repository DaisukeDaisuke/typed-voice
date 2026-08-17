import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllApplicationData,
  clearConversationData,
  createApplicationBackup,
  createApplicationBackupFilename,
  parseApplicationBackup,
  restoreApplicationBackup,
  stringifyApplicationBackup,
  writeApplicationBackupToFileHandle,
} from "../src/app/application-backup.js";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); },
  };
}

function createFakeDb(initialStores) {
  const stores = new Map(
    Object.entries(initialStores).map(([name, records]) => [name, records.map((record) => structuredClone(record))])
  );
  const objectStoreNames = [...stores.keys()];
  objectStoreNames.contains = (name) => stores.has(name);

  function keyForRecord(record) {
    return record.key ?? record.id ?? record.assetId;
  }

  return {
    name: "typed-voice-app",
    version: 2,
    objectStoreNames,
    transaction(storeNames) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(name) {
          if (!names.includes(name) || !stores.has(name)) throw new Error(`Unknown store: ${name}`);
          return {
            getAll() {
              const request = { result: undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                request.result = stores.get(name).map((record) => structuredClone(record));
                request.onsuccess?.();
              });
              return request;
            },
            clear() {
              stores.set(name, []);
            },
            put(record) {
              const records = stores.get(name);
              const key = keyForRecord(record);
              const index = records.findIndex((item) => keyForRecord(item) === key);
              if (index >= 0) records[index] = structuredClone(record);
              else records.push(structuredClone(record));
            },
          };
        },
      };
      setImmediate(() => transaction.oncomplete?.());
      return transaction;
    },
    snapshot() {
      return Object.fromEntries([...stores].map(([name, records]) => [name, structuredClone(records)]));
    },
  };
}

function initialDatabase() {
  return {
    sessions: [{ id: "session-1", createdAt: 1, updatedAt: 2, firstMessagePreview: "hello", messageCount: 1 }],
    messages: [{ id: "message-1", sessionId: "session-1", sequence: 1, text: "hello", createdAt: 2, playedAt: 3, durationMs: 50 }],
    pendingUtterances: [{ id: "pending-1", sessionId: "session-1", generation: 1, text: "pending", createdAt: 4, reasoningDeadline: 5, state: "reasoning", error: null }],
    settings: [{ key: "reasoningSeconds", value: 2, updatedAt: 6 }],
    statistics: [{ key: "global", scope: "global", conversationCount: 1, messageCount: 1, typedChars: 5, deletedChars: 0, typingMs: 10, playbackMs: 50, activeDays: 1, lastActiveDay: "1970-01-01" }],
    assets: [{ key: "voice:model", manifestId: "voice", assetId: "model", version: "rev", sha256: "abc", size: 3, installedAt: 7, source: { provider: "test" }, licenseId: "test" }],
  };
}

test("バックアップはユーザーデータだけを保存しasset metadataを含めず復元でも保持する", async () => {
  const db = createFakeDb(initialDatabase());
  const storage = createStorage({
    "typed-voice-tutorial-v1-complete": "1",
    "typed-voice-tutorial-conversation-practice-count-v1": "2",
    "typed-voice-ui-model-profile-v1": "fp16",
    "typed-voice-internal-cache-state": "do-not-export",
    unrelated: "keep",
  });
  const uiState = { currentSessionId: "session-1", composerValue: "draft", secondaryView: "timeline" };
  const backup = await createApplicationBackup({ db, storage, uiState });

  assert.deepEqual(Object.keys(backup.database.stores).sort(), [
    "messages",
    "pendingUtterances",
    "sessions",
    "settings",
    "statistics",
  ]);
  assert.equal(Object.hasOwn(backup.database.stores, "assets"), false);
  assert.deepEqual(backup.localStorage, {
    "typed-voice-tutorial-v1-complete": "1",
    "typed-voice-tutorial-conversation-practice-count-v1": "2",
    "typed-voice-ui-model-profile-v1": "fp16",
  });
  assert.equal(Object.hasOwn(backup.localStorage, "typed-voice-internal-cache-state"), false);
  assert.deepEqual(backup.uiState, uiState);
  assert.equal(backup.cacheStorageIncluded, false);

  const roundTrip = parseApplicationBackup(stringifyApplicationBackup(backup));
  await clearAllApplicationData({ db, storage });
  const cleared = db.snapshot();
  assert.equal(cleared.sessions.length, 0);
  assert.equal(cleared.messages.length, 0);
  assert.equal(cleared.pendingUtterances.length, 0);
  assert.equal(cleared.settings.length, 0);
  assert.equal(cleared.statistics.length, 0);
  assert.deepEqual(cleared.assets, initialDatabase().assets);
  assert.deepEqual(storage.snapshot(), {
    unrelated: "keep",
    "typed-voice-tutorial-conversation-practice-count-v1": "2",
  });

  await restoreApplicationBackup({ db, storage }, roundTrip);
  assert.deepEqual(db.snapshot(), initialDatabase());
  assert.deepEqual(storage.snapshot(), {
    unrelated: "keep",
    "typed-voice-tutorial-v1-complete": "1",
    "typed-voice-tutorial-conversation-practice-count-v1": "2",
    "typed-voice-ui-model-profile-v1": "fp16",
  });
});

test("旧v1バックアップにassetsが含まれていても復元せず現在端末のasset metadataを保持する", async () => {
  const current = initialDatabase();
  current.assets = [{ key: "voice:new", manifestId: "voice", assetId: "new", version: "new", sha256: "new", size: 9 }];
  const db = createFakeDb(current);
  const storage = createStorage();
  const backup = await createApplicationBackup({ db: createFakeDb(initialDatabase()), storage });
  backup.database.stores.assets = initialDatabase().assets;

  await restoreApplicationBackup({ db, storage }, backup);

  assert.deepEqual(db.snapshot().assets, current.assets);
});

test("別形式のJSONはtyped-voiceバックアップとして復元しない", () => {
  assert.throws(() => parseApplicationBackup('{"format":"other","version":1}'), /対応バックアップ/);
});

test("バックアップ保存先へclose完了まで書き込み、保存完了を確認できる", async () => {
  const backup = await createApplicationBackup({ db: createFakeDb(initialDatabase()), storage: createStorage() });
  const writes = [];
  let closed = false;
  const fileHandle = {
    name: "saved-backup.json",
    async createWritable() {
      return {
        async write(value) { writes.push(value); },
        async close() { closed = true; },
      };
    },
  };

  const filename = await writeApplicationBackupToFileHandle(fileHandle, backup);

  assert.equal(filename, "saved-backup.json");
  assert.equal(closed, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(parseApplicationBackup(writes[0]), backup);
});

test("バックアップ保存のcloseに失敗した場合は保存完了として扱わない", async () => {
  const backup = await createApplicationBackup({ db: createFakeDb(initialDatabase()), storage: createStorage() });
  let aborted = false;
  const fileHandle = {
    async createWritable() {
      return {
        async write() {},
        async close() { throw new Error("save failed"); },
        async abort() { aborted = true; },
      };
    },
  };

  await assert.rejects(() => writeApplicationBackupToFileHandle(fileHandle, backup), /save failed/);
  assert.equal(aborted, true);
});

test("バックアップ既定ファイル名は日時を含む", () => {
  const filename = createApplicationBackupFilename("2026-08-17T11:22:33.000Z");
  assert.match(filename, /^typed-voice-backup-\d{8}-\d{6}\.json$/);
});

test("チュートリアル終了時は会話データだけ消し設定とasset metadataを残す", async () => {
  const db = createFakeDb(initialDatabase());

  await clearConversationData(db);
  const current = db.snapshot();

  assert.equal(current.sessions.length, 0);
  assert.equal(current.messages.length, 0);
  assert.equal(current.pendingUtterances.length, 0);
  assert.equal(current.statistics.length, 0);
  assert.deepEqual(current.settings, initialDatabase().settings);
  assert.deepEqual(current.assets, initialDatabase().assets);
});
