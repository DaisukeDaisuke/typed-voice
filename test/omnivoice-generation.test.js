import test from "node:test";
import assert from "node:assert/strict";
import { buildOmniVoiceAttentionMask, createPythonRandom, generateOmniVoiceCodes, prepareOmniVoiceInputs } from "../src/engine/omnivoice-generation.js";

function fakeTokenizer(onEncode = () => {}) {
  return {
    encode(text) {
      onEncode(text);
      const length = Math.max(1, Math.min(3, text.length));
      return { ids: Array.from({ length }, (_, index) => index + 1) };
    },
  };
}

const config = {
  num_audio_codebook: 2,
  audio_mask_id: 4,
  audio_vocab_size: 5,
};

test("Python random.Random互換seedはCPythonと同じ乱数列を返す", () => {
  const random = createPythonRandom(2026081601);
  const actual = Array.from({ length: 5 }, () => random());
  assert.deepEqual(actual, [
    0.9714470635171725,
    0.7426057000486872,
    0.10110613689366998,
    0.6191827105927913,
    0.4595064024223846,
  ]);
});

function deterministicBackbone({ batch, codebooks, sequenceLength }) {
  const vocabulary = config.audio_vocab_size;
  const logits = new Float32Array(batch * codebooks * sequenceLength * vocabulary).fill(-20);
  for (let b = 0; b < batch; b += 1) {
    for (let c = 0; c < codebooks; c += 1) {
      for (let s = 0; s < sequenceLength; s += 1) {
        const token = (c + s) % (vocabulary - 1);
        const offset = (((b * codebooks + c) * sequenceLength + s) * vocabulary);
        logits[offset + token] = 12 - s;
        logits[offset + config.audio_mask_id] = -40;
      }
    }
  }
  return Promise.resolve(logits);
}

test("OmniVoice noncausal attentionはconditionalを全結合しunconditional paddingを対角だけ残す", () => {
  const attention = buildOmniVoiceAttentionMask({ sequenceLength: 5, targetLength: 2, mode: "omnivoice-noncausal" });
  assert.equal(attention.type, "bool");
  assert.deepEqual(attention.shape, [2, 1, 5, 5]);
  assert.deepEqual(Array.from(attention.data.slice(0, 25)), new Array(25).fill(1));
  assert.deepEqual(
    Array.from(attention.data.slice(25)),
    [
      1, 1, 0, 0, 0,
      1, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
      0, 0, 0, 0, 1,
    ]
  );
});

test("legacy ONNXは従来の2D int64 attention contractを維持する", () => {
  const attention = buildOmniVoiceAttentionMask({ sequenceLength: 5, targetLength: 2 });
  assert.equal(attention.type, "int64");
  assert.deepEqual(attention.shape, [2, 5]);
  assert.deepEqual(Array.from(attention.data), [1n, 1n, 1n, 1n, 1n, 1n, 1n, 0n, 0n, 0n]);
});

test("iterative unmaskingは最終stepまでに全codebookのMASKを解消する", async () => {
  const inputs = await prepareOmniVoiceInputs("こんにちは", fakeTokenizer(), config, { targetTokens: 3 });
  const steps = [];
  const result = await generateOmniVoiceCodes({
    inputs,
    config,
    runBackboneStep: deterministicBackbone,
    numStep: 3,
    guidanceScale: 0,
    tShift: 1,
    layerPenalty: 0,
    yieldControl: async () => {},
    onStep: (step) => steps.push(step),
  });
  assert.equal(result.tokens.length, 6);
  assert.equal(Array.from(result.tokens).includes(4n), false);
  assert.equal(steps.at(-1).remaining, 0);
});

test("generation変更は次のunmask stepへ進む前に実行中生成を中断する", async () => {
  const inputs = await prepareOmniVoiceInputs("編集中", fakeTokenizer(), config, { targetTokens: 4 });
  let cancelled = false;
  let backboneCalls = 0;
  await assert.rejects(
    () => generateOmniVoiceCodes({
      inputs,
      config,
      runBackboneStep: async (args) => {
        backboneCalls += 1;
        return deterministicBackbone(args);
      },
      numStep: 4,
      guidanceScale: 0,
      tShift: 1,
      layerPenalty: 0,
      yieldControl: async () => {},
      isCancelled: () => cancelled,
      onStep: ({ step }) => {
        if (step === 1) cancelled = true;
      },
    }),
    /cancelled/
  );
  assert.equal(backboneCalls, 1);
});

test("reference audioなしのauto voice入力ではdenoise tokenを付けない", async () => {
  const encoded = [];
  await prepareOmniVoiceInputs("こんにちは", fakeTokenizer((text) => encoded.push(text)), { ...config, denoise: true }, { targetTokens: 2, language: "ja" });
  assert.equal(encoded.length, 2);
  assert.equal(encoded[0], "<|lang_start|>ja<|lang_end|><|instruct_start|>None<|instruct_end|>");
});

test("未実装のclass temperature samplingを黙ってgreedyへ落とさない", async () => {
  const inputs = await prepareOmniVoiceInputs("温度", fakeTokenizer(), config, { targetTokens: 2 });
  await assert.rejects(
    () => generateOmniVoiceCodes({ inputs, config, runBackboneStep: deterministicBackbone, classTemperature: 0.5 }),
    /classTemperature=0/
  );
});
