import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { decryptRemotePairingFile } from "../src/app/remote-pairing-file.js";

const MAGIC = new TextEncoder().encode("TVRKEY1\0");
const AAD = new TextEncoder().encode("typed-voice-remote-pairing-file/v1");
const KEY_HEX = "7f4b44d58e50e4b0de47d486bb11e16af31d8a78f4bbcd221ffb6b349911929a";

function hexToBytes(hex) {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function concat(...values) {
  const size = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

async function makeEncryptedFile(value) {
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const key = await webcrypto.subtle.importKey("raw", hexToBytes(KEY_HEX), { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(value))));
  return concat(MAGIC, iv, encrypted);
}

test("接続キーファイルはraw binaryとBase64の両方を復号する", async () => {
  const payload = { v: 1, u: "wss://example.trycloudflare.com/remote", a: "a", e: "e", c: "c" };
  const raw = await makeEncryptedFile(payload);
  assert.deepEqual(await decryptRemotePairingFile(raw, webcrypto), payload);
  const base64 = Buffer.from(raw).toString("base64url");
  assert.deepEqual(await decryptRemotePairingFile(new TextEncoder().encode(base64), webcrypto), payload);
});

test("接続キーファイルの改ざんを拒否する", async () => {
  const raw = await makeEncryptedFile({ v: 1 });
  raw[raw.length - 1] ^= 0x01;
  await assert.rejects(() => decryptRemotePairingFile(raw, webcrypto), /復号できません/);
});
