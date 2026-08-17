import initKanalizerWasm, { KanalizerModel } from "../kanalizer-wasm/kanalizer_browser.js";
import kanalizerWasmUrl from "../kanalizer-wasm/kanalizer_browser_bg.wasm?url";
import {
  loadKanalizerDictionary,
  prepareKanalizerDictionaryOffline,
} from "./kanalizer-dictionary.js";

const MODEL_REPOSITORY = "VOICEVOX/kanalizer-model";
const MODEL_TAG = "v5";
const MODEL_FILE = "model/c2k.safetensors";
const MODEL_CACHE = "typed-voice-kanalizer-model-v1";
const MODEL_API_URL = `https://huggingface.co/api/models/${MODEL_REPOSITORY}/revision/${MODEL_TAG}?blobs=true`;
const MODEL_METADATA_CACHE_URL = new URL("__typed_voice_kanalizer/model-metadata-v1.json", document.baseURI).href;

let runtimePromise = null;

export function hasKanalizerCandidate(text) {
  return /[A-Za-z]+/.test(text);
}

export async function prepareKanalizerOffline({ onStatus = () => {}, signal = null } = {}) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Download aborted", "AbortError");
  const dictionary = await prepareKanalizerDictionaryOffline({ onStatus, signal });
  const wasmBytes = await prepareKanalizerWasmOffline(onStatus, signal);
  const metadata = await fetchLatestModelMetadata(onStatus, signal);
  const cache = await caches.open(MODEL_CACHE);
  const request = modelRequest(metadata);
  let response = await cache.match(request);

  if (!response) {
    onStatus(`Kanalizer v5モデルをHugging Faceから取得しています（${(metadata.expectedBytes / 1024 / 1024).toFixed(2)} MiB）。`);
    const networkResponse = await fetch(request, { cache: "no-store", signal });
    if (!networkResponse.ok) throw new Error(`Kanalizer model fetch failed: ${networkResponse.status}`);
    await cache.put(request, networkResponse);
    response = await cache.match(request);
    if (!response) throw new Error("Kanalizer model cache write failed");
  } else {
    onStatus("保存済みKanalizer v5モデルを再検証しています。");
  }

  await verifyModelResponse(response, metadata, cache, request);
  await cache.put(
    new Request(MODEL_METADATA_CACHE_URL),
    new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } }),
  );
  await deleteOldModelEntries(cache, request);
  onStatus(`Kanalizerオフライン準備完了（${MODEL_TAG} / ${metadata.sha.slice(0, 12)}）。`);
  return {
    revision: metadata.sha,
    modelBytes: metadata.expectedBytes,
    dictionaryBytes: dictionary.indexBytes + dictionary.stringBytes,
    wasmBytes,
  };
}

async function prepareKanalizerWasmOffline(onStatus, signal) {
  onStatus("Kanalizer WASMをオフラインCacheへ保存しています。");
  const response = await fetch(kanalizerWasmUrl, { cache: "reload", signal });
  if (!response.ok) throw new Error(`Kanalizer WASM fetch failed: ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isSafeInteger(contentLength) && contentLength > 0) return contentLength;
  const buffer = await response.arrayBuffer();
  return buffer.byteLength;
}

export async function normalizeAsciiLetterRuns(text, { onStatus = () => {} } = {}) {
  const matches = [...text.matchAll(/[A-Za-z]+/g)];
  if (matches.length === 0) {
    return { text, replacements: [], modelRevision: null };
  }

  const dictionary = await loadKanalizerDictionary({ onStatus });
  let output = "";
  let cursor = 0;
  const replacements = [];
  let runtime = null;

  for (const match of matches) {
    const source = match[0];
    const index = match.index;
    const segments = dictionary.segment(source);
    const readings = [];
    const pronunciationBoundaries = findPronunciationBoundaries(source);
    let sourceOffset = 0;
    for (const segment of segments) {
      if (readings.length > 0) readings.push(pronunciationBoundaries.get(sourceOffset) || "");
      if (segment.known) {
        readings.push(segment.reading);
      } else {
        runtime ??= await getRuntime(onStatus);
        readings.push(runtime.model.convert(segment.source.toLowerCase()));
      }
      sourceOffset += segment.source.length;
    }
    const reading = readings.join("");
    output += text.slice(cursor, index) + reading;
    cursor = index + source.length;
    replacements.push({
      source,
      reading,
      index,
      segments: segments.map((segment) => ({ source: segment.source, known: segment.known })),
    });
  }
  output += text.slice(cursor);

  return {
    text: output,
    replacements,
    modelRevision: runtime?.revision ?? null,
  };
}

// PoCと本番で同じ変換実装を使う。既存PoCのimport名は互換性のため残す。
export const normalizeAsciiLetterRunsForPoc = normalizeAsciiLetterRuns;

function findPronunciationBoundaries(source) {
  const boundaries = new Map();
  for (let index = 1; index < source.length; index += 1) {
    const previous = source[index - 1];
    const current = source[index];
    const next = source[index + 1] || "";
    // OmniVoiceでは挿入スペースが長い停止やノイズを作ることがある。
    // 通常のCamelCase境界は詰め、頭字語から通常語へ移る境界だけ「_」を使う。
    if (/[A-Z]/.test(previous) && /[A-Z]/.test(current) && /[a-z]/.test(next)) boundaries.set(index, "_");
  }
  return boundaries;
}

async function getRuntime(onStatus) {
  if (!runtimePromise) {
    runtimePromise = createRuntime(onStatus).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function createRuntime(onStatus) {
  const cache = await caches.open(MODEL_CACHE);
  const metadataResponse = await cache.match(new Request(MODEL_METADATA_CACHE_URL));
  if (!metadataResponse) throw new Error("Kanalizer v5モデルがオフライン準備されていません。「オフライン音声を準備」を実行してください。");
  const metadata = validatePreparedMetadata(await metadataResponse.json());
  const request = modelRequest(metadata);
  const response = await cache.match(request);
  if (!response) throw new Error("Kanalizer v5モデルのオフラインCacheが見つかりません。再度オフライン準備してください。");

  onStatus("保存済みKanalizer v5モデルを検証しています。");
  const buffer = await verifyModelResponse(response, metadata, cache, request);

  onStatus("Kanalizer WASMを初期化しています。");
  await initKanalizerWasm();
  onStatus("KanalizerモデルをWASMへ読み込んでいます。");
  const model = new KanalizerModel(new Uint8Array(buffer));

  onStatus(`Kanalizer準備完了（${MODEL_TAG} / ${metadata.sha.slice(0, 12)}）。`);
  return { model, revision: metadata.sha };
}

async function fetchLatestModelMetadata(onStatus, signal) {
  onStatus("Hugging Faceの非認証APIからKanalizer v5モデル情報を取得しています。");
  const response = await fetch(MODEL_API_URL, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Kanalizer model metadata fetch failed: ${response.status}`);
  const raw = await response.json();
  const modelEntry = raw.siblings?.find((entry) => entry.rfilename === MODEL_FILE);
  return validatePreparedMetadata({
    sha: raw.sha,
    expectedSha256: modelEntry?.lfs?.sha256,
    expectedBytes: Number(modelEntry?.lfs?.size ?? modelEntry?.size),
  });
}

function validatePreparedMetadata(metadata) {
  const sha = String(metadata?.sha || "");
  const expectedSha256 = String(metadata?.expectedSha256 || "").toLowerCase();
  const expectedBytes = Number(metadata?.expectedBytes);
  if (!/^[0-9a-f]{40}$/i.test(sha) || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("Kanalizer model metadata is incomplete");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error("Kanalizer model metadata is incomplete");
  return { sha, expectedSha256, expectedBytes };
}

function modelRequest(metadata) {
  return new Request(`https://huggingface.co/${MODEL_REPOSITORY}/resolve/${metadata.sha}/${MODEL_FILE}`, { mode: "cors" });
}

async function verifyModelResponse(response, metadata, cache, request) {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== metadata.expectedBytes) {
    await cache.delete(request);
    throw new Error(`Kanalizer model size mismatch: ${buffer.byteLength} != ${metadata.expectedBytes}`);
  }
  const actualSha256 = await sha256Hex(buffer);
  if (actualSha256 !== metadata.expectedSha256) {
    await cache.delete(request);
    throw new Error("Kanalizer model SHA-256 mismatch");
  }
  return buffer;
}

async function deleteOldModelEntries(cache, currentRequest) {
  for (const cachedRequest of await cache.keys()) {
    if (cachedRequest.url === MODEL_METADATA_CACHE_URL || cachedRequest.url === currentRequest.url) continue;
    await cache.delete(cachedRequest);
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

