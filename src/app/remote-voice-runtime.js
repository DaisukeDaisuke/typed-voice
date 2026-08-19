import { RemoteWssTransport } from "./remote-wss-transport.js";
import { RemoteAudioFormat } from "./remote-protocol.js";

export class RemoteVoiceRuntime {
  constructor(pairing, { audioFormat = RemoteAudioFormat.FLOAT32LE, onOpen, onAuthenticated, onServerConfig, onWorkerStatus, onFailure, onClose } = {}) {
    this.pairing = pairing;
    this.audioFormat = audioFormat;
    this.ready = false;
    this.transportAuthenticated = false;
    this.workerStatus = Object.freeze({ connected: 0, ready: 0 });
    this.workerReadyWaiters = new Set();
    this.prepared = true;
    this.activeProfile = "remote";
    this.speed = 1;
    this.audioContext = null;
    this.progressListeners = new Set();
    this.transport = new RemoteWssTransport(pairing, {
      audioFormat,
      onOpen,
      onAuthenticated: () => {
        this.transportAuthenticated = true;
        this.#syncReady();
        onAuthenticated?.();
      },
      onServerConfig: (config) => {
        this.activeProfile = config.modelProfile;
        onServerConfig?.(config);
      },
      onWorkerStatus: (status) => {
        this.workerStatus = Object.freeze({ connected: status.connected, ready: status.ready });
        this.#syncReady();
        for (const waiter of this.workerReadyWaiters) waiter.onStatus?.(this.workerStatus);
        if (this.workerStatus.ready > 0) {
          for (const waiter of [...this.workerReadyWaiters]) {
            this.workerReadyWaiters.delete(waiter);
            waiter.resolve(this.workerStatus);
          }
        }
        onWorkerStatus?.(this.workerStatus);
      },
      onFailure: (error) => {
        this.transportAuthenticated = false;
        this.ready = false;
        this.#rejectWorkerWaiters(error);
        onFailure?.(error);
      },
      onClose: (event) => {
        this.transportAuthenticated = false;
        this.ready = false;
        this.#rejectWorkerWaiters(new Error("音声合成サーバーとの接続が終了しました。"));
        onClose?.(event);
      },
    });
  }

  subscribeProgress(listener) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  setSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new Error("速度は0.5〜2.0倍で指定してください。");
    this.speed = value;
  }

  setReplayAfterLoad() { return false; }
  async isProfilePrepared() { return true; }
  async getProfilePlan() { return { profile: this.activeProfile, totalBytes: 0, manifest: null }; }
  async prepare() { return { cached: true, totalBytes: 0 }; }
  async initializePrepared() { return { ready: this.ready, profile: this.activeProfile }; }

  waitForWorkerReady({ onStatus } = {}) {
    onStatus?.(this.workerStatus);
    if (this.ready && this.workerStatus.ready > 0) return Promise.resolve(this.workerStatus);
    return new Promise((resolve, reject) => {
      this.workerReadyWaiters.add({ resolve, reject, onStatus });
    });
  }

  connect() { return this.transport.connect(); }

  reconnect() {
    this.close();
    return this.connect();
  }

  async unlockAudio() {
    if (!this.audioContext) this.audioContext = new AudioContext();
    await this.audioContext.resume();
    return this.audioContext.state === "running";
  }

  get audioEnabled() { return this.audioContext?.state === "running"; }

  async synthesize({ utteranceId, generation, text }) {
    if (!this.ready) throw new Error("音声合成サーバーへ接続していません。");
    this.#emit({ stage: "generate", utteranceId, generation, phase: "remote-send" });
    const sessionId = new URL(globalThis.location.href).searchParams.get("conversation");
    const result = await this.transport.synthesize(text, {
      clientToken: `${utteranceId}:${generation}`,
      sessionId,
    });
    this.#emit({ stage: "synthesis-complete", utteranceId, generation });
    return {
      ...result,
      durationMs: result.samples.length / result.sampleRate * 1000,
    };
  }

  async cancel(utteranceId, generation) {
    await this.transport.cancelByClientToken(`${utteranceId}:${generation}`);
  }

  async play({ samples, sampleRate, durationMs }) {
    await this.unlockAudio();
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
  }

  close() {
    this.transportAuthenticated = false;
    this.ready = false;
    this.#rejectWorkerWaiters(new Error("音声合成サーバーとの接続を終了しました。"));
    this.transport.close();
  }

  async dispose() {
    this.close();
    await this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.transportAuthenticated = false;
    this.ready = false;
  }

  #syncReady() {
    this.ready = this.transportAuthenticated && this.workerStatus.ready > 0;
  }

  #rejectWorkerWaiters(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of [...this.workerReadyWaiters]) {
      this.workerReadyWaiters.delete(waiter);
      waiter.reject(failure);
    }
  }

  #emit(message) {
    for (const listener of this.progressListeners) listener(message);
  }
}

