import { clearAllApplicationData } from "./application-backup.js";
import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";

export const TUTORIAL_STORAGE_KEY = "typed-voice-tutorial-v1-complete";
export const TUTORIAL_DATABASE_KEY = "tutorialCompleteV1";
export const TUTORIAL_CONVERSATION_PRACTICE_COUNT_KEY = "typed-voice-tutorial-conversation-practice-count-v1";

export function readConversationPracticeCount(storage = globalThis.localStorage) {
  try {
    const value = Number.parseInt(storage?.getItem(TUTORIAL_CONVERSATION_PRACTICE_COUNT_KEY) ?? "0", 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function recordConversationPractice(storage = globalThis.localStorage) {
  const next = readConversationPracticeCount(storage) + 1;
  try {
    storage?.setItem(TUTORIAL_CONVERSATION_PRACTICE_COUNT_KEY, String(next));
  } catch {
    return next;
  }
  return next;
}

function localComplete(storage) {
  try {
    return storage?.getItem(TUTORIAL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export async function reconcileTutorialPersistence({
  storage = globalThis.localStorage,
  indexedDBImpl = globalThis.indexedDB,
} = {}) {
  const db = await openConversationDatabase(indexedDBImpl);
  try {
    const repository = new IndexedDbConversationRepository(db);
    const local = localComplete(storage);
    const database = await repository.getSetting(TUTORIAL_DATABASE_KEY, null) === "1";
    const complete = local && database;
    const corrupted = local !== database;
    if (!complete) {
      await clearAllApplicationData({ db, storage });
    }
    return { complete, corrupted };
  } finally {
    db.close?.();
  }
}

export async function markTutorialComplete(repository, storage = globalThis.localStorage) {
  if (!repository) throw new Error("Conversation repository is unavailable.");
  await repository.setSetting(TUTORIAL_DATABASE_KEY, "1");
  storage?.setItem(TUTORIAL_STORAGE_KEY, "1");
  const local = localComplete(storage);
  const database = await repository.getSetting(TUTORIAL_DATABASE_KEY, null) === "1";
  if (!local || !database) throw new Error("チュートリアル完了状態を保存できませんでした。");
  return true;
}
