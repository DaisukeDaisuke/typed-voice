function showServiceWorkerRequired() {
  const overlay = document.getElementById("service-worker-required");
  if (overlay) overlay.hidden = false;
  document.documentElement.classList.add("service-worker-blocked");
}

async function waitForController(timeoutMs = 5000) {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve(navigator.serviceWorker.controller ?? null);
    };
    const timeout = setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", finish);
  });
}

async function bootstrapWorkerPage() {
  if (!("serviceWorker" in navigator)) {
    showServiceWorkerRequired();
    return;
  }

  if (navigator.serviceWorker.controller) {
    await import("./worker.js");
    return;
  }

  try {
    const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
    const registration = await navigator.serviceWorker.register(
      new URL("app-service-worker.js", scopeUrl),
      { scope: scopeUrl.pathname },
    );
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      try {
        registration.active?.postMessage({ type: "typed-voice:claim-clients" });
      } catch {}
      await waitForController();
    }
  } catch (error) {
    console.error("Trusted Worker Service Worker bootstrap failed", error);
    showServiceWorkerRequired();
    return;
  }

  if (!navigator.serviceWorker.controller) {
    showServiceWorkerRequired();
    return;
  }

  location.reload();
}

void bootstrapWorkerPage();
