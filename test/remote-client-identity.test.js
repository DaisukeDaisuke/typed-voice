import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteClientBanHash } from "../src/app/remote-client-identity.js";

test("匿名端末IDは同じサーバーsaltで安定し別saltでは一致しない", async () => {
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  try {
    const saltA = new Uint8Array(32).fill(0x11);
    const saltB = new Uint8Array(32).fill(0x22);
    const first = await createRemoteClientBanHash(saltA);
    const second = await createRemoteClientBanHash(saltA);
    const otherServer = await createRemoteClientBanHash(saltB);
    assert.equal(first.byteLength, 32);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, otherServer);
  } finally {
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});
