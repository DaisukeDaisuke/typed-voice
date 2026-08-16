const DB_NAME = "typed-voice-app";
const DB_VERSION = 1;

const STORE_SESSIONS = "sessions";
const STORE_MESSAGES = "messages";
const STORE_PENDING = "pendingUtterances";
const STORE_SETTINGS = "settings";
const STORE_STATISTICS = "statistics";
const STORE_ASSETS = "assets";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function uuid() {
  return crypto.randomUUID();
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function dateKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function defaultGlobalStatistics() {
  return {
    key: "global",
    conversationCount: 0,
    messageCount: 0,
    typedChars: 0,
    deletedChars: 0,
    typingMs: 0,
    playbackMs: 0,
    activeDays: 0,
    lastActiveDay: null,
  };
}

function upgradeDatabase(db) {
  if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
    const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
    sessions.createIndex("updatedAt", "updatedAt");
  }
  if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
    const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
    messages.createIndex("sessionSequence", ["sessionId", "sequence"], { unique: true });
    messages.createIndex("sessionCreatedAt", ["sessionId", "createdAt"]);
  }
  if (!db.objectStoreNames.contains(STORE_PENDING)) {
    const pending = db.createObjectStore(STORE_PENDING, { keyPath: "id" });
    pending.createIndex("sessionCreatedAt", ["sessionId", "createdAt"]);
  }
  if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
    db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains(STORE_STATISTICS)) {
    db.createObjectStore(STORE_STATISTICS, { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains(STORE_ASSETS)) {
    db.createObjectStore(STORE_ASSETS, { keyPath: "assetId" });
  }
}

export async function openConversationDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw new Error("IndexedDB is unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgradeDatabase(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbConversationRepository {
  constructor(db) {
    this.db = db;
  }

  async createSession({ id = uuid(), createdAt = Date.now() } = {}) {
    const existing = await this.getSession(id);
    if (existing) return existing;
    const session = {
      id,
      createdAt,
      updatedAt: createdAt,
      firstMessagePreview: "",
      messageCount: 0,
    };
    const transaction = this.db.transaction(STORE_SESSIONS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_SESSIONS).add(session);
    await done;
    await updateStatistics(this.db, {
      conversationCount: 1,
      timestamp: createdAt,
    });
    return session;
  }

  async getSession(id) {
    const transaction = this.db.transaction(STORE_SESSIONS, "readonly");
    const done = transactionDone(transaction);
    const result = await requestValue(transaction.objectStore(STORE_SESSIONS).get(id));
    await done;
    return result ?? null;
  }

  async listSessions(limit = 100) {
    const transaction = this.db.transaction(STORE_SESSIONS, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(STORE_SESSIONS).index("updatedAt");
    const sessions = [];
    await new Promise((resolve, reject) => {
      const request = index.openCursor(null, "prev");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || sessions.length >= limit) {
          resolve();
          return;
        }
        sessions.push(cursor.value);
        cursor.continue();
      };
    });
    await done;
    return sessions;
  }

  async listMessages(sessionId) {
    const transaction = this.db.transaction(STORE_MESSAGES, "readonly");
    const done = transactionDone(transaction);
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const results = await requestValue(
      transaction.objectStore(STORE_MESSAGES).index("sessionSequence").getAll(range)
    );
    await done;
    return results;
  }

  async listPending(sessionId) {
    const transaction = this.db.transaction(STORE_PENDING, "readonly");
    const done = transactionDone(transaction);
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const results = await requestValue(
      transaction.objectStore(STORE_PENDING).index("sessionCreatedAt").getAll(range)
    );
    await done;
    return results;
  }

  async savePending(record) {
    const transaction = this.db.transaction(STORE_PENDING, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_PENDING).put(clone(record));
    await done;
    return record;
  }

  async deletePending(id) {
    const transaction = this.db.transaction(STORE_PENDING, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_PENDING).delete(id);
    await done;
  }

  async commitPending(pending, { playedAt = null, durationMs = 0 } = {}) {
    const transaction = this.db.transaction(
      [STORE_SESSIONS, STORE_MESSAGES, STORE_PENDING],
      "readwrite"
    );
    const done = transactionDone(transaction);
    const sessions = transaction.objectStore(STORE_SESSIONS);
    const session = await requestValue(sessions.get(pending.sessionId));
    if (!session) {
      transaction.abort();
      throw new Error(`Conversation not found: ${pending.sessionId}`);
    }
    const sequence = session.messageCount + 1;
    const message = {
      id: pending.id,
      sessionId: pending.sessionId,
      sequence,
      text: pending.text,
      createdAt: pending.createdAt,
      playedAt,
      durationMs,
    };
    transaction.objectStore(STORE_MESSAGES).add(message);
    transaction.objectStore(STORE_PENDING).delete(pending.id);
    session.updatedAt = Date.now();
    session.messageCount = sequence;
    if (!session.firstMessagePreview) {
      session.firstMessagePreview = pending.text.trim().slice(0, 80);
    }
    sessions.put(session);
    await done;
    await updateStatistics(this.db, {
      messageCount: 1,
      playbackMs: durationMs,
      timestamp: session.updatedAt,
    });
    return message;
  }

  async recordInputStatistics({ typedChars = 0, deletedChars = 0, typingMs = 0, timestamp = Date.now() }) {
    await updateStatistics(this.db, { typedChars, deletedChars, typingMs, timestamp });
  }

  async getStatistics() {
    const transaction = this.db.transaction(STORE_STATISTICS, "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(transaction.objectStore(STORE_STATISTICS).get("global"));
    await done;
    return value ?? defaultGlobalStatistics();
  }

  async getSetting(key, fallback = null) {
    const transaction = this.db.transaction(STORE_SETTINGS, "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(transaction.objectStore(STORE_SETTINGS).get(key));
    await done;
    return value?.value ?? fallback;
  }

  async setSetting(key, value) {
    const record = { key, value, updatedAt: Date.now() };
    const transaction = this.db.transaction(STORE_SETTINGS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_SETTINGS).put(record);
    await done;
    return value;
  }
}

async function updateStatistics(db, delta) {
  const transaction = db.transaction(STORE_STATISTICS, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_STATISTICS);
  const statistics = (await requestValue(store.get("global"))) ?? defaultGlobalStatistics();
  for (const field of ["conversationCount", "messageCount", "typedChars", "deletedChars", "typingMs", "playbackMs"]) {
    statistics[field] += Number(delta[field] || 0);
  }
  const day = dateKey(delta.timestamp);
  if (statistics.lastActiveDay !== day) {
    statistics.activeDays += 1;
    statistics.lastActiveDay = day;
  }
  store.put(statistics);
  await done;
}

export class MemoryConversationRepository {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.pending = new Map();
    this.settings = new Map();
    this.statistics = defaultGlobalStatistics();
  }

  async createSession({ id = uuid(), createdAt = Date.now() } = {}) {
    if (this.sessions.has(id)) return clone(this.sessions.get(id));
    const session = { id, createdAt, updatedAt: createdAt, firstMessagePreview: "", messageCount: 0 };
    this.sessions.set(id, session);
    this.#updateStats({ conversationCount: 1, timestamp: createdAt });
    return clone(session);
  }

  async getSession(id) {
    return clone(this.sessions.get(id) ?? null);
  }

  async listSessions(limit = 100) {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(clone);
  }

  async listMessages(sessionId) {
    return [...this.messages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  async listPending(sessionId) {
    return [...this.pending.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  async savePending(record) {
    this.pending.set(record.id, clone(record));
    return clone(record);
  }

  async deletePending(id) {
    this.pending.delete(id);
  }

  async commitPending(pending, { playedAt = null, durationMs = 0 } = {}) {
    const session = this.sessions.get(pending.sessionId);
    if (!session) throw new Error(`Conversation not found: ${pending.sessionId}`);
    const sequence = session.messageCount + 1;
    const message = {
      id: pending.id,
      sessionId: pending.sessionId,
      sequence,
      text: pending.text,
      createdAt: pending.createdAt,
      playedAt,
      durationMs,
    };
    this.messages.set(message.id, message);
    this.pending.delete(pending.id);
    session.messageCount = sequence;
    session.updatedAt = Date.now();
    if (!session.firstMessagePreview) session.firstMessagePreview = pending.text.trim().slice(0, 80);
    this.#updateStats({ messageCount: 1, playbackMs: durationMs, timestamp: session.updatedAt });
    return clone(message);
  }

  async recordInputStatistics(delta) {
    this.#updateStats(delta);
  }

  async getStatistics() {
    return clone(this.statistics);
  }

  async getSetting(key, fallback = null) {
    return this.settings.has(key) ? clone(this.settings.get(key)) : fallback;
  }

  async setSetting(key, value) {
    this.settings.set(key, clone(value));
    return value;
  }

  #updateStats(delta) {
    for (const field of ["conversationCount", "messageCount", "typedChars", "deletedChars", "typingMs", "playbackMs"]) {
      this.statistics[field] += Number(delta[field] || 0);
    }
    const day = dateKey(delta.timestamp);
    if (this.statistics.lastActiveDay !== day) {
      this.statistics.activeDays += 1;
      this.statistics.lastActiveDay = day;
    }
  }
}
