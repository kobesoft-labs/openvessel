# 参照している Node.js の版

| 項目 | 値 |
|---|---|
| **いまの版** | **v22.23.4**（22 系 LTS "Jod"） |
| 取り込んだ日 | 2026-10-24（初回 2026-10-23 に v22.20.0） |
| 固定している場所 | `src/node/version.ts`（ここだけ。ほかはすべてここを読む） |
| 取り込み元 | 公式 Docker イメージ `node:<版>-bookworm-slim`（linux/amd64）。lib と deps のソースは、その Node が持つ `internalBinding('builtins').natives` から取る |
| 取り込んだもの | `vendor/node/natives.json`（lib と deps。git の外）・`vendor/node/LICENSE`・`src/node/data/bindings.json`（バインディングの形と定数）・`src/node/data/process.json`（versions・オプションの既定値など） |
| 試験の版 | `test/node-compat/.node`（同じ版の `test/` を `test/node-compat/fetch.mjs` で取る） |

## 新しい版に追従するとき

1. 差分を見る: `node scripts/node-upgrade-check.mjs <新しい版>` → `docs/node-upgrades/<いま>-to-<新しい版>.md`
   - lib の変わったファイル（バインディングの使い方が変わったものに印）、増えた・消えたモジュール
   - バインディングの関数・定数・クラスのメソッドの増減（`src/nodejs/bindings/` で直す所）
   - CLI オプションの増減と既定値の変化、同梱の依存の版（`process.versions`）
2. `src/node/version.ts` の版を変える
3. `node scripts/gen-node-data.mjs`（Docker が要る）→ `node scripts/regen-fixtures.mjs`（バインディングの単体の試験の期待値を新しい版から取り直す）→ `node test/node-compat/fetch.mjs`（Node の試験も同じ版に）
4. 差分の報告に出たバインディングの変化を `src/nodejs/bindings/` に反映し、`src/nodejs/overrides/` の差し替えが新しい lib と合っているか見る
5. `node scripts/build.mjs` → `node test/node-compat/run.mjs --baseline` → `node test/node-compat/run.mjs` → `node corpus/run.mjs` で、前の版の数字から下がっていないか確かめる
6. この文書の「いまの版」と下の履歴を書き換える

## 履歴

| 日付 | 版 | メモ |
|---|---|---|
| 2026-10-23 | v22.20.0 | 方針 A（Node の lib をそのまま動かす）で取り込み開始 |
| 2026-10-24 | v22.23.4 | Astro 7 が Node >=22.23.4 を要求するため。差分は [node-upgrades/22.20.0-to-22.23.4.md](node-upgrades/22.20.0-to-22.23.4.md)（lib 105 ファイル、バインディング 15 件）。直したもの: buffer `createUnsafeArrayBuffer`、encoding `decodeWindows1252`（`decodeLatin1` の後継）、errors `getErrorSourcePositions`、crypto の証明書まわりの関数、OpenSSL 3.5.9 の CCM の `final`・ChaCha20-Poly1305 の遅い AAD の拒否 |
