import assert from "node:assert/strict";
import test from "node:test";
import { acquireModelDownloadLock } from "../src/app/model-download-lock.js";

function fakeChannelFactory(responses, sent) {
  return () => {
    const port1 = { onmessage: null, close() {} };
    const port2 = { __port1: port1 };
    sent.channels.push(port2);
    queueMicrotask(() => {
      const response = responses.shift();
      if (response !== undefined) port1.onmessage?.({ data: response });
    });
    return { port1, port2 };
  };
}

test("Service Workerが無い環境ではmodel download lockを使わない", async () => {
  const lock = await acquireModelDownloadLock("https://example.test/model.json", { controller: null });
  assert.equal(lock.shared, false);
  assert.doesNotThrow(() => lock.release());
});

test("同一manifestのdownload lockはbusyを待ってから取得しreleaseする", async () => {
  const responses = [
    { ok: true, granted: false, retryAfterMs: 1 },
    { ok: true, granted: true, leaseMs: 120000 },
  ];
  const sent = { messages: [], channels: [] };
  const controller = {
    postMessage(message, ports = []) {
      sent.messages.push(message);
      const replyPort = ports[0];
      if (!replyPort) return;
      const response = responses.shift();
      queueMicrotask(() => replyPort.__port1.onmessage?.({ data: response }));
    },
  };
  let intervalCallback = null;
  let clearedInterval = null;
  const lock = await acquireModelDownloadLock("https://example.test/model.json", {
    controller,
    randomUUID: () => "request-1",
    createMessageChannel: fakeChannelFactory([], sent),
    setTimeoutImpl: (callback) => setTimeout(callback, 50),
    clearTimeoutImpl: clearTimeout,
    setIntervalImpl(callback) { intervalCallback = callback; return 123; },
    clearIntervalImpl(value) { clearedInterval = value; },
  });
  assert.equal(lock.shared, true);
  assert.equal(sent.messages.filter((message) => message.type === "typed-voice:model-download-lock-acquire").length, 2);
  intervalCallback();
  assert.equal(sent.messages.at(-1).type, "typed-voice:model-download-lock-renew");
  lock.release();
  assert.equal(clearedInterval, 123);
  assert.equal(sent.messages.at(-1).type, "typed-voice:model-download-lock-release");
});
