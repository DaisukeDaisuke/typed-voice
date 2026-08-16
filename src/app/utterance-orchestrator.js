function defaultWaitUntil(deadline) {
  const delay = Math.max(0, deadline - Date.now());
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function now() {
  return Date.now();
}

function uuid() {
  return crypto.randomUUID();
}

export class UtteranceOrchestrator {
  constructor({
    repository,
    speech = null,
    playback = null,
    waitUntil = defaultWaitUntil,
    nowFn = now,
    onChange = () => {},
    maxRevisionable = 2,
  }) {
    this.repository = repository;
    this.speech = speech;
    this.playback = playback;
    this.waitUntil = waitUntil;
    this.now = nowFn;
    this.onChange = onChange;
    this.maxRevisionable = maxRevisionable;
    this.jobs = new Map();
    this.reasoningSignals = new Map();
  }

  async submit({ sessionId, text, reasoningSeconds }) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("読み上げる文章を入力してください。");
    const createdAt = this.now();
    const pending = {
      id: uuid(),
      sessionId,
      generation: 1,
      text: trimmed,
      createdAt,
      reasoningDeadline: createdAt + Math.max(0, Number(reasoningSeconds) || 0) * 1000,
      state: "reasoning",
      error: null,
    };
    await this.repository.savePending(pending);
    this.jobs.set(pending.id, pending);
    this.onChange({ type: "pending-added", pending: structuredClone(pending) });
    void this.#runGeneration(pending.id, pending.generation);
    return structuredClone(pending);
  }

  async resume(pending) {
    if (this.jobs.has(pending.id)) return;
    this.jobs.set(pending.id, structuredClone(pending));
    if (pending.state === "editing") return;
    void this.#runGeneration(pending.id, pending.generation);
  }

  async beginEdit(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("訂正対象の読み上げ待ちが見つかりません。");
    if (!this.isRevisionable(id)) throw new Error("訂正できるのは直近2件の読み上げ待ちです。");
    const previousGeneration = job.generation;
    job.generation += 1;
    job.state = "editing";
    job.error = null;
    this.#releaseReasoningSignal(job.id, previousGeneration);
    await this.speech?.cancel?.(job.id, previousGeneration);
    await this.repository.savePending(job);
    this.onChange({ type: "pending-edit-started", pending: structuredClone(job) });
    return structuredClone(job);
  }

  async edit(id, text, reasoningSeconds) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("修正対象の読み上げ待ちが見つかりません。");
    if (!this.isRevisionable(id)) throw new Error("修正できるのは直近2件の読み上げ待ちです。");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("空の文章には修正できません。");
    if (job.state !== "editing") {
      const previousGeneration = job.generation;
      await this.speech?.cancel?.(job.id, previousGeneration);
      job.generation += 1;
    }
    job.text = trimmed;
    job.reasoningDeadline = this.now() + Math.max(0, Number(reasoningSeconds) || 0) * 1000;
    job.state = "reasoning";
    job.error = null;
    await this.repository.savePending(job);
    this.onChange({ type: "pending-edited", pending: structuredClone(job) });
    void this.#runGeneration(id, job.generation);
    return structuredClone(job);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    const generation = job.generation;
    job.generation += 1;
    this.#releaseReasoningSignal(job.id, generation);
    await this.speech?.cancel?.(job.id, generation);
    this.jobs.delete(id);
    await this.repository.deletePending(id);
    this.onChange({ type: "pending-cancelled", id });
    return true;
  }

  isRevisionable(id) {
    const newest = [...this.jobs.values()]
      .filter((job) => !["cancelled", "committed"].includes(job.state))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, this.maxRevisionable)
      .map((job) => job.id);
    return newest.includes(id);
  }

  async forceReady(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("読み上げ待ちが見つかりません。");
    if (job.state === "editing") throw new Error("訂正中の文章は先に訂正を反映してください。");
    job.reasoningDeadline = this.now();
    await this.repository.savePending(job);
    this.#releaseReasoningSignal(job.id, job.generation);
    this.onChange({ type: "pending-forced", pending: structuredClone(job) });
  }

  async #runGeneration(id, generation) {
    const job = this.jobs.get(id);
    if (!job || job.generation !== generation) return;
    const reasoning = this.#waitForReasoning(job, generation);
    let synthesized = { skipped: true, durationMs: 0 };
    try {
      synthesized = this.speech
        ? await Promise.resolve(this.speech.synthesize({
            utteranceId: job.id,
            generation,
            text: job.text,
          }))
        : synthesized;
    } catch (error) {
      const current = this.jobs.get(id);
      if (!current || current.generation !== generation) return;
      current.state = "voice-error";
      current.error = error instanceof Error ? error.message : String(error);
      await this.repository.savePending(current);
      this.onChange({ type: "pending-error", pending: structuredClone(current) });
      return;
    }

    await reasoning;
    const current = this.jobs.get(id);
    if (!current || current.generation !== generation) return;

    current.state = "ready";
    current.error = null;
    await this.repository.savePending(current);
    this.onChange({ type: "pending-ready", pending: structuredClone(current) });

    let playedAt = null;
    let durationMs = Number(synthesized?.durationMs || 0);
    if (!synthesized?.skipped && this.playback) {
      const playbackResult = await this.playback.play({
        utteranceId: current.id,
        generation,
        ...synthesized,
      });
      const afterPlayback = this.jobs.get(id);
      if (!afterPlayback || afterPlayback.generation !== generation) return;
      playedAt = this.now();
      durationMs = Number(playbackResult?.durationMs ?? durationMs ?? 0);
    }

    const latest = this.jobs.get(id);
    if (!latest || latest.generation !== generation) return;
    const message = await this.repository.commitPending(latest, { playedAt, durationMs });
    latest.state = "committed";
    this.jobs.delete(id);
    this.onChange({ type: "message-committed", message });
  }

  #waitForReasoning(job, generation) {
    const key = `${job.id}:${generation}`;
    let release;
    const forced = new Promise((resolve) => {
      release = resolve;
    });
    this.reasoningSignals.set(key, release);
    return Promise.race([this.waitUntil(job.reasoningDeadline), forced]).finally(() => {
      if (this.reasoningSignals.get(key) === release) this.reasoningSignals.delete(key);
    });
  }

  #releaseReasoningSignal(id, generation) {
    this.reasoningSignals.get(`${id}:${generation}`)?.();
  }
}
