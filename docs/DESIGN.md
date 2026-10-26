# OpenVessel 設計

ブラウザの中で Node.js 風の環境を動かし、Astro のサイトを `npm install` → `astro build` / `astro dev` してプレビューするための OSS 部品。
WebContainer とは独立に（中身を見ずに）作る。

## 0. 目標と範囲

| する | しない |
|---|---|
| Astro のサイト 100 本（公開テーマ・examples）が `npm install && npm run build` で通る。**対象は Astro 7・6・5**（Vite 8/7/6。7 は rolldown を wasm32-wasi で） | Node の全機能の再現 |
| `astro dev` のプレビュー（HMR 込み）を iframe に出す | 実際のポートを外に開ける（どこにも listen しない） |
| POSIX 風のディレクトリ（`/bin` `/usr` `/home` `/tmp` `/dev`）と、よく使う CLI（sh・ls・cat・grep…） | bash の完全互換 |
| npm（install・ci・run・exec）と、pnpm・yarn・bun の呼び名 | ネイティブアドオン（`.node`）の実行 |
| 外への通信（許可リスト＋その都度の許可） | Cloudflare など外部サービスとの連携 |

## 1. オリジンの分け方（いちばん大事）

```
ホストのページ（埋め込む側のアプリ）           origin H
 ├ ランタイムの iframe（見えない）            origin R   runtime.html + sw.js
 │    ├ カーネル（Web Worker）                 VFS・プロセス表・パイプ・TTY・sh/coreutils/npm
 │    ├ プロセス（Web Worker 1 つ = node 1 つ） Node 互換の層・同期の syscall（SharedArrayBuffer）
 │    └ SW（R）                                ESM の配信・外部通信の制御
 ├ 中継の iframe（見えない）                  origin P   relay.html + sw.js
 └ プレビューの iframe                        origin P   SW が仮想のサーバーへ橋渡し
```

- **H・R・P は全部別のオリジン**にする。P（プレビュー）にはサイトのコードと、サイトに入っている外のスクリプト（解析タグなど）が載るので、いちばん信用しない
- R にはユーザーのコードと npm の依存が載る。ユーザーは自分のコードを自分のブラウザでいじる前提なので、R のコードは「ユーザーの持ち物」として扱う。ただし **外への通信だけはネットワークポリシーで制御する**（npm の依存に悪いものが混ざっていても、勝手に外へ出せない）
- 多人数で使うとき（例: Cocoro）は、P を `https://{session}.preview.example` のように **セッションごとのサブドメイン** にする（プレビュー同士が同じオリジンにならないように）

### 1.1 プレビュー（P）から攻撃させない

| 経路 | 守り |
|---|---|
| P → H の画面・クッキー | 別オリジン。iframe は `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`（トップの移動はさせない） |
| P → R（カーネル） | P が持てるのは「仮想サーバーへの HTTP / WebSocket」だけの口。口の上で受ける命令は `http-request`・`ws-*` だけ。ファイルの読み書き・プロセスの起動・通信の許可は、この口からはできない（中継の iframe を P のスクリプトに乗っ取られても同じ） |
| P が R の runtime.html を自分で埋め込む | runtime.html は `frame-ancestors` で H だけに絞る。さらに起動時に `ancestorOrigins` を確かめる |
| P から許可のダイアログを連打 | 同じオリジンへの問い合わせはまとめる。「このセッションは全部断る」を用意 |

### 1.2 R の中のコードを外へ勝手に出さない

- R で配る全部の文書・Worker に CSP `connect-src 'self'` を付ける。プロセスの中の `fetch`・`WebSocket`・`EventSource` は、R の外へ直接届かない
- 外へ出るのは **R の SW の `/__ov/net` だけ**。SW が方針（§5）を見て、許可されたものだけ本物の `fetch` をする
- 方針を変えられるのは H だけ（ランタイムの iframe の専用の口から）。SW は Worker からの「許可」を受けない（送り主が window か確かめる）
- npm の tarball のキャッシュ（R の Cache Storage）は、取り出すたびに `integrity`（sha512）を確かめる（R の中の悪いコードがキャッシュを書き換えても効かない）

## 2. カーネル（Web Worker）

TypeScript。1 つの Worker に、次をまとめて持つ。

- **VFS**: メモリ上の inode の木。ファイル・ディレクトリ・シンボリックリンク・`/dev/null|zero|random|urandom|tty`。mtime・mode・nlink。変更の通知（`fs.watch` 用）
- **プロセス表**: pid・ppid・pgid・argv・env・cwd・fd 表・終了コード・待ち合わせ
- **パイプ・TTY**: TTY は行の規律（エコー・行の編集・Ctrl-C で SIGINT・Ctrl-D で EOF・生モード）
- **カーネルの中で動くプログラム**（Worker を起こさない・非同期の関数）: `sh`（bash の名でも）・coreutils 一式・`npm`／`npx`／`pnpm`／`yarn`／`bun`（名前の読み替え）・`curl`
- **ESM の配信**: SW から「このファイルを ESM として」と頼まれたら、解決・書き換えをして返す（§3.3）
- **仮想のポート**: `listen(port)` を受けて、プレビューからの要求を、そのプロセスへ渡す

## 3. プロセス（Node 互換の層）

### 3.1 同期の syscall

Node の API は同期のもの（`fs.readFileSync`・`require`）が多いので、プロセスの Worker ↔ カーネルを **SharedArrayBuffer + `Atomics.wait`** でつなぐ。

- プロセスごとに 4 MB の共有の箱。頼みごと（JSON の頭＋バイナリ）を書いて、カーネルへ合図（postMessage）、`Atomics.wait` で待つ
- カーネルは答えを書いて `Atomics.notify`。箱より大きいものは分けて受け渡す
- 非同期の API（`fs.promises`・コールバック）も、中では同じ同期の syscall を呼ぶ（次のティックで返す）
- 待ちが要るもの（パイプの読み・子の終了・`spawnSync`）は、カーネルが答えを後回しにする

このため H は **cross-origin isolated**（COOP: same-origin・COEP: require-corp か credentialless）で、ランタイムの iframe に `allow="cross-origin-isolated"` を付ける必要がある。

### 3.2 CommonJS

Node の CJS の読み込み（`Module._load`・`_resolveFilename`・`_extensions`・`require.cache`・`createRequire`）を自前で持つ。中身は `new Function` で包む。

### 3.3 ES Modules（ブラウザの本物の ESM を使う）

- `import()` の先を `/__ov/esm/<絶対パス>` の URL にして、**R の SW が配る**。SW はカーネルに頼み、カーネルが:
  - 静的な `import`／`export from` の指定子を、Node の解決（`exports`・`imports`・条件 `node`/`import`/`default`）で URL に書き換える
  - `node:fs` などは `/__ov/builtin/fs.mjs`（組み込みを名前つきで出す薄い殻）
  - `import.meta` を、`file://` の URL・`dirname`・`filename`・`resolve` を持つ物に差し替える
  - 動的な `import()` を `__ov_dimport()` に差し替える（`file://`・クエリ付き・実行時の指定子を扱うため）
  - CJS のファイルを ESM から読むときは、`cjs-module-lexer` で名前つきの export を見つけて殻を作る
- 循環・トップレベルの await・生きた束縛は、ブラウザのものがそのまま効く
- `require(esm)` は、ESM を CJS に変換して読む（トップレベルの await があるときは Node と同じく失敗）

### 3.4 組み込みモジュール

`fs`・`path`・`events`・`stream`・`buffer`・`util`・`os`・`url`・`crypto`（ハッシュは同期の JS 実装）・`zlib`（fflate）・`child_process`・`worker_threads`・`http(s)`（クライアントはネットワークポリシーを通る fetch・サーバーは仮想ポート）・`net`（仮想のソケット）・`module`・`process`・`readline`・`tty`・`assert`・`async_hooks`（AsyncLocalStorage）・`vm`・`wasi`・`perf_hooks`・`timers`・`string_decoder`・`querystring`・`v8`/`inspector`/`dns` など（使われる所だけ）。

### 3.5 ネイティブの依存は WASM 版へ読み替える

方針: **WASM 版があればそれを使う。無ければ JS の実装（純 JS の代わりの包み・既存の JS 版）で動かす。**

| 依存 | 読み替え |
|---|---|
| `esbuild` | `esbuild-wasm`（同じ版） |
| `rollup`（4 以降） | `@rollup/wasm-node`（同じ版） |
| `lightningcss` | `lightningcss-wasm` の Node 版（同期で使える） |
| napi-rs の物（`rolldown`・`@astrojs/compiler-rs`・`@tailwindcss/oxide` など。wasm32-wasi 版が任意の依存に無ければ、同じ版を足す） | 任意の依存の `*-wasm32-wasi` を入れ、`NAPI_RS_FORCE_WASI=1` で読ませる。`node:wasi`・`worker_threads`・共有メモリが要る |
| `sharp`（0.34） | `@img/sharp-wasm32` |
| `@astrojs/compiler` | 元から WASM（そのまま） |
| WASM 版が無いもの（`sass-embedded`・`@parcel/watcher`・`fsevents` など） | JS 版（`sass`）・JS の代わり（watch はカーネルの通知）・入れない |

## 4. npm

カーネルの中の自前の実装（本物の npm は動かさない）。

- `package.json` の依存を解決（semver・dist-tag）。lockfile（`package-lock.json`・`pnpm-lock.yaml`・`yarn.lock`・`bun.lock`）があれば、その版を優先
- 配置は npm と同じ平らな node_modules（ぶつかるときだけ入れ子）
- tarball は `integrity` を確かめ、`DecompressionStream` で解いて VFS へ。`.bin` のリンク
- **install のスクリプト（postinstall など）は既定で動かさない**
- 任意の依存は `os`/`cpu` で選ぶ（`cpu: wasm32` の物だけ入れる）。§3.5 の読み替え
- `npm run`（pre/post・`node_modules/.bin` を PATH に）・`npx`・`npm exec`

## 5. 外への通信の方針

```ts
network: {
  mode: 'ask' | 'allowlist' | 'allow-all',   // allow-all は「全部許可」
  presets: ['npm', 'fonts', 'icons', 'cdn', 'github'],
  allow: ['api.example.com', '*.example.org'],
  deny: [],
}
```

- 用意したセット: `npm`（registry.npmjs.org など）・`fonts`（Google Fonts・Bunny・Fontsource・Fontshare）・`icons`（Iconify）・`cdn`（jsDelivr・unpkg・cdnjs・esm.sh）・`github`（codeload・raw）
- セットに無いホストは `ask` なら H に問い合わせる（「1 回だけ」「このセッション」「いつも」「断る」）。`allowlist` なら断る
- R のプロセス・npm・プレビュー（P）のページからの外への読み込みの、どれにも同じ方針を使う
- CORS を返さない相手には、ブラウザの都合で届かない（任意で自前の中継の URL を設定できる）

## 6. ホストの API（H で使う）

```ts
const vessel = await OpenVessel.boot({ runtimeUrl, previewUrl, network });
await vessel.fs.writeFile('/home/user/app/package.json', '...');
await vessel.mount(files, { path: '/home/user/app' });
const p = await vessel.spawn('npm', ['install'], { cwd: '/home/user/app' });
p.output.pipeTo(...); await p.exit;
vessel.on('server-ready', ({ port, url }) => iframe.src = url);
vessel.on('permission-request', req => req.respond('session'));
```

## 7. 試し方

- `scripts/serve.mjs`: H・R・P を 3 つのポートで、正しいヘッダー付きで配る
- `playground/`: ファイルの木・ターミナル（xterm）・プレビュー・許可のダイアログ
- `test/`: カーネル（VFS・sh・semver・配置）の単体の試験は Node で
- `corpus/`: Astro のサイト 100 本の一覧と、ヘッドレスの Chrome で `npm install && npm run build` を流す仕掛け
