#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from tokenizers import Tokenizer


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def make_session(model: Path, threads: int = 4):
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(model), sess_options=opts, providers=["CPUExecutionProvider"])


def log_softmax(x: np.ndarray) -> np.ndarray:
    maximum = np.max(x, axis=-1, keepdims=True)
    z = x - maximum
    return z - np.log(np.sum(np.exp(z), axis=-1, keepdims=True))


def gumbel_score(score: float, temperature: float, rng: random.Random) -> float:
    if not temperature > 0:
        return float(score)
    u = min(1 - 1e-10, max(0.0, rng.random()))
    noise = -math.log(-math.log(u + 1e-10) + 1e-10)
    return float(score) / temperature + noise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=Path("/tmp/typedvoice-model"))
    parser.add_argument("--fixed-llm", type=Path, default=Path("/tmp/onnxfix-diag/fixed-llm/llm_decoder.onnx"))
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/typedvoice-python-listen"))
    parser.add_argument("--text", default="こんにちは。つくよみちゃんの音声テストです。")
    parser.add_argument("--target-tokens", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260816)
    args = parser.parse_args()

    model = args.model_dir
    output = args.output_dir
    output.mkdir(parents=True, exist_ok=True)
    runtime_manifest = json.loads((model / "runtime-manifest.json").read_text(encoding="utf-8"))
    runtime = runtime_manifest["runtime"]
    config = runtime["generation"]

    codebooks = int(config["num_audio_codebook"])
    mask_id = int(config["audio_mask_id"])
    vocab = int(config["audio_vocab_size"])
    num_step = int(config["numStep"])
    guidance = float(config["guidanceScale"])
    t_shift = float(config["tShift"])
    layer_penalty = float(config["layerPenalty"])
    position_temperature = float(config["positionTemperature"])
    class_temperature = float(config["classTemperature"])
    if class_temperature != 0:
        raise RuntimeError(f"classTemperature={class_temperature} is unsupported by the reference greedy sampler")

    sample_rate = int(runtime["sampleRate"])
    target = args.target_tokens
    rng = random.Random(args.seed)

    print("Native Python / ONNX Runtime smoke", flush=True)
    print("onnxruntime", ort.__version__, "providers", ort.get_available_providers(), flush=True)
    print("text:", args.text, flush=True)
    print(
        "generation:",
        json.dumps(
            {
                "targetTokens": target,
                "numStep": num_step,
                "guidanceScale": guidance,
                "tShift": t_shift,
                "layerPenalty": layer_penalty,
                "positionTemperature": position_temperature,
                "classTemperature": class_temperature,
                "seed": args.seed,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    sums = {}
    for line in (model / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        sums[name.lstrip("*")] = digest.lower()
    required_hf = [
        "audio_embeddings_encoder.onnx",
        "audio_embeddings_encoder.onnx.data",
        "audio_heads_decoder.onnx",
        "audio_heads_decoder.onnx.data",
        "higgs_decoder.onnx",
        "higgs_decoder.onnx.data",
        "tokenizer.json",
        "tokenizer_config.json",
        "runtime-manifest.json",
    ]
    print("verifying cached HF assets...", flush=True)
    for name in required_hf:
        actual = sha256(model / name)
        expected = sums.get(name)
        if expected and actual != expected:
            raise RuntimeError(f"SHA256 mismatch: {name}: {actual} != {expected}")
        print("  ok", name, actual, flush=True)

    public_llm_hash = sha256(model / "llm_decoder.onnx")
    fixed_llm_hash = sha256(args.fixed_llm)
    fixed_llm_data = args.fixed_llm.with_suffix(args.fixed_llm.suffix + ".data")
    fixed_llm_data_hash = sha256(fixed_llm_data)
    print("public HF llm_decoder.onnx sha256:", public_llm_hash, flush=True)
    print("fixed llm_decoder.onnx sha256:", fixed_llm_hash, flush=True)
    print("fixed llm_decoder.onnx.data sha256:", fixed_llm_data_hash, flush=True)

    tokenizer = Tokenizer.from_file(str(model / "tokenizer.json"))
    style = "<|lang_start|>ja<|lang_end|><|instruct_start|>None<|instruct_end|>"
    wrapped = f"<|text_start|>{args.text.strip()}<|text_end|>"
    style_ids = tokenizer.encode(style).ids
    text_ids = tokenizer.encode(wrapped).ids
    target_offset = len(style_ids) + len(text_ids)
    sequence = target_offset + target
    print(
        "tokenized style/text/offset/sequence:",
        len(style_ids),
        len(text_ids),
        target_offset,
        sequence,
        flush=True,
    )

    base = np.zeros((codebooks, sequence), dtype=np.int64)
    for codebook in range(codebooks):
        base[codebook, : len(style_ids)] = style_ids
        base[codebook, len(style_ids) : target_offset] = text_ids
        base[codebook, target_offset:] = mask_id

    batch_ids = np.full((2, codebooks, sequence), mask_id, dtype=np.int64)
    batch_ids[0] = base
    batch_ids[1, :, :target] = mask_id

    audio_mask = np.zeros((2, sequence), dtype=bool)
    audio_mask[0, target_offset:] = True
    audio_mask[1, :target] = True

    attention = np.zeros((2, 1, sequence, sequence), dtype=bool)
    attention[0, 0, :, :] = True
    attention[1, 0, :target, :target] = True
    diagonal = np.arange(target, sequence)
    attention[1, 0, diagonal, diagonal] = True
    assert attention.shape == (2, 1, sequence, sequence)
    assert attention.dtype == np.bool_

    print("loading native ONNX Runtime sessions...", flush=True)
    embeddings_session = make_session(model / "audio_embeddings_encoder.onnx")
    llm_session = make_session(args.fixed_llm)
    heads_session = make_session(model / "audio_heads_decoder.onnx")
    decoder_session = make_session(model / "higgs_decoder.onnx")
    llm_inputs = [(item.name, item.type, item.shape) for item in llm_session.get_inputs()]
    print("fixed LLM inputs:", llm_inputs, flush=True)
    if (
        len(llm_inputs) != 2
        or llm_inputs[0][0] != "inputs_embeds"
        or llm_inputs[1][0] != "attention_mask"
        or "bool" not in llm_inputs[1][1]
    ):
        raise RuntimeError(f"unexpected fixed LLM contract: {llm_inputs}")

    def backbone(ids, mask):
        embeddings = embeddings_session.run(
            ["inputs_embeds"],
            {"input_ids": ids, "audio_mask": mask},
        )[0]
        hidden = llm_session.run(
            None,
            {
                "inputs_embeds": embeddings.astype(np.float32, copy=False),
                "attention_mask": attention,
            },
        )[0]
        logits = heads_session.run(
            ["logits"],
            {"hidden_states": hidden.astype(np.float32, copy=False)},
        )[0]
        return logits.astype(np.float32, copy=False)

    tokens = np.full((codebooks, target), mask_id, dtype=np.int64)
    steps = []
    for index in range(num_step + 1):
        linear = index / num_step
        steps.append((t_shift * linear) / (1 + (t_shift - 1) * linear))

    total = tokens.size
    remaining = total
    for step in range(num_step):
        scheduled = (
            remaining
            if step == num_step - 1
            else min(remaining, math.ceil(total * (steps[step + 1] - steps[step])))
        )
        logits = backbone(batch_ids, audio_mask)
        conditional = log_softmax(logits[0, :, target_offset : target_offset + target, :])
        unconditional = log_softmax(logits[1, :, :target, :])
        guided = log_softmax((1 + guidance) * conditional - guidance * unconditional)
        guided[:, :, mask_id] = -np.inf
        predictions = np.argmax(guided, axis=-1)
        scores = np.max(guided, axis=-1)
        scores = scores - np.arange(codebooks, dtype=np.float32)[:, None] * layer_penalty

        candidates = []
        for codebook in range(codebooks):
            for position in range(target):
                if tokens[codebook, position] == mask_id:
                    candidates.append(
                        (
                            gumbel_score(scores[codebook, position], position_temperature, rng),
                            codebook,
                            position,
                        )
                    )
        candidates.sort(key=lambda item: item[0], reverse=True)
        chosen = candidates[:scheduled]
        for _, codebook, position in chosen:
            tokens[codebook, position] = predictions[codebook, position]
        remaining -= len(chosen)
        batch_ids[0, :, target_offset : target_offset + target] = tokens
        batch_ids[1, :, :target] = tokens
        print(f"step {step + 1}/{num_step}: scheduled={scheduled} remaining={remaining}", flush=True)

    if np.any(tokens == mask_id):
        raise RuntimeError(f"masked tokens remain: {int(np.sum(tokens == mask_id))}")

    np.save(output / "codes.npy", tokens)
    waveform = decoder_session.run(
        [runtime.get("decoderOutputName", "waveform_24k")],
        {runtime.get("decoderInputName", "codes"): tokens[:, None, :]},
    )[0].astype(np.float32).reshape(-1)
    sf.write(output / "python_native_raw.wav", waveform, sample_rate, subtype="PCM_16")

    start = 0
    end = len(waveform)
    threshold = 0.0005
    while start < end and abs(float(waveform[start])) < threshold:
        start += 1
    while end > start and abs(float(waveform[end - 1])) < threshold:
        end -= 1
    normalized = waveform[start:end].copy()
    peak = float(np.max(np.abs(normalized))) if len(normalized) else 0.0
    scale = min(0.95 / peak, 3.0) if peak > 0 else 1.0
    normalized *= scale
    sf.write(output / "python_native_listen.wav", normalized, sample_rate, subtype="PCM_16")

    metadata = {
        "text": args.text,
        "modelRepo": "RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx",
        "publicRevision": "236aaf26821fb4783cbba3b5dcd6921c8f143b5d",
        "publicLlmUsed": False,
        "fixedLlmUsed": str(args.fixed_llm),
        "publicLlmSha256": public_llm_hash,
        "fixedLlmSha256": fixed_llm_hash,
        "fixedLlmDataSha256": fixed_llm_data_hash,
        "attention": {
            "dtype": "bool",
            "shape": list(attention.shape),
            "mode": "omnivoice-noncausal",
            "useCache": False,
        },
        "generation": {
            "targetTokens": target,
            "numStep": num_step,
            "guidanceScale": guidance,
            "tShift": t_shift,
            "layerPenalty": layer_penalty,
            "positionTemperature": position_temperature,
            "classTemperature": class_temperature,
            "seed": args.seed,
        },
        "codes": {
            "min": int(tokens.min()),
            "max": int(tokens.max()),
            "unique": int(len(np.unique(tokens))),
        },
        "audio": {
            "sampleRate": sample_rate,
            "rawSamples": int(len(waveform)),
            "normalizedSamples": int(len(normalized)),
            "rawMin": float(waveform.min()),
            "rawMax": float(waveform.max()),
            "rawRms": float(np.sqrt(np.mean(waveform.astype(np.float64) ** 2))),
            "peakBeforeNormalize": peak,
            "normalizeScale": scale,
        },
    }
    (output / "diagnostic.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2), flush=True)
    print("WAV:", output / "python_native_listen.wav", flush=True)


if __name__ == "__main__":
    main()
