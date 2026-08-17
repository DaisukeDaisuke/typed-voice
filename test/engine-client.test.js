import test from "node:test";
import assert from "node:assert/strict";
import { EngineClient } from "../src/engine/engine-client.js";

class FakeWorker {
  constructor() {
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
