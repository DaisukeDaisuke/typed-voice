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

test("QRはQuick Tunnelと分離した2種類の鍵だけを受け付ける", () => {
  const valid = validateRemotePairingPayload({
    protocolVersion: "1",
    endpoint: "wss://example-name.trycloudflare.com/typed-voice",
    encryptionKey: "a".repeat(43),
    authenticationKey: "b".repeat(43),
  });
  assert.equal(valid.endpoint, "wss://example-name.trycloudflare.com/typed-voice");
  assert.throws(() => validateRemotePairingPayload({
    protocolVersion: "1",
    endpoint: "wss://example.com/typed-voice",
    encryptionKey: "a".repeat(43),
    authenticationKey: "b".repeat(43),
  }));
  assert.throws(() => validateRemotePairingPayload({
    protocolVersion: "1",
    endpoint: "wss://example-name.trycloudflare.com/typed-voice",
    encryptionKey: "a".repeat(43),
    authenticationKey: "a".repeat(43),
  }));
});

test("QR文字列はUTF-8 JSONをbase64url化して日本語も往復する", () => {
  const source = {
    protocolVersion: "1",
    endpoint: "wss://example-name.trycloudflare.com/typed-voice",
    encryptionKey: "a".repeat(43),
    authenticationKey: "b".repeat(43),
    label: "東京都税関関税許可局",
  };
  const encoded = encodeRemotePairingQrText(source);
  assert.match(encoded, /^typed-voice:1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRemotePairingQrText(encoded), source);
});
