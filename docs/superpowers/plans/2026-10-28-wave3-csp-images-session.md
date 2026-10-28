# 波 3 共有の守り（CSP・画像の中継・画像の署名・session_id の発行範囲・/api/auth の no-store）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）の波 3 を直す。(1) 画像の署名つき URL（`item/look/news-images.ts`）を、置き場の道筋と自分のホストを確かめる共有の関数 `parseOwnObjectPath` を通し、確かめに失敗・署名に失敗したら元の値を返さず `null` にし、ITEM の期限を 7 日から 3600 秒にする（R8: SEC-SEARCH-014・015・016、SEC-LOOK-007・008、SEC-NEWS-007・008、SEC-HOME-006・007）。(2) `src/proxy.ts` の CSP から使っていない jsDelivr・`placehold.co`・`readdy.ai`・全 Supabase プロジェクトを許す `*.supabase.co` を外し、Stripe 系は全頁に残して Stripe 公式の一覧に揃える（R9: SEC-HOME-009-AC-01、SEC-ABOUT-003-AC-01、SEC-PRIVACY-014、Q29）。(3) `next.config.ts` の `images` を自分のプロジェクトの署名つきの道だけに絞り、`minimumCacheTTL: 3600` を付け、本番ビルドで必須の環境変数が無ければ落とす（SEC-HOME-017、SEC-NEWS-004-AC-02・023、SEC-ABOUT-003-AC-02・007）。(4) `/ui` の見本ページの外部画像を `public/` の手元の画像に替える（Q6）。(5) LOOK の `og:image` を署名を含まない同一オリジンの `/look/[id]/og` にする（SEC-LOOK-006、Q10）。(6) ブラウザ側の zod を `jitless` にして CSP の `eval` 違反を無くす（SEC-HOME-009-AC-02、Q25）。(7) `session_id` を `/cart`・`/checkout`・`/api/checkout` だけで発行する（SEC-PRIVACY-015、Q23）。(8) `/api/auth` 配下の応答に `Cache-Control: no-store` を付ける（SEC-AUTH-022-AC-02）。

**Architecture:** 共有部品を触る波。`src/proxy.ts`（Task 7・9・10）と `next.config.ts`（Task 8・13）は全頁・全領域に効くので、同じファイルを触るタスクは**直列**にする（並行にしない）。画像の署名は、新しい共有の関数 `src/lib/storage/safe-object-path.ts` を先に足し（Task 1）、署名を受け取る側（画面・API）を `null` を受けられる形に直してから（Task 2）、ITEM（Task 3）・LOOK（Task 4）・NEWS（Task 5）の順に fail-closed にする。この順なら途中で木が赤くならない（先に `null` を出すと、`/cart` などの `next/image` が空の `src` で落ちる）。CSP と画像の中継は、先に `/ui` の外部画像を消してから（Task 6）許可先を減らす（Task 7・8）。新しい窓口は `/look/[id]/og` の 1 本だけ（Task 11）。DB の移行はない。

**Tech Stack:** Next.js `^16.3.6`（App Router・`proxy.ts`・`next.config.ts` の `images`・Route Handler）、React `^19`、TypeScript、Supabase Storage（`createSignedUrl`・`download`）、zod `^4.3.6`（`z.config({ jitless: true })`）、Jest（単体・結合）、Playwright（書くだけ。流すのは controller）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md)（ユーザー答え Q29・Q23・Q6 と、推奨で進める Q10・Q25。**この文書が拘束する**）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R8・R9・R10・R18（PRIVACY-015）と §3-2 の波 3 の行・§3-3、領域別の `PRIVACY.md`・`HOME.md`・`ABOUT.md`・`LOOK.md`・`NEWS.md`・`SEARCH.md`。前の波の計画（書式の見本）: [`2026-10-26-wave1c-local-fixes.md`](./2026-10-26-wave1c-local-fixes.md)（コミット `a300074b`）、[`2026-10-26-wave2-local-fixes.md`](./2026-10-26-wave2-local-fixes.md)（コミット `ad3fe937`）。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-28。コード・DB・テストは 1 行も変えていない（この計画の作成だけ。読んだのは `src/`・`tests/`・`e2e/`・`supabase/migrations/`・本番の `SELECT` のみ） |
| 直す項目 | R8（SEARCH-014・015・016、LOOK-007・008、NEWS-007・008、HOME-006・007）、R9（HOME-009-AC-01・AC-02・017、NEWS-004-AC-02・023、LOOK-006、ABOUT-003-AC-01・AC-02・007、PRIVACY-014）、R18 の PRIVACY-015、R10 の AUTH-022-AC-02。Q29（Stripe は全頁に残す）・Q23・Q6・Q10・Q25 |
| タスク | 14 つ（共有の関数 1・受け手の null 対応 1・署名 ITEM/LOOK/NEWS 3・`/ui` 画像 1・CSP 1・`next.config.ts` 1・session_id 1・`/api/auth` no-store 1・`og` 窓口 1・zod 1・サイト URL の本番の確かめ 1・最終確認 1） |
| 新しいコード | `src/lib/storage/safe-object-path.ts`、`src/instrumentation-client.ts`、`src/app/look/[id]/og/route.ts`。窓口が 1 本増える（`route.ts`。共有文書の数の更新が要る。Task 11・14） |
| 新しい ADR | `ADR-0108`（HOME・CSP は自分のプロジェクトと Stripe・Turnstile だけを許す）、`ADR-0165`（LOOK・`og:image` の窓口）、`ADR-0316`（SEARCH・画像の署名は道筋を確かめ失敗は null）、`ADR-0355`（PRIVACY・`session_id` は許可リストの道だけで発行）、`ADR-0415`（AUTH・`/api/auth` の no-store は proxy で付ける）、`ADR-0206`（ABOUT・サイト URL は本番ビルドで必須）。番号は書く直前に `ls docs/03_BasicDesign/decisions` で再確認する（今の各帯の最大: HOME 0107・LOOK 0164・ABOUT 0205・SEARCH 0315・PRIVACY 0354・AUTH 0414・NEWS 0026） |
| 外す `test.fail` | 現在の行番号で 17 か所（各タスクの「E2E の印」に行ごとに書く）。**設計書の行番号から動いている**（1-B・1-C で外れた物と、行がずれた物がある。「設計書の印と今の印」の表） |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`db-migrations.md`・`er.md`。必要な変更は Task 14 の報告に書く（G-4 が共有の文書を持っている間は controller が反映する） |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`test:trace-coverage`・`validate-trace --update-baseline`・`next build`。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E は書くだけ。controller が最後に本番ビルドで流す（Task 14 の一覧）。`npm run trace:report` と `npm run test:trace-coverage` は実装者は流さず、controller が Task 14 の最後に流す（`.claude/CLAUDE.md` が範囲内の領域に求める） |
| 本番 | 本番の配備はこの計画の範囲外。配備前に Vercel の環境変数 `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SITE_URL` が要る（Task 13 が `VERCEL_ENV=production` のビルドを落とす） |

### 設計書の印と今の印（確かめた結果）

設計書の「確かめ方」の行番号は、波 1・波 2 の後で動いた。**現在の `e2e/` を読んで確かめた**。

| 設計書 | 今 | 状態 | タスク |
| --- | --- | --- | --- |
| R8 `FR-SEARCH-019:142`（SEARCH-014） | `FR-SEARCH-019:142` | 残っている | 3 |
| R8 `FR-SEARCH-021:273`（016） | `FR-SEARCH-021:283` | 残っている（10 行ずれ） | 3 |
| R8 `FR-SEARCH-021:383`（015） | `FR-SEARCH-021:393` | 残っている。商品（置き場に物が無い）と LOOK（外の URL）の両方を見るので、Task 3 と Task 4 の**両方**が終わって初めて反転する | 4 |
| R8 `FR-LOOK-SEC-001:357`（LOOK-007） | `FR-LOOK-SEC-001:362` | 残っている | 4 |
| R8 `FR-LOOK-SEC-001:389`（LOOK-008） | `FR-LOOK-SEC-001:394`（3 幅） | 残っている | 4 |
| R8 `FR-NEWS-SEC-001:388,400,413` | なし | **既に外れている**（NEWS-005 を 1-B・1-C で直した）。NEWS-007・008 には E2E の印が元々無い | 5 |
| R8 `FR-HOME-023:203,225`（HOME-006・007） | `FR-HOME-023:203`・`:225` | 残っている（3 幅の中の 2 本） | 3 |
| R9 `FR-HOME-022:94`（HOME-009-AC-01） | `FR-HOME-022:94` | 残っている。`connect-src` の `*.supabase.co` も外さないと反転しない | 7 |
| R9 `FR-HOME-022:118`（HOME-017） | `FR-HOME-022:118` | 残っている | 8 |
| R9 `FR-HOME-022:149`（HOME-009-AC-02、3 幅） | `FR-HOME-022:149` | 残っている。ブラウザの CSP 違反が**全部**消えて初めて反転する。zod の `eval` 以外の違反が残るかは実測が要る（Task 12 の注） | 12 |
| R9 `FR-ABOUT-010:76`（ABOUT-003-AC-01） | `FR-ABOUT-010:76` | 残っている | 7 |
| R9 `FR-ABOUT-010:102`（ABOUT-003-AC-02） | `FR-ABOUT-010:102` | 残っている | 8 |
| R9 `FR-PRIVACY-006:57`（PRIVACY-014-AC-02） | `FR-PRIVACY-006:57` | 残っている。**Q29 で要件と試験のほうを直す**（反転ではなく書き換え） | 7 |
| R9 `FR-NEWS-SEC-003:109`（NEWS-004-AC-02） | `FR-NEWS-SEC-003:109` | 残っている（`minimumCacheTTL`） | 8 |
| R9 `FR-NEWS-SEC-003:146`（NEWS-023） | `FR-NEWS-SEC-003:144` | 残っている | 8 |
| R9 `FR-LOOK-SEC-001:328`（LOOK-006-AC-02） | `FR-LOOK-SEC-001:333` | 残っている | 11 |
| R18 `FR-PRIVACY-006:68`（PRIVACY-015-AC-01） | `FR-PRIVACY-006:68` | 残っている（3 幅） | 9 |
| R10 `FR-LOGIN-030:210`（AUTH-022-AC-02） | `FR-LOGIN-030:235`（3 幅） | 残っている | 10 |
| R10 `FR-SEARCH-019:99`・`FR-NEWS-SEC-003:134,194`・`FR-STOCKIST-015:241` | なし | **1-C で外れた**（route 単位の no-store）。波 3 では `/api/auth` だけが残る | - |

## 前提の読み（決定文の解釈と、読んで確かめた事実。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | **`session_id` の読み手は全部、許可リスト `/cart`・`/checkout`・`/api/checkout` の中にある。許可リストの外で `session_id` が無くて壊れる所は見つからなかった。拡げない** | 読み手（Cookie の `session_id`）: ①`src/features/checkout/services/checkout-route-guard.ts:136`（`guardCheckoutPost`。`place-order/route.ts:148`・`promotion-code/route.ts:23`・`resume/route.ts:46` が呼ぶ。無ければ 400 `session_not_found`）、②`src/app/api/checkout/complete/route.ts:52`、③`src/app/api/checkout/create-session/route.ts:477`、④`src/lib/supabase/server.ts:22-28`（`createClient` が `x-session-id` に載せる。`extractSessionIdFromCookie` は `src/lib/auth/request-token.ts:61-67`）。書き手・消し手: `src/features/auth/services/register.ts:57`（ログインの成功で**必ず新しく発行して回す**。許可リストと無関係）、`src/app/api/auth/logout/route.ts:135,151`（消す）。④の先は `private.set_request_context()`（`remote_schema.sql:1247-1260`）が `app.session_id` にして、`carts`（`:3341-3357`）・`orders`/`order_items`（`:3604-3659`）・`wishlist`（`:3822-3832`）の「ゲストの古い session」の方針が使う。**ゲストがこれらの表に `createClient`（利用者の権限）で触る窓口は無い**: カート・お気に入りは `createServiceRoleClient` でゲストの別の印（`cart`・`wishlist` の Cookie）を使い（`src/app/api/cart/*`・`src/app/api/wishlist/*`、ゲストから会員への持ち越し `guest-shopping-merge.ts:24` もハッシュだけ）、決済の 5 窓口は `@supabase/supabase-js` の service role を直に作り（`complete:21`・`create-session:76`・`place-order:23`・`promotion-code:13`・`resume:23`）、注文の状況（`/api/order-status/*`・`/order-status/[token]`）は service role と確認印の token で `session_id` を使わず、顧客の `/api/orders`・`/api/orders/[id]` は `authenticateRequest` で会員を要求して `.eq('user_id', userId)` で絞る（`orders/route.ts:83-110`・`orders/[id]/route.ts:32-75`）。管理の窓口は `has_permission` で通る。つまり `x-session-id` / `app.session_id` に頼るのは今は決済の流れだけ |
| P2 | **`/cart` へ行く前に `/checkout` の API を直に叩く経路は、今も前も 400 になる**。proxy が Cookie を発行するのは応答であって、同じ要求の Cookie ではない（`proxy.ts:228-232` は `response.cookies.set` だけで、要求の見出しに足さない）ので、許可リストにしても「最初の `/api/checkout/*` の POST が 400」の動きは変わらない。ブラウザは `/cart`・`/checkout` の頁の応答で Cookie を受けてから API を呼ぶ | `checkout-route-guard.ts:136-139`。頁の遷移は `next/link`（`OrderSummary.tsx:61` → `Button.tsx:45`）でも要求は proxy を通る（matcher が `/:path*`）ので発行される |
| P3 | **決めた許可リストの動き**: `matchesPathSegment(pathname, prefix)` が `/cart`・`/checkout`・`/api/checkout` のどれかに当たる時だけ、Cookie が無ければ発行する。それ以外（`/`・`/about`・`/privacy`・`/terms`・`/news`・`/look`・`/item`・`/api/auth` ほか全部）は発行しない。既に Cookie がある要求は今までどおり何もしない。ログインの成功で回す `register.ts:57` と、ログアウトで消す `logout/route.ts` は変えない | Q23。`/cartx` のような境界の外れは `matchesPathSegment` が弾く。**ただし例外が 1 つ残る（ruling 10 で controller に確認）**: `register.ts:57` は、ログインの成功のたびに新しい `session_id` を発行して**許可リストの外の `/api/auth/*` の応答にも `Set-Cookie` を付ける**。Q23 の「他は発行しない」と文面では食い違う。残す理由は、ログイン前後で識別子を回すことがセッション固定の攻撃への守りで、`FR-CHECKOUT-046` がその回転に頼るため。許可リストの試験（Task 9）は「proxy が発行しない」ことだけを固定し、ログインの回転は対象外と書く |
| P4 | **ABOUT の試験の意図は「Set-Cookie がある応答も共有のキャッシュに残らない」**。`/about` は `src/app/layout.tsx:22` の `dynamic = 'force-dynamic'` で応答が `private`/`no-store` になる（Cookie の有無に依らない）ので、Set-Cookie の確認を外しても `expectNotSharedCacheable` は緑のまま。`FR-ABOUT-010:129`（`cookies.some(... session_id ...)`）と `:132-` の AC-02（`/about` から `session_id` を取って次の要求に使う）が `/about` では取れなくなるので書き換える。`about-proxy.test.ts` の `ARC-ABOUT-002` の 3 本（`:130`・`:147`・`:157` 付近の「発行する」系）と `privacy-proxy-headers.test.ts:121-154` は、発行する側を `/cart` に移し、`/about`・`/privacy` は付かない試験を足す | Q23 の答え |
| P5 | **画像の署名の許可範囲**: 道筋は `^<prefix>/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$`（`<prefix>` は `items`・`looks`・`news`）。URL の形は、**自分のプロジェクトの origin 1 つだけ**（`NEXT_PUBLIC_SUPABASE_URL` の origin。無ければ `SUPABASE_URL` の origin。CSP の `supabaseOrigin`（`NEXT_PUBLIC_SUPABASE_URL \|\| SUPABASE_URL`）と同じ `\|\|` の順）で、パスが `/storage/v1/object/(public\|sign\|authenticated)/<自分のバケット>/` の下の時だけ道筋を取り出す。`decodeURIComponent` の後にも式に合うこと（壊れた `%` は null）。**2 つ目の origin は許さない**: 署名つき URL の host（`createServiceRoleClient` は `SUPABASE_URL` を優先する `server.ts:138`）と、CSP の `img-src`・`remotePatterns`（1 host だけ）が食い違うと、署名が通っても画像が CSP と `/_next/image` で止まる。だから設計どおり 1 つに揃え、2 つの変数が別の origin を指す設定は Task 13 がビルドで落とす（ruling 2） | 設計 R8。バケット名は引数 `bucket`（`item-images`・`look-images`・`news-images`）で渡す（設計の `{ prefix }` だけでは URL からの道筋の取り出しができないため）。手元・E2E では 2 つの変数は同じ host（`scripts/e2e/environment.ts`） |
| P6 | **本番の画像の値は全部この式に合う（読むだけの `SELECT`。2026-10-28、project `pjidrgofvaglnuuznnyj`）**: `items.image_url` 9 行 = 自分の host の `/object/public/item-images/items/…` 9、`items.image_urls` 要素 11 = 同 11、`looks.image_urls` 要素 13 = `/object/public/look-images/looks/…` 13（LOOK 7 件）、`news_articles.image_url` 8 行 = 自分の host の `/object/public/news-images/news/…` 6 と素の道筋 `news/…` 2。**外の host 0、`/object/public/` 以外の自 host の形 0（`sign`・`authenticated` も 0）、`items/`・`looks/`・`news/` の外 0、安全な文字の式に合わない 0**。`order_items` は 0 行。バケット 3 つとも `public=false`・上限 5242880。商品の登録（`admin/items/route.ts:132-148`・`[id]/route.ts:230`）は今も `getPublicUrl` で `/object/public/` の URL を `items.image_url` に書く。だから **`/object/public/` の自 host URL は道筋に直して通す**（落とすと本番の商品画像が全部消える）。DB の移行・値の直しは要らない | Review Focus 1 |
| P7 | **署名の戻りの契約**: `signItemImageUrl`・`signLookImageUrl`・`signNewsImageUrl` は、入力が空・道筋にできない・署名に失敗の**どれでも** `null`（元の値を返さない）。失敗は種類（`invalid_path` / `sign_failed`）だけを `console.warn` に残し、道筋・URL・鍵・Supabase の誤りの文は書かない。`signLookImageUrls` は既に `null` を除く。`signNewsImageFields` は `image_url: null`。`signItemImageFields` は `image_url: null` と `image_urls` から**位置を保ったまま** 無効な要素を除く（Review Focus 2） | 設計 R8-2 |
| P8 | **ITEM の既定の期限は 3600 秒**（`item-images.ts:5`）。LOOK・NEWS と揃う。検索側は `SEARCH_IMAGE_URL_TTL_SECONDS = 3600` を明示して呼ぶ。メールは画像を使わない（`src/lib/orders/email`・`src/lib/mail*` に `img`・`imageUrl` が無い）、注文の頁・カート・お気に入り・決済の確認は**要求のたびに**署名する（頁のキャッシュ無し。ルートの `layout.tsx:22` が `force-dynamic`）ので、1 時間で困る呼び出しは無い。**開いたまま 1 時間を超えた頁の遅延画像は切れる**（再読み込みで直る。受け入れる）。**ただし期限の読みを次の 2 点で直す**: ①**決済は Stripe に画像の URL を送らない**（`create-session/route.ts:1017,1027,1038` の `product_data` は `{ name }` だけ）。スナップショットが持つのは生の `image_url`（`:878`）で、確認画面は表示のたびに `checkout-confirmation.service.ts:113` で署名し直す。だから決済の流れで切れる署名つき URL は残らない（決定文の「create-session は画像の URL を Stripe に送るか」の答えは**送らない**）。②**署名の使い回しが期限を縮める**: 今の `createSignedUrlByPath`（`item-images.ts:5,53-76`）は、キャッシュした URL を `expiresIn - 60` 秒（3600 秒なら 3540 秒）まで使い回す。使い回しの最後の側で頁が作られると、頁に載る URL の残りは約 60 秒で、遅延読み込みのカート・商品の画像が**数十秒で切れる**。1 時間でなく 1 分の問題になる。Task 3 で、使い回すのは**残りが期限の半分以上ある間だけ**（`expiresIn / 2` 秒。3600 秒なら 1800 秒）に縮め、試験を付ける。これで頁に載る URL の残りは最低でも 1800 秒になる。署名の呼び出しは 2 倍まで増えうるが、同じ道筋・同じ期限の 1 インスタンスあたり 30 分に 1 回で、許容する | R8 の「共有部品への影響」 |
| P9 | **`null` を受けられない所がある（Task 2 で先に直す）**: `src/features/cart/client/cart-api.ts:26` が `image_url: line.image ?? ''` → `CartItemRow.tsx:63` と `checkout/page.tsx:214` の `<Image src="">`（`next/image` は空の `src` で落ちる）。`cart-view.ts:83`・`wishlist/route.ts:141` の `?? item.image_url` は `null` のとき**元の値（外の URL）に戻してしまう**（fail-closed を無効にする）。`wishlist/page.tsx:149` の `typeof item.image_url === "string"` は `null` の 1 件で「形式が不正」と全体を捨てる。管理の `NewsSection.tsx:138` の `<Image src={item.image_url}>`。`ItemDetailClient.tsx:489-494` の `[item.image_url]`（`null` の 1 枚のサムネイル）。**管理の LOOK の商品選択 `src/app/admin/look/LookForm.tsx:457` の `<Image src={item.image_url} unoptimized>`**（データは `/api/admin/items` が `signItemImageFields` で署名して返す。型は `ItemSummary.image_url: string`（`admin/look/types.ts:5`）で、JSON の境界を越えるので `tsc` は `null` を見つけられない。署名が `null` を返すと商品の選択欄が落ちる）。**JSON の境界を越える受け手は `tsc` で数えられない**ので、Task 2 は `/api/admin/items`・`/api/items`・`/api/wishlist`・`/api/cart` の JSON を読む全てのクライアント（`fetch`・`useSWR`・フックの型）を `grep` で洗い出す。既に受けられる: `ItemCard`（`imageUrl?: string \| null`）、`RelatedItems.tsx:84`、`ItemSection.tsx:49`（`\|\| "/placeholder.png"`）、`LookSection.tsx:121`、検索の行（`imageUrl` が `null` なら `img` を出さない） | 実装前に `grep -rn "image_url" src --include=*.tsx` と `npx tsc --noEmit` で数える。**それだけに頼らない**: JSON の境界は Task 2 Step 1 の `grep`（4 つの窓口を読むクライアント）で数える |
| P10 | **`/ui` の画像**: `src/app/ui/page.tsx` の `readdy.ai` は **7 か所**（`:83-85` の carousel 3、`:256`・`:263`・`:270` の cardItems 3、`:1602` の Avatar 1）。決定文は 9 枚と書くが、実際は 7（残り 4 は既に `/placeholder.png`）。置き換え先は `public/` の既存の画像だけ（バイナリを作らない）: carousel = `/news1.png`・`/news2.png`・`/news3.png`、cardItems 3 枚と Avatar = `/placeholder.png`。`/ui` を開く E2E（`FR-UI-001`・`002`・`004`・`005`、`FR-TERMS-005`、`slider-*` の 8 本）は画像の中身を見ない（grep で `img`・`naturalWidth`・`carousel` を見る行が無い）ので、通る見込み | Q6 |
| P11 | **`src/lib/news-data.ts` の `newsData`**（`readdy.ai` の住所を持つ）は `src` のどこからも使われていない。消さずに報告する（使われていないコードの決まり）。CSP・`remotePatterns` から外しても影響なし | 決定文 |
| P12 | **Stripe の許可先（Task 7）**: Stripe 公式（<https://docs.stripe.com/security/guide> の Stripe.js の節）は `connect-src https://api.stripe.com`、`frame-src https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com`、`script-src https://*.js.stripe.com https://js.stripe.com`、`img-src https://*.stripe.com`。今の `buildCsp` は `*.js.stripe.com` を `script-src`・`frame-src` に持たない。**足す**（公式が「Stripe.js が別のオリジンでフレームを先に起動して速くする」ためと書く）。今ある `hooks.stripe.com`（3D セキュアなど）・`api.stripe.com`・`r.stripe.com`・`m.stripe.network`・`q.stripe.com`・`https://*.stripe.com`（画像）は**消さない**（`r.stripe.com`・`m.stripe.network`・`q.stripe.com` は Stripe.js の計測で、`FR-CHECKOUT-025` が CSP 違反 0 を見ている）。Turnstile（`challenges.cloudflare.com`: script・frame・connect）は全頁で残す。`maps.googleapis.com`（住所の部品の Google の鍵）と Link（`link.com`・`*.link.com`）は**足さない**（今は使っていない）。**注意**: 本番の Stripe アカウントで Link が有効だと、決済の部品が `link.com` の枠を開こうとして今の CSP で止められる可能性がある。テストモードの `FR-CHECKOUT-025` では出ていない。今回は変えず、controller の「本番の前の確認」に載せる | Q29、P12 の出典は Stripe 公式 |
| P13 | **`og:image` の窓口**: `GET /look/[id]/og`。`id` は `parseLookId`（既存）。公開の LOOK だけを匿名 client で読み（`looks.status='published'`）、`image_urls` の先頭から**検証に通る最初の 1 枚**の道筋を `parseOwnObjectPath(raw, { bucket: 'look-images', prefix: 'looks' })` で取り、service role の `storage.from('look-images').download(path)` のバイトを返す。種類はバイトの先頭の印（`detectImageType`）で決め、画像でなければ 404。応答の見出し: `Content-Type`（検出した種類）、`Cache-Control: public, max-age=300, s-maxage=300`、`X-Content-Type-Options: nosniff`。LOOK が非公開・無い・id が不正・画像が無い/検証に通らない・置き場の失敗はすべて 404（本文は固定の短い文字。置き場の誤りの文を出さない）。`Set-Cookie` は付かない（P3 の許可リストの外なので、公開で共有キャッシュに載る応答に識別子が付かない）。回数制限は**付けない**（公開の LOOK の数に限られ、`s-maxage=300` で CDN が受ける。クエリの付け替えで置き場を叩かれる量は後の波 4 の `rateLimit.ts` で見直す）。`generateMetadata` は、署名つきの画像が 1 枚以上取れる LOOK だけ `openGraph.images` に `/look/<id>/og` を入れる | Q10 の推奨 |
| P14 | **ITEM の `og:image`**（`src/app/item/[id]/page.tsx:35`）は DB の生の `image_url`（`/object/public/item-images/…`、バケットは非公開なので 400 になる壊れた URL）を入れている。設計の R9 の対象 ID に無い。**この波では直さない**。報告に「商品詳細の `og:image` が壊れている」と書く（直すなら LOOK と同じ `/item/[id]/og` の窓口） | 設計の範囲外 |
| P15 | **zod の `jitless`**: zod 4 の `$ZodObject` は**スキーマを作る時**に `core.globalConfig.jitless` と `util.allowsEval.value`（= `new Function("")` を試す。CSP の `eval` 違反の原因）を評価する（`node_modules/zod/v4/core/schemas.js:901-903`）。だから `z.config({ jitless: true })` は、ブラウザで最初に `z.object` が走るより前でなければ効かない。`jitless` のとき `allowsEval.value` は読まれない（`jit && allowsEval.value` の短絡）。**置き場所は `src/instrumentation-client.ts` の 1 ファイルだけ**: `import { z } from 'zod'; z.config({ jitless: true });`。Next 16 はこのファイルをアプリのフロントエンドのコードより前に（ハイドレーションの前に）ブラウザで 1 回実行するので、入口ごとの import は要らない。zod を使うファイルは 126 あり、どれがブラウザへ届くかを手で辿ると 1 つ漏れただけで直しが無効になる（一覧の辿りは不要）。サーバー側は `instrumentation-client.ts` を読まないので速度は変わらない（`typeof window` の分岐も要らない）。`FR-HOME-022:149` の条件つきの扱いは残す | Q25 の推奨。Next 公式の `instrumentation-client` の説明（クライアントの監視・分析の初期化を、頁の前に走らせる場所）。**実測で確かめる**: 本番ビルドで `/` を開き `new Function` が呼ばれない（Task 12 Step 5） |
| P16 | **サイトの URL の本番の確かめ**: `next.config.ts` の先頭で、`process.env.VERCEL_ENV === 'production'` のときだけ `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` が無ければ `throw`（`NODE_ENV` は E2E の本番ビルドも `production` になるので使わない）。`getSiteUrl`（`redirect.ts:64`）は変えない（`NEXT_PUBLIC_VERCEL_URL` の扱いは別判断。設計 R9-6）。`.env.example` に `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` を足す（今は `APP_BASE_URL` があるが `src` は読まない）。ビルドの値はビルドの時に埋め込まれるので、配備の手順（`docs/06_Operations`）にも書く | 設計 R9-6、`ABOUT.md` §3 |

## Global Constraints

- 並行作業: 別セッション（G-4 注文）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。コミットは作らない。`git status --short` に出ている `.claude/CLAUDE.md`・`package.json` は他者の変更なので触らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`next build`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E は書くだけ。DB は本番も手元も触らない。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者（G-4）の誤りが出たら触らず、報告に書く。
- 着手前に `git status --short` を見て、G-4 が変更中のファイルを確かめ、**重ならないようにする**。触らない: `src/lib/orders/**`、G-4 の注文・返品の窓口と画面、`src/app/admin/page.tsx`、`src/features/auth/middleware/rateLimit.ts`・`src/lib/auth/authenticate.ts`・`admin-rbac.ts`・`src/lib/audit.ts`（呼ぶだけ）、`supabase/**`（移行・見本の変更は無い）、`playwright.config.ts`、`scripts/e2e/**`。
- **`src/proxy.ts` と `next.config.ts` は全頁・全領域に効く共有ファイル**。触るタスクは Task 7（proxy: CSP）→ 8（next.config: images）→ 9（proxy: session_id）→ 10（proxy: no-store）→ 13（next.config: 本番の確かめ）の**この順に 1 つずつ**。各タスクの終わりで、その時点の `npx jest tests/unit/middleware tests/integration/api/about-proxy.test.ts tests/integration/api/privacy-proxy-headers.test.ts tests/integration/api/home-page-proxy-csp.test.ts tests/integration/api/news-proxy.test.ts tests/integration/api/stockist-proxy.test.ts tests/integration/api/search-rate-limit-proxy.test.ts tests/integration/api/admin-misc/admin-origin-guard.test.ts` を流して、他領域の proxy の試験が赤くなっていないことを確かめる。
- 共有文書は**編集しない**: `docs/02_Requirements/requirements.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/03_BasicDesign/data/er.md`、`tests/unit/docs/*-traceability.test.ts`、`docs/06_Operations/db-migrations.md`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID（E2E は受け入れ条件、結合は構造設計、単体は詳細設計）を守る。文書の冒頭の確認日は 2026-10-28。絵文字は使わない。要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）、脅威は `docs/05_Quality/security/threats/<area>.md`、構造設計は `docs/03_BasicDesign/areas/<area>.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、処理の詳細は `docs/04_DetailDesign/pages/` の頁の `DD-`。「今のコードは満たさない」は**直した項目だけ**外す。直していない部分は残す。
- 新しい受け入れ条件を起こしたら、領域の要件のファイルの冒頭の「E2E ファイルと受け入れ条件の対応表」にも足す。
- コードのコメント: 範囲内の新しい単位（`src/app/look/[id]/og/route.ts` の `GET`）には TSDoc で `@impl`・`@design`・`@remarks`（「なぜ」だけ）を書く。変えた単位は `@remarks` が今の動きと食い違わないよう直す（例: `look-images.ts` の `signLookImageUrl`「道筋が取れない時と署名に失敗した時は元の値をそのまま返し」、`src/app/layout.tsx` ではなく `src/proxy.ts` の `buildCsp` の説明）。**共有の新ファイル（`src/lib/storage/safe-object-path.ts`・`src/instrumentation-client.ts`）には `@impl` を付けない**（共有部品にはコメントを入れない決まり）。その単体試験は先頭に最初の利用者の `DD-` を付ける。`@impl` の番号は書く直前に `grep -rhoE "IMPL-(LOOK|HOME|SEARCH)-[0-9]+" src | sort -u | tail`（今の最大: LOOK 156・HOME 103・SEARCH 128）で確かめる。
- 入力は信用しない: 記録・監査に、画像の道筋・URL・Cookie の値・鍵・Supabase の誤りの文を残さない。残してよいのは固定の符号と種類だけ（`describeErrorForLog` は `src/lib/logging/safe-error.ts` に既にある）。
- 実装は最小。決定にない設定項目・追加の窓口・画面は作らない。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない（`\` が落ちて CRLF を壊す）。`graphify update` は自分で流さない（コミットのフックが後ろで作り直す）。
- E2E は既存の spec に足す。新しい spec ファイルは作らない。新しい E2E は mobile 390・tablet 768・desktop 1280 の 3 つの幅で書く（応答の見出しだけを見る試験は幅に依存しないので 1 回でよい。既存の流儀に合わせる）。

### ID の割当

番号は**書く直前に再確認**する（上の Global Constraints のコマンド）。違えば割当表をずらして一貫させる。ADR は領域ごとの帯（`scripts/trace/scope.json`）に合わせ、上位に載せる構造設計（`ARC-`・`API-`・`DATA-`）を書く直前に確かめる（無いと `missing-child`）。

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0108` | CSP は自分のプロジェクト・Stripe（全頁）・Turnstile だけを許し、使っていない CDN・外の画像のホストを許さない | 7 |
| ADR | `ADR-0316` | 画像の署名は、自分のホストと置き場の接頭辞を確かめ、失敗は元の値でなく null にする（ITEM は 3600 秒） | 3 |
| ADR | `ADR-0165` | LOOK の `og:image` は署名を含まない同一オリジンの窓口 `/look/[id]/og` が返す | 11 |
| ADR | `ADR-0355` | `session_id` は `/cart`・`/checkout`・`/api/checkout` だけで発行する（既定は配らない） | 9 |
| ADR | `ADR-0415` | `/api/auth` 配下の `Cache-Control: no-store` は route でなく proxy で付ける | 10 |
| ADR | `ADR-0206` | サイトの URL は本番ビルドで必須にし、`getSiteUrl` は投げない | 13 |
| 実装 | `IMPL-LOOK-157`（`@design DD-LOOK-071`） | `GET /look/[id]/og` | 11 |
| 詳細設計 | `DD-SEARCH-011` | 画像の署名の道筋の確かめ（共有。最初の利用者の SEARCH の名前で試験を付ける）。**項目は Task 1 が作る**（試験の先頭の ID が先に在るように。`validate-trace` を各タスクの間で通すため）。Task 3 が期限・キャッシュの節を足す | 1（作る）・3（足す） |
| 詳細設計 | `DD-HOME-004` | CSP の組み立て（`buildCsp`。共有の `proxy.ts` の HOME 側の写し）。**項目は Task 6 が作る**（`ui-page.test.tsx` の先頭の ID）。Task 7 が `buildCsp` の節を足す | 6（作る）・7（足す） |
| 詳細設計 | `DD-ABOUT-002` | サイトの URL・Supabase の URL は本番ビルドで必須（`next.config.ts`）。項目は Task 13 が `docs/04_DetailDesign/pages/08_about.md` に作る（今の最大は `DD-ABOUT-001`） | 13 |
| 詳細設計 | `DD-PRIVACY-004` | `session_id` の発行条件 | 9 |
| 詳細設計 | `DD-AUTH-037` | `/api/auth` の no-store | 10 |
| 受け入れ条件 | `SEC-HOME-009-AC-03` | `/cart` から「レジへ進む」で `/checkout` に進んで Stripe の部品が出るまで、CSP の違反が 0 件（3 幅） | 7 |
| 受け入れ条件 | `SEC-PRIVACY-015-AC-02` | `/cart`・`/checkout` では Cookie の無い閲覧者に `session_id` を発行し、`/`・`/about`・`/terms`・`/news` では発行しない | 9 |
| 受け入れ条件 | `SEC-PRIVACY-014-AC-03` | `/privacy` の CSP の `script-src` は Stripe.js の許可（`js.stripe.com`・`*.js.stripe.com`）を持つ（Q29 の決定を固定する） | 7 |
| 受け入れ条件 | `SEC-LOOK-006-AC-03` | `/look/<id>/og` が公開の LOOK で 200・画像・`Cache-Control`・`nosniff`、非公開で 404 | 11 |
| 受け入れ条件 | `SEC-ABOUT-007-AC-01` の単体 | `next.config.ts` が `VERCEL_ENV=production` で必須の環境変数が無ければ落ちる（既存の AC に最初の試験が付く） | 13 |

### 設計書の印と並べ方の注（shared files）

| ファイル | 触るタスク | 並べ方 |
| --- | --- | --- |
| `src/proxy.ts` | 7（CSP）→ 9（session_id）→ 10（no-store） | この順に直列。1 つ終わるごとに上の proxy の試験群を流す |
| `next.config.ts` | 8（images）→ 13（本番の確かめ） | 直列 |
| `src/lib/storage/item-images.ts` | 3 | 他は 2（型）・3 |
| `src/lib/storage/look-images.ts`・`news-images.ts` | 4・5 | 4 → 5 |
| `docs/*/areas/home.md` 系・`threats/home.md`・`01_home.md` | 3（HOME-006・007）・7・8・12 | 3 → 7 → 8 → 12（別の節を足す） |
| `docs/*/areas/search.md` 系 | 1・3・4 | 1 → 3 → 4 |
| `docs/*/areas/privacy.md` 系・`areas/about.md` 系 | 7・9 | 7 → 9 |

---

## Review Focus（最も踏みやすい失敗 6 つ）

レビュアーと実装者は、各タスクの前後でこの 6 つを具体的な入力で確かめる。

1. **本番の商品画像が一斉に消える。** 本番の `items.image_url` は 9 行とも自分の host の `https://pjidrgofvaglnuuznnyj.supabase.co/storage/v1/object/public/item-images/items/…`（P6）。`parseOwnObjectPath` が `/object/public/` の URL を道筋に直さなければ、署名が全部 `null` になって本番の商品・LOOK・NEWS の画像が全部消える。**確かめる入力（単体）**: ①`https://<自分>.supabase.co/storage/v1/object/public/item-images/items/2026-07-01/x.jpg` → `items/2026-07-01/x.jpg`、②同じ host の `…/object/sign/item-images/items/x.jpg?token=…` → `items/x.jpg`、③別 host（`https://evil.example/storage/v1/object/public/item-images/items/x.jpg`、`https://other.supabase.co/…`）→ null、④別バケット（`…/object/public/look-images/looks/x.jpg` を `item-images` で）→ null、⑤`..`・`%2e%2e`・`//`・先頭の `/`（`/items/x.jpg` は先頭の `/` を取って通すか、通さないかを現行の `normalizeObjectPath` と同じに保つ）・`other/x.png`・`items/` だけ・空・`%`（壊れた符号）→ null。⑥`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が**別の origin**の時、`SUPABASE_URL` 側の host の URL → null（許すのは 1 つだけ。`NEXT_PUBLIC_SUPABASE_URL` が無く `SUPABASE_URL` だけの時はその origin）。**環境変数が両方無い単体試験の環境**（Jest）では URL の形は全部 null になることも確かめる（素の道筋は通る）。
2. **署名の戻りの位置ずれ。** `signItemImageFields` は `[nextImageUrl = null, ...nextImageUrls] = await signItemImageUrls(supabase, [row.image_url, ...row.image_urls])`（`item-images.ts:145-`）。`signItemImageUrls` が無効な要素を `.filter(Boolean)` で**詰める**と、`image_url` が無効（`null`）なとき、`image_urls[0]` が `image_url` に繰り上がる（先頭の画像が別の画像になる）。**位置を保つ**: `signItemImageUrls` は `(string \| null)[]`（同じ長さ）を返し、`signItemImageFields` が `image_url` は先頭の要素（`null` のまま）、`image_urls` は残りの要素から `null` を除く。確かめる入力: `image_url` が外の URL・`image_urls = ['items/a.png', 'items/b.png']` → `image_url: null`・`image_urls = [signed a, signed b]`。
3. **`next/image` に空の `src` を渡して頁が落ちる。** 署名が `null` を返すと、カート（`cart-api.ts:26` が `?? ''`）→ `CartItemRow`・`checkout/page.tsx` の `<Image src="">`、管理のニュース一覧の `<Image src={null}>`、管理の LOOK の商品選択（`LookForm.tsx:457`。型は `string` のまま JSON で `null` が届くので `tsc` が見つけない）、商品詳細のサムネイルの `[null]` が落ちる（P9）。Task 2 でこの全部を先に直し、Task 3 より前に木を緑にする。確かめる入力: カートの 1 行の `image` が `null` → `src="/placeholder.png"`、お気に入りの 1 件が `image_url: null` → 頁全体を捨てず placeholder のカード、ニュース一覧の 1 件が `image_url: null` → placeholder。
4. **CSP を減らして決済・ログイン・画像が止まる。** 外すのは使っていない物だけ（jsDelivr 4 か所、`placehold.co`、`readdy.ai`・`*.readdy.ai`、`*.supabase.co` 2 か所）。**残す・足す物**: `supabaseOrigin`（`connect-src`・`img-src`。管理画面が署名つきの URL を生の `<img>` で出す: `proxy-csp.test.ts` の前提）、Stripe（`script-src` に `https://js.stripe.com` と `https://*.js.stripe.com`、`frame-src` に `https://js.stripe.com` `https://*.js.stripe.com` `https://hooks.stripe.com`、`connect-src` は今の 4 つ、`img-src` は `https://*.stripe.com` と `https://q.stripe.com`）、Turnstile（3 か所）、`frame-src` の Google の 2 つ、`style-src` の `'unsafe-inline'`、`img-src` の `data:`。手元の Supabase（`http://127.0.0.1:54321`）は `supabaseOrigin` で通る（`*.supabase.co` が無くても）。**`NEXT_PUBLIC_SUPABASE_URL` が無い環境**（`SUPABASE_URL` だけ）は今の `||` の順を保つ。確かめ方: `buildCsp` の単体（`proxy()` を通した見出し）で各ディレクティブを `toEqual` の配列で固定する（`toContain` だけにしない）。決済の E2E（`FR-CHECKOUT-025`・`036`・`005`・`046`・`040`）と、新しい `SEC-HOME-009-AC-03`（`/cart` から押して進む）で違反 0 を見る。
5. **`remotePatterns` を絞って手元の E2E の画像が 400 になる。** 手元の Supabase の枝（`localSupabaseStorage` と `dangerouslyAllowLocalIP`）は**残す**（`next.config.ts:10-17,34,72-81`）。本番の枝は、ビルド時の `NEXT_PUBLIC_SUPABASE_URL` の host 1 つ・道は `/storage/v1/object/sign/**` だけ（`public` は本番のバケットが非公開なので入れない。`authenticated` は `next/image` が認証の見出しを付けられないので入れない）。`readdy.ai`・`public.readdy.ai`・`placehold.co`・`*.supabase.co` は全部消す。`FR-HOME-022:118`（別のプロジェクト `e2eotherprojectref.supabase.co` が 400）・`FR-NEWS-SEC-003:144` が反転する一方、`FR-NEWS-SEC-003:109`（署名つき URL の最適化の `max-age <= 3600`）が通るかは、手元のバケットの `cache-control`（見本の上げ方に依る）と `minimumCacheTTL: 3600` で決まる。**controller が確かめる**: 実測の `Cache-Control` の `max-age` を報告に書く。
6. **`session_id` を減らして決済の入口が 400 になる。** P1 の読み手は全部 `/cart`・`/checkout`・`/api/checkout` の中だが、**Cookie の発行はその頁の応答で行う**ので、`/cart` や `/checkout` を開かずに `/api/checkout/*` を叩く E2E は（前から）400 になる。E2E の補助（`checkout-flow-helpers.ts`・`checkout-test-utils.ts`）が `seedCart`・`page.goto('/checkout')` を先に行うかを実際に読み、`FR-CHECKOUT-*` の中で**直に API を叩く物が頁を開いているか**を一覧にして報告に書く。壊れる物があれば、**許可リストを拡げずにその E2E の補助に `page.goto('/cart')` を足す**。`FR-WISHLIST-011:60-66` の `beforeEach`（`request.get('/')` から `session_id` を取る）は取れなくなる（`sessionCookie` は未定義のまま、`buildCookieHeader` は未定義を許す）が、その試験は `session_id` を使わない（`:8` の注記）。取る場所を `/cart` にする必要は無い。**書き換える物**: 上の P4。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 共有（新規） | `src/lib/storage/safe-object-path.ts`、`src/instrumentation-client.ts` | 新規 | 1・12 |
| 画像の署名（共有） | `src/lib/storage/item-images.ts`・`look-images.ts`・`news-images.ts` | 変更 | 3・4・5 |
| 画像の受け手 | `src/features/cart/services/cart-view.ts`・`client/cart-api.ts`、`src/app/api/wishlist/route.ts`、`src/app/wishlist/page.tsx`、`src/app/cart/_components/CartItemRow.tsx`、`src/app/checkout/page.tsx`、`src/components/NewsSection.tsx`、`src/app/item/[id]/ItemDetailClient.tsx`、`src/features/search/services/search.service.ts`、`src/lib/look/server.ts`、`src/features/look/services/admin-images.ts`・`src/features/news/services/admin-images.ts`（委譲） | 変更 | 2〜5 |
| 共有（proxy・設定） | `src/proxy.ts`、`next.config.ts`、`.env.example` | 変更 | 7〜10・13 |
| `/ui` | `src/app/ui/page.tsx` | 変更（7 か所の URL） | 6 |
| LOOK の og | `src/app/look/[id]/og/route.ts`（新規）、`src/app/look/[id]/page.tsx`（`generateMetadata`）、`src/lib/look/server.ts`（先頭の画像の道筋を返す小さな関数） | 新規・変更 | 11 |
| zod | `src/instrumentation-client.ts`（1 ファイルだけ。入口ごとの import は足さない。P15） | 新規 | 12 |
| 試験（単体・結合） | `tests/unit/lib/storage/safe-object-path.test.ts`・`item-images.test.ts`（新規）・`look-images.test.ts`・`news-images.test.ts`、`tests/unit/middleware/proxy-csp.test.ts`・`proxy-session.test.ts`（新規）・`proxy-no-store.test.ts`（新規）、`tests/integration/api/home-page-proxy-csp.test.ts`・`about-proxy.test.ts`・`privacy-proxy-headers.test.ts`・`look-image-signing.test.ts`・`news-image-signing.test.ts`・`search-image-signing.test.ts`、`tests/unit/next-config.test.ts`（新規）、`tests/unit/app/look-og-route.test.ts`（新規）、カート・お気に入り・ニュース管理・商品詳細の単体 | 追加・変更 | 全部 |
| E2E | `e2e/FR-SEARCH-019`・`021`、`FR-HOME-022`・`023`、`FR-LOOK-SEC-001`、`FR-ABOUT-010`、`FR-PRIVACY-006`、`FR-NEWS-SEC-003`、`FR-LOGIN-030`、`FR-CART-002`（確認のみ）、`FR-LOGIN-036`（注の文だけ） | `test.fail` の削除・期待の更新・新しい `test` の追加（書くだけ） | 3〜11 |
| 文書 | `docs/02_Requirements/areas/{home,about,privacy,look,news,search,auth}.md`、`docs/05_Quality/security/threats/{home,about,privacy,look,news,search,auth}.md`、`docs/03_BasicDesign/areas/{home,about,privacy,look,news,search,auth}.md`、`docs/03_BasicDesign/decisions/ADR-0108・0165・0206・0316・0355・0415`（新規）、`docs/04_DetailDesign/pages/{01_home,17-1_privacy,07_look_detail,19_search,14_login}.md`、`docs/03_BasicDesign/architecture/system-overview.md`、`docs/06_Operations/{secrets,deployment-topology}.md` | 追記・更新 | 全部 |

---

## Task 1: 道筋を確かめる共有の関数 `parseOwnObjectPath`（追加のみ）

**範囲:** 何も呼ばない新しい純粋な関数と、その単体試験。挙動は変わらない（Task 3〜5 が使う）。

**Files:**

- Create: `src/lib/storage/safe-object-path.ts`、`tests/unit/lib/storage/safe-object-path.test.ts`
- Docs: `docs/04_DetailDesign/pages/19_search.md` に `DD-SEARCH-011` の項目だけ作る（見出し直後の属性表・題「画像の署名の道筋の確かめ」・上位の `ARC-SEARCH-` の画像の署名の部品への紐付け・`parseOwnObjectPath` の仕様の要約）。試験の先頭の `DD-SEARCH-011` がこのタスクのコミットの時点で在り、`npm run validate-trace -- SEARCH` が通るようにするため。Task 3 が期限・キャッシュの節と `ADR-0316` を足す。確かめ: `npm run validate-docs`、`npm run validate-trace -- SEARCH`

**Interfaces:**

```ts
// src/lib/storage/safe-object-path.ts（共有。@impl なし）
export const SAFE_OBJECT_PATH_BODY = '[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*';
/** 「<prefix>/ の下の安全な文字だけ」の道筋なら true（URL は受けない）。 */
export function isSafeObjectPath(path: string, prefix: string): boolean;
/**
 * 画像の値（素の道筋 / バケット名つきの道筋 / 自分のプロジェクトの Storage の URL）から、<prefix>/ の下の安全な道筋を取り出す。
 * URL は origin が NEXT_PUBLIC_SUPABASE_URL（無ければ SUPABASE_URL）の origin 1 つと一致し、パスが
 * /storage/v1/object/(public|sign|authenticated)/<bucket>/ の下の時だけ。decodeURIComponent の後にも式に合うこと。
 * 取り出せない物（外の host・別のバケット・.. ・// ・先頭の / ・他の接頭辞・壊れた %・空）は null。
 */
export function parseOwnObjectPath(raw: string | null | undefined, options: { bucket: string; prefix: string }): string | null;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `src/lib/storage/item-images.ts:8-14,16-45`・`look-images.ts:18-51`・`news-images.ts:6-62` の `extract*ObjectPath` / `normalizeObjectPath` の動き（バケット名つきの道筋の先頭を外す。`/` の先頭を外す）を表にして、`parseOwnObjectPath` が**同じ入力で同じ道筋**を返す物（本番の値の 4 つの形）と、**意図して null にする**物（P5）を分けて書く。`grep -rn "extractItemImageObjectPath\|extractLookImageObjectPath\|extractNewsImageObjectPath" src tests` で呼び手を数える（`admin-images.ts` の 2 つが使う。残す）。
- [ ] **Step 2（RED）: 単体試験を書く**（先頭 `DD-SEARCH-011`）。環境変数は `process.env` を差し替えて `jest.resetModules` で読み直す（`proxy-csp.test.ts` の流儀）。表（`it.each`）で:
  - 通る物: Review Focus 1 の①②（`item-images`/`items`）、LOOK の `…/object/public/look-images/looks/2026-01-01/uuid.jpg`、NEWS の素の道筋 `news/e2e/news-1.png`、`news-images/news/x.png`（バケット名つきは外す）、`looks/e2e-look-sec-002.png`、`looks/e2e-sec005-probe/a.png`、`items/e2e/item-1-1.png`。`NEXT_PUBLIC_SUPABASE_URL` が無く `SUPABASE_URL` だけの時は、その origin の URL が通る。
  - null になる物: 別 host（`evil.example`・`other.supabase.co`・`example.com`）、別バケットの URL、`..`・`items/../looks/x.png`・`%2e%2e`・`items//x.png`・`/items/x.png` の絶対 URL でない先頭の `/`（現行は外して通す。**外して通す**で固定する。`//` を含む物は null）、接頭辞違い（`other/x.png`・`item/x.png`・`items`・`items/`）、`items/ x.png`・`items/x y.png`（空白）・`items/あ.png`・`items/.hidden`（先頭が `.`）、壊れた `%`（`items/%E0%A4%A.png`）、空・空白だけ・`null`・`undefined`、`javascript:alert(1)`・`data:image/png;base64,…`・`http://自分/…`（プロトコル違い。`http`/`https` は origin 比較で決まる）、`SUPABASE_URL` が `NEXT_PUBLIC_SUPABASE_URL` と別の origin の時の `SUPABASE_URL` 側の host の URL（Review Focus 1 の⑥）、環境変数が無い時の URL の形（素の道筋だけ通る）。
  - 注: 大文字小文字（`Items/x.png`）は null。
- [ ] **Step 3（GREEN）: 実装する。** 正規表現は `^${prefix}/${BODY}$`（`prefix` は呼び手の定数なので、`RegExp` に渡す前に正規表現の特殊文字を逃がす）。URL の判定は `value.startsWith('http://') \|\| 'https://'` の時だけ `new URL`（失敗は null）。`decodeURIComponent` は try/catch。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/lib/storage/safe-object-path.test.ts`。
- [ ] **Step 5: 報告。** 作ったファイル、`parseOwnObjectPath` と現行の `extract*` の差の表（P5 の「意図して null」）、共有文書の変更案は無い。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`。

---

## Task 2: 画像の値が `null` でも落ちない受け手にする（挙動は変えない）

**範囲:** Task 3 が署名を `null` を返す形に変える前に、`null` を受けられない所を全部直す。署名の関数はまだ元の値を返すので、**画面の見た目は変わらない**。`signItemImageFields` の戻りの型だけ先に `image_url: string \| null` に変えて、`tsc` に受け手を数えさせる。

**Files:**

- Modify: `src/lib/storage/item-images.ts`（戻りの型 `SignedItemImageFields<T>` だけ。中身は Task 3）、`src/features/cart/services/cart-view.ts`（`:83`）、`src/features/cart/client/cart-api.ts`（`:26`）、`src/app/api/wishlist/route.ts`（`:141`）、`src/app/wishlist/page.tsx`（`:30`・`:149`・`:396`）、`src/app/cart/_components/CartItemRow.tsx`（`:63`）、`src/app/checkout/page.tsx`（`:214`）、`src/components/NewsSection.tsx`（`:28`・`:138`）、`src/app/item/[id]/ItemDetailClient.tsx`（`:489-494` と使う所）、**`src/app/admin/look/LookForm.tsx`（`:457` の `<Image src={item.image_url} unoptimized>`）と `src/app/admin/look/types.ts`（`:5` の `ItemSummary.image_url: string`）**、`tsc` が示すその他、Step 1 の JSON 境界の `grep` が示すその他
- Test: `tests/unit/features/cart/`（cart-view の単体）、`tests/unit/api/wishlist/`、`tests/unit/app/wishlist-page.test.tsx` 相当（既存の物を探す: `grep -rln "wishlist" tests/unit`）、`tests/unit/components/NewsSection.test.tsx`（既存）、`tests/items/item-detail-api.test.ts`、商品詳細の単体、管理の LOOK の商品選択（`LookForm`）の単体（既存の物を `grep -rln LookForm tests` で探し、無ければ `tests/unit/app/admin/look/LookForm.test.tsx` を新規）
- Docs: 画像の挙動は変わらないので新しい `DD-` は書かない（`01_home.md` などの `DD-` は Task 3）。ただし**触る単位の `@impl`/`@design` と、つながる `DD-` の記述を確かめ、画像が無い時の代わりの絵（placeholder）に触れていれば直す**: `NewsSection.tsx` は NEWS の範囲（`scope.json`）で `@impl IMPL-NEWS-141`・`@design DD-NEWS-060`、`docs/04_DetailDesign/pages/16-1_admin_news.md` の `DD-NEWS-060` と `docs/02_Requirements/areas/news.md`・`docs/03_BasicDesign/areas/news.md` の管理の一覧の記述。`admin/look/types.ts` は LOOK の範囲（`scope.json:88`）で、その `@impl`/`@design` と `16-3_admin_look.md` の商品選択の記述。`@remarks` に「画像が `null` の時は placeholder」の 1 文が要るなら足す（「なぜ」だけ）。直さなくてよいと判断したら、その理由を報告に 1 行書く。`npm run validate-docs`、`npm run validate-trace -- NEWS`、`-- LOOK`

**Interfaces:**

```ts
// src/lib/storage/item-images.ts
export type SignedItemImageFields<T> = Omit<T, 'image_url' | 'image_urls'> & { image_url: string | null; image_urls: string[] };
export async function signItemImageFields<T extends { image_url?: string | null; image_urls?: string[] | null }>(supabase: SupabaseClient, row: T): Promise<SignedItemImageFields<T>>;
// cart-view / cart-api: 画像が無い時は固定の '/placeholder.png' を入れる（'' や元の値にしない）
export const PLACEHOLDER_IMAGE = '/placeholder.png'; // 置き場は受け手の領域（共有に増やさない）。既に定数があれば再利用
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P9 の一覧を `grep -rn "image_url" src --include=*.tsx --include=*.ts | grep -v graphify` で作り直し、`null`・`''` を受けられない所（`next/image` の `src`、`typeof === "string"` の検査、`.filter(Boolean)` を前提にした位置）を表にする。`signItemImageFields` の型を先に変えた状態で `npx tsc --noEmit` を流し、誤りが出る所を全部書き出す。**`tsc` だけに頼らない**: 署名された `image_url` は JSON を越えて届くので、型が `string` のまま宣言されたクライアントは `tsc` を通ったまま実行時に `null` で落ちる（例: `LookForm.tsx:457`）。`/api/admin/items`・`/api/items`（`/api/items/[id]`・公開の一覧を含む）・`/api/wishlist`・`/api/cart` の応答を読む全てのクライアントを `grep -rnE "api/(admin/)?items|api/wishlist|api/cart" src --include=*.ts --include=*.tsx`（`fetch`・`clientFetch`・フック・型の宣言）で洗い出し、受け取る型の `image_url`・`image_urls`・`image` を 1 つずつ読んで、`next/image` の `src`・`new URL(...)`・`.startsWith`・`.map` に `null` が届く所を表にする（P9 の既知の物に加える）。
- [ ] **Step 2（RED）: 試験を書く。** ①`cart-view` の 1 行で `signItemImageUrl` が `null` を返す（モック）→ `image` は `'/placeholder.png'`（元の `image_url` に戻さない）。②`cart-api.ts` の写像: `line.image` が `null`/`undefined`/`''` → `image_url: '/placeholder.png'`。③`wishlist/route.ts` の写像: 署名が `null` → `image_url: null`（元の外の URL に戻さない）。④`wishlist/page.tsx` の `parseWishlistResponse`: 1 件が `image_url: null` でも他の件を捨てず、その件は placeholder（`ItemCard` は `null` を受ける）。⑤管理のニュース一覧: 1 件が `image_url: null` → `img` の `src` が `/placeholder.png`。⑥商品詳細: `image_url: null` ・`image_urls: []` で落ちず placeholder、`image_url: null`・`image_urls: ['a','b']` ではサムネイルが 2 枚（`null` の 1 枚を足さない）。⑦管理の LOOK の商品選択（`LookForm`）: 商品の 1 件が `image_url: null` でも落ちず placeholder を描き、他の件は今のまま（`/api/admin/items` の応答を模した `ItemSummary[]` で描く）。Step 1 の JSON 境界の洗い出しで見つかった物にも同じ形の試験を 1 本ずつ足す。
- [ ] **Step 3（GREEN）: 直す。** 受け手の領域の中で閉じる。`CartItemRow`・`checkout/page.tsx` は型を `image_url: string`（cart-api が必ず文字を入れる）のまま使えるなら**触らない**。`wishlist/page.tsx` は検査を `typeof item.image_url === "string" \|\| item.image_url === null` にして、型を `string \| null` に。`NewsSection` は `src={item.image_url \|\| "/placeholder.png"}`。`ItemDetailClient` は `thumbnailImages` を `(item.image_urls?.length ? item.image_urls : [item.image_url]).filter((u): u is string => Boolean(u))`。`LookForm` は `ItemSummary.image_url` を `string | null` にし、`<Image src={item.image_url || "/placeholder.png"}>`（`unoptimized` はそのまま）。Step 1 の JSON 境界の洗い出しで見つかった物も同じ形で直す。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** 上の Test の各ファイル + `npx jest tests/unit/lib tests/unit/features/cart` の関連部分。
- [ ] **Step 5: 報告。** 直した受け手の一覧（P9 の表、`tsc` が足した物、JSON 境界の `grep` が足した物を分けて書く）、E2E の印は外さない、共有文書の変更案なし、Docs の確かめの結果（`NewsSection`・`admin/look/types.ts` の `@impl`/`@design` と `DD-` を直した・直さなかった理由）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- NEWS`、`-- LOOK`。

---

## Task 3: ITEM の署名を fail-closed にし、期限を 3600 秒にする（SEC-SEARCH-014・015(商品)・016、SEC-HOME-006・007）

**範囲:** `src/lib/storage/item-images.ts` の 3 関数。検索は期限を明示して呼ぶ。

**Files:**

- Modify: `src/lib/storage/item-images.ts`、`src/features/search/services/search.service.ts`（`:188`・`SEARCH_IMAGE_URL_TTL_SECONDS = 3600` を足して明示）
- Create: `tests/unit/lib/storage/item-images.test.ts`
- Test: `tests/integration/api/search-image-signing.test.ts`（`:217`・`:225` の「期限が 7 日」「`Cache-Control` が `null`」の現状固定を直す）、`tests/items/item-detail-api.test.ts`、`tests/integration/api/home-page-public-read.test.ts`（商品の節だけ）、`tests/unit/lib/items/`（`public.ts` の署名の呼び出し）
- E2E: `e2e/FR-SEARCH-019-search-api-contract-and-headers.spec.ts`、`FR-SEARCH-021-search-injected-rows.spec.ts`、`FR-HOME-023-home-published-only-and-content.spec.ts`
- Docs: `docs/02_Requirements/areas/search.md`（`SEC-SEARCH-014`・`015`・`016`）・`home.md`（`SEC-HOME-006`・`007`）、`docs/05_Quality/security/threats/{search,home}.md`、`docs/03_BasicDesign/areas/{search,home}.md`、`docs/03_BasicDesign/decisions/ADR-0316-search-image-signing-own-path-fail-closed.md`（新規）、`docs/04_DetailDesign/pages/19_search.md`・`01_home.md`

**Interfaces:**

```ts
// item-images.ts
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;            // 3600（7 日から）
// 署名の使い回し: 残りが expiresIn / 2 以上ある間だけ（SIGNED_URL_CACHE_BUFFER_SECONDS = 60 はやめる）
export async function signItemImageUrl(supabase, rawUrl, expiresIn = DEFAULT_SIGNED_URL_EXPIRY_SECONDS): Promise<string | null>;
// 無効・署名失敗は null（元の値を返さない）。失敗の種類だけ console.warn
export async function signItemImageUrls(supabase, rawUrls, expiresIn?): Promise<Array<string | null>>; // 入力と同じ長さ・同じ位置
export async function signItemImageFields<T>(…): Promise<SignedItemImageFields<T>>;
// search.service.ts
export const SEARCH_IMAGE_URL_TTL_SECONDS = 3600;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `item-images.ts:85-100`（`return rawUrl`・`?? rawUrl`）、`:102-143`（`rawUrl` の返し）、署名の in-memory キャッシュ（`:7`・`:53-76`: キーは `path:expiresIn`、`expiresIn - 60` 秒だけ使い回す）。**TTL 3600 だと、使い回しの最後の頃に作られた頁は残り約 60 秒の URL を載せる**（P8 の②）ので、使い回す窓を縮める（Step 3）、`grep -rn "signItemImage" src | grep -v storage/` の呼び手（P8: 検索 `search.service.ts:188`、カート `cart-view.ts:83`、お気に入り `wishlist/route.ts:141`、決済の確認 `create-session:855`・`resume:144`、顧客の注文 `orders/route.ts:195`・`orders/[id]/route.ts:161`、注文の状況 `order-status/[token]/page.tsx:42`、LOOK の関連商品 `look/server.ts:311`、公開の商品 `items/public.ts:71,166`・`api/items/[id]/route.ts:72`、管理 `admin/items/route.ts:229`・`[id]/route.ts:136`）。**期限を明示している呼び手は無い**ことを確かめる。
- [ ] **Step 2（RED）: 単体試験を書く**（`item-images.test.ts`、先頭 `DD-SEARCH-011`）。`createSignedUrl` をモック。①既定の期限が 3600（`createSignedUrl` の第 2 引数）。②自分の host の `/object/public/item-images/items/…` → 道筋に直して署名する。③別 host・`..`・`other/x.png`・空・`null` → `null` で `createSignedUrl` を**呼ばない**。④`createSignedUrl` が `{ error }` / `{ data: null }` → `null`（元の値でない）。⑤署名の失敗は `console.warn` が固定の語（`invalid_path` / `sign_failed`）だけで、道筋・URL・誤りの文を含まない。⑥`signItemImageUrls`: 無効が混ざっても**位置を保つ**（長さが同じ・無効の位置が `null`）。⑦`signItemImageFields`: Review Focus 2 の入力。⑧キャッシュ: 同じ道筋・同じ期限は、残りが期限の半分以上ある間は 2 回目に `createSignedUrl` を呼ばない（現行の「呼ばない」動きを保つ）。**使い回しの窓**: `jest.useFakeTimers` で、署名の 1799 秒後は使い回す（呼ばない）、1801 秒後は新しく署名する（呼ぶ。返る URL の残りが 1800 秒を切らない）、3540 秒後に取り出しても残りが約 60 秒の URL を返さない、を固定する。キーは `path:expiresIn` のままで、期限の違う呼び手（メール等）の URL を取り違えない。**書き換える現状固定**: `search-image-signing.test.ts` の 7 日と、失敗で元の値を期待する物、`tests/items/item-detail-api.test.ts` の署名の期限・元の値。
- [ ] **Step 3（GREEN）: 実装する。** `item-images.ts` を上のとおり。`extractItemImageObjectPath` は `admin` の後始末等で使われなければ**残す**（使われていなければ「使われていないコード」として報告する。消さない）。`parseOwnObjectPath(raw, { bucket: 'item-images', prefix: 'items' })` を使う。**キャッシュの使い回しの窓を縮める**: `SIGNED_URL_CACHE_BUFFER_SECONDS = 60` をやめ、`expiresAtMs = Date.now() + (expiresIn / 2) * 1000`（残りが期限の半分以上ある間だけ使い回す。`Math.max(1, …)` の下限は残す）にする。これで頁に載る URL の残りは常に `expiresIn / 2` 以上（3600 秒なら 1800 秒以上）。コメントに「頁に載せた URL が遅延読み込みの前に切れないため」と「なぜ」を書く。`search.service.ts` は `signItemImageUrl(supabase, result.imageUrl, SEARCH_IMAGE_URL_TTL_SECONDS)`（LOOK・NEWS も同じ値を明示してよい: Task 4・5）。`tsc`。
- [ ] **Step 4: 受け手の最終確認（読むだけ + 単体）。** Task 2 の受け手が `null` で動くこと。顧客の注文の `imageUrl: null`（`orders/route.ts:195`・`customer-order-view.ts:120`）、決済の確認（`checkout-confirmation.service.ts:113`）の型が `string \| null` であることを `tsc` で確かめる。**決済が Stripe に画像の URL を送らない**ことも読んで確かめる（`create-session/route.ts:1017,1027,1038` の `product_data` は `{ name }` だけ。スナップショット `:878` は生の `image_url` を持ち、確認画面が表示のたびに署名し直す。P8 の①）。さらに `null` のとき頁が落ちる所が無いことを `grep` で確認。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/lib/storage tests/integration/api/search-image-signing.test.ts tests/items tests/unit/lib/items tests/unit/features/search tests/integration/api/home-page-public-read.test.ts tests/unit/api/checkout tests/unit/api/orders`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-SEARCH-019:142`（SEARCH-014。検索の `imageUrl` の署名の期限が発行から 1 時間以内）、`FR-SEARCH-021:283`（SEARCH-016。置き場の決まった場所の外の道筋・別 host の URL の商品は `imageUrl` が `null`）、`FR-HOME-023:203`（HOME-006-AC-02。外の住所を入れた商品のカードの画像の `src` に外の住所が出ない。カードが出ていること: `ItemCard` が `null` を受ける）、`FR-HOME-023:225`（HOME-007-AC-01。ホームの商品・LOOK の関連商品の署名の期限 1 時間以内）。
  - **まだ外さない**: `FR-SEARCH-021:393`（SEARCH-015。商品**と LOOK** を見る。Task 4 で外す）。
  - `FR-HOME-023:225` は LOOK の関連商品の署名（`look/server.ts:311`）も `signItemImageUrl`（既定の 3600）を通るので、このタスクだけで反転する見込み。ホームの商品は `items/public.ts` の `signItemImageFields`。実際に流して確認。
- [ ] **Step 7: 文書。** `areas/search.md`: `SEC-SEARCH-014`・`016` の「今のコードは満たさない」を外し、`SEC-SEARCH-015` は「ITEM は満たす。LOOK は Task 4」と書く。`areas/home.md`: `SEC-HOME-006`・`007` を外す。要件の文（LOOK-007 の判断）: 「日付の階層と uuid のファイル名」に限る文を「`<prefix>/` の下の安全な文字」に書き換える（`SEC-LOOK-007` は Task 4）。`threats/*`: `THR-SEARCH-*`・`THR-HOME-*` の対応する行。`areas/search.md`（構造設計）: 画像の署名の部品（`ARC-SEARCH-`）に「道筋を確かめ、失敗は null」を足す。`19_search.md`・`01_home.md`: `DD-SEARCH-011`（署名の道筋の確かめ・期限 3600）、`01_home.md` の署名の節。**`DD-SEARCH-011` は Task 1 が作った項目に、期限 3600・使い回しの窓（残りが期限の半分以上の間だけ）・失敗は null の節を足す**（新しく作らない）。`ADR-0316`（背景: 署名は service role で行うので置き場の方針が効かない／決定: 共有の `parseOwnObjectPath`、失敗は null、期限 3600、署名の使い回しは期限の半分まで（頁に載る URL の残りを 1800 秒以上に保つ）／退けた案: 元の値を返す・DB の CHECK だけで守る（CHECK は波 2 で `NOT VALID` で入れた。管理の書き込みを守るが、読みの署名の穴は塞がない）／結果）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`、`npm run validate-trace -- HOME`（`--update-baseline` はしない）。
- [ ] **Step 9: 報告。** 変えたファイル、外した印の行番号、`null` が出る呼び出しの一覧と受け手の扱い、`order_items.item_image_url`（本番 0 行）の旧い形が来ても `null` になるだけで落ちないこと、共有文書の変更案（なし。**DB の値の直しは要らない**: P6）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`、`-- HOME`。

---

## Task 4: LOOK の署名を fail-closed にする（SEC-LOOK-007・008、SEC-SEARCH-015 の LOOK 側）

**範囲:** `src/lib/storage/look-images.ts`、`src/lib/look/server.ts` の署名なしの道筋、`isOwnLookImagePath` の委譲。

**Files:**

- Modify: `src/lib/storage/look-images.ts`（`signLookImageUrl` `:90-104`。`signLookImageUrls` は既に `null` を除く）、`src/lib/look/server.ts`（`mapLookRowToListItem` `:396` が署名していない `image_urls` を載せる経路を `imageUrls: []` に）、`src/features/look/services/admin-images.ts`（`isOwnLookImagePath` を `isSafeObjectPath(path, 'looks')` に委譲。`@impl IMPL-LOOK-153` の `@remarks` は動きが変わらないので直さない）、`src/features/search/services/search.service.ts`（LOOK の呼び出しに期限を明示）
- Test: `tests/unit/lib/storage/look-images.test.ts`、`tests/integration/api/look-image-signing.test.ts`、`tests/unit/lib/look-server.test.ts`・`look-public.test.ts`、`tests/unit/features/look/`（admin-images）
- E2E: `e2e/FR-LOOK-SEC-001-public-visibility.spec.ts`、`FR-SEARCH-021-search-injected-rows.spec.ts`
- Docs: `docs/02_Requirements/areas/look.md`（`SEC-LOOK-007`・`008`）・`search.md`、`docs/05_Quality/security/threats/look.md`、`docs/03_BasicDesign/areas/look.md`、`docs/04_DetailDesign/pages/07_look_detail.md`・`06_look_list.md`・`16-3_admin_look.md`（`DD-LOOK-006` の `@remarks` の写し）

- [ ] **Step 1: 現状の確認（読むだけ）。** `look-images.ts:82-104` の `rawUrl` を返す 2 行（`:98`・`:103`）。`look/server.ts:215-220`（詳細）・`:378`（一覧）で `signLookImageUrls` の結果だけを `imageUrls` に使うこと、`mapLookRowToListItem` が `row.image_urls`（生）を載せる経路が上書きされない呼び手が無いか（`grep -n "mapLookRowTo" src/lib/look/server.ts`）。`admin-images.ts:56-` の `isOwnLookImagePath` の式が `parseOwnObjectPath` の式と同じこと。
- [ ] **Step 2（RED）: 試験を書く**（先頭 `DD-LOOK-006`）。①`signLookImageUrl`: 外の URL・`../other/x.png`・`other/x.png`・別バケットの URL・署名失敗 → `null`、元の値を返さない。自分の host の `/object/public/look-images/looks/…` → 署名する。②`signLookImageUrls`: 無効を除く（既存）。③`look/server.ts`: 一覧の署名が失敗しても `imageUrls` に**生の値が出ない**（`[]`）。④`isOwnLookImagePath` の既存の試験は同じ結果（委譲の確認）。**書き換える現状固定**: `look-image-signing.test.ts`・`look-images.test.ts` の「元の値を返す」期待。
- [ ] **Step 3（GREEN）: 実装する。** `signLookImageUrl` を `parseOwnObjectPath(raw, { bucket: 'look-images', prefix: 'looks' })` で書き換え、`@remarks` を「道筋が取れない時と署名に失敗した時は null を返し、元の値は渡さない」に直す。`mapLookRowToListItem` の `imageUrls` を `[]` に（呼び手が署名した値で上書きする）。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/lib/storage tests/integration/api/look-image-signing.test.ts tests/unit/lib/look-server.test.ts tests/unit/lib/look-public.test.ts tests/unit/features/look tests/unit/app/look tests/integration/ui/look-public-read-path.test.tsx tests/integration/api/look-admin-*.test.ts`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOOK-SEC-001:362`（LOOK-007-AC-01。`../dir/x.png` と `dir/x.png` を入れた公開の LOOK の HTML に `dir/x.png` を指す署名つき URL が出ない）、`FR-LOOK-SEC-001:394`（LOOK-008-AC-01、3 幅。外の URL が `src` と `og:image` に出ない）、`FR-SEARCH-021:393`（SEARCH-015-AC-01、3 幅。Task 3 と合わせて反転）。
  - `og:image` の部分（`:394` のテストの `ogImages(opened.html)` が外の URL を含まない）は、今の `generateMetadata` が署名された画像だけを使うので、このタスクで満たされる（外の URL は署名が `null` になり `imageUrls` が空で `images: []`）。Task 11 で `og:image` が窓口になっても保たれる。
  - 外さない: `FR-LOOK-SEC-001:333`（Task 11）、`FR-LOOK-SEC-002:270`・`SEC-004:299,429`（別の波）。
- [ ] **Step 6: 文書。** `areas/look.md`: `SEC-LOOK-007`・`008` の「今のコードは満たさない」を外し、`SEC-LOOK-007` の式を「`looks/` の下の安全な文字」に書き換える。`threats/look.md`、構造設計の署名の部品、`DD-LOOK-006` の `@remarks` の写し（`06_look_list.md`/`07_look_detail.md` のどちらにあるかは `grep -rn "DD-LOOK-006" docs`）。`search.md`: `SEC-SEARCH-015` の「今のコードは満たさない」を外す。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`、`-- SEARCH`。
- [ ] **Step 8: 報告。** 外した印、LOOK の画像が `null` になった時の表示（`LookSection` 等が placeholder）、共有文書の変更案（なし）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。

---

## Task 5: NEWS の署名を fail-closed にする（SEC-NEWS-007・008）

**範囲:** `src/lib/storage/news-images.ts`、`isOwnNewsImagePath` の委譲。NEWS の画像を署名して出す所は管理の一覧・詳細（`admin/news/route.ts:224`・`[id]/route.ts:121`）と検索（`search.service.ts:192`）だけで、公開の `/news` の頁は画像を出さない。

**Files:**

- Modify: `src/lib/storage/news-images.ts`（`signNewsImageUrl` `:84-100`、`signNewsImageFields`）、`src/features/news/services/admin-images.ts`（`isOwnNewsImagePath` の委譲）、`src/features/search/services/search.service.ts`（期限を明示）
- Test: `tests/unit/lib/storage/news-images.test.ts`、`tests/integration/api/news-image-signing.test.ts`、`tests/integration/api/news-admin-list-api.test.ts`・`news-admin-item-get-api.test.ts`、`tests/unit/features/news/`（admin-images）
- E2E: なし（NEWS-007・008 には元から印が無い。`FR-NEWS-SEC-001` の印は 1-B・1-C で外れている）。新しい期待は結合試験に置く
- Docs: `docs/02_Requirements/areas/news.md`（`SEC-NEWS-007`・`008`）、`docs/05_Quality/security/threats/news.md`、`docs/03_BasicDesign/areas/news.md`、`docs/04_DetailDesign/pages/16-1_admin_news.md`・`03_news_detail.md`（`DD-NEWS-067`・`068`）

- [ ] **Step 1: 現状の確認（読むだけ）。** `news-images.ts:84-100`（`rawUrl` を返す 2 行）と `signNewsImageFields`（`image_url: await signNewsImageUrl(...)`）、管理の画面が `null` を受けること（Task 2 で `NewsSection` を直した）。`admin/news/[id]/route.ts:408` 周辺の後始末が `extractNewsImageObjectPath` を使う（残す）。
- [ ] **Step 2（RED）: 試験を書く**（先頭 `DD-NEWS-068`）。①`signNewsImageUrl`: 外の URL・`news/../x`・`other/x.png`・署名失敗 → `null`。素の道筋 `news/e2e/news-1.png`・`/object/public/news-images/news/…`（本番の 2 つの形）→ 署名する。②`signNewsImageFields` は `image_url: null` を返し、他の項目はそのまま。③`isOwnNewsImagePath` の既存の試験は同じ結果。**書き換える現状固定**: `news-image-signing.test.ts`・`news-images.test.ts` の「元の値を返す」期待。
- [ ] **Step 3（GREEN）: 実装する。** `parseOwnObjectPath(raw, { bucket: 'news-images', prefix: 'news' })`。`@remarks`（`IMPL-NEWS-165` の「…」）を動きに合わせて直す。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/lib/storage tests/integration/api/news-image-signing.test.ts tests/integration/api/news-admin-list-api.test.ts tests/integration/api/news-admin-item-get-api.test.ts tests/unit/api/admin/news tests/unit/features/news tests/integration/api/search-image-signing.test.ts`。
- [ ] **Step 5: E2E の印: なし。** `FR-NEWS-SEC-001` に印が残っていないことを `grep -n "test.fail" e2e/FR-NEWS-SEC-001*` で確かめて報告に書く。
- [ ] **Step 6: 文書。** `areas/news.md`: `SEC-NEWS-007`・`008` の「今のコードは満たさない」を外し、現行（道筋を確かめ、失敗は null）を書く。`threats/news.md`、構造設計、`DD-NEWS-067`（取り出し）・`068`（署名）。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- NEWS`。
- [ ] **Step 8: 報告。** 変えたファイル、`src/lib/news-data.ts` の `newsData` が未使用であること（P11。消さない）、共有文書の変更案（なし）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- NEWS`。

---

## Task 6: `/ui` の見本ページの外部画像を `public/` の手元の画像に替える（Q6）

**範囲:** `src/app/ui/page.tsx` の `readdy.ai` の 7 か所（P10）だけ。CSP・`remotePatterns` は Task 7・8。

**Files:**

- Modify: `src/app/ui/page.tsx`（`:83-85`・`:256`・`:263`・`:270`・`:1602`）
- Test: `tests/unit/app/ui-page.test.tsx`（新規。ソースの文字列に `readdy.ai`・`placehold.co` が無いこと、画像の `src` が `/` で始まること）
- E2E: 流す（書き換えなし）: `FR-UI-001`・`002`・`004`・`005`、`FR-TERMS-005`、`slider-*` の 8 本
- Docs: **`docs/04_DetailDesign/pages/01_home.md` に `DD-HOME-004` の項目だけ作る**（見出し直後の属性表・題「CSP の組み立てと外部ドメインを使わない見本ページ」・上位の `ARC-HOME-` への紐付け・このタスクの範囲の要約として「`/ui` は外部の画像を使わない」）。`ui-page.test.tsx` の先頭の `DD-HOME-004` がこのタスクのコミットの時点で在り、`npm run validate-trace -- HOME` が通るようにするため。Task 7 が `buildCsp` の節を足す。`docs/02_Requirements/areas/about.md`・`home.md`（`/ui` の画像の記述があれば）、`docs/05_Quality/security/threats/about.md`・`home.md`（「範囲外の指摘」の `/ui`）

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "readdy" src/app/ui/page.tsx`（7 行）。`Avatar`（`src/components/ui/…`）・`Carousel` が生の `<img>` か `next/image` か。`ls -la public`（`news1.png` 365KB・`news2.png` 712KB・`news3.png` 309KB・`placeholder.png` 584KB。`mainphoto.png` 3.3MB・`about.png` 2.6MB は重いので使わない）。`/ui` の E2E の一覧（`grep -rln "'/ui'\|goto('/ui" e2e`）が画像を見ないこと。
- [ ] **Step 2（RED）: 試験を書く。** `ui-page.test.tsx`（先頭 `DD-HOME-004`。項目は Docs のとおりこのタスクで作る。CSP から外す物を `/ui` が使わないことの静的な確かめ）: ファイルの文字列に `readdy.ai`・`placehold.co`・`https://` の画像の URL が無い。
- [ ] **Step 3（GREEN）: 置き換える。** carousel = `/news1.png`・`/news2.png`・`/news3.png`、cardItems の 3 枚と Avatar の `src` = `/placeholder.png`（`alt` は今のまま）。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/app/ui-page.test.tsx`。
- [ ] **Step 5: E2E: 印なし。** `FR-UI-*`・`slider-*` が `/ui` を開いて通ることを controller が確かめる（Task 14 の一覧）。`FR-ABOUT-008`・`009` の `readdy.ai` の不在の確認は変わらない。
- [ ] **Step 6: 文書。** `areas/about.md`・`threats/about.md` の「範囲外の指摘: `/ui` の `readdy.ai`」を「手元の画像に替えた」に直す。`threats/home.md` の同じ行。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- HOME`。
- [ ] **Step 8: 報告。** 実際は 9 枚でなく 7 か所だったこと、使った既存の画像、`src/lib/news-data.ts` の `newsData` が未使用（P11）、コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- HOME`。

---

## Task 7: CSP を自分のプロジェクト・Stripe（全頁）・Turnstile だけにする（`src/proxy.ts`。SEC-HOME-009-AC-01、SEC-ABOUT-003-AC-01、SEC-PRIVACY-014、Q29）

**範囲:** `src/proxy.ts` の `buildCsp` だけ。Cookie の発行・見出しは Task 9・10。

**Files:**

- Modify: `src/proxy.ts`（`buildCsp` `:54-131`）
- Test: `tests/unit/middleware/proxy-csp.test.ts`（前提の「`*.supabase.co` を許したまま」を「自分の origin だけ」に）、`tests/integration/api/home-page-proxy-csp.test.ts`（`:183-184`）、`tests/integration/api/privacy-proxy-headers.test.ts`（script-src の中身）、`tests/integration/api/about-proxy.test.ts`（`:213` 周辺の CSP 部分）、`tests/integration/api/news-proxy.test.ts`・`stockist-proxy.test.ts`（CSP を見る物があれば）
- E2E: `e2e/FR-HOME-022-home-response-hardening.spec.ts`、`FR-ABOUT-010-security-http-contract.spec.ts`、`FR-PRIVACY-006-response-headers-and-cookies.spec.ts`
- Docs: `docs/02_Requirements/areas/{home,about,privacy}.md`、`docs/05_Quality/security/threats/{home,about,privacy}.md`、`docs/03_BasicDesign/areas/{home,privacy}.md`（`privacy.md` の jsDelivr の行）、`docs/03_BasicDesign/decisions/ADR-0108-csp-own-project-stripe-turnstile-only.md`（新規。`ADR-0104` と並べる）、`docs/04_DetailDesign/pages/01_home.md`（`DD-HOME-004` は Task 6 が作った項目に `buildCsp` の節を足す）、`docs/03_BasicDesign/architecture/system-overview.md`（`readdy` の言及）

**Interfaces（最終形。配列は `toEqual` で固定する）:**

```text
script-src   'self' 'nonce-…' [dev: 'unsafe-eval'] https://challenges.cloudflare.com https://js.stripe.com https://*.js.stripe.com
style-src    'self' 'unsafe-inline'
style-src-elem 'self' [dev: 'unsafe-inline']
font-src     'self'
img-src      'self' data: <supabaseOrigin> https://q.stripe.com https://*.stripe.com
connect-src  'self' [dev: ws: wss:] <supabaseOrigin> https://challenges.cloudflare.com https://api.stripe.com https://r.stripe.com https://m.stripe.network https://q.stripe.com
frame-src    https://challenges.cloudflare.com https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://www.google.com https://maps.google.com
（その他は今のまま: default-src 'none'・base-uri・form-action・frame-ancestors・object-src・manifest-src・upgrade-insecure-requests・block-all-mixed-content）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `proxy.ts:54-131` の jsDelivr 4 か所（`:96` style-src、`:102` style-src-elem、`:109` script-src、`:123` font-src）、`placehold.co`（`:82`）、`readdy.ai`・`*.readdy.ai`（`:83-84`）、`*.supabase.co`（`:71` connect-src、`:86` img-src）。`grep -rn "jsdelivr\|placehold\|readdy\|\*\.supabase\.co" src --include=*.ts --include=*.tsx | grep -v "graphify"` で `src/proxy.ts`・`src/app/ui/page.tsx`（Task 6 で消えた）・`src/lib/news-data.ts`（未使用）以外に無いこと。Stripe を読むコードは `FinalConfirmationStep.tsx` の `loadStripe` だけ（`/checkout` 配下）。P12 の Stripe 公式との差（`*.js.stripe.com` が無い）。
- [ ] **Step 2（RED）: 試験を書く**（先頭 `DD-HOME-004`）。`proxy()` を通した見出しを `directives()` で割り、Interfaces の各ディレクティブを `toEqual`。道筋は `/`・`/privacy`・`/checkout`・`/api/auth/login`（全部同じ。**Stripe は全頁で同じ**: 決定 Q29）。①jsDelivr・`placehold.co`・`readdy.ai`・`*.supabase.co` がどのディレクティブにも無い。②`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` → `img-src`・`connect-src` に `http://127.0.0.1:54321`（`proxy-csp.test.ts` の既存の試験を「`*.supabase.co` が無い」に直す）。③`NEXT_PUBLIC_SUPABASE_URL` が無く `SUPABASE_URL` だけ → その origin。④どちらも無い → 空の項目が出ない（既存）。⑤`NODE_ENV=production` で `script-src` に `'unsafe-eval'` が無い。**書き換える現状固定**: `home-page-proxy-csp.test.ts:183-184`（`style-src` は `['self','unsafe-inline']`、`style-src-elem` は `['self']`）、`proxy-csp.test.ts` の 2 本。
- [ ] **Step 3（GREEN）: 実装する。** `buildCsp` の配列を上のとおり。`ADR-0104` の `style-src-elem` の理由（CSS の盗み出しは要素の差し込みが前提）は変えない。コメントに、Stripe を全頁に残す理由（CSP は文書を読み込んだ時に決まり `next/link` の遷移で変わらない。`/cart` → `Link` で `/checkout` へ進むと `/cart` の CSP のまま `FinalConfirmationStep` の `loadStripe` が止められる。Stripe 公式も全頁での読み込みを勧める）を書く。`'strict-dynamic'` は入れない（Turnstile の `<Script>` に nonce が付くかを本番ビルドで確かめてからの別件）。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** Global Constraints の proxy の試験群。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-HOME-022:94`（HOME-009-AC-01。`connect-src` に `https://*.supabase.co` が無いことを含む）、`FR-ABOUT-010:76`（ABOUT-003-AC-01）。
  - **書き換える（Q29。反転でなく要件と試験を直す）**: `FR-PRIVACY-006:57`（`SEC-PRIVACY-014-AC-02`）の `test.fail` を外し、題を「`/privacy` の CSP の `script-src` に `cdn.jsdelivr.net` が含まれない」にして、`not.toContain('js.stripe.com')` を消す。新しい `SEC-PRIVACY-014-AC-03` を同じファイルに足す: `/privacy` の `script-src` が `https://js.stripe.com` と `https://*.js.stripe.com` を含む（Q29 の決定を固定する）。
  - **足す**: `FR-HOME-022` に `SEC-HOME-009-AC-03`（3 幅）: `seedCart`（`e2e/checkout-flow-helpers.ts`）で `/cart` を開き、「レジへ進む」（`ご購入手続きへ` のリンク）を押して `/checkout` へ進み、`fillShippingForm` → `proceedToFinal` で Stripe の部品（`paymentElementFrame`）が出るまで、`securitypolicyviolation` を記録して **外部リソース（`^https?:`）の違反が 0 件**（`FR-CHECKOUT-025` の `blockedExternalResources` と同じ除外）。`FR-CHECKOUT-025` は `page.goto('/checkout')` で始めるので、`/cart` から押して進む経路は新しい試験が持つ。
  - 外さない: `FR-HOME-022:118`・`FR-ABOUT-010:102`・`FR-NEWS-SEC-003:109,144`（Task 8）、`FR-HOME-022:149`（Task 12）。
- [ ] **Step 6: 文書。** `areas/home.md`: `SEC-HOME-009-AC-01` の「今のコードは満たさない」を外し、`SEC-HOME-009-AC-03` を足す（対応表にも）。`SEC-HOME-009-AC-02`（`eval` の違反）は**文書に無い食い違い**として E2E に印があった物。Task 12 で扱う。`areas/about.md`: `SEC-ABOUT-003-AC-01` を外す。`areas/privacy.md`: `SEC-PRIVACY-014` の本文を「`/privacy` の `script-src` は nonce を求め、使っていない外のドメイン（`cdn.jsdelivr.net`）を許さない。`js.stripe.com` は全頁で許す（CSP は文書を読み込んだ時に決まり、`next/link` の遷移で変わらないため。Stripe 公式も全頁での読み込みを勧める）。`challenges.cloudflare.com` も同じ」に直し、`AC-02` の文と `AC-03` を書く。`threats/{home,about,privacy}.md` の jsDelivr・Stripe の行。`areas/privacy.md`（構造設計）の jsDelivr の行（`docs/03_BasicDesign/areas/privacy.md`）。`system-overview.md` の外部ドメインの一覧。`ADR-0108`（背景: 使っていない CDN と全 Supabase を許していた／決定: 実際に使う物だけ・Stripe は全頁で Stripe 公式の一覧に揃える（`*.js.stripe.com` を足す）／退けた案: `/checkout` 配下だけに Stripe を絞る（`next/link` の遷移で CSP が変わらず決済が止まる）、`'strict-dynamic'`（Turnstile を実測してから）、Link・Google マップの許可（使っていない）／結果）。`ADR-0104` の「関連文書」に `ADR-0108` を足す。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- HOME`、`-- ABOUT`、`-- PRIVACY`。
- [ ] **Step 8: 報告。** 外した印、書き換えた印（PRIVACY-014-AC-02）、足した試験、**本番の前の確認**（P12 の Link）、共有文書の変更案（なし）。

**検証コマンド:** `npx tsc --noEmit`、proxy の試験群、`npm run validate-docs`、`npm run validate-trace -- HOME|ABOUT|PRIVACY`。

---

## Task 8: `next.config.ts` の画像の中継を自分のプロジェクトの署名つきの道だけにし、キャッシュを 3600 秒にする（SEC-HOME-017、SEC-NEWS-004-AC-02・023、SEC-ABOUT-003-AC-02）

**範囲:** `next.config.ts` の `images` だけ。本番の環境変数の確かめは Task 13。

**Files:**

- Modify: `next.config.ts`（`:10-17`・`:33-83`）
- Create: `tests/unit/next-config.test.ts`
- E2E: `e2e/FR-HOME-022-home-response-hardening.spec.ts`、`FR-ABOUT-010-security-http-contract.spec.ts`、`FR-NEWS-SEC-003-http-hardening-and-rate-limit.spec.ts`
- Docs: `docs/02_Requirements/areas/{home,about,news}.md`、`docs/05_Quality/security/threats/{home,about,news,look}.md`、`docs/03_BasicDesign/areas/home.md`（画像の中継）、`docs/04_DetailDesign/pages/01_home.md`

**Interfaces:**

```ts
// next.config.ts（既定の export の images だけが変わる）
images: {
  ...(localSupabaseStorage ? { dangerouslyAllowLocalIP: true } : {}),
  minimumCacheTTL: 3600,
  remotePatterns: [
    // 本番: NEXT_PUBLIC_SUPABASE_URL の host 1 つ・署名つきの道だけ
    ...(remoteSupabaseHost ? [{ protocol: 'https', hostname: remoteSupabaseHost, port: '', pathname: '/storage/v1/object/sign/**' }] : []),
    // 手元: 今の枝（localSupabaseStorage）を残す
    ...(localSupabaseStorage ? [{ protocol, hostname, port, pathname: '/storage/v1/object/**' }] : []),
  ],
}
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `next.config.ts:35-71` の 6 つの本番の枝（`placehold.co`・`readdy.ai`・`public.readdy.ai`・`*.supabase.co` の `public`・`sign`・`authenticated`）と、手元の枝（`:72-81`）。E2E が使う手元の Supabase の URL（`scripts/e2e/environment.ts`）。`FR-NEWS-SEC-003:109` が `news-images` の署名つき URL（手元）を `/_next/image` に通して 200 と `max-age <= 3600` を見る。手元のバケットの見本の上げ方（`scripts/e2e/seed-storage.ts`）の `cacheControl`。
- [ ] **Step 2（RED）: 単体試験を書く**（`tests/unit/next-config.test.ts`。`jest.isolateModules` で `process.env` を差し替えて `require('../../next.config')` を読み直す。先頭 `DD-HOME-004`）。①`NEXT_PUBLIC_SUPABASE_URL=https://abcd1234.supabase.co` → `remotePatterns` は**ちょうど 1 件** `{ https, abcd1234.supabase.co, '', /storage/v1/object/sign/** }`、`dangerouslyAllowLocalIP` なし。②`http://127.0.0.1:54321` → 手元の枝だけ（`protocol: 'http'`・`port: '54321'`・`/storage/v1/object/**`）と `dangerouslyAllowLocalIP: true`。③`placehold.co`・`readdy.ai`・`public.readdy.ai`・`*.supabase.co`・`/object/public/**`・`/object/authenticated/**` がどの場合にも無い。④`minimumCacheTTL === 3600`。⑤環境変数が無い（`VERCEL_ENV` も無い）→ Supabase の枝が 0 件で例外を投げない（CI のビルド）。
- [ ] **Step 3（GREEN）: 実装する。** 上のとおり。`remoteSupabaseHost` は `new URL(NEXT_PUBLIC_SUPABASE_URL)` の `hostname`（`https:` で、ローカルでない時）。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/next-config.test.ts`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-HOME-022:118`（HOME-017-AC-01。`readdy.ai` と別のプロジェクト `e2eotherprojectref.supabase.co` が 400）、`FR-ABOUT-010:102`（ABOUT-003-AC-02。`placehold.co`・`readdy.ai` が 4xx）、`FR-NEWS-SEC-003:109`（NEWS-004-AC-02。署名つきの最適化の画像の `max-age <= 3600`）、`FR-NEWS-SEC-003:144`（NEWS-023-AC-01。別のプロジェクトのホストが 400）。
  - **`:109` の注**: 反転するかは手元のバケットの `cache-control` の値次第（Next は上流の `max-age` と `minimumCacheTTL` の大きいほうを使う）。見本が `cacheControl: '3600'` で上がっていれば `3600`。そうでなければ**この印は外さず**（外すと赤）、実測の値を報告して `seed-storage.ts` の扱いを controller に返す（このタスクの範囲外）。
  - `FR-ABOUT-010:102` は今のコードが外の 2 ホストへ実際に取りに行く（注記）。直した後は取りに行かない。
- [ ] **Step 6: 文書。** `areas/home.md`: `SEC-HOME-017` を外し、`areas/news.md`: `SEC-NEWS-004-AC-02`・`SEC-NEWS-023`、`areas/about.md`: `SEC-ABOUT-003-AC-02`。`threats/*` の `/_next/image` の行。`areas/home.md`（構造設計）に画像の中継の節（本番の host 1 つ・署名つきの道だけ・手元の枝・`minimumCacheTTL: 3600` と署名の期限の関係）。`ADR-0108` に追記（決定に `remotePatterns` を足す）。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- HOME|ABOUT|NEWS`。
- [ ] **Step 8: 報告。** 外した印・外さなかった印（`:109` の実測）、**E2E の 3000 番の残りを止めてから流す**こと（`next.config.ts` はビルドに焼かれる。controller への注意）、共有文書の変更案（なし）。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/unit/next-config.test.ts`、`npm run validate-docs`、`npm run validate-trace`（3 領域）。

---

## Task 9: `session_id` の発行を `/cart`・`/checkout`・`/api/checkout` だけにする（`src/proxy.ts`。SEC-PRIVACY-015、Q23）

**範囲:** `src/proxy.ts` の Cookie の発行の条件だけ。

**Files:**

- Modify: `src/proxy.ts`（`:228-232`）
- Create: `tests/unit/middleware/proxy-session.test.ts`
- Test（書き換え）: `tests/integration/api/about-proxy.test.ts`（`:130`〜`:186` の ARC-ABOUT-002 の Cookie の 5 本）、`tests/integration/api/privacy-proxy-headers.test.ts`（`:121`〜`:154`）
- E2E: `e2e/FR-PRIVACY-006-response-headers-and-cookies.spec.ts`（`:68` の印、新しい AC-02）、`FR-ABOUT-010-security-http-contract.spec.ts`（`:117-148`）、`FR-CART-002-005-006-007-summary-session-empty.spec.ts`（`:5-12`。**変えない**が通ること）、`FR-LOGIN-036-otp-verify-and-resend-pending-cookie.spec.ts`（`:529` の注の文だけ）
- Docs: `docs/02_Requirements/areas/{privacy,about}.md`、`docs/05_Quality/security/threats/privacy.md`、`docs/03_BasicDesign/areas/privacy.md`（`:39`・`:98` 付近の「Cookie の無い閲覧者には `session_id` を発行する」）・`auth.md`（`:1194` の `session_id` の表）・`about.md`（ARC-ABOUT-002）、`docs/03_BasicDesign/decisions/ADR-0355-privacy-session-id-allowlist.md`（新規）、`docs/04_DetailDesign/pages/17-1_privacy.md`（`DD-PRIVACY-004`）

**Interfaces:**

```ts
// src/proxy.ts
const SESSION_COOKIE_ISSUE_PATH_PREFIXES = ['/cart', '/checkout', '/api/checkout'] as const;
function shouldIssueSessionCookie(pathname: string): boolean; // matchesPathSegment のどれかに当たる時だけ true
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P1 の読み手の表を `grep -rnE "get\(['\"]session_id['\"]\)|sessionCookieName|extractSessionIdFromCookie|x-session-id" src --include=*.ts --include=*.tsx` で作り直し、**許可リストの外で `session_id` が無いと動かなくなる所が無い**ことを確かめる（P1・P2）。無ければそのまま進める。**あれば止めて controller に返す（拡げない）**。E2E の補助の読み: `e2e/checkout-flow-helpers.ts`・`checkout-test-utils.ts`・`shop-test-utils.ts` が決済 API を直に叩く前に `/cart`・`/checkout` を開いているか。Review Focus 6 の一覧を作る。
- [ ] **Step 2（RED）: 試験を書く**（`proxy-session.test.ts`、先頭 `DD-PRIVACY-004`）。`proxy(new NextRequest(url))` の表: **発行する**: `/cart`・`/cart/`・`/checkout`・`/checkout?session_id=cs_x`・`/api/checkout/create-session`（POST は Origin の検査を通す設定が要る: 既存の `proxy-origin.test.ts` の流儀）・`/api/checkout/complete`。**発行しない**: `/`・`/about`・`/privacy`・`/terms`・`/news`・`/look/1`・`/look/1/og`・`/item/1`・`/api/auth/login`・`/api/search`・`/cartx`・`/checkoutx`・`/api/checkoutx`・`/apicheckout`。既に `session_id` がある要求は**どの道筋でも** `Set-Cookie` を付けない（既存）。本番で `Secure`、30 日・`HttpOnly`・`Lax`・32 桁の 16 進（既存の `about-proxy` の形を `/cart` に移す）。**書き換える**: `about-proxy.test.ts` の「最初の要求で発行」「ごとに違う id」「Secure」「既にあれば付けない」「他の Cookie だけなら発行」の 5 本は `aboutRequest({}, '/cart')` を使い（題の `ARC-ABOUT-002` は `/about` に付く守りの見出しの試験と分け、発行は `ARC-PRIVACY-002` 側に寄せるか、題を「許可リストの道では」に直す）、`/about` は「`Set-Cookie` を付けないが守りの見出しは付く」を足す。`privacy-proxy-headers.test.ts:121-154` も同様（`/privacy` は付かない試験を足す）。
- [ ] **Step 3（GREEN）: 実装する。** `let sessionId = request.cookies.get(...)` の塊を `if (shouldIssueSessionCookie(pathname) && !request.cookies.get(sessionCookieName)?.value) { response.cookies.set(sessionCookieName, generateSessionId(), cookieOptionsForSession(SESSION_COOKIE_MAX_AGE)); }` にする（`sessionId` の変数が他で使われていなければ消す。使われていない変数は自分の変更が作った物なので消してよい）。コメントを「既定は配らない。許可リストは、決済の流れだけが `session_id` を読む（読み手の表）から」に直す。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** Global Constraints の proxy の試験群 + `npx jest tests/unit/middleware/proxy-session.test.ts`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-PRIVACY-006:68`（PRIVACY-015-AC-01、3 幅）。
  - 書き換える: `FR-ABOUT-010:117-130`（ABOUT-004-AC-01）: 題を「Cookie を持たない要求の /about は共有のキャッシュに残らない」にし、`cookies.length > 0` と `session_id` の確認を消して `expectNotSharedCacheable(response)` だけ残す（P4。`Set-Cookie` が付かないことの確認は PRIVACY-015 側が持つ）。`:132-148`（AC-02）: `/about` から `session_id` を取る部分を、固定の 32 桁の値を `Cookie` に付けて要求する形にし、`Set-Cookie` が無く共有のキャッシュに残らないことを確かめる。
  - 足す: `FR-PRIVACY-006` に `SEC-PRIVACY-015-AC-02`: Cookie の無い新しい context で、`/cart`・`/checkout` では `session_id` が発行され（`context.cookies()` に出る・属性 `HttpOnly`・`Lax`）、`/`・`/about`・`/terms`・`/news` では発行されない（頁ごとに新しい context。3 幅）。
  - 変えない/確かめる: `FR-CART-002:5-12`（`/cart` で `session_id` が発行され 30 日）は緑のまま。`FR-LOGIN-036:529` の注の文（「proxy が全部の応答に付ける」）を「`/cart` などの決済の道だけ」に直す（`filter` は残す。害は無い）。`FR-WISHLIST-011:60-66` は取れなくなるが使わない（Review Focus 6）。報告に書く。
- [ ] **Step 6: 文書。** `areas/privacy.md`: `SEC-PRIVACY-015` の「今のコードは満たさない」を外し、「発行する道は許可リスト（`/cart`・`/checkout`・`/api/checkout`）。既定は配らない」と書き、`AC-02` を足す。`areas/about.md`: `SEC-ABOUT-004-AC-01` の文（Set-Cookie がある応答も…）を、Set-Cookie の有無に依らず共有のキャッシュに残らない、に直す。`threats/privacy.md`。`areas/privacy.md`（構造設計）`:39`・`:98`、`areas/auth.md:1194` の `session_id` の表（発行する道）、`areas/about.md`（`ARC-ABOUT-002`）。`17-1_privacy.md`: `DD-PRIVACY-004`。`ADR-0355`（背景: 全頁・全 API に 30 日の識別子を配っていた／決定: 許可リスト、既定は配らない、読み手は決済の流れだけ（読み手の表）／退けた案: `/privacy` だけ除く（既定が「配る」のまま）、`create-session` の応答で発行（クライアントの流れを変える）／結果: `/og` のような公開の共有キャッシュの応答に Cookie が付かない。ログインの成功の時の回転（`register.ts:57`、許可リストの外の `/api/auth/*` にも `Set-Cookie` が付く）は残す。セッション固定への守りで `FR-CHECKOUT-046` が頼るため（ruling 10））。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- PRIVACY`、`-- ABOUT`。
- [ ] **Step 8: 報告。** P1 の確認の結果（**拡げる必要が無かった**こと、または見つけた物）、Review Focus 6 の E2E の一覧、外した・書き換えた・足した E2E、共有文書の変更案（`api-spec.md` に Cookie の発行範囲の記述があれば）。

**検証コマンド:** `npx tsc --noEmit`、proxy の試験群、`npm run validate-docs`、`npm run validate-trace -- PRIVACY|ABOUT`。

---

## Task 10: `/api/auth` 配下の応答に `Cache-Control: no-store` を付ける（`src/proxy.ts`。SEC-AUTH-022-AC-02）

**範囲:** `src/proxy.ts` の 2 か所の返り（`Forbidden origin` の早期 return と `NextResponse.next()` の後）だけ。route が自分で付ける値は消さない。

**Files:**

- Modify: `src/proxy.ts`（`:205-213`・`:226-243`）
- Create: `tests/unit/middleware/proxy-no-store.test.ts`
- E2E: `e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts`
- Docs: `docs/02_Requirements/areas/auth.md`（`SEC-AUTH-022-AC-02`）、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/03_BasicDesign/decisions/ADR-0415-auth-no-store-in-proxy.md`（新規）、`docs/04_DetailDesign/pages/14_login.md`（`DD-AUTH-037`）

**Interfaces:**

```ts
// src/proxy.ts
const NO_STORE_PATH_PREFIX = '/api/auth';           // matchesPathSegment
// Forbidden origin（403）と NextResponse.next() の両方で、/api/auth 配下なら Cache-Control: no-store
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `proxy.ts:206-213`（注文の状況の Origin 拒否だけ `no-store` を付ける）。`/api/auth` 配下で route が自分で付ける値（`grep -rn "Cache-Control\|NO_STORE" src/app/api/auth`: `confirm`・`login/cancel`・`login/resend`・`me`・`oauth/*`・`password-reset/*`・`post-login` が自前で付ける）。**proxy が付けた値と route の値のどちらが最終応答に残るか**は設計も未確認（R10 のリスク）。Next.js の仕組みでは route の応答の同名の見出しが後から書く見込みだが、**E2E が見出しの値そのものを見る**（Step 5）。route が付けない窓口（`login`・`otp/verify`・`refresh`・`mfa/*`）で proxy の値が出る。
- [ ] **Step 2（RED）: 単体試験を書く**（先頭 `DD-AUTH-037`）。①`/api/auth/login`・`/api/auth/refresh`・`/api/auth/mfa/status`・`/api/auth/otp/verify` の `proxy()` の応答の `Cache-Control` が `no-store`。②Origin が違う POST（403 `Forbidden origin`）にも `no-store`。③`/api/authx`・`/api/search`・`/news`・`/` には**付かない**（`cache-control` が無い）。④注文の状況の Origin 拒否は今までどおり `no-store` + `Referrer-Policy: no-referrer`。⑤Task 7 の CSP・他の見出しが `/api/auth` でも付く。
- [ ] **Step 3（GREEN）: 実装する。** `matchesPathSegment(pathname, '/api/auth')` の時だけ、403 の `rejection` と最終の `response` に `headers.set('Cache-Control', 'no-store')`。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** proxy の試験群 + `npx jest tests/unit/middleware/proxy-no-store.test.ts`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOGIN-030:235`（SEC-AUTH-022-AC-02、3 幅。`login`・`otp/verify`・`refresh`・`mfa/enroll-totp`・`mfa/verify`・`mfa/status` の各応答に `no-store`）。
  - 注意: この試験は会員の `mfa/*`（403）と `refresh`（成功）も見る。route が自前の値を付けた応答は route の値が残る。**値そのもの（`no-store` を含むこと）を見る**期待に変えない（今の期待を保つ）。route の値が `no-store` を含まず proxy の値も上書きされる窓口があれば、報告に書く。
- [ ] **Step 6: 文書。** `areas/auth.md`: `SEC-AUTH-022-AC-02` の「今のコードは満たさない（no-store は波 3 の proxy.ts で足す）」を外す。`threats/auth.md`、`areas/auth.md`（構造設計）の proxy の節。`ADR-0415`（背景: 認証の応答に `Cache-Control` が無い窓口があり、中継が覚える余地／決定: `/api/auth` 配下は proxy で付ける。route 単位の `withNoStore`（1-C）とは重ねず、検索・ニュース・取扱店は route 単位のまま／退けた案: `/api/*` 全体の既定（route の `s-maxage` との上書きの順が未確認）／結果）。`14_login.md` の `DD-AUTH-037`。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。
- [ ] **Step 8: 報告。** 外した印、proxy の値と route の値のどちらが残るかの単体での見立て（E2E で確認）、共有文書の変更案（なし）。

**検証コマンド:** `npx tsc --noEmit`、proxy の試験群、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 11: LOOK の `og:image` を `/look/[id]/og` の窓口にする（SEC-LOOK-006、Q10）

**範囲:** 新しい窓口 1 本と、`generateMetadata` の `images`。

**Files:**

- Create: `src/app/look/[id]/og/route.ts`（`IMPL-LOOK-157`・`DD-LOOK-071`）、`tests/unit/app/look-og-route.test.ts`
- Modify: `src/app/look/[id]/page.tsx`（`generateMetadata` `:101-105`）、`src/lib/look/server.ts`（公開の LOOK の `image_urls` の先頭の生の値だけを返す `getPublishedLookCoverRaw(id)`。匿名 client。署名しない）
- Test: `tests/unit/app/look/look-detail-page.test.tsx`（metadata の期待）、`tests/integration/ui/look-detail-screen.test.tsx`（metadata があれば）
- E2E: `e2e/FR-LOOK-SEC-001-public-visibility.spec.ts`
- Docs: `docs/02_Requirements/areas/look.md`（`SEC-LOOK-006`）、`docs/05_Quality/security/threats/look.md`、`docs/03_BasicDesign/areas/look.md`（`API-LOOK-`）、`docs/03_BasicDesign/decisions/ADR-0165-look-og-image-same-origin-route.md`（新規）、`docs/04_DetailDesign/pages/07_look_detail.md`（`DD-LOOK-071`）

**Interfaces:**

```ts
// src/app/look/[id]/og/route.ts
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
// 200: バイト + Content-Type(検出) + 'Cache-Control: public, max-age=300, s-maxage=300' + 'X-Content-Type-Options: nosniff'
// 404: 固定の短い本文（Cache-Control: no-store）。非公開・無い・不正な id・画像なし・検証に通らない・置き場の失敗
// src/lib/look/server.ts
export async function getPublishedLookCoverRaw(id: number): Promise<string | null>; // 公開の LOOK の image_urls のうち、検証に通る最初の生の値
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `look/[id]/page.tsx:101-105`（`images: look.imageUrls.length > 0 ? [{ url: look.imageUrls[0] }] : []` = 署名つき URL が `og:image` に入る）。`generateMetadata` が `getPublishedLookById`（全画像を署名）を呼ぶ（`:85`）。`parseLookId`（`IMPL-LOOK-147`）。`FR-LOOK-SEC-001:333` の期待（`og:image` の値に `token=` が無い）と、`ogImages()` の抜き出し。`proxy.ts` の matcher が `/look/1/og` にも CSP 等の見出しを付けること、Task 9 の許可リストの外なので `Set-Cookie` が付かないこと（公開の共有キャッシュの応答に識別子を付けないため）。
- [ ] **Step 2（RED）: 単体試験を書く**（`look-og-route.test.ts`、先頭 `DD-LOOK-071`。`getPublishedLookCoverRaw` と `createServiceRoleClient().storage.from('look-images').download` をモック）。①公開で PNG のバイト → 200・`Content-Type: image/png`・`Cache-Control` がちょうど `public, max-age=300, s-maxage=300`・`X-Content-Type-Options: nosniff`・本文のバイトが一致・`Set-Cookie` なし。②先頭が JPEG/WebP/GIF → それぞれの種類。③バイトが画像でない（`<html>`）→ 404。④id が `abc`・`0`・`-1`・`1.5`・`99999999999999999999` → 404 で `getPublishedLookCoverRaw` を呼ばない。⑤非公開・無い LOOK（`null`）→ 404。⑥`image_urls` の先頭が外の URL・`../x`・`other/x.png` で、2 番目が正しい → 2 番目を返す。全部無効 → 404。⑦`download` が `{ error }` → 404 で本文に誤りの文が出ない。⑧404 の `Cache-Control` は `no-store`。`page.tsx` の `generateMetadata`: 署名できる画像が 1 枚以上の LOOK は `openGraph.images` が `[{ url: '/look/<id>/og' }]`（相対。`metadataBase` で絶対になる）、画像が無い・非公開は `[]`。
- [ ] **Step 3（GREEN）: 実装する。** `getPublishedLookCoverRaw`（`createPublicClient`、`status='published'` は RLS と明示の両方、`maybeSingle`）。route は `parseOwnObjectPath(raw, { bucket: 'look-images', prefix: 'looks' })` → `download` → `detectImageType`。`new Response(bytes, { headers })`。記録は固定の種類（`not_found` / `download_failed` / `not_image`）だけ。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/app/look-og-route.test.ts tests/unit/app/look tests/integration/ui/look-detail-screen.test.tsx tests/unit/lib/look-server.test.ts`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOOK-SEC-001:333`（LOOK-006-AC-02。公開の LOOK の `og:image` に `token=` が無い）。
  - 足す: 同じファイルに `SEC-LOOK-006-AC-03`: 公開の LOOK の `og:image` の値（`/look/<id>/og` の絶対 URL）を `request.get` で開くと 200・`image/*`・`Cache-Control` が `max-age=300` と `s-maxage=300` と `public` を含む・`x-content-type-options: nosniff`・`Set-Cookie` が無い。非公開にした後は 404。存在しない id（`/look/99999999/og`）・`abc` は 404。
  - 保つ: `FR-LOOK-SEC-001` の他の `og:image` の確かめ（非公開にした後の `og:image` に道筋のトークンが出ない: `:296-321`）が、`og:image` が `/look/<id>/og` の形でも通ること。
- [ ] **Step 6: 文書。** `areas/look.md`: `SEC-LOOK-006` の「今のコードは満たさない」を外し、`SEC-LOOK-006-AC-03` を足す（対応表にも）。`threats/look.md`、構造設計（`API-LOOK-` に `GET /look/[id]/og`）、`07_look_detail.md` に `DD-LOOK-071`。`ADR-0165`（背景: 署名つき URL が 1 時間で切れ、期限つき URL がクローラーに残る／決定: 安定した同一オリジンの窓口。公開の LOOK だけ・検証した道筋のバイトを返す・`public, max-age=300, s-maxage=300`・`nosniff`・回数制限は付けない（理由と見直しは波 4）／退けた案: 署名つき URL をそのまま、`opengraph-image` のファイル規約（`ImageResponse` は再エンコードで重い）／結果: ITEM の `og:image` は別件（P14））。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。
- [ ] **Step 8: 報告。** 外した印、足した試験、**窓口が 1 本増えた**ので共有文書の変更案: `route-inventory.md`（`/look/[id]/og` `GET`、ファイル数・メソッド数 +1）、`api-spec.md`、数を固定する `tests/unit/docs/*-traceability.test.ts`（G-4 が共有文書を持っている間は controller が反映する）。P14（ITEM の `og:image` が壊れている）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。

---

## Task 12: ブラウザ側の zod を `jitless` にして CSP の `eval` 違反を無くす（SEC-HOME-009-AC-02、Q25）

**範囲:** 新しい 1 ファイル `src/instrumentation-client.ts` だけ。zod を使う入口（126 ファイル）の import は**触らない**。手で「どれがブラウザへ届くか」を辿ると 1 つの漏れで直しが無効になるので、Next 16 が「アプリのフロントエンドのコードより前に」ブラウザで 1 回実行する `instrumentation-client.ts` に置く。

**Files:**

- Create: `src/instrumentation-client.ts`、`tests/unit/instrumentation-client.test.ts`
- Modify: なし
- E2E: `e2e/FR-HOME-022-home-response-hardening.spec.ts`
- Docs: `docs/02_Requirements/areas/home.md`（`SEC-HOME-009-AC-02` を要件として書く。今は文書に無い食い違い）、`docs/05_Quality/security/threats/home.md`、`docs/03_BasicDesign/areas/home.md`、`docs/04_DetailDesign/pages/01_home.md`

**Interfaces:**

```ts
// src/instrumentation-client.ts（共有。@impl なし。Next が全頁のハイドレーションより前にブラウザで 1 回実行する）
import { z } from 'zod';
z.config({ jitless: true });
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P15。`node_modules/zod/v4/core/schemas.js:901-903` の `jit`・`allowsEval` の評価がスキーマを作る時であること。`src/instrumentation-client.ts`・`instrumentation.ts` が無いこと（`ls src/instrumentation*`）。Next 16.3.6 が `src/instrumentation-client.ts` を読むこと（`node_modules/next/dist/build/webpack-config.js` と `create-compiler-aliases.js` に `instrumentation-client` の参照が在る。`node_modules/next/dist/docs/01-app` の説明も読む）。`next.config.ts` に `instrumentation-client` を無効にする設定が無いこと。**zod を使うファイルを辿らない**（不要）。`FR-CHECKOUT-025` の `eval` の除外は変えない。
- [ ] **Step 2（RED）: 試験を書く**（`instrumentation-client.test.ts`、先頭 `DD-HOME-004`、jsdom）。①`jest.isolateModules` で `src/instrumentation-client.ts` を読み込んだ後、同じモジュールの `zod` で `z.object({ a: z.string() })` を作って `parse` しても、`global.Function` を差し替えた呼び出しが 0 件（`new Function` が呼ばれない）。読み込む前の同じ手順では呼ばれることも対照で見る（zod の `allowsEval` が評価される状態を `jest.isolateModules` で作る）。②`core.globalConfig.jitless === true`。③ファイルが `zod` の import と `z.config({ jitless: true })` だけを持つ（余計な副作用を持たない）ことを文字列で固定する。
- [ ] **Step 3（GREEN）: 実装する。** 上の 1 ファイル。`tsc`。`z.config` の型と `jitless` の綴りは `node_modules/zod/v4/core/core.d.ts` で確かめる。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/instrumentation-client.test.ts tests/unit/components/LoginModal.test.tsx tests/unit/features/auth`。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す（**条件つき**）: `FR-HOME-022:149`（SEC-HOME-009-AC-02「CSP の違反が記録されない」、3 幅）。このテストは `/` でブラウザの `securitypolicyviolation` と `console` の CSP メッセージが 0 件であることを見る。zod の `eval` が唯一の違反とは限らない（`FR-CHECKOUT-025` の注は zod の `eval` を除外している）。**外して流した結果が赤なら、印を戻し、残った違反の種類（ブロックされた URL）を報告する**。他の違反が Task 7 の CSP の変更で出た物なら Task 7 に戻す。
  - **`instrumentation-client` が本番ビルドで実際に効くことの実測**（controller が流す。Task 14）: 本番ビルドで `/` を開き、`FR-HOME-022:149` の `eval` の違反が出ないことを見る。違反が残り、かつ原因が zod の `eval` なら、`instrumentation-client.ts` が読まれていない（置き場所・設定）か、`z.config` より前に別の `z.object` が走る経路があるので、報告に書いて戻す（その時だけ、最初に `z.object` を作る入口の先頭に `import '@/instrumentation-client'` を足す案を controller に返す。実装者は勝手に入口を増やさない）。
  - 足す（`FR-CHECKOUT-025` の除外は変えない）: なし。
- [ ] **Step 6: 文書。** `areas/home.md`: `SEC-HOME-009-AC-02` を「文書に無い食い違い」でなく要件として書く（ブラウザ側の zod は `jitless` で、`/` で CSP の違反が記録されない）。`threats/home.md`、構造設計（`instrumentation-client.ts` が全頁より前にブラウザで 1 回走ること）、`01_home.md`（`DD-HOME-004` の節に `jitless` を足す）。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- HOME`。
- [ ] **Step 8: 報告。** `:149` の印を外したか、残る違反（種類とブロックされた URL）、`instrumentation-client` が読まれる根拠（`node_modules/next` の参照）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- HOME`。

---

## Task 13: 本番ビルドで必須の環境変数が無ければ落とす（`next.config.ts`。SEC-ABOUT-007）

**範囲:** `next.config.ts` の先頭の確かめと `.env.example`・運用の文書。`getSiteUrl` は変えない。確かめは 2 つ: ①本番ビルド（`VERCEL_ENV=production`）で `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` が無ければ落とす。②`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が**両方あり別の origin を指す**ならビルドを落とす（環境に依らない）。②は P5・ruling 2 の「信頼する origin は 1 つ」を設定の側で守る: 署名つき URL は `createServiceRoleClient`（`SUPABASE_URL` 優先 `server.ts:138`）が作る一方、CSP の `img-src` と `remotePatterns` は `NEXT_PUBLIC_SUPABASE_URL` の 1 host だけを許すので、2 つが別だと署名が通っても画像が止まる。手元・E2E では同じ host なので影響しない。

**Files:**

- Modify: `next.config.ts`（先頭）、`.env.example`
- Test: `tests/unit/next-config.test.ts`（Task 8 で作った物に足す）
- Docs: `docs/02_Requirements/areas/about.md`（`SEC-ABOUT-007`）、`docs/05_Quality/security/threats/about.md`、`docs/03_BasicDesign/areas/about.md`、`docs/03_BasicDesign/decisions/ADR-0206-about-site-url-required-at-production-build.md`（新規）、`docs/04_DetailDesign/pages/08_about.md`（**`DD-ABOUT-002` の項目を作る**。今の最大は `DD-ABOUT-001`。試験の先頭の ID が在るように、このタスクの中で作る）、`docs/06_Operations/secrets.md`・`deployment-topology.md`（環境変数の表。`order-email-operations.md:119,565` の `NEXT_PUBLIC_SITE_URL` の記述と矛盾させない。2 つの Supabase の URL が別の origin だと落ちることも書く）

- [ ] **Step 1: 現状の確認（読むだけ）。** `next.config.ts` に `VERCEL_ENV` の確かめが無いこと。`src/lib/site-url-guard.ts` が `VERCEL_ENV` を使う前例。`scripts/e2e/environment.ts:68` が E2E で `NEXT_PUBLIC_SITE_URL` を固定すること。`.env.example` に `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` が無いこと。本番が未デプロイであること（memory: 2026-09-13 時点でプロジェクト無し。初回の配備を落とすのが意図）。
- [ ] **Step 2（RED）: 単体試験を足す**（`next-config.test.ts`、先頭 `DD-ABOUT-002`。`SEC-ABOUT-007-AC-01`）。`VERCEL_ENV=production` で `NEXT_PUBLIC_SITE_URL` が無い → 読み込みが `NEXT_PUBLIC_SITE_URL` を名指しして throw。`NEXT_PUBLIC_SUPABASE_URL` が無い → 名指しして throw。両方ある → 通る。`VERCEL_ENV=preview`/無し → 通る（`NODE_ENV=production` でも throw しない: E2E の本番ビルドを止めない）。値（URL）をメッセージに出さない。**別の origin の確かめ**: `NEXT_PUBLIC_SUPABASE_URL=https://a.supabase.co` と `SUPABASE_URL=https://b.supabase.co` → 変数名を名指しして throw（`VERCEL_ENV` が無くても。値は出さない）。同じ origin（末尾の `/` やパスの違いは無視して origin で比べる）→ 通る。片方だけ → 通る。`http://127.0.0.1:54321` が両方 → 通る（手元・E2E）。
- [ ] **Step 3（GREEN）: 実装する。** 先頭に 2 変数の確かめと、2 つの Supabase の URL の origin が違えば落とす確かめ（URL が `new URL` で読めない時は何もしない: 読めない値の扱いは既存の動きに任せる）。`.env.example` に 2 行を、コメント（ビルド時に埋め込まれる・本番の Vercel の Production に設定する・末尾に `/` を付けない）と共に足す。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/next-config.test.ts tests/integration/api/auth/site-url-guard.test.ts tests/integration/ui/about-metadata.test.tsx`。
- [ ] **Step 5: E2E: 印なし。** 環境変数を外してビルドし直す状態は共有の E2E で作れない（`areas/about.md` の注）。
- [ ] **Step 6: 文書。** `areas/about.md`: `SEC-ABOUT-007-AC-01` の確かめ方を単体に直し、現行（本番ビルドで必須。`getSiteUrl` は投げない）を書く。`NEXT_PUBLIC_VERCEL_URL` の扱いは別判断と書く（設計 R9-6）。`secrets.md`・`deployment-topology.md`: 環境変数の表に `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` が**ビルドの前に**要ること、無ければビルドが落ちることを足す。`DD-ABOUT-002`（`08_about.md`。2 つの確かめと、値を出さない失敗の文）。`ADR-0206`（決定: `VERCEL_ENV === 'production'` のビルドで未設定なら落とす。2 つの Supabase の URL が別の origin ならビルドを落とす（信頼する origin は 1 つに揃える）／退けた案: `getSiteUrl` で投げる（メールの一時停止・`legal` 頁・`getRequestOrigin` の挙動と試験が変わる）、`NODE_ENV`（E2E の本番ビルドも入る）、警告だけ）。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- ABOUT`。
- [ ] **Step 8: 報告。** 配備の前の手順（Vercel の Production に 2 変数を設定してからビルド）、共有文書の変更案（`docs/06_Operations` は共有ではないが `db-migrations.md` は触らない）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ABOUT`。

---

## Task 14: 最終確認と controller への報告

**範囲:** 読むことと、流してよい検査だけ。コードは変えない。

- [ ] **Step 1: 木の確認。** `npx tsc --noEmit`。流してよい `jest` の対象指定（各タスクの Step の和集合 + Global Constraints の proxy の試験群 + `npx jest tests/unit/lib/storage tests/unit/middleware tests/unit/next-config.test.ts tests/unit/instrumentation-client.test.ts`）。`npm run validate-docs`（既知の 2 件のリンク切れは `2026-10-07-checkout-place-order-payment.md`。それ以外が増えていないこと）。`npm run validate-trace`（増えた違反が 0）。
- [ ] **Step 1b: 範囲内の領域に求められる 2 つの確かめ（controller が最後に流す。実装者は流さない）。** `.claude/CLAUDE.md` は、範囲内の領域を変えたら `npm run validate-trace` と `npm run test:trace-coverage` を通し、テストの追加・変更では `npm run trace:report` で `docs/05_Quality/reports/` の一覧を全領域分作り直すよう求める（波 1-C の計画の controller の最後の手順にも在った）。この波は HOME・ABOUT・PRIVACY・LOOK・NEWS・SEARCH・AUTH の 7 領域の試験と受け入れ条件を足す・書き換えるので、次を**この順に**流して通す: ①`npm run trace:report`（`docs/05_Quality/reports/` を作り直す。差分を確認して同じコミットに含める）、②`npm run test:trace-coverage`（`scripts/trace/baseline.json` の既知の違反・`test-gaps.md` の届かない分岐から**増やさない**。`--update-baseline` はしない）、③`npm run validate-trace`（増えた違反 0）、④`npm run validate-docs`。③と④を①②の後でもう一度流して、作り直した一覧が検査を壊していないことを確かめる。赤になった領域は、その領域のタスクに戻す。
- [ ] **Step 2: 印の棚卸し。** `grep -rnE "test\.fail" e2e | grep -E "SEC-(HOME-(006|007|009|017)|NEWS-(004|023)|LOOK-(006|007|008)|ABOUT-003|PRIVACY-01[45]|SEARCH-01[456]|AUTH-022)"` を流し、残る行が「`FR-HOME-022:149` の条件つきの 1 本」と「`FR-NEWS-SEC-003:109` の実測次第の 1 本」以外に無いことを確かめる。各タスクの外した行の合計 17（`:94`・`:118`・`:149`・`FR-HOME-023:203,225`・`FR-ABOUT-010:76,102`・`FR-PRIVACY-006:57`（書き換え）・`:68`・`FR-NEWS-SEC-003:109,144`・`FR-LOOK-SEC-001:333,362,394`・`FR-SEARCH-019:142`・`FR-SEARCH-021:283,393`・`FR-LOGIN-030:235`）と数が合うこと。
- [ ] **Step 3: 共有文書の変更案をまとめる。** `route-inventory.md`・`api-spec.md`（`/look/[id]/og`、Task 11）、`tests/unit/docs/*-traceability.test.ts` の数、`test-spec.md`（足した・書き換えた試験、書き換えた現状固定）、作業と指摘の台帳（W-08・波 3 の状態、解決した指摘 ID の一覧）、`requirements.md`（FREQ の AC の文が変わる物があれば）。
- [ ] **Step 4: 報告。** 下の「controller が最後に流す E2E」「本番の前の確認」「ruling（controller への確認）」「回す物」を、結果と共に返す。

### controller が最後に流す E2E（本番ビルド。3000 番の残りを止めてから。`db reset` してから）

`next.config.ts`・`proxy.ts` はビルドに焼かれる。コード変更の後は 3000 番のアプリを止めてから流す。

```bash
npx playwright test e2e/FR-HOME-022 e2e/FR-HOME-023 e2e/FR-HOME-024 e2e/FR-ABOUT-008 e2e/FR-ABOUT-009 e2e/FR-ABOUT-010 e2e/FR-PRIVACY-005 e2e/FR-PRIVACY-006 e2e/FR-PRIVACY-007 e2e/FR-PRIVACY-008 e2e/FR-PRIVACY-009 e2e/FR-NEWS-SEC-001 e2e/FR-NEWS-SEC-003 e2e/FR-NEWS-SEC-005 e2e/FR-LOOK-SEC-001 e2e/FR-LOOK-SEC-002 e2e/FR-LOOK-SEC-003 e2e/FR-LOOK-SEC-004 e2e/FR-LOOK-DETAIL e2e/FR-LOOK-ALL e2e/FR-LOOK-ADMIN-001 e2e/FR-SEARCH-018 e2e/FR-SEARCH-019 e2e/FR-SEARCH-021 e2e/FR-SEARCH-022 e2e/FR-LOGIN-030 e2e/FR-LOGIN-032 e2e/FR-LOGIN-036 e2e/FR-CART e2e/FR-WISHLIST e2e/FR-CHECKOUT-005 e2e/FR-CHECKOUT-025 e2e/FR-CHECKOUT-036 e2e/FR-CHECKOUT-040 e2e/FR-CHECKOUT-046 e2e/FR-UI e2e/slider e2e/FR-TERMS-005 e2e/FR-ITEM e2e/FR-NEWS-ADMIN
```

その後、全件を流して `.superpowers/sdd/2026-10-25-security-gap-fixes/e2e-results-wave2-full.json`（波 2 の全件: 414 failed）と比べる（`flattenPlaywrightJson` で直して渡す）。**新しい赤**の原因の見立て: ①画像が出ない（`items/`・`looks/`・`news/` の外の見本）、②CSP 違反（`securitypolicyviolation`）、③`/api/checkout/*` が 400 `session_not_found`（Review Focus 6）、④`/_next/image` が 400（手元の枝の抜け）。

### 本番の前の確認（コードでは確かめられない）

1. Vercel の Production に `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SITE_URL` を設定してからビルドする（Task 13）。
2. Stripe の本番アカウントで **Link** が有効なら、決済の部品が `link.com`・`*.link.com` を開こうとして今の CSP（`frame-src`・`connect-src`・`img-src` に無い）で止められる可能性。テストモードの `FR-CHECKOUT-025` では出ていない。有効なら Stripe 公式の Link の節（<https://docs.stripe.com/security/guide>）の 3 行を足す（別の判断）。
3. 本番の `items.image_url` などが `/object/public/…` の自 host URL であること（読んで確認済み: P6）。署名が全部通る。配備の後、商品一覧・商品詳細・LOOK・NEWS（管理）・検索・カート・お気に入りの画像が出ることを 1 通り見る。
4. 画像を開いたまま 1 時間を超えた頁では遅延画像が切れる（再読み込みで直る）ことを許容する（ITEM の期限 7 日 → 1 時間の副作用）。

### ruling（controller への確認。実装者は広げず、理由を書いて進める）

1. **`session_id` の許可リストは拡げない**（P1・P2）。許可リストの外で壊れる所は見つからなかった。`/cart` を開かずに決済 API を直に叩く E2E があれば、E2E の補助のほうに `page.goto('/cart')` を足す。
2. **画像の署名で信頼する origin は 1 つだけ**（設計どおり `NEXT_PUBLIC_SUPABASE_URL`。無ければ `SUPABASE_URL`）。署名つき URL は `createServiceRoleClient`（`SUPABASE_URL` 優先 `server.ts:138`）が作るが、CSP の `img-src` と `remotePatterns` は 1 host だけを許すので、2 つ目の origin を署名で許しても画像は CSP・`/_next/image` で止まる。だから署名の側を広げず、**`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が別の origin を指す設定を Task 13 がビルドで落とす**。controller の確認点: 本番の Vercel でこの 2 つに別の値を入れる予定が無いこと（手元・E2E は同じ host）。以前の案（2 つの origin を許す）は取り下げた。
3. **`/ui` の画像は 7 か所**（決定文は 9 枚）。置き換えは既存の `public/` の画像（`/news1-3.png`・`/placeholder.png`）。重い `mainphoto.png`・`about.png` は使わない。
4. **`/look/[id]/og` に回数制限を付けない**（公開の LOOK の数に限られ `s-maxage=300`。見直しは波 4）。
5. **ITEM の `og:image`（`item/[id]/page.tsx:35`）は生の `/object/public/…` で壊れている**（P14）。設計の範囲外なので直さない。直すなら LOOK と同じ窓口 `/item/[id]/og`。
6. **`FR-HOME-022:149`（CSP の違反 0）と `FR-NEWS-SEC-003:109`（`max-age <= 3600`）は実測次第**で、反転しなければ印を戻して報告する。
7. **`FR-PRIVACY-006:57` は反転でなく書き換え**（Q29）。要件 `SEC-PRIVACY-014` の `js.stripe.com` の文を直す。
8. **`src/lib/news-data.ts` の `newsData`（`readdy.ai`）は未使用**。消さずに報告する。
9. **`getSiteUrl` の `NEXT_PUBLIC_VERCEL_URL`** は別判断（設計 R9-6）。Task 13 は本番ビルドの確かめだけ。
10. **ログインの成功で `session_id` を回す `register.ts:57` を残すか**（controller/ユーザーの判断）。この発行は許可リスト（`/cart`・`/checkout`・`/api/checkout`）の外の `/api/auth/*` の応答にも `Set-Cookie` を付けるので、Q23 の「他は発行しない」と文面では食い違う。**既定の案は残す**: ログイン前後で識別子を回すのはセッション固定の攻撃への守りで、`FR-CHECKOUT-046` がこの回転に頼る。残す場合、Q23 の文を「proxy が配るのは許可リストの道だけ。ログインの成功の時の回転は別」と読み替え、`ADR-0355` の「結果」に書く。外す場合は `register.ts` の発行をやめて `FR-CHECKOUT-046` を作り直す別の計画になる（この波では扱わない）。Task 9 は proxy の発行条件だけを変え、`register.ts`・`logout/route.ts` は触らない。

## 回す物（この波で直さない。理由つき）

| 物 | 回す先 | 理由 |
| --- | --- | --- |
| ITEM の `og:image`（P14） | 別判断 | 設計の対象 ID に無い |
| `rateLimit.ts` の送り元・`/look/[id]/og` の回数制限 | 波 4 | 共有の `rateLimit.ts`。G の窓口と一緒 |
| `'strict-dynamic'` | 別判断 | Turnstile の `<Script>` に nonce が付くかを本番ビルドで実測してから |
| `getSiteUrl` の `NEXT_PUBLIC_VERCEL_URL`・`VERCEL_PROJECT_PRODUCTION_URL` | 別判断 | `redirect.ts` は共有（メール・`legal`・Origin の許可に効く） |
| Link・Google の住所の部品の CSP | 本番の前の確認 | 今は使っていない |
| `src/lib/news-data.ts` の `newsData` | 報告のみ | 使われていないコードの決まり |
| 管理の商品登録が `getPublicUrl` の URL を DB に書く（`admin/items/route.ts:148`・`[id]/route.ts:230`） | 別判断 | 動いている（署名が道筋に直す）。書く値を素の道筋にするのは別の整理 |
| `FR-WISHLIST-011` の `beforeEach` が取る `session_id` | 報告のみ | 使われていない値になる。害は無い |

## 自己点検（計画の作成者が行った確認）

- 設計書の確かめ方の行番号を**全部現在の `e2e/` で引き直した**（「設計書の印と今の印」の表）。外れていた 4 行（`FR-NEWS-SEC-001`、R10 の 3 行）は元から外れていると書いた。
- `session_id` の読み手を `src` 全体の grep（`get('session_id')`・`sessionCookieName`・`x-session-id`・`extractSessionIdFromCookie`）と RLS の方針（`remote_schema.sql`・`20260919141000`）、`createClient`（利用者の権限）を使う窓口の表の一覧で確かめた。
- 本番の画像の値を `SELECT` で数えた（P6）。読み取りだけ。`order_items` は 0 行。
- 署名の呼び手（`grep -rn "signItemImage\|signLookImage\|signNewsImage"`）の `null` の扱いを 1 つずつ読んだ。**`?? item.image_url`（`cart-view.ts:83`・`wishlist/route.ts:141`）が fail-closed を打ち消す**ことと、**`cart-api.ts:26` の `?? ''` が空の `src` で `next/image` を落とす**ことを見つけた（Task 2 の理由）。
- Stripe の許可先は Stripe 公式（`docs.stripe.com/security/guide`）の本文を取って今の `buildCsp` と突き合わせた（`*.js.stripe.com` が足りない）。
- `zod` の `jitless` の効く位置は `node_modules/zod/v4/core/schemas.js:901-903` を読んで決めた。
- 実行はしていない: `jest`・`tsc`・`next build`・E2E・サーバー。計画に書いた試験の数・期待は、実装の時に実測で直る。
