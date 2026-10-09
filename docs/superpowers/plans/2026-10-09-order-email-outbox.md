# 注文のメールを確実に送る（グループ D）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** お客様への注文のメール（注文確認・入金待ち・支払い期限切れ・取消・発送）を、0通にも2通にもならないように送る。管理画面に注文の履歴・送ったメールの中身・再送・発送のメールを送るかのチェックを付け、配達の状態を記録する（R-34・R-14、FREQ-386）。

**Architecture:** 注文の状態を変える DB の関数が、同じ取引で `private.order_email_outbox` に1行書く（transactional outbox）。worker が1行ずつ担当の印を付けて取り出し、中身を作って控えてから、Resend へ行の番号から作った重複防止キーで送る。失敗は倍に広げて9回までやり直し、設定の問題は送信全体を一時停止する。配達の状態は Svix 署名の受け口と1時間ごとの見回りで記録し、管理画面は注文の「履歴」ダイアログで見せる。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Supabase（Postgres 17、SECURITY DEFINER の関数、pg_cron）、Resend SDK 6.16.0、Jest（ts-jest・Testing Library）＋`pg`、Playwright

**Spec:** [docs/superpowers/specs/2026-10-09-order-email-outbox-design.md](../specs/2026-10-09-order-email-outbox-design.md)（ユーザー承認 2026-10-09）

## Global Constraints

- ユーザーの方針: Shopify と同じ形に近づける。Shopify に無い所は世界の業界の定番に従う。計画に無い判断が要る時もこの順で決める
- 対象のメールの種類（DB の値）: `paid`（注文確認）・`awaiting_payment`（入金待ち）・`payment_expired`（支払い期限切れ）・`canceled`（取消）・`shipped`（発送）。注文にならなかった支払いの案内（`sendUnplacedPaymentNotice`）と店への知らせは今のまま
- 行の状態（DB の値）: `pending`・`sending`・`retry_wait`・`sent`・`skipped`（取りやめ）・`dead`（送れなかった）。配達の状態: `delivered`・`delayed`・`bounced`・`complained`・`suppressed`・`failed`
- 自動の行は1注文1種類1行（`origin = 'auto'`）。手の再送（`origin = 'manual'`）は送信待ち・送信中・やり直し待ちの間、1注文1種類1行
- Resend の重複防止キーは `order-email/<行の番号>`。中身（件名・本文）は最初に送る前に行へ控え、やり直しは控えた中身で送る
- やり直し: 失敗した試行の回数 n に対し、次は 2^(n-1) 分後（1・2・4…128分）に前後2割の揺らぎ。最初の試行と合わせて9回、9回目の失敗で `dead`。待つ時間の指示（`Retry-After`）が長ければそちら。担当の期限は5分で、期限切れも1回の失敗（`lease_expired`）
- 設定の問題（`config_api_key`・`config_sender_domain`・`config_provider`・`quota_daily`・`quota_monthly`）は回数を数えずに送信全体を止め、15分ごとに1件だけ試す。`quota_daily` は次の UTC 0時（日本時間 9時）まで待つ。送れたら同じ取引で再開する
- 取りやめ: 入金待ちは注文が `pending` でなければ、支払い期限切れは注文が `paid`・`shipped` なら `superseded`。宛先が無ければ `no_recipient`。入金済み・取消・発送は取りやめない
- 本文の保存: 送信済みは送ってから45日、取りやめ・送れなかったは片付けた時に消す。Resend の知らせの受付済みの番号は3日
- 画面の文言（一字も変えない）:
  - 発送の画面のチェック: `お客様に発送のメールを送る`（最初は入っている）
  - 履歴のボタン: `履歴`。ダイアログの題: `この注文の履歴`
  - 再送のボタン: `お客様へ再送`。確かめの文: `{種類}のメールを、お客様（注文のメールアドレス）へもう一度送ります`。ボタン: `再送する`・`やめる`
  - 中身のボタン: `中身を見る`。本文を消した後: `本文の保存期間（45日）を過ぎました`
  - 一時停止の表示: `メールの送信を一時停止しています（{原因}）`
  - 種類の名前: `注文確認`・`入金待ち`・`支払い期限切れ`・`取消`・`発送`
- 権限: 履歴と中身は `admin.orders.read`、再送と発送は `admin.orders.manage`。再送は CSRF・回数の制限（送信元ごとと管理者ごとに10分に30回）・監査（お客様の個人情報は入れない）
- 配達の知らせの受け口: `POST /api/webhook/resend-delivery`。鍵は `RESEND_DELIVERY_WEBHOOK_SECRET`（お問い合わせの `RESEND_WEBHOOK_SECRET` とは別）。署名は Svix（届いたままの本文・`timingSafeEqual`・時刻の差は5分まで・署名が並んだらどれか1つ）。本文は64KBまで
- 移行は2本: `supabase/migrations/20261009095633_order_email_outbox.sql`（表と関数）と `supabase/migrations/20261009095736_order_email_enqueue.sql`（状態を変える関数の作り直しと古い送信権の片付け。何度当てても同じ結果）。どちらも `BEGIN;`〜`COMMIT;`。関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名。`PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、`service_role` だけに与える（`private` の関数は `PUBLIC` から外すだけ）。最後に `NOTIFY pgrst, 'reload schema';`
- `supabase/pending/` は触らない。本番 DB へは、全タスクの後、ユーザーの push の後で許可を得て Supabase MCP の `apply_migration` で2本を順に当て、当てた版にファイル名と文書の版を直す
- 画面と機能の変更は `docs/02_Requirements/requirements.md` に FREQ-434〜438 の行を足す（Task 9。`grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` が FREQ-433 であることを確かめる）。新しい E2E は `e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts`・`e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`・`e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts`（`ls e2e | grep FR-CHECKOUT- | sort -V | tail -1` が FR-CHECKOUT-048、`ls e2e | grep FR-ADMIN- | sort -V | tail -1` が FR-ADMIN-064 であることを確かめる）
- E2E は本番ビルド（`next build && next start`）・手元の Supabase（`npx supabase db reset` の直後）で、mobile（390px）・tablet（768px）・desktop（1280px）の3つの画面幅で流す。流す前に3000番に何も無いことを `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめる。DB 結合テストの直後に E2E を流さない（`npx supabase db reset` を挟む）
- DB 結合テストは `npx supabase db reset` の後に、フォルダ全体を `--runInBand` で流す: `eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"` の後に `LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`（値は画面に出さない）
- 実装は Codex（`--model gpt-6.1-sol`、コミットしない。E2E と DB 結合テストは controller が流す）。controller がタスクのファイルだけを名指しでコミットし、レビューは Opus。master に直接コミットし、push しない。`--no-verify` を使わない。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 秘密の値（`.env.local` の鍵・合言葉・印・確認コード）を画面・ログ・文書・報告に出さない。ログと監査には宛先・本文・氏名・住所を出さず、原因の記号と注文番号だけにする
- 返答・文書・コメントは日本語。コードのコメントは周りに合わせる（理由を書く。何をしているかの繰り返しは書かない）

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **送れた直後に worker が落ちる（Resend は受け付けたが、送信済みの記録の前）**: 担当の期限が切れて次の試行になり、控えた同じ中身・同じ重複防止キーで送るので、Resend は2通目を送らない（Task 1 の「担当の期限が切れた行は1回の失敗として数え、控えた中身は残す」、Task 2 の worker の「控えがあれば作り直さず、同じ鍵で送る」）
2. **Resend の鍵の誤り・1日の上限で、たくさんのメールが溜まる**: 回数を数えずに止め、15分ごと（1日の上限は日本時間 9時の後）に1件だけ試し、通ったら全部送る（Task 1 の一時停止の試験、Task 2 の「設定の問題では止めて残りを取り出さない」）
3. **入金待ちのメールを送る前にお客様がすぐ払った**: 入金待ちは取りやめ、入金済みのメールだけが届く。同じ注文のメールは書いた順に送る（Task 1 の「同じ注文の後の行は前の行が片付くまで取り出さない」、Task 2 の「入金待ちは注文が入金待ちでなければ取りやめ」）
4. **管理者が「再送する」を続けて2回押す・2人が同時に押す**: 2つ目の行は作られず 409 で断り、ボタンは押せない（Task 1 の「手の再送は送信待ちの間1行」、Task 6 の「同じ種類の再送が送信待ちなら 409」、Task 7 の「送っている間はボタンを押せない」）
5. **Resend の知らせが順番どおりに来ない・同じ知らせが2回来る（Svix の送り直し）**: 新しい知らせだけ記録し、2回目は何もせず 200 を返す（Task 1 の配達の状態の試験、Task 5 の受け口の試験）

---

## 本計画の決め事（設計書の書いていないところ）

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | 移行を2本に分ける。A（`_order_email_outbox.sql`）は3つの表・送る予定の関数・保存期間の定期処理・定期処理の名前の追加、B（`_order_email_enqueue.sql`）は状態を変える関数の作り直し・古い送信権の片付けだけ。B は何度当てても同じ結果に書く | 表を作る移行と関数の作り直しを分けると、タスクごとに試験とレビューができる。本番には A・B を続けて当てる |
| P2 | 取り出しは1回に1行（`claim_order_email(_lease_seconds integer)`） | 設計書 7-2 の `claim_order_emails(_limit, ...)` を1行に絞った。設定の問題で止める時に、取ったまま送らない行を作らない（グループ B のキューと同じ形） |
| P3 | 送信の再開は `complete_order_email` が同じ取引で行う。`resume_order_email_sending()` は作らない | 送れたことが再開の条件（サーキットブレーカーの half-open から closed） |
| P4 | 点検用の関数を `get_order_email_backlog`・`list_unnotified_dead_order_emails`・`mark_order_emails_dead_notified`・`list_unnotified_order_email_delivery_problems`・`mark_order_email_delivery_problems_notified` に分け、知らせ済みの印 `dead_notified_at`・`delivery_alert_notified_at` を表に足す | 設計書 7-2 の `order_email_ops_snapshot()` を、グループ B の退避の知らせと同じ形に分けた |
| P5 | 同じ注文の順番は、行を足した順の番号 `seq`（identity）で決める | `created_at` の既定は取引の開始の時刻なので、同じ取引で2行足すと順番が決まらない |
| P6 | 取消のメールの書き分け（`payment_in_progress`・`pending`）も `variant` に入れる。列名は `variant` | 設計書 7-1 の `paid_variant` を広げた。今の取消のメールは前の状態で書き出しが変わる |
| P7 | `mark_order_paid` は `_notify_customer boolean`（全額返金済みでない時 true）と `_paid_email_variant text` を既定値なしで足し、古い6引数の関数は消す。`admin_ship_paid_order` も `_notify_customer boolean` を既定値なしで足し、返すのは `id` だけにする | 引数を忘れた呼び出しを、黙って0通にせず失敗させる。発送の関数はメールアドレスと氏名を返す必要が無くなった |
| P8 | 送り手が SES（`MAIL_PROVIDER` が無い時を含む）・知らない値の時は、本番かどうかにかかわらず送らずに一時停止（`config_provider`）。`MAIL_FROM_ADDRESS` が無い時も `config_provider`、Resend で `RESEND_API_KEY` が無い時は `config_api_key`。手元のメール受け（`local`）は送る | 重複防止キーの無い送り手で送らない（OWASP Fail Securely）。E2E と開発は `local` |
| P9 | 本番の `private.order_emails` の8行（移行前の未入金の注文2件の「送らない」印）は、取りやめ（`legacy_suppressed`）の行として新しい表へ移してから古い表を消す | 設計書 7-4 は「移さない」だったが、本番を読んで、印が8行・該当の注文が2件あると分かった。消すと、この2件に後から期限切れのメールが届きうる（グループ A 設計書 7-1 の決め事を守る）。設計書 7-4 も直す（Task 9） |
| P10 | worker の1回の起動は、Stripe の知らせに35秒、注文のメールに10秒（合わせて今の45秒） | 入口の `maxDuration` 60秒を超えない |
| P11 | 管理画面の E2E は、今までの管理画面の E2E と同じく管理画面の窓口を差し替えて流す。メールが本当に届くこと（再送で2通目・発送のチェックを外すと届かない）は、同じ spec の中で手元の DB の関数を呼び、worker の定期処理の入口を叩き、Mailpit を数えて確かめる | 本物の管理者のログインには2段階認証（TOTP）が要り、E2E の仕組みが無い |
| P12 | 注文のメールの点検は `runOrderEmailOpsChecks`（新しいファイル）にし、今の `runOpsChecks` は変えない。`ops-checks.ts` の `sendOnce` を export して使う。worker と毎時の見回りの両方の終わりで呼ぶ | グループ B の点検とその試験を変えずに足す |
| P13 | 配達の状態の見回りは毎分の worker の中で、`order_email_delivery_check` の最後の成功・失敗から1時間たった時だけ動かす。送り手が Resend の時だけ。鍵が送信専用（`restricted_api_key` など）なら失敗を記録して終わる（送信は止めない） | 新しい定期処理と合言葉を増やさない（設計書 4-7） |
| P14 | 発送の画面を `OrderShipDialog`（新しい部品）に切り出し、チェックを足す。追跡番号の形の誤りは画面の中に出す（文言は今のまま） | 取消の画面（`OrderCancelDialog`）と同じ形にし、試験できるようにする。今は誤りが一覧の下に出て、開いているダイアログに隠れていた |
| P15 | 履歴・中身・再送の確かめは1つのダイアログ（`OrderHistoryDialog`）の中で画面を切り替える | 今の `Dialog` は Escape を document で受けるので、重ねると外側も閉じる |
| P16 | 履歴の窓口は、注文（状態・宛先・受付の時刻）を service role で読み、状態の変化（`list_order_status_history`）・メール（`list_order_email_history`）・一時停止（`get_order_email_send_state`）を合わせて新しい順に返す。再送できるかは窓口が決めて返す | 画面が判断しない。DB の決まりと同じ表（`RESENDABLE_ORDER_STATUSES`）を使う |
| P17 | 中身の窓口は送信済みの行だけ返し、本文を消した後は `{ status: 'erased' }` を200で返す | 画面が「本文の保存期間（45日）を過ぎました」を出す |
| P18 | 再送の回数の制限は、窓口名 `admin:orders:email-resend`、送信元ごとと管理者ごとに10分に30回 | 今の管理画面の `enforceRateLimit` の形と同じ |
| P19 | 手順書は新しい `docs/06_Operations/order-email-operations.md`。店への知らせには「手順書（docs/06_Operations/order-email-operations.md）の「節の名前」」を入れる | 設計書 10-4 |
| P20 | DB 結合の道具 `insertOrderWithStockLine` に `shippingEmail`（既定は今の `fixture@example.com`）を足し、E2E も使う | 配送先は後から書き換えられないので、宛先を作る時に決める |
| P21 | 配達の知らせの受け口の本文の上限は 64KB（`content-length` と読んだ大きさの両方で確かめ、超えたら 413）。`svix-id` が200文字を超えたら 400 | 設計書 6-2。DB の決まり（200文字）で 500 になり Svix が送り直し続けるのを防ぐ |

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20261009095633_order_email_outbox.sql`（新規） | 3つの表・決まり・送る予定の関数・保存期間の定期処理・定期処理の名前（Task 1） |
| `supabase/migrations/20261009095736_order_email_enqueue.sql`（新規） | 状態を変える関数が行を書く・古い送信権を移して消す（Task 3） |
| `tests/integration/db/order_email_outbox.integration.test.ts`（新規） | 表と関数の結合テスト（Task 1） |
| `tests/integration/db/order_email_enqueue.integration.test.ts`（新規） | 状態を変える関数が書く行の結合テスト（Task 3） |
| `src/lib/orders/email/order-email-types.ts`（新規） | 種類・状態・原因の記号・名前・再送できる状態（Task 2。画面からも使う） |
| `src/lib/orders/email/order-email-compose.ts`（新規） | 注文の材料を読み、5種類の件名と本文を作る（Task 2） |
| `src/lib/orders/email/order-email-sender.ts`（新規） | Resend へ重複防止キーで送り、失敗を分ける（Task 2） |
| `src/lib/orders/email/order-email-store.ts`（新規） | 送る予定の関数の呼び出し（Task 2 で送る分、Task 4・5・6 で足す） |
| `src/lib/orders/email/order-email-worker.ts`（新規） | 取り出して送る繰り返し（Task 2）、最後の成功の記録（Task 4） |
| `src/lib/orders/email/order-email-schedule.ts`（新規） | 窓口の `after()` で worker を1回動かす（Task 2） |
| `src/lib/orders/email/order-email-ops.ts`（新規） | 注文のメールの点検と店への知らせ（Task 4） |
| `src/lib/orders/email/order-email-delivery.ts`（新規） | 配達の知らせの読み取りと1時間ごとの見回り（Task 5） |
| `src/lib/orders/email/order-history.ts`（新規） | 履歴の形・名前・組み立て（Task 6。画面からも使う） |
| `src/lib/webhooks/svix.ts`（新規） | Svix の署名の確かめ（Task 5。お問い合わせの受け口と共通） |
| `src/lib/orders/order-confirmation-email.ts`・`order-lifecycle-emails.ts`、`order-shipped-email.ts`（削除） | 直接送る処理と送信権を消す（Task 3） |
| `src/lib/stripe/checkout-payment-reconciler.ts`・`checkout-payment-reconciler-deps.ts` | 直接送らずに DB へ「送るか」を渡す（Task 3） |
| `src/app/api/admin/orders/[id]/status/route.ts`・`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts` | 発送の「送るか」、直接の送信を消す（Task 3）、`after()`（Task 4） |
| `src/app/api/checkout/complete/route.ts`・`src/app/api/cron/expire-pending-orders/route.ts`・`src/lib/stripe/webhook-worker.ts` | worker を動かす・点検（Task 4・5） |
| `src/lib/ops/ops-store.ts`・`ops-checks.ts`・`ops-alert-mail.ts` | 定期処理と知らせの名前、知らせの文（Task 4） |
| `src/app/api/webhook/resend-delivery/route.ts`（新規）、`src/app/api/contact/inbound/route.ts`、`src/proxy.ts` | 配達の知らせの受け口、署名の確かめを共通にする（Task 5） |
| `src/app/api/admin/orders/[id]/history/route.ts`・`emails/[emailId]/route.ts`・`emails/resend/route.ts`（新規） | 履歴・中身・再送の窓口（Task 6） |
| `src/components/OrderHistoryDialog.tsx`・`OrderShipDialog.tsx`（新規）、`src/components/OrderSection.tsx`、`src/app/admin/page.tsx` | 履歴のダイアログ・発送の画面・履歴のボタン（Task 7） |
| `e2e/order-email-test-utils.ts`（新規）、`e2e/FR-CHECKOUT-049-…`・`FR-ADMIN-065-…`・`FR-ADMIN-066-…`（新規）、`tests/integration/db/helpers/order-fixtures.ts` | E2E（Task 8） |
| 要求表・設計の文書・手順書・台帳 | Task 9 |

---

### Task 1: 注文のメールの表と関数（移行 A）

**Files:**
- Create: `supabase/migrations/20261009095633_order_email_outbox.sql`
- Create: `tests/integration/db/order_email_outbox.integration.test.ts`

**Interfaces:**
- Consumes: `public.orders`・`public.order_revisions`・`auth.users`・`public.ops_job_heartbeats`・`public.release_stock_for_unpaid_order`（既存）、`tests/integration/db/helpers`（既存）
- Produces:
  - 表 `private.order_email_outbox`（列は Step 3 の SQL のとおり。`seq` は足した順の番号）、`private.order_email_send_pause`（1行だけ）、`private.resend_webhook_receipts`
  - `private.enqueue_order_email(_order_id uuid, _kind text, _variant text DEFAULT NULL) RETURNS boolean`（自動の行を書く。書けたら true。Task 3 が使う）
  - `private.set_order_email_pause(_reason text) RETURNS boolean`、`private.order_email_max_attempts()`、`private.order_email_retry_delay(integer)`、`private.purge_order_email_data()`
  - `public.claim_order_email(_lease_seconds integer) RETURNS TABLE (email_id uuid, order_id uuid, kind text, variant text, origin text, attempts integer, lease_token uuid, subject text, body_text text, payment_expired_sent boolean)`
  - `public.save_order_email_content(_email_id uuid, _lease_token uuid, _subject text, _body_text text) RETURNS boolean`
  - `public.complete_order_email(_email_id uuid, _lease_token uuid, _provider_message_id text) RETURNS boolean`
  - `public.fail_order_email(_email_id uuid, _lease_token uuid, _error_code text, _category text, _retry_after_seconds integer DEFAULT NULL) RETURNS text`（結果の状態 `retry_wait`・`dead`。担当の印が合わなければ NULL）
  - `public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text) RETURNS boolean`（`superseded`・`no_recipient`）
  - `public.pause_order_email_sending(_reason text) RETURNS boolean`（新しく止めたら true）、`public.get_order_email_send_state() RETURNS TABLE (paused boolean, reason text, paused_at timestamptz, next_probe_at timestamptz)`
  - `public.request_order_email_resend(_order_id uuid, _kind text, _actor_id uuid) RETURNS uuid`。断り: `RESEND_ARGUMENT_REQUIRED`・`INVALID_EMAIL_KIND`（22023）、`ORDER_NOT_FOUND`（P0002）、`RESEND_NOT_ALLOWED`（22023）、`RESEND_ALREADY_QUEUED`（23505）
  - `public.list_order_email_history(_order_id uuid) RETURNS TABLE (email_id uuid, kind text, variant text, origin text, requested_by_email text, status text, attempts integer, last_error_code text, delivery_status text, delivery_event_at timestamptz, created_at timestamptz, sent_at timestamptz, finished_at timestamptz, has_body boolean, body_erased boolean)`（新しい順）
  - `public.list_order_status_history(_order_id uuid) RETURNS TABLE (changed_at timestamptz, from_status text, to_status text, change_reason text, actor_email text, shipping_carrier text, tracking_number text, cancel_reason text)`（新しい順）
  - `public.get_order_email_content(_order_id uuid, _email_id uuid) RETURNS TABLE (subject text, body_text text, sent_at timestamptz, body_erased boolean)`（送信済みの行だけ）
  - `public.record_order_email_delivery(_svix_id text, _provider_message_id text, _delivery_status text, _event_at timestamptz) RETURNS text`（`updated`・`stale`・`duplicate`・`unknown_email`）
  - `public.list_order_emails_awaiting_delivery(_limit integer) RETURNS TABLE (email_id uuid, provider_message_id text)`
  - `public.get_order_email_backlog(_older_than_seconds integer) RETURNS TABLE (status text, email_count integer, oldest_created_at timestamptz, last_errors text[])`
  - `public.list_unnotified_dead_order_emails(_limit integer) RETURNS TABLE (email_id uuid, order_id uuid, kind text, last_error_code text, attempts integer, finished_at timestamptz, total_count integer)`、`public.mark_order_emails_dead_notified(_email_ids uuid[]) RETURNS integer`
  - `public.list_unnotified_order_email_delivery_problems(_limit integer) RETURNS TABLE (email_id uuid, order_id uuid, kind text, delivery_status text, delivery_event_at timestamptz, total_count integer)`、`public.mark_order_email_delivery_problems_notified(_email_ids uuid[]) RETURNS integer`
  - 定期処理の名前 `order_email_worker`・`order_email_delivery_check`（`ops_job_heartbeats`）、毎日の片付け `order-email-retention`（19:40 UTC）

- [ ] **Step 1: 結合テストを書く**

`tests/integration/db/order_email_outbox.integration.test.ts`:

```ts
/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithStockLine, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 注文のメールの表と関数（グループ D 設計書 3・4・6・7 章）。
 * 取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で表を空にし、終わったら戻す（ほかの試験の行に邪魔されない）。
 * 同時の取り出しだけは2つの接続が要るので、別の describe で確定した行を使う。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createOrder(db: PgClient, status: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const { orderId } = await insertOrderWithStockLine(db, {
    status, itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
  });
  return orderId;
}

/** order_revisions.changed_by と requested_by は auth.users への外部キーなので、実在の行を作る */
async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `order-email-admin-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

async function enqueue(db: PgClient, orderId: string, kind: string, variant: string | null = null): Promise<boolean> {
  const res = await db.query('select private.enqueue_order_email($1::uuid, $2::text, $3::text) as inserted', [orderId, kind, variant]);
  return res.rows[0].inserted as boolean;
}

async function claim(db: PgClient): Promise<Row | null> {
  const res = await db.query('select * from public.claim_order_email(300)');
  return res.rows[0] ?? null;
}

async function emailRow(db: PgClient, emailId: string): Promise<Row> {
  return (await db.query('select * from private.order_email_outbox where id = $1', [emailId])).rows[0];
}

async function sendState(db: PgClient): Promise<Row> {
  return (await db.query('select * from public.get_order_email_send_state()')).rows[0];
}

/** 取引の中では now() が止まっているので、次に試す時刻との差が待つ時間そのものになる */
async function waitSeconds(db: PgClient, emailId: string): Promise<number> {
  const res = await db.query(
    'select extract(epoch from next_attempt_at - now())::float8 as wait from private.order_email_outbox where id = $1',
    [emailId],
  );
  return Number(res.rows[0].wait);
}

function complete(db: PgClient, claimed: Row, messageId: string | null = null) {
  return db.query('select public.complete_order_email($1, $2, $3) as done', [claimed.email_id, claimed.lease_token, messageId]);
}

function fail(db: PgClient, claimed: Row, code: string, category: string, retryAfter: number | null = null) {
  return db.query('select public.fail_order_email($1, $2, $3, $4, $5) as status', [
    claimed.email_id, claimed.lease_token, code, category, retryAfter,
  ]);
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

describeLocalDb('integration: 注文のメールの表と関数', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表の決まり', () => {
    test('自動の行は1注文1種類1行。2回目は何もしない', async () => {
      const orderId = await createOrder(db(), 'paid');

      expect(await enqueue(db(), orderId, 'paid', 'order_confirmed')).toBe(true);
      expect(await enqueue(db(), orderId, 'paid', 'payment_received')).toBe(false);

      const rows = await db().query('select kind, variant, origin, status from private.order_email_outbox where order_id = $1', [orderId]);
      expect(rows.rows).toEqual([{ kind: 'paid', variant: 'order_confirmed', origin: 'auto', status: 'pending' }]);
    });

    test('書き分けは種類に合うものだけ。入金済みと取消は書き分けが要る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', null], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'canceled', 'paid'], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'shipped', 'order_confirmed'], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'refund', null], { code: '23514' });
    });
  });

  describe('取り出し', () => {
    test('担当の印を付けて1行取り出し、試した回数を数える', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');

      const claimed = await claim(db());

      expect(claimed).toMatchObject({
        order_id: orderId, kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
        subject: null, body_text: null, payment_expired_sent: false,
      });
      expect(claimed?.lease_token).toEqual(expect.any(String));
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'sending' });
      expect(await claim(db())).toBeNull();
    });

    test('同じ注文の後の行は、前の行が片付くまで取り出さない', async () => {
      const orderId = await createOrder(db(), 'pending');
      await enqueue(db(), orderId, 'awaiting_payment');
      await enqueue(db(), orderId, 'paid', 'payment_received');

      const first = await claim(db());
      expect(first?.kind).toBe('awaiting_payment');
      expect(await claim(db())).toBeNull();

      await db().query('select public.skip_order_email($1, $2, $3)', [first!.email_id, first!.lease_token, 'superseded']);
      const second = await claim(db());
      expect(second?.kind).toBe('paid');
    });

    test('期限切れのメールを送っていれば payment_expired_sent が true', async () => {
      const orderId = await createOrder(db(), 'failed');
      await enqueue(db(), orderId, 'payment_expired');
      const expired = await claim(db());
      await complete(db(), expired!, `re_${uniqueSuffix()}`);
      await enqueue(db(), orderId, 'paid', 'payment_received_after_expiry');

      expect(await claim(db())).toMatchObject({ kind: 'paid', payment_expired_sent: true });
    });

    test('中身は送る前に一度だけ控え、控えは取り出しで返る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      const saved = await db().query('select public.save_order_email_content($1, $2, $3, $4) as saved', [
        claimed!.email_id, claimed!.lease_token, '件名', '本文',
      ]);
      const again = await db().query('select public.save_order_email_content($1, $2, $3, $4) as saved', [
        claimed!.email_id, claimed!.lease_token, '別の件名', '別の本文',
      ]);

      expect(saved.rows[0].saved).toBe(true);
      expect(again.rows[0].saved).toBe(false);
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ subject: '件名', body_text: '本文' });
    });

    test('担当の期限が切れた行は1回の失敗として数え、控えた中身は残す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);
      await db().query("update private.order_email_outbox set lease_expires_at = now() - interval '1 second' where id = $1", [claimed!.email_id]);

      expect(await claim(db())).toBeNull();
      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ status: 'retry_wait', attempts: 1, last_error_code: 'lease_expired', subject: '件名', body_text: '本文' });
      const wait = await waitSeconds(db(), claimed!.email_id);
      expect(wait).toBeGreaterThanOrEqual(48);
      expect(wait).toBeLessThanOrEqual(72);

      await db().query('update private.order_email_outbox set next_attempt_at = now() where id = $1', [claimed!.email_id]);
      expect(await claim(db())).toMatchObject({ email_id: claimed!.email_id, attempts: 2, subject: '件名', body_text: '本文' });
    });

    test('担当の印が違えば、送信済みにも失敗にもできない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      const wrong = { ...claimed, lease_token: '00000000-0000-4000-8000-000000000000' };

      expect((await complete(db(), wrong)).rows[0].done).toBe(false);
      expect((await fail(db(), wrong, 'network_error', 'transient')).rows[0].status).toBeNull();
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'sending' });
    });
  });

  describe('やり直しと送れなかった', () => {
    test('一時的な失敗はやり直し待ちにし、1分の前後2割だけ待つ', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'provider_unavailable', 'transient')).rows[0].status).toBe('retry_wait');
      const wait = await waitSeconds(db(), claimed!.email_id);
      expect(wait).toBeGreaterThanOrEqual(48);
      expect(wait).toBeLessThanOrEqual(72);
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ last_error_code: 'provider_unavailable', attempts: 1 });
    });

    test('待つ時間の指示が長ければ、そちらに従う', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      await fail(db(), claimed!, 'rate_limited', 'transient', 600);

      expect(await waitSeconds(db(), claimed!.email_id)).toBeCloseTo(600, 0);
    });

    test('9回目の失敗で送れなかったにし、控えた本文を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      await db().query('update private.order_email_outbox set attempts = 8 where order_id = $1', [orderId]);
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      expect((await fail(db(), claimed!, 'provider_unavailable', 'transient')).rows[0].status).toBe('dead');
      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ status: 'dead', attempts: 9, subject: null, body_text: null });
      expect(row.finished_at).not.toBeNull();
      expect(row.body_erased_at).not.toBeNull();
    });

    test('このメールだけの問題はすぐに送れなかったにする', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'invalid_message', 'permanent')).rows[0].status).toBe('dead');
    });

    test('知らない分け方と形の違う記号は断る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await expectRejected(db(), 'select public.fail_order_email($1, $2, $3, $4, null)', [claimed!.email_id, claimed!.lease_token, 'network_error', 'retry'], { code: '22023' });
      await expectRejected(db(), 'select public.fail_order_email($1, $2, $3, $4, null)', [claimed!.email_id, claimed!.lease_token, 'Error: secret', 'transient'], { code: '22023' });
    });

    test('取りやめは理由を残し、控えた本文を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'awaiting_payment');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      await db().query('select public.skip_order_email($1, $2, $3)', [claimed!.email_id, claimed!.lease_token, 'superseded']);

      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({
        status: 'skipped', last_error_code: 'superseded', subject: null, body_text: null,
      });
      await expectRejected(db(), 'select public.skip_order_email($1, $2, $3)', [claimed!.email_id, claimed!.lease_token, 'other'], { code: '22023' });
    });
  });

  describe('送信の一時停止', () => {
    test('設定の問題は回数を数えずに戻し、送信全体を止め、15分後に1件だけ試す', async () => {
      const first = await createOrder(db(), 'paid');
      const second = await createOrder(db(), 'paid');
      await enqueue(db(), first, 'paid', 'order_confirmed');
      await enqueue(db(), second, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'config_api_key', 'config')).rows[0].status).toBe('retry_wait');

      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'retry_wait', attempts: 0, last_error_code: 'config_api_key' });
      expect(await sendState(db())).toMatchObject({ paused: true, reason: 'config_api_key' });
      const probe = await db().query("select next_probe_at = now() + interval '15 minutes' as ok from public.get_order_email_send_state()");
      expect(probe.rows[0].ok).toBe(true);
      expect(await claim(db())).toBeNull();

      await db().query("update private.order_email_send_pause set next_probe_at = now() - interval '1 second'");
      const tried = await claim(db());
      expect(tried).not.toBeNull();
      expect(await claim(db())).toBeNull();
      const moved = await db().query("select next_probe_at = now() + interval '15 minutes' as ok from public.get_order_email_send_state()");
      expect(moved.rows[0].ok).toBe(true);

      await complete(db(), tried!);
      expect(await sendState(db())).toMatchObject({ paused: false, reason: null, paused_at: null, next_probe_at: null });
      expect(await claim(db())).not.toBeNull();
    });

    test('1日の上限は次の UTC 0時まで試さない', async () => {
      await db().query("select public.pause_order_email_sending('quota_daily')");

      const res = await db().query(
        `select next_probe_at = ((date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC') as ok
         from public.get_order_email_send_state()`,
      );
      expect(res.rows[0].ok).toBe(true);
    });

    test('止めた時刻は最初のまま。知らない理由は断る', async () => {
      const firstPause = await db().query("select public.pause_order_email_sending('config_provider') as newly");
      const secondPause = await db().query("select public.pause_order_email_sending('config_provider') as newly");

      expect(firstPause.rows[0].newly).toBe(true);
      expect(secondPause.rows[0].newly).toBe(false);
      await expectRejected(db(), "select public.pause_order_email_sending('network_error')", [], { code: '22023' });
    });
  });

  describe('手の再送', () => {
    async function sentPaidEmail(status = 'paid'): Promise<{ orderId: string; emailId: string }> {
      const orderId = await createOrder(db(), status);
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      return { orderId, emailId: claimed!.email_id };
    }

    test('送信済みのメールを、同じ書き分けの手の行として足し、管理者を記録する', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();

      const res = await db().query('select public.request_order_email_resend($1, $2, $3) as email_id', [orderId, 'paid', actor.id]);

      expect(await emailRow(db(), res.rows[0].email_id)).toMatchObject({
        kind: 'paid', variant: 'order_confirmed', origin: 'manual', requested_by: actor.id, status: 'pending',
      });
    });

    test('同じ種類の手の再送が送信待ちの間は、次を断る。送った後はまた足せる', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();
      await db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id]);

      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id], {
        code: '23505', message: expect.stringContaining('RESEND_ALREADY_QUEUED'),
      });

      const manual = await claim(db());
      await complete(db(), manual!, `re_${uniqueSuffix()}`);
      await expect(db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id])).resolves.toBeTruthy();
    });

    test('今の注文の状態で意味の無い種類と、送信済み・送れなかったの行が無い種類は断る', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'awaiting_payment', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'shipped', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });

      const pendingOrder = await createOrder(db(), 'pending');
      await enqueue(db(), pendingOrder, 'awaiting_payment');
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [pendingOrder, 'awaiting_payment', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', ['00000000-0000-4000-8000-000000000000', 'paid', actor.id], {
        code: 'P0002',
      });
    });

    test('送れなかったメールも再送できる', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await fail(db(), claimed!, 'invalid_message', 'permanent');

      await expect(db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id])).resolves.toBeTruthy();
    });
  });

  describe('管理画面の履歴と中身', () => {
    test('メールの履歴は新しい順で、本文は返さず、手の再送の管理者のメールアドレスを返す', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const auto = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [auto!.email_id, auto!.lease_token, '件名', '本文']);
      await complete(db(), auto!, `re_${uniqueSuffix()}`);
      await db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id]);

      const res = await db().query('select * from public.list_order_email_history($1)', [orderId]);

      expect(res.rows.map((row) => [row.origin, row.status, row.requested_by_email, row.has_body])).toEqual([
        ['manual', 'pending', actor.email, false],
        ['auto', 'sent', null, true],
      ]);
      expect(Object.keys(res.rows[0])).not.toContain('body_text');
    });

    test('注文の状態の変化を、変えた管理者と取消の理由つきで新しい順に返す', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'payment_in_progress');
      await db().query(
        `select public.release_stock_for_unpaid_order($1, 'payment_in_progress', 'cancelled', 'admin_cancel', $2, null, 'customer_request', null, false)`,
        [orderId, actor.id],
      );

      const res = await db().query('select * from public.list_order_status_history($1)', [orderId]);

      expect(res.rows).toEqual([
        expect.objectContaining({
          from_status: 'payment_in_progress', to_status: 'cancelled', change_reason: 'admin_cancel',
          actor_email: actor.email, cancel_reason: 'customer_request', shipping_carrier: null, tracking_number: null,
        }),
      ]);
    });

    test('中身は送信済みの行だけ返し、本文を消した後は消したことだけ返す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      const beforeSent = await db().query('select * from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(beforeSent.rows).toEqual([]);

      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      const sent = await db().query('select subject, body_text, body_erased from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(sent.rows).toEqual([{ subject: '件名', body_text: '本文', body_erased: false }]);

      const otherOrder = await createOrder(db(), 'paid');
      const wrongOrder = await db().query('select * from public.get_order_email_content($1, $2)', [otherOrder, claimed!.email_id]);
      expect(wrongOrder.rows).toEqual([]);

      await db().query("update private.order_email_outbox set sent_at = now() - interval '46 days' where id = $1", [claimed!.email_id]);
      await db().query('select private.purge_order_email_data()');
      const erased = await db().query('select subject, body_text, body_erased from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(erased.rows).toEqual([{ subject: null, body_text: null, body_erased: true }]);
    });
  });

  describe('配達の状態', () => {
    async function sentWithMessage(messageId: string): Promise<string> {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, messageId);
      return claimed!.email_id as string;
    }

    function record(svixId: string | null, messageId: string, status: string, eventAt: string) {
      return db().query('select public.record_order_email_delivery($1, $2, $3, $4::timestamptz) as result', [svixId, messageId, status, eventAt]);
    }

    test('新しい知らせだけ記録し、同じ知らせの番号は1回だけ処理する', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const emailId = await sentWithMessage(messageId);
      const svix = `msg_${uniqueSuffix()}`;

      expect((await record(svix, messageId, 'delivered', '2026-10-09T01:00:00Z')).rows[0].result).toBe('updated');
      expect((await record(svix, messageId, 'delivered', '2026-10-09T01:00:00Z')).rows[0].result).toBe('duplicate');
      expect((await record(`msg_${uniqueSuffix()}`, messageId, 'delayed', '2026-10-09T00:59:00Z')).rows[0].result).toBe('stale');
      expect(await emailRow(db(), emailId)).toMatchObject({ delivery_status: 'delivered' });
    });

    test('届かなかった知らせは店へ知らせる印を空にし、知らないメールは何もしない', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const emailId = await sentWithMessage(messageId);
      await db().query('update private.order_email_outbox set delivery_alert_notified_at = now() where id = $1', [emailId]);

      expect((await record(null, messageId, 'bounced', '2026-10-09T02:00:00Z')).rows[0].result).toBe('updated');
      expect(await emailRow(db(), emailId)).toMatchObject({ delivery_status: 'bounced', delivery_alert_notified_at: null });
      expect((await record(`msg_${uniqueSuffix()}`, `re_unknown_${uniqueSuffix()}`, 'delivered', '2026-10-09T02:00:00Z')).rows[0].result).toBe('unknown_email');
      await expectRejected(db(), 'select public.record_order_email_delivery($1, $2, $3, now())', [null, messageId, 'opened'], { code: '22023' });
    });

    test('見回りの対象は、送ってから3日以内で配達の状態が決まっていないメールだけ', async () => {
      const waiting = await sentWithMessage(`re_${uniqueSuffix()}`);
      const delayed = await sentWithMessage(`re_${uniqueSuffix()}`);
      const delivered = await sentWithMessage(`re_${uniqueSuffix()}`);
      const old = await sentWithMessage(`re_${uniqueSuffix()}`);
      await db().query("update private.order_email_outbox set delivery_status = 'delayed', delivery_event_at = now() where id = $1", [delayed]);
      await db().query("update private.order_email_outbox set delivery_status = 'delivered', delivery_event_at = now() where id = $1", [delivered]);
      await db().query("update private.order_email_outbox set sent_at = now() - interval '4 days' where id = $1", [old]);

      const res = await db().query('select email_id from public.list_order_emails_awaiting_delivery(50)');

      expect(res.rows.map((row) => row.email_id).sort()).toEqual([waiting, delayed].sort());
    });
  });

  describe('点検', () => {
    test('15分以上送れていないメールを状態ごとに数える', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      await db().query("update private.order_email_outbox set created_at = now() - interval '20 minutes' where order_id = $1", [orderId]);

      const res = await db().query('select * from public.get_order_email_backlog(900)');

      expect(res.rows).toEqual([expect.objectContaining({ status: 'pending', email_count: 1, last_errors: [] })]);
    });

    test('まだ知らせていない送れなかったメールを返し、印を付けると返さない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await fail(db(), claimed!, 'invalid_message', 'permanent');

      const listed = await db().query('select * from public.list_unnotified_dead_order_emails(50)');
      expect(listed.rows).toEqual([expect.objectContaining({ email_id: claimed!.email_id, kind: 'paid', last_error_code: 'invalid_message', total_count: 1 })]);

      const marked = await db().query('select public.mark_order_emails_dead_notified($1::uuid[]) as count', [[claimed!.email_id]]);
      expect(marked.rows[0].count).toBe(1);
      expect((await db().query('select * from public.list_unnotified_dead_order_emails(50)')).rows).toEqual([]);
    });

    test('まだ知らせていない届かなかったメールを返し、印を付けると返さない', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, messageId);
      await db().query("select public.record_order_email_delivery(null, $1, 'suppressed', now())", [messageId]);

      const listed = await db().query('select * from public.list_unnotified_order_email_delivery_problems(50)');
      expect(listed.rows).toEqual([expect.objectContaining({ email_id: claimed!.email_id, delivery_status: 'suppressed', total_count: 1 })]);

      await db().query('select public.mark_order_email_delivery_problems_notified($1::uuid[])', [[claimed!.email_id]]);
      expect((await db().query('select * from public.list_unnotified_order_email_delivery_problems(50)')).rows).toEqual([]);
    });

    test('注文のメールの定期処理の名前を記録できる', async () => {
      await db().query("select public.record_ops_heartbeat('order_email_worker', true)");
      await db().query("select public.record_ops_heartbeat('order_email_delivery_check', false, 'config_api_key')");
      const res = await db().query("select job from public.get_ops_heartbeats() where job like 'order_email%' order by job");
      expect(res.rows.map((row) => row.job)).toEqual(['order_email_delivery_check', 'order_email_worker']);
    });
  });

  describe('片付けと守り', () => {
    test('毎日の片付けは、45日を過ぎた送信済みの本文と3日を過ぎた受付済みの番号を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);
      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      const recentSvix = `msg_${uniqueSuffix()}`;
      const oldSvix = `msg_${uniqueSuffix()}`;
      await db().query(
        "insert into private.resend_webhook_receipts (svix_id, received_at) values ($1, now()), ($2, now() - interval '4 days')",
        [recentSvix, oldSvix],
      );

      await db().query('select private.purge_order_email_data()');
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ subject: '件名' });

      await db().query("update private.order_email_outbox set sent_at = now() - interval '46 days' where id = $1", [claimed!.email_id]);
      await db().query('select private.purge_order_email_data()');

      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ subject: null, body_text: null, status: 'sent' });
      expect(row.body_erased_at).not.toBeNull();
      const receipts = await db().query('select svix_id from private.resend_webhook_receipts where svix_id = any($1)', [[recentSvix, oldSvix]]);
      expect(receipts.rows).toEqual([{ svix_id: recentSvix }]);
      const job = await db().query("select count(*)::int as count from cron.job where jobname = 'order-email-retention'");
      expect(job.rows[0].count).toBe(1);
    });

    test.each(['anon', 'authenticated', 'service_role'])('%s は3つの表を直接読めない', async (role) => {
      for (const table of ['private.order_email_outbox', 'private.order_email_send_pause', 'private.resend_webhook_receipts']) {
        await db().query('savepoint denied');
        await db().query(`set local role ${role}`);
        await expect(db().query(`select * from ${table}`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint denied');
      }
    });

    test.each(['anon', 'authenticated'])('%s は関数を呼べない', async (role) => {
      await db().query('savepoint denied');
      await db().query(`set local role ${role}`);
      await expect(db().query('select * from public.claim_order_email(300)')).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint denied');
      await db().query('savepoint denied');
      await db().query(`set local role ${role}`);
      await expect(db().query("select public.request_order_email_resend(gen_random_uuid(), 'paid', gen_random_uuid())")).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint denied');
    });

    test('service_role は関数を呼べるが、行を書く private の関数は呼べない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await db().query('savepoint service');
      await db().query('set local role service_role');
      await expect(db().query('select * from public.claim_order_email(300)')).resolves.toBeTruthy();
      await expect(db().query("select private.enqueue_order_email($1, 'shipped', null)", [orderId])).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint service');
    });
  });
});

describeLocalDb('integration: 注文のメールの同時の取り出し', (db) => {
  let other: PgClient;
  const created: string[] = [];

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await db().query('delete from private.order_email_outbox where order_id = any($1::uuid[])', [created]);
    }
    await other.end();
  });

  test('2つの worker が同時に取り出しても、同じ行を取らない', async () => {
    // ほかの試験が残した未完了の行に邪魔されないよう、先に片付けてから確定した2行を用意する（使い捨ての手元の DB だけ）
    await db().query(
      `update private.order_email_outbox
       set status = 'skipped', finished_at = now(), lease_token = null, lease_expires_at = null, last_error_code = 'superseded'
       where status in ('pending', 'sending', 'retry_wait')`,
    );
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
    for (let index = 0; index < 2; index += 1) {
      const orderId = await createOrder(db(), 'paid');
      created.push(orderId);
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
    }

    await db().query('begin');
    await other.query('begin');
    try {
      const first = await claim(db());
      const second = await claim(other);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.email_id).not.toBe(first!.email_id);
    } finally {
      await db().query('rollback');
      await other.query('rollback');
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる（controller）**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_email_outbox --runInBand`
Expected: FAIL（`relation "private.order_email_outbox" does not exist` など）

- [ ] **Step 3: 移行 A を書く**

`supabase/migrations/20261009095633_order_email_outbox.sql`:

```sql
-- 注文のメールを確実に送る（グループ D 設計書 2026-10-09 の 3・4・6・7 章。R-34・R-14）
--
-- 注文の状態を変える DB の関数が同じ取引で1行書く「注文のメール」の表と、worker・管理画面・配達の知らせが使う関数。
-- 表は private に置き、読み書きは public の SECURITY DEFINER の関数だけにする（実行は service_role だけ）。
-- 失敗した試行の回数 n に対し、次の試行は 2^(n-1) 分後（1・2・4…128分）に前後2割の揺らぎを足す。
-- 最初の試行と合わせて9回試し、9回目も失敗したら dead（送れなかった）にする（グループ B のキューと同じ表）。
-- 同じ注文のメールは、足した順の番号（seq）の順に送る。
BEGIN;

-- 1. 注文のメール。自動の行は1注文1種類1行、手の再送は送信待ちの間1行（設計書 3-2・7-1）
CREATE TABLE IF NOT EXISTS private.order_email_outbox (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped')),
  variant text,
  origin text NOT NULL CHECK (origin IN ('auto', 'manual')),
  requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry_wait', 'sent', 'skipped', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  subject text CHECK (subject IS NULL OR pg_catalog.char_length(subject) BETWEEN 1 AND 300),
  body_text text CHECK (body_text IS NULL OR pg_catalog.char_length(body_text) BETWEEN 1 AND 20000),
  provider_message_id text
    CHECK (provider_message_id IS NULL OR pg_catalog.char_length(provider_message_id) BETWEEN 1 AND 200),
  delivery_status text CHECK (
    delivery_status IS NULL
    OR delivery_status IN ('delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'failed')
  ),
  delivery_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  finished_at timestamptz,
  body_erased_at timestamptz,
  dead_notified_at timestamptz,
  delivery_alert_notified_at timestamptz,
  CONSTRAINT order_email_outbox_seq_key UNIQUE (seq),
  -- CHECK は NULL を通すので、書き分けが要る種類は IS NOT NULL も確かめる
  CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending'))
    OR (kind IN ('awaiting_payment', 'payment_expired', 'shipped') AND variant IS NULL)
  ),
  CONSTRAINT order_email_outbox_requester_check CHECK (origin = 'manual' OR requested_by IS NULL),
  CONSTRAINT order_email_outbox_lease_check CHECK (
    (status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT order_email_outbox_body_pair_check CHECK ((subject IS NULL) = (body_text IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto';

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_manual_open_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'manual' AND status IN ('pending', 'sending', 'retry_wait');

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_provider_message_idx
  ON private.order_email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 取り出し（送信待ち・やり直し待ち・期限の切れた担当）
CREATE INDEX IF NOT EXISTS order_email_outbox_due_idx
  ON private.order_email_outbox (next_attempt_at)
  WHERE status IN ('pending', 'sending', 'retry_wait');

-- 同じ注文の順番と管理画面の履歴
CREATE INDEX IF NOT EXISTS order_email_outbox_order_idx
  ON private.order_email_outbox (order_id, seq);

CREATE INDEX IF NOT EXISTS order_email_outbox_dead_unnotified_idx
  ON private.order_email_outbox (finished_at)
  WHERE status = 'dead' AND dead_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS order_email_outbox_delivery_problem_idx
  ON private.order_email_outbox (delivery_event_at)
  WHERE delivery_status IN ('bounced', 'complained', 'suppressed', 'failed') AND delivery_alert_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS order_email_outbox_delivery_check_idx
  ON private.order_email_outbox (sent_at)
  WHERE status = 'sent' AND provider_message_id IS NOT NULL
    AND (delivery_status IS NULL OR delivery_status = 'delayed');

-- 2. 送信の一時停止（1行だけ。設計書 4-5）
CREATE TABLE IF NOT EXISTS private.order_email_send_pause (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  reason text CHECK (
    reason IS NULL
    OR reason IN ('config_api_key', 'config_sender_domain', 'config_provider', 'quota_daily', 'quota_monthly')
  ),
  paused_at timestamptz,
  next_probe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_email_send_pause_state_check CHECK (
    (paused AND reason IS NOT NULL AND paused_at IS NOT NULL AND next_probe_at IS NOT NULL)
    OR (NOT paused AND reason IS NULL AND paused_at IS NULL AND next_probe_at IS NULL)
  )
);

INSERT INTO private.order_email_send_pause (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 3. Resend の知らせの受付済みの番号（設計書 6-2。Svix の送り直しは約28時間なので3日持つ）
CREATE TABLE IF NOT EXISTS private.resend_webhook_receipts (
  svix_id text PRIMARY KEY CHECK (pg_catalog.char_length(svix_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS resend_webhook_receipts_received_idx
  ON private.resend_webhook_receipts (received_at);

-- private は Data API から見えないが、念のため RLS を有効にして方針を置かず、表の権限も外す（関数だけで触る）
ALTER TABLE private.order_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.order_email_send_pause ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.resend_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.order_email_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.order_email_send_pause FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.resend_webhook_receipts FROM PUBLIC, anon, authenticated, service_role;

-- 4. 回数と待つ時間（設計書 4-3）
CREATE OR REPLACE FUNCTION private.order_email_max_attempts()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 9
$$;

-- 失敗した試行が _failed_attempts 回の後に待つ時間（1・2・4…128分）。前後2割の揺らぎを足す
CREATE OR REPLACE FUNCTION private.order_email_retry_delay(_failed_attempts integer)
RETURNS interval
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT pg_catalog.make_interval(
    secs => 60 * (2 ^ LEAST(GREATEST(COALESCE(_failed_attempts, 1) - 1, 0), 7)) * (0.8 + 0.4 * pg_catalog.random())
  )
$$;

-- 5. 行を書く（設計書 3-1）。状態を変える関数が同じ取引で呼ぶ。自動の行は1注文1種類1行なので、2回目は何もしない
CREATE OR REPLACE FUNCTION private.enqueue_order_email(_order_id uuid, _kind text, _variant text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin)
  VALUES (_order_id, _kind, _variant, 'auto')
  ON CONFLICT (order_id, kind) WHERE origin = 'auto' DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 6. 送信全体を止める（設計書 4-5）。止めた時刻は最初に止めた時のまま、次に1件試す時刻を決め直す
CREATE OR REPLACE FUNCTION private.set_order_email_pause(_reason text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_was_paused boolean;
BEGIN
  IF _reason IS NULL
     OR _reason NOT IN ('config_api_key', 'config_sender_domain', 'config_provider', 'quota_daily', 'quota_monthly') THEN
    RAISE EXCEPTION 'INVALID_PAUSE_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT p.paused INTO v_was_paused FROM private.order_email_send_pause AS p WHERE p.id FOR UPDATE;

  UPDATE private.order_email_send_pause AS p
  SET paused = true,
      reason = _reason,
      paused_at = CASE WHEN p.paused THEN p.paused_at ELSE pg_catalog.now() END,
      -- 1日の上限は UTC 0時（日本時間 9時）に戻る。それまで試さない
      next_probe_at = CASE
        WHEN _reason = 'quota_daily'
          THEN (pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
        ELSE pg_catalog.now() + interval '15 minutes'
      END,
      updated_at = pg_catalog.now()
  WHERE p.id;

  RETURN NOT COALESCE(v_was_paused, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_order_email_sending(_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.set_order_email_pause(_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_order_email_send_state()
RETURNS TABLE (paused boolean, reason text, paused_at timestamptz, next_probe_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.paused, p.reason, p.paused_at, p.next_probe_at
  FROM private.order_email_send_pause AS p
  WHERE p.id
$$;

-- 7. 送る行を1つ取り出す（設計書 4-1・4-3・4-5）
--   1) 担当の期限が切れた試行は1回の失敗として数える（9回目なら送れなかった）。控えた中身は残す（同じ鍵で送り直す）
--   2) 止めている間は次に試す時刻まで何も返さない。時刻を過ぎていたら1件だけ返し、次に試す時刻を先へ進める
--   3) 同じ注文の前の行が片付くまで、後の行は取り出さない
CREATE OR REPLACE FUNCTION public.claim_order_email(_lease_seconds integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  variant text,
  origin text,
  attempts integer,
  lease_token uuid,
  subject text,
  body_text text,
  payment_expired_sent boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_paused boolean;
  v_next_probe_at timestamptz;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN 'dead' ELSE 'retry_wait' END,
      finished_at = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN pg_catalog.now() END,
      subject = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.subject END,
      body_text = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.body_text END,
      body_erased_at = CASE
        WHEN e.attempts >= private.order_email_max_attempts() AND e.subject IS NOT NULL THEN pg_catalog.now()
        ELSE e.body_erased_at
      END,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = 'lease_expired',
      next_attempt_at = pg_catalog.now() + private.order_email_retry_delay(e.attempts)
  WHERE e.status = 'sending'
    AND e.lease_expires_at <= pg_catalog.now();

  -- 止めていない間は一時停止の行をロックしない（同時に動く worker の取り出しを待たせない）
  SELECT p.paused INTO v_paused FROM private.order_email_send_pause AS p WHERE p.id;
  IF v_paused THEN
    SELECT p.paused, p.next_probe_at INTO v_paused, v_next_probe_at
    FROM private.order_email_send_pause AS p
    WHERE p.id
    FOR UPDATE;

    IF v_paused THEN
      IF v_next_probe_at > pg_catalog.now() THEN
        RETURN;
      END IF;
      UPDATE private.order_email_send_pause AS p
      SET next_probe_at = pg_catalog.now() + interval '15 minutes',
          updated_at = pg_catalog.now()
      WHERE p.id;
    END IF;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM private.order_email_outbox AS e
    WHERE e.status IN ('pending', 'retry_wait')
      AND e.next_attempt_at <= pg_catalog.now()
      AND NOT EXISTS (
        SELECT 1
        FROM private.order_email_outbox AS earlier
        WHERE earlier.order_id = e.order_id
          AND earlier.seq < e.seq
          AND earlier.status IN ('pending', 'sending', 'retry_wait')
      )
    ORDER BY e.next_attempt_at, e.seq
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE private.order_email_outbox AS e
    SET status = 'sending',
        attempts = e.attempts + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => _lease_seconds),
        last_error_code = NULL
    FROM candidate AS c
    WHERE e.id = c.id
    RETURNING e.id, e.order_id, e.kind, e.variant, e.origin, e.attempts, e.lease_token, e.subject, e.body_text
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         )
  FROM claimed AS c;
END;
$$;

-- 8. 最初に送る前に中身を控える（設計書 4-2）。控えは一度だけ
CREATE OR REPLACE FUNCTION public.save_order_email_content(
  _email_id uuid,
  _lease_token uuid,
  _subject text,
  _body_text text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _subject IS NULL OR _body_text IS NULL THEN
    RAISE EXCEPTION 'CONTENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET subject = _subject,
      body_text = _body_text
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token
    AND e.subject IS NULL;
  RETURN FOUND;
END;
$$;

-- 9. 送信済みにする。送れたので、止めていた送信を同じ取引で再開する（設計書 4-5。half-open から closed）
CREATE OR REPLACE FUNCTION public.complete_order_email(
  _email_id uuid,
  _lease_token uuid,
  _provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.order_email_outbox AS e
  SET status = 'sent',
      sent_at = pg_catalog.now(),
      finished_at = pg_catalog.now(),
      provider_message_id = NULLIF(pg_catalog.btrim(_provider_message_id), ''),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE private.order_email_send_pause AS p
  SET paused = false,
      reason = NULL,
      paused_at = NULL,
      next_probe_at = NULL,
      updated_at = pg_catalog.now()
  WHERE p.id
    AND p.paused;

  RETURN true;
END;
$$;

-- 10. 失敗を記録する（設計書 4-3・4-4）。結果の状態を返し、担当の印が合わなければ NULL
--   transient: やり直し待ち（9回目の失敗なら送れなかった）。待つ時間の指示が長ければそちら（最大1日）
--   permanent: すぐ送れなかった
--   config: このメールの失敗として数えず、すぐ取り出せる状態に戻して送信全体を止める
CREATE OR REPLACE FUNCTION public.fail_order_email(
  _email_id uuid,
  _lease_token uuid,
  _error_code text,
  _category text,
  _retry_after_seconds integer DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF _category IS NULL OR _category NOT IN ('transient', 'permanent', 'config') THEN
    RAISE EXCEPTION 'INVALID_FAILURE_CATEGORY' USING ERRCODE = '22023';
  END IF;
  IF _error_code IS NULL OR _error_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023';
  END IF;

  IF _category = 'config' THEN
    UPDATE private.order_email_outbox AS e
    SET status = 'retry_wait',
        attempts = GREATEST(e.attempts - 1, 0),
        next_attempt_at = pg_catalog.now(),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = _error_code
    WHERE e.id = _email_id
      AND e.status = 'sending'
      AND e.lease_token = _lease_token
    RETURNING e.status INTO v_status;

    IF v_status IS NOT NULL THEN
      PERFORM private.set_order_email_pause(_error_code);
    END IF;
    RETURN v_status;
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN 'dead'
        ELSE 'retry_wait'
      END,
      finished_at = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN pg_catalog.now()
      END,
      subject = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN NULL
        ELSE e.subject
      END,
      body_text = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN NULL
        ELSE e.body_text
      END,
      body_erased_at = CASE
        WHEN (_category = 'permanent' OR e.attempts >= private.order_email_max_attempts()) AND e.subject IS NOT NULL
          THEN pg_catalog.now()
        ELSE e.body_erased_at
      END,
      next_attempt_at = pg_catalog.now() + GREATEST(
        private.order_email_retry_delay(e.attempts),
        pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(_retry_after_seconds, 0), 0), 86400))
      ),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = _error_code
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token
  RETURNING e.status INTO v_status;

  RETURN v_status;
END;
$$;

-- 11. 取りやめ（設計書 4-1）。理由を残し、控えた本文を消す
CREATE OR REPLACE FUNCTION public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _reason IS NULL OR _reason NOT IN ('superseded', 'no_recipient') THEN
    RAISE EXCEPTION 'INVALID_SKIP_REASON' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = _reason
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token;
  RETURN FOUND;
END;
$$;

-- 12. 管理画面の再送（設計書 5-3）。今の注文の状態で意味のある種類で、送信済みか送れなかった行があるときだけ。
--     書き分けはその種類の最後の行から写す。同じ種類の手の再送が送信待ちなら断る
CREATE OR REPLACE FUNCTION public.request_order_email_resend(_order_id uuid, _kind text, _actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.order_status;
  v_variant text;
  v_found boolean;
  v_email_id uuid;
BEGIN
  IF _order_id IS NULL OR _kind IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESEND_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _kind NOT IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped') THEN
    RAISE EXCEPTION 'INVALID_EMAIL_KIND' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    (_kind = 'paid' AND v_status IN ('paid', 'shipped'))
    OR (_kind = 'awaiting_payment' AND v_status = 'pending')
    OR (_kind = 'payment_expired' AND v_status = 'failed')
    OR (_kind = 'canceled' AND v_status = 'cancelled')
    OR (_kind = 'shipped' AND v_status = 'shipped')
  ) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  SELECT e.variant, true INTO v_variant, v_found
  FROM private.order_email_outbox AS e
  WHERE e.order_id = _order_id
    AND e.kind = _kind
    AND e.status IN ('sent', 'dead')
  ORDER BY e.seq DESC
  LIMIT 1;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, requested_by)
    VALUES (_order_id, _kind, v_variant, 'manual', _actor_id)
    RETURNING id INTO v_email_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESEND_ALREADY_QUEUED' USING ERRCODE = '23505';
  END;

  RETURN v_email_id;
END;
$$;

-- 13. 管理画面の履歴（設計書 5-1）。本文は返さない
CREATE OR REPLACE FUNCTION public.list_order_email_history(_order_id uuid)
RETURNS TABLE (
  email_id uuid,
  kind text,
  variant text,
  origin text,
  requested_by_email text,
  status text,
  attempts integer,
  last_error_code text,
  delivery_status text,
  delivery_event_at timestamptz,
  created_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  has_body boolean,
  body_erased boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 注文の状態の変化（order_revisions から）。前後の値はそのまま返さず、決めた項目だけ取り出す（住所などを出さない）
CREATE OR REPLACE FUNCTION public.list_order_status_history(_order_id uuid)
RETURNS TABLE (
  changed_at timestamptz,
  from_status text,
  to_status text,
  change_reason text,
  actor_email text,
  shipping_carrier text,
  tracking_number text,
  cancel_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.changed_at,
         r.before_data ->> 'status',
         r.after_data ->> 'status',
         r.reason,
         u.email::text,
         CASE WHEN r.after_data ->> 'status' = 'shipped' THEN r.after_data ->> 'shipping_carrier' END,
         CASE WHEN r.after_data ->> 'status' = 'shipped' THEN r.after_data ->> 'tracking_number' END,
         CASE WHEN r.after_data ->> 'status' = 'cancelled' THEN r.after_data ->> 'cancel_reason' END
  FROM public.order_revisions AS r
  LEFT JOIN auth.users AS u ON u.id = r.changed_by
  WHERE r.order_id = _order_id
    AND r.operation = 'status_update'
  ORDER BY r.changed_at DESC, r.id DESC
$$;

-- 14. 送ったメールの中身（設計書 5-2）。送信済みの行だけ
CREATE OR REPLACE FUNCTION public.get_order_email_content(_order_id uuid, _email_id uuid)
RETURNS TABLE (subject text, body_text text, sent_at timestamptz, body_erased boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.subject, e.body_text, e.sent_at, e.body_erased_at IS NOT NULL
  FROM private.order_email_outbox AS e
  WHERE e.id = _email_id
    AND e.order_id = _order_id
    AND e.status = 'sent'
$$;

-- 15. 配達の状態（設計書 6-2〜6-4）。受け口は知らせの番号つき、見回りは番号なしで呼ぶ。
--     同じ知らせは1回だけ、記録より新しい知らせだけ書き換える。届かなかった知らせは店へ知らせ直す
CREATE OR REPLACE FUNCTION public.record_order_email_delivery(
  _svix_id text,
  _provider_message_id text,
  _delivery_status text,
  _event_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated uuid;
BEGIN
  IF _provider_message_id IS NULL
     OR pg_catalog.char_length(_provider_message_id) NOT BETWEEN 1 AND 200
     OR _event_at IS NULL
     OR _delivery_status IS NULL
     OR _delivery_status NOT IN ('delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'failed') THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_EVENT' USING ERRCODE = '22023';
  END IF;

  IF _svix_id IS NOT NULL THEN
    INSERT INTO private.resend_webhook_receipts (svix_id) VALUES (_svix_id)
    ON CONFLICT (svix_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN 'duplicate';
    END IF;
  END IF;

  UPDATE private.order_email_outbox AS e
  SET delivery_status = _delivery_status,
      delivery_event_at = _event_at,
      delivery_alert_notified_at = CASE
        WHEN _delivery_status IN ('bounced', 'complained', 'suppressed', 'failed') THEN NULL
        ELSE e.delivery_alert_notified_at
      END
  WHERE e.provider_message_id = _provider_message_id
    AND (e.delivery_event_at IS NULL OR e.delivery_event_at < _event_at)
  RETURNING e.id INTO v_updated;

  IF v_updated IS NOT NULL THEN
    RETURN 'updated';
  END IF;
  IF EXISTS (SELECT 1 FROM private.order_email_outbox AS e WHERE e.provider_message_id = _provider_message_id) THEN
    RETURN 'stale';
  END IF;
  RETURN 'unknown_email';
END;
$$;

-- 1時間ごとの見回りの対象（設計書 6-4）。送ってから3日以内で、配達の状態が無いか遅れのメール
CREATE OR REPLACE FUNCTION public.list_order_emails_awaiting_delivery(_limit integer)
RETURNS TABLE (email_id uuid, provider_message_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.provider_message_id
  FROM private.order_email_outbox AS e
  WHERE e.status = 'sent'
    AND e.provider_message_id IS NOT NULL
    AND (e.delivery_status IS NULL OR e.delivery_status = 'delayed')
    AND e.sent_at > pg_catalog.now() - interval '3 days'
  ORDER BY e.sent_at, e.seq
  LIMIT LEAST(GREATEST(COALESCE(_limit, 0), 0), 100)
$$;

-- 16. 点検（設計書 4-6・4-8）。中身は返さず、原因の記号だけ返す
CREATE OR REPLACE FUNCTION public.get_order_email_backlog(_older_than_seconds integer)
RETURNS TABLE (status text, email_count integer, oldest_created_at timestamptz, last_errors text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.status,
         pg_catalog.count(*)::integer,
         pg_catalog.min(e.created_at),
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT e.last_error_code), NULL)
  FROM private.order_email_outbox AS e
  WHERE e.status IN ('pending', 'sending', 'retry_wait')
    AND e.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _older_than_seconds)
  GROUP BY e.status
  ORDER BY e.status
$$;

CREATE OR REPLACE FUNCTION public.list_unnotified_dead_order_emails(_limit integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  last_error_code text,
  attempts integer,
  finished_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.order_id, e.kind, e.last_error_code, e.attempts, e.finished_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM private.order_email_outbox AS e
  WHERE e.status = 'dead'
    AND e.dead_notified_at IS NULL
  ORDER BY e.finished_at, e.seq
  LIMIT _limit
$$;

CREATE OR REPLACE FUNCTION public.mark_order_emails_dead_notified(_email_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET dead_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_email_ids)
    AND e.status = 'dead'
    AND e.dead_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unnotified_order_email_delivery_problems(_limit integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  delivery_status text,
  delivery_event_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.order_id, e.kind, e.delivery_status, e.delivery_event_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM private.order_email_outbox AS e
  WHERE e.delivery_status IN ('bounced', 'complained', 'suppressed', 'failed')
    AND e.delivery_alert_notified_at IS NULL
  ORDER BY e.delivery_event_at, e.seq
  LIMIT _limit
$$;

CREATE OR REPLACE FUNCTION public.mark_order_email_delivery_problems_notified(_email_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET delivery_alert_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_email_ids)
    AND e.delivery_status IN ('bounced', 'complained', 'suppressed', 'failed')
    AND e.delivery_alert_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 17. 毎日の片付け（設計書 7-5）。送信済みの本文は送ってから45日、取りやめ・送れなかったの本文は残っていれば消す。
--     Resend の知らせの受付済みの番号は3日
CREATE OR REPLACE FUNCTION private.purge_order_email_data()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE private.order_email_outbox AS e
  SET subject = NULL,
      body_text = NULL,
      body_erased_at = pg_catalog.now()
  WHERE e.subject IS NOT NULL
    AND (
      (e.status = 'sent' AND e.sent_at < pg_catalog.now() - interval '45 days')
      OR e.status IN ('skipped', 'dead')
    );

  DELETE FROM private.resend_webhook_receipts AS r
  WHERE r.received_at < pg_catalog.now() - interval '3 days';
END;
$$;

-- 18. 定期処理の最後の成功に、注文のメールの worker と配達の見回りを足す
ALTER TABLE public.ops_job_heartbeats
  DROP CONSTRAINT IF EXISTS ops_job_heartbeats_job_check,
  ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
    job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check')
  );

-- 19. 権限。private の関数は PUBLIC から外すだけ（状態を変える関数と定期処理だけが呼ぶ）
REVOKE ALL ON FUNCTION private.order_email_max_attempts() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_email_retry_delay(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.set_order_email_pause(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.purge_order_email_data() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_order_email_content(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_order_email(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_order_email_sending(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_send_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_status_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_content(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_email_delivery(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_emails_awaiting_delivery(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_backlog(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_dead_order_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_emails_dead_notified(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_order_email_delivery_problems(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_email_delivery_problems_notified(uuid[]) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_order_email_content(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_email(uuid, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_order_email_sending(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_send_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_status_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_content(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_email_delivery(text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_emails_awaiting_delivery(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_backlog(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_dead_order_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_emails_dead_notified(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_order_email_delivery_problems(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_email_delivery_problems_notified(uuid[]) TO service_role;

-- 20. 毎日の片付け（日本時間 4:40。実行の記録の掃除の後）。同名のジョブは置き換わる
SELECT cron.schedule(
  'order-email-retention',
  '40 19 * * *',
  $$ SELECT private.purge_order_email_data() $$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 4: テストが通ることを確かめる（controller）**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_email_outbox --runInBand`
Expected: PASS（全件）。続けて Global Constraints の DB 結合テスト（フォルダ全体）を流し、ほかの試験が落ちないこと（`ops_alerting` の「知らない定期処理の名前は断る」が通ること）を確かめる

- [ ] **Step 5: コミット（controller）**

```bash
git add supabase/migrations/20261009095633_order_email_outbox.sql tests/integration/db/order_email_outbox.integration.test.ts
git commit -m "feat(db): 注文のメールの表と送る予定の関数を足す（グループ D 移行 A）"
```

---

### Task 2: 中身を作る・送る・取り出して送る（サーバーの部品）

**Files:**
- Create: `src/lib/orders/email/order-email-types.ts`
- Create: `src/lib/orders/email/order-email-compose.ts`
- Create: `src/lib/orders/email/order-email-sender.ts`
- Create: `src/lib/orders/email/order-email-store.ts`
- Create: `src/lib/orders/email/order-email-worker.ts`
- Create: `src/lib/orders/email/order-email-schedule.ts`
- Test: `tests/unit/lib/orders/email/order-email-types.test.ts`・`order-email-compose.test.ts`・`order-email-sender.test.ts`・`order-email-store.test.ts`・`order-email-worker.test.ts`・`order-email-schedule.test.ts`（すべて新規）

**Interfaces:**
- Consumes: Task 1 の `claim_order_email`・`save_order_email_content`・`complete_order_email`・`fail_order_email`・`skip_order_email`・`pause_order_email_sending`・`get_order_email_send_state`。既存の `formatCurrency`・`formatItemLines`・`ConfirmationItem`・`OrderEmailRow`（`src/lib/orders/order-confirmation-email.ts`）、`resolveMailProvider`（`src/lib/mail.ts`）、`sendMail`（`src/lib/mail/adapters/local.ts`）、`PaidEmailVariant`・`OrderStatus`（`src/lib/orders/order-payment-types.ts`）
- Produces（後のタスクが使う）:
  - `order-email-types.ts`: `ORDER_EMAIL_KINDS`・`OrderEmailKind`・`OrderEmailVariant`・`CanceledEmailVariant`・`ORDER_EMAIL_STATUSES`・`OrderEmailStatus`・`ORDER_EMAIL_DELIVERY_STATUSES`・`OrderEmailDeliveryStatus`・`DELIVERY_PROBLEM_STATUSES`・`ORDER_EMAIL_ERROR_CODES`・`OrderEmailErrorCode`・`OrderEmailFailureCategory`・`OrderEmailPauseReason`・`OrderEmailSkipReason`・`ORDER_EMAIL_KIND_LABELS`・`ORDER_EMAIL_ERROR_LABELS`・`ORDER_EMAIL_DELIVERY_LABELS`・`RESENDABLE_ORDER_STATUSES`・`isOrderEmailKind(value)`・`isOrderEmailErrorCode(value)`・`describeOrderEmailState(status, delivery): { label: string; warning: boolean }`
  - `order-email-compose.ts`: `loadOrderEmailMaterial(store: Pick<SupabaseClient, 'from'>, orderId: string): Promise<OrderEmailMaterial | null>`・`OrderEmailMaterialError`・`composeOrderEmail(material, { kind, variant, paymentExpiredSent }): { subject: string; text: string } | null`・`greeting(fullName)`・型 `OrderEmailMaterial`・`OrderEmailMaterialRow`
  - `order-email-sender.ts`: `checkOrderEmailSendConfig(env?): OrderEmailPauseReason | null`・`sendOrderEmailMessage(message: OrderEmailMessage, env?): Promise<OrderEmailSendOutcome>`・`classifyResendError(error, headers?)`・`parseRetryAfter(headers)`・型 `OrderEmailMessage`・`OrderEmailSendFailure`・`OrderEmailSendOutcome`
  - `order-email-store.ts`: 型 `OrderEmailStore`（`rpc(name: OrderEmailRpcName, params?)`）・`OrderEmailRpcName`・`OrderEmailStoreError`・`ClaimedOrderEmail`・`OrderEmailSendState`。関数 `claimOrderEmail(store, leaseSeconds)`・`saveOrderEmailContent(store, claim, content)`・`completeOrderEmail(store, claim, providerMessageId)`・`failOrderEmail(store, claim, failure)`・`skipOrderEmail(store, claim, reason)`・`pauseOrderEmailSending(store, reason)`・`getOrderEmailSendState(store)`
  - `order-email-worker.ts`: `ORDER_EMAIL_WORKER_BUDGET_MS = 10_000`・`ORDER_EMAIL_LEASE_SECONDS = 300`・`skipReasonFor(claim, material)`・`processOrderEmails(deps): Promise<OrderEmailWorkerResult>`・`runOrderEmailWorker(options?: { budgetMs?: number }): Promise<OrderEmailWorkerResult>`・型 `OrderEmailWorkerDeps`・`OrderEmailWorkerResult`（`{ sent: number; skipped: number; failed: number; stoppedBy: 'empty' | 'budget' | 'paused' | 'claim_error' }`）
  - `order-email-schedule.ts`: `scheduleOrderEmailDelivery(): void`

この Task では、まだ誰も新しい部品を呼ばない（Task 3・4 がつなぐ）。今のメールの送り方（`order-confirmation-email.ts` などの送信）は Task 3 まで変えない。

- [ ] **Step 1: 種類と名前の試験を書く**

`tests/unit/lib/orders/email/order-email-types.test.ts`:

```ts
import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  isOrderEmailKind,
  ORDER_EMAIL_ERROR_CODES,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  RESENDABLE_ORDER_STATUSES,
} from '@/lib/orders/email/order-email-types';

describe('注文のメールの種類と名前', () => {
  it('種類の名前は設計書のとおり', () => {
    expect(ORDER_EMAIL_KIND_LABELS).toEqual({
      paid: '注文確認', awaiting_payment: '入金待ち', payment_expired: '支払い期限切れ', canceled: '取消', shipped: '発送',
    });
  });

  it('原因の記号にはすべて日本語の名前がある。宛先の形の不正は「宛先の形が不正」', () => {
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(ORDER_EMAIL_ERROR_LABELS[code]).toEqual(expect.any(String));
    expect(ORDER_EMAIL_ERROR_LABELS.invalid_message).toBe('宛先の形が不正');
    expect(ORDER_EMAIL_ERROR_LABELS.provider_unavailable).toBe('送信サービスの一時的な失敗');
  });

  it('再送できる注文の状態は DB の request_order_email_resend と同じ表', () => {
    expect(RESENDABLE_ORDER_STATUSES).toEqual({
      paid: ['paid', 'shipped'], awaiting_payment: ['pending'], payment_expired: ['failed'], canceled: ['cancelled'], shipped: ['shipped'],
    });
  });

  it.each([
    ['pending', null, '送信待ち', false],
    ['sending', null, '送信待ち', false],
    ['retry_wait', null, 'やり直し待ち', false],
    ['sent', null, '送信済み', false],
    ['sent', 'delivered', '配達済み', false],
    ['sent', 'delayed', '配達の遅れ', false],
    ['sent', 'bounced', '届かなかった', true],
    ['sent', 'complained', '迷惑メールにされた', true],
    ['sent', 'suppressed', '送信先が止められている', true],
    ['sent', 'failed', '送信サービスで送れなかった', true],
    ['skipped', null, '取りやめ', false],
    ['dead', null, '送れなかった', true],
  ] as const)('%s・%s は「%s」（注意の印 %s）', (status, delivery, label, warning) => {
    expect(describeOrderEmailState(status, delivery)).toEqual({ label, warning });
  });

  it('種類と原因の記号を見分ける', () => {
    expect(isOrderEmailKind('shipped')).toBe(true);
    expect(isOrderEmailKind('refund')).toBe(false);
    expect(isOrderEmailErrorCode('lease_expired')).toBe(true);
    expect(isOrderEmailErrorCode('Error: boom')).toBe(false);
  });
});
```

- [ ] **Step 2: 種類と名前を書く**

`src/lib/orders/email/order-email-types.ts`:

```ts
import type { OrderStatus, PaidEmailVariant } from '@/lib/orders/order-payment-types';

/**
 * 注文のメールの種類・状態・原因の記号（グループ D 設計書 3・4・5・6 章）。
 * DB の CHECK 制約（移行 20261009095633_order_email_outbox.sql）と同じ値を1か所に置く。画面からも読む。
 */
export const ORDER_EMAIL_KINDS = ['paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped'] as const;
export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];

/** 取消のメールの書き出しは、取り消す前の状態で変わる */
export type CanceledEmailVariant = 'payment_in_progress' | 'pending';
export type OrderEmailVariant = PaidEmailVariant | CanceledEmailVariant;

export const ORDER_EMAIL_STATUSES = ['pending', 'sending', 'retry_wait', 'sent', 'skipped', 'dead'] as const;
export type OrderEmailStatus = (typeof ORDER_EMAIL_STATUSES)[number];

export const ORDER_EMAIL_DELIVERY_STATUSES = [
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'suppressed',
  'failed',
] as const;
export type OrderEmailDeliveryStatus = (typeof ORDER_EMAIL_DELIVERY_STATUSES)[number];

/** 店へ知らせ、履歴に注意の印を付ける配達の状態（設計書 6-3） */
export const DELIVERY_PROBLEM_STATUSES: readonly OrderEmailDeliveryStatus[] = ['bounced', 'complained', 'suppressed', 'failed'];

export const ORDER_EMAIL_ERROR_CODES = [
  'provider_unavailable',
  'rate_limited',
  'network_error',
  'db_unavailable',
  'lease_expired',
  'unexpected_error',
  'config_api_key',
  'config_sender_domain',
  'config_provider',
  'quota_daily',
  'quota_monthly',
  'invalid_message',
  'idempotency_conflict',
  'source_missing',
  'superseded',
  'no_recipient',
  'legacy_suppressed',
] as const;
export type OrderEmailErrorCode = (typeof ORDER_EMAIL_ERROR_CODES)[number];

export type OrderEmailFailureCategory = 'transient' | 'config' | 'permanent';
export type OrderEmailPauseReason = Extract<
  OrderEmailErrorCode,
  'config_api_key' | 'config_sender_domain' | 'config_provider' | 'quota_daily' | 'quota_monthly'
>;
export type OrderEmailSkipReason = Extract<OrderEmailErrorCode, 'superseded' | 'no_recipient'>;

export const ORDER_EMAIL_KIND_LABELS: Record<OrderEmailKind, string> = {
  paid: '注文確認',
  awaiting_payment: '入金待ち',
  payment_expired: '支払い期限切れ',
  canceled: '取消',
  shipped: '発送',
};

/** 管理画面の履歴と店への知らせに出す原因（設計書 5-1） */
export const ORDER_EMAIL_ERROR_LABELS: Record<OrderEmailErrorCode, string> = {
  provider_unavailable: '送信サービスの一時的な失敗',
  rate_limited: '送信の回数の制限',
  network_error: '通信の失敗',
  db_unavailable: 'データベースの一時的な失敗',
  lease_expired: '処理の中断',
  unexpected_error: '想定外の失敗',
  config_api_key: '送信の鍵の設定',
  config_sender_domain: '送信元のドメインの設定',
  config_provider: '送信サービスの設定',
  quota_daily: '1日の送信の上限',
  quota_monthly: '1か月の送信の上限',
  invalid_message: '宛先の形が不正',
  idempotency_conflict: '同じ送信の印で中身が違う',
  source_missing: '注文の情報が足りない',
  superseded: '注文の状態が変わったため',
  no_recipient: '宛先が無い',
  legacy_suppressed: '移行前の注文のため',
};

export const ORDER_EMAIL_DELIVERY_LABELS: Record<OrderEmailDeliveryStatus, string> = {
  delivered: '配達済み',
  delayed: '配達の遅れ',
  bounced: '届かなかった',
  complained: '迷惑メールにされた',
  suppressed: '送信先が止められている',
  failed: '送信サービスで送れなかった',
};

/** 再送できる種類と、そのときの注文の状態（設計書 5-3。DB の request_order_email_resend と同じ表） */
export const RESENDABLE_ORDER_STATUSES: Record<OrderEmailKind, readonly OrderStatus[]> = {
  paid: ['paid', 'shipped'],
  awaiting_payment: ['pending'],
  payment_expired: ['failed'],
  canceled: ['cancelled'],
  shipped: ['shipped'],
};

export function isOrderEmailKind(value: unknown): value is OrderEmailKind {
  return typeof value === 'string' && (ORDER_EMAIL_KINDS as readonly string[]).includes(value);
}

export function isOrderEmailErrorCode(value: unknown): value is OrderEmailErrorCode {
  return typeof value === 'string' && (ORDER_EMAIL_ERROR_CODES as readonly string[]).includes(value);
}

/** 履歴に出す状態の名前と注意の印（設計書 5-1）。送信済みは、配達の状態が分かればそれを出す */
export function describeOrderEmailState(
  status: OrderEmailStatus,
  delivery: OrderEmailDeliveryStatus | null,
): { label: string; warning: boolean } {
  switch (status) {
    case 'pending':
    case 'sending':
      return { label: '送信待ち', warning: false };
    case 'retry_wait':
      return { label: 'やり直し待ち', warning: false };
    case 'skipped':
      return { label: '取りやめ', warning: false };
    case 'dead':
      return { label: '送れなかった', warning: true };
    case 'sent':
      return delivery
        ? { label: ORDER_EMAIL_DELIVERY_LABELS[delivery], warning: DELIVERY_PROBLEM_STATUSES.includes(delivery) }
        : { label: '送信済み', warning: false };
  }
}
```

- [ ] **Step 3: 中身を作る試験を書く**

`tests/unit/lib/orders/email/order-email-compose.test.ts`:

```ts
// 明細の書き方の部品（order-confirmation-email）が import する監査ログと Supabase を、試験では読み込まない
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function material(overrides: Partial<OrderEmailMaterial['order']> = {}): OrderEmailMaterial {
  return {
    order: {
      id: ORDER_ID,
      status: 'paid',
      shipping_email: 'hanako@example.com',
      shipping_full_name: '山田 花子',
      subtotal_amount: 10000,
      shipping_amount: 0,
      discount_amount: 0,
      total_amount: 10000,
      currency: 'jpy',
      shipping_postal_code: '1500001',
      shipping_prefecture: '東京都',
      shipping_city: '渋谷区',
      shipping_address: '神宮前1-1-1',
      shipping_building: null,
      shipping_phone: '0311112222',
      review_reason: null,
      shipping_carrier: null,
      tracking_number: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'backorder' }],
  };
}

describe('composeOrderEmail', () => {
  it('注文確認は今までと同じ件名と本文', () => {
    const email = composeOrderEmail(material(), { kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false });

    expect(email).toEqual({
      subject: '【Le Fil des Heures】ご注文ありがとうございます（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'この度はご注文いただき誠にありがとうございます。',
        'ご注文を承りました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        'ご注文内容:',
        '・コート（BLACK / M） x1　￥10,000',
        '　受注生産・発送まで数週間〜2か月以上（目安）',
        '',
        '小計: ￥10,000',
        '送料: 無料',
        '合計: ￥10,000',
        '',
        'お届け先:',
        '山田 花子 様',
        '〒1500001',
        '東京都渋谷区神宮前1-1-1',
        '0311112222',
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
  });

  it('割引があるときだけ割引の行を出す', () => {
    const email = composeOrderEmail(material({ discount_amount: 1000, total_amount: 9000 }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.text).toContain('割引: -￥1,000');
  });

  it('入金時に在庫を確保し直せなかった注文には、お届けの目安を出さない', () => {
    const email = composeOrderEmail(material({ review_reason: 'stock_not_reserved' }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.text).not.toContain('受注生産・発送まで');
  });

  it('期限切れの案内を送った後の入金だけ、期限切れの後の文面にする', () => {
    const sent = composeOrderEmail(material(), { kind: 'paid', variant: 'payment_received_after_expiry', paymentExpiredSent: true });
    const notSent = composeOrderEmail(material(), { kind: 'paid', variant: 'payment_received_after_expiry', paymentExpiredSent: false });

    expect(sent?.text).toContain('お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。');
    expect(notSent?.text).not.toContain('お支払い期限が過ぎたため');
    expect(notSent?.text).toContain('この度はご注文いただき誠にありがとうございます。');
  });

  it('入金待ちは件名と書き出しが変わる', () => {
    const email = composeOrderEmail(material({ status: 'pending' }), { kind: 'awaiting_payment', variant: null, paymentExpiredSent: false });
    expect(email?.subject).toBe('【お支払い待ち】ご注文を承りました（ORD-A1B2C3D4）');
    expect(email?.text).toContain('ご注文を承りました。まだお支払いは完了していません。');
  });

  it('支払い期限切れは今までと同じ件名と書き出し', () => {
    const email = composeOrderEmail(material({ status: 'failed' }), { kind: 'payment_expired', variant: null, paymentExpiredSent: false });
    expect(email?.subject).toBe('【Le Fil des Heures】お支払い期限切れのお知らせ（ORD-A1B2C3D4）');
    expect(email?.text).toContain('お支払い期限が過ぎたため、ご注文を取り消しました。');
    expect(email?.text).toContain('合計: ￥10,000');
  });

  it.each([
    ['payment_in_progress', 'お手続き中のご注文を取り消しました。'],
    ['pending', 'お支払い待ちのご注文を取り消しました。'],
  ] as const)('取消は前の状態 %s で書き出しが変わる', (variant, lead) => {
    const email = composeOrderEmail(material({ status: 'cancelled' }), { kind: 'canceled', variant, paymentExpiredSent: false });
    expect(email?.subject).toBe('【Le Fil des Heures】ご注文取消のお知らせ（ORD-A1B2C3D4）');
    expect(email?.text).toContain(lead);
  });

  it('発送は配送業者と追跡のリンクを出す。業者か伝票番号が無ければ作らない', () => {
    const email = composeOrderEmail(material({ status: 'shipped', shipping_carrier: 'yamato', tracking_number: '1234-5678' }), {
      kind: 'shipped', variant: null, paymentExpiredSent: false,
    });
    expect(email?.subject).toBe('【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）');
    expect(email?.text).toContain('配送業者: ヤマト運輸');
    expect(email?.text).toContain('追跡番号: 1234-5678');
    expect(email?.text).toContain('number=1234-5678');

    expect(composeOrderEmail(material({ status: 'shipped' }), { kind: 'shipped', variant: null, paymentExpiredSent: false })).toBeNull();
    expect(composeOrderEmail(material({ status: 'shipped', shipping_carrier: 'unknown', tracking_number: '1' }), {
      kind: 'shipped', variant: null, paymentExpiredSent: false,
    })).toBeNull();
  });

  it('件名には氏名も商品名も入れない', () => {
    const email = composeOrderEmail(material({ shipping_full_name: '山田\r\nBcc: x@example.com' }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.subject).not.toContain('山田');
    expect(email?.subject).not.toContain('コート');
  });
});

describe('loadOrderEmailMaterial', () => {
  function store(results: { order: unknown; orderError?: unknown; items?: unknown; itemsError?: unknown }) {
    const from = jest.fn((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: results.order, error: results.orderError ?? null }) }) }),
        };
      }
      return { select: () => ({ eq: async () => ({ data: results.items ?? null, error: results.itemsError ?? null }) }) };
    });
    return { from } as never;
  }

  it('注文と明細を読む。注文の状態・配送業者・伝票番号も読む', async () => {
    const order = material().order;
    const items = material().items;

    await expect(loadOrderEmailMaterial(store({ order, items }), ORDER_ID)).resolves.toEqual({ order, items });
  });

  it('注文が無い・明細が0件なら null', async () => {
    await expect(loadOrderEmailMaterial(store({ order: null }), ORDER_ID)).resolves.toBeNull();
    await expect(loadOrderEmailMaterial(store({ order: material().order, items: [] }), ORDER_ID)).resolves.toBeNull();
  });

  it('読めなければ OrderEmailMaterialError を投げる', async () => {
    await expect(loadOrderEmailMaterial(store({ order: null, orderError: { message: 'down' } }), ORDER_ID)).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order: material().order, itemsError: { message: 'down' } }), ORDER_ID),
    ).rejects.toBeInstanceOf(OrderEmailMaterialError);
  });
});
```

円の書き方（`￥` か `¥` か）は `formatCurrency` の結果に合わせる。Step 4 の前に `node -e "console.log(new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(10000))"` で確かめ、違えば試験の文字だけを直す（コードは直さない）。

- [ ] **Step 4: 中身を作る部品を書く**

`src/lib/orders/email/order-email-compose.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  formatCurrency,
  formatItemLines,
  type ConfirmationItem,
  type OrderEmailRow,
} from '@/lib/orders/order-confirmation-email';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { OrderEmailKind, OrderEmailVariant } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの材料を読み、件名と本文を作る（グループ D 設計書 4-2）。
 * 文面は今までのメール（注文確認・入金待ち・期限切れ・取消・発送）と同じにする。
 * 件名は固定の文と注文番号だけで組み、氏名や商品名は本文にだけ入れる（メールの見出しへの差し込みを防ぐ）。
 */
const SHOP_NAME = 'Le Fil des Heures';

const MATERIAL_ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone, review_reason, shipping_carrier, tracking_number';

const PAID_LEAD = ['この度はご注文いただき誠にありがとうございます。', 'ご注文を承りました。'];

const PAID_AFTER_EXPIRY_LEAD = [
  'お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。',
  'ご注文は有効です。このまま商品をお届けします。',
];

const AWAITING_LEAD = [
  'ご注文を承りました。まだお支払いは完了していません。',
  'お支払い手続きの案内は、決済画面および Stripe からのメールをご確認ください。',
  'ご入金の確認後、あらためて確認メールをお送りします。',
];

export type OrderEmailMaterialRow = OrderEmailRow & {
  status: OrderStatus;
  shipping_carrier: string | null;
  tracking_number: string | null;
};

export type OrderEmailMaterial = { order: OrderEmailMaterialRow; items: ConfirmationItem[] };

export type ComposeRequest = {
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  /** 期限切れのメールを実際に送ったか。送っていなければ、期限切れの後の入金も普通の文面にする（設計書 4-1） */
  paymentExpiredSent: boolean;
};

export type ComposedOrderEmail = { subject: string; text: string };

/** 材料を読めなかった（DB の失敗）。worker は一時的な失敗としてやり直す */
export class OrderEmailMaterialError extends Error {
  constructor(
    readonly table: 'orders' | 'order_items',
    options?: { cause?: unknown },
  ) {
    super(`order email material could not be read: ${table}`, options);
    this.name = 'OrderEmailMaterialError';
  }
}

/** 注文行と明細を読む。注文が無い・明細が0件なら null（送れない）。読めなければ OrderEmailMaterialError を投げる */
export async function loadOrderEmailMaterial(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
): Promise<OrderEmailMaterial | null> {
  const { data: order, error: orderError } = await store
    .from('orders')
    .select(MATERIAL_ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<OrderEmailMaterialRow>();
  if (orderError) {
    throw new OrderEmailMaterialError('orders', { cause: orderError });
  }
  if (!order) {
    return null;
  }

  const { data: items, error: itemsError } = await store
    .from('order_items')
    .select('item_name, color, size, quantity, line_total, fulfillment_type')
    .eq('order_id', orderId);
  if (itemsError) {
    throw new OrderEmailMaterialError('order_items', { cause: itemsError });
  }
  if (!items || items.length === 0) {
    return null;
  }

  return { order, items: items as ConfirmationItem[] };
}

export function greeting(fullName: string | null): string {
  return fullName ? `${fullName} 様` : 'お客様';
}

function contactLine(orderId: string): string {
  return `お問い合わせの際は、注文番号（${toOrderNumber(orderId)}）をお問い合わせフォームにご入力ください。`;
}

function orderSummaryLines({ order, items }: OrderEmailMaterial): string[] {
  return [
    `注文番号: ${toOrderNumber(order.id)}`,
    '',
    'ご注文内容:',
    ...formatItemLines(items, order.currency),
    '',
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
  ];
}

function composeConfirmation(
  { order, items }: OrderEmailMaterial,
  state: 'paid' | 'awaiting_payment',
  leadLines: string[],
): ComposedOrderEmail {
  const orderNumber = toOrderNumber(order.id);
  const subject =
    state === 'awaiting_payment'
      ? `【お支払い待ち】ご注文を承りました（${orderNumber}）`
      : `【Le Fil des Heures】ご注文ありがとうございます（${orderNumber}）`;

  // 入金時に在庫を確保し直せなかった注文は、fulfillment_type が stock のままでも引渡しの時期を約束できない。
  const itemLines = formatItemLines(items, order.currency, { withFulfillment: order.review_reason !== 'stock_not_reserved' });

  // 空の項目で空行が出ないよう、値のある行だけを積む。
  const shippingLines = [
    order.shipping_full_name ? `${order.shipping_full_name} 様` : null,
    order.shipping_postal_code ? `〒${order.shipping_postal_code}` : null,
    [order.shipping_prefecture, order.shipping_city, order.shipping_address].filter(Boolean).join('') || null,
    order.shipping_building || null,
    order.shipping_phone || null,
  ].filter((line): line is string => Boolean(line));

  // 注文確定の RPC の COALESCE と同じく、取れないときは 0 として扱う。
  const discountAmount = order.discount_amount ?? 0;

  const text = [
    greeting(order.shipping_full_name),
    '',
    ...leadLines,
    '',
    `注文番号: ${orderNumber}`,
    '',
    'ご注文内容:',
    ...itemLines,
    '',
    `小計: ${formatCurrency(order.subtotal_amount, order.currency)}`,
    `送料: ${order.shipping_amount > 0 ? formatCurrency(order.shipping_amount, order.currency) : '無料'}`,
    // 値引があるときだけ出す。書き方は注文詳細（/api/orders/[id]）と同じ「-￥1,000」（FREQ-396）
    ...(discountAmount > 0 ? [`割引: -${formatCurrency(discountAmount, order.currency)}`] : []),
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
    '',
    'お届け先:',
    ...shippingLines,
    '',
    contactLine(order.id),
    '',
    SHOP_NAME,
  ].join('\n');

  return { subject, text };
}

function composeExpired(material: OrderEmailMaterial): ComposedOrderEmail {
  const { order } = material;
  return {
    subject: `【${SHOP_NAME}】お支払い期限切れのお知らせ（${toOrderNumber(order.id)}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'お支払い期限が過ぎたため、ご注文を取り消しました。',
      'お支払いは発生していません。引き続きご購入を希望される場合は、あらためてご注文ください。',
      '',
      ...orderSummaryLines(material),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

function composeCanceled(material: OrderEmailMaterial, previousStatus: 'payment_in_progress' | 'pending'): ComposedOrderEmail {
  const { order } = material;
  const lead =
    previousStatus === 'payment_in_progress'
      ? 'お手続き中のご注文を取り消しました。'
      : 'お支払い待ちのご注文を取り消しました。';
  return {
    subject: `【${SHOP_NAME}】ご注文取消のお知らせ（${toOrderNumber(order.id)}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      lead,
      'お支払いは発生していません。',
      '',
      ...orderSummaryLines(material),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

function isShippingCarrierId(value: unknown): value is ShippingCarrierId {
  return typeof value === 'string' && (SHIPPING_CARRIER_IDS as readonly string[]).includes(value);
}

/** 配送業者か伝票番号が無ければ作らない（送れない材料の不足） */
function composeShipped({ order }: OrderEmailMaterial): ComposedOrderEmail | null {
  const trackingNumber = order.tracking_number?.trim();
  if (!isShippingCarrierId(order.shipping_carrier) || !trackingNumber) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  const carrier = SHIPPING_CARRIERS[order.shipping_carrier];
  return {
    subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'ご注文の商品を発送いたしました。',
      '',
      `注文番号: ${orderNumber}`,
      '',
      `配送業者: ${carrier.label}`,
      `追跡番号: ${trackingNumber}`,
      `追跡はこちら: ${carrier.trackingUrl(trackingNumber)}`,
      '',
      '※ 追跡情報は反映までに数時間かかる場合があります。',
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/** 件名と本文を作る。材料が足りなければ null */
export function composeOrderEmail(material: OrderEmailMaterial, request: ComposeRequest): ComposedOrderEmail | null {
  switch (request.kind) {
    case 'awaiting_payment':
      return composeConfirmation(material, 'awaiting_payment', AWAITING_LEAD);
    case 'paid':
      return composeConfirmation(
        material,
        'paid',
        request.variant === 'payment_received_after_expiry' && request.paymentExpiredSent ? PAID_AFTER_EXPIRY_LEAD : PAID_LEAD,
      );
    case 'payment_expired':
      return composeExpired(material);
    case 'canceled':
      return composeCanceled(material, request.variant === 'payment_in_progress' ? 'payment_in_progress' : 'pending');
    case 'shipped':
      return composeShipped(material);
  }
}
```

- [ ] **Step 5: 送る部品の試験を書く**

`tests/unit/lib/orders/email/order-email-sender.test.ts`:

```ts
const mockResendSend = jest.fn();
const mockResendConstructor = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation((key: string) => {
    mockResendConstructor(key);
    return { emails: { send: (...args: unknown[]) => mockResendSend(...args) } };
  }),
}));

const mockLocalSend = jest.fn();
jest.mock('@/lib/mail/adapters/local', () => ({
  sendMail: (...args: unknown[]) => mockLocalSend(...args),
}));

import {
  checkOrderEmailSendConfig,
  classifyResendError,
  parseRetryAfter,
  sendOrderEmailMessage,
} from '@/lib/orders/email/order-email-sender';

const MESSAGE = { to: 'hanako@example.com', subject: '件名', text: '本文', idempotencyKey: 'order-email/email-1' };
const RESEND_ENV = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', MAIL_FROM_ADDRESS: 'shop@example.com', RESEND_API_KEY: 're_test_key' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkOrderEmailSendConfig', () => {
  it.each([
    [{ ...RESEND_ENV }, null],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM_ADDRESS: 'shop@example.com' }, null],
    [{ NODE_ENV: 'development', MAIL_FROM_ADDRESS: 'shop@example.com' }, null],
    [{ NODE_ENV: 'production', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'ses', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ ...RESEND_ENV, MAIL_FROM_ADDRESS: '' }, 'config_provider'],
    [{ ...RESEND_ENV, RESEND_API_KEY: '' }, 'config_api_key'],
  ] as const)('%o は %s', (env, expected) => {
    expect(checkOrderEmailSendConfig(env)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  it('秒数を読み、大文字小文字を問わず、1日で打ち切る。読めなければ null', () => {
    expect(parseRetryAfter({ 'retry-after': '30' })).toBe(30);
    expect(parseRetryAfter({ 'Retry-After': '5' })).toBe(5);
    expect(parseRetryAfter({ 'retry-after': '999999' })).toBe(86_400);
    expect(parseRetryAfter({ 'retry-after': 'soon' })).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('classifyResendError（設計書 4-4）', () => {
  it.each([
    [{ name: 'rate_limit_exceeded', statusCode: 429 }, { category: 'transient', code: 'rate_limited', retryAfterSeconds: 2 }],
    [{ name: 'application_error', statusCode: 500 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'internal_server_error', statusCode: 500 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'application_error', statusCode: null }, { category: 'transient', code: 'network_error', retryAfterSeconds: null }],
    [{ name: 'concurrent_idempotent_requests', statusCode: 409 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'some_new_error', statusCode: 503 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'some_new_error', statusCode: 418 }, { category: 'transient', code: 'unexpected_error', retryAfterSeconds: 2 }],
    [{ name: 'missing_api_key', statusCode: 401 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'restricted_api_key', statusCode: 401 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'invalid_api_key', statusCode: 403 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'suspended_api_key', statusCode: 403 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'validation_error', statusCode: 403 }, { category: 'config', code: 'config_sender_domain', retryAfterSeconds: null }],
    [{ name: 'invalid_from_address', statusCode: 422 }, { category: 'config', code: 'config_sender_domain', retryAfterSeconds: null }],
    [{ name: 'daily_quota_exceeded', statusCode: 429 }, { category: 'config', code: 'quota_daily', retryAfterSeconds: null }],
    [{ name: 'monthly_quota_exceeded', statusCode: 429 }, { category: 'config', code: 'quota_monthly', retryAfterSeconds: null }],
    [{ name: 'validation_error', statusCode: 400 }, { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null }],
    [{ name: 'missing_required_field', statusCode: 422 }, { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null }],
    [{ name: 'invalid_idempotent_request', statusCode: 409 }, { category: 'permanent', code: 'idempotency_conflict', retryAfterSeconds: null }],
  ])('%o を %o に分ける', (error, expected) => {
    expect(classifyResendError(error, { 'retry-after': '2' })).toEqual(expected);
  });
});

describe('sendOrderEmailMessage', () => {
  it('Resend へ重複防止キーを付けて送り、メールの番号を返す', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 're_123' }, error: null, headers: {} });

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({ ok: true, providerMessageId: 're_123' });

    expect(mockResendConstructor).toHaveBeenCalledWith('re_test_key');
    expect(mockResendSend).toHaveBeenCalledWith(
      { from: 'shop@example.com', to: 'hanako@example.com', subject: '件名', text: '本文' },
      { idempotencyKey: 'order-email/email-1' },
    );
  });

  it('Resend の断りを分けて返す（待つ時間の指示を読む）', async () => {
    mockResendSend.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' },
      headers: { 'retry-after': '3' },
    });

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({
      ok: false,
      failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 3 },
    });
  });

  it('送る途中で投げられたら通信の失敗としてやり直す', async () => {
    mockResendSend.mockRejectedValue(new Error('socket hang up'));

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({
      ok: false,
      failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null },
    });
  });

  it('手元のメール受けは Mailpit へ送る（メールの番号は持たない）', async () => {
    mockLocalSend.mockResolvedValue({ ID: 'mailpit-1' });
    const env = { NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };

    await expect(sendOrderEmailMessage(MESSAGE, env)).resolves.toEqual({ ok: true, providerMessageId: null });
    expect(mockLocalSend).toHaveBeenCalledWith({ to: 'hanako@example.com', subject: '件名', text: '本文', from: 'no-reply@e2e.test' });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('SES と設定が無いときは送らずに設定の問題を返す', async () => {
    await expect(sendOrderEmailMessage(MESSAGE, { NODE_ENV: 'production', MAIL_FROM_ADDRESS: 'shop@example.com' })).resolves.toEqual({
      ok: false,
      failure: { category: 'config', code: 'config_provider', retryAfterSeconds: null },
    });
    await expect(sendOrderEmailMessage(MESSAGE, { ...RESEND_ENV, RESEND_API_KEY: '' })).resolves.toEqual({
      ok: false,
      failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null },
    });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(mockLocalSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 送る部品を書く**

`src/lib/orders/email/order-email-sender.ts`:

```ts
import { Resend } from 'resend';
import { resolveMailProvider, type MailProvider } from '@/lib/mail';
import { sendMail as sendLocalMail } from '@/lib/mail/adapters/local';
import type {
  OrderEmailErrorCode,
  OrderEmailFailureCategory,
  OrderEmailPauseReason,
} from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールを送る（グループ D 設計書 4-4）。
 * Resend へは行の番号から作った重複防止キーを付ける（同じキーの送り直しは、24時間のうちは2通目にならない）。
 * 重複防止キーの無い送り手（SES）では送らない（OWASP Fail Securely）。E2E と開発は手元のメール受け（local）へ送る。
 */
export type OrderEmailMessage = { to: string; subject: string; text: string; idempotencyKey: string };

export type OrderEmailSendFailure = {
  category: OrderEmailFailureCategory;
  code: OrderEmailErrorCode;
  retryAfterSeconds: number | null;
};

export type OrderEmailSendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; failure: OrderEmailSendFailure };

type Env = Record<string, string | undefined>;

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

const CONFIG_KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key']);

const PERMANENT_ERRORS = new Set([
  'missing_required_field',
  'invalid_parameter',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_region',
  'invalid_access',
  'not_found',
  'method_not_allowed',
  'security_error',
]);

function providerOf(env: Env): MailProvider | null {
  try {
    return resolveMailProvider(env);
  } catch {
    return null;
  }
}

function failure(
  category: OrderEmailFailureCategory,
  code: OrderEmailErrorCode,
  retryAfterSeconds: number | null = null,
): OrderEmailSendFailure {
  return { category, code, retryAfterSeconds };
}

/** 送れる設定か（設計書 4-4・本計画 P8）。送れなければ止める理由を返す */
export function checkOrderEmailSendConfig(env: Env = process.env): OrderEmailPauseReason | null {
  const provider = providerOf(env);
  if (provider !== 'resend' && provider !== 'local') return 'config_provider';
  if (!env.MAIL_FROM_ADDRESS?.trim()) return 'config_provider';
  if (provider === 'resend' && !env.RESEND_API_KEY?.trim()) return 'config_api_key';
  return null;
}

/** 待つ時間の指示（秒）。大文字小文字を問わず読み、1日で打ち切る */
export function parseRetryAfter(headers: Record<string, string> | null | undefined): number | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const seconds = key ? Number.parseInt(headers[key], 10) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Resend の断りを、やり直す・止める・やり直さないに分ける（設計書 4-4） */
export function classifyResendError(
  error: { name?: string | null; statusCode?: number | null },
  headers?: Record<string, string> | null,
): OrderEmailSendFailure {
  const name = error.name ?? '';
  const status = error.statusCode ?? null;
  const retryAfter = parseRetryAfter(headers);

  switch (name) {
    case 'rate_limit_exceeded':
      return failure('transient', 'rate_limited', retryAfter);
    case 'daily_quota_exceeded':
      return failure('config', 'quota_daily');
    case 'monthly_quota_exceeded':
      return failure('config', 'quota_monthly');
    case 'invalid_from_address':
      return failure('config', 'config_sender_domain');
    case 'invalid_idempotent_request':
      return failure('permanent', 'idempotency_conflict');
    case 'concurrent_idempotent_requests':
      return failure('transient', 'provider_unavailable', retryAfter);
    case 'validation_error':
      // 403 は送信元のドメインが確かめられていない（全部のメールに効く）。それ以外はこのメールの形の問題
      return status === 403 ? failure('config', 'config_sender_domain') : failure('permanent', 'invalid_message');
    case 'application_error':
    case 'internal_server_error':
      // SDK は通信の失敗を statusCode の無い application_error にして返す
      return status === null ? failure('transient', 'network_error') : failure('transient', 'provider_unavailable', retryAfter);
  }

  if (CONFIG_KEY_ERRORS.has(name)) return failure('config', 'config_api_key');
  if (PERMANENT_ERRORS.has(name)) return failure('permanent', 'invalid_message');
  if (status !== null && (status === 429 || status >= 500)) return failure('transient', 'provider_unavailable', retryAfter);
  return failure('transient', 'unexpected_error', retryAfter);
}

/** 1通送る。例外は投げず、結果を返す */
export async function sendOrderEmailMessage(message: OrderEmailMessage, env: Env = process.env): Promise<OrderEmailSendOutcome> {
  const configError = checkOrderEmailSendConfig(env);
  if (configError) {
    return { ok: false, failure: failure('config', configError) };
  }

  if (providerOf(env) === 'local') {
    try {
      await sendLocalMail({ to: message.to, subject: message.subject, text: message.text, from: env.MAIL_FROM_ADDRESS });
      return { ok: true, providerMessageId: null };
    } catch {
      return { ok: false, failure: failure('transient', 'network_error') };
    }
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const response = await resend.emails.send(
      { from: env.MAIL_FROM_ADDRESS as string, to: message.to, subject: message.subject, text: message.text },
      { idempotencyKey: message.idempotencyKey },
    );
    if (response.error) {
      return { ok: false, failure: classifyResendError(response.error, response.headers) };
    }
    return { ok: true, providerMessageId: response.data?.id ?? null };
  } catch {
    return { ok: false, failure: failure('transient', 'network_error') };
  }
}
```

`resend.emails.send` の第1引数の型が合わなければ、今の `src/lib/mail/adapters/resend.ts` と同じく `as CreateEmailOptions` を付ける（中身は変えない）。

- [ ] **Step 7: DB の関数を呼ぶ部品と worker の試験を書く**

`tests/unit/lib/orders/email/order-email-store.test.ts`:

```ts
import {
  claimOrderEmail,
  failOrderEmail,
  getOrderEmailSendState,
  OrderEmailStoreError,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

function storeReturning(data: unknown, error: { message?: string; code?: string } | null = null) {
  const rpc = jest.fn(async () => ({ data, error }));
  return { store: { rpc } as unknown as OrderEmailStore, rpc };
}

describe('order-email-store', () => {
  it('取り出した行を名前を変えて返す。無ければ null', async () => {
    const { store, rpc } = storeReturning([{
      email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false,
    }]);

    await expect(claimOrderEmail(store, 300)).resolves.toEqual({
      id: 'email-1', orderId: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      leaseToken: 'lease-1', subject: null, bodyText: null, paymentExpiredSent: false,
    });
    expect(rpc).toHaveBeenCalledWith('claim_order_email', { _lease_seconds: 300 });
    await expect(claimOrderEmail(storeReturning([]).store, 300)).resolves.toBeNull();
  });

  it('失敗の記録に分け方・原因・待つ時間を渡す', async () => {
    const { store, rpc } = storeReturning('retry_wait');
    const claim = { id: 'email-1', leaseToken: 'lease-1' };

    await expect(failOrderEmail(store, claim, { category: 'transient', code: 'rate_limited', retryAfterSeconds: 3 })).resolves.toBe('retry_wait');
    expect(rpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'rate_limited', _category: 'transient', _retry_after_seconds: 3,
    });
  });

  it('一時停止の状態を日付に直す', async () => {
    const { store } = storeReturning([{ paused: true, reason: 'quota_daily', paused_at: '2026-10-09T01:00:00Z', next_probe_at: '2026-10-10T00:00:00Z' }]);

    await expect(getOrderEmailSendState(store)).resolves.toEqual({
      paused: true, reason: 'quota_daily', pausedAt: new Date('2026-10-09T01:00:00Z'), nextProbeAt: new Date('2026-10-10T00:00:00Z'),
    });
  });

  it('DB の失敗は OrderEmailStoreError にし、記号だけ持つ', async () => {
    const { store } = storeReturning(null, { message: 'connection refused', code: '08006' });

    await expect(claimOrderEmail(store, 300)).rejects.toMatchObject({ name: 'OrderEmailStoreError', operation: 'claim_order_email', code: '08006' });
    await expect(claimOrderEmail(store, 300)).rejects.toBeInstanceOf(OrderEmailStoreError);
  });
});
```

`tests/unit/lib/orders/email/order-email-worker.test.ts`:

```ts
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { processOrderEmails, skipReasonFor, type OrderEmailWorkerDeps } from '@/lib/orders/email/order-email-worker';
import { OrderEmailMaterialError, type OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import type { OrderEmailStore } from '@/lib/orders/email/order-email-store';
import type { OrderEmailSendOutcome } from '@/lib/orders/email/order-email-sender';

type QueueRow = {
  email_id: string; order_id: string; kind: string; variant: string | null; origin: string; attempts: number;
  lease_token: string; subject: string | null; body_text: string | null; payment_expired_sent: boolean;
};

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
    lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, ...overrides,
  };
}

function material(overrides: Partial<OrderEmailMaterial['order']> = {}): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
      subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
      shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
      shipping_building: null, shipping_phone: '0311112222', review_reason: null, shipping_carrier: null, tracking_number: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
  };
}

/** DB の関数をまねる。取り出しは queue から1行ずつ返す */
function harness(queue: QueueRow[], options: {
  material?: OrderEmailMaterial | null | Error;
  send?: OrderEmailSendOutcome[];
  saveResult?: boolean;
  failOn?: string;
  config?: OrderEmailWorkerDeps['checkConfig'];
  clock?: number[];
} = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const pending = [...queue];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (options.failOn === name) return { data: null, error: { message: 'db down', code: '08006' } };
    switch (name) {
      case 'claim_order_email':
        return { data: pending.length > 0 ? [pending.shift()] : [], error: null };
      case 'save_order_email_content':
        return { data: options.saveResult ?? true, error: null };
      case 'complete_order_email':
      case 'skip_order_email':
        return { data: true, error: null };
      case 'fail_order_email':
        return { data: params?._category === 'permanent' ? 'dead' : 'retry_wait', error: null };
      case 'pause_order_email_sending':
        return { data: true, error: null };
      default:
        return { data: null, error: null };
    }
  });
  const outcomes = [...(options.send ?? [{ ok: true, providerMessageId: 're_1' } as const])];
  const send = jest.fn(async () => outcomes.shift() ?? ({ ok: true, providerMessageId: 're_next' } as const));
  const loadMaterial = jest.fn(async () => {
    const value = options.material === undefined ? material() : options.material;
    if (value instanceof Error) throw value;
    return value;
  });
  const times = [...(options.clock ?? [])];
  const deps: OrderEmailWorkerDeps = {
    store: { rpc } as unknown as OrderEmailStore,
    loadMaterial,
    send,
    checkConfig: options.config ?? (() => null),
    now: () => (times.length > 0 ? (times.shift() as number) : 0),
    budgetMs: 10_000,
  };
  return { deps, calls, send, loadMaterial };
}

const names = (calls: Array<{ name: string }>) => calls.map((call) => call.name);

describe('processOrderEmails', () => {
  it('中身を作って送る前に控え、行の番号の重複防止キーで送り、送信済みにする', async () => {
    const h = harness([row()]);

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(names(h.calls)).toEqual(['claim_order_email', 'save_order_email_content', 'complete_order_email', 'claim_order_email']);
    const saved = h.calls[1].params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご注文ありがとうございます（ORD-ORDER-1）');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
    expect(h.calls[2].params).toEqual({ _email_id: 'email-1', _lease_token: 'lease-1', _provider_message_id: 're_1' });
  });

  it('控えがあれば作り直さず、控えた中身を同じ鍵で送る（送れた直後に落ちた後のやり直し）', async () => {
    const h = harness([row({ attempts: 2, subject: '控えた件名', body_text: '控えた本文' })]);

    await processOrderEmails(h.deps);

    expect(names(h.calls)).not.toContain('save_order_email_content');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: '控えた件名', text: '控えた本文', idempotencyKey: 'order-email/email-1',
    });
  });

  it('入金待ちは、注文がもう入金待ちでなければ取りやめにし、送らない', async () => {
    const h = harness([row({ kind: 'awaiting_payment', variant: null })], { material: material({ status: 'paid' }) });

    const result = await processOrderEmails(h.deps);

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'superseded',
    });
  });

  it('宛先が無ければ取りやめにする', async () => {
    const h = harness([row()], { material: material({ shipping_email: '  ' }) });

    await processOrderEmails(h.deps);

    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'no_recipient' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('注文や明細が無い・発送の伝票番号が無いときは、すぐ送れなかったにする', async () => {
    const missing = harness([row()], { material: null });
    await processOrderEmails(missing.deps);
    expect(missing.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });

    const shipped = harness([row({ kind: 'shipped', variant: null })], { material: material({ status: 'shipped' }) });
    await processOrderEmails(shipped.deps);
    expect(shipped.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(shipped.send).not.toHaveBeenCalled();
  });

  it('材料を読めないときと、中身を控えられないときは、送らずにやり直す', async () => {
    const unreadable = harness([row()], { material: new OrderEmailMaterialError('orders') });
    await processOrderEmails(unreadable.deps);
    expect(unreadable.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });

    const unsaved = harness([row()], { failOn: 'save_order_email_content' });
    await processOrderEmails(unsaved.deps);
    expect(unsaved.send).not.toHaveBeenCalled();
    expect(unsaved.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });
  });

  it('担当を失っていて控えられなければ、送らず何も書かない', async () => {
    const h = harness([row()], { saveResult: false });

    const result = await processOrderEmails(h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('fail_order_email');
    expect(result.failed).toBe(1);
  });

  it('一時的な失敗は待つ時間の指示を渡してやり直し、次の行へ進む', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [
        { ok: false, failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 2 } },
        { ok: true, providerMessageId: 're_2' },
      ],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, stoppedBy: 'empty' });
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'rate_limited', _category: 'transient', _retry_after_seconds: 2,
    });
  });

  it('設定の問題では止めて、残りを取り出さない', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [{ ok: false, failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null } }],
    });

    const result = await processOrderEmails(h.deps);

    expect(result.stoppedBy).toBe('paused');
    expect(names(h.calls).filter((name) => name === 'claim_order_email')).toHaveLength(1);
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({ _category: 'config', _error_code: 'config_api_key' });
  });

  it('送る前に設定が足りなければ、止めて取り出さない', async () => {
    const h = harness([row()], { config: () => 'config_provider' });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'paused' });
    expect(names(h.calls)).toEqual(['pause_order_email_sending']);
    expect(h.calls[0].params).toEqual({ _reason: 'config_provider' });
  });

  it('取り出しに失敗したら止める', async () => {
    const h = harness([row()], { failOn: 'claim_order_email' });

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ stoppedBy: 'claim_error' });
  });

  it('時間の予算を使い切ったら止める', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      clock: [0, 0, 10_001],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'budget' });
  });

  it('送信済みの記録に失敗しても止めない（担当の期限の後に、同じ鍵で送り直す）', async () => {
    const h = harness([row()], { failOn: 'complete_order_email' });

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });
  });
});

describe('skipReasonFor（設計書 4-1）', () => {
  const claim = (kind: string) => ({ kind } as never);

  it.each([
    ['awaiting_payment', 'pending', null],
    ['awaiting_payment', 'paid', 'superseded'],
    ['awaiting_payment', 'failed', 'superseded'],
    ['payment_expired', 'failed', null],
    ['payment_expired', 'cancelled', null],
    ['payment_expired', 'paid', 'superseded'],
    ['payment_expired', 'shipped', 'superseded'],
    ['paid', 'shipped', null],
    ['canceled', 'cancelled', null],
    ['shipped', 'shipped', null],
  ])('%s のメールは、注文が %s なら %s', (kind, status, expected) => {
    expect(skipReasonFor(claim(kind), material({ status: status as never }))).toBe(expected);
  });
});
```

注文番号は `toOrderNumber('order-1')` で `ORD-ORDER-1` になる（先頭8文字の大文字）。

`tests/unit/lib/orders/email/order-email-schedule.test.ts`:

```ts
const mockAfter = jest.fn();
jest.mock('next/server', () => ({ after: (...args: unknown[]) => mockAfter(...args) }));
const mockRun = jest.fn();
jest.mock('@/lib/orders/email/order-email-worker', () => ({
  runOrderEmailWorker: (...args: unknown[]) => mockRun(...args),
}));

import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';

describe('scheduleOrderEmailDelivery', () => {
  beforeEach(() => jest.clearAllMocks());

  it('返事の後に worker を1回動かす。失敗はログだけにする', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    scheduleOrderEmailDelivery();
    await (mockAfter.mock.calls[0][0] as () => Promise<void>)();

    expect(mockRun).toHaveBeenCalledWith();
    expect(error).toHaveBeenCalledWith('[order-email] inline worker run failed', 'Error');
    error.mockRestore();
  });

  it('リクエストの外（after が使えない）では投げずに、毎分の定期処理に任せる', () => {
    mockAfter.mockImplementation(() => {
      throw new Error('after() was called outside a request scope');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => scheduleOrderEmailDelivery()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[order-email] inline delivery was not scheduled', 'Error');
    warn.mockRestore();
  });
});
```

- [ ] **Step 8: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/orders/email --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/email/order-email-sender'` など）

- [ ] **Step 9: DB の関数を呼ぶ部品を書く**

`src/lib/orders/email/order-email-store.ts`:

```ts
import type {
  OrderEmailErrorCode,
  OrderEmailFailureCategory,
  OrderEmailKind,
  OrderEmailPauseReason,
  OrderEmailSkipReason,
  OrderEmailStatus,
  OrderEmailVariant,
} from '@/lib/orders/email/order-email-types';
import { isOrderEmailErrorCode } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの表を DB の関数で読み書きする（グループ D 設計書 7-2）。
 * 表は service_role からも直接は触れない（関数だけ）。失敗は OrderEmailStoreError にし、DB の文は残さない。
 */
type QueryError = { message?: string; code?: string } | null;

export type OrderEmailRpcName =
  | 'claim_order_email'
  | 'save_order_email_content'
  | 'complete_order_email'
  | 'fail_order_email'
  | 'skip_order_email'
  | 'pause_order_email_sending'
  | 'get_order_email_send_state';

export type OrderEmailStore = {
  rpc(name: OrderEmailRpcName, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: QueryError }>;
};

export class OrderEmailStoreError extends Error {
  readonly code: string | null;

  constructor(
    readonly operation: OrderEmailRpcName,
    error: QueryError,
  ) {
    super(`order email store failed: ${operation}`);
    this.name = 'OrderEmailStoreError';
    this.code = error?.code ?? null;
  }
}

export type ClaimedOrderEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  origin: 'auto' | 'manual';
  attempts: number;
  leaseToken: string;
  subject: string | null;
  bodyText: string | null;
  paymentExpiredSent: boolean;
};

export type OrderEmailLease = Pick<ClaimedOrderEmail, 'id' | 'leaseToken'>;

export type OrderEmailSendState = {
  paused: boolean;
  reason: OrderEmailErrorCode | null;
  pausedAt: Date | null;
  nextProbeAt: Date | null;
};

export async function callOrderEmailRpc(
  store: OrderEmailStore,
  name: OrderEmailRpcName,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await store.rpc(name, params);
  if (error) throw new OrderEmailStoreError(name, error);
  return data;
}

export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export async function claimOrderEmail(store: OrderEmailStore, leaseSeconds: number): Promise<ClaimedOrderEmail | null> {
  const row = rowsOf(await callOrderEmailRpc(store, 'claim_order_email', { _lease_seconds: leaseSeconds }))[0];
  if (!row) return null;
  return {
    id: String(row.email_id),
    orderId: String(row.order_id),
    kind: row.kind as OrderEmailKind,
    variant: textOrNull(row.variant) as OrderEmailVariant | null,
    origin: row.origin === 'manual' ? 'manual' : 'auto',
    attempts: Number(row.attempts),
    leaseToken: String(row.lease_token),
    subject: textOrNull(row.subject),
    bodyText: textOrNull(row.body_text),
    paymentExpiredSent: row.payment_expired_sent === true,
  };
}

export async function saveOrderEmailContent(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  content: { subject: string; text: string },
): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'save_order_email_content', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _subject: content.subject,
    _body_text: content.text,
  });
  return data === true;
}

export async function completeOrderEmail(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  providerMessageId: string | null,
): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'complete_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _provider_message_id: providerMessageId,
  });
  return data === true;
}

export async function failOrderEmail(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  failure: { category: OrderEmailFailureCategory; code: OrderEmailErrorCode; retryAfterSeconds: number | null },
): Promise<OrderEmailStatus | null> {
  const data = await callOrderEmailRpc(store, 'fail_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _error_code: failure.code,
    _category: failure.category,
    _retry_after_seconds: failure.retryAfterSeconds,
  });
  return textOrNull(data) as OrderEmailStatus | null;
}

export async function skipOrderEmail(store: OrderEmailStore, lease: OrderEmailLease, reason: OrderEmailSkipReason): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'skip_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _reason: reason,
  });
  return data === true;
}

export async function pauseOrderEmailSending(store: OrderEmailStore, reason: OrderEmailPauseReason): Promise<boolean> {
  return (await callOrderEmailRpc(store, 'pause_order_email_sending', { _reason: reason })) === true;
}

export async function getOrderEmailSendState(store: OrderEmailStore): Promise<OrderEmailSendState> {
  const row = rowsOf(await callOrderEmailRpc(store, 'get_order_email_send_state'))[0];
  return {
    paused: row?.paused === true,
    reason: isOrderEmailErrorCode(row?.reason) ? row.reason : null,
    pausedAt: dateOrNull(row?.paused_at),
    nextProbeAt: dateOrNull(row?.next_probe_at),
  };
}
```

- [ ] **Step 10: worker と予定を書く**

`src/lib/orders/email/order-email-worker.ts`:

```ts
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';
import {
  checkOrderEmailSendConfig,
  sendOrderEmailMessage,
  type OrderEmailMessage,
  type OrderEmailSendFailure,
  type OrderEmailSendOutcome,
} from '@/lib/orders/email/order-email-sender';
import {
  claimOrderEmail,
  completeOrderEmail,
  failOrderEmail,
  pauseOrderEmailSending,
  saveOrderEmailContent,
  skipOrderEmail,
  type ClaimedOrderEmail,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import type { OrderEmailPauseReason, OrderEmailSkipReason } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの worker（グループ D 設計書 4 章）。
 * 1行ずつ担当の印を付けて取り出し、取りやめを判定し、最初の時だけ中身を作って控えてから送る。
 * 毎分の定期処理（Stripe の知らせの worker の続き）と、行を書いた窓口の after() から動く。
 */
export const ORDER_EMAIL_WORKER_BUDGET_MS = 10_000;
export const ORDER_EMAIL_LEASE_SECONDS = 300;

export type OrderEmailWorkerDeps = {
  store: OrderEmailStore;
  loadMaterial: (orderId: string) => Promise<OrderEmailMaterial | null>;
  send: (message: OrderEmailMessage) => Promise<OrderEmailSendOutcome>;
  checkConfig: () => OrderEmailPauseReason | null;
  now: () => number;
  budgetMs: number;
};

export type OrderEmailWorkerResult = {
  sent: number;
  skipped: number;
  failed: number;
  stoppedBy: 'empty' | 'budget' | 'paused' | 'claim_error';
};

type DeliverOutcome = 'sent' | 'skipped' | 'failed' | 'paused';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** 送る前に取りやめにする理由（設計書 4-1）。送ってよければ null */
export function skipReasonFor(
  claim: Pick<ClaimedOrderEmail, 'kind'>,
  material: OrderEmailMaterial,
): OrderEmailSkipReason | null {
  if (!material.order.shipping_email?.trim()) return 'no_recipient';
  if (claim.kind === 'awaiting_payment' && material.order.status !== 'pending') return 'superseded';
  if (claim.kind === 'payment_expired' && (material.order.status === 'paid' || material.order.status === 'shipped')) {
    return 'superseded';
  }
  return null;
}

async function recordFailure(
  deps: OrderEmailWorkerDeps,
  claim: ClaimedOrderEmail,
  failure: OrderEmailSendFailure,
): Promise<DeliverOutcome> {
  try {
    await failOrderEmail(deps.store, claim, failure);
  } catch (error) {
    // 記録できなくても、担当の期限が切れた後に1回の失敗として数え直される
    console.error('[order-email-worker] failed to record failure', claim.id, failure.code, errorName(error));
  }
  return failure.category === 'config' ? 'paused' : 'failed';
}

async function deliver(deps: OrderEmailWorkerDeps, claim: ClaimedOrderEmail): Promise<DeliverOutcome> {
  let material: OrderEmailMaterial | null;
  try {
    material = await deps.loadMaterial(claim.orderId);
  } catch {
    return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
  }
  if (!material) {
    return recordFailure(deps, claim, { category: 'permanent', code: 'source_missing', retryAfterSeconds: null });
  }

  const skip = skipReasonFor(claim, material);
  if (skip) {
    try {
      await skipOrderEmail(deps.store, claim, skip);
    } catch (error) {
      console.error('[order-email-worker] failed to record skip', claim.id, skip, errorName(error));
    }
    return 'skipped';
  }

  let content = claim.subject !== null && claim.bodyText !== null ? { subject: claim.subject, text: claim.bodyText } : null;
  if (!content) {
    const composed = composeOrderEmail(material, {
      kind: claim.kind,
      variant: claim.variant,
      paymentExpiredSent: claim.paymentExpiredSent,
    });
    if (!composed) {
      return recordFailure(deps, claim, { category: 'permanent', code: 'source_missing', retryAfterSeconds: null });
    }
    // 控えられないまま送ると、やり直しの中身が変わって重複防止キーが使えなくなる。送らずにやり直す
    let saved: boolean;
    try {
      saved = await saveOrderEmailContent(deps.store, claim, composed);
    } catch {
      return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
    }
    if (!saved) {
      // 担当の期限が切れて、別の worker が取り直した。こちらは送らない
      return 'failed';
    }
    content = composed;
  }

  const outcome = await deps.send({
    to: (material.order.shipping_email as string).trim(),
    subject: content.subject,
    text: content.text,
    idempotencyKey: `order-email/${claim.id}`,
  });
  if (!outcome.ok) {
    return recordFailure(deps, claim, outcome.failure);
  }

  try {
    await completeOrderEmail(deps.store, claim, outcome.providerMessageId);
  } catch (error) {
    // 送れている。担当の期限の後に同じ中身・同じ鍵で送り直し、Resend が2通目を送らずに受け付けを返す
    console.error('[order-email-worker] failed to record sent', claim.id, errorName(error));
  }
  return 'sent';
}

export async function processOrderEmails(deps: OrderEmailWorkerDeps): Promise<OrderEmailWorkerResult> {
  const startedAt = deps.now();
  const result: OrderEmailWorkerResult = { sent: 0, skipped: 0, failed: 0, stoppedBy: 'budget' };

  const configError = deps.checkConfig();
  if (configError) {
    try {
      await pauseOrderEmailSending(deps.store, configError);
    } catch (error) {
      console.error('[order-email-worker] failed to pause sending', configError, errorName(error));
    }
    return { ...result, stoppedBy: 'paused' };
  }

  while (deps.now() - startedAt < deps.budgetMs) {
    let claim: ClaimedOrderEmail | null;
    try {
      claim = await claimOrderEmail(deps.store, ORDER_EMAIL_LEASE_SECONDS);
    } catch (error) {
      console.error('[order-email-worker] claim failed', errorName(error));
      return { ...result, stoppedBy: 'claim_error' };
    }
    if (!claim) return { ...result, stoppedBy: 'empty' };

    const outcome = await deliver(deps, claim);
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else result.failed += 1;
    if (outcome === 'paused') return { ...result, stoppedBy: 'paused' };
  }

  return result;
}

/** 本物の依存で1回動かす */
export async function runOrderEmailWorker(options: { budgetMs?: number } = {}): Promise<OrderEmailWorkerResult> {
  const client = await createServiceRoleClient();
  return processOrderEmails({
    store: client as unknown as OrderEmailStore,
    loadMaterial: (orderId) => loadOrderEmailMaterial(client, orderId),
    send: (message) => sendOrderEmailMessage(message),
    checkConfig: () => checkOrderEmailSendConfig(),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? ORDER_EMAIL_WORKER_BUDGET_MS,
  });
}
```

`src/lib/orders/email/order-email-schedule.ts`:

```ts
import { after } from 'next/server';
import { runOrderEmailWorker } from '@/lib/orders/email/order-email-worker';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 行を書いた窓口の返事の後に、注文のメールの worker を1回動かす（設計書 4-7）。ふだんは数秒で届く。
 * 動かせなくても、毎分の定期処理が送る。
 */
export function scheduleOrderEmailDelivery(): void {
  try {
    after(() =>
      runOrderEmailWorker().then(
        () => undefined,
        (error: unknown) => {
          console.error('[order-email] inline worker run failed', errorName(error));
        },
      ),
    );
  } catch (error) {
    // after() はリクエストの外（試験や定期処理の外の呼び出し）では使えない
    console.warn('[order-email] inline delivery was not scheduled', errorName(error));
  }
}
```

- [ ] **Step 11: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/orders/email --runInBand`
Expected: PASS
Run: `npm run typecheck` と `npx eslint src/lib/orders/email tests/unit/lib/orders/email`
Expected: エラー0件

- [ ] **Step 12: コミット（controller）**

```bash
git add src/lib/orders/email/order-email-types.ts src/lib/orders/email/order-email-compose.ts src/lib/orders/email/order-email-sender.ts src/lib/orders/email/order-email-store.ts src/lib/orders/email/order-email-worker.ts src/lib/orders/email/order-email-schedule.ts tests/unit/lib/orders/email
git commit -m "feat(orders): 注文のメールの中身を作って送る worker を足す（グループ D）"
```

---

### Task 3: 状態を変える関数が行を書き、直接の送信をやめる（移行 B とつなぎ替え）

**Files:**
- Create: `supabase/migrations/20261009095736_order_email_enqueue.sql`
- Create: `tests/integration/db/order_email_enqueue.integration.test.ts`
- Delete: `tests/integration/db/order_email_claims.integration.test.ts`（消す送信権の関数を試している）
- Modify: `tests/integration/db/mark_order_payment.integration.test.ts`・`place_order_shown_stock.integration.test.ts`・`order_state_transition_hardening.integration.test.ts`・`payment_exceptions.integration.test.ts`・`reconciler_composed.integration.test.ts`・`reconciler_postgrest.integration.test.ts`
- Modify: `src/lib/stripe/checkout-payment-reconciler.ts`・`src/lib/stripe/checkout-payment-reconciler-deps.ts`
- Modify: `src/lib/orders/order-confirmation-email.ts`・`src/lib/orders/order-lifecycle-emails.ts`
- Delete: `src/lib/orders/order-shipped-email.ts`・`tests/unit/lib/orders/order-shipped-email.test.ts`
- Modify: `src/app/api/admin/orders/[id]/status/route.ts`・`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`
- Modify: `tests/unit/lib/stripe/checkout-payment-reconciler.test.ts`・`tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts`・`tests/unit/api/admin/order-status-shipped.test.ts`・`tests/unit/api/admin/order-attention-route.test.ts`・`tests/unit/lib/orders/order-confirmation-email.test.ts`・`tests/unit/lib/orders/order-lifecycle-emails.test.ts`

**Interfaces:**
- Consumes: Task 1 の `private.enqueue_order_email(uuid, text, text)`、Task 2 の `greeting`（`order-email-compose.ts`）
- Produces:
  - `public.mark_order_paid(_order_id uuid, _expected_status public.order_status, _payment_intent_id text, _paid_amount integer, _paid_currency text, _notify_customer boolean, _paid_email_variant text, _source_event_id text DEFAULT NULL)`（戻り値は今と同じ。`_notify_customer`・`_paid_email_variant` は NULL を断る。金額が合い `_notify_customer` が true なら `paid` の行を書く）
  - `public.mark_order_awaiting_payment(uuid, text, text)`（引数は今と同じ。状態を変えたら `awaiting_payment` の行を書く）
  - `public.release_stock_for_unpaid_order(...)`（引数は今と同じ。失敗にしたら `payment_expired`、取消で `_notify_customer` が true なら `canceled`（書き分けは取り消す前の状態）の行を書く。`resolve_payment_exception` の取消もこの関数を通る）
  - `public.admin_ship_paid_order(_order_id uuid, _actor_id uuid, _shipping_carrier text, _tracking_number text, _notify_customer boolean) RETURNS TABLE (id uuid)`（`_notify_customer` は NULL を断る。true なら `shipped` の行を書く）
  - `ReconcilerDatabase.markOrderPaid(args)` の args に `notifyCustomer: boolean`・`paidEmailVariant: PaidEmailVariant` を足す。`ReconcilerMailer` は `sendUnplacedPaymentNotice`・`sendShopAlert` の2つだけ。`createReconcilerMailer()` は引数なし
  - 発送の窓口（`POST /api/admin/orders/[id]/status`、`status: 'shipped'`）は `notifyCustomer: boolean`（既定 true）を受ける
  - 消す物: `private.order_emails`・`claim_order_email`・`release_order_email`・`private.suppress_legacy_unpaid_order_emails`、`sendOrderConfirmationEmail`・`sendOrderConfirmationEmailForOrderId`・`claimOrderEmail`・`releaseOrderEmail`・`fetchOrderEmailSource`・`OrderEmailClaimStore`・`OrderEmailKind`（`order-confirmation-email.ts` のもの）・`sendPaymentExpiredEmail`・`sendOrderCanceledEmail`・`sendOrderShippedEmail`

- [ ] **Step 1: 結合テストを書く**

`tests/integration/db/order_email_enqueue.integration.test.ts`:

```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithStockLine, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 注文の状態を変える DB の関数が、同じ取引で「注文のメール」の行を書く（グループ D 設計書 3-1・7-3）。
 * 行は注文ごとに確かめるので、ほかの試験の行とは混ざらない。
 */
jest.setTimeout(30000);

async function createActor(db: PgClient): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`order-email-enqueue-${uniqueSuffix()}@example.com`],
  );
  return res.rows[0].id as string;
}

async function createOrder(db: PgClient, status: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const { orderId } = await insertOrderWithStockLine(db, {
    status, itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
  });
  return orderId;
}

async function emailsOf(db: PgClient, orderId: string): Promise<Array<{ kind: string; variant: string | null; origin: string; status: string }>> {
  const res = await db.query(
    'select kind, variant, origin, status from private.order_email_outbox where order_id = $1 order by seq',
    [orderId],
  );
  return res.rows;
}

function markPaid(
  db: PgClient,
  orderId: string,
  expected: string,
  options: { amount?: number; notify?: boolean | null; variant?: string | null } = {},
) {
  return db.query(
    `select updated, amount_matches
     from public.mark_order_paid($1::uuid, $2::public.order_status, $3::text, $4::integer, 'jpy', $5::boolean, $6::text, null)`,
    [orderId, expected, `pi_${uniqueSuffix()}`, options.amount ?? PRICE, options.notify === undefined ? true : options.notify,
      options.variant === undefined ? 'order_confirmed' : options.variant],
  );
}

describeLocalDb('integration: 状態を変える関数が注文のメールの行を書く', (db) => {
  test('入金済みにすると、注文確認の行を書く。2回目は状態が変わらないので書かない', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    expect((await markPaid(db(), orderId, 'payment_in_progress')).rows[0]).toEqual({ updated: true, amount_matches: true });
    expect((await markPaid(db(), orderId, 'payment_in_progress')).rows[0].updated).toBe(false);

    expect(await emailsOf(db(), orderId)).toEqual([{ kind: 'paid', variant: 'order_confirmed', origin: 'auto', status: 'pending' }]);
  });

  test('取引を取り消すと、状態の変更と一緒に行も残らない', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    await db().query('begin');
    await markPaid(db(), orderId, 'payment_in_progress');
    await db().query('rollback');

    expect(await emailsOf(db(), orderId)).toEqual([]);
  });

  test('金額が違う・お客様に送らない（全額返金済み）ときは書かない', async () => {
    const mismatch = await createOrder(db(), 'payment_in_progress');
    const refunded = await createOrder(db(), 'payment_in_progress');

    await markPaid(db(), mismatch, 'payment_in_progress', { amount: PRICE - 1 });
    await markPaid(db(), refunded, 'payment_in_progress', { notify: false });

    expect(await emailsOf(db(), mismatch)).toEqual([]);
    expect(await emailsOf(db(), refunded)).toEqual([]);
  });

  test('「送るか」と書き分けは省けない。知らない書き分けは断る', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');
    await expect(markPaid(db(), orderId, 'payment_in_progress', { notify: null })).rejects.toMatchObject({ code: '22023' });
    await expect(markPaid(db(), orderId, 'payment_in_progress', { variant: null })).rejects.toMatchObject({ code: '22023' });
    await expect(markPaid(db(), orderId, 'payment_in_progress', { variant: 'refund' })).rejects.toMatchObject({ code: '22023' });
    await expect(
      db().query("select * from public.mark_order_paid($1::uuid, 'payment_in_progress', 'pi_x', 5000, 'jpy', 'evt_x')", [orderId]),
    ).rejects.toMatchObject({ code: '42883' });
  });

  test('期限切れの後の入金は、その書き分けで書く', async () => {
    const orderId = await createOrder(db(), 'failed');

    await markPaid(db(), orderId, 'failed', { variant: 'payment_received_after_expiry' });

    expect(await emailsOf(db(), orderId)).toEqual([
      { kind: 'paid', variant: 'payment_received_after_expiry', origin: 'auto', status: 'pending' },
    ]);
  });

  test('入金待ちにすると入金待ちの行を書く', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    await db().query('select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, null)', [orderId, `pi_${uniqueSuffix()}`]);

    expect(await emailsOf(db(), orderId)).toEqual([{ kind: 'awaiting_payment', variant: null, origin: 'auto', status: 'pending' }]);
  });

  test('期限切れで失敗にすると期限切れの行を書く。放棄では書かない', async () => {
    const expired = await createOrder(db(), 'pending');
    const abandoned = await createOrder(db(), 'payment_in_progress');

    await db().query("select released from public.release_stock_for_unpaid_order($1, 'pending', 'failed', 'stripe_voucher_expired')", [expired]);
    await db().query("select released from public.release_stock_for_unpaid_order($1, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')", [abandoned]);

    expect(await emailsOf(db(), expired)).toEqual([{ kind: 'payment_expired', variant: null, origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), abandoned)).toEqual([]);
  });

  test.each([
    ['payment_in_progress', true, [{ kind: 'canceled', variant: 'payment_in_progress', origin: 'auto', status: 'pending' }]],
    ['pending', true, [{ kind: 'canceled', variant: 'pending', origin: 'auto', status: 'pending' }]],
    ['pending', false, []],
  ])('%s の注文の取消は、知らせる(%s)時だけ前の状態の書き分けで書く', async (from, notify, expected) => {
    const actor = await createActor(db());
    const orderId = await createOrder(db(), from);

    await db().query(
      `select released from public.release_stock_for_unpaid_order($1, $2::public.order_status, 'cancelled', 'admin_cancel', $3, null, 'customer_request', null, $4)`,
      [orderId, from, actor, notify],
    );

    expect(await emailsOf(db(), orderId)).toEqual(expected);
  });

  test('要対応の「注文を取り消して解決」も、知らせる時だけ取消の行を書く', async () => {
    const actor = await createActor(db());
    const notified = await createOrder(db(), 'pending');
    const silent = await createOrder(db(), 'pending');

    for (const [orderId, notify] of [[notified, true], [silent, false]] as const) {
      const exception = await db().query(
        `select exception_id from public.record_payment_exception(
           _payment_ref => $1, _reason => 'state_conflict', _detail => null, _checkout_session_id => null,
           _payment_intent_id => null, _draft_id => null, _order_id => $2)`,
        [`cs_enqueue_${uniqueSuffix()}`, orderId],
      );
      await db().query(
        `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, 'お客様の依頼', true, 'customer_request', $3)`,
        [exception.rows[0].exception_id, actor, notify],
      );
    }

    expect(await emailsOf(db(), notified)).toEqual([{ kind: 'canceled', variant: 'pending', origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), silent)).toEqual([]);
  });

  test('発送は「発送のメールを送る」の時だけ行を書き、履歴に配送業者と伝票番号が出る', async () => {
    const actor = await createActor(db());
    const notified = await createOrder(db(), 'paid');
    const silent = await createOrder(db(), 'paid');

    const shipped = await db().query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'TRK-1', true)", [notified, actor]);
    await db().query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'sagawa', 'TRK-2', false)", [silent, actor]);

    expect(shipped.rows).toEqual([{ id: notified }]);
    expect(await emailsOf(db(), notified)).toEqual([{ kind: 'shipped', variant: null, origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), silent)).toEqual([]);
    const history = await db().query('select to_status, shipping_carrier, tracking_number from public.list_order_status_history($1)', [notified]);
    expect(history.rows).toEqual([{ to_status: 'shipped', shipping_carrier: 'yamato', tracking_number: 'TRK-1' }]);
  });

  test('発送の関数は「送るか」を省くと断る', async () => {
    const actor = await createActor(db());
    const orderId = await createOrder(db(), 'paid');

    await expect(
      db().query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'TRK-3', null)", [orderId, actor]),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      db().query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'TRK-3')", [orderId, actor]),
    ).rejects.toMatchObject({ code: '42883' });
  });

  test('古い送信権の表と関数は無い', async () => {
    const res = await db().query(
      `select to_regclass('private.order_emails') as claims,
              to_regprocedure('public.claim_order_email(uuid,text)') as claim,
              to_regprocedure('public.release_order_email(uuid,text)') as release,
              to_regprocedure('private.suppress_legacy_unpaid_order_emails()') as suppress,
              to_regprocedure('public.mark_order_paid(uuid,public.order_status,text,integer,text,text)') as old_mark_paid,
              to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text)') as old_ship`,
    );
    expect(res.rows[0]).toEqual({ claims: null, claim: null, release: null, suppress: null, old_mark_paid: null, old_ship: null });
  });

  test('作り直した関数は anon・authenticated が呼べず、service_role だけが呼べる', async () => {
    const signatures = [
      'public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
      'public.admin_ship_paid_order(uuid,uuid,text,text,boolean)',
    ];
    for (const signature of signatures) {
      const res = await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
        [signature],
      );
      expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる（controller）**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_email_enqueue --runInBand`
Expected: FAIL（`function public.mark_order_paid(uuid, order_status, text, integer, unknown, boolean, text, unknown) does not exist` など）

- [ ] **Step 3: 移行 B を書く**

`supabase/migrations/20261009095736_order_email_enqueue.sql`:

```sql
-- 注文の状態を変える DB の関数が、同じ取引で「注文のメール」の行を書く（グループ D 設計書 3-1・7-3・7-4）。
-- 状態の変更を取り消せば行も残らない（transactional outbox）。アプリはメールを直接送らない。
-- 古い送信権（private.order_emails と claim_order_email・release_order_email）を消す。
-- 本番の古い送信権の行（移行前の未入金の注文の「送らない」印）は、取りやめ（legacy_suppressed）の行として移す（本計画 P9）。
-- 何度当てても同じ結果になるように書く。
BEGIN;

-- 1. 入金済みにする（グループ A 設計書 4-1。中身は今までと同じ）。
--    金額が合い、アプリが「お客様に送る」（全額返金済みでない）を渡した時だけ、注文確認の行を書く
DROP FUNCTION IF EXISTS public.mark_order_paid(uuid, public.order_status, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.mark_order_paid(
  _order_id uuid,
  _expected_status public.order_status,
  _payment_intent_id text,
  _paid_amount integer,
  _paid_currency text,
  _notify_customer boolean,
  _paid_email_variant text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean, amount_matches boolean, needs_review boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  matches boolean;
  missing_reservation boolean;
BEGIN
  IF _order_id IS NULL
     OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL
     OR _paid_amount IS NULL
     OR NULLIF(pg_catalog.btrim(_paid_currency), '') IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'MARK_PAID_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _paid_email_variant IS NULL
     OR _paid_email_variant NOT IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry') THEN
    RAISE EXCEPTION 'INVALID_PAID_EMAIL_VARIANT' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN (
       'payment_in_progress'::public.order_status,
       'pending'::public.order_status,
       'failed'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM _expected_status THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  matches := target.total_amount = _paid_amount
    AND pg_catalog.lower(target.currency) = pg_catalog.lower(_paid_currency);

  -- 在庫扱いで確保中が0の明細（⑤の失敗の後の入金と、確保の記録が無い古い明細）を確保し直す。
  -- バリアントは id の昇順でロックする（受付・在庫を戻す処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 足りるバリアントの明細だけ確保する。同じバリアントの明細は合算して判定する（受付と同じ）。
  WITH lines AS (
    SELECT r.order_item_id, r.variant_id, r.quantity
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  ),
  needed AS (
    SELECT l.variant_id, pg_catalog.sum(l.quantity)::integer AS quantity
    FROM lines AS l
    GROUP BY l.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note)
  SELECT l.variant_id, -l.quantity, 'purchase', _order_id, l.order_item_id, 'reserve_on_paid'
  FROM lines AS l
  WHERE l.variant_id IN (SELECT c.variant_id FROM covered AS c)
  ORDER BY l.variant_id, l.order_item_id;

  SELECT EXISTS (
    SELECT 1
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
  ) INTO missing_reservation;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_paid', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'paid'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      review_reason = CASE WHEN missing_reservation THEN 'stock_not_reserved' ELSE o.review_reason END,
      review_marked_at = CASE WHEN missing_reservation THEN pg_catalog.now() ELSE o.review_marked_at END
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  -- 金額が違う支払いは要対応にし、店が確かめてから連絡する（注文確認は送らない）
  IF matches AND _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'paid', _paid_email_variant);
  END IF;

  RETURN QUERY SELECT true, matches, missing_reservation;
END;
$$;

-- 2. 入金待ちにする（中身は今までと同じ）。状態を変えたら入金待ちの行を書く
CREATE OR REPLACE FUNCTION public.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
BEGIN
  IF _order_id IS NULL OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_AWAITING_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM 'payment_in_progress'::public.order_status THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_awaiting', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'pending'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id)
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  PERFORM private.enqueue_order_email(_order_id, 'awaiting_payment', NULL);

  RETURN QUERY SELECT true;
END;
$$;

-- 3. 確保した分だけ在庫を戻す（グループ A 設計書 4-1・4-5・4-7。中身は今までと同じ）。
--    失敗にしたら期限切れの行、取消で「お客様に知らせる」なら取消の行（書き分けは取り消す前の状態）を書く。
--    要対応の「注文を取り消して解決」（resolve_payment_exception）もこの関数を通る
CREATE OR REPLACE FUNCTION public.release_stock_for_unpaid_order(
  _order_id uuid,
  _expected_status public.order_status,
  _next_status public.order_status,
  _change_reason text,
  _actor_id uuid DEFAULT NULL,
  _source_event_id text DEFAULT NULL,
  _cancel_reason text DEFAULT NULL,
  _cancel_note text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (released boolean, order_id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  updated_id uuid;
BEGIN
  IF _order_id IS NULL OR _change_reason IS NULL OR pg_catalog.btrim(_change_reason) = '' THEN
    RAISE EXCEPTION 'RELEASE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  IF _next_status IS NULL
     OR _next_status NOT IN (
       'failed'::public.order_status, 'abandoned'::public.order_status, 'cancelled'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_NEXT_STATUS:%', _next_status USING ERRCODE = '22023';
  END IF;

  -- 放棄は「決済画面が一度も完了しなかった」注文だけ。払込票を発行した入金待ちは放棄にしない。
  IF _next_status = 'abandoned'::public.order_status
     AND _expected_status <> 'payment_in_progress'::public.order_status THEN
    RAISE EXCEPTION 'ABANDON_REQUIRES_PAYMENT_IN_PROGRESS' USING ERRCODE = '22023';
  END IF;

  -- 取消は人の判断なので、実行者と理由を必ず残す（R-18）。「その他」はメモも要る（設計書 5-2）。
  IF _next_status = 'cancelled'::public.order_status
     AND (_actor_id IS NULL
          OR _cancel_reason IS NULL
          OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')) THEN
    RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
  END IF;

  IF _next_status = 'cancelled'::public.order_status
     AND _cancel_reason = 'other'
     AND NULLIF(pg_catalog.btrim(_cancel_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(_actor_id::text, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', _change_reason, true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = _next_status,
      cancel_reason = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _cancel_reason ELSE o.cancel_reason
      END,
      cancel_note = CASE
        WHEN _next_status = 'cancelled'::public.order_status
          THEN NULLIF(pg_catalog.btrim(_cancel_note), '')
        ELSE o.cancel_note
      END,
      cancel_notify_customer = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _notify_customer ELSE o.cancel_notify_customer
      END
  WHERE o.id = _order_id
    AND o.status = _expected_status
  RETURNING o.id INTO updated_id;

  IF updated_id IS NULL THEN
    RETURN QUERY SELECT false, _order_id, o.status FROM public.orders AS o WHERE o.id = _order_id;
    RETURN;
  END IF;

  -- バリアントを id 昇順でロックする（受付・入金済みにする処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(updated_id) AS r
    WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 確保した分だけを戻す（R-41）。状態を条件に更新しているので、同じ注文で二度は走らない。
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note, created_by)
  SELECT r.variant_id, r.reserved, 'cancel', updated_id, r.order_item_id, _change_reason, _actor_id
  FROM private.order_line_reservations(updated_id) AS r
  WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  ORDER BY r.variant_id, r.order_item_id;

  IF _next_status = 'failed'::public.order_status THEN
    PERFORM private.enqueue_order_email(updated_id, 'payment_expired', NULL);
  ELSIF _next_status = 'cancelled'::public.order_status AND COALESCE(_notify_customer, false) THEN
    PERFORM private.enqueue_order_email(updated_id, 'canceled', _expected_status::text);
  END IF;

  RETURN QUERY SELECT true, updated_id, _next_status;
END;
$$;

-- 4. 発送（グループ A 設計書 5-2。中身は今までと同じ）。「お客様に発送のメールを送る」なら発送の行を書く（設計書 5-4）。
--    メールは worker が送るので、メールアドレスと氏名は返さない
DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.admin_ship_paid_order(
  _order_id uuid,
  _actor_id uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _notify_customer IS NULL THEN
    RAISE EXCEPTION 'NOTIFY_CUSTOMER_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _shipping_carrier IS NULL
     OR NOT (_shipping_carrier = ANY (ARRAY['yamato', 'sagawa', 'japanpost'])) THEN
    RAISE EXCEPTION 'INVALID_SHIPPING_CARRIER' USING ERRCODE = '22023';
  END IF;

  IF _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_TRACKING_NUMBER' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_ship_paid_order', true);

  UPDATE public.orders AS o
  SET status = 'shipped'::public.order_status,
      shipped_at = pg_catalog.now(),
      shipping_carrier = _shipping_carrier,
      tracking_number = _tracking_number
  WHERE o.id = _order_id
    AND o.status = 'paid'::public.order_status
    AND o.shipped_at IS NULL
    AND private.order_has_required_shipping_fields(o)
    AND NOT EXISTS (
      SELECT 1
      FROM public.payment_exceptions AS e
      WHERE e.order_id = o.id
        AND e.reason = 'paid_amount_mismatch'
        AND e.resolved_at IS NULL
    )
  RETURNING o.id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RETURN;
  END IF;

  IF _notify_customer THEN
    PERFORM private.enqueue_order_email(v_order_id, 'shipped', NULL);
  END IF;

  RETURN QUERY SELECT v_order_id;
END;
$$;

-- 5. 古い送信権の行を、取りやめの行として移す（本計画 P9）。移した注文・種類には、自動の行がもう書かれない
DO $$
BEGIN
  IF pg_catalog.to_regclass('private.order_emails') IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, status, last_error_code, finished_at)
    SELECT c.order_id,
           c.kind,
           CASE c.kind WHEN 'paid' THEN 'order_confirmed' WHEN 'canceled' THEN 'pending' END,
           'auto',
           'skipped',
           'legacy_suppressed',
           pg_catalog.now()
    FROM private.order_emails AS c
    ON CONFLICT (order_id, kind) WHERE origin = 'auto' DO NOTHING;
  END IF;
END
$$;

-- 6. 古い送信権を消す（設計書 7-4）
DROP FUNCTION IF EXISTS public.claim_order_email(uuid, text);
DROP FUNCTION IF EXISTS public.release_order_email(uuid, text);
DROP FUNCTION IF EXISTS private.suppress_legacy_unpaid_order_emails();
DROP TABLE IF EXISTS private.order_emails;

-- 7. 権限
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
```

`private.clear_cart_for_order`・`private.order_line_reservations`・`private.order_has_required_shipping_fields` は今のまま呼ぶ（作り直さない）。この3つの関数の本体と `mark_order_paid` などの今の本体を `grep -n "FUNCTION public.mark_order_paid\|FUNCTION public.release_stock_for_unpaid_order\|FUNCTION public.admin_ship_paid_order" supabase/migrations/*.sql` で探し、いちばん新しい定義と上の本体が「行を書く所」以外で同じことを確かめる（違えば新しい定義に合わせて、行を書く所だけを足す）。

- [ ] **Step 4: 既存の DB 結合テストを新しい関数の形に直す**

| ファイル | 直すこと |
|---|---|
| `tests/integration/db/order_email_claims.integration.test.ts` | 消す |
| `tests/integration/db/mark_order_payment.integration.test.ts` | `markPaid` の SQL を `public.mark_order_paid($1::uuid, $2::public.order_status, $3::text, $4::integer, $5::text, true, 'order_confirmed', $6::text)` にする（引数の配列は今のまま）。権限の試験の `'public.mark_order_paid(uuid,public.order_status,text,integer,text,text)'` を `'public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)'` にする |
| `tests/integration/db/place_order_shown_stock.integration.test.ts` | `public.mark_order_paid($1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', null)` を `public.mark_order_paid($1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', true, 'order_confirmed', null)` にする |
| `tests/integration/db/order_state_transition_hardening.integration.test.ts` | `'public.admin_ship_paid_order(uuid,uuid,text,text)'`（2か所）を `'public.admin_ship_paid_order(uuid,uuid,text,text,boolean)'` にする。`admin_ship_paid_order(` の2つの呼び出しの最後の引数 `'TRACK-123'::text` の後に `, false` を足す |
| `tests/integration/db/payment_exceptions.integration.test.ts` | `admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678')` を `admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678', false)` にする |
| `tests/integration/db/reconciler_composed.integration.test.ts` | 下の Step 9 の表 |
| `tests/integration/db/reconciler_postgrest.integration.test.ts` | 下の Step 9 の表 |

- [ ] **Step 5: 照合と DB の操作の試験を直す（落ちる形にする）**

`tests/unit/lib/stripe/checkout-payment-reconciler.test.ts` を次のとおり直す。

1. 試験の DB が、本物の関数と同じ規則で「書いた行」を記録するようにする。`harness` の `world` を次にし、`markOrderPaid`・`markOrderAwaitingPayment`・`releaseStock` の偽物の中で行を足す:

```ts
type EnqueuedEmail = { orderId: string; kind: 'paid' | 'awaiting_payment' | 'payment_expired' | 'canceled'; variant: string | null };

  const world: { stripe: CheckoutPaymentSnapshot; order: ReconcilerOrder | null; enqueued: EnqueuedEmail[] } = {
    stripe: init.stripe,
    order: init.order ?? null,
    enqueued: [],
  };
```

```ts
    async markOrderPaid(args) {
      if (!world.order || world.order.status !== args.expectedStatus) {
        return { updated: false, amountMatches: false, needsReview: false };
      }
      world.order = { ...world.order, status: 'paid', paymentIntentId: world.order.paymentIntentId ?? args.paymentIntentId };
      const amountMatches = init.amountMatches ?? true;
      // DB の mark_order_paid と同じく、金額が合い「送る」の時だけ注文確認の行を書く
      if (amountMatches && args.notifyCustomer) {
        world.enqueued.push({ orderId: world.order.id, kind: 'paid', variant: args.paidEmailVariant });
      }
      return { updated: true, amountMatches, needsReview: init.needsReview ?? false };
    },
    async markOrderAwaitingPayment(args) {
      if (!world.order || world.order.status !== 'payment_in_progress') {
        return { updated: false };
      }
      world.order = { ...world.order, status: 'pending', paymentIntentId: world.order.paymentIntentId ?? args.paymentIntentId };
      world.enqueued.push({ orderId: world.order.id, kind: 'awaiting_payment', variant: null });
      return { updated: true };
    },
    async releaseStock(args) {
      if (!world.order || world.order.status !== args.expectedStatus) {
        return { released: false };
      }
      world.order = { ...world.order, status: args.nextStatus };
      if (args.nextStatus === 'failed') {
        world.enqueued.push({ orderId: world.order.id, kind: 'payment_expired', variant: null });
      } else if (args.nextStatus === 'cancelled' && args.notifyCustomer) {
        world.enqueued.push({ orderId: world.order.id, kind: 'canceled', variant: args.expectedStatus });
      }
      return { released: true };
    },
```

2. `mailer` の偽物は `sendUnplacedPaymentNotice`・`sendShopAlert` の2つだけにする。ファイルの頭に `const emailsOf = (h: { world: { enqueued: EnqueuedEmail[] } }, kind: EnqueuedEmail['kind']) => h.world.enqueued.filter((email) => email.kind === kind);` を足す。

3. 確かめの文を次の表のとおり置き換える（左の文が出てくる所をすべて）:

| 今の文 | 新しい文 |
|---|---|
| `expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith(X, 'paid', V)` | `expect(emailsOf(h, 'paid')).toEqual([{ orderId: X, kind: 'paid', variant: V }])` |
| `expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith(X, 'awaiting_payment')` | `expect(emailsOf(h, 'awaiting_payment')).toEqual([{ orderId: X, kind: 'awaiting_payment', variant: null }])` |
| `expect(h.mailer.sendOrderConfirmation).not.toHaveBeenCalled()` | `expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([])` |
| `expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(1)` | `expect(emailsOf(h, 'paid')).toHaveLength(1)` |
| `expect(h.mailer.sendPaymentExpired).toHaveBeenCalledWith(X)` | `expect(emailsOf(h, 'payment_expired')).toEqual([{ orderId: X, kind: 'payment_expired', variant: null }])` |
| `expect(h.mailer.sendPaymentExpired).not.toHaveBeenCalled()` | `expect(emailsOf(h, 'payment_expired')).toEqual([])` |
| `expect(h.mailer.sendOrderCanceled).toHaveBeenCalledTimes(notifyCustomer ? 1 : 0)` | `expect(emailsOf(h, 'canceled')).toEqual(notifyCustomer ? [{ orderId: 'order-1', kind: 'canceled', variant: 'payment_in_progress' }] : [])` |
| `expect(h.mailer.sendOrderCanceled).not.toHaveBeenCalled()` | `expect(emailsOf(h, 'canceled')).toEqual([])` |

「書かない・送らない」ことを確かめる2つの試験（`for (const key of Object.keys(h.mailer) ...) expect(h.mailer[key]).not.toHaveBeenCalled();` がある所）には、その下に `expect(h.world.enqueued).toEqual([]);` を足す。

4. 最初の試験の `expect(h.database.markOrderPaid).toHaveBeenCalledWith({...})` に `notifyCustomer: true, paidEmailVariant: 'order_confirmed'` を足す。「全額返金済みの支払いで%sの注文を入金済みにするときは…」の試験に `expect(h.database.markOrderPaid).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false }));` を足す。

5. 「下書き ID の無い Session でも注文があれば…」の試験のコメント `// 送るかは送信権が決める（移行前の2件は Task 6 で送信済みとして登録してあるので届かない）` を `// 行を書くかは DB が決める（移行前の2件は取りやめの行を移してあるので、自動の行はもう書かれない）` にする。

6. 試験の名前の「メールを送る」「メールは1通」などは、そのままでよい（行が1つ＝1通）。

`tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts` の「入金済み・在庫の戻しの RPC に名前付きの引数を渡し、結果を読む」で、`database.markOrderPaid({...})` に `notifyCustomer: true, paidEmailVariant: 'payment_received'` を足し、次を足す:

```ts
    expect(rpc).toHaveBeenCalledWith('mark_order_paid', {
      _order_id: 'order-1',
      _expected_status: 'pending',
      _payment_intent_id: 'pi_1',
      _paid_amount: 5000,
      _paid_currency: 'jpy',
      _notify_customer: true,
      _paid_email_variant: 'payment_received',
      _source_event_id: 'evt_1',
    });
```

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler tests/unit/lib/stripe/checkout-payment-reconciler-deps --runInBand`
Expected: FAIL（`notifyCustomer` を渡していない・まだメールの送信を呼んでいる）

- [ ] **Step 6: 照合と DB の操作を直す**

`src/lib/stripe/checkout-payment-reconciler.ts`:

1. `ReconcilerDatabase.markOrderPaid` の引数の型に足す:

```ts
    /** お客様に注文確認を送るか（全額返金済みの支払いは送らない）。DB が金額の一致と合わせて、行を書くか決める */
    notifyCustomer: boolean;
    /** 入金済みの書き分け（グループ A 設計書 5-4） */
    paidEmailVariant: PaidEmailVariant;
```

2. `ReconcilerMailer` を次にする:

```ts
/** 照合が送るメール。お客様への注文のメールは、状態を変える DB の関数が同じ取引で行を書き、worker が送る（グループ D） */
export interface ReconcilerMailer {
  sendUnplacedPaymentNotice(args: { to: string; fullName: string | null; state: 'paid' | 'awaiting_payment' }): Promise<boolean>;
  sendShopAlert(alert: ShopPaymentAlert): Promise<boolean>;
}
```

3. `markPaid` の `deps.database.markOrderPaid({...})` に `notifyCustomer: !isFullyRefunded(state), paidEmailVariant: emailVariant,` を足し、次の部分を消す:

```ts
  // 全額返金済みの支払いは、このあと返金の同期が注文を取り消す。注文確定・入金確認のメールは送らない
  if (!isFullyRefunded(state)) {
    await deps.mailer.sendOrderConfirmation(order.id, 'paid', emailVariant);
  }
```

`markOrderPaid` の呼び出しの直前に次のコメントを置く:

```ts
  // 全額返金済みの支払いは、このあと返金の同期が注文を取り消すので、注文確認の行を書かない（DB は金額の一致も見る）
```

4. `markAwaiting` の `await deps.mailer.sendOrderConfirmation(order.id, 'awaiting_payment');` を消す。

5. `release` の次の部分を消す:

```ts
  if (nextStatus === 'failed') {
    await deps.mailer.sendPaymentExpired(order.id);
  }
  if (cancel?.notifyCustomer) {
    await deps.mailer.sendOrderCanceled(order.id, expectedStatus);
  }
```

使わなくなった import（`PaidEmailVariant` は型で使い続ける）を外す。

`src/lib/stripe/checkout-payment-reconciler-deps.ts`:

1. `markOrderPaid` の RPC の引数に `_notify_customer: args.notifyCustomer, _paid_email_variant: args.paidEmailVariant,` を足す（`_source_event_id` の前）。
2. `createReconcilerMailer` を次にする:

```ts
export function createReconcilerMailer(): ReconcilerMailer {
  return {
    sendUnplacedPaymentNotice,
    sendShopAlert: sendShopPaymentAlert,
  };
}
```

3. `createDefaultReconcilerDeps` の `mailer: createReconcilerMailer(client),` を `mailer: createReconcilerMailer(),` にする。`sendOrderConfirmationEmailForOrderId`・`sendOrderCanceledEmail`・`sendPaymentExpiredEmail` の import を外す。

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler tests/unit/lib/stripe/checkout-payment-reconciler-deps --runInBand`
Expected: PASS

- [ ] **Step 7: 古い送信の部品を消す**

`src/lib/orders/order-confirmation-email.ts` を、明細の書き方と型だけにする。残すのは `ConfirmationItem`・`OrderConfirmationShipping`・`formatCurrency`・`formatItemLines`・`OrderEmailRow` だけ。消すのは `OrderEmailClaimStore`・`OrderEmailKind`・`OrderConfirmationParams`・`sendOrderConfirmationEmail`・`claimOrderEmail`・`releaseOrderEmail`・`OrderEmailSourceStore`・`ORDER_EMAIL_COLUMNS`・`OrderEmailSource`・`fetchOrderEmailSource`・`sendOrderConfirmationEmailForOrderId` と、使わなくなった import（`SupabaseClient`・`sendMail`・`toOrderNumber`・`logAudit`・`PaidEmailVariant`）。ファイルの頭に次のコメントを置く:

```ts
/**
 * 注文のメールの明細の書き方（金額・明細の行・お届けの目安）。
 * メールの組み立てと送信は src/lib/orders/email/ が行う（グループ D。送る予定の表と worker）。
 */
```

`src/lib/orders/order-lifecycle-emails.ts` は、注文にならなかった支払いの案内（`sendUnplacedPaymentNotice`）と店への要対応メール（`ShopPaymentAlert`・`sendShopPaymentAlert`）だけにする。消すのは `contactLine`・`orderSummaryLines`・`sendClaimedOrderEmail`・`sendPaymentExpiredEmail`・`sendOrderCanceledEmail` と、`order-confirmation-email` からの import。`greeting` は `import { greeting } from '@/lib/orders/email/order-email-compose';` に替えて、ファイルの中の `greeting` を消す。頭のコメントを次にする:

```ts
/**
 * 注文にならなかった支払いのお客様への案内と、店への要対応メール（グループ A 設計書 5-3・5-4）。
 * お客様への注文のメール（入金待ち・入金済み・期限切れ・取消・発送）は src/lib/orders/email/ が送る（グループ D）。
 * 件名は固定の文面で組み、外から来た値（氏名・商品名）は本文にだけ入れる（メールヘッダーの注入を防ぐ）。
 */
```

`src/lib/orders/order-shipped-email.ts` と `tests/unit/lib/orders/order-shipped-email.test.ts` を消す。

`tests/unit/lib/orders/order-confirmation-email.test.ts` は、`formatItemLines`・`formatCurrency` だけを使う試験（「目安を出す指定のときだけ、明細の次の行に在庫あり・受注生産の目安を添える」）を残し、送信・送信権・注文 ID から送る試験と、それだけが使う mock を消す（文面の確かめは Task 2 の `order-email-compose.test.ts` が持つ）。

`tests/unit/lib/orders/order-lifecycle-emails.test.ts` は「期限切れのお知らせ」「取消のお知らせ」の describe と、それだけが使う mock を消す。

- [ ] **Step 8: 管理画面の発送と要対応の解決を直す**

`src/app/api/admin/orders/[id]/status/route.ts`:

1. `sendOrderShippedEmail` の import を消す。
2. 発送のスキーマを次にする:

```ts
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(SHIPPING_CARRIER_IDS),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
    // 発送の画面の「お客様に発送のメールを送る」（既定は送る。Shopify の「発送の詳細を今すぐ送る」）
    notifyCustomer: z.boolean().default(true),
  }),
```

3. `admin_ship_paid_order` の RPC の引数に `_notify_customer: parsedBody.data.notifyCustomer,` を足す。
4. 成功の監査を `await audit('success', 'Status changed to shipped', { status: 'shipped', carrier: parsedBody.data.carrier, notify_customer: parsedBody.data.notifyCustomer });` にし、`await sendOrderShippedEmail({...});` の呼び出しを消す。

`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`:

1. `sendOrderCanceledEmail` の import を消す。
2. 次の部分を消す（取消のメールは `release_stock_for_unpaid_order` が同じ取引で行を書く）:

```ts
    if (row.cancelled_from && row.order_id && notifyCustomer) {
      await sendOrderCanceledEmail({
        store: supabase,
        orderId: row.order_id,
        previousStatus: row.cancelled_from,
        logLabel: '[admin]',
      });
    }
```

`tests/unit/api/admin/order-status-shipped.test.ts`:

1. `mockSendOrderShippedEmail` と `@/lib/orders/order-shipped-email` の mock を消し、それを確かめる文（`expect(mockSendOrderShippedEmail)...`）を消す。
2. 「paid の注文を発送済みにできる」の `expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', {...})` に `_notify_customer: true` を足す。
3. 「発送」の describe に次を足す:

```ts
  test('「お客様に発送のメールを送る」を外すと、DB に送らないを渡す', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID }], error: null });

    const response = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: false });

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', expect.objectContaining({ _notify_customer: false }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: 'Status changed to shipped',
      metadata: expect.objectContaining({ notify_customer: false }),
    }));
  });

  test('「送るか」が真偽でなければ 400', async () => {
    const response = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: 'no' });
    expect(response.status).toBe(400);
  });
```

`tests/unit/api/admin/order-attention-route.test.ts`:

1. `mockSendOrderCanceledEmail` と `@/lib/orders/order-lifecycle-emails` の mock を消す。
2. `expect(mockSendOrderCanceledEmail).toHaveBeenCalledTimes(notifyCustomer ? 1 : 0)` を `expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _notify_customer: notifyCustomer }))` に、`expect(mockSendOrderCanceledEmail).toHaveBeenCalledTimes(1)` を `expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _notify_customer: true }))` にする（RPC の偽物の名前はファイルの中のものに合わせる）。`expect(mockSendOrderCanceledEmail).not.toHaveBeenCalled()` の行は消す。

- [ ] **Step 9: 照合を本物の DB に通す試験を直す**

| ファイル | 直すこと |
|---|---|
| `tests/integration/db/reconciler_composed.integration.test.ts` | 頭のコメントの「createReconcilerMailer（注文メールの組み立てと claim_order_email の送信権、期限切れのお知らせ、店への要対応メールの組み立て）」を「createReconcilerMailer（店への要対応メールの組み立て）。お客様への注文のメールは、本物の RPC が同じ取引で書く送る予定の行で確かめる」に、`// 外の世界に出るメールの送信だけを偽物にする。送信権（claim_order_email）と本文の組み立ては本物` を `// 外の世界に出るメール（店への要対応メール）の送信だけを偽物にする` にする。`createReconcilerMailer(client)` を `createReconcilerMailer()` にする。`claimedEmailKinds` を消して、次の `queuedEmails` を足す。`admin_ship_paid_order(` の呼び出しの最後に `, false` を足す |
| 同上 | 確かめの文を置き換える: `expect(await claimedEmailKinds(orderId)).toEqual(['paid'])` → `expect(await queuedEmails(orderId)).toEqual([{ kind: 'paid', variant: 'order_confirmed', status: 'pending' }])`。`['awaiting_payment']` → `[{ kind: 'awaiting_payment', variant: null, status: 'pending' }]`。`['awaiting_payment', 'payment_expired']` → `[{ kind: 'awaiting_payment', variant: null, status: 'pending' }, { kind: 'payment_expired', variant: null, status: 'pending' }]`。`[]` → `[]`（`queuedEmails` で） |
| 同上 | お客様へのメールを数える文を置き換える: カードの入金と払込期限切れの試験の `expect(sentMails()).toHaveLength(1)`・`toHaveLength(2)` を `expect(sentMails()).toHaveLength(0)` にし、お客様へのメールの件名を見る `expect(sentMails()[0]).toMatchObject({ to: CUSTOMER_EMAIL, ... })`・`expect(sentMails()[0].subject).toContain(...)`・`expect(sentMails()[1]...)` の行を消す（お客様へのメールは worker が送るので、照合は送らない）。店への要対応メールの確かめ（`SHOP_ALERT_TO` 宛て）はそのまま。使わなくなった `CUSTOMER_EMAIL` と `toOrderNumber` の import は、ほかで使っていなければ消す。試験の名前の「確認メールを1通だけ送り」は「注文確認の送る予定を1行だけ書き」、「期限切れのお知らせを1通だけ送る」は「期限切れの送る予定を1行だけ書く」にする |
| `tests/integration/db/reconciler_postgrest.integration.test.ts` | `mailer` の偽物を `{ sendUnplacedPaymentNotice: jest.fn().mockResolvedValue(true), sendShopAlert: jest.fn().mockResolvedValue(true) }` にする。`expect(deps.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(N)` を `expect(await paidEmailCount(db(), orderId)).toBe(N)` に（注文の番号が無い試験は `draft.checkoutSessionId` から `select id from public.orders where checkout_session_id = $1` で引く）、`expect(deps.mailer.sendOrderConfirmation).not.toHaveBeenCalled()` を、注文が無い試験では消す |

`queuedEmails`（reconciler_composed）と `paidEmailCount`（reconciler_postgrest）は次のとおり:

```ts
  /** 照合が本物の RPC で書いた、お客様への注文のメールの送る予定。private スキーマなので pg で直接読む */
  const queuedEmails = async (orderId: string) =>
    (
      await db().query(
        'select kind, variant, status from private.order_email_outbox where order_id = $1 order by seq',
        [orderId],
      )
    ).rows;
```

```ts
async function paidEmailCount(db: PgClient, orderId: string): Promise<number> {
  const res = await db.query(
    "select count(*)::int as count from private.order_email_outbox where order_id = $1 and kind = 'paid'",
    [orderId],
  );
  return res.rows[0].count as number;
}
```

- [ ] **Step 10: テストが通ることを確かめる**

Run: `npx jest tests/unit --runInBand`
Expected: PASS（`order-shipped-email` を参照する試験が残っていないこと）
Run: `npm run typecheck` と `npm run lint`
Expected: エラー0件
Run（controller）: `npx supabase db reset` の後に Global Constraints の DB 結合テスト（フォルダ全体）
Expected: PASS（`order_email_enqueue`・`order_email_outbox`・直した7本を含む）

- [ ] **Step 11: コミット（controller）**

```bash
git add supabase/migrations/20261009095736_order_email_enqueue.sql tests/integration/db/order_email_enqueue.integration.test.ts tests/integration/db/order_email_claims.integration.test.ts tests/integration/db/mark_order_payment.integration.test.ts tests/integration/db/place_order_shown_stock.integration.test.ts tests/integration/db/order_state_transition_hardening.integration.test.ts tests/integration/db/payment_exceptions.integration.test.ts tests/integration/db/reconciler_composed.integration.test.ts tests/integration/db/reconciler_postgrest.integration.test.ts src/lib/stripe/checkout-payment-reconciler.ts src/lib/stripe/checkout-payment-reconciler-deps.ts src/lib/orders/order-confirmation-email.ts src/lib/orders/order-lifecycle-emails.ts src/lib/orders/order-shipped-email.ts "src/app/api/admin/orders/[id]/status/route.ts" "src/app/api/admin/payment-exceptions/[id]/resolve/route.ts" tests/unit/lib/stripe/checkout-payment-reconciler.test.ts tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts tests/unit/api/admin/order-status-shipped.test.ts tests/unit/api/admin/order-attention-route.test.ts tests/unit/lib/orders/order-confirmation-email.test.ts tests/unit/lib/orders/order-lifecycle-emails.test.ts tests/unit/lib/orders/order-shipped-email.test.ts
git commit -m "feat(orders): 状態を変える DB の関数が注文のメールの行を書き、直接の送信をやめる（グループ D 移行 B）"
```

---

### Task 4: worker を動かすきっかけと、店への知らせ

**Files:**
- Create: `src/lib/orders/email/order-email-ops.ts`
- Modify: `src/lib/orders/email/order-email-store.ts`（点検の関数を足す）・`src/lib/orders/email/order-email-worker.ts`（最後の成功を記録する）
- Modify: `src/lib/ops/ops-store.ts`・`src/lib/ops/ops-checks.ts`・`src/lib/ops/ops-alert-mail.ts`
- Modify: `src/lib/stripe/webhook-worker.ts`
- Modify: `src/app/api/checkout/complete/route.ts`・`src/app/api/admin/orders/[id]/status/route.ts`・`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`・`src/app/api/cron/expire-pending-orders/route.ts`
- Test: `tests/unit/lib/orders/email/order-email-ops.test.ts`（新規）・`tests/unit/lib/orders/email/order-email-worker.test.ts`・`tests/unit/lib/ops/ops-alert-mail.test.ts`・`tests/unit/lib/stripe/webhook-worker.test.ts`・`tests/unit/api/checkout/complete-route.test.ts`・`tests/unit/api/admin/order-status-shipped.test.ts`・`tests/unit/api/admin/order-attention-route.test.ts`・`tests/unit/api/cron/expire-pending-orders-route.test.ts`

**Interfaces:**
- Consumes: Task 1 の `get_order_email_backlog`・`list_unnotified_dead_order_emails`・`mark_order_emails_dead_notified`・`list_unnotified_order_email_delivery_problems`・`mark_order_email_delivery_problems_notified`・`get_order_email_send_state`、Task 2 の `runOrderEmailWorker`・`scheduleOrderEmailDelivery`・`getOrderEmailSendState`・`callOrderEmailRpc`・`rowsOf`・`textOrNull`・`dateOrNull`・`ORDER_EMAIL_WORKER_BUDGET_MS`、既存の `recordHeartbeat`・`readHeartbeats`・`claimAlert`・`releaseAlert`
- Produces:
  - `OpsJob` に `'order_email_worker' | 'order_email_delivery_check'`、`OpsAlertKey` に `'order_email_paused' | 'order_email_backlog' | 'order_email_dead' | 'order_email_delivery_problem' | 'job_stale_order_email_worker'` を足す
  - `ops-checks.ts` の `sendOnce(deps, key, mail)` を export する（中身は変えない）
  - `ops-alert-mail.ts`: `ORDER_EMAIL_RUNBOOK`・`orderEmailPausedMail(state)`・`orderEmailBacklogMail(rows)`・`orderEmailDeadDigestMail(emails, total)`・`orderEmailDeliveryProblemMail(emails, total)`。`staleJobMail` は `'order_email_worker'` も受ける（今の2つの文面は変えない）。`OpsAlertKind` に `'order_email_paused' | 'order_email_backlog' | 'order_email_dead' | 'order_email_delivery_problem'` を足す
  - `order-email-store.ts`: 型 `OrderEmailBacklogRow`・`DeadOrderEmail`・`DeliveryProblemEmail`、関数 `readOrderEmailBacklog(store, olderThanSeconds)`・`listUnnotifiedDeadOrderEmails(store, limit)`・`markDeadOrderEmailsNotified(store, ids)`・`listUnnotifiedDeliveryProblems(store, limit)`・`markDeliveryProblemsNotified(store, ids)`
  - `order-email-ops.ts`: `ORDER_EMAIL_OPS_LIMITS`・`runOrderEmailOpsChecks(deps): Promise<OrderEmailOpsResult>`・型 `OrderEmailOpsDeps`・`OrderEmailOpsResult`
  - `webhook-worker.ts`: `WORKER_TIME_BUDGET_MS = 35_000`。`WorkerRunResult` に `emails: OrderEmailWorkerResult | null`・`emailChecks: OrderEmailOpsResult` を足す
  - `runOrderEmailWorker` は終わりに `order_email_worker` の最後の成功（取り出しの失敗なら失敗と `db_unavailable`）を記録する

- [ ] **Step 1: 点検と知らせの文の試験を書く**

`tests/unit/lib/orders/email/order-email-ops.test.ts`:

```ts
import { ORDER_EMAIL_OPS_LIMITS, runOrderEmailOpsChecks } from '@/lib/orders/email/order-email-ops';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const NOW = new Date('2026-10-09T12:00:00Z');

type State = {
  sendState: unknown[];
  backlog: unknown[];
  dead: unknown[];
  delivery: unknown[];
  heartbeats: unknown[];
  sentAt: Record<string, string | null>;
  failOn?: string;
};

function emptyState(): State {
  return {
    sendState: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }],
    backlog: [], dead: [], delivery: [], heartbeats: [], sentAt: {},
  };
}

/** DB の関数を、送る権利の時刻まで含めてまねる（グループ B の ops-checks の試験と同じ作り） */
function fakeStore(state: State) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (state.failOn === name) return { data: null, error: { message: 'db down' } };
    switch (name) {
      case 'get_order_email_send_state':
        return { data: state.sendState, error: null };
      case 'get_order_email_backlog':
        return { data: state.backlog, error: null };
      case 'list_unnotified_dead_order_emails':
        return { data: state.dead, error: null };
      case 'mark_order_emails_dead_notified':
        return { data: (params?._email_ids as string[]).length, error: null };
      case 'list_unnotified_order_email_delivery_problems':
        return { data: state.delivery, error: null };
      case 'mark_order_email_delivery_problems_notified':
        return { data: (params?._email_ids as string[]).length, error: null };
      case 'get_ops_heartbeats':
        return { data: state.heartbeats, error: null };
      case 'claim_ops_alert': {
        const key = String(params?._alert_key);
        const previous = state.sentAt[key] ?? null;
        if (previous && NOW.getTime() - new Date(previous).getTime() < Number(params?._cooldown_seconds) * 1000) {
          return { data: [{ claimed: false, claimed_at: null, previous_sent_at: previous }], error: null };
        }
        state.sentAt[key] = NOW.toISOString();
        return { data: [{ claimed: true, claimed_at: NOW.toISOString(), previous_sent_at: previous }], error: null };
      }
      case 'release_ops_alert': {
        const key = String(params?._alert_key);
        if (state.sentAt[key] === params?._claimed_at) state.sentAt[key] = (params?._previous_sent_at as string | null) ?? null;
        return { data: true, error: null };
      }
      default:
        return { data: null, error: null };
    }
  });
  return { store: { rpc } as never, calls };
}

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

describe('runOrderEmailOpsChecks', () => {
  it('何も無ければ知らせない', async () => {
    const send = jest.fn();
    const { store } = fakeStore(emptyState());

    await expect(runOrderEmailOpsChecks({ store, send, now: () => NOW })).resolves.toEqual({
      pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('送信を止めていれば知らせ、1時間以内はもう知らせない', async () => {
    const state = emptyState();
    state.sendState = [{ paused: true, reason: 'config_api_key', paused_at: '2026-10-09T11:50:00Z', next_probe_at: '2026-10-09T12:05:00Z' }];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).pausedAlerted).toBe(true);
    expect(send.mock.calls[0][0].kind).toBe('order_email_paused');
    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).pausedAlerted).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('15分以上送れていないメールがあれば知らせる', async () => {
    const state = emptyState();
    state.backlog = [{ status: 'retry_wait', email_count: 2, oldest_created_at: '2026-10-09T11:30:00Z', last_errors: ['provider_unavailable'] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(true);
    expect(calls.find((call) => call.name === 'get_order_email_backlog')?.params).toEqual({
      _older_than_seconds: ORDER_EMAIL_OPS_LIMITS.backlogAgeSeconds,
    });
  });

  it('送れなかったメールをまとめて1通知らせ、送れた時だけ印を付ける', async () => {
    const state = emptyState();
    state.dead = [{ email_id: 'email-1', order_id: ORDER_ID, kind: 'paid', last_error_code: 'invalid_message', attempts: 1, finished_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    const unsent = fakeStore({ ...state, sentAt: {} });
    const failingSend = jest.fn().mockResolvedValue(false);

    expect((await runOrderEmailOpsChecks({ store: unsent.store, send: failingSend, now: () => NOW })).deadNotified).toBe(0);
    expect(unsent.calls.map((call) => call.name)).not.toContain('mark_order_emails_dead_notified');

    const sent = fakeStore({ ...state, sentAt: {} });
    const send = jest.fn().mockResolvedValue(true);
    expect((await runOrderEmailOpsChecks({ store: sent.store, send, now: () => NOW })).deadNotified).toBe(1);
    expect(sent.calls.find((call) => call.name === 'mark_order_emails_dead_notified')?.params).toEqual({ _email_ids: ['email-1'] });
  });

  it('届かなかったメールをまとめて1通知らせ、印を付ける', async () => {
    const state = emptyState();
    state.delivery = [{ email_id: 'email-2', order_id: ORDER_ID, kind: 'shipped', delivery_status: 'bounced', delivery_event_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).deliveryNotified).toBe(1);
    expect(send.mock.calls[0][0].kind).toBe('order_email_delivery_problem');
    expect(calls.find((call) => call.name === 'mark_order_email_delivery_problems_notified')?.params).toEqual({ _email_ids: ['email-2'] });
  });

  it('注文のメールの worker が15分以上成功していなければ知らせる。一度も成功していなければ知らせない', async () => {
    const stale = emptyState();
    stale.heartbeats = [{ job: 'order_email_worker', last_succeeded_at: '2026-10-09T11:44:00Z', last_failed_at: null, last_error_code: null }];
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store: fakeStore(stale).store, send, now: () => NOW })).staleAlerted).toBe(true);
    expect(send.mock.calls[0][0].subject).toBe('【要確認】定期処理が止まっています（注文のメールの送信）');

    const never = emptyState();
    expect((await runOrderEmailOpsChecks({ store: fakeStore(never).store, send: jest.fn(), now: () => NOW })).staleAlerted).toBe(false);
  });

  it('点検の1つが失敗しても残りは続ける', async () => {
    const state = emptyState();
    state.failOn = 'get_order_email_backlog';
    state.dead = [{ email_id: 'email-1', order_id: ORDER_ID, kind: 'paid', last_error_code: null, attempts: 9, finished_at: null, total_count: 1 }];
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrderEmailOpsChecks({ store: fakeStore(state).store, send: jest.fn().mockResolvedValue(true), now: () => NOW });

    expect(result.failedChecks).toEqual(['backlog']);
    expect(result.deadNotified).toBe(1);
    error.mockRestore();
  });
});
```

`tests/unit/lib/ops/ops-alert-mail.test.ts` の「店への知らせのメールの文面」に次を足し、`import` に `orderEmailBacklogMail`・`orderEmailDeadDigestMail`・`orderEmailDeliveryProblemMail`・`orderEmailPausedMail` を足す:

```ts
  describe('注文のメール（グループ D）', () => {
    const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

    it('一時停止: 原因と、自動で再開することと、手順書の節を書く', () => {
      const mail = orderEmailPausedMail({
        reason: 'quota_daily', pausedAt: new Date('2026-10-09T01:00:00Z'), nextProbeAt: new Date('2026-10-10T00:00:00Z'),
      });
      expect(mail.kind).toBe('order_email_paused');
      expect(mail.subject).toBe('【要対応】注文のメールの送信を止めています');
      expect(mail.lines.join('\n')).toContain('1日の送信の上限');
      expect(mail.lines.join('\n')).toContain('docs/06_Operations/order-email-operations.md）の「送信の一時停止」');
    });

    it('溜まり: 状態ごとの件数と原因の名前を書く', () => {
      const mail = orderEmailBacklogMail([
        { status: 'retry_wait', count: 2, oldestCreatedAt: new Date('2026-10-09T01:00:00Z'), lastErrors: ['provider_unavailable', 'Error: x@example.com'] },
      ]);
      const text = mail.lines.join('\n');
      expect(mail.subject).toBe('【要確認】注文のメールの送信が遅れています');
      expect(text).toContain('やり直し待ち: 2件');
      expect(text).toContain('送信サービスの一時的な失敗、想定外の失敗');
      expect(text).not.toContain('@example.com');
      expect(text).toContain('の「溜まり」');
    });

    it('送れなかった: 注文番号・種類・原因・試行の回数と、管理画面から再送できることを書く', () => {
      const mail = orderEmailDeadDigestMail([
        { id: 'email-1', orderId: ORDER_ID, kind: 'paid', lastErrorCode: 'invalid_message', attempts: 1, finishedAt: null },
      ], 3);
      const text = mail.lines.join('\n');
      expect(mail.subject).toBe('【要対応】送れなかった注文のメール（3件）');
      expect(text).toContain('- ORD-A1B2C3D4（注文確認のメール） 原因: 宛先の形が不正 試行: 1回');
      expect(text).toContain('（ほかに 2 件。次の知らせで送ります）');
      expect(text).toContain('「履歴」から「お客様へ再送」');
      expect(text).toContain('の「送れなかった」');
    });

    it('届かなかった: 注文番号・種類・配達の状態を書く', () => {
      const mail = orderEmailDeliveryProblemMail([
        { id: 'email-2', orderId: ORDER_ID, kind: 'shipped', deliveryStatus: 'bounced', deliveryEventAt: new Date('2026-10-09T01:00:00Z') },
      ], 1);
      const text = mail.lines.join('\n');
      expect(mail.subject).toBe('【要確認】届かなかった注文のメール（1件）');
      expect(text).toContain('- ORD-A1B2C3D4（発送のメール） 状態: 届かなかった');
      expect(text).toContain('の「届かなかった」');
    });

    it('遅れ: 注文のメールの worker は15分と手順書の「worker の停止」を書く。今の2つの文面は変えない', () => {
      const email = staleJobMail('order_email_worker', new Date('2026-10-09T01:00:00Z'));
      expect(email.lines[0]).toBe('注文のメールの送信が、15分以上成功していません。');
      expect(email.lines.join('\n')).toContain('docs/06_Operations/order-email-operations.md）の「worker の停止」');
      expect(staleJobMail('order_sweep', new Date('2026-10-09T01:00:00Z')).lines[0]).toBe('毎時の見回りが、2時間以上成功していません。');
    });
  });
```

`tests/unit/lib/orders/email/order-email-worker.test.ts` の頭の `jest.mock('@/lib/supabase/server', ...)`（Task 2 で置いた物）を次に置き換え、ほかの mock を足す:

```ts
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockClientRpc = jest.fn();
const mockClient = { rpc: (...args: unknown[]) => mockClientRpc(...args), from: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockClient) }));
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-sender'),
  checkOrderEmailSendConfig: () => null,
}));
```

```ts
describe('runOrderEmailWorker', () => {
  beforeEach(() => {
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
  });

  it('送るものが無くても、最後の成功を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: [], error: null });

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'empty' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', true, null);
  });

  it('取り出しに失敗したら、失敗と原因の記号を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: null, error: { message: 'down', code: '08006' } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'claim_error' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', false, 'db_unavailable');
    error.mockRestore();
  });
});
```

（`runOrderEmailWorker` を `@/lib/orders/email/order-email-worker` の import に足す。）

Run: `npx jest tests/unit/lib/orders/email tests/unit/lib/ops --runInBand`
Expected: FAIL（`order-email-ops` が無い・`orderEmailPausedMail` が無い・最後の成功を記録しない）

- [ ] **Step 2: 点検の関数・知らせの文・点検を書く**

`src/lib/orders/email/order-email-store.ts` の `OrderEmailRpcName` に次を足す:

```ts
  | 'get_order_email_backlog'
  | 'list_unnotified_dead_order_emails'
  | 'mark_order_emails_dead_notified'
  | 'list_unnotified_order_email_delivery_problems'
  | 'mark_order_email_delivery_problems_notified'
```

同じファイルの終わりに足す:

```ts
export type OrderEmailBacklogRow = {
  status: 'pending' | 'sending' | 'retry_wait';
  count: number;
  oldestCreatedAt: Date;
  lastErrors: string[];
};

export type DeadOrderEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  lastErrorCode: string | null;
  attempts: number;
  finishedAt: Date | null;
};

export type DeliveryProblemEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  deliveryStatus: OrderEmailDeliveryStatus;
  deliveryEventAt: Date | null;
};

export async function readOrderEmailBacklog(store: OrderEmailStore, olderThanSeconds: number): Promise<OrderEmailBacklogRow[]> {
  const data = await callOrderEmailRpc(store, 'get_order_email_backlog', { _older_than_seconds: olderThanSeconds });
  return rowsOf(data).map((row) => ({
    status: row.status as OrderEmailBacklogRow['status'],
    count: Number(row.email_count),
    oldestCreatedAt: new Date(String(row.oldest_created_at)),
    lastErrors: Array.isArray(row.last_errors)
      ? (row.last_errors as unknown[]).filter((value): value is string => typeof value === 'string')
      : [],
  }));
}

export async function listUnnotifiedDeadOrderEmails(
  store: OrderEmailStore,
  limit: number,
): Promise<{ emails: DeadOrderEmail[]; total: number }> {
  const list = rowsOf(await callOrderEmailRpc(store, 'list_unnotified_dead_order_emails', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    emails: list.map((row) => ({
      id: String(row.email_id),
      orderId: String(row.order_id),
      kind: row.kind as OrderEmailKind,
      lastErrorCode: textOrNull(row.last_error_code),
      attempts: Number(row.attempts),
      finishedAt: dateOrNull(row.finished_at),
    })),
  };
}

export async function markDeadOrderEmailsNotified(store: OrderEmailStore, emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  const data = await callOrderEmailRpc(store, 'mark_order_emails_dead_notified', { _email_ids: emailIds });
  return typeof data === 'number' ? data : 0;
}

export async function listUnnotifiedDeliveryProblems(
  store: OrderEmailStore,
  limit: number,
): Promise<{ emails: DeliveryProblemEmail[]; total: number }> {
  const list = rowsOf(await callOrderEmailRpc(store, 'list_unnotified_order_email_delivery_problems', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    emails: list.map((row) => ({
      id: String(row.email_id),
      orderId: String(row.order_id),
      kind: row.kind as OrderEmailKind,
      deliveryStatus: row.delivery_status as OrderEmailDeliveryStatus,
      deliveryEventAt: dateOrNull(row.delivery_event_at),
    })),
  };
}

export async function markDeliveryProblemsNotified(store: OrderEmailStore, emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  const data = await callOrderEmailRpc(store, 'mark_order_email_delivery_problems_notified', { _email_ids: emailIds });
  return typeof data === 'number' ? data : 0;
}
```

（`OrderEmailDeliveryStatus` を型の import に足す。）

`src/lib/ops/ops-store.ts`:

```ts
export type OpsJob = 'webhook_worker' | 'order_sweep' | 'stripe_reconcile' | 'order_email_worker' | 'order_email_delivery_check';

export type OpsAlertKey =
  | 'webhook_backlog'
  | 'webhook_dead'
  | 'webhook_signature_invalid'
  | 'webhook_mode_mismatch'
  | 'job_stale_order_sweep'
  | 'job_stale_stripe_reconcile'
  | 'order_email_paused'
  | 'order_email_backlog'
  | 'order_email_dead'
  | 'order_email_delivery_problem'
  | 'job_stale_order_email_worker';
```

`src/lib/ops/ops-checks.ts` の `async function sendOnce(` を `export async function sendOnce(` にする（中身は変えない）。

`src/lib/ops/ops-alert-mail.ts`:

1. `OpsAlertKind` に `| 'order_email_paused' | 'order_email_backlog' | 'order_email_dead' | 'order_email_delivery_problem'` を足す。
2. `RUNBOOK` の下に `export const ORDER_EMAIL_RUNBOOK = '手順書（docs/06_Operations/order-email-operations.md）';` を足す。
3. `STALE_JOBS` と `staleJobMail` を次にする（今の2つの文面は同じになる）:

```ts
const STALE_JOBS = {
  order_sweep: { label: '毎時の見回り', threshold: '2時間', runbook: RUNBOOK, section: '定期処理が止まったとき' },
  stripe_reconcile: { label: '毎晩の照合', threshold: '25時間', runbook: RUNBOOK, section: '定期処理が止まったとき' },
  order_email_worker: { label: '注文のメールの送信', threshold: '15分', runbook: ORDER_EMAIL_RUNBOOK, section: 'worker の停止' },
} as const;
```

```ts
export function staleJobMail(job: keyof typeof STALE_JOBS, lastSucceededAt: Date): OpsAlertMail {
  const { label, threshold, runbook, section } = STALE_JOBS[job];
  return {
    kind: 'job_stale',
    subject: `【要確認】定期処理が止まっています（${label}）`,
    lines: [
      `${label}が、${threshold}以上成功していません。`,
      `最後の成功: ${formatJst(lastSucceededAt)}`,
      '',
      `次にやること: ${runbook}の「${section}」に沿って、定期処理の実行の記録を確かめてください。`,
    ],
  };
}
```

4. ファイルの終わり（`sendOpsAlertMail` の前）に足す:

```ts
const ORDER_EMAIL_BACKLOG_LABELS: Record<OrderEmailBacklogRow['status'], string> = {
  pending: '送信待ち',
  sending: '送信中',
  retry_wait: 'やり直し待ち',
};

/** 原因の記号の名前。自由文（宛先などを含みうる）は「想定外の失敗」にして載せない */
function orderEmailErrorLabel(code: string | null): string {
  return isOrderEmailErrorCode(code) ? ORDER_EMAIL_ERROR_LABELS[code] : ORDER_EMAIL_ERROR_LABELS.unexpected_error;
}

export function orderEmailPausedMail(state: Pick<OrderEmailSendState, 'reason' | 'pausedAt' | 'nextProbeAt'>): OpsAlertMail {
  return {
    kind: 'order_email_paused',
    subject: '【要対応】注文のメールの送信を止めています',
    lines: [
      `送信サービスの設定の問題で、お客様への注文のメールの送信を止めています（${orderEmailErrorLabel(state.reason)}）。`,
      ...(state.pausedAt ? [`止めた時刻: ${formatJst(state.pausedAt)}`] : []),
      ...(state.nextProbeAt ? [`次に1件だけ試す時刻: ${formatJst(state.nextProbeAt)}`] : []),
      '設定が直ると、試した1件が送れた時点で自動で再開します。止めている間のメールは消えずに残ります。',
      '',
      `次にやること: ${ORDER_EMAIL_RUNBOOK}の「送信の一時停止」に沿って、設定を確かめてください。`,
    ],
  };
}

export function orderEmailBacklogMail(rows: OrderEmailBacklogRow[]): OpsAlertMail {
  return {
    kind: 'order_email_backlog',
    subject: '【要確認】注文のメールの送信が遅れています',
    lines: [
      'お客様への注文のメールのうち、書いてから15分以上たっても送れていないものがあります。',
      '',
      ...rows.map((row) => {
        const causes = row.lastErrors.length > 0 ? ` 原因: ${row.lastErrors.map(orderEmailErrorLabel).join('、')}` : '';
        return `${ORDER_EMAIL_BACKLOG_LABELS[row.status]}: ${row.count}件（いちばん古いもの: ${formatJst(row.oldestCreatedAt)}）${causes}`;
      }),
      '',
      `次にやること: ${ORDER_EMAIL_RUNBOOK}の「溜まり」に沿って、worker と送信の一時停止を確かめてください。`,
    ],
  };
}

export function orderEmailDeadDigestMail(emails: DeadOrderEmail[], total: number): OpsAlertMail {
  const rest = total - emails.length;
  return {
    kind: 'order_email_dead',
    subject: `【要対応】送れなかった注文のメール（${total}件）`,
    lines: [
      'お客様への注文のメールを送れませんでした（これ以上やり直しません）。',
      '',
      ...emails.map((email) =>
        `- ${toOrderNumber(email.orderId)}（${ORDER_EMAIL_KIND_LABELS[email.kind]}のメール） `
        + `原因: ${orderEmailErrorLabel(email.lastErrorCode)} 試行: ${email.attempts}回`),
      ...(rest > 0 ? [`（ほかに ${rest} 件。次の知らせで送ります）`] : []),
      '',
      '管理画面の ORDER タブで、その注文の「履歴」から「お客様へ再送」できます。',
      `原因ごとの対応は、${ORDER_EMAIL_RUNBOOK}の「送れなかった」を確かめてください。`,
    ],
  };
}

export function orderEmailDeliveryProblemMail(emails: DeliveryProblemEmail[], total: number): OpsAlertMail {
  const rest = total - emails.length;
  return {
    kind: 'order_email_delivery_problem',
    subject: `【要確認】届かなかった注文のメール（${total}件）`,
    lines: [
      'お客様への注文のメールが、相手のメールの会社で届かなかった・止められたと知らせがありました。',
      '',
      ...emails.map((email) =>
        `- ${toOrderNumber(email.orderId)}（${ORDER_EMAIL_KIND_LABELS[email.kind]}のメール） `
        + `状態: ${ORDER_EMAIL_DELIVERY_LABELS[email.deliveryStatus]}`
        + (email.deliveryEventAt ? ` 時刻: ${formatJst(email.deliveryEventAt)}` : '')),
      ...(rest > 0 ? [`（ほかに ${rest} 件。次の知らせで送ります）`] : []),
      '',
      `宛先の誤りや受け取りの拒否のことがあります。${ORDER_EMAIL_RUNBOOK}の「届かなかった」に沿って、お客様への連絡を考えてください。`,
    ],
  };
}
```

`import` に足す: `import { isOrderEmailErrorCode, ORDER_EMAIL_DELIVERY_LABELS, ORDER_EMAIL_ERROR_LABELS, ORDER_EMAIL_KIND_LABELS } from '@/lib/orders/email/order-email-types';` と `import type { DeadOrderEmail, DeliveryProblemEmail, OrderEmailBacklogRow, OrderEmailSendState } from '@/lib/orders/email/order-email-store';`

`src/lib/orders/email/order-email-ops.ts`:

```ts
import { readHeartbeats, type OpsStore } from '@/lib/ops/ops-store';
import { sendOnce } from '@/lib/ops/ops-checks';
import {
  orderEmailBacklogMail,
  orderEmailDeadDigestMail,
  orderEmailDeliveryProblemMail,
  orderEmailPausedMail,
  staleJobMail,
  type OpsAlertMail,
} from '@/lib/ops/ops-alert-mail';
import {
  getOrderEmailSendState,
  listUnnotifiedDeadOrderEmails,
  listUnnotifiedDeliveryProblems,
  markDeadOrderEmailsNotified,
  markDeliveryProblemsNotified,
  readOrderEmailBacklog,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

/**
 * 注文のメールの点検（グループ D 設計書 4-6・4-8）。worker と毎時の見回りの終わりに呼ぶ。
 * - 一時停止: 止めていれば知らせる
 * - 溜まり: 書いてから15分以上送れていないメール
 * - 送れなかった・届かなかった: まだ知らせていない分をまとめて1通（50件まで）。送れた時だけ印を付ける
 * - worker の停止: 最後の成功から15分（一度も成功していなければ対象にしない）
 * 種類ごとに1時間に1回まで。点検の1つが失敗しても、残りは続ける。
 */
export const ORDER_EMAIL_OPS_LIMITS = {
  backlogAgeSeconds: 15 * 60,
  digestLimit: 50,
  staleAfterSeconds: 15 * 60,
} as const;

export type OrderEmailOpsDeps = {
  store: OpsStore & OrderEmailStore;
  send: (mail: OpsAlertMail) => Promise<boolean>;
  now: () => Date;
};

export type OrderEmailOpsResult = {
  pausedAlerted: boolean;
  backlogAlerted: boolean;
  deadNotified: number;
  deliveryNotified: number;
  staleAlerted: boolean;
  failedChecks: Array<'paused' | 'backlog' | 'dead' | 'delivery' | 'stale'>;
};

function logFailure(check: string, error: unknown): void {
  console.error(`[order-email-ops] ${check} check failed`, error instanceof Error ? error.name : 'UnknownError');
}

export async function runOrderEmailOpsChecks(deps: OrderEmailOpsDeps): Promise<OrderEmailOpsResult> {
  const result: OrderEmailOpsResult = {
    pausedAlerted: false,
    backlogAlerted: false,
    deadNotified: 0,
    deliveryNotified: 0,
    staleAlerted: false,
    failedChecks: [],
  };

  try {
    const state = await getOrderEmailSendState(deps.store);
    if (state.paused) {
      result.pausedAlerted = await sendOnce(deps, 'order_email_paused', orderEmailPausedMail(state));
    }
  } catch (error) {
    result.failedChecks.push('paused');
    logFailure('paused', error);
  }

  try {
    const backlog = await readOrderEmailBacklog(deps.store, ORDER_EMAIL_OPS_LIMITS.backlogAgeSeconds);
    if (backlog.length > 0) {
      result.backlogAlerted = await sendOnce(deps, 'order_email_backlog', orderEmailBacklogMail(backlog));
    }
  } catch (error) {
    result.failedChecks.push('backlog');
    logFailure('backlog', error);
  }

  try {
    const { emails, total } = await listUnnotifiedDeadOrderEmails(deps.store, ORDER_EMAIL_OPS_LIMITS.digestLimit);
    if (emails.length > 0 && (await sendOnce(deps, 'order_email_dead', orderEmailDeadDigestMail(emails, total)))) {
      // 印付けに失敗したら、1時間後の点検で同じ分を知らせ直す（知らせを失うより再送を選ぶ）
      result.deadNotified = await markDeadOrderEmailsNotified(deps.store, emails.map((email) => email.id));
    }
  } catch (error) {
    result.failedChecks.push('dead');
    logFailure('dead', error);
  }

  try {
    const { emails, total } = await listUnnotifiedDeliveryProblems(deps.store, ORDER_EMAIL_OPS_LIMITS.digestLimit);
    if (emails.length > 0 && (await sendOnce(deps, 'order_email_delivery_problem', orderEmailDeliveryProblemMail(emails, total)))) {
      result.deliveryNotified = await markDeliveryProblemsNotified(deps.store, emails.map((email) => email.id));
    }
  } catch (error) {
    result.failedChecks.push('delivery');
    logFailure('delivery', error);
  }

  try {
    const lastSucceededAt = (await readHeartbeats(deps.store)).order_email_worker?.lastSucceededAt ?? null;
    if (lastSucceededAt && deps.now().getTime() - lastSucceededAt.getTime() >= ORDER_EMAIL_OPS_LIMITS.staleAfterSeconds * 1000) {
      result.staleAlerted = await sendOnce(deps, 'job_stale_order_email_worker', staleJobMail('order_email_worker', lastSucceededAt));
    }
  } catch (error) {
    result.failedChecks.push('stale');
    logFailure('stale', error);
  }

  return result;
}
```

`src/lib/orders/email/order-email-worker.ts` の `runOrderEmailWorker` を次にする（`import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';` を足す）:

```ts
/** 本物の依存で1回動かし、最後の成功を記録する（取り出しに失敗したときだけ失敗） */
export async function runOrderEmailWorker(options: { budgetMs?: number } = {}): Promise<OrderEmailWorkerResult> {
  const client = await createServiceRoleClient();
  const store = client as unknown as OrderEmailStore & OpsStore;
  const result = await processOrderEmails({
    store,
    loadMaterial: (orderId) => loadOrderEmailMaterial(client, orderId),
    send: (message) => sendOrderEmailMessage(message),
    checkConfig: () => checkOrderEmailSendConfig(),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? ORDER_EMAIL_WORKER_BUDGET_MS,
  });

  const claimFailed = result.stoppedBy === 'claim_error';
  try {
    await recordHeartbeat(store, 'order_email_worker', !claimFailed, claimFailed ? 'db_unavailable' : null);
  } catch (error) {
    console.error('[order-email-worker] failed to record heartbeat', errorName(error));
  }
  return result;
}
```

Run: `npx jest tests/unit/lib/orders/email tests/unit/lib/ops --runInBand`
Expected: PASS（今の `ops-checks`・`ops-alert-mail` の試験も通る）

- [ ] **Step 3: worker の起動と窓口の試験を書く**

`tests/unit/lib/stripe/webhook-worker.test.ts`:

1. `jest.mock` の並びに足す:

```ts
const mockRunOrderEmailWorker = jest.fn();
jest.mock('@/lib/orders/email/order-email-worker', () => ({
  ORDER_EMAIL_WORKER_BUDGET_MS: 10_000,
  runOrderEmailWorker: (...args: unknown[]) => mockRunOrderEmailWorker(...args),
}));
const mockRunOrderEmailOpsChecks = jest.fn();
jest.mock('@/lib/orders/email/order-email-ops', () => ({
  runOrderEmailOpsChecks: (...args: unknown[]) => mockRunOrderEmailOpsChecks(...args),
}));
```

2. `const CHECKS = ...` の下に足し、`beforeEach` で返す値を決める:

```ts
const EMAILS = { sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' };
const EMAIL_CHECKS = { pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [] };
```

```ts
    mockRunOrderEmailWorker.mockResolvedValue(EMAILS);
    mockRunOrderEmailOpsChecks.mockResolvedValue(EMAIL_CHECKS);
```

3. 「約45秒の予算で処理し、成功を記録して点検する」を次にする:

```ts
  it('Stripe の知らせに35秒、注文のメールに10秒を使い、成功を記録して両方を点検する', async () => {
    mockDrain.mockResolvedValue({ processed: 2, failed: 0, stoppedBy: 'empty' });

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });

    expect(WORKER_TIME_BUDGET_MS).toBe(35_000);
    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore, budgetMs: 35_000 }));
    expect(mockRunOrderEmailWorker).toHaveBeenCalledWith({ budgetMs: 10_000 });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty', checks: CHECKS, emails: EMAILS, emailChecks: EMAIL_CHECKS });
  });

  it('注文のメールの worker が投げても、点検まで続ける', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockRunOrderEmailWorker.mockRejectedValueOnce(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });

    expect(result.emails).toBeNull();
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled();
    error.mockRestore();
  });
```

ほかの試験の `toEqual({ ..., checks: CHECKS })` は `toMatchObject` にするか、`emails: EMAILS, emailChecks: EMAIL_CHECKS` を足す。

窓口の4つの試験ファイル（`tests/unit/api/checkout/complete-route.test.ts`・`tests/unit/api/admin/order-status-shipped.test.ts`・`tests/unit/api/admin/order-attention-route.test.ts`・`tests/unit/api/cron/expire-pending-orders-route.test.ts`）の `jest.mock` の並びに足す:

```ts
const mockScheduleOrderEmailDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockScheduleOrderEmailDelivery(...args),
}));
```

そして次の確かめを足す（`beforeEach` の `jest.clearAllMocks()` が回数を戻す。無いファイルは `mockScheduleOrderEmailDelivery.mockClear()` を `beforeEach` に足す）:

| ファイル | 試験 | 足す確かめ |
|---|---|---|
| `complete-route.test.ts` | 「決済完了の Session は照合関数に任せ、注文 ID・状態・支払方法を返す」 | `expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);` |
| 同上 | 「照合の一時的な失敗は 503 を返す」 | `expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();` |
| `order-status-shipped.test.ts` | 「paid の注文を発送済みにできる」 | `expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);` |
| 同上 | 「更新対象が無ければ 409 を返し、…」 | `expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();` |
| 同上 | 「支払い手続き中の注文は、開いている決済を失効させてから、…照合する」（取消になる試験） | `expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);` |
| `order-attention-route.test.ts` | 解決の試験で `notifyCustomer` を変える `it.each` | `expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);`（取り消して解決したら、知らせるかどうかにかかわらず1回） |
| 同上 | 「メモを付けて解決済みにする」（取り消さない） | `expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();` |
| `expire-pending-orders-route.test.ts` | 「照合の結果を種類ごとに数え、1件の失敗で残りを止めない」 | `expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);` |

`expire-pending-orders-route.test.ts` には、さらに次の mock を足し、同じ試験に `expect(mockRunOrderEmailOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ now: expect.any(Function) }));` を足す:

```ts
const mockRunOrderEmailOpsChecks = jest.fn().mockResolvedValue({
  pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [],
});
jest.mock('@/lib/orders/email/order-email-ops', () => ({
  runOrderEmailOpsChecks: (...args: unknown[]) => mockRunOrderEmailOpsChecks(...args),
}));
```

Run: `npx jest tests/unit/lib/stripe/webhook-worker tests/unit/api --runInBand`
Expected: FAIL（予算がまだ45秒・worker を呼んでいない・予定を呼んでいない）

- [ ] **Step 4: worker の起動と窓口を直す**

`src/lib/stripe/webhook-worker.ts`:

```ts
import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';
import type { WebhookEventStore } from '@/lib/stripe/webhook-events';
import { drainWebhookQueue, type DrainResult } from '@/lib/stripe/webhook-drain';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { runOpsChecks, type OpsCheckResult } from '@/lib/ops/ops-checks';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import {
  ORDER_EMAIL_WORKER_BUDGET_MS,
  runOrderEmailWorker,
  type OrderEmailWorkerResult,
} from '@/lib/orders/email/order-email-worker';
import { runOrderEmailOpsChecks, type OrderEmailOpsResult } from '@/lib/orders/email/order-email-ops';
import type { OrderEmailStore } from '@/lib/orders/email/order-email-store';

/**
 * 1回の起動で Stripe の知らせを続けて処理する時間（設計書 2026-10-05 グループ B の 3-1）。
 * 続けて注文のメールに10秒を使い（グループ D 設計書 4-7）、合わせて入口の maxDuration 60 秒に余裕を持たせる。
 */
export const WORKER_TIME_BUDGET_MS = 35_000;

export type WorkerRunResult = DrainResult & {
  checks: OpsCheckResult;
  emails: OrderEmailWorkerResult | null;
  emailChecks: OrderEmailOpsResult;
};

/**
 * worker の1回の起動。毎分の定期処理と、受け取り口の after() の両方から呼ぶ。
 * Stripe の知らせを先に、注文のメールを後に処理し、最後の成功を記録し、点検して店へ知らせる。
 */
export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult> {
  const store = (await createServiceRoleClient()) as unknown as WebhookEventStore & OpsStore & OrderEmailStore;
  // 監査の IP・User-Agent を定期処理のものと誤らないよう、空のヘッダーの要求で処理する（今までどおり）
  const auditRequest = new NextRequest(new URL('/api/webhook/stripe', options.requestUrl));

  const drain = await drainWebhookQueue({
    store,
    process: (event) => processStripeWebhookEvent(event, auditRequest),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? WORKER_TIME_BUDGET_MS,
  });

  const claimFailed = drain.stoppedBy === 'claim_error';
  try {
    await recordHeartbeat(store, 'webhook_worker', !claimFailed, claimFailed ? 'db_unavailable' : null);
  } catch (error) {
    console.error('[stripe-webhook-worker] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }

  let emails: OrderEmailWorkerResult | null = null;
  try {
    emails = await runOrderEmailWorker({ budgetMs: ORDER_EMAIL_WORKER_BUDGET_MS });
  } catch (error) {
    console.error('[stripe-webhook-worker] Order email worker failed', error instanceof Error ? error.name : 'UnknownError');
  }

  const checks = await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  const emailChecks = await runOrderEmailOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  return { ...drain, checks, emails, emailChecks };
}
```

`src/app/api/checkout/complete/route.ts`: `import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';` を足し、照合の `try { result = await reconcileCheckoutPayment(...) } catch {...}` の直後に次を足す:

```ts
    // 照合が書いた注文のメール（入金済み・入金待ち）を、返事の後に送る（グループ D 設計書 4-7）
    scheduleOrderEmailDelivery();
```

`src/app/api/admin/orders/[id]/status/route.ts`: 同じ import を足し、発送の成功の監査の後と、`respondToCancelResult` の `result.orderStatus === 'cancelled'` の分岐の監査の後に `scheduleOrderEmailDelivery();` を足す。

`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`: 同じ import を足し、成功の監査の前に次を足す:

```ts
    if (row.cancelled_from) {
      // 取消のメールは在庫を戻す関数が同じ取引で行を書いた（知らせる時だけ）。返事の後に送る
      scheduleOrderEmailDelivery();
    }
```

`src/app/api/cron/expire-pending-orders/route.ts`: 同じ import と `import { runOrderEmailOpsChecks } from '@/lib/orders/email/order-email-ops';`・`import type { OrderEmailStore } from '@/lib/orders/email/order-email-store';` を足す。点検の関数（`runOpsChecks` を呼ぶ所）で、`runOpsChecks` の後に `await runOrderEmailOpsChecks({ store: store as unknown as OpsStore & OrderEmailStore, send: sendOpsAlertMail, now: () => new Date() });` を呼ぶ（`runOpsChecks` の戻り値はそのまま返す）。最後の `return NextResponse.json(summary);` の直前に `scheduleOrderEmailDelivery();` を足す（見回りの照合が書いた期限切れ・入金済みのメールを送る）。

Run: `npx jest tests/unit --runInBand`
Expected: PASS
Run: `npm run typecheck` と `npm run lint`
Expected: エラー0件

- [ ] **Step 5: コミット（controller）**

```bash
git add src/lib/orders/email/order-email-ops.ts src/lib/orders/email/order-email-store.ts src/lib/orders/email/order-email-worker.ts src/lib/ops/ops-store.ts src/lib/ops/ops-checks.ts src/lib/ops/ops-alert-mail.ts src/lib/stripe/webhook-worker.ts src/app/api/checkout/complete/route.ts "src/app/api/admin/orders/[id]/status/route.ts" "src/app/api/admin/payment-exceptions/[id]/resolve/route.ts" src/app/api/cron/expire-pending-orders/route.ts tests/unit/lib/orders/email/order-email-ops.test.ts tests/unit/lib/orders/email/order-email-worker.test.ts tests/unit/lib/ops/ops-alert-mail.test.ts tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/api/checkout/complete-route.test.ts tests/unit/api/admin/order-status-shipped.test.ts tests/unit/api/admin/order-attention-route.test.ts tests/unit/api/cron/expire-pending-orders-route.test.ts
git commit -m "feat(orders): 注文のメールの worker を毎分と窓口の後に動かし、店へ知らせる（グループ D）"
```

---

### Task 5: 配達の状態（Resend の知らせの受け口と1時間ごとの見回り）

**Files:**
- Create: `src/lib/webhooks/svix.ts`
- Create: `src/lib/orders/email/order-email-delivery.ts`
- Create: `src/app/api/webhook/resend-delivery/route.ts`
- Modify: `src/lib/orders/email/order-email-store.ts`（配達の状態の関数を足す）
- Modify: `src/app/api/contact/inbound/route.ts`（署名の確かめを共通の部品にする。動きは変えない）
- Modify: `src/lib/stripe/webhook-worker.ts`（1時間ごとの見回り）・`src/proxy.ts`（説明書き）
- Test: `tests/unit/lib/webhooks/svix.test.ts`・`tests/unit/lib/orders/email/order-email-delivery.test.ts`・`tests/unit/api/webhook/resend-delivery-route.test.ts`（すべて新規）、`tests/unit/lib/stripe/webhook-worker.test.ts`・`tests/unit/middleware/proxy-origin.test.ts`

**Interfaces:**
- Consumes: Task 1 の `record_order_email_delivery`・`list_order_emails_awaiting_delivery`、Task 2 の `callOrderEmailRpc`・`rowsOf`・`OrderEmailDeliveryStatus`、Task 4 の `OpsJob`（`order_email_delivery_check`）・`WorkerRunResult`、既存の `readHeartbeats`・`recordHeartbeat`・`resolveMailProvider`
- Produces:
  - `svix.ts`: `SVIX_TOLERANCE_SECONDS = 300`・`verifySvixSignature(secret, svixId, svixTimestamp, svixSignatureHeader, payload): boolean`・`isSvixTimestampFresh(svixTimestamp, nowMs?): boolean`
  - `order-email-delivery.ts`: `MAX_DELIVERY_WEBHOOK_BYTES = 65_536`・`DELIVERY_CHECK_INTERVAL_MS = 3_600_000`・`DELIVERY_CHECK_LIMIT = 50`・`parseDeliveryEvent(payload): ParsedDeliveryEvent`・`checkOrderEmailDeliveries(deps)`・`createResendLastEventReader(apiKey)`・`runOrderEmailDeliveryCheckIfDue(store, options?)`
  - `order-email-store.ts`: `recordOrderEmailDelivery(store, { svixId, providerMessageId, status, eventAt }): Promise<'updated' | 'stale' | 'duplicate' | 'unknown_email'>`・`listOrderEmailsAwaitingDelivery(store, limit): Promise<Array<{ id: string; providerMessageId: string }>>`
  - 窓口 `POST /api/webhook/resend-delivery`（環境変数 `RESEND_DELIVERY_WEBHOOK_SECRET`）。応答: 鍵が無い 503、大きすぎる 413、署名の見出しが無い・`svix-id` が長すぎる・本文が読めない 400、署名か時刻が合わない 401、受けない種類 200 `{ received: true, ignored: true }`、記録できた（重複・知らないメールを含む）200 `{ received: true }`、DB の失敗 500

- [ ] **Step 1: 試験を書く**

`tests/unit/lib/webhooks/svix.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { isSvixTimestampFresh, verifySvixSignature } from '@/lib/webhooks/svix';

const KEY = Buffer.from('svix-test-secret-0123456789').toString('base64');
const SECRET = `whsec_${KEY}`;

function sign(secret: string, id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
}

describe('verifySvixSignature', () => {
  const id = 'msg_1';
  const timestamp = '1760000000';
  const payload = '{"type":"email.delivered"}';

  it('届いたままの本文で作った署名を通す', () => {
    expect(verifySvixSignature(SECRET, id, timestamp, sign(SECRET, id, timestamp, payload), payload)).toBe(true);
  });

  it('本文が1文字でも違えば断る', () => {
    expect(verifySvixSignature(SECRET, id, timestamp, sign(SECRET, id, timestamp, payload), `${payload} `)).toBe(false);
  });

  it('鍵の作り直しの間は署名が並ぶ。どれか1つが合えば通す', () => {
    const old = sign(`whsec_${Buffer.from('old-secret').toString('base64')}`, id, timestamp, payload);
    expect(verifySvixSignature(SECRET, id, timestamp, `${old} ${sign(SECRET, id, timestamp, payload)}`, payload)).toBe(true);
    expect(verifySvixSignature(SECRET, id, timestamp, old, payload)).toBe(false);
  });
});

describe('isSvixTimestampFresh', () => {
  const now = 1_760_000_000_000;

  it('前後5分までを通す', () => {
    expect(isSvixTimestampFresh(String(now / 1000 - 300), now)).toBe(true);
    expect(isSvixTimestampFresh(String(now / 1000 + 300), now)).toBe(true);
    expect(isSvixTimestampFresh(String(now / 1000 - 301), now)).toBe(false);
    expect(isSvixTimestampFresh(String(now / 1000 + 301), now)).toBe(false);
    expect(isSvixTimestampFresh('soon', now)).toBe(false);
  });
});
```

`tests/unit/lib/orders/email/order-email-delivery.test.ts`:

```ts
import {
  checkOrderEmailDeliveries,
  parseDeliveryEvent,
  runOrderEmailDeliveryCheckIfDue,
  type LastEventReader,
} from '@/lib/orders/email/order-email-delivery';

const NOW = new Date('2026-10-09T12:00:00Z');

describe('parseDeliveryEvent（設計書 6-3）', () => {
  it.each([
    ['email.delivered', 'delivered'],
    ['email.delivery_delayed', 'delayed'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.suppressed', 'suppressed'],
    ['email.failed', 'failed'],
  ])('%s は %s', (type, status) => {
    expect(parseDeliveryEvent({ type, created_at: '2026-10-09T01:00:00.000Z', data: { email_id: 're_1' } })).toEqual({
      kind: 'delivery', status, providerMessageId: 're_1', eventAt: new Date('2026-10-09T01:00:00.000Z'),
    });
  });

  it('受けない種類は無視する（Object の名前も知らない種類として扱う）', () => {
    expect(parseDeliveryEvent({ type: 'email.opened', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } })).toEqual({ kind: 'ignored' });
    expect(parseDeliveryEvent({ type: 'constructor', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } })).toEqual({ kind: 'ignored' });
  });

  it('形の違う知らせは invalid', () => {
    expect(parseDeliveryEvent(null)).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: {} })).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: 'yesterday', data: { email_id: 're_1' } })).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: { email_id: 'x'.repeat(201) } })).toEqual({ kind: 'invalid' });
  });
});

function fakeStore(awaiting: Array<{ email_id: string; provider_message_id: string }>, heartbeats: unknown[] = []) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    switch (name) {
      case 'list_order_emails_awaiting_delivery':
        return { data: awaiting, error: null };
      case 'record_order_email_delivery':
        return { data: 'updated', error: null };
      case 'get_ops_heartbeats':
        return { data: heartbeats, error: null };
      default:
        return { data: null, error: null };
    }
  });
  return { store: { rpc } as never, calls };
}

describe('checkOrderEmailDeliveries', () => {
  it('状態の決まっていないメールを Resend で読み、分かった状態を今の時刻で記録する', async () => {
    const { store, calls } = fakeStore([
      { email_id: 'email-1', provider_message_id: 're_1' },
      { email_id: 'email-2', provider_message_id: 're_2' },
    ]);
    const readLastEvent: LastEventReader = jest.fn(async (id: string) =>
      id === 're_1' ? { ok: true as const, status: 'delivered' as const } : { ok: true as const, status: null });

    await expect(checkOrderEmailDeliveries({ store, readLastEvent, now: () => NOW, limit: 50 })).resolves.toEqual({
      checked: 2, updated: 1, failed: 0, configError: false,
    });
    expect(calls.find((call) => call.name === 'list_order_emails_awaiting_delivery')?.params).toEqual({ _limit: 50 });
    expect(calls.find((call) => call.name === 'record_order_email_delivery')?.params).toEqual({
      _svix_id: null, _provider_message_id: 're_1', _delivery_status: 'delivered', _event_at: NOW.toISOString(),
    });
  });

  it('鍵が送信専用などで読めなければ、そこで止めて設定の問題を返す', async () => {
    const { store, calls } = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }, { email_id: 'email-2', provider_message_id: 're_2' }]);
    const readLastEvent: LastEventReader = jest.fn(async () => ({ ok: false as const, configError: true }));

    await expect(checkOrderEmailDeliveries({ store, readLastEvent, now: () => NOW, limit: 50 })).resolves.toMatchObject({ configError: true });
    expect(readLastEvent).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.name)).not.toContain('record_order_email_delivery');
  });
});

describe('runOrderEmailDeliveryCheckIfDue', () => {
  const RESEND = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM_ADDRESS: 'shop@example.com' };

  it('送り手が Resend でなければ何もしない', async () => {
    const { store, calls } = fakeStore([]);
    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: { NODE_ENV: 'production', MAIL_PROVIDER: 'local' }, now: () => NOW })).resolves.toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('最後に動いてから1時間たっていなければ動かない', async () => {
    const { store, calls } = fakeStore([], [
      { job: 'order_email_delivery_check', last_succeeded_at: null, last_failed_at: '2026-10-09T11:30:00Z', last_error_code: 'config_api_key' },
    ]);
    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: RESEND, now: () => NOW })).resolves.toBe('not_due');
    expect(calls.map((call) => call.name)).toEqual(['get_ops_heartbeats']);
  });

  it('動いたら最後の成功を記録する。鍵の問題なら失敗と原因の記号を記録する', async () => {
    const ok = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);
    await expect(runOrderEmailDeliveryCheckIfDue(ok.store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: true, status: 'delivered' }),
    })).resolves.toBe('done');
    expect(ok.calls.find((call) => call.name === 'record_ops_heartbeat')?.params).toEqual({
      _job: 'order_email_delivery_check', _succeeded: true, _error_code: null,
    });

    const denied = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);
    await expect(runOrderEmailDeliveryCheckIfDue(denied.store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: false, configError: true }),
    })).resolves.toBe('failed');
    expect(denied.calls.find((call) => call.name === 'record_ops_heartbeat')?.params).toEqual({
      _job: 'order_email_delivery_check', _succeeded: false, _error_code: 'config_api_key',
    });
  });
});
```

`tests/unit/api/webhook/resend-delivery-route.test.ts`:

```ts
/** @jest-environment node */
import { createHmac } from 'node:crypto';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));

import { POST } from '@/app/api/webhook/resend-delivery/route';

const SECRET = `whsec_${Buffer.from('resend-delivery-test-secret').toString('base64')}`;

function sign(id: string, timestamp: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function deliveryRequest(
  body: string,
  options: { id?: string; timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
): Request {
  const id = options.id ?? 'msg_1';
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new Request('http://localhost/api/webhook/resend-delivery', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': options.signature ?? sign(id, timestamp, body),
      ...options.headers,
    },
    body,
  });
}

const DELIVERED = JSON.stringify({
  type: 'email.delivered',
  created_at: '2026-10-09T01:00:00.000Z',
  data: { email_id: 're_1', to: ['hanako@example.com'], subject: '件名' },
});

describe('POST /api/webhook/resend-delivery', () => {
  const saved = process.env.RESEND_DELIVERY_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = SECRET;
    mockRpc.mockResolvedValue({ data: 'updated', error: null });
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
    else process.env.RESEND_DELIVERY_WEBHOOK_SECRET = saved;
  });

  it('正しい署名の配達の知らせを、知らせの番号つきで記録して 200 を返す', async () => {
    const response = await POST(deliveryRequest(DELIVERED));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockRpc).toHaveBeenCalledWith('record_order_email_delivery', {
      _svix_id: 'msg_1', _provider_message_id: 're_1', _delivery_status: 'delivered', _event_at: '2026-10-09T01:00:00.000Z',
    });
  });

  it('同じ知らせの2回目・知らないメールも 200 を返す（送り直させない）', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'duplicate', error: null });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(200);
    mockRpc.mockResolvedValueOnce({ data: 'unknown_email', error: null });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(200);
  });

  it('鍵の作り直しの間に並んだ署名のどれかが合えば通す', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const old = sign('msg_1', timestamp, DELIVERED, `whsec_${Buffer.from('old').toString('base64')}`);
    const response = await POST(deliveryRequest(DELIVERED, { timestamp, signature: `${old} ${sign('msg_1', timestamp, DELIVERED)}` }));
    expect(response.status).toBe(200);
  });

  it('署名が合わない・時刻が5分より古いなら 401 で、DB に触れない', async () => {
    expect((await POST(deliveryRequest(DELIVERED, { signature: 'v1,AAAA' }))).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    expect((await POST(deliveryRequest(DELIVERED, { timestamp: old, signature: sign('msg_1', old, DELIVERED) }))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('署名の見出しが無い・知らせの番号が長すぎるなら 400', async () => {
    const missing = new Request('http://localhost/api/webhook/resend-delivery', { method: 'POST', body: DELIVERED });
    expect((await POST(missing)).status).toBe(400);
    const longId = 'x'.repeat(201);
    expect((await POST(deliveryRequest(DELIVERED, { id: longId }))).status).toBe(400);
  });

  it('64KB を超える本文は 413', async () => {
    const big = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1', pad: 'x'.repeat(70_000) } });
    expect((await POST(deliveryRequest(big))).status).toBe(413);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('受けない種類は記録せずに 200、形の違う本文は 400', async () => {
    const opened = JSON.stringify({ type: 'email.opened', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } });
    const ignored = await POST(deliveryRequest(opened));
    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toEqual({ received: true, ignored: true });

    const broken = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: {} });
    expect((await POST(deliveryRequest(broken))).status).toBe(400);
    expect((await POST(deliveryRequest('not json'))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('鍵が無ければ 503、DB の失敗は 500（Svix が送り直す）', async () => {
    delete process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(503);

    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = SECRET;
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down', code: '08006' } });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(500);
    error.mockRestore();
  });
});
```

`tests/unit/lib/stripe/webhook-worker.test.ts` に mock と確かめを足す:

```ts
const mockRunOrderEmailDeliveryCheckIfDue = jest.fn();
jest.mock('@/lib/orders/email/order-email-delivery', () => ({
  runOrderEmailDeliveryCheckIfDue: (...args: unknown[]) => mockRunOrderEmailDeliveryCheckIfDue(...args),
}));
```

`beforeEach` に `mockRunOrderEmailDeliveryCheckIfDue.mockResolvedValue('not_due');` を足し、Task 4 で直した最初の試験に `expect(mockRunOrderEmailDeliveryCheckIfDue).toHaveBeenCalledWith(mockStore);` を足す。次の試験も足す:

```ts
  it('配達の見回りが投げても、点検まで続ける', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockRunOrderEmailDeliveryCheckIfDue.mockRejectedValueOnce(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runWebhookWorker({ requestUrl: 'http://localhost/x' });

    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled();
    error.mockRestore();
  });
```

`tests/unit/middleware/proxy-origin.test.ts` の `test.each(['/api/webhook/stripe', '/api/contact/inbound', '/api/cron/meta-kpi-sync'])` に `'/api/webhook/resend-delivery'` を足す。

Run: `npx jest tests/unit/lib/webhooks tests/unit/lib/orders/email/order-email-delivery tests/unit/api/webhook/resend-delivery-route tests/unit/lib/stripe/webhook-worker tests/unit/middleware/proxy-origin --runInBand`
Expected: FAIL（モジュールが無い。proxy の試験は今の除外で通る）

- [ ] **Step 2: 署名の部品を書き、お問い合わせの受け口をそれに替える**

`src/lib/webhooks/svix.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix の署名の確かめ（Resend の Webhook。お問い合わせの返信と、注文のメールの配達の状態）。
 * 届いたままの本文で HMAC-SHA256 を作り、時間差の出ない比べ方で比べる。
 * 鍵の作り直しの24時間は署名が空白で並ぶので、どれか1つが合えば通す（グループ D 設計書 6-2）。
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignatureHeader: string,
  payload: string,
): boolean {
  const secretKey = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const secretBytes = Buffer.from(secretKey, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const providedSignatures = svixSignatureHeader
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((value): value is string => Boolean(value));

  const expectedBuffer = Buffer.from(expected);
  return providedSignatures.some((signature) => {
    const provided = Buffer.from(signature);
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });
}

/** 前後5分を過ぎた知らせは断る（使い回しを防ぐ） */
export function isSvixTimestampFresh(svixTimestamp: string, nowMs: number = Date.now()): boolean {
  const timestamp = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Math.abs(Math.floor(nowMs / 1000) - timestamp) <= SVIX_TOLERANCE_SECONDS;
}
```

`src/app/api/contact/inbound/route.ts`: ファイルの中の `SVIX_TOLERANCE_SECONDS`・`verifySvixSignature`・`isTimestampFresh` と `createHmac`・`timingSafeEqual` の import を消し、`import { isSvixTimestampFresh, verifySvixSignature } from '@/lib/webhooks/svix';` を足す。`isTimestampFresh(svixTimestamp)` の呼び出しを `isSvixTimestampFresh(svixTimestamp)` にする（ほかは変えない）。

- [ ] **Step 3: 配達の状態の関数・読み取り・見回りを書く**

`src/lib/orders/email/order-email-store.ts` の `OrderEmailRpcName` に `| 'record_order_email_delivery' | 'list_order_emails_awaiting_delivery'` を足し、終わりに足す:

```ts
export type OrderEmailDeliveryRecordResult = 'updated' | 'stale' | 'duplicate' | 'unknown_email';

export async function recordOrderEmailDelivery(
  store: OrderEmailStore,
  event: { svixId: string | null; providerMessageId: string; status: OrderEmailDeliveryStatus; eventAt: Date },
): Promise<OrderEmailDeliveryRecordResult> {
  const data = await callOrderEmailRpc(store, 'record_order_email_delivery', {
    _svix_id: event.svixId,
    _provider_message_id: event.providerMessageId,
    _delivery_status: event.status,
    _event_at: event.eventAt.toISOString(),
  });
  if (data === 'updated' || data === 'stale' || data === 'duplicate' || data === 'unknown_email') return data;
  throw new OrderEmailStoreError('record_order_email_delivery', null);
}

export async function listOrderEmailsAwaitingDelivery(
  store: OrderEmailStore,
  limit: number,
): Promise<Array<{ id: string; providerMessageId: string }>> {
  const data = await callOrderEmailRpc(store, 'list_order_emails_awaiting_delivery', { _limit: limit });
  return rowsOf(data).flatMap((row) =>
    typeof row.provider_message_id === 'string' ? [{ id: String(row.email_id), providerMessageId: row.provider_message_id }] : [],
  );
}
```

`src/lib/orders/email/order-email-delivery.ts`:

```ts
import { Resend } from 'resend';
import { resolveMailProvider } from '@/lib/mail';
import { readHeartbeats, recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import {
  listOrderEmailsAwaitingDelivery,
  recordOrderEmailDelivery,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import type { OrderEmailDeliveryStatus } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの配達の状態（グループ D 設計書 6 章）。
 * Resend の知らせ（Webhook）を読み取り、受け口の登録前や長い停止の取りこぼしを1時間ごとの見回りで拾う。
 */
export const MAX_DELIVERY_WEBHOOK_BYTES = 64 * 1024;
export const DELIVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DELIVERY_CHECK_LIMIT = 50;

// Object の名前（constructor など）を種類と取り違えないよう Map で持つ
const EVENT_TYPES = new Map<string, OrderEmailDeliveryStatus>([
  ['email.delivered', 'delivered'],
  ['email.delivery_delayed', 'delayed'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.suppressed', 'suppressed'],
  ['email.failed', 'failed'],
]);

const LAST_EVENTS = new Map<string, OrderEmailDeliveryStatus>([
  ['delivered', 'delivered'],
  ['delivery_delayed', 'delayed'],
  ['bounced', 'bounced'],
  ['complained', 'complained'],
  ['suppressed', 'suppressed'],
  ['failed', 'failed'],
]);

const KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key']);

export type ParsedDeliveryEvent =
  | { kind: 'delivery'; status: OrderEmailDeliveryStatus; providerMessageId: string; eventAt: Date }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

/** Resend の知らせの本文を読む。時刻は知らせの created_at（順番が前後しても新しい方を残すため） */
export function parseDeliveryEvent(payload: unknown): ParsedDeliveryEvent {
  if (!payload || typeof payload !== 'object') return { kind: 'invalid' };
  const { type, created_at: createdAt, data } = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  if (typeof type !== 'string') return { kind: 'invalid' };
  const status = EVENT_TYPES.get(type);
  if (!status) return { kind: 'ignored' };

  const emailId = data && typeof data === 'object' ? (data as { email_id?: unknown }).email_id : undefined;
  if (typeof emailId !== 'string' || emailId.length < 1 || emailId.length > 200) return { kind: 'invalid' };
  const eventAt = typeof createdAt === 'string' ? new Date(createdAt) : null;
  if (!eventAt || Number.isNaN(eventAt.getTime())) return { kind: 'invalid' };

  return { kind: 'delivery', status, providerMessageId: emailId, eventAt };
}

export type LastEventResult = { ok: true; status: OrderEmailDeliveryStatus | null } | { ok: false; configError: boolean };
export type LastEventReader = (providerMessageId: string) => Promise<LastEventResult>;

/** Resend の API でメールの最後の状態を読む。送信専用の鍵では読めない（restricted_api_key） */
export function createResendLastEventReader(apiKey: string): LastEventReader {
  const resend = new Resend(apiKey);
  return async (providerMessageId) => {
    try {
      const { data, error } = await resend.emails.get(providerMessageId);
      if (error) return { ok: false, configError: KEY_ERRORS.has(error.name) };
      return { ok: true, status: LAST_EVENTS.get(data?.last_event ?? '') ?? null };
    } catch {
      return { ok: false, configError: false };
    }
  };
}

export async function checkOrderEmailDeliveries(deps: {
  store: OrderEmailStore;
  readLastEvent: LastEventReader;
  now: () => Date;
  limit: number;
}): Promise<{ checked: number; updated: number; failed: number; configError: boolean }> {
  const result = { checked: 0, updated: 0, failed: 0, configError: false };
  for (const email of await listOrderEmailsAwaitingDelivery(deps.store, deps.limit)) {
    const read = await deps.readLastEvent(email.providerMessageId);
    if (!read.ok) {
      if (read.configError) return { ...result, configError: true };
      result.failed += 1;
      continue;
    }
    result.checked += 1;
    if (!read.status) continue;
    // 見回りの時刻で記録する。これより古い知らせが後から届いても、記録を戻さない
    const recorded = await recordOrderEmailDelivery(deps.store, {
      svixId: null,
      providerMessageId: email.providerMessageId,
      status: read.status,
      eventAt: deps.now(),
    });
    if (recorded === 'updated') result.updated += 1;
  }
  return result;
}

/** 毎分の worker から呼ぶ。送り手が Resend の時だけ、最後に動いてから1時間たっていれば動く（本計画 P13） */
export async function runOrderEmailDeliveryCheckIfDue(
  store: OpsStore & OrderEmailStore,
  options: { env?: Record<string, string | undefined>; now?: () => Date; readLastEvent?: LastEventReader } = {},
): Promise<'skipped' | 'not_due' | 'done' | 'failed'> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  let provider: string;
  try {
    provider = resolveMailProvider(env);
  } catch {
    return 'skipped';
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  if (provider !== 'resend' || !apiKey) return 'skipped';

  const job = (await readHeartbeats(store)).order_email_delivery_check;
  const lastRunAt = Math.max(job?.lastSucceededAt?.getTime() ?? 0, job?.lastFailedAt?.getTime() ?? 0);
  if (lastRunAt > 0 && now().getTime() - lastRunAt < DELIVERY_CHECK_INTERVAL_MS) return 'not_due';

  try {
    const result = await checkOrderEmailDeliveries({
      store,
      readLastEvent: options.readLastEvent ?? createResendLastEventReader(apiKey),
      now,
      limit: DELIVERY_CHECK_LIMIT,
    });
    await recordHeartbeat(store, 'order_email_delivery_check', !result.configError, result.configError ? 'config_api_key' : null);
    return result.configError ? 'failed' : 'done';
  } catch {
    await recordHeartbeat(store, 'order_email_delivery_check', false, 'db_unavailable').catch(() => undefined);
    return 'failed';
  }
}
```

- [ ] **Step 4: 受け口を書き、worker で見回りを動かす**

`src/app/api/webhook/resend-delivery/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { isSvixTimestampFresh, verifySvixSignature } from '@/lib/webhooks/svix';
import { MAX_DELIVERY_WEBHOOK_BYTES, parseDeliveryEvent } from '@/lib/orders/email/order-email-delivery';
import { recordOrderEmailDelivery, type OrderEmailStore } from '@/lib/orders/email/order-email-store';

/**
 * PUBLIC: Resend の配達の状態の知らせ（グループ D 設計書 6-2）。
 * お問い合わせの受け口とは別の鍵（RESEND_DELIVERY_WEBHOOK_SECRET）で、届いたままの本文の Svix 署名を確かめる。
 * 受付済みの番号を書き、配達の状態を1行直すだけにして、すぐ返す。DB の失敗の時だけ 500 を返して送り直してもらう。
 * 宛先・本文はログに出さない。
 */
const MAX_SVIX_ID_LENGTH = 200;

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[resend-delivery] RESEND_DELIVERY_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DELIVERY_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_DELIVERY_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(body);

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature || svixId.length > MAX_SVIX_ID_LENGTH) {
    return NextResponse.json({ error: 'Missing signature headers' }, { status: 400 });
  }
  if (!isSvixTimestampFresh(svixTimestamp) || !verifySvixSignature(secret, svixId, svixTimestamp, svixSignature, rawBody)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const event = parseDeliveryEvent(payload);
  if (event.kind === 'invalid') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  if (event.kind === 'ignored') {
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    await recordOrderEmailDelivery(store, {
      svixId,
      providerMessageId: event.providerMessageId,
      status: event.status,
      eventAt: event.eventAt,
    });
  } catch (error) {
    console.error('[resend-delivery] Failed to record delivery', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to record delivery' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
```

`src/lib/stripe/webhook-worker.ts`: `import { runOrderEmailDeliveryCheckIfDue } from '@/lib/orders/email/order-email-delivery';` を足し、`runOrderEmailWorker` の try の後に足す:

```ts
  try {
    await runOrderEmailDeliveryCheckIfDue(store);
  } catch (error) {
    console.error('[stripe-webhook-worker] Delivery check failed', error instanceof Error ? error.name : 'UnknownError');
  }
```

`src/proxy.ts` の `'/api/webhook',         // Stripe: 署名検証（constructEvent）` を `'/api/webhook',         // Stripe（constructEvent）・Resend の配達の知らせ（Svix）: 署名検証` にする。

Run: Step 1 の Run
Expected: PASS
Run: `npx jest tests/unit --runInBand`、`npm run typecheck`、`npm run lint`
Expected: PASS・エラー0件

- [ ] **Step 5: コミット（controller）**

```bash
git add src/lib/webhooks/svix.ts src/lib/orders/email/order-email-delivery.ts src/lib/orders/email/order-email-store.ts src/app/api/webhook/resend-delivery/route.ts src/app/api/contact/inbound/route.ts src/lib/stripe/webhook-worker.ts src/proxy.ts tests/unit/lib/webhooks/svix.test.ts tests/unit/lib/orders/email/order-email-delivery.test.ts tests/unit/api/webhook/resend-delivery-route.test.ts tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/middleware/proxy-origin.test.ts
git commit -m "feat(orders): Resend の配達の知らせの受け口と1時間ごとの見回りを足す（グループ D）"
```

---

### Task 6: 管理画面の窓口（履歴・中身・再送）

**Files:**
- Create: `src/lib/orders/email/order-history.ts`
- Create: `src/app/api/admin/orders/[id]/history/route.ts`
- Create: `src/app/api/admin/orders/[id]/emails/[emailId]/route.ts`
- Create: `src/app/api/admin/orders/[id]/emails/resend/route.ts`
- Modify: `src/lib/orders/email/order-email-store.ts`（履歴・中身・再送の関数を足す）
- Test: `tests/unit/lib/orders/email/order-history.test.ts`・`tests/unit/api/admin/order-email-routes.test.ts`（どちらも新規）

**Interfaces:**
- Consumes: Task 1 の `request_order_email_resend`・`list_order_email_history`・`list_order_status_history`・`get_order_email_content`・`get_order_email_send_state`、Task 2 の `describeOrderEmailState`・`RESENDABLE_ORDER_STATUSES`・`ORDER_EMAIL_KINDS`・ラベル・`getOrderEmailSendState`・`callOrderEmailRpc`・`rowsOf`・`textOrNull`・`scheduleOrderEmailDelivery`、既存の `authorizeAdminPermission`・`requireCsrfOrDeny`・`enforceRateLimit`・`logAudit`・`toOrderNumber`・`CANCEL_REASON_LABELS`・`SHIPPING_CARRIERS`
- Produces:
  - `order-history.ts`（画面からも使う。サーバーだけの物を import しない）: `ORDER_STATUS_LABELS`・型 `OrderStatusHistoryRow`・`OrderEmailHistoryRow`・`OrderHistoryEntry`（`created`・`status`・`email`）・`OrderHistoryEmailEntry`・`OrderHistoryResponse`・`OrderEmailContentResponse`・関数 `buildOrderHistory(input)`
  - `order-email-store.ts`: `OrderEmailResendError`（`reason: 'not_allowed' | 'already_queued' | 'order_not_found'`）・`requestOrderEmailResend(store, { orderId, kind, actorId }): Promise<string>`・`listOrderEmailHistory(store, orderId)`・`listOrderStatusHistory(store, orderId)`・`getOrderEmailContent(store, orderId, emailId)`
  - `GET /api/admin/orders/[id]/history` → `OrderHistoryResponse`（`admin.orders.read`。400・404・500）
  - `GET /api/admin/orders/[id]/emails/[emailId]` → `{ status: 'available', subject, bodyText, sentAt } | { status: 'erased', sentAt }`（`admin.orders.read`。400・404）
  - `POST /api/admin/orders/[id]/emails/resend`（本文 `{ kind }`）→ 200 `{ success: true, emailId }`（`admin.orders.manage`・CSRF・回数の制限・監査 `admin.orders.email.resend`）。409 の文言: 送信待ちの再送がある `同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。`・状態が合わない `今の注文の状態では、このメールは再送できません。`。404 `注文が見つかりません。`。500 `再送を受け付けられませんでした。`

- [ ] **Step 1: 履歴の組み立ての試験を書く**

`tests/unit/lib/orders/email/order-history.test.ts`:

```ts
import { buildOrderHistory, type OrderEmailHistoryRow } from '@/lib/orders/email/order-history';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const NOT_PAUSED = { paused: false, reason: null, pausedAt: null, nextProbeAt: null };

function email(overrides: Partial<OrderEmailHistoryRow> = {}): OrderEmailHistoryRow {
  return {
    id: 'email-1', kind: 'paid', origin: 'auto', requestedByEmail: null, status: 'sent', attempts: 1, lastErrorCode: null,
    deliveryStatus: null, deliveryEventAt: null, createdAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:05.000Z',
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, ...overrides,
  };
}

describe('buildOrderHistory', () => {
  it('受付・状態の変化・メールを新しい順に並べ、宛先と注文番号を出す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'shipped', shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_ship_paid_order',
          actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
        },
        {
          changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
      emailRows: [email({ deliveryStatus: 'delivered', deliveryEventAt: '2026-10-09T01:01:00.000Z' })],
      sendState: NOT_PAUSED,
    });

    expect(history.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '発送済み', recipient: 'hanako@example.com' });
    expect(history.sendPaused).toBeNull();
    expect(history.entries.map((entry) => entry.type)).toEqual(['status', 'email', 'status', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-10T02:00:00.000Z', fromLabel: '決済完了', toLabel: '発送済み',
      actorEmail: 'admin@example.com', detail: '配送業者: ヤマト運輸 / 伝票番号: 1234-5678',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'email', kindLabel: '注文確認', stateLabel: '配達済み', warning: false, manual: false, canViewContent: true, resendable: true,
    });
  });

  it('取消は理由を出す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'cancelled', shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'pending', toStatus: 'cancelled', changeReason: 'admin_cancel',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: 'customer_request',
      }],
      emailRows: [],
      sendState: NOT_PAUSED,
    });

    expect(history.entries[0]).toMatchObject({ fromLabel: '未決済', toLabel: 'キャンセル', detail: '理由: お客様の依頼' });
  });

  it('再送できるのは、送信済み・送れなかった行で、今の注文の状態で意味のある種類だけ。同じ種類の手の再送が送信待ちなら押せない', () => {
    const order = { id: ORDER_ID, status: 'paid' as const, shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' };

    const rows = (extra: OrderEmailHistoryRow[]) =>
      buildOrderHistory({ order, statusRows: [], emailRows: extra, sendState: NOT_PAUSED }).entries.filter((entry) => entry.type === 'email');

    expect(rows([email({ status: 'dead', lastErrorCode: 'invalid_message', hasBody: false })])[0]).toMatchObject({
      resendable: true, stateLabel: '送れなかった', warning: true, errorLabel: '宛先の形が不正', canViewContent: false,
    });
    expect(rows([email({ kind: 'awaiting_payment', status: 'sent' })])[0]).toMatchObject({ resendable: false });
    expect(rows([email({ status: 'skipped', lastErrorCode: 'superseded' })])[0]).toMatchObject({
      resendable: false, stateLabel: '取りやめ', errorLabel: '注文の状態が変わったため',
    });
    const withOpenManual = rows([
      email({ id: 'email-2', origin: 'manual', requestedByEmail: 'admin@example.com', status: 'pending', sentAt: null, hasBody: false }),
      email(),
    ]);
    expect(withOpenManual.map((entry) => entry.resendable)).toEqual([false, false]);
    expect(withOpenManual[0]).toMatchObject({ manual: true, requestedByEmail: 'admin@example.com', stateLabel: '送信待ち' });
  });

  it('送信を止めていれば、その原因の名前を返す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'paid', shippingEmail: null, createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [],
      emailRows: [],
      sendState: { paused: true, reason: 'quota_daily' },
    });

    expect(history.sendPaused).toEqual({ reasonLabel: '1日の送信の上限' });
    expect(history.order.recipient).toBeNull();
  });
});
```

- [ ] **Step 2: 窓口の試験を書く**

`tests/unit/api/admin/order-email-routes.test.ts`:

```ts
/** @jest-environment node */
const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockSchedule = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockSchedule(...args),
}));
const mockRpc = jest.fn();
const mockMaybeSingle = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }) }) }),
  })),
}));

import { GET as getHistory } from '@/app/api/admin/orders/[id]/history/route';
import { GET as getContent } from '@/app/api/admin/orders/[id]/emails/[emailId]/route';
import { POST as postResend } from '@/app/api/admin/orders/[id]/emails/resend/route';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const EMAIL_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe('GET /api/admin/orders/[id]/history', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/history`);

  it('注文を見る権限で、履歴を新しい順に返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    rpcReturns({
      list_order_status_history: { data: [{
        changed_at: '2026-10-09T01:00:00.000Z', from_status: 'payment_in_progress', to_status: 'paid', change_reason: 'stripe_payment_paid',
        actor_email: null, shipping_carrier: null, tracking_number: null, cancel_reason: null,
      }] },
      list_order_email_history: { data: [{
        email_id: EMAIL_ID, kind: 'paid', variant: 'order_confirmed', origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1,
        last_error_code: null, delivery_status: null, delivery_event_at: null, created_at: '2026-10-09T01:00:00.000Z',
        sent_at: '2026-10-09T01:00:05.000Z', finished_at: '2026-10-09T01:00:05.000Z', has_body: true, body_erased: false,
      }] },
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
    });

    const response = await getHistory(request(), context);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' });
    expect(body.entries.map((entry: { type: string }) => entry.type)).toEqual(['email', 'status', 'created']);
    expect(body.entries[0]).toMatchObject({ emailId: EMAIL_ID, stateLabel: '送信済み', resendable: true });
    expect(JSON.stringify(body)).not.toContain('order_confirmed');
  });

  it('権限が無ければ認可の応答、注文番号の形が違えば 400、無ければ 404、DB の失敗は 500', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });
    expect((await getHistory(request(), context)).status).toBe(403);

    expect((await getHistory(request(), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);

    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await getHistory(request(), context)).status).toBe(404);

    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
    rpcReturns({ list_order_status_history: { data: null, error: { message: 'down', code: '08006' } } });
    expect((await getHistory(request(), context)).status).toBe(500);
    error.mockRestore();
  });
});

describe('GET /api/admin/orders/[id]/emails/[emailId]', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID, emailId: EMAIL_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/${EMAIL_ID}`);

  it('送信済みのメールの件名と本文を返す', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: '件名', body_text: '本文', sent_at: '2026-10-09T01:00:05.000Z', body_erased: false }] } });

    const response = await getContent(request(), context);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
    expect(mockRpc).toHaveBeenCalledWith('get_order_email_content', { _order_id: ORDER_ID, _email_id: EMAIL_ID });
    await expect(response.json()).resolves.toEqual({ status: 'available', subject: '件名', bodyText: '本文', sentAt: '2026-10-09T01:00:05.000Z' });
  });

  it('本文を消した後は消したことだけ返し、無い・送信済みでなければ 404', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: null, body_text: null, sent_at: '2026-08-01T00:00:00.000Z', body_erased: true }] } });
    await expect((await getContent(request(), context)).json()).resolves.toEqual({ status: 'erased', sentAt: '2026-08-01T00:00:00.000Z' });

    rpcReturns({ get_order_email_content: { data: [] } });
    expect((await getContent(request(), context)).status).toBe(404);

    expect((await getContent(request(), { params: Promise.resolve({ id: ORDER_ID, emailId: 'x' }) })).status).toBe(400);
  });
});

describe('POST /api/admin/orders/[id]/emails/resend', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID }) };
  const request = (body: unknown) => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/resend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' },
    body: JSON.stringify(body),
  });

  it('注文の管理の権限・CSRF・回数の制限を通った後に再送の行を足し、監査に残し、worker を動かす', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const response = await postResend(request({ kind: 'paid' }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, emailId: EMAIL_ID });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 }));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'admin:orders:email-resend', subject: 'admin-1' }));
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', { _order_id: ORDER_ID, _kind: 'paid', _actor_id: 'admin-1' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { kind: 'paid', email_id: EMAIL_ID },
    }));
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('権限が無ければ CSRF を確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わない・回数の制限を超えたら、行を足さない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);

    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('知らない種類・形の違う注文番号は 400', async () => {
    expect((await postResend(request({ kind: 'refund' }), context)).status).toBe(400);
    expect((await postResend(request({ kind: 'paid' }), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);
  });

  it.each([
    ['RESEND_ALREADY_QUEUED', '23505', 409, '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。'],
    ['RESEND_NOT_ALLOWED', '22023', 409, '今の注文の状態では、このメールは再送できません。'],
    ['ORDER_NOT_FOUND', 'P0002', 404, '注文が見つかりません。'],
  ])('DB が %s で断ったら %i', async (message, code, status, error) => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message, code } } });

    const response = await postResend(request({ kind: 'paid' }), context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('思いがけない DB の失敗は 500', async () => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message: 'down', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await postResend(request({ kind: 'paid' }), context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '再送を受け付けられませんでした。' });
    consoleError.mockRestore();
  });
});
```

Run: `npx jest tests/unit/lib/orders/email/order-history tests/unit/api/admin/order-email-routes --runInBand`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 履歴の形と組み立てを書く**

`src/lib/orders/email/order-history.ts`:

```ts
import { toOrderNumber } from '@/lib/orders/order-number';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason, type OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  RESENDABLE_ORDER_STATUSES,
  type OrderEmailDeliveryStatus,
  type OrderEmailErrorCode,
  type OrderEmailKind,
  type OrderEmailStatus,
} from '@/lib/orders/email/order-email-types';

/**
 * 管理画面の「この注文の履歴」（グループ D 設計書 5-1）。窓口と画面の両方が使うので、サーバーだけの物を import しない。
 * 注文の状態の変化とメールを新しい順に並べる。再送できるかは窓口が決めて返す（画面は判断しない）。
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  payment_in_progress: '支払い手続き中',
  pending: '未決済',
  paid: '決済完了',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
  shipped: '発送済み',
};

export type OrderStatusHistoryRow = {
  changedAt: string;
  fromStatus: string | null;
  toStatus: string;
  changeReason: string | null;
  actorEmail: string | null;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  cancelReason: string | null;
};

export type OrderEmailHistoryRow = {
  id: string;
  kind: OrderEmailKind;
  origin: 'auto' | 'manual';
  requestedByEmail: string | null;
  status: OrderEmailStatus;
  attempts: number;
  lastErrorCode: string | null;
  deliveryStatus: OrderEmailDeliveryStatus | null;
  deliveryEventAt: string | null;
  createdAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  hasBody: boolean;
  bodyErased: boolean;
};

export type OrderHistoryCreatedEntry = { type: 'created'; at: string };

export type OrderHistoryStatusEntry = {
  type: 'status';
  at: string;
  fromLabel: string | null;
  toLabel: string;
  actorEmail: string | null;
  detail: string | null;
};

export type OrderHistoryEmailEntry = {
  type: 'email';
  at: string;
  emailId: string;
  kind: OrderEmailKind;
  kindLabel: string;
  manual: boolean;
  requestedByEmail: string | null;
  stateLabel: string;
  warning: boolean;
  attempts: number;
  errorLabel: string | null;
  sentAt: string | null;
  deliveryEventAt: string | null;
  canViewContent: boolean;
  bodyErased: boolean;
  resendable: boolean;
};

export type OrderHistoryEntry = OrderHistoryCreatedEntry | OrderHistoryStatusEntry | OrderHistoryEmailEntry;

export type OrderHistoryResponse = {
  order: { id: string; orderNumber: string; statusLabel: string; recipient: string | null };
  sendPaused: { reasonLabel: string } | null;
  entries: OrderHistoryEntry[];
};

export type OrderEmailContentResponse =
  | { status: 'available'; subject: string; bodyText: string; sentAt: string | null }
  | { status: 'erased'; sentAt: string | null };

export type BuildOrderHistoryInput = {
  order: { id: string; status: OrderStatus; shippingEmail: string | null; createdAt: string };
  statusRows: OrderStatusHistoryRow[];
  emailRows: OrderEmailHistoryRow[];
  sendState: { paused: boolean; reason: OrderEmailErrorCode | null };
};

const OPEN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['pending', 'sending', 'retry_wait']);
const ERROR_SHOWN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['retry_wait', 'dead', 'skipped']);

function statusLabel(value: string | null): string | null {
  return value && value in ORDER_STATUS_LABELS ? ORDER_STATUS_LABELS[value as OrderStatus] : value;
}

function isShippingCarrierId(value: unknown): value is ShippingCarrierId {
  return typeof value === 'string' && (SHIPPING_CARRIER_IDS as readonly string[]).includes(value);
}

function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

function statusDetail(row: OrderStatusHistoryRow): string | null {
  if (row.toStatus === 'shipped' && isShippingCarrierId(row.shippingCarrier)) {
    return `配送業者: ${SHIPPING_CARRIERS[row.shippingCarrier].label} / 伝票番号: ${row.trackingNumber ?? ''}`;
  }
  if (row.toStatus === 'cancelled' && isCancelReason(row.cancelReason)) {
    return `理由: ${CANCEL_REASON_LABELS[row.cancelReason]}`;
  }
  return null;
}

export function buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse {
  const { order, statusRows, emailRows, sendState } = input;
  const openManualKinds = new Set(
    emailRows.filter((row) => row.origin === 'manual' && OPEN_STATUSES.has(row.status)).map((row) => row.kind),
  );

  const emailEntries: OrderHistoryEmailEntry[] = emailRows.map((row) => {
    const state = describeOrderEmailState(row.status, row.deliveryStatus);
    return {
      type: 'email',
      at: row.createdAt,
      emailId: row.id,
      kind: row.kind,
      kindLabel: ORDER_EMAIL_KIND_LABELS[row.kind],
      manual: row.origin === 'manual',
      requestedByEmail: row.requestedByEmail,
      stateLabel: state.label,
      warning: state.warning,
      attempts: row.attempts,
      errorLabel:
        ERROR_SHOWN_STATUSES.has(row.status) && isOrderEmailErrorCode(row.lastErrorCode)
          ? ORDER_EMAIL_ERROR_LABELS[row.lastErrorCode]
          : null,
      sentAt: row.sentAt,
      deliveryEventAt: row.deliveryEventAt,
      canViewContent: row.status === 'sent',
      bodyErased: row.bodyErased,
      resendable:
        (row.status === 'sent' || row.status === 'dead')
        && RESENDABLE_ORDER_STATUSES[row.kind].includes(order.status)
        && !openManualKinds.has(row.kind),
    };
  });

  const statusEntries: OrderHistoryStatusEntry[] = statusRows.map((row) => ({
    type: 'status',
    at: row.changedAt,
    fromLabel: statusLabel(row.fromStatus),
    toLabel: statusLabel(row.toStatus) ?? row.toStatus,
    actorEmail: row.actorEmail,
    detail: statusDetail(row),
  }));

  // 同じ時刻（状態の変更と同じ取引で書いたメール）は、メールを上に置く（新しい順で、変更が原因になる）
  const entries: OrderHistoryEntry[] = [...emailEntries, ...statusEntries, { type: 'created', at: order.createdAt }];
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    order: {
      id: order.id,
      orderNumber: toOrderNumber(order.id),
      statusLabel: ORDER_STATUS_LABELS[order.status],
      recipient: order.shippingEmail,
    },
    sendPaused: sendState.paused
      ? { reasonLabel: sendState.reason ? ORDER_EMAIL_ERROR_LABELS[sendState.reason] : ORDER_EMAIL_ERROR_LABELS.config_provider }
      : null,
    entries,
  };
}
```

`Array.prototype.sort` は安定なので、同じ時刻ではメール・状態の変化・受付の順のまま残る。

- [ ] **Step 4: 履歴・中身・再送の関数を足す**

`src/lib/orders/email/order-email-store.ts` の `OrderEmailRpcName` に `| 'request_order_email_resend' | 'list_order_email_history' | 'list_order_status_history' | 'get_order_email_content'` を足し、終わりに足す（`import type { OrderEmailHistoryRow, OrderStatusHistoryRow } from '@/lib/orders/email/order-history';` も足す）:

```ts
export class OrderEmailResendError extends Error {
  constructor(readonly reason: 'not_allowed' | 'already_queued' | 'order_not_found') {
    super(`order email resend refused: ${reason}`);
    this.name = 'OrderEmailResendError';
  }
}

/** 管理画面の再送の行を足し、行の番号を返す（設計書 5-3）。DB の断りは OrderEmailResendError にする */
export async function requestOrderEmailResend(
  store: OrderEmailStore,
  request: { orderId: string; kind: OrderEmailKind; actorId: string },
): Promise<string> {
  const { data, error } = await store.rpc('request_order_email_resend', {
    _order_id: request.orderId,
    _kind: request.kind,
    _actor_id: request.actorId,
  });
  if (error) {
    const message = error.message ?? '';
    if (message.includes('RESEND_ALREADY_QUEUED')) throw new OrderEmailResendError('already_queued');
    if (message.includes('RESEND_NOT_ALLOWED')) throw new OrderEmailResendError('not_allowed');
    if (message.includes('ORDER_NOT_FOUND')) throw new OrderEmailResendError('order_not_found');
    throw new OrderEmailStoreError('request_order_email_resend', error);
  }
  if (typeof data !== 'string') throw new OrderEmailStoreError('request_order_email_resend', null);
  return data;
}

export async function listOrderEmailHistory(store: OrderEmailStore, orderId: string): Promise<OrderEmailHistoryRow[]> {
  const data = await callOrderEmailRpc(store, 'list_order_email_history', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    id: String(row.email_id),
    kind: row.kind as OrderEmailKind,
    origin: row.origin === 'manual' ? 'manual' : 'auto',
    requestedByEmail: textOrNull(row.requested_by_email),
    status: row.status as OrderEmailStatus,
    attempts: Number(row.attempts),
    lastErrorCode: textOrNull(row.last_error_code),
    deliveryStatus: textOrNull(row.delivery_status) as OrderEmailDeliveryStatus | null,
    deliveryEventAt: textOrNull(row.delivery_event_at),
    createdAt: String(row.created_at),
    sentAt: textOrNull(row.sent_at),
    finishedAt: textOrNull(row.finished_at),
    hasBody: row.has_body === true,
    bodyErased: row.body_erased === true,
  }));
}

export async function listOrderStatusHistory(store: OrderEmailStore, orderId: string): Promise<OrderStatusHistoryRow[]> {
  const data = await callOrderEmailRpc(store, 'list_order_status_history', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    changedAt: String(row.changed_at),
    fromStatus: textOrNull(row.from_status),
    toStatus: String(row.to_status),
    changeReason: textOrNull(row.change_reason),
    actorEmail: textOrNull(row.actor_email),
    shippingCarrier: textOrNull(row.shipping_carrier),
    trackingNumber: textOrNull(row.tracking_number),
    cancelReason: textOrNull(row.cancel_reason),
  }));
}

export type OrderEmailContent =
  | { status: 'available'; subject: string; bodyText: string; sentAt: string | null }
  | { status: 'erased'; sentAt: string | null };

/** 送信済みのメールの中身。無い・送信済みでなければ null */
export async function getOrderEmailContent(
  store: OrderEmailStore,
  orderId: string,
  emailId: string,
): Promise<OrderEmailContent | null> {
  const row = rowsOf(await callOrderEmailRpc(store, 'get_order_email_content', { _order_id: orderId, _email_id: emailId }))[0];
  if (!row) return null;
  const sentAt = textOrNull(row.sent_at);
  const subject = textOrNull(row.subject);
  const bodyText = textOrNull(row.body_text);
  if (row.body_erased === true || subject === null || bodyText === null) {
    return { status: 'erased', sentAt };
  }
  return { status: 'available', subject, bodyText, sentAt };
}
```

- [ ] **Step 5: 窓口を書く**

`src/app/api/admin/orders/[id]/history/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { buildOrderHistory } from '@/lib/orders/email/order-history';
import {
  getOrderEmailSendState,
  listOrderEmailHistory,
  listOrderStatusHistory,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

type HistoryOrderRow = { id: string; status: OrderStatus; shipping_email: string | null; created_at: string };

/** 「この注文の履歴」（グループ D 設計書 5-1）。注文の状態の変化とメールを新しい順に返す。本文は返さない */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, status, shipping_email, created_at')
      .eq('id', parsedId.data)
      .maybeSingle<HistoryOrderRow>();
    if (error) {
      throw error;
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const store = supabase as unknown as OrderEmailStore;
    const [statusRows, emailRows, sendState] = await Promise.all([
      listOrderStatusHistory(store, order.id),
      listOrderEmailHistory(store, order.id),
      getOrderEmailSendState(store),
    ]);

    return NextResponse.json(
      buildOrderHistory({
        order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: order.created_at },
        statusRows,
        emailRows,
        sendState,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin.orders.history] Failed to load history', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
```

`src/app/api/admin/orders/[id]/emails/[emailId]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getOrderEmailContent, type OrderEmailStore } from '@/lib/orders/email/order-email-store';

const paramsSchema = z.object({ id: z.string().uuid(), emailId: z.string().uuid() });

/** 送ったメールの中身（設計書 5-2）。送信済みの行だけ。送ってから45日を過ぎて本文を消した後は、消したことだけ返す */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; emailId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    const content = await getOrderEmailContent(store, parsed.data.id, parsed.data.emailId);
    if (!content) {
      return NextResponse.json({ error: 'Email not found' }, { status: 404 });
    }
    return NextResponse.json(content, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.orders.email.content] Failed to load content', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to load content' }, { status: 500 });
  }
}
```

`src/app/api/admin/orders/[id]/emails/resend/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { ORDER_EMAIL_KINDS } from '@/lib/orders/email/order-email-types';
import {
  OrderEmailResendError,
  requestOrderEmailResend,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';

const bodySchema = z.object({ kind: z.enum(ORDER_EMAIL_KINDS) });

const RATE_LIMIT = { endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 } as const;

const MESSAGES = {
  already_queued: '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。',
  not_allowed: '今の注文の状態では、このメールは再送できません。',
  order_not_found: '注文が見つかりません。',
  failed: '再送を受け付けられませんでした。',
} as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * お客様へのメールの再送（グループ D 設計書 5-3）。手で足した印の新しい行を作り、今の注文の情報で作り直して送る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）の順に確かめる。監査にお客様の個人情報は入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { kind } = parsedBody.data;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown>) =>
    logAudit({
      action: 'admin.orders.email.resend',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: parsedId.data,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    const emailId = await requestOrderEmailResend(store, { orderId: parsedId.data, kind, actorId: authz.userId });
    await audit('success', 'Order email resend requested', { kind, email_id: emailId });
    scheduleOrderEmailDelivery();
    return NextResponse.json({ success: true, emailId });
  } catch (error) {
    if (error instanceof OrderEmailResendError) {
      if (error.reason === 'order_not_found') {
        await audit('failure', 'Order not found', { kind });
        return NextResponse.json({ error: MESSAGES.order_not_found }, { status: 404 });
      }
      await audit('conflict', error.reason === 'already_queued' ? 'Resend already queued' : 'Resend not allowed', { kind });
      return NextResponse.json({ error: MESSAGES[error.reason] }, { status: 409 });
    }
    console.error('[admin.orders.email.resend] Failed to request resend', error instanceof Error ? error.name : 'UnknownError');
    await audit('error', 'Failed to request resend', { kind });
    return NextResponse.json({ error: MESSAGES.failed }, { status: 500 });
  }
}
```

- [ ] **Step 6: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/orders/email tests/unit/api/admin --runInBand`
Expected: PASS
Run: `npm run typecheck` と `npm run lint`
Expected: エラー0件

- [ ] **Step 7: コミット（controller）**

```bash
git add src/lib/orders/email/order-history.ts src/lib/orders/email/order-email-store.ts "src/app/api/admin/orders/[id]/history/route.ts" "src/app/api/admin/orders/[id]/emails/[emailId]/route.ts" "src/app/api/admin/orders/[id]/emails/resend/route.ts" tests/unit/lib/orders/email/order-history.test.ts tests/unit/api/admin/order-email-routes.test.ts
git commit -m "feat(admin): 注文の履歴・送ったメールの中身・再送の窓口を足す（グループ D）"
```

---

### Task 7: 管理画面（履歴のダイアログ・発送の画面のチェック）

**Files:**
- Create: `src/components/OrderHistoryDialog.tsx`
- Create: `src/components/OrderShipDialog.tsx`
- Modify: `src/components/OrderSection.tsx`（「履歴」のボタン）
- Modify: `src/app/admin/page.tsx`（発送の画面を部品に替え、履歴のダイアログをつなぐ）
- Test: `tests/unit/components/OrderHistoryDialog.test.tsx`・`tests/unit/components/OrderShipDialog.test.tsx`（どちらも新規）・`tests/unit/components/OrderSection.actions.test.tsx`

**Interfaces:**
- Consumes: Task 6 の窓口（`GET /api/admin/orders/[id]/history`・`GET /api/admin/orders/[id]/emails/[emailId]`・`POST /api/admin/orders/[id]/emails/resend`）と型 `OrderHistoryResponse`・`OrderHistoryEmailEntry`・`OrderEmailContentResponse`、Task 3 の発送の窓口の `notifyCustomer`、既存の `Dialog`・`Button`・`Checkbox`・`StatusBadge`・`clientFetch`・`toOrderNumber`
- Produces:
  - `OrderHistoryDialog({ orderId: string | null; onClose: () => void })`（`orderId` が null なら閉じている）
  - `OrderShipDialog({ open: boolean; onClose: () => void; onSubmit: (values: OrderShipValues) => void })`・型 `OrderShipValues`（`{ carrier: ShippingCarrierId; trackingNumber: string; notifyCustomer: boolean }`）
  - `OrderSection` の新しい props `onShowHistory?: (id: string) => void`。ボタンの見える字は `履歴`、読み上げの名前は `{注文番号} の履歴`

決め事（本計画 P14・P15 の続き）: 追跡番号の形の誤りは、発送の画面の中に `role="alert"` で出す（今は一覧の下に出て、開いているダイアログに隠れていた。文言は今と同じ `追跡番号は英数字とハイフンで入力してください。`）。

- [ ] **Step 1: 画面の部品の試験を書く**

`tests/unit/components/OrderShipDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import OrderShipDialog from '@/components/OrderShipDialog';

function renderDialog(onSubmit = jest.fn()) {
  const utils = render(<OrderShipDialog open onClose={jest.fn()} onSubmit={onSubmit} />);
  return { ...utils, onSubmit };
}

describe('OrderShipDialog', () => {
  it('「お客様に発送のメールを送る」は最初から入っている', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
  });

  it('外すと「送らない」で発送する', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText('配送業者'), { target: { value: 'sagawa' } });
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: ' 1234-5678 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));

    expect(onSubmit).toHaveBeenCalledWith({ carrier: 'sagawa', trackingNumber: '1234-5678', notifyCustomer: false });
  });

  it('追跡番号の形が違えば、画面の中で知らせて送らない', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: '12 34' } });
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));

    expect(screen.getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('開き直すと既定（ヤマト・空・送る）へ戻す', () => {
    const { rerender } = render(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    rerender(<OrderShipDialog open={false} onClose={jest.fn()} onSubmit={jest.fn()} />);
    rerender(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
    expect(screen.getByLabelText('追跡番号')).toHaveValue('');
  });
});
```

`tests/unit/components/OrderHistoryDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderHistoryDialog from '@/components/OrderHistoryDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function history(overrides: Partial<OrderHistoryResponse> = {}): OrderHistoryResponse {
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries: [
      {
        type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'email-1', kind: 'paid', kindLabel: '注文確認', manual: false,
        requestedByEmail: null, stateLabel: '届かなかった', warning: true, attempts: 1, errorLabel: null,
        sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z', canViewContent: true, bodyErased: false, resendable: true,
      },
      { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderHistoryDialog', () => {
  it('履歴を新しい順に出し、宛先と注意の印を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('注文確認のメール');
    expect(items[0]).toHaveTextContent('注意');
    expect(items[0]).toHaveTextContent('届かなかった');
    expect(items[1]).toHaveTextContent('支払い手続き中 → 決済完了');
    expect(items[2]).toHaveTextContent('注文を受け付けました');
  });

  it('送信を止めていれば、その原因を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history({ sendPaused: { reasonLabel: '1日の送信の上限' } })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    expect(await screen.findByText('メールの送信を一時停止しています（1日の送信の上限）')).toBeInTheDocument();
  });

  it('中身を見ると件名と本文を出し、「戻る」で履歴へ戻る', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ status: 'available', subject: '【Le Fil des Heures】ご注文ありがとうございます', bodyText: '山田 花子 様\n\nご注文を承りました。', sentAt: '2026-10-09T01:00:05.000Z' }));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '中身を見る' }));

    expect(await screen.findByRole('dialog', { name: '注文確認のメールの中身' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenLastCalledWith(`/api/admin/orders/${ORDER_ID}/emails/email-1`, { cache: 'no-store' });
    expect(screen.getByText('【Le Fil des Heures】ご注文ありがとうございます')).toBeInTheDocument();
    expect(screen.getByText(/ご注文を承りました。/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
  });

  it('本文を消した後は保存期間を過ぎたことを出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ status: 'erased', sentAt: '2026-08-01T00:00:00.000Z' }));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '中身を見る' }));

    expect(await screen.findByText('本文の保存期間（45日）を過ぎました')).toBeInTheDocument();
  });

  it('再送は確かめてから送り、受け付けたら履歴を読み直す。送っている間はボタンを押せない', async () => {
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'お客様へ再送' }));

    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toBeInTheDocument();
    expect(screen.getByText('注文確認のメールを、お客様（注文のメールアドレス）へもう一度送ります')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再送する' }));

    expect(screen.getByRole('button', { name: '再送する' })).toBeDisabled();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, `/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'paid' }),
    });

    resolvePost(json({ success: true, emailId: 'email-2' }));
    expect(await screen.findByText('再送を受け付けました。少し待つと届きます。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(3);
  });

  it('「やめる」では送らない。断られたら理由を出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ error: '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。' }, 409))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'お客様へ再送' }));
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'お客様へ再送' }));
    fireEvent.click(screen.getByRole('button', { name: '再送する' }));
    expect(await screen.findByText('同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。')).toBeInTheDocument();
  });

  it('再送できない行にはボタンを出さず、読めなければ知らせる', async () => {
    const entries = history().entries.map((entry) => (entry.type === 'email' ? { ...entry, resendable: false, canViewContent: false } : entry));
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));
    const { unmount } = render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');
    expect(screen.queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '中身を見る' })).not.toBeInTheDocument();
    unmount();

    mockClientFetch.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('履歴を見る権限がありません。');
  });

  it('Escape で閉じる', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));
    const onClose = jest.fn();

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={onClose} />);
    await screen.findByText('宛先: hanako@example.com');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

`tests/unit/components/OrderSection.actions.test.tsx` に足す:

```tsx
  it('どの注文にも「履歴」を出し、押すと注文の番号を渡す', () => {
    const onShowHistory = jest.fn();

    render(<OrderSection orders={[paidOrder, pendingOrder]} onShowHistory={onShowHistory} />);

    const buttons = screen.getAllByRole('button', { name: /の履歴$/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('履歴');
    fireEvent.click(buttons[1]);
    expect(onShowHistory).toHaveBeenCalledWith('pending-order');
  });
```

Run: `npx jest tests/unit/components/OrderHistoryDialog tests/unit/components/OrderShipDialog tests/unit/components/OrderSection --runInBand`
Expected: FAIL（部品が無い・「履歴」が無い）

- [ ] **Step 2: 発送の画面を書く**

`src/components/OrderShipDialog.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

export type OrderShipValues = {
  carrier: ShippingCarrierId;
  trackingNumber: string;
  notifyCustomer: boolean;
};

type OrderShipDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: OrderShipValues) => void;
};

const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

function isShippingCarrierId(value: string): value is ShippingCarrierId {
  return (SHIPPING_CARRIER_IDS as readonly string[]).includes(value);
}

/**
 * 発送の画面（グループ D 設計書 5-4。Shopify の「発送の詳細を今すぐ送る」に合わせる）。
 * 「お客様に発送のメールを送る」は既定でオン、外せる。開くたびに既定へ戻す。
 */
export default function OrderShipDialog({ open, onClose, onSubmit }: OrderShipDialogProps) {
  const [carrier, setCarrier] = useState<ShippingCarrierId>('yamato');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCarrier('yamato');
      setTrackingNumber('');
      setNotifyCustomer(true);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="発送済みにする">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = trackingNumber.trim();
          if (!TRACKING_NUMBER_PATTERN.test(value)) {
            setError('追跡番号は英数字とハイフンで入力してください。');
            return;
          }
          onSubmit({ carrier, trackingNumber: value, notifyCustomer });
        }}
      >
        <div>
          <label htmlFor="ship-carrier" className="block font-acumin lk-text-3xs text-[#474747]">
            配送業者
          </label>
          <select
            id="ship-carrier"
            value={carrier}
            onChange={(event) => {
              if (isShippingCarrierId(event.target.value)) setCarrier(event.target.value);
            }}
            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
          >
            {SHIPPING_CARRIER_IDS.map((id) => (
              <option key={id} value={id}>
                {SHIPPING_CARRIERS[id].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ship-tracking" className="block font-acumin lk-text-3xs text-[#474747]">
            追跡番号
          </label>
          <input
            id="ship-tracking"
            type="text"
            inputMode="numeric"
            maxLength={64}
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            placeholder="1234-5678-9012"
            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
          />
        </div>
        <Checkbox
          label="お客様に発送のメールを送る"
          checked={notifyCustomer}
          onChange={(event) => setNotifyCustomer(event.target.checked)}
        />
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin">
            発送する
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
```

- [ ] **Step 3: 履歴のダイアログを書く**

`src/components/OrderHistoryDialog.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import type {
  OrderEmailContentResponse,
  OrderHistoryEmailEntry,
  OrderHistoryEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry };

type OrderHistoryDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
};

function formatJst(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorMessageOf(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : fallback;
}

/**
 * 「この注文の履歴」（グループ D 設計書 5 章。Shopify の注文の Timeline とメールの再送に合わせる）。
 * 状態の変化とメールを新しい順に出し、送ったメールの中身と再送の確かめを同じダイアログの中で切り替える
 * （ダイアログを重ねると、Escape で外側も閉じるため）。再送できるかは窓口が決めた値に従う。
 */
export default function OrderHistoryDialog({ orderId, onClose }: OrderHistoryDialogProps) {
  const [history, setHistory] = useState<OrderHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const response = await clientFetch(`/api/admin/orders/${id}/history`, { cache: 'no-store' });
      if (!response.ok) {
        setHistory(null);
        setLoadError(response.status === 403 ? '履歴を見る権限がありません。' : '履歴を読み込めませんでした。');
        return;
      }
      setHistory((await response.json()) as OrderHistoryResponse);
    } catch {
      setHistory(null);
      setLoadError('履歴を読み込めませんでした。');
    }
  }, []);

  useEffect(() => {
    if (!orderId) return;
    setHistory(null);
    setNotice(null);
    setView({ name: 'list' });
    void load(orderId);
  }, [orderId, load]);

  const openContent = async (entry: OrderHistoryEmailEntry) => {
    if (!orderId) return;
    setView({ name: 'content', entry, content: null, error: null });
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/${entry.emailId}`, { cache: 'no-store' });
      if (!response.ok) {
        setView({ name: 'content', entry, content: null, error: 'メールの中身を読み込めませんでした。' });
        return;
      }
      setView({ name: 'content', entry, content: (await response.json()) as OrderEmailContentResponse, error: null });
    } catch {
      setView({ name: 'content', entry, content: null, error: 'メールの中身を読み込めませんでした。' });
    }
  };

  const resend = async (entry: OrderHistoryEmailEntry) => {
    if (!orderId || submitting) return;
    setSubmitting(true);
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: entry.kind }),
      });
      const body: unknown = await response.json().catch(() => null);
      setNotice(response.ok ? '再送を受け付けました。少し待つと届きます。' : errorMessageOf(body, '再送を受け付けられませんでした。'));
    } catch {
      setNotice('再送を受け付けられませんでした。');
    } finally {
      setSubmitting(false);
      setView({ name: 'list' });
    }
    await load(orderId);
  };

  const title =
    view.name === 'content' ? `${view.entry.kindLabel}のメールの中身` : view.name === 'confirm' ? 'お客様へ再送' : 'この注文の履歴';

  const renderEntry = (entry: OrderHistoryEntry, index: number) => {
    if (entry.type === 'created') {
      return (
        <li key={`created-${index}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> 注文を受け付けました
        </li>
      );
    }
    if (entry.type === 'status') {
      return (
        <li key={`status-${index}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> {entry.fromLabel ? `${entry.fromLabel} → ` : ''}
          {entry.toLabel}
          {entry.detail ? <span className="block text-[#474747]">{entry.detail}</span> : null}
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    return (
      <li key={`email-${entry.emailId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#474747]">{formatJst(entry.at)}</span>
          <span>{entry.kindLabel}のメール</span>
          {entry.manual ? <span className="text-[#474747]">手で再送{entry.requestedByEmail ? `（${entry.requestedByEmail}）` : ''}</span> : null}
          {entry.warning ? <span className="font-semibold text-red-700">注意</span> : null}
          <StatusBadge tone={entry.warning ? 'danger' : 'neutral'} size="sm">
            {entry.stateLabel}
          </StatusBadge>
        </div>
        {entry.errorLabel ? <p className="text-[#474747]">原因: {entry.errorLabel}</p> : null}
        {entry.attempts > 1 ? <p className="text-[#474747]">試した回数: {entry.attempts}回</p> : null}
        <div className="flex flex-wrap gap-2">
          {entry.canViewContent ? (
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void openContent(entry)}>
              中身を見る
            </Button>
          ) : null}
          {entry.resendable ? (
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => setView({ name: 'confirm', entry })}>
              お客様へ再送
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Dialog open={orderId !== null} onClose={onClose} title={title}>
      {view.name === 'list' ? (
        <div className="space-y-3">
          {loadError ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {loadError}
            </p>
          ) : null}
          {!history && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {history ? (
            <>
              <p className="font-acumin lk-text-3xs text-[#474747]">
                {history.order.orderNumber}（{history.order.statusLabel}）
              </p>
              <p className="font-acumin lk-text-3xs text-black">宛先: {history.order.recipient ?? 'なし'}</p>
              {history.sendPaused ? (
                <p role="alert" className="font-acumin lk-text-3xs text-red-700">
                  メールの送信を一時停止しています（{history.sendPaused.reasonLabel}）
                </p>
              ) : null}
              {notice ? (
                <p role="status" aria-live="polite" className="font-acumin lk-text-3xs text-black">
                  {notice}
                </p>
              ) : null}
              <ol className="max-h-[60vh] space-y-3 overflow-y-auto">{history.entries.map(renderEntry)}</ol>
            </>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            閉じる
          </Button>
        </div>
      ) : null}

      {view.name === 'content' ? (
        <div className="space-y-3">
          {view.error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {view.error}
            </p>
          ) : null}
          {!view.content && !view.error ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {view.content?.status === 'erased' ? (
            <p className="font-acumin lk-text-3xs text-black">本文の保存期間（45日）を過ぎました</p>
          ) : null}
          {view.content?.status === 'available' ? (
            <>
              <p className="font-acumin lk-text-3xs font-semibold text-black">{view.content.subject}</p>
              <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-acumin lk-text-3xs text-black">
                {view.content.bodyText}
              </pre>
            </>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setView({ name: 'list' })}>
            戻る
          </Button>
        </div>
      ) : null}

      {view.name === 'confirm' ? (
        <div className="space-y-3">
          <p className="font-acumin lk-text-3xs text-black">
            {view.entry.kindLabel}のメールを、お客様（注文のメールアドレス）へもう一度送ります
          </p>
          {history?.order.recipient ? (
            <p className="font-acumin lk-text-3xs text-[#474747]">宛先: {history.order.recipient}</p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setView({ name: 'list' })}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={submitting}
              onClick={() => void resend(view.entry)}
            >
              再送する
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
```

試験の「送っている間はボタンを押せない」は、`resend` が `finally` の前の間（POST を待っている間）に `再送する` が `disabled` になることを確かめる。

- [ ] **Step 4: 一覧と管理画面をつなぐ**

`src/components/OrderSection.tsx`:

1. `import { toOrderNumber } from '@/lib/orders/order-number';` を足す。
2. `OrderSectionProps` に `/** 注文の履歴（状態の変化とメール）を開く */ onShowHistory?: (id: string) => void;` を足し、引数の分割に `onShowHistory,` を足す。
3. 「操作」の列の `<div className="flex flex-wrap items-center gap-2">` の最初の子に足す:

```tsx
								{onShowHistory ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										aria-label={`${toOrderNumber(order.id)} の履歴`}
										onClick={() => onShowHistory(order.id)}
									>
										履歴
									</Button>
								) : null}
```

`src/app/admin/page.tsx`:

1. `import OrderShipDialog, { type OrderShipValues } from '@/components/OrderShipDialog';` と `import OrderHistoryDialog from '@/components/OrderHistoryDialog';` を足す。
2. `shipCarrier`・`shipTrackingNumber` の state を消し、`const [historyOrderId, setHistoryOrderId] = useState<string | null>(null);` を足す。
3. `openShipDialog` を次にする:

```tsx
  const openShipDialog = (id: string) => {
    setOrdersNoticeMessage(null);
    setShipOrderId(id);
  };
```

4. `handleShipOrder` を `async (values: OrderShipValues) => { ... }` にし、追跡番号の確かめ（`OrderShipDialog` が行う）を消し、送る本文を `JSON.stringify({ status: 'shipped', carrier: values.carrier, trackingNumber: values.trackingNumber, notifyCustomer: values.notifyCustomer })` にする（ほかの処理は今のまま）。
5. 発送の `<Dialog open={shipOrderId !== null} ...>…</Dialog>` をまるごと次にする:

```tsx
            <OrderShipDialog
              open={shipOrderId !== null}
              onClose={() => setShipOrderId(null)}
              onSubmit={(values) => void handleShipOrder(values)}
            />
            <OrderHistoryDialog orderId={historyOrderId} onClose={() => setHistoryOrderId(null)} />
```

6. `<OrderSection ... />` に `onShowHistory={setHistoryOrderId}` を足す。
7. 使わなくなった import（`SHIPPING_CARRIERS`・`SHIPPING_CARRIER_IDS`・`ShippingCarrierId`、ほかで使っていなければ `Dialog`）を外す。

Run: `npx jest tests/unit/components --runInBand`
Expected: PASS（`AdminOrderRefundFlow`・`AdminOrderSearch` など管理画面の今の試験も通る）
Run: `npm run typecheck` と `npm run lint`
Expected: エラー0件

- [ ] **Step 5: 画面を目で確かめる（controller）**

開発の画面（`.claude/launch.json` の dev サーバー）で、管理者でログインした状態の ORDER タブを開き、1件の「履歴」を押して、ダイアログの見た目（390px・768px・1280px）を確かめ、画面の写しを残す。発送の画面のチェックが見えることも確かめる。

- [ ] **Step 6: コミット（controller）**

```bash
git add src/components/OrderHistoryDialog.tsx src/components/OrderShipDialog.tsx src/components/OrderSection.tsx src/app/admin/page.tsx tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/OrderShipDialog.test.tsx tests/unit/components/OrderSection.actions.test.tsx
git commit -m "feat(admin): 注文の履歴のダイアログと、発送のメールを送るかのチェックを足す（グループ D）"
```

---

### Task 8: E2E（3つの画面幅）

**Files:**
- Create: `e2e/order-email-test-utils.ts`
- Create: `e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts`
- Create: `e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`
- Create: `e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts`
- Modify: `tests/integration/db/helpers/order-fixtures.ts`（`insertOrderWithStockLine` に `shippingEmail`）

**Interfaces:**
- Consumes: 本物の決済の流れ（`e2e/checkout-flow-helpers.ts`）、手元の DB（`E2E_LOCAL_DB_URL`、既定 `postgresql://postgres:postgres@127.0.0.1:54322/postgres`）、手元のメール受け（`MAIL_LOCAL_URL`）、E2E の固定の値 `CRON_SECRET`・`STRIPE_WEBHOOK_SECRET`（`scripts/e2e/environment.ts` の `E2E_FIXED_ENV`。本番の値ではない）、Task 1 の DB の関数、Task 3 の `admin_ship_paid_order`、Task 6・7 の窓口と画面
- Produces: `e2e/order-email-test-utils.ts` の `withLocalDb(fn)`・`uniqueEmail(label)`・`createPaidOrder(db, email)`・`createActor(db)`・`runWorkerOnce(request)`・`mailsTo(request, email)`。`insertOrderWithStockLine(db, { ..., shippingEmail?: string })`

管理画面の E2E は、今までの管理画面の E2E と同じく窓口を差し替えて画面を確かめ、メールが本当に届くことは同じ spec の中で手元の DB の関数・worker の定期処理の入口・Mailpit で確かめる（本計画 P11）。

- [ ] **Step 1: 試験の道具を書く**

`tests/integration/db/helpers/order-fixtures.ts` の `insertOrderWithStockLine` の options に `/** 宛先。配送先は後から書き換えられないので、作る時に決める（E2E が使う） */ shippingEmail?: string;` を足し、INSERT の `'fixture@example.com'` を `$6` にして、引数の配列の最後に `options.shippingEmail ?? 'fixture@example.com'` を足す（ほかは変えない）。

`e2e/order-email-test-utils.ts`:

```ts
/**
 * 注文のメールの E2E の道具（グループ D）。手元の DB・手元のメール受け（Mailpit）・worker の定期処理の入口だけを使う。
 * 本物の管理者のログインには2段階認証（TOTP）が要るので、管理画面の操作の代わりに DB の関数を直に呼ぶ（本計画 P11）。
 */
import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createCatalogFixture, insertOrderWithStockLine } from '../tests/integration/db/helpers/order-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function withLocalDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では注文を作らない');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    return await fn(client as unknown as PgClient);
  } finally {
    await client.end();
  }
}

export function uniqueEmail(label: string): string {
  return `e2e-order-email-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** 入金済みの注文（在庫の明細1行）を、試験ごとの宛先で作る */
export async function createPaidOrder(db: PgClient, email: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const { orderId } = await insertOrderWithStockLine(db, {
    status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true, shippingEmail: email,
  });
  return orderId;
}

/** 再送と発送の関数は実行者（auth.users への外部キー）が要る */
export async function createActor(db: PgClient): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [uniqueEmail('admin')],
  );
  return res.rows[0].id as string;
}

/** worker の定期処理の入口を1回叩く（Stripe の知らせの後に注文のメールを送る） */
export async function runWorkerOnce(request: APIRequestContext): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET が無い（E2E の固定の値）');
  const response = await request.post('/api/cron/process-stripe-webhooks', {
    headers: { authorization: `Bearer ${secret}` },
    timeout: 90_000,
  });
  expect(response.status()).toBe(200);
}

export type MailpitMessage = { ID: string; Subject: string };

/** 手元のメール受けで、その宛先へのメールを読む（API: https://mailpit.axllent.org/docs/api-v1/） */
export async function mailsTo(request: APIRequestContext, email: string): Promise<MailpitMessage[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const response = await request.get(new URL('/api/v1/search', mailUrl).toString(), {
    params: { query: `to:${email}` },
    timeout: 5_000,
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { messages?: MailpitMessage[] };
  return body.messages ?? [];
}
```

- [ ] **Step 2: FR-CHECKOUT-049 を書く**

`e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts`:

```ts
/**
 * FR-CHECKOUT-049 注文確認のメールは、決済の完了と Webhook の両方が動いても1通だけ届く
 * 対応 FREQ: FREQ-434（AC-01）
 *
 * テスト用カードで注文し（決済の完了の窓口が照合する）、同じ決済の Stripe の知らせを受け取り口へ署名つきで送る
 * （worker が同じ照合をもう一度動かす）。署名の合言葉は E2E の固定の値（scripts/e2e/environment.ts）で、本番の値ではない。
 */
import Stripe from 'stripe';
import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';
import { mailsTo, runWorkerOnce, withLocalDb } from './order-email-test-utils';

const CONFIRMATION_SUBJECT = 'ご注文ありがとうございます';

test.describe('FR-CHECKOUT-049 注文確認のメールは1通だけ届く', () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）決済の完了と Webhook の両方が動いても、注文確認のメールは1通`, async ({ page, request }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      const email = `e2e-email-once-${viewport.name}-${Date.now()}@example.com`;
      const confirmations = async () =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(CONFIRMATION_SUBJECT)).length;

      await page.goto('/checkout');
      await fillShippingForm(page, email);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });

      // 決済の完了の窓口が書いた送る予定を、返事の後の worker が送る（FREQ-434-AC-01）
      await expect.poll(confirmations, { timeout: 60_000, message: `${email} へ注文確認のメールが届くこと` }).toBe(1);

      const order = await withLocalDb(async (db) =>
        (await db.query('select id, checkout_session_id, payment_intent_id from public.orders where shipping_email = $1', [email])).rows[0]);
      expect(order?.checkout_session_id).toEqual(expect.any(String));

      const eventId = `evt_e2e_once_${viewport.name}_${Date.now()}`;
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: order.checkout_session_id,
            object: 'checkout.session',
            payment_intent: order.payment_intent_id,
            payment_status: 'paid',
            status: 'complete',
          },
        },
      });
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET が無い（E2E の固定の値）');
      const webhook = await request.post('/api/webhook/stripe', {
        data: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
      });
      expect(webhook.status()).toBe(200);

      await expect.poll(
        async () => withLocalDb(async (db) =>
          (await db.query('select processing_status from public.stripe_webhook_events where id = $1', [eventId])).rows[0]?.processing_status),
        { timeout: 90_000, message: 'Stripe の知らせの処理が終わること' },
      ).toBe('completed');
      await runWorkerOnce(request);

      const rows = await withLocalDb(async (db) =>
        (await db.query("select origin, status from private.order_email_outbox where order_id = $1 and kind = 'paid'", [order.id])).rows);
      expect(rows).toEqual([{ origin: 'auto', status: 'sent' }]);
      // 2通目が届くとしたら worker の後。少し待ってから数える
      await page.waitForTimeout(3_000);
      expect(await confirmations()).toBe(1);
    });
  }
});
```

- [ ] **Step 3: FR-ADMIN-065 を書く**

`e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`:

```ts
/**
 * FR-ADMIN-065 注文の履歴（状態の変化とメール）・送ったメールの中身・お客様への再送
 * 対応 FREQ: FREQ-436（AC-01・AC-02）
 *
 * 画面は、今までの管理画面の E2E と同じく窓口を差し替えて確かめる（本物の管理者のログインには2段階認証が要る）。
 * 再送で2通目が本当に届くことは、手元の DB の関数・worker の定期処理の入口・手元のメール受けで確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { createActor, createPaidOrder, mailsTo, runWorkerOnce, uniqueEmail, withLocalDb } from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const SUBJECT = '【Le Fil des Heures】ご注文ありがとうございます（ORD-A1B2C3D4）';

const ORDER_ROW = {
  id: ORDER_ID,
  customerName: '山田 花子',
  customerEmail: 'hanako@example.com',
  orderDate: '2026-10-09',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
  status: '決済完了',
  canShip: true,
};

const SENT_EMAIL = {
  type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'b1b2c3d4-1111-2222-8333-444455556666', kind: 'paid',
  kindLabel: '注文確認', manual: false, requestedByEmail: null, stateLabel: '配達済み', warning: false, attempts: 1,
  errorLabel: null, sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z',
  canViewContent: true, bodyErased: false, resendable: true,
};

function historyBody(resent: boolean) {
  const manual = {
    ...SENT_EMAIL, at: '2026-10-09T02:00:00.000Z', emailId: 'c1b2c3d4-1111-2222-8333-444455556666', manual: true,
    requestedByEmail: 'admin@example.com', stateLabel: '送信待ち', sentAt: null, deliveryEventAt: null, canViewContent: false, resendable: false,
  };
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries: [
      ...(resent ? [manual] : []),
      { ...SENT_EMAIL, resendable: !resent },
      { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
  };
}

async function mockAdminApis(page: Page, state: { resent: boolean; resendBodies: unknown[] }): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'admin@example.com', role: 'admin', mfaVerified: true } }),
    }));
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }));
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
    }));
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [ORDER_ROW], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }),
    }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyBody(state.resent)) }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/emails/${SENT_EMAIL.emailId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'available', subject: SUBJECT, bodyText: '山田 花子 様\n\nご注文を承りました。', sentAt: SENT_EMAIL.sentAt }),
    }));
  await page.route(`**/api/admin/orders/${ORDER_ID}/emails/resend`, (route) => {
    state.resendBodies.push(route.request().postDataJSON());
    state.resent = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, emailId: 'c1b2c3d4-1111-2222-8333-444455556666' }) });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-065 order history and email resend (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('履歴に状態の変化とメールが並び、中身を開け、再送すると「手で再送」が出る。Escape で閉じる', async ({ page }) => {
      // FREQ-436-AC-01
      const state = { resent: false, resendBodies: [] as unknown[] };
      await mockAdminApis(page, state);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();

      const historyButton = page.getByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });
      await historyButton.click();
      const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('宛先: hanako@example.com')).toBeVisible();
      await expect(dialog.getByRole('listitem').nth(0)).toContainText('注文確認のメール');
      await expect(dialog.getByRole('listitem').nth(0)).toContainText('配達済み');
      await expect(dialog.getByRole('listitem').nth(1)).toContainText('支払い手続き中 → 決済完了');
      await expect(dialog.getByRole('listitem').nth(2)).toContainText('注文を受け付けました');

      await dialog.getByRole('button', { name: '中身を見る' }).click();
      const content = page.getByRole('dialog', { name: '注文確認のメールの中身' });
      await expect(content.getByText(SUBJECT)).toBeVisible();
      await expect(content.getByText(/ご注文を承りました。/)).toBeVisible();
      await content.getByRole('button', { name: '戻る' }).click();

      await page.getByRole('dialog', { name: 'この注文の履歴' }).getByRole('button', { name: 'お客様へ再送' }).click();
      const confirm = page.getByRole('dialog', { name: 'お客様へ再送' });
      await expect(confirm.getByText('注文確認のメールを、お客様（注文のメールアドレス）へもう一度送ります')).toBeVisible();
      await confirm.getByRole('button', { name: '再送する' }).click();

      const after = page.getByRole('dialog', { name: 'この注文の履歴' });
      await expect(after.getByText('再送を受け付けました。少し待つと届きます。')).toBeVisible();
      await expect(after.getByText('手で再送（admin@example.com）')).toBeVisible();
      await expect(after.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);
      expect(state.resendBodies).toEqual([{ kind: 'paid' }]);

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(historyButton).toBeFocused();
    });

    test('再送すると、同じ件名のメールが2通目として届き、履歴に手の再送が残る（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-436-AC-02
      const email = uniqueEmail(`resend-${viewport.name}`);
      const { orderId, actorId } = await withLocalDb(async (db) => {
        const created = await createPaidOrder(db, email);
        await db.query("select private.enqueue_order_email($1, 'paid', 'order_confirmed')", [created]);
        return { orderId: created, actorId: await createActor(db) };
      });

      await runWorkerOnce(request);
      await expect.poll(async () => (await mailsTo(request, email)).length, { timeout: 30_000 }).toBe(1);

      await withLocalDb((db) => db.query("select public.request_order_email_resend($1, 'paid', $2)", [orderId, actorId]));
      await runWorkerOnce(request);
      await expect.poll(async () => (await mailsTo(request, email)).length, { timeout: 30_000 }).toBe(2);

      const subjects = new Set((await mailsTo(request, email)).map((message) => message.Subject));
      expect([...subjects]).toEqual([expect.stringContaining('ご注文ありがとうございます')]);
      const history = await withLocalDb(async (db) =>
        (await db.query('select origin, status from public.list_order_email_history($1)', [orderId])).rows);
      expect(history).toEqual([{ origin: 'manual', status: 'sent' }, { origin: 'auto', status: 'sent' }]);
    });
  });
}
```

- [ ] **Step 4: FR-ADMIN-066 を書く**

`e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts`:

```ts
/**
 * FR-ADMIN-066 発送の時に、発送のメールを送るかを選べる（最初は送る）
 * 対応 FREQ: FREQ-438（AC-01・AC-02）
 *
 * 画面は窓口を差し替えて、送る本文に「送るか」が載ることを確かめる。
 * 「外すと届かず、入れると1通届く」は、手元の DB の発送の関数・worker の定期処理の入口・手元のメール受けで確かめる（本計画 P11）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { createActor, createPaidOrder, mailsTo, runWorkerOnce, uniqueEmail, withLocalDb } from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const SHIPPED_SUBJECT = '商品を発送いたしました';

const BASE = {
  customerName: '山田 花子',
  customerEmail: 'hanako@example.com',
  orderDate: '2026-10-09',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
  status: '決済完了',
  canShip: true,
};

const ORDERS = [
  { ...BASE, id: 'd1b2c3d4-1111-2222-8333-444455556666' },
  { ...BASE, id: 'e1b2c3d4-1111-2222-8333-444455556666' },
];

async function mockAdminApis(page: Page, bodies: unknown[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }),
    }));
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }));
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
    }));
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    }));
  await page.route('**/api/admin/orders/*/status', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, status: 'shipped' }) });
  });
}

async function ship(page: Page, row: number, notify: boolean): Promise<void> {
  await page.getByRole('button', { name: '発送済みにする' }).nth(row).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  const checkbox = dialog.getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
  await expect(checkbox).toBeChecked();
  if (!notify) await checkbox.uncheck();
  await dialog.getByLabel('追跡番号').fill(`E2E-${row}`);
  await dialog.getByRole('button', { name: '発送する' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-066 ship email opt-out (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送の画面の「お客様に発送のメールを送る」は最初から入っていて、外すと「送らない」を送る', async ({ page }) => {
      // FREQ-438-AC-01
      const bodies: unknown[] = [];
      await mockAdminApis(page, bodies);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();

      await ship(page, 0, false);
      await ship(page, 0, true);

      expect(bodies).toEqual([
        { status: 'shipped', carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: false },
        { status: 'shipped', carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: true },
      ]);
    });

    test('「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-438-AC-02
      const silentEmail = uniqueEmail(`ship-silent-${viewport.name}`);
      const notifiedEmail = uniqueEmail(`ship-notified-${viewport.name}`);
      const { silentOrder } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const silent = await createPaidOrder(db, silentEmail);
        const notified = await createPaidOrder(db, notifiedEmail);
        await db.query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'E2E-SILENT', false)", [silent, actor]);
        await db.query("select * from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', 'E2E-NOTIFIED', true)", [notified, actor]);
        return { silentOrder: silent };
      });

      await runWorkerOnce(request);

      await expect.poll(
        async () => (await mailsTo(request, notifiedEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT)).length,
        { timeout: 30_000 },
      ).toBe(1);
      expect((await mailsTo(request, silentEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT))).toHaveLength(0);
      const rows = await withLocalDb(async (db) =>
        (await db.query("select count(*)::int as count from private.order_email_outbox where order_id = $1 and kind = 'shipped'", [silentOrder])).rows[0]);
      expect(rows.count).toBe(0);
    });
  });
}
```

- [ ] **Step 5: E2E を流す（controller）**

1. 3000番に何も無いことを確かめる: `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue`（何か出たら、そのアプリを止める）
2. `npx supabase db reset`
3. `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/FR-CHECKOUT-049 e2e/FR-ADMIN-065 e2e/FR-ADMIN-066 e2e/FR-ADMIN-050 e2e/FR-CHECKOUT-041 --reporter=list`
Expected: すべて PASS（FR-CHECKOUT-049 は Stripe のテストモードで決済するので、`seedCart` が使えない時は skip になる。skip の時は理由を報告に書く）

落ちたら CLAUDE.md の「失敗したときの切り分け」の順（単体で再実行 → 他の画面幅 → 時間切れか中身の違いか）で調べる。`retries` は上げない。

- [ ] **Step 6: コミット（controller）**

```bash
git add e2e/order-email-test-utils.ts e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts tests/integration/db/helpers/order-fixtures.ts
git commit -m "test(e2e): 注文のメールが1通だけ届くこと・履歴と再送・発送のメールを選べることを確かめる（グループ D）"
```

---

### Task 9: 要求・設計の文書・手順書・台帳

**Files:**
- Modify: `docs/02_Requirements/requirements.md`
- Modify: `docs/superpowers/specs/2026-10-09-order-email-outbox-design.md`（7-4 と 11 章）
- Modify: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`
- Modify: `docs/03_BasicDesign/data/er.md`・`docs/03_BasicDesign/api/api-spec.md`・`docs/03_BasicDesign/api/route-inventory.md`
- Modify: `docs/04_DetailDesign/pages/13_checkout.md`・`docs/04_DetailDesign/pages/16_admin.md`・`docs/04_DetailDesign/sequence/checkout-payment.md`・`docs/04_DetailDesign/sequence/order-administration.md`・`docs/04_DetailDesign/sequence/stripe-webhooks.md`・`docs/04_DetailDesign/states/order-payment.md`
- Create: `docs/06_Operations/order-email-operations.md`
- Modify: `docs/06_Operations/README.md`・`docs/06_Operations/secrets.md`・`docs/06_Operations/webhook-queue-operations.md`

**Interfaces:**
- Consumes: Task 1〜8 の名前（表・関数・窓口・環境変数・E2E のファイル名）
- Produces: 文書だけ（コードは変えない）

文書は `documentation-guide` の決まり（頭に「概要」、図は Mermaid、絵文字なし、見出しは H4 まで、関連は相対リンク）に従う。

- [ ] **Step 1: 要求の行を足し、古い行に置き換えの注記を付ける**

`grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` が `FREQ-433` であることを確かめ、FREQ-433 の行の次に次の5行を足す:

```markdown
| FREQ-434 | 注文のメール（注文確認・入金待ち・支払い期限切れ・取消・発送）を、0通にも2通にもしないこと（グループ D。R-34・R-14、FREQ-386 を確実にする） | FREQ-434-REQ-01<br>FREQ-434-REQ-02<br>FREQ-434-REQ-03 | ・注文の状態を変える DB の関数が、同じ取引で「注文のメール」の表に1行書くこと（自動の行は1注文1種類1行。状態の変更を取り消せば行も残らない）<br>・worker が担当の印を付けて1行ずつ取り出し、最初に送る前に件名と本文を控え、行の番号から作った重複防止キー（`order-email/<行の番号>`）で Resend に送ること<br>・送り手が Resend でない時（設定が無く SES になる時を含む）は送らずに送信を一時停止すること | FREQ-434-AC-01<br>FREQ-434-AC-02<br>FREQ-434-AC-03 | ・3つの画面幅で、決済の完了と Webhook の両方が動いても注文確認のメールが1通だけ届くこと（E2E FR-CHECKOUT-049）<br>・状態の変更を取り消すと送る予定が残らず、同じ注文・同じ種類の自動の行は1つだけになること（DB 結合）<br>・送れた後に記録の前に落ちても、やり直しが控えた中身と同じ重複防止キーで送ること（単体・DB 結合） |
| FREQ-435 | 送れなかった注文のメールを自動でやり直し、送れなければ店へ知らせること。ふだん1分以内に送り、15分を超えたら店へ知らせること | FREQ-435-REQ-01<br>FREQ-435-REQ-02<br>FREQ-435-REQ-03 | ・一時的な失敗は 1・2・4…128分の間隔（前後2割の揺らぎ。待つ時間の指示が長ければそちら）で最初と合わせて9回試し、駄目なら送れなかったにすること<br>・設定の問題（鍵・送信元のドメイン・送り手・送信の上限）は回数を数えずに送信全体を止め、15分ごと（1日の上限は日本時間 9時の後）に1件だけ試し、送れたら再開すること<br>・同じ注文のメールは書いた順に送り、意味がなくなった入金待ち・支払い期限切れのメールは取りやめること。送れなかった・溜まり（15分）・一時停止・worker の停止を、種類ごとに1時間に1回まで店へ知らせること | FREQ-435-AC-01<br>FREQ-435-AC-02<br>FREQ-435-AC-03<br>FREQ-435-AC-04 | ・やり直しの間隔・回数・揺らぎ・待つ時間の指示が決まりどおりであること（DB 結合・単体）<br>・設定の問題で一時停止し、回数を数えず、1件の試しが通ると再開すること（DB 結合・単体）<br>・同じ注文の後のメールは前のメールが片付くまで送らず、入金待ちは注文が入金待ちでなければ取りやめになること（DB 結合・単体）<br>・店への知らせに注文番号・原因・手順書の節が入り、お客様の氏名・住所・メールアドレスが入らないこと（単体） |
| FREQ-436 | 管理画面で注文の履歴（状態の変化とメール）を見て、送ったメールの中身（45日）を開き、お客様へ再送できること（Shopify の注文の Timeline・メールの再送に合わせる） | FREQ-436-REQ-01<br>FREQ-436-REQ-02<br>FREQ-436-REQ-03 | ・注文の一覧に「履歴」を置き、状態の変化（受付・入金・発送・取消と操作した管理者）とメール（種類・状態・時刻・原因・手で再送の印）を新しい順に出すこと。上に宛先と、送信の一時停止を出すこと<br>・送信済みのメールの件名と本文を、送ってから45日まで見られること（過ぎたら「本文の保存期間（45日）を過ぎました」）<br>・送信済み・送れなかったメールを、今の注文の状態で意味のある種類だけ、確かめてから再送できること（注文の管理の権限・CSRF・回数の制限・監査。同じ種類の再送が送信待ちの間は再送できない） | FREQ-436-AC-01<br>FREQ-436-AC-02<br>FREQ-436-AC-03 | ・3つの画面幅で、履歴に状態の変化とメールが並び、中身を開け、再送すると「手で再送」が出て、Escape で閉じると「履歴」のボタンへ戻ること（E2E FR-ADMIN-065）<br>・3つの画面幅で、再送すると同じ件名のメールが2通目として届くこと（E2E FR-ADMIN-065）<br>・再送の窓口が権限・CSRF・回数の制限を確かめ、送信待ちの再送がある間・注文の状態が合わない時は 409 で断り、監査に残すこと（単体・DB 結合） |
| FREQ-437 | 注文のメールの配達の状態を記録し、届かなかったら注意の印と店への知らせを出すこと | FREQ-437-REQ-01<br>FREQ-437-REQ-02 | ・Resend の知らせを、届いたままの本文の Svix 署名・時刻（前後5分）・本文の大きさ（64KB）・種類で確かめてから記録すること（同じ知らせは1回だけ、記録より新しい知らせだけ書き換える）<br>・1時間ごとに、送ってから3日以内で配達の状態が決まっていないメールを Resend の API で読み直すこと | FREQ-437-AC-01<br>FREQ-437-AC-02<br>FREQ-437-AC-03 | ・受け口が署名・時刻・大きさ・種類・重複を確かめ、決まりどおり 200・400・401・413 を返すこと（単体）<br>・配達の状態が前後しても戻らず、届かなかった・迷惑メールにされた・送信先が止められている・送信サービスで送れなかったを店へまとめて知らせること（DB 結合・単体）<br>・見回りが状態の決まらないメールだけを読み直し、送信専用の鍵なら止めて記録すること（単体） |
| FREQ-438 | 発送の時に、お客様に発送のメールを送るかを選べること（最初は送る。Shopify の「発送の詳細を今すぐ送る」） | FREQ-438-REQ-01 | ・発送の画面に「お客様に発送のメールを送る」を置き（最初は入っている）、外したら発送の関数に「送らない」を渡すこと | FREQ-438-AC-01<br>FREQ-438-AC-02 | ・3つの画面幅で、発送の画面のチェックが最初から入っていて、外すと「送らない」を送ること（E2E FR-ADMIN-066）<br>・3つの画面幅で、「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届くこと（E2E FR-ADMIN-066） |
```

古い行に注記を足す（文の終わりに足す。消さない）:

| 行 | 足す注記 |
|---|---|
| FREQ-268 の要件「メール送信に失敗しても…監査ログに記録すること」 | `（2026-10-09 FREQ-434・435 で置き換え。発送の関数が送る予定の行を書き、worker が送り、送れなければやり直す）` |
| FREQ-268 の受け付け基準「更新対象が0件のとき sendOrderShippedEmail が呼ばれないこと」・「送信失敗時に例外を投げず…記録されること」 | それぞれ `（FREQ-434・435 で置き換え）` |
| FREQ-386 の要件の1つめ・2つめ（送信権） | `（2026-10-09 FREQ-434 で置き換え。送信権の代わりに、状態を変える DB の関数が同じ取引で送る予定の行を書く）` |
| FREQ-386 の受け付け基準の1〜3つめ | それぞれ `（FREQ-434 で置き換え）` |
| FREQ-408 の受け付け基準「送れなかったら送信権を戻し、後の経路が送り直せること」 | `（FREQ-435 で置き換え。お客様への注文のメールは自動でやり直す。受付を通らない支払いの案内は今のまま送信権を戻す）` |

- [ ] **Step 2: 設計書とレビュー台帳を直す**

`docs/superpowers/specs/2026-10-09-order-email-outbox-design.md`:

1. 7-4 の2つめの箇条書き「本番のアプリは公開前で、今ある注文は試験の物なので、古い送信の記録は新しい表に移さない。」を次にする:

```markdown
- 本番の古い送信権は8行で、移行前の未入金の注文2件の「送らない」印だった（2026-10-09 に本番を読んで確かめた）。消すと、この2件に後から期限切れのメールが届きうるので、取りやめ（`legacy_suppressed`）の自動の行として新しい表へ移してから消す（実装計画の決め事 P9）。
```

2. 11 章の表の終わりに足す:

```markdown
| 実装計画を書く時 | 古い送信権の8行を取りやめとして移す（7-4） | 本番を読んで、移行前の未入金の注文2件の「送らない」印だと分かった。グループ A 設計書 7-1 の決め事を守る |
```

`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`:

1. 一覧の `| R-14 | P2 | 未修正 | メール送信権のDB取得失敗時に重複送信を許す |` を `| R-14 | P2 | 修正済み（2026-10-09） | メール送信権のDB取得失敗時に重複送信を許す |` に、`| R-34 | P2 | 未修正 | 注文確認メールの送信失敗後に再送する経路がない |` を `| R-34 | P2 | 修正済み（2026-10-09） | 注文確認メールの送信失敗後に再送する経路がない |` にする。
2. `### R-14 …` と `### R-34 …` の節の終わりに、それぞれ次を足す:

```markdown
- **修正（2026-10-09）**: グループ D（[設計書](../../../superpowers/specs/2026-10-09-order-email-outbox-design.md)・[実装計画](../../../superpowers/plans/2026-10-09-order-email-outbox.md)）で、送信権の仕組みを送る予定の表（transactional outbox）に置き換えた。注文の状態を変える DB の関数が同じ取引で1行書き（自動の行は1注文1種類1行）、worker が行の番号から作った重複防止キーで Resend に送る。一時的な失敗は約4時間で9回までやり直し、設定の問題は送信全体を止め、送れなければ店へ知らせて管理画面から再送できる。移行は `20261009095633_order_email_outbox.sql`・`20261009095736_order_email_enqueue.sql`（本番への適用は push の後）。
```

3. グループの表の `| 5 | D 注文メールを確実に送る | R-34, R-14 | 未着手 |` を `| 5 | D 注文メールを確実に送る | R-34, R-14 | 実装済み（2026-10-09。push・本番への適用は未） |` にする。

- [ ] **Step 3: 基本設計（ER・API）を直す**

`docs/03_BasicDesign/data/er.md`:

1. 頭の追記の並び（`2026-10-08 追記（全体レビュー、FREQ-433）…` の行）の次に足す:

```markdown
2026-10-09 追記（グループ D、FREQ-434〜438）: [移行 A](../../../supabase/migrations/20261009095633_order_email_outbox.sql) で `private.order_email_outbox`（注文のメール。自動の行は `(order_id, kind)` で1行、手の再送は送信待ちの間1行、`provider_message_id` は重複なし）・`private.order_email_send_pause`（送信の一時停止。1行）・`private.resend_webhook_receipts`（Resend の知らせの受付済みの番号。3日）を足した。[移行 B](../../../supabase/migrations/20261009095736_order_email_enqueue.sql) で `private.order_emails`（古い送信権）を消した（本番の8行は取りやめの行として移した）。3つの表は関数だけで読み書きし、RLS を有効にして表の権限を外してある。本番の適用状況は未確認。
```

2. 概要の表の「商品・LOOK・在庫・注文」の行の `注文メール送信権` を `注文のメール（送る予定・送信の一時停止・配達の知らせの受付済み）` にする。
3. `### 2.3 注文・改訂・在庫台帳・メール送信権` と `### 4.3 注文・改訂・在庫台帳・メール送信権` の見出しを `…・注文のメール` にし、その節の Mermaid の ER 図の `ORDER_EMAILS` の箱（あれば）を、`ORDER_EMAIL_OUTBOX`（`id`・`seq`・`order_id`・`kind`・`variant`・`origin`・`requested_by`・`status`・`attempts`・`next_attempt_at`・`provider_message_id`・`delivery_status`）に替え、`ORDERS ||--o{ ORDER_EMAIL_OUTBOX : "メール"` を足す。`ORDER_EMAIL_SEND_PAUSE` と `RESEND_WEBHOOK_RECEIPTS` は関係の無い箱として足す。
4. 表の一覧の `private.order_emails` の行を消し、次の3行を足す（列の並びは今の表に合わせる）: `private.order_email_outbox`（主キー `id`、一意 `seq`・自動の行 `(order_id, kind)`・手の送信待ち `(order_id, kind)`・`provider_message_id`、参照先 2（`orders`・`auth.users`））、`private.order_email_send_pause`（主キー `id`。参照なし）、`private.resend_webhook_receipts`（主キー `svix_id`。参照なし）。根拠のリンクは移行 A の行番号。
5. 外部キーの一覧の `private.order_emails.order_id` の行を消し、`private.order_email_outbox.order_id → public.orders(id)`（`CASCADE`）と `private.order_email_outbox.requested_by → auth.users(id)`（`SET NULL`）の2行を足す。

`docs/03_BasicDesign/api/api-spec.md` と `docs/03_BasicDesign/api/route-inventory.md` に、今の書き方に合わせて次の4つの窓口を足し、発送の窓口の本文に `notifyCustomer`（真偽、既定 true）を足す:

| 窓口 | 権限 | 中身 |
|---|---|---|
| `GET /api/admin/orders/[id]/history` | `admin.orders.read` | 注文（注文番号・状態・宛先）、送信の一時停止、受付・状態の変化・メールを新しい順。本文は返さない |
| `GET /api/admin/orders/[id]/emails/[emailId]` | `admin.orders.read` | 送信済みのメールの件名と本文。45日を過ぎたら `{ status: 'erased' }` |
| `POST /api/admin/orders/[id]/emails/resend` | `admin.orders.manage`・CSRF・10分に30回（送信元・管理者） | 本文 `{ kind }`。手の再送の行を足す。409（送信待ちの再送がある・状態が合わない）・404 |
| `POST /api/webhook/resend-delivery` | 公開（Svix 署名・`RESEND_DELIVERY_WEBHOOK_SECRET`） | Resend の配達の知らせ（6種類）。200・400・401・413・500・503 |

- [ ] **Step 4: 詳細設計（画面・流れ・状態）を直す**

`docs/04_DetailDesign/pages/13_checkout.md` の `### 注文メールは1注文・1種類につき1通（FREQ-386）` の節の本文（送信権の説明の箇条書きと表）を、次に置き換える（見出しは `### 注文メールは1注文・1種類につき1通（FREQ-386・FREQ-434）` にする）:

```markdown
2026-10-09 から、注文のメールは送る予定の表（transactional outbox）で送る（[グループ D 設計書](../../superpowers/specs/2026-10-09-order-email-outbox-design.md)）。

- 注文の状態を変える DB の関数（入金済み・入金待ち・在庫を戻す・発送）が、同じ取引で `private.order_email_outbox` に1行書く。自動の行は1注文1種類1行なので、画面からの complete・Webhook・毎時の見回りのどれが何回動いても、行は1つ。
- 決済の完了の窓口は、照合の後に返事を返してから worker を1回動かす（`after()`）。Webhook の知らせは worker が処理した後に続けて送る。どちらも動かなくても、毎分の定期処理が送る。
- worker は最初に送る前に件名と本文を控え、行の番号から作った重複防止キーで Resend に送る。送れた後に落ちても、やり直しは同じ中身・同じキーなので2通目にならない。
- 一時的な失敗は約4時間で9回までやり直す。駄目なら「送れなかった」にして店へ知らせ、管理画面の注文の「履歴」から再送できる。
```

`docs/04_DetailDesign/pages/16_admin.md`:

1. 注文の操作の表（`admin_ship_paid_order` の行がある表）の発送の行の終わりに `「お客様に発送のメールを送る」（最初は入っている）を外すと、発送のメールの行を書かない（FREQ-438）。` を足す。
2. 注文の節の終わりに、次の節を足す:

```markdown
#### 注文の履歴（FREQ-436・437）

各注文の「履歴」（読み上げの名前は「{注文番号} の履歴」）で「この注文の履歴」のダイアログを開く。

| 表示 | 中身 |
|---|---|
| 上 | 注文番号と状態、宛先（注文のメールアドレス）、送信を止めていれば「メールの送信を一時停止しています（原因）」 |
| 並び | 受付・状態の変化（配送業者と伝票番号、取消の理由、操作した管理者）・メール（種類・状態・時刻・原因・手で再送の印）を新しい順 |
| メールの状態 | 送信待ち・やり直し待ち・送信済み・配達済み・配達の遅れ・届かなかった・迷惑メールにされた・送信先が止められている・送信サービスで送れなかった・取りやめ・送れなかった。問題のある状態には「注意」 |
| 中身を見る | 送信済みのメールの件名と本文。送ってから45日を過ぎたら「本文の保存期間（45日）を過ぎました」 |
| お客様へ再送 | 送信済み・送れなかったメールで、今の注文の状態で意味のある種類だけ。「{種類}のメールを、お客様（注文のメールアドレス）へもう一度送ります」で確かめ、「再送する」「やめる」 |

中身と再送の確かめは同じダイアログの中で切り替える。Escape で閉じ、閉じたら「履歴」のボタンへ戻る。
```

`docs/04_DetailDesign/sequence/order-administration.md`:

1. 根拠の表の「取消・出荷のメール」の行のリンクを4つにする（文字 → `order-administration.md` から見た行き先）: 「送る予定の表」→ `../../../supabase/migrations/20261009095633_order_email_outbox.sql`、「状態を変える関数」→ `../../../supabase/migrations/20261009095736_order_email_enqueue.sql`、「worker」→ `../../../src/lib/orders/email/order-email-worker.ts`、「中身」→ `../../../src/lib/orders/email/order-email-compose.ts`。
2. Mermaid の `Reconcile->>DB: claim_order_email(canceled)`（2か所）を消し、在庫を戻す RPC の矢印の説明に「（知らせる時は取消のメールの行を同じ取引で書く）」を足す。
3. 発送の流れの `API->>DB: admin_ship_paid_order(order, actor, carrier, tracking)` を `API->>DB: admin_ship_paid_order(order, actor, carrier, tracking, notify)` にし、`API->>Mail: sendOrderShippedEmail` の分岐を、`Note over DB: notify なら発送のメールの行を書く` と `API-->>API: after() で worker を動かす` に替える。
4. 「取消メール」の行（`private.order_emails`の注文ID・種類の一意性でclaim…）を「取消・発送のメールは、状態を変える関数が同じ取引で送る予定の行を書き、worker が送る。失敗はやり直し、送れなければ店へ知らせる（FREQ-434・435）」にする。根拠の行の出荷メール（`order-shipped-email.ts`）へのリンクを消し、文字「worker」・行き先 `../../../src/lib/orders/email/order-email-worker.ts` のリンクに替える。

`docs/04_DetailDesign/sequence/checkout-payment.md`: 入金済み・入金待ちの後にお客様へメールを送る矢印（`sendOrderConfirmation` などを呼ぶもの）を、`DB` の中で送る予定の行を書く注記と、返事の後の `after()` で worker が送る矢印に替える。`未解決・送信権ありなら通知を試みる` は要対応の知らせ（`payment_exceptions`）の送信権なので変えない。

`docs/04_DetailDesign/sequence/stripe-webhooks.md`: worker の説明の表に次の行を足す: `| 注文のメール | Stripe の知らせを35秒まで処理した後、続けて10秒まで注文のメールを送り、1時間ごとに配達の状態を見回り、注文のメールの点検をする（グループ D） |`。worker の予算を45秒と書いている所は「Stripe の知らせに35秒、注文のメールに10秒（合わせて45秒）」にする。

`docs/04_DetailDesign/states/order-payment.md` の `private.order_emails`による種類別の送信権とメール失敗の扱いは…` の文を「注文のメールは、状態を変える関数が同じ取引で `private.order_email_outbox` に行を書き、worker が送る（[グループ D 設計書](../../superpowers/specs/2026-10-09-order-email-outbox-design.md)）。」にする。

- [ ] **Step 5: 手順書を書き、運用の文書を直す**

`docs/06_Operations/order-email-operations.md`（新規）:

下の中身の `~~~` は、ファイルに書く時に3つのバッククォートに替える（計画書の中で入れ子の囲みが崩れないため）。

```markdown
# 注文のメールの手順書

> 対象: お客様への注文のメール（注文確認・入金待ち・支払い期限切れ・取消・発送）の送信・やり直し・一時停止・配達の状態と、店への知らせ
> 設計: [グループ D 設計書](../superpowers/specs/2026-10-09-order-email-outbox-design.md)、Stripe の知らせと定期処理: [手順書](webhook-queue-operations.md)

---

## 概要

注文のメールは、注文の状態を変える DB の関数が「注文のメール」の表に1行書き、毎分の worker（Stripe の知らせの worker の続き）と、行を書いた窓口の返事の後の worker が送る。この手順書は、公開のときにやること、本番の Resend とつないだ通しの確かめ、店へ知らせのメールが届いたときの調べ方、配達の知らせの鍵の入れ替え、状態の確かめ方をまとめる。値（鍵・合言葉）はこの文書にもチャットにもコミットにも残さない。

| 場面 | 見る節 |
|---|---|
| 公開のとき | 1 |
| 本番の Resend とつないだ通しの確かめ | 2 |
| 店へ知らせのメールが届いた | 3 |
| 配達の知らせの鍵を入れ替える | 4 |
| 状態を確かめる | 5 |

| 仕組み | いつ | どこで |
|---|---|---|
| 送る | 毎分（Stripe の知らせの後に10秒まで）と、行を書いた窓口の返事の後 | `POST /api/cron/process-stripe-webhooks`・`after()` |
| 配達の状態 | Resend の知らせが届いたとき | `POST /api/webhook/resend-delivery` |
| 配達の見回り | 1時間ごと（毎分の worker の中） | Resend の API（Full access の鍵が要る） |
| 本文の片付け | 毎日 4:40（19:40 UTC） | DB の中だけ（送信済みの本文は45日、受付済みの番号は3日） |

~~~mermaid
flowchart LR
    A["状態を変える DB の関数"] -->|同じ取引で1行| B["注文のメールの表"]
    B --> C["worker"]
    C -->|重複防止キー| D["Resend"]
    D -->|配達の知らせ| E["受け口"]
    E --> B
    C -->|送れなかった・溜まり・一時停止| F["店への知らせ"]
~~~

---

## 1. 公開のときにやること

| 順 | やること | 誰が | 確かめ方 |
|---|---|---|---|
| 1 | Vercel の環境変数 `MAIL_PROVIDER` を `resend` にし、`RESEND_API_KEY`・`MAIL_FROM_ADDRESS`（確かめ済みのドメインのアドレス）・`SHOP_ALERT_EMAIL` を入れる。`RESEND_API_KEY` は Full access にする（送信専用の鍵だと、配達の見回りが「鍵の設定」で止まる。送信と Webhook は動く） | ユーザー | 5 の「送信の一時停止」で `paused` が false |
| 2 | Resend の管理画面の Webhooks で宛先 `<公開した URL>/api/webhook/resend-delivery` を作り、`email.delivered`・`email.delivery_delayed`・`email.bounced`・`email.complained`・`email.suppressed`・`email.failed` の6つを選ぶ。出た署名の鍵（`whsec_` で始まる）を Vercel の `RESEND_DELIVERY_WEBHOOK_SECRET` に入れて出し直す。お問い合わせの返信の宛先（`/api/contact/inbound`・`RESEND_WEBHOOK_SECRET`）とは別の宛先・別の鍵にする | ユーザー | Resend の管理画面で宛先が有効 |
| 3 | 2 の通しの確かめ | ユーザー（試しの注文）、Claude（確かめる） | 2 の表 |

- `MAIL_PROVIDER` が `resend` でないと、注文のメールは送らずに送信を止める（重複防止キーの無い送り手で送らないため）。
- 宛先を登録するまでの間も、1時間ごとの見回りが配達の状態を拾う。

## 2. 本番の Resend とつないだ通しの確かめ（公開の後・開店の前）

試しの注文の宛先を Resend の試し用の宛先にして、次を確かめる。試しの注文は確かめた後に取り消すか返金する。

| 宛先 | 確かめること |
|---|---|
| `delivered@resend.dev` | 管理画面の履歴に「配達済み」 |
| `bounced@resend.dev` | 「届かなかった」と「注意」、1時間以内に店へ「届かなかった注文のメール」 |
| `complained@resend.dev` | 「迷惑メールにされた」と「注意」、店への知らせ |
| `suppressed@resend.dev` | 「送信先が止められている」と「注意」、店への知らせ |

| 日付 | 宛先 | 結果 | 確かめた人 |
|---|---|---|---|
| （まだ） | | | |

## 3. 店へ知らせのメールが届いたとき

知らせは種類ごとに1時間に1回まで。お客様の氏名・住所・メールアドレスは入れず、注文番号と原因だけを書く。

### 送れなかった

件名「【要対応】送れなかった注文のメール（N件）」。やり直しても送れなかったか、このメールだけの問題で送らなかった。

1. 管理画面の ORDER タブで、その注文の「履歴」を開き、原因を見る。
2. 原因が「宛先の形が不正」なら、お客様のメールアドレスの誤りを疑い、ほかの手段（電話など）でお客様に確かめる。
3. 直せる原因なら、「お客様へ再送」で送り直す。

### 届かなかった

件名「【要確認】届かなかった注文のメール（N件）」。Resend が送った後に、相手のメールの会社で届かなかった・止められた。

| 状態 | 意味 | やること |
|---|---|---|
| 届かなかった | 宛先が無い・受け取りの拒否 | 宛先の誤りを疑い、ほかの手段でお客様に確かめる |
| 迷惑メールにされた | お客様が迷惑メールと報告した | 再送しない。必要ならほかの手段で連絡する |
| 送信先が止められている | 前に届かなかった宛先で、Resend が送らない | 宛先の誤りを疑う。Resend の管理画面の Suppressions を確かめる |
| 送信サービスで送れなかった | Resend の中で送れなかった | Resend の管理画面のそのメールの記録を確かめる |

### 送信の一時停止

件名「【要対応】注文のメールの送信を止めています」。鍵・送信元のドメイン・送り手・送信の上限の問題で、送信全体を止めている。メールは消えずに残り、直ると試した1件が送れた時点で自動で再開する（15分ごと。1日の上限は日本時間 9時の後）。

| 原因 | 直し方 |
|---|---|
| 送信の鍵の設定 | Vercel の `RESEND_API_KEY` が Resend の有効な鍵か確かめ、入れ直して出し直す |
| 送信元のドメインの設定 | Resend の管理画面で送信元のドメインの確かめ（DNS）が通っているか、`MAIL_FROM_ADDRESS` がそのドメインか確かめる |
| 送信サービスの設定 | `MAIL_PROVIDER` が `resend`、`MAIL_FROM_ADDRESS` が入っているか確かめる |
| 1日の送信の上限・1か月の送信の上限 | Resend の利用の上限を確かめ、必要なら上のプランにする |

この知らせ自体も同じ送信サービスで送るので、鍵や上限の問題では届かないことがある。管理画面の注文の「履歴」の上の表示と、5 の「送信の一時停止」でも確かめる。

### 溜まり

件名「【要確認】注文のメールの送信が遅れています」。書いてから15分以上送れていないメールがある。

1. 5 の「送信の一時停止」で止まっていないか確かめる（止まっていれば上の節）。
2. 5 の「最後の成功」で `order_email_worker` が新しいか確かめる（古ければ次の節）。
3. 原因が「送信サービスの一時的な失敗」「送信の回数の制限」なら、やり直しで送れるのを待つ（最長約4時間）。

### worker の停止

件名「【要確認】定期処理が止まっています（注文のメールの送信）」。注文のメールの worker が15分以上成功していない。[Stripe の知らせの手順書](webhook-queue-operations.md)の「定期処理が止まったとき」に沿って、毎分の定期処理（`process-stripe-webhooks`）の実行の記録と応答を確かめる。

### 原因の記号

| 記号 | 名前 | 扱い |
|---|---|---|
| `provider_unavailable` | 送信サービスの一時的な失敗 | やり直す |
| `rate_limited` | 送信の回数の制限 | 待つ時間の指示に従ってやり直す |
| `network_error` | 通信の失敗 | やり直す |
| `db_unavailable` | データベースの一時的な失敗 | やり直す |
| `lease_expired` | 処理の中断 | やり直す（同じ重複防止キーなので2通目にならない） |
| `unexpected_error` | 想定外の失敗 | やり直す |
| `config_api_key`・`config_sender_domain`・`config_provider`・`quota_daily`・`quota_monthly` | 設定の問題 | 送信全体を止める |
| `invalid_message` | 宛先の形が不正 | 送れなかった |
| `idempotency_conflict` | 同じ送信の印で中身が違う | 送れなかった（開発者に連絡） |
| `source_missing` | 注文の情報が足りない | 送れなかった（開発者に連絡） |
| `superseded` | 注文の状態が変わったため | 取りやめ |
| `no_recipient` | 宛先が無い | 取りやめ |
| `legacy_suppressed` | 移行前の注文のため | 取りやめ（移行で移した印） |

## 4. 配達の知らせの鍵の入れ替え

1. Resend の管理画面で、その宛先の署名の鍵を作り直す（古い鍵も24時間は署名に並ぶ）。
2. 24時間のうちに、新しい鍵を Vercel の `RESEND_DELIVERY_WEBHOOK_SECRET` に入れて出し直す（受け口は並んだ署名のどれか1つが合えば通す）。
3. 出し直した後、Resend の管理画面でその宛先の配達の記録が成功（200）になっているのを確かめる。

## 5. 状態を確かめる（本番は読むだけ）

~~~sql
-- 状態ごとの件数
select status, count(*) from private.order_email_outbox group by status order by status;

-- 送信の一時停止
select * from public.get_order_email_send_state();

-- 注文のメールの worker と配達の見回りの最後の成功・失敗
select * from public.get_ops_heartbeats() where job like 'order_email%';

-- 15分以上送れていないメール
select * from public.get_order_email_backlog(900);
~~~
```

`docs/06_Operations/README.md` の手順書の一覧（`webhook-queue-operations.md` へのリンクがある所）に、文字「注文のメールの手順書」・行き先 `order-email-operations.md` のリンクを足す。

`docs/06_Operations/secrets.md` の `## CRON_SECRET` の前に足す:

```markdown
## RESEND_DELIVERY_WEBHOOK_SECRET

Resend の配達の状態の知らせ（`POST /api/webhook/resend-delivery`）の Svix 署名の鍵です（`whsec_` で始まる）。お問い合わせの返信の `RESEND_WEBHOOK_SECRET` とは別の宛先・別の鍵にします。Vercel の環境変数にだけ置きます。入れ替えは[注文のメールの手順書](order-email-operations.md)の4に従います。

注文のメールは `MAIL_PROVIDER=resend` の時だけ送ります（ほかの送り手では送信を止めます）。`RESEND_API_KEY` は Full access にします（送信専用の鍵だと、1時間ごとの配達の見回りが動きません）。
```

`docs/06_Operations/webhook-queue-operations.md`:

1. 1 の表の順1の「知らせのメールを送る設定（`MAIL_PROVIDER`。未指定のときの既定は `ses` で、AWS の鍵と `AWS_REGION`。`resend` なら `RESEND_API_KEY`）も入れる」を「知らせのメールを送る設定（`MAIL_PROVIDER` は `resend` と `RESEND_API_KEY`。注文のメールは `resend` でしか送らない。注文のメールの手順書の1）も入れる」にし、「注文のメールの手順書」を `order-email-operations.md` へのリンクにする。
2. 1 の表の順5の後に、順 `5b`・やること「Resend の配達の知らせの宛先を登録する（注文のメールの手順書の1の順2）」・誰が「ユーザー」・確かめ方「Resend の管理画面で宛先が有効」の行を足す（「注文のメールの手順書」は `order-email-operations.md` へのリンク）。
3. 頭の定期処理の表の worker の行に「（Stripe の知らせの後に注文のメールも送る）」を足す。

- [ ] **Step 6: 文書の確かめ**

Run: `npm run -s validate-docs`
Expected: 今からある2件（`docs/superpowers/plans/2026-10-07-checkout-place-order-payment.md` のリンク2つ）だけ。新しい誤りは0件

- [ ] **Step 7: コミット（controller）**

```bash
git add docs/02_Requirements/requirements.md docs/superpowers/specs/2026-10-09-order-email-outbox-design.md docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md docs/03_BasicDesign/data/er.md docs/03_BasicDesign/api/api-spec.md docs/03_BasicDesign/api/route-inventory.md docs/04_DetailDesign/pages/13_checkout.md docs/04_DetailDesign/pages/16_admin.md docs/04_DetailDesign/sequence/checkout-payment.md docs/04_DetailDesign/sequence/order-administration.md docs/04_DetailDesign/sequence/stripe-webhooks.md docs/04_DetailDesign/states/order-payment.md docs/06_Operations/order-email-operations.md docs/06_Operations/README.md docs/06_Operations/secrets.md docs/06_Operations/webhook-queue-operations.md
git commit -m "docs(orders): 注文のメールの要求 FREQ-434〜438・設計の文書・手順書を足し、R-34・R-14 を直した記録を書く（グループ D）"
```

---

### Task 10: 全体の確かめ

**Files:** なし（確かめだけ。直しが要れば、その原因のタスクのファイルを直して別のコミットにする）

- [ ] **Step 1: 静的な確かめと単体**

Run: `npm run -s lint`、`npx tsc --noEmit -p tsconfig.json`、`npx jest --runInBand`
Expected: lint の誤り 0、型の誤り 0、単体は全部 PASS

- [ ] **Step 2: DB 結合**

Run: `npx supabase db reset` の後に Global Constraints の DB 結合テスト（フォルダ全体・PostgREST の3本の環境変数を付ける）。終わったら `npx supabase db reset`
Expected: 全部 PASS

- [ ] **Step 3: 守りの点検**

このプロジェクトの `security-check` の skill を、この計画で変えたファイル（`git diff --name-only 7ad71826..HEAD -- src supabase`）にかけ、結果（OWASP の点検の項目ごと）を報告に残す。指摘があれば、原因のタスクのファイルを直して別のコミットにする。

- [ ] **Step 4: E2E 全件**

Run: 3000番に何も無いことを確かめ、`npx supabase db reset` の直後に `PLAYWRIGHT_HTML_OPEN=never npm run test:e2e`、続けて `npm run e2e:compare`
Expected: 前の基準（2026-10-09 のカートとお気に入りの引き継ぎの2回目の push: 2492 passed / 174 failed / 28 skipped）より新しく落ちた試験が無い。新しく落ちた試験は単体で流し直し、(1) 単体で通るか、(2) 同じ試験の他の画面幅が通っているか、(3) `page.goto` の時間切れかアサーションの食い違いか、で切り分けて報告する

- [ ] **Step 5: グラフを新しくする**

Run: `.venv/Scripts/python.exe -m graphify update .`
Expected: 成功

- [ ] **Step 6: ユーザーに報告して止まる**

報告すること: 全部の確かめの結果（件数）、守りの点検の結果、新しく落ちた試験と切り分け、push の許可の依頼（未 push の 7ad71826 も一緒に出る）、push の後に本番の DB へ移行2本（`20261009095633_order_email_outbox.sql` → `20261009095736_order_email_enqueue.sql`）を当てる許可の依頼。当てた後は、2本のファイル名を本番の台帳の版に直し、同じコミットで文書（er.md・レビュー台帳・計画と設計書の版の記載）を直して `npm run -s validate-docs` を流す。当てた後の確かめ（読むだけ）: 3つの表と18の公開の関数があり実行は service_role だけ、`private.order_emails` が無い、取りやめの行が8行（`legacy_suppressed`）、`order-email-retention` の定期処理が1つ、Supabase の advisors に新しい指摘が無い。公開と開店の前の残り（`MAIL_PROVIDER=resend`・配達の知らせの宛先と鍵・通しの確かめ）は開店前の残りの一覧に足す
