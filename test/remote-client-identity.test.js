import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteClientBanHash, getRemoteClientInstanceId } from "../src/app/remote-client-identity.js";

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

test("再接続用client instance IDは同じsessionStorageでは安定し別sessionでは分離する", () => {
  const originalSessionStorage = globalThis.sessionStorage;
  const firstValues = new Map();
  globalThis.sessionStorage = {
    getItem(key) { return firstValues.get(key) ?? null; },
    setItem(key, value) { firstValues.set(key, String(value)); },
  };
  try {
    const first = getRemoteClientInstanceId();
    const reloaded = getRemoteClientInstanceId();
    assert.equal(first.byteLength, 16);
    assert.deepEqual(first, reloaded);

    const secondValues = new Map();
    globalThis.sessionStorage = {
      getItem(key) { return secondValues.get(key) ?? null; },
      setItem(key, value) { secondValues.set(key, String(value)); },
    };
    const otherTab = getRemoteClientInstanceId();
    assert.equal(otherTab.byteLength, 16);
    assert.notDeepEqual(first, otherTab);
  } finally {
    if (originalSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = originalSessionStorage;
  }
});
