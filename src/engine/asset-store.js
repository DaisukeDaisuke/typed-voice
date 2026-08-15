import { sha256Stream } from "./incremental-sha256.js";

export const MODEL_CACHE_NAME = "typed-voice-model-assets-v2";
const DB_NAME = "typed-voice-assets";
const DB_VERSION = 2;
const STORE_NAME = "asset-metadata";
const VIRTUAL_PREFIX = "__typed_voice_assets/";

function openDatabase(indexedDBImpl = indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("voice-assets")) db.deleteObjectStore("voice-assets");
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request?.result ?? request);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function isSha256(value) {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
}

function validateAsset(asset) {
  if (!asset || typeof asset !== "object") throw new Error("Invalid asset entry");
  for (const field of ["id", "localPath", "sha256"]) {
    if (typeof asset[field] !== "string" || asset[field].length === 0) throw new Error(`Asset ${field} is required`);
  }
  if (!isSha256(asset.sha256)) throw new Error(`Asset ${asset.id} has invalid SHA-256`);
  if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0) throw new Error(`Asset ${asset.id} has invalid byteSize`);
  const source = asset.source;
  if (!source || source.provider !== "huggingface") throw new Error(`Asset ${asset.id} requires a Hugging Face source`);
  for (const field of ["repo", "revision", "path"]) {
    if (typeof source[field] !== "string" || source[field].length === 0) throw new Error(`Asset ${asset.id} source.${field} is required`);
  }
  if (source.revision === "main" || source.revision === "master") throw new Error(`Asset ${asset.id} must pin an immutable revision`);
}

export function validateVoiceManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2) throw new Error("Unsupported voice manifest schema");
  if (typeof manifest.id !== "string" || manifest.id.length === 0) throw new Error("Manifest id is required");
  if (!manifest.voice || manifest.voice.engine !== "omnivoice") throw new Error("This PoC requires voice.engine=omnivoice");
  if (!manifest.voice.source?.repo || !manifest.voice.source?.revision) throw new Error("Voice source repo/revision are required");
  if (["main", "master"].includes(manifest.voice.source.revision)) throw new Error("Voice source revision must be immutable");
  if (manifest.installable === false) return manifest;
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error("Installable manifest requires assets");
  const ids = new Set();
  const paths = new Set();
  for (const asset of manifest.assets) {
    validateAsset(asset);
    if (ids.has(asset.id)) throw new Error(`Duplicate asset id: ${asset.id}`);
    if (paths.has(asset.localPath)) throw new Error(`Duplicate asset localPath: ${asset.localPath}`);
    ids.add(asset.id);
    paths.add(asset.localPath);
  }
  return manifest;
}

export function buildHuggingFaceResolveUrl(asset) {
  validateAsset(asset);
  const { repo, revision, path } = asset.source;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${revision}/${encodedPath}`;
}

export function buildVirtualAssetUrl(manifestId, localPath, baseUrl = globalThis.location?.href) {
  if (!baseUrl) throw new Error("A base URL is required to build a virtual asset URL");
  const encodedId = encodeURIComponent(manifestId);
  const encodedPath = localPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return new URL(`${VIRTUAL_PREFIX}${encodedId}/${encodedPath}`, baseUrl).href;
}

function keyFor(manifestId, assetId) {
  return `${manifestId}:${assetId}`;
}

async function readMetadata(db, key) {
  return runTransaction(db, "readonly", (store) => store.get(key));
}

async function writeMetadata(db, record) {
  return runTransaction(db, "readwrite", (store) => store.put(record));
}

async function deleteMetadata(db, key) {
  return runTransaction(db, "readwrite", (store) => store.delete(key));
}

async function cacheHasVerifiedAsset({ cache, db, manifest, asset, virtualUrl }) {
  const [cached, metadata] = await Promise.all([cache.match(virtualUrl), readMetadata(db, keyFor(manifest.id, asset.id))]);
  return Boolean(
    cached && metadata && metadata.sha256 === asset.sha256.toLowerCase() && metadata.byteSize === asset.byteSize && metadata.virtualUrl === virtualUrl
  );
}

async function downloadAndVerifyAsset({ fetchImpl, cache, db, manifest, asset, virtualUrl, onProgress }) {
  const response = await fetchImpl(buildHuggingFaceResolveUrl(asset), { cache: "no-store" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${asset.id}`);
  if (!response.body) throw new Error(`Streaming response body is unavailable for ${asset.id}`);
  const declaredSize = Number(response.headers.get("content-length") || response.headers.get("x-linked-size") || 0);
  if (declaredSize > 0 && declaredSize !== asset.byteSize) {
    throw new Error(`Content-Length mismatch for ${asset.id}: expected ${asset.byteSize}, got ${declaredSize}`);
  }

  const [cacheBody, hashBody] = response.body.tee();
  const cacheWrite = cache.put(
    virtualUrl,
    new Response(cacheBody, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "application/octet-stream",
        "content-length": String(asset.byteSize),
        "x-typed-voice-sha256": asset.sha256.toLowerCase(),
      },
    })
  );
  let lastReported = 0;
  const hashResult = sha256Stream(hashBody, ({ loaded }) => {
    if (loaded - lastReported >= 1024 * 1024 || loaded === asset.byteSize) {
      lastReported = loaded;
      onProgress?.({ assetId: asset.id, loaded, total: asset.byteSize });
    }
  });

  let verified;
  try {
    const [, digest] = await Promise.all([cacheWrite, hashResult]);
    verified = digest;
  } catch (error) {
    await cache.delete(virtualUrl);
    throw error;
  }

  if (verified.byteSize !== asset.byteSize || verified.sha256 !== asset.sha256.toLowerCase()) {
    await Promise.all([cache.delete(virtualUrl), deleteMetadata(db, keyFor(manifest.id, asset.id))]);
    throw new Error(`Integrity mismatch for ${asset.id}`);
  }

  await writeMetadata(db, {
    key: keyFor(manifest.id, asset.id),
    manifestId: manifest.id,
    assetId: asset.id,
    virtualUrl,
    sha256: verified.sha256,
    byteSize: verified.byteSize,
    verifiedAt: Date.now(),
    source: asset.source,
  });
}

export async function prepareVoiceAssets(manifest, options = {}) {
  validateVoiceManifest(manifest);
  if (manifest.installable === false) throw new Error(manifest.blockedReason || "Converted runtime assets are not available yet");
  const fetchImpl = options.fetchImpl ?? fetch;
  const cachesImpl = options.cachesImpl ?? caches;
  const db = options.db ?? (await openDatabase(options.indexedDBImpl));
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  let completedBytes = 0;

  for (const asset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, asset.localPath, baseUrl);
    if (await cacheHasVerifiedAsset({ cache, db, manifest, asset, virtualUrl })) {
      completedBytes += asset.byteSize;
      options.onProgress?.({ phase: "cached", assetId: asset.id, loadedBytes: completedBytes, totalBytes });
      continue;
    }
    await downloadAndVerifyAsset({
      fetchImpl,
      cache,
      db,
      manifest,
      asset,
      virtualUrl,
      onProgress: ({ loaded }) => options.onProgress?.({
        phase: "downloading",
        assetId: asset.id,
        loadedBytes: completedBytes + loaded,
        totalBytes,
      }),
    });
    completedBytes += asset.byteSize;
    options.onProgress?.({ phase: "verified", assetId: asset.id, loadedBytes: completedBytes, totalBytes });
  }

  return { manifestId: manifest.id, totalBytes, assetBaseUrl: buildVirtualAssetUrl(manifest.id, "", baseUrl) };
}

export async function assertPreparedVoiceAssets(manifest, options = {}) {
  validateVoiceManifest(manifest);
  if (manifest.installable === false) throw new Error(manifest.blockedReason || "Manifest is not installable");
  const cachesImpl = options.cachesImpl ?? caches;
  const db = options.db ?? (await openDatabase(options.indexedDBImpl));
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  for (const asset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, asset.localPath, baseUrl);
    if (!(await cacheHasVerifiedAsset({ cache, db, manifest, asset, virtualUrl }))) {
      throw new Error(`Prepared asset is missing or unverified: ${asset.id}`);
    }
  }
  return { manifestId: manifest.id, assetBaseUrl: buildVirtualAssetUrl(manifest.id, "", baseUrl) };
}

export async function verifyAssetBytes(bytes, expectedSha256) {
  const { sha256 } = await sha256Stream(new Blob([bytes]).stream());
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  return sha256;
}
