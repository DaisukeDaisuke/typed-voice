const DATABASE_NAME = "typed-voice-remote";
const DATABASE_VERSION = 1;
const STORE_NAME = "state";
const PAIRING_KEY = "pairingV1";

function openDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl?.open) return Promise.reject(new Error("IndexedDBを利用できません。"));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("接続情報の保存領域を開けませんでした。"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("接続情報を読み書きできませんでした。"));
  });
}

async function withStore(mode, callback, indexedDBImpl = globalThis.indexedDB) {
  const db = await openDatabase(indexedDBImpl);
  try {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return await callback(store);
  } finally {
    db.close?.();
  }
}

export function readRemotePairing(indexedDBImpl = globalThis.indexedDB) {
  return withStore("readonly", (store) => requestResult(store.get(PAIRING_KEY)), indexedDBImpl);
}

export function writeRemotePairing(pairing, indexedDBImpl = globalThis.indexedDB) {
  return withStore("readwrite", (store) => requestResult(store.put(pairing, PAIRING_KEY)), indexedDBImpl);
}
