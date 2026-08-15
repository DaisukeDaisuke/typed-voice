import * as ort from "onnxruntime-web/all";
import { Tokenizer } from "@huggingface/tokenizers";
import { buildVirtualAssetUrl } from "./asset-store.js";
import { configureOrtWasm } from "./threading.js";
import { generateOmniVoiceCodes, prepareOmniVoiceInputs } from "./omnivoice-generation.js";

function halfToFloat(value) {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function tensorToFloat32(tensor) {
  if (tensor.data instanceof Float32Array) return new Float32Array(tensor.data);
  if (tensor.type === "float16" && tensor.data instanceof Uint16Array) {
    return Float32Array.from(tensor.data, halfToFloat);
  }
  return Float32Array.from(tensor.data, Number);
}

function normalizePcm(input) {
  let start = 0;
  let end = input.length;
  const threshold = 0.0005;
  while (start < end && Math.abs(input[start]) < threshold) start += 1;
  while (end > start && Math.abs(input[end - 1]) < threshold) end -= 1;
  const pcm = input.slice(start, end);
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const scale = Math.min(0.95 / peak, 3);
    for (let index = 0; index < pcm.length; index += 1) pcm[index] *= scale;
  }
  return pcm;
}

function bigintRange(length, batch) {
  const result = new BigInt64Array(batch * length);
  for (let row = 0; row < batch; row += 1) {
    for (let index = 0; index < length; index += 1) result[row * length + index] = BigInt(index);
  }
  return result;
}

export class OmniVoiceEngine {
  constructor({ preferredThreadCount } = {}) {
    this.preferredThreadCount = preferredThreadCount;
    this.manifest = null;
    this.tokenizer = null;
    this.sessions = null;
    this.backend = null;
    this.runtime = null;
  }

  async initialize(manifest, { onStatus = () => {}, appBaseUrl = new URL("./", globalThis.location.href).href } = {}) {
    if (!manifest.runtime) throw new Error("OmniVoice runtime description is missing");
    this.manifest = manifest;
    this.runtime = manifest.runtime;
    this.appBaseUrl = appBaseUrl;
    configureOrtWasm(ort, {
      preferredThreadCount: this.preferredThreadCount,
      wasmBaseUrl: appBaseUrl,
    });

    const assetRoot = buildVirtualAssetUrl(manifest.id, "", appBaseUrl);
    onStatus({ phase: "tokenizer" });
    this.tokenizer = await loadTokenizer(assetRoot, this.runtime.tokenizerDirectory || "tokenizer");

    const candidates = globalThis.navigator?.gpu && this.runtime.preferWebGpu !== false ? ["webgpu", "wasm"] : ["wasm"];
    let lastError;
    for (const backend of candidates) {
      try {
        onStatus({ phase: "sessions", backend });
        this.sessions = await this.#createSessions(backend);
        this.backend = backend;
        await this.#warmup();
        return { backend: this.backend, sampleRate: this.runtime.sampleRate };
      } catch (error) {
        lastError = error;
        await this.dispose();
        this.manifest = manifest;
        this.runtime = manifest.runtime;
        this.tokenizer = await loadTokenizer(assetRoot, this.runtime.tokenizerDirectory || "tokenizer");
        onStatus({ phase: "backend-failed", backend, message: error.message });
      }
    }
    throw new Error(`OmniVoice initialization failed: ${lastError?.message || "no usable backend"}`);
  }

  async synthesize(text, options = {}) {
    if (!this.sessions || !this.tokenizer) throw new Error("OmniVoice engine is not initialized");
    const inputs = await prepareOmniVoiceInputs(text, this.tokenizer, this.runtime.generation, options);
    const generated = await generateOmniVoiceCodes({
      inputs,
      config: this.runtime.generation,
      runBackboneStep: (step) => this.#runBackboneStep(step),
      numStep: options.numStep ?? this.runtime.generation.numStep ?? 16,
      guidanceScale: options.guidanceScale ?? this.runtime.generation.guidanceScale ?? 4,
      tShift: options.tShift ?? this.runtime.generation.tShift ?? 0.05,
      isCancelled: options.isCancelled,
      onStep: options.onStep,
    });
    if (options.isCancelled?.()) throw new Error("cancelled");
    const pcm = await this.#decode(generated.tokens, generated.codebooks, generated.targetLength);
    return { pcm: normalizePcm(pcm), sampleRate: this.runtime.sampleRate, backend: this.backend };
  }

  async #createSessions(backend) {
    const sessions = {};
    for (const [name, definition] of Object.entries(this.runtime.sessions)) {
      const modelUrl = buildVirtualAssetUrl(this.manifest.id, definition.model, this.appBaseUrl);
      const options = {
        executionProviders: [backend],
        graphOptimizationLevel: "all",
      };
      if (definition.externalData?.length) {
        options.externalData = definition.externalData.map((entry) => ({
          path: entry.path,
          data: buildVirtualAssetUrl(this.manifest.id, entry.localPath, this.appBaseUrl),
        }));
      }
      sessions[name] = await ort.InferenceSession.create(modelUrl, options);
    }
    return sessions;
  }

  async #warmup() {
    const codebooks = this.runtime.generation.num_audio_codebook;
    const sequenceLength = 4;
    const inputIds = new BigInt64Array(2 * codebooks * sequenceLength).fill(BigInt(this.runtime.generation.audio_mask_id));
    const audioMask = new Uint8Array(2 * sequenceLength).fill(1);
    const attentionMask = new BigInt64Array(2 * sequenceLength).fill(1n);
    const logits = await this.#runBackboneStep({ inputIds, audioMask, attentionMask, batch: 2, codebooks, sequenceLength });
    if (logits.length !== 2 * codebooks * sequenceLength * this.runtime.generation.audio_vocab_size) {
      throw new Error(`Unexpected warmup logits length: ${logits.length}`);
    }
  }

  async #runBackboneStep({ inputIds, audioMask, attentionMask, batch, codebooks, sequenceLength }) {
    const embeddingsResult = await this.sessions.audioEmbeddings.run({
      input_ids: new ort.Tensor("int64", inputIds, [batch, codebooks, sequenceLength]),
      audio_mask: new ort.Tensor("bool", audioMask, [batch, sequenceLength]),
    });
    const embeddings = embeddingsResult.inputs_embeds;
    const llmFeed = {
      inputs_embeds: new ort.Tensor("float32", tensorToFloat32(embeddings), [batch, sequenceLength, this.runtime.hiddenSize]),
    };
    const llmInputNames = new Set(this.sessions.llm.inputNames);
    if (llmInputNames.has("attention_mask")) {
      llmFeed.attention_mask = new ort.Tensor("int64", attentionMask, [batch, sequenceLength]);
    }
    if (llmInputNames.has("position_ids")) {
      llmFeed.position_ids = new ort.Tensor("int64", bigintRange(sequenceLength, batch), [batch, sequenceLength]);
    }
    for (const inputName of this.sessions.llm.inputNames) {
      if (!inputName.includes("past")) continue;
      llmFeed[inputName] = new ort.Tensor("float32", new Float32Array(0), [batch, this.runtime.numKvHeads, 0, this.runtime.headDim]);
    }
    const llmResult = await this.sessions.llm.run(llmFeed);
    const hidden = llmResult.hidden_states;
    const headsResult = await this.sessions.audioHeads.run({
      hidden_states: new ort.Tensor("float32", tensorToFloat32(hidden), [batch, sequenceLength, this.runtime.hiddenSize]),
    });
    return tensorToFloat32(headsResult.logits);
  }

  async #decode(tokens, codebooks, targetLength) {
    const decoderInputName = this.runtime.decoderInputName || "codes";
    const decoderOutputName = this.runtime.decoderOutputName || "waveform_24k";
    const result = await this.sessions.higgsDecoder.run({
      [decoderInputName]: new ort.Tensor("int64", tokens, [codebooks, 1, targetLength]),
    });
    const waveform = result[decoderOutputName];
    if (!waveform) throw new Error(`Higgs decoder output not found: ${decoderOutputName}`);
    return tensorToFloat32(waveform);
  }

  async dispose() {
    if (this.sessions) {
      await Promise.all(Object.values(this.sessions).map((session) => session.release?.()));
    }
    this.sessions = null;
    this.backend = null;
    this.tokenizer = null;
  }
}

async function loadTokenizer(assetRoot, tokenizerDirectory) {
  const base = new URL(`${tokenizerDirectory.replace(/\/$/, "")}/`, assetRoot);
  const [tokenizerResponse, configResponse] = await Promise.all([
    fetch(new URL("tokenizer.json", base)),
    fetch(new URL("tokenizer_config.json", base)),
  ]);
  if (!tokenizerResponse.ok) {
    throw new Error(`Tokenizer model is unavailable offline: ${tokenizerResponse.status}`);
  }
  if (!configResponse.ok) {
    throw new Error(`Tokenizer config is unavailable offline: ${configResponse.status}`);
  }
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    tokenizerResponse.json(),
    configResponse.json(),
  ]);
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}
