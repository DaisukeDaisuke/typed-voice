export class NoVoiceRuntime {
  constructor() {
    this.ready = false;
    this.prepared = false;
    this.activeProfile = null;
    this.audioEnabled = false;
  }

  subscribeProgress() {
    return () => {};
  }

  setSpeed() {}

  setReplayAfterLoad() {
    return false;
  }

  async isProfilePrepared() {
    return false;
  }

  async getProfilePlan() {
    throw new Error("クライアントモードでは、この端末の音声モデルを使用しません。");
  }

  async prepare() {
    throw new Error("クライアントモードでは、この端末の音声モデルを使用しません。");
  }

  async initializePrepared() {
    throw new Error("クライアントモードでは、この端末の音声モデルを使用しません。");
  }

  async unlockAudio() {
    return false;
  }

  async synthesize() {
    return { skipped: true, durationMs: 0 };
  }

  async cancel() {}

  async play() {
    return { durationMs: 0 };
  }
}
