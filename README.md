# typed-voice
入力した文章を、ブラウザからそのまま音声にするためのツールです。<br>
文章を書いて読み上げたいときに、内部のモデル構成やWebGPUの知識を先に覚える必要はありません。まずはLive Previewを開いて、画面の案内どおりに試せます。
## Live Preview
**[▶ typed-voice を開く](https://daisukedaisuke.github.io/typed-voice)** <br>
初回だけ、利用する端末に音声モデルを準備します。準備が終われば、対応環境では同じ大容量データを毎回取り直さず、オフラインでも使えるように設計しています。
## 使い方
1. 上のLive Previewを開きます。
2. はじめての案内に沿って、端末に合う音声モデルを準備します。
3. 文章を入力して、読み上げます。
端末やブラウザによって利用できる高速化方式が違っても、できるだけその環境で動く経路へ切り替えるようにしています。
## こんな使い方を想定しています
- 会話中に、打ち込んだ文章をその場で声として届けたい。
- PCだけでなく、タブレットやモバイル環境でも同じ画面から使いたい。
- 一度準備した音声モデルを再利用して、通信できない場面でも使いたい。
## 音声を先に聞いてみる
現在のブラウザ向け標準候補で生成したサンプルです。
- [日本語サンプル — 「東京都税関関税許可局、関税許可を急遽却下」](https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/01_customs_tariff_rejection.wav) <br>
- [English sample — “Hey, you finally made it!”](https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/04_found_me_waiting_English.wav) <br>
現在も開発中です。画面や内部実装は更新されますが、READMEの先頭では「使う人が何をできるか」を優先し、細かな実装仕様は以下へまとめています。 <br>
<details>
<summary><strong>技術仕様・モデル構成を見る</strong></summary>
<p>現在のPoCは <code>kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune</code> から変換した実モデルをブラウザ上で動かします。別のOmniVoiceモデル、compressed/GPTQ版、Piper Plusを代替音声には使用しません。</p>
<h3>配布profile</h3>
<table>
<thead><tr><th>配布profile</th><th>Hugging Face</th><th>用途</th><th>量子化</th></tr></thead>
<tbody>
<tr><td>Mobile INT8</td><td><a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/tree/mobile-int8">mobile-int8</a></td><td>ブラウザ向け標準候補</td><td>LLMの定数MatMul weightのみ8-bit。activation / audio embeddings / audio heads / Higgs decoderはFP32</td></tr>
<tr><td>FP32 baseline</td><td><a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/tree/main">main</a></td><td>品質baseline / 比較用</td><td>なし</td></tr>
</tbody>
</table>
<p>Mobile INT8は同一文・固定seedのnative ONNX Runtime生成をFP32と聞き比べ、実用上の劣化はほぼないと確認済みです。わずかに音の豊かさが減った可能性はありますが、差は小さいためブラウザ移植対象として採用します。</p>
<h3>現在のPoC境界</h3>
<p>ブラウザ実装は <code>audio_embeddings_encoder -&gt; llm_decoder -&gt; audio_heads_decoder -&gt; iterative unmask -&gt; Higgs decoder</code> のsplit構成です。desktopではaudio embeddings / LLM / audio headsをWebGPU、Higgs decoderをWASMで動かすhybrid経路の音質・速度を確認済みです。Mobile INT8ではLLM weightだけを8-bit <code>MatMulNBits</code> へ変換し、OmniVoice本来のrank-4 Boolean non-causal attentionとno-KV-cache契約を維持します。</p>
<h3>比較用Audio Samples</h3>
<p>GitHub ActionsのCPU runnerで、各profileの確定runtimeから同一文章・同一seedで生成する比較用WAVです。</p>
<ul>
<li><code>東京都税関関税許可局、関税許可を急遽却下</code> — <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/01_customs_tariff_rejection.wav">FP32</a> / <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/01_customs_tariff_rejection.wav">Mobile INT8</a></li>
<li><code>WebAssemblyをLLMでVibe Coding中</code> — <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/02_webassembly_vibe_coding.wav">FP32</a> / <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/02_webassembly_vibe_coding.wav">Mobile INT8</a></li>
<li><code>えへへ、見つけてくれたんだ！ずっとここで待ってたんだよ？</code> — <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/03_found_me_waiting.wav">FP32</a> / <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/03_found_me_waiting.wav">Mobile INT8</a></li>
<li><code>Hey, you finally made it! How does it feel, looking back at everything we've been through?</code> — <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/04_found_me_waiting_English.wav">FP32</a> / <a href="https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/04_found_me_waiting_English.wav">Mobile INT8</a></li>
</ul>
<h3>オフライン設計</h3>
<p>最初の明示的な「オフライン音声を準備」で、build固有のimmutable revisionへ固定した資産を取得します。CI / Release監査ではSHA-256を維持し、ブラウザの初回取得・reload時の大容量asset検証にはXXH3-128を使用します。検証済みメタデータだけをIndexedDBへ記録し、巨大な <code>ArrayBuffer</code> をIndexedDBへ複製しません。</p>
<p>Service Workerは1個だけ使用し、アプリshell、ONNX Runtime WebのWASM runtime、manifestのオフライン化とCOOP/COEP付与を担当します。app base配下の <code>__typed_voice_assets/</code> は準備済みCache以外へネットワークfallbackしません。</p>
<h3>音声生成</h3>
<p>Dedicated Worker内でOmniVoice推論を行います。UIとの境界はFloat32 PCMです。待機列はlatest-winsで有限長とし、実行中生成もiterative unmaskのstep間でgenerationを確認して古い要求を中断します。WebGPUはsession生成と実forwardのwarmupが成功した場合のみ使用し、失敗時はWASMへfallbackします。WASM multi-threadはCross-Origin Isolation、SharedArrayBuffer、secure contextが揃う場合だけ有効です。</p>
<h3>npm依存のセキュリティ</h3>
<p>PoCのtokenizer読込だけに <code>@huggingface/transformers</code> を使用すると、ブラウザでは不要な <code>onnxruntime-node</code>、<code>adm-zip</code>、<code>sharp</code> がnpm依存へ入り、2026-08-16時点の <code>npm audit</code> でhigh severityが報告されます。そのためTransformers.js全体への依存を削除し、<code>@huggingface/tokenizers</code> だけを使用してCache済み <code>tokenizer.json</code> / <code>tokenizer_config.json</code> を直接読みます。lockfile更新後にCodespace側で <code>npm audit</code> を再実行して解消を確認してください。</p>
</details>
<details>
<summary><strong>開発・テスト手順を見る</strong></summary>
<h3>Build</h3>
<p>Node.js依存関係をインストールします。</p>
<pre><code>npm install</code></pre>
<p>通常の開発・本番buildではPiper PlusのRust/WASM buildを要求しません。ONNX Runtime WebのWASM runtimeとライセンス/NOTICEを <code>public/</code> へコピーします。</p>
<pre><code>npm run dev
npm run build</code></pre>
<p>PoCとは別に既存Piper Plus資産を再構築する場合だけ、Rustと<code>wasm-pack</code>を準備して明示的に実行します。これはつくよみちゃんfull-finetuneの音質確認経路には入りません。</p>
<pre><code>npm run build:with-piper</code></pre>
<h3>Tests</h3>
<p>通常のNode.jsテストは次です。</p>
<pre><code>npm test</code></pre>
<p>ローカルMCPのオフラインMJS runnerで依存不要のPoCテストだけを実行する場合は <code>scripts/offline-poc-tests.mjs</code> を実行します。asset integrity境界、manifest固定revision、latest-wins queue、OmniVoice iterative unmask、step間cancel、ORT thread fallbackを挙動で検証します。</p>
</details>
<details>
<summary><strong>ライセンスと第三者資産を見る</strong></summary>
<p>プロジェクト自身のコードはApache License 2.0です。モデル、コーパス、Higgs Audio 2、Meta Llama 3、Piper Plusなどの第三者資産はトップレベルApache-2.0へ再ライセンスされません。詳細は <code>NOTICE</code>、<code>THIRD_PARTY_NOTICES.md</code>、<code>licenses/</code> を参照してください。</p>
</details>
