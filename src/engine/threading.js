export function selectOrtThreadCount({
  isSecureContext = globalThis.isSecureContext === true,
  crossOriginIsolated = globalThis.crossOriginIsolated === true,
  hasSharedArrayBuffer = typeof globalThis.SharedArrayBuffer !== "undefined",
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 1,
  preferredThreadCount = 0,
} = {}) {
  if (!isSecureContext || !crossOriginIsolated || !hasSharedArrayBuffer) {
    return 1;
  }

  const logicalCores = Math.max(1, Math.trunc(hardwareConcurrency) || 1);
  if (Number.isFinite(preferredThreadCount) && preferredThreadCount > 0) {
    return Math.max(1, Math.min(logicalCores, Math.trunc(preferredThreadCount)));
  }

  return Math.max(1, Math.floor(logicalCores / 2));
}

export function configureOrtWasm(ort, options = {}) {
  const numThreads = selectOrtThreadCount(options);
  ort.env.wasm.numThreads = numThreads;
  ort.env.wasm.proxy = false;
  if (options.wasmBaseUrl) {
    ort.env.wasm.wasmPaths = options.wasmBaseUrl;
  }
  return numThreads;
}