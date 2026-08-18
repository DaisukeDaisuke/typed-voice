import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalModeUrl,
  buildServerModeUrl,
  decodeRemotePairingQrText,
  encodeRemotePairingQrText,
  isServerModeUrl,
  resolveRemoteStartupAction,
  validateRemotePairingPayload,
} from "../src/app/remote-mode-policy.js";
import {
  bytesToBase64Url,
  computeRemotePairingChecksum,
} from "../src/app/remote-protocol.js";

test("server=1だけがクライアントモードを選ぶ", () => {
  assert.equal(isServerModeUrl("https://example.test/index.html?server=1"), true);
  assert.equal(isServerModeUrl("https://example.test/index.html?server=0"), false);
  assert.equal(isServerModeUrl("https://example.test/index.html"), false);
});

test("クライアントモードは接続情報がなければ毎回チュートリアルを要求する", () => {
  assert.equal(resolveRemoteStartupAction({ serverMode: true, hasPairing: true }), "handshake");
  assert.equal(resolveRemoteStartupAction({ serverMode: true, hasPairing: false }), "tutorial");
  assert.equal(resolveRemoteStartupAction({ serverMode: false, hasPairing: true }), "local");
});

test("モード切替は既存のURL情報を保ったままserverだけを変更する", () => {
  const server = buildServerModeUrl("https://example.test/index.html?conversation=abc#x");
  assert.equal(server.searchParams.get("conversation"), "abc");
  assert.equal(server.searchParams.get("server"), "1");
  assert.equal(server.hash, "#x");
  const local = buildLocalModeUrl(server.href);
  assert.equal(local.searchParams.get("conversation"), "abc");
  assert.equal(local.searchParams.has("server"), false);
});

test("QRはQuick Tunnel・32-byte分離鍵・checksumが一致した場合だけ受け付ける", async () => {
  const endpoint = "wss://example-name.trycloudflare.com/remote";
  const authKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const encryptionKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const checksum = await computeRemotePairingChecksum(endpoint, authKey, encryptionKey);
  const payload = {
    v: 1,
    u: endpoint,
    a: bytesToBase64Url(authKey),
    e: bytesToBase64Url(encryptionKey),
    c: bytesToBase64Url(checksum),
  };
  const valid = await validateRemotePairingPayload(payload);
  assert.equal(valid.endpoint, endpoint);
  await assert.rejects(validateRemotePairingPayload({ ...payload, u: "wss://example.com/remote" }));
  await assert.rejects(validateRemotePairingPayload({ ...payload, e: payload.a }));
  await assert.rejects(validateRemotePairingPayload({ ...payload, c: bytesToBase64Url(new Uint8Array(16)) }));
});

test("QR文字列はraw UTF-8 JSONをそのまま往復する", () => {
  const source = {
    v: 1,
    u: "wss://example-name.trycloudflare.com/remote",
    a: "a".repeat(43),
    e: "b".repeat(43),
    c: "c".repeat(22),
    label: "東京都税関関税許可局",
  };
  const encoded = encodeRemotePairingQrText(source);
  assert.equal(encoded, JSON.stringify(source));
  assert.deepEqual(decodeRemotePairingQrText(encoded), source);
});
