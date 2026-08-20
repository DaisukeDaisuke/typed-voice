import test from "node:test";
import assert from "node:assert/strict";
import { EngineClient } from "../src/engine/engine-client.js";

class FakeWorker {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.listeners = new Set();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "configure") {
      queueMicrotask(() => this.emit({
        type: "configured",
        requestId: message.requestId,
        manifest: { id: "test", assets: [] },
      }));
    }
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    for (const listener of this.listeners) listener({ data });
  }
}

test("Trusted Worker用EngineClientはdedicated workerを直接取得runtimeとしてconfigureする", async () => {
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const normal = new EngineClient({ manifestUrl: "https://example.invalid/manifest.json" });
    await normal.getManifest();
    assert.equal(normal.worker.options.name, undefined);
    normal.abort();

    const trusted = new EngineClient({
      manifestUrl: "https://example.invalid/manifest.json",
      directWorkerRuntime: true,
    });
    await trusted.getManifest();
    assert.equal(trusted.worker.options.name, "typed-voice-trusted-worker-runtime");
    assert.equal(trusted.worker.messages[0].directWorkerRuntime, true);
    trusted.abort();
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test("abortは進行中prepareをAbortErrorで終了しWorkerを停止する", async () => {
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new EngineClient({ manifestUrl: "https://example.invalid/manifest.json" });
    await client.getManifest();
    const worker = client.worker;
    const preparing = client.prepare();
    await Promise.resolve();

    client.abort(new DOMException("cancelled", "AbortError"));

    await assert.rejects(preparing, (error) => error?.name === "AbortError");
    assert.equal(worker.terminated, true);
    assert.equal(client.worker, null);
    assert.equal(client.pending.size, 0);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});
