import { createXXHash128 } from "hash-wasm";

export const SOURCE_UPDATE_STORAGE_KEY = "typed-voice-source-cache-key-v1";
const SOURCE_PROTOCOL_VERSION = 1;

export function readStoredSourceGeneration(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(SOURCE_UPDATE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function markSourceUpdateAcknowledged(generation, storage = globalThis.localStorage) {
  const value = String(generation || "");
  if (!/^[0-9a-f]{32}$/i.test(value)) return false;
  try {
    storage?.setItem(SOURCE_UPDATE_STORAGE_KEY, value.toLowerCase());
    return storage?.getItem(SOURCE_UPDATE_STORAGE_KEY) === value.toLowerCase();
  } catch {
    return false;
  }
}

export async function planSourceAssets(groups, { storage = globalThis.localStorage } = {}) {
  const storedGeneration = readStoredSourceGeneration(storage);
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
    knownAcceptedKey: storedGeneration,
  }, "plan");
  if (!plan.updateAvailable
    && plan.acceptedGeneration === plan.generation
    && storedGeneration !== plan.generation) {
    markSourceUpdateAcknowledged(plan.generation, storage);
  }
  return plan;
}

export async function applySourceAssets(groups, { storage = globalThis.localStorage, signal = null } = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    throw new Error("Service Workerの更新機能がまだ有効になっていません。再読み込みしてください。");
  }
  const requestId = crypto.randomUUID();
  const result = await requestServiceWorker(
    "typed-voice:apply-source-assets",
    { groups, requestId },
    "result",
    120_000,
    { signal, cancelType: "typed-voice:cancel-source-assets", requestId },
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
    showServiceWorkerRequired();
    throw new Error("Service Worker registration completed, but this page is not controlled by it.");
  }

  sessionStorage.setItem(reloadKey, "1");
  try {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    location.reload();
  } catch (error) {
    console.error("Service Worker activation failed", error);
    showServiceWorkerRequired();
    throw error;
  }
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

async function refreshServiceWorker(serviceWorkerUrl, scopeUrl) {
  try {
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname });
    await registration.update().catch(() => {});
    if (await supportsSourceProtocol(navigator.serviceWorker.controller)) return true;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", finish);
        resolve();
      };
      const timeout = globalThis.setTimeout(finish, 5000);
      navigator.serviceWorker.addEventListener("controllerchange", finish);
    });
    return supportsSourceProtocol(navigator.serviceWorker.controller);
  } catch (error) {
    console.warn("Service Worker update check failed; continuing with the installed offline worker", error);
    return false;
  }
}

function reloadUnderExistingServiceWorker(reloadKey) {
  if (sessionStorage.getItem(reloadKey) === "1") {
    showServiceWorkerRequired();
    throw new Error("An active Service Worker exists, but this page is still not controlled by it.");
  }
  sessionStorage.setItem(reloadKey, "1");
  location.reload();
}

export function showServiceWorkerRequired() {
  const overlay = document.querySelector("#service-worker-required");
  if (!overlay) return;
  overlay.hidden = false;
  document.documentElement.classList.add("service-worker-blocked");
  const retry = overlay.querySelector("button");
  retry?.focus({ preventScroll: true });
}

