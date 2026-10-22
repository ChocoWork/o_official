# 注文の状況のページ（グループ E-5）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ゲストも会員も注文のメールの同じリンクから状況を見られ、個人情報は持ち主のログインか電話番号の下4桁の確認を通った時だけ見られるようにする。

**Architecture:** 公開の部分は Server Component が毎回読み、個人情報のキーを持たない型で描画する。個人情報はブラウザから専用の窓口へ取りに行き、ログインの更新は既存の `clientFetch` に任せる。リンク・確認期限・失敗の合計は DB に持ち、電話番号の比較と加算は1つの取引で行う。会員の注文 API と表示の組み立てを共有し、既存の返却値を保つ。

**Tech Stack:** 現行 `package.json` の Next.js `^16.3.6` App Router、React / react-dom `^19.0.0`、TypeScript `^5`、Supabase Postgres 17、`@supabase/supabase-js ^2.103.3`、`@supabase/ssr ^0.10.2`、zod `^4.3.6`、Jest / ts-jest `^29`、`pg ^8.23.0`、`@testing-library/react ^16.3.2`、`@playwright/test ^1.58.2`。HMAC とハッシュは Node の `crypto`、手元のメールは Mailpit。依存を増やさない。

**Spec:** [承認済み設計書](../specs/2026-10-22-order-status-page-design.md)。下調べは `tmp/e5/facts.md`、作り手の確認は `tmp/e5/builder-check.md`。設計書と controller の指定が違う所は「突き合わせ」に記す。

## 概要

11タスクを番号順に進める。各実装者には担当 Task、Global Constraints、P-list、C-0〜C-6、該当 AC を渡す。本文は実装計画の下書きであり、実装・試験・DB 適用の実績ではない。チェックは実測の証拠が揃ってから付ける。

| Task | 作る物 | 後で使う物 |
|---|---|---|
| 1 | 移行 A、リンク・確認・送信成功・公開材料の DB 関数 | C-0、C-1 の A |
| 2 | 移行 B、返品の共通の芯と注文番号による読み出し | C-1 の B |
| 3 | 会員 API と共有する表示の組み立て、公開・個人情報の型 | C-2 の表示 |
| 4 | トークン・下4桁・署名 Cookie・store | C-2 の土台 |
| 5 | 確認と個人情報の2つの窓口 | C-3 |
| 6 | Server Component と公開表示、個人情報・確認の Client Component | C-5 |
| 7 | 16種類のメールのリンク、電話削除、材料の準備 | C-6 |
| 8 | お問い合わせの URL 初期値 | C-2 のお問い合わせ |
| 9 | 新10本の E2E と既存の見本の修正 | 30ケース、controller が実行 |
| 10 | FREQ-498〜505 の8行・32 AC、設計と運用の文書 | AC 対応表と静的試験 |
| 11 | 全体検証・既存データでの予行演習・本番適用の手順 | 実測と前回比較、許可後の適用記録 |

```mermaid
flowchart TD
  A[Task 1 リンクと公開材料] --> D[Task 4 store と印]
  B[Task 2 返品の共通の芯] --> D
  C[Task 3 表示と型] --> D
  D --> E[Task 5 確認と個人情報の窓口]
  E --> F[Task 6 ページ]
  D --> G[Task 7 メール]
  F --> H[Task 8 お問い合わせ]
  G --> I[Task 9 E2E]
  H --> I
  I --> J[Task 10 要求と文書]
  J --> K[Task 11 全体検証と出し方]
```

コミットの Step は後日の controller 用。今回の執筆では実行しない。実装者もコミットせず、controller が指定ファイルだけを master にコミットする。push、本番の読み取り、本番への各移行の適用は、それぞれ別のユーザーの許可を得る。実装開始前に Task 11 Step 1 を先に行う。

## Global Constraints

設計書10章の決定を次の7行で固定する。

- リンクだけでは個人情報と支払い方法を見せず、本人の確認後だけ見せる。
- 確認期限の後の個人情報と支払い方法は、ログインした持ち主の会員だけに見せる。
- 本人の確認は注文時の電話番号の下4桁。お客様向けのメールの定型のお届け先から電話番号を消す。
- リンクだけで見せるのは、注文番号・注文日、進み具合、配送の状況と移り変わりと時刻、品物と数と金額、運送会社の名前、返金の額と状況、返品・キャンセルの申し込みの状況。伝票番号と追跡 URL は確認後だけ。
- 確認期限の後も、公開の部分は同じリンクで見られる。
- ゲストの返品・キャンセルは、同じメールでの会員登録とメール確認を済ませて注文履歴から申し込む道と、注文番号入りのお問い合わせの道を用意する。
- 会員にもゲストと同じリンクを送り、ログインした持ち主にはそのページで個人情報も見せる。

設計書11章 a〜l の値を次の12行で固定する。

- a: 下4桁で確かめられる期間は21日。
- b: お客様向けの対象メールが `complete_order_email` で `sent` になった時刻から21日。期限を戻さず、進んだ時だけ失敗の合計を0にする。
- c: お客様向け16種類にリンクを入れ、店向け3種類には入れない（種類の全リストは C-6）。
- d: 43文字のトークンを `private.order_status_links` にそのまま保存。初めて新しい本文を作る時に用意し、1注文1本で作り直さない。
- e: 注文ごとは15分に5回、送信元ごとは10分に30回、確認できる期間の失敗の合計は20回。
- f: 確認済み Cookie は24時間と `verify_until` の早い方まで。`httpOnly`、本番で `secure`、`sameSite='strict'`、`path=/api/order-status/{token}`。
- g: 電話番号が無い・数字が4桁未満なら確認欄を出さず、「ログインするか、お問い合わせください」を出す。
- h: `cancelled` は見せる。`payment_in_progress`・`abandoned` は、存在しない注文と同じ404。
- i: 返品の送り先は個人情報の窓口だけ。今の会員の頁と同じく受付中の返品だけが材料を持ち、表示は `accepted`・`partially_received` の間だけ。
- j: お問い合わせは URL の `type`・`order` で欄を埋めるだけ。送信時の注文の関連付け・認可は変更しない。
- k: 要求は FREQ-498 から、新しい E2E は FR-ORDER-001 から。Task 10 の32 AC が正。
- l: 公開の部分をサーバー、個人情報をブラウザからの GET に分ける。印は専用 API の住所だけに送る `sameSite='strict'`。

実装全体の決まりは次のとおり。

- 画面とメールの文は C-4〜C-6 のとおり一字も変えない。値と店の文章は文字として出す。`dangerouslySetInnerHTML` は使わない。
- Next.js 16 の `params` は `Promise<{ token: string }>`。ページは `await connection()` の後に DB を読む。描画中と `after()` で Cookie を発行しない。
- 同梱ガイド `node_modules/next/dist/docs/01-app/03-api-reference/` の `03-file-conventions/{dynamic-routes,route}.md` と `04-functions/{connection,cookies,generate-metadata}.md` が根拠。現行設定には `cacheComponents: true` が無い。今回それを足さない。
- ページの固定 metadata は `robots: { index: false, follow: false }`。API の成功・拒否・例外は全て `Cache-Control: no-store`。追跡リンクは `rel="noopener noreferrer"`。
- 公開の読み出しで、個人情報・支払い方法・発送と送り返しの伝票番号・返送先を TS に取得しない。取得後の削除だけで済ませない（P17）。公開 API は作らない。
- 新表は RLS を有効にし、`anon`・`authenticated` を RESTRICTIVE policy で全拒否。表の権限は `service_role` の SELECT だけ。書き込みは関数だけ。
- public の RPC は全て `SECURITY DEFINER`、`SET search_path = ''`、完全修飾名、所有者 `postgres`。`PUBLIC`・`anon`・`authenticated` の EXECUTE を外し、`service_role` だけに与える。private の補助はこれら全ロールから EXECUTE を外し、外から呼ばせない。
- 移行は A → B、各 `BEGIN;`〜`COMMIT;`。最後に `NOTIFY pgrst, 'reload schema';`。適用済みの移行は直さない。
- 電話番号・入力した下4桁・トークン・Cookie・署名・秘密の鍵をログ・監査・エラー・URL のクエリに入れない。E-5 のログは C-4 の固定記号だけ。外部への Referrer は現行 proxy の `no-referrer` を維持する。
- 確認 POST は既存 proxy の Origin 検査と `denyIfCsrfInvalid()` を通す。ゲストにログインを必須にしない。既存の CSRF は refresh Cookie の無いゲストを通し、ゲストの送信元は proxy が確かめる。
- 回数制限の DB 障害は503で止める。例外を握りつぶして制限無しで続けない。注文の subject は DB で得た UUID、利用者の入力やトークンを使わない。
- 会員 API の認証・所有者条件・エラー・JSON のキー、値、null とキー無し、配列順を変えない。返品の読み取りだけ失敗した時の `returnSection: null` も維持する。
- E2E は本番ビルド（`next build && next start`）、手元の Supabase、Mailpit、3画面幅390/768/1280。controller が実行。DB 結合後のデータを流用せず reset を挟む。17TRACK は E-4 の手元の fake だけ。
- PowerShell は `npx.cmd`・`npm.cmd`。型は `npx.cmd tsc --noEmit --incremental false`。DB 結合・reset・E2E・サービス停止と起動は controller の担当。
- 各 Task のコミット前に該当試験と全体の型を通す。コードを変えた後は controller が `.venv/Scripts/python.exe -m graphify update .` を行い、graphify の生成物をコミットへ混ぜない。
- 文書は日本語・概要あり・Mermaid・H4まで・絵文字なし。ソースの前に `.venv/Scripts/python.exe -m graphify query "<問い>"`。新しい判断は P-list と台帳へ残す。
- 本文のコミット命令は後日の手順。実装者は実行しない。controller が日本語の Conventional Commits、`--no-verify` 無し、指定ファイルだけで実行する。今回の下書き作成では Git の状態を操作しない。

## Review Focus

1. `+81`・ハイフン・空白・括弧・全角数字が混じった電話でも同じ最後の4桁になり、短い電話は確認できない。Task 1「電話の書き方をそろえ4桁を固定回数で比べる」、Task 4「入力は数字4桁ちょうどだけ受ける」で押さえる。
2. 別の会員がログインしたブラウザに、ログインしただけで個人情報を出さない。Task 5「別の会員は200のnone、印があればverified」、Task 9 FR-ACCOUNT-044 で押さえる。
3. 期限切れ後も Cookie が残ったブラウザで、公開部分は残し、個人情報を消す。Task 5「DBの期限と印の期限を毎回照合する」、Task 6「期限と未ログインへの変化で個人情報を捨てる」、FR-ORDER-004 で押さえる。
4. 別のメールが同時に完了した時、期限を戻さず、進まない完了で失敗数を消さない。Task 1「2接続の送信完了でも期限を戻さない」「同じ取引時刻の完了は失敗数を再び消さない」で押さえる。
5. E-5 前に保存された本文は送り直しでも変えず、リンクも後付けしない。既存のリンク行がある時だけ期限更新の対象になる。Task 1「リンク無しの旧本文も種類で期限を更新する」、Task 7「保存済み本文ではリンクを用意せずそのまま送る」、Task 11 の件数確認で押さえる。

## 本計画の決め事（P-list）

P1〜P16 は controller の指定。P17以降は現行コードを読んで補った実装の決め事。

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | A=`20261023100000_order_status_links.sql`、B=`20261023100100_order_status_returns.sql` の2本。前の移行を直さず、本番適用後に MCP が返した版へ改名する | E-4 と同じ適用履歴にそろえる |
| P2 | SQL で32バイトの乱数を base64url の43文字にする。`+`→`-`、`/`→`_`、`=` を削除。CHECK は `^[A-Za-z0-9_-]{43}$`。呼ぶ名前は `extensions.gen_random_bytes(32)` と固定するが、既存移行に pgcrypto の配置の宣言が無いため X2 の前提確認を必須にする | 推測で別 schema の関数を呼ばない。Task 1 で配置を保証する |
| P3 | `ensure_order_status_link` は無ければ `ON CONFLICT (order_id) DO NOTHING` で入れ、保存済みのトークンを読む。同時呼び出しも1本。メール材料の準備から service_role で呼ぶ | トークンを再発行しない |
| P4 | お客様向けの種類の送信成功で `GREATEST(今の値, sent_at + interval '21 days')`。NULL は新しい期限へ。値が進んだ時だけ `failed_attempts=0`。リンク行が無ければ何もしない | 失敗・店向け・古い完了で期限やロックを変えない |
| P5 | 比較と失敗数は DB 内で同じ取引。答えは `ok/mismatch/locked/unavailable/expired` の5つ。`mismatch` だけ1増加、既に20なら `locked`。全角数字も半角にそろえ数字だけの最後4桁を比べ、電話そのものを返さない | TS に照合用の電話を持ち出さない |
| P6 | `enforceRateLimit` の endpoint は両方 `order-status:verify`。IP は30回/600秒、DBで得た注文UUIDの subject は5回/900秒。存在しないトークンは IP 枠だけ数えて404 | 既存の固定時間枠をそのまま使う。移動時間枠へ作り直さない |
| P7 | Cookie 名 `sb-order-status`。payload は `purpose='order_status', orderId, tokenHashPrefix, iat, exp`。prefix はトークンの SHA-256 の16進の先頭16文字。鍵は `ORDER_STATUS_SESSION_SECRET`、無ければ `JWT_SECRET`。期限・属性は C-2 | 同名で path の違う複数注文の印を持てる |
| P8 | 持ち主または有効な印は200。ログインの印を持ち込み、その検証が失敗した時だけ401。それ以外は200の `access:'none'` と `verifiable/reason`。確認不能な認証サービスは503 | `client-fetch.ts:93-122,210-221` の refresh と未ログイン通知を、ゲストの普通の閲覧で発火させない |
| P9 | 個人情報は、お届け先の名前・郵便番号・住所・電話、連絡先メール、会員と同じ表示の支払方法、発送の伝票番号と追跡URL、返品の送り返しの伝票番号と返送先だけ。識別用の発送ID/回数・返品ID/送り返しの配列index以外の情報を足さない | 公開の内容を個人情報の答えへ重複させない |
| P10 | 公開部分は Server Component → store の道だけ。公開型と個人情報型を分け、公開型に個人情報のキーを定義しない | ブラウザで隠す形にしない |
| P11 | 存在しない・隠す2状態・形の違うトークンは同じ404。形が違えば DB を呼ばない | 存在の違いを文で知らせない |
| P12 | メールへ「ご注文の状況はこちら: {URL}」。お問い合わせの一文の直前へ1行。`new URL('/order-status/' + token, getSiteUrl())`。URLを作れなければ材料不足 | 配達済みの旧リンクも同じ1行に置き換える |
| P13 | お問い合わせの `type` は `product/order/other` だけ。`order` は trim・大文字化後 `^ORD-[0-9A-F]{8}$` だけ。合わない値は無視 | 注文番号の実際の UUID の先頭8桁に合わせる |
| P14 | 登録入口は `/login?tab=register`。ログインは `/login`。メール・トークンをクエリへ足さない | 現行 `src/app/login/page.tsx:40-46` が `tab=register` を読む。`/register` は使わない |
| P15 | FR-ORDER-006 は Mailpit 本文のリンクから入る。ほかは DB の試験道具でトークンを取れる。21日・24時間・900秒は DB 値と試験用の印の時刻で作り、待たない | 本物の道を1本持ち、長い待ちと不安定な時刻に頼らない |
| P16 | E-5 前の注文へ一括でリンクを作らない。次の新しいメール本文の準備で作る | 既存の決済・注文作成を変えない |
| P17 | Task 1 に `get_order_status_public_material(uuid)` を追加。発送・配送・返金の公開用材料を DB で名指しして返す。Task 2 の新 RPC は `_include_private boolean DEFAULT false` を持つ | 現行 `list_order_fulfillments/get_order_delivery_detail/list_order_refunds/get_customer_order_returns` は伝票番号や内部情報を返す。そのまま公開材料に使うと設計書5-2に反する。X3 に scope の追加として記録 |
| P18 | DB の比較は4文字それぞれの ASCII 値の XOR を OR で蓄積し、4回全てを実行後に0かを見る。比較途中の一致・不一致で抜けない | 4文字の照合を通常の text の `=` に任せない。DB全体の所要時間が一定だと主張するものではない |
| P19 | 期限は `verify_until > now()` の間だけ有効。同時刻は期限切れ。判定順は存在・隠す状態 → expired → unavailable → locked → 比較。20回目は `mismatch` で20となり、その答えの `reason='locked'` で欄を止める | 状態が重なった時の答えを固定する。正解しても失敗の合計は戻さない |
| P20 | verify POST は Origin → CSRF → IP 枠 → トークン形/存在 → 注文枠 → JSON/入力 → DB比較 → Cookie。本文は `{ lastFour: string }` だけ、文字列上限64、取り出した数字が4桁ちょうど。入力の最後4桁だけを採る処理にはしない | 不正入力でDBの失敗数を消費せず、短い枠は消費する。ゲストも CSRF の既存の意味を保つ |
| P21 | メール材料の準備は worker の `loadStatusUrl(orderId)` で行う。店向け・保存済み本文は呼ばない。新しいお客様向け本文だけ `orderStatusUrl` を材料へ足す | 既存3系統の loader の引数と再送の重複防止キーを保ち、旧本文を勝手に作り直さない |
| P22 | `OrderItemRow` と `OrderReturnsSection` に判別できる `readOnly:true` の props を追加。省略時は従来の操作あり。公開返品の型もそのまま受けられる表示用の枝を持つ | ゲスト用にダミー callback や空の個人情報を作らない |
| P23 | contact は mount 時の `window.location.search` を1回読む。`type/order` を別々に検証し、利用者が既に変えた欄は上書きしない。`subject` は今回読まない | 現行 Client Component を保ち、`useSearchParams` に伴う Suspense の追加を避ける |
| P24 | E-5 の公開返金型には `customerActionDeadline` を持たせない。金額・日付・processing/completed だけ。会員APIの同キーと案内は現状を保つ | 返金先口座の入力期限は支払方法を推測させ、設計書5-1のリンクだけの範囲に指定されていない |
| P25 | 個人情報の認可は有効な確認印 → 持ち主の認証の順。有効な印があれば古いログイン印が残っていても200。認証が成功した別会員だけでは none | 2つの認可のどちらかでよいという契約を守る。印の無い認証障害は503 |
| P26 | SQL の pgcrypto 前提は A 冒頭で `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`、続けて `extensions.gen_random_bytes(integer)` の存在を検査。既に別schemaへある時は固定記号 `ORDER_STATUS_CRYPTO_UNAVAILABLE` で止め、移設しない | 現行 migration のみでは配置を証明できない。実装者が探索した名前へ黙って切り替えない |
| P27 | E2E の `E2E_FIXED_ENV` に `ORDER_STATUS_SESSION_SECRET='e2e-order-status-session-secret-only'` と `NEXT_PUBLIC_SITE_URL='http://localhost:3000'` を追加。新しい注文状況 spec は trace/video/screenshot を off。URL や本文を失敗メッセージへ出さない | 親環境の秘密と本番サイトURLを引き継がず、試験の印を両プロセスで同じ鍵にし、記録からトークンを漏らさない |
| P28 | 適用前の保存済み未完了本文は件数だけ数え、本文を書き換えず通常の再試行を継続する。送信済みメールを一斉再送しない | 設計書8-2の「変えない」とP16を両立する。古い電話や旧リンクが本文に残る点を運用文書に明記 |
| P29 | 個人情報GETは `clientFetch`。verify POSTは `fetch` に `getCsrfTokenFromCookie()` の値がある時だけ同じCSRFヘッダーを付け、`credentials:'same-origin'` で1回送る | `client-fetch.ts:183-202` は読めるCSRF Cookieが無いPOSTの前にもrefreshする。ゲストの確認で余計な401通知を出さず、POSTを自動再送しない。CSRF/Originのサーバー側の守りは変えない |
| P30 | 共通E2Eのメール本文読取は `/order-status/{43文字}` の43文字部分を `[ORDER_STATUS_LINK]` へ伏せる。生のメールからURLを読むのはFR-ORDER-006の専用道具だけ | 既存メールのassert失敗で新しいトークンを本文diffへ出さない。直接Mailpit本文を読む既存2本も共通道具へ寄せる |
| P31 | Task 5でproxyのOrigin拒否の応答に、`/api/order-status` のセグメント配下だけ `Cache-Control:no-store` と `Referrer-Policy:no-referrer` を付ける。本文と403は維持する | 現行proxyは拒否を通常ヘッダー付与より前に返す。専用窓口の拒否時にも設計書4-3の守りを満たすための限定した追加（X4） |

### 突き合わせ

4件を追跡する。controller の決定を変更した件数は0。X1は優先する決定が指定済み、X3/X4は実装範囲の不足をこの下書きで補う案、X2は実DBでの前提確認が残る。

| ID | 設計・指定 | 現行の根拠と差 | この下書きでの扱い |
|---|---|---|---|
| X1 | 設計書5-2は印もログインも無い時401。controller P8は200のnone | `src/lib/client-fetch.ts:93-122,210-221` は401でrefreshし、refreshも401なら `auth:session-expired`。`src/contexts/LoginContext.tsx:249-262` は未ログインへ描き直す。FR-ACCOUNT-007について依頼にある既知の問題と整合 | controller P8を優先。C-3、Task 5/6、FR-ACCOUNT-044に固定。設計書を今回直さない |
| X2 | P2は乱数関数のschemaを既存移行から確定する指定 | `rg -ni 'pgcrypto|gen_random_bytes' supabase/migrations` は0件。`20260901102912_remote_schema.sql:7-9` の拡張の宣言だけでは pgcrypto の位置は分からない | 呼ぶ名前と保証方法はP2/P26に固定。controller が 2026-10-22 に手元の DB で確かめた: `pgcrypto` は `extensions` にあり、`extensions.gen_random_bytes` がある（Supabase の標準の置き場所）。本番は Task 11 の適用前の読み取りで同じ確認をする |
| X3 | Task 1の指定の列挙には公開材料RPCが無い。Task 2の新読み出しを既存の全項目のまま使うと設計書5-2に反する | 会員API `src/app/api/orders/[id]/route.ts:169-249`、配送型 `src/lib/orders/tracking/delivery-types.ts:55-61`、返品SQL `20261020144842_order_return_customer_requests.sql:1118-1126,1170-1183` は伝票番号・返送先・支払方法関連を含む | Task数は増やさず、Task 1へ公開材料RPC、Task 2へ `_include_private` の分岐を追加する案。公開経路の「取得前の分離」をDB結合とstoreの単体で検証する |
| X4 | 設計書4-3では専用APIの応答はno-store、ページからのReferrerは出さない | `src/proxy.ts:201-205` のOrigin拒否は `:226-232` の通常ヘッダーの付与より前に403を返す。Handlerだけではこの応答を補えない | Task 5の変更ファイルにproxyを追加する案。P31の2ヘッダーだけを新APIの拒否へ追加し、他ルートの意味は変えない |

作り手のレビュー1は設計書3章・11-lで既に採用済み。レビュー2の lax 案は採用しない。設計書6-4どおり、印を使うのはページ読み込み後の同じサイトへの API 呼び出しなので strict を保つ。

## File Structure

全予定ファイルを以下に列挙する。`{}` は表の中の同じ役目のファイルの列挙であり、コミット時は各 Task の実パスを使う。証拠は Task 11 に別記する。

| 作る・変えるファイル | 役目 | Task |
|---|---|---|
| `supabase/migrations/20261023100000_order_status_links.sql` | リンク表、確認、送信完了、公開材料の守り | 1 |
| `tests/integration/db/order_status_links.integration.test.ts` | リンク・期限・競合・権限・公開材料 | 1 |
| `tests/integration/db/helpers/order-status-fixtures.ts` | 手元だけの注文とリンクの見本 | 1 |
| `tests/integration/db/order_status_postgrest.integration.test.ts` | service_role RPC と anon/authenticated 拒否、JSONの境界 | 1/2 |
| `supabase/migrations/20261023100100_order_status_returns.sql` | 既存返品RPCの共通化と注文番号による読み出し | 2 |
| `tests/integration/db/order_status_returns.integration.test.ts` | 旧答えとの一致と公開・個人情報の分岐 | 2 |
| `tests/integration/db/helpers/order-status-fixtures.ts` | 元の返品関数を試験の取引内だけに用意し、同じ材料で答えを比べる | 2 |
| `src/lib/orders/customer-order-view-types.ts` | 共通の入力・会員返却型・公開型・個人情報型 | 3 |
| `src/lib/orders/customer-order-view.ts` | 発送・配送・返金・品物・進み具合・住所の組み立て | 3 |
| `src/app/api/orders/[id]/route.ts` | 既存の読み取りと認可を保ち、組み立てを共通関数へ移す | 3 |
| `tests/unit/lib/orders/customer-order-view.test.ts` | 公開キーの分離と会員の値の一致 | 3 |
| `tests/unit/api/orders/order-detail-progress.test.ts`、`tests/integration/api/orders.test.ts` | 既存会員APIの契約回帰 | 3 |
| `src/lib/orders/status/status-{types,token,phone,session,store,messages}.ts` | 土台、Cookie、厳密なDB変換、固定文 | 4 |
| `src/lib/orders/returns/customer-return-store.ts` | 公開/既存の返品の変換の共有。既存の呼び出しは変更しない | 4 |
| `tests/unit/lib/orders/status/status-{token,phone,session,store}.test.ts` | 形・署名・期限・DB呼び出しと型 | 4 |
| `tests/unit/lib/orders/returns/customer-return-store.test.ts` | 既存変換の回帰 | 4 |
| `src/app/api/order-status/[token]/{verify,private}/route.ts` | 確認POST、個人情報GET | 5 |
| `tests/unit/api/order-status/{verify,private}.test.ts` | 順番・認可・回数・返却・no-store | 5 |
| `tests/unit/middleware/proxy-origin.test.ts` | 新POSTもOrigin保護の対象であること | 5 |
| `src/proxy.ts` | 新APIのOrigin拒否にだけno-store/no-referrerを付ける | 5 |
| `src/app/order-status/[token]/{page,not-found,error}.tsx` | ページ・同じ404・固定エラー表示 | 6 |
| `src/features/order-status/components/OrderStatus{Public,Access,VerifyForm,Private,Guidance}.tsx` | 公開表示、取得と状態、入力、個人情報、2つの道 | 6 |
| `src/features/order-status/status-client.ts` | clientFetch の型つき呼び出し | 6 |
| `src/features/account/components/OrderItemRow.tsx`、`src/features/account/returns/OrderReturnsSection.tsx` | 操作を出さない枝 | 6 |
| `tests/unit/components/{OrderStatusPage,OrderItemRow}.test.tsx` | ページ入口と共有の行 | 6 |
| `tests/unit/features/order-status/{OrderStatusPublic,OrderStatusAccess,OrderStatusVerifyForm,OrderStatusPrivate,OrderStatusGuidance,status-client}.test.tsx` | 各表示・再取得・入力の部品試験 | 6 |
| `tests/unit/features/account/returns/OrderReturnsSection.test.tsx` | 操作ありを維持し、操作無しの返品表示 | 6 |
| `src/lib/orders/status/status-email.ts` | service_roleでリンクを用意し絶対URLにする | 7 |
| `src/lib/orders/email/order-email-{compose,worker}.ts` | 材料のURL、16種類への行の追加、電話削除 | 7 |
| `tests/unit/lib/orders/status/status-email.test.ts` | 既存リンク・不正サイトURL・DB失敗 | 7 |
| `tests/unit/lib/orders/email/order-email-compose{,-returns,-requests,-delivery}.test.ts` | 既存の全文期待と全書き分け | 7 |
| `tests/unit/lib/orders/email/order-email-worker{,-recipient,-requests,-delivery}.test.ts` | 材料の用意・店向け・保存済み本文・失敗 | 7 |
| `src/features/contact/contact-prefill.ts`、`src/app/contact/page.tsx` | type/orderの検証と初期入力 | 8 |
| `tests/unit/features/contact/contact-prefill.test.ts`、`tests/unit/components/ContactPage.test.tsx` | 値の検証・自動入力・編集の保持 | 8 |
| `e2e/order-status-test-utils.ts` | 手元DB・印・期限・回数・安全な遷移の道具 | 9 |
| `e2e/FR-ORDER-001-public-view.spec.ts`〜`008-delivery-refund-visibility.spec.ts` | Task 9 の8本（中間の実名もTask 9に列挙） | 9 |
| `e2e/FR-CONTACT-014-order-status-prefill.spec.ts`、`e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts` | 問い合わせと会員、各3ケース | 9 |
| `e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts`、`e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts` | 旧リンク期待の置換・電話が無いメールの確認 | 9 |
| `e2e/order-email-test-utils.ts`、`e2e/FR-CHECKOUT-041-confirmation-email-fulfillment.spec.ts`、`e2e/FR-CHECKOUT-045-in-stock-line.spec.ts` | メール本文のリンク値を伏せ、直接のMailpit本文読取を共有する | 9 |
| `scripts/e2e/environment.ts`、`tests/unit/scripts/e2e/environment.test.ts` | E2E専用の署名鍵を上書き、fingerprintへの反映 | 9 |
| `tests/unit/docs/order-status-traceability.test.ts` | 8行・32AC・E2Eコメント・契約の静的照合 | 10 |
| `docs/02_Requirements/requirements.md` | FREQ-498〜505 | 10 |
| `docs/03_BasicDesign/api/{api-spec,route-inventory}.md`、`docs/03_BasicDesign/data/er.md`、`docs/03_BasicDesign/ui/{screen-list,screen-flow}.md` | 窓口・表・画面のつながり | 10 |
| `docs/04_DetailDesign/pages/20_order_status.md`、`docs/04_DetailDesign/pages/{09_contact,15_account}.md` | 新しい頁と既存の受け渡し・表示共有 | 10 |
| `docs/04_DetailDesign/states/order-payment.md`、`docs/04_DetailDesign/sequence/order-administration.md` | 注文状態を変えないことと新しい閲覧の流れ | 10 |
| `docs/06_Operations/{order-email-operations,webhook-queue-operations}.md`、`.env.example` | 期限・旧本文・適用・鍵の名前 | 10/11 |
| `docs/superpowers/plans/2026-10-22-order-status-page.md` | 後日の検証記録と実際の移行名への追従 | 11 |

## 共通の約束

### C-0 表と列

新表は `private.order_status_links` だけ。注文・発送・返金・返品・メールの既存列を足したり型を変えたりしない。

| 列 | 型・制約 | 意味 |
|---|---|---|
| `order_id` | `uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT` | 注文ごと1本 |
| `token` | `text NOT NULL`、`order_status_links_token_key UNIQUE(token)` | 元のトークン |
| `verify_until` | `timestamptz NULL`、既定NULL | 確認の最後の時刻 |
| `failed_attempts` | `integer NOT NULL DEFAULT 0` | 確認できる期間の失敗の数 |
| `created_at` | `timestamptz NOT NULL DEFAULT pg_catalog.now()` | 作成時刻 |

CHECK 名は `order_status_links_token_check`（`token ~ '^[A-Za-z0-9_-]{43}$'`）、`order_status_links_failed_attempts_check`（`failed_attempts BETWEEN 0 AND 20`）。token の一意索引で検索する。期限での全件検索や定期削除は作らない。

policy 名は `order_status_links_deny_clients`。`AS RESTRICTIVE FOR ALL TO anon, authenticated USING(false) WITH CHECK(false)`。`REVOKE ALL` を `PUBLIC, anon, authenticated, service_role` へ行ってから `GRANT SELECT ... TO service_role`。`private` の schema USAGE は service_role の既存契約を確認する。新たに顧客へ与えない。

`complete_order_email` は outbox の `sending` と lease の一致を確かめる現在の UPDATE を維持し、その UPDATE の `RETURNING order_id,kind,sent_at` の結果だけで期限を進める。行の鍵で同じ注文の更新を直列にし、UPDATE の時点の値で `GREATEST` とリセット条件を計算する。send_pause の再開と boolean の返り値は従来どおり。本文の有無・内容・originで種類の判定を変えない。

### C-1 DB の関数

新しい RPC の引数名は下表のとおり。TABLE の0行と jsonb の SQL NULL を、いずれも TS は `null` に直す。秘密値を RAISE の文や DETAIL に差し込まない。

| Task | 完全な署名 | 答えと条件 |
|---|---|---|
| 1 | `private.order_status_phone_last_four(_phone text) RETURNS text` | IMMUTABLE、全角数字をtranslate後に数字だけ、4桁未満NULL、ほかは最後4桁。DB内だけ |
| 1 | `private.order_status_four_equal(_actual text, _provided text) RETURNS boolean` | IMMUTABLE、数字4桁同士だけ。P18の固定4回比較。外から呼べない |
| 1 | `public.ensure_order_status_link(_order_id uuid) RETURNS text` | 注文が無ければ `ORDER_NOT_FOUND/P0002`。NULL引数は `ORDER_STATUS_ARGUMENT_INVALID/22023`。既存リンクはそのまま返す。隠す状態でも作成は拒まないが読むRPCは隠す。token一意衝突は3回まで再生成し、超過は `ORDER_STATUS_TOKEN_COLLISION/23505` |
| 1 | `public.get_order_status_link(_token text) RETURNS TABLE(order_id uuid, customer_id uuid, verify_until timestamptz, failed_attempts integer, phone_available boolean)` | 形が違う・存在しない・隠す状態は0行。customer_idはorders.user_id。phone_availableはDB内の抽出結果の有無だけ。電話・トークンは答えに含めない |
| 1 | `public.verify_order_status_phone(_token text, _last_four text) RETURNS TABLE(result text, verify_until timestamptz, failed_attempts integer)` | 存在しない・隠す状態は0行。入力が数字4桁でなければ22023。P19順に判定、リンク行の `FOR UPDATE` 後に比較・加算。正解でもカウンターを消さない |
| 1 | `public.get_order_status_public_material(_order_id uuid) RETURNS jsonb` | NULL/無い/隠す状態はSQL NULL。C-2 `CustomerOrderPublicMaterial` の snake_case の形。返品は含めず、個人情報の列や全行の `to_jsonb(o)` を読まない |
| 1 | `public.complete_order_email(_email_id uuid, _lease_token uuid, _provider_message_id text) RETURNS boolean` | 引数・返り値・lease・pause処理を維持。対象はC-6の16種類だけ。P4の期限更新を同じ取引に追加 |
| 2 | `private.build_customer_order_returns(_order public.orders, _include_private boolean) RETURNS jsonb` | STABLE、既存SQLのJSONを作る芯。既存の並び・null・状態決定・availabilityを保つ。falseでは返送先と送り返しの業者/番号のキーを作らず、その列の取得も分岐外へ出さない |
| 2 | `public.get_customer_order_returns(_order_id uuid, _customer_id uuid) RETURNS jsonb` | STABLE、最初に既存 `private.customer_order_for_request(_order_id,_customer_id,false)`、次に芯へtrue。無い・他人・隠す状態は従来どおり `ORDER_NOT_FOUND/P0002`。NULL返しへ変えない |
| 2 | `public.get_order_status_returns(_order_id uuid, _include_private boolean DEFAULT false) RETURNS jsonb` | STABLE、所有者条件無し、無い・NULL・隠す状態はSQL NULL。trueは従来と同じJSON、falseは公開返品型のsnake_case。service_roleだけ |

新旧 public RPC は全て Global Constraints の守り。private の芯は既存と同じ所有者の内部呼び出しだけで使い、service_role への直接 EXECUTE は与えない。

言語と実行の属性も固定する。privateの電話抽出は `LANGUAGE sql IMMUTABLE SECURITY INVOKER`、4桁比較は `LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER`、返品の芯は `LANGUAGE plpgsql STABLE SECURITY INVOKER`。全て `SET search_path = ''`。get_order_status_link/get_order_status_public_material/返品のpublic2関数は `LANGUAGE plpgsql STABLE`、ensure/verify/completeは `LANGUAGE plpgsql VOLATILE`。publicは全て前述のSECURITY DEFINER。

公開材料RPCは次の値だけを名指しする。公開の画面に渡さない計算用の値も、電話や追跡番号を含まない。

| JSONのキー | DBの取得元と全項目 |
|---|---|
| `order` | ordersの `id,created_at,status,subtotal_amount,shipping_amount,discount_amount,total_amount,currency` と `order_items`。明細は `id,item_id,variant_id,item_name,item_image_url,color,size,quantity,line_total,line_kind`、`created_at,id` 昇順 |
| `line_rows` | 既存 `private.order_line_fulfillment(_order_id)` を既存 `list_order_line_fulfillment` と同じ名前へ変換。C-2 `OrderLineFulfillmentRow` の全項目。数え方は複製しない |
| `fulfillments` | `fulfillment_id,number,shipping_carrier,shipped_at,cancelled_at,lines[{order_item_id,quantity}]`。取消済みも材料上は可、最終表示は除外。番号昇順、行は既存と同じ順 |
| `delivery_detail` | `enabled` と `fulfillments[{fulfillment_id,cancelled_at,tracking_version,delivery_status,delivery_status_at,delivered_at,registration,events}]`。registration は現版の `state,ever_registered` だけ。eventsは現版だけの `tracking_version,status,happened_at,recorded_at`、新しい時刻順。操作した人・細かい状況・番号の直しの履歴は取得しない |
| `delivery_summary` | `active_count,delivered_count`。取消でない発送をDBで数える。要対応の種別を出さない |
| `refund_rows` | order_refundsの `refund_id,created_at,amount,status`。全状態の材料を読むが最終表示は processing/completed だけ。支払方法・口座期限・失敗理由・メモ・実行者を取得しない |

トークン照合と認可用の link、公開材料、公開返品は別の読み取り。途中で注文が隠す状態へ変わった場合も公開材料/返品で再確認する。材料がNULLなら404。返品だけの失敗は `returnSection:null`、それ以外の読取障害は固定エラーで止め、空の履歴を作らない。

### C-2 TS の型と関数

以下は署名と型の契約。関数本体は実装者が書く。`OrderStatusStore` は `Pick<SupabaseClient,'rpc'|'from'>` とし `status-store.ts` からexportする。store と session と status-email は `import 'server-only'`、型・文・純粋な表示組み立てには付けない。Jest は既存と同じ `jest.mock('server-only',()=>({}),{virtual:true})` を使う。

#### 表示の型と関数（Task 3）

`customer-order-view-types.ts` で定義する。既存型の import は `order-progress.ts`、`tracking/delivery-types.ts`、`returns/customer-return-types.ts`、`fulfillment/fulfillment-store.ts`、`refund/refund-store.ts`。次の省略元は既存APIのJSONの全項目（`src/app/api/orders/[id]/route.ts:391-435`）を写した型 `CustomerOrderDetailView` であり、ページ側の不完全なローカル型を元にしない。

```ts
type CustomerOrderItemRow = {
  id: string; item_id: number | null; variant_id: number | null; item_name: string;
  item_image_url: string | null; color: string | null; size: string | null;
  quantity: number; line_total: number; line_kind: 'order' | 'exchange';
};
type CustomerOrderPublicRow = {
  id: string; created_at: string; status: Exclude<OrderStatus,'payment_in_progress'|'abandoned'>;
  subtotal_amount: number; shipping_amount: number; discount_amount: number;
  total_amount: number; currency: string; order_items: CustomerOrderItemRow[] | null;
};
type CustomerOrderItem = {
  id: string; itemId: number | null; variantId: number | null; name: string;
  imageUrl: string | null; color: string | null; size: string | null;
  quantity: number; amount: string; lineKind: 'order'|'exchange';
  shippedQuantity: number; refundedQuantity: number; readyQuantity: number; inProductionQuantity: number;
};
type CustomerOrderShipment = {
  id: string; number: number; shippedAt: string; carrier: string | null; carrierLabel: string | null;
  trackingNumber: string | null; trackingUrl: string | null; deliveredAt: string | null;
  delivery?: CustomerDelivery;
  items: Array<{orderItemId:string;name:string;color:string|null;size:string|null;quantity:number;lineKind:'order'|'exchange'}>;
};
type CustomerOrderRefund = {
  id:string;date:string;amount:string;status:'processing'|'completed';customerActionDeadline:string|null;
};
type PublicCustomerOrderReturn = Omit<CustomerOrderReturn,'returnAddress'|'sentBack'> & {
  sentBack: Array<Omit<CustomerOrderReturn['sentBack'][number],'carrier'|'trackingNumber'>>;
};
type PublicCustomerOrderReturns = Omit<CustomerOrderReturns,'returns'> & {returns:PublicCustomerOrderReturn[]};
type CustomerOrderPublicView = {
  id:string;orderNumber:string;orderDate:string;status:CustomerOrderPublicRow['status'];
  progress:OrderProgress & {steps:OrderProgressStep[]|null};
  subtotalAmount:string;shippingAmount:string;discountAmount:string;totalAmount:string;
  shipments:Array<Omit<CustomerOrderShipment,'trackingNumber'|'trackingUrl'>>;
  refunds:Array<Omit<CustomerOrderRefund,'customerActionDeadline'>>;refundTotal:string|null;
  returnSection:PublicCustomerOrderReturns|null;items:CustomerOrderItem[];
};
type OrderStatusPrivateReturn = {
  id:string;returnAddress:CustomerOrderReturn['returnAddress'];
  sentBack:Array<{index:number;trackingNumber:string|null}>;
};
type CustomerOrderPrivateView = {
  shipping:{fullName:string;postalCode:string;address:string;phone:string};
  contactEmail:string;paymentMethod:string;
  shipments:Array<Pick<CustomerOrderShipment,'id'|'number'|'trackingNumber'|'trackingUrl'>>;
  returns:OrderStatusPrivateReturn[];
};
type CustomerOrderDetailView = Omit<CustomerOrderPublicView,'shipments'|'refunds'|'returnSection'> & {
  paymentMethod:string;shippingFullName:string;shippingEmail:string;shippingPhone:string;shippingAddress:string;
  shipments:CustomerOrderShipment[];refunds:CustomerOrderRefund[];returnSection:CustomerOrderReturns|null;
};
```

`CustomerOrderPublicMaterial` の形は `{order:CustomerOrderPublicRow;lineRows:OrderLineFulfillmentRow[];fulfillments:PublicFulfillmentMaterial[];deliveryDetail:PublicDeliveryMaterial;deliverySummary:{activeCount:number;deliveredCount:number};refundRows:PublicRefundMaterial[]}`。3つの補助型は次で固定する。

```ts
type PublicFulfillmentMaterial = Pick<OrderFulfillmentHistoryRow,
  'fulfillmentId'|'number'|'shippingCarrier'|'shippedAt'|'cancelledAt'|'lines'>;
type PublicDeliveryMaterial = {enabled:boolean;fulfillments:Array<{
  fulfillmentId:string;cancelledAt:string|null;trackingVersion:number;deliveryStatus:DeliveryStatus;
  deliveryStatusAt:string;deliveredAt:string|null;
  registration:{state:TrackingState;everRegistered:boolean}|null;
  events:Array<{trackingVersion:number;status:DeliveryStatus;happenedAt:string;recordedAt:string}>;
}>};
type PublicRefundMaterial = Pick<OrderRefundRow,'refundId'|'createdAt'|'amount'|'status'>;
type CustomerOrderPublicInput = CustomerOrderPublicMaterial & {
  returnSection:PublicCustomerOrderReturns|null;trackingKeyConfigured:boolean;
  signImage:(path:string|null)=>Promise<string|null>;
};
type CustomerOrderPrivateInput = {
  order:{shipping_full_name:string|null;shipping_postal_code:string|null;shipping_prefecture:string|null;
    shipping_city:string|null;shipping_address:string|null;shipping_building:string|null;
    shipping_phone:string|null;shipping_email:string|null};
  paymentMethod:string|null;
  fulfillments:Array<Pick<OrderFulfillmentHistoryRow,'fulfillmentId'|'number'|'shippingCarrier'|'trackingNumber'|'cancelledAt'>>;
  returnSection:CustomerOrderReturns|null;
};
```

`CustomerOrderDetailInput` は `{order:CustomerOrderPublicRow & CustomerOrderPrivateInput['order'];lineRows:OrderLineFulfillmentRow[];fulfillments:OrderFulfillmentHistoryRow[];deliverySummary:OrderDeliverySummary|undefined;deliveryDetail:OrderDeliveryDetail;refundRows:OrderRefundRow[];returnSection:CustomerOrderReturns|null;paymentMethod:string|null;trackingKeyConfigured:boolean;signImage:CustomerOrderPublicInput['signImage']}`。

| ファイル | exportする署名 | 使い方 |
|---|---|---|
| `customer-order-view.ts` | `buildCustomerOrderPublicView(input:CustomerOrderPublicInput):Promise<CustomerOrderPublicView>` | 公開のキーだけ。単体では余計なキーを混ぜた材料も試す |
| 同上 | `buildCustomerOrderPrivateView(input:CustomerOrderPrivateInput):CustomerOrderPrivateView` | P9だけ。住所は郵便番号を除く4要素を空白で連結、名前/電話/メール等NULLは空文字 |
| 同上 | `buildCustomerOrderDetailView(input:CustomerOrderDetailInput):Promise<CustomerOrderDetailView>` | 共通計算を使って現行会員JSONを復元。住所は現行どおり郵便番号に〒を付け、ほかと空白で連結。返金口座期限・完全な返品・追跡番号を現行位置へ入れる |

金額・日時・配列順・返金状態・`hasOpenRefund`・品ごとの数・追跡の公開条件は元APIから移す。公開の返金に口座期限を足さない点だけが新頁用の差。会員への値は変えない。配送が無い時は `delivery:null` でなくキー無し。返品を公開型へ写す時も名指しし、全体の spread で非公開キーを混ぜない。

#### 土台（Task 4）

`status-types.ts` は次の型をexportする。`OrderStatusLink` はサーバー内部だけで使い、Client Component のpropsへ渡さない。

```ts
type OrderStatusLink = {
  orderId:string;customerId:string|null;verifyUntil:string|null;failedAttempts:number;phoneAvailable:boolean;
};
type OrderStatusUnavailableReason = 'expired'|'unavailable'|'locked';
type OrderStatusVerification = {verifiable:true;reason:null}|{verifiable:false;reason:OrderStatusUnavailableReason};
type OrderStatusPhoneResult = {result:'ok'|'mismatch'|'locked'|'unavailable'|'expired';verifyUntil:string|null;failedAttempts:number};
type OrderStatusSession = {purpose:'order_status';orderId:string;tokenHashPrefix:string;iat:number;exp:number};
type OrderStatusPrivateResponse =
  | ({access:'none'} & OrderStatusVerification)
  | {access:'member';data:CustomerOrderPrivateView;expiresAt:null}
  | {access:'verified';data:CustomerOrderPrivateView;expiresAt:string};
type OrderStatusVerifyResponse = {ok:true;expiresAt:string};
type OrderStatusErrorCode = 'ORDER_STATUS_NOT_FOUND'|'ORDER_STATUS_INPUT_INVALID'|'ORDER_STATUS_MISMATCH'
  |'ORDER_STATUS_LOCKED'|'ORDER_STATUS_UNAVAILABLE'|'ORDER_STATUS_EXPIRED'|'ORDER_STATUS_RATE_LIMITED'
  |'ORDER_STATUS_FORBIDDEN'|'ORDER_STATUS_AUTH_REQUIRED'|'ORDER_STATUS_TEMPORARILY_UNAVAILABLE'|'ORDER_STATUS_FAILED';
type OrderStatusErrorResponse = {error:string;code:OrderStatusErrorCode;verifiable?:boolean;reason?:OrderStatusUnavailableReason|null};
```

| ファイル | 署名・定数 |
|---|---|
| `status-token.ts` | `isOrderStatusToken(value:unknown):value is string`、正規表現 `^[A-Za-z0-9_-]{43}$`。trimして通さない |
| `status-phone.ts` | `extractOrderStatusLastFour(phone:string|null|undefined):string|null`（全角数字→半角→数字だけ→4桁以上なら末尾4桁）、`parseOrderStatusLastFour(value:unknown):string|null`（文字列1〜64字、同じ数字化の後4桁ちょうどだけ） |
| `status-session.ts` | `ORDER_STATUS_SESSION_COOKIE_NAME='sb-order-status'`、`ORDER_STATUS_SESSION_MAX_AGE_SECONDS=86400` |
| 同上 | `createOrderStatusSession(input:{orderId:string;token:string;verifyUntil:string;now?:Date}):{value:string;session:OrderStatusSession}` |
| 同上 | `readOrderStatusSession(value:string|undefined,input:{orderId:string;token:string;verifyUntil:string|null;now?:Date}):OrderStatusSession|null` |
| 同上 | `orderStatusCookieOptions(token:string,session:OrderStatusSession):{httpOnly:true;secure:boolean;sameSite:'strict';path:string;maxAge:number;expires:Date}` |
| `status-store.ts` | `ensureOrderStatusLink(store:OrderStatusStore,orderId:string):Promise<string>` |
| 同上 | `getOrderStatusLink(store:OrderStatusStore,token:string):Promise<OrderStatusLink|null>` |
| 同上 | `verifyOrderStatusPhone(store:OrderStatusStore,input:{token:string;lastFour:string}):Promise<OrderStatusPhoneResult|null>` |
| 同上 | `loadOrderStatusPublicMaterial(store:OrderStatusStore,orderId:string):Promise<CustomerOrderPublicMaterial|null>` |
| 同上 | `loadOrderStatusReturns(store:OrderStatusStore,input:{orderId:string;includePrivate:false}):Promise<PublicCustomerOrderReturns|null>` と `includePrivate:true` の `Promise<CustomerOrderReturns|null>` のオーバーロード |
| 同上 | `loadOrderStatusPrivateInput(store:OrderStatusStore,orderId:string):Promise<CustomerOrderPrivateInput|null>` |
| 同上 | `orderStatusVerification(link:OrderStatusLink,now?:Date):OrderStatusVerification`（P19の順） |
| 同上 | `OrderStatusStoreError extends Error`、`constructor(operation:string,cause?:unknown)`、`readonly operation:string`、`readonly code:'ORDER_STATUS_STORE_FAILED'`。messageは `order status store failed` 固定。元DBエラーはcauseのみ、ログへ渡さない |
| `customer-return-store.ts` | `parseCustomerOrderReturns(value:unknown,orderId:string):CustomerOrderReturns|null`、`parsePublicCustomerOrderReturns(value:unknown,orderId:string):PublicCustomerOrderReturns|null`。既存loaderも前者を使う |

新RPCのJSONは snake_case、TSだけcamelCase。数字・列挙・日付・配列の形が壊れた答えを `String(undefined)` や空配列で成功にしない。新storeは固定エラーにする。既存の返品parserの許容範囲は変えない。

Cookie は `base64url(JSON).base64url(HMAC-SHA256)`。鍵は非空の専用値、次に非空のJWT_SECRET、両方無ければ固定エラー。JSONの順は `purpose,orderId,tokenHashPrefix,iat,exp`。`iat=floor(now/1000)`、`exp=min(iat+86400,floor(verifyUntil/1000))`、`exp<=iat` は発行しない。署名は32バイトで長さを確かめて `timingSafeEqual`。purpose、UUID、16文字の小文字hex、整数時刻、`iat<=now<exp`、`0<exp-iat<=86400`、注文一致、ハッシュ一致、現在のDB期限が未来で `exp<=DB期限` を全て確認する。延長メールでも古いCookieのexpを延ばさない。Cookieへ生のトークン・電話は入れない。Domainは指定しない。

`loadOrderStatusPrivateInput` は認可後だけ呼ぶ。ordersの `shipping_full_name,shipping_postal_code,shipping_prefecture,shipping_city,shipping_address,shipping_building,shipping_phone,shipping_email,payment_intent_id` を名指しし、id一致と `HIDDEN_ORDER_STATUS_FILTER` の除外をここでも付ける。無ければnull。ほかに読むのは `checkout_drafts.payment_method`、取消でない発送の `id,number,shipping_carrier,tracking_number,cancelled_at`、`get_order_status_returns(...,true)` だけ。支払方法は既存どおり payment_intent_id で draft を `limit(1).maybeSingle()`、無ければnull。失敗をログに出さない。公開材料にはこの関数を呼ぶ道を持たせない。

#### ブラウザ・お問い合わせ・メール（Task 6〜8）

| ファイル | 署名 |
|---|---|
| `features/order-status/status-client.ts` | `fetchOrderStatusPrivate(token:string,signal?:AbortSignal):Promise<Response>` は `clientFetch`。`submitOrderStatusLastFour(token:string,lastFour:string):Promise<Response>` はP29の `fetch` と既存CSRFヘッダー。両方 `cache:'no-store'`。POSTの自動再送無し |
| `features/contact/contact-prefill.ts` | `type ContactPrefill={inquiryType?:'product'|'order'|'other';orderNumber?:string}`、`parseContactPrefill(search:string):ContactPrefill`。重複した同名queryはその項目を無視 |
| `status/status-email.ts` | `loadOrderStatusEmailUrl(store:OrderStatusStore,orderId:string):Promise<string|null>`。P12、DB失敗は固定storeエラー、URL失敗はnull |
| `order-email-compose.ts` | 既存 `OrderEmailMaterial` に `orderStatusUrl?:string|null`。`composeOrderEmail` の署名は維持。新しいお客様向け本文はURLが無ければnull |
| `order-email-worker.ts` | 既存 `OrderEmailWorkerDeps` に `loadStatusUrl:(orderId:string)=>Promise<string|null>` を追加。runOrderEmailWorkerがservice_roleのstoreを閉包に持つ |

### C-3 窓口

| 方法・住所 | 本文 | 正常 |
|---|---|---|
| `POST /api/order-status/[token]/verify` | JSON `{lastFour:string}`。他のキーは禁止 | `200 {ok:true,expiresAt:ISO文字列}` と確認Cookie。`expiresAt`はCookieのexpと同じ |
| `GET /api/order-status/[token]/private` | 無し。queryで認可情報を受け取らない | C-2 `OrderStatusPrivateResponse`。member/verifiedだけdataを持ち、noneはdataキー無し |

両 Handler は `(request:NextRequest,context:{params:Promise<{token:string}>}):Promise<NextResponse>`。verify は `export const runtime='nodejs'`。GETもNodeの署名検証を使うので同じruntime。JSONの全部の答えにno-storeと `Referrer-Policy:no-referrer` を付ける。

verify の制限応答は既存 `enforceRateLimit` の `Retry-After` と503の意味を保ち、本文はC-4の固定文へ直す。IP超過は後続のDBを呼ばない。token形不正も、Origin/CSRF/IPの後は注文の読取無しで404。存在が確認できたら注文枠を消費してから入力を検証する。比較中に消えた/隠された場合も404。

| verify の結果 | HTTP | 返す物 |
|---|---|---|
| 入力・JSONが不正 | 400 | `ORDER_STATUS_INPUT_INVALID`。失敗の合計は増やさない |
| mismatch、合計19以下 | 400 | `ORDER_STATUS_MISMATCH`、`verifiable:true,reason:null` |
| 20回目のmismatch | 400 | `ORDER_STATUS_MISMATCH`、`verifiable:false,reason:'locked'`。画面はロック案内へ |
| 既にlocked | 423 | `ORDER_STATUS_LOCKED`、`verifiable:false,reason:'locked'` |
| unavailable | 409 | `ORDER_STATUS_UNAVAILABLE`、`verifiable:false,reason:'unavailable'` |
| expired | 410 | `ORDER_STATUS_EXPIRED`、`verifiable:false,reason:'expired'` |
| 無い・隠す・形不正 | 404 | `ORDER_STATUS_NOT_FOUND`。3つとも同じ本文 |
| IP/注文の枠超過 | 429 | `ORDER_STATUS_RATE_LIMITED` と `Retry-After` |
| CSRF拒否 | 403 | `ORDER_STATUS_FORBIDDEN`。Origin拒否は現行proxyの `{error:'Forbidden origin'}` のまま |
| DB/鍵/予期しない失敗 | 500 | `ORDER_STATUS_FAILED`。制限・認証サービスの利用不能は503へ |

GETはトークンの形 → link取得 → 有効な確認印 → 持ち主の認証 → none の順。印の認可で成功したら認証を必須にしない。確認印のない要求は、`extractAuthToken(request)` または `sb-refresh-token` の存在を「ログインの印の持ち込み」とする。いずれも無いなら認証を呼ばずnone。refreshだけ残る時は401で更新の機会を作る。

認証成功でも `claims.sub !== link.customerId` ならnone（有効な確認印がある時は上のverified）。認証失敗の `missing/invalid/revoked` は、持ち込みがある場合だけ401。本文は `{access:'none',verifiable,reason,error:'Unauthorized',code:'ORDER_STATUS_AUTH_REQUIRED'}`。`unavailable` は503、`Retry-After:30`。印の無効だけでは401にしない。既にログインを失っても公開部分をログイン画面へ転送しない。

認可後の個人情報の組み立てが失敗したら500、存在しなければ404。個人情報を空の成功で返さない。`reason` は `expired/unavailable/locked/null` だけ。`failedAttempts`・期限のDB値・customerIdは未認可の答えに含めない。

### C-4 誤りの記号と画面の言葉

APIの `error` もこの文を使う。401の `Unauthorized` と既存proxyの403だけは前節のとおり。ブラウザは401の後、公開のまま案内を出す。503/500は再取得ボタンを出す。

| code・状況 | 画面の文（固定） |
|---|---|
| `ORDER_STATUS_NOT_FOUND` | このページは見つかりません |
| `ORDER_STATUS_INPUT_INVALID` | 電話番号の下4桁を入れてください。 |
| `ORDER_STATUS_MISMATCH` | 電話番号の下4桁が一致しません。もう一度確かめてください。 |
| `ORDER_STATUS_LOCKED` | 確認できる回数を超えました。ログインするか、お問い合わせください。 |
| `ORDER_STATUS_UNAVAILABLE` | ログインするか、お問い合わせください |
| `ORDER_STATUS_EXPIRED` | 電話番号で確認できる期間が過ぎました。ログインするか、お問い合わせください。 |
| `ORDER_STATUS_RATE_LIMITED` | しばらくしてから、もう一度お試しください。 |
| `ORDER_STATUS_FORBIDDEN` | 画面を開き直して、もう一度お試しください。 |
| `ORDER_STATUS_AUTH_REQUIRED` の画面案内 | ログインするか、電話番号の下4桁で確かめてください。 |
| `ORDER_STATUS_TEMPORARILY_UNAVAILABLE` | ただいま確認できません。時間をおいて、もう一度お試しください。 |
| `ORDER_STATUS_FAILED`・通信失敗・ページのerror | ご注文の状況を読み込めませんでした。時間をおいて、もう一度お試しください。 |

DB専用の `ORDER_STATUS_ARGUMENT_INVALID` は入力400、`ORDER_NOT_FOUND` は404へ写す。それ以外のDB文字列・SQLSTATEをブラウザへ返さない。ログで使うのは上表の固定codeと `ORDER_STATUS_CRYPTO_UNAVAILABLE` だけ。監査の新イベントは作らない。

### C-5 画面の文言

新しい文字列は `status-messages.ts` の `ORDER_STATUS_TEXT` と `ORDER_STATUS_ERROR_MESSAGES` に集める。既存の意味の同じラベルは下の表の既存定数を使う。この節を正とし、実装者が英語へ置き換えたり説明を言い換えたりしない。

| 場所 | 文・式・条件 |
|---|---|
| metadata title | `ご注文の状況 | Le Fil des Heures`（トークンや注文番号を入れない） |
| h1 | ご注文の状況 |
| 番号・注文日 | `注文番号 {orderNumber}`、`ご注文日 {orderDate}` |
| 段のaria-label | 配送ステータス |
| 発送h2/aria-label | `配送情報（{number}回目）` |
| 配送ラベル・リンク | 発送日、配送業者、お届け日、最後の更新、配送の移り変わり、追跡番号、配送状況を確認する |
| 届いた日/更新 | `お届け日 {M月D日}`、`最後の更新 {日本時間の日時}` |
| 配送の問題 | 配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください |
| 未発送h2 | 発送準備中の商品、受注生産中の商品（該当する数が1以上の時だけ） |
| 商品h2 | ご注文商品 |
| 商品の行 | `数量: {quantity}`、交換の品、`返金済み {refundedQuantity}点`、交換の金額は `—`、色とサイズは `{color} / {size}` |
| 発送の品/返品の品 | `{品名}{色・サイズがあれば括弧内に色 / サイズ} × {quantity}`。既存の `itemLabel/describeItem` と同じ空値の扱い |
| 金額h2・dt | 支払金額、小計、送料、クーポン値引き、支払金額 |
| 返金 | ご返金、手続き中、完了、ご返金の合計（合計は2件以上） |
| 確認h2 | お届け先などの確認 |
| 確認の説明 | お届け先・お支払い方法・伝票番号を見るには、ご注文の時の電話番号の下4桁を入れてください。 |
| 入力ラベル | ご注文の時の電話番号の下4桁 |
| 入力補助 | 数字4桁を入れてください。 |
| 入力例 | `1234` |
| 送信/送信中 | 確かめる、確認中… |
| 確認成功のLiveMessage | 確認できました。 |
| 個人情報取得中のLiveMessage | お届け先などを確認しています。 |
| 個人情報のh2 | お届け先、ご連絡先、お支払い方法、伝票番号、返品の返送先・送り返しの伝票番号 |
| 個人情報のdt | お名前、郵便番号、住所、電話番号、メールアドレス |
| 空の個人情報の値 | `-`（空欄のままにしない） |
| 通常発送の番号 | `配送情報（{number}回目）`、`追跡番号 {trackingNumber}`。番号の無い発送は個人情報側の行ごと出さない |
| ログインへのリンク | ログインする（`/login`） |
| ゲスト向けh2 | 返品・キャンセルをご希望の方へ |
| 会員登録の説明 | ご注文の時と同じメールアドレスで会員登録し、メールの確認を済ませると、このご注文が会員の注文履歴に入り、そこから返品・キャンセルを申し込めます。 |
| 登録のリンク | 会員登録して申し込む（`/login?tab=register`） |
| 問い合わせの説明 | 会員登録をせずにお申し込みをご希望の方は、お問い合わせからご連絡ください。注文番号は入力済みで開きます。 |
| 問い合わせのリンク | お問い合わせから申し込む（`/contact?type=order&order={orderNumber}`） |
| 持ち主向けh2/説明 | 返品・キャンセルのお申し込み、返品・キャンセルのお申し込みは、会員の注文のページで受け付けています。 |
| 持ち主向けリンク | 会員の注文のページへ（`/account/orders/{id}`） |
| 読み直しボタン | もう一度読み込む |
| 404のリンク | トップページへ（`/`） |

進み具合のlabelは現行 `ORDER_PROGRESS_LABELS` のうち `未決済/受注生産中/発送準備中/配送中/配達済み/決済失敗/キャンセル/キャンセルの手続き中`、一部の印は `一部発送済み`。段は `お支払い/受注生産中/発送準備中/配送中/配達済み`。隠す2状態のlabelを公開しない。

配送の8ラベルは `受付済み/輸送中/配達中/不在で持ち帰り/受け取り待ち/配達済み/遅れ/問題あり`（`DELIVERY_STATUS_LABELS`）。運送会社は現行 `SHIPPING_CARRIERS` のlabel。支払方法は現行 `mapPaymentMethodLabel` の `クレジットカード/コンビニ払い/PayPay/Link/銀行振込`、未知の値は保存済みの文字列、空は `-`。新しい番号や方法の推測はしない。

返品表示は `OrderReturnsSection` の既存の文を次のとおり保つ。公開側に送り先と番号を空文字で作って渡さず、型の無い部分は専用の個人情報の欄へ置く。

| 値・場所 | label / note / 式 |
|---|---|
| 欄h2・返品番号 | 返品・交換、`返品番号 {label}` |
| requested | お申し込み中 / 内容を確かめて、メールでご連絡します。 |
| accepted | 返品の受付済み |
| partially_received | 一部をお受け取りしました / 残りの商品の返送のしかたは、下のとおりです。 |
| inspecting | お受け取りしました（確かめています） / 確かめてから、ご連絡します。 |
| awaiting_fee | お支払いをお待ちしています / ご案内のメールをご覧ください。 |
| refund_preparing / returned / declined | ご返金の準備中 / 返品済み / お受けできませんでした |
| cancel requested | キャンセルのお申し込み中 |
| cancel declined | キャンセルのお申し込みをお受けできませんでした |
| cancel resolved / closed | キャンセルのお申し込みのお手続きが済みました |
| ご希望・解決 | ご希望: 返金、`ご希望: 交換（{色 / サイズ}）`、無ければ ご希望: 交換、返金、`交換: {色 / サイズ}`、無ければ 交換 |
| 金額・店の文 | `ご返金 {formatYen(refundAmount)}`、当店より:、店の文そのまま |
| 交換の発送 | 交換の品をお送りします。、交換の品をお送りしました。 |
| 返送h4・案内 | 返送のしかた、品物のご返送は不要です。、下記の返送先へお送りください。 |
| 店負担 | 返送料は当店が負担いたします。着払いでお送りください。 |
| お客様負担 | 恐れ入りますが、返送料はお客様のご負担でお送りください。 |
| 店の送り状 | 当店がご用意する送り状でお送りください。 / `当店がご用意する送り状でお送りください。返送料 {formatYen(fee)} をご返金額から差し引きます。` |
| 返送先・送り返し | 返送先:、`〒{postalCode} {address}`、お返しした商品、E-5の個人情報欄は `送り返しの伝票番号: {trackingNumber}`。会員の既存の枝は業者があればそのlabelと半角空白を番号の前に付ける従来表記を保つ |

readOnly の時は「返品・交換を申し込む」「キャンセルを申し込む」とフォーム、受付終了の操作案内を出さない。記録の無い返品欄は出さない。送り返した品名・数・店の文は公開表示に残し、番号は個人情報の欄だけ。認可後の返送先も同欄だけにし、公開欄へ重複させない。

日付と金額は会員APIの既存書式。注文日時は `Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})`。返金日は同じ設定の時刻無し。配達日と返品期限は `M月D日`。配送の時刻は会員ページと同じ日本時間の `formatDateTime` の書式。壊れた表示日付は `-`。

### C-6 メールの文言

対象は `paid,awaiting_payment,payment_expired,canceled,shipped,refund,return_accepted,return_received,return_sent_back,return_requested,return_declined,cancel_request_received,cancel_request_declined,out_for_delivery,delivered,shipping_update` の16種類。店向けは `return_refund_pending_shop,return_request_shop,cancel_request_shop` の3種類で、変更しない。

| 操作 | そのまま使う行 |
|---|---|
| 足す | `ご注文の状況はこちら: {orderStatusUrl}` |
| 直後の既存行 | `お問い合わせの際は、注文番号（{orderNumber}）をお問い合わせフォームにご入力ください。` |
| deliveredから消す | `ご注文の確認はこちら: {getSiteUrlを基にした/account/orders/{id}のURL}` と、その後の旧リンク用の空行 |
| paid / awaiting_paymentから消す | `shippingLines` の `order.shipping_phone || null` に由来する電話の1行。お届け先の名前・郵便番号・住所・建物は残す |

新しい末尾は `空行 → ご注文の状況はこちら: {URL} → お問い合わせの際は、注文番号（{orderNumber}）をお問い合わせフォームにご入力ください。 → 空行 → Le Fil des Heures`。リンクとお問い合わせの間に空行を挟まない。deliveredも同じ末尾にそろえる。ほかの文・件名・品名・数量・金額・追跡リンク・返送先のお店の電話を変えない。本文に問い合わせ文が1回だけあることを前提に、16種類の全文期待で位置と1回を確かめる。

保存済みの `subject/body_text` は作り直さない。新URLを用意するのは新本文だけ。URLが作れない時は現行の composer の材料不足（`source_missing`）に入り、配送3種類は transient、ほかは permanent という既存の分類を保つ。DB失敗は `db_unavailable/transient`。1通の不足でworker全体を止めない。

### Task 1: 移行 A（リンクと本人の確認）

**Files:**

- Create: `supabase/migrations/20261023100000_order_status_links.sql`
- Create: `tests/integration/db/order_status_links.integration.test.ts`
- Create: `tests/integration/db/order_status_postgrest.integration.test.ts`
- Create: `tests/integration/db/helpers/order-status-fixtures.ts`

**Interfaces:**

- Consumes: C-0/C-1のA、既存 `complete_order_email(uuid,uuid,text):boolean`（元の全文は `20261009095633_order_email_outbox.sql:354-392`）、`private.order_line_fulfillment(uuid)`、E-4の3移行、`describeLocalDb`・`connectLocalDb`・`PgClient`、既存 `helpers/order-fixtures.ts`。
- Produces: C-0の1表とC-1のAの7関数（private2・新public4・置換public1）。試験用 `createOrderStatusFixture(db:PgClient,input?:{status?:OrderStatus;phone?:string|null;customerId?:string|null}):Promise<{orderId:string;orderItemId:string}>`、`setOrderStatusLinkState(db:PgClient,input:{orderId:string;verifyUntil:string|null;failedAttempts:number}):Promise<void>`。後者は試験用postgres接続でだけ使用。

- [x] **Step 1: DB の記録・守り・比較・公開材料の落ちる試験を書く**

1接続の試験はBEGIN/ROLLBACK、拒否の後はSAVEPOINTへ戻す。2接続の試験は確定した合成注文を使い、両接続をfinallyで閉じる。接続不可やskipをREDに数えない。

```ts
test('32バイトから43文字のリンクを作り同時に呼んでも1注文1本');
expect(tokens.every(value=>/^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
expect(new Set(tokens).size).toBe(1);
expect(linkCount).toBe(1);
test('電話の書き方をそろえ4桁を固定回数で比べる');
expect(normalized).toEqual(['5678','5678','5678','5678',null,null]);
expect(compareResults).toEqual([true,false,false,false,false]);
test('間違いだけ加算し20回目はmismatchで次はlocked');
expect(outcomes).toEqual(['ok','mismatch','mismatch','locked']);
expect(counts).toEqual([18,19,20,20]);
test('同時の間違いでも失敗数が20を超えない');
expect(finalFailedAttempts).toBe(20);
expect(outcomeCounts).toEqual({mismatch:1,locked:1});
test('期限NULLと過去と同時刻はexpired、短い電話はunavailable');
expect(results).toEqual(['expired','expired','expired','unavailable']);
test('16種類だけが送信成功で期限を進める');
expect(customerAdvances).toHaveLength(16);
expect(shopAdvances).toBe(0);
expect(failedOrSkippedAdvances).toBe(0);
test('2接続の送信完了でも期限を戻さない');
expect(verifyUntil).toBe(laterSentAtPlus21Days);
test('同じ取引時刻の完了は失敗数を再び消さない');
expect(failedAfterSecondComplete).toBe(3);
test('リンク無しの旧本文も種類で期限を更新する');
expect(withExistingLink.verifyUntil).toBe(sentAtPlus21Days);
expect(withoutLink.linkCount).toBe(0);
test('leaseの不一致と重複完了は期限もpauseも変えない');
expect(completed).toEqual([false,false]);
expect(stateAfter).toEqual(stateBefore);
test('公開材料のDBの答えに個人情報と番号のキーが無い');
expect(forbiddenKeys).toEqual([]);
expect(privateSentinelFound).toBe(false);
test('RLSとRESTRICTIVE拒否、SELECTだけ、EXECUTEはservice_roleだけ');
expect(rlsAndPolicy).toEqual({enabled:true,restrictive:true,using:'false',withCheck:'false'});
expect(deniedSqlStates.every(code=>code==='42501')).toBe(true);
```

電話のfixtureは `+81 (90) 1234-5678`、`090-1234-5678`、`０９０ １２３４ ５６７８`、`（０９０）１２３４－５６７８`、NULL、`１２３`。比較は一致、先頭/途中/末尾の不一致、長さ違い。時間の測定で合否を決めず、固定4回・途中RETURN無しもSQL本文で確認する。

さらに token形のCHECK23514、重複token23505、注文FK23503、失敗数-1/21の23514、初期NULL/0、0行の3種類、cancelledの可視、正解でカウンター非リセット、期限が進む時だけ0、進まない未来の期限の保持、送信pauseの再開を試す。`complete_order_email` の送った時刻と21日後の差をDB内で比較する。PostgRESTは手元のservice_roleで各新RPCの引数と返り方を確認し、anon/authenticatedのexecuteと表への直接操作を拒む。

- [x] **Step 2: controller が前提と RED を確かめる**

最初に手元catalogの `pg_extension`・`pg_namespace`・`to_regprocedure('extensions.gen_random_bytes(integer)')` を読み、schema名と関数の有無だけ控える。別schemaに既にある場合はX2として止め、配置変更を実装者に判断させない。まだpgcryptoが無ければP26で作る前提を確認する。

Run: Task 11の手元DB環境で `npx.cmd jest tests/integration/db/order_status_links.integration.test.ts tests/integration/db/order_status_postgrest.integration.test.ts --runInBand`。
Expected: FAIL（表とRPCが無い）。実測の失敗数を記録。PostgRESTの接続設定無しによるskipは別記する。

- [x] **Step 3: C-0/C-1 A の署名と指定値を実装する**

P26の拡張前提 → 表/制約/守り → privateの抽出/比較 → 新public4関数 → completeの置換 → revoke/grant → NOTIFY の順。`ensure` は挿入後に別のSELECTで保存値を読む。tokenの一意衝突だけは新しい乱数で最大3回試し、なお衝突なら固定の `ORDER_STATUS_TOKEN_COLLISION`（SQLSTATE23505）で止める。注文ごとの競合はトークン衝突として数えない。

`verify` はリンク行をFOR UPDATEした後に現在の注文状態と電話を確かめ、P19順に答える。トークンの期限は延長する以外の書き換えを作らず、既存注文への一括INSERTは書かない。公開材料はC-1の選択列だけ。配送の内部RPCを呼んでからJSONのキーを消す代用はしない。

- [x] **Step 4: controller が GREEN を確かめる**

Run: `npx.cmd supabase db reset --local` → 同じ2スイートと `tests/integration/db/order_email_outbox.integration.test.ts` を `--runInBand` → `npx.cmd tsc --noEmit --incremental false`。
Expected: PASS、skip0、型の誤り0。SQLの `AS $$` と `$$;`、UTF-8/LF/末尾改行、関数と権限の漏れ0を確認する。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- supabase/migrations/20261023100000_order_status_links.sql tests/integration/db/order_status_links.integration.test.ts tests/integration/db/order_status_postgrest.integration.test.ts tests/integration/db/helpers/order-status-fixtures.ts
git commit -m "feat: 注文状況のリンクと本人確認を追加"
```

### Task 2: 移行 B（返品の読み出しの共通化）

**Files:**

- Create: `supabase/migrations/20261023100100_order_status_returns.sql`
- Create: `tests/integration/db/order_status_returns.integration.test.ts`
- Modify: `tests/integration/db/helpers/order-status-fixtures.ts`
- Modify: `tests/integration/db/order_status_postgrest.integration.test.ts`

**Interfaces:**

- Consumes: Task 1、既存 `public.get_customer_order_returns(uuid,uuid):jsonb`（`20261020144842_order_return_customer_requests.sql:1079-1286`）、`private.customer_order_for_request(uuid,uuid,boolean):public.orders`、`private.customer_return_availability(public.orders)`。
- Produces: C-1 B の3関数。試験用 `installLegacyCustomerReturns(db:PgClient):Promise<void>` は元移行の当該CREATE文だけを読み、名前だけ `pg_temp.customer_returns_before` へ替えて同じ取引内に作る。関数本体の写しを新しい見本ファイルへ固定しない。

- [x] **Step 1: 旧関数との答えの一致と公開の分離の試験を書く**

```ts
test('既存の持ち主用RPCは元のSQLのJSONと完全に一致する');
expect(after).toEqual(before);
test('持ち主以外とNULLと隠す状態の誤りも変わらない');
expect(refusals).toEqual(Array(5).fill({code:'P0002',message:'ORDER_NOT_FOUND'}));
test('注文番号で読むtrueは元の持ち主用と同じでゲストも読める');
expect(byIdPrivate).toEqual(before);
expect(guestPrivate).not.toBeNull();
test('注文番号で読むfalseと省略は返送先と送り返し番号を取得しない');
expect(publicWithFalse).toEqual(publicWithDefault);
expect(forbiddenKeys).toEqual([]);
test('取り消した返品と内部の情報を混ぜず既存の並びとnullを保つ');
expect(returnNumbers).toEqual([3,2,1]);
expect(cancelRequestIds).toEqual(expectedNewestFirstIds);
expect(internalKeys).toEqual([]);
test('新RPCもservice_role以外は呼べず芯は直接呼べない');
expect(deniedCodes.every(code=>code==='42501')).toBe(true);
```

合成fixtureは requested/open/closed/declined/cancelled、交換希望/確定交換、部分受取、検品待ち、費用待ち、返金待ち、返金済み、返送先設定あり/なし、送り返しの番号あり/なし、キャンセル4状態を作る。旧関数と新関数を同じ取引時刻・同じ設定・同じ行で比較し、期限を含め全キーとnullを比べる。古い関数を「無い時NULL」と思い込まず、実際のP0002を比較する。

- [x] **Step 2: controller が RED を確かめる**

Run: `npx.cmd jest tests/integration/db/order_status_returns.integration.test.ts --runInBand`（Task 11の手元環境）。
Expected: 新RPC未定義でFAIL。旧関数の基準との比較自体は通ることを先に確かめる。

- [x] **Step 3: C-1 B の3つの署名を実装する**

元のJSONを組む部分をprivateの芯へ移す。既存公開関数の入口の所有者・隠す状態の確かめと例外は一字も変えない。`_order_id` で参照していた箇所は芯の `_order.id` へ機械的にそろえる。trueのJSON式の変更はそれだけ。

新しい公開関数は注文の `id,status` だけを名指しして `_order public.orders` の同じフィールドへ入れる。公開falseのために電話・住所を読む必要は無い。`_include_private IS NULL` は `ORDER_STATUS_ARGUMENT_INVALID/22023`。falseのJSONでは `return_address` と sent_backの `carrier/tracking_number` のキーを作らず、その値を読むSELECTをfalse時に実行しない。お店のメモや理由の記号は元から足さない。

- [x] **Step 4: controller が GREEN と既存DB試験を確かめる**

Run: reset → `npx.cmd jest tests/integration/db/order_status_returns.integration.test.ts tests/integration/db/order_status_postgrest.integration.test.ts tests/integration/db/order_return_customer_requests.integration.test.ts --runInBand` → 型。
Expected: PASS、skip0、元の答えとの差0、旧RPCの権限・誤りの差0。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- supabase/migrations/20261023100100_order_status_returns.sql tests/integration/db/order_status_returns.integration.test.ts tests/integration/db/order_status_postgrest.integration.test.ts tests/integration/db/helpers/order-status-fixtures.ts
git commit -m "refactor: 返品の読み出しを共通化し注文状況用を追加"
```

### Task 3: 見せる物の組み立てを共通にする

**Files:**

- Create: `src/lib/orders/customer-order-view-types.ts`
- Create: `src/lib/orders/customer-order-view.ts`
- Create: `tests/unit/lib/orders/customer-order-view.test.ts`
- Modify: `src/app/api/orders/[id]/route.ts`
- Modify: `tests/unit/api/orders/order-detail-progress.test.ts`
- Modify: `tests/integration/api/orders.test.ts`

**Interfaces:**

- Consumes: 現行会員APIのJSON・ローカル型・`toShipments/toCustomerDelivery/toCustomerRefunds`、`deriveOrderProgress/buildOrderProgressSteps`、`mapPaymentMethodLabel`、`signItemImageUrl`、既存store群。
- Produces: C-2 表示の全型と `buildCustomerOrderPublicView`・`buildCustomerOrderPrivateView`・`buildCustomerOrderDetailView` の3署名。後続はAPIのexportしていない関数をimportしない。

- [x] **Step 1: 会員の答えを固定し、公開の型の試験を書く**

先に既存会員fixtureのJSON全文期待を現状で通して保存する。画像署名は固定文字列のmockにし、署名の実値を記録しない。

```ts
test('会員のJSONは共通化の前後で文字列として同じ');
expect(JSON.stringify(actual)).toBe(expectedJsonBeforeRefactor);
test('公開型と公開の答えに個人情報のキーを持たない');
expect(recursiveForbiddenKeys).toEqual([]);
// @ts-expect-error 公開型にこのキーは存在しない
publicView.paymentMethod;
test('配送の現版だけを出し取消と登録前と鍵無しを隠す');
expect(events).toEqual(expectedCurrentVersionEvents);
expect(noKeyShipment).not.toHaveProperty('delivery');
test('返金は手続き中と済みだけを古い順に出し段の数も保つ');
expect(publicRefunds.map(row=>row.status)).toEqual(['processing','completed']);
expect(publicRefunds[0]).not.toHaveProperty('customerActionDeadline');
expect(memberRefunds[0].customerActionDeadline).toBe('10月25日');
test('個人情報の組み立ては指定の6種類の情報だけ返す');
expect(Object.keys(privateView)).toEqual(['shipping','contactEmail','paymentMethod','shipments','returns']);
```

追加する境界は、NULL画像/unknown carrier/番号無し、交換の0円、全部返金の手続き中、在庫と受注生産の段、割引0と正数、無効な日時、空住所、未知の支払方法、返品だけの失敗。会員APIの認証失敗・404・配送/返金500・返品失敗だけnullが現状どおりであることも既存試験で固定する。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/lib/orders/customer-order-view.test.ts tests/unit/api/orders/order-detail-progress.test.ts --runInBand`。
Expected: 新しい表示関数の未定義でFAIL。既存JSONの基準試験は共通化前にPASS。実測を分けて記録する。

- [x] **Step 3: C-2 の型と3署名を実装し、API の組み立てだけを移す**

読む順・認証・所有者フィルタ・service_roleを作る時点は動かさない。API末尾のキー順も含めて `buildCustomerOrderDetailView` で復元する。共通の配送/返金/進み具合の計算を1か所へ移し、公開版では個人情報の入力を必要にしない。member wrapperは既存の口座期限と返品全項目を戻す。新しい公開型のために会員ページの表示を変更しない。

- [x] **Step 4: GREEN と既存の API の試験を確かめる**

Run: Step 2の2スイート → `npx.cmd jest tests/integration/api/orders.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx --runInBand` → 型。
Expected: PASS、会員JSONの文字列差0、型の誤り0。これはmockによるAPI/単体の証拠でありDBや画面の実行結果とは区別する。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- src/lib/orders/customer-order-view-types.ts src/lib/orders/customer-order-view.ts "src/app/api/orders/[id]/route.ts" tests/unit/lib/orders/customer-order-view.test.ts tests/unit/api/orders/order-detail-progress.test.ts tests/integration/api/orders.test.ts
git commit -m "refactor: 注文の表示を共有し会員の返却値を維持"
```

### Task 4: トークン・下4桁・確認印・store の土台

**Files:**

- Create: `src/lib/orders/status/status-types.ts`
- Create: `src/lib/orders/status/status-token.ts`
- Create: `src/lib/orders/status/status-phone.ts`
- Create: `src/lib/orders/status/status-session.ts`
- Create: `src/lib/orders/status/status-store.ts`
- Create: `src/lib/orders/status/status-messages.ts`
- Create: `tests/unit/lib/orders/status/status-token.test.ts`
- Create: `tests/unit/lib/orders/status/status-phone.test.ts`
- Create: `tests/unit/lib/orders/status/status-session.test.ts`
- Create: `tests/unit/lib/orders/status/status-store.test.ts`
- Modify: `src/lib/orders/returns/customer-return-store.ts`
- Modify: `tests/unit/lib/orders/returns/customer-return-store.test.ts`

**Interfaces:**

- Consumes: C-1のRPC名と引数、C-2表示型、既存 `customer-return-store.ts` の変換、`login-2fa-session.ts` の署名と検証のパターン。実際の2FA用関数は呼ばない。
- Produces: C-2 土台の全署名と型、C-4/C-5の固定文。`loadOrderStatusPrivateInput` は認可を内包しないので、後続はTask 5の認可後だけ呼ぶ。

- [x] **Step 1: 形・期限・取得列・署名の落ちる試験を書く**

```ts
test('トークンは43文字のbase64urlだけを受ける');
expect(validities).toEqual([true,false,false,false,false,false]);
test('入力は数字4桁ちょうどだけ受ける');
expect(inputs.map(parseOrderStatusLastFour)).toEqual(['1234','1234','1234',null,null,null,null]);
test('保存電話は全角をそろえ数字だけの末尾4桁で短い時はnull');
expect(phones.map(extractOrderStatusLastFour)).toEqual(['5678','5678','5678',null,null]);
test('署名とpurposeと注文とトークンと時刻を全て照合する');
expect(validRead?.orderId).toBe(orderId);
expect(invalidReads.every(value=>value===null)).toBe(true);
test('24時間とDB期限の早い方を秒で使い同時刻は失効');
expect(expirations).toEqual([iat+86400,iat+3600]);
expect(atExpiry).toBeNull();
test('専用鍵を優先し無ければJWT_SECRET、両方無ければ発行しない');
expect(keySelectionChecks).toEqual([true,true,true]);
test('公開のstoreは公開材料RPCと返品falseだけを呼ぶ');
expect(publicRpcCalls).toEqual(expectedPublicCalls);
expect(privateSelectCalls).toEqual([]);
test('個人情報のstoreは認可済みの注文だけ名指しの列で読む');
expect(selectedColumns).toEqual(expectedPrivateColumns);
test('壊れたRPCの答えとDB失敗を空の成功にしない');
expect(error.code).toBe('ORDER_STATUS_STORE_FAILED');
expect(error.message.includes(secretSentinel)).toBe(false);
```

入力fixtureは `1234,１２３４,(12) 34,123,12345,空文字,非文字列`。署名の異常はpayload改変・署名改変・違う長さ・不正base64url・違うpurpose・違う注文・違うtoken・未来iat・小数・exp過大・期限NULL・期限短縮・異常JSON・余分なsegment。Cookie属性はpath/strict/httpOnly/secure/maxAge/expires/Domain無しを全て比較する。2注文へ同じCookie値を移しても拒否する。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/lib/orders/status --runInBand`。
Expected: 未定義モジュールでFAIL。新しい試験の件数を記録する。

- [x] **Step 3: C-2 の署名・固定値・変換を実装する**

SQL側の判定結果をTSで電話と比べ直さない。`getOrderStatusLink` は期限・phoneAvailable・数だけから利用可否を作る。公開材料RPCの項目を名指しして厳密に変換する。返品parserは既存変換を共有するが、公開型へ非公開のキーをNULLで生やさない。`loadCustomerOrderReturns` の引数/RPC/例外処理と既存答えは保つ。

`loadOrderStatusPrivateInput` の返送先は返送の案内を出す `accepted/partially_received` の返品だけが後段に残るようにする。発送は取消を除き番号昇順。送り返しは元の配列indexでひも付ける。署名鍵を関数呼び出し時に読み、import時のenv固定をしない。単体の固定時計で境界を確かめる。

- [x] **Step 4: GREEN と既存返品parserを確かめる**

Run: Step 2 → `npx.cmd jest tests/unit/lib/orders/returns/customer-return-store.test.ts --runInBand` → 型。
Expected: PASS、秘密値のログ0、型の誤り0。DBに実在することの証拠はTask 1/2と区別する。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- src/lib/orders/status/status-types.ts src/lib/orders/status/status-token.ts src/lib/orders/status/status-phone.ts src/lib/orders/status/status-session.ts src/lib/orders/status/status-store.ts src/lib/orders/status/status-messages.ts src/lib/orders/returns/customer-return-store.ts tests/unit/lib/orders/status/status-token.test.ts tests/unit/lib/orders/status/status-phone.test.ts tests/unit/lib/orders/status/status-session.test.ts tests/unit/lib/orders/status/status-store.test.ts tests/unit/lib/orders/returns/customer-return-store.test.ts
git commit -m "feat: 注文状況の確認印と読み出しの土台を追加"
```

### Task 5: 確認と個人情報の窓口

**Files:**

- Create: `src/app/api/order-status/[token]/verify/route.ts`
- Create: `src/app/api/order-status/[token]/private/route.ts`
- Create: `tests/unit/api/order-status/verify.test.ts`
- Create: `tests/unit/api/order-status/private.test.ts`
- Modify: `src/proxy.ts`
- Modify: `tests/unit/middleware/proxy-origin.test.ts`

**Interfaces:**

- Consumes: Task 4のstore/session、`denyIfCsrfInvalid():Promise<NextResponse|null>`、`enforceRateLimit({request,endpoint,limit,windowSeconds,subject?}):Promise<Response|undefined>`、`extractAuthToken(request)`、`authenticateRequest(request)`、Task 3 `buildCustomerOrderPrivateView`。
- Produces: C-3 の2署名と答え。ブラウザはC-4のcodeを用い、HTTPステータスだけでmismatchと期限切れを混同しない。

- [x] **Step 1: 守りの順と返却の落ちる試験を書く**

```ts
test('verifyはCSRFからIP、存在、注文枠、入力、DB比較の順');
expect(calls).toEqual(['csrf','ip:30/600','link','order:5/900','parse','verify']);
test('存在しないトークンはIP枠だけ数えて404');
expect(response.status).toBe(404);
expect(orderLimitCalls).toHaveLength(0);
test('成功だけに期限の早い方の確認Cookieを発行する');
expect(response.status).toBe(200);
expect(cookieNames).toEqual(['sb-order-status']);
test('20回目の不一致は欄を止め、429は合計に数えない');
expect(twentieth.body).toMatchObject({code:'ORDER_STATUS_MISMATCH',verifiable:false,reason:'locked'});
expect(verifyCallsAfter429).toBe(0);
test('ログイン印の無いゲストは200のnoneで認証を呼ばない');
expect(body).toEqual({access:'none',verifiable:true,reason:null});
expect(authenticateRequest).not.toHaveBeenCalled();
test('別の会員は200のnone、印があればverified');
expect(accesses).toEqual(['none','verified']);
test('古いログイン印だけとrefreshだけは401、認証不能は503');
expect(statuses).toEqual([401,401,503]);
test('有効な印があれば古いログイン印で401にしない');
expect(access).toBe('verified');
test('DBの期限と印の期限を毎回照合する');
expect(expiredStampAccess).toBe('none');
expect(ownerAfterDeadlineAccess).toBe('member');
test('認可前に個人情報のselectと完全な返品を呼ばない');
expect(privateCallsBeforeGrant).toEqual([]);
test('全ての成功と拒否と例外でno-store');
expect(cacheControls.every(value=>value==='no-store')).toBe(true);
```

Origin保護はproxyを直接試し、許可元・別の元・Origin/Referer両方無し・Referer退避を既存の条件どおり確認する。新APIのOrigin403にもno-store/no-referrer、他APIの403は前と同じであることを追加する。CSRF拒否・IP超過・注文超過・入力不正の後はDB比較0回、auth unavailable503でrefreshを誘わないこと、GET404の3種類同文、完全なP9の答え、ログが固定codeのみ、署名鍵無しの500も試す。制限のsubjectはlinkのUUIDでありtokenでないことをmockの引数で確認する。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/api/order-status tests/unit/middleware/proxy-origin.test.ts --runInBand`。
Expected: 新Handler未定義でFAIL。既存proxyの拒否の試験はPASS。

- [x] **Step 3: C-3 の Handler 2本を実装する**

`await context.params`、Node runtime、no-storeの全経路を守る。verifyはログインを必須にせずP20順。CSRF/制限の既存Responseは新しいJSONへ写し、Retry-Afterを保持する。GETはP25のOR認可。ログインの持ち込み有無は未検証claimsから判断しない。会員が持ち主ならCookieの期限に関係なくmember。noneにdataの空オブジェクトや電話の有無以外の情報を足さない。

proxyは既存 `matchesPathSegment(request.nextUrl.pathname,'/api/order-status')` で新APIの配下を見分け、Origin拒否のJSONにP31の2ヘッダーだけを足す。検査順・許可リスト・除外ルートは変えない。

- [x] **Step 4: GREEN と守りの既存試験を確かめる**

Run: Step 2 → `npx.cmd jest tests/unit/lib/client-fetch.test.ts tests/unit/lib/csrf.middleware.test.ts --runInBand` → 型。
Expected: PASS、ログイン共通処理への変更0、型の誤り0。Originはproxy、CSRFは既存helperの意味を保つ。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- "src/app/api/order-status/[token]/verify/route.ts" "src/app/api/order-status/[token]/private/route.ts" src/proxy.ts tests/unit/api/order-status/verify.test.ts tests/unit/api/order-status/private.test.ts tests/unit/middleware/proxy-origin.test.ts
git commit -m "feat: 注文状況の本人確認と個人情報の窓口を追加"
```

### Task 6: 公開のページと個人情報・確認の欄

**Files:**

- Create: `src/app/order-status/[token]/page.tsx`
- Create: `src/app/order-status/[token]/not-found.tsx`
- Create: `src/app/order-status/[token]/error.tsx`
- Create: `src/features/order-status/components/OrderStatusPublic.tsx`
- Create: `src/features/order-status/components/OrderStatusAccess.tsx`
- Create: `src/features/order-status/components/OrderStatusVerifyForm.tsx`
- Create: `src/features/order-status/components/OrderStatusPrivate.tsx`
- Create: `src/features/order-status/components/OrderStatusGuidance.tsx`
- Create: `src/features/order-status/status-client.ts`
- Modify: `src/features/account/components/OrderItemRow.tsx`
- Modify: `src/features/account/returns/OrderReturnsSection.tsx`
- Create: `tests/unit/components/OrderStatusPage.test.tsx`
- Create: `tests/unit/features/order-status/OrderStatusPublic.test.tsx`
- Create: `tests/unit/features/order-status/OrderStatusAccess.test.tsx`
- Create: `tests/unit/features/order-status/OrderStatusVerifyForm.test.tsx`
- Create: `tests/unit/features/order-status/OrderStatusPrivate.test.tsx`
- Create: `tests/unit/features/order-status/OrderStatusGuidance.test.tsx`
- Create: `tests/unit/features/order-status/status-client.test.tsx`
- Modify: `tests/unit/components/OrderItemRow.test.tsx`
- Modify: `tests/unit/features/account/returns/OrderReturnsSection.test.tsx`

**Interfaces:**

- Consumes: C-2の型と3表示関数、Task 4の公開storeと文、Task 5のC-3、`useLogin()` の `isLoggedIn/isAuthResolved`、`SESSION_EXPIRED_EVENT`、`getCsrfTokenFromCookie`、既存 `OrderItemRow/OrderReturnsSection`、共有Button/LiveMessage/TextField。
- Produces: 下表の署名。個人情報をServer Componentのpropsへ渡さない。tokenをpropsへ渡すのは専用APIの住所を作るためだけ。

| ファイル・export | 署名・props |
|---|---|
| `page.tsx` default | `OrderStatusPage({params}:{params:Promise<{token:string}>}):Promise<React.JSX.Element>`、固定 `metadata:Metadata` |
| `not-found.tsx` default | `OrderStatusNotFound():React.JSX.Element` |
| `error.tsx` default | `OrderStatusError({reset}:{error:Error & {digest?:string};reset:()=>void}):React.JSX.Element`。errorのmessage/digestを表示もログ出力もしない |
| `OrderStatusPublic` | `({view}:{view:CustomerOrderPublicView}):React.JSX.Element` |
| `OrderStatusAccess` | `({token,orderId,orderNumber,publicReturns}:{token:string;orderId:string;orderNumber:string;publicReturns:readonly PublicCustomerOrderReturn[]}):React.JSX.Element` |
| `OrderStatusVerifyForm` | `({token,onVerified,onUnavailable}:{token:string;onVerified:(expiresAt:string)=>void;onUnavailable:(value:OrderStatusVerification)=>void}):React.JSX.Element` |
| `OrderStatusPrivate` | `({data,publicReturns}:{data:CustomerOrderPrivateView;publicReturns:readonly PublicCustomerOrderReturn[]}):React.JSX.Element` |
| `OrderStatusGuidance` | `({access,orderId,orderNumber}:{access:'none'|'verified'|'member';orderId:string;orderNumber:string}):React.JSX.Element` |
| 既存 `OrderItemRow` | 操作ありの既存propsと、`{item:OrderLineItem;readOnly:true;isReordering?:never;onReorder?:never}` のunion。省略時の動作は同じ |
| 既存 `OrderReturnsSection` | 操作ありの既存propsに `readOnly?:false` を足す枝と、`{orderId:string;section:PublicCustomerOrderReturns;readOnly:true;cancelLines?:never;onChanged?:never}` のunion |
| 同ファイル `OrderReturnPrivateDetails` | `({orderReturn,details}:{orderReturn:PublicCustomerOrderReturn;details:OrderStatusPrivateReturn}):React.JSX.Element|null`。既存HowToReturnの文と条件、送り返しの番号の表示を共有する |

- [x] **Step 1: 公開の範囲と状態の変化の部品試験を書く**

```tsx
test('ページはconnectionの後で公開材料を読み個人情報を呼ばない');
expect(calls).toEqual(['connection','link','publicMaterial','publicReturns','publicView']);
expect(privateLoader).not.toHaveBeenCalled();
test('形違いと無い注文と隠す状態は同じnotFound');
expect(notFoundCalls).toBe(3);
test('公開欄には進み具合と商品と金額を出し個人情報の文字が無い');
expect(screen.getByRole('heading',{name:'ご注文の状況'})).toBeVisible();
expect(privateSentinelPresent).toBe(false);
test('readOnlyの共用部品は申し込みと購入の操作を出さない');
expect(screen.queryByRole('button',{name:'キャンセルを申し込む'})).not.toBeInTheDocument();
expect(screen.queryByRole('link',{name:'返品・交換を申し込む'})).not.toBeInTheDocument();
expect(screen.queryByRole('button',{name:'再度購入'})).not.toBeInTheDocument();
test('GETのnoneは確認欄、memberとverifiedは指定の個人情報だけ');
expect(renderedAccesses).toEqual(['form','private-member','private-verified']);
test('期限と未ログインへの変化で個人情報を捨てる');
expect(privateSentinelAfterExpiry).toBe(false);
expect(publicOrderStillVisible).toBe(true);
test('古い読取の返事が後から届いても個人情報を戻さない');
expect(accessAfterLateResponse).toBe('none');
test('確認POSTはCSRFを付けるがrefreshも自動再送もしない');
expect(postCount).toBe(1);
expect(refreshCalls).toBe(0);
test('店の文章はHTMLとして実行せず文字として表示する');
expect(injectedElementExists).toBe(false);
expect(literalMessageVisible).toBe(true);
```

ほかに、C-5の全ラベル、公開返品の全8状態、キャンセル4状態、登録と問い合わせのhref、持ち主だけの会員注文リンク、返送先の状態条件、番号無しは行を出さない、入力全角/3桁/5桁/二重押し、mismatch/locked/expired/429/500/503/通信失敗、Retry後の復帰、401後の公開維持と無限再読込無しを試す。Jestのfake timersで24時間の境界を進め、実際に待たない。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/components/OrderStatusPage.test.tsx tests/unit/features/order-status tests/unit/components/OrderItemRow.test.tsx tests/unit/features/account/returns/OrderReturnsSection.test.tsx --runInBand`。
Expected: 新しい頁・部品未定義でFAIL。既存の操作ありの試験は現状でPASS。

- [x] **Step 3: 上表の署名と C-5 の画面を実装する**

ページは `await params` → token形検査 → `await connection()` → service_role作成 → link/公開材料/公開返品 → 公開組み立て → JSX。形違いはDB無しでnotFound、NULLの公開材料もnotFound。返品だけの失敗はnullで続け、それ以外は固定codeだけを記録して固定エラーへ送る。公開propsへlinkを丸ごと渡さない。

表示順は、h1・番号/日付 → 進み具合と段 → 発送ごとの状況/移り変わり/品 → 未発送の2区分 → ご注文商品 → ご返金 → 返品・キャンセルの記録 → 支払金額 → 個人情報または確認欄 → 返品・キャンセルの案内。幅は `max-w-6xl mx-auto px-4 sm:px-6`、390では1列、768以上は金額欄と主欄を分けてよい。長い値に `min-w-0 break-words`。会員と同じ account系の既存classを使い、共有CSSの変更は不要。

Accessは認証状態の確定後に初回GETし、その後 `isLoggedIn` の変化・`SESSION_EXPIRED_EVENT`・画面へ戻った時（visibilityがvisible）・verifiedの `expiresAt` 到達で読み直す。認可が失われた通知では直ちに個人情報を捨てる。要求ごとの世代番号とAbortControllerで古い返事を捨て、unmount時はtimer/購読を外す。401最終応答はそのverifiable/reasonを使って公開のまま案内し、自分でrefreshのループを足さない。ログイン状態を画面で認可の根拠にしない。

VerifyFormは label関連付け、`type='text' inputMode='numeric' autoComplete='off'`、`aria-describedby`、エラーはLiveMessage、送信中disable。`maxLength=64` とし、全角を入力の段階で切り捨てない。入力内容をURL/state保存/consoleへ出さない。成功したら入力を消し、親がGETをやり直す。20回目のmismatchの `reason='locked'` はフォームを外し、ロック文を出す。

公開の返品欄はreadOnly。送り返しの品と店の文はそこに出し、返送先/番号は `OrderReturnPrivateDetails` を個人情報欄から呼ぶ。新しい操作の枝は作らない。guest/verifiedの案内は2つの道、memberは会員の注文リンクだけ。新しい404とerrorにもC-5の固定文以外を出さない。

- [x] **Step 4: GREEN と共有部品の既存試験を確かめる**

Run: Step 2 → `npx.cmd jest tests/unit/components/AccountOrderDetailPage.test.tsx --runInBand` → 型 → `npm.cmd run lint`。
Expected: PASS、型/lintの新しい誤り0。3画面幅の実寸と本当のCookieの運搬はTask 9まで未検証。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- "src/app/order-status/[token]/page.tsx" "src/app/order-status/[token]/not-found.tsx" "src/app/order-status/[token]/error.tsx" src/features/order-status/components/OrderStatusPublic.tsx src/features/order-status/components/OrderStatusAccess.tsx src/features/order-status/components/OrderStatusVerifyForm.tsx src/features/order-status/components/OrderStatusPrivate.tsx src/features/order-status/components/OrderStatusGuidance.tsx src/features/order-status/status-client.ts src/features/account/components/OrderItemRow.tsx src/features/account/returns/OrderReturnsSection.tsx tests/unit/components/OrderStatusPage.test.tsx tests/unit/features/order-status/OrderStatusPublic.test.tsx tests/unit/features/order-status/OrderStatusAccess.test.tsx tests/unit/features/order-status/OrderStatusVerifyForm.test.tsx tests/unit/features/order-status/OrderStatusPrivate.test.tsx tests/unit/features/order-status/OrderStatusGuidance.test.tsx tests/unit/features/order-status/status-client.test.tsx tests/unit/components/OrderItemRow.test.tsx tests/unit/features/account/returns/OrderReturnsSection.test.tsx
git commit -m "feat: 注文状況のページと確認の欄を追加"
```

### Task 7: お客様向けメールのリンクと電話番号

**Files:**

- Create: `src/lib/orders/status/status-email.ts`
- Create: `tests/unit/lib/orders/status/status-email.test.ts`
- Modify: `src/lib/orders/email/order-email-compose.ts`
- Modify: `src/lib/orders/email/order-email-worker.ts`
- Modify: `tests/unit/lib/orders/email/order-email-compose.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-compose-returns.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-compose-requests.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-compose-delivery.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-worker.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-worker-recipient.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-worker-requests.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-worker-delivery.test.ts`

**Interfaces:**

- Consumes: `ensureOrderStatusLink(store,orderId):Promise<string>`、`getSiteUrl()`、`isShopEmailKind(kind)`、既存 `OrderEmailMaterial/OrderEmailWorkerDeps`、保存済みsubject/bodyの優先と `order-email/{claim.id}` の重複防止キー。
- Produces: C-2 `loadOrderStatusEmailUrl`、任意の材料 `orderStatusUrl?:string|null`、必須のdeps `loadStatusUrl`、C-6の全文。loadOrderEmailMaterial/loadRequestEmailMaterial/loadDeliveryEmailMaterialの既存引数は変えない。

- [x] **Step 1: 16種類と全書き分け、旧本文の試験を先に書く**

```ts
test.each(CUSTOMER_STATUS_MAIL_KINDS)('%sのリンクはお問い合わせ文の直前に1回だけ');
expect(text.split(statusLine).length-1).toBe(1);
expect(text.includes(`${statusLine}\n${contactLine}`)).toBe(true);
test.each(['paid','awaiting_payment'])('%sにお客様の電話が無く住所と名前は残る');
expect(text.includes(customerPhone)).toBe(false);
expect(text.includes(customerAddress)).toBe(true);
test('deliveredの会員用リンクを消しほかの配達済みの文を保つ');
expect(text.includes('/account/orders/')).toBe(false);
expect(text.includes('ご注文の確認はこちら:')).toBe(false);
test('店向け3種類はリンクを用意せず本文も変えない');
expect(loadStatusUrl).not.toHaveBeenCalled();
expect(actualShopText).toBe(previousShopText);
test('返送先のお店の電話は消さない');
expect(text.includes(shopReturnPhone)).toBe(true);
test('保存済み本文ではリンクを用意せずそのまま送る');
expect(loadStatusUrl).not.toHaveBeenCalled();
expect(sentText).toBe(savedOldText);
test('住所を作れない時は材料不足で次のメールを続ける');
expect(failures[0].code).toBe('source_missing');
expect(result.sent).toBe(1);
test('リンク準備のDB失敗はdb_unavailableとして再試行する');
expect(failure).toMatchObject({code:'db_unavailable',category:'transient'});
```

`CUSTOMER_STATUS_MAIL_KINDS` は試験内でC-6の16種類を明示して定義し、実装側の判定だけを正にしない。paid通常/期限後、canceledの3書き分け、refundの3書き分け、return_acceptedの返送方法3通り、deliveredの返品日数あり/無制限を既存全文期待で確認する。URL無しは全16種類null、店向けはURL無しでも既存どおり。合成の電話値以外を失敗時のdiffへ出さない。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/lib/orders/email/order-email-compose tests/unit/lib/orders/status/status-email.test.ts --runInBand`。
Expected: 旧本文のため新しいリンク/電話削除の期待でFAIL。単にfixtureのURLが無いことによるnullだけをREDの根拠にしない。

- [x] **Step 3: C-6 の行と材料の準備の署名を実装する**

workerは既存の材料loader → 既存の取りやめ判定 → 保存済み本文の有無 → 新しいお客様向けなら `loadStatusUrl(claim.orderId)` → compose/save/send の順。送信対象でない注文・店向け・保存済み本文のためにリンクを作らない。depsの本番実装は既存service_role clientを共有する。URL設定の失敗nullとDB失敗throwを分ける。

composerは全16種類の既存本文を作ってから共通の末尾へ1行を追加する形にそろえてよいが、deliveredの旧リンクと電話以外の行・空行は変えない。共通化の前提として問い合わせ文が1回であることを全種類で確かめる。URLはhelperから得たhttp/httpsの絶対URLだけを使う。材料のURLを `getSiteUrl()` とトークン以外の入力から作らない。

- [x] **Step 4: GREEN と全メール単体を確かめる**

Run: `npx.cmd jest tests/unit/lib/orders/email tests/unit/lib/orders/status/status-email.test.ts --runInBand` → 型。
Expected: PASS。新depsを作る4つのworker試験の全harnessへ固定の `loadStatusUrl` を足す。実メール送信の証拠はTask 9のMailpitまで未確認。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- src/lib/orders/status/status-email.ts src/lib/orders/email/order-email-compose.ts src/lib/orders/email/order-email-worker.ts tests/unit/lib/orders/status/status-email.test.ts tests/unit/lib/orders/email/order-email-compose.test.ts tests/unit/lib/orders/email/order-email-compose-returns.test.ts tests/unit/lib/orders/email/order-email-compose-requests.test.ts tests/unit/lib/orders/email/order-email-compose-delivery.test.ts tests/unit/lib/orders/email/order-email-worker.test.ts tests/unit/lib/orders/email/order-email-worker-recipient.test.ts tests/unit/lib/orders/email/order-email-worker-requests.test.ts tests/unit/lib/orders/email/order-email-worker-delivery.test.ts
git commit -m "feat: 注文メールに状況のリンクを追加し電話を削除"
```

### Task 8: お問い合わせを入力済みで開く

**Files:**

- Create: `src/features/contact/contact-prefill.ts`
- Create: `tests/unit/features/contact/contact-prefill.test.ts`
- Create: `tests/unit/components/ContactPage.test.tsx`
- Modify: `src/app/contact/page.tsx`

**Interfaces:**

- Consumes: P13/P23、既存フォームの `inquiryType/orderNumber` のstateと値 `product/order/other`、現行送信API。
- Produces: C-2 `ContactPrefill` と `parseContactPrefill(search:string):ContactPrefill`。変更するstateは2つだけ。件名・氏名・メール・本文をURLから埋めない。

- [x] **Step 1: 値の検証と編集を守る試験を書く**

```tsx
test('種別と小文字の注文番号を受け取り大文字で返す');
expect(parseContactPrefill('?type=order&order=ord-a1b2c3d4')).toEqual({inquiryType:'order',orderNumber:'ORD-A1B2C3D4'});
test('許可した種別だけ受け、英数字でもG以降の番号は無視する');
expect(invalids.map(parseContactPrefill)).toEqual([{}, {}, {}, {}]);
test('片方が不正でも正しい方の初期値は残す');
expect(parseContactPrefill('?type=unknown&order=ORD-A1B2C3D4')).toEqual({orderNumber:'ORD-A1B2C3D4'});
test('重複した項目とHTMLらしい値を無視する');
expect(parseContactPrefill('?type=order&type=other&order=%3Cscript%3E')).toEqual({});
test('フォームを入力済みで開き後の編集を上書きしない');
expect(screen.getByLabelText('注文番号（任意）')).toHaveValue('ORD-A1B2C3D4');
expect(numberAfterRerender).toBe('ORD-11112222');
test('URL無しのフォームと送信の本文は従来どおり');
expect(unrelatedFields).toEqual(previousEmptyFields);
expect(submitted.orderNumber).toBe('ORD-11112222');
```

product/other、trim、大文字化、空文字、8桁未満/超過、`ORD-ZZZZZZZZ`、同名のorder重複、queryのsubject・token・emailを無視するケースも固定する。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/features/contact/contact-prefill.test.ts tests/unit/components/ContactPage.test.tsx --runInBand`。
Expected: helper未定義と初期値無しでFAIL。

- [x] **Step 3: parse の署名と mount 時の初期値だけ実装する**

`URLSearchParams` で各キーを `getAll` し、1個の時だけ検証する。typeの大小は変えず小文字3値だけ。orderだけtrim・大文字化。contactのeffectは1回だけとし、現在の欄が空で利用者が触っていない時に値を入れる。送信時の `resolveLinkedOrderId`、メールの照合、入力の最大32文字、既存ラベルを変えない。

- [x] **Step 4: GREEN と既存お問い合わせAPI単体を確かめる**

Run: Step 2 → `npx.cmd jest tests/unit/api/contact/route.test.ts --runInBand` → 型。
Expected: PASS、API変更0、型の誤り0。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- src/features/contact/contact-prefill.ts src/app/contact/page.tsx tests/unit/features/contact/contact-prefill.test.ts tests/unit/components/ContactPage.test.tsx
git commit -m "feat: お問い合わせの種別と注文番号をURLから入力"
```

### Task 9: E2E と既存の見本

**Files:**

- Create: `e2e/order-status-test-utils.ts`
- Create: `e2e/FR-ORDER-001-public-view.spec.ts`
- Create: `e2e/FR-ORDER-002-verify-private.spec.ts`
- Create: `e2e/FR-ORDER-003-verify-limits.spec.ts`
- Create: `e2e/FR-ORDER-004-expiry.spec.ts`
- Create: `e2e/FR-ORDER-005-returns-guidance.spec.ts`
- Create: `e2e/FR-ORDER-006-email-link.spec.ts`
- Create: `e2e/FR-ORDER-007-not-found-security.spec.ts`
- Create: `e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts`
- Create: `e2e/FR-CONTACT-014-order-status-prefill.spec.ts`
- Create: `e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts`
- Modify: `e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts`
- Modify: `e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts`
- Modify: `e2e/order-email-test-utils.ts`
- Modify: `e2e/FR-CHECKOUT-041-confirmation-email-fulfillment.spec.ts`
- Modify: `e2e/FR-CHECKOUT-045-in-stock-line.spec.ts`
- Modify: `scripts/e2e/environment.ts`
- Modify: `tests/unit/scripts/e2e/environment.test.ts`

**Interfaces:**

- Consumes: Task 1〜8、Task 10のAC表（実装順は9が先でも番号はこの表を使う）、既存 `withLocalDb`・`createPaidOrder`・`mailBodies`・`mailsTo`・`runWorkerOnce`、`delivery-tracking-test-utils.ts` の `withDeliveryScenario/loginCustomer/isolateCustomerApiIp/expectNoHorizontalOverflow`。
- Produces: 新10ファイル、各ファイルに390/768/1280の1ケースずつ、計30ケース。既存ファイルのケース数は減らさない。次の道具を `order-status-test-utils.ts` でexportする。

| 署名 | 決まった動き |
|---|---|
| `createOrderStatusScenario(db:PgClient,input:{kind:'public'|'returns'|'delivery';customerId?:string|null;phone?:string|null}):Promise<{orderId:string;orderItemId:string;lastFour:string|null}>` | 合成注文、私用の目印文字列、必要な発送/返品/返金。元からのfixture関数を使う |
| `prepareOrderStatusTestLink(db:PgClient,orderId:string):Promise<string>` | `ensure_order_status_link` で用意し、試験用に期限をDBの今から21日後へ。メールの試験006はこれを呼ばない |
| `setOrderStatusTestState(db:PgClient,input:{orderId:string;verifyUntil?:string|null;failedAttempts?:number}):Promise<void>` | 指定した注文だけを直す。postgres/loopback限定 |
| `expireOrderStatusTestBuckets(db:PgClient,input:{ip:string;orderId:string}):Promise<void>` | 自分のIP枠と注文UUIDのSHA-512のsubject枠だけ、古いbucketへ移す。移す先の自分の古い行だけ先に消し、一意衝突を避ける |
| `setOrderStatusSessionForTest(page:Page,input:{orderId:string;token:string;issuedAt:Date;verifyUntil:Date;tamper?:boolean;keepExpiredTransport?:boolean}):Promise<void>` | 専用のE2E鍵で署名。payloadが期限切れでもCookieが残る試験だけtransport期限を未来へ置く。生の値は記録しない |
| `openOrderStatusPage(page:Page,token:string):Promise<number>` | page.gotoの返却HTTPを返す。失敗はURL入りの元例外を捨て固定文だけでthrow。URLをtest名へ入れない |
| `readOrderStatusUrlFromMail(request:APIRequestContext,email:string):Promise<URL>` | Mailpitのraw本文から該当行を1つ抽出。originはlocalhost:3000、pathは43文字のtokenだけと確かめ、query/hash無し。URLと本文は出力しない |
| 既存道具へ追加 `maskOrderStatusMailLinks(text:string):string` | P30の置換。`mailBodies`はLF化後にこれを通す。新006のraw読取だけ独立させる |

- [x] **Step 1: 30ケースの名前と期待、環境の単体を先に書く**

下表の名前の先頭へviewport名と幅を付け、各specで3幅をforループする。ブラウザプロジェクトを増やしてケース数を倍にしない。

| spec | `test` の名前と必須の期待 | ACコメント |
|---|---|---|
| FR-ORDER-001 | リンクだけで公開の状況を見られ個人情報を読まない。h1・番号・品/数/価格・金額を表示。HTML/RSCとnoneのAPIに個人情報の目印/キー無し。初回private200、refresh要求無し。overflow無し | 498-01、501-04、505-02/04 |
| FR-ORDER-002 | 下4桁の確認で指定の情報だけを見られ同じブラウザで覚える。全角も正解、通常発送/送り返しの番号・返送先・住所/電話/メール/支払方法を表示。Cookie属性、reload、2注文でpath別の印、他注文への付け替え拒否。overflow無し | 499-01/02/03 |
| FR-ORDER-003 | 短い枠と20回の失敗で止まり新しいメール成功で再開する。6回目429、別注文で31回目429、古いbucketへ移動後に再試行可。20回目mismatchで停止、次は423、失敗数20。送信成功で0。overflow無し | 500-02/03 |
| FR-ORDER-004 | 21日と24時間の後は公開を残して個人情報を消す。期限NULL/過去、署名期限切れ/改変、古い印がブラウザに残る場合をDB値と印で作る。期限後に送るPOST410。overflow無し | 499-04、500-04 |
| FR-ORDER-005 | 返品とキャンセルの記録を見せ申し込みは2つの道へ案内する。全状態の記録、HTMLのような店の文は文字、ボタン/フォーム無し、登録tabと注文番号入りcontactへ実際に進む。overflow無し | 498-03、502-02/03、504-04 |
| FR-ORDER-006 | 本物のメールのリンクから確認まで通りお客様の電話が無い。ゲストのpaidを予定→worker→Mailpitで受け、raw本文からリンク取得、送信成功時刻+21日、一意のリンク、頁→確認。本文の電話無し/住所あり。overflow無し | 500-01、503-01/02 |
| FR-ORDER-007 | 同じ404とnoindexとno-storeと送信元の守りを持つ。形違い/存在しない/隠す2状態404、cancelled200、robots、API no-store、no-referrer、別Origin/元無しPOST403、CSRF拒否。overflow無し | 498-04、505-02/03 |
| FR-ORDER-008 | 配送と返金の条件を会員とそろえ非公開の番号を混ぜない。現版だけ・取消無し・オフ/未登録ではdelivery無し、deliveredAtは常時。返金の失敗/エラー無し・金額/順/進み具合、番号は確認後だけ。overflow無し。鍵無しの条件はviewの単体で検証 | 498-02/03 |
| FR-CONTACT-014 | 種別と注文番号を入力済みで開き不正値は無視して編集できる。order/小文字番号、type不正、重複、HTML値、正しい片方を保持、編集後の送信JSON、URLにない欄は空。overflow無し | 504-01/02/03 |
| FR-ACCOUNT-044 | 持ち主と別の会員と期限切れのログインを同じリンクで区別する。本人200member、失効accessと有効refreshは更新1回でGET再送、別会員200none、別会員でも正しい確認印はverified、確認期限後も本人はmember、会員注文へのリンク。overflow無し | 501-01/02/03、502-04 |

コメントは省略形でなく `// FREQ-498-AC-01` の完全形。同じACを複数specで確かめる時はそれぞれにコメントを置く。代表の期待は次の形にする。

```ts
test('390px リンクだけで公開の状況を見られ個人情報を読まない');
expect(privateResponse.status()).toBe(200);
expect(privateBody.access).toBe('none');
expect(privateSentinelInHtml).toBe(false);
expect(refreshRequestCount).toBe(0);
test('390px 本物のメールのリンクから確認まで通りお客様の電話が無い');
expect(mailHasCustomerPhone).toBe(false);
expect(statusUrlHasExpectedLocalShape).toBe(true);
expect(afterVerifyAccess).toBe('verified');
test('環境の専用鍵とサイトURLは親環境より優先する');
expect(prepared.ORDER_STATUS_SESSION_SECRET).toBe('e2e-order-status-session-secret-only');
expect(prepared.NEXT_PUBLIC_SITE_URL).toBe('http://localhost:3000');
```

トークンや本文を値とする `expect(actual).toEqual(expected)` を使わず、形や一致のbooleanを比べる。新status specとACCOUNT-044は `test.use({trace:'off',video:'off',screenshot:'off'})`。DBの値を戻すのはfinally、設定を変える008は既存 `withDeliveryScenario` の共通の鍵と復旧を使う。

- [x] **Step 2: controller が RED とケース数を確かめる**

Run: 3000番の所有確認 → 手元DB reset → `$env:PLAYWRIGHT_HTML_OPEN='never'; $env:E2E_STRICT='1'` を別々の行で設定 → `npx.cmd playwright test e2e/FR-ORDER-001-public-view.spec.ts e2e/FR-ORDER-002-verify-private.spec.ts e2e/FR-ORDER-003-verify-limits.spec.ts e2e/FR-ORDER-004-expiry.spec.ts e2e/FR-ORDER-005-returns-guidance.spec.ts e2e/FR-ORDER-006-email-link.spec.ts e2e/FR-ORDER-007-not-found-security.spec.ts e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts e2e/FR-CONTACT-014-order-status-prefill.spec.ts e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts`。
Expected: 道具がまだ無ければその未定義でFAIL。これはE2E道具のREDであり製品の欠陥の証明とは記さない。既に動く道具で全てPASSなら無理に壊さず、Task 1〜8の実測REDを参照する。登録されたケース数は30、skip0。

- [x] **Step 3: 試験の道具と既存の依存だけ直す**

新helperは全DB接続にloopback検査。各試験で `isolateCustomerApiIp` を使い、別試験が同じIP枠を使い切らないようにする。raw本文は006のメモリ内でだけ読み、画面・URLを添付しない。21日・24時間・15分の `waitForTimeout` を作らない。refreshは `loginCustomer` で実際のログインを作り、access Cookieだけを壊して有効なrefreshを残す。

既存FR-ADMIN-101の旧リンク期待を、伏せた `/order-status/[ORDER_STATUS_LINK]` の1行へ替え `// FREQ-503-AC-01` を添える。FR-CHECKOUT-049へpaid本文の電話無し/リンクありを足し `// FREQ-503-AC-02` を添える。FR-CHECKOUT-041/045の直接Mailpit読取は既存の `mailBodies` へ替え、名前/金額/数/案内の既存期待は維持する。共通 `mailBodies` の新しい伏せ方は本文を書き換えて送る処理ではなく、試験で読んだ後の値だけ。

FR-ORDER-007のCSRF拒否は、`loginCustomer` でrefresh Cookieのある状態を作ってから、許可OriginとCSRFヘッダー無しのPOSTで確かめる。refresh Cookieの無いゲストをCSRF不足として拒む期待にはしない。鍵無しはサーバー環境の差なので、実行中の本番ビルドで環境値を書き換える試験を足さず、Task 3の単体へ割り当てる。

`E2E_FIXED_ENV` の2値を加え、既存 `computeServerFingerprint` のfixed-key集計へ自然に含める。環境の単体で親の専用鍵/本番URLを上書きすることを確認する。SupabaseやMailpitの接続先を省略して本番へ戻す変更はしない。

- [x] **Step 4: controller が GREEN と既存の対象を確かめる**

Run: 環境のJest → 型 → reset → 3000番のE2Eアプリを止めてStep 2の新10本と、既存FR-ADMIN-101・FR-CHECKOUT-041/045/049を本番ビルドで実行。
Expected: 新30ケース全てexpected、skip0。既存もPASS。メール本文の伏せにより既存のassert失敗ログに43文字のトークンが無いことを合成失敗の単体で確認するのではなく、mask関数の戻り値と各読取経路の静的確認で点検する。全件比較はTask 11。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- e2e/order-status-test-utils.ts e2e/FR-ORDER-001-public-view.spec.ts e2e/FR-ORDER-002-verify-private.spec.ts e2e/FR-ORDER-003-verify-limits.spec.ts e2e/FR-ORDER-004-expiry.spec.ts e2e/FR-ORDER-005-returns-guidance.spec.ts e2e/FR-ORDER-006-email-link.spec.ts e2e/FR-ORDER-007-not-found-security.spec.ts e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts e2e/FR-CONTACT-014-order-status-prefill.spec.ts e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts e2e/order-email-test-utils.ts e2e/FR-CHECKOUT-041-confirmation-email-fulfillment.spec.ts e2e/FR-CHECKOUT-045-in-stock-line.spec.ts scripts/e2e/environment.ts tests/unit/scripts/e2e/environment.test.ts
git commit -m "test: 注文状況と問い合わせのE2Eを追加"
```

### Task 10: 要求と設計・運用の文書

**Files:**

- Create: `tests/unit/docs/order-status-traceability.test.ts`
- Create: `docs/04_DetailDesign/pages/20_order_status.md`
- Modify: `docs/02_Requirements/requirements.md`
- Modify: `docs/03_BasicDesign/api/api-spec.md`
- Modify: `docs/03_BasicDesign/api/route-inventory.md`
- Modify: `docs/03_BasicDesign/data/er.md`
- Modify: `docs/03_BasicDesign/ui/screen-list.md`
- Modify: `docs/03_BasicDesign/ui/screen-flow.md`
- Modify: `docs/04_DetailDesign/pages/09_contact.md`
- Modify: `docs/04_DetailDesign/pages/15_account.md`
- Modify: `docs/04_DetailDesign/states/order-payment.md`
- Modify: `docs/04_DetailDesign/sequence/order-administration.md`
- Modify: `docs/06_Operations/order-email-operations.md`
- Modify: `docs/06_Operations/webhook-queue-operations.md`
- Modify: `.env.example`

**Interfaces:**

- Consumes: C-0〜C-6、P1〜P31、Task 9の10spec/30ケース、既存FREQ-497の6列の行形式、要求管理ルール。
- Produces: FREQ-498〜505の8行、各4 ACで32 AC。次の要求行案と試験の対応。番号の重複が実装時に増えていれば勝手にずらさずcontrollerへ報告する。

#### 要求の行の案

この表の6列を既存FREQ-497の直後へ加える。受け付け基準の文は下表のとおり。実装時は次の対応表の実在するファイルへ、requirements.mdからの相対Markdownリンクを付け、「E2E」「単体」「DB 結合」「担当 Task」を既存行と同じ括弧内の形で添える。E2EのないACは `E2E —（DB 結合・単体で検証）` と明記する。ここではまだ作られていない試験へのリンク切れを作らないためパスをコードとして載せる。

| 要求ID | 要求 | 要件ID | 要件 | AC番号 | 受け付け基準の文 |
|---|---|---|---|---|---|
| FREQ-498 | 注文の状況をリンクから見られる機能を提供すること（グループ E-5） | FREQ-498-REQ-01 | ・ログインせずに指定の公開範囲を見られること | FREQ-498-AC-01<br>FREQ-498-AC-02<br>FREQ-498-AC-03<br>FREQ-498-AC-04 | ・FREQ-498-AC-01: リンクだけで注文番号・注文日・品物・数・金額が表示され、個人情報の項目が取得されないこと<br>・FREQ-498-AC-02: 進み具合と発送・配送の状況が会員の注文と同じ条件で表示され、取り消した発送と古い配送の版が表示されないこと<br>・FREQ-498-AC-03: 返金の額と状況、返品・キャンセルの申し込みの状況が表示され、失敗の詳細と店内だけの情報が表示されないこと<br>・FREQ-498-AC-04: 取り消した注文は表示され、支払いの途中・放棄・存在しない注文と形の違うリンクは同じ404で表示されること |
| FREQ-499 | 電話番号で個人情報を確かめる機能を提供すること（グループ E-5） | FREQ-499-REQ-01 | ・下4桁の確認を通った時だけ指定の個人情報を表示すること | FREQ-499-AC-01<br>FREQ-499-AC-02<br>FREQ-499-AC-03<br>FREQ-499-AC-04 | ・FREQ-499-AC-01: 全角数字や記号を含む注文時の電話の下4桁で確認でき、数字が4桁に満たない電話では確認できないこと<br>・FREQ-499-AC-02: 正しい確認の後だけ、お届け先・連絡先メール・支払方法・発送と送り返しの伝票番号・追跡先・返品の送り先が表示されること<br>・FREQ-499-AC-03: 確認の印が署名され、24時間と確認期限の早い方まで専用窓口の住所だけに保存され、注文ごとに区別されること<br>・FREQ-499-AC-04: 改変・別注文・期限切れの印では個人情報が表示されず、公開の状況は引き続き表示されること |
| FREQ-500 | 本人確認の期限と回数を守る機能を提供すること（グループ E-5） | FREQ-500-REQ-01 | ・対象メールの送信成功からの期限と確認の上限を守ること | FREQ-500-AC-01<br>FREQ-500-AC-02<br>FREQ-500-AC-03<br>FREQ-500-AC-04 | ・FREQ-500-AC-01: お客様向け16種類の送信成功だけで確認期限が21日後へ進み、同時に完了しても期限が戻らないこと<br>・FREQ-500-AC-02: 注文ごとの15分に5回と送信元ごとの10分に30回を超える確認が拒否されること<br>・FREQ-500-AC-03: 不一致だけが合計20回まで数えられ、期限が進む送信成功の時だけ失敗数が0へ戻ること<br>・FREQ-500-AC-04: 確認期限が無い時と切れた時は下4桁の欄が表示されず、ログインとお問い合わせが案内されること |
| FREQ-501 | 会員も同じ注文リンクを使える機能を提供すること（グループ E-5） | FREQ-501-REQ-01 | ・持ち主のログインとゲストの確認を区別して扱うこと | FREQ-501-AC-01<br>FREQ-501-AC-02<br>FREQ-501-AC-03<br>FREQ-501-AC-04 | ・FREQ-501-AC-01: 持ち主の会員が同じリンクを開くと、下4桁の確認期限の後も個人情報が表示されること<br>・FREQ-501-AC-02: ログインの印が切れても有効な更新の印があれば更新後に個人情報が表示されること<br>・FREQ-501-AC-03: 別の会員のログインだけでは個人情報が表示されず、その注文の有効な確認印がある時だけ表示されること<br>・FREQ-501-AC-04: ログインの印がないゲストへの個人情報の応答は未認可の200となり、不要なログイン更新と未ログインへの描き直しが起きないこと |
| FREQ-502 | 注文状況から返品とキャンセルを案内する機能を提供すること（グループ E-5） | FREQ-502-REQ-01 | ・記録の表示と申し込みの入口を分けること | FREQ-502-AC-01<br>FREQ-502-AC-02<br>FREQ-502-AC-03<br>FREQ-502-AC-04 | ・FREQ-502-AC-01: 返品の読み出しを共通化した後も、既存の持ち主向け関数の答えと拒否の振る舞いが変更前と一致すること<br>・FREQ-502-AC-02: 注文状況では返品とキャンセルの記録を表示し、申し込みのボタンとフォームを表示しないこと<br>・FREQ-502-AC-03: 持ち主としてログインしていない人へ、同じメールでの登録とメール確認の説明、お問い合わせの2つの道が表示されること<br>・FREQ-502-AC-04: 持ち主の会員へ、返品・キャンセルを申し込める会員の注文のページのリンクが表示されること |
| FREQ-503 | 注文メールから状況ページへ案内する機能を提供すること（グループ E-5） | FREQ-503-REQ-01 | ・対象の本文に同じリンクを入れ電話番号を除くこと | FREQ-503-AC-01<br>FREQ-503-AC-02<br>FREQ-503-AC-03<br>FREQ-503-AC-04 | ・FREQ-503-AC-01: お客様向け16種類だけに同じ注文のリンクが1行入り、配達済みの旧会員用リンクが置き換わり、店向け3種類は変わらないこと<br>・FREQ-503-AC-02: 支払済みと支払い待ちの本文からお客様の電話が消え、名前・住所と返品先のお店の電話は残ること<br>・FREQ-503-AC-03: サイトの住所を作れない時はそのメールが材料不足として扱われ、ほかのメールの処理は続くこと<br>・FREQ-503-AC-04: 保存済みの本文は送り直しでも書き換えられず、既存の注文へのリンクの一括作成と一斉再送が行われないこと |
| FREQ-504 | お問い合わせを注文番号入りで開く機能を提供すること（グループ E-5） | FREQ-504-REQ-01 | ・許可したURLの値だけで問い合わせの初期入力を作ること | FREQ-504-AC-01<br>FREQ-504-AC-02<br>FREQ-504-AC-03<br>FREQ-504-AC-04 | ・FREQ-504-AC-01: 案内から開いたお問い合わせに「ご注文について」と正しい注文番号が入力されること<br>・FREQ-504-AC-02: 不正な種別・注文番号・同名の重複値は無視され、正しい方の項目だけが入力されること<br>・FREQ-504-AC-03: 自動入力の後も利用者が欄を編集でき、再描画で入力が元へ戻らず、その値で送信されること<br>・FREQ-504-AC-04: 登録の入口がログインページの登録欄を開き、問い合わせのURLの値だけで注文の持ち主が決められないこと |
| FREQ-505 | 注文状況の閲覧とデータを守る機能を提供すること（グループ E-5） | FREQ-505-REQ-01 | ・権限と情報の分離を守り検索と漏えいを防ぐこと | FREQ-505-AC-01<br>FREQ-505-AC-02<br>FREQ-505-AC-03<br>FREQ-505-AC-04 | ・FREQ-505-AC-01: 新しい表の行ごとのアクセス制御と利用者の拒否が有効で、直接の書き込みが拒まれ、公開のDB関数はサーバー用権限だけで実行されること<br>・FREQ-505-AC-02: 公開の取得と型に個人情報のキーが無く、リンク値と電話がログ・監査・誤り・URLのクエリに出されず、異なる送信元の確認が拒まれること<br>・FREQ-505-AC-03: ページに検索を拒む指定があり、窓口が保存を許さず、追跡先へ元の住所が渡らないこと<br>・FREQ-505-AC-04: 3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で公開と確認後の表示と案内が横にはみ出さないこと |

#### 各 AC を確かめる試験

表の単体/DBの名前は次の実ファイルを指す。この対応を静的試験の定数にも持たせる。E2Eの列はファイルの識別子であり、Task 9の実名へリンクする。全種類のメールと全署名異常を、1本のE2Eで全て確かめたとは書かない。

| 略称 | 実ファイル |
|---|---|
| view | `tests/unit/lib/orders/customer-order-view.test.ts` |
| page | `tests/unit/components/OrderStatusPage.test.tsx` |
| phone/session/store | `tests/unit/lib/orders/status/status-phone.test.ts` / `status-session.test.ts` / `status-store.test.ts` |
| verify/private | `tests/unit/api/order-status/verify.test.ts` / `private.test.ts` |
| public/access/form/guidance | `tests/unit/features/order-status/OrderStatusPublic.test.tsx` / `OrderStatusAccess.test.tsx` / `OrderStatusVerifyForm.test.tsx` / `OrderStatusGuidance.test.tsx` |
| returns | `tests/unit/features/account/returns/OrderReturnsSection.test.tsx` |
| mail | `tests/unit/lib/orders/email/order-email-compose.test.ts`、`order-email-compose-returns.test.ts`、`order-email-compose-requests.test.ts`、`order-email-compose-delivery.test.ts` |
| worker | `tests/unit/lib/orders/email/order-email-worker.test.ts`、`order-email-worker-delivery.test.ts` |
| prefill/contact | `tests/unit/features/contact/contact-prefill.test.ts` / `tests/unit/components/ContactPage.test.tsx` |
| contact-api | `tests/unit/api/contact/route.test.ts` |
| origin | `tests/unit/middleware/proxy-origin.test.ts` |
| links-db/returns-db/rest-db | `tests/integration/db/order_status_links.integration.test.ts` / `order_status_returns.integration.test.ts` / `order_status_postgrest.integration.test.ts` |

| AC（完全な接頭辞はFREQ-） | 単体 | DB 結合 | E2E・その範囲 | 担当Task |
|---|---|---|---|---|
| 498-AC-01 | view/page/public/store | links-db | FR-ORDER-001 | 1/3/4/6 |
| 498-AC-02 | view/public | links-db | FR-ORDER-008 | 1/3/6 |
| 498-AC-03 | view/public/returns | links-db/returns-db | FR-ORDER-005、FR-ORDER-008 | 1/2/3/6 |
| 498-AC-04 | page/private | links-db | FR-ORDER-007 | 1/5/6 |
| 499-AC-01 | phone/verify/form | links-db | FR-ORDER-002（短い電話はDB/単体） | 1/4/5/6 |
| 499-AC-02 | view/private | returns-db | FR-ORDER-002 | 2/3/5/6 |
| 499-AC-03 | session | — | FR-ORDER-002（属性と2注文。署名異常の全形は単体） | 4/6 |
| 499-AC-04 | session/private/access | — | FR-ORDER-004 | 4/5/6 |
| 500-AC-01 | worker | links-db | FR-ORDER-006（paidの成功。16種類と競合はDB） | 1/7 |
| 500-AC-02 | verify | links-db（カウンター非更新） | FR-ORDER-003 | 5/9 |
| 500-AC-03 | verify/access | links-db | FR-ORDER-003 | 1/5/6 |
| 500-AC-04 | store/access | links-db | FR-ORDER-004 | 1/4/6 |
| 501-AC-01 | private/access | — | FR-ACCOUNT-044 | 5/6 |
| 501-AC-02 | private/access | — | FR-ACCOUNT-044 | 5/6 |
| 501-AC-03 | private/access | — | FR-ACCOUNT-044 | 5/6 |
| 501-AC-04 | private/access | — | FR-ORDER-001 | 5/6 |
| 502-AC-01 | view | returns-db | —（DB 結合・単体で検証） | 2/3 |
| 502-AC-02 | returns/public | returns-db | FR-ORDER-005 | 2/6 |
| 502-AC-03 | guidance | — | FR-ORDER-005 | 6 |
| 502-AC-04 | guidance/access | — | FR-ACCOUNT-044 | 6 |
| 503-AC-01 | mail/worker | links-db（1注文1本） | FR-ORDER-006（paidだけ）、既存FR-ADMIN-101（delivered） | 1/7/9 |
| 503-AC-02 | mail | — | FR-ORDER-006（paidだけ）、既存FR-CHECKOUT-049 | 7/9 |
| 503-AC-03 | mail/worker | — | —（単体で検証） | 7 |
| 503-AC-04 | worker | links-db、Task 11予行演習 | —（DB 結合・単体で検証） | 1/7/11 |
| 504-AC-01 | prefill/contact/guidance | — | FR-CONTACT-014 | 6/8 |
| 504-AC-02 | prefill/contact | — | FR-CONTACT-014 | 8 |
| 504-AC-03 | contact | — | FR-CONTACT-014 | 8 |
| 504-AC-04 | guidance/contact-api | — | FR-ORDER-005（登録入口だけ） | 6/8 |
| 505-AC-01 | store | links-db/returns-db/rest-db | —（DB 結合・単体で検証） | 1/2/4 |
| 505-AC-02 | view/store/verify/private/origin | links-db/returns-db/rest-db | FR-ORDER-001、FR-ORDER-007（HTTPと表示。ログは単体/静的） | 1/2/3/4/5/9 |
| 505-AC-03 | page/private/verify | — | FR-ORDER-007 | 5/6/9 |
| 505-AC-04 | public/access/guidance | — | 新10spec全て | 6/8/9 |

ACにE2Eがある行の文章は、requirementsへ書く時に原則 `3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で、` を先頭へ添える。DBだけの比較・全16種類などは括弧で証拠の範囲を明記する。505-AC-04は既にその文があるので二重に付けない。新spec全ての `// FREQ-505-AC-04` コメントも忘れない。

- [x] **Step 1: 32 AC とコメント対応の静的試験を先に書く**

```ts
test('FREQ-498から505の8行と32ACが一意で日本語の確かめられる文を持つ');
expect(requirementIds).toEqual(Array.from({length:8},(_,i)=>`FREQ-${498+i}`));
expect(acIds).toHaveLength(32);
expect(new Set(acIds).size).toBe(32);
test('ACごとのE2Eコメントと単体DBの対応が計画と一致する');
expect(actualAcMap).toEqual(expectedAcMap);
test('新10本は3幅ずつで30ケースを持ちskipやonlyを追加しない');
expect(newSpecFiles).toHaveLength(10);
expect(viewportWidths).toEqual([390,768,1280]);
test('2つのAPIと1表と鍵と運用の約束が文書にそろう');
expect(documentGaps).toEqual([]);
test('過去の移行は変えず新2本に完全修飾と権限とNOTIFYがある');
expect(migrationContractGaps).toEqual([]);
```

静的試験が検証するのは定義と対応であり、30ケースを実行して通した証拠にはしない。API一覧は現行128ファイル/167メソッド（E2E専用を含む）から新2ファイル/2メソッド分を足すが、実装時のソースから数え直す。今の一覧表はE2E専用を除くため、現状維持なら129行/168メソッド、全体は130ファイル/169メソッドとなる。

- [x] **Step 2: RED を確かめる**

Run: `npx.cmd jest tests/unit/docs/order-status-traceability.test.ts --runInBand`。
Expected: 要求8行・新文書・環境値の注記が無いためFAIL。既存最大番号が497でない場合は採番衝突として止める。

- [x] **Step 3: 要求の行と C-0〜C-6 の契約を文書へ写す**

新しい頁の文書は概要・公開/個人情報の表・2段のMermaid・固定文・エラー・テスト対応。ERは1表とFK。APIはC-3の全ステータスとnone/401/503の違い。画面の一覧と流れへtoken頁と登録/問い合わせ/会員注文の行き先を足す。状態の文書は注文のenumを変えないこと、個人情報の表示状態を別に持つことを明記する。

運用文書は21日と24時間の違い、メールの種類での期限更新、20回のリセット条件、旧保存済み本文を変えない方針、送り直し待ち件数の確認、リンクを一括で作らないこと、秘密値をログへ出さないこと、本番のアクセスログ/解析でtoken付きpathを記録しない設定を確認する手順を書く。既存のログを今回取得したとは書かない。

`.env.example` へ次の2行を追加する。実値は空のまま。既存の秘密値や `.env.local` を読まない。

```dotenv
# 注文状況の確認印に使うサーバー専用の鍵。空なら JWT_SECRET を使う。
ORDER_STATUS_SESSION_SECRET=
```

承認済みのE-5設計書はこのTaskでも変更しない。X1の優先する決定はAPI/頁の文書に明記する。既存の章全体を置換せず、E-5節と必要なリンク/目次だけを加える。

- [x] **Step 4: GREEN と文書の検証を確かめる**

Run: Step 2 → `npx.cmd jest tests/unit/docs/delivery-status-traceability.test.ts --runInBand` → `npm.cmd run -s validate-docs` → 型。
Expected: PASS、相対リンク切れ0、Mermaid構文の誤り0、既存E-4の静的試験もPASS。絵文字無し、H4まで、UTF-8、文字化け無しを確認する。

- [x] **Step 5: controller が名指しでコミットする**

```powershell
git add -- tests/unit/docs/order-status-traceability.test.ts docs/04_DetailDesign/pages/20_order_status.md docs/02_Requirements/requirements.md docs/03_BasicDesign/api/api-spec.md docs/03_BasicDesign/api/route-inventory.md docs/03_BasicDesign/data/er.md docs/03_BasicDesign/ui/screen-list.md docs/03_BasicDesign/ui/screen-flow.md docs/04_DetailDesign/pages/09_contact.md docs/04_DetailDesign/pages/15_account.md docs/04_DetailDesign/states/order-payment.md docs/04_DetailDesign/sequence/order-administration.md docs/06_Operations/order-email-operations.md docs/06_Operations/webhook-queue-operations.md .env.example
git commit -m "docs: 注文状況の要求と設計と運用を記録"
```

### Task 11: 全体の確かめと本番への出し方

**Files:**

- Evidence（gitの外）: `.superpowers/sdd/2026-10-22-order-status-page/progress.md`、`status-before.txt`、`base-commit.txt`、`e2e-baseline.json`、`e2e-results-group-e5.json`、`ac-trace.md`、`report-to-user.md`、各checkのログ。
- Evidence（gitの外）: `tmp/e5/fingerprint.sql`、`tmp/e5/rehearsal.ts`、`tmp/e5/rehearsal-state.json`、`tmp/e5/before-apply.sql`、`tmp/e5/after-apply.sql`。本番の値・本文・トークンを保存しない。
- Modify（検証と適用の記録だけ）: `docs/superpowers/plans/2026-10-22-order-status-page.md`、`docs/06_Operations/order-email-operations.md`、`docs/06_Operations/webhook-queue-operations.md`。
- Rename（許可を得て本番へ当てた後だけ）: P1のA/BをMCPが返した版へ。改名時の参照修正は `docs/03_BasicDesign/data/er.md`、`tests/unit/docs/order-status-traceability.test.ts` にも行う。

**Interfaces:**

- Consumes: Task 1〜10、32AC、新30ケース、Review Focusの5項目、前回 `.superpowers/sdd/2026-10-21-delivery-status/e2e-results-group-e4.json`、C-1の新/置換10関数と1表。内訳は新public5・置換public2・新private3。
- Produces: 実測RED/GREEN、全Jest/DB/E2E/型/lint/文書の結果、既存データでの予行演習、前回比較、32ACの証拠、手元/本番の同じ定義のmd5とACL、許可を得たpush/適用/改名の記録。
- 予行演習の道具の入口は `runOrderStatusRehearsal(phase:'seed'|'apply-a'|'apply-b'|'check'):Promise<void>`。CLIは `npx.cmd tsx tmp/e5/rehearsal.ts --phase seed` の形。DBは `postgresql://postgres:postgres@127.0.0.1:54322/postgres` だけを許す。SQL適用はファイルをUTF-8で読み全文を1回queryし、値を出力しない。

- [x] **Step 1: 実装前に場と前回の基準を控える（Task 1 より先）**

controllerは `git rev-parse HEAD` と `git --no-optional-locks status --short` を控える。既存の `.claude/CLAUDE.md`・`package.json`・`.superpowers/` 等の変更を混ぜない。実装前の単体/ほかのJest/型/lint/validate-docsの結果を測り、前からの失敗・skipを分ける。前回JSONは存在・時刻・md5と実測のexpected/unexpected/flaky/skippedを読み、E-4計画の古い合格数を流用しない。

`scripts/e2e/compare-baseline.ts` の `flattenPlaywrightJson` で前回を `{tests:TestOutcome[]}` に直し、今回の作業場の `e2e-baseline.json` に保存。元の全件JSONは保全する。元が無い時はその場で不足を報告し、代わりの基準をcontrollerがユーザーへ確認するまで比較を済みとしない。

普段の開発アプリが本番DBを見る点、新しいRPCを読むコードを入れてから本番適用まで普段の画面が500になり得る点をユーザーへ伝える。実装中は使わないか手元へ向けるかを既存のセッションの許可と照合し、方針を台帳へ残す。3000番の所有は次で確認する。

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

controllerが手元Supabase/MailpitとE-4のfakeを用意する。既存のE2E用アプリだけ、プロセスのcommand lineで所有を確認して止める。普段のアプリを勝手に止めない。DockerやOSの保護設定を勝手に変更しない。X2は手元catalogで解消した記録を残す。

- [x] **Step 2: 全体の受け入れの RED と未実施を記録する**

Task 10の静的試験で8行/32ACと対応を調べ、各TaskのREDログとGREENログへリンクする。未実施を「通過」に変えない。既に全て通る場合はREDを作るための変更をせず、先行Taskの実測REDを参照する。

```ts
test('新30ケースは全てexpectedでskipが無い');
expect(newFiles).toHaveLength(10);
expect(newCases).toHaveLength(30);
expect(newCases.every(item=>item.outcome==='expected')).toBe(true);
test('32ACの証拠と前回からの説明のない回帰が無い');
expect(coveredAcIds.size).toBe(32);
expect(unexplainedRegressions).toEqual([]);
```

- [x] **Step 3: 全単体・ほかの Jest・型・lint・文書を確かめる**

Run:

```powershell
npx.cmd jest tests/unit --runInBand
npx.cmd jest tests/features tests/items tests/integration/api tests/integration/lib tests/integration/auth-flow.test.ts tests/integration/csrf.test.ts --runInBand
npx.cmd tsc --noEmit --incremental false
npm.cmd run lint
npm.cmd run -s validate-docs
```

Expected: 今回による失敗0。実装前の失敗/skip/警告との差を1件ずつ区別する。単体だけを全Jestと呼ばない。静的なSQL文字列の確認を、SQLの実行の合格と呼ばない。

- [x] **Step 4: controller が DB 結合を全件流す**

E2E用アプリ/workerを動かしたままDB結合を流さない。reset後に環境を次の形でプロセスの中へ渡す。statusのJSONや鍵を出力・ログ保存しない。

```powershell
npx.cmd supabase db reset --local
$e5LocalStatus = (& npx.cmd supabase status -o json | ConvertFrom-Json)
$env:LOCAL_SUPABASE_URL = $e5LocalStatus.API_URL
$env:LOCAL_SUPABASE_SERVICE_ROLE_KEY = $e5LocalStatus.SERVICE_ROLE_KEY
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
npx.cmd jest tests/integration/db --runInBand
```

実行前にAPI_URLもlocalhost/127.0.0.1/::1であることを検査する。Expected: A→B適用、全件PASS、skip0。新3スイートだけでなく、既存のメール・返品・返金・発送もPASS。読み取り権限、2接続の競合、旧JSON比較、PostgRESTの引数、同じ時刻の期限リセットを確認する。

- [x] **Step 5: E-4 までの既存データで A/B を当てる予行演習**

`tmp/e5/rehearsal.ts` を上記署名で用意する。実施前にCLIの `db reset --help` で `--version` が利用可能なことを確認し、使えない時に無指定resetで代用しない。実施コマンドは次の順。

```powershell
npx.cmd supabase db reset --local --version 20261021221410
npx.cmd tsx tmp/e5/rehearsal.ts --phase seed
npx.cmd tsx tmp/e5/rehearsal.ts --phase apply-a
npx.cmd tsx tmp/e5/rehearsal.ts --phase apply-b
npx.cmd tsx tmp/e5/rehearsal.ts --phase check
```

seedはE-4までの状態で、ゲスト/会員のpaid、pending、shipped、cancelled、隠す2状態、発送/返金/返品/キャンセル申し込み、旧本文保存済みretry_waitを合成で作る。注文の件数、明細の件数、既存JSONの答え、保存済み本文のmd5、旧completeの定義のmd5をメモリまたは合成データだけのstateへ控える。トークンはstateへ保存しない。

apply-aはP1のA全文を適用し、直後のリンク件数0を確認してから、1注文だけensureを呼ぶ。旧本文の送信完了をリンクあり/無しの2注文で試し、ありだけ21日へ進む。誤ったleaseはfalse、保存済み本文のmd5は同じ。残りの注文へリンクが増えない。

apply-bはB適用直前/直後に同じ合成の持ち主用JSONを読み、全項目の一致を確認。新しい注文番号用false/trueを照合する。checkは既存の注文/発送/返品/返金の件数と内容に意図しない差0、新規リンクは明示した1件だけ、公開の非公開キー0、RLS/ACL適合、旧本文の変更0、期限の不正0を数える。各検査は名称・pass/fail・件数だけ出し、skipを作らない。

Expected: 全検査の違反0。resetだけの新規DBへの適用成功で、既存データを使った適用成功を代用しない。予行演習後はこのDBをE2Eへ流用しない。

- [x] **Step 6: DB を作り直し本番ビルドの E2E 全件を流す**

3000番の所有を確かめ、コード変更後の古いE2Eアプリだけを止める。Run:

```powershell
npx.cmd supabase db reset --local
$env:PLAYWRIGHT_HTML_OPEN = 'never'
$env:E2E_STRICT = '1'
npx.cmd playwright test
```

Expected: 見張りを通り、fake→build→start。新30ケースは全てexpected、skip0。全件の実測を先に `.superpowers/sdd/2026-10-22-order-status-page/e2e-results-group-e5.json` へコピーし、部分再実行で上書きしない。実値を含むCookieやrawメール本文は記録へ添付しない。

- [x] **Step 7: 前回の E2E と全件で比べる**

```powershell
npm.cmd run e2e:compare -- .superpowers/sdd/2026-10-22-order-status-page/e2e-baseline.json .superpowers/sdd/2026-10-22-order-status-page/e2e-results-group-e5.json
```

Expected: 新しい失敗/skip/欠落と説明のない回帰0。前はexpectedで今回そうでない物を1件ずつ説明する。既存の失敗と同じだという主張には前後のerror-contextと単独再実行の証拠を付ける。retriesを上げて通さない。今回触った会員・返品・お問い合わせ・メールを「前から失敗」の一言で除外しない。

- [x] **Step 8: DB 定義の指紋と秘密の境界を確かめる**

`tmp/e5/fingerprint.sql` は読み取りだけ。C-0の1表の全列/NULL/default/CHECK/FK/UNIQUE/索引/RLS/policy/ACL、C-1の10関数の引数/戻り値/owner/SECURITY DEFINER/STABLEまたはIMMUTABLE/search_path/ACL/`pg_get_functiondef`、pgcryptoのschemaを列挙する。`(kind,name,md5(def),acl)` をC順で並べ全体md5を出す。無い名前はmissingとして数え、存在しない物を飛ばしてmd5を作らない。

手元reset後のDBで `missing=0`、新/置換public7関数はservice_roleのみ、新private3関数の外向けEXECUTE無し、新表service_role SELECTだけ、RESTRICTIVE/RLS有効を確認する。Bの既存public関数を含める。試験用pg_temp関数は指紋の対象に入れない。

SQL全文にJSON由来の `\u` と16進4字が残っていないこと、A/Bの `AS $$` と `$$;`、UTF-8/LF/末尾改行、各ファイルのbytes/md5を確認。元移行の変更0を開始commitとのdiffで確認する。トークン・電話・秘密の実値がソース差分/ログ/証拠/クエリへ混ざらないことを確認する。E2Eの合成値は秘密の本番値の検証ではない。

- [x] **Step 9: Opus の全体の最終レビューと必要な修正**

実施の記録（2026-10-22、手元だけ）: 単体 9,588 件通過・DB 結合 1,574 件通過・既存データでの予行演習 98 項目の違反0・指紋 missing 0・E2E 全件 3,579 件中 3,355 件通過（新しい30ケースは全部通過、前回から新しく落ちたのは全件の負荷での商品詳細2件だけ）・Opus の全体の最終レビューは Critical 0・Important 0。詳しくは [運用の文書](../../06_Operations/webhook-queue-operations.md) の 9.1。本番の DB・本物のメール・本番のログの設定は未確認。

全体の最終レビューは `.claude/CLAUDE.md` の指定どおり `claude Opus5.5` を使う。これは後日の実装controllerの手順であり、下書きの作成中に他の係を呼ぶ指示ではない。設計書全13章、X1〜X4、P1〜P31、C-0〜C-6、32AC、Review Focus5項目、元SQLとの差、実測ログ、旧本文/競合/認証更新/公開経路を渡す。

指摘は所有Taskへ戻し、必要なRED→GREENを記録する。直した部分と影響する既存の検証をやり直す。E2Eに影響する変更ならreset→全件→比較を更新する。重大な未解決0を確認する。現在の実行環境で指定モデルを利用できない時はcontrollerがユーザーへ不足を報告し、別モデルの結果をOpusレビューと呼ばない。

- [x] **Step 10: 全体の結果を報告し検証記録だけコミットする**

`report-to-user.md` に各範囲の実測件数、skip、前回比較、32AC、新30ケース、予行演習、missing/指紋、既存差分、未確認の本番環境/本物のメール経路を短く書く。手元Mailpitの結果を本番の受信箱への到着証拠にしない。計画のチェックと運用文書へ実測だけ追記する。

```powershell
git add -- docs/superpowers/plans/2026-10-22-order-status-page.md docs/06_Operations/order-email-operations.md docs/06_Operations/webhook-queue-operations.md
git commit -m "docs: 注文状況の全体検証の結果を記録"
```

#### 本番への出し方（ここからは全確認後、それぞれのユーザーの許可を得てから）

- [ ] **Step 11: push の許可を得てから送る**

差分・全実測・未確認・移行A/Bの内容とbytes/md5を見せ、pushの許可を得る。DB適用の許可とは別。作業ツリーを開始時と比べ、指定ファイル以外をstageしない。3000番の自分のE2Eアプリを止め、`$env:PLAYWRIGHT_HTML_OPEN='never'` の環境で `git push o_official master`。pre-pushを通し、`--no-verify` を使わない。

- [ ] **Step 12: 本番の読み取りの許可を得て前提を確かめる**

Supabase MCPの読み取りだけ。適用版がE-4の `20261021221410` まで揃いE-5が未適用、元completeと元get_customer_order_returnsの定義/引数/ACL/md5が手元の前提と一致、pgcryptoがextensionsにあることを確認する。不一致なら当てずに報告する。

既存の注文/発送/返品/メールの件数と、顧客向けの `subject IS NOT NULL AND body_text IS NOT NULL` の未完了（pending/retry_wait/sending）件数を種類/状態だけで数える。deadに保存済み本文がある数も別に数える。本文・宛先・電話・token・注文ごとの一覧は読まない。旧本文を維持し通常の再試行を続けるP28の影響を件数で報告する。値を書き換える実行はこの許可へ含めない。

- [ ] **Step 13: A の適用の許可を得て全文と md5 を確かめる**

適用名 `order_status_links`、P1のA、bytes/md5、X2の前提、リンクの一括作成無しを見せる。許可後にファイル全文を一字も変えず `apply_migration` へ渡す。直前にもunicode escapeと文字化けを検査する。MCPの `list_migrations` が返した実際の版を控え、次をその版に対して読む。

```sql
select md5(statements[1]) as statement_md5,
       octet_length(statements[1]) as statement_bytes,
       array_length(statements,1) as statement_count
from supabase_migrations.schema_migrations
where version = '<Aを当てた実際の版>';
```

Expected: 手元ファイルのUTF-8 bytes/md5と同じ、statement_count=1。違えば止めて報告し、Bへ進まない。A直後のリンク0件を確認するが、並行して新メールが本文を作った場合は増加を処理の時刻と件数で説明し、一括作成の証拠と混同しない。

- [ ] **Step 14: B も別の許可で当て、同じ md5 を確認する**

適用名 `order_status_returns`、P1のB、bytes/md5を見せ別に許可を得る。Aのmd5一致が前提。全文を適用後に実版を控え、同じSELECTのversionをBへ替えてstatement_count=1とbytes/md5一致を確認する。差があっても戻すSQLを勝手に実行せず報告し、必要なら前へ進める修正移行を別途用意する。

- [ ] **Step 15: 本番の指紋と権限と既存の件数を読む**

Step 8と同じfingerprint SQLを使う。missing0、定義の全体md5/ACLと種類ごとの件数が手元と一致。不一致は行ごとの指紋で分け、今回の差と前からの差を区別する。既存の件数に意図しない差0、電話やメール本文の一括変更0、新しい一括リンク作成0。新表のRLS/拒否/SELECTだけ、新public5/置換public2の権限、新private3の外向けEXECUTE無しを確認する。

ユーザー側の開店前の確認として、専用鍵の設定（空ならJWT_SECRET）、本番サイトURL、アクセスログ/解析のtoken付きpathの除外、実際のゲストの注文メール→ページ→下4桁の確認を残す。本物の注文やメールを作る操作はDBの読み取り許可に含めない。

- [ ] **Step 16: 当てた版へファイル名と参照を直し記録する**

controllerはMCPが返した版を使い、`$appliedA` と `$appliedB` へrepo内の実際の1パスずつを置く。末尾は `_order_status_links.sql`・`_order_status_returns.sql`。解決済み絶対パスがrepo内で、既存ファイルに衝突しないことを検査してから `Move-Item -LiteralPath` で名前だけ直す。本文のbytes/md5は変えない。

計画・ER・運用・静的試験の仮の2名を実際の名へ直す。履歴として残すP1には仮名→適用名の対応を書き、実行手順の参照は実名へ替える。`rg '20261023100[01]00_order_status' docs tests` の残りが履歴の対応だけであることを確認。静的単体・型・validate-docsを通し、実版と指紋一致を記録する。

```powershell
git add -- supabase/migrations/20261023100000_order_status_links.sql supabase/migrations/20261023100100_order_status_returns.sql $appliedA $appliedB docs/superpowers/plans/2026-10-22-order-status-page.md docs/03_BasicDesign/data/er.md docs/06_Operations/order-email-operations.md docs/06_Operations/webhook-queue-operations.md tests/unit/docs/order-status-traceability.test.ts
git commit -m "docs: 注文状況の本番適用の版と確認結果を記録"
```

再pushもユーザーの許可を得る。アプリとDBの適用時刻を運用文書へ残し、本番の動作を手元の合格から推定しない。

#### 設計書との最後の対応

| 設計書 | 実装と証拠のTask |
|---|---|
| 1〜2 目的・公開範囲・反目標 | 3/5/6/9/10、498/505 |
| 3 2段の流れとログインの更新 | 4/5/6/9、501。401の差はX1 |
| 4-1 リンクの形・表・作成・守り | 1/4/7/11、499/503/505。乱数のschemaはX2 |
| 4-2 21日・成功時だけ・旧本文 | 1/7/11、500/503 |
| 4-3 noindex・no-store・no-referrer・同じ404 | 5/6/9/10、498/505。proxyの拒否の補足はX4 |
| 5-1 公開/確認後の全項目と既存の出し分け | 1/2/3/4/5/6/9、498/499。取得前の分離の追加はX3 |
| 5-2 会員JSONを保つ共通化と専用窓口 | 2/3/5/6、501/502 |
| 5-3 頁と3幅 | 6/9、505-AC-04 |
| 6-1〜6-4 下4桁・期限・上限・Cookie | 1/4/5/6/9、499/500 |
| 7 2つの道と問い合わせの入力 | 6/8/9、502/504 |
| 8 メール16種類・電話・旧本文 | 1/7/9/11、503 |
| 9 DBの関数と移行 | 1/2/4/11、C-0/C-1 |
| 10〜11 承認した決定と値 | Global Constraints、P1〜P31、全Task |
| 12 試験 | 1〜11、32AC、30ケース、Review Focus5項目 |
| 13 開店前のユーザーの確認 | 10/11。本番の実注文・実受信・アクセスログ設定は未確認のまま |

下書きでの仕様の未割当ては0。X2の実DB前提とX3/X4の範囲の補足は、実装前にcontrollerが確認する項目。今回の下書きは、これらを確認済みまたは承認済みとする記録ではない。
