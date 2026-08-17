/*
 * Cross-origin isolation response rewriting is derived from coi-serviceworker:
 * https://github.com/gzuidhof/coi-serviceworker
 * Copyright (c) Guido Zuidhof and contributors, MIT License.
 */

const MODEL_CACHE = "typed-voice-model-assets-v2";
const KANALIZER_MODEL_CACHE = "typed-voice-kanalizer-model-v1";
const SOURCE_CACHE_KEY = new URL(self.location.href).searchParams.get("source-cache") || "legacy-v4";
const SOURCE_CACHE = `typed-voice-source-${SOURCE_CACHE_KEY}`;
const MODEL_PREFIX = new URL("__typed_voice_assets/", self.registration.scope).pathname;
const MODEL_CHUNK_QUERY = "__typed_voice_part";
const DEV_MODE = new URL(self.location.href).searchParams.get("dev") === "1";
const SHELL = [
  "./",
  "./index.html",
  "./poc.html",
  "./licenses.html",
  "./voice-manifest.json",
  "./LICENSE.txt",
  "./NOTICE.txt",
  "./THIRD_PARTY_NOTICES.md",
  "./licenses/BOSON-HIGGS-AUDIO-2-LICENSE.txt",
  "./licenses/META-LLAMA-3-LICENSE.txt",
  "./licenses/VOICEVOX-KANALIZER-LICENSE.txt",
  "./licenses/KANALIZER-RUST-LICENSES.md",
  "./ort-wasm-simd-threaded.mjs",
  "./ort-wasm-simd-threaded.wasm",
  "./ort-wasm-simd-threaded.jsep.mjs",
  "./ort-wasm-simd-threaded.jsep.wasm",
  "./ort-wasm-simd-threaded.jspi.mjs",
  "./ort-wasm-simd-threaded.jspi.wasm",
  "./ort-wasm-simd-threaded.asyncify.mjs",
  "./ort-wasm-simd-threaded.asyncify.wasm"
];

self.addEventListener("install", (event) => {
  if (!DEV_MODE) event.waitUntil(caches.open(SOURCE_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("typed-voice-") && key !== SOURCE_CACHE && key !== MODEL_CACHE && key !== KANALIZER_MODEL_CACHE)
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "typed-voice:check-model-cache") return;
  const port = event.ports?.[0];
  if (!port) return;
  event.waitUntil((async () => {
    try {
      const prepared = await isPreparedModelCached(message.manifestUrl, message.appBaseUrl);
      port.postMessage({ ok: true, prepared });
    } catch (error) {
      port.postMessage({ ok: false, prepared: false, message: error instanceof Error ? error.message : String(error) });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(MODEL_PREFIX)) {
    event.respondWith(readPreparedModelAsset(event.request));
    return;
  }
  if (DEV_MODE) {
    event.respondWith(fetch(event.request).then(isolatedResponse));
    return;
  }
  event.respondWith(readShellAsset(event.request));
});

async function readPreparedModelAsset(request) {
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(request);
  if (!response) {
    return isolatedResponse(
      new Response("Prepared model asset is unavailable offline", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
  }
  const chunkCount = Number(response.headers.get("x-typed-voice-chunk-count") || 0);
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return isolatedResponse(response);
  const byteSize = Number(response.headers.get("x-typed-voice-byte-size") || 0);
  const virtualUrl = new URL(request.url);
  virtualUrl.searchParams.delete(MODEL_CHUNK_QUERY);
  return isolatedResponse(new Response(createModelChunkStream(cache, virtualUrl.href, chunkCount), {
    status: 200,
    headers: {
      "content-type": response.headers.get("x-typed-voice-content-type") || "application/octet-stream",
      ...(Number.isSafeInteger(byteSize) && byteSize > 0 ? { "content-length": String(byteSize) } : {}),
      "x-typed-voice-xxh3-128": response.headers.get("x-typed-voice-xxh3-128") || "",
    },
  }));
}

function buildModelChunkUrl(virtualUrl, index) {
  const url = new URL(virtualUrl);
  url.searchParams.set(MODEL_CHUNK_QUERY, String(index));
  return url.href;
}

function buildModelAssetUrl(manifestId, localPath, baseUrl) {
  const encodedId = encodeURIComponent(manifestId);
  const encodedPath = String(localPath || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return new URL(`__typed_voice_assets/${encodedId}/${encodedPath}`, baseUrl || self.registration.scope).href;
}

async function isPreparedModelCached(manifestUrl, appBaseUrl) {
  if (!manifestUrl) return false;
  const cache = await caches.open(MODEL_CACHE);
  const manifestResponse = await cache.match(manifestUrl);
  if (!manifestResponse) return false;
  const manifest = await manifestResponse.json();
  if (!manifest?.id || !Array.isArray(manifest.assets) || manifest.assets.length === 0) return false;
  for (const asset of manifest.assets) {
    const virtualUrl = buildModelAssetUrl(manifest.id, asset.localPath, appBaseUrl);
    const indexResponse = await cache.match(virtualUrl);
    if (!indexResponse) return false;
    const chunkCount = Number(indexResponse.headers.get("x-typed-voice-chunk-count") || 0);
    const byteSize = Number(indexResponse.headers.get("x-typed-voice-byte-size") || 0);
    const xxh3 = indexResponse.headers.get("x-typed-voice-xxh3-128") || "";
    if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return false;
    if (Number(asset.byteSize) !== byteSize) return false;
    if (String(asset.xxh3_128 || "").toLowerCase() !== xxh3.toLowerCase()) return false;
    for (let index = 0; index < chunkCount; index += 1) {
      if (!await cache.match(buildModelChunkUrl(virtualUrl, index))) return false;
    }
  }
  return true;
}

function createModelChunkStream(cache, virtualUrl, chunkCount) {
  let chunkIndex = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (reader) {
            const current = await reader.read();
            if (!current.done) {
              controller.enqueue(current.value);
              return;
            }
            reader.releaseLock();
            reader = null;
            chunkIndex += 1;
          }
          if (chunkIndex >= chunkCount) {
            controller.close();
            return;
          }
          const response = await cache.match(buildModelChunkUrl(virtualUrl, chunkIndex));
          if (!response?.body) throw new Error(`Prepared model chunk is unavailable offline: ${chunkIndex}`);
          reader = response.body.getReader();
        }
      } catch (error) {
        if (reader) reader.releaseLock();
        reader = null;
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!reader) return;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        reader = null;
      }
    },
  });
}

async function readShellAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SOURCE_CACHE);
      await cache.put(request, response.clone());
    }
    return isolatedResponse(response);
  } catch (error) {
    let response = await caches.match(request);
    if (!response && request.mode === "navigate") {
      const canonicalUrl = new URL(request.url);
      canonicalUrl.search = "";
      canonicalUrl.hash = "";
      response = await caches.match(canonicalUrl.href);
      if (!response) response = await caches.match(new URL("./index.html", self.registration.scope).href);
    }
    if (!response) throw error;
    return isolatedResponse(response);
  }
}

function isolatedResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
