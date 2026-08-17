export async function resolveCurrentConversation(repository, currentSession = null) {
  if (!repository) throw new Error("Conversation repository is unavailable.");
  if (currentSession?.id) {
    const persisted = await repository.getSession(currentSession.id);
    if (persisted) return persisted;
  }
  return repository.createSession();
}

export async function createConversationFromSubmittedText(repository, text) {
  if (!repository) throw new Error("Conversation repository is unavailable.");
  const firstMessagePreview = String(text || "").trim().slice(0, 80);
  if (!firstMessagePreview) throw new Error("読み上げる文章を入力してください。");
  return repository.createSession({ firstMessagePreview });
}
