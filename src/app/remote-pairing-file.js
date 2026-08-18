const FILE_MAGIC = new TextEncoder().encode("TVRKEY1\0");
const FILE_AAD = new TextEncoder().encode("typed-voice-remote-pairing-file/v1");
const FILE_WRAP_KEY_HEX = "7f4b44d58e50e4b0de47d486bb11e16af31d8a78f4bbcd221ffb6b349911929a";
const MAX_PAIRING_FILE_BYTES = 16 * 1024;

function hexToBytes(hex) {
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function startsWith(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function decodeBase64Text(text) {
  let source = String(text ?? "").trim();
  if (source.startsWith("typed-voice-key:1:")) source = source.slice("typed-voice-key:1:".length).trim();
  source = source.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!source || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) throw new Error("接続キーファイルがraw binaryでもBase64でもありません。");
  source += "=".repeat((4 - source.length % 4) % 4);
  let binary;
  try { binary = atob(source); }
  catch { throw new Error("接続キーファイルのBase64が壊れています。"); }
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function normalizeEncryptedBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < FILE_MAGIC.byteLength + 12 + 16 || bytes.byteLength > MAX_PAIRING_FILE_BYTES) {
    throw new Error("接続キーファイルのサイズが正しくありません。");
  }
  if (startsWith(bytes, FILE_MAGIC)) return bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const decoded = decodeBase64Text(text);
  if (!startsWith(decoded, FILE_MAGIC)) throw new Error("typed-voice-serverの接続キーファイルではありません。");
  return decoded;
}

export async function decryptRemotePairingFile(input, cryptoImpl = globalThis.crypto) {
  const bytes = normalizeEncryptedBytes(input);
  const ivOffset = FILE_MAGIC.byteLength;
  const iv = bytes.slice(ivOffset, ivOffset + 12);
  const ciphertextAndTag = bytes.slice(ivOffset + 12);
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    hexToBytes(FILE_WRAP_KEY_HEX),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  let plaintext;
  try {
    plaintext = await cryptoImpl.subtle.decrypt({
      name: "AES-GCM",
      iv,
      additionalData: FILE_AAD,
      tagLength: 128,
    }, key, ciphertextAndTag);
  } catch {
    throw new Error("接続キーファイルを復号できません。別のサーバー用か、ファイルが壊れています。");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new Error("接続キーファイルの中身が正しくありません。");
  }
}
