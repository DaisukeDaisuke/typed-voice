import {
  fetchVoiceManifest,
  loadPreparedVoiceAssets,
  markPreparedVoiceAssetsVerified,
  prepareVoiceAssets,
} from "./asset-store.js";
import { LatestRequestQueue } from "./latest-queue.js";
import { PiperEngine } from "./piper-engine.js";

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

async function dispatch(message) {
  switch (message.type) {
    case "configure":
      manifestUrl = message.manifestUrl;
      manifest = await fetchVoiceManifest(manifestUrl);
      postMessage({ type: "configured", requestId: message.requestId, manifest });
      return;
    case "prepare":
      await ensureManifest();
      {
        const assets = await prepareVoiceAssets(manifest, {
          onProgress(progress) {
            postMessage({ type: "progress", requestId: message.requestId, stage: "download", ...progress });
          },
        });
        engine?.dispose();
        engine = new PiperEngine();
        await engine.initialize({
          modelData: assets.modelData,
          config: assets.config,
          preferredThreadCount: message.preferredThreadCount ?? 0,
          wasmBaseUrl: new URL("./", manifestUrl).href,
          synthesisDefaults: manifest.inference,
        });
        postMessage({ type: "progress", requestId: message.requestId, stage: "verify", loaded: 1, total: 1, percentage: 100 });
        const smoke = await engine.synthesize("こんにちは");
        if (!(smoke.samples instanceof Float32Array) || smoke.samples.length === 0) {
          throw new Error("Offline voice verification produced empty PCM");
        }
        await markPreparedVoiceAssetsVerified(manifest);
        postMessage({
          type: "prepared",
          requestId: message.requestId,
          threadCount: engine.threadCount,
          sampleRate: smoke.sampleRate,
          sampleCount: smoke.samples.length,
        });
      }
      return;
    case "initialize": {
      await ensureManifest();
      const assets = await loadPreparedVoiceAssets(manifest);
      if (!assets) {
        throw new Error("オフライン音声が未準備です");
      }
      engine?.dispose();
      engine = new PiperEngine();
      await engine.initialize({
        modelData: assets.modelData,
        config: assets.config,
        preferredThreadCount: message.preferredThreadCount ?? 0,
        wasmBaseUrl: new URL("./", manifestUrl).href,
        synthesisDefaults: manifest.inference,
      });
      postMessage({
        type: "ready",
        requestId: message.requestId,
        threadCount: engine.threadCount,
      });
      return;
    }
    case "synthesize": {
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
    case "dispose":
      engine?.dispose();
      engine = null;
      postMessage({ type: "disposed", requestId: message.requestId });
      return;
    default:
      throw new Error(`Unknown worker message: ${message.type}`);
  }
}

async function ensureManifest() {
  if (!manifest) {
    if (!manifestUrl) {
      throw new Error("Engine worker is not configured");
    }
    manifest = await fetchVoiceManifest(manifestUrl);
  }
}

async function pumpQueue() {
  if (running) {
    return;
  }
  running = true;
  try {
    for (;;) {
      const request = queue.shift();
      if (!request) {
        break;
      }
      if (!engine) {
        postMessage({ type: "error", requestId: request.requestId, message: "Engine is not initialized" });
        continue;
      }
      const currentGeneration = latestGeneration.get(request.utteranceId);
      if (currentGeneration !== request.generation) {
        postMessage({ type: "discarded", requestId: request.requestId, reason: "stale-generation" });
        continue;
      }

      try {
        const result = await engine.synthesize(request.text, request.options);
        if (latestGeneration.get(request.utteranceId) !== request.generation) {
          postMessage({ type: "discarded", requestId: request.requestId, reason: "stale-generation" });
          continue;
        }
        const samples =
          result.samples.byteOffset === 0 && result.samples.byteLength === result.samples.buffer.byteLength
            ? result.samples
            : result.samples.slice();
        postMessage(
          {
            type: "result",
            requestId: request.requestId,
            utteranceId: request.utteranceId,
            generation: request.generation,
            samples,
            sampleRate: result.sampleRate,
          },
          [samples.buffer]
        );
      } catch (error) {
        postMessage({
          type: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
    if (queue.length > 0) {
      void pumpQueue();
    }
  }
}