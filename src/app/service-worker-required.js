import { createXXHash128 } from "hash-wasm";

export const SOURCE_UPDATE_STORAGE_KEY = "typed-voice-source-cache-key-v2";
const PREVIOUS_SOURCE_UPDATE_STORAGE_KEY = "typed-voice-source-cache-key-v1";
const SERVICE_WORKER_REREGISTRATION_MIGRATION_KEY = "typed-voice-sw-reregister-20260821-v1";
const SOURCE_PROTOCOL_VERSION = 2;

function readStorageValue(key, storage = globalThis.localStorage) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readStoredSourceGeneration(storage = globalThis.localStorage) {
  return readStorageValue(SOURCE_UPDATE_STORAGE_KEY, storage);
}

export function markSourceUpdateAcknowledged(generation, storage = globalThis.localStorage) {
  const value = String(generation || "");
  if (!/^[0-9a-f]{32}$/i.test(value)) return false;
  try {
    storage?.setItem(SOURCE_UPDATE_STORAGE_KEY, value.toLowerCase());
    if (storage?.getItem(SOURCE_UPDATE_STORAGE_KEY) !== value.toLowerCase()) return false;
    storage?.removeItem(PREVIOUS_SOURCE_UPDATE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function planSourceAssets(groups, { storage = globalThis.localStorage } = {}) {
  const storedGeneration = readStoredSourceGeneration(storage);
  const previousStoredGeneration = readStorageValue(PREVIOUS_SOURCE_UPDATE_STORAGE_KEY, storage);
  const migrationPending = !storedGeneration && Boolean(previousStoredGeneration);
  const forceMigrationUpdate = navigator.onLine && migrationPending;
  const controller = navigator.serviceWorker?.controller;
  if (!await supportsSourceProtocol(controller)) {
    if (!navigator.onLine) {
      return Object.freeze({
        generation: storedGeneration,
        acceptedGeneration: storedGeneration,
        updateAvailable: false,
        totalBytes: 0,
        fetchBytes: 0,
        reusableBytes: 0,
        assetCount: 0,
        fetchCount: 0,
        protocolUnavailable: true,
      });
    }
    throw new Error("Service Workerの更新確認機能がまだ有効になっていません。再読み込みしてください。");
  }
  const plan = await requestServiceWorker("typed-voice:plan-source-assets", {
    groups,
    knownAcceptedKey: storedGeneration ?? previousStoredGeneration,
  }, "plan");
  if (forceMigrationUpdate) {
    return Object.freeze({ ...plan, updateAvailable: true, forcedMigration: true });
  }
  if (!migrationPending
    && !plan.updateAvailable
    && plan.acceptedGeneration === plan.generation
    && storedGeneration !== plan.generation) {
    markSourceUpdateAcknowledged(plan.generation, storage);
  }
  return plan;
}

export async function applySourceAssets(groups, {
  storage = globalThis.localStorage,
  signal = null,
  onProgress = () => {},
} = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    throw new Error("Service Workerの更新機能がまだ有効になっていません。再読み込みしてください。");
  }
  const requestId = crypto.randomUUID();
  const result = await requestServiceWorker(
    "typed-voice:apply-source-assets",
    { groups, requestId },
    "result",
    120_000,
    {
      signal,
      cancelType: "typed-voice:cancel-source-assets",
      requestId,
      progressKey: "progress",
      onProgress,
    },
  );
  if (!markSourceUpdateAcknowledged(result.generation, storage)) {
    throw new Error("更新済みソースの世代を保存できませんでした。");
  }
  return result;
}

export async function verifyStoredSourceAssets(groups, { onProgress = () => {} } = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    return Object.freeze({
      generation: readStoredSourceGeneration(),
      checkedCount: 0,
      checkedBytes: 0,
      corruptCount: 0,
      corruptBytes: 0,
      missingCount: 0,
      missingBytes: 0,
      protocolUnavailable: true,
    });
  }

  const plan = await requestServiceWorker(
    "typed-voice:source-verification-plan",
    { groups },
    "plan",
  );
  const totalBytes = Number(plan?.availableBytes || 0);
  let checkedBytes = 0;
  let checkedCount = 0;
  let corruptCount = 0;
  let corruptBytes = 0;

  for (const entry of plan?.entries || []) {
    const expectedBytes = Number(entry?.byteSize || 0);
    let loadedForEntry = 0;
    let valid = false;
    try {
      const response = await fetch(entry.url, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`Source verification stream unavailable: ${entry.path}`);
      const hasher = await createXXHash128();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const current = await reader.read();
          if (current.done) break;
          hasher.update(current.value);
          loadedForEntry += current.value.byteLength;
          onProgress({
            path: entry.path,
            checkedBytes: checkedBytes + loadedForEntry,
            totalBytes,
            checkedCount,
            totalCount: plan.entries.length,
          });
        }
      } finally {
        reader.releaseLock();
      }
      valid = loadedForEntry === expectedBytes
        && hasher.digest().toLowerCase() === String(entry.xxh3_128 || "").toLowerCase();
    } catch {
      valid = false;
    }

    checkedBytes += loadedForEntry;
    checkedCount += 1;
    if (!valid) {
      corruptCount += 1;
      corruptBytes += expectedBytes;
      await requestServiceWorker("typed-voice:invalidate-source-asset", {
        generation: plan.generation,
        path: entry.path,
      }, "result");
    }
    onProgress({
      path: entry.path,
      checkedBytes,
      totalBytes,
      checkedCount,
      totalCount: plan.entries.length,
    });
  }

  return Object.freeze({
    generation: plan?.generation ?? null,
    checkedCount,
    checkedBytes,
    corruptCount,
    corruptBytes,
    missingCount: Number(plan?.missingCount || 0),
    missingBytes: Number(plan?.missingBytes || 0),
  });
}

async function requestServiceWorker(type, payload, resultKey, timeoutMs = 10_000, {
  signal = null,
  cancelType = null,
  requestId = null,
  progressKey = null,
  onProgress = null,
} = {}) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) throw new Error("Service Worker is not controlling this page.");
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      channel.port1.close();
      callback(value);
    };
    const cancel = () => {
      if (cancelType && requestId) controller.postMessage({ type: cancelType, requestId });
    };
    const abort = () => {
      cancel();
      finish(reject, signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    const timeout = globalThis.setTimeout(() => {
      cancel();
      finish(reject, new Error("Service Worker source update request timed out."));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = (event) => {
      if (progressKey && event.data?.[progressKey]) {
        if (typeof onProgress === "function") onProgress(event.data[progressKey]);
        return;
      }
      if (event.data?.ok) finish(resolve, event.data[resultKey]);
      else finish(reject, new Error(event.data?.message || "Service Worker source update request failed."));
    };
    controller.postMessage({ type, ...payload }, [channel.port2]);
  });
}

async function supportsSourceProtocol(controller, timeoutMs = 750) {
  if (!controller) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (supported) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      resolve(Boolean(supported));
    };
    const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event) => finish(
      event.data?.ok && Number(event.data?.version) === SOURCE_PROTOCOL_VERSION
    );
    controller.postMessage({ type: "typed-voice:source-protocol" }, [channel.port2]);
  });
}

export async function requireServiceWorker({ reloadKey = "typed-voice-coi-reloaded" } = {}) {
  if (!("serviceWorker" in navigator)) {
    showServiceWorkerRequired();
    throw new Error("Service Worker is unavailable in this browser.");
  }

  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const serviceWorkerUrl = new URL("app-service-worker.js", scopeUrl);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");

  if (navigator.onLine && readStorageValue(SERVICE_WORKER_REREGISTRATION_MIGRATION_KEY) !== "done") {
    const registration = await navigator.serviceWorker.getRegistration(scopeUrl.href).catch(() => null);
    if (registration) {
      const unregistered = await registration.unregister().catch(() => false);
      if (!unregistered) throw new Error("Service Workerの移行再登録に失敗しました。");
      globalThis.localStorage?.setItem?.(SERVICE_WORKER_REREGISTRATION_MIGRATION_KEY, "done");
      location.reload();
      return new Promise(() => {});
    }
    globalThis.localStorage?.setItem?.(SERVICE_WORKER_REREGISTRATION_MIGRATION_KEY, "done");
  }

  // An already-controlled page must remain usable with no network at all.
  // Refreshing the worker is an online maintenance operation, not an offline startup dependency.
  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(reloadKey);
    if (navigator.onLine) await refreshServiceWorker(serviceWorkerUrl, scopeUrl);
    return;
  }

  // A previously installed active worker is persisted by the browser independently of Cache Storage.
  // If this document was loaded before it became controlled, one reload lets that worker handle navigation,
  // including a fully offline navigation from the application shell cache.
  const existing = await navigator.serviceWorker.getRegistration(scopeUrl.href).catch(() => null);
  if (existing?.active) {
    let registration = existing;
    if (navigator.onLine) {
      try {
        registration = await navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname });
        await registration.update().catch(() => {});
      } catch (error) {
        console.warn("Service Worker refresh before control failed; retrying with the installed worker", error);
      }
    }
    requestClientClaim(registration);
    const controller = await waitForServiceWorkerController(5000);
    if (controller) {
      // This document itself was loaded before the worker controlled navigation,
      // so reload once to obtain the worker-provided isolation headers too.
      location.reload();
      return new Promise(() => {});
    }
    reloadUnderExistingServiceWorker(reloadKey);
    return new Promise(() => {});
  }

  if (!navigator.onLine) {
    showServiceWorkerRequired();
    throw new Error("Service Worker has not been installed yet. Connect once to prepare offline use.");
  }

  try {
    await navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname });
  } catch (error) {
    console.error("Service Worker registration failed", error);
    showServiceWorkerRequired();
    throw error;
  }

  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(reloadKey);
    return;
  }
  if (sessionStorage.getItem(reloadKey) === "1") {
    const controller = await waitForServiceWorkerController(5000);
    if (controller) {
      location.reload();
      return new Promise(() => {});
    }
    showServiceWorkerRequired();
    throw new Error("Service Worker registration completed, but this page is not controlled by it.");
  }

  sessionStorage.setItem(reloadKey, "1");
  await waitForServiceWorkerController(5000);
  location.reload();
  return new Promise(() => {});
}

export async function queryPreparedModelCache(manifestUrl, { appBaseUrl = null } = {}) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (prepared) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      resolve(Boolean(prepared));
    };
    const timeout = globalThis.setTimeout(() => finish(false), 5000);
    channel.port1.onmessage = (event) => finish(event.data?.ok && event.data?.prepared);
    controller.postMessage({
      type: "typed-voice:check-model-cache",
      manifestUrl,
      appBaseUrl,
    }, [channel.port2]);
  });
}

export async function refreshTypedVoiceServiceWorker() {
  if (!("serviceWorker" in navigator) || !navigator.onLine) return false;
  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const serviceWorkerUrl = new URL("app-service-worker.js", scopeUrl);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");
  return refreshServiceWorker(serviceWorkerUrl, scopeUrl);
}

async function refreshServiceWorker(serviceWorkerUrl, scopeUrl) {
  try {
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname });
    const previousController = navigator.serviceWorker.controller;
    let updateFound = false;
    const onUpdateFound = () => { updateFound = true; };
    registration.addEventListener("updatefound", onUpdateFound);
    try {
      await registration.update().catch(() => {});
    } finally {
      registration.removeEventListener("updatefound", onUpdateFound);
    }
    if (updateFound || registration.installing || registration.waiting) {
      await waitForServiceWorkerControllerChange(previousController, 5000);
    }
    return supportsSourceProtocol(navigator.serviceWorker.controller);
  } catch (error) {
    console.warn("Service Worker update check failed; continuing with the installed offline worker", error);
    return false;
  }
}

function waitForServiceWorkerControllerChange(previousController, timeoutMs = 5000) {
  if (navigator.serviceWorker.controller && navigator.serviceWorker.controller !== previousController) {
    return Promise.resolve(navigator.serviceWorker.controller);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      resolve(navigator.serviceWorker.controller ?? null);
    };
    const changed = () => {
      if (navigator.serviceWorker.controller !== previousController) finish();
    };
    const timeout = globalThis.setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
  });
}

function reloadUnderExistingServiceWorker(reloadKey) {
  const attempts = Number(sessionStorage.getItem(reloadKey) || 0);
  if (attempts >= 2) {
    showServiceWorkerRequired();
    throw new Error("An active Service Worker exists, but this page is still not controlled by it.");
  }
  sessionStorage.setItem(reloadKey, String(attempts + 1));
  location.reload();
}

function requestClientClaim(registration) {
  try {
    registration?.active?.postMessage({ type: "typed-voice:claim-clients" });
  } catch {
    // Older workers do not know this message. The bounded reload fallback below
    // remains compatible with them while the new worker is being installed.
  }
}

function waitForServiceWorkerController(timeoutMs = 5000) {
  if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      resolve(navigator.serviceWorker.controller ?? null);
    };
    const changed = () => finish();
    const timeout = globalThis.setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
  });
}

export function showServiceWorkerRequired() {
  const overlay = document.querySelector("#service-worker-required");
  if (!overlay) return;
  overlay.hidden = false;
  document.documentElement.classList.add("service-worker-blocked");
  const retry = overlay.querySelector("button");
  retry?.focus({ preventScroll: true });
}

