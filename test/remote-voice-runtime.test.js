import test from "node:test";
import assert from "node:assert/strict";

import { RemoteVoiceRuntime } from "../src/app/remote-voice-runtime.js";

const PAIRING = {
  endpoint: "wss://example-name.trycloudflare.com/remote",
  authenticationKey: Buffer.alloc(32, 1).toString("base64url"),
  encryptionKey: Buffer.alloc(32, 2).toString("base64url"),
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installLocation(href) {
  const original = globalThis.location;
  globalThis.location = { href };
  return () => {
    if (original === undefined) delete globalThis.location;
    else globalThis.location = original;
  };
}

test("同一profile・会話UUID・textはclient側で1回だけ送信し同じ音声を共有する", async () => {
  const restoreLocation = installLocation("https://example.test/?conversation=conversation-a");
  const runtime = new RemoteVoiceRuntime(PAIRING);
  const result = deferred();
  const calls = [];
  runtime.activeProfile = "fp16";
  runtime.transport = {
    synthesize(text, options) {
      calls.push({ text, options });
      return result.promise;
    },
    async cancelByClientToken() { return false; },
  };
  try {
    const firstPromise = runtime.synthesize({
      utteranceId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      text: "同じ文章",
    });
    const secondPromise = runtime.synthesize({
      utteranceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      text: "同じ文章",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.sessionId, "conversation-a");

    const samples = new Float32Array([0.1, -0.1, 0.2]);
    result.resolve({ samples, sampleRate: 24_000, audioFormat: 2 });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.strictEqual(first.samples, samples);
    assert.strictEqual(second.samples, samples);
    assert.strictEqual(first.samples, second.samples);

    const third = await runtime.synthesize({
      utteranceId: "77777777-7777-4777-8777-777777777777",
      generation: 1,
      text: "同じ文章",
    });
    assert.equal(calls.length, 1);
    assert.strictEqual(third.samples, samples);
  } finally {
    restoreLocation();
  }
});

test("同じtextでも会話UUIDが違えばclient送信は束ねずserver側cacheへ任せる", async () => {
  const restoreLocation = installLocation("https://example.test/?conversation=conversation-a");
  const runtime = new RemoteVoiceRuntime(PAIRING);
  const calls = [];
  runtime.activeProfile = "fp16";
  runtime.transport = {
    synthesize(text, options) {
      calls.push({ text, options });
      return new Promise(() => {});
    },
    async cancelByClientToken() { return false; },
  };
  try {
    void runtime.synthesize({
      utteranceId: "33333333-3333-4333-8333-333333333333",
      generation: 1,
      text: "同じ文章",
    });
    globalThis.location.href = "https://example.test/?conversation=conversation-b";
    void runtime.synthesize({
      utteranceId: "44444444-4444-4444-8444-444444444444",
      generation: 1,
      text: "同じ文章",
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.options.sessionId), ["conversation-a", "conversation-b"]);
  } finally {
    restoreLocation();
  }
});

test("共有queryの1 consumerだけcancelしても基底送信は止めず全consumer消失時だけcancelする", async () => {
  const restoreLocation = installLocation("https://example.test/?conversation=conversation-a");
  const runtime = new RemoteVoiceRuntime(PAIRING);
  const calls = [];
  const cancelled = [];
  runtime.activeProfile = "fp16";
  runtime.transport = {
    synthesize(text, options) {
      calls.push({ text, options });
      return new Promise(() => {});
    },
    async cancelByClientToken(clientToken) {
      cancelled.push(clientToken);
      return true;
    },
  };
  try {
    const firstId = "55555555-5555-4555-8555-555555555555";
    const secondId = "66666666-6666-4666-8666-666666666666";
    const first = runtime.synthesize({ utteranceId: firstId, generation: 1, text: "共有文章" });
    const second = runtime.synthesize({ utteranceId: secondId, generation: 1, text: "共有文章" });
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    assert.equal(calls.length, 1);

    await runtime.cancel(firstId, 1);
    await firstRejected;
    assert.deepEqual(cancelled, []);

    await runtime.cancel(secondId, 1);
    await secondRejected;
    assert.deepEqual(cancelled, [`${firstId}:1`]);
  } finally {
    restoreLocation();
  }
});
