import "./poc.css";
import { EngineClient } from "./engine/engine-client.js";
import { requireServiceWorker } from "./app/service-worker-required.js";

const REMOTE_MANIFEST_URLS = Object.freeze({
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/typed-voice-manifest.json",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/typed-voice-manifest.json",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/typed-voice-manifest.json",
});

const statusElement = document.getElementById("server-engine-status");
const query = new URL(location.href).searchParams;
const profile = query.get("profile") || "fp16";
const preferredThreadCount = Math.max(0, Math.min(64, Number(query.get("threads")) || 0));
const appBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const manifestUrl = REMOTE_MANIFEST_URLS[profile]
  || new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;

await requireServiceWorker({ reloadKey: `typed-voice-server-engine-${profile}-coi-reloaded` });
const client = new EngineClient({
  manifestUrl,
  appBaseUrl,
  onProgress(message) {
    if (message.stage === "initialize" && message.phase) statusElement.textContent = `音声エンジン: ${message.phase}`;
  },
});
const generations = new Map();
let engineInfo = null;
let engineError = null;

function encodeBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  }
  return btoa(binary);
}

const readyPromise = (async () => {
  try {
    statusElement.textContent = `音声データを準備しています (${profile})。`;
    await client.prepare(preferredThreadCount);
    statusElement.textContent = "WebGPU/WASM音声エンジンを初期化しています。";
    engineInfo = await client.initialize(preferredThreadCount);
    statusElement.textContent = `準備完了: ${engineInfo.backend}`;
    return engineInfo;
  } catch (error) {
    engineError = error instanceof Error ? error : new Error(String(error));
    statusElement.textContent = `起動失敗: ${engineError.message}`;
    throw engineError;
  }
})();
void readyPromise.catch(() => {});

function parseInput(input) {
  if (typeof input !== "string") return input || {};
  return input.trim() ? JSON.parse(input) : {};
}

async function synthesize(input) {
  await readyPromise;
  const parsed = parseInput(input);
  const id = String(parsed.id ?? "");
  const text = String(parsed.text ?? "");
  if (!id || !text.trim()) throw new Error("id and text are required");
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  const result = await client.synthesize({
    utteranceId: id,
    generation,
    text,
    options: { language: "ja", speed: 1 },
  });
  const bytes = new Uint8Array(result.samples.buffer, result.samples.byteOffset, result.samples.byteLength);
  return JSON.stringify({
    id,
    generation,
    sampleRate: result.sampleRate,
    sampleCount: result.samples.length,
    backend: result.backend,
    audioBase64: encodeBase64(bytes),
  });
}

async function cancel(input) {
  const parsed = parseInput(input);
  const id = String(parsed.id ?? "");
  if (!id) return JSON.stringify({ cancelled: false });
  const generation = generations.get(id);
  if (!generation) return JSON.stringify({ cancelled: false });
  await client.cancel(id, generation);
  return JSON.stringify({ cancelled: true, id, generation });
}

async function status() {
  return JSON.stringify({
    ready: Boolean(engineInfo),
    profile,
    backend: engineInfo?.backend ?? null,
    sampleRate: engineInfo?.sampleRate ?? null,
    error: engineError?.message ?? null,
  });
}

async function registerWebMcp() {
  const modelContext = ("modelContext" in document && document.modelContext)
    || ("modelContext" in navigator && navigator.modelContext);
  if (!modelContext || typeof modelContext.registerTool !== "function") throw new Error("WebMCP API is unavailable");
  const tools = [{
    name: "typed-voice.status",
    title: "typed-voice server status",
    description: "Returns the local typed-voice synthesis engine status.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: status,
  }, {
    name: "typed-voice.synthesize",
    title: "typed-voice synthesize",
    description: "Synthesizes Japanese speech locally and returns Float32 mono audio to the local CDP/WebMCP controller.",
    inputSchema: {
      type: "object",
      required: ["id", "text"],
      properties: { id: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    execute: synthesize,
  }, {
    name: "typed-voice.cancel",
    title: "typed-voice cancel",
    description: "Cancels the matching local synthesis generation when possible.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    execute: cancel,
  }];
  for (const tool of tools) {
    try {
      await modelContext.registerTool(tool);
    } catch (error) {
      if (!/already|duplicate/i.test(String(error?.message || error))) throw error;
    }
  }
}

await registerWebMcp();
globalThis.TypedVoiceServerEngine = Object.freeze({ ready: () => readyPromise, status });
