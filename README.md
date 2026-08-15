# typed-voice
とある日曜劇場の真似事（AIで実装中）
## Build
このプロジェクトは、GitHub Codespaces または GitHub Actions 上でビルドすることを前提としています。ローカルPCへRust、`wasm-pack` などのビルド環境を直接導入する運用は想定していません。
ビルドはnpmスクリプト経由で実行します。`npm run build` は内部でPiper PlusのG2P WASMをビルドした後、Viteによる本番ビルドを行います。
### GitHub Codespaces
リポジトリをCodespacesで開き、サブモジュールを取得します。
```bash
git submodule update --init --recursive
```
CodespaceにRustが入っていない場合はRustを準備し、`wasm-pack` をインストールします。
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo install wasm-pack --locked
```
Node.js依存関係をインストールします。
```bash
npm install
```
本番ビルドを実行します。
```bash
npm run build
```
生成物は `dist/` に出力されます。
開発サーバーを起動する場合もnpmスクリプト経由で実行します。
```bash
npm run dev
```
`npm run dev` でも起動前にPiper PlusのG2P WASMが再ビルドされます。
### GitHub Actions
Actionsでは、checkout時にサブモジュールを取得し、Rust、`wasm-pack`、Node.jsを準備した後に `npm install` と `npm run build` を実行します。
```yaml
name: Build
on:
  push:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: dtolnay/rust-toolchain@stable
      - name: Install wasm-pack
        run: cargo install wasm-pack --locked
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm install
      - name: Build
        run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: typed-voice-dist
          path: dist/
```
`package-lock.json` をコミットした後は、Actionsの依存関係インストールを `npm install` から `npm ci` に変更できます。
## npm scripts
| Command | Description |
| --- | --- |
| `npm run build:piper-wasm` | Piper PlusのG2P WASMをビルドし、ONNX Runtime WebのWASMファイルを `public/` へ配置します。 |
| `npm run build` | `build:piper-wasm` を実行した後、Viteで本番用 `dist/` を生成します。 |
| `npm run dev` | `build:piper-wasm` を実行した後、Vite開発サーバーを起動します。 |
| `npm run preview` | ビルド済みの `dist/` をViteでプレビューします。 |
| `npm test` | Node.jsのテストを実行します。 |
