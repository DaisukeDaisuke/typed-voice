import "./style.css";
import { EngineClient } from "./engine/engine-client.js";

const isolationStatus = document.querySelector("#isolation-status");
const engineStatus = document.querySelector("#engine-status");
const prepareButton = document.querySelector("#prepare-button");
const initializeButton = document.querySelector("#initialize-button");
const speakButton = document.querySelector("#speak-button");
const speechText = document.querySelector("#speech-text");

await registerServiceWorkerForIsolation();

const manifestUrl = new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
const client = new EngineClient({
  manifestUrl,
  onProgress({ stage, loaded, total, percentage }) {
    if (stage === "verify") {
      engineStatus.textContent = "保存済みモデルから日本語G2PとONNX推論を検証しています。";
      return;
    }
    const loadedMiB = (loaded / 1024 / 1024).toFixed(1);
    const totalText = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MiB` : "";
    engineStatus.textContent = `モデル取得: ${loadedMiB}${totalText} MiB (${percentage.toFixed(1)}%)`;
  },
});

isolationStatus.textContent = globalThis.crossOriginIsolated
  ? "Cross-Origin Isolation: 有効。WASMマルチスレッドを使用できます。"
  : "Cross-Origin Isolation: 無効。WASMは1スレッドへフォールバックします。";

prepareButton.addEventListener("click", async () => {
  await runButtonTask(prepareButton, async () => {
    engineStatus.textContent = "音声モデルを取得・検証・保存しています。";
    const prepared = await client.prepare();
    engineStatus.textContent = `オフライン音声の準備が完了しました。日本語G2P/推論検証済み、ORT WASM threads=${prepared.threadCount}`;
    speakButton.disabled = false;
  });
});

initializeButton.addEventListener("click", async () => {
  await runButtonTask(initializeButton, async () => {
    engineStatus.textContent = "保存済みモデルからエンジンを起動しています。";
    const ready = await client.initialize();
    engineStatus.textContent = `エンジン起動完了。ORT WASM threads=${ready.threadCount}`;
    speakButton.disabled = false;
  });
});

speakButton.addEventListener("click", async () => {
  const text = speechText.value.trim();
  if (!text) {
    return;
  }
  const audioContext = new AudioContext();
  await audioContext.resume();
  await runButtonTask(speakButton, async () => {
    const startedAt = performance.now();
    const result = await client.synthesize({
      utteranceId: crypto.randomUUID(),
      generation: 1,
      text,
      options: { language: "ja" },
    });
    const elapsed = performance.now() - startedAt;
    await playFloat32(audioContext, result.samples, result.sampleRate);
    const seconds = result.samples.length / result.sampleRate;
    engineStatus.textContent = `生成 ${elapsed.toFixed(0)} ms / 音声 ${seconds.toFixed(2)} s / Float32 PCM ${result.sampleRate} Hz`;
  });
});

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
    button.disabled = false;
  }
}

async function registerServiceWorkerForIsolation() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const serviceWorkerUrl = new URL(`${import.meta.env.BASE_URL}app-service-worker.js`, document.baseURI);
  await navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });

  if (navigator.serviceWorker.controller || globalThis.crossOriginIsolated) {
    return;
  }
  if (sessionStorage.getItem("typed-voice-coi-reloaded") === "1") {
    return;
  }
  sessionStorage.setItem("typed-voice-coi-reloaded", "1");
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
  });
  location.reload();
}