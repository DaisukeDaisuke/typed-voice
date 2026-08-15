# typed-voice
とある日曜劇場の真似事（AIで実装中）。現在のPoCは、つくよみちゃん向け音声エンジンの第一候補として `kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune` を扱い、Piper Plusはfallback/regression経路として残しています。
## 現在のPoC境界
`public/voice-manifest.json` はfull-finetune元重みの固定revisionを保持します。ただし、ブラウザ用split ONNXがまだ生成されていないため `installable:false` です。`C:\Users\owner\Downloads\model.safetensors` のcompressed/GPTQ重みをfull-finetuneの代用品にはしません。
`public/omnivoice-reference-manifest.json` は `onnx-community/OmniVoice-Onnx` の固定revisionを使うランタイム検証用セットです。これは声質候補の置き換えではありません。ブラウザ実装は `audio_embeddings_encoder -> llm_decoder -> audio_heads_decoder -> iterative unmask -> Higgs decoder` のsplit構成を前提にしています。
## オフライン設計
最初の明示的な「オフライン音声を準備」で、固定revision・固定SHA-256の資産を取得します。大容量ファイルは `ReadableStream` を二分し、Cache APIへの保存と増分SHA-256検証を並行します。検証済みメタデータだけをIndexedDBへ記録し、巨大な `ArrayBuffer` をIndexedDBへ複製しません。
Service Workerは1個だけ使用し、アプリshell、ONNX Runtime WebのWASM runtime、manifestのオフライン化とCOOP/COEP付与を担当します。app base配下の `__typed_voice_assets/` は準備済みCache以外へネットワークfallbackしません。
## 音声生成
Dedicated Worker内でOmniVoice推論を行います。UIとの境界はFloat32 PCMです。待機列はlatest-winsで有限長とし、実行中生成もiterative unmaskのstep間でgenerationを確認して古い要求を中断します。WebGPUはsession生成と実forwardのwarmupが成功した場合のみ使用し、失敗時はWASMへfallbackします。WASM multi-threadはCross-Origin Isolation、SharedArrayBuffer、secure contextが揃う場合だけ有効です。
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
Piper Plus fallbackを含むG2P WASMを再構築する場合だけ、Rustと`wasm-pack`を準備して明示的に実行します。
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
