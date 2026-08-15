import test from "node:test";
import assert from "node:assert/strict";
import { generateOmniVoiceCodes, prepareOmniVoiceInputs } from "../src/engine/omnivoice-generation.js";

function fakeTokenizer(text) {
  const length = Math.max(1, Math.min(3, text.length));
  return Promise.resolve({ input_ids: { data: Int32Array.from({ length }, (_, index) => index + 1) } });
}

const config = {
  num_audio_codebook: 2,
  audio_mask_id: 4,
  audio_vocab_size: 5,
};

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

test("iterative unmaskingは最終stepまでに全codebookのMASKを解消する", async () => {
  const inputs = await prepareOmniVoiceInputs("こんにちは", fakeTokenizer, config, { targetTokens: 3 });
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
  const inputs = await prepareOmniVoiceInputs("編集中", fakeTokenizer, config, { targetTokens: 4 });
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
