const MODEL_CACHE_NAME = "typed-voice-model-assets-v2";
const KANALIZER_MODEL_CACHE_NAME = "typed-voice-kanalizer-model-v1";
const SOURCE_CACHE_PREFIX = "typed-voice-source-";
const HUGGINGFACE_RESOLVE_CACHE_PREFIX = "typed-voice-huggingface-resolve-";
const ASSET_STORE_NAME = "assets";

export function isTypedVoiceOwnedCacheName(name) {
  return name === MODEL_CACHE_NAME
    || name === KANALIZER_MODEL_CACHE_NAME
    || name.startsWith(SOURCE_CACHE_PREFIX)
    || name.startsWith(HUGGINGFACE_RESOLVE_CACHE_PREFIX);
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function clearTypedVoiceAssetMetadata(db) {
  if (!db?.objectStoreNames?.contains?.(ASSET_STORE_NAME)) return false;
  const transaction = db.transaction(ASSET_STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(ASSET_STORE_NAME).clear();
  await done;
  return true;
}

export async function clearTypedVoiceCacheStorage(cachesImpl = globalThis.caches) {
  if (!cachesImpl?.keys || !cachesImpl?.delete) throw new Error("Cache Storageを利用できません。");
  const names = (await cachesImpl.keys()).filter(isTypedVoiceOwnedCacheName);
  await Promise.all(names.map((name) => cachesImpl.delete(name)));
  return names;
}

function workerScriptMatches(worker, expectedWorkerUrl) {
  if (!worker?.scriptURL) return false;
  const actual = new URL(worker.scriptURL);
  return actual.origin === expectedWorkerUrl.origin && actual.pathname === expectedWorkerUrl.pathname;
}

export async function findTypedVoiceServiceWorkerRegistration({
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  baseUrl = globalThis.document?.baseURI,
} = {}) {
  if (!serviceWorkerContainer?.getRegistration) throw new Error("Service Workerを利用できません。");
  if (!baseUrl) throw new Error("typed-voiceのURLを確認できません。");
  const expectedWorkerUrl = new URL("app-service-worker.js", baseUrl);
  const scopeUrl = new URL("./", expectedWorkerUrl);
  const registration = await serviceWorkerContainer.getRegistration(scopeUrl.href);
  if (!registration) return null;
  const workers = [registration.active, registration.waiting, registration.installing];
  if (!workers.some((worker) => workerScriptMatches(worker, expectedWorkerUrl))) {
    throw new Error("typed-voice以外のService Workerは登録解除しません。");
  }
  return registration;
}

export async function resetTypedVoiceOfflineRuntime({
  db,
  cachesImpl = globalThis.caches,
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  baseUrl = globalThis.document?.baseURI,
} = {}) {
  const registration = await findTypedVoiceServiceWorkerRegistration({ serviceWorkerContainer, baseUrl });
  let serviceWorkerUnregistered = false;
  if (registration) {
    serviceWorkerUnregistered = await registration.unregister();
    if (!serviceWorkerUnregistered) throw new Error("Service Workerの登録解除に失敗しました。");
  }
  try {
    const [deletedCaches, metadataCleared] = await Promise.all([
      clearTypedVoiceCacheStorage(cachesImpl),
      clearTypedVoiceAssetMetadata(db),
    ]);
    return { serviceWorkerUnregistered, deletedCaches, metadataCleared };
  } catch (error) {
    if (serviceWorkerUnregistered && error && typeof error === "object") error.requiresReload = true;
    throw error;
  }
}

export class OfflineRuntimeResetUiController {
  constructor(documentRef = document, {
    db = null,
    cachesImpl = globalThis.caches,
    serviceWorkerContainer = globalThis.navigator?.serviceWorker,
    locationRef = globalThis.location,
  } = {}) {
    this.document = documentRef;
    this.db = db;
    this.cachesImpl = cachesImpl;
    this.serviceWorkerContainer = serviceWorkerContainer;
    this.location = locationRef;
    this.running = false;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.reset.addEventListener("click", () => void this.#reset());
    this.elements.reload.addEventListener("click", () => this.location.reload());
    return this;
  }

  showFreeze() {
    this.elements.freeze.hidden = false;
    for (const child of this.document.body.children) {
      if (child !== this.elements.freeze) child.inert = true;
    }
    this.document.documentElement.classList.add("offline-runtime-frozen");
    this.elements.reload.focus({ preventScroll: true });
  }

  async #reset() {
    if (this.running) return;
    this.running = true;
    this.elements.reset.disabled = true;
    this.elements.status.textContent = "サービスワーカの登録とtyped-voiceのキャッシュを削除しています。";
    try {
      await resetTypedVoiceOfflineRuntime({
        db: this.db,
        cachesImpl: this.cachesImpl,
        serviceWorkerContainer: this.serviceWorkerContainer,
        baseUrl: this.document.baseURI,
      });
      this.showFreeze();
    } catch (error) {
      if (error?.requiresReload) {
        this.showFreeze();
        return;
      }
      this.elements.status.textContent = error instanceof Error ? error.message : String(error);
      this.elements.reset.disabled = false;
      this.running = false;
    }
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required offline reset UI element is missing: ${id}`);
      return element;
    };
    return {
      reset: byId("offline-runtime-reset"),
      status: byId("offline-runtime-reset-status"),
      freeze: byId("offline-reset-freeze"),
      reload: byId("offline-reset-reload"),
    };
  }
}

export function initializeOfflineRuntimeResetUi(documentRef = document, options = {}) {
  return new OfflineRuntimeResetUiController(documentRef, options).initialize();
}
