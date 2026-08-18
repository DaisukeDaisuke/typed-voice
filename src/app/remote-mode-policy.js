import {
  REMOTE_PROTOCOL_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  computeRemotePairingChecksum,
} from "./remote-protocol.js";

export const REMOTE_MODE_PARAM = "server";
export const REMOTE_PAIRING_QR_PREFIX = "typed-voice:1:";

export function encodeRemotePairingQrText(value) {
  return JSON.stringify(value);
}

export function decodeRemotePairingQrText(text) {
  const source = String(text ?? "").trim();
  if (source.startsWith(REMOTE_PAIRING_QR_PREFIX)) {
    const encoded = source.slice(REMOTE_PAIRING_QR_PREFIX.length);
    if (!encoded) throw new Error("QRの接続情報が空です。");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded));
    return JSON.parse(json);
  }
  return JSON.parse(source);
}

export function isServerModeUrl(urlLike) {
  const url = new URL(String(urlLike), "https://typed-voice.invalid/");
  return url.searchParams.get(REMOTE_MODE_PARAM) === "1";
}

export function resolveRemoteStartupAction({ serverMode, hasPairing }) {
  if (!serverMode) return "local";
  if (hasPairing) return "handshake";
  return "tutorial";
}

export function buildServerModeUrl(urlLike) {
  const url = new URL(String(urlLike), "https://typed-voice.invalid/");
  url.searchParams.set(REMOTE_MODE_PARAM, "1");
  return url;
}

export function buildLocalModeUrl(urlLike) {
  const url = new URL(String(urlLike), "https://typed-voice.invalid/");
  url.searchParams.delete(REMOTE_MODE_PARAM);
  return url;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function validateRemotePairingPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QRの接続情報が正しくありません。");
  if (value.v !== REMOTE_PROTOCOL_VERSION) throw new Error("QRのバージョン情報が正しくありません。");
  let endpoint;
  try {
    endpoint = new URL(String(value.u ?? ""));
  } catch {
    throw new Error("QRの接続先が正しくありません。");
  }
  if (endpoint.protocol !== "wss:" || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(endpoint.hostname)) {
    throw new Error("このQRはtyped-voice-serverの接続先ではありません。");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("QRの接続先に不要な情報が含まれています。");
  }
  const authenticationKey = base64UrlToBytes(value.a);
  const encryptionKey = base64UrlToBytes(value.e);
  const checksum = base64UrlToBytes(value.c);
  if (authenticationKey.byteLength !== 32 || encryptionKey.byteLength !== 32 || checksum.byteLength !== 16) {
    throw new Error("QRの鍵情報が正しくありません。");
  }
  if (equalBytes(authenticationKey, encryptionKey)) throw new Error("QRの鍵情報が正しくありません。");
  const expected = await computeRemotePairingChecksum(endpoint.href, authenticationKey, encryptionKey);
  if (!equalBytes(checksum, expected)) throw new Error("QRのチェックサムが一致しません。");
  return Object.freeze({
    protocolVersion: String(REMOTE_PROTOCOL_VERSION),
    endpoint: endpoint.href,
    authenticationKey: bytesToBase64Url(authenticationKey),
    encryptionKey: bytesToBase64Url(encryptionKey),
    checksum: bytesToBase64Url(checksum),
    savedAt: Date.now(),
  });
}
