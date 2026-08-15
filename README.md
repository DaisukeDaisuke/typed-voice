# typed-voice
とある日曜劇場の真似事（AIで実装中）。現在のPoCは `kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune` の実際の音質をブラウザ上で確認することを目的とします。別のOmniVoiceモデル、compressed/GPTQ版、Piper PlusなどをPoCの代替音声として使用しません。
## 現在のPoC境界
`public/voice-manifest.json` はfull-finetune元重みの固定revisionを保持します。ブラウザ用split ONNXがまだ生成されていないため `installable:false` ですが、これはエンジン初期化だけを止めます。`preparable:true` と固定hash付き `conversion-source` assetを持つため、dev画面からfull-finetune原本 `model.safetensors`（2,450,344,144 bytes）を実際に取得・ストリーミングSHA-256検証・Cache保存できます。`C:\Users\owner\Downloads\model.safetensors` のcompressed/GPTQ重みをfull-finetuneの代用品にはしません。
ブラウザ実装は `audio_embeddings_encoder -> llm_decoder -> audio_heads_decoder -> iterative unmask -> Higgs decoder` のsplit構成を前提にしますが、PoCで実行可能にするモデル資産はfull-finetuneから生成したものだけです。音質確認前のINT4/INT8量子化も行いません。
## オフライン設計
最初の明示的な「オフライン音声を準備」で、固定revision・固定SHA-256の資産を取得します。大容量ファイルは `ReadableStream` を二分し、Cache APIへの保存と増分SHA-256検証を並行します。検証済みメタデータだけをIndexedDBへ記録し、巨大な `ArrayBuffer` をIndexedDBへ複製しません。
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
ローカルMCPのオフラインMJS runnerで依存不要のPoCテストだけを実行する場合は `scripts/offline-poc-tests.mjs` を実行します。増分SHA-256境界、manifest固定revision、latest-wins queue、OmniVoice iterative unmask、step間cancel、ORT thread fallbackを挙動で検証します。
## License
プロジェクト自身のコードはApache License 2.0です。モデル、コーパス、Higgs Audio 2、Meta Llama 3、Piper Plusなどの第三者資産はトップレベルApache-2.0へ再ライセンスされません。詳細は `NOTICE`、`THIRD_PARTY_NOTICES.md`、`licenses/` を参照してください。
