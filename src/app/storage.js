const DB_NAME = "typed-voice-app";
const DB_VERSION = 2;

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

function defaultStatisticsRecord(key, scope, metadata = {}) {
  return {
    key,
    scope,
    ...metadata,
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

function defaultGlobalStatistics() {
  return defaultStatisticsRecord("global", "global");
}

function upgradeDatabase(db, transaction, oldVersion) {
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
    const statistics = db.createObjectStore(STORE_STATISTICS, { keyPath: "key" });
    statistics.createIndex("scope", "scope");
    statistics.createIndex("sessionId", "sessionId");
    statistics.createIndex("day", "day");
  } else if (oldVersion < 2) {
    const statistics = transaction.objectStore(STORE_STATISTICS);
    if (!statistics.indexNames.contains("scope")) statistics.createIndex("scope", "scope");
    if (!statistics.indexNames.contains("sessionId")) statistics.createIndex("sessionId", "sessionId");
    if (!statistics.indexNames.contains("day")) statistics.createIndex("day", "day");
  }
  if (oldVersion < 2 && db.objectStoreNames.contains(STORE_ASSETS)) {
    db.deleteObjectStore(STORE_ASSETS);
  }
  if (!db.objectStoreNames.contains(STORE_ASSETS)) {
    const assets = db.createObjectStore(STORE_ASSETS, { keyPath: "key" });
    assets.createIndex("assetId", "assetId");
    assets.createIndex("manifestId", "manifestId");
  }
}

export async function openConversationDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw new Error("IndexedDB is unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => upgradeDatabase(request.result, request.transaction, event.oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbConversationRepository {
  constructor(db) {
    this.db = db;
  }

  async createSession({ id = uuid(), createdAt = Date.now(), firstMessagePreview = "" } = {}) {
    const existing = await this.getSession(id);
    if (existing) return existing;
    const session = {
      id,
      createdAt,
      updatedAt: createdAt,
      firstMessagePreview: String(firstMessagePreview || "").trim().slice(0, 80),
      messageCount: 0,
    };
    const transaction = this.db.transaction(STORE_SESSIONS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_SESSIONS).add(session);
    try {
      await done;
    } catch (error) {
      if (error?.name === "ConstraintError" || transaction.error?.name === "ConstraintError") {
        const raced = await this.getSession(id);
        if (raced) return raced;
      }
      throw error;
    }
    await updateStatistics(this.db, {
      conversationCount: 1,
      timestamp: createdAt,
      sessionId: id,
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
      timestamp: playedAt ?? pending.createdAt,
      sessionId: pending.sessionId,
    });
    return message;
  }

  async recordInputStatistics({ typedChars = 0, deletedChars = 0, typingMs = 0, timestamp = Date.now(), sessionId = null }) {
    await updateStatistics(this.db, { typedChars, deletedChars, typingMs, timestamp, sessionId });
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
  const day = dateKey(delta.timestamp);
  const dayKey = `day:${day}`;
  const sessionKey = delta.sessionId ? `session:${delta.sessionId}` : null;
  const [globalStatistics, existingDayStatistics, existingSessionStatistics] = await Promise.all([
    requestValue(store.get("global")),
    requestValue(store.get(dayKey)),
    sessionKey ? requestValue(store.get(sessionKey)) : Promise.resolve(null),
  ]);
  const globalRecord = globalStatistics ?? defaultGlobalStatistics();
  globalRecord.key = "global";
  globalRecord.scope = "global";
  const dayRecord = existingDayStatistics ?? defaultStatisticsRecord(dayKey, "day", { day });
  const sessionRecord = sessionKey
    ? existingSessionStatistics ?? defaultStatisticsRecord(sessionKey, "session", { sessionId: delta.sessionId })
    : null;
  const sessionWasActiveToday = sessionRecord?.lastActiveDay === day;
  const records = [globalRecord, dayRecord, ...(sessionRecord ? [sessionRecord] : [])];
  for (const record of records) {
    for (const field of ["conversationCount", "messageCount", "typedChars", "deletedChars", "typingMs", "playbackMs"]) {
      record[field] += Number(delta[field] || 0);
    }
    record.lastActiveDay = day;
  }
  if (!existingDayStatistics) {
    globalRecord.activeDays += 1;
  }
  dayRecord.activeDays = 1;
  if (sessionRecord && !sessionWasActiveToday) sessionRecord.activeDays += 1;
  for (const record of records) store.put(record);
  await done;
}

export class MemoryConversationRepository {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.pending = new Map();
    this.settings = new Map();
    this.statistics = new Map([["global", defaultGlobalStatistics()]]);
  }

  async createSession({ id = uuid(), createdAt = Date.now(), firstMessagePreview = "" } = {}) {
    if (this.sessions.has(id)) return clone(this.sessions.get(id));
    const session = {
      id,
      createdAt,
      updatedAt: createdAt,
      firstMessagePreview: String(firstMessagePreview || "").trim().slice(0, 80),
      messageCount: 0,
    };
    this.sessions.set(id, session);
    this.#updateStats({ conversationCount: 1, timestamp: createdAt, sessionId: id });
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
    this.#updateStats({
      messageCount: 1,
      playbackMs: durationMs,
      timestamp: playedAt ?? pending.createdAt,
      sessionId: pending.sessionId,
    });
    return clone(message);
  }

  async recordInputStatistics(delta) {
    this.#updateStats(delta);
  }

  async getStatistics() {
    return clone(this.statistics.get("global") ?? defaultGlobalStatistics());
  }

  async getSetting(key, fallback = null) {
    return this.settings.has(key) ? clone(this.settings.get(key)) : fallback;
  }

  async setSetting(key, value) {
    this.settings.set(key, clone(value));
    return value;
  }

  #updateStats(delta) {
    const day = dateKey(delta.timestamp);
    const dayKey = `day:${day}`;
    const sessionKey = delta.sessionId ? `session:${delta.sessionId}` : null;
    const globalRecord = this.statistics.get("global") ?? defaultGlobalStatistics();
    const existingDay = this.statistics.get(dayKey);
    const dayRecord = existingDay ?? defaultStatisticsRecord(dayKey, "day", { day });
    const sessionRecord = sessionKey
      ? this.statistics.get(sessionKey) ?? defaultStatisticsRecord(sessionKey, "session", { sessionId: delta.sessionId })
      : null;
    const sessionWasActiveToday = sessionRecord?.lastActiveDay === day;
    const records = [globalRecord, dayRecord, ...(sessionRecord ? [sessionRecord] : [])];
    for (const record of records) {
      for (const field of ["conversationCount", "messageCount", "typedChars", "deletedChars", "typingMs", "playbackMs"]) {
        record[field] += Number(delta[field] || 0);
      }
      record.lastActiveDay = day;
    }
    if (!existingDay) globalRecord.activeDays += 1;
    dayRecord.activeDays = 1;
    if (sessionRecord && !sessionWasActiveToday) sessionRecord.activeDays += 1;
    for (const record of records) this.statistics.set(record.key, record);
  }
}
