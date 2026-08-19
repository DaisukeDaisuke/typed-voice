import test from "node:test";
import assert from "node:assert/strict";

import { RemoteModeUi } from "../src/app/remote-mode-ui.js";

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
  };
}

function createButton() {
  const listeners = new Map();
  return {
    disabled: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    click() { return listeners.get("click")?.(); },
  };
}

function createDocument({ pairing = false } = {}) {
  const reconnectRetry = createButton();
  const elements = new Map([
    ["remote-mode-banner", { hidden: true }],
    ["remote-mode-status-title", { textContent: "" }],
    ["remote-mode-status-detail", { textContent: "" }],
    ["remote-connection-blocker", { hidden: true }],
    ["remote-connection-title", { textContent: "" }],
    ["remote-connection-state", { textContent: "" }],
    ["remote-connection-endpoint", { textContent: "" }],
    ["remote-connection-detail", { textContent: "" }],
    ["remote-reconnect-retry", reconnectRetry],
    ["settings-panel", { inert: false }],
  ]);
  const topbar = { inert: false };
  const main = { inert: false };
  const body = { classList: createClassList() };
  const documentRef = {
    location: { href: "https://example.test/index.html?server=1" },
    baseURI: "https://example.test/",
    body,
    getElementById(id) { return elements.get(id) ?? null; },
    querySelector(selector) {
      if (selector === ".topbar") return topbar;
      if (selector === "main") return main;
      return null;
    },
  };
  const pairingValue = pairing ? {
    protocolVersion: "1",
    endpoint: "wss://example-name.trycloudflare.com/typed-voice",
    encryptionKey: "a".repeat(43),
    authenticationKey: "b".repeat(43),
  } : null;
  return { documentRef, elements, topbar, main, body, pairingValue, reconnectRetry };
}

test("クライアントモードはハンドシェイク成功まで通常UIを操作不能にする", () => {
  const { documentRef, topbar, main, body, pairingValue } = createDocument({ pairing: true });
  const ui = new RemoteModeUi(documentRef, { pairing: pairingValue });
  assert.equal(topbar.inert, true);
  assert.equal(main.inert, true);
  assert.equal(body.classList.contains("remote-mode-locked"), true);
  ui.showHandshakeSuccess();
  assert.equal(topbar.inert, false);
  assert.equal(main.inert, false);
  assert.equal(body.classList.contains("remote-mode-locked"), false);
});

test("保存済み接続の待機中はWSS URLと経過秒を表示して画面をブロックする", () => {
  const { documentRef, elements, pairingValue } = createDocument({ pairing: true });
  const ui = new RemoteModeUi(documentRef, { pairing: pairingValue });
  ui.startConnectionDisplay();
  assert.equal(elements.get("remote-connection-blocker").hidden, false);
  assert.equal(elements.get("remote-connection-endpoint").textContent, pairingValue.endpoint);
  assert.equal(elements.get("remote-connection-state").textContent, "未接続 - 0秒経過");
  ui.stopConnectionTimer();
});

test("ハンドシェイク失敗は通常UIをロックしたまま再接続チュートリアルを開く", () => {
  const { documentRef, topbar, main, pairingValue } = createDocument({ pairing: true });
  const ui = new RemoteModeUi(documentRef, { pairing: pairingValue });
  let reconnectOpened = 0;
  ui.bindActions({
    openTutorial() {},
    openReconnectTutorial() { reconnectOpened += 1; },
  });
  ui.showHandshakeFailure();
  assert.equal(topbar.inert, true);
  assert.equal(main.inert, true);
  assert.equal(reconnectOpened, 1);
});

test("再接続チュートリアルの再試行は同じ接続先へ再接続し10秒クールダウンする", async () => {
  const { documentRef, pairingValue, reconnectRetry } = createDocument({ pairing: true });
  const ui = new RemoteModeUi(documentRef, { pairing: pairingValue });
  let reconnectCalls = 0;
  ui.attachVoiceRuntime({
    reconnect() { reconnectCalls += 1; },
  });
  ui.bindActions({ openTutorial() {}, openReconnectTutorial() {} });
  await reconnectRetry.click();
  assert.equal(reconnectCalls, 1);
  assert.equal(reconnectRetry.disabled, true);
  await reconnectRetry.click();
  assert.equal(reconnectCalls, 1);
  ui.stopConnectionTimer();
  clearTimeout(ui.retryCooldownTimer);
  ui.retryCooldownTimer = 0;
});
