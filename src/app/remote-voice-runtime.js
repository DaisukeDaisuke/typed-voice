import { RemoteWssTransport } from "./remote-wss-transport.js";
import { RemoteAudioFormat } from "./remote-protocol.js";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_CLIENT_AUDIO_CACHE_ENTRIES = 64;
const MAX_CLIENT_AUDIO_CACHE_BYTES = 64 * 1024 * 1024;

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
    this.playbackTail = Promise.resolve();
    this.synthesisCache = new Map();
    this.synthesisCacheBytes = 0;
    this.synthesisConsumers = new Map();
    this.progressListeners = new Set();
    this.reconnectWanted = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = 0;
    this.transport = new RemoteWssTransport(pairing, {
      audioFormat,
      onOpen,
      onAuthenticated: () => {
        this.#clearReconnectTimer();
        this.reconnectAttempt = 0;
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
        this.#scheduleReconnect();
      },
      onClose: (event) => {
        this.transportAuthenticated = false;
        this.ready = false;
        this.#rejectWorkerWaiters(new Error("音声合成サーバーとの接続が終了しました。"));
        onClose?.(event);
        this.#scheduleReconnect();
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

  connect() {
    this.reconnectWanted = true;
    this.#clearReconnectTimer();
    return this.transport.connect();
  }

  reconnect() {
    this.reconnectWanted = true;
    this.#clearReconnectTimer();
    return this.transport.reconnect();
  }

  async unlockAudio() {
    if (!this.audioContext) this.audioContext = new AudioContext();
    await this.audioContext.resume();
    return this.audioContext.state === "running";
  }

  get audioEnabled() { return this.audioContext?.state === "running"; }

  async synthesize({ utteranceId, generation, text }) {
    this.#emit({ stage: "generate", utteranceId, generation, phase: "remote-send" });
    const sessionId = new URL(globalThis.location.href).searchParams.get("conversation");
    const clientToken = `${utteranceId}:${generation}`;
    const cacheKey = JSON.stringify([this.activeProfile, sessionId ?? "", String(text), this.speed]);
    let entry = this.synthesisCache.get(cacheKey);
    if (entry?.state === "ready") {
      this.#emit({ stage: "synthesis-complete", utteranceId, generation });
      return entry.result;
    }
    if (!entry) {
      entry = {
        state: "pending",
        cacheKey,
        transportToken: clientToken,
        consumers: new Map(),
        result: null,
      };
      this.synthesisCache.set(cacheKey, entry);
      void this.transport.synthesize(text, {
        clientToken: entry.transportToken,
        sessionId,
        speed: this.speed,
      }).then((result) => {
        if (this.synthesisCache.get(cacheKey) !== entry) return;
        const shared = {
          ...result,
          durationMs: result.samples.length / result.sampleRate * 1000,
        };
        entry.state = "ready";
        entry.result = shared;
        this.synthesisCacheBytes += result.samples.byteLength;
        for (const consumer of entry.consumers.values()) {
          this.synthesisConsumers.delete(consumer.clientToken);
          this.#emit({
            stage: "synthesis-complete",
            utteranceId: consumer.utteranceId,
            generation: consumer.generation,
          });
          consumer.resolve(shared);
        }
        entry.consumers.clear();
        this.#pruneSynthesisCache();
      }).catch((error) => {
        if (this.synthesisCache.get(cacheKey) === entry) this.synthesisCache.delete(cacheKey);
        for (const consumer of entry.consumers.values()) {
          this.synthesisConsumers.delete(consumer.clientToken);
          consumer.reject(error);
        }
        entry.consumers.clear();
      });
    }
    return new Promise((resolve, reject) => {
      const consumer = { clientToken, utteranceId, generation, resolve, reject };
      entry.consumers.set(clientToken, consumer);
      this.synthesisConsumers.set(clientToken, entry);
    });
  }

  async cancel(utteranceId, generation) {
    const clientToken = `${utteranceId}:${generation}`;
    const entry = this.synthesisConsumers.get(clientToken);
    if (!entry) return;
    const consumer = entry.consumers.get(clientToken);
    entry.consumers.delete(clientToken);
    this.synthesisConsumers.delete(clientToken);
    consumer?.reject(new DOMException("Remote synthesis cancelled", "AbortError"));
    if (entry.consumers.size !== 0) return;
    if (entry.state === "pending" && this.synthesisCache.get(entry.cacheKey) === entry) this.synthesisCache.delete(entry.cacheKey);
    await this.transport.cancelByClientToken(entry.transportToken);
  }

  async play({ samples, sampleRate, durationMs }) {
    const playback = this.playbackTail.then(async () => {
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
    });
    this.playbackTail = playback.catch(() => {});
    return playback;
  }

  close() {
    this.reconnectWanted = false;
    this.#clearReconnectTimer();
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

  #clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
  }

  #scheduleReconnect() {
    if (!this.reconnectWanted || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = 0;
      if (!this.reconnectWanted) return;
      try {
        this.transport.reconnect();
      } catch (error) {
        this.#scheduleReconnect();
      }
    }, delay);
  }

  #pruneSynthesisCache() {
    while (this.synthesisCache.size > MAX_CLIENT_AUDIO_CACHE_ENTRIES
      || this.synthesisCacheBytes > MAX_CLIENT_AUDIO_CACHE_BYTES) {
      const oldest = [...this.synthesisCache.entries()].find(([, entry]) => entry.state === "ready");
      if (!oldest) return;
      const [key, entry] = oldest;
      this.synthesisCache.delete(key);
      this.synthesisCacheBytes -= entry.result?.samples?.byteLength ?? 0;
    }
  }

  #emit(message) {
    for (const listener of this.progressListeners) listener(message);
  }
}

