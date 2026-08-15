import test from "node:test";
import assert from "node:assert/strict";
import { LatestRequestQueue } from "../src/engine/latest-queue.js";

test("同じutteranceの古いgenerationを待機列から置換する", () => {
  const queue = new LatestRequestQueue(2);
  queue.enqueue({ utteranceId: "a", generation: 1 });
  const result = queue.enqueue({ utteranceId: "a", generation: 2 });
  assert.deepEqual(result.replaced.map((item) => item.generation), [1]);
  assert.equal(queue.shift().generation, 2);
});

test("待機列は有限で古い要求を落とす", () => {
  const queue = new LatestRequestQueue(2);
  queue.enqueue({ utteranceId: "a", generation: 1 });
  queue.enqueue({ utteranceId: "b", generation: 1 });
  const result = queue.enqueue({ utteranceId: "c", generation: 1 });
  assert.deepEqual(result.dropped.map((item) => item.utteranceId), ["a"]);
  assert.equal(queue.length, 2);
});

test("cancel/revisionで古いgenerationだけ除去する", () => {
  const queue = new LatestRequestQueue(3);
  queue.enqueue({ utteranceId: "a", generation: 1 });
  queue.enqueue({ utteranceId: "b", generation: 1 });
  const removed = queue.removeOlder("a", 2);
  assert.equal(removed.length, 1);
  assert.equal(queue.shift().utteranceId, "b");
});