import test from "node:test";
import assert from "node:assert/strict";

import { RemoteWssTransport } from "../src/app/remote-wss-transport.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000 });
  }

  send(value) {
    this.sent.push(value);
  }
}
FakeWebSocket.instances = [];

const PAIRING = {
  endpoint: "wss://example-name.trycloudflare.com/remote",
  authenticationKey: Buffer.alloc(32, 1).toString("base64url"),
  encryptionKey: Buffer.alloc(32, 2).toString("base64url"),
};

test("保存済み接続先へWSSで接続し、socket openだけでは認証済みにしない", () => {
  FakeWebSocket.instances.length = 0;
  let opened = 0;
  const transport = new RemoteWssTransport(PAIRING, {
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 10000,
    onOpen() { opened += 1; },
  });
  transport.connect();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, PAIRING.endpoint);
  socket.open();
  assert.equal(opened, 1);
  assert.equal(transport.authenticated, false);
  assert.equal(socket.sent.length, 1);
  transport.close();
});

test("認証済みWSS接続が切断されたら切断通知へ進む", () => {
  FakeWebSocket.instances.length = 0;
  let disconnected = 0;
  const transport = new RemoteWssTransport(PAIRING, {
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 10000,
    onClose() { disconnected += 1; },
  });
  transport.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  transport.markAuthenticated();
  socket.close();
  assert.equal(disconnected, 1);
});

test("WSS以外の接続先は接続前に拒否する", () => {
  const transport = new RemoteWssTransport({ ...PAIRING, endpoint: "https://example-name.trycloudflare.com/remote" }, {
    WebSocketImpl: FakeWebSocket,
  });
  assert.throws(() => transport.connect());
});
