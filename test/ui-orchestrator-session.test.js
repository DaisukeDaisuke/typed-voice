import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConversationRepository } from "../src/app/storage.js";
import {
  createConversationFromSubmittedText,
  normalizeConversationId,
  resolveCurrentConversation,
  selectBootstrapConversationId,
} from "../src/app/conversation-session-policy.js";

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

test("初期化前に決めたUUIDをそのまま新しい会話IDとして使える", async () => {
  const repository = new MemoryConversationRepository();
  const preferredId = "123e4567-e89b-42d3-a456-426614174000";
  const session = await resolveCurrentConversation(repository, null, { preferredId });

  assert.equal(session.id, preferredId);
  assert.equal((await repository.listSessions()).length, 1);
});

test("会話IDとして不正なURL値はUUIDとして採用しない", () => {
  assert.equal(normalizeConversationId("not-a-uuid"), null);
  assert.equal(normalizeConversationId("123e4567-e89b-42d3-a456-426614174000"), "123e4567-e89b-42d3-a456-426614174000");
});

test("初回reloadでは直前に確保したUUIDを再利用する", () => {
  const reloadId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(selectBootstrapConversationId({
    reloadId,
    navigationType: "reload",
    createId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }), reloadId);
});

test("通常navigateではreload用UUIDを新規会話へ流用しない", () => {
  const created = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(selectBootstrapConversationId({
    reloadId: "123e4567-e89b-42d3-a456-426614174000",
    navigationType: "navigate",
    createId: () => created,
  }), created);
});

test("新しい会話の作成時に手元の1行目をプレビューへ即時保存できる", async () => {
  const repository = new MemoryConversationRepository();
  const session = await createConversationFromSubmittedText(repository, "  最初の読み上げ文章です  ");

  assert.equal(session.firstMessagePreview, "最初の読み上げ文章です");
  assert.equal(session.messageCount, 0);
  assert.equal((await repository.listMessages(session.id)).length, 0);
});
