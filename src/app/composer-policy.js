export function countComposerLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n").length;
}

export function getComposerLineAtCaret(text, caret) {
  const value = String(text).replace(/\r\n?/g, "\n");
  const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
  const start = value.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const nextBreak = value.indexOf("\n", position);
  const end = nextBreak === -1 ? value.length : nextBreak;
  return value.slice(start, end);
}

export function getCompletedLineFromLineBreak(text, caret) {
  const value = String(text).replace(/\r\n?/g, "\n");
  const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
  if (position === 0 || value[position - 1] !== "\n") return "";
  const previousBreak = value.lastIndexOf("\n", position - 2);
  return value.slice(previousBreak + 1, position - 1);
}

export function retainRecentSubmittedLines(text, caret, maxSubmittedLines = 2) {
  const value = String(text).replace(/\r\n?/g, "\n");
  const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
  if (position === 0 || value[position - 1] !== "\n") return { value, caret: position };
  const prefix = value.slice(0, position - 1);
  const completedLines = prefix.split("\n");
  if (completedLines.length <= maxSubmittedLines) return { value, caret: position };
  const retained = completedLines.slice(-maxSubmittedLines).join("\n");
  const suffix = value.slice(position);
  const nextValue = `${retained}\n${suffix}`;
  return { value: nextValue, caret: retained.length + 1 };
}
