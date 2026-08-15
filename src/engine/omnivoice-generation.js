import { estimateTargetTokens } from "./duration-estimator.js";

const COND_BATCH = 0;
const UNCOND_BATCH = 1;

function timeSteps(numStep, tShift) {
  const steps = [];
  const intervals = numStep + 1;
  for (let index = 0; index <= intervals; index += 1) {
    const linear = index / intervals;
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

function choosePredictions({ logits, codebooks, sequenceLength, vocabularySize, targetLength, targetOffset, guidanceScale, layerPenalty }) {
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

      let bestToken = 0;
      let bestScore = -Infinity;
      for (let token = 0; token < vocabularySize - 1; token += 1) {
        const score = (1 + guidanceScale) * conditional[token] - guidanceScale * unconditional[token];
        guided[token] = score;
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

function unmaskBest({ scores, predictions, tokens, maskId, count }) {
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === BigInt(maskId)) {
      candidates.push(index);
    }
  }
  candidates.sort((left, right) => scores[right] - scores[left]);
  const chosen = candidates.slice(0, count);
  for (const index of chosen) {
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
  const styleText = `<|denoise|><|lang_start|>${language}<|lang_end|><|instruct_start|>${instruction}<|instruct_end|>`;
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
  isCancelled = () => false,
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  onStep = () => {},
}) {
  const { inputIds, audioMask, codebooks, sequenceLength, targetLength, targetOffset } = inputs;
  const maskId = config.audio_mask_id;
  const vocabularySize = config.audio_vocab_size;
  const batchIds = new BigInt64Array(2 * codebooks * sequenceLength).fill(BigInt(maskId));
  const batchMask = new Uint8Array(2 * sequenceLength);
  const attentionMask = new BigInt64Array(2 * sequenceLength);
  attentionMask.fill(1n, 0, sequenceLength);
  attentionMask.fill(1n, sequenceLength, sequenceLength + targetLength);

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
        : Math.max(1, Math.min(remaining, Math.ceil(totalMask * (steps[step + 1] - steps[step]))));

    const logits = await runBackboneStep({
      inputIds: batchIds,
      audioMask: batchMask,
      attentionMask,
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
    });
    const changed = unmaskBest({ scores, predictions, tokens, maskId, count: scheduled });
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
