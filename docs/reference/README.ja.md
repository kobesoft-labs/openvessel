# OpenVessel リファレンス

[English](README.md)

OpenVessel の詳しい技術文書です。ホスト API のすべてのオプション、埋め込みとデプロイの要件、コンポーネント間の
通信プロトコル、そしてタブの中で動く各部分（カーネル、ファイルシステム、プロセス、シェル、パッケージマネージャ、
ネイティブモジュール、Node.js ランタイム）の仕組みを説明しています。内容はこのリポジトリにある OpenVessel に
基づいています（バージョンは `package.json`、移植している Node.js のバージョンは `openvessel.node` を参照してください）。

全体像を先に知りたい場合は [OpenVessel の仕組み](../how-it-works.ja.md) を、ブラウザで動くものと動かないものについては
[互換性](../compatibility.ja.md) を読んでください。

## はじめに

[はじめに](getting-started.ja.md) では、空のページから `npm install`、`astro build`、プレビューの表示までを
説明しています。配信するファイル、必要なヘッダー、最初の `boot()` もここで扱います。

## 組み込む

- [ホスト API](host-api.ja.md): `OpenVessel.boot()` とすべてのオプション、ファイル、プロセス、イベント、プレビュー、エラー
- [ネットワークポリシー](network-policy.ja.md): モード、プリセット、許可・拒否パターンの書き方、判定の順序、許可の確認ダイアログ
- [デプロイ](deployment.ja.md): 3 つのオリジン、`dist/` のファイル、必要なヘッダーの一覧、ヘッダーを設定できないホスト
- [プレビュー](preview.ja.md): 仮想ポートの開発サーバーを iframe に表示する仕組み、HTTP と WebSocket の中継、URL
- [通信プロトコル](protocol.ja.md): ホストページ、ランタイム、プレビュー、プロセスの間でやり取りするメッセージ

## 内部の仕組み

- [カーネル](kernel.ja.md): カーネルの Worker、システムコール、仮想ネットワーク、外部への HTTP、起動時のシステム
- [ファイルシステム](filesystem.ja.md): メモリ上のファイルシステム。inode、モード、リンク、エラー、監視
- [プロセス](processes.ja.md): プロセス、ファイル記述子、パイプ、端末、シグナル
- [シェルとコマンド](shell.ja.md): `sh` の文法と組み込みコマンド、すべてのコマンドとそのオプション
- [パッケージマネージャ](package-managers.ja.md): 組み込みの `npm`・`pnpm`・`yarn`・`bun`。コマンド、インストール、lockfile、スクリプト
- [ネイティブモジュール](native-modules.ja.md): WebAssembly ビルド、WASI、napi-rs と emnapi、互換パッケージ
- [Node.js ランタイム](nodejs-runtime.ja.md): Worker の中で Node.js を動かす仕組み。起動、イベントループ、モジュール、TypeScript、fetch、worker
- [バインディング](bindings.ja.md): すべての `internalBinding()` モジュールとその実装状況

## 開発に参加する

- [ビルドと保守](building.ja.md): ビルドスクリプト、生成データ、Node.js の新しいバージョンへの追従、リリース
- [テスト](testing.ja.md): 単体テスト、E2E テスト、Node.js 本体のテストスイート、Astro のコーパス

## 互換性の約束

1.0.0 以降、ホスト API（`dist/host` と型定義）と埋め込みの要件はセマンティック バージョニングに従います。
「内部の仕組み」のページと [通信プロトコル](protocol.ja.md) で説明している内部の実装は、どのリリースでも変わる
可能性があります。詳しくは [変更履歴](../../CHANGELOG.md) を参照してください。
