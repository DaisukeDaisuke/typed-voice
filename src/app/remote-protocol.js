export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_HEADER_BYTES = 20;
export const REMOTE_AUTH_DEADLINE_MS = 20_000;

export const RemoteOpcode = Object.freeze({
  PING: 0x01,
  PONG: 0x02,
  SESSION: 0x03,
  SERVER_CONFIG: 0x04,
  WORKER_STATUS: 0x05,
  TEXT: 0x10,
  CANCEL: 0x11,
  TEXT_SYNC: 0x12,
  AUDIO: 0x20,
  ERROR: 0x7f,
  HELLO_CLIENT: 0xf0,
  HELLO_SERVER: 0xf1,
  AUTH: 0xf2,
});

export const RemoteModelProfileFromCode = Object.freeze({
  1: "fp32",
  2: "fp16",
  3: "mobile-int8",
  4: "mobile-int4",
});

export const RemoteAudioFormat = Object.freeze({
  PCM16LE: 1,
  FLOAT32LE: 2,
});

export const RemoteAudioFlags = Object.freeze({ START: 1, END: 2 });

const encoder = new TextEncoder();

function cryptoApi() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto APIを利用できません。");
  }
  return globalThis.crypto;
}

function concatBytes(...parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
  const result = new Uint8Array(arrays.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(text) {
  const source = String(text ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(source)) throw new Error("base64url形式が正しくありません。");
  const normalized = source.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function computeRemotePairingChecksum(endpoint, authKey, encryptionKey) {
  const digest = await cryptoApi().subtle.digest("SHA-256", concatBytes(
    encoder.encode("typed-voice-remote-qr/v1\n"),
    encoder.encode(String(endpoint)),
    Uint8Array.of(0),
    authKey,
    encryptionKey,
  ));
  return new Uint8Array(digest).slice(0, 16);
}

async function hmacSha256(rawKey, data) {
  const key = await cryptoApi().subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await cryptoApi().subtle.sign("HMAC", key, data));
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function hkdf(rawKey, salt, info, length) {
  const baseKey = await cryptoApi().subtle.importKey("raw", rawKey, "HKDF", false, ["deriveBits"]);
  const bits = await cryptoApi().subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: encoder.encode(info),
  }, baseKey, length * 8);
  return new Uint8Array(bits);
}

function proofInput(label, audioFormat, clientNonce, serverNonce) {
  return concatBytes(
    encoder.encode(label),
    Uint8Array.of(REMOTE_PROTOCOL_VERSION, audioFormat),
    clientNonce,
    serverNonce,
  );
}

function assertAudioFormat(value) {
  if (![RemoteAudioFormat.PCM16LE, RemoteAudioFormat.FLOAT32LE].includes(value)) {
    throw new Error("サポートされていない音声形式です。");
  }
}

export function createRemoteClientHello(audioFormat) {
  assertAudioFormat(audioFormat);
  const clientNonce = cryptoApi().getRandomValues(new Uint8Array(32));
  const frame = new Uint8Array(36);
  frame[0] = RemoteOpcode.HELLO_CLIENT;
  frame[1] = REMOTE_PROTOCOL_VERSION;
  frame[2] = audioFormat;
  frame[3] = 0;
  frame.set(clientNonce, 4);
  return { frame, clientNonce };
}

export async function acceptRemoteServerHello({ frame, authKey, encryptionKey, clientNonce, audioFormat, createClientHash = null, clientInstanceId = null }) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (![68, 100].includes(bytes.byteLength) || bytes[0] !== RemoteOpcode.HELLO_SERVER) throw new Error("サーバーHELLOが正しくありません。");
  const helloFlags = bytes[3];
  const hasClientBanSalt = (helloFlags & 1) !== 0;
  if (bytes[1] !== REMOTE_PROTOCOL_VERSION || bytes[2] !== audioFormat || (helloFlags & ~1) !== 0) throw new Error("サーバーHELLOのバージョンまたは音声形式が一致しません。");
  if (hasClientBanSalt !== (bytes.byteLength === 100)) throw new Error("サーバーHELLOの匿名識別情報が正しくありません。");
  const serverNonce = bytes.slice(4, 36);
  const serverProof = bytes.slice(36, 68);
  const serverBanSalt = hasClientBanSalt ? bytes.slice(68, 100) : null;
  const serverProofBase = proofInput("server", audioFormat, clientNonce, serverNonce);
  const expectedProof = await hmacSha256(authKey, serverBanSalt ? concatBytes(serverProofBase, serverBanSalt) : serverProofBase);
  if (!equalBytes(serverProof, expectedProof)) throw new Error("音声合成サーバーを認証できませんでした。");

  const salt = concatBytes(clientNonce, serverNonce);
  const [c2sKeyBytes, s2cKeyBytes, c2sPrefix, s2cPrefix] = await Promise.all([
    hkdf(encryptionKey, salt, "typed-voice-remote/v1/c2s/key", 32),
    hkdf(encryptionKey, salt, "typed-voice-remote/v1/s2c/key", 32),
    hkdf(encryptionKey, salt, "typed-voice-remote/v1/c2s/nonce", 4),
    hkdf(encryptionKey, salt, "typed-voice-remote/v1/s2c/nonce", 4),
  ]);
  const [sendKey, receiveKey] = await Promise.all([
    cryptoApi().subtle.importKey("raw", c2sKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]),
    cryptoApi().subtle.importKey("raw", s2cKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]),
  ]);
  const clientHash = hasClientBanSalt && typeof createClientHash === "function"
    ? await createClientHash(serverBanSalt)
    : null;
  if (clientHash && clientHash.byteLength !== 32) throw new Error("クライアント匿名識別ハッシュが正しくありません。");
  const instanceId = clientInstanceId == null
    ? null
    : clientInstanceId instanceof Uint8Array
      ? clientInstanceId
      : new Uint8Array(clientInstanceId);
  if (instanceId && instanceId.byteLength !== 16) throw new Error("クライアント接続IDが正しくありません。");
  if (instanceId && !clientHash) throw new Error("クライアント接続IDには匿名識別ハッシュが必要です。");
  const clientProofBase = proofInput("client", audioFormat, clientNonce, serverNonce);
  const clientProofMaterial = clientHash
    ? concatBytes(clientProofBase, clientHash, instanceId ?? new Uint8Array())
    : clientProofBase;
  const clientProof = await hmacSha256(authKey, clientProofMaterial);
  const authFrame = new Uint8Array(clientHash ? (instanceId ? 84 : 68) : 36);
  authFrame[0] = RemoteOpcode.AUTH;
  authFrame[1] = REMOTE_PROTOCOL_VERSION;
  authFrame[2] = audioFormat;
  authFrame[3] = 0;
  authFrame.set(clientProof, 4);
  if (clientHash) authFrame.set(clientHash, 36);
  if (instanceId) authFrame.set(instanceId, 68);
  return {
    authFrame,
    clientHash,
    clientInstanceId: instanceId,
    session: {
      audioFormat,
      sendKey,
      receiveKey,
      sendNoncePrefix: c2sPrefix,
      receiveNoncePrefix: s2cPrefix,
      sendSeq: 0n,
      receiveSeq: 0n,
    },
  };
}

function nonce(prefix, seq) {
  const result = new Uint8Array(12);
  result.set(prefix, 0);
  new DataView(result.buffer).setBigUint64(4, seq, false);
  return result;
}

function header(op, flags, seq, id) {
  const result = new Uint8Array(REMOTE_HEADER_BYTES);
  result[0] = REMOTE_PROTOCOL_VERSION;
  result[1] = op;
  result[2] = flags;
  result[3] = 0;
  const view = new DataView(result.buffer);
  view.setBigUint64(4, seq, false);
  view.setBigUint64(12, id, false);
  return result;
}

export function randomRemoteId() {
  const bytes = cryptoApi().getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0, false);
}

export async function encryptRemoteFrame(session, { op, flags = 0, id = 0n, payload = new Uint8Array() }) {
  if (session.sendSeq > 0xffffffffffffffffn) throw new Error("送信seqが上限に達しました。");
  const seq = session.sendSeq;
  const frameHeader = header(op, flags, seq, id);
  const plaintext = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const encrypted = await cryptoApi().subtle.encrypt({
    name: "AES-GCM",
    iv: nonce(session.sendNoncePrefix, seq),
    additionalData: frameHeader,
    tagLength: 128,
  }, session.sendKey, plaintext);
  session.sendSeq += 1n;
  return concatBytes(frameHeader, new Uint8Array(encrypted));
}

export async function decryptRemoteFrame(session, frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < REMOTE_HEADER_BYTES + 16) throw new Error("暗号化フレームが短すぎます。");
  const frameHeader = bytes.slice(0, REMOTE_HEADER_BYTES);
  if (frameHeader[0] !== REMOTE_PROTOCOL_VERSION || frameHeader[3] !== 0) throw new Error("暗号化フレームのヘッダーが正しくありません。");
  const view = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength);
  const seq = view.getBigUint64(4, false);
  if (seq !== session.receiveSeq) throw new Error("受信seqが連続していません。");
  const id = view.getBigUint64(12, false);
  const decrypted = await cryptoApi().subtle.decrypt({
    name: "AES-GCM",
    iv: nonce(session.receiveNoncePrefix, seq),
    additionalData: frameHeader,
    tagLength: 128,
  }, session.receiveKey, bytes.slice(REMOTE_HEADER_BYTES));
  session.receiveSeq += 1n;
  return {
    op: frameHeader[1],
    flags: frameHeader[2],
    seq,
    id,
    payload: new Uint8Array(decrypted),
  };
}

