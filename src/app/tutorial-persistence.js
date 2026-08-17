import { clearAllApplicationData } from "./application-backup.js";
import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";

export const TUTORIAL_STORAGE_KEY = "typed-voice-tutorial-v1-complete";
export const TUTORIAL_DATABASE_KEY = "tutorialCompleteV1";

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
