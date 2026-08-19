import {
  assertPreparedVoiceAssets,
  prepareVoiceAssets,
  readPreparedVoiceManifest,
  storePreparedVoiceManifest,
  validateVoiceManifest,
} from "./asset-store.js";
import { LatestRequestQueue } from "./latest-queue.js";
import { OmniVoiceEngine } from "./omnivoice-engine.js";

const queue = new LatestRequestQueue(2);
const latestGeneration = new Map();
let running = false;
let engine = null;
let manifest = null;
let manifestUrl = null;
let appBaseUrl = null;
let verifiedManifestId = null;
let directWorkerRuntime = false;

async function registerDirectWorkerRuntime() {
  if (!directWorkerRuntime || !appBaseUrl) return;
  const response = await fetch(new URL("__typed_voice_worker_runtime/register", appBaseUrl), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Trusted Worker runtime registration failed: ${response.status}`);
}

self.addEventListener("message", (event) => {
  const message = event.data;
  void dispatch(message).catch((error) => {
    postMessage({
      type: "error",
      requestId: message?.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

async function fetchManifest(url) {
  let networkError;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Failed to fetch voice manifest: ${response.status}`);
    return validateVoiceManifest(await response.json());
  } catch (error) {
    networkError = error;
  }

  const cached = await readPreparedVoiceManifest(url);
  if (cached) return cached;
  throw networkError;
}

async function dispatch(message) {
  switch (message.type) {
    case "configure": {
      manifestUrl = message.manifestUrl;
      appBaseUrl = message.appBaseUrl || new URL("./", manifestUrl).href;
      directWorkerRuntime = message.directWorkerRuntime === true;
      await registerDirectWorkerRuntime();
      manifest = await fetchManifest(manifestUrl);
      verifiedManifestId = null;
      await engine?.dispose();
      engine = null;
      postMessage({ type: "configured", requestId: message.requestId, manifest });
      return;
    }
    case "prepare": {
      ensureManifest();
      const prepared = await prepareVoiceAssets(manifest, {
        baseUrl: appBaseUrl,
        onProgress(progress) {
          postMessage({ type: "progress", requestId: message.requestId, stage: "download", ...progress });
        },
      });
      await storePreparedVoiceManifest(manifestUrl, manifest);
      verifiedManifestId = manifest.id;
      postMessage({ type: "prepared", requestId: message.requestId, ...prepared });
      return;
    }
    case "initialize": {
      ensureManifest();
      await registerDirectWorkerRuntime();
      if (verifiedManifestId !== manifest.id) {
        await assertPreparedVoiceAssets(manifest, {
          baseUrl: appBaseUrl,
          onProgress(progress) {
            postMessage({ type: "progress", requestId: message.requestId, stage: "initialize", ...progress });
          },
        });
        verifiedManifestId = manifest.id;
      }
      await engine?.dispose();
      engine = new OmniVoiceEngine({ preferredThreadCount: message.preferredThreadCount ?? 0 });
      const ready = await engine.initialize(manifest, {
        appBaseUrl,
        onStatus(status) {
          postMessage({ type: "progress", requestId: message.requestId, stage: "initialize", ...status });
        },
      });
      postMessage({ type: "ready", requestId: message.requestId, ...ready });
      return;
    }
    case "synthesize": {
      ensureManifest();
      const latest = latestGeneration.get(message.utteranceId);
      if (Number.isFinite(latest) && message.generation < latest) {
        postMessage({ type: "discarded", requestId: message.requestId, reason: "stale-generation" });
        return;
      }
      latestGeneration.set(message.utteranceId, message.generation);
      const { replaced, dropped } = queue.enqueue(message);
      for (const item of [...replaced, ...dropped]) {
        postMessage({ type: "discarded", requestId: item.requestId, reason: "superseded" });
      }
      void pumpQueue();
      return;
    }
    case "cancel": {
      const cancelledBeforeGeneration = message.generation + 1;
      latestGeneration.set(message.utteranceId, cancelledBeforeGeneration);
      const removed = queue.removeOlder(message.utteranceId, cancelledBeforeGeneration);
      for (const item of removed) {
        postMessage({ type: "discarded", requestId: item.requestId, reason: "cancelled" });
      }
      postMessage({ type: "cancelled", requestId: message.requestId });
      return;
    }
    case "dispose": {
      await engine?.dispose();
      engine = null;
      postMessage({ type: "disposed", requestId: message.requestId });
      return;
    }
    default:
      throw new Error(`Unknown worker message: ${message.type}`);
  }
}

function ensureManifest() {
  if (!manifest) throw new Error("Engine worker is not configured");
}

async function pumpQueue() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const request = queue.shift();
      if (!request) break;
      if (!engine) {
        postMessage({ type: "error", requestId: request.requestId, message: "Engine is not initialized" });
        continue;
      }
      const isCancelled = () => latestGeneration.get(request.utteranceId) !== request.generation;
      if (isCancelled()) {
        postMessage({ type: "discarded", requestId: request.requestId, reason: "stale-generation" });
        continue;
      }

      try {
        const result = await engine.synthesize(request.text, {
          ...request.options,
          isCancelled,
          onStep(step) {
            postMessage({
              type: "progress",
              requestId: request.requestId,
              stage: "generate",
              utteranceId: request.utteranceId,
              generation: request.generation,
              ...step,
            });
          },
        });
        if (isCancelled()) {
          postMessage({ type: "discarded", requestId: request.requestId, reason: "stale-generation" });
          continue;
        }
        const pcm = result.pcm.byteOffset === 0 && result.pcm.byteLength === result.pcm.buffer.byteLength
          ? result.pcm
          : result.pcm.slice();
        postMessage(
          {
            type: "result",
            requestId: request.requestId,
            utteranceId: request.utteranceId,
            generation: request.generation,
            samples: pcm,
            sampleRate: result.sampleRate,
            backend: result.backend,
            tokenHash: result.tokenHash,
            targetLength: result.targetLength,
          },
          [pcm.buffer]
        );
      } catch (error) {
        if (isCancelled() || error?.message === "cancelled") {
          postMessage({ type: "discarded", requestId: request.requestId, reason: "cancelled" });
          continue;
        }
        postMessage({
          type: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
    if (queue.length > 0) void pumpQueue();
  }
}
