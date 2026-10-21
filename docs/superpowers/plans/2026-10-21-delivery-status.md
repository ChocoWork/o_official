# 配送の状況（グループ E-4）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 伝票番号の直し・手で配達済み・届いた日からの返品の期限をいつも使え、ショップの設定で追跡をオンにした時だけ 17TRACK の配送状況・メール・要対応を使えるようにする。

**Architecture:** 発送の今の状況と版を `order_fulfillments` に持ち、出来事・番号の直し・追跡の予定・要対応を別の表に残す。書き込みは注文 → 発送の鍵を取る DB の関数に集め、状況とメールの予定を同じ取引で書く。17TRACK の知らせは読み直しの合図だけにし、毎分の処理と `after()` が同じ借りの印つきの処理を使う。

**Tech Stack:** `package.json` の指定は Next.js `^16.3.6` App Router、TypeScript `^5`、React / react-dom `^19.0.0`、`@supabase/supabase-js ^2.103.3`、`@supabase/ssr ^0.10.2`、zod `^4.3.6`、Jest / ts-jest `^29`、`pg ^8.23.0`、`@testing-library/react ^16.3.2`、`@playwright/test ^1.58.2`。DB は既存の Supabase Postgres 17（RLS・SECURITY DEFINER）、メールの手元の試験は Mailpit。17TRACK 用の SDK は増やさず `fetch` と Node の `crypto` を使う。

**Spec:** [配送の状況の設計書](../specs/2026-10-21-delivery-status-design.md)（承認済み。本文・16章の #1〜26・v2.4 の付録が正）。[グループ E 全体の決定](../specs/2026-10-10-group-e-overview-design.md)（差がある所は今回の設計書 1-5 が正）。

## 概要

15のタスクを「試験を先に書く → 落ちることを確かめる → 実装 → 通ることを確かめる → コミット」の順に進める。型と DB の契約は C-0〜C-6 を使う。この文書は計画だけで、実装・起動・試験・DB 接続・本番の確認を行った記録ではない。

| Task | 作る物 | 主なファイル |
|---|---|---|
| 1 | 移行 A（記録と守り） | `supabase/migrations/20261021220816_delivery_tracking_records.sql` |
| 2 | 移行 B（お店の関数・読む関数・返品の期限） | `supabase/migrations/20261021221140_delivery_tracking_admin.sql` |
| 3 | 移行 C（追跡の関数） | `supabase/migrations/20261021221410_delivery_tracking_sync.sql` |
| 4 | TS の土台・状態の対応の表・DB の呼び出し | `src/lib/orders/tracking/delivery-*.ts` |
| 5 | 17TRACK client・署名・共通の見本 | `src/lib/orders/tracking/seventeen-track-*.ts`・`tests/fixtures/17track/` |
| 6 | 毎分と急ぎの道・運用の知らせ | `delivery-worker.ts`・`delivery-schedule.ts`・`delivery-ops.ts` |
| 7 | 知らせの受け口 | `src/app/api/webhook/17track/route.ts` |
| 8 | 配達中・配達済み・発送の更新のメール | `src/lib/orders/email/` |
| 9 | 管理画面の窓口・一覧・履歴・設定の窓口 | `src/app/api/admin/` |
| 10 | 履歴・番号の直し・配達済み・要対応の画面 | `src/components/OrderHistoryDialog.tsx` ほか |
| 11 | ショップの設定の配送の追跡の欄 | `src/components/ShopSettingsSection.tsx` |
| 12 | お客様の画面・進み具合・プライバシー・返品の説明 | `src/app/account/orders/[id]/page.tsx` ほか |
| 13 | 作り物の 17TRACK・E2E 8本・既存の見本の直し | `e2e/FR-ADMIN-100`〜`104`・`FR-ACCOUNT-041`〜`043` |
| 14 | FREQ-488〜497・設計と運用の文書・環境の値の名前 | `docs/`・`.env.example` |
| 15 | 全体の確かめと本番への出し方 | 作業場 `.superpowers/sdd/2026-10-21-delivery-status/` |

- 実装と直しは Codex（`--model gpt-6.1-sol`。使えない間は Sonnet）、タスクごとのレビューは Sonnet、全タスクの後の全体のレビューだけ Opus（1回）。コミットは controller がタスクのファイルだけを名指しで行う
- push と本番の DB への適用は、全部の確かめの後に、ユーザーの許可を得てから行う（Task 15 の最後の節）
- 実装を始める前（Task 1 の前）に、Task 15 Step 1 を流す。手元の本番ビルド・Supabase・Mailpit、3000番の扱い、前回の E2E の一覧、普段の開発のアプリを使う予定を確かめる。17TRACK の本物の口座や鍵は、追跡オフの実装と手元の試験の前提にしない

## Global Constraints

（この節の値は一字も変えない。タスクの要件は全部この節を含む。回数の制限など設計書に数の無い物は P-list と C-3 で決める）

- ユーザーの方針: Shopify と同じ形に近づける。Shopify に無い所は業界の定番に従う。計画に無い判断が要る時もこの順で決め、決めたことは台帳に残す
- 最初は追跡しない（案B）。ショップの設定の「配送の追跡」は最初オフ。追跡がオフの間は、登録・読み直し・見回りを一切しない
- 配送の状況: `confirmed`・`in_transit`・`out_for_delivery`・`attempted_delivery`・`ready_for_pickup`・`delivered`・`delayed`・`failure`。注文の状態の値（`order_status`）は変えない
- 出どころ `source`: `shipment`・`tracking`・`manual`・`tracking_edit`。状況と時刻だけを残す（場所や運送会社の文は残さない）
- 要対応 `kind`: `delivery_failure`・`attempted_delivery`・`tracking_not_found`・`tracking_registration_failed`・`tracking_stalled`。`resolution`: `auto`・`manual`
- 登録 `state`: `pending`・`registered`・`stopped`・`failed`。`failure_kind`: `invalid_number`・`repeated_error`
- 止める理由 `stop_reason`: `delivered`・`expired`・`replaced`・`cancelled`・`provider_stopped`・`disabled`
- メールの種類（16 → 19）: `out_for_delivery`・`delivered`・`shipping_update`。書き分け（`variant`）は空。3つとも注文の履歴から送り直せない
- メールはその発送の `notify_customer` がオンの時だけ予定に入れる。配達中・配達済みは（発送・版・種類）で1通。発送の更新は直しの記録1つで1通。古い版の配達中・配達済みと、配達済みの後の配達中と、取り消した発送のメールは送らずに終える
- 設定の列: `delivery_tracking_enabled`（最初は `false`）・`delivery_tracking_updated_at`・`delivery_tracking_updated_by`。変えるのは追跡を切り替える関数だけ
- 環境の値: `TRACKING_17TRACK_API_KEY`（サーバーだけで読む）・`TRACKING_17TRACK_BASE_URL`（無ければ `https://api.17track.net/track/v2.4`）。見出しは `17token`
- 17TRACK の運送会社の番号: ヤマト 100062・佐川 100040・日本郵便 10021。渡すのは伝票番号と運送会社の番号だけ。1回に40件まで、1秒に3回まで
- 知らせの受け口: `POST /api/webhook/17track`。本文の上限は 1MiB（1048576 bytes）。`sign` ＝ SHA-256（本文そのまま ＋ `/` ＋ 鍵）の16進。署名は時間で差の出ない比べ方で比べる
- 受け口の順番: 鍵なし503 → 本文の上限413 → 署名401 → JSON 400 → オフなら200／DB の失敗500 → 200と `after()`。ログインと CSRF は通さない。200以外なら 17TRACK は10分・30分・60分後に送り直す
- 登録は すぐ・5分・15分・1時間・6時間 の5回、その後は1日1回。`invalid_number` と、やり直しの2回目（-18019905）は試し直さない
- 読み直しは6時間ごと。失敗時は5分・15分・1時間、その後は6時間ごと。`gettrackinfo` を使い、`getRealTimeTrackInfo`・`deletetrack`・`changecarrier` は使わない
- 30日（`expires_at`）の数え始めは、版1は発送した時刻、直した版は直した時刻。一度でも登録できた行だけが期限切れで `tracking_stalled` を開く。一度も登録できない行は `stopped`・`expired` にするだけ
- 「番号が正しくない」はすぐ `tracking_not_found`、情報が無いのは登録から72時間で `tracking_not_found`
- 配達済みになったら、その版の状況を動かさず追跡を止める。届いた時刻は発送した時刻より前にしない。手の日付は発送の日〜今日、日本時間の正午を発送した時刻と今で挟む
- 古い出来事は、同じ版の `tracking` の行だけと比べる。発送の記録・伝票番号の直しの時刻とは比べない。直した後の `delivery_status_at` は直した時刻、その後の読み直しで戻ることがある
- 知らせは（配送業者、upper(番号)）で合う `registered` 全行の合図にする。同じ組の発送はいくつあってもよい。外の止める呼び方は、番号の直し・発送の取消の時に同じ組の止めていない行がほかに無い時だけ。配達済み・期限切れ・設定オフでは送らない
- 毎分の置き場はメールの送り出しの後・運用の確かめの前。時間は「8秒か残りの短い方」（min(8s, remaining), skip if < 3s）。今の Stripe とメールの時間の決まりと、その試験は変えない。飛ばした時も心拍を残す
- 運用のジョブの心拍に `delivery_tracking` を足す。口座ぜんたいの失敗は `pending` のまま、失敗の数を数えず、発送ごとの要対応を開かず、`SHOP_ALERT_EMAIL` に1日1回知らせる。鍵が消えた時の知らせは追跡オンの時だけ
- 管理画面の書く窓口は権限 → CSRF → 送信元ごと → 管理者ごとの回数の制限を通す。番号の直し・配達済み・要対応を閉じる権限は `admin.orders.manage`、要対応を読む権限は `admin.orders.read`、設定は `admin.settings.manage`（店長だけ）
- 管理画面の窓口は `POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking`・`POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered`・`POST /api/admin/order-attention/deliveries/[attentionId]/resolve`・今の `PUT /api/admin/settings/shop` の任意の項目
- お客様の窓口は今までどおり自分の注文だけ。条件に合わない配送状況のキーはサーバーが返さない。管理者の名前・17TRACK の細かい状況・追跡の登録の状態は出さない
- 新しい表は RLS を有効にし、`anon`・`authenticated` は RESTRICTIVE の方針で全部拒み、権限も外す。`service_role` は SELECT だけ。書くのは関数だけ。登録の表だけ `private`、ほかの3表は `public`
- public の関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名。`PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、`service_role` だけに与える。private の補助は `PUBLIC` から外す。移行の最後に `NOTIFY pgrst, 'reload schema';`
- 鍵の順番: 注文 → 発送。版と借りの印が合う結果だけ書く。二重防止は画面で作る uuid と、決まった順の入力 JSON の md5。同じ番号・同じ指紋は前の結果を `replayed: true`、違う指紋は C-4 の断り
- 返品の期限は `delivered_at` があればその日本時間の日付、無ければ発送の日（日本時間）＋目安の日数。品ごと／最後の品・日数・日の終わり・無制限と、もうある返品・申し込みの記録は変えない
- 移行は A → B → C、各 `BEGIN;`〜`COMMIT;`。当て済みの移行は直さず、最新の関数の本文を新しい移行で置き換える。仮のファイル名は P1、本番適用後に実際の版へ直す
- 要求は FREQ-488〜497。最後が FREQ-487（現在 `requirements.md:1671`）であることを追加前に確かめる。E2E は FR-ADMIN-100〜104・FR-ACCOUNT-041〜043。AC 番号の正は Task 14 の表で、Task 13 の `// FREQ-4xx-AC-nn` はその表に合わせる
- 普段の開発のアプリ（`npm run dev`）は本番の DB につながっている。新しい列・表・関数をアプリが読み始めてから本番適用が終わるまで、普段の開発の画面は500になりうる。実装前にユーザーへ伝え、手元の Supabase につなぐか実装中は使わないか決める。確認は手元だけで行う
- E2E は本番ビルド（`next build && next start`）・手元の Supabase（`npx supabase db reset` の直後）・Mailpit・作り物の 17TRACK、mobile（390px）・tablet（768px）・desktop（1280px）。3000番を `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめ、`PLAYWRIGHT_HTML_OPEN=never` を付ける。DB 結合の直後には流さず reset を挟む
- DB 結合は reset 後、フォルダ全体を `--runInBand`。Git Bash で `eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"` の後に `LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`。値は画面に出さず、skip を合格としない
- 単体は `npx jest tests/unit --runInBand`、型は `npx tsc --noEmit`、lint は `npm run lint`。PowerShell では `npx.cmd`・`npm.cmd` を使う。controller が DB 結合と E2E を流す
- 各タスクのコミットは全体の型の確かめを通す。union に値を足す時は同じタスクで、その型で引く `Record` と `switch` を全部直す
- 実装者はコミットしない。controller がタスクのファイルだけを名指しで master にコミットし、push しない。`--no-verify` を使わない。日本語の Conventional Commits、末尾は `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- コードを変えたタスクのコミットの後、controller が `.venv/Scripts/python.exe -m graphify update .` を流す（`graphify-out/` はコミットしない。タスクの Step には書かない）
- 秘密の値（`.env.local` の鍵・合言葉・印・確認コード）と署名つきリンクを、画面・ログ・監査・文書・報告に出さない。17TRACK の鍵・署名・本文・運送会社の文・場所は保存もログ出力もしない。監査に伝票番号は可、氏名・住所・連絡先は不可
- 返答・文書・コメントは日本語。コードのコメントは理由を書く。ソースを読む前に `.venv/Scripts/python.exe -m graphify query "<問い>"`。Next.js のコードを書く前に `node_modules/next/dist/docs/` の該当する guide を読む
- 画面の文言とメールの文言は C-5・C-6 のとおり（一字も変えない）。誤りの言葉は C-4。値は画面で文字として出し、HTML として読まない。日時は日本時間、日付は `M月D日`。タスクは番号どおり進める

## Review Focus

1. 番号を直した後に、発送を記録した時の要求が再送されても、元の発送を返して直した番号を戻さない（Task 2 `発送の作成の再送は番号の直しの後も同じ発送を返す`）。
2. 同じ配送業者・英字の大小だけ違う番号を2発送で使い、片方の取消ともう片方の読み直しが重なっても、残った荷物の追跡を止めない（Task 3 `共有する番号の停止と新しい登録を直列に扱う`、Task 6 の stop 呼び出し）。
3. 読み直し中に新しい知らせや設定オフ・番号の直しが来ても、合図を失わず、古い結果と古い配達中のメールを捨てる（Task 3 `借りている間の合図を次の読み直しへ残す`、Task 8 の保存済み本文の試験）。
4. 登録の待ちが1000行を超えた店や、鍵が途中で消えた店でも、件数と進み具合を切れた一覧から推測せず、配送状況の隠す条件をサーバーで守る（Task 2 の集計、Task 12 `鍵が無い間は記録済みの輸送中も返さない`）。
5. 今日の午前・発送日の午後・日本時間の日付の境目で同じ日を選んでも、未来や発送前の配達を作らず、返品の期限を同じ日付から数える（Task 2 `手の正午を発送と今で挟む`、Task 12 の日付表示）。

## 本計画の決め事（設計書の書いていないところ）

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | 移行は指定の3本: `supabase/migrations/20261021220816_delivery_tracking_records.sql`・`supabase/migrations/20261021221140_delivery_tracking_admin.sql`・`supabase/migrations/20261021221410_delivery_tracking_sync.sql`。A は表・守り・outbox・claim の列・既存 enqueue の索引との整合、B はお店・読む関数・メールの補助・返品、C は追跡。適用後は MCP が返した版へファイルと文書を直す（2026-10-22 に本番へ当て、作業中の仮の版 20261022100000・20261022100100・20261022100200 から、当てた版 20261021220816・20261021221140・20261021221410 へ直した） | 関数の依存順で分ける。最新の適用済み E-3 段2の3本を元にし、過去の移行を直さない |
| P2 | outbox に `tracking_version integer`・`tracking_change_id uuid` を足す。配達中・配達済みは `(fulfillment_id, tracking_version, kind)`、発送の更新は `(tracking_change_id)` の部分一意索引。既存の `order_email_outbox_auto_once_idx` から新3種類も外し、`private.enqueue_order_email` の最後の `ON CONFLICT` の述語を同じ字へ直す（C-0） | 段2 P12 と同じ。注文ごとの索引が残ると2発送目・次の版のメールが落ちる |
| P3 | 手で配達済みの二重防止は `order_fulfillment_events` の `request_key`・`request_fingerprint`、番号の直しは tracking_changes の同名2列に持つ。発送の作成は fulfillment に不変の `request_fingerprint` を足して比較する。列は古いSQLのfixtureとの互換のためnullable、新しい作成関数は必ず入れる | 番号・notify は後から変わるので、現在値と作成時の再送を比べる今の方法を保てない（現コード `20261013001143_order_return_receipts.sql:1620`）。既存のSQL fixtureを一斉に変更しない |
| P4 | 配送業者・番号がともに同じ修正は、メールのチェックだけ違っても `DELIVERY_TRACKING_UNCHANGED`。通知の選択は番号・業者の直しに伴って変える。空白は route が trim、保存は入力の大小を残し、外への送信・照合だけ大文字 | 4-6 の「同じ値は断る」に合わせる。通知だけで配達済みと期限を消す操作を作らない。番号の表示をむやみに変えない |
| P5 | toggle の PUT は `deliveryTracking?: { enabled: boolean }`。既存の2つの必須 boolean と任意の `returns` は維持。GET/PUT は `deliveryTracking: DeliveryTrackingSettings` を返し、`keyConfigured` は空白を除いた鍵の有無だけ、`backfillCount` は登録行の無い対象の正確な集計 | 既存の設定の形に従い、鍵を返さず確かめの件数を用意する |
| P6 | ON の鍵の確認は、返品・既存トグルを含む保存より前。保存は既存の返品 → 既存トグル → 配送の順の別取引。途中の失敗は保存済みのまとまりだけ監査に残し、画面は GET し直す。確かめの件数は GET の時点の数、PUT の `backfilledCount` が実数 | 既存の部分保存の扱いを保つ。GET と PUT の間の新しい発送で件数が変わりうる |
| P7 | 再オンの時は、取り込みの条件（取消でない・配達済みでない・`expires_at>now()`・3社と番号のある現版）に合う発送のうち、その版の行が無い物は新しく `pending` を作り、`stop_reason='disabled'` で止まっている行は**同じ行を** `pending` に戻す（`stop_reason`・`stopped_at`・`failure_kind`・lease を空、`attempts=0`・`read_attempts=0`・`retry_allowed=true`・`next_run_at=now()`、`ever_registered`・`registered_at` は保つ）。`expires_at` は元の値のまま。ほかの理由で止まった行（delivered/expired/replaced/cancelled/provider_stopped）は戻さない。`backfillCount` は両方を数える。確認文は仕様のまま | 設計書 4-4「設定をオフにして止めた `disabled` の行は同じ行を `pending` に戻す」（2026-10-21 に controller が意図を明記）。オフにしてからオンに戻した店で、途中の荷物の追跡が自然に再開するように。オフの時に 17TRACK へ止める呼び方を送っていないので、登録は「もう登録してある」で成功になる（Task 2 で固定） |
| P8 | claim は通常の `pending/registered` に加え、期限内で再試行可能な `failed/repeated_error` の日次の行も対象。`retry_allowed` 列で -18019905 を除く。停止の外への呼び出しは同じ登録表の `provider_stop_pending` で持ち、1度試して終える | 4-6 の借りる説明だけでは5-1の日次回復が実現しないため、5-1を満たす。停止の失敗で管理操作を巻き戻さない |
| P9 | 同じ組を外で同時に触らないよう、claim はその組に有効な lease があれば渡さない。注文の鍵 → 発送の鍵の後、組の advisory transaction lock を配送業者・大文字の番号の順で取る。停止前にほかの止めていない行を再確認し、呼び終えるまで同じ組の登録を借りない | 共有する番号と stop/register のすれ違いを防ぐ。DB の取引を HTTP の間は開かない |
| P10 | `signal_revision` と claim 時の写し、`stop_signaled` を登録表に持つ。結果を書いた時に合図の番号が進んでいたら `next_run_at=now()`。STOPPED の合図は読み直し成功後にだけ `provider_stopped` へ進める | 借りている間の知らせを、6時間後の予定で上書きしない |
| P11 | worker の1回は8秒、HTTP は `min(2500ms, 残り)`、残り500msで新しい処理を始めない。毎分の残りは開始から60秒のうち後段用15秒を除いた値。Stripe の35秒とメールの10秒を削らず、残り3秒未満なら skip の心拍 | 既存の点検とメール配信の見回りに約13秒を要する現コードを保つ。急ぎの `after()` は単独で8秒使う |
| P12 | 1つの API 呼び出しは40件まで、同じ処理では開始の間隔を334ms以上にする。同時 worker 間は `private.delivery_tracking_provider_gate` の1行を関数で借り、毎秒3回の枠を DB で守る（C-0/C-1） | 複数の `after()` と毎分の worker が同時でも provider の制限を超えないための補助の表 |
| P13 | 運用の知らせは種類ごとに86400秒で `claimAlert`、失敗なら `releaseAlert`。署名401は10分に5回、読み直しの一時の失敗は連続5回で知らせる。未知の状態も1日1回。心拍が15分止まれば知らせる | 設計書の「続く時」「運用の知らせ」の閾値を決める。今の `sendOnce` の1時間を配送に流用しない |
| P14 | 17TRACK の見本は `tests/fixtures/17track/v2.4.json` の1ファイルと README。fake は `scripts/e2e/fake-17track.mjs`、`127.0.0.1:4017` のみ。既存 `scripts/e2e-server.mjs` が fake の印を確かめてから起こし、その後 build/start する | どの試験も付録と同じ形を読む。fake の別プロセスはテスト後も E2E のアプリと一緒に使える |
| P15 | E2E の見張りは接続先の省略（本番への fallback）・本番・非 loopback・ユーザー情報つき URL・別 path を拒否。安全な接続先へ上書きする前にも明示の unsafe 値を拒否。fake 鍵へ上書きし URL・fake 契約版を fingerprint に足す。直接起動の `e2e-server.mjs` でも同じ条件を確かめる | 現コードは2か所で見張る（`environment.ts:87`、`e2e-server.mjs:51`）。本番の鍵と URL を受け継がせない |
| P16 | 管理画面の履歴は既存の `fulfillment` 行に現在値と registration を付け、出来事は `delivery_event`、番号の直しは `tracking_change` の独立した行にする。登録の状態は現在値だけで、登録の毎回の失敗を履歴の行にしない | 出来事と番号の直しは追記の表、登録は予定の現在値という設計に合わせる。番号の直しのメールの状態も返す |
| P17 | 顧客用・管理用・worker 用の読み出しを分ける。進み具合は注文ごとの集計関数、出来事は注文1件の jsonb で返す。1000件の PostgREST の切れを検出して、切れた答えから配達済みを判定しない | 既存 `listOrderLineFulfillment` の200注文単位・1000行未満の守りに従う |
| P18 | 登録の最初の5回は、最初を即時、失敗した時点から5分・15分・1時間・6時間、5回目の失敗の後は24時間。口座の失敗は6時間後へ置き、attempts は据え置き。読み直しの失敗数は登録の attempts と別の `read_attempts` | 「5回」の間隔を一意にし、口座の失敗や普通の読み直しが登録の5回を使わないようにする |
| P19 | 同じ状況・同じ条件の読み直しでは、手で閉じた要対応を開き直さない。異なる状況に移ってから同じ条件に戻った時、新しい版、情報あり→なしの新しい条件だけ開き直す | 4-5 の「もう一度起きたら」を、毎回の見回りと区別する。直す・取消・配達済み・オフは開いた全行を閉じる |
| P20 | provider の時刻は offset 付き `time_iso`、なければ UTC の `time_utc`（`YYYY-MM-DD HH:mm:ss` は UTC として読む）。読めない時は読んだ時刻。milestone の `key_stage='Delivered'` の時刻を届いた時刻に優先し、なければ最新の出来事の時刻 | ブラウザやサーバーの地域設定で解釈を変えない。付録の場所・文・events 全件は使わない |
| P21 | 顧客の表示条件は ON かつ鍵あり、現版の登録が `registered/stopped`。配達済みとお届け日は別枠で常に返す。旧版の出来事は管理者だけ、顧客は現版だけ | 番号を直した時に別の荷物の履歴を混ぜず、7-1 の鍵なしの隠す決まりを守る |
| P22 | E2E は管理者のログイン等を今の道具で差し替え、配送操作の窓口は手元の DB の本物の RPC へ橋渡しする。追跡の HTTP・署名・メール・顧客の窓口は本物のアプリを使う。管理窓口の RBAC/CSRF/鍵なし拒否は単体で別に証明する | 既存の管理者 E2E と同じ境界。差し替えを本物の認証の証拠と呼ばない |
| P23 | Task 14 の AC 表を Task 13 より先に読み、実際の requirements への追記は Task 14。文書だけのタスクは既存の静的検証の落ちる確認を RED とする。Task 15 は新機能を作らず全体の受け入れの RED→修正→GREEN | 指定の15タスクの順と、E2E コメントの番号の正を両立する |
| P24 | ONの間に鍵が消えた時もOFFへ戻す操作は許す。画面の鍵未設定の禁止はOFF→ONに適用する | 鍵が無い店の追跡と要対応を止める道を残す。5-5の「オンにできない」と6-7の禁止をこの形で両立する |

### 突き合わせ

設計書ですでに決まった8状況・手で配達済み・2つのモードなどは再比較しない。新しい動作の決め事だけを比べる。下のリンクは設計書の出典を再利用する。外の情報を今回読み直したという意味ではない。

| 決め事 | この計画 | Shopify・業界との関係 | 出典 |
|---|---|---|---|
| P4 通知の変更 | 番号・業者の直しの時に、この先の通知も決める。同じ番号だけの操作は断る | Shopify の notifyCustomer はこの更新とこの先の更新に効く。通知だけの独立した画面は足さない | [fulfillmentTrackingInfoUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentTrackingInfoUpdate) |
| P7 再オン | 期限内の disabled の行は同じ行を pending に戻し、行の無い対象は新しく取り込む | 追跡アプリを入れ直した時に最近の注文を取り込むのと同じ考え | [17TRACK アプリ](https://apps.shopify.com/17track) |
| P13 運用の閾値 | 署名401は10分5回、読めないのは5回、各種類1日1回 | provider の送り直しを受ける前提で、店の荷物の問題と接続の問題を分ける。数はこの計画の運用上の判断 | [17TRACK の説明書](https://api.17track.net/en/doc) |
| P21 現版の履歴 | お客様には今の番号の出来事だけ | 同じ発送の trackingInfo を書き換える考えに合わせ、直す前の番号は管理者の直しの記録へ残す | [Shopify Fulfillment](https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment) |
| P24 鍵なしのOFF | ONにするには鍵を必要とし、止める方は許す | この計画の接続を止める道。追跡アプリを使う形に合わせ、使えない設定からも追跡のリンクだけへ戻せる | [Shopify の注文の追跡](https://help.shopify.com/en/manual/fulfillment/setup/order-status-page/order-tracking) |

## File Structure

表の `{a,b}` は列挙の省略表記。各 Task の **Files:** と commit は実際のパスを列挙する。

| ファイル | 責務 | タスク |
|---|---|---|
| `supabase/migrations/20261021220816_delivery_tracking_records.sql` | 表・列・守り・outbox と claim の変更 | 1 |
| `supabase/migrations/20261021221140_delivery_tracking_admin.sql` | 管理操作・読み出し・メール補助・返品の期限 | 2 |
| `supabase/migrations/20261021221410_delivery_tracking_sync.sql` | claim・結果・合図・期限・provider の枠 | 3 |
| `tests/integration/db/delivery_tracking_{records,admin,sync,postgrest}.integration.test.ts`・`helpers/delivery-tracking-fixtures.ts` | DB の契約・ロール・競合・PostgREST | 1〜4 |
| `tests/integration/db/order_fulfillments.integration.test.ts`・`order_refund_results.integration.test.ts`・`order_return_records.integration.test.ts` | 旧守り・claim列・旧期限の期待を保つ | 1〜2 |
| `src/lib/orders/tracking/delivery-types.ts`・`delivery-messages.ts`・`delivery-store.ts`・`seventeen-track-status.ts` | ブラウザ可の型と言葉、server-only の RPC、状態の表 | 4 |
| `src/lib/orders/tracking/seventeen-track-client.ts`・`seventeen-track-signature.ts`・`delivery-config.ts` | provider の HTTP・解釈・署名・設定 | 5 |
| `tests/fixtures/17track/v2.4.json`・`README.md` | 単体と fake 共通の付録の見本 | 5 |
| `src/lib/orders/tracking/delivery-worker.ts`・`delivery-schedule.ts`・`delivery-ops.ts` | 時間・再試行・急ぎの道・知らせ | 6 |
| `src/lib/stripe/webhook-worker.ts`・`src/lib/ops/ops-store.ts`・`ops-checks.ts`・`ops-alert-mail.ts` | 毎分の置き場と心拍・運用の型 | 6 |
| `src/app/api/admin/orders/[id]/fulfillments/route.ts`・`[fulfillmentId]/cancel/route.ts` | 作成・取消の急ぎの追跡の処理 | 6 |
| `src/app/api/webhook/17track/route.ts` | 本文の上限・署名・合図 | 7 |
| `src/lib/orders/email/order-email-types.ts`・`order-email-store.ts`・`order-email-compose.ts`・`order-email-worker.ts`・`order-email-delivery-material.ts`（新規） | 19種類・材料・本文・送る前の中止 | 8 |
| `src/app/api/admin/orders/[id]/emails/resend/route.ts` | 配送3種類の再送拒否 | 8 |
| `src/lib/orders/tracking/delivery-route-support.ts` | 管理操作の守り・断り・監査 | 9 |
| `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/{tracking,delivered}/route.ts`・`src/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route.ts` | 書く3つの窓口 | 9 |
| `src/app/api/admin/order-attention/route.ts`・`src/app/api/admin/orders/route.ts`・`src/app/api/admin/orders/[id]/history/route.ts`・`src/app/api/admin/settings/shop/route.ts` | 配送の一覧・履歴・設定 | 9 |
| `src/lib/orders/email/order-history.ts`・`src/lib/orders/order-payment-types.ts` | 履歴の2種類と発送の現在値、要対応の型 | 9 |
| `src/components/OrderTrackingEditDialog.tsx`・`OrderDeliveredDialog.tsx`・`src/lib/orders/tracking/delivery-client.ts` | 入力・二重防止・結果不明時の再送 | 10 |
| `src/components/OrderHistoryDialog.tsx`・`OrderSection.tsx`・`AttentionInbox.tsx`・`src/app/admin/page.tsx` | 履歴の表示・印・配送の組と接続 | 10 |
| `src/components/ShopSettingsSection.tsx` | 配送のトグル・鍵と件数・確認 | 11 |
| `src/lib/orders/order-progress.ts`・`src/app/api/orders/route.ts`・`src/app/api/orders/[id]/route.ts`・`src/app/api/admin/orders/route.ts`・`src/lib/orders/fulfillment/fulfillment-materials.ts` | 全消費先の配達済みの進み具合 | 12 |
| `src/app/account/orders/[id]/page.tsx`・`src/app/privacy/page.tsx`・`src/components/ShopReturnSettingsSection.tsx` | 発送の状況と日付、ONだけの委託の文、返品の説明 | 12 |
| `scripts/e2e/fake-17track.mjs`・`scripts/e2e/environment.ts`・`scripts/e2e-server.mjs` | fake 起動と二重の見張り | 13 |
| `e2e/delivery-tracking-test-utils.ts`・FR-ADMIN-100〜104・FR-ACCOUNT-041〜043 と既存の見本 | E2E と本物の DB への橋渡し | 13 |
| `tests/unit/lib/orders/tracking/{delivery-types,delivery-store,seventeen-track-status}.test.ts` | 型・RPC・対応表 | 4 |
| `tests/unit/lib/orders/tracking/{delivery-config,seventeen-track-client,seventeen-track-signature}.test.ts` | 付録・署名・HTTPの分類 | 5 |
| `tests/unit/lib/orders/tracking/{delivery-worker,delivery-schedule,delivery-ops}.test.ts`・`tests/unit/lib/stripe/webhook-worker.test.ts`・`tests/unit/lib/ops/{ops-store,ops-checks,ops-alert-mail}.test.ts`・`tests/unit/api/admin/order-fulfillment-routes.test.ts` | 予算・毎分・知らせ・急ぎの道 | 6 |
| `tests/unit/api/webhook/17track-route.test.ts` | 受け口の順番と本文上限 | 7 |
| `tests/unit/lib/orders/email/{order-email-types,order-email-store,order-email-compose-delivery,order-email-worker-delivery,order-email-delivery-material}.test.ts`・`tests/unit/api/admin/order-email-routes.test.ts` | 3メールの契約・コピー・中止・再送拒否 | 8 |
| `tests/unit/api/admin/{order-delivery-routes,order-attention-route,order-email-routes,shop-settings-route}.test.ts`・`tests/unit/lib/orders/email/order-history-delivery.test.ts` | 管理窓口・守り・設定・履歴 | 9 |
| `tests/unit/components/{OrderTrackingEditDialog,OrderDeliveredDialog,OrderHistoryDialog,OrderSection.actions,AttentionInbox,AdminOrderHistoryWiring}.test.tsx`・`tests/unit/lib/orders/tracking/delivery-client.test.ts` | 管理画面の操作と再送 | 10 |
| `tests/unit/components/ShopSettingsSection.test.tsx` | トグル・確認・部分保存 | 11 |
| `tests/unit/lib/orders/order-progress.test.ts`・`tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts`・`tests/unit/api/orders/{order-detail-progress,orders-list-progress}.test.ts`・`tests/unit/api/admin/orders-search-route.test.ts`・`tests/unit/components/{AccountOrderDetailPage,ShopReturnSettingsSection,PrivacyPage}.test.tsx`・`tests/integration/api/orders.test.ts` | 配達済み・射影・privacy・返品の説明 | 12 |
| `tests/unit/scripts/e2e/environment.test.ts`・`tests/unit/scripts/e2e-server-tracking.test.ts` | 二重の環境の見張り | 13 |
| `tests/unit/docs/delivery-status-traceability.test.ts` | 要求・AC・E2Eコメント・文書の対応 | 14 |
| `docs/02_Requirements/requirements.md`・API/ER/画面/状態/運用の文書・`.env.example` | Task 14 に全パスを列挙 | 14 |

## 共通の約束

### C-0 表と列

以下は名前・型・CHECK の正。新しい FK はすべて `ON DELETE RESTRICT`、した人の uuid は FK にしない（利用者を消す UPDATE と追記の守りを衝突させない）。指定の無い時刻は nullable、既定値は無い。

| 表 | 足す列・定義 |
|---|---|
| `public.shop_settings` | `delivery_tracking_enabled boolean NOT NULL DEFAULT false`、`delivery_tracking_updated_at timestamptz`、`delivery_tracking_updated_by uuid` |
| `public.order_fulfillments` | `delivery_status text NOT NULL DEFAULT 'confirmed' CHECK (delivery_status IN ('confirmed','in_transit','out_for_delivery','attempted_delivery','ready_for_pickup','delivered','delayed','failure'))`、`delivery_status_at timestamptz NOT NULL DEFAULT pg_catalog.now()`、`delivered_at timestamptz`、`tracking_version integer NOT NULL DEFAULT 1 CHECK (tracking_version >= 1)`、`request_fingerprint text`（nullable、Bで既存行を補い、新規の関数は必ず入れる） |

`delivery_status_at` は既存行を `shipped_at` に揃え、新規はBの作成関数が発送した時刻を明示する。既定はAの間の古い作成関数との互換用（同じ取引のnow）。CHECK `order_fulfillments_delivery_check`: `(delivery_status = 'delivered') = (delivered_at IS NOT NULL) AND (delivered_at IS NULL OR delivered_at >= shipped_at)`。

`private.restrict_fulfillment_record_update()` を置き換え、取消の2列だけの1回の更新は従来どおり許す（Aの間の古い取消関数も動く）。追加の配送の列は、呼ぶ側が `set_config('app.fulfillment_change', 'tracking_edit' | 'manual' | 'tracking', true)` を取引内で置き、終了時は前の値へ戻す。トリガーは SECURITY INVOKER のまま、既存 `public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)` の owner と `current_user` が同じことも必要とする（service_role が GUC を真似ても権限にならない）。固定列は `to_jsonb(NEW) - 許す列` で比較し、取消済みの変更・追跡での delivered からの戻し・飛び越した版を拒否。削除/TRUNCATE の既存トリガーは保つ。settings の配送3列も同じ owner と操作印 `app.delivery_tracking_setting='toggle'` で toggle 関数だけを許す。

`request_fingerprint` は値から別の値/NULLへ変えない。古い行でNULLの時だけ、tracking_editの関数が直す前の値とlinesから指紋を作って同じ更新で入れてよい（列の守りにもこの1回だけを足す）。

`public.order_fulfillment_events`:

| 列 | 型・決まり |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()` |
| `fulfillment_id` | `uuid NOT NULL REFERENCES public.order_fulfillments(id)` |
| `tracking_version` | `integer NOT NULL CHECK (tracking_version >= 1)` |
| `status` | `text NOT NULL`、上の8値の CHECK `order_fulfillment_events_status_check` |
| `happened_at`・`recorded_at` | `timestamptz NOT NULL`・`timestamptz NOT NULL DEFAULT pg_catalog.now()` |
| `source` | `text NOT NULL CHECK (source IN ('shipment','tracking','manual','tracking_edit'))` |
| `provider_sub_status` | `text CHECK (provider_sub_status IS NULL OR char_length(provider_sub_status) BETWEEN 1 AND 100)`（記号だけ） |
| `created_by` | `uuid` |
| `request_key`・`request_fingerprint` | `uuid`・`text`（manual だけ必須、ほかは両方 NULL） |

制約 `order_fulfillment_events_once_key UNIQUE (fulfillment_id,tracking_version,status,happened_at)`、部分一意索引 `order_fulfillment_events_manual_request_idx(request_key) WHERE request_key IS NOT NULL`、読む索引 `(fulfillment_id,tracking_version,happened_at DESC,recorded_at DESC,id)`。CHECK `order_fulfillment_events_request_check`: `(source='manual' AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL AND created_by IS NOT NULL) OR (source<>'manual' AND request_key IS NULL AND request_fingerprint IS NULL)`。UPDATE/DELETE/TRUNCATE は全拒否。

`public.order_fulfillment_tracking_changes`:

| 列 | 型・決まり |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()` |
| `fulfillment_id` | `uuid NOT NULL REFERENCES public.order_fulfillments(id)` |
| `from_carrier`・`to_carrier` | `text`・`text NOT NULL`、`yamato/sagawa/japanpost` の CHECK（from は legacy の NULL 可） |
| `from_tracking_number`・`to_tracking_number` | `text`・`text NOT NULL`、`^[0-9A-Za-z-]{1,64}$` の CHECK（from は NULL 可） |
| `tracking_version` | `integer NOT NULL CHECK (tracking_version >= 2)` |
| `notify_customer` | `boolean NOT NULL` |
| `request_key`・`request_fingerprint` | `uuid NOT NULL UNIQUE`・`text NOT NULL` |
| `changed_by`・`changed_at` | `uuid NOT NULL`・`timestamptz NOT NULL DEFAULT pg_catalog.now()` |

制約 `order_fulfillment_tracking_changes_version_key UNIQUE(fulfillment_id,tracking_version)`、索引 `(fulfillment_id,changed_at DESC)`。全行追記だけ。

`private.fulfillment_tracking_registrations`:

| 列 | 型・決まり |
|---|---|
| `fulfillment_id`・`tracking_version` | `uuid REFERENCES public.order_fulfillments(id)`・`integer CHECK (tracking_version>=1)`、ともに NOT NULL、組の PRIMARY KEY |
| `carrier`・`tracking_number` | `text NOT NULL CHECK (carrier IN ('yamato','sagawa','japanpost'))`・`text NOT NULL CHECK (tracking_number ~ '^[0-9A-Z-]{1,64}$')` |
| `state` | `text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','registered','stopped','failed'))` |
| `failure_kind` | `text CHECK (failure_kind IN ('invalid_number','repeated_error'))` |
| `expires_at` | `timestamptz NOT NULL` |
| `ever_registered`・`retry_allowed` | `boolean NOT NULL DEFAULT false`・`boolean NOT NULL DEFAULT true` |
| `stop_reason` | `text CHECK (stop_reason IN ('delivered','expired','replaced','cancelled','provider_stopped','disabled'))` |
| `next_run_at` | `timestamptz NOT NULL DEFAULT pg_catalog.now()` |
| `attempts`・`read_attempts` | `integer NOT NULL DEFAULT 0 CHECK (attempts>=0)`・`integer NOT NULL DEFAULT 0 CHECK (read_attempts>=0)` |
| `last_error_code` | `text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_-]{1,64}$')` |
| `lease_token`・`lease_expires_at` | `uuid`・`timestamptz`（片方だけ NULL は不可） |
| `provider_status`・`provider_sub_status` | `text`・`text`、各 `char_length(...) BETWEEN 1 AND 100` または NULL |
| `last_read_at`・`registered_at`・`stopped_at` | `timestamptz` |
| `signal_revision`・`claimed_signal_revision` | `bigint NOT NULL DEFAULT 0 CHECK (signal_revision>=0)`・`bigint` |
| `stop_signaled`・`provider_stop_pending` | `boolean NOT NULL DEFAULT false`・`boolean NOT NULL DEFAULT false` |
| `provider_stop_attempted_at`・`retrack_attempted_at` | `timestamptz`（外の停止とやり直しを試した記録） |

CHECK: `(state='failed') = (failure_kind IS NOT NULL)`、`(state='stopped') = (stop_reason IS NOT NULL)`、`(state='stopped') = (stopped_at IS NOT NULL)`、`(lease_token IS NULL) = (lease_expires_at IS NULL)`、`NOT ever_registered OR registered_at IS NOT NULL`。索引 `fulfillment_tracking_due_idx(next_run_at) WHERE state<>'stopped'`、`fulfillment_tracking_pair_idx(carrier,tracking_number)`、`fulfillment_tracking_stop_idx(next_run_at) WHERE provider_stop_pending`。組への UNIQUE は作らない。lease 失効は再び借りられ、削除/TRUNCATE は拒否する。

`public.order_fulfillment_attention`:

| 列 | 型・決まり |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()`（resolve の attentionId） |
| `fulfillment_id` | `uuid NOT NULL REFERENCES public.order_fulfillments(id)` |
| `kind` | `text NOT NULL CHECK (kind IN ('delivery_failure','attempted_delivery','tracking_not_found','tracking_registration_failed','tracking_stalled'))` |
| `opened_at` | `timestamptz NOT NULL DEFAULT pg_catalog.now()` |
| `resolved_at`・`resolved_by`・`resolution` | `timestamptz`・`uuid`・`text CHECK (resolution IN ('auto','manual'))` |

CHECK `order_fulfillment_attention_resolution_check`: `(resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolution IS NOT NULL AND ((resolution='auto' AND resolved_by IS NULL) OR (resolution='manual' AND resolved_by IS NOT NULL)))`。部分一意索引 `order_fulfillment_attention_open_idx(fulfillment_id,kind) WHERE resolved_at IS NULL`、索引 `(opened_at,id) WHERE resolved_at IS NULL`。更新は開いた行の resolved の3列を一度だけ。削除/TRUNCATE は拒否。

provider の枠だけの補助表 `private.delivery_tracking_provider_gate(id boolean PRIMARY KEY DEFAULT true CHECK(id), next_call_at timestamptz NOT NULL DEFAULT pg_catalog.now())`、最初の1行を作る。RLS・service_role SELECT のみ、関数だけ更新。17TRACK の情報を増やす表ではない。

outbox の変更（既存の return/refund/cancel の CHECK と索引は保つ）:

- `tracking_version integer CHECK (tracking_version>=1)`、`tracking_change_id uuid REFERENCES public.order_fulfillment_tracking_changes(id)` を追加。
- kind CHECK は現16値の末尾に `'out_for_delivery','delivered','shipping_update'` を追加。variant CHECK の `variant IS NULL` の枝にも3つを追加。
- `order_email_outbox_fulfillment_check`: `(kind IN ('shipped','out_for_delivery','delivered','shipping_update')) = (fulfillment_id IS NOT NULL)`。
- `order_email_outbox_tracking_check`: `((kind IN ('out_for_delivery','delivered','shipping_update')) = (tracking_version IS NOT NULL)) AND ((kind='shipping_update') = (tracking_change_id IS NOT NULL))`。shipping_update の id は同じ fulfillment/version の直しに属することを enqueue 関数で確かめる。
- `order_email_outbox_auto_delivery_idx`: UNIQUE `(fulfillment_id,tracking_version,kind) WHERE origin='auto' AND kind IN ('out_for_delivery','delivered')`。
- `order_email_outbox_auto_tracking_change_idx`: UNIQUE `(tracking_change_id) WHERE origin='auto' AND kind='shipping_update'`。
- `order_email_outbox_auto_once_idx` と enqueue 最後の枝の述語は、両方を次の**同じ文**へ置き換える。

```sql
WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
  AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'return_requested', 'return_declined', 'return_request_shop', 'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop', 'out_for_delivery', 'delivered', 'shipping_update')
```

`ops_job_heartbeats_job_check` は今の `webhook_worker/order_sweep/stripe_reconcile/order_email_worker/order_email_delivery_check/return_photo_purge` に `delivery_tracking` を足す。移行 A は既存の取消でない発送へ `(version=1,status='confirmed',happened_at=shipped_at,source='shipment')` の最初の出来事を1行だけ作り、登録・メールは作らない。

### C-1 DB の関数

引数に既定値を明記していない関数には既定値を足さない。jsonb のキーは C-2 の camelCase を snake_case に直した字。SQL の TABLE の答えは PostgREST では配列。呼び出しの失敗と空の答えを区別する。

| Task | 名前と引数 | 答え（列名と型） |
|---|---|---|
| 1 | `private.restrict_fulfillment_record_update()`、`private.guard_delivery_settings_update()`、`private.reject_delivery_record_change()`、`private.guard_delivery_attention_update()` | `trigger`。前者は既存を置き換え、ほかは新規 |
| 1 | `private.backfill_delivery_events()` | `integer`（足した行数）。取消でない発送のversion1/confirmed/shipmentをON CONFLICT DO NOTHINGで足す。Aが1回呼ぶ |
| 1 | `private.enqueue_order_email(_order_id uuid,_kind text,_variant text DEFAULT NULL,_fulfillment_id uuid DEFAULT NULL,_refund_id uuid DEFAULT NULL)` | `boolean`。最新段2 D の本文から述語だけを直す |
| 1 | `public.claim_order_email(_lease_seconds integer)` | 既存15列 `email_id uuid,order_id uuid,kind text,variant text,origin text,attempts integer,lease_token uuid,subject text,body_text text,payment_expired_sent boolean,fulfillment_id uuid,refund_id uuid,return_id uuid,return_receipt_id uuid,cancel_request_id uuid` の末尾に `tracking_version integer,tracking_change_id uuid`。DROP→CREATE、権限を戻す |
| 2 | `public.admin_create_fulfillment(_order_id uuid,_actor_id uuid,_request_key uuid,_shipping_carrier text,_tracking_number text,_notify_customer boolean,_lines jsonb)` | 既存と同じ `TABLE(fulfillment_id uuid,number integer,completes_order boolean,order_status public.order_status,replayed boolean)` |
| 2 | `public.admin_cancel_fulfillment(_order_id uuid,_fulfillment_id uuid,_actor_id uuid)` | 既存と同じ `TABLE(outcome text,order_status public.order_status)` |
| 2 | `public.admin_update_fulfillment_tracking(_order_id uuid,_fulfillment_id uuid,_actor_id uuid,_request_key uuid,_shipping_carrier text,_tracking_number text,_notify_customer boolean)` | `TABLE(tracking_change_id uuid,tracking_version integer,replayed boolean)` |
| 2 | `public.admin_mark_fulfillment_delivered(_order_id uuid,_fulfillment_id uuid,_actor_id uuid,_request_key uuid,_delivered_on date,_notify_customer boolean)` | `TABLE(event_id uuid,delivered_at timestamptz,replayed boolean)` |
| 2 | `public.admin_set_delivery_tracking(_enabled boolean,_actor_id uuid)` | `TABLE(enabled boolean,updated_at timestamptz,updated_by uuid,backfilled_count integer)` |
| 2 | `public.admin_resolve_delivery_attention(_attention_id uuid,_actor_id uuid)` | `TABLE(outcome text)`、`resolved/already_resolved`（通信切れの再送を安全にする） |
| 2 | `private.enqueue_delivery_email(_fulfillment_id uuid,_tracking_version integer,_kind text,_tracking_change_id uuid DEFAULT NULL)` | `boolean`。許す種類は新3つ、variant NULL、通知条件を確かめる |
| 2 | `private.fulfillment_line_returnable(_order_id uuid)` | 既存と同じ `TABLE(fulfillment_id uuid,fulfillment_number integer,shipped_at timestamptz,order_item_id uuid,quantity integer,in_returns integer,missing integer,returnable integer,deadline_date date)` |
| 2 | `public.get_delivery_tracking_settings()` | `TABLE(enabled boolean,updated_at timestamptz,updated_by_email text,backfill_count integer)` |
| 2 | `private.delivery_tracking_backfill_targets()` | `TABLE(fulfillment_id uuid,tracking_version integer,expires_at timestamptz)`。設定の件数とONの取り込みが同じSELECTを使う |
| 2 | `public.list_order_delivery_summaries(_order_ids uuid[])` | `TABLE(order_id uuid,active_count integer,delivered_count integer,attention_kind text)`（空の注文も0、200注文まで） |
| 2 | `public.get_order_delivery_detail(_order_id uuid)` | `jsonb`、C-2 `OrderDeliveryDetail`。存在しない注文は `ORDER_NOT_FOUND` |
| 2 | `public.list_delivery_attention(_limit integer)` | `jsonb`、`{items: DeliveryAttentionItem[],total: number}` の snake_case（1〜100、全体の件数は limit 前の COUNT） |
| 2 | `public.skip_order_email(_email_id uuid,_lease_token uuid,_reason text)` | 既存の `boolean`。最新段1 C を元に `superseded/fulfillment_cancelled` の許す条件だけ拡張 |
| 3 | `public.claim_delivery_tracking(_limit integer,_lease_seconds integer)` | `TABLE(fulfillment_id uuid,tracking_version integer,carrier text,tracking_number text,action text,lease_token uuid,signal_revision bigint,attempts integer,read_attempts integer,expires_at timestamptz)` |
| 3 | `public.record_delivery_registration_result(_fulfillment_id uuid,_tracking_version integer,_lease_token uuid,_outcome text,_error_code text)` | `TABLE(applied boolean,state text)`。outcome は `registered/invalid_number/transient/account/retrack_exhausted` |
| 3 | `public.record_delivery_read_result(_fulfillment_id uuid,_tracking_version integer,_lease_token uuid,_result jsonb)` | `TABLE(applied boolean,changed boolean,stopped boolean)`。JSON は下の `DeliveryReadResult` の snake_case |
| 3 | `public.signal_delivery_tracking(_signals jsonb)` | `integer`（合う登録行の数）。各 `{carrier: 100062|100040|10021,number: string,event: 'TRACKING_UPDATED'|'TRACKING_STOPPED'}` |
| 3 | `public.expire_delivery_tracking(_limit integer)` | `integer`（止めた行数、1〜1000）。workerはONかつ鍵ありの時だけ呼ぶ |
| 3 | `public.record_delivery_stop_result(_fulfillment_id uuid,_tracking_version integer,_lease_token uuid,_succeeded boolean,_error_code text)` | `boolean`（借りた行に結果を書けたか）。1回で pending を外す |
| 3 | `public.take_delivery_provider_slot()` | `integer`（待つ ms、0 は今呼べる）。1行の鍵で次の開始を334ms後へ予約。待ちが予算より長ければ HTTP を始めない |
| 3 | `private.set_delivery_attention(_fulfillment_id uuid,_kind text,_open boolean)` | `void`。P19 の新しい条件の時だけ呼ぶ |

`get_order_delivery_detail` は最終の呼び出し元が本人の確認済みであることを前提とする service_role 専用。顧客の route は先に owner と隠す注文の状態を確かめ、管理者の route は権限を確かめる。顧客へそのまま jsonb を返さない。

### C-2 TS の部品

`src/lib/orders/tracking/delivery-types.ts`（ブラウザ可。時刻と uuid は string、日付は `YYYY-MM-DD` の string）:

```ts
export type DeliveryStatus = 'confirmed' | 'in_transit' | 'out_for_delivery' | 'attempted_delivery' | 'ready_for_pickup' | 'delivered' | 'delayed' | 'failure';
export type DeliveryEventSource = 'shipment' | 'tracking' | 'manual' | 'tracking_edit';
export type DeliveryAttentionKind = 'delivery_failure' | 'attempted_delivery' | 'tracking_not_found' | 'tracking_registration_failed' | 'tracking_stalled';
export type TrackingState = 'pending' | 'registered' | 'stopped' | 'failed';
export type TrackingFailureKind = 'invalid_number' | 'repeated_error';
export type TrackingStopReason = 'delivered' | 'expired' | 'replaced' | 'cancelled' | 'provider_stopped' | 'disabled';
export type TrackingAction = 'register' | 'retrack' | 'read' | 'stop';
export type DeliveryTrackingSettings = { enabled: boolean; updatedAt: string | null; updatedByEmail: string | null; keyConfigured: boolean; backfillCount: number };
export type DeliveryEvent = { id: string; trackingVersion: number; status: DeliveryStatus; happenedAt: string; recordedAt: string; source: DeliveryEventSource; providerSubStatus: string | null; actorEmail: string | null };
export type TrackingChange = { id: string; fromCarrier: string | null; fromTrackingNumber: string | null; toCarrier: ShippingCarrierId; toTrackingNumber: string; trackingVersion: number; notifyCustomer: boolean; changedAt: string; actorEmail: string | null; emailStatus: OrderEmailStatus | null };
export type DeliveryRegistration = { state: TrackingState; failureKind: TrackingFailureKind | null; stopReason: TrackingStopReason | null; expiresAt: string };
export type FulfillmentDeliveryDetail = { fulfillmentId: string; number: number; carrier: string | null; trackingNumber: string | null; notifyCustomer: boolean; shippedAt: string; cancelledAt: string | null; trackingVersion: number; deliveryStatus: DeliveryStatus; deliveryStatusAt: string; deliveredAt: string | null; deliveredSource: 'tracking' | 'manual' | null; registration: DeliveryRegistration | null; events: DeliveryEvent[]; trackingChanges: TrackingChange[] };
export type OrderDeliveryDetail = { enabled: boolean; fulfillments: FulfillmentDeliveryDetail[] };
export type OrderDeliverySummary = { activeCount: number; deliveredCount: number; attentionKind: DeliveryAttentionKind | null };
export type DeliveryAttentionItem = { id: string; orderId: string; orderNumber: string; fulfillmentId: string; fulfillmentNumber: number; kind: DeliveryAttentionKind; openedAt: string; status: DeliveryStatus };
export type UpdateTrackingInput = { orderId: string; fulfillmentId: string; actorId: string; requestKey: string; carrier: ShippingCarrierId; trackingNumber: string; notifyCustomer: boolean };
export type UpdateTrackingResult = { trackingChangeId: string; trackingVersion: number; replayed: boolean };
export type MarkDeliveredInput = { orderId: string; fulfillmentId: string; actorId: string; requestKey: string; deliveredOn: string; notifyCustomer: boolean };
export type MarkDeliveredResult = { eventId: string; deliveredAt: string; replayed: boolean };
export type TrackingClaim = { fulfillmentId: string; trackingVersion: number; carrier: ShippingCarrierId; trackingNumber: string; action: TrackingAction; leaseToken: string; signalRevision: number; attempts: number; readAttempts: number; expiresAt: string };
export type RegistrationOutcome = 'registered' | 'invalid_number' | 'transient' | 'account' | 'retrack_exhausted';
export type DeliveryReadResult = { outcome: 'ok' | 'not_found' | 'not_registered' | 'invalid_number' | 'transient' | 'account'; status: DeliveryStatus | null; providerStatus: string | null; providerSubStatus: string | null; happenedAt: string | null; deliveredAt: string | null; readAt: string; errorCode: string | null };
export type TrackingSignal = { carrier: 100062 | 100040 | 10021; number: string; event: 'TRACKING_UPDATED' | 'TRACKING_STOPPED' };
export type CustomerDelivery = { status: DeliveryStatus; statusAt: string; events: Array<{ status: DeliveryStatus; happenedAt: string }> };
export type DeliveryCallResult<T> = { kind: 'ok'; data: T } | { kind: 'blocked' | 'refused'; message: string } | { kind: 'unknown' };
```

上の `ShippingCarrierId` は既存 shipping-carriers、`OrderEmailStatus` は既存 order-email-types の type import。対応する値の配列 `DELIVERY_STATUSES`・`DELIVERY_EVENT_SOURCES`・`DELIVERY_ATTENTION_KINDS`・`TRACKING_STATES`・`TRACKING_FAILURE_KINDS`・`TRACKING_STOP_REASONS` を同じ順で export。

`delivery-store.ts` は `import 'server-only'`、`DeliveryStore = Pick<SupabaseClient,'rpc'>`。断りは `DeliveryOperationError(readonly code: DeliveryErrorCode)`、DB/不正な答えは `DeliveryStoreError(readonly operation: string, readonly code: string | null)`。本文は保持してもログには名前と記号だけ。

```ts
export function updateFulfillmentTracking(store: DeliveryStore, input: UpdateTrackingInput): Promise<UpdateTrackingResult>;
export function markFulfillmentDelivered(store: DeliveryStore, input: MarkDeliveredInput): Promise<MarkDeliveredResult>;
export function setDeliveryTracking(store: DeliveryStore, input: { enabled: boolean; actorId: string }): Promise<{ enabled: boolean; updatedAt: string | null; updatedBy: string | null; backfilledCount: number }>;
export function resolveDeliveryAttention(store: DeliveryStore, input: { attentionId: string; actorId: string }): Promise<{ outcome: 'resolved' | 'already_resolved' }>;
export function getDeliveryTrackingSettings(store: DeliveryStore): Promise<Omit<DeliveryTrackingSettings,'keyConfigured'>>;
export function listOrderDeliverySummaries(store: DeliveryStore, orderIds: readonly string[]): Promise<Map<string,OrderDeliverySummary>>;
export function getOrderDeliveryDetail(store: DeliveryStore, orderId: string): Promise<OrderDeliveryDetail>;
export function listDeliveryAttention(store: DeliveryStore, limit: number): Promise<{ items: DeliveryAttentionItem[]; total: number }>;
export function claimDeliveryTracking(store: DeliveryStore, input: { limit: number; leaseSeconds: number }): Promise<TrackingClaim[]>;
export function recordDeliveryRegistrationResult(store: DeliveryStore, claim: TrackingClaim, outcome: RegistrationOutcome, errorCode: string | null): Promise<{ applied: boolean; state: TrackingState }>;
export function recordDeliveryReadResult(store: DeliveryStore, claim: TrackingClaim, result: DeliveryReadResult): Promise<{ applied: boolean; changed: boolean; stopped: boolean }>;
export function signalDeliveryTracking(store: DeliveryStore, signals: TrackingSignal[]): Promise<number>;
export function expireDeliveryTracking(store: DeliveryStore, limit: number): Promise<number>;
export function recordDeliveryStopResult(store: DeliveryStore, claim: TrackingClaim, succeeded: boolean, errorCode: string | null): Promise<boolean>;
export function takeDeliveryProviderSlot(store: DeliveryStore): Promise<number>;
```

`seventeen-track-status.ts` は `SEVENTEEN_TRACK_CARRIERS = {yamato:100062,sagawa:100040,japanpost:10021} as const`、`mapSeventeenTrackStatus(status:string,subStatus:string|null): DeliveryStatus | 'not_found' | null`（null は未知、今の値を保つ）。対応の正は Task 4 の表。

`delivery-config.ts`: `readDeliveryTrackingConfig(env:NodeJS.ProcessEnv): {apiKey:string|null;baseUrl:string}`。鍵は trim した空を null、URL は末尾 `/` を除く。公開用は `isDeliveryTrackingKeyConfigured(env): boolean` のみ。

```ts
// seventeen-track-client.ts。外へ渡す Pair はこの2項目だけ。
export type ProviderPair = { number: string; carrier: 100062 | 100040 | 10021 };
export type ProviderItemResult = { pair: ProviderPair; outcome: RegistrationOutcome | 'not_registered' | 'not_found' | 'stopped'; errorCode: string | null; read: DeliveryReadResult | null };
export type ProviderCallOptions = { timeoutMs?:number };
export type SeventeenTrackClient = { register(pairs:ProviderPair[],options?:ProviderCallOptions):Promise<ProviderItemResult[]>; retrack(pairs:ProviderPair[],options?:ProviderCallOptions):Promise<ProviderItemResult[]>; getTrackInfo(pairs:ProviderPair[],options?:ProviderCallOptions):Promise<ProviderItemResult[]>; stopTrack(pairs:ProviderPair[],options?:ProviderCallOptions):Promise<ProviderItemResult[]> };
export function createSeventeenTrackClient(input:{apiKey:string;baseUrl:string;fetch:typeof fetch;timeoutMs:number;now:()=>Date}):SeventeenTrackClient;
// seventeen-track-signature.ts
export function verifySeventeenTrackSignature(raw:Uint8Array, sign:string|null, key:string):boolean;
export function parseTrackingSignals(value:unknown):TrackingSignal[];
// delivery-worker.ts
export const DELIVERY_TRACKING_BUDGET_MS = 8000;
export const DELIVERY_TRACKING_MIN_BUDGET_MS = 3000;
export const DELIVERY_TRACKING_POLL_SECONDS = 21600;
export type DeliveryWorkerResult = { registered:number; read:number; stopped:number; expired:number; stoppedBy:'empty'|'budget'|'disabled'|'key_missing'|'error' };
export type DeliveryWorkerDeps = { store:DeliveryStore; provider:SeventeenTrackClient; now:()=>number; wait:(ms:number)=>Promise<void>; report:(kind:DeliveryOpsKind)=>Promise<void> };
export function processDeliveryTracking(deps:DeliveryWorkerDeps, options:{budgetMs:number}):Promise<DeliveryWorkerResult>;
export function runDeliveryTrackingWorker(options?:{budgetMs?:number}):Promise<DeliveryWorkerResult>;
// delivery-schedule.ts
export function scheduleDeliveryTracking():void;
// delivery-ops.ts
export type DeliveryOpsKind = 'account_error'|'key_missing'|'signature_invalid'|'read_failed'|'unknown_status';
export function reportDeliveryTrackingIssue(store:OpsStore, kind:DeliveryOpsKind):Promise<void>;
```

worker は登録/読み直しの間隔を DB に任せ、外への HTTP 直前に枠を取る。配列の結果を（carrier, upper(number)）へ照合し、欠けた・重複して矛盾した答えは `transient`（推測で成功にしない）。`signalRevision` は JS の安全な整数の範囲を検査する。

`getTrackInfo` の全項目は `read` を必ず持つ（他3操作だけnull）。拒否の項目も `not_registered/not_found/invalid_number/transient/account` のoutcome、readAt、errorCodeを入れ、status/happenedAt/deliveredAtはnullにする。register/retrack/stopの結果はread=null。

履歴（Task 9、`order-history.ts`）: `OrderHistoryFulfillmentEntry` に任意の `delivery?: FulfillmentDeliveryDetail` を足す。新しい union は `OrderHistoryDeliveryEventEntry = {type:'delivery_event';at:string;fulfillmentId:string;number:number;event:DeliveryEvent}`、`OrderHistoryTrackingChangeEntry = {type:'tracking_change';at:string;fulfillmentId:string;number:number;change:TrackingChange}`。`BuildOrderHistoryInput.delivery?: OrderDeliveryDetail`。返す route は必ず現在の delivery を渡す。既存の見本に無い場合だけ無しとして読む。

`OrderAttention` に `deliveries?: DeliveryAttentionItem[]`・`counts.deliveries?: number`、管理注文の行に `deliveryAttention?: 'failure'|'attempted_delivery'|'untrackable'|null`。窓口は必ず返す。任意なのは Task 10/13 前の見本とコミット時の型を保つため。

実装後の追加型（Task 10・12のレビューによる記録）:

- `OrderHistoryResponse.deliveryTrackingEnabled?: boolean`: 管理履歴の追跡オン・オフ。無い古い見本はオフとして扱う。
- `DeliveryDialogProps.onUncertain?: () => void`: 結果不明を一度でも経た後、履歴を読み直すための通知。
- `DeliveryRegistration.everRegistered: boolean`: 一度でも登録できたか。お客様の状況はregistered、またはstoppedかつtrueの時だけ返す。

### C-3 窓口

書く管理窓口は未知キーを拒否し、uuid・carrier・trim後 `^[0-9A-Za-z-]{1,64}$`・boolean・実在する日付を検査。認証と CSRF の前に DB を読まない。rate limit は送信元と `subject:authz.userId` の両方。

| method/path | 権限・CSRF | 回数（各送信元・各管理者） | request → response |
|---|---|---|---|
| POST `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking` | `admin.orders.manage`・あり | `admin:orders:fulfillment-tracking`、60回/600秒 | `{requestKey,carrier,trackingNumber,notifyCustomer}` → `{data:UpdateTrackingResult}` |
| POST `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered` | 同上 | `admin:orders:fulfillment-delivered`、30回/600秒 | `{requestKey,deliveredOn:'YYYY-MM-DD',notifyCustomer}` → `{data:MarkDeliveredResult}` |
| POST `/api/admin/order-attention/deliveries/[attentionId]/resolve` | 同上 | `admin:orders:delivery-resolve`、60回/600秒 | `{}` → `{data:{outcome:'resolved'|'already_resolved'}}` |
| GET `/api/admin/order-attention` | `admin.orders.read`・なし | 既存どおり | 既存 data に `deliveries:DeliveryAttentionItem[]` と `counts.deliveries:number` |
| GET `/api/admin/orders` | 既存どおり | 既存どおり | 行に `deliveryAttention`。DB 状態の絞り込みは変えない |
| GET `/api/admin/orders/[id]/history` | `admin.orders.read`・なし | 既存どおり | C-2 の履歴を追加、`Cache-Control:no-store` |
| GET `/api/admin/settings/shop` | `admin.settings.manage`・なし | なし | 既存 data に `deliveryTracking:DeliveryTrackingSettings`、no-store |
| PUT `/api/admin/settings/shop` | `admin.settings.manage`・あり | 既存 `admin:settings:shop-update`、30回/600秒 | 既存の必須2 toggle＋任意 returns＋`deliveryTracking?:{enabled:boolean}` → GETと同じ data、配送を渡した時だけ `backfilledCount:number` も data に追加 |
| GET `/api/orders/[id]` | 既存のお客様・本人だけ | 既存どおり | 各 shipment に `deliveredAt:string|null`。条件に合う時だけ `delivery:CustomerDelivery`（合わない時はキー無し）。cancelled は返さない |
| GET `/api/orders` | 既存どおり | 既存どおり | 既存 progress の `delivered` を選べる |
| POST `/api/webhook/17track` | 署名、認証・CSRFなし | アプリの送信元制限は足さない | object または配列 → `{received:true}`、順と HTTP は Global Constraints |

新3操作の成功後はメール worker を起こす。番号の直しは追跡 worker も起こす（再送成功でも可、DB の claim が重複を防ぐ）。監査 action は `admin.orders.fulfillment.tracking_update`・`admin.orders.fulfillment.delivered`・`admin.orders.delivery_attention.resolve`。番号の直しの metadata は fulfillmentId・trackingVersion・carrier・trackingNumber・notifyCustomer・replayed、配達済みは fulfillmentId・deliveredOn・replayed、resolve は attentionId・outcome。設定の action は今の `admin.settings.shop.update` に配送の boolean と件数だけ追加。

### C-4 誤りの記号と言葉

`DeliveryErrorCode` は表の記号の和、`DELIVERY_ERROR_MESSAGES:Record<DeliveryErrorCode,{status:400|404|409;message:string}>`。DB の ERRCODE は見つからない時 `P0002`、引数 `22023`、不変の守り `55000`、CHECK `23514`。raw message を返さない。

| 記号 | HTTP | 言葉 |
|---|---|---|
| `ORDER_NOT_FOUND` | 404 | 注文が見つかりません。 |
| `FULFILLMENT_NOT_FOUND` | 404 | 発送の記録が見つかりません。 |
| `DELIVERY_ARGUMENT_INVALID` | 400 | 入力を確かめてください。 |
| `DELIVERY_REQUEST_MISMATCH` | 409 | 操作の内容が変わりました。画面を開き直してください。 |
| `DELIVERY_FULFILLMENT_CANCELLED` | 409 | 取り消した発送は変更できません。 |
| `DELIVERY_TRACKING_UNCHANGED` | 409 | 配送業者か伝票番号を直してください。 |
| `DELIVERY_ALREADY_DELIVERED` | 409 | すでに配達済みです。履歴を読み直してください。 |
| `DELIVERY_DATE_INVALID` | 400 | 届いた日は、発送の日から今日までの日を選んでください。 |
| `DELIVERY_TRACKING_KEY_MISSING` | 409 | 17TRACK の鍵を設定してください。 |
| `DELIVERY_ATTENTION_NOT_FOUND` | 404 | 配送の要対応が見つかりません。 |

鍵なしはアプリの断りで DB のエラーではない。新しい表の追記拒否は `DELIVERY_RECORD_APPEND_ONLY`、不変列は `DELIVERY_RECORD_IMMUTABLE`。管理窓口の500は `配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。`、読み出し500は `配送の記録を読み込めませんでした。`。顧客の owner-safe 404 `{error:'Order not found'}`、既存認証/CSRF/429の本文は変えない。画面の429の案内は `しばらくしてから、もう一度お試しください。`。

### C-5 画面の文言

設計書にある文はそのまま、ほかの文はこの表で決める。句点を足し引きしない。日時は日本時間の年月日と時分、届いた日は `M月D日`。

| 所 | 文言 |
|---|---|
| 8つの状況 | `受付済み`・`輸送中`・`配達中`・`不在で持ち帰り`・`受け取り待ち`・`配達済み`・`遅れ`・`問題あり` |
| 登録 | `登録待ち`・`追跡中`・`止めた`・`登録できない`、届いた出どころ `追跡`・`手で` |
| 履歴 | `配送の状況（{n}回目）`、`最後の更新 {日時}`、`お届け日 {M月D日}（追跡）`／`（手で）`、`伝票番号を直した（{n}回目）`、`{前の配送業者} {前の番号} → {新しい配送業者} {新しい番号}`、前の値が空なら `記録なし`、`お客様へのメール：送信済み`／`送信待ち`／`送らない`／`送れなかった` |
| 直す画面 | 題とボタン `伝票番号を直す`、欄 `配送業者`・`伝票番号`、チェック `お客様に発送の更新のメールを送る`、閉じる `戻る`、保存中 `保存しています…`、成功 `伝票番号を直しました。` |
| 直す（ON） | `直すと配送の状況は受付済みに戻り、新しい伝票番号で追跡します。チェックを外すと、この先の配達中・配達済みのメールも送りません` |
| 直す（OFF） | `チェックを外すと、この先の配達済みのメールも送りません` |
| 配達済みの番号の直し | `配達済みの記録が消え、返品の期限は新しい届いた日から数え直します` |
| 配達済みの画面 | 題とボタン `配達済みにする`、欄 `届いた日`、チェック `お客様に配達済みのメールを送る`、成功 `配達済みにしました。`、戻る・保存中は直す画面と同じ |
| 配達済み（OFF） | `お客様に届いたことが分かった時に使います。返品の期限は、この日から数えます` |
| 配達済み（ON） | `追跡で配達済みにならない時に使います。この後、この伝票番号の追跡は止まります` |
| 入力の誤り | `配送業者を選んでください。`・`伝票番号は英数字とハイフンで1〜64字にしてください。`、日付は C-4 |
| 結果不明 | `結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。`、ボタン `もう一度確かめる` |
| 一覧の印 | 優先順 `問題あり`・`不在で持ち帰り`・`追跡できない`、発送済みの絞り込み `発送済み（配送中・配達済み）` |
| 配送の要対応 | 組 `配送`、数 `配送 {n}件`、種類 `問題あり`・`不在で持ち帰り`・`伝票番号で荷物が見つからない`・`追跡の登録ができない`・`配達済みにならない`、行 `注文番号 {注文番号}・{n}回目の発送`、ボタン `履歴を開く`・`対応済みにする`、成功 `対応済みにしました。` |
| 設定 | 見出し `配送の追跡`、トグル `配送の追跡（17TRACK）を使う`、`鍵：設定済み`／`鍵：未設定`、未設定 `17TRACK の鍵を設定してください`、`最後の変更：{日時}・{人}`（人が空なら `不明`、時刻が空なら行を出さない） |
| 設定の説明1 | `オンにすると、発送した荷物の配送状況（配達中・配達済みなど）を 17TRACK から受け取り、お客様の注文の画面に出し、配達中・配達済みのメールを送ります。17TRACK には配送業者と伝票番号だけを渡します` |
| 設定の説明2 | `17TRACK の利用料がかかります（最初の200件は無料。その後は年払い）。佐川急便の荷物は、佐川急便の追跡が止まっている間は追えません` |
| 設定の説明3 | `オフの間も、伝票番号の直しと、手で配達済みにすることはできます` |
| ON確認 | 題 `配送の追跡を使う`、`30日以内に発送した配達済みでない発送（{N}件）も 17TRACK に登録します。1件ごとに 17TRACK の件数を使います`、ボタン `オンにする`・`戻る` |
| OFF確認 | 題 `配送の追跡を止める`、`追跡を止め、配送の要対応を閉じます。記録した配送状況は残ります`、ボタン `オフにする`・`戻る` |
| 設定の失敗 | `設定を保存できませんでした。現在の設定を読み直しました。`、件数の再取得中は `件数を確かめています…` |
| お客様 | `配達済み`・`お届け日 {M月D日}`・`最後の更新 {日時}`・`配送の移り変わり`、問題あり/遅れ `配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください`。伝票番号とリンクの既存の文は維持 |
| 返品の目安の説明 | `配達済みの記録が無い発送は、発送の日に目安の日数を足した日を届いた日とみなします` |
| privacy の委託の一覧（ONだけ） | `配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）` |
| メールの履歴の種類名 | `配達中のお知らせ`・`配達済みのお知らせ`・`発送の更新`（既存の履歴が `のメール` を付ける） |

### C-6 メールの文言

既存 `greeting`・`formatShipmentItemLines`・`contactLine`・`SHOP_NAME` を使う。以下の順に行を並べ、`空行` は空文字1行、末尾は店名（勝手に末尾の空行を増やさない）。商品はその発送の行だけ、`・{品名}（{色} / {サイズ}） × {数}`、値段は書かない。色・サイズの片方/両方が無い時の書き方は既存の関数と同じ。

| kind | 件名 |
|---|---|
| `out_for_delivery` | `【Le Fil des Heures】商品を配達中です（{注文番号}）` |
| `delivered` | `【Le Fil des Heures】商品をお届けしました（{注文番号}）` |
| `shipping_update` | `【Le Fil des Heures】発送の情報を更新しました（{注文番号}）` |

- 配達中: 宛名 → 空行 → `ご注文の商品を配達中です。` → 空行 → `注文番号: {注文番号}` → 空行 → `配達中の商品:` → 商品の行 → 空行 → `配送業者: {配送業者}` → `追跡番号: {伝票番号}` → `追跡はこちら: {追跡のリンク}` → 空行 → 問い合わせの案内 → 空行 → 店名。
- 配達済み: 宛名 → 空行 → `ご注文の商品をお届けしました。` → 空行 → `注文番号: {注文番号}` → `お届け日: {M月D日}` → 空行 → `お届けした商品:` → 商品の行 → 空行 → `商品に不具合がございましたら、到着から {N} 日以内にご注文の画面またはお問い合わせからご連絡ください` → 空行 → `ご注文の確認はこちら: {注文の画面のリンク}` → 空行 → 問い合わせの案内 → 空行 → 店名。N は材料を読む時の `shop_return_settings.window_days`、NULL なら案内とその直後の空行を出さない。
- 発送の更新: 宛名 → 空行 → `ご注文の発送の情報を更新しました。` → 空行 → `注文番号: {注文番号}` → 空行 → `発送した商品:` → 商品の行 → 空行 → `配送業者: {新しい配送業者}` → `追跡番号: {新しい伝票番号}` → `追跡はこちら: {追跡のリンク}` → 空行 → `先にお知らせした伝票番号は使えません` → 空行 → 問い合わせの案内 → 空行 → 店名。

shipping_update は直しの行の新しい値、配達中/配達済みは claim の版の発送を使う。古い版や取消の判定は保存済みの本文があっても送る直前に行う。17TRACK の細かい状況・場所・文をメールへ入れない。付録の見本は説明書の写しであり、本物の HTTP・署名・課金・3社の追跡を確認済みと扱わない。

### Task 1: 移行 A（記録と守り）

**Files:**

- Create: `supabase/migrations/20261021220816_delivery_tracking_records.sql`
- Create: `tests/integration/db/delivery_tracking_records.integration.test.ts`
- Create: `tests/integration/db/helpers/delivery-tracking-fixtures.ts`
- Modify: `tests/integration/db/order_fulfillments.integration.test.ts`
- Modify: `tests/integration/db/order_refund_results.integration.test.ts`

**Interfaces:**

- Consumes: `public.shop_settings`（id=1）、`public.order_fulfillments` と lines、段2 D の `private.enqueue_order_email(uuid,text,text,uuid,uuid):boolean`・`public.claim_order_email(integer)`、`describeLocalDb`・`PgClient`・既存 `order-fixtures.ts`。
- Produces: C-0 の表・列・CHECK・索引と C-1 Task 1 の関数。`claim_order_email` は既存15列＋`tracking_version integer,tracking_change_id uuid` の17列。試験の道具 `insertDeliveryFixture(client:PgClient,input:{orderId:string;shippedAt:string;carrier?:ShippingCarrierId;trackingNumber?:string;notifyCustomer?:boolean}):Promise<{fulfillmentId:string}>`（本物の管理 RPC ではなく SQL で状態を作る）。

- [x] **Step 1: DB の記録と守りの落ちる試験を書く**

新しい records の試験では BEGIN/ROLLBACK、拒否の試験は SAVEPOINT。ロールを替えた試験は必ず戻す。バックフィルは migration が実際に呼ぶ `private.backfill_delivery_events()` を使い、取消でない/取消済み/legacy番号無しのfixtureへ1回目は対象の行数、2回目は0を返すことを照合する。

```ts
test('最初は追跡オフで登録もメールも無い');
expect(settings.delivery_tracking_enabled).toBe(false);
expect(registrations).toHaveLength(0);
expect(deliveryEmails).toHaveLength(0);
test('8状況・4つの出どころ・5つの要対応以外は23514');
expect(invalidStatus.code).toBe('23514');
test('同じ発送・版・状況・時刻は1行だけ');
expect(duplicateEvent.code).toBe('23505');
test('同じ組の番号を2発送に記録できる');
expect(pairRows).toHaveLength(2);
test('届いた時刻は発送より前にならない');
expect(beforeShipment.code).toBe('23514');
test('直接の書き込みはservice_roleも拒む');
expect(serviceRoleInsert.code).toBe('42501');
test('GUCだけを真似ても配送の列は直せない');
expect(directUpdateRejected).toBe(true);
test('追記の行は更新・削除・TRUNCATEできない');
expect(eventDelete.code).toBe('55000');
test('claimの最後の2列を増やして既存の15列を保つ');
expect(columnNames.slice(-3)).toEqual(['cancel_request_id','tracking_version','tracking_change_id']);
```

さらに outbox の新3種類の正しい組合せ・variant NULL、欠けた version/change の23514、2発送・2版は別行で同じ版は1行、既存 `paid/awaiting_payment/canceled/refund/return_requested/cancel_request_shop/shipped` の enqueue が `ON CONFLICT` の誤りを出さず各1回になる試験を書く。ops の7つの job と未知 job の23514、public 関数の EXECUTE は service_role だけ、private の PUBLIC EXECUTE 無しも確認する。

- [x] **Step 2: controller が RED を確かめる**

Run: Global Constraints のローカル DB の環境を渡し、`npx jest tests/integration/db/delivery_tracking_records.integration.test.ts --runInBand`。
Expected: FAIL（表/列/17列の claim がまだ無い）。接続できない・skip は RED の証拠にしない。

- [x] **Step 3: C-0 と C-1 Task 1 を移行 A に書く**

関数の本文を長く複製せず、元の最新の本文を読み、指定の差だけを入れる。outbox の元は `20261020144439_order_return_request_records.sql:357–567`。claim は DROP→CREATE→revoke/grant、17列の3か所（宣言・RETURNING・SELECT）を揃える。

この段階で古い作成 RPC が動くよう、`delivery_status_at` は `DEFAULT pg_catalog.now()` つきで足して既存行を shipped_at へ直す。そのバックフィルの間だけ、同じ移行の取引内で `order_fulfillments_cancel_only` を無効にし、直した守りを有効に戻してからCOMMITする（ALTER TABLEの鍵を保ち、取消済みの既存行も揃える）。`request_fingerprint` はnullableで足し、Bが既存行を補う。settings の守りは配送3列以外の既存トグルを妨げない。

既存の取消でない発送に最初の confirmed の出来事を足す。legacy の carrier/number が NULL でも出来事は作る。取消済みには足さない。登録・新メールはゼロ。指紋の既存行のバックフィルと新規行の必須化は B で行う。

新しい public 3表と private 2表の RLS/SELECT だけの grant、出来事と番号の直しの追記の守り、attention の1回の解決、登録と provider gate の削除禁止を作る。削除禁止と FK の確認では postgres の試験接続でも守りが効くことを確かめる。

- [x] **Step 4: controller が GREEN を確かめる**

Run: `npx supabase db reset` → Global Constraints の DB 環境で `npx jest tests/integration/db/delivery_tracking_records.integration.test.ts tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/order_refund_results.integration.test.ts --runInBand`。
Expected: PASS、skip 0。旧試験の「直接番号を変えると拒否」は残す。claim の列数を固定している期待だけ17列へ直す。`npx tsc --noEmit` も誤り0。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add supabase/migrations/20261021220816_delivery_tracking_records.sql tests/integration/db/delivery_tracking_records.integration.test.ts tests/integration/db/helpers/delivery-tracking-fixtures.ts tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/order_refund_results.integration.test.ts
git commit -m "feat: 配送の記録と書き込みの守りを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: 移行 B（お店の関数）

**Files:**

- Create: `supabase/migrations/20261021221140_delivery_tracking_admin.sql`
- Create: `tests/integration/db/delivery_tracking_admin.integration.test.ts`
- Modify: `tests/integration/db/helpers/delivery-tracking-fixtures.ts`
- Modify: `tests/integration/db/order_return_records.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 の C-0。最新 `admin_create_fulfillment` は `20261013001143_order_return_receipts.sql:1558`、最新 `admin_cancel_fulfillment` は `20261013000456_order_return_actions.sql:1962`、最新 `private.fulfillment_line_returnable(uuid)` は `20261012235910_order_return_records.sql:1039`、最新 skip は段1 C の859行。
- Produces: C-1 Task 2 の関数。snake_case の `OrderDeliveryDetail`、`OrderDeliverySummary`、設定と要対応の答え。`request_fingerprint` の既存行への補完と新しい作成関数での必須値の書き込み。

- [x] **Step 1: 管理操作と読む物の落ちる試験を書く**

```ts
test('追跡オフの発送はconfirmedの出来事だけ作る');
expect(event).toMatchObject({status:'confirmed',source:'shipment',tracking_version:1});
expect(registrations).toHaveLength(0);
test('オンの発送と取り込みは同じ取引でpendingを作る');
expect(registration).toMatchObject({state:'pending',ever_registered:false,tracking_version:1});
test('30日の境目はexpires_atより前だけ取り込む');
expect(atBoundaryIncluded).toBe(false);
expect(correctedVersion.expires_at).toBe(correctedAtPlus30Days);
test('配達済み・取消・番号なし・既存の版は取り込まない');
expect(backfilled_count).toBe(eligibleWithoutRegistrationCount);
test('再オンは期限内のdisabledを同じ行のままpendingへ戻す');
expect(reactivated).toMatchObject({state:'pending',stop_reason:null,stopped_at:null,attempts:0,ever_registered:true});
expect(reactivated.expires_at).toBe(originalExpiresAt);
expect(expiredDisabled).toMatchObject({state:'stopped',stop_reason:'disabled'});
expect(deliveredStopped).toMatchObject({state:'stopped',stop_reason:'delivered'});
test('オフは開いた配送の要対応をautoで閉じる');
expect(openAttention).toHaveLength(0);
expect(eventsAfter).toEqual(eventsBefore);
test('番号の直しは配達済みでも新しい版のconfirmedへ戻す');
expect(updated).toMatchObject({tracking_version:2,delivery_status:'confirmed',delivered_at:null});
expect(oldRegistration).toMatchObject({state:'stopped',stop_reason:'replaced'});
expect(shippingUpdateCount).toBe(1);
test('同じキーの再送は元の結果、違う入力はDELIVERY_REQUEST_MISMATCH');
expect(replay.replayed).toBe(true);
expect(mismatch.message).toContain('DELIVERY_REQUEST_MISMATCH');
test('発送の作成の再送は番号の直しの後も同じ発送を返す');
expect(createReplay.fulfillment_id).toBe(originalFulfillmentId);
expect(currentTrackingNumber).toBe(correctedTrackingNumber);
test('手の正午を発送と今で挟む');
expect(delivered_at).toBe(clampedNoonJst);
test('集計は1000行を超える発送も数える');
expect(summary.active_count).toBe(1001);
expect(summary.delivered_count).toBe(1001);
```

日付の試験は、DB の `now()` に対して発送日の午前/午後、今日の午前/午後の分岐を fixture の値で作り、正午の上下限を SQL と JS の期待で照らす。過去・今日の境界は4つの DB timezone（UTC/Asia/Tokyo/America/Los_Angeles/Europe/London）で同じ JST 日付。未来日・発送日前・無効日・取消・別注文の fulfillment・同じ値の番号は C-4。手の notify は `発送.notify_customer AND 入力.notifyCustomer` だけで、発送の notify 自体を変えない。

この試験へ追加する表:

| ケース | 固定する期待 |
|---|---|
| オン/オフと作成・番号の直しが同時（2接続） | 設定の鍵の後の値で登録を決め、OFF後に pending が残らない |
| 同じ発送を2接続で直す/手で配達済み | 注文→発送の鍵で直列、同じキーは1回、別キーの2回目の配達済みは `DELIVERY_ALREADY_DELIVERED` |
| 同じ request_key を別注文/別発送で使う | 他の結果を返さず `DELIVERY_REQUEST_MISMATCH` |
| completes_order の発送の番号を直す | orders の古い carrier/number の写しも更新、部分発送なら更新しない |
| 取消の既存制限 | `FULFILLMENT_HAS_RETURN`・`FULFILLMENT_REFUNDED` と exchange hold を保つ |
| 取消成功 | 登録 cancelled、attention auto、pending/retry の配送メール skipped。外の停止は後で行う |
| 要対応の手の解決の再送 | `resolved`→`already_resolved`、別の新しい attention 行は閉じない |
| 読む物 | history の actor と sub_status は管理用だけ、limit前の total、priority failure→attempted→追跡できない |
| 返品 | delivered_at の JST 日付＋window_days。NULLは shipped＋buffer。last_item/無制限/取消除外を維持。番号を直すと目安へ戻る。既存返品と申し込みは変更0行 |

- [x] **Step 2: controller が RED を確かめる**

Run: DB 環境を渡し、`npx jest tests/integration/db/delivery_tracking_admin.integration.test.ts --runInBand`。
Expected: FAIL（新 RPC が無い、初回イベント/登録/指紋の再送がまだ無い）。

- [x] **Step 3: C-1 Task 2 を移行 B に書く**

作成と取消は上の最新の本文を元にし、引数/答え・数量・住所・返品・返金・交換の保留・注文の状態・初回の発送メールの条件を維持する。共通の設定の行を `FOR SHARE` → 注文を `FOR UPDATE` → 発送を `FOR UPDATE`。toggle は settings を `FOR UPDATE` → 対象注文を id 昇順 → 発送の順にする（4-6 の注文→発送を逆にしない）。これで toggle と配送の書き込みを同時に通さない。

指紋は `md5(jsonb_build_object(...)::text)`。作成は `order_id,shipping_carrier,tracking_number,notify_customer,lines`（lines は order_item_id 昇順の `{order_item_id,quantity}`）、直しは `order_id,fulfillment_id,shipping_carrier,tracking_number,notify_customer`、手は `order_id,fulfillment_id,delivered_on,notify_customer`。actor は指紋に入れない。引数→存在と所属→過去の request_key→状態の順で確かめ、再送は現在値の変化で落とさない。旧行の作成の指紋を現時点の値と lines から補う時は、Aと同じ取引内のtrigger無効化/再有効化を使う。新規作成は必ず指紋を入れる。NULLの古い行への作成の再送は現在値から計算して比べ、最初のtracking_editでは直す前に指紋を保存する。

管理操作の決まり:

| 操作 | 同じ取引の変更 |
|---|---|
| 作成 | shipped_at と同じ delivery_status_at、version1、confirmedのイベント、ONだけ pending（expires_at=shipped_at+30日）、従来の発送メール |
| 直し | carrier/number/notify を保存、version+1、confirmed、status_at=now、delivered_at=NULL、tracking_change と tracking_edit の confirmed、古い登録 replaced、新しい登録はONだけ（now+30日）、attention全部auto、notifyなら shipping_update |
| 手で配達済み | 選んだJST日の正午を `GREATEST(shipped_at,LEAST(noon,now()))`、status_at と delivered_at に入れる。manualイベントに request を記録、登録 delivered、attention全部auto、両notifyなら deliveredメール |
| ON | `expires_at>now()` に当たる、取消でない・配達済みでない・3社と番号のある現版で、その版の登録が無い物は新しく pending、`disabled` で止まった行は P7 のとおり同じ行を pending に戻す。版2以上の始点は tracking_changes.changed_at |
| OFF | 止まっていない登録を disabled、全登録のlease無効化とprovider_stop_pending=false、開いたattention全てauto、出来事とdelivered_atを消さない |

`get_delivery_tracking_settings` の backfill_count と ON の対象の SQL を同じ private の SELECT に揃える（補助の名前 `private.delivery_tracking_backfill_targets():TABLE(fulfillment_id uuid,tracking_version integer,expires_at timestamptz)`、公開EXECUTE無し）。読む関数は jsonb の配列を DB 内で集計し、注文一覧は200注文以下の集計を返す。エラーを空配列にして「全部配達済み」にしない。

`private.enqueue_delivery_email` は fulfillment/order/version/change の所属を検査し、ONの out_for_delivery、manualの入力で制御する delivered、tracking_change のnotifyで shipping_update を書く。delivery_status が delivered の out_for_delivery は入れない。通知の消し方は Task 8 と同じ。`skip_order_email` は配送3種類の取消を許し、旧版の out_for_delivery/delivered と配達済みの out_for_delivery に限って superseded を許す。既存の skip の許す条件を広げすぎない。

- [x] **Step 4: controller が GREEN を確かめる**

Run: reset → DB 環境で `npx jest tests/integration/db/delivery_tracking_admin.integration.test.ts tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/order_return_records.integration.test.ts --runInBand`。
Expected: PASS、skip0。旧 shipped＋3＋7 の期待は維持して届いた日の期待を追加。2接続の試験は別接続で準備を commit し、試験後は次の reset で捨てる。`npx tsc --noEmit` も誤り0。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add supabase/migrations/20261021221140_delivery_tracking_admin.sql tests/integration/db/delivery_tracking_admin.integration.test.ts tests/integration/db/helpers/delivery-tracking-fixtures.ts tests/integration/db/order_return_records.integration.test.ts
git commit -m "feat: 配送の直しと手の配達済みの関数を追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: 移行 C（追跡の関数）

**Files:**

- Create: `supabase/migrations/20261021221410_delivery_tracking_sync.sql`
- Create: `tests/integration/db/delivery_tracking_sync.integration.test.ts`
- Modify: `tests/integration/db/helpers/delivery-tracking-fixtures.ts`

**Interfaces:**

- Consumes: Task 1 の登録・イベント・attention と provider gate、Task 2 `private.enqueue_delivery_email(uuid,integer,text,uuid):boolean`、設定と注文→発送の鍵。
- Produces: C-1 Task 3 の8関数。claim の action は `register/retrack/read/stop`、登録結果は `RegistrationOutcome`、読み直し結果は `DeliveryReadResult` の snake_case。状態/メール/attention を1取引に書く。

- [x] **Step 1: 借りる・結果・合図の落ちる試験を書く**

```ts
test('2接続のclaimは同じ行も同じ組も借りない');
expect(intersectionOfClaims).toEqual([]);
test('失効したleaseを借り直し、前のtokenは書けない');
expect(oldTokenResult.applied).toBe(false);
test('借りている間の合図を次の読み直しへ残す');
expect(next_run_at).toBe(now);
test('共有する番号の停止と新しい登録を直列に扱う');
expect(stopClaimWhileOtherActive).toEqual([]);
expect(registerClaimWhileStopLeased).toEqual([]);
test('番号だけの失敗はinvalid_numberで試し直さない');
expect(row).toMatchObject({state:'failed',failure_kind:'invalid_number',retry_allowed:false});
expect(openKinds).toEqual(['tracking_not_found']);
test('口座の失敗はattemptsを使わずattentionも開かない');
expect(row).toMatchObject({state:'pending',attempts:beforeAttempts});
expect(openKinds).toEqual([]);
test('一時の失敗5回の後も1日1回回復できる');
expect(failed).toMatchObject({state:'failed',failure_kind:'repeated_error',retry_allowed:true});
expect(retryAt).toBe(fifthFailurePlus24Hours);
test('retrackの2回目は日次の試し直しもしない');
expect(row.retry_allowed).toBe(false);
test('古いtrackingだけを比べ、直す前の時刻を受け取れる');
expect(afterEdit.delivery_status_at).toBe(providerTimeBeforeEdit);
test('同じ状況と古い出来事はイベントもメールも増やさない');
expect(eventDelta).toBe(0);
expect(emailDelta).toBe(0);
```

以下の表を `test.each` にし、applied/changed、fulfillment、イベント、登録、attention、outbox を同時に見る。fixture の `now` は DB の取引の時刻に固定する。

| 入力/前提 | 期待 |
|---|---|
| ON=false | claim空、合図0件、結果applied=false、attention増加0 |
| 同じtokenでも旧版・取消・手で配達済みの後 | 結果applied=false、状態/イベント/メール変更0 |
| 同じ版の最後のtracking時刻より1秒前 | changed=false。shipment/tracking_edit の時刻は比較に使わない |
| 同時刻で異なる状況 | lease取得順の結果を受ける（古いとは判定しない）。同じstatus/timeの二重は UNIQUEで増えない |
| 配達済みの後に配達中 | changed=false、out_for_deliveryメール0 |
| providerの届いた時刻 < shipped_at | delivered_at=shipped_at、trackingイベントの happened_at は provider時刻を保つ |
| providerに時刻が無い | happened_at=read_at |
| NotFound 登録後71:59:59 / 72:00:00 | 前はattention0、後はtracking_not_found1。登録前の作成時刻からは数えない |
| invalid_number | 直ちにtracking_not_found。登録成功後は自動で閉じる |
| failure→手の解決→failureの同じ読み直し | 新行0。in_transit→failureなら新しいattention1 |
| attempted_delivery→in_transit、NotFound→情報あり | 対応するattentionをautoで閉じる |
| delivered・直し・取消・OFF | 開いた全種類をautoで閉じる |
| expires_at=now、ever_registered=false / true | 両方stopped/expired、後者だけtracking_stalled |
| STOPPEDの合図→読み直しdelivered / 未配達 | 前はstopped/delivered、後はstopped/provider_stoppedとtracking_stalled |
| 知らない組/止めた行への知らせ | 更新0。yamatoの同じ番号とsagawaの番号を混同しない |
| 同じcarrierでab-1/AB-1の2発送 | 合図は2件、1発送の取消の外の停止は0回 |
| 通知OFF / ONで2回out_for_delivery→delivered | OFFメール0、ON各1。別版はまた各1 |
| 1秒のprovider枠を4接続が取る | 予約時刻の差が334ms以上、1秒に最大3開始 |

- [x] **Step 2: controller が RED を確かめる**

Run: DB 環境で `npx jest tests/integration/db/delivery_tracking_sync.integration.test.ts --runInBand`。
Expected: FAIL（claim/record/signal が無い）。

- [x] **Step 3: C-1 Task 3 を移行 C に書く**

claim は limit1〜40・lease30〜300秒（workerは60秒）、期限と時刻が来た行、失効leaseだけ。候補を読む→settingsのFOR SHARE→注文/発送をそれぞれFOR UPDATE SKIP LOCKED→組の `pg_try_advisory_xact_lock(hashtextextended(carrier||':'||upper(number),0))`→登録のFOR UPDATE SKIP LOCKED→別のSQL文で同じ組の有効leaseを再確認→tokenを書く、の順にする。単一SELECTのNOT EXISTSだけで同じ組の競合を防いだとしない。1行書くごとに次の候補を読み、同じbatch内の共有番号も同時に借りない。すべての書く関数がこの鍵の順序に従う。

claim の取引内で action を決め、tokenを渡す。止まった組を再び追う場合、過去に `ever_registered=true` で止まった同じ組の行（自動停止のdelivered/expiredも含む）を見て retrack、別の追跡中の行があれば register（既登録の成功で共有）にする。外へのstopが借りられた後に新しいpendingができた場合も、そのpendingはstopのleaseが終わるまで借りず、その後retrackする。

登録の結果は次の表。結果の度にtokenを確かめ、古いtokenはfalseだけ返す。

| outcome | 変更 |
|---|---|
| registered | state=registered、failure_kind=NULL、attempts=0、ever_registered=true、初回成功の registered_at、次は今（すぐ1回読む）、登録失敗のattentionをauto |
| invalid_number | failed/invalid_number、retry_allowed=false、tracking_not_found |
| transient | attempts+1、5回目未満はpendingで次の間隔、5回目以上failed/repeated_error＋attention、24時間後 |
| account | pendingを保ち、attemptsは不変、6時間後。発送ごとのattentionを作らない |
| retrack_exhausted | failed/repeated_error、retry_allowed=false、tracking_registration_failed |

読み直しの短い決定表（3-3 の正）:

| 順 | 条件 | 動き |
|---|---|---|
| 1 | 設定OFF・版違い・取消・token違い・lease失効 | applied=false、書かない |
| 2 | すでにdelivered | 状況を動かさない。登録だけ止める必要があればdeliveredで止める |
| 3 | not_registered | pendingへ、次は今、ever_registered/registered_atは保持 |
| 3a | invalid_number | failed/invalid_number、retry_allowed=false、tracking_not_foundを直ちに開く（登録時と同じ分類） |
| 4 | transient/account | 前の状況を保つ。read_attempts はtransientだけ加算、5分/15分/1時間/6時間。accountは6時間 |
| 5 | not_found | 前の状況を保つ（初回はconfirmed）、72時間ならattention。6時間後 |
| 6 | 未知の状態（status=NULL） | providerの記号とlast_read_atだけ、状況/イベント/配送メールは変えない。運用はTSが知らせる |
| 7 | 同じ版のtrackingのMAX(happened_at)より前 | 状況/イベントは変えない。次の読み直しへ |
| 8 | 同じ状況 | イベント無し、last_read_atとproviderの記号を更新、情報ありならnot_foundを閉じる |
| 9 | 違う状況 | eventを1行、status/status_atを更新、attentionの条件の変化をP19で処理 |
| 10 | 新たにdelivered | delivered_at=max(providerの届いた時刻またはhappened_at,shipped_at)、登録delivered、attention全部auto、通知ONならdeliveredを1通 |
| 11 | 新たにout_for_delivery | 通知ONでまだdeliveredでない時だけout_for_deliveryを1通 |
| 12 | STOPPED合図を持つ成功した読み直し後、未配達 | provider_stoppedで停止、tracking_stalled。deliveredなら行10が先 |

成功は read_attempts=0、通常は6時間後だが signal_revision がclaim時より進んでいれば今。STOPPEDの合図の消費もそのrevisionまで。expiry は ON時の期限を迎えた行を注文→発送→登録の順で取り、ever_registered だけattention。停止理由replaced/cancelledの外への停止は、同じ組の別の止めていない行を確認してから provider_stop_pending を設定し、workerのstop結果を記録する。disabled/delivered/expired はその印を付けない。

- [x] **Step 4: controller が GREEN を確かめる**

Run: reset → DB 環境で `npx jest tests/integration/db/delivery_tracking_sync.integration.test.ts tests/integration/db/delivery_tracking_admin.integration.test.ts --runInBand`。
Expected: PASS、skip0、2接続の競合でハング無し。`npx tsc --noEmit` も誤り0。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add supabase/migrations/20261021221410_delivery_tracking_sync.sql tests/integration/db/delivery_tracking_sync.integration.test.ts tests/integration/db/helpers/delivery-tracking-fixtures.ts
git commit -m "feat: 配送の追跡の借り出しと結果の関数を追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: TS の土台

**Files:**

- Create: `src/lib/orders/tracking/delivery-types.ts`
- Create: `src/lib/orders/tracking/delivery-messages.ts`
- Create: `src/lib/orders/tracking/delivery-store.ts`
- Create: `src/lib/orders/tracking/seventeen-track-status.ts`
- Create: `tests/unit/lib/orders/tracking/delivery-types.test.ts`
- Create: `tests/unit/lib/orders/tracking/delivery-store.test.ts`
- Create: `tests/unit/lib/orders/tracking/seventeen-track-status.test.ts`
- Create: `tests/integration/db/delivery_tracking_postgrest.integration.test.ts`

**Interfaces:**

- Consumes: C-1 の DB、既存 `ShippingCarrierId`・`OrderEmailStatus`・`SupabaseClient`。
- Produces: C-2 の型/値の配列・`DeliveryStore` と15個の呼び出し・`DeliveryOperationError`・`DeliveryStoreError`、C-4/C-5 の `DELIVERY_ERROR_MESSAGES`・`DELIVERY_STATUS_LABELS`・`DELIVERY_ATTENTION_LABELS`・`TRACKING_STATE_LABELS`、`mapSeventeenTrackStatus` と `SEVENTEEN_TRACK_CARRIERS`。

- [x] **Step 1: 型・表・snake_case の落ちる試験を書く**

```ts
test('状態と運送会社は承認した値だけ');
expect(DELIVERY_STATUSES).toEqual(['confirmed','in_transit','out_for_delivery','attempted_delivery','ready_for_pickup','delivered','delayed','failure']);
expect(SEVENTEEN_TRACK_CARRIERS).toEqual({yamato:100062,sagawa:100040,japanpost:10021});
test('未知のprovider状態をfailureへ推測しない');
expect(mapSeventeenTrackStatus('NewStatus','NewSub')).toBeNull();
test('別の注文の番号をRPCへ混ぜず17個のclaim列を読む');
expect(rpc).toHaveBeenCalledWith('admin_update_fulfillment_tracking', exactSnakeCaseInput);
test('DBの断りとDB障害と壊れた答えを分ける');
expect(refusal).toBeInstanceOf(DeliveryOperationError);
expect(brokenResponse).toBeInstanceOf(DeliveryStoreError);
test('一覧は200注文で分け、1000行の答えを拒む');
expect(truncatedResponse).toBeInstanceOf(DeliveryStoreError);
```

provider 対応表を test.each で固定する（細かい状況は主の値と組で照合）:

| status/sub_status | 期待 |
|---|---|
| InfoReceived（細かい状況が無くてもよい） | confirmed |
| NotFound | not_found（DBの状況ではない） |
| InTransit（全ての細かい状況） | in_transit |
| OutForDelivery | out_for_delivery |
| DeliveryFailure_NoBody・DeliveryFailure_Other | attempted_delivery |
| AvailableForPickup | ready_for_pickup |
| Delivered | delivered |
| Exception_Delayed・Expired | delayed |
| Exception_Returning/Returned/Lost/Damage/Rejected/NoBody/Security/Destroyed/Cancel/Other | failure（この10記号を個別に試す） |
| DeliveryFailure_Security/Rejected/InvalidAddress | failure（3記号を個別に試す） |
| Exception_Future・DeliveryFailure_Future・知らない主の値 | null |

主の値が既知でも、Exception/DeliveryFailure の未知の細かい状況はnull。配達中等の主だけで決まる種類は未知のsubでも主を使う。C-4 の各記号のHTTPと文を全件比較する。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/lib/orders/tracking/delivery-types.test.ts tests/unit/lib/orders/tracking/delivery-store.test.ts tests/unit/lib/orders/tracking/seventeen-track-status.test.ts --runInBand`。
Expected: FAIL（module未作成）。

- [x] **Step 3: 指定のファイルへ C-2/C-4 の宣言と表を実装する**

値を表1か所から引き、DB wrapper は正しい関数名・引数・列名と型を厳しく読む。未知のenum、欠けた必須値、不正時刻、負の数、結果が0行の管理操作は StoreError。`listOrderDeliverySummaries` は200注文ずつ、uuidの大小をそろえ、元のキーへ戻す。行数1000以上なら拒否。Map の空を理由に全部配達済みとしない。

本物の PostgREST を通す試験ではローカル URL の守りを既存 `fulfillment_postgrest.integration.test.ts` と同じにし、全ての新 RPC の引数名を実際に渡して、snake_case→camelCase、JSONの配列、TABLEの配列、signalのinteger、slotのintegerを照合する。token/leaseの拒否も呼ぶ。モックのRPC試験だけで契約の一致を主張しない。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2 と同じ単体、`npx tsc --noEmit`。controller は reset後 DB環境で `npx jest tests/integration/db/delivery_tracking_postgrest.integration.test.ts --runInBand`。
Expected: PASS、型の誤り0、DBのskip0。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/tracking/delivery-types.ts src/lib/orders/tracking/delivery-messages.ts src/lib/orders/tracking/delivery-store.ts src/lib/orders/tracking/seventeen-track-status.ts tests/unit/lib/orders/tracking/delivery-types.test.ts tests/unit/lib/orders/tracking/delivery-store.test.ts tests/unit/lib/orders/tracking/seventeen-track-status.test.ts tests/integration/db/delivery_tracking_postgrest.integration.test.ts
git commit -m "feat: 配送の型と言葉とDBの呼び出しを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: 17TRACK client

**Files:**

- Create: `src/lib/orders/tracking/delivery-config.ts`
- Create: `src/lib/orders/tracking/seventeen-track-client.ts`
- Create: `src/lib/orders/tracking/seventeen-track-signature.ts`
- Create: `tests/fixtures/17track/v2.4.json`
- Create: `tests/fixtures/17track/README.md`
- Create: `tests/unit/lib/orders/tracking/delivery-config.test.ts`
- Create: `tests/unit/lib/orders/tracking/seventeen-track-client.test.ts`
- Create: `tests/unit/lib/orders/tracking/seventeen-track-signature.test.ts`

**Interfaces:**

- Consumes: Task 4 `mapSeventeenTrackStatus`・`ProviderPair` に使うcarrier番号、C-2 `RegistrationOutcome/DeliveryReadResult/TrackingSignal`。
- Produces: C-2 の config・client・署名の5関数と `SeventeenTrackClient`。fixture は `{contract:'17track-v2.4',responses:Record<string,unknown>,webhooks:Record<string,unknown>}`。キーは `registered,alreadyRegistered,invalidNumber,accountQuota,notRegistered,noInformation,retrackExhausted,inTransit,outForDelivery,delivered,stopped,unknownStatus`。webhooks は `updated,stopped`。

- [x] **Step 1: 付録の見本と落ちる単体を書く**

```ts
test('v2.4へPOSTし番号とcarrierだけを渡す');
expect(url).toBe('https://api.17track.net/track/v2.4/register');
expect(JSON.parse(body)).toEqual([{number:'AB-1',carrier:100062}]);
expect(headers).toMatchObject({'17token':fakeKey,'Content-Type':'application/json'});
test('本文を1字変えた署名は通さない');
expect(verifySeventeenTrackSignature(raw,validSign,fakeKey)).toBe(true);
expect(verifySeventeenTrackSignature(changedRaw,validSign,fakeKey)).toBe(false);
test('署名なし・非hex・違う長さは例外を出さずfalse');
expect(verifySeventeenTrackSignature(raw,null,fakeKey)).toBe(false);
test('知らせのtrack_infoを配送の結果へ使わない');
expect(parseTrackingSignals(fixture.webhooks.updated)).toEqual([{carrier:100062,number:'AB-1',event:'TRACKING_UPDATED'}]);
test('最新時刻とDelivered milestoneだけを読む');
expect(result.read).not.toHaveProperty('location');
expect(result.read).not.toHaveProperty('description');
```

client の `test.each` は付録の全コードとHTTPを次のとおりに固定する。

| code/HTTP | 期待 |
|---|---|
| 0 accepted、-18019901、-18019904 | registered |
| -18010011/-18010012/-18010013/-18010015/-18019903/-18019910/-18019911 | invalid_number |
| -18019905 | retrack_exhausted |
| -18019907/-18019908、401/-18010001/-18010002/-18010004/-18010005 | account |
| 429/500/503/-18010003/-18019815/-18019816/-18019817、timeout/network、未知のエラーcode | transient |
| -18019902（get/stop） | not_registered（stopはローカル停止を終え、読み直しはpendingへ） |
| -18019906（stop） | stopped（成功） |
| -18019909、NotFound | not_found、happenedAt/deliveredAt=null |

トップレベルの非0 code と rejected[].error.code の両方、accepted/rejected混在、順番違い、欠けた組、同じ組の矛盾、本文がJSONでない、41件と0件の呼び出し、HTTP timeoutを試す。1件の不正で別のacceptedを捨てない。signatureはraw bytesの日本語・改行・CRLFも固定する。配列webhook、未知event/未知carrierは無視、JSON構造自体が壊れた時は parse が `TypeError`（routeは400）にする。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/lib/orders/tracking/delivery-config.test.ts tests/unit/lib/orders/tracking/seventeen-track-client.test.ts tests/unit/lib/orders/tracking/seventeen-track-signature.test.ts --runInBand`。
Expected: FAIL（module未作成）。本物のURLへは接続しない。

- [x] **Step 3: C-2 の宣言を実装する**

client/config は server-only、fetch注入、AbortControllerでtimeout（各callのoptionsがあればfactoryの既定より優先）、redirectを追わない。4つのpathは `/register`・`/retrack`・`/gettrackinfo`・`/stoptrack`。getquota は開店前の手順だけでworkerには実装しない。responseは `code,data.accepted[],data.rejected[].error.code` と accepted[].track_info の付録の形だけを読む。getのacceptedは `outcome='registered'` と `read.outcome='ok'|'not_found'` の組で返す。未知のmain/sub_statusはstatus=nullを返す。結果にはraw messageもpayloadも入れない。

署名は raw bytes → `/` のUTF-8 bytes → keyのUTF-8 bytes の順でSHA-256し、64桁のhexをBufferに直して `timingSafeEqual`。大文字hexは同じbytesとしてよい。長さを先に検査する。JSONを作り直した物に署名しない。

fixture/README に「2026-10-21 の説明書 v2.4 からの写し。本物の返事・署名の鍵・課金・retrackは未確認」を明記する。description/locationに試験用の捨てる文字を入れ、戻り値に残らない試験にする。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2 と同じ単体と `npx tsc --noEmit`。
Expected: PASS、型の誤り0。ネットワーク呼び出しは注入したfetchだけ。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/tracking/delivery-config.ts src/lib/orders/tracking/seventeen-track-client.ts src/lib/orders/tracking/seventeen-track-signature.ts tests/fixtures/17track/v2.4.json tests/fixtures/17track/README.md tests/unit/lib/orders/tracking/delivery-config.test.ts tests/unit/lib/orders/tracking/seventeen-track-client.test.ts tests/unit/lib/orders/tracking/seventeen-track-signature.test.ts
git commit -m "feat: 17TRACKのやり取りと署名の確かめを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: 毎分の処理と急ぎの道

**Files:**

- Create: `src/lib/orders/tracking/delivery-worker.ts`
- Create: `src/lib/orders/tracking/delivery-schedule.ts`
- Create: `src/lib/orders/tracking/delivery-ops.ts`
- Modify: `src/lib/stripe/webhook-worker.ts`
- Modify: `src/lib/ops/ops-store.ts`
- Modify: `src/lib/ops/ops-checks.ts`
- Modify: `src/lib/ops/ops-alert-mail.ts`
- Modify: `src/app/api/admin/orders/[id]/fulfillments/route.ts`
- Modify: `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts`
- Create: `tests/unit/lib/orders/tracking/delivery-worker.test.ts`
- Create: `tests/unit/lib/orders/tracking/delivery-schedule.test.ts`
- Create: `tests/unit/lib/orders/tracking/delivery-ops.test.ts`
- Modify: `tests/unit/lib/stripe/webhook-worker.test.ts`
- Modify: `tests/unit/lib/ops/ops-store.test.ts`
- Modify: `tests/unit/lib/ops/ops-checks.test.ts`
- Modify: `tests/unit/lib/ops/ops-alert-mail.test.ts`
- Modify: `tests/unit/api/admin/order-fulfillment-routes.test.ts`

**Interfaces:**

- Consumes: Task 4 の `DeliveryStore` と claim/result/slot、Task 5 `SeventeenTrackClient`、既存 `recordHeartbeat/claimAlert/releaseAlert/bumpSignal/sendOpsAlertMail`。
- Produces: C-2 の worker/schedule/ops の宣言、`OpsJob` の `delivery_tracking`、`WorkerRunResult.deliveryTracking?:DeliveryWorkerResult|null`。`OpsAlertKey` に `delivery_tracking_account_error`・`delivery_tracking_key_missing`・`delivery_tracking_signature_invalid`・`delivery_tracking_read_failed`・`delivery_tracking_unknown_status`・`job_stale_delivery_tracking` を足す。

- [x] **Step 1: 時間・モード・回復と運用の落ちる単体を書く**

```ts
test('順番はStripe、メール、配送、点検、メールの配信の見回り');
expect(calls).toEqual(['stripe','mail','tracking','ops','mailOps','mailDelivery']);
test('Stripe35秒とメール10秒は変えない');
expect(WORKER_TIME_BUDGET_MS).toBe(35000);
expect(ORDER_EMAIL_WORKER_BUDGET_MS).toBe(10000);
test.each([[8000,8000],[5000,5000],[3000,3000],[2999,0]])('残り%smsの配送の枠は%sms');
test('予算で飛ばしてもdelivery_trackingの心拍を残す');
expect(heartbeatJob).toBe('delivery_tracking');
test('追跡OFFは鍵があってもHTTPを呼ばず鍵なしの知らせも無い');
expect(providerCalls).toEqual([]);
expect(alertCalls).toEqual([]);
test('ON中の鍵なしは登録と読み直しをせず予定を残す');
expect(claimCalls).toBe(0);
expect(expiryCalls).toBe(0);
expect(alertCooldownSeconds).toBe(86400);
test('claimの後にOFFになったら新しいHTTPを始めない');
expect(providerCalls).toEqual([]);
test('同じ組を別発送が使う間はstopTrackを呼ばない');
expect(stopTrack).not.toHaveBeenCalled();
test('accountの失敗を1日1回だけ知らせる');
expect(claimAlert).toHaveBeenCalledWith(store,'delivery_tracking_account_error',86400);
test('署名401は10分5回で1日1回の知らせ');
expect(bumpSignal).toHaveBeenCalledWith(store,'delivery_tracking_signature_invalid',600);
expect(sentOnCount4).toBe(0);
expect(sentOnCount5).toBe(1);
```

追加: 40件以下の配列、actionごとの正しいpath、leaseが失効した結果を捨てる、全体の334ms枠、HTTP timeout/DB失敗があっても次の点検へ進む、最初の処理からの実時間を予算で数える、waitが残りを超える時にHTTPを始めない、retrack exhaustedを通常の日次回復と分ける。登録/読取の再試行間隔はDBの答えを変えずに渡す試験と、DB試験の間隔の組を突き合わせる。

ops は送信失敗でclaimを返す、raw本文/鍵/署名/numberをログと運用メールへ入れない、連続5回の読み直し失敗と未知の状態は各1日1回、心拍15分で知らせる（まだ1度も成功していないjobは既存どおり対象外）。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/lib/orders/tracking/delivery-worker.test.ts tests/unit/lib/orders/tracking/delivery-schedule.test.ts tests/unit/lib/orders/tracking/delivery-ops.test.ts tests/unit/lib/stripe/webhook-worker.test.ts --runInBand`。
Expected: FAIL（worker未作成、毎分の呼ぶ順番に配送が無い）。

- [x] **Step 3: C-2 の worker/schedule/ops を実装する**

`processDeliveryTracking` は注入した時計・wait・provider・DBだけを使う。run関数は設定を読み、OFFはdisabled、ONで鍵なしはkey_missingで戻り予定も期限も動かさない。設定と鍵を確かめてから expire→claim（60秒）→枠の予約→HTTP→tokenつき結果。claimをaction別にまとめ、stop→register→retrack→readの順で各40件以下を呼ぶ。各HTTPの直前にも設定を再確認し、OFFなら始めない。call optionsのtimeoutMsには `min(2500,残りms)` を渡す。stop失敗も結果を記録して先へ進む。HTTPはDB取引の外。進行中のHTTPの返事も、DBが再確認するOFF/版/tokenの条件に合わなければ捨てる。

`scheduleDeliveryTracking():void` は既存のメールの schedule と同じ `after()`。中で投げたものは名前/記号だけでログに出す。作成・取消のrouteの成功後に呼ぶ（createのreplayedも回復の道として呼ぶ）。番号の直しはTask 9、webhookはTask 7が同じ関数を呼ぶ。

毎分は関数の開始時刻を控え、メールの後で `remaining=max(0,60000-elapsedMs-15000)`、`budget=min(8000,remaining)`。3000未満はworkerを呼ばず、正常の心拍を残し、WorkerRunResult.deliveryTrackingをnullにする（既存のrecord_ops_heartbeatは成功時のerror_codeを保存しない）。OFFは正常の心拍、鍵なし/DB失敗は失敗の心拍。元のStripe/mailの引数と試験の期待は保つ。`src/app/api/cron/process-stripe-webhooks/route.ts` の maxDuration=60 とcronの登録は変更しない。

`reportDeliveryTrackingIssue` は `claimAlert(...,86400)` を直接使い、既存 `sendOnce`（1時間）を使わない。送信先の値は表示しない。心拍の追加で `OpsJob` を引く全Recordとswitch、staleの配列・結果の型・15分・メールの名前 `配送の追跡` を同じTaskで更新する。

- [x] **Step 4: GREEN を確かめる**

Run: `npx jest tests/unit/lib/orders/tracking tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/lib/ops tests/unit/api/admin/order-fulfillment-routes.test.ts --runInBand`、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。時間の試験はfake clock、HTTPは注入fetchで本物へ接続0。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/tracking/delivery-worker.ts src/lib/orders/tracking/delivery-schedule.ts src/lib/orders/tracking/delivery-ops.ts src/lib/stripe/webhook-worker.ts src/lib/ops/ops-store.ts src/lib/ops/ops-checks.ts src/lib/ops/ops-alert-mail.ts src/app/api/admin/orders/[id]/fulfillments/route.ts src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts tests/unit/lib/orders/tracking/delivery-worker.test.ts tests/unit/lib/orders/tracking/delivery-schedule.test.ts tests/unit/lib/orders/tracking/delivery-ops.test.ts tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/lib/ops/ops-store.test.ts tests/unit/lib/ops/ops-checks.test.ts tests/unit/lib/ops/ops-alert-mail.test.ts tests/unit/api/admin/order-fulfillment-routes.test.ts
git commit -m "feat: 毎分と発送直後に配送の追跡を進める" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: 知らせの受け口

**Files:**

- Create: `src/app/api/webhook/17track/route.ts`
- Create: `tests/unit/api/webhook/17track-route.test.ts`

**Interfaces:**

- Consumes: Task 5 `verifySeventeenTrackSignature(raw,sign,key):boolean`・`parseTrackingSignals(value):TrackingSignal[]`、Task 4 `signalDeliveryTracking(store,signals):Promise<number>`、Task 6 `scheduleDeliveryTracking():void`・`reportDeliveryTrackingIssue(store,'signature_invalid')`。
- Produces: `export async function POST(request:Request):Promise<Response>`、`runtime='nodejs'`、C-3の `{received:true}`。Node cryptoが使えるruntimeに固定する。

- [x] **Step 1: 5-2 の順番の落ちる単体を書く**

```ts
test('鍵なしは本文を読む前に503');
expect(response.status).toBe(503);
expect(readBody).not.toHaveBeenCalled();
test('1048576 bytesは受け、1048577 bytesは署名前に413');
expect(overLimit.status).toBe(413);
test('不正JSONでも署名が違えば先に401');
expect(response.status).toBe(401);
test('署名が合っていてJSONが読めないなら400');
expect(response.status).toBe(400);
test('OFFでも署名は確かめ、合う知らせだけ200で無視');
expect(validOff.status).toBe(200);
expect(invalidOff.status).toBe(401);
expect(signalRpc).not.toHaveBeenCalled();
test('payloadのDeliveredを記録せず合図の組だけ渡す');
expect(signalRpc).toHaveBeenCalledWith(store,[{carrier:100062,number:'AB-1',event:'TRACKING_UPDATED'}]);
test('DBが失敗したら500、成功後だけafter');
expect(failed.status).toBe(500);
expect(schedule).not.toHaveBeenCalled();
```

署名なし/形式不正、Content-Lengthなし/偽の小さい値/大きい値、分割streamで上限を越える、1件と配列、未知イベント/未知番号/止めた番号、TRACKING_STOPPED、空配列、途中のstream失敗400も加える。署名401の計数の失敗は401を500へ変えない。ログを検査しraw本文/鍵/署名が一切無い。認証/CSRF middlewareは呼ばない。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/api/webhook/17track-route.test.ts --runInBand`。
Expected: FAIL（route未作成）。

- [x] **Step 3: 指定のPOSTを実装する**

順番はGlobal Constraintsの6段。本文はstreamを読みながら累計bytesを数えて上限でcancelし、上限以下のbytesだけ連結する。Content-Lengthだけを信用しない。署名後にUTF-8/JSONを読み、合図へ射影する。未知event/carrierの有効なJSONは200の無視、壊れた必須構造は400。設定のDB読取失敗も500。受け入れと無視の200は同じ `{received:true}` で未知番号の有無を漏らさない。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2 と同じ単体、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。署名と読み直しの順は外からのモックの呼ぶ順で確認する。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/app/api/webhook/17track/route.ts tests/unit/api/webhook/17track-route.test.ts
git commit -m "feat: 17TRACKの知らせを読み直しの合図として受ける" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: 配送のメール3種類

**Files:**

- Modify: `src/lib/orders/email/order-email-types.ts`
- Modify: `src/lib/orders/email/order-email-store.ts`
- Modify: `src/lib/orders/email/order-email-compose.ts`
- Modify: `src/lib/orders/email/order-email-worker.ts`
- Create: `src/lib/orders/email/order-email-delivery-material.ts`
- Modify: `src/app/api/admin/orders/[id]/emails/resend/route.ts`
- Modify: `tests/unit/lib/orders/email/order-email-types.test.ts`
- Modify: `tests/unit/lib/orders/email/order-email-store.test.ts`
- Create: `tests/unit/lib/orders/email/order-email-compose-delivery.test.ts`
- Create: `tests/unit/lib/orders/email/order-email-worker-delivery.test.ts`
- Create: `tests/unit/lib/orders/email/order-email-delivery-material.test.ts`
- Modify: `tests/unit/api/admin/order-email-routes.test.ts`

**Interfaces:**

- Consumes: Task 1の17列claim、Task 2 `skip_order_email`、既存の `OrderEmailMaterial`・`loadOrderEmailMaterial`・`formatShipmentItemLines`・保存済み本文・送り出しのidempotency。
- Produces: `DELIVERY_EMAIL_KINDS=['out_for_delivery','delivered','shipping_update'] as const`・`DeliveryEmailKind`・`isDeliveryEmailKind(kind:OrderEmailKind):kind is DeliveryEmailKind`。19種類の kind/label/resendability、`ClaimedOrderEmail` に `trackingVersion?:number|null;trackingChangeId?:string|null`（DB読取は必ず値かnullを入れる）。

新しい材料の正:

```ts
// order-email-delivery-material.ts
export type OrderEmailDeliveryMaterial = {
  fulfillmentId:string; trackingVersion:number; currentTrackingVersion:number;
  cancelled:boolean; deliveryStatus:DeliveryStatus; deliveredAt:string|null;
  windowDays:number|null; carrier:ShippingCarrierId|null; trackingNumber:string|null;
};
export function loadDeliveryEmailMaterial(
  store:Pick<SupabaseClient,'from'|'rpc'>,
  claim:ClaimedOrderEmail,
):Promise<OrderEmailMaterial|null>;
```

`OrderEmailMaterial.delivery?:OrderEmailDeliveryMaterial` を足す。商品の行は既存 fulfillment の材料を使う。workerのdepsへ `loadDeliveryMaterial?:(claim:ClaimedOrderEmail)=>Promise<OrderEmailMaterial|null>`（非配送の既存depsは省略可）を足し、通常のrunは必ず渡す。`skipReasonFor` の claim は kind と任意のtrackingVersionを読める形に拡張する。

- [x] **Step 1: コピー・材料・送る直前の落ちる単体を書く**

```ts
test('メールの種類はSQLの19種類と同じ順');
expect(ORDER_EMAIL_KINDS).toHaveLength(19);
expect(ORDER_EMAIL_KINDS.slice(-3)).toEqual(['out_for_delivery','delivered','shipping_update']);
test.each(['out_for_delivery','delivered','shipping_update'])('配送の%sは再送できない');
expect(RESENDABLE_ORDER_STATUSES[kind]).toEqual([]);
test('届いた日の案内は設定の7日、無制限なら一文無し');
expect(body).toContain('商品に不具合がございましたら、到着から 7 日以内にご注文の画面またはお問い合わせからご連絡ください');
expect(unlimitedBody).not.toContain('到着から');
test('発送の更新は直した時の新しい番号を使う');
expect(body).toContain('先にお知らせした伝票番号は使えません');
expect(body).toContain(correctedNumber);
test('保存済み本文があっても旧版の配達中と配達済みを送らない');
expect(skipReason).toBe('superseded');
expect(send).not.toHaveBeenCalled();
test('配達済みの後の配達中は送る直前にも捨てる');
expect(skipReason).toBe('superseded');
test('取消は3種類ともfulfillment_cancelled');
expect(skipReason).toBe('fulfillment_cancelled');
```

件名と本文はC-6の全文を独立した期待文字列で比較し、価格/PII/providerの文/場所が無いこと、同じ品の部分発送だけの数、色サイズ無し、DeliveredのJST日付、windowDays=1/7/365/NULLを固定する。配達中/配達済みのmaterialは現在の版を検査し、shipping_updateはchangeの所属/order/versionと新しい値を読む。別注文のchangeやNULLの必須versionはsource_missingで再試行の後にdead（誤送信しない）。再送のrouteは認証/CSRF後、DB呼出しの前に3種類を既存の再送不可の本文で断る。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/lib/orders/email/order-email-compose-delivery.test.ts tests/unit/lib/orders/email/order-email-worker-delivery.test.ts tests/unit/lib/orders/email/order-email-delivery-material.test.ts tests/unit/lib/orders/email/order-email-types.test.ts --runInBand`。
Expected: FAIL（19種類/配送材料/コピー/skipが未実装）。

- [x] **Step 3: 宣言とC-6のコピーを実装する**

kind unionを増やす同じTaskで labels・RESENDABLE_ORDER_STATUSES・compose の分岐・`OrderEmailMaterialTable` の追加表（`order_fulfillment_tracking_changes`）を更新する。typesのSQL照合先は移行Aの最新CHECKへ直す。16種類や10+6を固定する試験を19へ直し、返品4種類・申し込み6種類の部分集合の試験は変えない。

新しいmaterial loaderは既存の注文/発送/商品の読み方を使い、注文と発送の所属を両方で絞る。senderとそのidempotency key `order-email/{outbox-row-id}` は変えない。保存済み本文の再利用より前に、現在の版・取消・現在のdeliveredを読み直しskipする。shipping_updateは旧版でも送る（直した事実のメール。8-2の旧版の抑止は配達中/配達済みだけ）。

- [x] **Step 4: GREEN を確かめる**

Run: `npx jest tests/unit/lib/orders/email tests/unit/api/admin/order-email-routes.test.ts --runInBand`、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。DBの一意/skipの本物の証拠はTask 1〜3、ここは単体の証拠と分ける。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/email/order-email-types.ts src/lib/orders/email/order-email-store.ts src/lib/orders/email/order-email-compose.ts src/lib/orders/email/order-email-worker.ts src/lib/orders/email/order-email-delivery-material.ts src/app/api/admin/orders/[id]/emails/resend/route.ts tests/unit/lib/orders/email/order-email-types.test.ts tests/unit/lib/orders/email/order-email-store.test.ts tests/unit/lib/orders/email/order-email-compose-delivery.test.ts tests/unit/lib/orders/email/order-email-worker-delivery.test.ts tests/unit/lib/orders/email/order-email-delivery-material.test.ts tests/unit/api/admin/order-email-routes.test.ts
git commit -m "feat: 配達中と配達済みと発送の更新のメールを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: 管理画面の窓口

**Files:**

- Create: `src/lib/orders/tracking/delivery-route-support.ts`
- Create: `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking/route.ts`
- Create: `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered/route.ts`
- Create: `src/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route.ts`
- Modify: `src/app/api/admin/order-attention/route.ts`
- Modify: `src/app/api/admin/orders/route.ts`
- Modify: `src/app/api/admin/orders/[id]/history/route.ts`
- Modify: `src/app/api/admin/settings/shop/route.ts`
- Modify: `src/lib/orders/email/order-history.ts`
- Modify: `src/lib/orders/order-payment-types.ts`
- Create: `tests/unit/api/admin/order-delivery-routes.test.ts`
- Modify: `tests/unit/api/admin/order-attention-route.test.ts`
- Modify: `tests/unit/api/admin/order-email-routes.test.ts`
- Modify: `tests/unit/api/admin/shop-settings-route.test.ts`
- Create: `tests/unit/lib/orders/email/order-history-delivery.test.ts`

**Interfaces:**

- Consumes: Task 4 の管理4操作/設定/一覧/履歴のwrapper、Task 6 のschedule、Task 8の3種類のメール状態。
- Produces: C-3の3 POSTと4 GET/PUTの追加、C-2の履歴2union・fulfillment.delivery・OrderAttentionと注文の印。共通の守りは `guardDeliveryAdminWrite(request:Request,endpoint:'tracking'|'delivered'|'resolve'):Promise<{ok:true;actorId:string}|{ok:false;response:Response}>`、断りは `deliveryErrorReply(error:unknown):{status:number;body:{error:string;code?:DeliveryErrorCode}}`。

- [x] **Step 1: 管理窓口の落ちる単体を書く**

```ts
test.each(['tracking','delivered','resolve'])('%sは権限→CSRF→IP→管理者の順');
expect(checkOrder).toEqual(['admin.orders.manage','csrf','ip','actor']);
test('サポートは配送を直せて設定は変えられない');
expect(trackingAllowed).toBe(true);
expect(settingsStatus).toBe(403);
test('ONの鍵なしは他の設定も書く前に409');
expect(response.status).toBe(409);
expect(body.code).toBe('DELIVERY_TRACKING_KEY_MISSING');
expect(anyWriteRpc).not.toHaveBeenCalled();
test('deliveryTrackingを省いたPUTは配送を変えない');
expect(setDeliveryTracking).not.toHaveBeenCalled();
test('settingsは鍵の有無とlimit前の件数だけ返す');
expect(data.deliveryTracking).toMatchObject({keyConfigured:true,backfillCount:1001});
expect(JSON.stringify(data)).not.toContain(fakeSecret);
test('履歴は出来事・直し・登録の現在値を別の形で返す');
expect(entryTypes).toEqual(expect.arrayContaining(['fulfillment','delivery_event','tracking_change']));
test('複数の要対応は問題ありを先に印にする');
expect(order.deliveryAttention).toBe('failure');
```

追加: 未認証401/権限なし403/CSRF拒否/各429でDBもscheduleも0回、uuid/厳しいbody/英数字ハイフン/無効な日付/所属違い、C-4全断り、想定外500のraw message非露出。成功とreplayでメールschedule、直しだけtracking schedule。監査はC-3のaction/許す値だけ。GETはCSRF/書く回数制限を通さない。

settingsはreturns→旧toggle→配送の途中で失敗した3通りについて、書けたまとまりだけ監査に残ること、dataへ鍵が1文字も無いことを固定。historyの新しい行は時刻降順、同時刻はtypeとidで安定、直しのemailStatusを `sent/pending/retry_wait/dead/skipped/null` から返す。OFFでは登録の現在値を顧客用に流用しない。attentionはOFFならdeliveries空/count0、配送だけある時も他の組の既存値を保つ。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/api/admin/order-delivery-routes.test.ts tests/unit/api/admin/order-attention-route.test.ts tests/unit/api/admin/order-email-routes.test.ts tests/unit/api/admin/shop-settings-route.test.ts tests/unit/lib/orders/email/order-history-delivery.test.ts --runInBand`。
Expected: FAIL（route/履歴の新union/設定の追加が無い）。

- [x] **Step 3: C-3 と新しい履歴の宣言を実装する**

routeのparamsは既存と同じ `Promise<{id:string;fulfillmentId:string}>`、resolveは `Promise<{attentionId:string}>`。body検査の後、C-2のinputへ authz.userId を入れてDBを呼ぶ。callerが渡したactorIdを使わない。

historyは `getOrderDeliveryDetail` を読んで既存の `buildOrderHistory` に渡し、fulfillment行の現版・notify・cancelledを表示の正にする。shipping_updateのメールを送ったかはoutboxのstatusを読む（notifyだけから「送信済み」としない）。登録状態はfulfillment.delivery.registration、出来事と直しは独立entryにする。actorEmailは管理用のDB読取だけで付ける。

一覧の印は集計RPCから、`delivery_failure`→failure、`attempted_delivery`→attempted_delivery、残り3つ→untrackable。現行の状態の絞り込みとページの件数を保つ。進み具合deliveredへの接続はTask 12。settingsはP5/P6、GETの件数はDBの対象の正確な集計、PUTが返す実数は別のbackfilledCount。tracking用のkeyConfiguredはboolean以外を返さない。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2 と同じ単体、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。管理操作の認証/CSRF/回数/監査はここで証拠を残す。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/tracking/delivery-route-support.ts src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking/route.ts src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered/route.ts src/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route.ts src/app/api/admin/order-attention/route.ts src/app/api/admin/orders/route.ts src/app/api/admin/orders/[id]/history/route.ts src/app/api/admin/settings/shop/route.ts src/lib/orders/email/order-history.ts src/lib/orders/order-payment-types.ts tests/unit/api/admin/order-delivery-routes.test.ts tests/unit/api/admin/order-attention-route.test.ts tests/unit/api/admin/order-email-routes.test.ts tests/unit/api/admin/shop-settings-route.test.ts tests/unit/lib/orders/email/order-history-delivery.test.ts
git commit -m "feat: 配送の管理窓口と履歴と設定の答えを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: 管理画面

**Files:**

- Create: `src/components/OrderTrackingEditDialog.tsx`
- Create: `src/components/OrderDeliveredDialog.tsx`
- Create: `src/lib/orders/tracking/delivery-client.ts`
- Modify: `src/components/OrderHistoryDialog.tsx`
- Modify: `src/components/OrderSection.tsx`
- Modify: `src/components/AttentionInbox.tsx`
- Modify: `src/app/admin/page.tsx`
- Create: `tests/unit/components/OrderTrackingEditDialog.test.tsx`
- Create: `tests/unit/components/OrderDeliveredDialog.test.tsx`
- Create: `tests/unit/lib/orders/tracking/delivery-client.test.ts`
- Modify: `tests/unit/components/OrderHistoryDialog.test.tsx`
- Modify: `tests/unit/components/OrderSection.actions.test.tsx`
- Modify: `tests/unit/components/AttentionInbox.test.tsx`
- Modify: `tests/unit/components/AdminOrderHistoryWiring.test.tsx`

**Interfaces:**

- Consumes: Task 9のC-3、`FulfillmentDeliveryDetail`・履歴union・`DeliveryAttentionItem`・C-5コピー。
- Produces: 下の宣言と、既存 `OrderHistoryDialog.onChanged` で一覧/要対応を読み直す接続。

```ts
// 各新しいdialogはdefault export、React.JSX.Elementを返す。
export type DeliveryDialogProps = { open:boolean; orderId:string; fulfillment:FulfillmentDeliveryDetail; trackingEnabled:boolean; onClose:()=>void; onChanged:()=>void };
// このpropsはOrderTrackingEditDialog.tsxでexportし、OrderDeliveredDialog.tsxがtype importする。
// delivery-client.ts
export function submitTrackingEdit(orderId:string,fulfillmentId:string,body:Pick<UpdateTrackingInput,'requestKey'|'carrier'|'trackingNumber'|'notifyCustomer'>):Promise<DeliveryCallResult<UpdateTrackingResult>>;
export function submitManualDelivered(orderId:string,fulfillmentId:string,body:Pick<MarkDeliveredInput,'requestKey'|'deliveredOn'|'notifyCustomer'>):Promise<DeliveryCallResult<MarkDeliveredResult>>;
```

`OrderHistoryDialog` と内部bodyのpropsに `canManageDelivery?:boolean`（省略false）。`AttentionInbox` に `onOpenDeliveryHistory?:(orderId:string)=>void;onResolveDelivery?:(attentionId:string)=>void`。pageは `userRole==='admin'||userRole==='supporter'` の時だけ書くcallbackと管理ボタンの権限を渡す。既存のrefund権限を広げない。

- [x] **Step 1: コピー・表示条件・再送の落ちる部品試験を書く**

```ts
test('OFFの履歴にも配達済みと直しと過去の移り変わりを出す');
expect(screen.getByText('お届け日 10月21日（手で）')).toBeVisible();
expect(screen.queryByText('追跡中')).not.toBeInTheDocument();
test('ONは現在の状況・最後の更新・登録・細かい記号を出す');
expect(screen.getByText('不在で持ち帰り')).toBeVisible();
test('取消には2つのボタン無し、配達済みには直すだけ');
expect(screen.queryByRole('button',{name:'配達済みにする'})).not.toBeInTheDocument();
test('配達済みを直す時は返品の期限の警告を出す');
expect(screen.getByText('配達済みの記録が消え、返品の期限は新しい届いた日から数え直します')).toBeVisible();
test('開いた時のuuidを通信切れの再送で保つ');
expect(secondBody.requestKey).toBe(firstBody.requestKey);
expect(secondBody).toEqual(firstBody);
test('配送だけある要対応の欄も表示する');
expect(screen.getByRole('heading',{name:'配送'})).toBeVisible();
```

追加: ON/OFFの説明の全文、初期notifyは発送の値、手のメールチェックはnotify=true時だけ（falseなら送るbodyもfalse）、届いた日の初期値はJST今日/min発送日/max今日、未入力と無効な日付。POST中の二重押し、401/403/429は番号保持、400/404/409は入力へ戻し新しい番号、5xx/通信切れ/読めない成功本文はunknownとして入力を凍結し同じ番号/内容だけ再送できる。成功後は履歴/一覧/attentionを読み直す。

OrderSectionの複数attentionの優先順、0件で配送の組を消す、配達済みの行に再送ボタン無し、ON/OFFの履歴の6-1表を行ごとにtest.each。role=dialogの名前、開く/戻る/閉じるのfocus、Escape、Tab、390px相当の狭い配置で番号が折り返すことも部品の属性/配置で確認する。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/components/OrderTrackingEditDialog.test.tsx tests/unit/components/OrderDeliveredDialog.test.tsx tests/unit/lib/orders/tracking/delivery-client.test.ts tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/AttentionInbox.test.tsx --runInBand`。
Expected: FAIL（dialog/配送の組/新しい履歴が無い）。

- [x] **Step 3: 宣言とC-5の画面を実装する**

既存のDialog/Button/入力部品と `clientFetch` を使い、C-3のbody以外を送らない。requestKeyは画面を開いた時に `crypto.randomUUID()`。結果不明では一時保存した同じbodyを使い、入力は変えさせない。親の履歴の現在値と差し替えず、再送で前の結果を取ってから読み直す。

履歴の現在の状況/登録はONだけ、配達済みと直しと記録済みの出来事はOFFでも出す。providerSubStatusは小さな字で文字として出す。配送の要対応の行はorderNumber/何回目/種類/開いた時刻/現在状況だけ。resolveはpageのcallbackがC-3を呼び、processingIdsにattentionIdを入れる。成功後のC-5のnoticeと、全部閉じた時の組の消失をつなぐ。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2 の対象＋`tests/unit/components/OrderSection.actions.test.tsx tests/unit/components/AdminOrderHistoryWiring.test.tsx`、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。部品の試験をDB/ブラウザの証拠としない。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/components/OrderTrackingEditDialog.tsx src/components/OrderDeliveredDialog.tsx src/lib/orders/tracking/delivery-client.ts src/components/OrderHistoryDialog.tsx src/components/OrderSection.tsx src/components/AttentionInbox.tsx src/app/admin/page.tsx tests/unit/components/OrderTrackingEditDialog.test.tsx tests/unit/components/OrderDeliveredDialog.test.tsx tests/unit/lib/orders/tracking/delivery-client.test.ts tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/OrderSection.actions.test.tsx tests/unit/components/AttentionInbox.test.tsx tests/unit/components/AdminOrderHistoryWiring.test.tsx
git commit -m "feat: 配送の直しと配達済みと要対応の画面を追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: ショップの設定の画面

**Files:**

- Modify: `src/components/ShopSettingsSection.tsx`
- Modify: `tests/unit/components/ShopSettingsSection.test.tsx`

**Interfaces:**

- Consumes: Task 9 GET/PUT の `deliveryTracking:DeliveryTrackingSettings` と任意入力 `{deliveryTracking:{enabled:boolean}}`、既存必須2トグル・returns。
- Produces: SETTINGS の自動の返金と返品の間のC-5の「配送の追跡」。既存の `ShopSettings` の2キーを増やさず、LoadedSettingsに `deliveryTracking:DeliveryTrackingSettings|null` を別に持つ（古い見本だけnullを許す。実際の答えは必須）。

- [x] **Step 1: トグル・件数・確認の落ちる部品試験を書く**

```ts
test('自動の返金、配送の追跡、返品の順に出す');
expect(sectionNames).toEqual(['自動の返金','配送の追跡','返品']);
test('鍵の値は出さず未設定ならトグルを押せない');
expect(screen.getByRole('switch',{name:'配送の追跡（17TRACK）を使う'})).toBeDisabled();
expect(screen.getByText('鍵：未設定')).toBeVisible();
test('ON前にGETで件数を読み直しN件を確認する');
expect(screen.getByText('30日以内に発送した配達済みでない発送（12件）も 17TRACK に登録します。1件ごとに 17TRACK の件数を使います')).toBeVisible();
test('確認を戻るとPUTしない');
expect(put).not.toHaveBeenCalled();
test('OFF確認と保存は配送だけを変える');
expect(body.deliveryTracking).toEqual({enabled:false});
expect(body).not.toHaveProperty('returns');
test('途中の失敗はGETし直し部分保存した値を反映する');
expect(screen.getByText('設定を保存できませんでした。現在の設定を読み直しました。')).toBeVisible();
```

説明3文の全文、ON/OFF確認の全文、0件の確認、GETの間に鍵が消えるケース（押せない/エラー）、metadataの人/時刻/NULL、待ちの二重押し、保存のbodyが直前にGETした既存2トグルを保つ、returnsの保存は配送入力を送らないことを試す。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/components/ShopSettingsSection.test.tsx --runInBand`。
Expected: FAIL（配送のsectionが無い）。

- [x] **Step 3: C-5の欄と確認を実装する**

鍵は未設定なら「オンにする」を禁止する。すでにONで鍵が消えた時もOFFにする操作は許す（P5のONだけ拒否と整合）。文中の「トグルを押せず」はOFF→ONの道に適用する。ON確認を開く直前にGETし、件数/鍵/2トグルを取り直し、確認後のPUTにその2トグルと配送だけを送る。保存成功の実数を現在の設定へ反映し、確認中に件数が増えた差を失敗にしない。

説明は設定済み/未設定にかかわらず出す。鍵文字列を保持するstateやinputは作らない。最後に変えた人・時刻は既存トグルと同じ形。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。既存の自動返金と返品の保存の試験も通る。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/components/ShopSettingsSection.tsx tests/unit/components/ShopSettingsSection.test.tsx
git commit -m "feat: 設定に配送の追跡の切り替えを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: お客様の画面と進み具合

**Files:**

- Modify: `src/lib/orders/order-progress.ts`
- Modify: `src/lib/orders/fulfillment/fulfillment-materials.ts`
- Modify: `src/app/api/orders/[id]/route.ts`
- Modify: `src/app/api/orders/route.ts`
- Modify: `src/app/api/admin/orders/route.ts`
- Modify: `src/app/account/orders/[id]/page.tsx`
- Modify: `src/app/privacy/page.tsx`
- Modify: `src/components/ShopReturnSettingsSection.tsx`
- Modify: `tests/unit/lib/orders/order-progress.test.ts`
- Modify: `tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts`
- Modify: `tests/unit/api/orders/order-detail-progress.test.ts`
- Modify: `tests/unit/api/orders/orders-list-progress.test.ts`
- Modify: `tests/unit/api/admin/orders-search-route.test.ts`
- Modify: `tests/unit/components/AccountOrderDetailPage.test.tsx`
- Modify: `tests/unit/components/ShopReturnSettingsSection.test.tsx`
- Create: `tests/unit/components/PrivacyPage.test.tsx`
- Modify: `tests/integration/api/orders.test.ts`

**Interfaces:**

- Consumes: Task 4 の `OrderDeliverySummary/OrderDeliveryDetail/CustomerDelivery`、Task 5 のkeyConfigured、Task 2の返品の期限、既存 `OrderLineProgressCounts`。
- Produces: `deriveOrderProgress(status:OrderStatus,lines:readonly OrderLineProgressCounts[],options?:{hasOpenRefund?:boolean;delivery?:Pick<OrderDeliverySummary,'activeCount'|'deliveredCount'>}):OrderProgress`。APIの `shipments[].deliveredAt:string|null;delivery?:CustomerDelivery`、既存のprogress/steps/list labelにdeliveredが到達する。`PrivacyPage` は asyncなrequest時のServer Component。

- [x] **Step 1: 表示の条件と進み具合の落ちる試験を書く**

```ts
test('全部の取消でない発送が配達済みなら配達済み');
expect(progress.key).toBe('delivered');
expect(progress.label).toBe('配達済み');
expect(steps.every(step=>step.state==='done')).toBe(true);
test('一部だけ配達済みと発送0件は配達済みにしない');
expect(partial.key).toBe('in_transit');
expect(empty.key).not.toBe('delivered');
test('発送準備中か受注生産中の品が残れば先の段を保つ');
expect(ready.key).toBe('ready');
expect(making.key).toBe('in_production');
test('鍵が無い間は記録済みの輸送中も返さない');
expect(shipment).not.toHaveProperty('delivery');
expect(shipment.deliveredAt).toBeNull();
test('OFFでも配達済みとお届け日は残す');
expect(shipment.deliveredAt).toBe(deliveredAt);
expect(screen.getByText('お届け日 10月21日')).toBeVisible();
test('privacyの17TRACKの一文はONだけ');
expect(offHtml).not.toContain('配送状況の確認業務');
expect(onHtml).toContain('配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）');
```

顧客のサーバーの射影を `test.each` で固定する:

| ON | 鍵あり | 現版の登録 | deliveredAt | deliveryキー | 顧客の表示 |
|---|---|---|---|---|---|
| false | 任意 | 任意 | NULL | 無し | 追跡のリンクだけ |
| true | false | registered/stopped | NULL | 無し | 追跡のリンクだけ |
| true | true | 無し/pending/failed | NULL | 無し | 追跡のリンクだけ |
| true | true | registered/stopped | NULL | 有り | 現版の状況/最後の更新/現版の出来事 |
| 任意 | 任意 | 任意 | 値あり | 条件を満たす時だけ | 常に配達済みとお届け日 |

他人/無い/隠す状態は既存404、DB読取失敗は500（空の履歴で偽の配達済みにしない）。顧客JSONを再帰検査し `actorEmail/providerSubStatus/registration/trackingChanges/createdBy/leaseToken` がどこにも無い、取消発送と旧版イベントが無いことを固定する。顧客の配送イベントは新しい順、status/happenedAtだけ。日本時間の前日/翌日への表示、問題あり/遅れのC-5一文、unknown legacy carrierの従来の表示も試す。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/lib/orders/order-progress.test.ts tests/unit/api/orders/order-detail-progress.test.ts tests/unit/api/orders/orders-list-progress.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/unit/components/PrivacyPage.test.tsx --runInBand`。
Expected: FAIL（deriveはまだdeliveredを選ばず、新しい射影/委託文が無い）。

- [x] **Step 3: 宣言・射影・C-5の表示を実装する**

deriveの固定payment/cancelled/failed等とhasOpenRefundの優先順を保ち、受注生産/発送準備の残りが無い場合にだけ `activeCount>0 && deliveredCount===activeCount` を選ぶ。渡さない既存の呼び出しは従来どおり。Task 12では全呼び出し元（顧客の一覧・詳細、管理の一覧、fulfillment-materials）へDBの集計を渡す。取消はDBの集計から除き、注文のstatusの列や絞り込みを変えない。

顧客GETはownerを確かめた後にservice_roleで配送を読む。登録状態/設定/鍵でdeliveryキーを作るかサーバーが決める。値なしをnullで付けるのではなくキーを省く。deliveredAtだけは常に付け、画面はその値を優先して配達済みを出す。追跡のリンクは既存shipping-carriersから、新しい番号だけ。

privacyはローカルguide `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md` を読み、`await connection()` の後に設定を読み、ビルド時にDBへ行かずrequest時のONを反映する。現在のnext.config.tsはcacheComponentsの指定無し。設定を読めない時は一文を黙って出し分けせずページの失敗として扱う。鍵なしでもONなら委託文を出す（15章の条件は設定のON）。

返品の説明はC-5へ置き換え、窓口/画面で期限を独自計算しない。`tests/integration/api/orders.test.ts` の差し替えDBに新しい読取の答えを足し、既存のownerと返金/返品の試験を保つ。

- [x] **Step 4: GREEN を確かめる**

Run: `npx jest tests/unit/lib/orders/order-progress.test.ts tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts tests/unit/api/orders tests/unit/api/admin/orders-search-route.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/unit/components/ShopReturnSettingsSection.test.tsx tests/unit/components/PrivacyPage.test.tsx tests/integration/api/orders.test.ts --runInBand`、`npx tsc --noEmit`。
Expected: PASS、型の誤り0。ここは差し替えのAPI/部品試験。返品の期限のDB証拠はTask 2、画面からの一連の証拠はTask 13。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add src/lib/orders/order-progress.ts src/lib/orders/fulfillment/fulfillment-materials.ts src/app/api/orders/[id]/route.ts src/app/api/orders/route.ts src/app/api/admin/orders/route.ts src/app/account/orders/[id]/page.tsx src/app/privacy/page.tsx src/components/ShopReturnSettingsSection.tsx tests/unit/lib/orders/order-progress.test.ts tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts tests/unit/api/orders/order-detail-progress.test.ts tests/unit/api/orders/orders-list-progress.test.ts tests/unit/api/admin/orders-search-route.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/unit/components/ShopReturnSettingsSection.test.tsx tests/unit/components/PrivacyPage.test.tsx tests/integration/api/orders.test.ts
git commit -m "feat: 注文に配達済みと配送の移り変わりを表示" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: 作り物の 17TRACK と E2E

**Files:**

- Create: `scripts/e2e/fake-17track.mjs`
- Modify: `scripts/e2e/environment.ts`
- Modify: `scripts/e2e-server.mjs`
- Modify: `tests/unit/scripts/e2e/environment.test.ts`
- Create: `tests/unit/scripts/e2e-server-tracking.test.ts`
- Create: `e2e/delivery-tracking-test-utils.ts`
- Create: `e2e/FR-ADMIN-100-fulfillment-tracking-edit.spec.ts`
- Create: `e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts`
- Create: `e2e/FR-ADMIN-102-delivery-tracking-sync.spec.ts`
- Create: `e2e/FR-ADMIN-103-delivery-attention.spec.ts`
- Create: `e2e/FR-ADMIN-104-delivery-tracking-settings.spec.ts`
- Create: `e2e/FR-ACCOUNT-041-delivery-without-tracking.spec.ts`
- Create: `e2e/FR-ACCOUNT-042-delivery-tracking.spec.ts`
- Create: `e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts`
- Modify: `e2e/admin-test-utils.ts`
- Modify: `e2e/order-fulfillment-test-utils.ts`
- Modify: `e2e/order-detail-fixtures.ts`
- Modify: `e2e/return-request-test-utils.ts`
- Modify: `e2e/FR-ADMIN-060-order-attention-inbox.spec.ts`
- Modify: `e2e/FR-ADMIN-070-order-progress-labels.spec.ts`
- Modify: `e2e/FR-ADMIN-079-shop-settings.spec.ts`
- Modify: `e2e/FR-ADMIN-092-shop-return-settings.spec.ts`
- Modify: `e2e/FR-ADMIN-098-return-request-settings.spec.ts`
- Modify: `e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts`

**Interfaces:**

- Consumes: Task 5の共通fixture、Task 6のworker/毎分の実route、Task 7の署名route、Task 8のMailpit、Task 9〜12の画面と契約。コメントの正はTask 14の40 AC。
- Produces: fake のHTTP contractと新8本×2ケース×3幅=48ケース。テストの道具の宣言は下記。既存の `playwright.config.ts` の `webServer.command='node scripts/e2e-server.mjs'` は保つ。

```ts
// delivery-tracking-test-utils.ts
export const deliveryViewports = [{name:'mobile',width:390,height:844},{name:'tablet',width:768,height:1024},{name:'desktop',width:1280,height:900}] as const;
export function withDeliveryScenario<T>(run:(context:{client:PgClient;numberPrefix:string})=>Promise<T>):Promise<T>;
export function setFakeTracking(input:{carrier:100062|100040|10021;number:string;responseKey:string;happenedAt?:string;deliveredAt?:string}):Promise<void>;
export function sendSignedTrackingWebhook(input:{carrier:100062|100040|10021;number:string;event:'TRACKING_UPDATED'|'TRACKING_STOPPED';invalidSign?:boolean}):Promise<Response>;
export function runTrackingMinuteJob():Promise<void>;
export function mockAdminDeliveryBridge(page:Page,context:{client:PgClient;orderIds:string[]}):Promise<void>;
export function readFakeTrackingCalls(pair:{carrier:number;number:string}):Promise<Array<{path:string;number:string;carrier:number}>>;
```

fake の受け口:

| method/path | 動き |
|---|---|
| GET `/__health` | `{fake:'17track-v2.4'}`、違う既存プロセスを再利用しない |
| POST `/track/v2.4/register` | 40件以下のnumber/carrierだけを受け、登録済みは-18019901。指定のfixtureのrejectedも返せる |
| POST `/track/v2.4/retrack` | activeは-18019904、停止済みは1回だけ成功、2回目-18019905 |
| POST `/track/v2.4/gettrackinfo` | 指定した fixture の accepted[].track_info、未登録は-18019902 |
| POST `/track/v2.4/stoptrack` | 停止を記録、停止済みは-18019906 |
| POST `/__control/state` | `setFakeTracking` のinputで自分の組の状態を変える（fixtureをcloneしてnumber/carrier/時刻だけ差し替え） |
| GET `/__control/calls?carrier=...&number=...` | 自分の組の呼び出しだけ。見出し/鍵/名前/住所は記録しない |
| DELETE `/__control/state?carrier=...&number=...` | 自分の組だけ消す。全件resetは作らない |

controlの見出し `x-e2e-control` は作り物の鍵だけ、通常pathは `17token` を確かめる。fakeはloopbackだけにbindし、実APIへ転送する機能は作らない。

- [x] **Step 1: 環境の守りと新しい E2E の落ちる試験を書く**

```ts
test('E2Eは17TRACKの本番URLと省略のfallbackを拒む');
expect(findUnsafeE2ESettings({...safeEnv,TRACKING_17TRACK_BASE_URL:'https://api.17track.net/track/v2.4'})).not.toEqual([]);
expect(findUnsafeE2ESettings({...safeEnv,TRACKING_17TRACK_BASE_URL:undefined})).not.toEqual([]);
test('明示の危険なURLをoverride前にも拒む');
expect(()=>prepareE2EEnvironment(unsafeInput)).toThrow('17TRACK');
test('localhostでも別pathとURL内の認証情報は拒む');
expect(unsafePaths.every(url=>findUnsafeE2ESettings({...safeEnv,TRACKING_17TRACK_BASE_URL:url}).length>0)).toBe(true);
test('直接の起動も危険なURLならfakeやbuildの前に終了する');
expect(scriptExitCode).toBe(1);
expect(scriptStderr).toContain('17TRACK');
expect(scriptStdout).not.toContain('[e2e-server] ready');
test('fakeのURLと契約版が変わればfingerprintが変わる');
expect(fingerprintA).not.toBe(fingerprintB);
```

新しいE2Eの各ケースは下表の名前と期待を持つ。各幅で `document.documentElement.scrollWidth<=innerWidth` とdialogの見切れ無しも確認する。Task 14の対応ACのコメントをケースの直前へ付ける。

| spec | ケース1（各幅） | ケース2（各幅） |
|---|---|---|
| ADMIN-100 | `追跡オフで番号を直し発送の更新が1通届く`：新番号/直し履歴/メール全文/外への登録0 | `配達済みの番号を直し通知を外す`：警告、version+1、confirmed、delivered_at消去、メール0、配送メール再送ボタン無し |
| ADMIN-101 | `届いた日を選び手で配達済みとメールと期限を記録する`：JST日付/手で/1通/全発送配達済みの進み具合 | `取消と配達済みの操作を出さず通知オフを保つ`：ボタン条件とメール0、下限/上限入力の表示 |
| ADMIN-102 | `オンの発送を登録し知らせから配達中と配達済みへ進む`：register→get、payloadは偽DeliveredでgetはInTransit、署名不正401、次に配達中/配達済み | `同じ知らせの再送でも出来事とメールは各1回`：同じ合図2回、各1通、delivered後のout_for_delivery0、追跡停止 |
| ADMIN-103 | `問題ありを対応済みにし回復後の再発で開き直す`：印→配送の組→履歴→manual resolve→in_transit→failureの新attention | `不在と追跡できない印の優先を出す`：failure優先、attempted、untrackable。0件の組は消失 |
| ADMIN-104 | `オンの取り込みの件数とオフの確認を表示する`：GETのN、PUTの実数、登録、OFF停止/attention閉じ/履歴残存 | `鍵未設定ではオンにできず最後の変更を表示する`：keyConfigured=falseのAPI見本、switch禁止/文/PUT0、保存済みmetadata |
| ACCOUNT-041 | `追跡オフはリンクだけで手の配達済みは見える`：初期deliveryキー無し、手で届いた日/進み具合/一覧のlabel | `追跡オフの知らせは無視し返品は届いた日を使う`：署名あり200/外への呼出し0、DBの期限と顧客の期限が一致 |
| ACCOUNT-042 | `配達中から配達済みと新しい順の移り変わりを出す`：現版の状況/最後の更新/日本時間/メール/届いた日/期限 | `直した番号だけを出し一部の配達済みは配送中のまま`：旧版履歴無し、新リンク、他の未配達/未発送の優先 |
| ACCOUNT-043 | `登録待ちと失敗と鍵なしとオフで状況を隠す`：APIからキー無し、deliveredAtは常に保持、OFFで以前の輸送中を隠す | `オンだけ委託の文を出し顧客JSONに店内の情報を出さない`：privacy全文、owner404、actor/sub_status/登録のキー無し |

- [x] **Step 2: controller が RED を確かめる**

Run: `npx jest tests/unit/scripts/e2e/environment.test.ts tests/unit/scripts/e2e-server-tracking.test.ts --runInBand`。
Expected: FAIL（URLの見張り/fake起動が無い）。新E2Eもcontrollerがローカル環境で流し、fake未作成による起動の失敗を控える（起動の失敗とアプリのassertionの失敗を区別）。

- [x] **Step 3: fakeと見張りと橋渡しを実装する**

P14/P15のとおり `E2E_FIXED_ENV` に fake URL `http://127.0.0.1:4017/track/v2.4` と作り物の鍵を足す。baseEnvに明示の非local URLがあればoverrideで隠さず停止。未指定のbaseEnvにはfakeのoverrideを入れた後で必須検査する。workerは受け継いだ安全な値だけを検査。`scripts/e2e-server.mjs` の直起動は未指定も拒否する。

serverスクリプトはfakeを隠れた別プロセスで起こし、healthが正しい時だけ再利用する。ビルド前にも見張る。既存のNextアプリのfingerprint/reuse/strictの守りを保つ。4017番に別プロセスがいれば止めずに失敗させる。

`withDeliveryScenario` は専用pg接続で `pg_advisory_lock(940488)` を取り、新8本の設定変更をファイルをまたいで直列にする。テストごとの番号prefixでfakeを分け、finallyで配送設定を元に戻し自分のfakeの組だけ消してlockを返す。顧客のログインは既存の `createTestMember/loginAsMember`、注文/発送は本物のローカルRPC。時間を進める必要がある予定はテスト用SQLで自分の登録のnext_run_atだけ今にする。運送会社のHTTPはfake、メールはMailpitで対象注文の3種類を数える。

状態とメールを待つ時は `expect.poll`（timeout=30000ms）で毎分routeの実行と読み取りを繰り返し、固定のsleepで成功を仮定しない。登録→読み直し→次の起動のメール送り出しという順を保つ。

管理者の橋渡しは許したorderIdsだけを扱い、書く3操作/設定の配送toggleは本物のSQL関数を呼ぶ。履歴/一覧/要対応もC-2へ射影した本物のDB結果。起動したアプリの毎分routeを `CRON_SECRET` で呼び、本物の17TRACK clientを進める。管理RBAC/CSRFは差し替えなのでTask 9の証拠、ADMIN-104の鍵なしとACCOUNT-043の鍵なしの表示はAPI見本であり本物の環境変更の証拠ではないと台帳に書く。

既存E2Eの直す所は確認済みの契約に限る。共通のadmin attention見本にdeliveries/count0、history見本にdelivery、顧客shipment見本にdeliveredAt、settings見本にdeliveryTrackingを追加。ADMIN-079/092/098のsection/説明と保存の期待を新しい任意fieldの形に合わせる。ACCOUNT-032/ADMIN-070の未配達の見本は未配達のままにし、新たにdeliveredの到達の期待を足す。全件の結果で別の破損が出た時はそのファイルを台帳に記し、所有Taskへ戻して直す。

- [x] **Step 4: controller が GREEN を確かめる**

Run: Step 2の単体、`npx tsc --noEmit`。reset後、3000/4017番の所有を確認して `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/FR-ADMIN-100 e2e/FR-ADMIN-101 e2e/FR-ADMIN-102 e2e/FR-ADMIN-103 e2e/FR-ADMIN-104 e2e/FR-ACCOUNT-041 e2e/FR-ACCOUNT-042 e2e/FR-ACCOUNT-043`。
Expected: 新8本48ケースが全てexpected、skip0。fakeのcallsに外のURLや名前/住所が無い。既存6本も同じlocal環境で流してexpected（前から失敗ならTask 15の前後比較で個別判定）。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add scripts/e2e/fake-17track.mjs scripts/e2e/environment.ts scripts/e2e-server.mjs tests/unit/scripts/e2e/environment.test.ts tests/unit/scripts/e2e-server-tracking.test.ts e2e/delivery-tracking-test-utils.ts e2e/FR-ADMIN-100-fulfillment-tracking-edit.spec.ts e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts e2e/FR-ADMIN-102-delivery-tracking-sync.spec.ts e2e/FR-ADMIN-103-delivery-attention.spec.ts e2e/FR-ADMIN-104-delivery-tracking-settings.spec.ts e2e/FR-ACCOUNT-041-delivery-without-tracking.spec.ts e2e/FR-ACCOUNT-042-delivery-tracking.spec.ts e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts e2e/admin-test-utils.ts e2e/order-fulfillment-test-utils.ts e2e/order-detail-fixtures.ts e2e/return-request-test-utils.ts e2e/FR-ADMIN-060-order-attention-inbox.spec.ts e2e/FR-ADMIN-070-order-progress-labels.spec.ts e2e/FR-ADMIN-079-shop-settings.spec.ts e2e/FR-ADMIN-092-shop-return-settings.spec.ts e2e/FR-ADMIN-098-return-request-settings.spec.ts e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts
git commit -m "test: 配送の作り物と3画面幅のE2Eを追加" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: 要求と設計と運用の文書

**Files:**

- Modify: `docs/02_Requirements/requirements.md`
- Modify: `docs/03_BasicDesign/api/api-spec.md`
- Modify: `docs/03_BasicDesign/api/route-inventory.md`
- Modify: `docs/03_BasicDesign/data/er.md`
- Modify: `docs/03_BasicDesign/ui/screen-list.md`
- Modify: `docs/03_BasicDesign/ui/screen-flow.md`
- Modify: `docs/04_DetailDesign/pages/15_account.md`
- Modify: `docs/04_DetailDesign/pages/16_admin.md`
- Modify: `docs/04_DetailDesign/pages/17_privacy.md`
- Modify: `docs/04_DetailDesign/states/order-payment.md`
- Modify: `docs/04_DetailDesign/sequence/order-administration.md`
- Modify: `docs/04_DetailDesign/sequence/stripe-webhooks.md`
- Modify: `docs/04_DetailDesign/states/stripe-webhook-queue.md`
- Modify: `docs/06_Operations/order-email-operations.md`
- Modify: `docs/06_Operations/webhook-queue-operations.md`
- Modify: `supabase/pending/README.md`
- Modify: `docs/superpowers/specs/2026-10-10-group-e-overview-design.md`
- Modify: `docs/superpowers/specs/2026-10-10-partial-fulfillment-design.md`
- Modify: `docs/superpowers/specs/2026-10-09-order-email-outbox-design.md`
- Modify: `docs/superpowers/specs/2026-10-12-returns-design.md`
- Modify: `.env.example`
- Create: `tests/unit/docs/delivery-status-traceability.test.ts`

**Interfaces:**

- Consumes: Task 1〜13の最終契約、設計書12/14/15章、以下の40 AC（コメントの番号の正）。
- Produces: FREQ-488〜497の10行・40 AC。要求/実装/試験の対応、3本の移行と19メール種類、開店前の手順。旧仕様書は過去の決定の本文を消さず、E-4詳細への参照と実装後の状態の注記を足す。

AC表では `ADMIN-100` はTask 13の同じ番号のspec、`ACCOUNT-041`も同じ。E2E欄が「—」の物をE2Eの証拠と呼ばない。DB/単体の名称はTaskのFilesの試験を指す。requirementsの列の形式は既存FREQ-487に揃える。

| AC | 受け付け基準 | 所有Task・DB/単体 | E2E（各3幅） |
|---|---|---|---|
| FREQ-488-AC-01 | いつも業者/番号を直せ、version+1とconfirmed、古い登録停止、新版30日 | 2/9/10 admin | ADMIN-100 |
| FREQ-488-AC-02 | 配達済みも警告して直せ、届いた時刻を消し期限を目安へ戻す | 2/10 admin | ADMIN-100 |
| FREQ-488-AC-03 | 直す時のnotifyがこの先へ効き、ONだけshipping_update1通 | 2/8/10 email | ADMIN-100 |
| FREQ-488-AC-04 | 同じキーは元の結果、異なる入力は拒否、作成の再送も直した番号を戻さない | 2 admin、10 client | — |
| FREQ-489-AC-01 | 発送日〜今日、JST正午を発送と今で挟む | 2 admin、10 dialog | ADMIN-101 |
| FREQ-489-AC-02 | manual記録、追跡停止、attention閉鎖、両notifyの時だけメール | 2 admin、8 email | ADMIN-101 |
| FREQ-489-AC-03 | 取消/配達済みへの再操作拒否、画面のボタン条件 | 2/10 | ADMIN-101 |
| FREQ-490-AC-01 | 最初はOFFで外へ0回、ONの発送はpendingから登録 | 2/6 | ADMIN-102、ACCOUNT-041 |
| FREQ-490-AC-02 | 全8状況の対応、未知は保持、同版trackingだけで時刻比較、届いた時刻の下限 | 3 sync、4 status | — |
| FREQ-490-AC-03 | lease/版/取消/設定で古い結果を捨て、処理中の合図を残す | 3 sync | — |
| FREQ-490-AC-04 | 3分類と5回/日次回復、invalid/retrack2回目は再試行無し | 3/5/6 | — |
| FREQ-490-AC-05 | 6時間/72時間/版ごと30日、ever_registeredだけ期限のattention | 3 sync | — |
| FREQ-491-AC-01 | 鍵→1MiB→署名→JSON→モードの順で503/413/401/400/200/500 | 7 webhook | ADMIN-102（署名401） |
| FREQ-491-AC-02 | 署名ありも合図だけ、記録はgettrackinfo、再送は冪等 | 3/5/7 | ADMIN-102 |
| FREQ-491-AC-03 | carrierとupper番号で全行照合、共有番号の停止が他発送を止めない | 3 sync、6 worker | — |
| FREQ-491-AC-04 | 401が10分5回なら1日1回の運用通知、本文/署名をログへ出さない | 6 ops、7 route | — |
| FREQ-492-AC-01 | 3件名/本文/商品と数/リンク/設定の日数、無制限は案内無し | 8 compose | ADMIN-100/101/102 |
| FREQ-492-AC-02 | 配達中/配達済みは発送と版と種類、更新はchangeごと1通 | 1/2/3 | ADMIN-102 |
| FREQ-492-AC-03 | 保存済み本文も旧版/取消/配達済み後の配達中を送らず終える | 2 skip、8 worker | — |
| FREQ-492-AC-04 | 新3種類は再送不可、kindの正は19 | 8 types/routes、10 history | ADMIN-100 |
| FREQ-493-AC-01 | 6-1のON/OFF別の履歴、直しの人/値/メール状態と配達の出どころ | 9 history、10 component | ADMIN-100/101 |
| FREQ-493-AC-02 | 問題あり→不在→追跡できないの順の一覧の印、DB状態のfilter維持 | 9/10 | ADMIN-103 |
| FREQ-493-AC-03 | 配送の組/履歴を開く/手の解決/自動閉鎖/新しい条件の再発 | 3/9/10 | ADMIN-103 |
| FREQ-493-AC-04 | 読むadmin.orders.read、3書込admin.orders.manage、CSRF/IP/actor制限 | 9 routes | — |
| FREQ-494-AC-01 | ONかつ鍵ありのregistered/stoppedだけ状況を返し、ほかはキー無し | 12 route | ACCOUNT-043 |
| FREQ-494-AC-02 | 準備/生産なし、active>0の全発送deliveredで注文の配達済み、部分は配送中 | 12 progress/API | ACCOUNT-041/042 |
| FREQ-494-AC-03 | 本人だけ404、現版のstatus/時刻だけ、管理者/細かい状況/登録を漏らさない | 12 route | ACCOUNT-043 |
| FREQ-494-AC-04 | 届いたJST日付を返品期限へ使い、NULLは目安、最後の品/無制限/既存記録を保つ | 2 returnable、12 | ACCOUNT-041/042 |
| FREQ-494-AC-05 | 新番号のリンクと新しい順の現版の履歴、お届け日、遅れ/問題の一文 | 12 component | ACCOUNT-042 |
| FREQ-495-AC-01 | 初期OFF、店長だけ、鍵未設定はON拒否、鍵の値を返さない | 2/9/11 | ADMIN-104（未設定表示） |
| FREQ-495-AC-02 | ON確認の正確な対象件数、30日/取消/配達済み/版を選別して取り込み | 2 admin、9/11 | ADMIN-104 |
| FREQ-495-AC-03 | OFFは登録disabledとattentionauto、外のstop無し、記録と配達済みは保持 | 2/6/11/12 | ADMIN-104、ACCOUNT-043 |
| FREQ-495-AC-04 | 最後の人/時刻、既存2toggle/returnsの省略と部分保存を保つ | 9/11 | ADMIN-104 |
| FREQ-495-AC-05 | privacyの指定文はONだけ、OFFで出さず国外移転の文は維持 | 12 privacy | ACCOUNT-043 |
| FREQ-496-AC-01 | 毎分の順番とmin(8秒,残り)、3秒未満skip、既存予算と心拍 | 6 worker | — |
| FREQ-496-AC-02 | ONの鍵なし/口座/読取失敗を1日1回、予定を保ち個別attentionを増やさない | 3/6 | — |
| FREQ-496-AC-03 | fakeと共通fixture、E2Eが本番URL/省略/危険な再利用を拒否 | 5/13 environment | — |
| FREQ-497-AC-01 | 全新表のRLS/deny/service_role SELECT、public RPCはservice_role EXECUTEだけ | 1 records、4 PostgREST | — |
| FREQ-497-AC-02 | 直接UPDATE/DELETE拒否、owner+操作印、注文→発送の鍵、二重防止 | 1/2/3 | — |
| FREQ-497-AC-03 | 外へ番号とcarrierだけ、鍵/署名/本文/場所/氏名住所を漏らさない | 5/6/7/9/12 | ACCOUNT-043 |

- [x] **Step 1: ACと文書の落ちる静的試験を書く**

`tests/unit/docs/delivery-status-traceability.test.ts` はローカルの文字だけを読む。アプリ/DB/ネットワークを使わない。

```ts
test('FREQ-488から497の10行と40ACが一意で試験の対応を持つ');
expect(requirementIds).toEqual(Array.from({length:10},(_,i)=>`FREQ-${488+i}`));
expect(uniqueAcIds.size).toBe(40);
test('E2EのACコメントが要求表に存在し対応するspecだけを指す');
expect(unknownComments).toEqual([]);
test('3つの新routeと19メールと2モードがAPIと運用へ反映される');
expect(apiText).toContain('/api/webhook/17track');
expect(envNames).toEqual(expect.arrayContaining(['TRACKING_17TRACK_API_KEY','TRACKING_17TRACK_BASE_URL']));
```

旧仕様書へ付ける参照のリンク先の実在、ERの3public表＋登録表＋provider枠、route-inventoryの3管理POST＋1webhook、環境の値の行が空の鍵/公知のbaseURLだけであることも確認する。reqの説明文中に繰り返すACは一意な番号の集合で数え、列の数を誤認しない。

- [x] **Step 2: RED を確かめる**

Run: `npx jest tests/unit/docs/delivery-status-traceability.test.ts --runInBand`。
Expected: FAIL（要求行/AC/環境名/route文書がまだ無い）。

- [x] **Step 3: 上のAC表と最終のコードで文書を更新する**

追加前に `rg -n '^\| FREQ-48[7-9] ' docs/02_Requirements/requirements.md` で最後が487を確認し、488以降が他作業で使われていたら番号を勝手にずらさず止めて報告する。Task 13のFR番号も同じ。要求は設計書と上の表の言葉で10行にまとめ、REQ番号/AC番号は既存の列の書式へ合わせる。

| 文書 | 足す/直す内容 |
|---|---|
| API・route-inventory | C-3の4新path、settings任意入力/鍵有無/件数、履歴/attention/顧客の追加、守り/エラー。実コードからrouteの件数を数え、既存の合計へ4path/4methodを足す |
| ER | C-0の全列/制約/索引/追記/権限/17列claim、3移行、lockとlease、provider枠。orders.statusを増やさない |
| account/admin/privacyの設計 | 2モード、6-1/7-1の表示表、C-5文、キーの非表示、確認の件数/ボタン条件、委託のON条件 |
| 状態/sequence/queue | deriveの配達済み、返品の起点、配送の合図→get→同一取引、毎分の枠を追加。Stripeとメール配信の状態を荷物の配達と混同させない |
| 画面一覧/flow | 既存の履歴内のdialogと設定の欄を追記。新しいページURLは0（path総数を増やさない） |
| mail運用 | 19種類/3種類再送不可/旧版skip/設定の日数/無制限、店への接続の通知と顧客メールの区別 |
| webhook運用・pending README | 新しいcron登録は不要、毎分の既存ジョブに同居、OFFが最初、heartbeatsと各運用通知、手元fake/本番前確認 |
| 旧4設計書 | 今回の詳細仕様と計画へリンク。E-4の候補provider/常時追跡/返品の仮の起点は今回の決定を参照する注記。旧決定の履歴は残す |

`.env.example` は次の名前と公知のURLだけ追加する（値の入った他の環境ファイルを写さない）。

```dotenv
# 配送の追跡をオンにする時だけ必要（サーバー専用）
TRACKING_17TRACK_API_KEY=
TRACKING_17TRACK_BASE_URL=https://api.17track.net/track/v2.4
```

開店前の手順は設計書15をそのまま役割とともに残す: ユーザーが口座/鍵/受け口の登録、無料枠で3社の実番号、gettrackinfoの件数消費、本物の知らせの401無し、停止番号のretrack1回、200件前の購入、privacyの運営会社名/国の扱い、佐川の復旧を確認する。controllerは値を受け取らず手順と結果の記録を用意する。追跡を使わない店はこの設定無しで運用できる。

- [x] **Step 4: GREEN を確かめる**

Run: Step 2、`npm run -s validate-docs`、`npx tsc --noEmit`、名指しの `git diff --check`。
Expected: 静的試験PASS、今回追加したリンク/要求/routeの抜け0。既存の文書の失敗は実装前の一覧と照合して分ける。文書の合計の数だけを通すためにコードを増減しない。

- [x] **Step 5: controller が名指しでコミットする**

```bash
git add docs/02_Requirements/requirements.md docs/03_BasicDesign/api/api-spec.md docs/03_BasicDesign/api/route-inventory.md docs/03_BasicDesign/data/er.md docs/03_BasicDesign/ui/screen-list.md docs/03_BasicDesign/ui/screen-flow.md docs/04_DetailDesign/pages/15_account.md docs/04_DetailDesign/pages/16_admin.md docs/04_DetailDesign/pages/17_privacy.md docs/04_DetailDesign/states/order-payment.md docs/04_DetailDesign/sequence/order-administration.md docs/04_DetailDesign/sequence/stripe-webhooks.md docs/04_DetailDesign/states/stripe-webhook-queue.md docs/06_Operations/order-email-operations.md docs/06_Operations/webhook-queue-operations.md supabase/pending/README.md docs/superpowers/specs/2026-10-10-group-e-overview-design.md docs/superpowers/specs/2026-10-10-partial-fulfillment-design.md docs/superpowers/specs/2026-10-09-order-email-outbox-design.md docs/superpowers/specs/2026-10-12-returns-design.md .env.example tests/unit/docs/delivery-status-traceability.test.ts
git commit -m "docs: 配送の要求と設計と運用手順を更新" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: 全体の確かめと本番への出し方

**Files:**

- Evidence（gitの外）: `.superpowers/sdd/2026-10-21-delivery-status/progress.md`・`status-before.txt`・`base-commit.txt`・`e2e-baseline.json`・`e2e-results-group-e4.json`・`ac-trace.md`・`report-to-user.md`・各checkのログ。
- Evidence（gitの外）: `tmp/e4-fingerprint.sql`・`tmp/e4-before-apply.sql`・`tmp/e4-after-apply.sql`。
- Modify（検証と本番適用の記録だけ）: `docs/superpowers/plans/2026-10-21-delivery-status.md`・`docs/06_Operations/webhook-queue-operations.md`。
- Rename（許可を得た本番適用後だけ）: A/B/Cの3ファイルを実際に適用された版へ。旧名はP1、名前の末尾は変えない。

**Interfaces:**

- Consumes: Task 1〜14、C-0/C-1の全関数/表/索引、Task 14の40AC、新8本48ケース、前回の `.superpowers/sdd/2026-10-13-returns-stage2/e2e-results-group-e3-stage2.json`。
- Produces: 実測RED/GREEN数と全体の結果、前回との比較、40ACの証拠、本番前後の同じ定義の指紋/ACL、ユーザーへの確認可能な報告、OFFから始める本番適用の記録。

- [x] **Step 1: 実装前に場と基準を確かめる（Task 1の前）**

controllerが普段のアプリが本番DBへつながる注意を伝え、実装中は使わない/手元へ向ける方針を控える。`git rev-parse HEAD` と `git status --short` を作業場に残し、既存の `.claude/CLAUDE.md`・`package.json` 等の変更を実装の物へ混ぜない。実装前のunit/tsc/lint/validate-docsの結果も控える。

手元のSupabaseとMailpitが動くこと、普段の3000番の所有を確かめる。`npm run build` が通ることを確かめる。Docker/Smart App Controlの問題は勝手に設定変更で直さずユーザーへ理由を報告する。手元のDBが使えないままDBのGREENを主張して進めない。

前回のJSONは存在を読み、`stats.startTime` とテスト数/expected/unexpected/flaky/skippedを数えて写す。旧計画にある古い通過数を流用しない。`scripts/e2e/compare-baseline.ts` の `flattenPlaywrightJson` で `{tests:TestOutcome[]}` へ直し、作業場のe2e-baseline.jsonにする。元の前回JSONとmd5を保管し、`test-results/e2e-results.json` を基準にしない。元が無ければその場で報告し、代わりの基準をユーザーが指定するまで比較の証拠を作ったことにしない。

- [x] **Step 2: 全体の受け入れの RED と抜けを記録する**

Task 14の静的試験を使い、各ACに単体/DB/E2Eの証拠のパスがあり、新8本が48ケースあるかを調べる。新しいケースの名前と要点の固定値:

```ts
test('新しい48ケースに飛ばしと失敗が無い');
expect(newFiles).toHaveLength(8);
expect(newCases).toHaveLength(48);
expect(newCases.every(test=>test.outcome==='expected')).toBe(true);
test('40ACの証拠が揃い、前回通過からの回帰が無い');
expect(coveredAcIds.size).toBe(40);
expect(unexplainedRegressions).toEqual([]);
```

この段階で未実施/失敗/対応無しがあればREDとして台帳へ書き、所有Taskで修正する。全て済んでいる場合はREDを作るための壊す変更をせず、これまでの各TaskのREDのログを参照する。

- [x] **Step 3: 単体とJestのほかの範囲、型・lint・文書を確かめる**

Run:

```bash
npx jest tests/unit --runInBand
npx jest tests/features tests/items tests/integration/api tests/integration/lib tests/integration/auth-flow.test.ts tests/integration/csrf.test.ts --runInBand
npx tsc --noEmit
npm run lint
npm run -s validate-docs
```

Expected: 今回の範囲の失敗0。前からのskip/警告/文書の失敗はStep 1の実測と分け、増加は直す。tests/unitだけでpre-pushのJest全部を通したとしない。件数は実測を台帳へ書く。

- [x] **Step 4: controller がDB結合を全件流す**

3000番のE2Eのアプリはcommand lineで所有を確かめてから止める。普段のnext devならユーザーの予定を確かめる。動いたアプリのworkerとDB試験に同じ予定を取り合せない。

Run: `npx supabase db reset` → Global ConstraintsのDB環境の取得と `npx jest tests/integration/db --runInBand`。
Expected: A→B→Cの順に適用、全件PASS、skip0。新4スイート（records/admin/sync/postgrest）だけでなく従来の発送/返金/返品/メールもPASS。RLSのロール、2接続、17列claim、既存メールenqueue、期限の旧期待も通る。

- [x] **Step 5: DBをもう一度作り直し、本番ビルドのE2E全件を流す**

Run: `npx supabase db reset`、3000/4017番の確認、`PLAYWRIGHT_HTML_OPEN=never E2E_STRICT=1 npx playwright test`。
Expected: `scripts/e2e-server.mjs` がfake→build→start、見張りが実URLを拒否。全体の実測を保存し、先に `test-results/e2e-results.json` を `.superpowers/sdd/2026-10-21-delivery-status/e2e-results-group-e4.json` へ写す。部分的な再実行で全件の結果を上書きしない。

- [x] **Step 6: 前のE2Eと比べる**

Run:

```bash
npm run e2e:compare -- .superpowers/sdd/2026-10-21-delivery-status/e2e-baseline.json .superpowers/sdd/2026-10-21-delivery-status/e2e-results-group-e4.json
```

Expected: 新48ケースexpectedのみ、skip0。前に通り後で通らない物、新しい失敗、前にあり後に無い物を1件ずつ説明する。新しい失敗と原因不明の回帰0。前にも失敗していた管理/注文/設定/privacyの画面はerror-contextを比べ、前と同じ原因か確かめる。今回触った画面の失敗を「前から失敗」だけで除外しない。単独の再実行の結果と理由を台帳へ別に残す。

- [x] **Step 7: 契約と守りと指紋を静的に確かめる**

C-0/C-1を元に `tmp/e4-fingerprint.sql` を用意する。読み取りだけ。関数は `pg_get_functiondef`、CHECK/FK/UNIQUEは `pg_get_constraintdef`、索引は `pg_get_indexdef`、triggerは `pg_get_triggerdef`、RLS/policy、全新列の型/NULL/default、ACL/SECURITY DEFINER/search_path、opsの7job、outboxの19kindを列挙する。`(kind,name,md5(def),acl)` をC順に並べて全体md5を出し、定義の行ごとの指紋も残す。対象の名前が1つでも無ければmissing>0で失敗とする。

手元のreset直後の形でこのSQLを流し、`missing=0`、全publicの新/置換RPCはservice_roleだけ、privateのPUBLIC EXECUTEなし、新5表のservice_roleはSELECTだけ、deny/RLS=true、索引とON CONFLICTの述語一致を確認する。旧migrationを変更していないことを起点commitとのdiffで確かめる。

新SQLの `\\u[0-9a-fA-F]{4}` を検索する。文字列をJSONからSQLへ貼って `\u` と16進4字が残っていれば、日本語そのものへ直す。UTF-8・LF・末尾改行・CR無しを確認し、A/B/C各ファイルのmd5とbytesを控える。秘密の値、運送会社の文/場所、署名、raw本文が差分に無いことを確認する。

- [x] **Step 8: 最後の Opus レビューと必要な修正**

全Task後のOpusの全体レビューを1回行う。設計書全節、P-list、C-0〜C-6、40AC、Review Focusの5行、A/B/Cの元本文との差、lease/shared番号/設定切り替え/メールの競合、実測の検証ログを渡す。単体だけで本物のprovider/本番を確認したことにしていないかも確認する。

指摘は所有Taskで修正し、該当するRED→GREENを残す。コードを直した場合だけ影響する検証と全体の型/lintをやり直す。全件E2Eの結果に影響する修正ならreset→全件→比較を更新する。最終reviewで未解決の重大な指摘0。

- [x] **Step 9: GREENの報告を作り、検証の記録だけコミットする**

実施の記録（2026-10-22、手元だけ）: 単体 9,146 件通過・DB 結合 1,551 件通過・既存データでの予行演習 26 項目と適用後 12 項目が違反 0・指紋 missing 0・E2E 全件 3,549 件中 3,324 件通過（新しい 48 件と直した既存 156 件は全部通過、E-4 が起こした失敗 0）。詳しくは [運用の文書](../../06_Operations/webhook-queue-operations.md) の「手元の確かめの結果」。本物の 17TRACK と本番の DB は未確認。

`report-to-user.md` にunit/ほかのJest/DB/E2E/型/lint/文書の実測、前回比較、40AC、新48ケース、手元指紋、既存差分、未確認の本物の17TRACKの5点（返事/署名/課金/3社/retrack）を短く並べる。実装計画のチェックと運用文書へ手元の検証結果を記す。

```bash
git add docs/superpowers/plans/2026-10-21-delivery-status.md docs/06_Operations/webhook-queue-operations.md
git commit -m "docs: 配送の全体検証の結果を記録" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### 本番への出し方（ここからは全確認後、ユーザーの許可を得てから）

- [x] **Step 10: pushの許可を得てから、3000番のアプリを止めてpushする**

実装差分・実測・未確認・移行3本を見せて許可を得る。pushの許可をDB適用の許可としない。作業ツリーをStep 1と比べ、無関係なファイルをstageしない。3000番が自分のE2Eアプリであることを確認して止め、`PLAYWRIGHT_HTML_OPEN=never git push o_official master`（リモートの名前は `o_official`）。pre-pushを通し、失敗なら記録して所有Taskへ戻る。`--no-verify` は使わない。

- [x] **Step 11: 本番を読む許可を得て、適用前の状態を確認する**

Supabase MCPの読み取りだけで、migration一覧・今回置き換える関数の存在/引数/現在の定義のmd5、既存CHECKと索引、shop_settings、発送/取消/メールの件数を読む。顧客情報と鍵は読まない。最新のE-3段2が揃うこと、E-4が二重適用でないことを確かめる。DBの定義が計画の元と違えば適用せず報告する。

- [x] **Step 12: Aを当てる許可を得て、全文を適用しmd5を比べる**

名前 `delivery_tracking_records`・P1のAのファイル・bytesを見せ、`apply_migration` に全文を一字も変えず渡す許可を得る。直前に `\u` と4桁16進のscanをもう一度行う。適用後 `list_migrations` が返す版を控える。

```sql
select md5(statements[1]) as statement_md5,
       octet_length(statements[1]) as statement_bytes,
       array_length(statements,1) as statement_count
from supabase_migrations.schema_migrations
where version = '<Aを当てた実際の版>';
```

Expected: 手元ファイルのmd5/bytesと同じ、statement_count=1。違えば止めて報告し、黙ってBへ進まない。

- [x] **Step 13: B、Cをそれぞれ別の許可で当て、同じmd5確認をする**

Bの名前 `delivery_tracking_admin`、次にCの `delivery_tracking_sync`。各ファイル/bytesを見せ、1本ずつ `apply_migration` の許可を得る。前の1本のmd5一致が次の前提。同じSELECTのversionを実際のB/Cの版へ替え、各statement_count=1・bytes/md5一致を確認する。不一致は戻す操作をせず、差を説明して前へ進める移行を用意する。

- [x] **Step 14: 本番の指紋と守りとバックフィルを読む**

Step 7と**同じ**fingerprint SQLを本番で実行する。missing=0、kindごとの件数と全体md5/ACLが手元と一致。差があれば行ごとに比べ、今回以外の既存の差も分けて報告する。新5表のRLS/deny/service_role SELECT、新/置換RPCの実行権限、17列claim、19kindと2つの新unique/作り直したonce索引、ops7jobを確認する。

設定はOFF、取消でない既存発送ごとにconfirmedの最初のイベントが1行、登録0・配送attention0・新3種類outbox0。既存の注文/発送/返品/メールの件数が、意図したイベント追加以外で変わらない。届いた時刻の不正な行0。アプリでの本物の17TRACKの登録/手の配達済みなど、書く動作確認はこの読み取りの許可に含めない。

- [x] **Step 15: 実際の版へファイル名と参照を直してコミットする**

controllerは返された3版を `$appliedA`・`$appliedB`・`$appliedC` にそれぞれ `supabase/migrations/<実際の版>_delivery_tracking_records.sql`・`..._delivery_tracking_admin.sql`・`..._delivery_tracking_sync.sql` の**実際の1パスずつ**として置く。3パスがrepo内で既存と衝突しないことを確認してから `Move-Item -LiteralPath` で名前だけ直す。本文のbytes/md5は変えない。

計画/ER/運用/SQL照合の単体にある仮名を実際の3名へ直し、`rg '20261022100[012]00_delivery_tracking' docs tests` の結果が0になることを確認（履歴として仮名を残す節には適用済みへの対応を明記）。静的単体と型を通し、本番の版・指紋一致・OFFの記録を追記する。名指しの対象は下記だけ（PowerShell、変数3つは上で確定したパス）。

```powershell
git add -- supabase/migrations/20261021220816_delivery_tracking_records.sql supabase/migrations/20261021221140_delivery_tracking_admin.sql supabase/migrations/20261021221410_delivery_tracking_sync.sql $appliedA $appliedB $appliedC docs/superpowers/plans/2026-10-21-delivery-status.md docs/03_BasicDesign/data/er.md docs/06_Operations/webhook-queue-operations.md tests/unit/lib/orders/email/order-email-types.test.ts
git commit -m "docs: 配送の本番適用の版と確認結果を記録" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

再pushもユーザーの許可を得る。追跡ONの本番設定/本物の17TRACKの試験は設計書15のユーザーの作業として残す。無料枠の数や現在の佐川の状態を、手元のfakeの結果で確認済みとしない。作業場の全件JSONは次の作業の基準になるので残す。

#### 設計書との最終の対応

| 設計書の節 | 実装と証拠のTask |
|---|---|
| 3-0 | 1/2/6/7/11/12/13（OFF、ON、取り込み、OFFへ戻す、鍵なし） |
| 3-1〜3-3 | 2/3/4/6/13（8状況、時刻、止める、手のclamp） |
| 4-0〜4-7 | 1/2/3/4（列、4記録表＋provider枠、関数、書き込みの守り） |
| 5-1〜5-5 | 3/5/6/7/13（3分類、retrack、署名、get、期限、運用、fake） |
| 6-1〜6-6 | 9/10/13（履歴の全行、直し、手、印、要対応、権限） |
| 6-7 | 2/9/11/13（設定、鍵有無、正確な件数、確認、metadata） |
| 7-1〜7-2 | 4/12/13（サーバーの射影、現版、配達済み、全消費先） |
| 8-1〜8-3 | 1/2/3/8/13（19種類、本文、unique/ON CONFLICT、送る前の中止、再送不可） |
| 9 | 2/12/13（delivered_at、NULLの目安、旧期待、説明、既存返品保持） |
| 10〜11 | 1/2/3/5/7/9/12/15（RLS/grant、owner/CSRF/lease、秘密、移行） |
| 12 | 4〜14（各アプリ、環境、文書、毎分の枠とafter） |
| 13-1〜13-2 | 1〜15（単体/DB/E2E、前回比較、許可後のpush/適用/指紋） |
| 14 | 13/14（FREQ-488〜497、ADMIN-100〜104、ACCOUNT-041〜043、40AC） |
| 15 | 12/14/15（privacy、開店前のユーザーの手順、本物は未確認） |
| 16 #1〜9 | 2/3/4/8/10/12（6時間、最小の記録、終端、手、notify、版、部分、表示、72時間） |
| 16 #10〜18 | 1/2/3/5/6/7/8（日数、再送不可、鍵なし、retry、1MiB、3分類、30日起点、同版比較、下限） |
| 16 #19〜26 | 2/3/6/9/11/12/13（共有番号、枠、設定、取り込み、OFF、鍵の拒否、privacy、手の配達済み） |
| 付録 | 4/5/7/13/14/15（v2.4、全error番号、4path、wire、署名、共通fixture、実物確認の手順） |

計画時点の仕様の未割当ては0。解釈を固定した所はP7（再オン時は期限内のdisabledを同じ行で再開する）・P8（failedの日次回復もclaim対象）・P11（既存の後段のための時間を先に残す）。本物の17TRACKの契約の検証は設計書15の段階まで未確認のまま。
