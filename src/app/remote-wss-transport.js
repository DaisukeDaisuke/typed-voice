export const REMOTE_WSS_CONNECT_TIMEOUT_MS = 4000;

export class RemoteWssTransport {
  constructor(endpoint, {
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = REMOTE_WSS_CONNECT_TIMEOUT_MS,
    onOpen = () => {},
    onClose = () => {},
    onFailure = () => {},
  } = {}) {
    this.endpoint = String(endpoint);
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onFailure = onFailure;
    this.socket = null;
    this.authenticated = false;
    this.settledFailure = false;
    this.connectTimer = 0;
  }

  connect() {
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== "wss:") throw new Error("音声合成サーバーの接続先はWSSである必要があります。");
    if (typeof this.WebSocketImpl !== "function") throw new Error("このブラウザではWebSocketを利用できません。");
    this.close();
    this.settledFailure = false;
    const socket = new this.WebSocketImpl(endpoint.href);
    this.socket = socket;
    this.connectTimer = globalThis.setTimeout(() => {
      if (socket !== this.socket || socket.readyState === this.WebSocketImpl.OPEN) return;
      this.fail(new Error("音声合成サーバーへの接続がタイムアウトしました。"));
      try { socket.close(); } catch {}
    }, this.connectTimeoutMs);
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.clearConnectTimer();
      this.onOpen(socket);
    });
    socket.addEventListener("error", () => {
      if (socket !== this.socket || socket.readyState === this.WebSocketImpl.OPEN) return;
      this.fail(new Error("音声合成サーバーへ接続できませんでした。"));
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return;
      this.clearConnectTimer();
      this.socket = null;
      if (this.authenticated) {
        this.authenticated = false;
        this.onClose(event);
        return;
      }
      this.fail(new Error("音声合成サーバーとの接続が終了しました。"));
    });
    return socket;
  }

  markAuthenticated() {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("WSS接続が確立していません。");
    }
    this.authenticated = true;
  }

  fail(error) {
    if (this.settledFailure) return;
    this.settledFailure = true;
    this.clearConnectTimer();
    this.onFailure(error);
  }

  clearConnectTimer() {
    if (!this.connectTimer) return;
    globalThis.clearTimeout(this.connectTimer);
    this.connectTimer = 0;
  }

  close() {
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) {
      try { socket.close(); } catch {}
    }
  }
}
