import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConversationRepository } from "../src/app/storage.js";

test("統計はglobal・day・sessionへ正規化して更新する", async () => {
  const repository = new MemoryConversationRepository();
  const firstDay = Date.UTC(2026, 7, 17, 1, 0, 0);
  const secondDay = Date.UTC(2026, 7, 18, 1, 0, 0);
  const session = await repository.createSession({ id: "session-1", createdAt: firstDay });

  await repository.recordInputStatistics({
    sessionId: session.id,
    typedChars: 12,
    deletedChars: 2,
    typingMs: 500,
    timestamp: firstDay + 1_000,
  });
  const pending = {
    id: "message-1",
    sessionId: session.id,
    generation: 1,
    text: "hello",
    createdAt: firstDay + 2_000,
    reasoningDeadline: firstDay + 3_000,
    state: "reasoning",
    error: null,
  };
  await repository.savePending(pending);
  await repository.commitPending(pending, { playedAt: firstDay + 4_000, durationMs: 800 });
  await repository.recordInputStatistics({
    sessionId: session.id,
    typedChars: 3,
    timestamp: secondDay,
  });

  const global = await repository.getStatistics();
  const day1 = repository.statistics.get("day:2026-08-17");
  const day2 = repository.statistics.get("day:2026-08-18");
  const sessionStatistics = repository.statistics.get("session:session-1");

  assert.equal(global.scope, "global");
  assert.equal(global.conversationCount, 1);
  assert.equal(global.messageCount, 1);
  assert.equal(global.typedChars, 15);
  assert.equal(global.activeDays, 2);
  assert.equal(day1.scope, "day");
  assert.equal(day1.conversationCount, 1);
  assert.equal(day1.messageCount, 1);
  assert.equal(day1.typedChars, 12);
  assert.equal(day2.typedChars, 3);
  assert.equal(sessionStatistics.scope, "session");
  assert.equal(sessionStatistics.sessionId, "session-1");
  assert.equal(sessionStatistics.messageCount, 1);
  assert.equal(sessionStatistics.typedChars, 15);
  assert.equal(sessionStatistics.activeDays, 2);
});
