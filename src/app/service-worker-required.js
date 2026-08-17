// Bump only this key when deployed HTML/JS/CSS/runtime source must be discarded.
// The prepared model cache uses a separate fixed key and is intentionally preserved.
const SOURCE_CACHE_KEY = "2026-08-17-15";

export async function requireServiceWorker({ reloadKey = "typed-voice-coi-reloaded" } = {}) {
  if (!("serviceWorker" in navigator)) {
    showServiceWorkerRequired();
    throw new Error("Service Worker is unavailable in this browser.");
  }

  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const serviceWorkerUrl = new URL("app-service-worker.js", scopeUrl);
  serviceWorkerUrl.searchParams.set("source-cache", SOURCE_CACHE_KEY);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");

  // An already-controlled page must remain usable with no network at all.
  // Refreshing the worker is an online maintenance operation, not an offline startup dependency.
  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(reloadKey);
    if (navigator.onLine) refreshServiceWorker(serviceWorkerUrl, scopeUrl);
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

function refreshServiceWorker(serviceWorkerUrl, scopeUrl) {
  navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname }).catch((error) => {
    console.warn("Service Worker update check failed; continuing with the installed offline worker", error);
  });
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

