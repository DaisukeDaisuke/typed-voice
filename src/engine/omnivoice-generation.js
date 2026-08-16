import { estimateTargetTokens } from "./duration-estimator.js";

const COND_BATCH = 0;
const UNCOND_BATCH = 1;
const NONCAUSAL_ATTENTION_MODE = "omnivoice-noncausal";

export function createPythonRandom(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error("OmniVoice seed must be a safe integer");
  const words = [];
  let value = BigInt(seed);
  if (value < 0n) value = -value;
  do {
    words.push(Number(value & 0xffffffffn));
    value >>= 32n;
  } while (value !== 0n);

  const mt = new Uint32Array(624);
  mt[0] = 19650218;
  for (let index = 1; index < 624; index += 1) {
    const previous = mt[index - 1];
    mt[index] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + index) >>> 0;
  }

  let i = 1;
  let j = 0;
  let count = Math.max(624, words.length);
  for (; count > 0; count -= 1) {
    const previous = mt[i - 1];
    mt[i] = (
      (mt[i] ^ Math.imul(previous ^ (previous >>> 30), 1664525)) +
      words[j] +
      j
    ) >>> 0;
    i += 1;
    j += 1;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
    if (j >= words.length) j = 0;
  }
  for (count = 623; count > 0; count -= 1) {
    const previous = mt[i - 1];
    mt[i] = ((mt[i] ^ Math.imul(previous ^ (previous >>> 30), 1566083941)) - i) >>> 0;
    i += 1;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
  }
  mt[0] = 0x80000000;

  let index = 624;
  function nextUint32() {
    if (index >= 624) {
      for (let k = 0; k < 624; k += 1) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = mt[index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  return () => {
    const high = nextUint32() >>> 5;
    const low = nextUint32() >>> 6;
    return (high * 67108864 + low) / 9007199254740992;
  };
}

export function buildOmniVoiceAttentionMask({ sequenceLength, targetLength, mode = "legacy-causal-2d" }) {
  if (mode !== NONCAUSAL_ATTENTION_MODE) {
    const data = new BigInt64Array(2 * sequenceLength);
    data.fill(1n, 0, sequenceLength);
    data.fill(1n, sequenceLength, sequenceLength + targetLength);
    return { data, type: "int64", shape: [2, sequenceLength] };
  }

  const matrixSize = sequenceLength * sequenceLength;
  const data = new Uint8Array(2 * matrixSize);
  data.fill(1, 0, matrixSize);
  const uncondBase = matrixSize;
  for (let row = 0; row < targetLength; row += 1) {
    data.fill(1, uncondBase + row * sequenceLength, uncondBase + row * sequenceLength + targetLength);
  }
  for (let index = targetLength; index < sequenceLength; index += 1) {
    data[uncondBase + index * sequenceLength + index] = 1;
  }
  return { data, type: "bool", shape: [2, 1, sequenceLength, sequenceLength] };
}

function timeSteps(numStep, tShift) {
  const steps = [];
  for (let index = 0; index <= numStep; index += 1) {
    const linear = index / numStep;
    steps.push((tShift * linear) / (1 + (tShift - 1) * linear));
  }
  return steps;
}

function logSoftmaxInto(values, offset, length, output) {
  let maximum = -Infinity;
  for (let index = 0; index < length; index += 1) {
    maximum = Math.max(maximum, values[offset + index]);
  }
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Math.exp(values[offset + index] - maximum);
  }
  const normalizer = maximum + Math.log(sum);
  for (let index = 0; index < length; index += 1) {
    output[index] = values[offset + index] - normalizer;
  }
}

function choosePredictions({ logits, codebooks, sequenceLength, vocabularySize, targetLength, targetOffset, guidanceScale, layerPenalty, maskId }) {
  const count = codebooks * targetLength;
  const predictions = new Int32Array(count);
  const scores = new Float32Array(count);
  const conditional = new Float32Array(vocabularySize);
  const unconditional = new Float32Array(vocabularySize);
  const guided = new Float32Array(vocabularySize);
  const condBatchStride = codebooks * sequenceLength * vocabularySize;

  for (let codebook = 0; codebook < codebooks; codebook += 1) {
    for (let target = 0; target < targetLength; target += 1) {
      const condOffset = ((codebook * sequenceLength + targetOffset + target) * vocabularySize);
      const uncondOffset = condBatchStride + ((codebook * sequenceLength + target) * vocabularySize);
      logSoftmaxInto(logits, condOffset, vocabularySize, conditional);
      logSoftmaxInto(logits, uncondOffset, vocabularySize, unconditional);

      let normalizerMax = -Infinity;
      for (let token = 0; token < vocabularySize; token += 1) {
        const score = (1 + guidanceScale) * conditional[token] - guidanceScale * unconditional[token];
        guided[token] = score;
        normalizerMax = Math.max(normalizerMax, score);
      }
      let normalizerSum = 0;
      for (let token = 0; token < vocabularySize; token += 1) {
        normalizerSum += Math.exp(guided[token] - normalizerMax);
      }
      const normalizer = normalizerMax + Math.log(normalizerSum);
      let bestToken = 0;
      let bestScore = -Infinity;
      for (let token = 0; token < vocabularySize; token += 1) {
        if (token === maskId) continue;
        const score = guided[token] - normalizer;
        if (score > bestScore) {
          bestToken = token;
          bestScore = score;
        }
      }
      const outputIndex = codebook * targetLength + target;
      predictions[outputIndex] = bestToken;
      scores[outputIndex] = bestScore - layerPenalty * codebook;
    }
  }
  return { predictions, scores };
}

function gumbelScore(score, temperature, random) {
  if (!(temperature > 0)) return score;
  const u = Math.min(1 - 1e-10, Math.max(0, random()));
  const noise = -Math.log(-Math.log(u + 1e-10) + 1e-10);
  return score / temperature + noise;
}

function unmaskBest({ scores, predictions, tokens, maskId, count, positionTemperature, random }) {
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === BigInt(maskId)) {
      candidates.push({ index, score: gumbelScore(scores[index], positionTemperature, random) });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const chosen = candidates.slice(0, count);
  for (const { index } of chosen) {
    tokens[index] = BigInt(predictions[index]);
  }
  return chosen.length;
}

export async function prepareOmniVoiceInputs(text, tokenizer, config, options = {}) {
  const normalizedText = text.trim().replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ");
  if (!normalizedText) {
    throw new Error("Synthesis text is empty");
  }
  const language = options.language ?? "ja";
  const instruction = options.instruct ?? "None";
  // OmniVoice 0.2.1 prepends <|denoise|> only when reference-audio tokens
  // are present. The fixed-voice browser PoC has no reference encoder.
  const denoisePrefix = options.hasReferenceAudio && (options.denoise ?? config.denoise) ? "<|denoise|>" : "";
  const styleText = `${denoisePrefix}<|lang_start|>${language}<|lang_end|><|instruct_start|>${instruction}<|instruct_end|>`;
  const wrappedText = `<|text_start|>${normalizedText}<|text_end|>`;
  const [styleEncoded, textEncoded] = await Promise.all([
    tokenizer.encode(styleText),
    tokenizer.encode(wrappedText),
  ]);
  const styleIds = Array.from(styleEncoded.ids, Number);
  const textIds = Array.from(textEncoded.ids, Number);
  const targetLength = Math.min(
    options.maxTargetTokens ?? 700,
    options.targetTokens ?? estimateTargetTokens(normalizedText, { speed: options.speed ?? 1 })
  );
  const codebooks = config.num_audio_codebook;
  const targetOffset = styleIds.length + textIds.length;
  const sequenceLength = targetOffset + targetLength;
  const inputIds = new BigInt64Array(codebooks * sequenceLength);
  const audioMask = new Uint8Array(sequenceLength);

  for (let codebook = 0; codebook < codebooks; codebook += 1) {
    const row = codebook * sequenceLength;
    for (let index = 0; index < styleIds.length; index += 1) inputIds[row + index] = BigInt(styleIds[index]);
    for (let index = 0; index < textIds.length; index += 1) inputIds[row + styleIds.length + index] = BigInt(textIds[index]);
    for (let index = 0; index < targetLength; index += 1) inputIds[row + targetOffset + index] = BigInt(config.audio_mask_id);
  }
  audioMask.fill(1, targetOffset);
  return { inputIds, audioMask, codebooks, sequenceLength, targetLength, targetOffset };
}

export async function generateOmniVoiceCodes({
  inputs,
  config,
  runBackboneStep,
  numStep = 16,
  guidanceScale = 4,
  tShift = 0.05,
  layerPenalty = 5,
  positionTemperature = 0,
  classTemperature = 0,
  attentionMode = "legacy-causal-2d",
  isCancelled = () => false,
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  onStep = () => {},
  random = Math.random,
}) {
  if (!Number.isInteger(numStep) || numStep <= 0) {
    throw new Error("OmniVoice numStep must be a positive integer");
  }
  if (classTemperature !== 0) {
    throw new Error("OmniVoice browser PoC currently requires classTemperature=0 (greedy token selection)");
  }
  const { inputIds, audioMask, codebooks, sequenceLength, targetLength, targetOffset } = inputs;
  const maskId = config.audio_mask_id;
  const vocabularySize = config.audio_vocab_size;
  const batchIds = new BigInt64Array(2 * codebooks * sequenceLength).fill(BigInt(maskId));
  const batchMask = new Uint8Array(2 * sequenceLength);
  const attention = buildOmniVoiceAttentionMask({ sequenceLength, targetLength, mode: attentionMode });

  for (let codebook = 0; codebook < codebooks; codebook += 1) {
    for (let sequence = 0; sequence < sequenceLength; sequence += 1) {
      batchIds[(COND_BATCH * codebooks + codebook) * sequenceLength + sequence] = inputIds[codebook * sequenceLength + sequence];
    }
    for (let target = 0; target < targetLength; target += 1) {
      batchIds[(UNCOND_BATCH * codebooks + codebook) * sequenceLength + target] = BigInt(maskId);
    }
  }
  batchMask.set(audioMask, 0);
  batchMask.fill(1, sequenceLength, sequenceLength + targetLength);

  const tokens = new BigInt64Array(codebooks * targetLength).fill(BigInt(maskId));
  const steps = timeSteps(numStep, tShift);
  const totalMask = tokens.length;
  let remaining = totalMask;

  for (let step = 0; step < numStep && remaining > 0; step += 1) {
    await yieldControl();
    if (isCancelled()) throw new Error("cancelled");
    const scheduled =
      step === numStep - 1
        ? remaining
        : Math.min(remaining, Math.ceil(totalMask * (steps[step + 1] - steps[step])));

    const logits = await runBackboneStep({
      inputIds: batchIds,
      audioMask: batchMask,
      attentionMask: attention.data,
      attentionMaskType: attention.type,
      attentionMaskShape: attention.shape,
      batch: 2,
      codebooks,
      sequenceLength,
    });
    const { predictions, scores } = choosePredictions({
      logits,
      codebooks,
      sequenceLength,
      vocabularySize,
      targetLength,
      targetOffset,
      guidanceScale,
      layerPenalty,
      maskId,
    });
    const changed = unmaskBest({
      scores,
      predictions,
      tokens,
      maskId,
      count: scheduled,
      positionTemperature,
      random,
    });
    remaining -= changed;

    for (let codebook = 0; codebook < codebooks; codebook += 1) {
      for (let target = 0; target < targetLength; target += 1) {
        const token = tokens[codebook * targetLength + target];
        batchIds[(COND_BATCH * codebooks + codebook) * sequenceLength + targetOffset + target] = token;
        batchIds[(UNCOND_BATCH * codebooks + codebook) * sequenceLength + target] = token;
      }
    }
    onStep({ step: step + 1, numStep, remaining, total: totalMask });
  }

  if (remaining !== 0 || tokens.some((token) => token === BigInt(maskId))) {
    throw new Error(`OmniVoice generation left ${remaining} masked tokens`);
  }
  return { tokens, codebooks, targetLength };
}
