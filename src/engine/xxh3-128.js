import { createXXHash128 } from "hash-wasm";

export function isXxh3_128(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

export async function xxh3_128Stream(readable, onChunk = () => {}) {
  const hasher = await createXXHash128();
  const reader = readable.getReader();
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      loaded += value.byteLength;
      onChunk({ loaded, chunkSize: value.byteLength });
    }
  } finally {
    reader.releaseLock();
  }
  return { xxh3_128: hasher.digest(), byteSize: loaded };
}
