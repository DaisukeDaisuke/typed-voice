import {
  REMOTE_AUTH_DEADLINE_MS,
  RemoteAudioFlags,
  RemoteAudioFormat,
  RemoteModelProfileFromCode,
  RemoteOpcode,
  acceptRemoteServerHello,
  base64UrlToBytes,
  createRemoteClientHello,
  decryptRemoteFrame,
  encryptRemoteFrame,
  randomRemoteId,
} from "./remote-protocol.js";
import { createRemoteClientBanHash } from "./remote-client-identity.js";

export const REMOTE_WSS_CONNECT_TIMEOUT_MS = 4000;

function toUint8Array(value) {
  if (value instanceof Uint8Array) return Promise.resolve(value);
  if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Promise.resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof Blob) return value.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return Promise.reject(new Error("音声合成サーバーからbinary message以外を受信しました。"));
}

function decodeAudio(format, bytes, sampleCount) {
  if (format === RemoteAudioFormat.FLOAT32LE) {
    if (bytes.byteLength !== sampleCount * 4) throw new Error("Float32音声の長さが一致しません。");
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) samples[index] = view.getFloat32(index * 4, true);
    return samples;
  }
  if (format === RemoteAudioFormat.PCM16LE) {
    if (bytes.byteLength !== sampleCount * 2) throw new Error("PCM16音声の長さが一致しません。");
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    return samples;
  }
  throw new Error("未対応の音声形式を受信しました。");
}

function joinChunks(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class RemoteWssTransport {
  constructor(pairing, {
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = REMOTE_WSS_CONNECT_TIMEOUT_MS,
    authDeadlineMs = REMOTE_AUTH_DEADLINE_MS,
    audioFormat = RemoteAudioFormat.FLOAT32LE,
    onOpen = () => {},
    onAuthenticated = () => {},
    onServerConfig = () => {},
    onWorkerStatus = () => {},
    onClose = () => {},
    onFailure = () => {},
  } = {}) {
    this.pairing = typeof pairing === "string" ? { endpoint: pairing } : pairing;
    this.endpoint = String(this.pairing?.endpoint ?? "");
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.authDeadlineMs = authDeadlineMs;
    this.audioFormat = audioFormat;
    this.onOpen = onOpen;
    this.onAuthenticated = onAuthenticated;
    this.onServerConfig = onServerConfig;
    this.onWorkerStatus = onWorkerStatus;
    this.onClose = onClose;
    this.onFailure = onFailure;
    this.socket = null;
    this.authenticated = false;
    this.settledFailure = false;
    this.connectTimer = 0;
    this.authTimer = 0;
    this.handshakeState = "idle";
    this.clientNonce = null;
    this.session = null;
    this.sendTail = Promise.resolve();
    this.receiveTail = Promise.resolve();
    this.pending = new Map();
    this.clientTokens = new Map();
    this.lastSessionId = null;
    this.serverConfig = null;
    this.workerStatus = null;
  }

  connect() {
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== "wss:") throw new Error("音声合成サーバーの接続先はWSSである必要があります。");
    if (typeof this.WebSocketImpl !== "function") throw new Error("このブラウザではWebSocketを利用できません。");
    if (!this.pairing?.authenticationKey || !this.pairing?.encryptionKey) throw new Error("QRの認証鍵がありません。");
    this.close();
    this.settledFailure = false;
    this.handshakeState = "connecting";
    const socket = new this.WebSocketImpl(endpoint.href);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.connectTimer = globalThis.setTimeout(() => {
      if (socket !== this.socket || socket.readyState === this.WebSocketImpl.OPEN) return;
      this.fail(new Error("音声合成サーバーへの接続がタイムアウトしました。"));
      try { socket.close(); } catch {}
    }, this.connectTimeoutMs);
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.clearConnectTimer();
      try {
        const hello = createRemoteClientHello(this.audioFormat);
        this.clientNonce = hello.clientNonce;
        this.handshakeState = "hello-sent";
        socket.send(hello.frame);
        this.authTimer = globalThis.setTimeout(() => {
          if (socket !== this.socket || this.authenticated) return;
          this.fail(new Error("音声合成サーバーの認証が20秒以内に完了しませんでした。"));
          try { socket.close(); } catch {}
        }, this.authDeadlineMs);
        this.onOpen(socket);
      } catch (error) {
        this.fail(error);
        try { socket.close(); } catch {}
      }
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      this.receiveTail = this.receiveTail
        .then(() => this.#handleMessage(event.data))
        .catch((error) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          try { socket.close(); } catch {}
        });
    });
    socket.addEventListener("error", () => {
      if (socket !== this.socket || socket.readyState === this.WebSocketImpl.OPEN) return;
      this.fail(new Error("音声合成サーバーへ接続できませんでした。"));
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return;
      this.clearTimers();
      this.socket = null;
      this.session = null;
      this.handshakeState = "closed";
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;
      this.#rejectPending(new Error("音声合成サーバーとの接続が終了しました。"));
      if (wasAuthenticated) this.onClose(event);
      else this.fail(new Error("音声合成サーバーとの接続が終了しました。"));
    });
    return socket;
  }

  async synthesize(text, { clientToken = null, sessionId = null } = {}) {
    if (!this.authenticated || !this.session) throw new Error("音声合成サーバーの認証が完了していません。");
    const source = String(text ?? "");
    if (!source.trim()) throw new Error("読み上げる文章が空です。");
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (normalizedSessionId && normalizedSessionId !== this.lastSessionId) {
      if (normalizedSessionId.length > 128) throw new Error("会話IDが長すぎます。");
      await this.#sendEncrypted({ op: RemoteOpcode.SESSION, payload: new TextEncoder().encode(normalizedSessionId) });
      this.lastSessionId = normalizedSessionId;
    }
    const id = randomRemoteId();
    const key = id.toString();
    const promise = new Promise((resolve, reject) => {
      this.pending.set(key, {
        id,
        resolve,
        reject,
        chunks: [],
        totalBytes: 0,
        metadata: null,
        clientToken,
      });
      if (clientToken) this.clientTokens.set(clientToken, id);
    });
    try {
      await this.#sendEncrypted({ op: RemoteOpcode.TEXT, id, payload: new TextEncoder().encode(source) });
    } catch (error) {
      this.#finishPending(key, error);
      throw error;
    }
    return promise;
  }

  async cancelByClientToken(clientToken) {
    const id = this.clientTokens.get(clientToken);
    if (id == null || !this.authenticated) return false;
    await this.#sendEncrypted({ op: RemoteOpcode.CANCEL, id });
    return true;
  }

  markAuthenticated() {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) throw new Error("WSS接続が確立していません。");
    this.authenticated = true;
    this.clearAuthTimer();
  }

  fail(error) {
    if (this.settledFailure) return;
    this.settledFailure = true;
    this.clearTimers();
    this.onFailure(error);
  }

  clearConnectTimer() {
    if (!this.connectTimer) return;
    globalThis.clearTimeout(this.connectTimer);
    this.connectTimer = 0;
  }

  clearAuthTimer() {
    if (!this.authTimer) return;
    globalThis.clearTimeout(this.authTimer);
    this.authTimer = 0;
  }

  clearTimers() {
    this.clearConnectTimer();
    this.clearAuthTimer();
  }

  close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.session = null;
    this.handshakeState = "idle";
    this.lastSessionId = null;
    this.serverConfig = null;
    this.workerStatus = null;
    this.#rejectPending(new DOMException("Remote transport closed", "AbortError"));
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) {
      try { socket.close(); } catch {}
    }
  }

  async #handleMessage(value) {
    const bytes = await toUint8Array(value);
    if (!this.session) {
      if (this.handshakeState !== "hello-sent") throw new Error("認証前に想定外のメッセージを受信しました。");
      const authKey = base64UrlToBytes(this.pairing.authenticationKey);
      const encryptionKey = base64UrlToBytes(this.pairing.encryptionKey);
      if (authKey.byteLength !== 32 || encryptionKey.byteLength !== 32) throw new Error("QRの鍵長が正しくありません。");
      const accepted = await acceptRemoteServerHello({
        frame: bytes,
        authKey,
        encryptionKey,
        clientNonce: this.clientNonce,
        audioFormat: this.audioFormat,
        createClientHash: createRemoteClientBanHash,
      });
      this.session = accepted.session;
      this.handshakeState = "auth-sent";
      this.socket.send(accepted.authFrame);
      return;
    }

    const frame = await decryptRemoteFrame(this.session, bytes);
    if (!this.authenticated) {
      if (this.handshakeState !== "auth-sent") throw new Error("AUTH後の暗号化フレーム順序が正しくありません。");
      if (frame.op === RemoteOpcode.SERVER_CONFIG) {
        this.#acceptServerConfig(frame);
        return;
      }
      if (frame.op === RemoteOpcode.WORKER_STATUS) {
        this.#acceptWorkerStatus(frame);
        return;
      }
      if (frame.op !== RemoteOpcode.PING) {
        throw new Error("AUTH後の暗号化確認PINGを受信できませんでした。");
      }
      this.markAuthenticated();
      this.handshakeState = "authenticated";
      this.onAuthenticated();
    }
    await this.#handleEncryptedFrame(frame);
  }

  async #handleEncryptedFrame(frame) {
    if (frame.op === RemoteOpcode.SERVER_CONFIG) {
      this.#acceptServerConfig(frame);
      return;
    }
    if (frame.op === RemoteOpcode.WORKER_STATUS) {
      this.#acceptWorkerStatus(frame);
      return;
    }
    if (frame.op === RemoteOpcode.PING) {
      await this.#sendEncrypted({ op: RemoteOpcode.PONG, id: frame.id });
      return;
    }
    if (frame.op === RemoteOpcode.PONG) return;
    if (frame.op === RemoteOpcode.AUDIO) {
      this.#acceptAudio(frame);
      return;
    }
    if (frame.op === RemoteOpcode.ERROR) {
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      const code = frame.payload.byteLength >= 2 ? view.getUint16(0, false) : 0;
      const message = frame.payload.byteLength > 2 ? new TextDecoder("utf-8", { fatal: false }).decode(frame.payload.slice(2)) : "サーバーでエラーが発生しました。";
      this.#finishPending(frame.id.toString(), new Error(`[${code}] ${message}`));
      return;
    }
    throw new Error(`未対応の暗号化opcodeです: ${frame.op}`);
  }

  #acceptServerConfig(frame) {
    if (frame.id !== 0n || frame.payload.byteLength !== 1) {
      throw new Error("サーバー設定フレームが正しくありません。");
    }
    const modelProfile = RemoteModelProfileFromCode[frame.payload[0]];
    if (!modelProfile) {
      throw new Error("サーバーのモデル設定が正しくありません。");
    }
    this.serverConfig = Object.freeze({ modelProfile });
    this.onServerConfig(this.serverConfig);
  }

  #acceptWorkerStatus(frame) {
    if (frame.id !== 0n || frame.payload.byteLength !== 4) {
      throw new Error("Worker状態フレームが正しくありません。");
    }
    const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    const connected = view.getUint16(0, false);
    const ready = view.getUint16(2, false);
    if (ready > connected) throw new Error("Worker状態の件数が正しくありません。");
    this.workerStatus = Object.freeze({ connected, ready });
    this.onWorkerStatus(this.workerStatus);
  }

  #acceptAudio(frame) {
    const key = frame.id.toString();
    const pending = this.pending.get(key);
    if (!pending) throw new Error("対応するTEXTがないAUDIOを受信しました。");
    let audio = frame.payload;
    if (frame.flags & RemoteAudioFlags.START) {
      if (pending.metadata || frame.payload.byteLength < 10) throw new Error("AUDIO STARTが正しくありません。");
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      const format = view.getUint8(0);
      const channels = view.getUint8(1);
      const sampleRate = view.getUint32(2, false);
      const sampleCount = view.getUint32(6, false);
      if (format !== this.audioFormat || channels !== 1 || sampleRate < 8000 || sampleRate > 192000) throw new Error("AUDIOメタデータが正しくありません。");
      pending.metadata = { format, channels, sampleRate, sampleCount };
      audio = frame.payload.slice(10);
    } else if (!pending.metadata) {
      throw new Error("AUDIO STARTより先に音声データを受信しました。");
    }
    if (audio.byteLength) {
      pending.chunks.push(audio);
      pending.totalBytes += audio.byteLength;
    }
    if (frame.flags & RemoteAudioFlags.END) {
      const metadata = pending.metadata;
      const bytes = joinChunks(pending.chunks, pending.totalBytes);
      const samples = decodeAudio(metadata.format, bytes, metadata.sampleCount);
      this.pending.delete(key);
      if (pending.clientToken) this.clientTokens.delete(pending.clientToken);
      pending.resolve({ samples, sampleRate: metadata.sampleRate, audioFormat: metadata.format });
    }
  }

  #sendEncrypted(message) {
    const task = this.sendTail.then(async () => {
      if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN || !this.session) throw new Error("WSS接続がありません。");
      const frame = await encryptRemoteFrame(this.session, message);
      this.socket.send(frame);
    });
    this.sendTail = task.catch(() => {});
    return task;
  }

  #finishPending(key, error) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.clientToken) this.clientTokens.delete(pending.clientToken);
    pending.reject(error);
  }

  #rejectPending(error) {
    for (const [key] of this.pending) this.#finishPending(key, error);
  }
}
