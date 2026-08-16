import { assertPreparedVoiceAssets, prepareVoiceAssets, validateVoiceManifest } from "./asset-store.js";
import { LatestRequestQueue } from "./latest-queue.js";
import { OmniVoiceEngine } from "./omnivoice-engine.js";

const queue = new LatestRequestQueue(2);
const latestGeneration = new Map();
let running = false;
let engine = null;
let manifest = null;
let manifestUrl = null;

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
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Failed to fetch voice manifest: ${response.status}`);
  return validateVoiceManifest(await response.json());
}

async function dispatch(message) {
  switch (message.type) {
    case "configure": {
      manifestUrl = message.manifestUrl;
      manifest = await fetchManifest(manifestUrl);
      await engine?.dispose();
      engine = null;
      postMessage({ type: "configured", requestId: message.requestId, manifest });
      return;
    }
    case "prepare": {
      ensureManifest();
      const appBaseUrl = new URL("./", manifestUrl).href;
      const prepared = await prepareVoiceAssets(manifest, {
        baseUrl: appBaseUrl,
        onProgress(progress) {
          postMessage({ type: "progress", requestId: message.requestId, stage: "download", ...progress });
        },
      });
      postMessage({ type: "prepared", requestId: message.requestId, ...prepared });
      return;
    }
    case "initialize": {
      ensureManifest();
      const appBaseUrl = new URL("./", manifestUrl).href;
      await assertPreparedVoiceAssets(manifest, {
        baseUrl: appBaseUrl,
        onProgress(progress) {
          postMessage({ type: "progress", requestId: message.requestId, stage: "initialize", ...progress });
        },
      });
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
      latestGeneration.set(message.utteranceId, message.generation);
      const { replaced, dropped } = queue.enqueue(message);
      for (const item of [...replaced, ...dropped]) {
        postMessage({ type: "discarded", requestId: item.requestId, reason: "superseded" });
      }
      void pumpQueue();
      return;
    }
    case "cancel": {
      latestGeneration.set(message.utteranceId, message.generation);
      const removed = queue.removeOlder(message.utteranceId, message.generation);
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
