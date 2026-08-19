# typed-voice
とある日曜劇場の真似事（AIで実装中）。現在のPoCは `kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune` から変換した実モデルをブラウザ上で動かします。別のOmniVoiceモデル、compressed/GPTQ版、Piper Plusを代替音声には使用しません。

# Live Preview

https://daisukedaisuke.github.io/typed-voice


| 配布profile | Hugging Face直リンク | 用途 | 量子化 |
| --- | --- | --- | --- |
| Mobile INT8 | [mobile-int8](https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/tree/mobile-int8) | ブラウザ向け標準候補 | LLMの定数MatMul weightのみ8-bit。activation / audio embeddings / audio heads / Higgs decoderはFP32 |
| FP32 baseline | [main](https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/tree/main) | 品質baseline / 比較用 | なし |

Mobile INT8は同一文・固定seedのnative ONNX Runtime生成をFP32と聞き比べ、実用上の劣化はほぼないと確認済みです。わずかに音の豊かさが減った可能性はありますが、差は小さいためブラウザ移植対象として採用します。
## 現在のPoC境界
ブラウザ実装は `audio_embeddings_encoder -> llm_decoder -> audio_heads_decoder -> iterative unmask -> Higgs decoder` のsplit構成です。desktopではaudio embeddings / LLM / audio headsをWebGPU、Higgs decoderをWASMで動かすhybrid経路の音質・速度を確認済みです。Mobile INT8ではLLM weightだけを8-bit `MatMulNBits` へ変換し、OmniVoice本来のrank-4 Boolean non-causal attentionとno-KV-cache契約を維持します。
## Audio Samples
以下はGitHub ActionsのCPU runnerで、各profileの確定runtimeから**同一文章・同一seed**で生成する比較用WAVです。

| Sample | FP32 | Mobile INT8 |
| --- | --- | --- |
| `東京都税関関税許可局、関税許可を急遽却下` | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/01_customs_tariff_rejection.wav"></audio> | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/01_customs_tariff_rejection.wav"></audio> |
| `WebAssemblyをLLMでVibe Coding中` | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/02_webassembly_vibe_coding.wav"></audio> | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/02_webassembly_vibe_coding.wav"></audio> |
| `えへへ、見つけてくれたんだ！ずっとここで待ってたんだよ？` | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/03_found_me_waiting.wav"></audio> | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/03_found_me_waiting.wav"></audio> |
| `Hey, you finally made it! How does it feel, looking back at everything we've been through?` | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/04_found_me_waiting_English.wav"></audio> | <audio controls src="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/04_found_me_waiting_English.wav"></audio> |

## オフライン設計
最初の明示的な「オフライン音声を準備」で、build固有のimmutable revisionへ固定した資産を取得します。CI / Release監査ではSHA-256を維持し、ブラウザの初回取得・reload時の大容量asset検証にはXXH3-128を使用します。検証済みメタデータだけをIndexedDBへ記録し、巨大な `ArrayBuffer` をIndexedDBへ複製しません。
Service Workerは1個だけ使用し、アプリshell、ONNX Runtime WebのWASM runtime、manifestのオフライン化とCOOP/COEP付与を担当します。app base配下の `__typed_voice_assets/` は準備済みCache以外へネットワークfallbackしません。
## 音声生成
Dedicated Worker内でOmniVoice推論を行います。UIとの境界はFloat32 PCMです。待機列はlatest-winsで有限長とし、実行中生成もiterative unmaskのstep間でgenerationを確認して古い要求を中断します。WebGPUはsession生成と実forwardのwarmupが成功した場合のみ使用し、失敗時はWASMへfallbackします。WASM multi-threadはCross-Origin Isolation、SharedArrayBuffer、secure contextが揃う場合だけ有効です。
## npm依存のセキュリティ
PoCのtokenizer読込だけに `@huggingface/transformers` を使用すると、ブラウザでは不要な `onnxruntime-node`、`adm-zip`、`sharp` がnpm依存へ入り、2026-08-16時点の `npm audit` でhigh severityが報告されます。そのためTransformers.js全体への依存を削除し、`@huggingface/tokenizers` だけを使用してCache済み `tokenizer.json` / `tokenizer_config.json` を直接読みます。lockfile更新後にCodespace側で `npm audit` を再実行して解消を確認してください。
## Build
Node.js依存関係をインストールします。
```bash
npm install
```
通常の開発・本番buildではPiper PlusのRust/WASM buildを要求しません。ONNX Runtime WebのWASM runtimeとライセンス/NOTICEを `public/` へコピーします。
```bash
npm run dev
npm run build
```
PoCとは別に既存Piper Plus資産を再構築する場合だけ、Rustと`wasm-pack`を準備して明示的に実行します。これはつくよみちゃんfull-finetuneの音質確認経路には入りません。
```bash
npm run build:with-piper
```
## Tests
通常のNode.jsテストは次です。
```bash
npm test
```
ローカルMCPのオフラインMJS runnerで依存不要のPoCテストだけを実行する場合は `scripts/offline-poc-tests.mjs` を実行します。asset integrity境界、manifest固定revision、latest-wins queue、OmniVoice iterative unmask、step間cancel、ORT thread fallbackを挙動で検証します。
## License
プロジェクト自身のコードはApache License 2.0です。モデル、コーパス、Higgs Audio 2、Meta Llama 3、Piper Plusなどの第三者資産はトップレベルApache-2.0へ再ライセンスされません。詳細は `NOTICE`、`THIRD_PARTY_NOTICES.md`、`licenses/` を参照してください。
