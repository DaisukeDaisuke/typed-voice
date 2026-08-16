import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConversationRepository } from "../src/app/storage.js";
import { UtteranceOrchestrator } from "../src/app/utterance-orchestrator.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function createRepository() {
  const repository = new MemoryConversationRepository();
  const session = await repository.createSession({ id: "session-1", createdAt: 1_000 });
  return { repository, session };
}

test("reasoningと音声合成を並行開始し、両方が終わるまで正式messageにしない", async () => {
  const { repository, session } = await createRepository();
  const reasoning = deferred();
  const speechResult = deferred();
  const calls = [];
  const orchestrator = new UtteranceOrchestrator({
    repository,
    nowFn: () => 10_000,
    waitUntil(deadline) {
      calls.push(["reasoning", deadline]);
      return reasoning.promise;
    },
    speech: {
      synthesize(request) {
        calls.push(["speech", request.text]);
        return speechResult.promise;
      },
    },
    playback: {
      async play() {
        calls.push(["play"]);
        return { durationMs: 1200 };
      },
    },
  });

  await orchestrator.submit({ sessionId: session.id, text: "並行開始", reasoningSeconds: 2 });
  assert.deepEqual(calls.slice(0, 2), [["reasoning", 12_000], ["speech", "並行開始"]]);

  reasoning.resolve();
  await flush();
  assert.equal((await repository.listMessages(session.id)).length, 0);

  speechResult.resolve({ samples: new Float32Array([0]), sampleRate: 24_000, durationMs: 1000 });
  await flush();
  const messages = await repository.listMessages(session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "並行開始");
  assert.equal(messages[0].durationMs, 1200);
  assert.equal(calls.some(([name]) => name === "play"), true);
});

test("修正前generationの遅い合成結果は破棄し、修正版だけ確定する", async () => {
  const { repository, session } = await createRepository();
  const waits = [];
  const syntheses = [];
  const cancelled = [];
  const orchestrator = new UtteranceOrchestrator({
    repository,
    nowFn: () => 20_000,
    waitUntil() {
      const item = deferred();
      waits.push(item);
      return item.promise;
    },
    speech: {
      synthesize(request) {
        const item = deferred();
        syntheses.push({ request, ...item });
        return item.promise;
      },
      async cancel(id, generation) {
        cancelled.push([id, generation]);
      },
    },
  });

  const original = await orchestrator.submit({ sessionId: session.id, text: "古い文章", reasoningSeconds: 2 });
  await orchestrator.edit(original.id, "修正版", 2);
  assert.deepEqual(cancelled, [[original.id, 1]]);
  assert.equal(syntheses.length, 2);
  assert.equal(syntheses[1].request.generation, 2);

  waits[0].resolve();
  syntheses[0].resolve({ skipped: true });
  await flush();
  assert.equal((await repository.listMessages(session.id)).length, 0);

  waits[1].resolve();
  syntheses[1].resolve({ skipped: true });
  await flush();
  const messages = await repository.listMessages(session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "修正版");
});

test("取り消したpendingは古いreasoning/合成が完了しても復活しない", async () => {
  const { repository, session } = await createRepository();
  const reasoning = deferred();
  const synthesis = deferred();
  const orchestrator = new UtteranceOrchestrator({
    repository,
    waitUntil: () => reasoning.promise,
    speech: { synthesize: () => synthesis.promise, cancel: async () => {} },
  });

  const pending = await orchestrator.submit({ sessionId: session.id, text: "取り消す", reasoningSeconds: 2 });
  assert.equal(await orchestrator.cancel(pending.id), true);
  reasoning.resolve();
  synthesis.resolve({ skipped: true });
  await flush();
  assert.equal((await repository.listPending(session.id)).length, 0);
  assert.equal((await repository.listMessages(session.id)).length, 0);
});

test("修正可能なのは直近2件の読み上げ待ちだけ", async () => {
  const { repository, session } = await createRepository();
  const never = new Promise(() => {});
  let clock = 30_000;
  const orchestrator = new UtteranceOrchestrator({
    repository,
    nowFn: () => clock++,
    waitUntil: () => never,
  });

  const first = await orchestrator.submit({ sessionId: session.id, text: "1", reasoningSeconds: 5 });
  const second = await orchestrator.submit({ sessionId: session.id, text: "2", reasoningSeconds: 5 });
  const third = await orchestrator.submit({ sessionId: session.id, text: "3", reasoningSeconds: 5 });
  assert.equal(orchestrator.isRevisionable(first.id), false);
  assert.equal(orchestrator.isRevisionable(second.id), true);
  assert.equal(orchestrator.isRevisionable(third.id), true);
});

test("音声engine未接続でもreasoning後に会話UIの正式messageへ進める", async () => {
  const { repository, session } = await createRepository();
  const reasoning = deferred();
  const orchestrator = new UtteranceOrchestrator({
    repository,
    waitUntil: () => reasoning.promise,
  });

  await orchestrator.submit({ sessionId: session.id, text: "UI単体", reasoningSeconds: 2 });
  assert.equal((await repository.listPending(session.id)).length, 1);
  reasoning.resolve();
  await flush();
  const messages = await repository.listMessages(session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "UI単体");
});
