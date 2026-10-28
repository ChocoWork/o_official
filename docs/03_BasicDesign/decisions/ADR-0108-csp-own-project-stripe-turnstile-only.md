# ADR-0108 CSP は自分のプロジェクト・Stripe（全頁）・Turnstile だけを許し、使っていない CDN と外の画像のホストを許さない

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/proxy.ts`（共有） | 基準コミット: `90786822`（作業ツリー）

## 概要

CSP の許可先から、使っていない jsDelivr（4 か所）・`placehold.co`・`readdy.ai`・`*.readdy.ai`・全 Supabase プロジェクトを許す `*.supabase.co`（2 か所）を外す。許すのは自分のプロジェクトの Supabase の origin 1 つ、Stripe 公式の一覧に揃えた Stripe（全頁）、Turnstile、地図の枠だけにする。Stripe は決済の頁だけに絞らず全頁に残す（ユーザーの決定 Q29）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME・ABOUT・PRIVACY（コードは共有の `src/proxy.ts` で、どの領域の範囲のコードでもない） |
| 対応する ID | SEC-HOME-009、SEC-ABOUT-003、SEC-PRIVACY-014 |
| 対象のコード | `src/proxy.ts` の `buildCsp`（`script-src`・`style-src`・`style-src-elem`・`font-src`・`img-src`・`connect-src`・`frame-src`）、`next.config.ts` の `images`（`remotePatterns`・`minimumCacheTTL`） |
| 関連文書 | `docs/02_Requirements/areas/{home,about,privacy}.md`、`docs/05_Quality/security/threats/{home,about,privacy}.md`、`docs/03_BasicDesign/decisions/ADR-0104-csp-style-attr-unsafe-inline-elem-self.md`、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 7、P12）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q29）、Stripe 公式 <https://docs.stripe.com/security/guide> |
| 調べた時点 | 2026-10-28（`buildCsp` の単体試験と、`/`・`/privacy`・`/checkout`・`/api/auth/login` での各指令の固定は流した。E2E は書いただけで流していない） |

## 判断

### ADR-0108 CSP は自分のプロジェクト・Stripe（全頁）・Turnstile だけを許し、使っていない CDN と外の画像のホストを許さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-009、SEC-ABOUT-003、SEC-PRIVACY-014 |
| 根拠 | 使っていない CDN を許すと、そこが乗っ取られた時に全部の頁でスクリプトが動く。`*.supabase.co` を許すと、差し込みが通った時に他人の Supabase のプロジェクトへ情報を持ち出せる。CSP は文書を読み込んだ時に決まり `next/link` の画面の切り替えでは変わらないので、`/cart` から `Link` で `/checkout` へ進むと `/cart` の CSP のまま `loadStripe` が走る。Stripe の許可を決済の頁だけに絞ると決済の部品が止まる（Q29） |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q29）、`design-final.md`（R9） |

#### 背景

- CSP は全部の頁に同じ 1 つの方針で付く（`proxy` が全部の応答に付ける）。`src` は jsDelivr・`placehold.co`・`readdy.ai` を読んでいなかった（`/ui` の `readdy.ai` の画像 7 か所は先に `public/` の手元の画像へ替えた。`DD-HOME-004`）
- Stripe.js を実際に読むのは `/checkout` 配下の `FinalConfirmationStep` の `loadStripe` だけ
- 以前の Stripe の許可は `script-src` の `js.stripe.com` と `frame-src` の `js.stripe.com`・`hooks.stripe.com`。Stripe 公式は `*.js.stripe.com` も `script-src`・`frame-src` に挙げる（Stripe.js が別のオリジンで枠を先に起動して速くするため）

#### 決定

- `script-src` は `'self'`・nonce・（開発のみ `'unsafe-eval'`）・`https://challenges.cloudflare.com`・`https://js.stripe.com`・`https://*.js.stripe.com`
- `style-src` は `'self'`・`'unsafe-inline'`、`style-src-elem` は `'self'`（開発のみ `'unsafe-inline'`）、`font-src` は `'self'`（jsDelivr を外す。`ADR-0104` の style 属性と style 要素の分け方は変えない）
- `img-src` は `'self'`・`data:`・自分の Supabase の origin・`https://q.stripe.com`・`https://*.stripe.com`
- `connect-src` は `'self'`・（開発のみ `ws:`・`wss:`）・自分の Supabase の origin・Turnstile・`https://api.stripe.com`・`https://r.stripe.com`・`https://m.stripe.network`・`https://q.stripe.com`
- `frame-src` は Turnstile・`https://js.stripe.com`・`https://*.js.stripe.com`・`https://hooks.stripe.com`・`https://www.google.com`・`https://maps.google.com`
- 自分の Supabase の origin は `NEXT_PUBLIC_SUPABASE_URL`、無ければ `SUPABASE_URL`（今の `||` の順）。2 つの変数が別の origin を指す設定は、署名つきの画像の host と食い違うので、ビルドで落とす（`next.config.ts` の `assertBuildEnv`。2026-10-28、`ADR-0206`・`DD-ABOUT-002`）
- 画像の中継（`next.config.ts` の `images`、2026-10-28 に追記）: `remotePatterns` は、ビルド時の `NEXT_PUBLIC_SUPABASE_URL` の host 1 つの `/storage/v1/object/sign/**`（署名つきの道）だけにする。`placehold.co`・`readdy.ai`・`public.readdy.ai`・全プロジェクトを許す `*.supabase.co`（`public`・`sign`・`authenticated` の 3 本）は外す。`public` の道は本番のバケットが非公開なので入れず、`authenticated` の道は `next/image` が認証の見出しを付けられないので入れない。手元の Supabase につないだビルドだけ、手元の枝（`dangerouslyAllowLocalIP` と `/storage/v1/object/**`）を足す。最適化した画像のキャッシュ `minimumCacheTTL` は、署名つき URL の期限と同じ 3600 秒にする（既定の 4 時間だと、期限が切れた後も最適化の結果が残る）。CSP の `img-src` と同じ「自分のプロジェクト 1 つだけ」の考え方に揃える

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| Stripe の許可を `/checkout` 配下だけにする | `next/link` の遷移で CSP が変わらず、`/cart` から進むと決済の部品が止まる。全頁で同じ方針にする設計とも合わない |
| Stripe.js を全頁で読み込む | 許可を残すだけで十分。読み込みは今までどおり決済の頁だけ（Q29） |
| `'strict-dynamic'` を足す | Turnstile の `<Script>` に nonce が付くかを本番ビルドで確かめてからの別件 |
| Link（`link.com`）・Google マップの鍵の許可を足す | 今は使っていない。本番で Link が有効なら決済の部品が止められる可能性があるので、本番の前に確かめる |
| `*.supabase.co` を残す | 他人のプロジェクトへの持ち出し先になる。管理画面の署名つきの画像は自分の origin で足りる |

#### 結果

- 良くなること: 許可先が実際に使う物だけになり、CDN の乗っ取りや他の Supabase への持ち出しが CSP で止まる。Stripe 公式の一覧と同じになる
- 悪くなること: 本番の Stripe アカウントで Link が有効だと `link.com` の枠が止められる可能性がある（テストモードの `FR-CHECKOUT-025` では出ていない）。許可先を増やす時は `buildCsp` を直す
- CSP は全部の頁で共有なので、この判断は HOME・ABOUT・PRIVACY のほか全頁に効く

## 未確認事項

- 本番の Stripe アカウントで Link が有効な時の CSP の違反
- 本番ビルドの `/cart` → `/checkout` の経路で外部リソースの違反が 0 件かの実測（E2E `SEC-HOME-009-AC-03`）
