import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConversationRepository } from "../src/app/storage.js";
import { resolveCurrentConversation } from "../src/app/ui-orchestrator.js";

test("現在の会話がなければ即座に新しい会話を作る", async () => {
  const repository = new MemoryConversationRepository();
  const session = await resolveCurrentConversation(repository, null);
  const sessions = await repository.listSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, session.id);
  assert.equal(session.messageCount, 0);
  assert.equal(session.firstMessagePreview, "");
});

test("現在の会話が保存済みなら新しい会話を増やさない", async () => {
  const repository = new MemoryConversationRepository();
  const existing = await repository.createSession({ id: "existing-session", createdAt: 1_000 });
  const resolved = await resolveCurrentConversation(repository, existing);

  assert.equal(resolved.id, existing.id);
  assert.equal((await repository.listSessions()).length, 1);
});

test("現在の会話が消えていたら新しい会話へ復旧する", async () => {
  const repository = new MemoryConversationRepository();
  const stale = {
    id: "missing-session",
    createdAt: 1_000,
    updatedAt: 1_000,
    firstMessagePreview: "",
    messageCount: 0,
  };
  const resolved = await resolveCurrentConversation(repository, stale);

  assert.notEqual(resolved.id, stale.id);
  assert.equal((await repository.listSessions()).length, 1);
});
