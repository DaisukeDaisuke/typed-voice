const CLIENT_ID_KEY = "typed-voice-remote-client-id-v1";
const CLIENT_INSTANCE_ID_KEY = "typed-voice-remote-client-instance-id-v1";
const encoder = new TextEncoder();

function cryptoApi() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto APIを利用できません。");
  }
  return globalThis.crypto;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stableClientId() {
  let stored = null;
  try { stored = globalThis.localStorage?.getItem?.(CLIENT_ID_KEY) ?? null; } catch {}
  if (/^[A-Za-z0-9_-]{22}$/.test(String(stored ?? ""))) return stored;
  const created = bytesToBase64Url(cryptoApi().getRandomValues(new Uint8Array(16)));
  try { globalThis.localStorage?.setItem?.(CLIENT_ID_KEY, created); } catch {}
  return created;
}

export function getRemoteClientInstanceId() {
  let stored = null;
  try { stored = globalThis.sessionStorage?.getItem?.(CLIENT_INSTANCE_ID_KEY) ?? null; } catch {}
  if (/^[A-Za-z0-9_-]{22}$/.test(String(stored ?? ""))) {
    const normalized = stored.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength === 16) return bytes;
  }
  const created = cryptoApi().getRandomValues(new Uint8Array(16));
  try { globalThis.sessionStorage?.setItem?.(CLIENT_INSTANCE_ID_KEY, bytesToBase64Url(created)); } catch {}
  return created;
}

function bucketPowerOfTwo(value, maximum = 32) {
  const number = Math.max(1, Math.min(maximum, Number(value) || 1));
  let bucket = 1;
  while (bucket < number && bucket < maximum) bucket *= 2;
  return bucket;
}

function memoryBucket(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number <= 1) return 1;
  if (number <= 2) return 2;
  if (number <= 4) return 4;
  if (number <= 8) return 8;
  return 16;
}

function touchBucket(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number === 0) return 0;
  if (number === 1) return 1;
  return 5;
}

function lowEntropyMaterial() {
  const navigatorRef = globalThis.navigator ?? {};
  const uaData = navigatorRef.userAgentData;
  const platform = String(uaData?.platform || navigatorRef.platform || "unknown").slice(0, 32);
  return JSON.stringify({
    id: stableClientId(),
    platform,
    mobile: Boolean(uaData?.mobile),
    cores: bucketPowerOfTwo(navigatorRef.hardwareConcurrency, 32),
    memory: memoryBucket(navigatorRef.deviceMemory),
    touch: touchBucket(navigatorRef.maxTouchPoints),
  });
}

export async function createRemoteClientBanHash(serverSalt) {
  const salt = serverSalt instanceof Uint8Array ? serverSalt : new Uint8Array(serverSalt);
  if (salt.byteLength !== 32) throw new Error("サーバーの匿名識別saltが正しくありません。");
  const prefix = encoder.encode("typed-voice-client-ban/v1\n");
  const material = encoder.encode(lowEntropyMaterial());
  const input = new Uint8Array(prefix.byteLength + salt.byteLength + 1 + material.byteLength);
  let offset = 0;
  input.set(prefix, offset); offset += prefix.byteLength;
  input.set(salt, offset); offset += salt.byteLength;
  input[offset] = 0; offset += 1;
  input.set(material, offset);
  return new Uint8Array(await cryptoApi().subtle.digest("SHA-256", input));
}
