# Third-party notices
## Project source license
The source code authored for `typed-voice` is distributed under Apache License 2.0. The top-level `LICENSE` does not relicense model weights, datasets, voice corpora, generated voice rights, or separately licensed third-party assets.
## VocoLoco
The OmniVoice browser-worker design, duration-estimation approach, and related implementation ideas are adapted from `Magkino/vocoloco_tts`, which is distributed under Apache License 2.0. Modified code in this repository is not a verbatim copy of its worker.
## OmniVoice and ONNX reference artifacts
The split-runtime design follows OmniVoice and `onnx-community/OmniVoice-Onnx`. The reference manifest is pinned to revision `a7be7c65cc118137683f49eff0f80fdf9d5b5dbf`. It exists only to validate browser runtime compatibility and must not be treated as the selected Tsukuyomichan voice-quality checkpoint.
## Tsukuyomichan OmniVoice Full Finetune
The selected first conversion target is `kizuna-intelligence/tsukuyomichan-omnivoice-full-finetune`, pinned to revision `c1d7ff9477d0b21f220c58070da63355f69607e9`. The model repository labels its license as `other` and requires compliance with the Tsukuyomichan Corpus terms for corpus-derived portions. The repository also imposes restrictions on generated audio and requires attribution when a model, demo, or application is published. This project does not currently redistribute converted full-finetune runtime artifacts.
Required corpus identification used by this application: `つくよみちゃんコーパス（CV: 夢前黎）`, © Rei Yumesaki. Corpus terms and the full required publication credit are available from `https://tyc.rei-yumesaki.net/material/corpus/` and the pinned model card.
## Higgs Audio 2
The OmniVoice audio decoder uses Higgs Audio 2 materials under the Boson Higgs Audio 2 Community License Agreement, which incorporates the Meta Llama 3 Community License Agreement. Copies are included as `licenses/BOSON-HIGGS-AUDIO-2-LICENSE.txt` and `licenses/META-LLAMA-3-LICENSE.txt`. The Boson agreement contains attribution, redistribution, acceptable-use, and additional commercial conditions; those terms apply independently of the project Apache-2.0 license.
## Piper Plus fallback
The existing Piper Plus code remains in `third_party/piper-plus` and `src/engine/piper-engine.js` as a fallback/regression path. Its upstream licenses remain applicable to that submodule and its dependencies. Piper Plus is not the primary engine selected by the current PoC.
