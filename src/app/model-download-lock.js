const DEFAULT_ACQUIRE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 500;
const DEFAULT_RENEW_INTERVAL_MS = 30 * 1000;

function delay(ms, setTimeoutImpl = globalThis.setTimeout) {
  return new Promise((resolve) => setTimeoutImpl(resolve, ms));
}

function requestLockState(controller, message, {
  createMessageChannel = () => new MessageChannel(),
  responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    const channel = createMessageChannel();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeout);
      channel.port1.close?.();
      callback(value);
    };
    const timeout = setTimeoutImpl(() => finish(reject, new Error("Service Worker model download lock response timed out")), responseTimeoutMs);
    channel.port1.onmessage = (event) => finish(resolve, event.data);
    try {
      controller.postMessage(message, [channel.port2]);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function acquireModelDownloadLock(key, options = {}) {
  const controller = options.controller ?? globalThis.navigator?.serviceWorker?.controller;
  if (!controller?.postMessage) return { shared: false, release() {} };

  const normalizedKey = String(key ?? "");
  if (!normalizedKey) throw new Error("model download lock key is required");
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const requestId = randomUUID();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  const setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? globalThis.clearInterval;
  const deadline = now() + acquireTimeoutMs;

  for (;;) {
    let response;
    try {
      response = await requestLockState(controller, {
        type: "typed-voice:model-download-lock-acquire",
        key: normalizedKey,
        requestId,
      }, { ...options, setTimeoutImpl, clearTimeoutImpl });
    } catch (error) {
      if (now() >= deadline) throw error;
      await delay(DEFAULT_RETRY_MS, setTimeoutImpl);
      continue;
    }
    if (!response?.ok) throw new Error(response?.message || "Service Worker rejected the model download lock request");
    if (response.granted) {
      let released = false;
      const renew = () => {
        if (released) return;
        controller.postMessage({
          type: "typed-voice:model-download-lock-renew",
          key: normalizedKey,
          requestId,
        });
      };
      const renewalTimer = setIntervalImpl(renew, renewIntervalMs);
      return {
        shared: true,
        release() {
          if (released) return;
          released = true;
          clearIntervalImpl(renewalTimer);
          controller.postMessage({
            type: "typed-voice:model-download-lock-release",
            key: normalizedKey,
            requestId,
          });
        },
      };
    }
    if (now() >= deadline) throw new Error("Timed out waiting for another tab to finish the model download");
    const retryAfterMs = Number(response.retryAfterMs);
    await delay(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_MS, setTimeoutImpl);
  }
}
