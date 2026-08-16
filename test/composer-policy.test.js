import test from "node:test";
import assert from "node:assert/strict";
import {
  countComposerLines,
  getCompletedLineFromLineBreak,
  getComposerLineAtCaret,
  retainRecentSubmittedLines,
} from "../src/app/composer-policy.js";

test("改行挿入後は直前の行を即座に発話candidateとして取り出せる", () => {
  assert.equal(countComposerLines("一行"), 1);
  assert.equal(getCompletedLineFromLineBreak("一行目\n", 4), "一行目");
  assert.equal(getCompletedLineFromLineBreak("一行目\n二行目\n", 8), "二行目");
});

test("入力欄は直近2件の提出済み行と現在行だけを保持する", () => {
  const retained = retainRecentSubmittedLines("一行目\n二行目\n三行目\n", 12, 2);
  assert.equal(retained.value, "二行目\n三行目\n");
  assert.equal(retained.caret, retained.value.length);
});

test("カーソルを置いた任意行を訂正対象として取り出せる", () => {
  const text = "税関関税許可局\nWebAssemblyをLLMでVibe Coding中\n";
  assert.equal(getComposerLineAtCaret(text, 3), "税関関税許可局");
  const secondStart = text.indexOf("WebAssembly") + 5;
  assert.equal(getComposerLineAtCaret(text, secondStart), "WebAssemblyをLLMでVibe Coding中");
});
