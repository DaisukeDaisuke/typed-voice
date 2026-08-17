const BACKUP_FORMAT = "typed-voice-backup";
const BACKUP_VERSION = 1;
const LOCAL_STORAGE_PREFIX = "typed-voice-";
const RESET_PRESERVED_LOCAL_STORAGE_KEYS = Object.freeze([
  "typed-voice-tutorial-conversation-practice-count-v1",
]);
const CONVERSATION_DATA_STORES = Object.freeze([
  "sessions",
  "messages",
  "pendingUtterances",
  "statistics",
]);
const TUTORIAL_RESET_DATA_STORES = Object.freeze([
  ...CONVERSATION_DATA_STORES,
  "settings",
]);

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encodeValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) return { __typedVoiceType: "undefined" };
  if (typeof value === "bigint") return { __typedVoiceType: "bigint", value: String(value) };
  if (typeof value !== "object") throw new TypeError(`Unsupported backup value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Cyclic IndexedDB values are not supported by typed-voice backup v1.");
  seen.add(value);
  try {
    if (value instanceof Date) {
      return { __typedVoiceType: "date", value: value.toISOString() };
    }
    if (value instanceof ArrayBuffer) {
      return { __typedVoiceType: "array-buffer", value: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return {
        __typedVoiceType: value instanceof DataView ? "data-view" : "typed-array",
        constructor: value.constructor.name,
        value: bytesToBase64(bytes),
      };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      const encoded = {
        __typedVoiceType: typeof File !== "undefined" && value instanceof File ? "file" : "blob",
        mimeType: value.type,
        value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      };
      if (encoded.__typedVoiceType === "file") {
        encoded.name = value.name;
        encoded.lastModified = value.lastModified;
      }
      return encoded;
    }
    if (value instanceof Map) {
      return {
        __typedVoiceType: "map",
        value: await Promise.all([...value].map(async ([key, item]) => [
          await encodeValue(key, seen),
          await encodeValue(item, seen),
        ])),
      };
    }
    if (value instanceof Set) {
      return {
        __typedVoiceType: "set",
        value: await Promise.all([...value].map((item) => encodeValue(item, seen))),
      };
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => encodeValue(item, seen)));
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await encodeValue(item, seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

const TYPED_ARRAY_CONSTRUCTORS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  ...(typeof BigInt64Array !== "undefined" ? { BigInt64Array } : {}),
  ...(typeof BigUint64Array !== "undefined" ? { BigUint64Array } : {}),
});

function decodeValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const type = value.__typedVoiceType;
  if (type === "undefined") return undefined;
  if (type === "bigint") return BigInt(value.value);
  if (type === "date") return new Date(value.value);
  if (type === "array-buffer") return base64ToBytes(value.value).buffer;
  if (type === "data-view") {
    const bytes = base64ToBytes(value.value);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (type === "typed-array") {
    const Constructor = TYPED_ARRAY_CONSTRUCTORS[value.constructor];
    if (!Constructor) throw new TypeError(`Unsupported typed array in backup: ${value.constructor}`);
    const bytes = base64ToBytes(value.value);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Constructor(buffer);
  }
  if (type === "blob" || type === "file") {
    const bytes = base64ToBytes(value.value);
    if (type === "file" && typeof File !== "undefined") {
      return new File([bytes], value.name || "file", {
        type: value.mimeType || "",
        lastModified: Number(value.lastModified || 0),
      });
    }
    return new Blob([bytes], { type: value.mimeType || "" });
  }
  if (type === "map") return new Map(value.value.map(([key, item]) => [decodeValue(key), decodeValue(item)]));
  if (type === "set") return new Set(value.value.map(decodeValue));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = decodeValue(item);
  return result;
}

function readTypedVoiceLocalStorage(storage) {
  const result = {};
  if (!storage) return result;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LOCAL_STORAGE_PREFIX)) result[key] = storage.getItem(key);
  }
  return result;
}

export function clearTypedVoiceLocalStorage(storage, { preserveKeys = [] } = {}) {
  if (!storage) return;
  const preserved = new Set(preserveKeys);
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LOCAL_STORAGE_PREFIX) && !preserved.has(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export async function createApplicationBackup({ db, storage = globalThis.localStorage, uiState = null } = {}) {
  if (!db) throw new Error("IndexedDB connection is unavailable.");
  const storeNames = [...db.objectStoreNames];
  const transaction = db.transaction(storeNames, "readonly");
  const done = transactionDone(transaction);
  const requests = storeNames.map((storeName) => requestValue(transaction.objectStore(storeName).getAll()));
  const recordSets = await Promise.all(requests);
  await done;
  const stores = {};
  for (let index = 0; index < storeNames.length; index += 1) {
    stores[storeNames[index]] = await Promise.all(recordSets[index].map((record) => encodeValue(record)));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    database: {
      name: db.name,
      version: db.version,
      stores,
    },
    localStorage: readTypedVoiceLocalStorage(storage),
    uiState: uiState == null ? null : structuredClone(uiState),
    cacheStorageIncluded: false,
  };
}

export function stringifyApplicationBackup(backup) {
  validateApplicationBackup(backup);
  return JSON.stringify(backup, null, 2);
}

export function parseApplicationBackup(text) {
  const backup = JSON.parse(text);
  validateApplicationBackup(backup);
  return backup;
}

export function validateApplicationBackup(backup) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new Error("typed-voiceの対応バックアップではありません。");
  }
  if (!backup.database || typeof backup.database.stores !== "object" || backup.database.stores === null) {
    throw new Error("バックアップ内のIndexedDBデータが壊れています。");
  }
  if (!backup.localStorage || typeof backup.localStorage !== "object") {
    throw new Error("バックアップ内の設定データが壊れています。");
  }
  return backup;
}

export async function restoreApplicationBackup({ db, storage = globalThis.localStorage } = {}, backup) {
  validateApplicationBackup(backup);
  if (!db) throw new Error("IndexedDB connection is unavailable.");
  const currentStores = [...db.objectStoreNames];
  for (const storeName of Object.keys(backup.database.stores)) {
    if (!currentStores.includes(storeName)) throw new Error(`このバージョンに存在しない保存領域です: ${storeName}`);
  }
  const decodedStores = {};
  for (const storeName of currentStores) {
    const encodedRecords = backup.database.stores[storeName] ?? [];
    decodedStores[storeName] = encodedRecords.map(decodeValue);
  }
  const transaction = db.transaction(currentStores, "readwrite");
  const done = transactionDone(transaction);
  for (const storeName of currentStores) {
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const record of decodedStores[storeName]) store.put(record);
  }
  await done;
  clearTypedVoiceLocalStorage(storage);
  for (const [key, value] of Object.entries(backup.localStorage)) storage?.setItem(key, String(value));
}

export async function clearAllApplicationData({ db, storage = globalThis.localStorage } = {}) {
  if (!db) throw new Error("IndexedDB connection is unavailable.");
  const storeNames = TUTORIAL_RESET_DATA_STORES.filter((name) => db.objectStoreNames.contains(name));
  const transaction = db.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction);
  for (const storeName of storeNames) transaction.objectStore(storeName).clear();
  await done;
  clearTypedVoiceLocalStorage(storage, { preserveKeys: RESET_PRESERVED_LOCAL_STORAGE_KEYS });
}

export async function clearConversationData(db) {
  if (!db) throw new Error("IndexedDB connection is unavailable.");
  const storeNames = CONVERSATION_DATA_STORES.filter((name) => db.objectStoreNames.contains(name));
  if (storeNames.length === 0) return;
  const transaction = db.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction);
  for (const storeName of storeNames) transaction.objectStore(storeName).clear();
  await done;
}

export async function readApplicationBackupFile(file) {
  if (!file) throw new Error("バックアップファイルを選択してください。");
  return parseApplicationBackup(await file.text());
}

export function downloadApplicationBackup(documentRef, backup, filename = null) {
  const created = new Date(backup.createdAt || Date.now());
  const stamp = [
    created.getFullYear(),
    String(created.getMonth() + 1).padStart(2, "0"),
    String(created.getDate()).padStart(2, "0"),
    "-",
    String(created.getHours()).padStart(2, "0"),
    String(created.getMinutes()).padStart(2, "0"),
    String(created.getSeconds()).padStart(2, "0"),
  ].join("");
  const blob = new Blob([stringifyApplicationBackup(backup)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = filename || `typed-voice-backup-${stamp}.json`;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  return anchor.download;
}
