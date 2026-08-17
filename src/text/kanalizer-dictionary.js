const INDEX_URL = new URL("../kanalizer-dictionary/dictionary.idx", import.meta.url);
const STRING_URL = new URL("../kanalizer-dictionary/dictionary.str", import.meta.url);

const HEADER_SIZE = 32;
const BUCKET_RECORD_SIZE = 8;
const RECORD_SIZE = 10;
const MIN_SPLIT_WORD_LENGTH = 3;

let dictionaryPromise = null;

export async function prepareKanalizerDictionaryOffline({ onStatus = () => {} } = {}) {
  onStatus("Kanalizer既知語辞書をオフラインCacheへ保存しています。");
  const responses = await Promise.all([
    fetch(INDEX_URL, { cache: "reload" }),
    fetch(STRING_URL, { cache: "reload" }),
  ]);
  if (!responses[0].ok || !responses[1].ok) {
    throw new Error(`Kanalizer dictionary fetch failed: ${responses[0].status}/${responses[1].status}`);
  }
  return {
    indexBytes: Number(responses[0].headers.get("content-length") || 0),
    stringBytes: Number(responses[1].headers.get("content-length") || 0),
  };
}

export async function loadKanalizerDictionary({ onStatus = () => {} } = {}) {
  if (!dictionaryPromise) {
    dictionaryPromise = createDictionary(onStatus).catch((error) => {
      dictionaryPromise = null;
      throw error;
    });
  }
  return dictionaryPromise;
}

async function createDictionary(onStatus) {
  onStatus("Kanalizer既知語辞書を読み込んでいます。");
  const [indexResponse, stringResponse] = await Promise.all([fetch(INDEX_URL), fetch(STRING_URL)]);
  if (!indexResponse.ok || !stringResponse.ok) {
    throw new Error(`Kanalizer dictionary fetch failed: ${indexResponse.status}/${stringResponse.status}`);
  }
  const [indexBuffer, stringBuffer] = await Promise.all([indexResponse.arrayBuffer(), stringResponse.arrayBuffer()]);
  return createKanalizerDictionary(indexBuffer, stringBuffer);
}

export function createKanalizerDictionary(indexBuffer, stringBuffer) {
  return new KanalizerDictionary(indexBuffer, stringBuffer);
}

class KanalizerDictionary {
  #index;
  #pool;
  #maxWordLength;
  #recordCount;
  #bucketCount;
  #bucketOffset;
  #recordOffset;
  #decoder = new TextDecoder();
  #readingCache = new Map();

  constructor(indexBuffer, stringBuffer) {
    this.#index = new DataView(indexBuffer);
    this.#pool = new Uint8Array(stringBuffer);
    const magic = String.fromCharCode(...new Uint8Array(indexBuffer, 0, 4));
    const version = this.#index.getUint16(4, true);
    if (magic !== "KDX1" || version !== 1) throw new Error("Unsupported Kanalizer dictionary format");
    this.#maxWordLength = this.#index.getUint16(6, true);
    this.#recordCount = this.#index.getUint32(8, true);
    const declaredPoolBytes = this.#index.getUint32(12, true);
    this.#bucketCount = this.#index.getUint32(16, true);
    const recordSize = this.#index.getUint32(20, true);
    this.#bucketOffset = this.#index.getUint32(24, true);
    this.#recordOffset = this.#index.getUint32(28, true);
    if (recordSize !== RECORD_SIZE || this.#bucketOffset !== HEADER_SIZE) throw new Error("Invalid Kanalizer dictionary header");
    if (declaredPoolBytes !== this.#pool.byteLength) throw new Error("Invalid Kanalizer dictionary string pool size");
    if (this.#bucketCount !== this.#maxWordLength * 26) throw new Error("Invalid Kanalizer dictionary bucket count");
    const expectedIndexBytes = this.#recordOffset + this.#recordCount * RECORD_SIZE;
    if (expectedIndexBytes !== indexBuffer.byteLength) throw new Error("Invalid Kanalizer dictionary index size");
  }

  segment(source) {
    const token = source.toLowerCase();
    if (!/^[a-z]+$/.test(token)) return [{ source, reading: null, known: false }];
    const states = Array.from({ length: token.length + 1 }, () => [null, null]);
    states[0][0] = { knownChars: 0, squaredKnown: 0, segments: 0, previous: -1, previousType: -1, segment: null };

    for (let index = 0; index < token.length; index += 1) {
      for (let type = 0; type <= 1; type += 1) {
        const state = states[index][type];
        if (!state) continue;
        this.#relaxUnknown(states, token, index, type, state);
        const maxLength = Math.min(this.#maxWordLength, token.length - index);
        for (let length = MIN_SPLIT_WORD_LENGTH; length <= maxLength; length += 1) {
          const match = this.#lookupSlice(token, index, length);
          if (!match) continue;
          const next = {
            knownChars: state.knownChars + length,
            squaredKnown: state.squaredKnown + length * length,
            segments: state.segments + 1,
            previous: index,
            previousType: type,
            segment: { source: source.slice(index, index + length), reading: match, known: true },
          };
          this.#relax(states[index + length], 0, next);
        }
      }
    }

    const finalType = better(states[token.length][0], states[token.length][1]) === states[token.length][0] ? 0 : 1;
    let state = states[token.length][finalType];
    if (!state) return [{ source, reading: null, known: false }];
    const segments = [];
    let cursor = token.length;
    let type = finalType;
    while (cursor > 0 && state) {
      if (state.segment) segments.push(state.segment);
      const previousCursor = state.previous;
      const previousType = state.previousType;
      cursor = previousCursor;
      type = previousType;
      state = cursor >= 0 && type >= 0 ? states[cursor][type] : null;
    }
    segments.reverse();
    return mergeUnknownSegments(segments);
  }

  #relaxUnknown(states, token, index, previousType, state) {
    const continuing = previousType === 1;
    const next = {
      knownChars: state.knownChars,
      squaredKnown: state.squaredKnown,
      segments: state.segments + (continuing ? 0 : 1),
      previous: index,
      previousType,
      segment: { source: token[index], reading: null, known: false },
    };
    this.#relax(states[index + 1], 1, next);
  }

  #relax(target, type, candidate) {
    target[type] = better(target[type], candidate);
  }

  #lookupSlice(token, start, length) {
    const first = token.charCodeAt(start) - 97;
    if (first < 0 || first >= 26 || length < 1 || length > this.#maxWordLength) return null;
    const bucketIndex = (length - 1) * 26 + first;
    const bucketOffset = this.#bucketOffset + bucketIndex * BUCKET_RECORD_SIZE;
    let low = this.#index.getUint32(bucketOffset, true);
    let high = low + this.#index.getUint32(bucketOffset + 4, true) - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const recordOffset = this.#recordOffset + middle * RECORD_SIZE;
      const wordOffset = this.#index.getUint32(recordOffset, true);
      const comparison = compareAsciiSlice(token, start, length, this.#pool, wordOffset);
      if (comparison === 0) return this.#readingForRecord(middle, recordOffset);
      if (comparison < 0) high = middle - 1;
      else low = middle + 1;
    }
    return null;
  }

  #readingForRecord(recordIndex, recordOffset) {
    const cached = this.#readingCache.get(recordIndex);
    if (cached) return cached;
    const readingOffset = this.#index.getUint32(recordOffset + 4, true);
    const readingLength = this.#index.getUint16(recordOffset + 8, true);
    const reading = this.#decoder.decode(this.#pool.subarray(readingOffset, readingOffset + readingLength));
    this.#readingCache.set(recordIndex, reading);
    return reading;
  }
}

function compareAsciiSlice(token, tokenOffset, length, pool, poolOffset) {
  for (let index = 0; index < length; index += 1) {
    const delta = token.charCodeAt(tokenOffset + index) - pool[poolOffset + index];
    if (delta) return delta;
  }
  return 0;
}

function better(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  if (candidate.knownChars !== current.knownChars) return candidate.knownChars > current.knownChars ? candidate : current;
  if (candidate.squaredKnown !== current.squaredKnown) return candidate.squaredKnown > current.squaredKnown ? candidate : current;
  if (candidate.segments !== current.segments) return candidate.segments < current.segments ? candidate : current;
  return current;
}

function mergeUnknownSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (!segment.known && previous && !previous.known) previous.source += segment.source;
    else merged.push({ ...segment });
  }
  return merged;
}

