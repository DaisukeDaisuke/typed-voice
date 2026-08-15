import * as ort from "onnxruntime-web/wasm";
import { PiperPlus } from "../../third_party/piper-plus/src/wasm/openjtalk-web/src/index.js";
import initPiperWasm, {
  WasmPhonemizer,
} from "../../third_party/piper-plus/src/wasm/openjtalk-web/dist/rust-wasm/piper_plus_wasm.js";
import { configureOrtWasm } from "./threading.js";

class DirectWasmPhonemizer {
  constructor(wasm) {
    this.wasm = wasm;
  }

  encode(text, language) {
    const result = this.wasm.phonemize(text, language);
    try {
      const phonemeIds = Array.from(result.phonemeIds);
      const flat = result.prosodyFeatures;
      const prosodyFeatures = [];
      if (flat?.length) {
        for (let index = 0; index < flat.length; index += 3) {
          prosodyFeatures.push([flat[index], flat[index + 1], flat[index + 2]]);
        }
      }
      return { phonemeIds, prosodyFeatures: prosodyFeatures.length > 0 ? prosodyFeatures : null };
    } finally {
      result.free();
    }
  }

  detectLanguage(text) {
    return this.wasm.detectLanguage(text);
  }

  dispose() {
    this.wasm.free();
  }
}

export class PiperEngine {
  constructor() {
    this.core = null;
    this.threadCount = 1;
    this.synthesisDefaults = Object.freeze({ language: "ja" });
  }

  async initialize({ modelData, config, preferredThreadCount = 0, wasmBaseUrl, synthesisDefaults = {} }) {
    if (!(modelData instanceof ArrayBuffer)) {
      throw new TypeError("modelData must be an ArrayBuffer");
    }
    if (!config || typeof config !== "object") {
      throw new TypeError("config must be an object");
    }

    this.dispose();
    this.synthesisDefaults = Object.freeze({ language: "ja", ...synthesisDefaults });
    this.threadCount = configureOrtWasm(ort, { preferredThreadCount, wasmBaseUrl });
    await initPiperWasm();

    const session = await ort.InferenceSession.create(new Uint8Array(modelData), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "extended",
      enableMemPattern: true,
    });
    const wasm = new WasmPhonemizer(JSON.stringify(config));
    const core = new PiperPlus();
    core._ort = ort;
    core._config = config;
    core._session = session;
    core._sessionManager = { currentProvider: "wasm" };
    core._phonemizer = new DirectWasmPhonemizer(wasm);
    core._hasSpeakerEmbedding = session.inputNames?.includes("speaker_embedding") ?? false;
    core._hasProsodyFeatures = session.inputNames?.includes("prosody_features") ?? false;
    core._initialized = true;
    this.core = core;
  }

  async synthesize(text, options = {}) {
    if (!this.core?.isInitialized) {
      throw new Error("Piper engine is not initialized");
    }
    const result = await this.core.synthesize(text, {
      ...this.synthesisDefaults,
      ...options,
    });
    return {
      samples: result.samples,
      sampleRate: result.sampleRate,
    };
  }

  dispose() {
    if (this.core) {
      this.core.dispose();
      this.core = null;
    }
  }
}