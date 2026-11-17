# ADR-0467 パスキーのサーバーの窓口は、始めの2つの道を設定で切り替え、UV の門を窓口に置き、GoTrue は `fetch` で直に呼ぶ

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/lib/auth/passkey-start-mode.ts`、`passkey-start-config.ts`、`passkey-uv.ts`、`passkey-gotrue.ts`、`src/features/auth/schemas/passkey.ts`、`src/lib/build-env-guard.ts` | 基準コミット: 4f3c67b4

## 概要

ログインの終わりは必ずアプリの窓口を通す。始めは、サーバーが `sb_secret_` の鍵で GoTrue を呼ぶ道 (a) と、ブラウザが直に呼ぶ道 (b) を、設定 `NEXT_PUBLIC_PASSKEY_START_MODE` で切り替える（既定は (a)）。UV の確かめはログインの終わりで GoTrue を呼ぶ前に行い、GoTrue へは supabase-js でなく `fetch` で直に呼ぶ。以降のタスクがこの文書に判断を足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-042、THR-AUTH-043、SEC-AUTH-044、DD-AUTH-051 |
| 対象のコード | `src/lib/auth/passkey-start-mode.ts`、`passkey-start-config.ts`、`passkey-uv.ts`、`passkey-gotrue.ts`、`src/features/auth/schemas/passkey.ts`、`src/lib/build-env-guard.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（4-2・5-1・5-3）、[段1b の計画](../../superpowers/plans/2026-11-17-passkey-stage1b-server-endpoints.md)、[ADR-0464](ADR-0464-access-token-hook-single-gate.md) |
| 試験 | 単体 `tests/unit/lib/auth/passkey-*.test.ts`、`tests/unit/features/auth/schemas/passkey.test.ts`、`tests/unit/lib/build-env-guard.test.ts` |
| 調べた時点 | 2026-11-17（手元で単体の試験を流した。窓口の E2E は Task 3・6 で足す） |

## 判断

### ADR-0467 パスキーのサーバーの窓口は、始めの2つの道を設定で切り替え、UV の門を窓口に置き、GoTrue は `fetch` で直に呼ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-042 |
| 根拠 | ログインの終わりをブラウザの直の呼び出しにすると、UV の門・認めた鍵の確かめ・アプリのセッションの結び付けを通らずに入れる。始めは GoTrue の回数の制限をお客さんごとに掛けるために IP が要り、サーバーから呼ぶなら `sb_secret_` の鍵と `Sb-Forwarded-For` が要る。本番の鍵の形が分からないので、どちらの道でも作れるようにして切り替える（設計 5-1） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-1・5-3）、`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/task-2-brief.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| パスキーの終わりの確かめ | 無し（パスワード＋TOTP） | 確かめていない（Shopify の公式資料でスタッフのパスキーの実装を読んでいない） | サーバーが署名・`userVerification`・認めた鍵を確かめる（WebAuthn Level 2 の 7.2 の考え方） | 終わりは必ずアプリの窓口を通し、UV の印が無ければ GoTrue を呼ばずに断る |
| 始めの回数の制限 | 無し | - | 呼び手の IP ごとに数える | サーバーが IP を添える (a) か、見えない Turnstile を付けるブラウザの直の呼び出し (b) |

#### 決定

- 始めの切り替えは設定 `NEXT_PUBLIC_PASSKEY_START_MODE`（`server`｜`browser`、既定 `server`）の1つ。ブラウザの部品とサーバーの窓口が同じ値を読み、2つの変数の食い違いを無くす。値はビルドで埋め込まれるので、切り替えは再デプロイが要る
- 始め (a) の鍵は、新しい変数 `SUPABASE_SECRET_KEY` を先に、無ければ `SUPABASE_SERVICE_ROLE_KEY` が `sb_secret_` の形ならそれを使う。本番の鍵の形を読んでいなくても、どちらでも動く。別の窓口の鍵は今のまま
- 手元の開発用の IP `PASSKEY_START_DEV_IP` は、手元の Supabase の住所のときだけ使い、本番・プレビューに残れば `next build`・`next start` を止める
- GoTrue は supabase-js でなく `fetch` で直に呼ぶ。supabase-js のパスキーの関数は更新トークンつきの session をメモリに持たないと動かず、窓口は要求の Cookie のアクセストークンだけを持つため。路・本文の形は `@supabase/auth-js` の実装（2.119.0）から写し、誤りの本文の形を supabase-js とそろえるため `X-Supabase-Api-Version: 2024-01-01` を付ける
- 登録の終わりで UV の印を読むため、自前の小さな CBOR の読み取りを足す（外のライブラリを足さない）。これは安全の門でなく、PIN の無い鍵を2本登録して「数だけ2本で入れない」状態になるのを避ける使い勝手の守り

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 始めを (b) だけにする | Turnstile の確かめが画面に出る。設計は (a) を既定にし、IP の信頼を `getClientIp` の1か所に置く |
| 古い `service_role` の JWT で (a) を呼ぶ | 添え書き `Sb-Forwarded-For` が効かず、全員が1つの IP になる |
| 設定を `server` 側と `NEXT_PUBLIC_` 側の2つにする | 2つの値が食い違い、画面とサーバーの道が別になる |
| 登録・一覧・削除も supabase-js で呼ぶ | session をメモリに持てず、アクセストークンだけでは動かない |
| 外の CBOR のライブラリを足す | 読む形が小さく、依存を増やす理由が無い |

#### 結果

- 良くなること: 鍵の形・IP・UV の読み方・GoTrue の呼び方が1か所にそろい、窓口は閉じる側に倒しやすい
- 悪くなること: 本番の `SUPABASE_SERVICE_ROLE_KEY` が JWT の形だと、`SUPABASE_SECRET_KEY` を足すまで (a) は動かない（閉じる側）。自前の CBOR の読み取りは小さいが、保守の対象が増える
- 見直す条件: 本番の鍵の形が分かった時（設計 8-2）。GoTrue の更新で路・本文が変わった時
