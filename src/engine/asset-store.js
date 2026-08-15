const DB_NAME = "typed-voice-assets";
const DB_VERSION = 1;
const STORE_NAME = "voice-assets";

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 verification requires crypto.subtle");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAssetBytes(bytes, expectedSha256) {
  if (!expectedSha256) {
    return null;
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}

export function validateVoiceManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error("Unsupported voice manifest");
  }
  for (const key of ["id", "repo", "revision"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      throw new Error(`voice manifest is missing ${key}`);
    }
  }
  if (!manifest.files?.model?.path || !manifest.files?.model?.sha256 || !manifest.files?.config?.path) {
    throw new Error("voice manifest is missing model/config metadata");
  }
  return manifest;
}

export async function fetchVoiceManifest(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to fetch voice manifest: ${response.status} ${response.statusText}`);
  }
  return validateVoiceManifest(await response.json());
}

export function buildHuggingFaceResolveUrl(manifest, path) {
  if (manifest.provider !== "huggingface") {
    throw new Error(`Unsupported voice provider: ${manifest.provider}`);
  }
  const repo = manifest.repo.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(manifest.revision)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function fetchArrayBufferWithProgress(url, onProgress, fetchImpl) {
  const response = await fetchImpl(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body || typeof onProgress !== "function") {
    return response.arrayBuffer();
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total, percentage: total > 0 ? (loaded / total) * 100 : 0 });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function cacheKey(manifest) {
  return `${manifest.id}@${manifest.revision}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putCachedRecord(key, value) {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    await requestAsPromise(transaction.objectStore(STORE_NAME).put(value, key));
  } finally {
    db.close();
  }
}

async function getCachedRecord(key) {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    return await requestAsPromise(transaction.objectStore(STORE_NAME).get(key));
  } finally {
    db.close();
  }
}

export async function prepareVoiceAssets(manifest, { onProgress, fetchImpl = fetch } = {}) {
  validateVoiceManifest(manifest);
  const modelUrl = buildHuggingFaceResolveUrl(manifest, manifest.files.model.path);
  const configUrl = buildHuggingFaceResolveUrl(manifest, manifest.files.config.path);

  const configResponse = await fetchImpl(configUrl, { mode: "cors", credentials: "omit" });
  if (!configResponse.ok) {
    throw new Error(`Failed to fetch voice config: ${configResponse.status} ${configResponse.statusText}`);
  }
  const configText = await configResponse.text();
  const config = JSON.parse(configText);
  const modelData = await fetchArrayBufferWithProgress(modelUrl, onProgress, fetchImpl);
  const modelSha256 = await verifyAssetBytes(modelData, manifest.files.model.sha256);

  const record = {
    manifestId: manifest.id,
    revision: manifest.revision,
    modelSha256,
    modelData,
    config,
    installedAt: Date.now(),
    verifiedAt: null,
  };
  await putCachedRecord(cacheKey(manifest), record);
  return record;
}

export async function markPreparedVoiceAssetsVerified(manifest) {
  validateVoiceManifest(manifest);
  const key = cacheKey(manifest);
  const record = await getCachedRecord(key);
  if (!record) {
    throw new Error("Prepared voice assets disappeared before verification completed");
  }
  await verifyAssetBytes(record.modelData, manifest.files.model.sha256);
  record.verifiedAt = Date.now();
  await putCachedRecord(key, record);
}

export async function loadPreparedVoiceAssets(manifest) {
  validateVoiceManifest(manifest);
  const record = await getCachedRecord(cacheKey(manifest));
  if (!record || !record.verifiedAt) {
    return null;
  }
  await verifyAssetBytes(record.modelData, manifest.files.model.sha256);
  return record;
}