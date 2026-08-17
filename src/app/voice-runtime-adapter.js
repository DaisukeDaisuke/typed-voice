import { EngineClient } from "../engine/engine-client.js";

const REMOTE_MANIFEST_URLS = Object.freeze({
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/typed-voice-manifest.json",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/typed-voice-manifest.json",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/typed-voice-manifest.json",
});

export class VoiceRuntimeAdapter {
  constructor({ manifestUrl, appBaseUrl = null, onStatus = () => {} }) {
    this.manifestUrl = manifestUrl;
    this.appBaseUrl = appBaseUrl;
    this.onStatus = onStatus;
    this.speed = 1;
    this.ready = false;
    this.prepared = false;
    this.activeProfile = null;
    this.activeManifest = null;
    this.audioContext = null;
    this.playbackTail = Promise.resolve();
    this.client = null;
    this.progressListeners = new Set();
  }

  subscribeProgress(listener) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  setSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new Error("速度は0.5〜2.0倍で指定してください。");
    }
    this.speed = value;
  }

  manifestUrlForProfile(profile = "fp32") {
    return REMOTE_MANIFEST_URLS[profile] || this.manifestUrl;
  }

  async getProfilePlan(profile = "fp32") {
    await this.#ensureProfileClient(profile);
    const manifest = this.activeManifest;
    const totalBytes = Array.isArray(manifest?.assets)
      ? manifest.assets.reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0)
      : 0;
    return {
      profile: this.activeProfile,
      manifest,
      totalBytes,
      manifestUrl: this.manifestUrlForProfile(this.activeProfile),
    };
  }

  async prepare(profile = "fp32") {
    await this.#ensureProfileClient(profile);
    if (this.prepared) {
      const plan = await this.getProfilePlan(profile);
      return { manifestId: plan.manifest?.id, totalBytes: plan.totalBytes, cached: true };
    }
    this.onStatus("音声データを取得・検証し、オフラインCacheへ保存しています。");
    const result = await this.client.prepare();
    this.prepared = true;
    this.onStatus("音声データをオフラインCacheへ保存しました。");
    return result;
  }

  async initializePrepared(profile = this.activeProfile ?? "fp32", { enableAudio = true } = {}) {
    await this.#ensureProfileClient(profile);
    if (this.ready) {
      if (enableAudio) await this.#enableAudioContext();
      return { ready: true, profile: this.activeProfile };
    }
    if (enableAudio) await this.#enableAudioContext();
    this.onStatus("保存済みモデルから音声エンジンを起動しています。");
    const initialized = await this.client.initialize();
    this.prepared = true;
    this.ready = true;
    this.onStatus(`音声を利用できます。${initialized.backend}`);
    return initialized;
  }

  async enable(profile = this.activeProfile ?? "fp32") {
    await this.prepare(profile);
    return this.initializePrepared(profile, { enableAudio: true });
  }

  get audioEnabled() {
    return Boolean(this.audioContext && this.audioContext.state !== "closed");
  }

  async synthesize({ utteranceId, generation, text }) {
    if (!this.ready) return { skipped: true, durationMs: 0 };
    const result = await this.client.synthesize({
      utteranceId,
      generation,
      text,
      options: {
        language: "ja",
        speed: this.speed,
      },
    });
    return {
      ...result,
      durationMs: result.samples.length / result.sampleRate * 1000,
    };
  }

  async cancel(utteranceId, generation) {
    if (!this.ready || !this.client) return;
    await this.client.cancel(utteranceId, generation);
  }

  async play({ samples, sampleRate, durationMs }) {
    if (!this.ready || !this.audioContext) return { durationMs: 0 };
    const playback = this.playbackTail.then(async () => {
      await this.audioContext.resume();
      const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      await new Promise((resolve) => {
        source.addEventListener("ended", resolve, { once: true });
        source.start();
      });
      return { durationMs: Number(durationMs || samples.length / sampleRate * 1000) };
    });
    this.playbackTail = playback.catch(() => {});
    return playback;
  }

  async dispose() {
    await this.client?.dispose();
    await this.audioContext?.close();
    this.client = null;
    this.audioContext = null;
    this.ready = false;
    this.prepared = false;
    this.activeProfile = null;
    this.activeManifest = null;
  }

  async #ensureProfileClient(profile) {
    const normalized = Object.hasOwn(REMOTE_MANIFEST_URLS, profile) || profile === "fp32" ? profile : "fp16";
    if (this.client && this.activeProfile === normalized) {
      if (!this.activeManifest) this.activeManifest = await this.client.getManifest();
      return;
    }
    if (this.ready && this.activeProfile !== normalized) {
      await this.audioContext?.close().catch(() => {});
      this.audioContext = null;
      this.ready = false;
    }
    await this.client?.dispose().catch(() => {});
    this.client = new EngineClient({
      manifestUrl: this.manifestUrlForProfile(normalized),
      appBaseUrl: this.appBaseUrl,
      onProgress: (message) => this.#handleProgress(message),
    });
    this.activeProfile = normalized;
    this.activeManifest = await this.client.getManifest();
    this.prepared = false;
  }

  async #enableAudioContext() {
    this.audioContext ??= new AudioContext();
    await this.audioContext.resume();
  }

  #handleProgress(message) {
    for (const listener of this.progressListeners) {
      try {
        listener(message);
      } catch {
        // A UI progress observer must never break engine preparation.
      }
    }
    if (message.stage === "download" || message.phase === "verifying-cache" || message.phase === "verified-cache") {
      const loaded = Number(message.loadedBytes || 0);
      const total = Number(message.totalBytes || 0);
      const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
      this.onStatus(`音声データを確認中 ${percentage}%`);
      return;
    }
    if (message.stage === "initialize") {
      this.onStatus(`音声エンジンを起動中${message.backend ? ` (${message.backend})` : ""}`);
    }
  }
}
