import { EngineClient } from "../engine/engine-client.js";

export class VoiceRuntimeAdapter {
  constructor({ manifestUrl, onStatus = () => {} }) {
    this.manifestUrl = manifestUrl;
    this.onStatus = onStatus;
    this.speed = 1;
    this.ready = false;
    this.audioContext = null;
    this.playbackTail = Promise.resolve();
    this.client = null;
  }

  setSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new Error("速度は0.5〜2.0倍で指定してください。");
    }
    this.speed = value;
  }

  async enable() {
    if (this.ready) return { ready: true };
    this.client ??= new EngineClient({
      manifestUrl: this.manifestUrl,
      onProgress: (message) => this.#handleProgress(message),
    });
    this.audioContext ??= new AudioContext();
    await this.audioContext.resume();
    this.onStatus("オフライン音声を確認しています。初回は約2.4 GiBを取得します。");
    await this.client.prepare();
    this.onStatus("保存済みモデルから音声エンジンを起動しています。");
    const initialized = await this.client.initialize();
    this.ready = true;
    this.onStatus(`音声を利用できます。${initialized.backend}`);
    return initialized;
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
  }

  #handleProgress(message) {
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
