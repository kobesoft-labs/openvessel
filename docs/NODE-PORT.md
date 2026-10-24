# Node の移植（方針 A）

2026-10-23 決定。手書きの組み込みモジュール（旧 `src/node/`）をやめ、**Node v22.20.0 の `lib/` をそのまま動かす**。
本来 C++ で書かれている部分（`internalBinding`）を、OpenVessel のカーネル（OS の層）の上に TypeScript で書く。

```
Node の lib/*.js（変更しない）         ← vendor/node（版を固定して取ってくる）
  ├ primordials・realm・bootstrap/node・main/*
internalBinding（ここを書く）           ← src/node/bindings/*.ts
  ├ fs・buffer・process_methods・timers・task_queue・stream_wrap・pipe_wrap・tty_wrap
  ├ process_wrap・spawn_sync・tcp_wrap・module_wrap・contextify・url・util・types …
差し替え（最小限・一覧で管理）          ← src/node/overrides/*.js
  ├ fetch（undici でなく関所つきの fetch）・TypeScript の型の除去（amaro でなく sucrase）
OS の層（カーネル・残す）               ← src/kernel/
  ├ VFS・プロセス・パイプ・TTY・socketpair・仮想ポート・sh・npm・ESM の配信・通信の関所
```

## 決めたこと

- **lib は書き換えない**。動かないものはバインディング側で合わせる。どうしても無理なものだけ `overrides/` に置き、理由を書く
- 版は `src/node/version.ts` の 1 か所。`scripts/fetch-node.mjs` が `vendor/node`（git の外）に取る。ライセンスは Node の LICENSE を dist に同梱
- 定数の表（オプションの既定値・uv の errno・各種 constants・http のメソッド・crypto/zlib の定数など）は、本物の Node（`npx node@22.20.0 --expose-internals`）から `scripts/gen-node-data.mjs` で吸い出して `src/node/data/*.json` にする。手で書かない
- 起動の速さ: lib 全体をビルド時に 1 つのファイルに束ね（各モジュールは関数のまま、評価は使う時）、Worker の読み込みに V8 のコードキャッシュを効かせる。起動時間を計り続ける（目標: `node -e 0` が 30ms 以内）

## 実行のモデル（libuv の代わり）

- **イベントループ**: ハンドル（ref/unref・active）とリクエストを数え、ゼロで `beforeExit` → 再確認 → `exit`。タイマーは `timers` バインディング（`scheduleTimer`・`processTimers`）、即時は `immediateInfo`
- **コールバックの入口**: ループから JS を呼ぶ入口（タイマー・I/O・メッセージ）はすべて `callbackScope` を通し、終わったら Node の tick の処理（`processTicksAndRejections`）を呼ぶ。C++ の `InternalCallbackScope` にあたる
- **Promise の拒否**: Worker の `unhandledrejection`／`rejectionhandled` を、`setPromiseRejectCallback` の 0（ハンドラ無し）／1（後から付いた）に読み替える
- **同期の syscall**: いまの SharedArrayBuffer + `Atomics.wait` のまま。非同期の fs は同期の syscall を呼んで次のターンに `oncomplete`

## 難所と方針

| 部分 | 方針 |
|---|---|
| ESM（`module_wrap`） | `ModuleWrap` を JS で書く。ソースはカーネルに登録し、R の SW がブラウザの本物の ESM として配る。リンクは import の指定子をリンク先の URL に書き換えて表す。合成モジュール（`node:fs` など）は `export let` と setter で生きた束縛を作る。`import.meta` と動的 import は Node のコールバックへつなぐ。同期の評価（`require(esm)`）は ESM→CJS 変換で |
| CJS（`contextify.compileFunctionForCJSLoader`） | 関数で包んで評価。`sourceURL` を付ける。ESM の構文の検出は es-module-lexer |
| ストリーム（`stream_wrap`・`pipe_wrap`・`tty_wrap`） | カーネルの fd の読み（readStart/readStop）と書きに載せる。`streamBaseState` と `onread` は Node と同じ形 |
| 子プロセス（`process_wrap`・`spawn_sync`） | カーネルの spawn。IPC は socketpair（`NODE_CHANNEL_FD`）。親子の JSON のやり取りは lib の JS がそのまま行う |
| ネット（`tcp_wrap`・`cares_wrap`） | 仮想ポート（listen/accept/connect）。外への TCP は張れないので、HTTP の中身を読んで関所の fetch に読み替える（後の段） |
| `worker` | カーネルのスレッド（Web Worker）。その中で `main/worker_thread.js` を起こす。MessagePort はブラウザの物に Node の口を付ける |
| `zlib` | pako の zlib の移植（z_stream 単位で Node と同じ）。Brotli は WASM |
| `crypto` | ハッシュ・HMAC・乱数・PBKDF2/scrypt/HKDF・AES は @noble。WebCrypto はブラウザの物。鍵の生成・署名は段階的に |
| `vm` | 新しい realm は作れないので、`with` とプロキシで近似。範囲を文書に書く |
| `util`（Promise の状態・Proxy の中身・反復子の中身） | ブラウザから見えないので「分からない」を返す（inspect の表示が Node と違う箇所として一覧に残す） |

## 段階

1. 起動: `node -e "console.log(1)"` が Node の lib で動く（primordials・realm・bootstrap・options・process・console・timers・tick）
2. fs・buffer・process の stdio・child_process → `npm run` と sh との行き来
3. CJS・ESM（ModuleWrap）→ Astro の build
4. net・http（仮想ポート）→ `astro dev` と HMR
5. worker_threads・zlib・crypto・fetch
6. Node の試験（test/node-compat）とコーパス（corpus/）で旧実装（1259 本中 494 本・Astro 5/6 の 100 本中 79 本前後）を超えたら、旧 `src/node/` を消す

各段で `test/node-compat` の数字を記録する（`docs/compatibility.ja.md`）。
