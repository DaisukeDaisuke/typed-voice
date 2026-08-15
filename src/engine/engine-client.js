export class EngineClient {
  constructor({ manifestUrl, onProgress = () => {} }) {
    this.worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.onProgress = onProgress;
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
    this.configured = this.request("configure", { manifestUrl });
  }

  request(type, payload = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type, requestId, ...payload });
    });
  }

  async prepare(preferredThreadCount = 0) {
    await this.configured;
    return this.request("prepare", { preferredThreadCount });
  }

  async getManifest() {
    const configured = await this.configured;
    return configured.manifest;
  }

  async initialize(preferredThreadCount = 0) {
    await this.configured;
    return this.request("initialize", { preferredThreadCount });
  }

  async synthesize({ utteranceId, generation, text, options = {} }) {
    await this.configured;
    return this.request("synthesize", { utteranceId, generation, text, options });
  }

  async cancel(utteranceId, generation) {
    await this.configured;
    return this.request("cancel", { utteranceId, generation });
  }

  async dispose() {
    try {
      await this.request("dispose");
    } finally {
      this.worker.terminate();
    }
  }

  handleMessage(message) {
    if (message.type === "progress") {
      this.onProgress(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    if (message.type === "error") {
      this.pending.delete(message.requestId);
      pending.reject(new Error(message.message));
      return;
    }
    if (message.type === "discarded") {
      this.pending.delete(message.requestId);
      pending.reject(new Error(`Synthesis discarded: ${message.reason}`));
      return;
    }
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }
}