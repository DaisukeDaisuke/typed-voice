export const REMOTE_MODE_PARAM = "server";
export const REMOTE_PAIRING_QR_PREFIX = "typed-voice:1:";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeRemotePairingQrText(value) {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  return `${REMOTE_PAIRING_QR_PREFIX}${bytesToBase64Url(bytes)}`;
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

export function validateRemotePairingPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QRの接続情報が正しくありません。");
  const protocolVersion = String(value.protocolVersion ?? "").trim();
  const endpointText = String(value.endpoint ?? "").trim();
  const encryptionKey = String(value.encryptionKey ?? "").trim();
  const authenticationKey = String(value.authenticationKey ?? "").trim();
  if (!protocolVersion || protocolVersion.length > 32) throw new Error("QRのバージョン情報が正しくありません。");
  let endpoint;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error("QRの接続先が正しくありません。");
  }
  if (endpoint.protocol !== "wss:" || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(endpoint.hostname)) {
    throw new Error("このQRはtyped-voice-serverの接続先ではありません。");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("QRの接続先に不要な情報が含まれています。");
  }
  const keyPattern = /^[A-Za-z0-9_-]{32,160}$/;
  if (!keyPattern.test(encryptionKey) || !keyPattern.test(authenticationKey)) {
    throw new Error("QRの鍵情報が正しくありません。");
  }
  if (encryptionKey === authenticationKey) throw new Error("QRの鍵情報が正しくありません。");
  return Object.freeze({
    protocolVersion,
    endpoint: endpoint.href,
    encryptionKey,
    authenticationKey,
    savedAt: Date.now(),
  });
}
