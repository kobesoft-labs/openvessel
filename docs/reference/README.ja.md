# OpenVessel リファレンス

[English](README.md)

OpenVessel の細かい技術文書です。ホスト API のすべてのオプション、埋め込みと配信の条件、部品どうしの通信の形式、
そしてタブの中のしくみ（カーネル・ファイルシステム・プロセス・シェル・パッケージマネージャ・ネイティブのモジュール・
Node.js の層）を、ひとつずつ説明します。書いてあるのは、このリポジトリの OpenVessel です
（版は `package.json`、移植している Node.js の版は `openvessel.node` を見てください）。

全体の考え方は [OpenVessel のしくみ](../how-it-works.ja.md) から、ブラウザで動くもの・動かないものは
[互換性](../compatibility.ja.md) から読むと分かりやすいです。

## はじめに

| ページ | 中身 |
|---|---|
| [はじめに](getting-started.ja.md) | 空のページから `npm install`・`astro build`・プレビューまで。配るもの・ヘッダー・最初の `boot()`。 |

## 組み込む

| ページ | 中身 |
|---|---|
| [ホスト API](host-api.ja.md) | `OpenVessel.boot()` とすべてのオプション、ファイル、プロセス、イベント、プレビュー、エラー。 |
| [通信の方針](network-policy.ja.md) | モード、用意したセット、許可・拒否の書き方、判定の順番、確認のダイアログ。 |
| [配信](deployment.ja.md) | 3 つのオリジン、`dist/` のファイル、必要なヘッダーのすべて、ヘッダーを付けられない配信先。 |
| [プレビュー](preview.ja.md) | 仮想ポートの開発サーバーを iframe に出すしくみ。HTTP と WebSocket の橋渡し、URL。 |
| [通信の形式](protocol.ja.md) | ホストのページ・ランタイム・プレビュー・プロセスの間でやり取りするメッセージ。 |

## 中のしくみ

| ページ | 中身 |
|---|---|
| [カーネル](kernel.ja.md) | カーネルの Worker、システムコール、仮想のネットワーク、外への HTTP、起動時の中身。 |
| [ファイルシステム](filesystem.ja.md) | メモリ上のファイルシステム。inode、モード、リンク、エラー、監視。 |
| [プロセス](processes.ja.md) | プロセス、ファイル記述子、パイプ、端末、シグナル。 |
| [シェルとコマンド](shell.ja.md) | `sh` の文法と組み込みコマンド、すべてのコマンドとそのオプション。 |
| [パッケージマネージャ](package-managers.ja.md) | 組み込みの `npm`・`pnpm`・`yarn`・`bun`。コマンド、インストール、lockfile、スクリプト。 |
| [ネイティブのモジュール](native-modules.ja.md) | WebAssembly 版、WASI、napi-rs と emnapi、互換パッケージ。 |
| [Node.js の層](nodejs-runtime.ja.md) | Worker の中で Node.js が動くしくみ。起動、イベントループ、モジュール、TypeScript、fetch、worker。 |
| [バインディング](bindings.ja.md) | すべての `internalBinding()` のモジュールと、その状態。 |

## 開発に加わる

| ページ | 中身 |
|---|---|
| [ビルドと保守](building.ja.md) | ビルドのスクリプト、生成するデータ、Node.js の新しい版への追従、リリース。 |
| [試験](testing.ja.md) | 単体の試験、端から端までの試験、Node.js 自身の試験、Astro のコーパス。 |

## 互換性の約束

1.0.0 から、ホスト API（`dist/host` と型定義）と埋め込みの条件は、セマンティック バージョニングに従います。
「中のしくみ」のページと [通信の形式](protocol.ja.md) に書いた内部は、どのリリースでも変わることがあります。
[変更履歴](../../CHANGELOG.md) を見てください。
