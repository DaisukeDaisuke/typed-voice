# typed-voice 現行補正報告書 2026-08-16

本書は第一版草案や既存補正文を置換する新しい全体仕様書ではない。添付ZIP内の全実文書を通読した上で、2026-08-16後半までに実測で更新された事項だけを補正し、UIオーケストラ実装へ移るための現在地点を固定する。

## 1. 文書関係

第一版草案 `gistfile1.txt` のUI、会話、履歴、reasoning、独立オーケストラ、完全オフライン、行動テストの定義は維持する。

`2.md` と `gistfile2.md` は全文棄却しない。ただしPiper Plusを一次エンジンへ固定する記述、Piper固有G2Pやモデルサイズを全体仕様へ昇格した記述は失効済みである。

`typed-voice-engine-correction.md`、エンジン選定補正、handoff v2/v3、persistent checkpoint v4は、それぞれ当時の作業状態として維持する。ただし以下の実測結果で更新された箇所は本書を優先する。

## 2. OmniVoice変換は成立した

「OmniVoiceのONNX変換自体が音声破損を起こしている」という仮説は棄却する。

破損原因は、OmniVoice本来の非causal / MaskGIT型attentionを、変換時にQwenのcausal decoder semanticsへ変更していたことだった。同一checkpoint・同一入力で4D full-attentionと旧2D causal-attentionを比較したところ、最初のlogitsから大差があり、最終640 audio token中639 tokenが不一致だった。

修正版は `bool [batch, 1, sequence, sequence]` のattention maskを直接受け、KV cacheを使用しない。PyTorchと修正版ONNXの数値差は最大約 `9.2e-5`、16-step生成後の640 audio tokenはPyTorch原実装とbyte単位で完全一致した。

変換元は固定revisionの `kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune` であり、compressed/GPTQ版を代用品としていない。

## 3. Python native品質baselineは合格した

Python + ONNX Runtime CPUで生成した日本語音声をユーザーが試聴し、次を確認した。

- 日本語として正常。
- つくよみちゃんとして十分かわいい。
- ホワイトノイズなし。
- PoCの音質要件を満たす。

したがって、変換artifact自体の品質baselineは成立した。

GitHub ActionsではPython + ONNX Runtime CPUにより静的audio sampleを生成し、Hugging Face / GitHub Releaseへ配布する経路を持つ。ブラウザリアルタイム生成をsample生成に使用しない。

## 4. ブラウザbackendの確定補正

純WebGPUでの生成は、日本語として認識できるものの、ひどいマイクを通したようなノイズ・劣化が発生した。

純WASMではノイズがなく、イントネーションも正常だった。

同一文章、同一target length、CPython `random.Random`互換seed、同一position temperatureでWASMとWebGPUを比較すると、生成audio token hashは完全一致した。税関テスト文では両backendとも `tokens=5837f4a1` だった。

したがってLLM、noncausal attention、audio headsのWebGPU実行は破損していない。劣化はHiggs decoderのWebGPU実行に局在すると判断できる。

現在の確定PoC backendは次。

```text
audio embeddings  -> WebGPU
LLM               -> WebGPU
audio heads       -> WebGPU
Higgs decoder     -> WASM
```

表示上は `webgpu+higgs-wasm` とする。

このhybrid構成で、税関テスト文は約1.9秒生成、音声約3.31秒、target=85、token hash `5837f4a1`。ユーザー試聴でノイズなし・イントネーション正常を確認した。

WebGPUを利用できない環境ではWASMへfallbackする。

## 5. 速度指定

PoCには速度指定を正式に残す。UI範囲は現在 `0.5x` から `2.0x`。

速度は再生時の単純なpitch変更ではなく、OmniVoiceのtarget duration / target token estimationへ反映する。PoCで実動作確認済み。

## 6. ブラウザasset integrityはXXH3-128へ変更

旧文書の「ブラウザで毎回SHA-256を計算する」は失効する。iPadでmulti-GiB assetを毎回純JS SHA-256するコストが大きすぎるためである。

現在は次の責務分離を採用する。

- CI / Release監査: SHA-256を維持。
- browser first download: XXH3-128。
- browser reload/cache revalidation: XXH3-128。

converterはmanifestへ `sha256` と `xxh3_128` の両方を出力する。browser runtimeは `xxh3_128` を使用する。

`hash-wasm@4.12.0` のXXH128実装を精査し、Python `xxhash.xxh3_128` とsingle-shot / streaming双方でdigest一致を確認した。ViteでXXH128だけをbundleした場合は約19.8KB、gzip約8.7KBだった。

Codespace上の512MiB比較では、XXH3-128は約5.1GiB/s、旧純JS SHA-256は約45MiB/sで、同環境では約113倍の差が出た。この数値はiPad実測値ではない。

旧SHA metadataしか持たない既存browser cacheも、大容量assetを再downloadせず、cache本体をXXH3-128で検証して新metadataへ昇格できる。

## 7. Service Worker補正

production Service Workerを1個に統合する原則は維持する。

開発時にService Workerを完全unregisterしていた実装では、`/__typed_voice_assets/.../tokenizer_config.json` がViteのSPA fallbackへ流れ、`<!doctype ...` をJSONとしてparseして失敗した。

現在はdevでもmodel virtual URLをService Workerがcontrolする。これによりPoCのvirtual model asset経路をdevでも実検証できる。

## 8. session初期化失敗時のメモリ補正

ONNX sessionを順次作成する途中で失敗した場合、`this.sessions`へ代入される前のpartial sessionが解放されない経路があった。

これは特にメモリ制約の厳しいiPadで悪影響を持つため、partial sessionを必ずreleaseするよう補正した。失敗時はbackendだけでなくsession名も分かるエラーへする。

## 9. iPad Safariは未解決課題として残す

iPad Safariでは旧版で取得済みのassetが存在する状態で「オフライン音声を準備」を押しても反応しない症状が報告されている。

Windowsしか開発環境がないため、macOS Safari Web Inspector / Xcode Simulatorによる実機相当の詳細調査は現在行えない。

したがって以下は未達のまま残す。

- iPad Safariでの旧cache -> XXH3 metadata migration実動作。
- iPad SafariでのWASM OmniVoice初期化。
- iPad Air M4で12GB以内、できれば8GB目標内の実測。
- 機内モード相当でreload -> history -> TTS -> playbackまでの最終実機確認。

この未達はUIオーケストラ実装をブロックしない。UIオーケストラは第一版草案の通り音声エンジンから独立して完動可能でなければならない。

## 10. PoCは破棄しない

今回のPoCは単なる一時debug画面ではない。

以下を一画面で再現できる受入試験・診断・デモ資産である。

- offline voice preparation。
- cache integrity。
- backend初期化。
- 実日本語合成。
- 速度指定。
- token hash表示。
- backend表示。
- ライセンス表示。

したがってproduction deploymentに `poc.html` として残し、製品UIから「Voice Lab」等の開発内部語でない名称で到達可能にする。

## 11. UIオーケストラへ移る現在の根拠

第一版草案の優先順位に従い、UIオーケストラはengine未実装でも独立して完動しなければならない。現在はさらに実TTS PoCも成立しているため、UI実装を待つ理由はない。

UI側で現在維持する確定事項:

- `仕事` はUIで `会話`。
- `reasoning` はUIで `読み上げ待ち時間`。
- 正式messageとpending utteranceを混ぜない。
- Enter/提出時点でreasoningとsynthesisを並行開始できる設計。
- 両方の条件を満たすまで再生しない。
- generation更新により古い合成結果を破棄する。
- 直近2件のpendingを修正可能にする。
- 会話を開くためにreloadしない。
- URLへconversation UUIDを即時反映する。
- sessions/messages/pending/settings/statisticsを巨大JSONへまとめない。
- UIは仕様書ではないため、内部語を画面へ表示しない。
- 入力後もキーボード・focusを維持して連続入力できること。
- PCデバッグ、スマートフォンを阻害しないresponsive設計。

## 12. 現在の完成判定

音声品質PoCについてはdesktop browserで合格。

iPad実機については未完。

製品全体としてはUIオーケストラ、履歴、reasoning、DB、再生制御、完全オフライン統合をこれから実装・結合する。

PoCの成功を理由にiPad課題を「解決済み」にしてはならず、iPad課題を理由に既に合格したdesktop PoCやUI実装を止めてもならない。
