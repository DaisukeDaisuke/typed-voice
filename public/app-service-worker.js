/*
 * Cross-origin isolation response rewriting is derived from coi-serviceworker:
 * https://github.com/gzuidhof/coi-serviceworker
 * Copyright (c) Guido Zuidhof and contributors, MIT License.
 */

const CACHE_NAME = "typed-voice-engine-poc-v2";
const SHELL = ["./", "./index.html", "./voice-manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
      self.clients.claim(),
    ])
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  let response = sameOrigin ? await caches.match(request) : null;

  if (!response) {
    try {
      response = await fetch(request);
      if (sameOrigin && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
    } catch (error) {
      if (request.mode === "navigate") {
        response = await caches.match("./index.html");
      }
      if (!response) {
        throw error;
      }
    }
  }

  return sameOrigin ? withIsolationHeaders(response) : response;
}

function withIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}