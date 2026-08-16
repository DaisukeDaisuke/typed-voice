import "./style.css";
import { EngineClient } from "./engine/engine-client.js";

const isolationStatus = document.querySelector("#isolation-status");
const engineStatus = document.querySelector("#engine-status");
const voiceNotice = document.querySelector("#voice-notice");
const prepareButton = document.querySelector("#prepare-button");
const initializeButton = document.querySelector("#initialize-button");
const speakButton = document.querySelector("#speak-button");
const speechText = document.querySelector("#speech-text");

let client = null;
let manifest = null;

await registerServiceWorkerForIsolation();
isolationStatus.textContent = globalThis.crossOriginIsolated
  ? "Cross-Origin Isolation: 有効。WASMマルチスレッドを利用できます。"
  : "Cross-Origin Isolation: 無効。WASMは1スレッドへフォールバックします。";

await loadVoiceManifest();

prepareButton.addEventListener("click", async () => {
  await runButtonTask(prepareButton, async () => {
    engineStatus.textContent = "つくよみちゃんFP32 runtimeを取得し、ストリーミングSHA-256検証後にオフラインCacheへ保存しています。";
    const prepared = await client.prepare();
    engineStatus.textContent = `オフライン音声準備完了: ${(prepared.totalBytes / 1024 / 1024).toFixed(1)} MiB`;
    initializeButton.disabled = false;
  });
});

initializeButton.addEventListener("click", async () => {
  await runButtonTask(initializeButton, async () => {
    engineStatus.textContent = "保存済みモデルからOmniVoiceエンジンを起動し、実forwardでbackendを検証しています。";
    const ready = await client.initialize();
    engineStatus.textContent = `エンジン起動完了: backend=${ready.backend}, sampleRate=${ready.sampleRate}`;
    speakButton.disabled = false;
  });
});

speakButton.addEventListener("click", async () => {
  const text = speechText.value.trim();
  if (!text) return;
  const audioContext = new AudioContext();
  await audioContext.resume();
  await runButtonTask(speakButton, async () => {
    const utteranceId = crypto.randomUUID();
    const startedAt = performance.now();
    const result = await client.synthesize({
      utteranceId,
      generation: 1,
      text,
      options: { language: "ja" },
    });
    const elapsed = performance.now() - startedAt;
    await playFloat32(audioContext, result.samples, result.sampleRate);
    engineStatus.textContent = `生成 ${elapsed.toFixed(0)} ms / 音声 ${(result.samples.length / result.sampleRate).toFixed(2)} s / ${result.backend}`;
  });
});

async function loadVoiceManifest() {
  speakButton.disabled = true;
  initializeButton.disabled = true;
  prepareButton.disabled = true;
  if (client) await client.dispose();
  const manifestUrl = new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
  client = new EngineClient({
    manifestUrl,
    onProgress(message) {
      if (message.stage === "download") {
        const loaded = Number(message.loadedBytes || 0);
        const total = Number(message.totalBytes || 0);
        const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
        engineStatus.textContent = `取得・検証: ${message.assetId || "asset"} ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB (${percentage}%)`;
      } else if (message.stage === "generate") {
        engineStatus.textContent = `OmniVoice生成: step ${message.step}/${message.numStep}, masked=${message.remaining}`;
      } else if (message.stage === "initialize") {
        if (message.phase === "verifying-cache" || message.phase === "verified-cache") {
          const loaded = Number(message.loadedBytes || 0);
          const total = Number(message.totalBytes || 0);
          const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
          engineStatus.textContent = `保存済み音声をSHA-256再検証: ${message.assetId || "asset"} ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB (${percentage}%)`;
        } else {
          engineStatus.textContent = `エンジン初期化: ${message.phase}${message.backend ? ` (${message.backend})` : ""}`;
        }
      }
    },
  });
  manifest = await client.getManifest();
  voiceNotice.textContent = manifest.displayName;
  prepareButton.disabled = manifest.preparable === false || !Array.isArray(manifest.assets) || manifest.assets.length === 0;
  initializeButton.disabled = manifest.installable === false;
  engineStatus.textContent = manifest.installable === false
    ? (manifest.blockedReason || "音声runtimeは現在利用できません。")
    : "最初に「オフライン音声を準備」を実行してください。";
}

async function playFloat32(audioContext, samples, sampleRate) {
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  await new Promise((resolve) => {
    source.addEventListener("ended", resolve, { once: true });
    source.start();
  });
}

async function runButtonTask(button, task) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    engineStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (button === prepareButton) {
      button.disabled = manifest?.preparable === false || !Array.isArray(manifest?.assets) || manifest.assets.length === 0;
    } else if (button === initializeButton) {
      button.disabled = manifest?.installable === false;
    } else {
      button.disabled = false;
    }
  }
}

async function registerServiceWorkerForIsolation() {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) {
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (registration) await registration.unregister();
    if ("caches" in globalThis) {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith("typed-voice-shell-"))
          .map((name) => caches.delete(name))
      );
    }
    if (navigator.serviceWorker.controller && sessionStorage.getItem("typed-voice-dev-sw-cleared") !== "1") {
      sessionStorage.setItem("typed-voice-dev-sw-cleared", "1");
      location.reload();
      await new Promise(() => {});
    }
    sessionStorage.removeItem("typed-voice-coi-reloaded");
    return;
  }
  const serviceWorkerUrl = new URL(`${import.meta.env.BASE_URL}app-service-worker.js`, document.baseURI);
  await navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });
  if (navigator.serviceWorker.controller || globalThis.crossOriginIsolated) return;
  if (sessionStorage.getItem("typed-voice-coi-reloaded") === "1") return;
  sessionStorage.setItem("typed-voice-coi-reloaded", "1");
  await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  location.reload();
}
