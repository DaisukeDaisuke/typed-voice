const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeConversationId(value) {
  const id = String(value || "").trim();
  return UUID_PATTERN.test(id) ? id : null;
}

export function selectBootstrapConversationId({
  requestedId = null,
  reloadId = null,
  navigationType = "navigate",
  createId = () => crypto.randomUUID(),
} = {}) {
  const requested = normalizeConversationId(requestedId);
  if (requested) return requested;
  const reload = normalizeConversationId(reloadId);
  if (navigationType === "reload" && reload) return reload;
  return createId();
}

export async function resolveCurrentConversation(repository, currentSession = null, { preferredId = null } = {}) {
  if (!repository) throw new Error("Conversation repository is unavailable.");
  if (currentSession?.id) {
    const persisted = await repository.getSession(currentSession.id);
    if (persisted) return persisted;
  }
  const id = normalizeConversationId(preferredId);
  return repository.createSession(id ? { id } : undefined);
}

export async function createConversationFromSubmittedText(repository, text) {
  if (!repository) throw new Error("Conversation repository is unavailable.");
  const firstMessagePreview = String(text || "").trim().slice(0, 80);
  if (!firstMessagePreview) throw new Error("読み上げる文章を入力してください。");
  return repository.createSession({ firstMessagePreview });
}
