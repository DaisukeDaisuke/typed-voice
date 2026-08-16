export async function requireServiceWorker({ reloadKey = "typed-voice-coi-reloaded" } = {}) {
  if (!("serviceWorker" in navigator)) {
    showServiceWorkerRequired();
    throw new Error("Service Worker is unavailable in this browser.");
  }

  const serviceWorkerUrl = new URL(`${import.meta.env.BASE_URL}app-service-worker.js`, document.baseURI);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");

  try {
    await navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });
  } catch (error) {
    console.error("Service Worker registration failed", error);
    showServiceWorkerRequired();
    throw error;
  }

  if (navigator.serviceWorker.controller) return;
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

export function showServiceWorkerRequired() {
  const overlay = document.querySelector("#service-worker-required");
  if (!overlay) return;
  overlay.hidden = false;
  document.documentElement.classList.add("service-worker-blocked");
  const retry = overlay.querySelector("button");
  retry?.focus({ preventScroll: true });
}

