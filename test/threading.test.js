import test from "node:test";
import assert from "node:assert/strict";
import { configureOrtWasm, selectOrtThreadCount } from "../src/engine/threading.js";

test("cross-origin isolationが無効なら1 threadへfallbackする", () => {
  assert.equal(
    selectOrtThreadCount({
      isSecureContext: true,
      crossOriginIsolated: false,
      hasSharedArrayBuffer: true,
      hardwareConcurrency: 8,
      preferredThreadCount: 8,
    }),
    1
  );
});

test("SharedArrayBufferがなければ1 threadへfallbackする", () => {
  assert.equal(
    selectOrtThreadCount({
      isSecureContext: true,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: false,
      hardwareConcurrency: 8,
    }),
    1
  );
});

test("secure contextでなければ1 threadへfallbackする", () => {
  assert.equal(
    selectOrtThreadCount({
      isSecureContext: false,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
      hardwareConcurrency: 8,
    }),
    1
  );
});

test("明示thread数はlogical core数以下へclampされる", () => {
  assert.equal(
    selectOrtThreadCount({
      isSecureContext: true,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
      hardwareConcurrency: 8,
      preferredThreadCount: 32,
    }),
    8
  );
});

test("未指定時はlogical core数から動的に決定する", () => {
  assert.equal(
    selectOrtThreadCount({
      isSecureContext: true,
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
      hardwareConcurrency: 10,
    }),
    5
  );
});

test("ORT WASM asset pathを同一originの固定baseへ設定する", () => {
  const ort = { env: { wasm: {} } };
  const threads = configureOrtWasm(ort, {
    isSecureContext: false,
    wasmBaseUrl: "https://example.test/typed-voice/",
  });
  assert.equal(threads, 1);
  assert.equal(ort.env.wasm.proxy, false);
  assert.equal(ort.env.wasm.wasmPaths, "https://example.test/typed-voice/");
});