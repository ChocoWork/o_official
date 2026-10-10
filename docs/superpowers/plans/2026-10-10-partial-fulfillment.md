# 部分発送と注文の進み具合（グループ E-1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 発送を1回ごとの記録にして在庫の品を先に送れるようにし、受注生産の品の仕上がりを記録し、注文の状態を「未決済・受注生産中・発送準備中・配送中」の言葉で管理画面とお客様の画面に出す。発送のメールを発送ごとに送り、発送と仕上がりを取り消せるようにし、在庫の画面に4つの数と履歴を出す（FREQ-439〜446）。

**Architecture:** 新しい3つの表（`order_fulfillments`・`order_fulfillment_lines`・`order_item_completions`）に、SECURITY DEFINER の DB の関数だけが書く。商品ごとの数（発送した・仕上がった・受注生産中・発送準備中・未発送）は `private.order_line_fulfillment` の1か所で数え、窓口と画面は全部その数を使う。注文の状態の値（`order_status`）は変えず、言葉は `src/lib/orders/order-progress.ts` が記録から出す。発送のメールは注文のメールの表（グループ D の outbox）に発送の番号の列を足して、発送ごとに1行書く。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Supabase（Postgres 17、SECURITY DEFINER の関数、RLS）、Jest（ts-jest・Testing Library）＋`pg`、Playwright、Mailpit（手元のメール受け）

**Spec:** [docs/superpowers/specs/2026-10-10-partial-fulfillment-design.md](../specs/2026-10-10-partial-fulfillment-design.md)（ユーザー承認 2026-10-10）。全体の決定: [docs/superpowers/specs/2026-10-10-group-e-overview-design.md](../specs/2026-10-10-group-e-overview-design.md)

## 概要

承認済みの設計書（部分発送と注文の進み具合、グループ E-1）を、12のタスクで作る手順。各タスクは「試験を先に書く → 落ちることを確かめる → 実装 → 通ることを確かめる → コミット」の順で進め、前のタスクが作った DB の関数と TS の部品を、下の共通の約束（C-1・C-2）のとおりに使う。

| Task | 作る物 | 主なファイル |
|---|---|---|
| 1 | 発送・発送の商品・仕上がりの3つの表と守り、商品ごとの数・仕上がり・読み出し・在庫の DB の関数、前からの発送済みの注文の写し（移行 A） | `supabase/migrations/20261010120000_order_fulfillments.sql` |
| 2 | 発送する・発送を取り消す DB の関数、発送ごとの発送のメール（注文のメールの表の変更）、前の発送の関数と受注の集計の view の削除（移行 B） | `supabase/migrations/20261010120100_fulfillment_order_emails.sql` |
| 3 | 注文の言葉と進み具合の段、発送と仕上がりの TS の部品（型・誤りの言葉・DB の呼び出し・発送の材料） | `src/lib/orders/order-progress.ts`・`src/lib/orders/fulfillment/` |
| 4 | 発送ごとの発送のメールの本文、取り消した発送のメールの取りやめ、再送の発送の番号、注文の確認の1行 | `src/lib/orders/email/` |
| 5 | 管理画面の窓口（発送の材料・発送・取消・仕上がり・再送・履歴）。状態の窓口から発送の道を消す | `src/app/api/admin/orders/[id]/` |
| 6 | 発送の画面の作り直し、仕上がりの画面、履歴の画面の取消と発送ごとの再送 | `src/components/OrderShipDialog.tsx` ほか |
| 7 | 管理画面の注文の一覧（言葉・一部発送済みの印・商品の数・ボタン・絞り込み・件数・CSV） | `src/app/api/admin/orders/route.ts`・`src/components/OrderSection.tsx`・`src/app/admin/page.tsx` |
| 8 | お客様の注文の画面（言葉・進み具合の段・発送ごとの配送情報・まだ送っていない商品） | `src/app/api/orders/`・`src/app/account/orders/[id]/page.tsx` |
| 9 | 在庫の画面の4つの数と、誰が・どの注文で動かしたかの履歴 | `src/app/api/admin/items/[id]/variants/route.ts`・`src/app/admin/item/ItemStockSection.tsx` |
| 10 | E2E（新しい8本と、今の E2E の直し。3つの画面幅） | `e2e/` |
| 11 | 要求表（FREQ-439〜446）と、設計の文書・手順書 | `docs/` |
| 12 | 全体の確かめ（単体・型・lint・DB 結合・E2E の全件と前回との比べ）と、本番への出し方 | — |

- 実装は Codex（使えない間は Sonnet）、レビューは Opus、コミットは controller がタスクのファイルだけを名指しで行う
- push と本番の DB への適用は、全部の確かめの後に、ユーザーの許可を得てから行う（Task 12 の最後の節）

## Global Constraints

- ユーザーの方針: Shopify と同じ形に近づける。Shopify に無い所は業界の定番に従う。計画に無い判断が要る時もこの順で決め、決めたことは台帳に残す
- 注文の状態の値（`order_status`）は変えない: `payment_in_progress`・`pending`・`paid`・`failed`・`abandoned`・`cancelled`・`shipped`。`paid` は「受注生産中・発送準備中・一部が配送中」、`shipped` は「全部を送った」
- 注文の言葉（一字も変えない）: `支払い手続き中`・`未決済`・`受注生産中`・`発送準備中`・`配送中`・`配達済み`・`決済失敗`・`放棄`・`キャンセル`。印: `一部発送済み`。`支払い手続き中` と `放棄` はお客様に出さない（今のまま）
- 言葉の決め方: `paid`・`shipped` の注文は、商品の段階のうちいちばん手前（受注生産中 → 発送準備中 → 配送中 → 配達済みの順で手前）。配達済みは E-4 から（E-1 では発送した品は全部 `配送中`）。`一部発送済み` は発送した数が1以上で未発送の数も1以上の時
- お客様の進み具合の段（一字も変えない）: 在庫の品だけの注文は `お支払い`・`発送準備中`・`配送中`・`配達済み`、受注生産の品を含む注文は `お支払い`・`受注生産中`・`発送準備中`・`配送中`・`配達済み`。キャンセル・決済失敗の注文には段を出さない
- 商品ごとの数（`private.order_line_fulfillment`）: `shipped`＝取り消していない発送の数の合計、`completed`＝在庫の品は `quantity`・受注生産の品は取り消していない仕上がりの合計、`in_production`＝`quantity − completed`、`ready_unshipped`＝`completed − shipped`、`unshipped`＝`quantity − shipped`。`shipped ≤ completed ≤ quantity` を守る
- 受注生産の品は、仕上がりを記録するまで送れない。仕上がりを記録できるのは `paid` の注文だけ
- 発送の画面の最初の数は、商品ごとの発送準備中の数の全部（受注生産中の品は入らない）
- 画面の文言（一字も変えない）:
  - 一覧のボタン: `発送済みにする`（今のまま）・`仕上がりを記録する`・`履歴`（今のまま）
  - 一覧の絞り込み: `すべて`・`支払い手続き中`・`未決済`・`発送待ち（受注生産中・発送準備中）`・`発送済み（配送中・配達済み）`・`決済失敗`・`放棄`・`キャンセル`
  - 発送の画面: 題 `発送済みにする`（今のまま）、ボタン `発送する`・`キャンセル`、印 `在庫`・`受注生産`、見出し `発送準備中`・`今回送る数`、受注生産中の行 `受注生産中 {n}`・入力の名前 `仕上がった数`・ボタン `仕上がりを記録`、合計 `今回送る数の合計: {n}点`、合計0の誤り `送る数を入れてください。`、チェック `お客様に発送のメールを送る`（今のまま）
  - 答えが分からない時: `結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。`、ボタン `もう一度確かめる`・`閉じる`
  - 仕上がりの画面: 題 `仕上がりを記録する`、入力の名前 `仕上がった数`、ボタン `記録する`・`キャンセル`、記録の後の知らせ `仕上がりを記録しました。`
  - 履歴: `発送（{n}回目）`・`発送（{n}回目）を取り消しました`・`受注生産の品が仕上がりました`・`仕上がりを取り消しました`、発送のメールの種類の名前 `発送（{n}回目）`、ボタン `この発送を取り消す`・`この仕上がりを取り消す`
  - 発送の取消の確かめ: `発送（{n}回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。`、ボタン `取り消す`・`やめる`
  - 仕上がりの取消の確かめ: `この仕上がりを取り消し、その商品を受注生産中に戻します。`、ボタン `取り消す`・`やめる`
  - お客様の注文の画面: 発送ごとの区切りの名前 `配送情報（{n}回目）`、見出し `発送準備中の商品`・`受注生産中の商品`
  - 在庫の画面: `すぐ出せる数`・`引き当て済み`・`手元の数`・`受注生産`、説明 `すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。`、履歴で記録した人が空の時 `自動`
- 窓口の答えの誤りの言葉（一字も変えない。`src/lib/orders/fulfillment/fulfillment-messages.ts` の1か所で持つ）は Task 3 の表のとおり
- 発送のメールの件名は `【Le Fil des Heures】商品を発送いたしました（{注文番号}）`（今のまま）。本文は設計書 8-1 のとおり。値段は書かない。残りがある時だけ `残りの商品は、準備ができ次第お送りします。`
- 注文の確認のメール（入金済み・入金待ち）に、在庫の品と受注生産の品が両方ある時だけ（`review_reason = 'stock_not_reserved'` の時は書かない）、ご注文内容の下へ `在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。`
- 権限: 発送の材料・発送・発送の取消・仕上がり・仕上がりの取消は `admin.orders.manage`。履歴は `admin.orders.read`（今のまま）。書く窓口は CSRF（`requireCsrfOrDeny`）と回数の制限（送信元ごとと管理者ごと）を通す。回数の制限の窓口名と回数: `admin:orders:fulfillment-create`（10分に60回）・`admin:orders:fulfillment-cancel`（10分に30回）・`admin:orders:completion-record`（10分に60回）・`admin:orders:completion-cancel`（10分に30回）
- 監査（`logAudit`）に伝票番号・宛先・氏名・住所を入れない（`maskAuditEvent` は `number` を含む鍵を伏せるが、そもそも入れない）
- 新しい3つの表は `public`。RLS を有効にし、`anon`・`authenticated` は RESTRICTIVE の方針で全部拒み、権限も外す。`service_role` は SELECT だけ。書くのは関数だけ。関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名。`PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、`service_role` だけに与える（`private` の関数は `PUBLIC` から外すだけ）。最後に `NOTIFY pgrst, 'reload schema';`
- 移行は2本: A `supabase/migrations/20261010120000_order_fulfillments.sql`、B `supabase/migrations/20261010120100_fulfillment_order_emails.sql`。どちらも `BEGIN;`〜`COMMIT;`。前からのデータの写しは何度当てても同じ結果に書く。本番 DB へは、全タスクの後、ユーザーの push の後で許可を得て Supabase MCP の `apply_migration` で A・B の順に当て、当てた版にファイル名と文書の版を直す
- 画面と機能の変更は `docs/02_Requirements/requirements.md` に FREQ-439〜446 の行を足す（Task 11。`grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` が FREQ-438 であることを確かめる）。新しい E2E は `e2e/FR-ADMIN-068`〜`073`・`e2e/FR-ACCOUNT-032`・`e2e/FR-CHECKOUT-050`（`ls e2e | grep -E "^FR-ADMIN-[0-9]" | sort -V | tail -1` が FR-ADMIN-067、FR-ACCOUNT は 031、FR-CHECKOUT は 049 であることを確かめる）
- E2E は本番ビルド（`next build && next start`）・手元の Supabase（`npx supabase db reset` の直後）で、mobile（390px）・tablet（768px）・desktop（1280px）の3つの画面幅で流す。流す前に3000番に何も無いことを `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめる。DB 結合テストの直後に E2E を流さない（`npx supabase db reset` を挟む）
- DB 結合テストは `npx supabase db reset` の後に、フォルダ全体を `--runInBand` で流す: `eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"` の後に `LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`（値は画面に出さない）
- 単体テストは `npx jest tests/unit --runInBand`、型は `npx tsc --noEmit`、lint は `npm run lint`
- 実装は Codex（`--model gpt-6.1-sol`、コミットしない。週の枠が尽きている間は Sonnet の subagent が代わる）。E2E と DB 結合テストは controller が流す。controller がタスクのファイルだけを名指しでコミットし、レビューは Opus。master に直接コミットし、push しない。`--no-verify` を使わない。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 秘密の値（`.env.local` の鍵・合言葉・印・確認コード）を画面・ログ・文書・報告に出さない
- 返答・文書・コメントは日本語。コードのコメントは周りに合わせる（理由を書く。何をしているかの繰り返しは書かない）。ソースを読む前に `.venv/Scripts/python.exe -m graphify query "<問い>"` で場所を確かめる

## Review Focus

本計画のタスクのテストで直接は確かめにくいが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **発送する直前に、もう1人（または別のタブ）が同じ品を発送した**: 注文の行の鍵で1つずつ進み、後の方は「発送準備中の数を超える」で 409 になり、画面に `発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。` が出る。2回目の発送は記録されない（Task 2 の「同時に2つの発送」、Task 5 の 409 の答え、Task 6 の発送の画面の誤りの出し方）
2. **発送を押した後に通信が切れた（サーバーは記録した）**: 画面は入力を止めて `もう一度確かめる` だけを出し、同じ重複防止キーで送り直すと前の結果（`replayed`）が返り、発送は1つだけ（Task 2 の送り直し、Task 5 の同じ番号の答え、Task 6 の答えが分からない時の画面）
3. **送っている途中の発送のメールの発送を取り消した**: 送る前・やり直し待ちの行は取りやめになり、送っている途中の行は worker が中身を作る時に取消を見て取りやめる。もう送った行はそのまま（Task 2 の取消とメールの取りやめ、Task 4 の worker の取りやめ）
4. **受注生産の品を一部送った後に、店が仕上がりを取り消そうとした**: 送った数を下回る取消は `もう発送した数があるため、取り消せません。` で断り、数は変わらない（Task 1 の仕上がりの取消、Task 5 の 409、Task 6 の履歴の画面の確かめ）
5. **前からの発送済みの注文（移行の前に発送した）**: 発送の記録と仕上がりの記録が写され、発送のメールの再送・お客様の注文の画面の配送情報・発送の取消が新しい注文と同じに動く（Task 1・2 の写しの試験、Task 4 の再送、Task 8 のお客様の窓口）

---

## 本計画の決め事（設計書の書いていないところ）

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | 移行は2本。A（`20261010120000_order_fulfillments.sql`）は3つの表・守り・数の関数・仕上がりの関数・読み出しの関数・在庫の関数・前からの写し。B（`20261010120100_fulfillment_order_emails.sql`）は注文のメールの表の変更と、発送の関数（発送のメールを書くので outbox の列が要る）・古い関数と view の削除 | 発送の関数は発送のメールの予定を書くので、outbox に発送の番号の列ができてから作る |
| P2 | 一覧の画面のために、注文の番号の配列で数を返す `public.list_order_line_fulfillment(_order_ids uuid[])` を作る（1回に200件まで） | 一覧の1ページ分の注文の数を、1回の呼び出しで読む |
| P3 | DB の関数は決まった言葉（例 `QUANTITY_EXCEEDS_READY`）で止め、TS は言葉の部分一致で誤りの記号（`FulfillmentErrorCode`）に直す。窓口は `{ error, code }` を返す | グループ D の再送と同じ形。画面は記号ではなく `error` の言葉を出す |
| P4 | `stock_movements(order_item_id)` に索引を足す（移行 A） | 引き当て済みの数を商品の行ごとに台帳から数えるため。今の索引は variant_id と order_id だけ |
| P5 | 仕上がりの記録は1つの商品の行ごとに1行。1回の操作の行は同じ `request_key` を持つ（`(request_key, order_item_id)` で一意） | 取消を商品ごとにできる。重複防止は操作ごと |
| P6 | 発送の画面と仕上がりの画面は、`orderId` を受け取って自分で材料を読む部品にする。成功したら親に知らせ、親（管理画面）が一覧を読み直す | 今の発送の画面は配送業者と伝票番号だけを親に返していたが、商品の数は画面の中で決めるため |
| P7 | 注文の言葉と進み具合の段は `src/lib/orders/order-progress.ts`（画面からも使う。サーバーだけの物を import しない）の1か所で出す。今の `src/lib/orders/order-status.ts` の `ORDER_PROGRESS_STEPS`・`resolveOrderProgressIndex` は使わなくなるので消す（`formatOrderStatus` は残す） | 管理画面・お客様の画面・窓口が同じ言葉を出す |
| P8 | お客様の窓口は、持ち主の確かめ（今のログインの確かめと RLS）を通った注文だけ、service_role で発送と数を読む | 新しい表はお客様から直接読めない（3-4 の守り） |
| P9 | 管理画面の一覧の窓口は、注文と商品は今のまま利用者の JWT で読み、数は service_role で読む（今の支払いの要対応と同じ） | 窓口の権限の確かめを変えない |
| P10 | 管理画面の一覧の窓口は、DB の状態を `orderStatus`、言葉を `status`、言葉の記号を `progressKey` で返す。画面の比べ方（件数・CSV）は `orderStatus` を使う | 言葉は表示のためで、仕事の判断には DB の状態を使う |
| P11 | 発送のメールの E2E は、グループ D の P11 と同じく、手元の DB の関数を呼び、worker の定期処理の入口を叩き、Mailpit を数えて確かめる。管理画面の E2E は管理画面の窓口を差し替えて流す | 本物の管理者のログインには2段階認証が要り、E2E の仕組みが無い |
| P12 | 前からの発送の写しでは、発送のメールを送ったか（`notify_customer`）を「その注文に発送のメールの行があるか」で決める（移行 A。outbox はグループ D からある） | 前の発送の画面のチェックは記録に残っていない |
| P13 | 発送の関数は、`completes_order` を発送の行を書く前に「未発送の合計 − 今回送る数の合計 = 0」で決める | 行を書いた後の数え直しを省く |
| P14 | `supabase/pending/harden_order_state_transitions.sql` の状態の移り方の表に「発送済み → 決済完了」を、変更の理由が `admin_cancel_fulfillment` の時だけ足す（Task 2）。設計書 12-3 の「`admin_ship_paid_order` の名前を直す」は、保留の SQL にその名前が無いので直す所が無い。単体テスト `tests/unit/migrations/order-state-transition-hardening.test.ts` の最初の試験は前の移行のファイル（`20260925000218`）を読むので変えず、移り方の確かめと、移行 B の2つの関数が service_role だけで動く確かめを足す | 設計書 12-3。当てる時に今の作りと食い違わないため。当てるのは今回もしない |
| P15 | 試験で注文の状態を直接変える時は、変更の理由（`app.order_change_reason`）を付け、入金済みからの取消は全額返金と同じ更新にする | `order_state_transition_hardening` の試験が保留の守りを手元の DB に当て、同じ実行の後の試験はその守りの下で動く（jest の順番は決まっていない） |
| P16 | 移行 B は前の発送の関数（`admin_ship_paid_order`）と view（`variant_backorder_summary`）を消す。それを使う窓口（`status` の発送の道・在庫の窓口）は Task 5・Task 9 で直すので、その間は手元でその2つの操作が失敗する | push は Task 12 の後。利用者には出ない |

---

## File Structure

| ファイル | 責務 | タスク |
|---|---|---|
| `supabase/migrations/20261010120000_order_fulfillments.sql`（新規） | 3つの表・守り・数の関数・仕上がりの関数・読み出しの関数・在庫の関数・前からの写し | 1 |
| `tests/integration/db/order_fulfillments.integration.test.ts`（新規） | 移行 A の結合テスト | 1 |
| `tests/integration/db/helpers/order-fixtures.ts` | 在庫の品と受注生産の品を持つ注文を作る道具 `insertOrderWithLines` を足す | 1 |
| `supabase/migrations/20261010120100_fulfillment_order_emails.sql`（新規） | 注文のメールの表の変更・発送の関数・古い関数と view の削除 | 2 |
| `tests/integration/db/fulfillment_order_emails.integration.test.ts`（新規） | 移行 B の結合テスト | 2 |
| `tests/integration/db/order_email_enqueue.integration.test.ts`・`order_email_outbox.integration.test.ts`・`order_state_transition_hardening.integration.test.ts`・`payment_exceptions.integration.test.ts`・`reconciler_composed.integration.test.ts` | `admin_ship_paid_order` を新しい関数に置き換える・発送のメールの一意の決まりの変更に合わせる | 2 |
| `supabase/pending/harden_order_state_transitions.sql`、`tests/unit/migrations/order-state-transition-hardening.test.ts` | 状態の移り方の表を直す（P14） | 2 |
| `src/lib/orders/email/order-email-types.ts`、`tests/unit/lib/orders/email/order-email-types.test.ts` | 発送のメールを再送できる状態・取りやめの理由 `fulfillment_cancelled` | 2 |
| `tests/integration/db/order_fulfillments.integration.test.ts`（Task 1 の試験）、`tests/integration/db/order_items_variant.integration.test.ts` | 移行 B の CHECK と view の削除に合わせる | 2 |
| `src/lib/orders/order-progress.ts`（新規） | 注文の言葉・一部発送済み・進み具合の段（画面からも使う） | 3 |
| `src/lib/orders/fulfillment/fulfillment-types.ts`（新規） | 発送と仕上がりの窓口の形と、最初の数の決め方（画面からも使う） | 3 |
| `src/lib/orders/fulfillment/fulfillment-messages.ts`（新規） | 誤りの記号ごとの言葉と HTTP（画面からも使う） | 3 |
| `src/lib/orders/fulfillment/fulfillment-store.ts`（新規） | 発送と仕上がりの DB の関数の呼び出しと誤りの直し（サーバーだけ） | 3 |
| `src/lib/orders/fulfillment/fulfillment-materials.ts`（新規） | 発送の画面の材料を組み立てる（サーバーだけ） | 3 |
| `src/lib/orders/order-status.ts` | `ORDER_PROGRESS_STEPS`・`resolveOrderProgressIndex` を消す（P7。使う所は Task 8 で置き換える） | 8 |
| `src/lib/orders/email/order-email-store.ts`・`order-email-worker.ts`・`order-email-compose.ts`、`src/lib/orders/order-confirmation-email.ts` | 発送ごとのメール・再送の発送の番号・注文の確認の1行（`order-email-types.ts` は Task 2 が直す） | 4 |
| `src/app/api/admin/orders/[id]/fulfillments/route.ts`（新規） | 発送の材料（GET）・発送する（POST） | 5 |
| `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts`（新規） | 発送の取消 | 5 |
| `src/app/api/admin/orders/[id]/completions/route.ts`（新規） | 仕上がりの記録 | 5 |
| `src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts`（新規） | 仕上がりの取消 | 5 |
| `src/app/api/admin/orders/[id]/status/route.ts` | 発送（`status: 'shipped'`）の道を消す | 5 |
| `src/app/api/admin/orders/[id]/emails/resend/route.ts` | 中身を `{ kind, fulfillmentId? }` にする | 5 |
| `src/lib/orders/email/order-history.ts`、`src/app/api/admin/orders/[id]/history/route.ts` | 履歴に発送・仕上がりとその取消、発送ごとのメールを足す | 5 |
| `src/components/OrderShipDialog.tsx`（作り直し）、`src/components/OrderCompletionDialog.tsx`（新規）、`src/components/OrderHistoryDialog.tsx` | 発送の画面・仕上がりの画面・履歴の取消の操作と発送ごとの再送 | 6 |
| `src/lib/orders/fulfillment/fulfillment-client.ts`（新規） | 画面（ブラウザ）から発送・仕上がり・取消の窓口を呼び、答えを「記録できた・断られた・分からない」に分ける。商品の見出しと数の入力の部品 | 6 |
| `src/components/ui/Dialog/Dialog.tsx`・`Dialog_types.ts`・`Dialog.css` | 小さい画面で画面いっぱいに開く `fullScreenOnMobile` | 6 |
| `src/app/api/admin/orders/route.ts`、`src/components/OrderSection.tsx`、`src/app/admin/page.tsx` | 一覧の言葉・印・数・ボタン・絞り込み・件数・CSV・画面のつなぎ | 7 |
| `src/app/api/orders/[id]/route.ts`・`src/app/api/orders/route.ts`、`src/app/account/orders/[id]/page.tsx`、`src/app/account/page.tsx` | お客様の言葉・進み具合・発送ごとの配送情報 | 8 |
| `src/app/api/admin/items/[id]/variants/route.ts`、`src/app/admin/item/ItemStockSection.tsx` | 在庫の4つの数と履歴 | 9 |
| `e2e/FR-ADMIN-068`〜`073`・`e2e/FR-ACCOUNT-032`・`e2e/FR-CHECKOUT-050`（新規）、今の E2E の直し、`e2e/order-email-test-utils.ts` | E2E | 10 |
| 要求表・設計の文書・手順書・グループ D の設計書の書き足し | 文書 | 11 |

---

## 共通の約束（タスクをまたぐ名前と形）

各タスクの実装者は自分のタスクしか読まない。ここに書いた名前・引数・型・答えの形は、作る側も使う側もこのとおりにする。

### C-1 DB の関数

移行 A（Task 1）:

| 関数 | 返す | 断り（`RAISE EXCEPTION` の言葉と ERRCODE） |
|---|---|---|
| `private.order_line_fulfillment(_order_id uuid)` | `TABLE (order_item_id uuid, variant_id bigint, fulfillment_type text, quantity integer, shipped integer, completed integer, in_production integer, ready_unshipped integer, unshipped integer)` | — |
| `public.list_order_line_fulfillment(_order_ids uuid[])` | `TABLE (order_id uuid, order_item_id uuid, variant_id bigint, fulfillment_type text, quantity integer, shipped integer, completed integer, in_production integer, ready_unshipped integer, unshipped integer)`。空・NULL なら0行 | 201件以上は `TOO_MANY_ORDERS`（22023） |
| `public.admin_record_completion(_order_id uuid, _actor_id uuid, _request_key uuid, _lines jsonb)` | `TABLE (completion_id uuid, order_item_id uuid, quantity integer, replayed boolean)`（記録した行ごと） | `COMPLETION_ARGUMENT_INVALID`（22023）、`ORDER_NOT_FOUND`（P0002）、`COMPLETION_REQUEST_MISMATCH`（22023）、`ORDER_NOT_IN_PRODUCTION`（22023）、`LINE_NOT_IN_PRODUCTION`（22023）、`QUANTITY_EXCEEDS_IN_PRODUCTION`（22023） |
| `public.admin_cancel_completion(_order_id uuid, _completion_id uuid, _actor_id uuid)` | `TABLE (outcome text)`（`cancelled`・`already_cancelled`） | `COMPLETION_ARGUMENT_INVALID`、`ORDER_NOT_FOUND`、`COMPLETION_NOT_FOUND`（P0002）、`ORDER_NOT_IN_PRODUCTION`、`COMPLETION_ALREADY_SHIPPED`（22023） |
| `public.list_order_fulfillments(_order_id uuid)` | `TABLE (fulfillment_id uuid, number integer, shipping_carrier text, tracking_number text, notify_customer boolean, completes_order boolean, shipped_at timestamptz, created_by_email text, cancelled_at timestamptz, cancelled_by_email text, legacy boolean, lines jsonb)`。`lines` は `[{"order_item_id": "<uuid>", "quantity": n}]`。何回目の新しい順 | — |
| `public.list_order_completions(_order_id uuid)` | `TABLE (completion_id uuid, order_item_id uuid, quantity integer, created_at timestamptz, created_by_email text, cancelled_at timestamptz, cancelled_by_email text, legacy boolean)`。新しい順 | — |
| `public.list_variant_stock_states(_variant_ids bigint[])` | `TABLE (variant_id bigint, committed integer, backorder integer)`。渡した番号ごとに1行 | 501件以上は `TOO_MANY_VARIANTS`（22023） |
| `public.list_item_stock_history(_item_id bigint, _limit integer)` | `TABLE (movement_id bigint, variant_id bigint, delta integer, reason text, note text, created_at timestamptz, actor_email text, order_id uuid, balance_after integer)`。新しい順。`_limit` は1〜200に丸める | — |

`_lines` の形（発送も仕上がりも同じ）: `[{"order_item_id": "<uuid>", "quantity": <1〜999の整数>}]`。1〜100行。同じ `order_item_id` は1行だけ。

移行 B（Task 2）:

| 関数 | 返す | 断り |
|---|---|---|
| `public.admin_create_fulfillment(_order_id uuid, _actor_id uuid, _request_key uuid, _shipping_carrier text, _tracking_number text, _notify_customer boolean, _lines jsonb)` | `TABLE (fulfillment_id uuid, number integer, completes_order boolean, order_status public.order_status, replayed boolean)` | `FULFILLMENT_ARGUMENT_INVALID`（22023）、`ORDER_NOT_FOUND`（P0002）、`FULFILLMENT_REQUEST_MISMATCH`（22023）、`ORDER_NOT_SHIPPABLE`（22023）、`SHIPPING_ADDRESS_INCOMPLETE`（22023）、`PAYMENT_REVIEW_REQUIRED`（22023）、`LINE_NOT_IN_ORDER`（22023）、`QUANTITY_EXCEEDS_READY`（22023） |
| `public.admin_cancel_fulfillment(_order_id uuid, _fulfillment_id uuid, _actor_id uuid)` | `TABLE (outcome text, order_status public.order_status)`（`cancelled`・`already_cancelled`） | `FULFILLMENT_ARGUMENT_INVALID`、`ORDER_NOT_FOUND`、`FULFILLMENT_NOT_FOUND`（P0002）、`FULFILLMENT_CANCEL_NOT_ALLOWED`（22023） |
| `private.enqueue_order_email(_order_id uuid, _kind text, _variant text DEFAULT NULL, _fulfillment_id uuid DEFAULT NULL)` | `boolean` | 発送のメールに発送の番号が無い・ほかの種類に発送の番号がある時は表の CHECK（23514） |
| `public.claim_order_email(_lease_seconds integer)` | 今の列の最後に `fulfillment_id uuid` を足す | 今のまま |
| `public.list_order_email_history(_order_id uuid)` | 今の列の最後に `fulfillment_id uuid, fulfillment_number integer` を足す | — |
| `public.request_order_email_resend(_order_id uuid, _kind text, _actor_id uuid, _fulfillment_id uuid DEFAULT NULL)` | `uuid` | 今の断りに加え、発送のメールで発送の番号が無いと `RESEND_FULFILLMENT_REQUIRED`（22023）。発送の番号がその注文の物でない・取り消してある・発送のメール以外に発送の番号を渡したと `RESEND_NOT_ALLOWED`。発送のメールを再送できる注文の状態は `paid`・`shipped` |
| `public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text)` | `boolean` | 理由に `fulfillment_cancelled` を足す（取り消した発送の発送のメールだけ。ほかは `SKIP_REASON_NOT_ALLOWED`（22023）） |
| `private.link_legacy_shipped_emails()` | `integer`（結んだ行の数） | 前の発送のメールの行を、移行 A が写した前からの発送に結ぶ。何度呼んでも同じ結果 |
| 消す: `public.admin_ship_paid_order(uuid, uuid, text, text, boolean)`、view `public.variant_backorder_summary`、前の形の `private.enqueue_order_email(uuid, text, text)`・`public.request_order_email_resend(uuid, text, uuid)` | — | — |

表の変更（移行 B）: `private.order_email_outbox.fulfillment_id uuid`（`order_fulfillments(id)` ON DELETE RESTRICT）、CHECK `order_email_outbox_fulfillment_check`（`(kind = 'shipped') = (fulfillment_id IS NOT NULL)`）、一意の索引 `order_email_outbox_auto_once_idx`（`(order_id, kind)`、自動で発送のメール以外）・`order_email_outbox_auto_shipped_idx`（`(fulfillment_id)`、自動の発送のメール）・`order_email_outbox_manual_open_idx`（`(order_id, kind, fulfillment_id) NULLS NOT DISTINCT`、手の再送の送信待ち）。注文の改訂の理由は発送 `admin_create_fulfillment`・発送の取消 `admin_cancel_fulfillment`

### C-2 TS の部品

`src/lib/orders/order-progress.ts`（Task 3。画面からも使う）:

```ts
import type { OrderStatus } from '@/lib/orders/order-payment-types';

export const ORDER_PROGRESS_KEYS = [
  'payment_in_progress', 'unpaid', 'in_production', 'ready', 'in_transit', 'delivered', 'failed', 'abandoned', 'cancelled',
] as const;
export type OrderProgressKey = (typeof ORDER_PROGRESS_KEYS)[number];
export const ORDER_PROGRESS_LABELS = {
  payment_in_progress: '支払い手続き中', unpaid: '未決済', in_production: '受注生産中', ready: '発送準備中',
  in_transit: '配送中', delivered: '配達済み', failed: '決済失敗', abandoned: '放棄', cancelled: 'キャンセル',
} as const satisfies Record<OrderProgressKey, string>;
export type OrderProgressLabel = (typeof ORDER_PROGRESS_LABELS)[OrderProgressKey];
export const PARTIALLY_SHIPPED_LABEL = '一部発送済み';
export type OrderLineProgressCounts = {
  fulfillmentType: string; quantity: number; shipped: number; inProduction: number; readyUnshipped: number; unshipped: number;
};
export type OrderProgress = { key: OrderProgressKey; label: OrderProgressLabel; partiallyShipped: boolean };
export function deriveOrderProgress(status: OrderStatus, lines: readonly OrderLineProgressCounts[]): OrderProgress;
export type OrderProgressStepKey = 'payment' | 'in_production' | 'ready' | 'in_transit' | 'delivered';
export const ORDER_PROGRESS_STEP_LABELS = {
  payment: 'お支払い', in_production: '受注生産中', ready: '発送準備中', in_transit: '配送中', delivered: '配達済み',
} as const satisfies Record<OrderProgressStepKey, string>;
export type OrderProgressStep = { key: OrderProgressStepKey; label: string; state: 'done' | 'current' | 'todo' };
/** 支払い手続き中・決済失敗・放棄・キャンセルは null（段を出さない） */
export function buildOrderProgressSteps(progress: OrderProgress, lines: readonly OrderLineProgressCounts[]): OrderProgressStep[] | null;
```

- `deriveOrderProgress`: `payment_in_progress`→`payment_in_progress`、`pending`→`unpaid`、`failed`→`failed`、`abandoned`→`abandoned`、`cancelled`→`cancelled`。`paid`・`shipped` は、`inProduction` の合計 > 0 なら `in_production`、そうでなく `readyUnshipped` の合計 > 0 なら `ready`、そうでなく `shipped` の合計 > 0 なら `in_transit`、どれでもなければ `ready`（商品の行が無い異常な注文）。`partiallyShipped` は `paid`・`shipped` の時だけ「`shipped` の合計 > 0 かつ `unshipped` の合計 > 0」、ほかは false
- `buildOrderProgressSteps`: 段は `payment`、（`fulfillmentType === 'backorder'` の行があれば）`in_production`、`ready`、`in_transit`、`delivered`。今の段は `unpaid`→`payment`、`in_production`→`in_production`、`ready`→`ready`、`in_transit`→`in_transit`、`delivered`→`delivered`。今の段より前は `done`、今の段は `current`、後は `todo`。`delivered` の時は全部 `done`

`src/lib/orders/fulfillment/fulfillment-types.ts`（Task 3。画面からも使う）:

```ts
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';

export type FulfillmentLineQuantity = { orderItemId: string; quantity: number };
export type FulfillmentMaterialLine = {
  orderItemId: string; name: string; color: string | null; size: string | null; fulfillmentType: 'stock' | 'backorder';
  quantity: number; shipped: number; inProduction: number; readyUnshipped: number; unshipped: number;
};
export type FulfillmentRecordSummary = {
  id: string; number: number; carrier: string | null; trackingNumber: string | null; shippedAt: string;
  notifyCustomer: boolean; completesOrder: boolean; cancelledAt: string | null; lines: FulfillmentLineQuantity[];
};
export type FulfillmentBlockedReason = 'not_shippable' | 'address_incomplete' | 'payment_review_required';
export type FulfillmentMaterials = {
  order: { id: string; orderNumber: string; status: OrderStatus; progress: OrderProgress };
  blockedReason: FulfillmentBlockedReason | null;
  lines: FulfillmentMaterialLine[];
  fulfillments: FulfillmentRecordSummary[];
};
export type CreateFulfillmentRequest = {
  requestKey: string; carrier: ShippingCarrierId; trackingNumber: string; notifyCustomer: boolean; lines: FulfillmentLineQuantity[];
};
export type CreateFulfillmentResponse = {
  fulfillmentId: string; number: number; completesOrder: boolean; orderStatus: OrderStatus; replayed: boolean;
};
export type CancelFulfillmentResponse = { outcome: 'cancelled' | 'already_cancelled'; orderStatus: OrderStatus };
export type RecordCompletionRequest = { requestKey: string; lines: FulfillmentLineQuantity[] };
export type RecordCompletionResponse = { completionIds: string[]; replayed: boolean };
export type CancelCompletionResponse = { outcome: 'cancelled' | 'already_cancelled' };
export const FULFILLMENT_ERROR_CODES = [
  'order_not_found', 'not_shippable', 'address_incomplete', 'payment_review_required', 'quantity_exceeds_ready',
  'fulfillment_request_mismatch', 'invalid_argument', 'fulfillment_not_found', 'fulfillment_cancel_not_allowed',
  'not_in_production', 'quantity_exceeds_in_production', 'completion_request_mismatch', 'completion_not_found',
  'completion_already_shipped',
] as const;
export type FulfillmentErrorCode = (typeof FULFILLMENT_ERROR_CODES)[number];
export type FulfillmentErrorResponse = { error: string; code: FulfillmentErrorCode | 'invalid_request' | 'failed' };
/** 発送の画面の最初の数: 未発送が1以上の商品ごとに、発送準備中の数の全部（受注生産中は入らない） */
export function initialShipQuantities(lines: readonly FulfillmentMaterialLine[]): Record<string, number>;
/** 入れた数の合計 */
export function totalQuantity(quantities: Record<string, number>): number;
```

`src/lib/orders/fulfillment/fulfillment-messages.ts`（Task 3。画面からも使う）:

| 記号 | HTTP | 言葉 |
|---|---|---|
| `order_not_found` | 404 | `注文が見つかりません。` |
| `not_shippable` | 409 | `発送できる状態ではありません。一覧を更新してください。` |
| `address_incomplete` | 409 | `配送先の必須項目が足りないため発送できません。` |
| `payment_review_required` | 409 | `支払額の確認（要対応）が済むまで発送できません。` |
| `quantity_exceeds_ready` | 409 | `発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。` |
| `fulfillment_request_mismatch` | 409 | `前の発送と内容が違います。画面を開き直してください。` |
| `invalid_argument` | 400 | `入力を確かめてください。` |
| `fulfillment_not_found` | 404 | `発送の記録が見つかりません。` |
| `fulfillment_cancel_not_allowed` | 409 | `この発送は取り消せません。注文の状態を確かめてください。` |
| `not_in_production` | 409 | `仕上がりを記録できる状態ではありません。一覧を更新してください。` |
| `quantity_exceeds_in_production` | 409 | `仕上がった数が受注生産中の数を超えています。一覧を更新してください。` |
| `completion_request_mismatch` | 409 | `前の記録と内容が違います。画面を開き直してください。` |
| `completion_not_found` | 404 | `仕上がりの記録が見つかりません。` |
| `completion_already_shipped` | 409 | `もう発送した数があるため、取り消せません。` |

ほかに: `INVALID_REQUEST_MESSAGE = '入力を確かめてください。'`（400、`code: 'invalid_request'`）、失敗（500、`code: 'failed'`）の言葉は発送 `発送の記録に失敗しました。`・発送の取消 `発送の取消に失敗しました。`・仕上がり `仕上がりの記録に失敗しました。`・仕上がりの取消 `仕上がりの取消に失敗しました。`・発送の材料の読み込み `発送の材料を読み込めませんでした。`。答えが分からない時の言葉 `UNKNOWN_OUTCOME_MESSAGE` は Global Constraints の文。

`fulfillment-messages.ts` の形（Task 3 が作り、Task 5・6 が使う）: `FULFILLMENT_ERROR_MESSAGES: Record<FulfillmentErrorCode, { status: 400 | 404 | 409; message: string }>`（上の表の「HTTP」と「言葉」）、`INVALID_REQUEST_BODY`（`{ error: INVALID_REQUEST_MESSAGE, code: 'invalid_request' }`）、`FULFILLMENT_FAILURE_MESSAGES`（`create`・`cancel`・`completion`・`completion_cancel`・`materials`）、`fulfillmentErrorBody(code)`（`{ error, code }`）・`fulfillmentFailureBody(kind)`（`{ error, code: 'failed' }`）、`UNKNOWN_OUTCOME_MESSAGE`。

DB の言葉 → 記号: `ORDER_NOT_FOUND`→`order_not_found`、`ORDER_NOT_SHIPPABLE`→`not_shippable`、`SHIPPING_ADDRESS_INCOMPLETE`→`address_incomplete`、`PAYMENT_REVIEW_REQUIRED`→`payment_review_required`、`LINE_NOT_IN_ORDER`・`QUANTITY_EXCEEDS_READY`→`quantity_exceeds_ready`、`FULFILLMENT_REQUEST_MISMATCH`→`fulfillment_request_mismatch`、`FULFILLMENT_ARGUMENT_INVALID`・`COMPLETION_ARGUMENT_INVALID`→`invalid_argument`、`FULFILLMENT_NOT_FOUND`→`fulfillment_not_found`、`FULFILLMENT_CANCEL_NOT_ALLOWED`→`fulfillment_cancel_not_allowed`、`ORDER_NOT_IN_PRODUCTION`→`not_in_production`、`LINE_NOT_IN_PRODUCTION`・`QUANTITY_EXCEEDS_IN_PRODUCTION`→`quantity_exceeds_in_production`、`COMPLETION_REQUEST_MISMATCH`→`completion_request_mismatch`、`COMPLETION_NOT_FOUND`→`completion_not_found`、`COMPLETION_ALREADY_SHIPPED`→`completion_already_shipped`。

`src/lib/orders/fulfillment/fulfillment-store.ts`（Task 3。サーバーだけ）:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
export type FulfillmentStore = Pick<SupabaseClient, 'rpc'>;
export class FulfillmentOperationError extends Error { readonly code: FulfillmentErrorCode; }
export class FulfillmentStoreError extends Error {}
export function toFulfillmentErrorCode(message: string | undefined): FulfillmentErrorCode | null;
export type OrderLineFulfillmentRow = {
  orderId: string; orderItemId: string; variantId: number | null; fulfillmentType: string; quantity: number;
  shipped: number; completed: number; inProduction: number; readyUnshipped: number; unshipped: number;
};
/** 空なら呼ばずに空を返す。200件ずつに分けて呼ぶ */
export function listOrderLineFulfillment(store: FulfillmentStore, orderIds: readonly string[]): Promise<Map<string, OrderLineFulfillmentRow[]>>;
export function createFulfillment(store: FulfillmentStore, input: {
  orderId: string; actorId: string; requestKey: string; carrier: ShippingCarrierId; trackingNumber: string;
  notifyCustomer: boolean; lines: FulfillmentLineQuantity[];
}): Promise<CreateFulfillmentResponse>;
export function cancelFulfillment(store: FulfillmentStore, input: { orderId: string; fulfillmentId: string; actorId: string }): Promise<CancelFulfillmentResponse>;
export function recordCompletion(store: FulfillmentStore, input: { orderId: string; actorId: string; requestKey: string; lines: FulfillmentLineQuantity[] }): Promise<RecordCompletionResponse>;
export function cancelCompletion(store: FulfillmentStore, input: { orderId: string; completionId: string; actorId: string }): Promise<CancelCompletionResponse>;
export type OrderFulfillmentHistoryRow = {
  fulfillmentId: string; number: number; shippingCarrier: string | null; trackingNumber: string | null; notifyCustomer: boolean;
  completesOrder: boolean; shippedAt: string; createdByEmail: string | null; cancelledAt: string | null;
  cancelledByEmail: string | null; legacy: boolean; lines: FulfillmentLineQuantity[];
};
export function listOrderFulfillments(store: FulfillmentStore, orderId: string): Promise<OrderFulfillmentHistoryRow[]>;
export type OrderCompletionHistoryRow = {
  completionId: string; orderItemId: string; quantity: number; createdAt: string; createdByEmail: string | null;
  cancelledAt: string | null; cancelledByEmail: string | null; legacy: boolean;
};
export function listOrderCompletions(store: FulfillmentStore, orderId: string): Promise<OrderCompletionHistoryRow[]>;
```

- RPC の引数名: `_order_id`・`_actor_id`・`_request_key`・`_shipping_carrier`・`_tracking_number`・`_notify_customer`・`_lines`（`[{ order_item_id, quantity }]`）・`_fulfillment_id`・`_completion_id`・`_order_ids`
- DB の誤りの言葉が表の言葉を含めば `FulfillmentOperationError`、含まなければ `FulfillmentStoreError`（原因を `cause` に持つ）

`src/lib/orders/fulfillment/fulfillment-materials.ts`（Task 3。サーバーだけ）:

```ts
/** 注文が無ければ null。service_role の client で読む */
export function loadFulfillmentMaterials(client: SupabaseClient, orderId: string): Promise<FulfillmentMaterials | null>;
```

- `blockedReason`: 注文が `paid` でなければ `not_shippable`、配送先が足りなければ（`findMissingShippingFields`）`address_incomplete`、支払額の違いの要対応（`payment_exceptions` の `paid_amount_mismatch` で `resolved_at` が空）が残れば `payment_review_required`、どれでもなければ null

注文のメールの部品（Task 4）:

- `src/lib/orders/email/order-email-store.ts`: 取り出した行の型に `fulfillmentId: string | null`、履歴の行の型 `OrderEmailHistoryRow` に `fulfillmentId: string | null; fulfillmentNumber: number | null` を足す。`requestOrderEmailResend(store, { orderId, kind, actorId, fulfillmentId?: string | null })` は `_fulfillment_id: fulfillmentId ?? null` を渡し、`RESEND_FULFILLMENT_REQUIRED` は `OrderEmailResendError('not_allowed')` にする
- `src/lib/orders/email/order-email-compose.ts`: `export type OrderEmailFulfillmentMaterial = { number: number; carrier: string | null; trackingNumber: string | null; completesOrder: boolean; cancelled: boolean; lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number }> }`。`OrderEmailMaterial` に `fulfillment: OrderEmailFulfillmentMaterial | null` を足す。`loadOrderEmailMaterial(store, orderId, fulfillmentId: string | null = null)`
- `src/lib/orders/email/order-email-worker.ts`: 材料を読む部品は `loadMaterial(orderId: string, fulfillmentId: string | null)`。発送のメールで発送が取り消されていれば `skip_order_email` の理由 `fulfillment_cancelled` で取りやめる
- `src/lib/orders/email/order-email-types.ts`（Task 2 で直す。DB の再送の表と取りやめの理由を変えるタスクで、結合テストが読む表も一緒に変えるため。Task 4 は使うだけ）: `RESENDABLE_ORDER_STATUSES.shipped` を `['paid', 'shipped']` にする。`ORDER_EMAIL_ERROR_CODES` に `fulfillment_cancelled` を足し、`OrderEmailSkipReason` を `'superseded' | 'no_recipient' | 'fulfillment_cancelled'` にし、`ORDER_EMAIL_ERROR_LABELS.fulfillment_cancelled` を `'発送の取消'` にする

注文の履歴（Task 5）:

```ts
// src/lib/orders/email/order-history.ts に足す
export type OrderHistoryLine = { orderItemId: string; name: string; shipped: number; completed: number };
export type OrderHistoryFulfillmentEntry = {
  type: 'fulfillment'; at: string; fulfillmentId: string; number: number; carrierLabel: string | null; trackingNumber: string | null;
  items: Array<{ name: string; quantity: number }>; actorEmail: string | null; notifyCustomer: boolean; completesOrder: boolean;
  cancelled: boolean; cancellable: boolean; legacy: boolean;
};
export type OrderHistoryFulfillmentCancelEntry = { type: 'fulfillment_cancel'; at: string; fulfillmentId: string; number: number; actorEmail: string | null };
export type OrderHistoryCompletionEntry = {
  type: 'completion'; at: string; completionId: string; items: Array<{ name: string; quantity: number }>; actorEmail: string | null;
  cancelled: boolean; cancellable: boolean; legacy: boolean;
};
export type OrderHistoryCompletionCancelEntry = { type: 'completion_cancel'; at: string; completionId: string; actorEmail: string | null };
// OrderHistoryEmailEntry に fulfillmentId: string | null; fulfillmentNumber: number | null を足し、
// 発送のメールの kindLabel は `発送（${fulfillmentNumber}回目）`（番号が無い時は今の '発送'）
// OrderHistoryEntry に4つを足す。BuildOrderHistoryInput に
//   fulfillments: OrderFulfillmentHistoryRow[]; completions: OrderCompletionHistoryRow[]; lines: OrderHistoryLine[]
// を足す
```

- 発送の `cancellable`: 取り消していない、かつ注文が `paid` か `shipped`
- 仕上がりの `cancellable`: 取り消していない、かつ注文が `paid`、かつ「その商品の仕上がった数 − この行の数 ≥ 発送した数」
- 発送のメールの `resendable`: 今の条件に加え、発送の番号のある行は、その発送が取り消されていないこと

画面の部品の約束（Task 6・7）:

```ts
// src/components/OrderShipDialog.tsx（作り直し）
type OrderShipDialogProps = { orderId: string | null; onClose: () => void; onShipped: (result: CreateFulfillmentResponse) => void };
// src/components/OrderCompletionDialog.tsx（新規）
type OrderCompletionDialogProps = { orderId: string | null; onClose: () => void; onRecorded: () => void };
// src/components/OrderHistoryDialog.tsx（今の props に足す）
type OrderHistoryDialogProps = { orderId: string | null; onClose: () => void; onChanged?: () => void };
```

- 発送の画面と仕上がりの画面は、`orderId` が null の時は閉じている。開く時に材料（GET `/api/admin/orders/${orderId}/fulfillments`）を読む。重複防止キーは `crypto.randomUUID()` で開く時に作る
- 履歴の画面は、発送か仕上がりを取り消したら `onChanged` を呼ぶ（管理画面が一覧を読み直す）

管理画面の一覧の窓口の形（Task 7。`src/components/OrderSection.tsx` の `OrderItem` を広げる）:

```ts
export type OrderStatus = '支払い手続き中' | '未決済' | '受注生産中' | '発送準備中' | '配送中' | '配達済み' | '決済失敗' | '放棄' | 'キャンセル';
export type OrderLineItem = {
  id: string; name: string; color: string | null; size: string | null; quantity: number;
  fulfillmentType: 'stock' | 'backorder'; shipped: number; inProduction: number; readyUnshipped: number;
};
// OrderItem に足す（どれも省略できる。今の試験の形を壊さない）:
//   orderStatus?: import('@/lib/orders/order-payment-types').OrderStatus;
//   progressKey?: import('@/lib/orders/order-progress').OrderProgressKey;
//   partiallyShipped?: boolean;
//   canRecordCompletion?: boolean;
// canShip は「paid で、発送準備中か受注生産中の数があり、配送先がそろい、支払額の確かめが残っていない」
```

お客様の注文の窓口の形（Task 8）:

```ts
// GET /api/orders/[id] の答えに足す（shippedAt・shippingCarrier・trackingNumber は返さない）
progress: { key: OrderProgressKey; label: string; partiallyShipped: boolean; steps: OrderProgressStep[] | null };
shipments: Array<{
  id: string; number: number; shippedAt: string; carrier: string | null; carrierLabel: string | null;
  trackingNumber: string | null; trackingUrl: string | null;
  items: Array<{ orderItemId: string; name: string; color: string | null; size: string | null; quantity: number }>;
}>;
// items の各行に足す: shippedQuantity: number; readyQuantity: number; inProductionQuantity: number
// GET /api/orders の一覧の status は deriveOrderProgress の言葉
```

在庫の窓口の形（Task 9）:

```ts
// GET /api/admin/items/[id]/variants の答え
variants: Array<{ id; colorName; colorHex; sizeLabel; sku; stockQuantity: number; isActive; committedQuantity: number; onHandQuantity: number; backorderQuantity: number }>;
movements: Array<{ id: number; variantId: number; delta: number; reason: string; note: string | null; createdAt: string;
  actorEmail: string | null; orderId: string | null; orderNumber: string | null; balanceAfter: number }>;
```

---

### Task 1: 発送と仕上がりの記録（移行 A）

**Files:**
- Create: `supabase/migrations/20261010120000_order_fulfillments.sql`
- Create: `tests/integration/db/order_fulfillments.integration.test.ts`
- Modify: `tests/integration/db/helpers/order-fixtures.ts`（`insertOrderWithLines` を足す）

**Interfaces:**
- Consumes: `public.orders`・`public.order_items`（`fulfillment_type` は `stock`・`backorder`）・`public.order_revisions`・`public.stock_movements`・`public.item_variants`・`auth.users`・`private.order_email_outbox`（グループ D）、`tests/integration/db/helpers`（既存）
- Produces:
  - 表 `public.order_fulfillments`・`public.order_fulfillment_lines`・`public.order_item_completions`（列は Step 3 の SQL のとおり）
  - 共通の約束 C-1 の移行 A の関数（`private.order_line_fulfillment`・`public.list_order_line_fulfillment`・`public.admin_record_completion`・`public.admin_cancel_completion`・`public.list_order_fulfillments`・`public.list_order_completions`・`public.list_variant_stock_states`・`public.list_item_stock_history`）
  - `private.parse_fulfillment_lines(_lines jsonb, _error text) RETURNS TABLE (order_item_id uuid, quantity integer)`（`_lines` の形を確かめて行に分ける。形が違えば `_error` の言葉で 22023。Task 2 の発送の関数も使う）
  - `private.backfill_legacy_fulfillments() RETURNS integer`（前からの発送済みの注文に、発送の記録と受注生産の品の仕上がりの記録を作る。作った発送の数を返す。何度呼んでも同じ結果）
  - 索引 `stock_movements_order_item_idx`
  - 試験の道具 `insertOrderWithLines(db, options)`（Step 1）

- [ ] **Step 1: 試験の道具を足す**

`tests/integration/db/helpers/order-fixtures.ts` の末尾に足す:

```ts
export type FixtureLine = {
  itemId: number;
  variantId: number;
  quantity: number;
  fulfillmentType: 'stock' | 'backorder';
  /** 在庫の品で、台帳に確保（purchase）を入れるか。既定は入れる */
  reserved?: boolean;
};

/**
 * 在庫の品と受注生産の品を混ぜた注文を直接作る（グループ E-1）。
 * shipped を渡すと、状態を発送済みにして発送の時刻・配送業者・伝票番号も入れる（移行の前に発送した注文を再現する）。
 */
export async function insertOrderWithLines(
  db: PgClient,
  options: {
    status: string;
    lines: FixtureLine[];
    shippingEmail?: string;
    shipped?: { carrier: 'yamato' | 'sagawa' | 'japanpost' | null; trackingNumber: string | null };
  },
): Promise<{ orderId: string; orderItemIds: string[] }> {
  const suffix = uniqueSuffix();
  const subtotal = options.lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone, shipped_at, shipping_carrier, tracking_number)
     values ($1, $2, null, $3::public.order_status, $4, 0, $4, 'jpy',
             $5, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222', $6, $7, $8)
     returning id`,
    [
      `fx-order-${suffix}`,
      `cs_fx_${suffix}`,
      options.status,
      subtotal,
      options.shippingEmail ?? 'fixture@example.com',
      options.shipped ? new Date().toISOString() : null,
      options.shipped?.carrier ?? null,
      options.shipped?.trackingNumber ?? null,
    ],
  );
  const orderId = order.rows[0].id as string;
  const orderItemIds: string[] = [];
  for (const line of options.lines) {
    const inserted = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
       values ($1, $2, '照合テスト', $3, 'BLACK', 'M', $4, $5, $6, $7)
       returning id`,
      [orderId, line.itemId, PRICE, line.quantity, PRICE * line.quantity, line.variantId, line.fulfillmentType],
    );
    const orderItemId = inserted.rows[0].id as string;
    orderItemIds.push(orderItemId);
    if (line.fulfillmentType === 'stock' && (line.reserved ?? true)) {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [line.variantId, -line.quantity, orderId, orderItemId],
      );
    }
  }
  return { orderId, orderItemIds };
}
```

- [ ] **Step 2: 結合テストを書く**

`tests/integration/db/order_fulfillments.integration.test.ts`:

```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 発送と仕上がりの記録（グループ E-1 設計書 3・5・10・11 章、移行 A）。
 * 1件ごとに取引の中で動かし、終わったら戻す。発送の行は移行 B の関数がまだ無いので、試験では postgres で直接書く。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `fulfillment-admin-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 在庫の品（在庫数 stock から2つ確保）と受注生産の品（3つ）の注文 */
async function createMixedOrder(db: PgClient, status = 'paid', stock = 5) {
  const stockFx = await createCatalogFixture(db, { stock });
  const madeFx = await createCatalogFixture(db, { stock: 0 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status,
    lines: [
      { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1], stockFx, madeFx };
}

/** 移行 B の発送の関数の代わりに、発送の記録を直接書く */
async function insertFulfillment(
  db: PgClient,
  orderId: string,
  lines: Array<{ orderItemId: string; quantity: number }>,
  number = 1,
  createdBy: string | null = null,
): Promise<string> {
  const res = await db.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, created_by)
     values ($1, $2, gen_random_uuid(), 'yamato', '1234-5678-9012', true, false, $3) returning id`,
    [orderId, number, createdBy],
  );
  const fulfillmentId = res.rows[0].id as string;
  for (const line of lines) {
    await db.query(
      'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)',
      [fulfillmentId, line.orderItemId, line.quantity],
    );
  }
  return fulfillmentId;
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

function recordCompletion(db: PgClient, orderId: string, actorId: string, requestKey: string, lines: unknown) {
  return db.query('select * from public.admin_record_completion($1, $2, $3, $4::jsonb)', [
    orderId, actorId, requestKey, JSON.stringify(lines),
  ]);
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

function newKey(): string {
  return crypto.randomUUID();
}

describeLocalDb('integration: 発送と仕上がりの記録（移行 A）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表の守り', () => {
    test('お客様とログインした人は読めず、アプリは読むだけ', async () => {
      for (const table of ['order_fulfillments', 'order_fulfillment_lines', 'order_item_completions']) {
        for (const role of ['anon', 'authenticated']) {
          await db().query('savepoint role_check');
          await db().query(`set local role ${role}`);
          await expect(db().query(`select * from public.${table} limit 1`)).rejects.toMatchObject({ code: '42501' });
          await db().query('rollback to savepoint role_check');
        }
        await db().query('savepoint role_check');
        await db().query('set local role service_role');
        await expect(db().query(`select count(*) from public.${table}`)).resolves.toBeDefined();
        await expect(db().query(`delete from public.${table}`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint role_check');
      }
    });

    test('発送の商品は追記だけ。発送と仕上がりは消せず、取消の2つの列だけ一度だけ変えられる', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const fulfillmentId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }]);

      await expectRejected(db(), 'update public.order_fulfillment_lines set quantity = 2 where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillment_lines where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillments where id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), "update public.order_fulfillments set tracking_number = '9999' where id = $1", [fulfillmentId], { code: '55000' });

      await db().query('update public.order_fulfillments set cancelled_at = now(), cancelled_by = $2 where id = $1', [fulfillmentId, actor.id]);
      await expectRejected(db(), 'update public.order_fulfillments set cancelled_at = now() where id = $1', [fulfillmentId], { code: '55000' });

      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await expectRejected(db(), 'delete from public.order_item_completions where order_id = $1', [orderId], { code: '55000' });
    });

    test('ほかの注文の商品は発送の商品にできず、在庫の品は仕上がりにできない', async () => {
      const first = await createMixedOrder(db());
      const second = await createMixedOrder(db());
      const fulfillmentId = await insertFulfillment(db(), first.orderId, []);

      await expectRejected(
        db(),
        'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)',
        [fulfillmentId, second.stockItemId],
        { code: '23514', message: 'FULFILLMENT_LINE_ORDER_MISMATCH' },
      );
      await expectRejected(
        db(),
        `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
         values ($1, $2, 1, gen_random_uuid())`,
        [first.orderId, first.stockItemId],
        { code: '23514', message: 'COMPLETION_LINE_INVALID' },
      );
    });
  });

  describe('商品ごとの数', () => {
    test('入金済みの注文: 在庫の品は発送準備中、受注生産の品は受注生産中', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const counts = await lineCounts(db(), orderId);

      expect(counts[stockItemId]).toMatchObject({
        fulfillment_type: 'stock', quantity: 2, shipped: 0, completed: 2, in_production: 0, ready_unshipped: 2, unshipped: 2,
      });
      expect(counts[madeItemId]).toMatchObject({
        fulfillment_type: 'backorder', quantity: 3, shipped: 0, completed: 0, in_production: 3, ready_unshipped: 0, unshipped: 3,
      });
    });

    test('仕上がりと発送で数が動き、取り消した記録は数えない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 2 }]);
      const shippedId = await insertFulfillment(db(), orderId, [
        { orderItemId: stockItemId, quantity: 2 },
        { orderItemId: madeItemId, quantity: 1 },
      ]);
      const cancelledId = await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }], 2);
      await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [cancelledId]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ shipped: 1, completed: 2, in_production: 1, ready_unshipped: 1, unshipped: 2 });
      expect(shippedId).toBeTruthy();
    });

    test('注文の番号の配列で数を返す。空なら0行、201件以上は断る', async () => {
      const first = await createMixedOrder(db());
      const second = await createMixedOrder(db());

      const res = await db().query('select * from public.list_order_line_fulfillment($1::uuid[])', [[first.orderId, second.orderId]]);
      expect(res.rows).toHaveLength(4);
      expect(new Set(res.rows.map((row) => row.order_id))).toEqual(new Set([first.orderId, second.orderId]));

      const empty = await db().query("select * from public.list_order_line_fulfillment('{}'::uuid[])");
      expect(empty.rows).toHaveLength(0);

      const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
      await expectRejected(db(), 'select * from public.list_order_line_fulfillment($1::uuid[])', [tooMany], {
        code: '22023', message: 'TOO_MANY_ORDERS',
      });
    });
  });

  describe('仕上がりの記録', () => {
    test('受注生産中の数を発送準備中に移し、同じ番号の送り直しは前の結果を返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();

      const first = await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 2 }]);
      expect(first.rows).toEqual([
        expect.objectContaining({ order_item_id: madeItemId, quantity: 2, replayed: false }),
      ]);

      const again = await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 2 }]);
      expect(again.rows).toEqual([
        expect.objectContaining({ completion_id: first.rows[0].completion_id, quantity: 2, replayed: true }),
      ]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[madeItemId]).toMatchObject({ completed: 2, in_production: 1, ready_unshipped: 2 });
      const rows = await db().query('select created_by, legacy from public.order_item_completions where order_id = $1', [orderId]);
      expect(rows.rows).toEqual([{ created_by: actor.id, legacy: false }]);
    });

    test('同じ番号で中身が違えば断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();
      await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 1 }]);

      await expectRejected(
        db(),
        'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)',
        [orderId, actor.id, key, JSON.stringify([{ order_item_id: madeItemId, quantity: 2 }])],
        { code: '22023', message: 'COMPLETION_REQUEST_MISMATCH' },
      );
    });

    test('入金済みでない注文・在庫の品・受注生産中を超える数は断る', async () => {
      const unpaid = await createMixedOrder(db(), 'pending');
      const paid = await createMixedOrder(db());
      const actor = await createActor(db());
      const sql = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';

      await expectRejected(db(), sql, [unpaid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])], {
        code: '22023', message: 'ORDER_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.stockItemId, quantity: 1 }])], {
        code: '22023', message: 'LINE_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])], {
        code: '22023', message: 'LINE_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 4 }])], {
        code: '22023', message: 'QUANTITY_EXCEEDS_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [crypto.randomUUID(), actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 1 }])], {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });

    test('行の形が違えば断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const sql = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';
      const bad: unknown[] = [
        [],
        {},
        Array.from({ length: 101 }, () => ({ order_item_id: madeItemId, quantity: 1 })),
        [{ order_item_id: madeItemId, quantity: 1 }, { order_item_id: madeItemId, quantity: 1 }],
        [{ order_item_id: madeItemId, quantity: 0 }],
        [{ order_item_id: madeItemId, quantity: 1000 }],
        [{ order_item_id: madeItemId, quantity: 1.5 }],
        [{ order_item_id: 'not-a-uuid', quantity: 1 }],
        [{ order_item_id: madeItemId, quantity: '1' }],
      ];
      for (const lines of bad) {
        await expectRejected(db(), sql, [orderId, actor.id, newKey(), JSON.stringify(lines)], {
          code: '22023', message: 'COMPLETION_ARGUMENT_INVALID',
        });
      }
      await expectRejected(db(), sql, [orderId, null, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])], {
        code: '22023', message: 'COMPLETION_ARGUMENT_INVALID',
      });
    });

    test('取消: 受注生産中に戻る。2回目は already_cancelled。送った数を下回る取消は断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      const second = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }]);

      const cancelled = await db().query('select * from public.admin_cancel_completion($1, $2, $3)', [
        orderId, first.rows[0].completion_id, actor.id,
      ]);
      expect(cancelled.rows).toEqual([{ outcome: 'cancelled' }]);
      const again = await db().query('select * from public.admin_cancel_completion($1, $2, $3)', [
        orderId, first.rows[0].completion_id, actor.id,
      ]);
      expect(again.rows).toEqual([{ outcome: 'already_cancelled' }]);

      // 残りの仕上がりは1つ、送ったのも1つ。これを取り消すと送った数を下回る
      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [orderId, second.rows[0].completion_id, actor.id], {
        code: '22023', message: 'COMPLETION_ALREADY_SHIPPED',
      });

      const row = await db().query('select cancelled_by from public.order_item_completions where id = $1', [first.rows[0].completion_id]);
      expect(row.rows[0].cancelled_by).toBe(actor.id);
      const counts = await lineCounts(db(), orderId);
      expect(counts[madeItemId]).toMatchObject({ completed: 1, shipped: 1, in_production: 2, ready_unshipped: 0 });
    });

    test('取消: ほかの注文の仕上がり・入金済みでない注文は断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const done = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);

      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [other.orderId, done.rows[0].completion_id, actor.id], {
        code: 'P0002', message: 'COMPLETION_NOT_FOUND',
      });
      // 保留中の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る形にする:
      // 理由を付け、入金済みからの取消は全額返金と同じ更新で行う
      await db().query("select set_config('app.order_change_reason', 'integration_test', true)");
      await db().query(
        "update public.orders set status = 'cancelled', refunded_amount = total_amount, refunded_at = now() where id = $1",
        [orderId],
      );
      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [orderId, done.rows[0].completion_id, actor.id], {
        code: '22023', message: 'ORDER_NOT_IN_PRODUCTION',
      });
    });
  });

  describe('読み出し', () => {
    test('発送の一覧は新しい順で、商品と数・実行した人と取り消した人のメールを返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const firstId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }], 1, actor.id);
      const secondId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }], 2);
      await db().query('update public.order_fulfillments set cancelled_at = now(), cancelled_by = $2 where id = $1', [secondId, actor.id]);

      const res = await db().query('select * from public.list_order_fulfillments($1)', [orderId]);
      expect(res.rows.map((row) => row.number)).toEqual([2, 1]);
      expect(res.rows[0]).toMatchObject({
        fulfillment_id: secondId, shipping_carrier: 'yamato', tracking_number: '1234-5678-9012',
        created_by_email: null, cancelled_by_email: actor.email, legacy: false,
        lines: [{ order_item_id: stockItemId, quantity: 1 }],
      });
      expect(res.rows[0].cancelled_at).not.toBeNull();
      expect(res.rows[1]).toMatchObject({ fulfillment_id: firstId, created_by_email: actor.email, cancelled_at: null });
    });

    test('仕上がりの一覧は新しい順で、記録した人のメールを返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);

      const res = await db().query('select * from public.list_order_completions($1)', [orderId]);
      expect(res.rows).toEqual([
        expect.objectContaining({ order_item_id: madeItemId, quantity: 1, created_by_email: actor.email, cancelled_at: null, legacy: false }),
      ]);
    });
  });

  describe('在庫の数', () => {
    test('引き当て済みは確保して送っていない数、受注生産は未入金と入金済みのまだ仕上がっていない数', async () => {
      const { orderId, stockItemId, madeItemId, stockFx, madeFx } = await createMixedOrder(db());
      const actor = await createActor(db());

      let states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      const byVariant = (rows: Row[]) => Object.fromEntries(rows.map((row) => [Number(row.variant_id), row]));
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 2, backorder: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ committed: 0, backorder: 3 });

      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }]);
      states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ backorder: 2 });
    });

    test('受注生産の数は、支払い手続き中・失敗・キャンセル・発送済みの注文を数えない', async () => {
      const madeFx = await createCatalogFixture(db(), { stock: 0 });
      for (const status of ['payment_in_progress', 'failed', 'cancelled', 'pending', 'paid']) {
        await insertOrderWithLines(db(), {
          status,
          lines: [{ itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' }],
        });
      }
      const res = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[madeFx.variantId]]);
      expect(res.rows).toEqual([{ variant_id: String(madeFx.variantId), committed: 0, backorder: 2 }]);
    });

    test('支払い手続き中の注文の確保は引き当て済みに入る', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 3 });
      await insertOrderWithLines(db(), {
        status: 'payment_in_progress',
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const res = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId]]);
      expect(res.rows[0]).toMatchObject({ committed: 1 });
    });

    test('501件以上の番号は断る', async () => {
      const ids = Array.from({ length: 501 }, (_, i) => i + 1);
      await expectRejected(db(), 'select * from public.list_variant_stock_states($1::bigint[])', [ids], {
        code: '22023', message: 'TOO_MANY_VARIANTS',
      });
    });

    test('在庫の履歴は新しい順で、変わった後の数・実行した人・注文を返す', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const actor = await createActor(db());
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, note, created_by) values ($1, -1, 'adjustment', '棚卸', $2)`,
        [stockFx.variantId, actor.id],
      );
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'paid',
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' }],
      });

      const res = await db().query('select * from public.list_item_stock_history($1, 50)', [stockFx.itemId]);
      expect(res.rows.map((row) => [row.reason, row.delta, row.balance_after])).toEqual([
        ['purchase', -2, 2],
        ['adjustment', -1, 4],
        ['restock', 5, 5],
      ]);
      expect(res.rows[0]).toMatchObject({ order_id: orderId, actor_email: null });
      expect(res.rows[1]).toMatchObject({ actor_email: actor.email, note: '棚卸', order_id: null });

      const limited = await db().query('select * from public.list_item_stock_history($1, 0)', [stockFx.itemId]);
      expect(limited.rows).toHaveLength(1);
    });
  });

  describe('前からの写し', () => {
    test('発送済みの注文に、全部の商品を1回で送った記録と、受注生産の品の仕上がりを作る。2回目は何もしない', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const madeFx = await createCatalogFixture(db(), { stock: 0 });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'sagawa', trackingNumber: 'SG-1' },
        lines: [
          { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
          { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' },
        ],
      });
      await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent')",
        [orderId],
      );

      const created = await db().query('select private.backfill_legacy_fulfillments() as created');
      expect(Number(created.rows[0].created)).toBeGreaterThanOrEqual(1);

      const fulfillments = await db().query('select * from public.order_fulfillments where order_id = $1', [orderId]);
      expect(fulfillments.rows).toEqual([
        expect.objectContaining({
          number: 1, shipping_carrier: 'sagawa', tracking_number: 'SG-1', notify_customer: true,
          completes_order: true, legacy: true, cancelled_at: null,
        }),
      ]);
      const lines = await db().query(
        'select order_item_id, quantity from public.order_fulfillment_lines where fulfillment_id = $1 order by quantity desc',
        [fulfillments.rows[0].id],
      );
      expect(lines.rows).toEqual([
        { order_item_id: orderItemIds[0], quantity: 2 },
        { order_item_id: orderItemIds[1], quantity: 1 },
      ]);
      const counts = await lineCounts(db(), orderId);
      expect(counts[orderItemIds[1]]).toMatchObject({ shipped: 1, completed: 1, in_production: 0, unshipped: 0 });

      await db().query('select private.backfill_legacy_fulfillments()');
      const again = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
      expect(again.rows[0].n).toBe(1);
      const completions = await db().query('select count(*)::int as n from public.order_item_completions where order_id = $1', [orderId]);
      expect(completions.rows[0].n).toBe(1);
    });

    test('発送のメールの行が無い注文は、メールを送らなかった記録になる', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-1' },
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      await db().query('select private.backfill_legacy_fulfillments()');
      const res = await db().query('select notify_customer from public.order_fulfillments where order_id = $1', [orderId]);
      expect(res.rows).toEqual([{ notify_customer: false }]);
    });
  });

  describe('権限', () => {
    test('関数を実行できるのは service_role だけ', async () => {
      const functions = [
        'public.list_order_line_fulfillment(uuid[])',
        'public.admin_record_completion(uuid, uuid, uuid, jsonb)',
        'public.admin_cancel_completion(uuid, uuid, uuid)',
        'public.list_order_fulfillments(uuid)',
        'public.list_order_completions(uuid)',
        'public.list_variant_stock_states(bigint[])',
        'public.list_item_stock_history(bigint, integer)',
      ];
      for (const fn of functions) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as authed,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        );
        expect(res.rows[0]).toEqual({ anon: false, authed: false, service: true });
      }
      for (const fn of ['private.order_line_fulfillment(uuid)', 'private.backfill_legacy_fulfillments()', 'private.parse_fulfillment_lines(jsonb, text)']) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect(res.rows[0].service).toBe(false);
      }
    });
  });
});
```

`crypto.randomUUID()` は Node の全体の `crypto`（Node 20 以上）。jest の `node` 環境で使える。

- [ ] **Step 3: 試験が落ちることを確かめる**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンドで `npx jest tests/integration/db/order_fulfillments.integration.test.ts --runInBand`
Expected: FAIL（`relation "public.order_fulfillments" does not exist` など）

- [ ] **Step 4: 移行 A を書く**

`supabase/migrations/20261010120000_order_fulfillments.sql`:

```sql
-- 部分発送と注文の進み具合（グループ E-1 設計書 3・5・10・11 章）の移行 A
--
-- 発送（Shopify の Fulfillment）・発送の商品・受注生産の品の仕上がり（Shopify で発送の保留を外す操作）の3つの表と守り、
-- 商品ごとの数の関数、仕上がりの関数、読み出しの関数、在庫の関数、前からの写しを作る。
-- 表は public に置き、書くのは SECURITY DEFINER の関数だけ（service_role は読むだけ）。
-- 発送の関数は、発送のメールの予定を書くので、注文のメールの表に発送の番号の列ができる移行 B で作る。
BEGIN;

-- 1. 表。実行した人の列は外部キーにしない: ON DELETE SET NULL は UPDATE として動くので、
--    取消の列しか変えさせない守りとぶつかり、利用者の削除そのものが失敗する（stock_movements と同じ考え）
CREATE TABLE IF NOT EXISTS public.order_fulfillments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  number integer NOT NULL CHECK (number >= 1),
  request_key uuid NOT NULL,
  shipping_carrier text CHECK (shipping_carrier IS NULL OR shipping_carrier IN ('yamato', 'sagawa', 'japanpost')),
  tracking_number text CHECK (tracking_number IS NULL OR tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  notify_customer boolean NOT NULL,
  completes_order boolean NOT NULL,
  shipped_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  legacy boolean NOT NULL DEFAULT false,
  CONSTRAINT order_fulfillments_order_number_key UNIQUE (order_id, number),
  CONSTRAINT order_fulfillments_request_key_key UNIQUE (request_key),
  -- 新しい発送は配送業者と伝票番号を必ず持つ。前からの記録だけは欠けていても写す
  CONSTRAINT order_fulfillments_tracking_check CHECK (legacy OR (shipping_carrier IS NOT NULL AND tracking_number IS NOT NULL)),
  CONSTRAINT order_fulfillments_cancelled_check CHECK (cancelled_by IS NULL OR cancelled_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.order_fulfillment_lines (
  fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments (id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items (id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity >= 1),
  PRIMARY KEY (fulfillment_id, order_item_id)
);

CREATE TABLE IF NOT EXISTS public.order_item_completions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items (id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity >= 1),
  request_key uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  legacy boolean NOT NULL DEFAULT false,
  -- 1回の操作で複数の商品を記録するので、重複防止キーは商品ごとに一意
  CONSTRAINT order_item_completions_request_line_key UNIQUE (request_key, order_item_id),
  CONSTRAINT order_item_completions_cancelled_check CHECK (cancelled_by IS NULL OR cancelled_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS order_fulfillment_lines_order_item_idx ON public.order_fulfillment_lines (order_item_id);
CREATE INDEX IF NOT EXISTS order_item_completions_order_item_idx ON public.order_item_completions (order_item_id);
CREATE INDEX IF NOT EXISTS order_item_completions_order_idx ON public.order_item_completions (order_id, created_at);
-- 引き当て済みを商品の行ごとに台帳から数える（今の索引は variant_id と order_id だけ）
CREATE INDEX IF NOT EXISTS stock_movements_order_item_idx ON public.stock_movements (order_item_id);

-- 2. 守り（関数の確かめに重ねる）
CREATE OR REPLACE FUNCTION private.reject_fulfillment_record_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

-- 取消の2つの列だけを、まだ取り消していない行に一度だけ書ける（E-4 で伝票番号の直しを足す時に、ここを広げる）
CREATE OR REPLACE FUNCTION private.restrict_fulfillment_record_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by')
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by')
     OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION '% allows only one cancellation', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.check_fulfillment_line_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_fulfillments AS f
    JOIN public.order_items AS oi ON oi.order_id = f.order_id
    WHERE f.id = NEW.fulfillment_id
      AND oi.id = NEW.order_item_id
  ) THEN
    RAISE EXCEPTION 'FULFILLMENT_LINE_ORDER_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.check_completion_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_items AS oi
    WHERE oi.id = NEW.order_item_id
      AND oi.order_id = NEW.order_id
      AND oi.fulfillment_type = 'backorder'
  ) THEN
    RAISE EXCEPTION 'COMPLETION_LINE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_fulfillment_lines_no_update ON public.order_fulfillment_lines;
CREATE TRIGGER order_fulfillment_lines_no_update
  BEFORE UPDATE OR DELETE ON public.order_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_fulfillment_lines_no_truncate ON public.order_fulfillment_lines;
CREATE TRIGGER order_fulfillment_lines_no_truncate
  BEFORE TRUNCATE ON public.order_fulfillment_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_fulfillment_lines_order_check ON public.order_fulfillment_lines;
CREATE TRIGGER order_fulfillment_lines_order_check
  BEFORE INSERT ON public.order_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_fulfillment_line_order();

DROP TRIGGER IF EXISTS order_fulfillments_no_delete ON public.order_fulfillments;
CREATE TRIGGER order_fulfillments_no_delete
  BEFORE DELETE ON public.order_fulfillments
  FOR EACH ROW EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_fulfillments_no_truncate ON public.order_fulfillments;
CREATE TRIGGER order_fulfillments_no_truncate
  BEFORE TRUNCATE ON public.order_fulfillments
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_fulfillments_cancel_only ON public.order_fulfillments;
CREATE TRIGGER order_fulfillments_cancel_only
  BEFORE UPDATE ON public.order_fulfillments
  FOR EACH ROW EXECUTE FUNCTION private.restrict_fulfillment_record_update();

DROP TRIGGER IF EXISTS order_item_completions_no_delete ON public.order_item_completions;
CREATE TRIGGER order_item_completions_no_delete
  BEFORE DELETE ON public.order_item_completions
  FOR EACH ROW EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_item_completions_no_truncate ON public.order_item_completions;
CREATE TRIGGER order_item_completions_no_truncate
  BEFORE TRUNCATE ON public.order_item_completions
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_fulfillment_record_change();
DROP TRIGGER IF EXISTS order_item_completions_cancel_only ON public.order_item_completions;
CREATE TRIGGER order_item_completions_cancel_only
  BEFORE UPDATE ON public.order_item_completions
  FOR EACH ROW EXECUTE FUNCTION private.restrict_fulfillment_record_update();
DROP TRIGGER IF EXISTS order_item_completions_line_check ON public.order_item_completions;
CREATE TRIGGER order_item_completions_line_check
  BEFORE INSERT ON public.order_item_completions
  FOR EACH ROW EXECUTE FUNCTION private.check_completion_line();

-- 3. 行の守りと権限。新しい public の表は anon・authenticated に自動で権限が付くので、まず全部外す
ALTER TABLE public.order_fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_fulfillment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.order_fulfillments;
CREATE POLICY "deny direct client access" ON public.order_fulfillments
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_fulfillment_lines;
CREATE POLICY "deny direct client access" ON public.order_fulfillment_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_item_completions;
CREATE POLICY "deny direct client access" ON public.order_item_completions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_fulfillments FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_fulfillment_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_item_completions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_fulfillments TO service_role;
GRANT SELECT ON public.order_fulfillment_lines TO service_role;
GRANT SELECT ON public.order_item_completions TO service_role;

-- 4. 商品ごとの数（設計書 3-3）。発送・仕上がり・窓口・在庫・お客様の画面は、全部この数を使う
CREATE OR REPLACE FUNCTION private.order_line_fulfillment(_order_id uuid)
RETURNS TABLE (
  order_item_id uuid,
  variant_id bigint,
  fulfillment_type text,
  quantity integer,
  shipped integer,
  completed integer,
  in_production integer,
  ready_unshipped integer,
  unshipped integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH counted AS (
    SELECT oi.id,
           oi.variant_id,
           oi.fulfillment_type,
           oi.quantity,
           COALESCE((
             SELECT pg_catalog.sum(fl.quantity)
             FROM public.order_fulfillment_lines AS fl
             JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
             WHERE fl.order_item_id = oi.id
               AND f.cancelled_at IS NULL
           ), 0)::integer AS shipped,
           CASE
             WHEN oi.fulfillment_type = 'backorder' THEN COALESCE((
               SELECT pg_catalog.sum(c.quantity)
               FROM public.order_item_completions AS c
               WHERE c.order_item_id = oi.id
                 AND c.cancelled_at IS NULL
             ), 0)::integer
             ELSE oi.quantity
           END AS completed
    FROM public.order_items AS oi
    WHERE oi.order_id = _order_id
  )
  SELECT c.id,
         c.variant_id,
         c.fulfillment_type,
         c.quantity,
         c.shipped,
         c.completed,
         GREATEST(c.quantity - c.completed, 0),
         GREATEST(c.completed - c.shipped, 0),
         GREATEST(c.quantity - c.shipped, 0)
  FROM counted AS c
$$;

-- 一覧の1ページ分の注文の数を1回で読む（本計画 P2）
CREATE OR REPLACE FUNCTION public.list_order_line_fulfillment(_order_ids uuid[])
RETURNS TABLE (
  order_id uuid,
  order_item_id uuid,
  variant_id bigint,
  fulfillment_type text,
  quantity integer,
  shipped integer,
  completed integer,
  in_production integer,
  ready_unshipped integer,
  unshipped integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _order_ids IS NULL OR pg_catalog.cardinality(_order_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(_order_ids) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_ORDERS' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT o.id, l.order_item_id, l.variant_id, l.fulfillment_type, l.quantity,
         l.shipped, l.completed, l.in_production, l.ready_unshipped, l.unshipped
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_line_fulfillment(o.id) AS l
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id, l.order_item_id;
END;
$$;

-- 5. 発送と仕上がりの行の形を確かめて分ける（共通の約束 C-1）。形が違えば _error の言葉で止める
CREATE OR REPLACE FUNCTION private.parse_fulfillment_lines(_lines jsonb, _error text)
RETURNS TABLE (order_item_id uuid, quantity integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_item jsonb;
  v_count integer;
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION '%', _error USING ERRCODE = '22023';
  END IF;
  v_count := pg_catalog.jsonb_array_length(_lines);
  IF v_count < 1 OR v_count > 100 THEN
    RAISE EXCEPTION '%', _error USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'order_item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION '%', _error USING ERRCODE = '22023';
    END IF;
    BEGIN
      order_item_id := (v_item ->> 'order_item_id')::uuid;
      -- 1.5 のような小数は整数に直せずに失敗する（黙って丸めない）
      quantity := (v_item ->> 'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION '%', _error USING ERRCODE = '22023';
    END;
    IF quantity < 1 OR quantity > 999 OR order_item_id = ANY (v_seen) THEN
      RAISE EXCEPTION '%', _error USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || order_item_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 6. 仕上がりの記録（設計書 5-3）
CREATE OR REPLACE FUNCTION public.admin_record_completion(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (completion_id uuid, order_item_id uuid, quantity integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
  v_quantities integer[];
  v_status public.order_status;
  v_existing integer;
BEGIN
  IF _order_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'COMPLETION_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(p.order_item_id ORDER BY p.order_item_id),
         pg_catalog.array_agg(p.quantity ORDER BY p.order_item_id)
  INTO v_ids, v_quantities
  FROM private.parse_fulfillment_lines(_lines, 'COMPLETION_ARGUMENT_INVALID') AS p;

  -- 同じ注文の操作（仕上がり・発送・取消）を1つずつ進める
  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_existing
  FROM public.order_item_completions AS c
  WHERE c.request_key = _request_key;
  IF v_existing > 0 THEN
    IF EXISTS (
         SELECT 1 FROM public.order_item_completions AS c
         WHERE c.request_key = _request_key AND c.order_id <> _order_id
       )
       OR v_existing <> pg_catalog.cardinality(v_ids)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.order_item_completions AS c
           WHERE c.request_key = _request_key
             AND c.order_item_id = r.order_item_id
             AND c.quantity = r.quantity
         )
       ) THEN
      RAISE EXCEPTION 'COMPLETION_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT c.id, c.order_item_id, c.quantity, true
    FROM public.order_item_completions AS c
    WHERE c.request_key = _request_key
    ORDER BY c.order_item_id;
    RETURN;
  END IF;

  -- 入金の前には作り始めない（設計書 17章）
  IF v_status <> 'paid'::public.order_status THEN
    RAISE EXCEPTION 'ORDER_NOT_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
    LEFT JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE l.order_item_id IS NULL
       OR l.fulfillment_type <> 'backorder'
  ) THEN
    RAISE EXCEPTION 'LINE_NOT_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE r.quantity > l.in_production
  ) THEN
    RAISE EXCEPTION 'QUANTITY_EXCEEDS_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  INSERT INTO public.order_item_completions AS c (order_id, order_item_id, quantity, request_key, created_by)
  SELECT _order_id, r.order_item_id, r.quantity, _request_key, _actor_id
  FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
  RETURNING c.id, c.order_item_id, c.quantity, false;
END;
$$;

-- 仕上がりの取消（設計書 5-3）。送った数を下回る取消はしない
CREATE OR REPLACE FUNCTION public.admin_cancel_completion(_order_id uuid, _completion_id uuid, _actor_id uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status public.order_status;
  v_order_item_id uuid;
  v_quantity integer;
  v_cancelled_at timestamptz;
  v_completed integer;
  v_shipped integer;
BEGIN
  IF _order_id IS NULL OR _completion_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'COMPLETION_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.order_item_id, c.quantity, c.cancelled_at
  INTO v_order_item_id, v_quantity, v_cancelled_at
  FROM public.order_item_completions AS c
  WHERE c.id = _completion_id
    AND c.order_id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_cancelled_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_cancelled'::text;
    RETURN;
  END IF;

  IF v_status <> 'paid'::public.order_status THEN
    RAISE EXCEPTION 'ORDER_NOT_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  SELECT l.completed, l.shipped INTO v_completed, v_shipped
  FROM private.order_line_fulfillment(_order_id) AS l
  WHERE l.order_item_id = v_order_item_id;
  IF v_completed - v_quantity < v_shipped THEN
    RAISE EXCEPTION 'COMPLETION_ALREADY_SHIPPED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_item_completions AS c
  SET cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE c.id = _completion_id;

  RETURN QUERY SELECT 'cancelled'::text;
END;
$$;

-- 7. 読み出し（設計書 9-2。管理画面の履歴が使う）
CREATE OR REPLACE FUNCTION public.list_order_fulfillments(_order_id uuid)
RETURNS TABLE (
  fulfillment_id uuid,
  number integer,
  shipping_carrier text,
  tracking_number text,
  notify_customer boolean,
  completes_order boolean,
  shipped_at timestamptz,
  created_by_email text,
  cancelled_at timestamptz,
  cancelled_by_email text,
  legacy boolean,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT f.id,
         f.number,
         f.shipping_carrier,
         f.tracking_number,
         f.notify_customer,
         f.completes_order,
         f.shipped_at,
         cu.email::text,
         f.cancelled_at,
         xu.email::text,
         f.legacy,
         COALESCE((
           SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object('order_item_id', l.order_item_id, 'quantity', l.quantity)
                    ORDER BY l.order_item_id
                  )
           FROM public.order_fulfillment_lines AS l
           WHERE l.fulfillment_id = f.id
         ), '[]'::jsonb)
  FROM public.order_fulfillments AS f
  LEFT JOIN auth.users AS cu ON cu.id = f.created_by
  LEFT JOIN auth.users AS xu ON xu.id = f.cancelled_by
  WHERE f.order_id = _order_id
  ORDER BY f.number DESC
$$;

CREATE OR REPLACE FUNCTION public.list_order_completions(_order_id uuid)
RETURNS TABLE (
  completion_id uuid,
  order_item_id uuid,
  quantity integer,
  created_at timestamptz,
  created_by_email text,
  cancelled_at timestamptz,
  cancelled_by_email text,
  legacy boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.order_item_id, c.quantity, c.created_at, cu.email::text, c.cancelled_at, xu.email::text, c.legacy
  FROM public.order_item_completions AS c
  LEFT JOIN auth.users AS cu ON cu.id = c.created_by
  LEFT JOIN auth.users AS xu ON xu.id = c.cancelled_by
  WHERE c.order_id = _order_id
  ORDER BY c.created_at DESC, c.id
$$;

-- 8. 在庫の数（設計書 10-1）。引き当て済み = 確保して送っていない数、受注生産 = 未入金・入金済みのまだ仕上がっていない数
CREATE OR REPLACE FUNCTION public.list_variant_stock_states(_variant_ids bigint[])
RETURNS TABLE (variant_id bigint, committed integer, backorder integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _variant_ids IS NULL OR pg_catalog.cardinality(_variant_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(_variant_ids) > 500 THEN
    RAISE EXCEPTION 'TOO_MANY_VARIANTS' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH wanted AS (
    SELECT DISTINCT w.variant_id FROM pg_catalog.unnest(_variant_ids) AS w(variant_id)
  ),
  per_item AS (
    SELECT oi.variant_id,
           oi.fulfillment_type,
           oi.quantity,
           o.status,
           GREATEST(0, -COALESCE((
             SELECT pg_catalog.sum(m.delta)
             FROM public.stock_movements AS m
             WHERE m.order_item_id = oi.id
               AND m.reason IN ('purchase', 'cancel')
           ), 0))::integer AS reserved,
           COALESCE((
             SELECT pg_catalog.sum(fl.quantity)
             FROM public.order_fulfillment_lines AS fl
             JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
             WHERE fl.order_item_id = oi.id
               AND f.cancelled_at IS NULL
           ), 0)::integer AS shipped,
           COALESCE((
             SELECT pg_catalog.sum(c.quantity)
             FROM public.order_item_completions AS c
             WHERE c.order_item_id = oi.id
               AND c.cancelled_at IS NULL
           ), 0)::integer AS completed
    FROM public.order_items AS oi
    JOIN public.orders AS o ON o.id = oi.order_id
    WHERE oi.variant_id IN (SELECT w.variant_id FROM wanted AS w)
  )
  SELECT w.variant_id,
         COALESCE(pg_catalog.sum(GREATEST(p.reserved - p.shipped, 0)) FILTER (WHERE p.fulfillment_type = 'stock'), 0)::integer,
         COALESCE(pg_catalog.sum(GREATEST(p.quantity - p.completed, 0)) FILTER (
           WHERE p.fulfillment_type = 'backorder'
             AND p.status IN ('pending'::public.order_status, 'paid'::public.order_status)
         ), 0)::integer
  FROM wanted AS w
  LEFT JOIN per_item AS p ON p.variant_id = w.variant_id
  GROUP BY w.variant_id
  ORDER BY w.variant_id;
END;
$$;

-- 在庫の履歴（設計書 10-2）。変わった後の数は、今の在庫数からその行より後の動きの合計を引いて出す
CREATE OR REPLACE FUNCTION public.list_item_stock_history(_item_id bigint, _limit integer)
RETURNS TABLE (
  movement_id bigint,
  variant_id bigint,
  delta integer,
  reason text,
  note text,
  created_at timestamptz,
  actor_email text,
  order_id uuid,
  balance_after integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.id, h.variant_id, h.delta, h.reason, h.note, h.created_at, h.actor_email, h.order_id, h.balance_after
  FROM (
    SELECT m.id,
           m.variant_id,
           m.delta,
           m.reason,
           m.note,
           m.created_at,
           u.email::text AS actor_email,
           m.order_id,
           (v.stock_quantity - COALESCE(pg_catalog.sum(m.delta) OVER (
             PARTITION BY m.variant_id
             ORDER BY m.id DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0))::integer AS balance_after
    FROM public.stock_movements AS m
    JOIN public.item_variants AS v ON v.id = m.variant_id
    LEFT JOIN auth.users AS u ON u.id = m.created_by
    WHERE v.item_id = _item_id
  ) AS h
  ORDER BY h.id DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

-- 9. 前からの写し（設計書 11章）。何度呼んでも同じ結果。作った発送の数を返す
CREATE OR REPLACE FUNCTION private.backfill_legacy_fulfillments()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_created integer;
BEGIN
  WITH inserted AS (
    INSERT INTO public.order_fulfillments
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, shipped_at, created_by, legacy)
    SELECT o.id,
           1,
           pg_catalog.gen_random_uuid(),
           o.shipping_carrier,
           o.tracking_number,
           -- 前の発送の画面のチェックは残っていないので、発送のメールの行があるかで決める（本計画 P12）
           EXISTS (
             SELECT 1 FROM private.order_email_outbox AS e
             WHERE e.order_id = o.id AND e.kind = 'shipped'
           ),
           true,
           o.shipped_at,
           (
             SELECT r.changed_by
             FROM public.order_revisions AS r
             WHERE r.order_id = o.id
               AND 'status' = ANY (r.changed_fields)
               AND r.after_data ->> 'status' = 'shipped'
             ORDER BY r.changed_at, r.id
             LIMIT 1
           ),
           true
    FROM public.orders AS o
    WHERE o.shipped_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.order_fulfillments AS f WHERE f.order_id = o.id)
    RETURNING id
  )
  SELECT pg_catalog.count(*)::integer INTO v_created FROM inserted;

  INSERT INTO public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity)
  SELECT f.id, oi.id, oi.quantity
  FROM public.order_fulfillments AS f
  JOIN public.order_items AS oi ON oi.order_id = f.order_id
  WHERE f.legacy
    AND NOT EXISTS (SELECT 1 FROM public.order_fulfillment_lines AS l WHERE l.fulfillment_id = f.id);

  -- 送った受注生産の品は作り終えている（shipped ≤ completed を守る）
  INSERT INTO public.order_item_completions (order_id, order_item_id, quantity, request_key, legacy)
  SELECT oi.order_id, oi.id, oi.quantity, pg_catalog.gen_random_uuid(), true
  FROM public.order_items AS oi
  JOIN public.order_fulfillments AS f ON f.order_id = oi.order_id AND f.legacy
  WHERE oi.fulfillment_type = 'backorder'
    AND NOT EXISTS (SELECT 1 FROM public.order_item_completions AS c WHERE c.order_item_id = oi.id);

  RETURN v_created;
END;
$$;

SELECT private.backfill_legacy_fulfillments();

-- 10. 権限。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.reject_fulfillment_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.restrict_fulfillment_record_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_fulfillment_line_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_completion_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_fulfillment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.parse_fulfillment_lines(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.backfill_legacy_fulfillments() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.list_order_line_fulfillment(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_record_completion(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_completion(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_fulfillments(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_completions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_variant_stock_states(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_item_stock_history(bigint, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_order_line_fulfillment(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_completion(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_completion(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_fulfillments(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_completions(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_variant_stock_states(bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_item_stock_history(bigint, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンドで `npx jest tests/integration/db/order_fulfillments.integration.test.ts --runInBand`
Expected: PASS（全部）

- [ ] **Step 6: DB の結合テストを全部流し、前からの試験が壊れていないことを確かめる**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンド（`npx jest tests/integration/db --runInBand`）
Expected: PASS（全部）。`stock_movements` の索引を足しただけで、今の関数は変えていない

- [ ] **Step 7: コミット**

```bash
git add supabase/migrations/20261010120000_order_fulfillments.sql tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/helpers/order-fixtures.ts
git commit -m "$(cat <<'EOF'
feat(orders): 発送と受注生産の仕上がりの記録の表と関数を足す（グループ E-1 の移行 A）

発送・発送の商品・仕上がりの3つの表と守り、商品ごとの数の関数、仕上がりの記録と取消、
読み出しと在庫の数の関数、前からの発送済みの注文の写しを足した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 発送の関数と発送ごとのメール（移行 B）

**Files:**
- Create: `supabase/migrations/20261010120100_fulfillment_order_emails.sql`
- Create: `tests/integration/db/fulfillment_order_emails.integration.test.ts`
- Modify: `tests/integration/db/order_fulfillments.integration.test.ts`（Task 1 の試験。前からの写しの試験で、移行 B の CHECK をその取引の中だけ外す）
- Modify: `tests/integration/db/order_email_enqueue.integration.test.ts`（発送の2つの試験・消した関数の試験・権限の試験）
- Modify: `tests/integration/db/order_email_outbox.integration.test.ts`（予定を書く道具・再送の状態表・発送のメールの再送の断り・権限の一覧）
- Modify: `tests/integration/db/order_state_transition_hardening.integration.test.ts`（権限・発送の試験・配送先の欠けた注文の試験・発送の取消の移り方の試験）
- Modify: `tests/integration/db/payment_exceptions.integration.test.ts:193-208`
- Modify: `tests/integration/db/reconciler_composed.integration.test.ts:365-366` ほか2か所
- Modify: `tests/integration/db/order_items_variant.integration.test.ts:119-147`
- Modify: `supabase/pending/harden_order_state_transitions.sql:37-46`（本計画 P14。当てない）
- Modify: `tests/unit/migrations/order-state-transition-hardening.test.ts`
- Modify: `src/lib/orders/email/order-email-types.ts`
- Modify: `tests/unit/lib/orders/email/order-email-types.test.ts`

**Interfaces:**
- Consumes（Task 1）: 表 `public.order_fulfillments`・`public.order_fulfillment_lines`・`public.order_item_completions`、`private.order_line_fulfillment(uuid)`、`private.parse_fulfillment_lines(jsonb, text)`、`private.backfill_legacy_fulfillments()`、`public.admin_record_completion(uuid, uuid, uuid, jsonb)`、`public.list_variant_stock_states(bigint[])`、試験の道具 `insertOrderWithLines`。グループ D の `private.order_email_outbox` と関数、`private.order_has_required_shipping_fields(public.orders)`、`public.payment_exceptions`
- Produces（共通の約束 C-1 の移行 B）:
  - `public.admin_create_fulfillment(_order_id uuid, _actor_id uuid, _request_key uuid, _shipping_carrier text, _tracking_number text, _notify_customer boolean, _lines jsonb) RETURNS TABLE (fulfillment_id uuid, number integer, completes_order boolean, order_status public.order_status, replayed boolean)`
  - `public.admin_cancel_fulfillment(_order_id uuid, _fulfillment_id uuid, _actor_id uuid) RETURNS TABLE (outcome text, order_status public.order_status)`
  - `private.enqueue_order_email(_order_id uuid, _kind text, _variant text DEFAULT NULL, _fulfillment_id uuid DEFAULT NULL) RETURNS boolean`
  - `public.claim_order_email(integer)` の最後の列 `fulfillment_id uuid`
  - `public.list_order_email_history(uuid)` の最後の列 `fulfillment_id uuid, fulfillment_number integer`
  - `public.request_order_email_resend(_order_id uuid, _kind text, _actor_id uuid, _fulfillment_id uuid DEFAULT NULL) RETURNS uuid`（断り `RESEND_FULFILLMENT_REQUIRED` を足す）
  - `public.skip_order_email(uuid, uuid, text)` の理由 `fulfillment_cancelled`（断り `SKIP_REASON_NOT_ALLOWED`）
  - `private.link_legacy_shipped_emails() RETURNS integer`
  - 列 `private.order_email_outbox.fulfillment_id`、CHECK `order_email_outbox_fulfillment_check`、索引 `order_email_outbox_auto_once_idx`・`order_email_outbox_auto_shipped_idx`・`order_email_outbox_manual_open_idx`・`order_email_outbox_fulfillment_idx`
  - 注文の改訂の理由 `admin_create_fulfillment`・`admin_cancel_fulfillment`
  - TS: `RESENDABLE_ORDER_STATUSES.shipped = ['paid', 'shipped']`、`ORDER_EMAIL_ERROR_CODES` に `'fulfillment_cancelled'`、`OrderEmailSkipReason = 'superseded' | 'no_recipient' | 'fulfillment_cancelled'`、`ORDER_EMAIL_ERROR_LABELS.fulfillment_cancelled = '発送の取消'`
  - 消す: `public.admin_ship_paid_order(uuid, uuid, text, text, boolean)`・view `public.variant_backorder_summary`（本計画 P16。使っている窓口は Task 5・Task 9 で直す）

- [ ] **Step 1: 新しい結合テストを書く**

`tests/integration/db/fulfillment_order_emails.integration.test.ts`:

```ts
/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 発送の関数と発送ごとの発送のメール（グループ E-1 設計書 6・7・8 章、移行 B）。
 * 注文のメールの取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で注文のメールの表を空にし、終わったら戻す。
 * 同時の発送だけは2つの接続が要るので、別の describe で確定した行を使う（消せない注文が手元の DB に残る）。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `fulfillment-email-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 在庫の品（2つ確保済み）と受注生産の品（3つ）の注文 */
async function createMixedOrder(db: PgClient, status = 'paid') {
  const stockFx = await createCatalogFixture(db, { stock: 5 });
  const madeFx = await createCatalogFixture(db, { stock: 0 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status,
    lines: [
      { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1] };
}

/** 住所が空の、在庫の品1つの入金済みの注文（配送先は後から直せないので、作る時に欠かす） */
async function createOrderWithoutAddress(db: PgClient): Promise<{ orderId: string; orderItemId: string }> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const suffix = uniqueSuffix();
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address,
        shipping_phone)
     values ($1, $2, null, 'paid', 5000, 0, 5000, 'jpy',
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', null, '0311112222')
     returning id`,
    [`fx-order-${suffix}`, `cs_fx_${suffix}`],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
     values ($1, $2, '照合テスト', 5000, 'BLACK', 'M', 1, 5000, $3, 'stock')
     returning id`,
    [orderId, fx.itemId, fx.variantId],
  );
  return { orderId, orderItemId: line.rows[0].id as string };
}

type ShipInput = {
  requestKey?: string;
  carrier?: string | null;
  tracking?: string | null;
  notify?: boolean | null;
  lines: unknown;
};

const SHIP_SQL = 'select * from public.admin_create_fulfillment($1, $2, $3, $4, $5, $6, $7::jsonb)';

function shipParams(orderId: string | null, actorId: string | null, input: ShipInput): unknown[] {
  return [
    orderId,
    actorId,
    input.requestKey ?? crypto.randomUUID(),
    input.carrier === undefined ? 'yamato' : input.carrier,
    input.tracking === undefined ? '1234-5678-9012' : input.tracking,
    input.notify === undefined ? true : input.notify,
    JSON.stringify(input.lines),
  ];
}

function ship(db: PgClient, orderId: string, actorId: string, input: ShipInput) {
  return db.query(SHIP_SQL, shipParams(orderId, actorId, input));
}

function cancelFulfillment(db: PgClient, orderId: string, fulfillmentId: string, actorId: string) {
  return db.query('select * from public.admin_cancel_fulfillment($1, $2, $3)', [orderId, fulfillmentId, actorId]);
}

function recordCompletion(db: PgClient, orderId: string, actorId: string, lines: unknown) {
  return db.query('select * from public.admin_record_completion($1, $2, $3, $4::jsonb)', [
    orderId, actorId, crypto.randomUUID(), JSON.stringify(lines),
  ]);
}

async function orderShipping(db: PgClient, orderId: string): Promise<Row> {
  const res = await db.query(
    'select status::text as status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1',
    [orderId],
  );
  return res.rows[0];
}

async function shippedEmails(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select fulfillment_id, origin, status, last_error_code from private.order_email_outbox
     where order_id = $1 and kind = 'shipped' order by seq`,
    [orderId],
  );
  return res.rows;
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

async function markOrderEmailsSent(db: PgClient, orderId: string): Promise<void> {
  await db.query(
    "update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where order_id = $1",
    [orderId],
  );
}

/**
 * 保留中の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る形で取り消す:
 * 理由を付け、入金済みからの取消は全額返金と同じ更新で行う（本計画 P15）
 */
async function cancelByFullRefund(db: PgClient, orderId: string): Promise<void> {
  await db.query("select set_config('app.order_change_reason', 'integration_test', true)");
  await db.query(
    "update public.orders set status = 'cancelled', refunded_amount = total_amount, refunded_at = now() where id = $1",
    [orderId],
  );
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 別の接続が鍵を待つまで待つ（最大5秒）。pg_blocking_pids は取引の写しではなく今の鍵を見る */
async function waitUntilBlocked(db: PgClient, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid]);
    if (res.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('別の接続が注文の行の鍵を待たなかった');
}

describeLocalDb('integration: 発送の関数と発送ごとのメール（移行 B）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('発送する', () => {
    test('在庫の品だけ先に送ると、注文は決済完了のまま。発送のメールの行はその発送に付く', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());

      const res = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });

      expect(res.rows).toEqual([
        expect.objectContaining({ number: 1, completes_order: false, order_status: 'paid', replayed: false }),
      ]);
      const fulfillmentId = res.rows[0].fulfillment_id as string;
      expect(await orderShipping(db(), orderId)).toEqual({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 2, ready_unshipped: 0, unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ shipped: 0, in_production: 3, unshipped: 3 });
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: fulfillmentId, origin: 'auto', status: 'pending' }),
      ]);
      const fulfillment = await db().query(
        'select created_by, notify_customer, legacy from public.order_fulfillments where id = $1',
        [fulfillmentId],
      );
      expect(fulfillment.rows).toEqual([{ created_by: actor.id, notify_customer: true, legacy: false }]);
      // 状態は変わらないので、注文の改訂は増えない
      const revisions = await db().query('select count(*)::int as n from public.order_revisions where order_id = $1', [orderId]);
      expect(revisions.rows[0].n).toBe(0);
    });

    test('残りを仕上げて送ると、注文は発送済みになり、発送の列にその発送の値が入る', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      await recordCompletion(db(), orderId, actor.id, [{ order_item_id: madeItemId, quantity: 3 }]);

      const res = await ship(db(), orderId, actor.id, {
        carrier: 'sagawa', tracking: 'SG-2', notify: false, lines: [{ order_item_id: madeItemId, quantity: 3 }],
      });

      expect(res.rows).toEqual([
        expect.objectContaining({ number: 2, completes_order: true, order_status: 'shipped', replayed: false }),
      ]);
      const shipping = await orderShipping(db(), orderId);
      expect(shipping).toMatchObject({ status: 'shipped', shipping_carrier: 'sagawa', tracking_number: 'SG-2' });
      expect(shipping.shipped_at).not.toBeNull();
      const revision = await db().query(
        "select reason, changed_by from public.order_revisions where order_id = $1 and after_data ->> 'status' = 'shipped'",
        [orderId],
      );
      expect(revision.rows).toEqual([{ reason: 'admin_create_fulfillment', changed_by: actor.id }]);
      // メールを送らない発送は、発送のメールの行を書かない（1回目の行だけ）
      expect(await shippedEmails(db(), orderId)).toHaveLength(1);
    });

    test('同じ番号の送り直しは前の結果を返し、発送もメールも増えない（Review Focus 2）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const input = { requestKey: crypto.randomUUID(), lines: [{ order_item_id: stockItemId, quantity: 2 }] };

      const first = await ship(db(), orderId, actor.id, input);
      const again = await ship(db(), orderId, actor.id, input);

      expect(again.rows).toEqual([{ ...first.rows[0], replayed: true }]);
      const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(1);
      expect(await shippedEmails(db(), orderId)).toHaveLength(1);
    });

    test('同じ番号で中身が違えば断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const requestKey = crypto.randomUUID();
      const line = [{ order_item_id: stockItemId, quantity: 1 }];
      await ship(db(), orderId, actor.id, { requestKey, lines: line });

      const changed: Array<[string, ShipInput]> = [
        [orderId, { requestKey, tracking: '9999-0000', lines: line }],
        [orderId, { requestKey, carrier: 'sagawa', lines: line }],
        [orderId, { requestKey, notify: false, lines: line }],
        [orderId, { requestKey, lines: [{ order_item_id: stockItemId, quantity: 2 }] }],
        [other.orderId, { requestKey, lines: [{ order_item_id: other.stockItemId, quantity: 1 }] }],
      ];
      for (const [target, input] of changed) {
        await expectRejected(db(), SHIP_SQL, shipParams(target, actor.id, input), {
          code: '22023', message: 'FULFILLMENT_REQUEST_MISMATCH',
        });
      }
    });

    test('発送準備中を超える数・注文に無い商品は断り、数は変わらない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());

      // 受注生産の品は、仕上がりを記録するまで送れない
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: madeItemId, quantity: 1 }] }), {
        code: '22023', message: 'QUANTITY_EXCEEDS_READY',
      });
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 3 }] }), {
        code: '22023', message: 'QUANTITY_EXCEEDS_READY',
      });
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: other.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'LINE_NOT_IN_ORDER',
      });
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2 });
    });

    test('決済完了でない・配送先が足りない・支払額の確かめが残る・無い注文は送れない', async () => {
      const actor = await createActor(db());
      const pending = await createMixedOrder(db(), 'pending');
      await expectRejected(db(), SHIP_SQL, shipParams(pending.orderId, actor.id, { lines: [{ order_item_id: pending.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'ORDER_NOT_SHIPPABLE',
      });

      const noAddress = await createOrderWithoutAddress(db());
      await expectRejected(db(), SHIP_SQL, shipParams(noAddress.orderId, actor.id, { lines: [{ order_item_id: noAddress.orderItemId, quantity: 1 }] }), {
        code: '22023', message: 'SHIPPING_ADDRESS_INCOMPLETE',
      });

      const review = await createMixedOrder(db());
      await db().query(
        "select exception_id from public.record_payment_exception($1::text, 'paid_amount_mismatch', null::text, $1::text, null, null, $2::uuid)",
        [`cs_review_${uniqueSuffix()}`, review.orderId],
      );
      await expectRejected(db(), SHIP_SQL, shipParams(review.orderId, actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'PAYMENT_REVIEW_REQUIRED',
      });

      await expectRejected(db(), SHIP_SQL, shipParams(crypto.randomUUID(), actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }), {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });

    test('引数の誤りは FULFILLMENT_ARGUMENT_INVALID', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const line = [{ order_item_id: stockItemId, quantity: 1 }];
      const bad: Array<[string | null, string | null, ShipInput]> = [
        [null, actor.id, { lines: line }],
        [orderId, null, { lines: line }],
        [orderId, actor.id, { carrier: 'fedex', lines: line }],
        [orderId, actor.id, { carrier: null, lines: line }],
        [orderId, actor.id, { tracking: '12 34', lines: line }],
        [orderId, actor.id, { tracking: 'x'.repeat(65), lines: line }],
        [orderId, actor.id, { tracking: null, lines: line }],
        [orderId, actor.id, { notify: null, lines: line }],
        [orderId, actor.id, { lines: [] }],
        [orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 0 }] }],
      ];
      for (const [target, actorId, input] of bad) {
        await expectRejected(db(), SHIP_SQL, shipParams(target, actorId, input), {
          code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID',
        });
      }
      const nullKey = shipParams(orderId, actor.id, { lines: line });
      nullKey[2] = null;
      await expectRejected(db(), SHIP_SQL, nullKey, { code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });
    });
  });

  describe('発送の取消', () => {
    test('全部を送った注文の発送を取り消すと決済完了に戻り、発送の列が空になる。2回目は already_cancelled', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      await recordCompletion(db(), orderId, actor.id, [{ order_item_id: madeItemId, quantity: 3 }]);
      await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: madeItemId, quantity: 3 }] });
      const firstId = first.rows[0].fulfillment_id as string;

      const cancelled = await cancelFulfillment(db(), orderId, firstId, actor.id);

      expect(cancelled.rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
      expect(await orderShipping(db(), orderId)).toEqual({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2, unshipped: 2 });
      const row = await db().query('select cancelled_by from public.order_fulfillments where id = $1', [firstId]);
      expect(row.rows[0].cancelled_by).toBe(actor.id);
      const revision = await db().query(
        `select reason, changed_by from public.order_revisions
         where order_id = $1 and before_data ->> 'status' = 'shipped' and after_data ->> 'status' = 'paid'`,
        [orderId],
      );
      expect(revision.rows).toEqual([{ reason: 'admin_cancel_fulfillment', changed_by: actor.id }]);
      // 送る前だった発送のメールは取りやめる
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);

      const again = await cancelFulfillment(db(), orderId, firstId, actor.id);
      expect(again.rows).toEqual([{ outcome: 'already_cancelled', order_status: 'paid' }]);
    });

    test('一部の発送の取消は状態を変えず、やり直し待ちのメールは取りやめ、送ったメールはそのまま（Review Focus 3）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const firstId = first.rows[0].fulfillment_id as string;
      const secondId = second.rows[0].fulfillment_id as string;
      await db().query(
        "update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where fulfillment_id = $1",
        [firstId],
      );
      await db().query(
        `update private.order_email_outbox
         set status = 'retry_wait', attempts = 1, next_attempt_at = now() + interval '1 minute'
         where fulfillment_id = $1`,
        [secondId],
      );

      expect((await cancelFulfillment(db(), orderId, firstId, actor.id)).rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
      expect((await cancelFulfillment(db(), orderId, secondId, actor.id)).rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);

      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'sent', last_error_code: null }),
        expect.objectContaining({ fulfillment_id: secondId, status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2 });
    });

    test('送っている途中の発送のメールは残し、worker が取消を見て取りやめる（Review Focus 3）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({ order_id: orderId, kind: 'shipped', fulfillment_id: fulfillmentId });

      await cancelFulfillment(db(), orderId, fulfillmentId, actor.id);
      expect(await shippedEmails(db(), orderId)).toEqual([expect.objectContaining({ status: 'sending' })]);

      const skipped = await db().query('select public.skip_order_email($1, $2, $3) as skipped', [
        claimed.email_id, claimed.lease_token, 'fulfillment_cancelled',
      ]);
      expect(skipped.rows[0].skipped).toBe(true);
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);
    });

    test('ほかの注文の発送・無い注文・取り消せない注文は断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const sql = 'select * from public.admin_cancel_fulfillment($1, $2, $3)';

      await expectRejected(db(), sql, [other.orderId, fulfillmentId, actor.id], { code: 'P0002', message: 'FULFILLMENT_NOT_FOUND' });
      await expectRejected(db(), sql, [crypto.randomUUID(), fulfillmentId, actor.id], { code: 'P0002', message: 'ORDER_NOT_FOUND' });
      await expectRejected(db(), sql, [orderId, fulfillmentId, null], { code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });

      await cancelByFullRefund(db(), orderId);
      await expectRejected(db(), sql, [orderId, fulfillmentId, actor.id], { code: '22023', message: 'FULFILLMENT_CANCEL_NOT_ALLOWED' });
    });
  });

  describe('発送のメール', () => {
    test('予定を書く関数: 発送のメールは発送の番号が要り、ほかの種類は持たない。同じ発送の自動の行は1行', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const sql = 'select private.enqueue_order_email($1, $2, $3, $4) as inserted';

      await expectRejected(db(), sql, [orderId, 'shipped', null, null], {
        code: '23514', constraint: 'order_email_outbox_fulfillment_check',
      });
      await expectRejected(db(), sql, [orderId, 'paid', 'order_confirmed', fulfillmentId], {
        code: '23514', constraint: 'order_email_outbox_fulfillment_check',
      });
      expect((await db().query(sql, [orderId, 'shipped', null, fulfillmentId])).rows[0].inserted).toBe(true);
      expect((await db().query(sql, [orderId, 'shipped', null, fulfillmentId])).rows[0].inserted).toBe(false);
      // ほかの種類は今のまま1注文1種類1行。3つの引数の呼び方（グループ D の関数が使う）もそのまま使える
      const legacyCall = 'select private.enqueue_order_email($1, $2, $3) as inserted';
      expect((await db().query(legacyCall, [orderId, 'paid', 'order_confirmed'])).rows[0].inserted).toBe(true);
      expect((await db().query(legacyCall, [orderId, 'paid', 'payment_received'])).rows[0].inserted).toBe(false);
    });

    test('取り出しと履歴は、発送の番号と何回目かを返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });

      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({ order_id: orderId, kind: 'shipped', fulfillment_id: first.rows[0].fulfillment_id });

      const history = await db().query(
        'select kind, fulfillment_id, fulfillment_number from public.list_order_email_history($1)',
        [orderId],
      );
      expect(history.rows).toEqual([
        { kind: 'shipped', fulfillment_id: second.rows[0].fulfillment_id, fulfillment_number: 2 },
        { kind: 'shipped', fulfillment_id: first.rows[0].fulfillment_id, fulfillment_number: 1 },
      ]);
    });
  });

  describe('再送', () => {
    test('発送のメールの再送は発送ごと。一部だけ送った決済完了の注文でもでき、同じ発送の送信待ちは1行', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      await markOrderEmailsSent(db(), orderId);
      const sql = 'select public.request_order_email_resend($1, $2, $3, $4) as email_id';

      const resent = await db().query(sql, [orderId, 'shipped', actor.id, first.rows[0].fulfillment_id]);

      const row = await db().query(
        'select kind, origin, status, fulfillment_id, requested_by from private.order_email_outbox where id = $1',
        [resent.rows[0].email_id],
      );
      expect(row.rows).toEqual([{
        kind: 'shipped', origin: 'manual', status: 'pending', fulfillment_id: first.rows[0].fulfillment_id, requested_by: actor.id,
      }]);
      // 別の発送の再送は同時に待てる。同じ発送の2回目は断る
      await expect(db().query(sql, [orderId, 'shipped', actor.id, second.rows[0].fulfillment_id])).resolves.toBeTruthy();
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, first.rows[0].fulfillment_id], {
        code: '23505', message: 'RESEND_ALREADY_QUEUED',
      });
    });

    test('発送の番号が無い・ほかの注文の発送・取り消した発送・発送のメール以外への番号は断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const kept = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const dropped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const foreign = await ship(db(), other.orderId, actor.id, { lines: [{ order_item_id: other.stockItemId, quantity: 1 }] });
      await db().query('select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', 'order_confirmed']);
      await markOrderEmailsSent(db(), orderId);
      await markOrderEmailsSent(db(), other.orderId);
      await cancelFulfillment(db(), orderId, dropped.rows[0].fulfillment_id, actor.id);
      const sql = 'select public.request_order_email_resend($1, $2, $3, $4)';

      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, null], { code: '22023', message: 'RESEND_FULFILLMENT_REQUIRED' });
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, foreign.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, dropped.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [orderId, 'paid', actor.id, kept.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expect(db().query(sql, [orderId, 'paid', actor.id, null])).resolves.toBeTruthy();
    });
  });

  describe('取りやめ', () => {
    test('発送の取消による取りやめは、取り消した発送の発送のメールだけ', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      const sql = 'select public.skip_order_email($1, $2, $3)';

      // 取り消していない発送のメールは、この理由で取りやめない
      await expectRejected(db(), sql, [claimed.email_id, claimed.lease_token, 'fulfillment_cancelled'], {
        code: '22023', message: 'SKIP_REASON_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [claimed.email_id, claimed.lease_token, 'other'], { code: '22023', message: 'INVALID_SKIP_REASON' });

      // 発送のメール以外も、この理由で取りやめない
      await db().query('select public.complete_order_email($1, $2, null)', [claimed.email_id, claimed.lease_token]);
      await db().query('select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', 'order_confirmed']);
      const paid = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(paid).toMatchObject({ order_id: orderId, kind: 'paid', fulfillment_id: null });
      await expectRejected(db(), sql, [paid.email_id, paid.lease_token, 'fulfillment_cancelled'], {
        code: '22023', message: 'SKIP_REASON_NOT_ALLOWED',
      });
    });
  });

  describe('前からのデータ', () => {
    test('前の発送のメールの行を、前からの発送に結ぶ。2回目は何もしない（Review Focus 5）', async () => {
      // 移行の前を再現する: 発送の番号の無い発送のメールの行は、この取引の中だけ決まりを外して書く
      await db().query('alter table private.order_email_outbox drop constraint order_email_outbox_fulfillment_check');
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-9' },
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const email = await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent') returning id",
        [orderId],
      );
      await db().query('select private.backfill_legacy_fulfillments()');

      const linked = await db().query('select private.link_legacy_shipped_emails() as linked');
      expect(linked.rows[0].linked).toBeGreaterThanOrEqual(1);

      const legacy = await db().query('select id from public.order_fulfillments where order_id = $1 and legacy', [orderId]);
      const row = await db().query('select fulfillment_id from private.order_email_outbox where id = $1', [email.rows[0].id]);
      expect(row.rows[0].fulfillment_id).toBe(legacy.rows[0].id);
      expect((await db().query('select private.link_legacy_shipped_emails() as linked')).rows[0].linked).toBe(0);
    });
  });

  describe('消した物と権限', () => {
    test('前の発送の関数・受注の集計の view・前の形の関数は無く、同じ名前の関数は1つだけ', async () => {
      const res = await db().query(
        `select to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text,boolean)') as ship,
                to_regclass('public.variant_backorder_summary') as backorder_view,
                to_regprocedure('private.enqueue_order_email(uuid,text,text)') as old_enqueue,
                to_regprocedure('public.request_order_email_resend(uuid,text,uuid)') as old_resend`,
      );
      expect(res.rows[0]).toEqual({ ship: null, backorder_view: null, old_enqueue: null, old_resend: null });

      // 同じ名前の関数が2つあると、Data API が呼び分けられない（PGRST203）
      for (const [schema, name] of [
        ['private', 'enqueue_order_email'],
        ['public', 'request_order_email_resend'],
        ['public', 'claim_order_email'],
        ['public', 'list_order_email_history'],
        ['public', 'admin_create_fulfillment'],
        ['public', 'admin_cancel_fulfillment'],
      ]) {
        const count = await db().query(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2`,
          [schema, name],
        );
        expect({ name, n: count.rows[0].n }).toEqual({ name, n: 1 });
      }
    });

    test('発送の関数は service_role だけが呼べ、結ぶ関数はだれも呼べない', async () => {
      for (const signature of [
        'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
        'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
      ]) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
          [signature],
        );
        expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
      }
      const link = await db().query(
        "select has_function_privilege('service_role', 'private.link_legacy_shipped_emails()', 'EXECUTE') as allowed",
      );
      expect(link.rows[0].allowed).toBe(false);
    });
  });
});

describeLocalDb('integration: 同時の発送（Review Focus 1）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    await other.end();
  });

  test('同じ品を2つの画面から同時に送ると、後の方は発送準備中の数を超えて断られ、発送は1つだけ', async () => {
    const actor = await createActor(db());
    const { orderId, stockItemId } = await createMixedOrder(db());
    const lines = [{ order_item_id: stockItemId, quantity: 2 }];
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await ship(db(), orderId, actor.id, { notify: false, lines });
      // 後の発送は注文の行の鍵を待つ。待っている間に前の発送を確定させる
      const second = ship(other, orderId, actor.id, { notify: false, lines }).then(() => null, (error: unknown) => error);
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await second).toMatchObject({ code: '22023', message: 'QUANTITY_EXCEEDS_READY' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
    expect(count.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンドで `npx jest tests/integration/db/fulfillment_order_emails.integration.test.ts --runInBand`
Expected: FAIL（`function public.admin_create_fulfillment(...) does not exist` など）

- [ ] **Step 3: 移行 B を書く**

`supabase/migrations/20261010120100_fulfillment_order_emails.sql`:

```sql
-- 部分発送と注文の進み具合（グループ E-1 設計書 6・7・8 章）の移行 B
--
-- 注文のメールの表（グループ D の outbox）に発送の番号の列を足し、発送のメールを発送ごとに1行にする。
-- 発送の関数と発送の取消の関数を作り、前の発送の関数（admin_ship_paid_order。発送は注文に1回だけだった）と、
-- 受注の集計の view（variant_backorder_summary。在庫の画面は移行 A の list_variant_stock_states に替える）を消す。
-- 移行 A（20261010120000_order_fulfillments.sql）の後に当てる。
BEGIN;

-- 1. 発送の番号の列（設計書 8-1）。発送の記録は消せない（移行 A の守り）ので、消す時の決まりは RESTRICT
ALTER TABLE private.order_email_outbox
  ADD COLUMN IF NOT EXISTS fulfillment_id uuid REFERENCES public.order_fulfillments (id) ON DELETE RESTRICT;

-- 2. 前の発送のメールの行を、移行 A が写した前からの発送（注文ごとに1つ）に結ぶ（設計書 8-4）。
--    何度呼んでも同じ結果。結んだ行の数を返す
CREATE OR REPLACE FUNCTION private.link_legacy_shipped_emails()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_linked integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET fulfillment_id = f.id
  FROM public.order_fulfillments AS f
  WHERE e.kind = 'shipped'
    AND e.fulfillment_id IS NULL
    AND f.order_id = e.order_id
    AND f.legacy;
  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RETURN v_linked;
END;
$$;

SELECT private.link_legacy_shipped_emails();

-- 発送のメールは必ず発送を持ち、ほかの種類は持たない。結べなかった行が残れば、ここで移行全体が止まる
ALTER TABLE private.order_email_outbox DROP CONSTRAINT IF EXISTS order_email_outbox_fulfillment_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_fulfillment_check CHECK ((kind = 'shipped') = (fulfillment_id IS NOT NULL));

-- 3. 一意の決まり（設計書 8-1）
--    自動の行: 発送のメールは発送ごとに1行、ほかの種類は今のまま1注文1種類1行
--    手の再送: 送信待ちの間、発送のメールは発送ごとに1行、ほかの種類は1注文1種類1行（発送の番号の空を同じ値とみなす）
DROP INDEX IF EXISTS private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped';

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_auto_shipped_idx
  ON private.order_email_outbox (fulfillment_id)
  WHERE origin = 'auto' AND kind = 'shipped';

DROP INDEX IF EXISTS private.order_email_outbox_manual_open_idx;
CREATE UNIQUE INDEX order_email_outbox_manual_open_idx
  ON private.order_email_outbox (order_id, kind, fulfillment_id) NULLS NOT DISTINCT
  WHERE origin = 'manual' AND status IN ('pending', 'sending', 'retry_wait');

-- 発送の取消と再送で、その発送のメールを探す
CREATE INDEX IF NOT EXISTS order_email_outbox_fulfillment_idx
  ON private.order_email_outbox (fulfillment_id)
  WHERE fulfillment_id IS NOT NULL;

-- 4. 予定を書く（設計書 8-1）。発送のメールは発送の番号を必ず渡す（無ければ表の CHECK で止まる）。
--    引数を足すので作り直す。3つの引数の呼び方（入金済み・入金待ち・期限切れ・取消）は、そのまま新しい関数に当たる
DROP FUNCTION IF EXISTS private.enqueue_order_email(uuid, text, text);

CREATE OR REPLACE FUNCTION private.enqueue_order_email(
  _order_id uuid,
  _kind text,
  _variant text DEFAULT NULL,
  _fulfillment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id)
    ON CONFLICT (order_id, kind) WHERE origin = 'auto' AND kind <> 'shipped' DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 5. 送る行を1つ取り出す（グループ D 設計書 4-1・4-3・4-5）。worker が発送の材料を読めるよう、最後の列に発送の番号を足す。
--    返す列を変えるので作り直す。ほかの中身は前と同じ
DROP FUNCTION IF EXISTS public.claim_order_email(integer);

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
  payment_expired_sent boolean,
  fulfillment_id uuid
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
    RETURNING e.id, e.order_id, e.kind, e.variant, e.origin, e.attempts, e.lease_token, e.subject, e.body_text,
              e.fulfillment_id
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         ),
         c.fulfillment_id
  FROM claimed AS c;
END;
$$;

-- 6. 取りやめ（グループ D 設計書 4-1）。発送の取消の理由を足す（設計書 7-3）
CREATE OR REPLACE FUNCTION public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _reason IS NULL OR _reason NOT IN ('superseded', 'no_recipient', 'fulfillment_cancelled') THEN
    RAISE EXCEPTION 'INVALID_SKIP_REASON' USING ERRCODE = '22023';
  END IF;

  -- 取りやめ（superseded）は入金待ちと支払い期限切れだけ（グループ D 設計書 4-1）。入金済み・取消・発送はその時の事実を伝えるので取りやめない
  IF _reason = 'superseded' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    WHERE e.id = _email_id
      AND e.kind NOT IN ('awaiting_payment', 'payment_expired')
  ) THEN
    RAISE EXCEPTION 'SUPERSEDE_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送の取消による取りやめは、取り消した発送の発送のメールだけ（worker の思い違いで、送るべきメールを落とさない）
  IF _reason = 'fulfillment_cancelled' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
    WHERE e.id = _email_id
      AND (e.kind <> 'shipped' OR f.cancelled_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'SKIP_REASON_NOT_ALLOWED' USING ERRCODE = '22023';
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

-- 7. 管理画面の再送（グループ D 設計書 5-3、E-1 設計書 8-2）。発送のメールは発送ごとに再送する。
--    発送の番号を足すので作り直す
DROP FUNCTION IF EXISTS public.request_order_email_resend(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.request_order_email_resend(
  _order_id uuid,
  _kind text,
  _actor_id uuid,
  _fulfillment_id uuid DEFAULT NULL
)
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
  -- 発送のメールは発送ごとに送るので、どの発送かが要る
  IF _kind = 'shipped' AND _fulfillment_id IS NULL THEN
    RAISE EXCEPTION 'RESEND_FULFILLMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 発送のメールは、一部だけ送った決済完了の注文でも再送できる
  IF NOT (
    (_kind = 'paid' AND v_status IN ('paid', 'shipped'))
    OR (_kind = 'awaiting_payment' AND v_status = 'pending')
    OR (_kind = 'payment_expired' AND v_status = 'failed')
    OR (_kind = 'canceled' AND v_status = 'cancelled')
    OR (_kind = 'shipped' AND v_status IN ('paid', 'shipped'))
  ) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送の番号は発送のメールだけに付く。その注文の、取り消していない発送だけ
  IF (_kind <> 'shipped' AND _fulfillment_id IS NOT NULL)
     OR (_kind = 'shipped' AND NOT EXISTS (
       SELECT 1
       FROM public.order_fulfillments AS f
       WHERE f.id = _fulfillment_id
         AND f.order_id = _order_id
         AND f.cancelled_at IS NULL
     )) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  SELECT e.variant, true INTO v_variant, v_found
  FROM private.order_email_outbox AS e
  WHERE e.order_id = _order_id
    AND e.kind = _kind
    AND e.fulfillment_id IS NOT DISTINCT FROM _fulfillment_id
    AND e.status IN ('sent', 'dead')
  ORDER BY e.seq DESC
  LIMIT 1;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, requested_by, fulfillment_id)
    VALUES (_order_id, _kind, v_variant, 'manual', _actor_id, _fulfillment_id)
    RETURNING id INTO v_email_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESEND_ALREADY_QUEUED' USING ERRCODE = '23505';
  END;

  RETURN v_email_id;
END;
$$;

-- 8. 管理画面の履歴（グループ D 設計書 5-1）。発送のメールの発送の番号と何回目かを足す（E-1 設計書 9-2）。本文は返さない。
--    返す列を変えるので作り直す
DROP FUNCTION IF EXISTS public.list_order_email_history(uuid);

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
  body_erased boolean,
  fulfillment_id uuid,
  fulfillment_number integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL,
         e.fulfillment_id, f.number
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 9. 発送する（設計書 6-3）。在庫は注文の時に確保済みなので動かさず、色・サイズの在庫に鍵はかけない
CREATE OR REPLACE FUNCTION public.admin_create_fulfillment(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean,
  _lines jsonb
)
RETURNS TABLE (
  fulfillment_id uuid,
  number integer,
  completes_order boolean,
  order_status public.order_status,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
  v_quantities integer[];
  v_order public.orders;
  v_existing public.order_fulfillments;
  v_unshipped integer;
  v_requested integer;
  v_number integer;
  v_fulfillment_id uuid;
  v_completes boolean;
  v_constraint text;
BEGIN
  IF _order_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _shipping_carrier IS NULL
     OR _shipping_carrier NOT IN ('yamato', 'sagawa', 'japanpost')
     OR _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'FULFILLMENT_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(p.order_item_id ORDER BY p.order_item_id),
         pg_catalog.array_agg(p.quantity ORDER BY p.order_item_id)
  INTO v_ids, v_quantities
  FROM private.parse_fulfillment_lines(_lines, 'FULFILLMENT_ARGUMENT_INVALID') AS p;

  -- 同じ注文の操作（発送・取消・仕上がり）を1つずつ進める。同時に2つの発送が来ても、後の方は前の発送の後の数で確かめる
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 同じ重複防止キーの送り直し（通信が切れた後の「もう一度確かめる」）は、同じ中身なら前の結果を返す
  SELECT f.* INTO v_existing FROM public.order_fulfillments AS f WHERE f.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id
       OR v_existing.shipping_carrier IS DISTINCT FROM _shipping_carrier
       OR v_existing.tracking_number IS DISTINCT FROM _tracking_number
       OR v_existing.notify_customer <> _notify_customer
       OR (
         SELECT pg_catalog.count(*)
         FROM public.order_fulfillment_lines AS l
         WHERE l.fulfillment_id = v_existing.id
       ) <> pg_catalog.cardinality(v_ids)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.order_fulfillment_lines AS l
           WHERE l.fulfillment_id = v_existing.id
             AND l.order_item_id = r.order_item_id
             AND l.quantity = r.quantity
         )
       ) THEN
      RAISE EXCEPTION 'FULFILLMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT v_existing.id, v_existing.number, v_existing.completes_order, v_order.status, true;
    RETURN;
  END IF;

  IF v_order.status <> 'paid'::public.order_status THEN
    RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;

  -- 一部の発送でも毎回確かめる（配送先は後から直せないので、足りない注文は1つも送らない）
  IF NOT private.order_has_required_shipping_fields(v_order) THEN
    RAISE EXCEPTION 'SHIPPING_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_exceptions AS e
    WHERE e.order_id = _order_id
      AND e.reason = 'paid_amount_mismatch'
      AND e.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PAYMENT_REVIEW_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
  FROM private.order_line_fulfillment(_order_id) AS l;
  IF v_unshipped = 0 THEN
    RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_ids) AS r(order_item_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_items AS oi
      WHERE oi.id = r.order_item_id
        AND oi.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity)
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE r.quantity > l.ready_unshipped
  ) THEN
    RAISE EXCEPTION 'QUANTITY_EXCEEDS_READY' USING ERRCODE = '22023';
  END IF;

  -- 本計画 P13: 行を書く前に「未発送の合計 − 今回送る数の合計 = 0」で決める（送る数は発送準備中の数以下なので負にならない）
  SELECT pg_catalog.sum(r.quantity)::integer INTO v_requested
  FROM pg_catalog.unnest(v_quantities) AS r(quantity);
  v_completes := v_unshipped - v_requested = 0;

  -- 何回目かは取り消した発送も数える（履歴の「発送（n回目）」が変わらない）
  SELECT COALESCE(pg_catalog.max(f.number), 0) + 1 INTO v_number
  FROM public.order_fulfillments AS f
  WHERE f.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_fulfillments AS f
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, created_by)
    VALUES (_order_id, v_number, _request_key, _shipping_carrier, _tracking_number, _notify_customer, v_completes, _actor_id)
    RETURNING f.id INTO v_fulfillment_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じキーをほかの注文の発送が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の結果を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_fulfillments_request_key_key' THEN
      RAISE EXCEPTION 'FULFILLMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity)
  SELECT v_fulfillment_id, r.order_item_id, r.quantity
  FROM pg_catalog.unnest(v_ids, v_quantities) AS r(order_item_id, quantity);

  -- 全部を送った時だけ、注文を発送済みにする（今の発送の列の意味＝全部を送った時の値を守る。
  -- 全額返金の取り消しの戻し先と、配送先を確かめるトリガーがそのまま使える）
  IF v_completes THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_create_fulfillment', true);
    UPDATE public.orders AS o
    SET status = 'shipped'::public.order_status,
        shipped_at = pg_catalog.now(),
        shipping_carrier = _shipping_carrier,
        tracking_number = _tracking_number
    WHERE o.id = _order_id;
  END IF;

  IF _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'shipped', NULL, v_fulfillment_id);
  END IF;

  RETURN QUERY
  SELECT v_fulfillment_id, v_number, v_completes, o.status, false
  FROM public.orders AS o
  WHERE o.id = _order_id;
END;
$$;

-- 10. 発送の取消（設計書 7-3）。何度押しても同じ結果
CREATE OR REPLACE FUNCTION public.admin_cancel_fulfillment(_order_id uuid, _fulfillment_id uuid, _actor_id uuid)
RETURNS TABLE (outcome text, order_status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status public.order_status;
  v_cancelled_at timestamptz;
  v_unshipped integer;
BEGIN
  IF _order_id IS NULL OR _fulfillment_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'FULFILLMENT_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT f.cancelled_at INTO v_cancelled_at
  FROM public.order_fulfillments AS f
  WHERE f.id = _fulfillment_id
    AND f.order_id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_cancelled_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_cancelled'::text, v_status;
    RETURN;
  END IF;

  -- 取り消した注文（返金で取り消した注文を含む）の発送は戻さない（E-2・E-3 で、返品や発送後の返金に使われた発送を拒む条件を足す）
  IF v_status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'FULFILLMENT_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_fulfillments AS f
  SET cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE f.id = _fulfillment_id;

  SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
  FROM private.order_line_fulfillment(_order_id) AS l;

  -- 未発送の品が戻ったら、注文を決済完了に戻す（発送の列は「全部を送った時の値」なので空にする）
  IF v_status = 'shipped'::public.order_status AND v_unshipped > 0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_fulfillment', true);
    UPDATE public.orders AS o
    SET status = 'paid'::public.order_status,
        shipped_at = NULL,
        shipping_carrier = NULL,
        tracking_number = NULL
    WHERE o.id = _order_id;
    v_status := 'paid'::public.order_status;
  END IF;

  -- まだ送っていない発送のメール（送る前・やり直し待ち）は取りやめる。
  -- 送っている途中の行は、worker が中身を作る時に取消を見て取りやめる
  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      last_error_code = 'fulfillment_cancelled'
  WHERE e.fulfillment_id = _fulfillment_id
    AND e.status IN ('pending', 'retry_wait');

  RETURN QUERY SELECT 'cancelled'::text, v_status;
END;
$$;

-- 11. 前の発送の関数（発送は注文に1回だけだった）と、受注の集計の view（在庫の画面は list_variant_stock_states に替える）を消す
DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text, boolean);
DROP VIEW IF EXISTS public.variant_backorder_summary;

-- 12. 権限。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.link_legacy_shipped_emails() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 4: 新しい試験が通ることを確かめる**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンドで `npx jest tests/integration/db/fulfillment_order_emails.integration.test.ts --runInBand`
Expected: PASS（全部）

- [ ] **Step 5: メールの種類の表を直す（単体テストを先に）**

`tests/unit/lib/orders/email/order-email-types.test.ts` を次の内容にする（今のファイルとの違いは、移行 B を読むこと、`functionBody` の道具、取りやめの理由に `fulfillment_cancelled`、原因の名前の確かめ、再送の表を移行 B の関数から読んで突き合わせること）:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  isOrderEmailKind,
  ORDER_EMAIL_ERROR_CODES,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  ORDER_EMAIL_KINDS,
  ORDER_EMAIL_STATUSES,
  ORDER_EMAIL_DELIVERY_STATUSES,
  DELIVERY_PROBLEM_STATUSES,
  RESENDABLE_ORDER_STATUSES,
  type OrderEmailVariant,
  type OrderEmailPauseReason,
  type OrderEmailSkipReason,
  type OrderEmailFailureCategory,
} from '@/lib/orders/email/order-email-types';

/**
 * アプリの値と DB の CHECK・関数の入力制限がずれないことを、移行の本文で確かめる。
 * - 表の CHECK・書き分け・失敗の分類: グループ D の移行（20261009095633）
 * - 発送ごとのメールで作り直した関数（取りやめの理由・再送できる状態の表）: グループ E-1 の移行 B（20261010120100）
 * 本番へ当てて版を改名したら、ここの名前も直す。
 */
const outboxMigration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261009095633_order_email_outbox.sql'), 'utf8',
);
// 行の説明にも関数名や許可の表の例が出るので、説明は外してから読む
const fulfillmentEmailMigration = fs
  .readFileSync(path.join(process.cwd(), 'supabase/migrations/20261010120100_fulfillment_order_emails.sql'), 'utf8')
  .replace(/--.*$/gm, '');

function sqlValues(pattern: RegExp, sql = outboxMigration): string[] {
  const values = sql.match(pattern)?.[1];
  expect(values).toBeDefined();
  return [...(values ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

/** 関数の本文。`CREATE [OR REPLACE] FUNCTION <名前>(` の次から、最初の `$$;` まで */
function functionBody(sql: string, qualifiedName: string): string {
  const header = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${qualifiedName.replace('.', '[.]')} *[(]`);
  const body = sql.split(header)[1]?.split('$$;')[0];
  expect(body).toBeDefined();
  return body as string;
}

describe('注文のメールの種類と名前', () => {
  it('メールの種類・状態・配達の状態は DB の CHECK と同じ値', () => {
    expect([...ORDER_EMAIL_KINDS].sort()).toEqual(sqlValues(/CHECK\s*\(kind IN \(([^)]+)\)/));
    expect([...ORDER_EMAIL_STATUSES].sort()).toEqual(sqlValues(/CHECK\s*\(status IN \(([^)]+)\)/));
    expect([...ORDER_EMAIL_DELIVERY_STATUSES].sort()).toEqual(sqlValues(/delivery_status IN \(([^)]+)\)/));
  });

  it('書き分けと一時停止の理由は DB の CHECK と同じ値', () => {
    // 型だけの値も Record で全件を並べ、型の増減と DB の増減を両方検知する。
    const variants: Record<OrderEmailVariant, true> = {
      order_confirmed: true, payment_received: true, payment_received_after_expiry: true, payment_in_progress: true, pending: true,
    };
    const pauseReasons: Record<OrderEmailPauseReason, true> = {
      config_api_key: true, config_sender_domain: true, config_provider: true, quota_daily: true, quota_monthly: true,
    };
    const paidVariants = sqlValues(/kind = 'paid'[\s\S]*?variant IN \(([^)]+)\)/);
    const canceledVariants = sqlValues(/kind = 'canceled'[\s\S]*?variant IN \(([^)]+)\)/);
    expect(Object.keys(variants).sort()).toEqual([...paidVariants, ...canceledVariants].sort());
    expect(Object.keys(pauseReasons).sort()).toEqual(sqlValues(/reason IN \(([^)]+)\)/));
  });

  it('取りやめの理由・失敗の分類は DB の関数の入力制限と同じ値', () => {
    const skipReasons: Record<OrderEmailSkipReason, true> = { superseded: true, no_recipient: true, fulfillment_cancelled: true };
    const categories: Record<OrderEmailFailureCategory, true> = { transient: true, config: true, permanent: true };
    // 取りやめの理由は、足した理由を含む移行 B の関数から読む。失敗の分類は変わっていないグループ D の移行から読む
    const sqlSkipReasons = sqlValues(/_reason NOT IN \(([^)]+)\)/, functionBody(fulfillmentEmailMigration, 'public.skip_order_email'));
    expect(Object.keys(skipReasons).sort()).toEqual(sqlSkipReasons);
    // 取りやめの理由は、履歴に出す原因の記号でもある。DB が受ける理由は、アプリが名前を持つ記号だけ
    for (const reason of sqlSkipReasons) expect(isOrderEmailErrorCode(reason)).toBe(true);
    expect(Object.keys(categories).sort()).toEqual(
      sqlValues(/_category NOT IN \(([^)]+)\)/, functionBody(outboxMigration, 'public.fail_order_email')),
    );
  });

  it('原因の記号は DB の CHECK の形を満たし、配達の問題の一覧は DB の索引と同じ値', () => {
    const errorPattern = outboxMigration.match(/last_error_code ~ '([^']+)'/)?.[1];
    expect(errorPattern).toBeDefined();
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(code).toMatch(new RegExp(errorPattern as string));
    expect([...DELIVERY_PROBLEM_STATUSES].sort()).toEqual(sqlValues(/WHERE delivery_status IN \(([^)]+)\)/));
  });

  it('種類の名前は設計書のとおり', () => {
    expect(ORDER_EMAIL_KIND_LABELS).toEqual({
      paid: '注文確認', awaiting_payment: '入金待ち', payment_expired: '支払い期限切れ', canceled: '取消', shipped: '発送',
    });
  });

  it('原因の記号にはすべて日本語の名前がある。宛先の形の不正は「宛先の形が不正」、発送の取消は「発送の取消」', () => {
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(ORDER_EMAIL_ERROR_LABELS[code]).toEqual(expect.any(String));
    expect(ORDER_EMAIL_ERROR_LABELS.invalid_message).toBe('宛先の形が不正');
    expect(ORDER_EMAIL_ERROR_LABELS.provider_unavailable).toBe('送信サービスの一時的な失敗');
    expect(ORDER_EMAIL_ERROR_LABELS.fulfillment_cancelled).toBe('発送の取消');
  });

  it('再送できる注文の状態は DB の request_order_email_resend と同じ表（発送のメールは、一部だけ送った間の決済完了でも再送できる）', () => {
    expect(RESENDABLE_ORDER_STATUSES).toEqual({
      paid: ['paid', 'shipped'], awaiting_payment: ['pending'], payment_expired: ['failed'], canceled: ['cancelled'], shipped: ['paid', 'shipped'],
    });

    // 移行 B の関数の許可の表を読んで突き合わせる。1つの種類は
    // `(_kind = '種類' AND v_status IN ('状態', ...))` か `(_kind = '種類' AND v_status = '状態')` の形で書いてある
    const sqlMatrix: Record<string, string[]> = {};
    for (const match of functionBody(fulfillmentEmailMigration, 'public.request_order_email_resend').matchAll(
      /\(_kind = '([a-z_]+)' AND v_status (?:IN \(([^)]+)\)|= '([a-z_]+)')\)/g,
    )) {
      sqlMatrix[match[1]] = (match[2] ? [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1]) : [match[3]]).sort();
    }
    const appMatrix = Object.fromEntries(ORDER_EMAIL_KINDS.map((kind) => [kind, [...RESENDABLE_ORDER_STATUSES[kind]].sort()]));
    expect(sqlMatrix).toEqual(appMatrix);
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

この repo の ts-jest は型を検査せずに流す（`tsconfig.json` の `isolatedModules: true`）。型の食い違いは Step 14 の `npx tsc --noEmit` で見る。

Run: `npx jest tests/unit/lib/orders/email/order-email-types.test.ts --runInBand`
Expected: FAIL（3件）— 「取りやめの理由・失敗の分類…」（`isOrderEmailErrorCode('fulfillment_cancelled')` が false）、「原因の記号にはすべて日本語の名前がある…」（`fulfillment_cancelled` の名前が `undefined`）、「再送できる注文の状態は…」（`shipped` が `['shipped']` のまま）

`src/lib/orders/email/order-email-types.ts` を4か所直す。

(a) ファイルの先頭の説明（1〜6行目）を置き換える:

```ts
import type { OrderStatus, PaidEmailVariant } from '@/lib/orders/order-payment-types';

/**
 * 注文のメールの種類・状態・原因の記号（グループ D 設計書 3・4・5・6 章）。
 * DB の CHECK 制約（移行 20261009095633_order_email_outbox.sql）と同じ値を1か所に置く。画面からも読む。
 * 取りやめの理由と再送できる状態の表は、発送ごとのメールで作り直した移行 20261010120100_fulfillment_order_emails.sql の関数と同じ。
 */
```

(b) `ORDER_EMAIL_ERROR_CODES` から `OrderEmailSkipReason` まで（30〜56行目）を置き換える（`fulfillment_cancelled` と取りやめの理由の1行だけが増える）:

```ts
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
  'fulfillment_cancelled',
  'legacy_suppressed',
] as const;
export type OrderEmailErrorCode = (typeof ORDER_EMAIL_ERROR_CODES)[number];

export type OrderEmailFailureCategory = 'transient' | 'config' | 'permanent';
export type OrderEmailPauseReason = Extract<
  OrderEmailErrorCode,
  'config_api_key' | 'config_sender_domain' | 'config_provider' | 'quota_daily' | 'quota_monthly'
>;
export type OrderEmailSkipReason = Extract<OrderEmailErrorCode, 'superseded' | 'no_recipient' | 'fulfillment_cancelled'>;
```

(c) `ORDER_EMAIL_ERROR_LABELS`（66〜85行目）を置き換える:

```ts
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
  fulfillment_cancelled: '発送の取消',
  legacy_suppressed: '移行前の注文のため',
};
```

(d) `RESENDABLE_ORDER_STATUSES`（96〜103行目。説明ごと）を置き換える:

```ts
/**
 * 再送できる種類と、そのときの注文の状態（設計書 5-3。DB の request_order_email_resend と同じ表）。
 * 発送のメールは、一部だけ送った間の注文（決済完了）でも再送できる（グループ E-1 設計書 8-2）。
 * その発送が取り消されていないことは、DB の関数と履歴の組み立てが見る。
 */
export const RESENDABLE_ORDER_STATUSES: Record<OrderEmailKind, readonly OrderStatus[]> = {
  paid: ['paid', 'shipped'],
  awaiting_payment: ['pending'],
  payment_expired: ['failed'],
  canceled: ['cancelled'],
  shipped: ['paid', 'shipped'],
};
```

Run: `npx jest tests/unit/lib/orders/email/order-email-types.test.ts --runInBand`
Expected: PASS

- [ ] **Step 6: Task 1 の試験を移行 B に合わせる**

`tests/integration/db/order_fulfillments.integration.test.ts` の `test('発送済みの注文に、全部の商品を1回で送った記録と、…')` の中の次の部分:

```ts
      await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent')",
        [orderId],
      );
```

を次に置き換える:

```ts
      // 移行 B の後は、発送のメールの行に発送の番号が要る。移行の前の行を再現するため、この取引の中だけ決まりを外す
      await db().query('alter table private.order_email_outbox drop constraint order_email_outbox_fulfillment_check');
      await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent')",
        [orderId],
      );
```

- [ ] **Step 7: 注文のメールの予定を書く試験を直す**

`tests/integration/db/order_email_enqueue.integration.test.ts`:

(a) `function markPaid(…) { … }` の後に足す:

```ts
/** 発送できる入金済みの注文（在庫の品1つ） */
async function createShippableOrder(db: PgClient): Promise<{ orderId: string; orderItemId: string }> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  return insertOrderWithStockLine(db, {
    status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
  });
}

/** 全部の商品を1回で送る（グループ E-1 の発送の関数） */
function shipAll(
  db: PgClient,
  order: { orderId: string; orderItemId: string },
  actor: string,
  carrier: string,
  tracking: string,
  notify: boolean,
) {
  return db.query(
    'select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), $3, $4, $5, $6::jsonb)',
    [order.orderId, actor, carrier, tracking, notify, JSON.stringify([{ order_item_id: order.orderItemId, quantity: 1 }])],
  );
}
```

(b) `test('発送は「発送のメールを送る」の時だけ行を書き、履歴に配送業者と伝票番号が出る', …)` と `test('発送の関数は「送るか」を省くと断る', …)` の2つを丸ごと次に置き換える:

```ts
  test('発送は「発送のメールを送る」の時だけ、その発送の行を書き、履歴に配送業者と伝票番号が出る', async () => {
    const actor = await createActor(db());
    const notified = await createShippableOrder(db());
    const silent = await createShippableOrder(db());

    const shipped = await shipAll(db(), notified, actor, 'yamato', 'TRK-1', true);
    await shipAll(db(), silent, actor, 'sagawa', 'TRK-2', false);

    expect(shipped.rows).toEqual([expect.objectContaining({ completes_order: true, order_status: 'shipped', replayed: false })]);
    expect(await emailsOf(db(), notified.orderId)).toEqual([{ kind: 'shipped', variant: null, origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), silent.orderId)).toEqual([]);
    const linked = await db().query(
      "select fulfillment_id from private.order_email_outbox where order_id = $1 and kind = 'shipped'",
      [notified.orderId],
    );
    expect(linked.rows).toEqual([{ fulfillment_id: shipped.rows[0].fulfillment_id }]);
    const history = await db().query(
      'select to_status, shipping_carrier, tracking_number from public.list_order_status_history($1)',
      [notified.orderId],
    );
    expect(history.rows).toEqual([{ to_status: 'shipped', shipping_carrier: 'yamato', tracking_number: 'TRK-1' }]);
  });

  test('発送の関数は「送るか」を省くと断る', async () => {
    const actor = await createActor(db());
    const { orderId, orderItemId } = await createShippableOrder(db());
    const lines = JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }]);

    await expect(
      db().query(
        "select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRK-3', null, $3::jsonb)",
        [orderId, actor, lines],
      ),
    ).rejects.toMatchObject({ code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });
    await expect(
      db().query(
        "select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRK-3', $3::jsonb)",
        [orderId, actor, lines],
      ),
    ).rejects.toMatchObject({ code: '42883' });
  });
```

(c) `test('古い送信権の表と関数は無い', …)` の問い合わせと期待を次に置き換える（前の発送の関数も無いことを足す）:

```ts
    const res = await db().query(
      `select to_regclass('private.order_emails') as claims,
              to_regprocedure('public.claim_order_email(uuid,text)') as claim,
              to_regprocedure('public.release_order_email(uuid,text)') as release,
              to_regprocedure('private.suppress_legacy_unpaid_order_emails()') as suppress,
              to_regprocedure('public.mark_order_paid(uuid,public.order_status,text,integer,text,text)') as old_mark_paid,
              to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text)') as old_ship,
              to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text,boolean)') as ship_paid`,
    );
    expect(res.rows[0]).toEqual({
      claims: null, claim: null, release: null, suppress: null, old_mark_paid: null, old_ship: null, ship_paid: null,
    });
```

(d) `test('作り直した関数は anon・authenticated が呼べず、service_role だけが呼べる', …)` の `signatures` を次に置き換える:

```ts
    const signatures = [
      'public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
      'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
      'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    ];
```

- [ ] **Step 8: 注文のメールの表の試験を直す**

`tests/integration/db/order_email_outbox.integration.test.ts`:

(a) `async function enqueue(…)` を丸ごと次に置き換え、その後に `insertFulfillmentRecord` を足す:

```ts
async function enqueue(
  db: PgClient,
  orderId: string,
  kind: string,
  variant: string | null = null,
  fulfillmentId: string | null = null,
): Promise<boolean> {
  const res = await db.query(
    'select private.enqueue_order_email($1::uuid, $2::text, $3::text, $4::uuid) as inserted',
    [orderId, kind, variant, fulfillmentId],
  );
  return res.rows[0].inserted as boolean;
}

/** 発送のメールは発送の記録が要る（グループ E-1）。再送の状態表だけを確かめる試験では、発送の関数を通さず直接書く */
async function insertFulfillmentRecord(db: PgClient, orderId: string): Promise<string> {
  const res = await db.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order)
     values ($1, 1, gen_random_uuid(), 'yamato', '1234-5678', true, true)
     returning id`,
    [orderId],
  );
  return res.rows[0].id as string;
}
```

(b) `test.each(ORDER_EMAIL_KINDS.flatMap(…))('送信済みの %s × 注文状態 %s の再送可否は RESENDABLE_ORDER_STATUSES と一致する', …)` を丸ごと次に置き換える:

```ts
    test.each(ORDER_EMAIL_KINDS.flatMap((kind) => ORDER_STATUSES.map((status) => [kind, status] as const)))(
      '送信済みの %s × 注文状態 %s の再送可否は RESENDABLE_ORDER_STATUSES と一致する', async (kind, status) => {
        const actor = await createActor(db());
        const orderId = await createOrder(db(), status);
        const variant = kind === 'paid' ? 'order_confirmed' : kind === 'canceled' ? 'pending' : null;
        // 発送のメールは発送ごとに送るので、発送の記録を用意して、その発送の行にする（グループ E-1）
        const fulfillmentId = kind === 'shipped' ? await insertFulfillmentRecord(db(), orderId) : null;
        await enqueue(db(), orderId, kind, variant, fulfillmentId);
        // 今の注文の状態に関係なく過去に送れた行を用意し、再送の状態表だけを確かめる
        await db().query("update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where order_id = $1", [orderId]);
        const sql = 'select public.request_order_email_resend($1, $2, $3, $4) as email_id';
        const args = [orderId, kind, actor.id, fulfillmentId];
        if (RESENDABLE_ORDER_STATUSES[kind].includes(status)) {
          const res = await db().query(sql, args);
          expect(await emailRow(db(), res.rows[0].email_id)).toMatchObject({
            order_id: orderId, kind, status: 'pending', origin: 'manual', fulfillment_id: fulfillmentId,
          });
        } else {
          await expectRejected(db(), sql, args, { code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED') });
        }
      },
    );
```

(c) `test('今の注文の状態で意味の無い種類と、送信済み・送れなかったの行が無い種類は断る', …)` の中の次の部分:

```ts
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'shipped', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });
```

を次に置き換える:

```ts
      // 発送のメールは、どの発送かを渡さないと断る（グループ E-1 設計書 8-2）
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'shipped', actor.id], {
        code: '22023', message: 'RESEND_FULFILLMENT_REQUIRED',
      });
```

(d) `describe('片付けと守り', …)` の1つ目の `test.each([…])` の `'public.request_order_email_resend(uuid, text, uuid)',` を `'public.request_order_email_resend(uuid, text, uuid, uuid)',` に、2つ目の `test.each([…])` の `'private.enqueue_order_email(uuid, text, text)',` を `'private.enqueue_order_email(uuid, text, text, uuid)',` に置き換える。

- [ ] **Step 9: 保留の守りの結合テストを直す**

`tests/integration/db/order_state_transition_hardening.integration.test.ts`:

(a) `async function insertOrder(…) { … }` の後に足す:

```ts
  /** 発送の関数は商品の行が要るので、注文に在庫の品を1つ足す（色・サイズの無い商品には、トリガーがバリアントを1つ作る） */
  async function insertOrderItem(orderId: string): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'state transition', 1000, 'TOPS', '/images/test.jpg', 'published')
       returning id`,
      [`state-transition-${suffix}`],
    );
    const variant = await client.query('select id from public.item_variants where item_id = $1 limit 1', [item.rows[0].id]);
    const line = await client.query(
      `insert into public.order_items
         (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
       values ($1, $2, $3, 'state transition', 1000, 1, 1000, 'stock')
       returning id`,
      [orderId, item.rows[0].id, variant.rows[0].id],
    );
    return line.rows[0].id as string;
  }
```

(b) `test('authenticated cannot update orders or execute transition RPCs', …)` の中の2か所の `'public.admin_ship_paid_order(uuid,uuid,text,text,boolean)',` を、どちらも `'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',` に置き換える。

(c) `test('shipping and refund projection RPCs execute with service-role-only transitions', …)` の中:

- `const shippingOrderId = await insertOrder({ status: 'paid' });` の次の行に足す:

```ts
      const shippingItemId = await insertOrderItem(shippingOrderId);
```

- 次の部分:

```ts
      const shipped = await client.query(
        `select * from public.admin_ship_paid_order(
           $1::uuid, $2::uuid, 'yamato'::text, 'TRACK-123'::text, false
         )`,
        [shippingOrderId, actorId],
      );
```

を次に置き換える:

```ts
      const shipped = await client.query(
        `select * from public.admin_create_fulfillment(
           $1::uuid, $2::uuid, gen_random_uuid(), 'yamato'::text, 'TRACK-123'::text, false, $3::jsonb
         )`,
        [shippingOrderId, actorId, JSON.stringify([{ order_item_id: shippingItemId, quantity: 1 }])],
      );
```

- 次の部分:

```ts
      expect(shipped.rows).toEqual([
        expect.objectContaining({ id: shippingOrderId }),
      ]);
```

を次に置き換える:

```ts
      expect(shipped.rows).toEqual([
        expect.objectContaining({ completes_order: true, order_status: 'shipped', replayed: false }),
      ]);
```

(d) `test('配送先欠落の paid 注文は RPC と直接 UPDATE の両方で出荷できない', …)` を丸ごと次に置き換え、その後に新しい試験を足す:

```ts
  test('配送先欠落の paid 注文は RPC と直接 UPDATE の両方で出荷できない', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const orderId = await insertOrder({ status: 'paid', shippingComplete: false });
      const orderItemId = await insertOrderItem(orderId);
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`shipping-hold-${Date.now()}@example.com`],
      );

      // 発送の関数は断る（前の関数は0行を返していた）。断りで取引が止まらないよう、退避点の中で呼ぶ
      await client.query('savepoint before_rpc_ship');
      await client.query('set local role service_role');
      await expect(
        client.query(
          `select * from public.admin_create_fulfillment(
            $1::uuid, $2::uuid, gen_random_uuid(), 'yamato'::text, 'TRACK-123'::text, false, $3::jsonb
          )`,
          [orderId, actor.rows[0].id, JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }])],
        ),
      ).rejects.toMatchObject({ code: '22023', message: 'SHIPPING_ADDRESS_INCOMPLETE' });
      await client.query('rollback to savepoint before_rpc_ship');

      await client.query('savepoint before_direct_ship');
      await expect(
        client.query(
          `update public.orders
           set status = 'shipped'::public.order_status, shipped_at = now()
           where id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_SHIPPING_ADDRESS_INCOMPLETE') });
      await client.query('rollback to savepoint before_direct_ship');
    } finally {
      await client.query('rollback');
    }
  });

  test('発送の取消だけが、発送済みから決済完了へ戻せる（グループ E-1 設計書 7-3）', async () => {
    await client.query('begin');
    try {
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`fulfillment-cancel-${Date.now()}@example.com`],
      );
      const actorId = actor.rows[0].id as string;
      const orderId = await insertOrder({ status: 'paid' });
      const orderItemId = await insertOrderItem(orderId);
      const lines = JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }]);

      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRACK-9', false, $3::jsonb)`,
        [orderId, actorId, lines],
      );
      const cancelled = await client.query(
        'select * from public.admin_cancel_fulfillment($1::uuid, $2::uuid, $3::uuid)',
        [orderId, shipped.rows[0].fulfillment_id, actorId],
      );
      await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRACK-10', false, $3::jsonb)`,
        [orderId, actorId, lines],
      );
      await client.query('reset role');

      expect(shipped.rows).toEqual([expect.objectContaining({ completes_order: true, order_status: 'shipped' })]);
      expect(cancelled.rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);

      // ほかの理由で発送済みから決済完了へ戻すことはできない
      await client.query('savepoint direct_unship');
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      await expect(
        client.query(
          `update public.orders
           set status = 'paid'::public.order_status, shipped_at = null, shipping_carrier = null, tracking_number = null
           where id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_TRANSITION_NOT_ALLOWED') });
      await client.query('rollback to savepoint direct_unship');
    } finally {
      await client.query('rollback');
    }
  });
```

- [ ] **Step 10: 要対応と照合の試験を直す**

(a) `tests/integration/db/payment_exceptions.integration.test.ts` の `test('支払額の違いの要対応が開いている注文は発送できず、解決すると発送できる', …)` を丸ごと次に置き換える:

```ts
  test('支払額の違いの要対応が開いている注文は発送できず、解決すると発送できる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId, orderItemId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'paid_amount_mismatch', orderId });
    const ship = () => db().query(
      `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', '1234-5678', false, $3::jsonb)`,
      [orderId, ACTOR, JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }])],
    );

    await expect(ship()).rejects.toMatchObject({ code: '22023', message: 'PAYMENT_REVIEW_REQUIRED' });
    await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)', [id, ACTOR, '差額を返金']);
    expect((await ship()).rows).toEqual([expect.objectContaining({ completes_order: true, order_status: 'shipped' })]);
  });
```

(b) `tests/integration/db/reconciler_composed.integration.test.ts` の `describe('実行者を使う流れ（発送の停止・取消）', …)` の中:

- 次の部分:

```ts
    const shipPaidOrder = (orderId: string) =>
      db().query(`select id from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678', false)`, [orderId, ACTOR]);
```

を次に置き換える:

```ts
    /** 注文の全部の商品を1回で送る（グループ E-1 の発送の関数） */
    const shipPaidOrder = async (orderId: string) => {
      const items = await db().query('select id, quantity from public.order_items where order_id = $1 order by id', [orderId]);
      return db().query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', '1234-5678', false, $3::jsonb)`,
        [orderId, ACTOR, JSON.stringify(items.rows.map((row) => ({ order_item_id: row.id, quantity: row.quantity })))],
      );
    };
```

- 2か所の `expect((await shipPaidOrder(orderId)).rowCount).toBe(0);` を、どちらも次に置き換える（前の関数は0行を返し、新しい関数は断る）:

```ts
      await expect(shipPaidOrder(orderId)).rejects.toMatchObject({ code: '22023', message: 'PAYMENT_REVIEW_REQUIRED' });
```

- `// 対照: 解決すれば発送できる。さっきの0件は、要対応が開いていたからである（配送先などほかの理由ではない）` を `// 対照: 解決すれば発送できる。さっきの断りは、要対応が開いていたからである（配送先などほかの理由ではない）` に置き換える（`expect((await shipPaidOrder(orderId)).rowCount).toBe(1);` はそのまま）

- [ ] **Step 11: 受注の集計の試験を新しい関数に替える**

`tests/integration/db/order_items_variant.integration.test.ts` の `test('受注の集計ビューが backorder の数量だけを合計する', …)` の中の、問い合わせと期待:

```ts
      const res = await client.query(
        `SELECT backorder_quantity FROM public.variant_backorder_summary WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows[0].backorder_quantity).toBe(2);
```

を次に置き換え、試験の名前を `'受注生産の数は backorder の数量だけを数える（グループ E-1 で view から関数に替えた）'` にする:

```ts
      // 注文は既定の状態（未決済）。未決済と決済完了の、まだ仕上がっていない受注生産の数を数える
      const res = await client.query(
        'SELECT backorder FROM public.list_variant_stock_states($1::bigint[])',
        [[variantId]],
      );
      expect(res.rows[0].backorder).toBe(2);
```

- [ ] **Step 12: 保留の守りの SQL と単体テストを直す（本計画 P14。当てない）**

(a) `tests/unit/migrations/order-state-transition-hardening.test.ts` の `it('revokes direct updates and installs payment-state invariants', …)` の最後の `expect` の後に足す:

```ts
    // 発送の取消で未発送の品が戻った注文だけ、発送済みから決済完了へ戻せる（グループ E-1 設計書 7-3・12-3）
    expect(sql).toContain("(OLD.status = 'shipped' AND NEW.status = 'paid'");
    expect(sql).toContain("pg_catalog.current_setting('app.order_change_reason', true) = 'admin_cancel_fulfillment'");
```

(b) 同じファイルの `const HARDENING_PATH = …;` の後に足す:

```ts
const FULFILLMENT_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261010120100_fulfillment_order_emails.sql',
);
```

(c) 同じファイルの最後の `});` の前に足す:

```ts
  it('replaces the ship RPC with service-role-only fulfillment RPCs that record the change reason', () => {
    const sql = fs.readFileSync(FULFILLMENT_PATH, 'utf8');

    for (const name of ['admin_create_fulfillment', 'admin_cancel_fulfillment']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`, 'i'));
      const body = sql.split(`CREATE OR REPLACE FUNCTION public.${name}(`)[1]?.split('$$;')[0];
      expect(body).toBeDefined();
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path = ''");
      expect(body).toContain(`'app.order_change_reason', '${name}'`);
    }
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text, boolean);');
  });
```

Run: `npx jest tests/unit/migrations/order-state-transition-hardening.test.ts --runInBand`
Expected: FAIL（`(OLD.status = 'shipped' AND NEW.status = 'paid'` が無い）

(d) `supabase/pending/harden_order_state_transitions.sql` の状態の移り方の表（コメントの行から `) THEN` まで）を次に置き換える:

```sql
  -- 設計書 4-1 の表に無い遷移は拒否する（取消の注文の復元は、全額返金の失敗で入金済み・発送済みへ戻すため。
  -- 発送済みから入金済みへは、発送の取消で未発送の品が戻った時だけ。グループ E-1 設計書 7-3）
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'payment_in_progress' AND NEW.status IN ('paid', 'pending', 'failed', 'abandoned', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
    OR (OLD.status = 'failed' AND NEW.status IN ('paid', 'cancelled'))
    OR (OLD.status = 'paid' AND NEW.status IN ('shipped', 'cancelled'))
    OR (OLD.status = 'shipped' AND NEW.status = 'cancelled')
    OR (OLD.status = 'shipped' AND NEW.status = 'paid'
        AND pg_catalog.current_setting('app.order_change_reason', true) = 'admin_cancel_fulfillment')
    OR (OLD.status = 'cancelled' AND NEW.status IN ('paid', 'shipped'))
  ) THEN
```

Run: `npx jest tests/unit/migrations/order-state-transition-hardening.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts --runInBand`
Expected: PASS

- [ ] **Step 13: DB の結合テストを全部流す**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンド（`npx jest tests/integration/db --runInBand`）
Expected: PASS（全部）。`order_state_transition_hardening` の試験が保留の守りを手元の DB に当てるので、その前後どちらで動いても通ることを、この全体の実行で確かめる（本計画 P15）。終わったら `npx supabase db reset` で手元の DB を作り直す

- [ ] **Step 14: 型と lint**

Run: `npx tsc --noEmit` と `npx eslint src/lib/orders/email/order-email-types.ts tests/unit/lib/orders/email/order-email-types.test.ts tests/unit/migrations/order-state-transition-hardening.test.ts tests/integration/db/fulfillment_order_emails.integration.test.ts tests/integration/db/order_email_enqueue.integration.test.ts tests/integration/db/order_email_outbox.integration.test.ts tests/integration/db/order_state_transition_hardening.integration.test.ts tests/integration/db/payment_exceptions.integration.test.ts tests/integration/db/reconciler_composed.integration.test.ts tests/integration/db/order_items_variant.integration.test.ts tests/integration/db/order_fulfillments.integration.test.ts`
Expected: 誤り0件。前の発送の関数と view を使う窓口（`src/app/api/admin/orders/[id]/status/route.ts`・`src/app/api/admin/items/[id]/variants/route.ts`）は、名前を文字列で渡すので型の誤りにならない。手元で動かすとその2つの操作は失敗するが、Task 5・Task 9 で直す（本計画 P16）

- [ ] **Step 15: コミット**

```bash
git add supabase/migrations/20261010120100_fulfillment_order_emails.sql tests/integration/db/fulfillment_order_emails.integration.test.ts tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/order_email_enqueue.integration.test.ts tests/integration/db/order_email_outbox.integration.test.ts tests/integration/db/order_state_transition_hardening.integration.test.ts tests/integration/db/payment_exceptions.integration.test.ts tests/integration/db/reconciler_composed.integration.test.ts tests/integration/db/order_items_variant.integration.test.ts supabase/pending/harden_order_state_transitions.sql tests/unit/migrations/order-state-transition-hardening.test.ts src/lib/orders/email/order-email-types.ts tests/unit/lib/orders/email/order-email-types.test.ts
git commit -m "$(cat <<'EOF'
feat(orders): 発送を1回ごとの記録にし、発送のメールを発送ごとに送る（グループ E-1 の移行 B）

発送の関数と発送の取消の関数を足し、注文のメールの表に発送の番号を持たせた。
全部を送った発送で注文を発送済みにし、取消で未発送が戻ったら決済完了に戻す。
前の発送の関数と受注の集計の view を消し、保留の守りに発送の取消の移り方を足した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 注文の言葉と発送の部品（TS の土台）

**Files:**
- Create: `src/lib/orders/order-progress.ts`（注文の言葉・一部発送済み・進み具合の段。画面からも使う）
- Create: `src/lib/orders/fulfillment/fulfillment-types.ts`（窓口の形・誤りの記号・最初の数の決め方。画面からも使う）
- Create: `src/lib/orders/fulfillment/fulfillment-messages.ts`（誤りの記号ごとの言葉と HTTP。画面からも使う）
- Create: `src/lib/orders/fulfillment/fulfillment-store.ts`（DB の関数の呼び出しと誤りの直し。サーバーだけ）
- Create: `src/lib/orders/fulfillment/fulfillment-materials.ts`（発送の画面の材料の組み立て。サーバーだけ）
- Test（すべて新規）: `tests/unit/lib/orders/order-progress.test.ts`・`tests/unit/lib/orders/fulfillment/fulfillment-types.test.ts`・`tests/unit/lib/orders/fulfillment/fulfillment-messages.test.ts`・`tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts`・`tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts`

**Interfaces:**
- Consumes:
  - 既存: `OrderStatus`・`ORDER_STATUSES`（`src/lib/orders/order-payment-types.ts`）、`ShippingCarrierId`（`src/lib/orders/shipping-carriers.ts`）、`findMissingShippingFields`（`src/features/checkout/services/checkout-draft.service.ts`）、`toOrderNumber`（`src/lib/orders/order-number.ts`）
  - Task 1・2 の DB の関数（`admin_create_fulfillment`・`admin_cancel_fulfillment`・`admin_record_completion`・`admin_cancel_completion`・`list_order_fulfillments`・`list_order_completions`・`list_order_line_fulfillment`）。引数名と答えの列は共通の約束 C-1 のとおり
- Produces（名前・引数・型は共通の約束 C-2 のとおり。ここに無い物は、この Task が足した物）:
  - `order-progress.ts`: `ORDER_PROGRESS_KEYS`・`ORDER_PROGRESS_LABELS`・`PARTIALLY_SHIPPED_LABEL`・`ORDER_PROGRESS_STEP_LABELS`・型 `OrderProgressKey`・`OrderProgressLabel`・`OrderLineProgressCounts`・`OrderProgress`・`OrderProgressStepKey`・`OrderProgressStep`・関数 `deriveOrderProgress`・`buildOrderProgressSteps`
  - `fulfillment-types.ts`: 窓口の型一式・`FULFILLMENT_ERROR_CODES`・型 `FulfillmentErrorCode`・`FulfillmentErrorResponse`・関数 `initialShipQuantities`・`totalQuantity`
  - `fulfillment-messages.ts`: `FULFILLMENT_ERROR_MESSAGES`（記号 → `{ status, message }`。共通の約束の表の「HTTP」と「言葉」）、`INVALID_REQUEST_MESSAGE`・`INVALID_REQUEST_BODY`、`FULFILLMENT_FAILURE_MESSAGES`（`create`・`cancel`・`completion`・`completion_cancel`・`materials`）、`UNKNOWN_OUTCOME_MESSAGE`、関数 `fulfillmentErrorBody(code)`・`fulfillmentFailureBody(kind)`
  - `fulfillment-store.ts`: `FulfillmentStore`・`FulfillmentOperationError`・`FulfillmentStoreError`・`toFulfillmentErrorCode`・`listOrderLineFulfillment`・`createFulfillment`・`cancelFulfillment`・`recordCompletion`・`cancelCompletion`・`listOrderFulfillments`・`listOrderCompletions`・型 `OrderLineFulfillmentRow`・`OrderFulfillmentHistoryRow`・`OrderCompletionHistoryRow`
  - `fulfillment-materials.ts`: `loadFulfillmentMaterials(client, orderId)`

決め事（本計画 P3・P7 の続き。共通の約束に書いていない所）:
- `listOrderLineFulfillment` が返す Map は、渡した注文の番号を全部キーに持つ。商品の行が無い注文は空の配列（呼ぶ側が `?? []` を書かなくてよい）。同じ番号が2回あっても1回として数える。
- `FulfillmentStoreError` は、どの呼び出しか（`operation`）と DB の記号（`code`）を持ち、DB の文は `cause` にだけ残す。窓口のログには `name` と `code` だけを出す（DB の文に宛先などが混ざりうるため）。
- `fulfillment-messages.ts` に、発送の材料を読めなかった時の言葉 `発送の材料を読み込めませんでした。`（`FULFILLMENT_FAILURE_MESSAGES.materials`）を足す。共通の約束の失敗の言葉は書く窓口の4つだけで、材料を読む窓口（GET）の分が無いため。
- 材料の商品の並びは、注文の商品の登録順（`created_at`、同じ時刻は `id`）にそろえる。読むたびに並びが入れ替わると、発送の画面の入力が動いて見えるため。

このタスクの試験が確かめる Review Focus: 1（別の人が先に同じ品を発送した時の `QUANTITY_EXCEEDS_READY` を、記号 `quantity_exceeds_ready` に直す）、2（同じ重複防止キーの送り直しの答え `replayed: true` を、発送と仕上がりの両方で読む）、4（送った数を下回る仕上がりの取消の断り `COMPLETION_ALREADY_SHIPPED` を、記号 `completion_already_shipped` に直す）。

- [ ] **Step 1: 注文の言葉と進み具合の試験を書く**

`tests/unit/lib/orders/order-progress.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOrderProgressSteps,
  deriveOrderProgress,
  ORDER_PROGRESS_KEYS,
  ORDER_PROGRESS_LABELS,
  ORDER_PROGRESS_STEP_LABELS,
  PARTIALLY_SHIPPED_LABEL,
  type OrderLineProgressCounts,
  type OrderProgress,
} from '@/lib/orders/order-progress';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';

function line(overrides: Partial<OrderLineProgressCounts> = {}): OrderLineProgressCounts {
  return { fulfillmentType: 'stock', quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides };
}

/** 在庫の品。2つとも発送準備中 */
const STOCK_READY = line();
/** 在庫の品。2つとも送った */
const STOCK_SHIPPED = line({ shipped: 2, readyUnshipped: 0, unshipped: 0 });
/** 受注生産の品。2つとも作っている途中 */
const BACKORDER_IN_PRODUCTION = line({ fulfillmentType: 'backorder', inProduction: 2, readyUnshipped: 0 });
/** 受注生産の品。仕上がって、まだ送っていない */
const BACKORDER_READY = line({ fulfillmentType: 'backorder' });
/** 受注生産の品。仕上がって、送った */
const BACKORDER_SHIPPED = line({ fulfillmentType: 'backorder', shipped: 2, readyUnshipped: 0, unshipped: 0 });

describe('注文の言葉と印', () => {
  it('9つの言葉・一部発送済みの印・進み具合の段の名前は設計書のとおり', () => {
    expect(ORDER_PROGRESS_LABELS).toEqual({
      payment_in_progress: '支払い手続き中',
      unpaid: '未決済',
      in_production: '受注生産中',
      ready: '発送準備中',
      in_transit: '配送中',
      delivered: '配達済み',
      failed: '決済失敗',
      abandoned: '放棄',
      cancelled: 'キャンセル',
    });
    expect(Object.keys(ORDER_PROGRESS_LABELS)).toEqual([...ORDER_PROGRESS_KEYS]);
    expect(PARTIALLY_SHIPPED_LABEL).toBe('一部発送済み');
    expect(ORDER_PROGRESS_STEP_LABELS).toEqual({
      payment: 'お支払い',
      in_production: '受注生産中',
      ready: '発送準備中',
      in_transit: '配送中',
      delivered: '配達済み',
    });
  });
});

describe('deriveOrderProgress', () => {
  it.each([
    ['payment_in_progress', 'payment_in_progress', '支払い手続き中'],
    ['pending', 'unpaid', '未決済'],
    ['failed', 'failed', '決済失敗'],
    ['abandoned', 'abandoned', '放棄'],
    ['cancelled', 'cancelled', 'キャンセル'],
  ] as const)('%s の注文は、商品の数に関係なく %s（%s）。一部発送済みの印は付かない', (status, key, label) => {
    const someShipped = [line({ shipped: 1, readyUnshipped: 1, unshipped: 1 }), BACKORDER_IN_PRODUCTION];

    expect(deriveOrderProgress(status, someShipped)).toEqual({ key, label, partiallyShipped: false });
  });

  it.each([
    ['在庫の品だけ・入金したところ', 'paid', [STOCK_READY], 'ready', '発送準備中', false],
    ['在庫の品だけ・全部送った', 'shipped', [STOCK_SHIPPED], 'in_transit', '配送中', false],
    ['在庫の品が2行・1行を送った', 'paid', [STOCK_READY, STOCK_SHIPPED], 'ready', '発送準備中', true],
    ['受注生産の品だけ・作っている途中', 'paid', [BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', false],
    ['受注生産の品だけ・仕上がった', 'paid', [BACKORDER_READY], 'ready', '発送準備中', false],
    ['在庫の品と受注生産の品・入金したところ', 'paid', [STOCK_READY, BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', false],
    ['在庫の品を先に送った', 'paid', [STOCK_SHIPPED, BACKORDER_IN_PRODUCTION], 'in_production', '受注生産中', true],
    ['受注生産の品が仕上がった（在庫の品は送り済み）', 'paid', [STOCK_SHIPPED, BACKORDER_READY], 'ready', '発送準備中', true],
    ['在庫の品と受注生産の品を全部送った', 'shipped', [STOCK_SHIPPED, BACKORDER_SHIPPED], 'in_transit', '配送中', false],
    ['商品が全部送り済みなら、状態が paid でも配送中', 'paid', [STOCK_SHIPPED], 'in_transit', '配送中', false],
    ['商品の行が無い異常な注文は発送準備中', 'paid', [], 'ready', '発送準備中', false],
    ['商品の行が無い異常な発送済みも発送準備中', 'shipped', [], 'ready', '発送準備中', false],
  ] as const)('%s → %s', (_name, status, lines, key, label, partiallyShipped) => {
    expect(deriveOrderProgress(status, lines)).toEqual({ key, label, partiallyShipped });
  });

  it('どの注文の状態でも例外を投げない', () => {
    for (const status of ORDER_STATUSES) {
      expect(() => deriveOrderProgress(status, [STOCK_READY, BACKORDER_IN_PRODUCTION])).not.toThrow();
    }
  });
});

describe('buildOrderProgressSteps', () => {
  const stepsOf = (status: (typeof ORDER_STATUSES)[number], lines: readonly OrderLineProgressCounts[]) =>
    buildOrderProgressSteps(deriveOrderProgress(status, lines), lines);
  const view = (steps: ReturnType<typeof buildOrderProgressSteps>) => steps?.map((step) => `${step.label}:${step.state}`);

  it.each([
    ['支払い手続き中', 'payment_in_progress'],
    ['決済失敗', 'failed'],
    ['放棄', 'abandoned'],
    ['キャンセル', 'cancelled'],
  ] as const)('%s の注文には段を出さない（null）', (_name, status) => {
    expect(stepsOf(status, [STOCK_READY, BACKORDER_IN_PRODUCTION])).toBeNull();
  });

  it('在庫の品だけの注文は4段。未決済の間は「お支払い」が今の段', () => {
    expect(view(stepsOf('pending', [STOCK_READY]))).toEqual(['お支払い:current', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('paid', [STOCK_READY]))).toEqual(['お支払い:done', '発送準備中:current', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('shipped', [STOCK_SHIPPED]))).toEqual(['お支払い:done', '発送準備中:done', '配送中:current', '配達済み:todo']);
  });

  it('受注生産の品を含む注文は5段。今の段は、いちばん手前の商品の段階で決まる', () => {
    const mixed = [STOCK_READY, BACKORDER_IN_PRODUCTION];

    expect(view(stepsOf('pending', mixed))).toEqual(['お支払い:current', '受注生産中:todo', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    expect(view(stepsOf('paid', mixed))).toEqual(['お支払い:done', '受注生産中:current', '発送準備中:todo', '配送中:todo', '配達済み:todo']);
    // 在庫の品を先に送っても、受注生産の品が作っている途中なら「受注生産中」のまま
    expect(view(stepsOf('paid', [STOCK_SHIPPED, BACKORDER_IN_PRODUCTION]))).toEqual([
      'お支払い:done', '受注生産中:current', '発送準備中:todo', '配送中:todo', '配達済み:todo',
    ]);
    expect(view(stepsOf('paid', [STOCK_SHIPPED, BACKORDER_READY]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:current', '配送中:todo', '配達済み:todo',
    ]);
    expect(view(stepsOf('shipped', [STOCK_SHIPPED, BACKORDER_SHIPPED]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:done', '配送中:current', '配達済み:todo',
    ]);
  });

  it('段の記号は 支払い → 受注生産中 → 発送準備中 → 配送中 → 配達済み の順', () => {
    expect(stepsOf('paid', [BACKORDER_IN_PRODUCTION])?.map((step) => step.key)).toEqual([
      'payment', 'in_production', 'ready', 'in_transit', 'delivered',
    ]);
    expect(stepsOf('paid', [STOCK_READY])?.map((step) => step.key)).toEqual(['payment', 'ready', 'in_transit', 'delivered']);
  });

  it('配達済みは、4段でも5段でも全部の段が済み（E-4 で配達の状況が入るまで、窓口は出さない言葉）', () => {
    const delivered: OrderProgress = { key: 'delivered', label: '配達済み', partiallyShipped: false };

    expect(view(buildOrderProgressSteps(delivered, [STOCK_SHIPPED]))).toEqual(['お支払い:done', '発送準備中:done', '配送中:done', '配達済み:done']);
    expect(view(buildOrderProgressSteps(delivered, [STOCK_SHIPPED, BACKORDER_SHIPPED]))).toEqual([
      'お支払い:done', '受注生産中:done', '発送準備中:done', '配送中:done', '配達済み:done',
    ]);
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/order-progress.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/order-payment-types']);
    expect(source).toMatch(/import type \{ OrderStatus \} from/);
  });
});
```

Run: `npx jest tests/unit/lib/orders/order-progress.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/order-progress'`）

- [ ] **Step 2: 注文の言葉と進み具合を書く**

`src/lib/orders/order-progress.ts`:

```ts
import type { OrderStatus } from '@/lib/orders/order-payment-types';

/**
 * 注文の言葉と進み具合の段（グループ E-1 設計書 4 章）。管理画面・お客様の画面・窓口が同じ言葉を出すので、
 * 画面からも読む。サーバーだけの物を import しない。
 * DB の注文の状態（order_status）は変えず、商品ごとの数から言葉を出す。
 */
export const ORDER_PROGRESS_KEYS = [
  'payment_in_progress',
  'unpaid',
  'in_production',
  'ready',
  'in_transit',
  'delivered',
  'failed',
  'abandoned',
  'cancelled',
] as const;
export type OrderProgressKey = (typeof ORDER_PROGRESS_KEYS)[number];

export const ORDER_PROGRESS_LABELS = {
  payment_in_progress: '支払い手続き中',
  unpaid: '未決済',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
} as const satisfies Record<OrderProgressKey, string>;
export type OrderProgressLabel = (typeof ORDER_PROGRESS_LABELS)[OrderProgressKey];

/** 発送した数が1以上で、未発送の数も1以上の注文に付ける印 */
export const PARTIALLY_SHIPPED_LABEL = '一部発送済み';

/** 商品の行ごとの数（DB の private.order_line_fulfillment の列）。fulfillmentType は stock か backorder */
export type OrderLineProgressCounts = {
  fulfillmentType: string;
  quantity: number;
  shipped: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

export type OrderProgress = { key: OrderProgressKey; label: OrderProgressLabel; partiallyShipped: boolean };

/** 商品の数を見ずに決まる言葉。paid・shipped は商品の数で決めるので入れない */
const FIXED_PROGRESS_KEYS: Record<Exclude<OrderStatus, 'paid' | 'shipped'>, OrderProgressKey> = {
  payment_in_progress: 'payment_in_progress',
  pending: 'unpaid',
  failed: 'failed',
  abandoned: 'abandoned',
  cancelled: 'cancelled',
};

function sumOf(lines: readonly OrderLineProgressCounts[], pick: (line: OrderLineProgressCounts) => number): number {
  return lines.reduce((total, line) => total + pick(line), 0);
}

/**
 * 注文の言葉。paid・shipped は、商品の段階のうちいちばん手前（受注生産中 → 発送準備中 → 配送中）にそろえる。
 * 配達済みは配送の状況を持つ E-4 から。E-1 では、発送した品は全部「配送中」になる。
 */
export function deriveOrderProgress(status: OrderStatus, lines: readonly OrderLineProgressCounts[]): OrderProgress {
  if (status !== 'paid' && status !== 'shipped') {
    const key = FIXED_PROGRESS_KEYS[status];
    return { key, label: ORDER_PROGRESS_LABELS[key], partiallyShipped: false };
  }

  const shipped = sumOf(lines, (line) => line.shipped);
  let key: OrderProgressKey = 'ready';
  if (sumOf(lines, (line) => line.inProduction) > 0) {
    key = 'in_production';
  } else if (sumOf(lines, (line) => line.readyUnshipped) > 0) {
    key = 'ready';
  } else if (shipped > 0) {
    key = 'in_transit';
  }
  return {
    key,
    label: ORDER_PROGRESS_LABELS[key],
    partiallyShipped: shipped > 0 && sumOf(lines, (line) => line.unshipped) > 0,
  };
}

export type OrderProgressStepKey = 'payment' | 'in_production' | 'ready' | 'in_transit' | 'delivered';

export const ORDER_PROGRESS_STEP_LABELS = {
  payment: 'お支払い',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
} as const satisfies Record<OrderProgressStepKey, string>;

export type OrderProgressStep = { key: OrderProgressStepKey; label: string; state: 'done' | 'current' | 'todo' };

/** 言葉の記号 → 今いる段。段を出さない言葉（支払い手続き中・決済失敗・放棄・キャンセル）は入れない */
const CURRENT_STEP_KEYS: Partial<Record<OrderProgressKey, OrderProgressStepKey>> = {
  unpaid: 'payment',
  in_production: 'in_production',
  ready: 'ready',
  in_transit: 'in_transit',
  delivered: 'delivered',
};

/**
 * お客様の注文の画面の進み具合の段。受注生産の品を含む注文だけ「受注生産中」の段が入る（5段）。
 * 支払い手続き中・決済失敗・放棄・キャンセルは null（段を出さない）。
 */
export function buildOrderProgressSteps(
  progress: OrderProgress,
  lines: readonly OrderLineProgressCounts[],
): OrderProgressStep[] | null {
  const current = CURRENT_STEP_KEYS[progress.key];
  if (!current) {
    return null;
  }

  const keys: OrderProgressStepKey[] = ['payment'];
  if (lines.some((line) => line.fulfillmentType === 'backorder')) {
    keys.push('in_production');
  }
  keys.push('ready', 'in_transit', 'delivered');

  const currentIndex = keys.indexOf(current);
  return keys.map((key, index): OrderProgressStep => ({
    key,
    label: ORDER_PROGRESS_STEP_LABELS[key],
    // 配達済みは最後の段。届いたら、全部の段が済んだことにする
    state: current === 'delivered' || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo',
  }));
}
```

Run: `npx jest tests/unit/lib/orders/order-progress.test.ts --runInBand`
Expected: PASS

- [ ] **Step 3: 発送の型と最初の数の試験を書く**

`tests/unit/lib/orders/fulfillment/fulfillment-types.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  FULFILLMENT_ERROR_CODES,
  initialShipQuantities,
  totalQuantity,
  type FulfillmentMaterialLine,
} from '@/lib/orders/fulfillment/fulfillment-types';

function materialLine(overrides: Partial<FulfillmentMaterialLine> = {}): FulfillmentMaterialLine {
  return {
    orderItemId: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
    quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides,
  };
}

describe('initialShipQuantities（発送の画面の最初の数）', () => {
  it('未発送の商品ごとに、発送準備中の数の全部を入れる', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'a', quantity: 3, shipped: 1, readyUnshipped: 2, unshipped: 2 }),
      materialLine({ orderItemId: 'b', quantity: 1, readyUnshipped: 1, unshipped: 1 }),
    ])).toEqual({ a: 2, b: 1 });
  });

  it('受注生産中の数は入れない。発送準備中が0の商品も、0で並べる（入力の欄が要るため）', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'made', fulfillmentType: 'backorder', quantity: 3, inProduction: 2, readyUnshipped: 1, unshipped: 3 }),
      materialLine({ orderItemId: 'wip', fulfillmentType: 'backorder', quantity: 2, inProduction: 2, readyUnshipped: 0, unshipped: 2 }),
    ])).toEqual({ made: 1, wip: 0 });
  });

  it('全部送った商品は並べない。商品が無ければ空', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'done', shipped: 2, readyUnshipped: 0, unshipped: 0 }),
      materialLine({ orderItemId: 'left', shipped: 1, readyUnshipped: 1, unshipped: 1 }),
    ])).toEqual({ left: 1 });
    expect(initialShipQuantities([])).toEqual({});
  });
});

describe('totalQuantity', () => {
  it('入れた数の合計を返す。0だけ・空は0', () => {
    expect(totalQuantity({ a: 2, b: 1, c: 0 })).toBe(3);
    expect(totalQuantity({ a: 0 })).toBe(0);
    expect(totalQuantity({})).toBe(0);
  });
});

describe('誤りの記号', () => {
  it('窓口が返す14の記号は共通の約束のとおり', () => {
    expect([...FULFILLMENT_ERROR_CODES]).toEqual([
      'order_not_found', 'not_shippable', 'address_incomplete', 'payment_review_required', 'quantity_exceeds_ready',
      'fulfillment_request_mismatch', 'invalid_argument', 'fulfillment_not_found', 'fulfillment_cancel_not_allowed',
      'not_in_production', 'quantity_exceeds_in_production', 'completion_request_mismatch', 'completion_not_found',
      'completion_already_shipped',
    ]);
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/fulfillment/fulfillment-types.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual([
      '@/lib/orders/order-payment-types',
      '@/lib/orders/order-progress',
      '@/lib/orders/shipping-carriers',
    ]);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-types.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/fulfillment/fulfillment-types'`）

- [ ] **Step 4: 発送の型と最初の数を書く**

`src/lib/orders/fulfillment/fulfillment-types.ts`:

```ts
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';

/**
 * 発送と仕上がりの窓口の形と誤りの記号（グループ E-1 設計書 3〜7 章）。窓口・DB の呼び出し・画面が同じ型を使うので、
 * 画面からも読む。サーバーだけの物を import しない。
 */
export type FulfillmentLineQuantity = { orderItemId: string; quantity: number };

export type FulfillmentMaterialLine = {
  orderItemId: string;
  name: string;
  color: string | null;
  size: string | null;
  fulfillmentType: 'stock' | 'backorder';
  quantity: number;
  shipped: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

export type FulfillmentRecordSummary = {
  id: string;
  number: number;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: string;
  notifyCustomer: boolean;
  completesOrder: boolean;
  cancelledAt: string | null;
  lines: FulfillmentLineQuantity[];
};

export type FulfillmentBlockedReason = 'not_shippable' | 'address_incomplete' | 'payment_review_required';

export type FulfillmentMaterials = {
  order: { id: string; orderNumber: string; status: OrderStatus; progress: OrderProgress };
  blockedReason: FulfillmentBlockedReason | null;
  lines: FulfillmentMaterialLine[];
  fulfillments: FulfillmentRecordSummary[];
};

export type CreateFulfillmentRequest = {
  requestKey: string;
  carrier: ShippingCarrierId;
  trackingNumber: string;
  notifyCustomer: boolean;
  lines: FulfillmentLineQuantity[];
};

export type CreateFulfillmentResponse = {
  fulfillmentId: string;
  number: number;
  completesOrder: boolean;
  orderStatus: OrderStatus;
  replayed: boolean;
};

export type CancelFulfillmentResponse = { outcome: 'cancelled' | 'already_cancelled'; orderStatus: OrderStatus };

export type RecordCompletionRequest = { requestKey: string; lines: FulfillmentLineQuantity[] };

export type RecordCompletionResponse = { completionIds: string[]; replayed: boolean };

export type CancelCompletionResponse = { outcome: 'cancelled' | 'already_cancelled' };

export const FULFILLMENT_ERROR_CODES = [
  'order_not_found',
  'not_shippable',
  'address_incomplete',
  'payment_review_required',
  'quantity_exceeds_ready',
  'fulfillment_request_mismatch',
  'invalid_argument',
  'fulfillment_not_found',
  'fulfillment_cancel_not_allowed',
  'not_in_production',
  'quantity_exceeds_in_production',
  'completion_request_mismatch',
  'completion_not_found',
  'completion_already_shipped',
] as const;
export type FulfillmentErrorCode = (typeof FULFILLMENT_ERROR_CODES)[number];

export type FulfillmentErrorResponse = { error: string; code: FulfillmentErrorCode | 'invalid_request' | 'failed' };

/** 発送の画面の最初の数: 未発送が1以上の商品ごとに、発送準備中の数の全部（受注生産中は入らない） */
export function initialShipQuantities(lines: readonly FulfillmentMaterialLine[]): Record<string, number> {
  const quantities: Record<string, number> = {};
  for (const line of lines) {
    if (line.unshipped >= 1) {
      quantities[line.orderItemId] = line.readyUnshipped;
    }
  }
  return quantities;
}

/** 入れた数の合計 */
export function totalQuantity(quantities: Record<string, number>): number {
  return Object.values(quantities).reduce((total, quantity) => total + quantity, 0);
}
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-types.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: 誤りの言葉の試験を書く**

`tests/unit/lib/orders/fulfillment/fulfillment-messages.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  FULFILLMENT_ERROR_MESSAGES,
  FULFILLMENT_FAILURE_MESSAGES,
  INVALID_REQUEST_BODY,
  INVALID_REQUEST_MESSAGE,
  UNKNOWN_OUTCOME_MESSAGE,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import { FULFILLMENT_ERROR_CODES } from '@/lib/orders/fulfillment/fulfillment-types';

// 共通の約束 C-2 の表。言葉を直す時は、画面と文書の言葉も一緒に直すため、ここは1字も変えずに写す
const EXPECTED = [
  ['order_not_found', 404, '注文が見つかりません。'],
  ['not_shippable', 409, '発送できる状態ではありません。一覧を更新してください。'],
  ['address_incomplete', 409, '配送先の必須項目が足りないため発送できません。'],
  ['payment_review_required', 409, '支払額の確認（要対応）が済むまで発送できません。'],
  ['quantity_exceeds_ready', 409, '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
  ['fulfillment_request_mismatch', 409, '前の発送と内容が違います。画面を開き直してください。'],
  ['invalid_argument', 400, '入力を確かめてください。'],
  ['fulfillment_not_found', 404, '発送の記録が見つかりません。'],
  ['fulfillment_cancel_not_allowed', 409, 'この発送は取り消せません。注文の状態を確かめてください。'],
  ['not_in_production', 409, '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
  ['quantity_exceeds_in_production', 409, '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
  ['completion_request_mismatch', 409, '前の記録と内容が違います。画面を開き直してください。'],
  ['completion_not_found', 404, '仕上がりの記録が見つかりません。'],
  ['completion_already_shipped', 409, 'もう発送した数があるため、取り消せません。'],
] as const;

describe('誤りの記号ごとの HTTP と言葉', () => {
  it.each(EXPECTED)('%s は %i、言葉は「%s」', (code, status, message) => {
    expect(FULFILLMENT_ERROR_MESSAGES[code]).toEqual({ status, message });
    expect(fulfillmentErrorBody(code)).toEqual({ error: message, code });
  });

  it('表は誤りの記号を過不足なく持つ（記号を足したら言葉と HTTP も要る）', () => {
    const codes = [...FULFILLMENT_ERROR_CODES].sort();

    expect(EXPECTED.map(([code]) => code).sort()).toEqual(codes);
    expect(Object.keys(FULFILLMENT_ERROR_MESSAGES).sort()).toEqual(codes);
  });
});

describe('入力の誤り・失敗・答えが分からない時の言葉', () => {
  it('入力の誤りは 400 の窓口で、記号は invalid_request', () => {
    expect(INVALID_REQUEST_MESSAGE).toBe('入力を確かめてください。');
    expect(INVALID_REQUEST_BODY).toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
  });

  it('失敗（500）の言葉は窓口ごとに違い、記号は failed', () => {
    expect(FULFILLMENT_FAILURE_MESSAGES).toEqual({
      create: '発送の記録に失敗しました。',
      cancel: '発送の取消に失敗しました。',
      completion: '仕上がりの記録に失敗しました。',
      completion_cancel: '仕上がりの取消に失敗しました。',
      materials: '発送の材料を読み込めませんでした。',
    });
    expect(fulfillmentFailureBody('cancel')).toEqual({ error: '発送の取消に失敗しました。', code: 'failed' });
  });

  it('答えが分からない時の言葉は Global Constraints のとおり', () => {
    expect(UNKNOWN_OUTCOME_MESSAGE).toBe('結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。');
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/fulfillment/fulfillment-messages.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/fulfillment/fulfillment-types']);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-messages.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/fulfillment/fulfillment-messages'`）

- [ ] **Step 6: 誤りの言葉を書く**

`src/lib/orders/fulfillment/fulfillment-messages.ts`:

```ts
import type { FulfillmentErrorCode, FulfillmentErrorResponse } from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 発送と仕上がりの窓口の誤りの言葉と HTTP（グループ E-1 設計書 5-2・6-2・7-2）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。画面に出す言葉は、ここの1か所だけで持つ。
 */
export const FULFILLMENT_ERROR_MESSAGES = {
  order_not_found: { status: 404, message: '注文が見つかりません。' },
  not_shippable: { status: 409, message: '発送できる状態ではありません。一覧を更新してください。' },
  address_incomplete: { status: 409, message: '配送先の必須項目が足りないため発送できません。' },
  payment_review_required: { status: 409, message: '支払額の確認（要対応）が済むまで発送できません。' },
  quantity_exceeds_ready: {
    status: 409,
    message: '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。',
  },
  fulfillment_request_mismatch: { status: 409, message: '前の発送と内容が違います。画面を開き直してください。' },
  invalid_argument: { status: 400, message: '入力を確かめてください。' },
  fulfillment_not_found: { status: 404, message: '発送の記録が見つかりません。' },
  fulfillment_cancel_not_allowed: { status: 409, message: 'この発送は取り消せません。注文の状態を確かめてください。' },
  not_in_production: { status: 409, message: '仕上がりを記録できる状態ではありません。一覧を更新してください。' },
  quantity_exceeds_in_production: { status: 409, message: '仕上がった数が受注生産中の数を超えています。一覧を更新してください。' },
  completion_request_mismatch: { status: 409, message: '前の記録と内容が違います。画面を開き直してください。' },
  completion_not_found: { status: 404, message: '仕上がりの記録が見つかりません。' },
  completion_already_shipped: { status: 409, message: 'もう発送した数があるため、取り消せません。' },
} as const satisfies Record<FulfillmentErrorCode, { status: 400 | 404 | 409; message: string }>;

/** 窓口に届いた中身の形が誤っている時（400）。どこが誤りかは返さない */
export const INVALID_REQUEST_MESSAGE = '入力を確かめてください。';
export const INVALID_REQUEST_BODY: FulfillmentErrorResponse = { error: INVALID_REQUEST_MESSAGE, code: 'invalid_request' };

/** 思いがけない失敗（500）の言葉。何を記録しようとして失敗したかで分ける */
export const FULFILLMENT_FAILURE_MESSAGES = {
  create: '発送の記録に失敗しました。',
  cancel: '発送の取消に失敗しました。',
  completion: '仕上がりの記録に失敗しました。',
  completion_cancel: '仕上がりの取消に失敗しました。',
  materials: '発送の材料を読み込めませんでした。',
} as const;
export type FulfillmentFailureKind = keyof typeof FULFILLMENT_FAILURE_MESSAGES;

/** 通信が切れたなど、サーバーが記録したか分からない時に画面が出す言葉 */
export const UNKNOWN_OUTCOME_MESSAGE =
  '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

export function fulfillmentErrorBody(code: FulfillmentErrorCode): FulfillmentErrorResponse {
  return { error: FULFILLMENT_ERROR_MESSAGES[code].message, code };
}

export function fulfillmentFailureBody(kind: FulfillmentFailureKind): FulfillmentErrorResponse {
  return { error: FULFILLMENT_FAILURE_MESSAGES[kind], code: 'failed' };
}
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-messages.test.ts --runInBand`
Expected: PASS

- [ ] **Step 7: DB の関数の呼び出しの試験を書く**

`tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  cancelCompletion,
  cancelFulfillment,
  createFulfillment,
  FulfillmentOperationError,
  FulfillmentStoreError,
  listOrderCompletions,
  listOrderFulfillments,
  listOrderLineFulfillment,
  recordCompletion,
  toFulfillmentErrorCode,
  type FulfillmentStore,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { FULFILLMENT_ERROR_CODES, type FulfillmentErrorCode } from '@/lib/orders/fulfillment/fulfillment-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const EMPTY_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455558888';
const ACTOR_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'f1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'f1b2c3d4-1111-4222-8333-444455556662';

type RpcAnswer = { data?: unknown; error?: { message?: string; code?: string } | null };

/** rpc だけを持つ入れ物。関数の名前ごとに答えを決める。決めていない関数は空の行を返す */
function storeWith(answers: Record<string, RpcAnswer>) {
  const rpc = jest.fn(async (...call: [name: string, args?: Record<string, unknown>]) => {
    const answer = answers[call[0]];
    return { data: answer?.data ?? [], error: answer?.error ?? null };
  });
  return { store: { rpc } as unknown as FulfillmentStore, rpc };
}

// DB の関数が止める言葉 → 誤りの記号（共通の約束 C-2）
const DB_WORDS = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_SHIPPABLE', 'not_shippable'],
  ['SHIPPING_ADDRESS_INCOMPLETE', 'address_incomplete'],
  ['PAYMENT_REVIEW_REQUIRED', 'payment_review_required'],
  ['LINE_NOT_IN_ORDER', 'quantity_exceeds_ready'],
  ['QUANTITY_EXCEEDS_READY', 'quantity_exceeds_ready'],
  ['FULFILLMENT_REQUEST_MISMATCH', 'fulfillment_request_mismatch'],
  ['FULFILLMENT_ARGUMENT_INVALID', 'invalid_argument'],
  ['COMPLETION_ARGUMENT_INVALID', 'invalid_argument'],
  ['FULFILLMENT_NOT_FOUND', 'fulfillment_not_found'],
  ['FULFILLMENT_CANCEL_NOT_ALLOWED', 'fulfillment_cancel_not_allowed'],
  ['ORDER_NOT_IN_PRODUCTION', 'not_in_production'],
  ['LINE_NOT_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['QUANTITY_EXCEEDS_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['COMPLETION_REQUEST_MISMATCH', 'completion_request_mismatch'],
  ['COMPLETION_NOT_FOUND', 'completion_not_found'],
  ['COMPLETION_ALREADY_SHIPPED', 'completion_already_shipped'],
] as const satisfies ReadonlyArray<readonly [string, FulfillmentErrorCode]>;

describe('toFulfillmentErrorCode', () => {
  it.each(DB_WORDS)('DB の言葉 %s は %s', (word, code) => {
    expect(toFulfillmentErrorCode(word)).toBe(code);
    // PostgREST は言葉の前後に別の文を足すことがある
    expect(toFulfillmentErrorCode(`error: ${word} (detail)`)).toBe(code);
  });

  it('14の記号が全部、どれかの DB の言葉から届く', () => {
    expect(new Set(DB_WORDS.map(([, code]) => code))).toEqual(new Set(FULFILLMENT_ERROR_CODES));
  });

  it('表に無い言葉・空・undefined は null', () => {
    expect(toFulfillmentErrorCode('TOO_MANY_ORDERS')).toBeNull();
    expect(toFulfillmentErrorCode('connection refused')).toBeNull();
    expect(toFulfillmentErrorCode('')).toBeNull();
    expect(toFulfillmentErrorCode(undefined)).toBeNull();
  });

  it('DB の関数が止める言葉は、移行の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    // 版の頭の数字は本番に当てる時に付け替わるので、名前の後ろで探す
    const migrationText = (suffix: string) => {
      const directory = path.join(process.cwd(), 'supabase/migrations');
      const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
      expect(files).toHaveLength(1);
      return fs.readFileSync(path.join(directory, files[0]), 'utf8');
    };
    const sql = `${migrationText('_order_fulfillments.sql')}\n${migrationText('_fulfillment_order_emails.sql')}`;

    for (const [word] of DB_WORDS) {
      expect(sql).toContain(word);
    }
  });
});

describe('createFulfillment', () => {
  const INPUT = {
    orderId: ORDER_ID,
    actorId: ACTOR_ID,
    requestKey: REQUEST_KEY,
    carrier: 'yamato' as const,
    trackingNumber: '1234-5678-9012',
    notifyCustomer: true,
    lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
  };

  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      admin_create_fulfillment: {
        data: [{ fulfillment_id: FULFILLMENT_ID, number: 2, completes_order: false, order_status: 'paid', replayed: false }],
      },
    });

    await expect(createFulfillment(store, INPUT)).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 2, completesOrder: false, orderStatus: 'paid', replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_create_fulfillment', {
      _order_id: ORDER_ID,
      _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
      _notify_customer: true,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
  });

  it('全部送った発送は completesOrder と発送済みを返す。同じ番号の送り直しは replayed が true', async () => {
    const { store } = storeWith({
      admin_create_fulfillment: {
        // PostgREST は行を1つのオブジェクトで返すこともある
        data: { fulfillment_id: FULFILLMENT_ID, number: 3, completes_order: true, order_status: 'shipped', replayed: true },
      },
    });

    await expect(createFulfillment(store, { ...INPUT, notifyCustomer: false })).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 3, completesOrder: true, orderStatus: 'shipped', replayed: true,
    });
  });

  it('DB が決まった言葉で断れば、記号を持つ FulfillmentOperationError', async () => {
    const { store } = storeWith({
      admin_create_fulfillment: { error: { message: 'QUANTITY_EXCEEDS_READY', code: '22023' } },
    });

    const error = await createFulfillment(store, INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FulfillmentOperationError);
    expect(error).toMatchObject({ code: 'quantity_exceeds_ready' });
  });

  it('知らない DB の失敗は FulfillmentStoreError。DB の文はメッセージに入れず、cause にだけ残す', async () => {
    const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };
    const { store } = storeWith({ admin_create_fulfillment: { error: dbError } });

    const error = (await createFulfillment(store, INPUT).catch((caught: unknown) => caught)) as FulfillmentStoreError;

    expect(error).toBeInstanceOf(FulfillmentStoreError);
    expect(error).not.toBeInstanceOf(FulfillmentOperationError);
    expect(error.message).toBe('fulfillment store failed: admin_create_fulfillment');
    expect(error.operation).toBe('admin_create_fulfillment');
    expect(error.code).toBe('08006');
    expect(error.cause).toEqual(dbError);
  });

  it('行が返らなければ FulfillmentStoreError', async () => {
    const { store } = storeWith({ admin_create_fulfillment: { data: [] } });

    await expect(createFulfillment(store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('cancelFulfillment', () => {
  const INPUT = { orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID };

  it('DB の関数の引数名のとおりに渡し、取り消した結果と注文の状態を返す', async () => {
    const { store, rpc } = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] } });

    await expect(cancelFulfillment(store, INPUT)).resolves.toEqual({ outcome: 'cancelled', orderStatus: 'paid' });

    expect(rpc).toHaveBeenCalledWith('admin_cancel_fulfillment', {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: ACTOR_ID,
    });
  });

  it('もう取り消してあれば already_cancelled', async () => {
    const { store } = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'already_cancelled', order_status: 'paid' }] } });

    await expect(cancelFulfillment(store, INPUT)).resolves.toEqual({ outcome: 'already_cancelled', orderStatus: 'paid' });
  });

  it('DB の言葉は記号に直し、知らない結果の言葉は FulfillmentStoreError', async () => {
    const refused = storeWith({ admin_cancel_fulfillment: { error: { message: 'FULFILLMENT_CANCEL_NOT_ALLOWED', code: '22023' } } });
    await expect(cancelFulfillment(refused.store, INPUT)).rejects.toMatchObject({ code: 'fulfillment_cancel_not_allowed' });

    const unknown = storeWith({ admin_cancel_fulfillment: { data: [{ outcome: 'weird', order_status: 'paid' }] } });
    await expect(cancelFulfillment(unknown.store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('recordCompletion', () => {
  const INPUT = { orderId: ORDER_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY, lines: [{ orderItemId: ITEM_1, quantity: 2 }] };

  it('DB の関数の引数名のとおりに渡し、記録した行の番号を集める', async () => {
    const { store, rpc } = storeWith({
      admin_record_completion: {
        data: [
          { completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: false },
          { completion_id: 'e1b2c3d4-1111-4222-8333-444455556667', order_item_id: ITEM_2, quantity: 1, replayed: false },
        ],
      },
    });

    await expect(recordCompletion(store, INPUT)).resolves.toEqual({
      completionIds: [COMPLETION_ID, 'e1b2c3d4-1111-4222-8333-444455556667'], replayed: false,
    });

    expect(rpc).toHaveBeenCalledWith('admin_record_completion', {
      _order_id: ORDER_ID, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY, _lines: [{ order_item_id: ITEM_1, quantity: 2 }],
    });
  });

  it('同じ番号の送り直しは、全部の行が replayed のとき replayed が true', async () => {
    const { store } = storeWith({
      admin_record_completion: { data: [{ completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: true }] },
    });

    await expect(recordCompletion(store, INPUT)).resolves.toEqual({ completionIds: [COMPLETION_ID], replayed: true });
  });

  it('DB の言葉は記号に直し、行が返らなければ FulfillmentStoreError', async () => {
    const refused = storeWith({ admin_record_completion: { error: { message: 'QUANTITY_EXCEEDS_IN_PRODUCTION', code: '22023' } } });
    await expect(recordCompletion(refused.store, INPUT)).rejects.toMatchObject({ code: 'quantity_exceeds_in_production' });

    const empty = storeWith({ admin_record_completion: { data: [] } });
    await expect(recordCompletion(empty.store, INPUT)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('cancelCompletion', () => {
  const INPUT = { orderId: ORDER_ID, completionId: COMPLETION_ID, actorId: ACTOR_ID };

  it('DB の関数の引数名のとおりに渡し、結果を返す', async () => {
    const { store, rpc } = storeWith({ admin_cancel_completion: { data: [{ outcome: 'cancelled' }] } });

    await expect(cancelCompletion(store, INPUT)).resolves.toEqual({ outcome: 'cancelled' });

    expect(rpc).toHaveBeenCalledWith('admin_cancel_completion', {
      _order_id: ORDER_ID, _completion_id: COMPLETION_ID, _actor_id: ACTOR_ID,
    });
  });

  it('送った数を下回る取消は、記号 completion_already_shipped で断る', async () => {
    const { store } = storeWith({ admin_cancel_completion: { error: { message: 'COMPLETION_ALREADY_SHIPPED', code: '22023' } } });

    await expect(cancelCompletion(store, INPUT)).rejects.toMatchObject({ code: 'completion_already_shipped' });
  });
});

describe('listOrderFulfillments / listOrderCompletions', () => {
  it('発送の一覧を窓口の形に直す。商品の行は jsonb の配列から読む', async () => {
    const { store, rpc } = storeWith({
      list_order_fulfillments: {
        data: [{
          fulfillment_id: FULFILLMENT_ID, number: 2, shipping_carrier: 'yamato', tracking_number: '1234-5678-9012', notify_customer: true,
          completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
          cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 2 }],
        }],
      },
    });

    await expect(listOrderFulfillments(store, ORDER_ID)).resolves.toEqual([{
      fulfillmentId: FULFILLMENT_ID, number: 2, shippingCarrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: true,
      completesOrder: false, shippedAt: '2026-10-10T02:00:00+00:00', createdByEmail: 'admin@example.com', cancelledAt: null,
      cancelledByEmail: null, legacy: false, lines: [{ orderItemId: ITEM_1, quantity: 2 }],
    }]);

    expect(rpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
  });

  it('前からの記録（配送業者・伝票番号・操作した人が空）と、取り消した記録も読める', async () => {
    const { store } = storeWith({
      list_order_fulfillments: {
        data: [{
          fulfillment_id: FULFILLMENT_ID, number: 1, shipping_carrier: null, tracking_number: null, notify_customer: false,
          completes_order: true, shipped_at: '2026-09-01T00:00:00+00:00', created_by_email: null,
          cancelled_at: '2026-10-11T03:00:00+00:00', cancelled_by_email: 'owner@example.com', legacy: true, lines: null,
        }],
      },
    });

    await expect(listOrderFulfillments(store, ORDER_ID)).resolves.toEqual([{
      fulfillmentId: FULFILLMENT_ID, number: 1, shippingCarrier: null, trackingNumber: null, notifyCustomer: false,
      completesOrder: true, shippedAt: '2026-09-01T00:00:00+00:00', createdByEmail: null,
      cancelledAt: '2026-10-11T03:00:00+00:00', cancelledByEmail: 'owner@example.com', legacy: true, lines: [],
    }]);
  });

  it('仕上がりの一覧を窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      list_order_completions: {
        data: [{
          completion_id: COMPLETION_ID, order_item_id: ITEM_2, quantity: 1, created_at: '2026-10-10T01:00:00+00:00',
          created_by_email: null, cancelled_at: null, cancelled_by_email: null, legacy: true,
        }],
      },
    });

    await expect(listOrderCompletions(store, ORDER_ID)).resolves.toEqual([{
      completionId: COMPLETION_ID, orderItemId: ITEM_2, quantity: 1, createdAt: '2026-10-10T01:00:00+00:00',
      createdByEmail: null, cancelledAt: null, cancelledByEmail: null, legacy: true,
    }]);

    expect(rpc).toHaveBeenCalledWith('list_order_completions', { _order_id: ORDER_ID });
  });

  it('DB の失敗は FulfillmentStoreError', async () => {
    const { store } = storeWith({ list_order_fulfillments: { error: { message: 'down', code: '08006' } } });

    await expect(listOrderFulfillments(store, ORDER_ID)).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});

describe('listOrderLineFulfillment', () => {
  const countRow = (orderId: string, orderItemId: string, overrides: Record<string, unknown> = {}) => ({
    order_id: orderId, order_item_id: orderItemId, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1,
    completed: 2, in_production: 0, ready_unshipped: 1, unshipped: 1, ...overrides,
  });

  it('空の入力は DB を呼ばず、空の Map を返す', async () => {
    const { store, rpc } = storeWith({});

    await expect(listOrderLineFulfillment(store, [])).resolves.toEqual(new Map());

    expect(rpc).not.toHaveBeenCalled();
  });

  it('行を注文ごとに集める。行が無い注文も空の配列でキーに入る。受注生産の行は variantId が null でもよい', async () => {
    const { store, rpc } = storeWith({
      list_order_line_fulfillment: {
        data: [
          countRow(ORDER_ID, ITEM_1),
          countRow(ORDER_ID, ITEM_2, { variant_id: null, fulfillment_type: 'backorder', quantity: 3, shipped: 0, completed: 1, in_production: 2, ready_unshipped: 1, unshipped: 3 }),
          countRow(OTHER_ORDER_ID, 'f1b2c3d4-1111-4222-8333-444455556663'),
        ],
      },
    });

    const result = await listOrderLineFulfillment(store, [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID] });
    expect(result.get(ORDER_ID)).toEqual([
      {
        orderId: ORDER_ID, orderItemId: ITEM_1, variantId: 11, fulfillmentType: 'stock', quantity: 2, shipped: 1, completed: 2,
        inProduction: 0, readyUnshipped: 1, unshipped: 1,
      },
      {
        orderId: ORDER_ID, orderItemId: ITEM_2, variantId: null, fulfillmentType: 'backorder', quantity: 3, shipped: 0, completed: 1,
        inProduction: 2, readyUnshipped: 1, unshipped: 3,
      },
    ]);
    expect(result.get(OTHER_ORDER_ID)).toHaveLength(1);
    expect(result.get(EMPTY_ORDER_ID)).toEqual([]);
  });

  it('同じ番号は1回として数える', async () => {
    const { store, rpc } = storeWith({ list_order_line_fulfillment: { data: [countRow(ORDER_ID, ITEM_1)] } });

    const result = await listOrderLineFulfillment(store, [ORDER_ID, ORDER_ID]);

    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    expect(result.get(ORDER_ID)).toHaveLength(1);
  });

  it('200件ずつに分けて呼ぶ（DB の関数は201件以上を断るため）', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { store, rpc } = storeWith({ list_order_line_fulfillment: { data: [] } });

    const result = await listOrderLineFulfillment(store, ids);

    expect(rpc.mock.calls.map(([, args]) => (args?._order_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(rpc.mock.calls[0][1]?._order_ids).toEqual(ids.slice(0, 200));
    expect(rpc.mock.calls[2][1]?._order_ids).toEqual(ids.slice(400));
    expect(result.size).toBe(450);
  });

  it('DB の失敗は FulfillmentStoreError', async () => {
    const { store } = storeWith({ list_order_line_fulfillment: { error: { message: 'TOO_MANY_ORDERS', code: '22023' } } });

    await expect(listOrderLineFulfillment(store, [ORDER_ID])).rejects.toBeInstanceOf(FulfillmentStoreError);
  });
});
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/fulfillment/fulfillment-store'`）

- [ ] **Step 8: DB の関数の呼び出しを書く**

`src/lib/orders/fulfillment/fulfillment-store.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type {
  CancelCompletionResponse,
  CancelFulfillmentResponse,
  CreateFulfillmentResponse,
  FulfillmentErrorCode,
  FulfillmentLineQuantity,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 発送と仕上がりの DB の関数を呼ぶ（グループ E-1 設計書 3〜7 章）。3つの表は service_role からも書けず、関数だけが書く。
 * 関数は断る理由を決まった言葉で止める。ここで誤りの記号（FulfillmentErrorCode）に直し、窓口が HTTP と画面の言葉にする。
 * DB の文には宛先などが混ざりうるので、ログに出さない（FulfillmentStoreError は呼び出しの名前と DB の記号だけを見せる）。
 */
export type FulfillmentStore = Pick<SupabaseClient, 'rpc'>;

type QueryError = { message?: string; code?: string } | null;

/** DB の関数が決まった言葉で断った。記号から HTTP と画面の言葉が決まる */
export class FulfillmentOperationError extends Error {
  constructor(readonly code: FulfillmentErrorCode) {
    super(`fulfillment operation refused: ${code}`);
    this.name = 'FulfillmentOperationError';
  }
}

/** DB の呼び出しが思いがけず失敗した。DB の文は cause にだけ残す */
export class FulfillmentStoreError extends Error {
  readonly code: string | null;

  constructor(
    readonly operation: string,
    cause: QueryError = null,
  ) {
    super(`fulfillment store failed: ${operation}`, { cause });
    this.name = 'FulfillmentStoreError';
    this.code = cause?.code ?? null;
  }
}

// DB の関数が RAISE EXCEPTION で止める言葉 → 誤りの記号（共通の約束 C-2）。言葉は移行の本文と同じ綴り
const DB_ERROR_WORDS: ReadonlyArray<readonly [string, FulfillmentErrorCode]> = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_SHIPPABLE', 'not_shippable'],
  ['SHIPPING_ADDRESS_INCOMPLETE', 'address_incomplete'],
  ['PAYMENT_REVIEW_REQUIRED', 'payment_review_required'],
  ['LINE_NOT_IN_ORDER', 'quantity_exceeds_ready'],
  ['QUANTITY_EXCEEDS_READY', 'quantity_exceeds_ready'],
  ['FULFILLMENT_REQUEST_MISMATCH', 'fulfillment_request_mismatch'],
  ['FULFILLMENT_ARGUMENT_INVALID', 'invalid_argument'],
  ['COMPLETION_ARGUMENT_INVALID', 'invalid_argument'],
  ['FULFILLMENT_NOT_FOUND', 'fulfillment_not_found'],
  ['FULFILLMENT_CANCEL_NOT_ALLOWED', 'fulfillment_cancel_not_allowed'],
  ['ORDER_NOT_IN_PRODUCTION', 'not_in_production'],
  ['LINE_NOT_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['QUANTITY_EXCEEDS_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['COMPLETION_REQUEST_MISMATCH', 'completion_request_mismatch'],
  ['COMPLETION_NOT_FOUND', 'completion_not_found'],
  ['COMPLETION_ALREADY_SHIPPED', 'completion_already_shipped'],
];

/** DB の誤りの文に表の言葉が含まれていれば、その記号。無ければ null */
export function toFulfillmentErrorCode(message: string | undefined): FulfillmentErrorCode | null {
  if (!message) {
    return null;
  }
  return DB_ERROR_WORDS.find(([word]) => message.includes(word))?.[1] ?? null;
}

type FulfillmentRpcName =
  | 'admin_create_fulfillment'
  | 'admin_cancel_fulfillment'
  | 'admin_record_completion'
  | 'admin_cancel_completion'
  | 'list_order_fulfillments'
  | 'list_order_completions'
  | 'list_order_line_fulfillment';

async function callRpc(store: FulfillmentStore, name: FulfillmentRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, args);
  if (error) {
    const code = toFulfillmentErrorCode(error.message);
    throw code ? new FulfillmentOperationError(code) : new FulfillmentStoreError(name, error);
  }
  return data;
}

/** PostgREST は表を返す関数の答えを配列で返す。行が1つのオブジェクトで来ても読めるようにする */
function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function outcomeOf(value: unknown): 'cancelled' | 'already_cancelled' | null {
  return value === 'cancelled' || value === 'already_cancelled' ? value : null;
}

/** DB の関数の引数 _lines の形 */
function toDbLines(lines: readonly FulfillmentLineQuantity[]): Array<{ order_item_id: string; quantity: number }> {
  return lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity }));
}

/** list_order_fulfillments の lines（jsonb の配列。商品の行が無ければ null になりうる）を窓口の形に直す */
function fromDbLines(value: unknown): FulfillmentLineQuantity[] {
  if (!Array.isArray(value)) return [];
  return value.map((line: { order_item_id: unknown; quantity: unknown }) => ({
    orderItemId: String(line.order_item_id),
    quantity: Number(line.quantity),
  }));
}

export type OrderLineFulfillmentRow = {
  orderId: string;
  orderItemId: string;
  variantId: number | null;
  fulfillmentType: string;
  quantity: number;
  shipped: number;
  completed: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

// DB の関数 list_order_line_fulfillment が一度に受ける注文の数の上限
const LINE_FULFILLMENT_CHUNK_SIZE = 200;

/**
 * 注文ごとの商品の数（発送した・仕上がった・受注生産中・発送準備中・未発送）。数え方は DB の1か所にあるので、
 * 窓口と画面は必ずこの答えを使う。渡した注文の番号は全部キーに入る（商品の行が無ければ空の配列）。
 * 空なら DB を呼ばない。DB の関数が受ける上限に合わせて、200件ずつに分けて呼ぶ。
 */
export async function listOrderLineFulfillment(
  store: FulfillmentStore,
  orderIds: readonly string[],
): Promise<Map<string, OrderLineFulfillmentRow[]>> {
  const ids = [...new Set(orderIds)];
  const byOrder = new Map<string, OrderLineFulfillmentRow[]>(ids.map((id): [string, OrderLineFulfillmentRow[]] => [id, []]));

  for (let start = 0; start < ids.length; start += LINE_FULFILLMENT_CHUNK_SIZE) {
    const data = await callRpc(store, 'list_order_line_fulfillment', {
      _order_ids: ids.slice(start, start + LINE_FULFILLMENT_CHUNK_SIZE),
    });
    for (const row of rowsOf(data)) {
      const orderId = String(row.order_id);
      byOrder.get(orderId)?.push({
        orderId,
        orderItemId: String(row.order_item_id),
        variantId: typeof row.variant_id === 'number' ? row.variant_id : null,
        fulfillmentType: String(row.fulfillment_type),
        quantity: Number(row.quantity),
        shipped: Number(row.shipped),
        completed: Number(row.completed),
        inProduction: Number(row.in_production),
        readyUnshipped: Number(row.ready_unshipped),
        unshipped: Number(row.unshipped),
      });
    }
  }
  return byOrder;
}

/** 発送を1回記録する。同じ requestKey の送り直しは前の結果を返す（replayed）。断りは FulfillmentOperationError */
export async function createFulfillment(
  store: FulfillmentStore,
  input: {
    orderId: string;
    actorId: string;
    requestKey: string;
    carrier: ShippingCarrierId;
    trackingNumber: string;
    notifyCustomer: boolean;
    lines: FulfillmentLineQuantity[];
  },
): Promise<CreateFulfillmentResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_create_fulfillment', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _shipping_carrier: input.carrier,
      _tracking_number: input.trackingNumber,
      _notify_customer: input.notifyCustomer,
      _lines: toDbLines(input.lines),
    }),
  )[0];
  if (!row) {
    throw new FulfillmentStoreError('admin_create_fulfillment', null);
  }
  return {
    fulfillmentId: String(row.fulfillment_id),
    number: Number(row.number),
    completesOrder: row.completes_order === true,
    orderStatus: row.order_status as OrderStatus,
    replayed: row.replayed === true,
  };
}

/** 発送を取り消す。もう取り消してあれば already_cancelled（何度押しても同じ結果） */
export async function cancelFulfillment(
  store: FulfillmentStore,
  input: { orderId: string; fulfillmentId: string; actorId: string },
): Promise<CancelFulfillmentResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_cancel_fulfillment', {
      _order_id: input.orderId,
      _fulfillment_id: input.fulfillmentId,
      _actor_id: input.actorId,
    }),
  )[0];
  const outcome = outcomeOf(row?.outcome);
  if (!outcome) {
    throw new FulfillmentStoreError('admin_cancel_fulfillment', null);
  }
  return { outcome, orderStatus: row.order_status as OrderStatus };
}

/** 受注生産の品の仕上がりを記録する。1回の操作で複数の商品を記録でき、行ごとに番号が付く */
export async function recordCompletion(
  store: FulfillmentStore,
  input: { orderId: string; actorId: string; requestKey: string; lines: FulfillmentLineQuantity[] },
): Promise<RecordCompletionResponse> {
  const rows = rowsOf(
    await callRpc(store, 'admin_record_completion', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _lines: toDbLines(input.lines),
    }),
  );
  if (rows.length === 0) {
    throw new FulfillmentStoreError('admin_record_completion', null);
  }
  return {
    completionIds: rows.map((row) => String(row.completion_id)),
    replayed: rows.every((row) => row.replayed === true),
  };
}

/** 仕上がりを取り消す。送った数を下回る取消は DB が断る（completion_already_shipped） */
export async function cancelCompletion(
  store: FulfillmentStore,
  input: { orderId: string; completionId: string; actorId: string },
): Promise<CancelCompletionResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_cancel_completion', {
      _order_id: input.orderId,
      _completion_id: input.completionId,
      _actor_id: input.actorId,
    }),
  )[0];
  const outcome = outcomeOf(row?.outcome);
  if (!outcome) {
    throw new FulfillmentStoreError('admin_cancel_completion', null);
  }
  return { outcome };
}

export type OrderFulfillmentHistoryRow = {
  fulfillmentId: string;
  number: number;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  notifyCustomer: boolean;
  completesOrder: boolean;
  shippedAt: string;
  createdByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  legacy: boolean;
  lines: FulfillmentLineQuantity[];
};

/** 注文の発送の一覧（取り消した分も含む。何回目の新しい順）。操作した人のメールを含むので、管理画面の窓口だけが使う */
export async function listOrderFulfillments(store: FulfillmentStore, orderId: string): Promise<OrderFulfillmentHistoryRow[]> {
  const data = await callRpc(store, 'list_order_fulfillments', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    fulfillmentId: String(row.fulfillment_id),
    number: Number(row.number),
    shippingCarrier: textOrNull(row.shipping_carrier),
    trackingNumber: textOrNull(row.tracking_number),
    notifyCustomer: row.notify_customer === true,
    completesOrder: row.completes_order === true,
    shippedAt: String(row.shipped_at),
    createdByEmail: textOrNull(row.created_by_email),
    cancelledAt: textOrNull(row.cancelled_at),
    cancelledByEmail: textOrNull(row.cancelled_by_email),
    legacy: row.legacy === true,
    lines: fromDbLines(row.lines),
  }));
}

export type OrderCompletionHistoryRow = {
  completionId: string;
  orderItemId: string;
  quantity: number;
  createdAt: string;
  createdByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  legacy: boolean;
};

/** 注文の仕上がりの一覧（取り消した分も含む。新しい順） */
export async function listOrderCompletions(store: FulfillmentStore, orderId: string): Promise<OrderCompletionHistoryRow[]> {
  const data = await callRpc(store, 'list_order_completions', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    completionId: String(row.completion_id),
    orderItemId: String(row.order_item_id),
    quantity: Number(row.quantity),
    createdAt: String(row.created_at),
    createdByEmail: textOrNull(row.created_by_email),
    cancelledAt: textOrNull(row.cancelled_at),
    cancelledByEmail: textOrNull(row.cancelled_by_email),
    legacy: row.legacy === true,
  }));
}
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts --runInBand`
Expected: PASS（DB の言葉と移行の本文を突き合わせる試験は、Task 1・2 の移行がある前提。無ければここだけ FAIL するので、移行のファイルがあるかを先に確かめる）

- [ ] **Step 9: 発送の材料の試験を書く**

`tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import { FulfillmentStoreError } from '@/lib/orders/fulfillment/fulfillment-store';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const STOCK_ITEM = 'f1b2c3d4-1111-4222-8333-444455556661';
const BACKORDER_ITEM = 'f1b2c3d4-1111-4222-8333-444455556662';
const FULFILLMENT_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const FULFILLMENT_2 = 'd1b2c3d4-1111-4222-8333-444455556662';

type QueryResult = { data: unknown; error: { message?: string; code?: string } | null };

/** from(...).select(...).eq(...) の鎖を作る入れ物。最後に待つ（await する）と結果を返す */
function query(result: QueryResult) {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    order: jest.fn(),
    maybeSingle: jest.fn(async () => result),
    then: (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of [builder.select, builder.eq, builder.is, builder.order]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

const ORDER_ROW = {
  id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子', shipping_postal_code: '1500001',
  shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-2-3', shipping_phone: '09012345678',
};
const ITEM_ROWS = [
  { id: STOCK_ITEM, item_name: 'シルクブラウス', color: '白', size: 'M' },
  { id: BACKORDER_ITEM, item_name: 'リネンパンツ', color: null, size: null },
];
const COUNT_ROWS = [
  {
    order_id: ORDER_ID, order_item_id: STOCK_ITEM, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 0, completed: 2,
    in_production: 0, ready_unshipped: 2, unshipped: 2,
  },
  {
    order_id: ORDER_ID, order_item_id: BACKORDER_ITEM, variant_id: 12, fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0,
    in_production: 1, ready_unshipped: 0, unshipped: 1,
  },
];
const FULFILLMENT_ROWS = [
  {
    fulfillment_id: FULFILLMENT_2, number: 2, shipping_carrier: 'sagawa', tracking_number: '9999-0000', notify_customer: false,
    completes_order: false, shipped_at: '2026-10-11T02:00:00+00:00', created_by_email: 'admin@example.com',
    cancelled_at: '2026-10-11T03:00:00+00:00', cancelled_by_email: 'admin@example.com', legacy: false,
    lines: [{ order_item_id: STOCK_ITEM, quantity: 1 }],
  },
  {
    fulfillment_id: FULFILLMENT_1, number: 1, shipping_carrier: 'yamato', tracking_number: '1234-5678', notify_customer: true,
    completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
    cancelled_by_email: null, legacy: false, lines: [{ order_item_id: STOCK_ITEM, quantity: 1 }],
  },
];

function stubClient(options: {
  order?: QueryResult;
  items?: QueryResult;
  exceptions?: QueryResult;
  rpc?: Record<string, QueryResult>;
} = {}) {
  const tables = {
    orders: query(options.order ?? { data: ORDER_ROW, error: null }),
    order_items: query(options.items ?? { data: ITEM_ROWS, error: null }),
    payment_exceptions: query(options.exceptions ?? { data: [], error: null }),
  };
  const rpcAnswers: Record<string, QueryResult> = {
    list_order_line_fulfillment: { data: COUNT_ROWS, error: null },
    list_order_fulfillments: { data: FULFILLMENT_ROWS, error: null },
    ...options.rpc,
  };
  const from = jest.fn((table: string) => tables[table as keyof typeof tables]);
  const rpc = jest.fn(async (name: string) => rpcAnswers[name] ?? { data: [], error: null });
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, tables };
}

describe('loadFulfillmentMaterials', () => {
  it('注文・商品ごとの数・発送の一覧をまとめて返す。商品の並びは登録順', async () => {
    const { client, rpc, tables } = stubClient();

    await expect(loadFulfillmentMaterials(client, ORDER_ID)).resolves.toEqual({
      order: {
        id: ORDER_ID,
        orderNumber: 'ORD-A1B2C3D4',
        status: 'paid',
        progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
      },
      blockedReason: null,
      lines: [
        {
          orderItemId: STOCK_ITEM, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock', quantity: 2,
          shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
        },
        {
          orderItemId: BACKORDER_ITEM, name: 'リネンパンツ', color: null, size: null, fulfillmentType: 'backorder', quantity: 1,
          shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
        },
      ],
      fulfillments: [
        {
          id: FULFILLMENT_2, number: 2, carrier: 'sagawa', trackingNumber: '9999-0000', shippedAt: '2026-10-11T02:00:00+00:00',
          notifyCustomer: false, completesOrder: false, cancelledAt: '2026-10-11T03:00:00+00:00',
          lines: [{ orderItemId: STOCK_ITEM, quantity: 1 }],
        },
        {
          id: FULFILLMENT_1, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', shippedAt: '2026-10-10T02:00:00+00:00',
          notifyCustomer: true, completesOrder: false, cancelledAt: null, lines: [{ orderItemId: STOCK_ITEM, quantity: 1 }],
        },
      ],
    });

    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    expect(rpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
    expect(tables.order_items.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
    expect(tables.order_items.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
  });

  it('操作した人のメールは材料に入れない（発送の画面に要らない）', async () => {
    const { client } = stubClient();

    const materials = await loadFulfillmentMaterials(client, ORDER_ID);

    expect(JSON.stringify(materials)).not.toContain('admin@example.com');
  });

  it('在庫の品だけを先に送った後は、一部発送済みの言葉と、残りの数を返す', async () => {
    const shipped = {
      ...COUNT_ROWS[0], shipped: 2, ready_unshipped: 0, unshipped: 0,
    };
    const { client } = stubClient({ rpc: { list_order_line_fulfillment: { data: [shipped, COUNT_ROWS[1]], error: null } } });

    const materials = await loadFulfillmentMaterials(client, ORDER_ID);

    expect(materials?.order.progress).toEqual({ key: 'in_production', label: '受注生産中', partiallyShipped: true });
    expect(materials?.lines[0]).toMatchObject({ shipped: 2, readyUnshipped: 0, unshipped: 0 });
  });

  it('注文が無ければ null。ほかの読み取りはしない', async () => {
    const { client, from, rpc } = stubClient({ order: { data: null, error: null } });

    await expect(loadFulfillmentMaterials(client, ORDER_ID)).resolves.toBeNull();

    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  describe('発送できない理由 blockedReason', () => {
    it.each(['pending', 'shipped', 'cancelled', 'failed', 'payment_in_progress', 'abandoned'])(
      '注文が %s なら not_shippable（配送先が足りなくても、この理由が先）',
      async (status) => {
        const { client } = stubClient({ order: { data: { ...ORDER_ROW, status, shipping_phone: null }, error: null } });

        const materials = await loadFulfillmentMaterials(client, ORDER_ID);

        expect(materials?.blockedReason).toBe('not_shippable');
      },
    );

    it.each([
      ['電話番号が空', { shipping_phone: null }],
      ['郵便番号が空白だけ', { shipping_postal_code: '   ' }],
      ['宛名が空', { shipping_full_name: '' }],
      ['メールが無い', { shipping_email: null }],
    ])('配送先が足りなければ address_incomplete（%s）。支払額の要対応より先', async (_name, overrides) => {
      const { client } = stubClient({
        order: { data: { ...ORDER_ROW, ...overrides }, error: null },
        exceptions: { data: [{ order_id: ORDER_ID }], error: null },
      });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBe('address_incomplete');
    });

    it('支払額の違いの要対応が残っていれば payment_review_required。読む条件は管理画面の一覧と同じ', async () => {
      const { client, tables } = stubClient({ exceptions: { data: [{ order_id: ORDER_ID }], error: null } });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBe('payment_review_required');
      expect(tables.payment_exceptions.select).toHaveBeenCalledWith('order_id');
      expect(tables.payment_exceptions.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
      expect(tables.payment_exceptions.eq).toHaveBeenCalledWith('reason', 'paid_amount_mismatch');
      expect(tables.payment_exceptions.is).toHaveBeenCalledWith('resolved_at', null);
    });

    it('建物名が無くても発送できる（必須項目ではない）', async () => {
      const { client } = stubClient({ order: { data: { ...ORDER_ROW, shipping_building: null }, error: null } });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBeNull();
    });
  });

  describe('DB の読み取りが失敗した時', () => {
    it.each([
      ['注文', { order: { data: null, error: { message: 'down', code: '08006' } } }],
      ['商品', { items: { data: null, error: { message: 'down', code: '08006' } } }],
      ['支払額の要対応', { exceptions: { data: null, error: { message: 'down', code: '08006' } } }],
      ['商品ごとの数', { rpc: { list_order_line_fulfillment: { data: null, error: { message: 'down', code: '08006' } } } }],
      ['発送の一覧', { rpc: { list_order_fulfillments: { data: null, error: { message: 'down', code: '08006' } } } }],
    ])('%s の読み取りが失敗したら FulfillmentStoreError を投げる', async (_name, options) => {
      const { client } = stubClient(options);

      await expect(loadFulfillmentMaterials(client, ORDER_ID)).rejects.toBeInstanceOf(FulfillmentStoreError);
    });
  });
});
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/fulfillment/fulfillment-materials'`）

- [ ] **Step 10: 発送の材料を書く**

`src/lib/orders/fulfillment/fulfillment-materials.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { findMissingShippingFields } from '@/features/checkout/services/checkout-draft.service';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import {
  FulfillmentStoreError,
  listOrderFulfillments,
  listOrderLineFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';
import type {
  FulfillmentBlockedReason,
  FulfillmentMaterialLine,
  FulfillmentMaterials,
} from '@/lib/orders/fulfillment/fulfillment-types';

type MaterialOrderRow = {
  id: string;
  status: OrderStatus;
  shipping_email: string | null;
  shipping_full_name: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_phone: string | null;
};

type MaterialItemRow = { id: string; item_name: string; color: string | null; size: string | null };

const ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_phone';

/**
 * 発送の画面が開いた時に読む材料（グループ E-1 設計書 6-1・6-2）。service_role の client で読む。
 * 発送できない理由は DB の関数 admin_create_fulfillment が断るのと同じ条件を、画面が先に知らせるために出す
 * （決済完了でない → 配送先が足りない → 支払額の違いの要対応が残っている、の順）。注文が無ければ null。
 */
export async function loadFulfillmentMaterials(client: SupabaseClient, orderId: string): Promise<FulfillmentMaterials | null> {
  const { data: order, error: orderError } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<MaterialOrderRow>();
  if (orderError) {
    throw new FulfillmentStoreError('load_order', orderError);
  }
  if (!order) {
    return null;
  }

  const [itemsResult, exceptionsResult, countsByOrder, fulfillmentRows] = await Promise.all([
    // 同じ注文の商品は同じ時刻に登録されるので、id を足して並びを決める
    client
      .from('order_items')
      .select('id, item_name, color, size')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    // 管理画面の一覧（src/app/api/admin/orders/route.ts）と、発送の DB の関数が断る条件と同じ
    client
      .from('payment_exceptions')
      .select('order_id')
      .eq('order_id', orderId)
      .eq('reason', 'paid_amount_mismatch')
      .is('resolved_at', null),
    listOrderLineFulfillment(client, [orderId]),
    listOrderFulfillments(client, orderId),
  ]);
  if (itemsResult.error) {
    throw new FulfillmentStoreError('load_order_items', itemsResult.error);
  }
  if (exceptionsResult.error) {
    throw new FulfillmentStoreError('load_payment_exceptions', exceptionsResult.error);
  }

  const counts = new Map((countsByOrder.get(orderId) ?? []).map((row) => [row.orderItemId, row] as const));
  const lines = ((itemsResult.data ?? []) as MaterialItemRow[]).flatMap((item): FulfillmentMaterialLine[] => {
    const row = counts.get(item.id);
    if (!row) {
      return [];
    }
    return [{
      orderItemId: item.id,
      name: item.item_name,
      color: item.color,
      size: item.size,
      fulfillmentType: row.fulfillmentType === 'backorder' ? 'backorder' : 'stock',
      quantity: row.quantity,
      shipped: row.shipped,
      inProduction: row.inProduction,
      readyUnshipped: row.readyUnshipped,
      unshipped: row.unshipped,
    }];
  });

  const paymentReviewOpen = (exceptionsResult.data ?? []).length > 0;

  return {
    order: { id: order.id, orderNumber: toOrderNumber(order.id), status: order.status, progress: deriveOrderProgress(order.status, lines) },
    blockedReason: blockedReasonOf(order, paymentReviewOpen),
    lines,
    fulfillments: fulfillmentRows.map((row) => ({
      id: row.fulfillmentId,
      number: row.number,
      carrier: row.shippingCarrier,
      trackingNumber: row.trackingNumber,
      shippedAt: row.shippedAt,
      notifyCustomer: row.notifyCustomer,
      completesOrder: row.completesOrder,
      cancelledAt: row.cancelledAt,
      lines: row.lines,
    })),
  };
}

function blockedReasonOf(order: MaterialOrderRow, paymentReviewOpen: boolean): FulfillmentBlockedReason | null {
  if (order.status !== 'paid') {
    return 'not_shippable';
  }
  const missingFields = findMissingShippingFields({
    email: order.shipping_email,
    fullName: order.shipping_full_name,
    kanaName: null,
    postalCode: order.shipping_postal_code,
    prefecture: order.shipping_prefecture,
    city: order.shipping_city,
    address: order.shipping_address,
    building: null,
    phone: order.shipping_phone,
  });
  if (missingFields.length > 0) {
    return 'address_incomplete';
  }
  return paymentReviewOpen ? 'payment_review_required' : null;
}
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts --runInBand`
Expected: PASS

- [ ] **Step 11: 型・lint・単体の全体を確かめる**

Run: `npx jest tests/unit/lib/orders --runInBand`
Expected: PASS（今ある `tests/unit/lib/orders` の試験も、`order-status.ts` などを変えていないので通る）
Run: `npx tsc --noEmit` と `npm run lint`
Expected: エラー0件

- [ ] **Step 12: コミット（controller）**

```bash
git add src/lib/orders/order-progress.ts src/lib/orders/fulfillment/fulfillment-types.ts src/lib/orders/fulfillment/fulfillment-messages.ts src/lib/orders/fulfillment/fulfillment-store.ts src/lib/orders/fulfillment/fulfillment-materials.ts tests/unit/lib/orders/order-progress.test.ts tests/unit/lib/orders/fulfillment/fulfillment-types.test.ts tests/unit/lib/orders/fulfillment/fulfillment-messages.test.ts tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts
git commit -m "feat(orders): 注文の言葉と発送・仕上がりの部品を足す（グループ E-1）" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 発送ごとの発送のメールと、注文の確認の1行

発送のメール（注文のメールの種類 `shipped`）を、発送1回ごとの内容で作る。Task 2 で、発送のメールの行は発送の番号（`fulfillment_id`）を持ち、発送ごとに1行できる。このタスクは TS の側で、取り出した行の発送の番号で発送の記録を読んで本文を書く。発送が取り消されていたら送らずに取りやめにする。管理画面の再送は発送の番号を渡せるようにする。注文の確認と入金待ちのメールには、在庫の品と受注生産の品が両方ある時だけ、先に在庫の品を送る案内を1行足す。取りやめの理由 `fulfillment_cancelled`・原因の名前・再送できる注文の状態の表（`order-email-types.ts`）は、DB の表と同時に変える必要があるので Task 2 が直す。このタスクは使うだけ。

**Files:**
- Modify: `src/lib/orders/email/order-email-store.ts:61-72,102-121,307-346`（取り出した行と履歴の行に発送の番号、再送の依頼に発送の番号）
- Modify: `src/lib/orders/email/order-history.ts:43-58`（型 `OrderEmailHistoryRow` に2つの項目を足すだけ。履歴の組み立ては Task 5）
- Modify: `src/lib/orders/email/order-email-compose.ts`（ファイル全体。材料に発送を足し、発送のメールを発送の記録から書き、注文の確認に1行足す）
- Modify: `src/lib/orders/email/order-email-worker.ts:37-44,82-93,109-113,224`（発送の番号で材料を読む・発送の取消で取りやめ）
- Modify: `src/lib/orders/order-confirmation-email.ts:29-46`（発送の明細の行 `formatShipmentItemLines` を足す）
- Test: `tests/unit/lib/orders/email/order-email-store.test.ts`（全体を置き換え）
- Test: `tests/unit/lib/orders/order-confirmation-email.test.ts`（全体を置き換え）
- Test: `tests/unit/lib/orders/email/order-email-compose.test.ts`（全体を置き換え）
- Test: `tests/unit/lib/orders/email/order-email-worker.test.ts:22,26-49,147-153,210-223,257-270,398-415`（読み込みの型・見本・環境の describe の `beforeEach`、その describe の最後に足す it、第1の it、発送のメールの it、取りやめの表）
- Test: `tests/unit/lib/orders/email/order-history.test.ts:6-12`（見本の行に2つの項目を足すだけ）
- Test: `tests/unit/api/admin/order-email-routes.test.ts:183`（期待する DB の呼び出しに `_fulfillment_id: null` を足すだけ。Task 5 が窓口を変える時にこの試験を広げる）

**Interfaces:**
- Consumes:
  - Task 1: 表 `public.order_fulfillments`（`id`・`order_id`・`number`・`shipping_carrier`・`tracking_number`・`completes_order`・`cancelled_at`）と `public.order_fulfillment_lines`（`fulfillment_id`・`order_item_id`・`quantity`）。service_role が SELECT できる
  - Task 2: `claim_order_email` の最後の列 `fulfillment_id`、`list_order_email_history` の最後の列 `fulfillment_id`・`fulfillment_number`、`request_order_email_resend(_order_id, _kind, _actor_id, _fulfillment_id DEFAULT NULL)` とその断りの言葉 `RESEND_FULFILLMENT_REQUIRED`、`skip_order_email` が受ける理由 `fulfillment_cancelled`
  - Task 2（Step 5）が直す `src/lib/orders/email/order-email-types.ts`: `ORDER_EMAIL_ERROR_CODES` と `OrderEmailSkipReason` の `fulfillment_cancelled`、`ORDER_EMAIL_ERROR_LABELS.fulfillment_cancelled = '発送の取消'`、`RESENDABLE_ORDER_STATUSES.shipped = ['paid', 'shipped']`。このタスクの worker は取りやめの理由 `'fulfillment_cancelled'` を `OrderEmailSkipReason` として返すので、型の確かめ（`npx tsc --noEmit`）は Task 2 が済んでいる前提
  - 既存: `isShippingCarrierId`・`SHIPPING_CARRIERS`・`toOrderNumber`・`formatItemLines`
- Produces（共通の約束 C-2「注文のメールの部品（Task 4）」のとおり）:
  - `order-email-store.ts`: `ClaimedOrderEmail.fulfillmentId: string | null`・`requestOrderEmailResend(store, { orderId, kind, actorId, fulfillmentId?: string | null })`（`_fulfillment_id: fulfillmentId ?? null` を渡し、`RESEND_FULFILLMENT_REQUIRED` は `OrderEmailResendError('not_allowed')`）・`listOrderEmailHistory` が返す行の `fulfillmentId: string | null; fulfillmentNumber: number | null`・小さな部品 `numberOrNull(value)`
  - `order-history.ts`: 型 `OrderEmailHistoryRow` に `fulfillmentId: string | null; fulfillmentNumber: number | null`
  - `order-email-compose.ts`: 型 `OrderEmailFulfillmentMaterial`（`{ number; carrier; trackingNumber; completesOrder; cancelled; lines }`）・`OrderEmailMaterial.fulfillment: OrderEmailFulfillmentMaterial | null`・`loadOrderEmailMaterial(store, orderId, fulfillmentId: string | null = null)`・`OrderEmailMaterialError.table` に `'order_fulfillments' | 'order_fulfillment_lines'`
  - `order-confirmation-email.ts`: 型 `ShipmentItem`・`formatShipmentItemLines(items)`
  - `order-email-worker.ts`: `OrderEmailWorkerDeps.loadMaterial(orderId: string, fulfillmentId: string | null)`・`skipReasonFor` が発送のメールで発送が取り消されていれば `'fulfillment_cancelled'`

決め事（本計画 P1〜P14 の続き）:
- **T4-1 注文のメールの材料から、注文の行の `shipping_carrier`・`tracking_number` を外す**（`MATERIAL_ORDER_COLUMNS` と `OrderEmailMaterialRow`）。理由: 注文の行の組は「全部を送った時の値」で、一部だけ送った間は空、発送の取消で空に戻る。材料に残すと、読み間違えても空になるだけで気づけない。配送業者と伝票番号は発送の記録（`order_fulfillments`）だけから読む
- **T4-2 取り消した発送も材料として読み、`cancelled: true` で返す**。取消を見て取りやめにするのは worker（`skipReasonFor`）。理由: 材料を `null` にすると「注文の情報が足りない（`source_missing`）」の送れなかったになり、店への「送れなかった」の知らせが出てしまう。発送の取消は誤りではないので、履歴には「取りやめ（発送の取消）」と残す
- **T4-3 発送の材料は、発送の番号に加えて注文の番号でも絞って読む**。理由: 取り出した行の注文と発送の組が食い違っても、ほかの注文の発送の中身を、この注文のお客様へ送らない（食い違えば材料なしの `source_missing` になる）
- **T4-4 取消の確かめは、控えた中身（やり直しの行）を使う判断より先**（今の `skipReasonFor` の位置のまま）。理由: 送る前・やり直し待ちの行は取消の時に DB が取りやめるが、送っている途中だった行がやり直しの待ちに入った後でも、取り消した発送のメールは送らない
- **T4-5 注文の確認の1行は、品の行（お届けの目安の行を含む）の直下に、前後に空行を1つずつ置いて書く**。設計書は位置を「ご注文内容の下」としか書かない。品の行に続けて書くと品の説明に見えるため、独立した1行にする。お届けの目安を書かない注文（`review_reason = 'stock_not_reserved'`）は、この1行も書かない
- **T4-6 `OrderEmailHistoryRow`（履歴の行の型）はこのタスクで広げる**。型の置き場が `order-history.ts`（Task 5 の持ち場）だが、ストアの組み立てが使うため。履歴の組み立て（`buildOrderHistory`）と画面は Task 5・6

試験の流し方の注意: この repo の ts-jest は、`tsconfig.json` の `isolatedModules: true` により型を検査せずに流す。型の食い違い（見本の項目の足りなさなど）は jest では出ないので、Step 9 の `npx tsc --noEmit` で見る。次の「FAIL」は、どれも実行時の確かめが外れる失敗。

本物の DB でしか確かめられないこと: `order_fulfillment_lines` から `order_items` を埋め込んで読む所（`MATERIAL_FULFILLMENT_LINE_COLUMNS`）は、PostgREST が外部キーから関係を見つけることに頼る。このタスクの単体の試験は、読み方（列・絞り込み・形の変換）だけを確かめる。本物の確かめは Task 10 の FR-ADMIN-071（手元の DB で worker を動かし、Mailpit の本文を数える）が行う。そこで「関係が見つからない」誤りが出たら、`order_fulfillment_lines` を `order_item_id, quantity` で読み、`order_items` を `.in('id', …)` で読んで組み合わせる形に直す。

このタスクの試験が確かめる Review Focus: 3（取り消した発送のメールの取りやめ。送る前・やり直し待ちの行は Task 2 の DB が取りやめ、送っている途中だった行はここの worker が取消を見て取りやめる）と、5（前からの発送の写しの再送と本文。全部を送った発送として、残りの案内なしで書く）。

- [ ] **Step 1: 取り出した行・履歴の行・再送の依頼の試験を書く**

`tests/unit/lib/orders/email/order-email-store.test.ts` を次の内容にする（取り出した行の見本に発送の番号を足し、発送のメールの行・履歴の行・再送の依頼の試験を足す）:

```ts
import {
  claimOrderEmail,
  failOrderEmail,
  getOrderEmailSendState,
  listOrderEmailHistory,
  OrderEmailStoreError,
  requestOrderEmailResend,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

function storeReturning(data: unknown, error: { message?: string; code?: string } | null = null) {
  const rpc = jest.fn(async () => ({ data, error }));
  return { store: { rpc } as unknown as OrderEmailStore, rpc };
}

const claimRow = {
  email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
  lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null,
};

const historyRow = {
  variant: null, origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1, last_error_code: null,
  delivery_status: null, delivery_event_at: null, created_at: '2026-10-10T01:00:00.000Z', sent_at: '2026-10-10T01:00:05.000Z',
  finished_at: '2026-10-10T01:00:05.000Z', has_body: true, body_erased: false,
};

describe('order-email-store', () => {
  it('取り出した行を名前を変えて返す。無ければ null', async () => {
    const { store, rpc } = storeReturning([claimRow]);

    await expect(claimOrderEmail(store, 300)).resolves.toEqual({
      id: 'email-1', orderId: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      leaseToken: 'lease-1', subject: null, bodyText: null, paymentExpiredSent: false, fulfillmentId: null,
    });
    expect(rpc).toHaveBeenCalledWith('claim_order_email', { _lease_seconds: 300 });
    await expect(claimOrderEmail(storeReturning([]).store, 300)).resolves.toBeNull();
  });

  it('発送のメールの行は、どの発送のメールかを発送の番号で返す', async () => {
    const { store } = storeReturning([{ ...claimRow, email_id: 'email-2', kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' }]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({ id: 'email-2', kind: 'shipped', fulfillmentId: 'fulfillment-1' });
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

  it('履歴の行に発送の番号と何回目の発送かを足して返す。発送のメールでない行は両方 null', async () => {
    const { store, rpc } = storeReturning([
      { ...historyRow, email_id: 'email-2', kind: 'shipped', fulfillment_id: 'fulfillment-2', fulfillment_number: 2 },
      { ...historyRow, email_id: 'email-1', kind: 'paid', fulfillment_id: null, fulfillment_number: null },
    ]);

    const rows = await listOrderEmailHistory(store, 'order-1');

    expect(rpc).toHaveBeenCalledWith('list_order_email_history', { _order_id: 'order-1' });
    expect(rows.map((row) => [row.id, row.kind, row.fulfillmentId, row.fulfillmentNumber])).toEqual([
      ['email-2', 'shipped', 'fulfillment-2', 2],
      ['email-1', 'paid', null, null],
    ]);
  });
});

describe('requestOrderEmailResend', () => {
  const request = { orderId: 'order-1', kind: 'shipped', actorId: 'admin-1' } as const;

  it('発送の番号を DB の関数に渡す。渡さなければ null を渡す', async () => {
    const { store, rpc } = storeReturning('email-9');

    await expect(requestOrderEmailResend(store, { ...request, fulfillmentId: 'fulfillment-2' })).resolves.toBe('email-9');
    expect(rpc).toHaveBeenLastCalledWith('request_order_email_resend', {
      _order_id: 'order-1', _kind: 'shipped', _actor_id: 'admin-1', _fulfillment_id: 'fulfillment-2',
    });

    await requestOrderEmailResend(store, { orderId: 'order-1', kind: 'paid', actorId: 'admin-1' });
    expect(rpc).toHaveBeenLastCalledWith('request_order_email_resend', {
      _order_id: 'order-1', _kind: 'paid', _actor_id: 'admin-1', _fulfillment_id: null,
    });
  });

  it.each([
    ['RESEND_ALREADY_QUEUED', '23505', 'already_queued'],
    ['RESEND_NOT_ALLOWED', '22023', 'not_allowed'],
    ['RESEND_FULFILLMENT_REQUIRED', '22023', 'not_allowed'],
    ['ORDER_NOT_FOUND', 'P0002', 'order_not_found'],
  ])('DB が %s（%s）で断ったら OrderEmailResendError(%s) にする', async (message, code, reason) => {
    const { store } = storeReturning(null, { message, code });

    await expect(requestOrderEmailResend(store, request)).rejects.toMatchObject({ name: 'OrderEmailResendError', reason });
  });

  it('思いがけない DB の失敗は OrderEmailStoreError のまま返す', async () => {
    const { store } = storeReturning(null, { message: 'connection refused', code: '08006' });

    const failure = requestOrderEmailResend(store, request);
    await expect(failure).rejects.toBeInstanceOf(OrderEmailStoreError);
    await expect(failure).rejects.toMatchObject({ operation: 'request_order_email_resend', code: '08006' });
  });
});
```

窓口の試験（`tests/unit/api/admin/order-email-routes.test.ts` の183行目）を直す。発送の番号を渡さない種類でも、DB の関数には `_fulfillment_id: null` が渡るようになるため:

```ts
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', { _order_id: ORDER_ID, _kind: 'paid', _actor_id: 'admin-1', _fulfillment_id: null });
```

Run: `npx jest tests/unit/lib/orders/email/order-email-store.test.ts tests/unit/api/admin/order-email-routes.test.ts --runInBand`
Expected: FAIL（store の試験5件 — 取り出した行・発送のメールの行・履歴の行・再送の依頼・`RESEND_FULFILLMENT_REQUIRED` の断り、窓口の試験1件 — DB の関数の引数に `_fulfillment_id` が無い）

- [ ] **Step 2: 取り出した行・履歴の行・再送の依頼を直す**

`src/lib/orders/email/order-email-store.ts` を4か所直す。

1つ目（`ClaimedOrderEmail`。61〜72行目）:

```ts
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
  /** 発送のメールだけ、どの発送のメールかを示す。ほかの種類は null（グループ E-1 設計書 8-1） */
  fulfillmentId: string | null;
};
```

2つ目（`dateOrNull` の次に `numberOrNull` を足し、`claimOrderEmail` に発送の番号を足す。102〜121行目）:

```ts
export function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
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
    fulfillmentId: textOrNull(row.fulfillment_id),
  };
}
```

3つ目（`requestOrderEmailResend`。307〜326行目。`OrderEmailResendError` はそのまま）:

```ts
/**
 * 管理画面の再送の行を足し、行の番号を返す（設計書 5-3）。DB の断りは OrderEmailResendError にする。
 * 発送のメールは、どの発送のメールかを発送の番号で渡す（グループ E-1 設計書 8-2）。ほかの種類は渡さない
 */
export async function requestOrderEmailResend(
  store: OrderEmailStore,
  request: { orderId: string; kind: OrderEmailKind; actorId: string; fulfillmentId?: string | null },
): Promise<string> {
  const { data, error } = await store.rpc('request_order_email_resend', {
    _order_id: request.orderId,
    _kind: request.kind,
    _actor_id: request.actorId,
    _fulfillment_id: request.fulfillmentId ?? null,
  });
  if (error) {
    const message = error.message ?? '';
    if (message.includes('RESEND_ALREADY_QUEUED')) throw new OrderEmailResendError('already_queued');
    // 発送の番号の無い発送のメールの再送は、状態が合わない再送と同じ「できない」にする（画面は発送の番号を必ず付ける）
    if (message.includes('RESEND_NOT_ALLOWED') || message.includes('RESEND_FULFILLMENT_REQUIRED')) {
      throw new OrderEmailResendError('not_allowed');
    }
    if (message.includes('ORDER_NOT_FOUND')) throw new OrderEmailResendError('order_not_found');
    throw new OrderEmailStoreError('request_order_email_resend', error);
  }
  if (typeof data !== 'string') throw new OrderEmailStoreError('request_order_email_resend', null);
  return data;
}
```

4つ目（`listOrderEmailHistory`。328〜346行目）:

```ts
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
    fulfillmentId: textOrNull(row.fulfillment_id),
    fulfillmentNumber: numberOrNull(row.fulfillment_number),
  }));
}
```

`src/lib/orders/email/order-history.ts` の型 `OrderEmailHistoryRow`（43〜58行目）に2つの項目を足す（型だけ。`buildOrderHistory` は Task 5 が直す）:

```ts
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
  /** 発送のメールだけ、どの発送のメールか・何回目の発送かを示す。ほかの種類は null（グループ E-1 設計書 8-2） */
  fulfillmentId: string | null;
  fulfillmentNumber: number | null;
};
```

`tests/unit/lib/orders/email/order-history.test.ts` の見本の行（6〜12行目）に2つの項目を足す（型の確かめ `npx tsc --noEmit` で、足りない項目を指摘されないようにするため）:

```ts
function email(overrides: Partial<OrderEmailHistoryRow> = {}): OrderEmailHistoryRow {
  return {
    id: 'email-1', kind: 'paid', origin: 'auto', requestedByEmail: null, status: 'sent', attempts: 1, lastErrorCode: null,
    deliveryStatus: null, deliveryEventAt: null, createdAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:05.000Z',
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, fulfillmentId: null, fulfillmentNumber: null, ...overrides,
  };
}
```

Run: `npx jest tests/unit/lib/orders/email/order-email-store.test.ts tests/unit/lib/orders/email/order-history.test.ts tests/unit/api/admin/order-email-routes.test.ts --runInBand`
Expected: PASS

- [ ] **Step 3: 発送の明細の行の試験を書く**

`tests/unit/lib/orders/order-confirmation-email.test.ts` を次の内容にする（今の試験はそのままで、発送の明細の行の試験を足す）:

```ts
import { formatItemLines, formatShipmentItemLines } from '@/lib/orders/order-confirmation-email';

describe('明細ごとのお届けの目安（グループ F 設計書 5-3）', () => {
  test('目安を出す指定のときだけ、明細の次の行に在庫あり・受注生産の目安を添える', () => {
    const items = [
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
      { item_name: 'ウールパンツ', color: null, size: 'L', quantity: 2, line_total: 36000, fulfillment_type: 'backorder' },
      { item_name: '目安の無い明細', quantity: 1, line_total: 1000, fulfillment_type: null },
    ];

    expect(formatItemLines(items, 'jpy', { withFulfillment: true })).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000\n　在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送',
      '・ウールパンツ（L） x2　￥36,000\n　受注生産・発送まで数週間〜2か月以上（目安）',
      '・目安の無い明細 x1　￥1,000',
    ]);
    expect(formatItemLines(items, 'jpy')).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000',
      '・ウールパンツ（L） x2　￥36,000',
      '・目安の無い明細 x1　￥1,000',
    ]);
  });
});

describe('発送のメールの明細の行（グループ E-1 設計書 8-1）', () => {
  test('商品名・色 / サイズ・数だけを並べる。色もサイズも無ければ括弧を付けない', () => {
    expect(formatShipmentItemLines([
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1 },
      { item_name: 'ウールパンツ', color: null, size: 'L', quantity: 2 },
      { item_name: 'ストール', color: null, size: null, quantity: 3 },
    ])).toEqual([
      '・シルクブラウス（WHITE / M） x1',
      '・ウールパンツ（L） x2',
      '・ストール x3',
    ]);
  });

  test('注文の明細（値段の項目を持つ）を渡しても、値段は書かない', () => {
    const orderItems = [
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
    ];

    const lines = formatShipmentItemLines(orderItems);

    expect(lines).toEqual(['・シルクブラウス（WHITE / M） x1']);
    expect(lines.join('\n')).not.toContain('￥');
  });
});
```

Run: `npx jest tests/unit/lib/orders/order-confirmation-email.test.ts --runInBand`
Expected: FAIL（2件。`formatShipmentItemLines is not a function`）

- [ ] **Step 4: 発送の明細の行を足す**

`src/lib/orders/order-confirmation-email.ts` の `formatItemLines`（29〜46行目）を次に置き換える。品の名前の組み立て（`itemLabel`）を小さな関数に出して、確定メールの明細と発送のメールの明細で同じ書き方を使う（`formatItemLines` の出力は変わらない）:

```ts
function itemLabel(item: { item_name: string; color?: string | null; size?: string | null }): string {
  const variant = [item.color, item.size].filter(Boolean).join(' / ');
  return variant ? `${item.item_name}（${variant}）` : item.item_name;
}

/** 明細の行。確定メールでは、受け付けで決まったお届けの目安を次の行に添える（グループ F 設計書 5-3） */
export function formatItemLines(
  items: ConfirmationItem[],
  currency: string,
  options: { withFulfillment?: boolean } = {},
): string[] {
  return items.map((item) => {
    const line = `・${itemLabel(item)} x${item.quantity}　${formatCurrency(item.line_total, currency)}`;
    const fulfillment =
      item.fulfillment_type === 'stock' || item.fulfillment_type === 'backorder' ? item.fulfillment_type : null;
    if (!options.withFulfillment || !fulfillment) {
      return line;
    }
    return `${line}\n　${FULFILLMENT_HEADINGS[fulfillment]}・${FINAL_FULFILLMENT_LABELS[fulfillment]}`;
  });
}

export type ShipmentItem = { item_name: string; color?: string | null; size?: string | null; quantity: number };

/**
 * 発送のメールの明細の行（グループ E-1 設計書 8-1）。値段は書かない。
 * 一部だけ送ると、注文の行の値段と送った数が合わなくなるため。
 */
export function formatShipmentItemLines(items: readonly ShipmentItem[]): string[] {
  return items.map((item) => `・${itemLabel(item)} x${item.quantity}`);
}
```

Run: `npx jest tests/unit/lib/orders/order-confirmation-email.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: 発送のメール・注文の確認の1行・材料の読み込みの試験を書く**

`tests/unit/lib/orders/email/order-email-compose.test.ts` を次の内容にする（今の試験からの違い: 見本の注文の行から配送業者・伝票番号を外し、見本に `fulfillment` を足した。「発送は配送業者と追跡のリンクを出す…」の it を、発送ごとの試験に置き換えた。注文の確認の1行の試験を足した。材料の読み込みの試験に、発送の番号がある時を足した）:

```ts
import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailFulfillmentMaterial,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1b2c3d4-1111-2222-8333-444455556666';
const SPLIT_SHIPMENT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';
const REMAINING_ITEMS_NOTICE = '残りの商品は、準備ができ次第お送りします。';
const SHIPPED = { kind: 'shipped', variant: null, paymentExpiredSent: false } as const;

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
      ...overrides,
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'backorder' }],
    fulfillment: null,
  };
}

/** 発送のメールの材料。既定は、全部を送った発送（残りの案内なし） */
function shipment(overrides: Partial<OrderEmailFulfillmentMaterial> = {}): OrderEmailFulfillmentMaterial {
  return {
    number: 1,
    carrier: 'yamato',
    trackingNumber: '1234-5678',
    completesOrder: true,
    cancelled: false,
    lines: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 }],
    ...overrides,
  };
}

const STOCK_ONLY_ITEMS: OrderEmailMaterial['items'] = [
  { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'stock' },
];

const STOCK_AND_BACKORDER_ITEMS: OrderEmailMaterial['items'] = [
  { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 6000, fulfillment_type: 'stock' },
  { item_name: 'パンツ', color: 'NAVY', size: 'L', quantity: 1, line_total: 4000, fulfillment_type: 'backorder' },
];

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

  it.each([
    ['入金済み', 'paid', 'order_confirmed', 'paid'],
    ['入金済み（入金を確認した）', 'paid', 'payment_received', 'paid'],
    ['入金済み（期限切れの後の入金）', 'paid', 'payment_received_after_expiry', 'paid'],
    ['入金待ち', 'awaiting_payment', null, 'pending'],
  ] as const)('在庫の品と受注生産の品が両方ある注文の確認（%s）には、先に在庫の品を送る案内を品の行の下に1行足す', (_label, kind, variant, status) => {
    const email = composeOrderEmail(
      { ...material({ status }), items: STOCK_AND_BACKORDER_ITEMS },
      { kind, variant, paymentExpiredSent: true },
    );

    // 品の行（お届けの目安の行を含む）の直下で、前後を空行で区切る
    expect(email?.text).toContain(
      ['　受注生産・発送まで数週間〜2か月以上（目安）', '', SPLIT_SHIPMENT_NOTICE, '', '小計: ￥10,000'].join('\n'),
    );
    expect(email?.text.split(SPLIT_SHIPMENT_NOTICE)).toHaveLength(2);
  });

  const noNoticeCases: Array<[string, OrderEmailMaterial]> = [
    ['在庫の品だけ', { ...material(), items: STOCK_ONLY_ITEMS }],
    ['受注生産の品だけ', material()],
    ['両方あっても在庫を確保し直せなかった', { ...material({ review_reason: 'stock_not_reserved' }), items: STOCK_AND_BACKORDER_ITEMS }],
  ];

  it.each(noNoticeCases)('%s の注文の確認には、先に在庫の品を送る案内を足さない', (_label, source) => {
    const email = composeOrderEmail(source, { kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false });
    expect(email?.text).not.toContain(SPLIT_SHIPMENT_NOTICE);
  });

  it('注文の確認でない種類のメールには、両方の品がある注文でも案内を足さない', () => {
    const both = { ...material({ status: 'failed' }), items: STOCK_AND_BACKORDER_ITEMS };

    expect(composeOrderEmail(both, { kind: 'payment_expired', variant: null, paymentExpiredSent: false })?.text)
      .not.toContain(SPLIT_SHIPMENT_NOTICE);
    expect(composeOrderEmail(both, { kind: 'canceled', variant: 'pending', paymentExpiredSent: false })?.text)
      .not.toContain(SPLIT_SHIPMENT_NOTICE);
    expect(composeOrderEmail({ ...both, fulfillment: shipment() }, SHIPPED)?.text).not.toContain(SPLIT_SHIPMENT_NOTICE);
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

  it('全部を送った発送（前からの発送の写しも同じ）は、その発送の商品・配送業者・追跡のリンクを書き、値段と残りの案内は書かない', () => {
    const email = composeOrderEmail({ ...material({ status: 'shipped' }), fulfillment: shipment() }, SHIPPED);

    expect(email).toEqual({
      subject: '【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文の商品を発送いたしました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        '発送した商品:',
        '・コート（BLACK / M） x1',
        '',
        '配送業者: ヤマト運輸',
        '追跡番号: 1234-5678',
        '追跡はこちら: https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678',
        '',
        '※ 追跡情報は反映までに数時間かかる場合があります。',
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
  });

  it('未発送の品が残る発送だけ、残りの案内を※の行の次に書く。書く商品はその発送の商品だけ', () => {
    const email = composeOrderEmail(
      {
        ...material({ status: 'paid' }),
        items: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2, line_total: 20000, fulfillment_type: 'stock' },
          { item_name: 'ストール', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' },
          { item_name: 'ブーツ', color: 'BROWN', size: '25', quantity: 1, line_total: 30000, fulfillment_type: 'backorder' },
        ],
        fulfillment: shipment({
          number: 2,
          completesOrder: false,
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2 },
            { item_name: 'ストール', color: null, size: null, quantity: 1 },
          ],
        }),
      },
      SHIPPED,
    );

    expect(email?.text).toContain(
      ['発送した商品:', '・コート（BLACK / M） x2', '・ストール x1', '', '配送業者: ヤマト運輸'].join('\n'),
    );
    expect(email?.text).toContain(
      ['※ 追跡情報は反映までに数時間かかる場合があります。', REMAINING_ITEMS_NOTICE, '', 'お問い合わせの際は'].join('\n'),
    );
    // まだ送らない品の名前と、値段は書かない
    expect(email?.text).not.toContain('ブーツ');
    expect(email?.text).not.toContain('￥');
  });

  const unsendableShipments: Array<[string, OrderEmailMaterial['fulfillment']]> = [
    ['発送の材料が無い', null],
    ['配送業者が空', shipment({ carrier: null })],
    ['配送業者が知らない業者', shipment({ carrier: 'unknown' })],
    ['伝票番号が空', shipment({ trackingNumber: null })],
    ['伝票番号が空白だけ', shipment({ trackingNumber: '  ' })],
  ];

  it.each(unsendableShipments)('発送のメールは、%s なら作らない（前からの発送の記録で空のものも同じ）', (_label, fulfillment) => {
    expect(composeOrderEmail({ ...material({ status: 'shipped' }), fulfillment }, SHIPPED)).toBeNull();
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
  const FULFILLMENT_ROW = {
    number: 2, shipping_carrier: 'sagawa', tracking_number: '9876-5432', completes_order: false, cancelled_at: null,
  };
  const FULFILLMENT_LINE_ROWS = [
    { quantity: 2, order_items: { item_name: 'コート', color: 'BLACK', size: 'M' } },
    { quantity: 1, order_items: { item_name: 'ストール', color: null, size: null } },
  ];

  type FilterChain = {
    eq: (column: string, value: unknown) => FilterChain;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  };

  function store(results: {
    order: unknown; orderError?: unknown; items?: unknown; itemsError?: unknown;
    fulfillment?: unknown; fulfillmentError?: unknown; lines?: unknown; linesError?: unknown;
  }) {
    const orderSelect = jest.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: results.order, error: results.orderError ?? null }) }) }));
    const itemSelect = jest.fn(() => ({ eq: async () => ({ data: results.items ?? null, error: results.itemsError ?? null }) }));
    const fulfillmentFilters: Array<[string, unknown]> = [];
    const fulfillmentChain: FilterChain = {
      eq: (column, value) => {
        fulfillmentFilters.push([column, value]);
        return fulfillmentChain;
      },
      maybeSingle: async () => ({ data: results.fulfillment ?? null, error: results.fulfillmentError ?? null }),
    };
    const fulfillmentSelect = jest.fn(() => fulfillmentChain);
    const lineFilters: Array<[string, unknown]> = [];
    const lineSelect = jest.fn(() => ({
      eq: async (column: string, value: unknown) => {
        lineFilters.push([column, value]);
        return { data: results.lines ?? null, error: results.linesError ?? null };
      },
    }));
    const from = jest.fn((table: string) => {
      if (table === 'orders') {
        return { select: orderSelect };
      }
      if (table === 'order_fulfillments') {
        return { select: fulfillmentSelect };
      }
      if (table === 'order_fulfillment_lines') {
        return { select: lineSelect };
      }
      return { select: itemSelect };
    });
    return { client: { from } as never, from, orderSelect, itemSelect, fulfillmentSelect, fulfillmentFilters, lineSelect, lineFilters };
  }

  it('注文と明細を読む。注文の状態は読むが、配送業者・伝票番号は注文の行から読まない', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID)).resolves.toEqual({ order, items, fulfillment: null });
    const columns = (db.orderSelect.mock.calls[0] as unknown as [string])[0].split(',').map((column) => column.trim());
    expect(columns).toEqual([
      'id', 'status', 'shipping_email', 'shipping_full_name', 'subtotal_amount', 'shipping_amount', 'discount_amount',
      'total_amount', 'currency', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address',
      'shipping_building', 'shipping_phone', 'review_reason',
    ]);
    expect(db.itemSelect).toHaveBeenCalledWith('item_name, color, size, quantity, line_total, fulfillment_type');
    // 発送の番号が無い種類は、発送の表を読まない
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillments');
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillment_lines');
  });

  it('発送の番号があれば、その発送の配送業者・伝票番号・商品を読む（注文の番号でも絞る）', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items, fulfillment: FULFILLMENT_ROW, lines: FULFILLMENT_LINE_ROWS });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, FULFILLMENT_ID)).resolves.toEqual({
      order,
      items,
      fulfillment: {
        number: 2,
        carrier: 'sagawa',
        trackingNumber: '9876-5432',
        completesOrder: false,
        cancelled: false,
        lines: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2 },
          { item_name: 'ストール', color: null, size: null, quantity: 1 },
        ],
      },
    });
    expect(db.fulfillmentSelect).toHaveBeenCalledWith('number, shipping_carrier, tracking_number, completes_order, cancelled_at');
    expect(db.fulfillmentFilters).toEqual([['id', FULFILLMENT_ID], ['order_id', ORDER_ID]]);
    expect(db.lineSelect).toHaveBeenCalledWith('quantity, order_items(item_name, color, size)');
    expect(db.lineFilters).toEqual([['fulfillment_id', FULFILLMENT_ID]]);
  });

  it('取り消した発送も読み、取消済みの印を付けて返す（送るかどうかは worker が決める）', async () => {
    const db = store({
      order: material().order,
      items: material().items,
      fulfillment: { ...FULFILLMENT_ROW, cancelled_at: '2026-10-10T03:00:00.000Z' },
      lines: FULFILLMENT_LINE_ROWS,
    });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, FULFILLMENT_ID)).resolves.toMatchObject({
      fulfillment: { number: 2, cancelled: true },
    });
  });

  it('注文が無い・明細が0件なら null。発送の番号がある時は、発送が無い・発送の商品が0件でも null', async () => {
    const order = material().order;
    const items = material().items;

    await expect(loadOrderEmailMaterial(store({ order: null }).client, ORDER_ID)).resolves.toBeNull();
    await expect(loadOrderEmailMaterial(store({ order, items: [] }).client, ORDER_ID)).resolves.toBeNull();
    // 発送が無い（別の注文の発送の番号を渡して絞り込みで見つからない場合も同じ）
    await expect(loadOrderEmailMaterial(store({ order, items }).client, ORDER_ID, FULFILLMENT_ID)).resolves.toBeNull();
    // 発送はあるが、発送の商品が0件
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillment: FULFILLMENT_ROW, lines: [] }).client, ORDER_ID, FULFILLMENT_ID),
    ).resolves.toBeNull();
  });

  it('読めなければ OrderEmailMaterialError を投げる', async () => {
    const order = material().order;
    const items = material().items;

    await expect(loadOrderEmailMaterial(store({ order: null, orderError: { message: 'down' } }).client, ORDER_ID)).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order, itemsError: { message: 'down' } }).client, ORDER_ID),
    ).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillmentError: { message: 'down' } }).client, ORDER_ID, FULFILLMENT_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_fulfillments' });
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillment: FULFILLMENT_ROW, linesError: { message: 'down' } }).client, ORDER_ID, FULFILLMENT_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_fulfillment_lines' });
  });
});
```

Run: `npx jest tests/unit/lib/orders/email/order-email-compose.test.ts --runInBand`
Expected: FAIL（12件）— 注文の確認の案内の4件（案内が入っていない）、「注文の確認でない種類」の1件（発送のメールが `null`）、発送のメールの2件（`Received: null`）、材料の読み込みの5件（結果に `fulfillment` が無い・列に `shipping_carrier` が残っている・発送を読まない）

- [ ] **Step 6: 材料の読み込みと本文の組み立てを直す**

`src/lib/orders/email/order-email-compose.ts` を次の内容にする（ファイル全体。今のファイルとの違い: 材料の列から配送業者・伝票番号を外した・発送の材料と読み込みを足した・注文の確認に1行・発送のメールの本文。ほかの関数は今のまま）:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  formatCurrency,
  formatItemLines,
  formatShipmentItemLines,
  type ConfirmationItem,
  type OrderEmailRow,
} from '@/lib/orders/order-confirmation-email';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { OrderEmailKind, OrderEmailVariant } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの材料を読み、件名と本文を作る（グループ D 設計書 4-2）。
 * 文面は今までのメール（注文確認・入金待ち・期限切れ・取消・発送）と同じにする。
 * 件名は固定の文と注文番号だけで組み、氏名や商品名は本文にだけ入れる（メールの見出しへの差し込みを防ぐ）。
 * 発送のメールは発送ごとに作り、その発送の商品と数・配送業者・伝票番号を発送の記録から読む（グループ E-1 設計書 8-1）。
 */
const SHOP_NAME = 'Le Fil des Heures';

// 配送業者と伝票番号は注文の行から読まない。注文の行の組は「全部を送った時の値」で、一部だけ送った間は空になるため
const MATERIAL_ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone, review_reason';

const MATERIAL_FULFILLMENT_COLUMNS = 'number, shipping_carrier, tracking_number, completes_order, cancelled_at';
const MATERIAL_FULFILLMENT_LINE_COLUMNS = 'quantity, order_items(item_name, color, size)';

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

/** 在庫の品と受注生産の品が両方ある注文の確認に添える1行（グループ E-1 設計書 8-3） */
const SPLIT_SHIPMENT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';

/** 未発送の品が残る発送のメールに添える1行（グループ E-1 設計書 8-1） */
const REMAINING_ITEMS_NOTICE = '残りの商品は、準備ができ次第お送りします。';

export type OrderEmailMaterialRow = OrderEmailRow & { status: OrderStatus };

/**
 * 発送のメールの材料。発送の記録から読む。
 * 取り消した発送も読み、取消済みの印を付ける（送るかどうかは worker が決める）。
 */
export type OrderEmailFulfillmentMaterial = {
  number: number;
  carrier: string | null;
  trackingNumber: string | null;
  completesOrder: boolean;
  cancelled: boolean;
  lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number }>;
};

export type OrderEmailMaterial = {
  order: OrderEmailMaterialRow;
  items: ConfirmationItem[];
  /** 発送のメールの時だけ読む。ほかの種類は null */
  fulfillment: OrderEmailFulfillmentMaterial | null;
};

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
    readonly table: 'orders' | 'order_items' | 'order_fulfillments' | 'order_fulfillment_lines',
    options?: { cause?: unknown },
  ) {
    super(`order email material could not be read: ${table}`, options);
    this.name = 'OrderEmailMaterialError';
  }
}

type FulfillmentRow = {
  number: number;
  shipping_carrier: string | null;
  tracking_number: string | null;
  completes_order: boolean;
  cancelled_at: string | null;
};

type FulfillmentLineRow = {
  quantity: number;
  order_items: { item_name: string; color: string | null; size: string | null };
};

/** その注文の発送と発送の商品を読む。発送が無い・発送の商品が0件なら null（送れない）。取り消した発送も読む */
async function loadFulfillmentMaterial(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
  fulfillmentId: string,
): Promise<OrderEmailFulfillmentMaterial | null> {
  // 注文の番号でも絞る。取り出した行の注文と発送の組が食い違っても、ほかの注文の発送の中身をこの注文のお客様へ送らない
  const { data: fulfillment, error: fulfillmentError } = await store
    .from('order_fulfillments')
    .select(MATERIAL_FULFILLMENT_COLUMNS)
    .eq('id', fulfillmentId)
    .eq('order_id', orderId)
    .maybeSingle<FulfillmentRow>();
  if (fulfillmentError) {
    throw new OrderEmailMaterialError('order_fulfillments', { cause: fulfillmentError });
  }
  if (!fulfillment) {
    return null;
  }

  const { data, error: linesError } = await store
    .from('order_fulfillment_lines')
    .select(MATERIAL_FULFILLMENT_LINE_COLUMNS)
    .eq('fulfillment_id', fulfillmentId);
  if (linesError) {
    throw new OrderEmailMaterialError('order_fulfillment_lines', { cause: linesError });
  }
  const lines = (data ?? []) as unknown as FulfillmentLineRow[];
  if (lines.length === 0) {
    return null;
  }

  return {
    number: fulfillment.number,
    carrier: fulfillment.shipping_carrier,
    trackingNumber: fulfillment.tracking_number,
    completesOrder: fulfillment.completes_order,
    cancelled: fulfillment.cancelled_at !== null,
    lines: lines.map((line) => ({
      item_name: line.order_items.item_name,
      color: line.order_items.color,
      size: line.order_items.size,
      quantity: line.quantity,
    })),
  };
}

/**
 * 注文行と明細を読む。発送の番号があれば、その発送も読む。
 * 注文が無い・明細が0件・発送が無い・発送の商品が0件なら null（送れない）。読めなければ OrderEmailMaterialError を投げる
 */
export async function loadOrderEmailMaterial(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
  fulfillmentId: string | null = null,
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

  if (fulfillmentId === null) {
    return { order, items: items as ConfirmationItem[], fulfillment: null };
  }

  const fulfillment = await loadFulfillmentMaterial(store, orderId, fulfillmentId);
  if (!fulfillment) {
    return null;
  }
  return { order, items: items as ConfirmationItem[], fulfillment };
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

/** 在庫の品と受注生産の品が両方ある注文だけ、先に在庫の品を送る案内を出す（グループ E-1 設計書 8-3） */
function hasStockAndBackorder(items: ConfirmationItem[]): boolean {
  return items.some((item) => item.fulfillment_type === 'stock') && items.some((item) => item.fulfillment_type === 'backorder');
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
  // お届けの目安も、先に在庫の品を送る案内も書かない。
  const canPromiseDelivery = order.review_reason !== 'stock_not_reserved';
  const itemLines = formatItemLines(items, order.currency, { withFulfillment: canPromiseDelivery });
  const showSplitShipmentNotice = canPromiseDelivery && hasStockAndBackorder(items);

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
    ...(showSplitShipmentNotice ? ['', SPLIT_SHIPMENT_NOTICE] : []),
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

/**
 * 発送の材料が無い・配送業者か伝票番号が無ければ作らない（送れない材料の不足）。
 * 値段は書かない。一部だけ送ると、注文の行の値段と送った数が合わなくなるため（グループ E-1 設計書 8-1）。
 * 発送の取消は、ここでなく worker が先に見る。
 */
function composeShipped({ order, fulfillment }: OrderEmailMaterial): ComposedOrderEmail | null {
  const trackingNumber = fulfillment?.trackingNumber?.trim();
  if (!fulfillment || !isShippingCarrierId(fulfillment.carrier) || !trackingNumber) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  const carrier = SHIPPING_CARRIERS[fulfillment.carrier];
  return {
    subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'ご注文の商品を発送いたしました。',
      '',
      `注文番号: ${orderNumber}`,
      '',
      '発送した商品:',
      ...formatShipmentItemLines(fulfillment.lines),
      '',
      `配送業者: ${carrier.label}`,
      `追跡番号: ${trackingNumber}`,
      `追跡はこちら: ${carrier.trackingUrl(trackingNumber)}`,
      '',
      '※ 追跡情報は反映までに数時間かかる場合があります。',
      // 未発送の品が残る発送だけ、残りの案内を添える
      ...(fulfillment.completesOrder ? [] : [REMAINING_ITEMS_NOTICE]),
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

Run: `npx jest tests/unit/lib/orders/email/order-email-compose.test.ts tests/unit/lib/orders/order-confirmation-email.test.ts --runInBand`
Expected: PASS

- [ ] **Step 7: worker の試験を直す**

`tests/unit/lib/orders/email/order-email-worker.test.ts` を5か所直す。ほかの it は今のまま。

1つ目（22行目の import。材料の型を足す）:

```ts
import { OrderEmailMaterialError, type OrderEmailFulfillmentMaterial, type OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
```

2つ目（26〜49行目。取り出した行の見本に発送の番号、材料の見本から配送業者・伝票番号を外して `fulfillment` を足し、発送の材料の見本を足す）:

```ts
type QueueRow = {
  email_id: string; order_id: string; kind: string; variant: string | null; origin: string; attempts: number;
  lease_token: string; subject: string | null; body_text: string | null; payment_expired_sent: boolean;
  fulfillment_id: string | null;
};

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
    lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null, ...overrides,
  };
}

function material(
  overrides: Partial<OrderEmailMaterial['order']> = {},
  fulfillment: OrderEmailMaterial['fulfillment'] = null,
): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
      subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
      shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
      shipping_building: null, shipping_phone: '0311112222', review_reason: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
    fulfillment,
  };
}

/** 発送のメールの材料。既定は、全部を送った発送（残りの案内なし） */
function fulfillmentMaterial(overrides: Partial<OrderEmailFulfillmentMaterial> = {}): OrderEmailFulfillmentMaterial {
  return {
    number: 1, carrier: 'yamato', trackingNumber: '1234-5678', completesOrder: true, cancelled: false,
    lines: [{ item_name: 'コート', color: null, size: null, quantity: 1 }],
    ...overrides,
  };
}
```

3つ目（`runOrderEmailWorker` の describe。147〜153行目の `beforeEach` に `mockClient.from.mockReset();` を足す。154行目の `afterEach` は残す）:

```ts
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
    mockClient.from.mockReset();
    // 実際の環境変数（VERCEL_ENV など）に左右されず、環境の門を通る環境で試す
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
  });
```

同じ describe の最後（「止める環境では DB に触れず、最後の成功も記録しない…」の it の直後、describe を閉じる `});` の前）に足す it。本物の読み込みの部品に、行の発送の番号が渡ることを確かめる。発送が見つからない材料にして、送らずに「材料が足りない」で終わらせる:

```ts
  it('発送のメールの行は、行の発送の番号で発送を読む（注文の番号でも絞る）', async () => {
    type FilterChain = {
      eq: (column: string, value: unknown) => FilterChain;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const filters: Array<[string, unknown]> = [];
    const fulfillmentQuery: FilterChain = {
      eq: (column, value) => {
        filters.push([column, value]);
        return fulfillmentQuery;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: material().order, error: null }) }) }) };
      }
      if (table === 'order_items') {
        return { select: () => ({ eq: async () => ({ data: material().items, error: null }) }) };
      }
      if (table === 'order_fulfillments') {
        return { select: () => fulfillmentQuery };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const claims = [[row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], []];
    mockClientRpc.mockImplementation(async (name: string) => ({
      data: name === 'claim_order_email' ? (claims.shift() ?? []) : 'dead',
      error: null,
    }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ failed: 1, stoppedBy: 'empty' });

    expect(filters).toEqual([['id', 'fulfillment-1'], ['order_id', 'order-1']]);
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });
```

4つ目（`processOrderEmails` の describe。第1の it「中身を作って送る前に控え…」の `expect(result)…` の次の行に、材料を読む時の引数の確かめを足す。210〜223行目）:

```ts
  it('中身を作って送る前に控え、行の番号の重複防止キーで送り、送信済みにする', async () => {
    const h = harness([row()]);

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    // 発送のメールでない行は、発送の番号を渡さずに材料を読む
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null);
    expect(names(h.calls)).toEqual(['claim_order_email', 'save_order_email_content', 'complete_order_email', 'claim_order_email']);
    const saved = h.calls[1].params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご注文ありがとうございます（ORD-ORDER-1）');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
    expect(h.calls[2].params).toEqual({ _email_id: 'email-1', _lease_token: 'lease-1', _provider_message_id: 're_1' });
  });
```

同じ describe の「宛先が無ければ取りやめにする」の it の次の行から、「注文や明細が無い・発送の伝票番号が無いときは、すぐ送れなかったにする」の it の終わりまで（257〜270行目）を、次の4つの it に置き換える。前の3つは新しい it で、最後の1つは今の it を、発送の材料を使う形に直したもの:

```ts
  it('発送のメールは、行の発送の番号で材料を読み、その発送の商品と残りの案内を書いて送る', async () => {
    const h = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-2' })], {
      material: material({ status: 'paid' }, fulfillmentMaterial({ number: 2, completesOrder: false })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', 'fulfillment-2');
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】商品を発送いたしました（ORD-ORDER-1）');
    expect(saved._body_text).toContain('・コート x1');
    expect(saved._body_text).toContain('残りの商品は、準備ができ次第お送りします。');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
  });

  it('発送が取り消されていたら、送らずに取りやめにする（送っている途中だった行は、ここで取消を見る）', async () => {
    const h = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], {
      material: material({ status: 'paid' }, fulfillmentMaterial({ cancelled: true })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
    expect(h.send).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('save_order_email_content');
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'fulfillment_cancelled',
    });
  });

  it('控えた中身がある行（やり直しの行）でも、発送が取り消されていたら送らない', async () => {
    const h = harness(
      [row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1', attempts: 2, subject: '控えた件名', body_text: '控えた本文' })],
      { material: material({ status: 'paid' }, fulfillmentMaterial({ cancelled: true })) },
    );

    await processOrderEmails(h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'fulfillment_cancelled' });
  });

  it('注文や明細が無い・発送の伝票番号が無いときは、すぐ送れなかったにする', async () => {
    const missing = harness([row()], { material: null });
    await processOrderEmails(missing.deps);
    expect(missing.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });

    const shipped = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], {
      material: material({ status: 'shipped' }, fulfillmentMaterial({ trackingNumber: null })),
    });
    await processOrderEmails(shipped.deps);
    expect(shipped.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(shipped.send).not.toHaveBeenCalled();
  });
```

5つ目（`skipReasonFor` の describe。398〜415行目）。今の `it.each` の次に、発送の取消の表を足す:

```ts
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

  it.each([
    ['shipped', false, null],
    ['shipped', true, 'fulfillment_cancelled'],
    // 発送の取消は発送のメールだけの理由。ほかの種類は、材料に取消済みの発送があっても見ない
    ['paid', true, null],
  ])('%s のメールは、発送が取消済み=%s なら %s（グループ E-1 設計書 7-3）', (kind, cancelled, expected) => {
    expect(skipReasonFor(claim(kind), material({ status: 'paid' }, fulfillmentMaterial({ cancelled })))).toBe(expected);
  });
});
```

Run: `npx jest tests/unit/lib/orders/email/order-email-worker.test.ts --runInBand`
Expected: FAIL（6件）— 第1の it（材料を読む時の引数が `('order-1', null)` でなく `('order-1')`）、発送のメールの it（発送の番号が渡っていない）、取消済みの発送の it の2件（取りやめにならず送られる）、`runOrderEmailWorker` の it（発送を読まず `filters` が空）、`skipReasonFor` の表の1件（`fulfillment_cancelled` でなく `null` を返す）

- [ ] **Step 8: worker を直す**

`src/lib/orders/email/order-email-worker.ts` を4か所直す。

1つ目（`OrderEmailWorkerDeps`。37〜44行目）:

```ts
export type OrderEmailWorkerDeps = {
  store: OrderEmailStore;
  /** 発送のメールの行は、行の発送の番号で発送の材料も読む。ほかの種類は null（グループ E-1 設計書 8-1） */
  loadMaterial: (orderId: string, fulfillmentId: string | null) => Promise<OrderEmailMaterial | null>;
  send: (message: OrderEmailMessage) => Promise<OrderEmailSendOutcome>;
  checkConfig: () => OrderEmailPauseReason | null;
  now: () => number;
  budgetMs: number;
};
```

2つ目（`skipReasonFor`。82〜93行目）:

```ts
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
  // 発送を取り消した後は、その発送のメールを送らない。送る前・やり直し待ちの行は取消の時に DB が取りやめるので、
  // ここで見るのは、取消の時に送っている途中だった行。控えた中身がある行も送らない（グループ E-1 設計書 7-3）
  if (claim.kind === 'shipped' && material.fulfillment?.cancelled) return 'fulfillment_cancelled';
  return null;
}
```

3つ目（`deliver` の材料を読む所。109〜113行目）:

```ts
async function deliver(deps: OrderEmailWorkerDeps, claim: ClaimedOrderEmail): Promise<DeliverOutcome> {
  let material: OrderEmailMaterial | null;
  try {
    material = await deps.loadMaterial(claim.orderId, claim.fulfillmentId);
  } catch {
```

4つ目（`runOrderEmailWorker` の本物の依存。224行目）:

```ts
    loadMaterial: (orderId, fulfillmentId) => loadOrderEmailMaterial(client, orderId, fulfillmentId),
```

Run: `npx jest tests/unit/lib/orders/email/order-email-worker.test.ts --runInBand`
Expected: PASS

- [ ] **Step 9: まとめて確かめる**

Run: `npx jest tests/unit/lib/orders tests/unit/lib/ops tests/unit/api/admin/order-email-routes.test.ts tests/unit/api/admin/order-attention-route.test.ts --runInBand`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: エラー0件（見本の項目の足りなさ・`OrderEmailMaterial` の `fulfillment` の足りなさは、ここで見つかる）

Run: `npm run lint`
Expected: エラー0件

次の2つのファイルは変えない（変えていないことを下の `git diff` で確かめる）:
- `src/lib/ops/ops-alert-mail.ts`: 店への知らせは、種類の名前 `ORDER_EMAIL_KIND_LABELS[kind]`（発送は `発送` のまま）と、原因の名前 `ORDER_EMAIL_ERROR_LABELS`（新しい `発送の取消` は自動で入る）だけを使う。`fulfillment_cancelled` は取りやめ（`skipped`）の行にだけ付き、知らせの対象（送れなかった・届かなかった・溜まり）に出ない。同じ注文の発送のメールが複数届かなかった時は、知らせの行の文が同じになる（何回目かを足すには `list_unnotified_dead_order_emails` の列を変える必要があり、設計書の範囲の外。店は注文の履歴で発送ごとに見分ける）
- `src/lib/orders/email/order-email-ops.ts`: 一時停止・溜まり・送れなかった・届かなかった・worker の停止の点検だけで、発送のメールの作りに依らない

Run: `git diff --stat -- src/lib/ops src/lib/orders/email/order-email-ops.ts`
Expected: 何も出ない

- [ ] **Step 10: コミット（controller）**

```bash
git add src/lib/orders/email/order-email-store.ts src/lib/orders/email/order-history.ts src/lib/orders/email/order-email-compose.ts src/lib/orders/email/order-email-worker.ts src/lib/orders/order-confirmation-email.ts tests/unit/lib/orders/email/order-email-store.test.ts tests/unit/lib/orders/email/order-email-compose.test.ts tests/unit/lib/orders/email/order-email-worker.test.ts tests/unit/lib/orders/email/order-history.test.ts tests/unit/lib/orders/order-confirmation-email.test.ts tests/unit/api/admin/order-email-routes.test.ts
git commit -m "feat(email): 発送のメールを発送ごとに作り、注文の確認に分けて送る案内を足す（グループ E-1）

- 取り出した行・履歴の行に発送の番号を足し、再送の依頼に発送の番号を渡す
- 発送のメールを発送の記録から書く（その発送の商品と数・配送業者・伝票番号。値段なし・残りがある時だけ残りの案内）
- 発送が取り消されていたら、送らずに取りやめ（fulfillment_cancelled）にする。控えた中身がある行も送らない
- 在庫の品と受注生産の品が両方ある注文の確認・入金待ちのメールに、先に在庫の品を送る案内を1行足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 管理画面の窓口（発送・仕上がり・取消・再送・履歴）

**Files:**
- Create: `src/app/api/admin/orders/[id]/fulfillments/route.ts`（GET 発送の材料 / POST 発送する）
- Create: `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts`（POST 発送の取消）
- Create: `src/app/api/admin/orders/[id]/completions/route.ts`（POST 仕上がりの記録）
- Create: `src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts`（POST 仕上がりの取消）
- Modify: `src/app/api/admin/orders/[id]/status/route.ts`（20行目の import、31〜45行目の中身の形、76行目の説明、130〜163行目の発送の道を消す）
- Modify: `src/app/api/admin/orders/[id]/emails/resend/route.ts`（中身を `{ kind, fulfillmentId? }` にする。全体を置き換える）
- Modify: `src/lib/orders/email/order-history.ts`（型と `buildOrderHistory`。全体を置き換える）
- Modify: `src/app/api/admin/orders/[id]/history/route.ts`（発送・仕上がり・商品の名前を足す。全体を置き換える）
- Test（新規）: `tests/unit/api/admin/order-fulfillment-routes.test.ts`・`tests/unit/api/admin/order-completion-routes.test.ts`
- Modify: `src/components/OrderHistoryDialog.tsx:226`（履歴の型に行が増えても型が通るよう、メールでない行を描かない1か所だけ足す。描く作りは Task 6）
- Test（直す）: `tests/unit/api/admin/order-status-shipped.test.ts`（109〜214行目）、`tests/unit/api/admin/order-email-routes.test.ts`（全体を置き換える）、`tests/unit/lib/orders/email/order-history.test.ts`（全体を置き換える）、`tests/unit/components/OrderHistoryDialog.test.tsx`（型付きの見本2か所に2つの列）、`e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`（型付きの見本 `SENT_EMAIL` に2つの列）

**Interfaces:**
- Consumes:
  - Task 3: `createFulfillment`・`cancelFulfillment`・`recordCompletion`・`cancelCompletion`・`listOrderFulfillments`・`listOrderCompletions`・`listOrderLineFulfillment`・`FulfillmentOperationError`・`FulfillmentStoreError`・型 `OrderFulfillmentHistoryRow`・`OrderCompletionHistoryRow`（`fulfillment-store.ts`）、`loadFulfillmentMaterials`（`fulfillment-materials.ts`）、`FULFILLMENT_ERROR_MESSAGES`（記号 → `{ status, message }`）・`INVALID_REQUEST_BODY`・`fulfillmentErrorBody`・`fulfillmentFailureBody`（`fulfillment-messages.ts`）
  - Task 4: `requestOrderEmailResend(store, { orderId, kind, actorId, fulfillmentId? })`（DB の関数へ `_fulfillment_id` を渡す）、`listOrderEmailHistory` が返す行の `fulfillmentId`・`fulfillmentNumber`、型 `OrderEmailHistoryRow` の同じ2項目
  - 前の Task で済んでいること: `RESENDABLE_ORDER_STATUSES.shipped` が `['paid', 'shipped']`（共通の約束では Task 4 の持ち場）。Step 9 の試験が、一部だけ送った間（決済完了）の発送のメールを再送できることを確かめる
  - Task 2: DB の関数 `admin_create_fulfillment`・`admin_cancel_fulfillment`・`request_order_email_resend(…, _fulfillment_id)`
  - 既存: `authorizeAdminPermission`・`requireCsrfOrDeny`・`enforceRateLimit`・`logAudit`・`scheduleOrderEmailDelivery`・`SHIPPING_CARRIER_IDS`・`SHIPPING_CARRIERS`・`isShippingCarrierId`・`toOrderNumber`
- Produces:
  - `GET /api/admin/orders/[id]/fulfillments` → `FulfillmentMaterials`（`admin.orders.manage`。400・404・500。`Cache-Control: no-store`）
  - `POST /api/admin/orders/[id]/fulfillments`（本文 `CreateFulfillmentRequest`）→ 200 `CreateFulfillmentResponse`（`admin.orders.manage`・CSRF・回数の制限 `admin:orders:fulfillment-create` 10分に60回・監査 `admin.orders.fulfillment.create`。成功の後に `scheduleOrderEmailDelivery()`）
  - `POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel` → 200 `CancelFulfillmentResponse`（回数の制限 `admin:orders:fulfillment-cancel` 10分に30回・監査 `admin.orders.fulfillment.cancel`）
  - `POST /api/admin/orders/[id]/completions`（本文 `RecordCompletionRequest`）→ 200 `RecordCompletionResponse`（回数の制限 `admin:orders:completion-record` 10分に60回・監査 `admin.orders.completion.record`。お客様にメールは送らないので worker は動かさない）
  - `POST /api/admin/orders/[id]/completions/[completionId]/cancel` → 200 `CancelCompletionResponse`（回数の制限 `admin:orders:completion-cancel` 10分に30回・監査 `admin.orders.completion.cancel`）
  - 誤りの答えはどれも `{ error, code }`（`FulfillmentErrorResponse`）。DB が決まった言葉で断ったら 記号 → HTTP と言葉（400・404・409）、中身の形の誤りは 400 `invalid_request`、思いがけない失敗は 500 `failed`
  - `POST /api/admin/orders/[id]/emails/resend`（本文 `{ kind, fulfillmentId? }`）: 発送のメール（`kind: 'shipped'`）は `fulfillmentId` が要り、ほかの種類は持てない。ほかの答えは今のまま
  - `POST /api/admin/orders/[id]/status`: `status: 'shipped'` は 400。未入金の注文の取消だけ
  - `order-history.ts`: 型 `OrderHistoryLine`・`OrderHistoryFulfillmentEntry`・`OrderHistoryFulfillmentCancelEntry`・`OrderHistoryCompletionEntry`・`OrderHistoryCompletionCancelEntry`、`OrderEmailHistoryRow`・`OrderHistoryEmailEntry` に `fulfillmentId`・`fulfillmentNumber`、`OrderHistoryEntry` に4つの行、`BuildOrderHistoryInput` に `fulfillments`・`completions`・`lines`
  - `GET /api/admin/orders/[id]/history`: 発送・発送の取消・仕上がり・仕上がりの取消の行と、発送ごとのメールの行を含む

決め事（本計画 P3 の続き。共通の約束に書いていない所）:
- 監査の鍵に `number` を含めない。`maskAuditEvent` が `number` を含む鍵を `[REDACTED]` にするので、「何回目か」の鍵は `sequence` にする。伝票番号・宛先・氏名・住所は、そもそも入れない。
- 発送の取消の監査の「何回目か」は、取消が済んだ後に `listOrderFulfillments` で引く（`admin_cancel_fulfillment` の答えに番号が無いため）。引けなくても取消の結果は変えず、`sequence` を `null` にする。
- 再送の窓口は、発送のメールに `fulfillmentId` が無い・発送のメール以外に `fulfillmentId` がある中身を 400 で断る（DB の表の CHECK `(kind = 'shipped') = (fulfillment_id IS NOT NULL)` と同じ決まり）。`fulfillmentId: null` は「持たない」として受ける。400 の答えは今のまま `{ error: 'Invalid request' }`。
- 履歴の発送の行の `at` は発送した時刻、取消の行の `at` は取り消した時刻。同じ時刻の行は、結果が上になる順（メール → 状態 → 取消 → 発送・仕上がり → 受付）に置く。
- 履歴の `OrderHistoryLine.name` は、メールの明細と同じ `商品名（色 / サイズ）`（色もサイズも無ければ商品名だけ）。
- Task 4 が先に `OrderEmailHistoryRow` へ `fulfillmentId`・`fulfillmentNumber` を足し（Task 4 の T4-6）、`order-history.test.ts` の見本の行と `order-email-routes.test.ts` の再送の期待（`_fulfillment_id: null`）も直している。Step 9 の `order-history.test.ts`・Step 10 の `order-history.ts`・Step 11 の `order-email-routes.test.ts` は全体の置き換えで、それらの直しと同じ形を含む（Task 4 の直しは、そのまま上書きされる）。
- 履歴の型の変更（`OrderHistoryEmailEntry` の必須の2項目、`OrderHistoryEntry` の4つの新しい行）が壊す所は、この Task で型が通る最小の直しを入れる（Step 14）: `OrderHistoryDialog.tsx` にメールでない行を描かない1か所、`OrderHistoryDialog.test.tsx` の型付きの見本2か所と `e2e/FR-ADMIN-065` の `SENT_EMAIL` に `fulfillmentId: null, fulfillmentNumber: null`。発送・仕上がりの行の描き方は Task 6 が画面ごと作り直し、`FR-ADMIN-065` の一覧の行の新しい形は Task 10 が直す（controller の決め事。各タスクの後に `npx tsc --noEmit` が通るようにするため）。jest は型を検査せずに流す（`tsconfig.json` の `isolatedModules: true`）。

このタスクの試験が確かめる Review Focus: 1（別の人が先に同じ品を発送した時は、DB の `QUANTITY_EXCEEDS_READY` が 409 になり、画面に出す言葉が決まった文で返る）、2（通信が切れて同じ番号で送り直された時は、200 で前と同じ形の答え `replayed: true` を返し、worker も動かす）、4（送った数を下回る仕上がりの取消は 409 `もう発送した数があるため、取り消せません。`。履歴の取消の印も出さない）。

- [ ] **Step 1: 発送の窓口の試験を書く**

`tests/unit/api/admin/order-fulfillment-routes.test.ts`:

```ts
/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

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
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));
const mockLoadMaterials = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-materials', () => ({
  loadFulfillmentMaterials: (...args: unknown[]) => mockLoadMaterials(...args),
}));

import { GET as getMaterials, POST as postFulfillment } from '@/app/api/admin/orders/[id]/fulfillments/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route';
import { FulfillmentStoreError } from '@/lib/orders/fulfillment/fulfillment-store';
import type { FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const TRACKING = '1234-5678-9012';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, fulfillmentId: FULFILLMENT_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

const CREATE_BODY = {
  requestKey: REQUEST_KEY,
  carrier: 'yamato',
  trackingNumber: TRACKING,
  notifyCustomer: true,
  lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
};
const CREATED_ROW = { fulfillment_id: FULFILLMENT_ID, number: 1, completes_order: false, order_status: 'paid', replayed: false };

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number を含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

function createRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

function cancelRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`, {
    method: 'POST',
    headers: HEADERS,
  });
}

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる（今の再送の窓口と同じ）
describe.each([
  ['発送する', 'admin:orders:fulfillment-create', 60, 'admin_create_fulfillment', [CREATED_ROW], () => postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT)],
  ['発送の取消', 'admin:orders:fulfillment-cancel', 30, 'admin_cancel_fulfillment', [{ outcome: 'cancelled', order_status: 'paid' }], () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
] as const)('%s の窓口の守り', (_name, endpoint, limit, rpcName, rpcRows, call) => {
  beforeEach(() => {
    rpcReturns({ [rpcName]: { data: rpcRows } });
  });

  it('権限が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、この窓口の名前と回数で数える', async () => {
    expect((await call()).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: expect.any(Request), endpoint, limit, windowSeconds: 600, subject: 'admin-1' });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/orders/[id]/fulfillments（発送の材料）', () => {
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments`);
  const MATERIALS: FulfillmentMaterials = {
    order: {
      id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [{
      orderItemId: ITEM_1, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock', quantity: 2,
      shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
    }],
    fulfillments: [],
  };

  it('注文の管理の権限で材料を返す。読むだけなので CSRF と回数の制限は通さない', async () => {
    mockLoadMaterials.mockResolvedValueOnce(MATERIALS);

    const response = await getMaterials(request(), ORDER_CONTEXT);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(MATERIALS);
    expect(mockLoadMaterials).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), ORDER_ID);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await getMaterials(request(), ORDER_CONTEXT)).status).toBe(403);
    expect(mockLoadMaterials).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400、注文が無ければ 404', async () => {
    const invalid = await getMaterials(request(), { params: Promise.resolve({ id: 'x' }) });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockLoadMaterials).not.toHaveBeenCalled();

    mockLoadMaterials.mockResolvedValueOnce(null);
    const missing = await getMaterials(request(), ORDER_CONTEXT);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ', async () => {
    mockLoadMaterials.mockRejectedValueOnce(new FulfillmentStoreError('load_order', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getMaterials(request(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の材料を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.materials] Failed to load materials', 'FulfillmentStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/fulfillments（発送する）', () => {
  it('権限・CSRF・回数の制限を通った後に発送を記録し、監査に残し、メールの worker を動かす', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [CREATED_ROW] } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 1, completesOrder: false, orderStatus: 'paid', replayed: false,
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _request_key: REQUEST_KEY,
      _shipping_carrier: 'yamato',
      _tracking_number: TRACKING,
      _notify_customer: true,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.fulfillment.create',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Fulfillment recorded',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: {
        fulfillment_id: FULFILLMENT_ID, sequence: 1, carrier: 'yamato', notify_customer: true, completes_order: false, line_count: 2, replayed: false,
      },
    });
    // 伝票番号・宛先・氏名を監査に入れない。入れた鍵が maskAuditEvent に伏せられることもない
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain(TRACKING);
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('「お客様に発送のメールを送る」を省くと送る。伝票番号の前後の空白は除いて DB に渡す', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [CREATED_ROW] } });

    // undefined の項目は JSON にならない（送られない）
    await postFulfillment(createRequest({ ...CREATE_BODY, notifyCustomer: undefined, trackingNumber: `  ${TRACKING}  ` }), ORDER_CONTEXT);

    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', expect.objectContaining({
      _notify_customer: true, _tracking_number: TRACKING,
    }));
  });

  it('送らないを選んで全部送った発送は、発送済みになったことを返す', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [{ ...CREATED_ROW, number: 2, completes_order: true, order_status: 'shipped' }] } });

    const response = await postFulfillment(createRequest({ ...CREATE_BODY, notifyCustomer: false }), ORDER_CONTEXT);

    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', expect.objectContaining({ _notify_customer: false }));
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 2, completesOrder: true, orderStatus: 'shipped', replayed: false,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ sequence: 2, notify_customer: false, completes_order: true }),
    }));
  });

  it('通信が切れて同じ番号で送り直されたら、前と同じ形の 200 を返す（replayed）。二重に記録しない', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [{ ...CREATED_ROW, replayed: true }] } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 1, completesOrder: false, orderStatus: 'paid', replayed: true,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: expect.objectContaining({ replayed: true }),
    }));
    // 前の呼び出しが worker を動かす前に止まっていても、送り直しで動かす
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('注文番号の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postFulfillment(createRequest(CREATE_BODY), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  it.each([
    ['requestKey が無い', { ...CREATE_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...CREATE_BODY, requestKey: 'abc' }],
    ['知らない配送業者', { ...CREATE_BODY, carrier: 'dhl' }],
    ['伝票番号が空白だけ', { ...CREATE_BODY, trackingNumber: '   ' }],
    ['伝票番号に記号', { ...CREATE_BODY, trackingNumber: '12 34/56' }],
    ['伝票番号が65文字', { ...CREATE_BODY, trackingNumber: 'a'.repeat(65) }],
    ['「送るか」が真偽でない', { ...CREATE_BODY, notifyCustomer: 'no' }],
    ['商品の行が無い', { ...CREATE_BODY, lines: [] }],
    ['商品の行が101行', { ...CREATE_BODY, lines: Array.from({ length: 101 }, (_, index) => ({ orderItemId: `d1b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`, quantity: 1 })) }],
    ['商品の番号が UUID でない', { ...CREATE_BODY, lines: [{ orderItemId: 'item-1', quantity: 1 }] }],
    ['数が0', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 0 }] }],
    ['数が1000', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1000 }] }],
    ['数が小数', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1.5 }] }],
    ['同じ商品が2行', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1 }, { orderItemId: ITEM_1, quantity: 2 }] }],
  ])('中身の誤り（%s）は 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postFulfillment(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.fulfillment.create', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postFulfillment(createRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // 発送する直前に別の人が同じ品を発送した時は QUANTITY_EXCEEDS_READY で 409 になり、2回目は記録されない
  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['ORDER_NOT_SHIPPABLE', '22023', 409, 'not_shippable', '発送できる状態ではありません。一覧を更新してください。'],
    ['SHIPPING_ADDRESS_INCOMPLETE', '22023', 409, 'address_incomplete', '配送先の必須項目が足りないため発送できません。'],
    ['PAYMENT_REVIEW_REQUIRED', '22023', 409, 'payment_review_required', '支払額の確認（要対応）が済むまで発送できません。'],
    ['LINE_NOT_IN_ORDER', '22023', 409, 'quantity_exceeds_ready', '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
    ['QUANTITY_EXCEEDS_READY', '22023', 409, 'quantity_exceeds_ready', '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
    ['FULFILLMENT_REQUEST_MISMATCH', '22023', 409, 'fulfillment_request_mismatch', '前の発送と内容が違います。画面を開き直してください。'],
    ['FULFILLMENT_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_create_fulfillment: { data: null, error: { message, code: dbCode } } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Fulfillment refused', metadata: { code },
    }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_create_fulfillment: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.create] Failed to create fulfillment', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to create fulfillment', metadata: null }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB が行を返さなければ 500', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [] } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect((await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(500);
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel（発送の取消）', () => {
  const LISTED = {
    fulfillment_id: FULFILLMENT_ID, number: 2, shipping_carrier: 'yamato', tracking_number: TRACKING, notify_customer: true,
    completes_order: true, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
    cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 2 }],
  };

  it('発送を取り消し、監査に何回目かを残す。メールは送らないので worker は動かさない', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: [LISTED] },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_fulfillment', {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: 'admin-1',
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.fulfillment.cancel',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Fulfillment cancelled',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { fulfillment_id: FULFILLMENT_ID, sequence: 2, outcome: 'cancelled', order_status: 'paid' },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain(TRACKING);
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('もう取り消してあれば already_cancelled の 200（何度押しても同じ結果）', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'already_cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: [LISTED] },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'already_cancelled', orderStatus: 'paid' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', detail: 'Fulfillment was already cancelled',
    }));
  });

  it('何回目かを引けなくても、取消の結果は変えない（sequence は null）', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: null, error: { message: 'down', code: '08006' } },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: expect.objectContaining({ sequence: null }),
    }));
  });

  it.each([
    ['注文番号', { id: 'x', fulfillmentId: FULFILLMENT_ID }],
    ['発送の番号', { id: ORDER_ID, fulfillmentId: 'x' }],
  ])('%s の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, params) => {
    const response = await postCancel(cancelRequest(), { params: Promise.resolve(params) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid id', metadata: null }));
  });

  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['FULFILLMENT_NOT_FOUND', 'P0002', 404, 'fulfillment_not_found', '発送の記録が見つかりません。'],
    ['FULFILLMENT_CANCEL_NOT_ALLOWED', '22023', 409, 'fulfillment_cancel_not_allowed', 'この発送は取り消せません。注文の状態を確かめてください。'],
    ['FULFILLMENT_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_cancel_fulfillment: { data: null, error: { message, code: dbCode } } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Fulfillment cancel refused', metadata: { code },
    }));
    expect(mockRpc).not.toHaveBeenCalledWith('list_order_fulfillments', expect.anything());
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_cancel_fulfillment: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の取消に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.cancel] Failed to cancel fulfillment', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to cancel fulfillment' }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
```

Run: `npx jest tests/unit/api/admin/order-fulfillment-routes.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/app/api/admin/orders/[id]/fulfillments/route'`）

- [ ] **Step 2: 発送の材料と発送する窓口を書く**

`src/app/api/admin/orders/[id]/fulfillments/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  createFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  carrier: z.enum(SHIPPING_CARRIER_IDS),
  trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  // 発送の画面の「お客様に発送のメールを送る」（既定は送る。Shopify の「発送の詳細を今すぐ送る」）
  notifyCustomer: z.boolean().default(true),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.orderItemId)).size === lines.length),
});

const RATE_LIMIT = { endpoint: 'admin:orders:fulfillment-create', limit: 60, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 発送の画面を開いた時に読む材料（グループ E-1 設計書 6-2）。注文・商品ごとの数・発送の一覧・発送できない理由。
 * 発送の操作と同じ人だけが読める。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const materials = await loadFulfillmentMaterials(client, parsedId.data);
    if (!materials) {
      return NextResponse.json(fulfillmentErrorBody('order_not_found'), { status: FULFILLMENT_ERROR_MESSAGES.order_not_found.status });
    }
    return NextResponse.json(materials, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.orders.fulfillment.materials] Failed to load materials', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    return NextResponse.json(fulfillmentFailureBody('materials'), { status: 500 });
  }
}

/**
 * 発送する（グループ E-1 設計書 6-2）。1回の発送を、商品と数つきで記録する。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → DB の関数の順に確かめる。
 * 監査に伝票番号・宛先・氏名・住所は入れない。同じ requestKey の送り直しは前の結果を返す（replayed）。
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
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.fulfillment.create',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は伝票番号などを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { requestKey, carrier, trackingNumber, notifyCustomer, lines } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await createFulfillment(store, {
      orderId: parsedId.data,
      actorId: authz.userId,
      requestKey,
      carrier,
      trackingNumber,
      notifyCustomer,
      lines,
    });
    // 何回目かの鍵に number を含めない（maskAuditEvent が number を含む鍵を伏せるため）。伝票番号は入れない
    await audit('success', 'Fulfillment recorded', {
      fulfillment_id: result.fulfillmentId,
      sequence: result.number,
      carrier,
      notify_customer: notifyCustomer,
      completes_order: result.completesOrder,
      line_count: lines.length,
      replayed: result.replayed,
    });
    // 発送のメール（知らせる時だけ）の行は DB の関数が同じ取引で書いた。返事の後に送る。
    // 送り直し（replayed）でも動かす: 前の呼び出しが worker を動かす前に止まっていても、メールが送られるように
    scheduleOrderEmailDelivery();
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Fulfillment refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.fulfillment.create] Failed to create fulfillment', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to create fulfillment');
    return NextResponse.json(fulfillmentFailureBody('create'), { status: 500 });
  }
}
```

この窓口の試験は、取消の窓口が無い間は読み込みで止まる。次の手順で取消の窓口を書いてから流す。

- [ ] **Step 3: 発送の取消の窓口を書く**

`src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  cancelFulfillment,
  listOrderFulfillments,
  type FulfillmentStore,
} from '@/lib/orders/fulfillment/fulfillment-store';

const paramsSchema = z.object({ id: z.string().uuid(), fulfillmentId: z.string().uuid() });

const RATE_LIMIT = { endpoint: 'admin:orders:fulfillment-cancel', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/** 監査に「何回目か」を残すための読み取り。引けなくても、取消の結果は変えない */
async function findFulfillmentSequence(store: FulfillmentStore, orderId: string, fulfillmentId: string): Promise<number | null> {
  try {
    const rows = await listOrderFulfillments(store, orderId);
    return rows.find((row) => row.fulfillmentId === fulfillmentId)?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * 発送の取消（グループ E-1 設計書 7-2）。その商品は発送準備中に戻り、全部を送っていた注文は決済完了に戻る。
 * お客様にメールは送らない（送った発送のメールは、店から連絡する）。まだ送っていない発送のメールは DB の関数が取りやめにする。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 番号 → DB の関数の順に確かめる。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; fulfillmentId: string }> }) {
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

  const rawParams = await params;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.fulfillment.cancel',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: rawParams.id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedParams = paramsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    await audit('failure', 'Invalid id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { id: orderId, fulfillmentId } = parsedParams.data;

  try {
    const store = await createServiceRoleClient();
    const result = await cancelFulfillment(store, { orderId, fulfillmentId, actorId: authz.userId });
    await audit(
      'success',
      result.outcome === 'cancelled' ? 'Fulfillment cancelled' : 'Fulfillment was already cancelled',
      {
        fulfillment_id: fulfillmentId,
        sequence: await findFulfillmentSequence(store, orderId, fulfillmentId),
        outcome: result.outcome,
        order_status: result.orderStatus,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Fulfillment cancel refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.fulfillment.cancel] Failed to cancel fulfillment', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to cancel fulfillment');
    return NextResponse.json(fulfillmentFailureBody('cancel'), { status: 500 });
  }
}
```

Run: `npx jest tests/unit/api/admin/order-fulfillment-routes.test.ts --runInBand`
Expected: PASS

- [ ] **Step 4: 仕上がりの窓口の試験を書く**

`tests/unit/api/admin/order-completion-routes.test.ts`:

```ts
/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

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
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));

import { POST as postCompletion } from '@/app/api/admin/orders/[id]/completions/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/completions/[completionId]/cancel/route';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'c1b2c3d4-1111-4222-8333-444455556661';
const COMPLETION_ID_2 = 'c1b2c3d4-1111-4222-8333-444455556662';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, completionId: COMPLETION_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

const RECORD_BODY = {
  requestKey: REQUEST_KEY,
  lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
};
const RECORDED_ROWS = [
  { completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: false },
  { completion_id: COMPLETION_ID_2, order_item_id: ITEM_2, quantity: 1, replayed: false },
];

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number を含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

function recordRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/completions`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

function cancelRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`, {
    method: 'POST',
    headers: HEADERS,
  });
}

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる（今の再送の窓口と同じ）
describe.each([
  ['仕上がりの記録', 'admin:orders:completion-record', 60, 'admin_record_completion', RECORDED_ROWS, () => postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT)],
  ['仕上がりの取消', 'admin:orders:completion-cancel', 30, 'admin_cancel_completion', [{ outcome: 'cancelled' }], () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
] as const)('%s の窓口の守り', (_name, endpoint, limit, rpcName, rpcRows, call) => {
  beforeEach(() => {
    rpcReturns({ [rpcName]: { data: rpcRows } });
  });

  it('権限が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、この窓口の名前と回数で数える', async () => {
    expect((await call()).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: expect.any(Request), endpoint, limit, windowSeconds: 600, subject: 'admin-1' });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/completions（仕上がりの記録）', () => {
  it('仕上がりを記録し、監査に行の数と数の合計を残す。お客様にメールは送らないので worker は動かさない', async () => {
    rpcReturns({ admin_record_completion: { data: RECORDED_ROWS } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completionIds: [COMPLETION_ID, COMPLETION_ID_2], replayed: false });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('admin_record_completion', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _request_key: REQUEST_KEY,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.completion.record',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Completion recorded',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { line_count: 2, total_quantity: 3, replayed: false },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('同じ番号で送り直されたら、前と同じ形の 200 を返す（replayed）', async () => {
    rpcReturns({ admin_record_completion: { data: RECORDED_ROWS.map((row) => ({ ...row, replayed: true })) } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completionIds: [COMPLETION_ID, COMPLETION_ID_2], replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ replayed: true }) }));
  });

  it('注文番号の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postCompletion(recordRequest(RECORD_BODY), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  it.each([
    ['requestKey が無い', { ...RECORD_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...RECORD_BODY, requestKey: 'abc' }],
    ['商品の行が無い', { ...RECORD_BODY, lines: [] }],
    ['商品の行が101行', { ...RECORD_BODY, lines: Array.from({ length: 101 }, (_, index) => ({ orderItemId: `d1b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`, quantity: 1 })) }],
    ['商品の番号が UUID でない', { ...RECORD_BODY, lines: [{ orderItemId: 'item-1', quantity: 1 }] }],
    ['数が0', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 0 }] }],
    ['数が1000', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1000 }] }],
    ['数が小数', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1.5 }] }],
    ['同じ商品が2行', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1 }, { orderItemId: ITEM_1, quantity: 1 }] }],
  ])('中身の誤り（%s）は 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postCompletion(recordRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.completion.record', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postCompletion(recordRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['ORDER_NOT_IN_PRODUCTION', '22023', 409, 'not_in_production', '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
    ['LINE_NOT_IN_PRODUCTION', '22023', 409, 'quantity_exceeds_in_production', '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
    ['QUANTITY_EXCEEDS_IN_PRODUCTION', '22023', 409, 'quantity_exceeds_in_production', '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
    ['COMPLETION_REQUEST_MISMATCH', '22023', 409, 'completion_request_mismatch', '前の記録と内容が違います。画面を開き直してください。'],
    ['COMPLETION_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_record_completion: { data: null, error: { message, code: dbCode } } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Completion refused', metadata: { code },
    }));
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_record_completion: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '仕上がりの記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.completion.record] Failed to record completion', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to record completion' }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB が行を返さなければ 500', async () => {
    rpcReturns({ admin_record_completion: { data: [] } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect((await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT)).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/completions/[completionId]/cancel（仕上がりの取消）', () => {
  it('仕上がりを取り消し、監査に結果を残す', async () => {
    rpcReturns({ admin_cancel_completion: { data: [{ outcome: 'cancelled' }] } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'cancelled' });
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_completion', {
      _order_id: ORDER_ID, _completion_id: COMPLETION_ID, _actor_id: 'admin-1',
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.completion.cancel',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Completion cancelled',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { completion_id: COMPLETION_ID, outcome: 'cancelled' },
    });
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('もう取り消してあれば already_cancelled の 200', async () => {
    rpcReturns({ admin_cancel_completion: { data: [{ outcome: 'already_cancelled' }] } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'already_cancelled' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Completion was already cancelled' }));
  });

  it.each([
    ['注文番号', { id: 'x', completionId: COMPLETION_ID }],
    ['仕上がりの番号', { id: ORDER_ID, completionId: 'x' }],
  ])('%s の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, params) => {
    const response = await postCancel(cancelRequest(), { params: Promise.resolve(params) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid id', metadata: null }));
  });

  // 受注生産の品を一部送った後に、店が仕上がりを取り消そうとした時は 409 で断り、数は変わらない
  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['COMPLETION_NOT_FOUND', 'P0002', 404, 'completion_not_found', '仕上がりの記録が見つかりません。'],
    ['ORDER_NOT_IN_PRODUCTION', '22023', 409, 'not_in_production', '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
    ['COMPLETION_ALREADY_SHIPPED', '22023', 409, 'completion_already_shipped', 'もう発送した数があるため、取り消せません。'],
    ['COMPLETION_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_cancel_completion: { data: null, error: { message, code: dbCode } } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Completion cancel refused', metadata: { code },
    }));
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_cancel_completion: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '仕上がりの取消に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.completion.cancel] Failed to cancel completion', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to cancel completion' }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
```

Run: `npx jest tests/unit/api/admin/order-completion-routes.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/app/api/admin/orders/[id]/completions/route'`）

- [ ] **Step 5: 仕上がりの記録の窓口を書く**

`src/app/api/admin/orders/[id]/completions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  recordCompletion,
} from '@/lib/orders/fulfillment/fulfillment-store';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.orderItemId)).size === lines.length),
});

const RATE_LIMIT = { endpoint: 'admin:orders:completion-record', limit: 60, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 受注生産の品の仕上がりを記録する（グループ E-1 設計書 5-2）。記録すると、その数が発送準備中に移る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → DB の関数の順に確かめる。
 * お客様にメールは送らない（Shopify も、発送の保留を外した時に知らせない）ので、worker は動かさない。
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
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.completion.record',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は残さず、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { requestKey, lines } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await recordCompletion(store, { orderId: parsedId.data, actorId: authz.userId, requestKey, lines });
    await audit('success', 'Completion recorded', {
      line_count: lines.length,
      total_quantity: lines.reduce((total, line) => total + line.quantity, 0),
      replayed: result.replayed,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Completion refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.completion.record] Failed to record completion', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to record completion');
    return NextResponse.json(fulfillmentFailureBody('completion'), { status: 500 });
  }
}
```

この窓口の試験も、取消の窓口が無い間は読み込みで止まる。次の手順で書いてから流す。

- [ ] **Step 6: 仕上がりの取消の窓口を書く**

`src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  cancelCompletion,
} from '@/lib/orders/fulfillment/fulfillment-store';

const paramsSchema = z.object({ id: z.string().uuid(), completionId: z.string().uuid() });

const RATE_LIMIT = { endpoint: 'admin:orders:completion-cancel', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 仕上がりの取消（グループ E-1 設計書 5-2）。その品は受注生産中に戻る。もう送った数を下回る取消は DB が断る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 番号 → DB の関数の順に確かめる。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; completionId: string }> }) {
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

  const rawParams = await params;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.completion.cancel',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: rawParams.id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedParams = paramsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    await audit('failure', 'Invalid id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { id: orderId, completionId } = parsedParams.data;

  try {
    const store = await createServiceRoleClient();
    const result = await cancelCompletion(store, { orderId, completionId, actorId: authz.userId });
    await audit(
      'success',
      result.outcome === 'cancelled' ? 'Completion cancelled' : 'Completion was already cancelled',
      { completion_id: completionId, outcome: result.outcome },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Completion cancel refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.completion.cancel] Failed to cancel completion', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to cancel completion');
    return NextResponse.json(fulfillmentFailureBody('completion_cancel'), { status: 500 });
  }
}
```

Run: `npx jest tests/unit/api/admin/order-completion-routes.test.ts tests/unit/api/admin/order-fulfillment-routes.test.ts --runInBand`
Expected: PASS

- [ ] **Step 7: 状態の窓口の試験を直す（発送の道を消した後の形）**

`tests/unit/api/admin/order-status-shipped.test.ts` の「CSRF トークン」の describe（109〜161行目）と「発送」の describe（163〜214行目）を直す。取消の describe（216行目から）は変えない。

`tests/unit/api/admin/order-status-shipped.test.ts` — 次の部分を置き換える（「CSRF トークン」の describe。発送の行を外し、取消だけにする）:

置き換える前:

```ts
describe('POST /api/admin/orders/[id]/status - CSRF トークン', () => {
  const SHIP = { status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' };

  // 確認が通れば取消も発送も成功する状態にしておく。拒否されたとき、処理が進んだことが 200 で分かる
  beforeEach(() => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID }], error: null });
  });

  // clearAllMocks は実装を戻さない。ここで置いた既定の応答を、後ろのテストへ持ち越さない
  afterEach(() => {
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
  });

  test.each([
    ['取消', 403, CANCEL],
    ['発送', 403, SHIP],
    ['取消（確認の DB の失敗）', 500, CANCEL],
    ['発送（確認の DB の失敗）', 500, SHIP],
  ])('CSRF トークンが合わなければ、%s は何もせず、確認の応答（%i）をそのまま返す', async (_name, status, body) => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status }));

    const res = await post(body);

    expect(res.status).toBe(status);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test.each([
    ['取消', CANCEL],
    ['発送', SHIP],
  ])('CSRF トークンが合えば、%s は処理を進める', async (_name, body) => {
    const res = await post(body);

    expect(mockRequireCsrf).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test('権限が無ければ CSRF を確かめず、認可の応答をそのまま返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = await post(CANCEL);

    expect(res.status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
```

置き換えた後:

```ts
describe('POST /api/admin/orders/[id]/status - CSRF トークン', () => {
  // 確認が通れば取消が成功する状態にしておく。拒否されたとき、処理が進んだことが 200 で分かる
  beforeEach(() => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
  });

  // clearAllMocks は実装を戻さない。ここで置いた既定の応答を、後ろのテストへ持ち越さない
  afterEach(() => {
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
  });

  test.each([
    ['取消', 403],
    ['取消（確認の DB の失敗）', 500],
  ])('CSRF トークンが合わなければ、%s は何もせず、確認の応答（%i）をそのまま返す', async (_name, status) => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status }));

    const res = await post(CANCEL);

    expect(res.status).toBe(status);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('CSRF トークンが合えば、取消は処理を進める', async () => {
    const res = await post(CANCEL);

    expect(mockRequireCsrf).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test('権限が無ければ CSRF を確かめず、認可の応答をそのまま返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = await post(CANCEL);

    expect(res.status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
```

`tests/unit/api/admin/order-status-shipped.test.ts` — 次の部分を置き換える（「発送」の describe。発送の道は消えたので、発送を送ると 400 になることだけ確かめる）:

置き換える前:

```ts
describe('POST /api/admin/orders/[id]/status - 発送', () => {
  test('paid の注文を発送済みにできる', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID }], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', {
      _actor_id: 'admin-1',
      _order_id: ORDER_ID,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
      _notify_customer: true,
    });
    expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、配送先と支払額の確認を促し、メールの送信を予約しない', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('配送先');
    expect(res.body.error).toContain('支払額');
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
  });

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

  test('未知の配送業者と記号の混ざった追跡番号は 400 を返す', async () => {
    expect((await post({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' })).status).toBe(400);
    expect((await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
```

置き換えた後:

```ts
describe('POST /api/admin/orders/[id]/status - 発送', () => {
  // 発送は /api/admin/orders/[id]/fulfillments に移した（グループ E-1）。この窓口は未入金の注文の取消だけ
  test.each([
    ['従来の発送の中身', { status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }],
    ['「送るか」を付けた発送の中身', { status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: false }],
    ['中身が足りない発送', { status: 'shipped' }],
  ])('status: shipped（%s）は 400 を返し、DB を読まず、発送の関数も呼ばない', async (_name, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith('admin_ship_paid_order', expect.anything());
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body' }));
  });
});
```

Run: `npx jest tests/unit/api/admin/order-status-shipped.test.ts --runInBand`
Expected: FAIL（「status: shipped（従来の発送の中身）」と「（「送るか」を付けた発送の中身）」の2件。今の窓口はまだ発送を受けるため、400 でなく 500 などが返る。「中身が足りない発送」は今でも 400 なので通る）

- [ ] **Step 8: 状態の窓口から発送の道を消す**

`src/app/api/admin/orders/[id]/status/route.ts` を次の4か所で直す。取消の作りは変えない。

`src/app/api/admin/orders/[id]/status/route.ts` — 次の部分を置き換える（20行目。発送の配送業者の import はもう使わない）:

置き換える前:

```ts
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import {
  ADMIN_NOTE_MAX_LENGTH,
```

置き換えた後:

```ts
import { logAudit } from '@/lib/audit';
import {
  ADMIN_NOTE_MAX_LENGTH,
```

`src/app/api/admin/orders/[id]/status/route.ts` — 次の部分を置き換える（31〜45行目。中身の形は取消だけにする。`status: 'shipped'` は形の誤りになり 400）:

置き換える前:

```ts
const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('cancelled'),
    reason: z.enum(CANCEL_REASONS),
    note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
    notifyCustomer: z.boolean().default(true),
  }),
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(SHIPPING_CARRIER_IDS),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
    // 発送の画面の「お客様に発送のメールを送る」（既定は送る。Shopify の「発送の詳細を今すぐ送る」）
    notifyCustomer: z.boolean().default(true),
  }),
]);
```

置き換えた後:

```ts
// 発送は /api/admin/orders/[id]/fulfillments に移した（グループ E-1）。この窓口は未入金の注文の取消だけ
const updateStatusSchema = z.object({
  status: z.literal('cancelled'),
  reason: z.enum(CANCEL_REASONS),
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
  notifyCustomer: z.boolean().default(true),
});
```

`src/app/api/admin/orders/[id]/status/route.ts` — 次の部分を置き換える（76行目。説明から発送を外す）:

置き換える前:

```ts
      description: 'Order status update endpoint (cancel or shipped)',
```

置き換えた後:

```ts
      description: 'Order status update endpoint (cancel)',
```

`src/app/api/admin/orders/[id]/status/route.ts` — 次の部分を置き換える（130〜163行目。発送の道と `admin_ship_paid_order` の呼び出しを消す）:

置き換える前:

```ts
    if (parsedBody.data.status === 'shipped') {
      const serviceRoleSupabase = await createServiceRoleClient();
      const { data, error } = await serviceRoleSupabase.rpc('admin_ship_paid_order', {
        _actor_id: authz.userId,
        _order_id: parsedOrderId.data,
        _shipping_carrier: parsedBody.data.carrier,
        _tracking_number: parsedBody.data.trackingNumber,
        _notify_customer: parsedBody.data.notifyCustomer,
      });

      if (error) {
        console.error('[admin.orders.status] Failed to ship order:', error);
        return NextResponse.json({ error: '発送状態の更新に失敗しました。' }, { status: 500 });
      }

      const shippedOrder = Array.isArray(data) ? data[0] : data;
      if (!shippedOrder) {
        await audit('failure', 'not_shippable');
        return NextResponse.json(
          {
            error:
              '発送できる状態ではありません。決済完了・未発送で配送先の必須項目が揃い、支払額の確認（要対応）が済んだ注文のみ発送できます。',
          },
          { status: 409 },
        );
      }

      await audit('success', 'Status changed to shipped', { status: 'shipped', carrier: parsedBody.data.carrier, notify_customer: parsedBody.data.notifyCustomer });

      // 発送のメール（知らせる時だけ）の行は DB の関数が同じ取引で書いた。返事の後に送る（グループ D 設計書 4-7）
      scheduleOrderEmailDelivery();

      return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
    }

    const cancel: CancelRequest = {
```

置き換えた後:

```ts
    const cancel: CancelRequest = {
```

Run: `npx jest tests/unit/api/admin/order-status-shipped.test.ts --runInBand`
Expected: PASS

- [ ] **Step 9: 履歴の組み立ての試験を書く**

`tests/unit/lib/orders/email/order-history.test.ts`（全体を次に置き換える）:

```ts
import {
  buildOrderHistory,
  type BuildOrderHistoryInput,
  type OrderEmailHistoryRow,
  type OrderHistoryEntry,
  type OrderHistoryLine,
} from '@/lib/orders/email/order-history';
import type { OrderCompletionHistoryRow, OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const NOT_PAUSED = { paused: false, reason: null, pausedAt: null, nextProbeAt: null };
const ORDER = { id: ORDER_ID, status: 'paid' as const, shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' };

const BLOUSE = '11111111-1111-4111-8111-111111111111'; // 在庫の品
const PANTS = '22222222-2222-4222-8222-222222222222'; // 受注生産の品（1つ仕上がった・まだ送っていない）
const DRESS = '33333333-3333-4333-8333-333333333333'; // 受注生産の品（3つ仕上がり、2つ送った）

const LINES: OrderHistoryLine[] = [
  { orderItemId: BLOUSE, name: 'シルクブラウス（白 / M）', shipped: 1, completed: 2 },
  { orderItemId: PANTS, name: 'リネンパンツ', shipped: 0, completed: 1 },
  { orderItemId: DRESS, name: 'ウールドレス（黒 / S）', shipped: 2, completed: 3 },
];

function email(overrides: Partial<OrderEmailHistoryRow> = {}): OrderEmailHistoryRow {
  return {
    id: 'email-1', kind: 'paid', origin: 'auto', requestedByEmail: null, status: 'sent', attempts: 1, lastErrorCode: null,
    deliveryStatus: null, deliveryEventAt: null, createdAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:05.000Z',
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, fulfillmentId: null, fulfillmentNumber: null, ...overrides,
  };
}

function fulfillment(overrides: Partial<OrderFulfillmentHistoryRow> = {}): OrderFulfillmentHistoryRow {
  return {
    fulfillmentId: 'f-1', number: 1, shippingCarrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true, completesOrder: false,
    shippedAt: '2026-10-10T02:00:00.000Z', createdByEmail: 'admin@example.com', cancelledAt: null, cancelledByEmail: null, legacy: false,
    lines: [{ orderItemId: BLOUSE, quantity: 1 }], ...overrides,
  };
}

function completion(overrides: Partial<OrderCompletionHistoryRow> = {}): OrderCompletionHistoryRow {
  return {
    completionId: 'c-1', orderItemId: PANTS, quantity: 1, createdAt: '2026-10-10T01:00:00.000Z', createdByEmail: 'admin@example.com',
    cancelledAt: null, cancelledByEmail: null, legacy: false, ...overrides,
  };
}

function input(overrides: Partial<BuildOrderHistoryInput> = {}): BuildOrderHistoryInput {
  return { order: ORDER, statusRows: [], emailRows: [], sendState: NOT_PAUSED, fulfillments: [], completions: [], lines: [], ...overrides };
}

function entriesOf<T extends OrderHistoryEntry['type']>(entries: OrderHistoryEntry[], type: T): Array<Extract<OrderHistoryEntry, { type: T }>> {
  return entries.filter((entry): entry is Extract<OrderHistoryEntry, { type: T }> => entry.type === type);
}

describe('buildOrderHistory', () => {
  it('受付・状態の変化・メールを新しい順に並べ、宛先と注文番号を出す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      statusRows: [
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_create_fulfillment',
          actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
        },
        {
          changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
      emailRows: [email({ deliveryStatus: 'delivered', deliveryEventAt: '2026-10-09T01:01:00.000Z' })],
    }));

    expect(history.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '発送済み', recipient: 'hanako@example.com' });
    expect(history.sendPaused).toBeNull();
    expect(history.entries.map((entry) => entry.type)).toEqual(['status', 'email', 'status', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-10T02:00:00.000Z', fromLabel: '決済完了', toLabel: '発送済み',
      actorEmail: 'admin@example.com', detail: '配送業者: ヤマト運輸 / 伝票番号: 1234-5678',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'email', kindLabel: '注文確認', stateLabel: '配達済み', warning: false, manual: false, canViewContent: true, resendable: true,
      fulfillmentId: null, fulfillmentNumber: null,
    });
  });

  it('取消は理由を出す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'cancelled' },
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'pending', toStatus: 'cancelled', changeReason: 'admin_cancel',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: 'customer_request',
      }],
    }));

    expect(history.entries[0]).toMatchObject({ fromLabel: '未決済', toLabel: 'キャンセル', detail: '理由: お客様の依頼' });
  });

  it('返金の同期で変わった状態は、全額返金・返金の取り消しと説明する', () => {
    const history = buildOrderHistory(input({
      statusRows: [
        {
          changedAt: '2026-10-11T02:00:00.000Z', fromStatus: 'cancelled', toStatus: 'paid', changeReason: 'stripe_refund_projection',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'cancelled', changeReason: 'stripe_refund_projection',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
    }));

    expect(history.entries[0]).toMatchObject({
      type: 'status', fromLabel: 'キャンセル', toLabel: '決済完了', actorEmail: null, detail: '返金の取り消し',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'status', fromLabel: '決済完了', toLabel: 'キャンセル', actorEmail: null, detail: '理由: 全額返金',
    });
  });

  it('発送の取消で発送済みから決済完了に戻った状態の行は、説明を「発送の取消」にする', () => {
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: '2026-10-11T03:00:00.000Z', fromStatus: 'shipped', toStatus: 'paid', changeReason: 'admin_cancel_fulfillment',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
    }));

    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-11T03:00:00.000Z', fromLabel: '発送済み', toLabel: '決済完了',
      actorEmail: 'admin@example.com', detail: '発送の取消',
    });
  });

  it('再送できるのは、送信済み・送れなかった行で、今の注文の状態で意味のある種類だけ。同じ種類の手の再送が送信待ちなら押せない', () => {
    const rows = (extra: OrderEmailHistoryRow[]) =>
      entriesOf(buildOrderHistory(input({ emailRows: extra })).entries, 'email');

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

  it('返金の取り消しでキャンセルから発送済みに戻る時は、配送情報より返金の取り消しを優先する', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped', shippingEmail: null },
      statusRows: [{
        changedAt: '2026-10-11T02:00:00.000Z', fromStatus: 'cancelled', toStatus: 'shipped', changeReason: 'stripe_refund_projection',
        actorEmail: null, shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
      }],
    }));

    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-11T02:00:00.000Z', fromLabel: 'キャンセル', toLabel: '発送済み', actorEmail: null, detail: '返金の取り消し',
    });
  });

  it('送信を止めていれば、その原因の名前を返す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, shippingEmail: null },
      sendState: { paused: true, reason: 'quota_daily' },
    }));

    expect(history.sendPaused).toEqual({ reasonLabel: '1日の送信の上限' });
    expect(history.order.recipient).toBeNull();
  });
});

describe('buildOrderHistory - 発送', () => {
  it('発送の行は、何回目・配送業者・伝票番号・商品と数・操作した人・メールの有無・全部送ったかを持つ', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({
        number: 2, completesOrder: true, lines: [{ orderItemId: BLOUSE, quantity: 1 }, { orderItemId: PANTS, quantity: 1 }],
      })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')).toEqual([{
      type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: 'f-1', number: 2, carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス（白 / M）', quantity: 1 }, { name: 'リネンパンツ', quantity: 1 }],
      actorEmail: 'admin@example.com', notifyCustomer: true, completesOrder: true, cancelled: false, cancellable: true, legacy: false,
    }]);
  });

  it('取り消した発送は、発送の行に取り消し済みの印を付けて取消の行を足す。もう取り消せない', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({ cancelledAt: '2026-10-11T03:00:00.000Z', cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['fulfillment_cancel', 'fulfillment', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'fulfillment_cancel', at: '2026-10-11T03:00:00.000Z', fulfillmentId: 'f-1', number: 1, actorEmail: 'owner@example.com',
    });
    expect(history.entries[1]).toMatchObject({ type: 'fulfillment', cancelled: true, cancellable: false });
  });

  it.each([
    ['payment_in_progress', false],
    ['pending', false],
    ['paid', true],
    ['failed', false],
    ['abandoned', false],
    ['cancelled', false],
    ['shipped', true],
  ] as const)('注文が %s の時、発送を取り消せるか=%s', (status, cancellable) => {
    const history = buildOrderHistory(input({ order: { ...ORDER, status }, fulfillments: [fulfillment()], lines: LINES }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({ cancellable });
  });

  it('前からの記録（legacy）は印を付ける。配送業者・伝票番号・操作した人が空でもよい', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      fulfillments: [fulfillment({ shippingCarrier: null, trackingNumber: null, createdByEmail: null, legacy: true })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({
      carrierLabel: null, trackingNumber: null, actorEmail: null, legacy: true,
    });
  });

  it('知らない配送業者は名前を出さない。商品の名前が分からなければ「商品」と出す', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({ shippingCarrier: 'dhl', lines: [{ orderItemId: 'unknown-item', quantity: 3 }] })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({ carrierLabel: null, items: [{ name: '商品', quantity: 3 }] });
  });
});

describe('buildOrderHistory - 仕上がり', () => {
  it('仕上がりの行は、商品と数・操作した人を持ち、取り消せる', () => {
    const history = buildOrderHistory(input({ completions: [completion()], lines: LINES }));

    expect(entriesOf(history.entries, 'completion')).toEqual([{
      type: 'completion', at: '2026-10-10T01:00:00.000Z', completionId: 'c-1', items: [{ name: 'リネンパンツ', quantity: 1 }],
      actorEmail: 'admin@example.com', cancelled: false, cancellable: true, legacy: false,
    }]);
  });

  it('仕上がりを取り消せるのは、取り消しても仕上がった数が送った数を下回らない時だけ', () => {
    // ウールドレスは3つ仕上がり、2つ送った。2つの記録を取り消すと1つになって送った数を下回る。1つの記録なら2つ残る
    const history = buildOrderHistory(input({
      completions: [
        completion({ completionId: 'c-a', orderItemId: DRESS, quantity: 2 }),
        completion({ completionId: 'c-b', orderItemId: DRESS, quantity: 1 }),
        completion({ completionId: 'c-c', orderItemId: PANTS, quantity: 1 }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'completion').map((entry) => [entry.completionId, entry.cancellable])).toEqual([
      ['c-a', false],
      ['c-b', true],
      ['c-c', true],
    ]);
  });

  it.each([
    ['payment_in_progress', false],
    ['pending', false],
    ['paid', true],
    ['failed', false],
    ['abandoned', false],
    ['cancelled', false],
    ['shipped', false],
  ] as const)('注文が %s の時、仕上がりを取り消せるか=%s（決済完了の注文だけ）', (status, cancellable) => {
    const history = buildOrderHistory(input({ order: { ...ORDER, status }, completions: [completion()], lines: LINES }));

    expect(entriesOf(history.entries, 'completion')[0]).toMatchObject({ cancellable });
  });

  it('取り消した仕上がりは、取り消し済みの印を付けて取消の行を足す。もう取り消せない', () => {
    const history = buildOrderHistory(input({
      completions: [completion({ cancelledAt: '2026-10-11T04:00:00.000Z', cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['completion_cancel', 'completion', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'completion_cancel', at: '2026-10-11T04:00:00.000Z', completionId: 'c-1', actorEmail: 'owner@example.com',
    });
    expect(history.entries[1]).toMatchObject({ type: 'completion', cancelled: true, cancellable: false });
  });

  it('商品の数が分からない仕上がり（前からの記録で商品が消えた等）は、取り消しの印を出さず、名前は「商品」', () => {
    const history = buildOrderHistory(input({ completions: [completion({ legacy: true, createdByEmail: null })], lines: [] }));

    expect(entriesOf(history.entries, 'completion')[0]).toMatchObject({
      items: [{ name: '商品', quantity: 1 }], cancellable: false, legacy: true, actorEmail: null,
    });
  });
});

describe('buildOrderHistory - 発送ごとのメール', () => {
  it('発送のメールの行は「発送（n回目）」と出し、どの発送かを返す。発送の番号が無い行は「発送」', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
        email({ id: 'e-0', kind: 'shipped', fulfillmentId: null, fulfillmentNumber: null }),
        email(),
      ],
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.kindLabel, entry.fulfillmentId, entry.fulfillmentNumber])).toEqual([
      ['発送（2回目）', 'f-2', 2],
      ['発送', null, null],
      ['注文確認', null, null],
    ]);
  });

  it('発送のメールを再送できるのは、その発送が取り消されていない時だけ。ほかの発送のメールには影響しない', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({ id: 'e-1', kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1 }),
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
      ],
      fulfillments: [
        fulfillment({ fulfillmentId: 'f-1', number: 1, cancelledAt: '2026-10-11T03:00:00.000Z', cancelledByEmail: 'owner@example.com' }),
        fulfillment({ fulfillmentId: 'f-2', number: 2 }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.emailId, entry.resendable])).toEqual([
      ['e-1', false],
      ['e-2', true],
    ]);
  });

  it('発送のメールは一部だけ送った間（決済完了）でも再送できる。手の再送が送信待ちなら、その発送だけ押せない', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({
          id: 'manual-2', kind: 'shipped', origin: 'manual', requestedByEmail: 'admin@example.com', status: 'pending', sentAt: null,
          hasBody: false, fulfillmentId: 'f-2', fulfillmentNumber: 2,
        }),
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
        email({ id: 'e-1', kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1 }),
      ],
      fulfillments: [fulfillment({ fulfillmentId: 'f-1', number: 1 }), fulfillment({ fulfillmentId: 'f-2', number: 2 })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.emailId, entry.resendable])).toEqual([
      ['manual-2', false],
      ['e-2', false],
      ['e-1', true],
    ]);
  });
});

describe('buildOrderHistory - 並び順', () => {
  it('同じ時刻の行は、結果が上になる順（メール → 状態 → 取消 → 発送・仕上がり → 受付）に置く', () => {
    const at = '2026-10-10T02:00:00.000Z';
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      statusRows: [{
        changedAt: at, fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_create_fulfillment',
        actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
      }],
      emailRows: [email({ kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1, createdAt: at })],
      fulfillments: [fulfillment({ shippedAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      completions: [completion({ createdAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual([
      'email', 'status', 'fulfillment_cancel', 'completion_cancel', 'fulfillment', 'completion', 'created',
    ]);
  });

  it('発送・仕上がり・メール・状態を、時刻の新しい順に混ぜる', () => {
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
      emailRows: [email({ kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1, createdAt: '2026-10-10T02:00:00.000Z' })],
      fulfillments: [fulfillment({ shippedAt: '2026-10-10T02:00:00.000Z' })],
      completions: [completion({ createdAt: '2026-10-09T05:00:00.000Z' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['email', 'fulfillment', 'completion', 'status', 'created']);
  });
});
```

Run: `npx jest tests/unit/lib/orders/email/order-history.test.ts --runInBand`
Expected: FAIL（`buildOrderHistory` が `fulfillments` などを受けず、発送の行も出ない）

- [ ] **Step 10: 履歴の型と組み立てを直す**

`src/lib/orders/email/order-history.ts`（全体を次に置き換える。`OrderEmailHistoryRow` の最後の2つの項目は Task 4 が足した物と同じ）:

```ts
import { toOrderNumber } from '@/lib/orders/order-number';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason, type OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
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
// 型だけを読む（実行時には何も読み込まない）。窓口が DB の関数から読んだ行を、そのまま渡してもらう
import type { OrderCompletionHistoryRow, OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';

/**
 * 管理画面の「この注文の履歴」（グループ D 設計書 5-1、グループ E-1 設計書 9-2）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。注文の状態の変化・メール・発送・仕上がりとその取消を新しい順に並べる。
 * 再送できるか・取り消せるかは窓口が決めて返す（画面は判断しない）。
 */
export const ORDER_STATUS_LABELS = {
  payment_in_progress: '支払い手続き中',
  pending: '未決済',
  paid: '決済完了',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
  shipped: '発送済み',
} as const satisfies Record<OrderStatus, string>;

export type OrderStatusLabel = (typeof ORDER_STATUS_LABELS)[OrderStatus];

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
  /** 発送のメールだけが、どの発送のメールかを持つ */
  fulfillmentId: string | null;
  fulfillmentNumber: number | null;
};

/** 注文の商品ごとの名前（商品名（色 / サイズ））と、発送した数・仕上がった数。取り消せるかの判断に使う */
export type OrderHistoryLine = { orderItemId: string; name: string; shipped: number; completed: number };

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
  fulfillmentId: string | null;
  fulfillmentNumber: number | null;
};

export type OrderHistoryFulfillmentEntry = {
  type: 'fulfillment';
  at: string;
  fulfillmentId: string;
  number: number;
  carrierLabel: string | null;
  trackingNumber: string | null;
  items: Array<{ name: string; quantity: number }>;
  actorEmail: string | null;
  notifyCustomer: boolean;
  completesOrder: boolean;
  cancelled: boolean;
  cancellable: boolean;
  legacy: boolean;
};

export type OrderHistoryFulfillmentCancelEntry = {
  type: 'fulfillment_cancel';
  at: string;
  fulfillmentId: string;
  number: number;
  actorEmail: string | null;
};

export type OrderHistoryCompletionEntry = {
  type: 'completion';
  at: string;
  completionId: string;
  items: Array<{ name: string; quantity: number }>;
  actorEmail: string | null;
  cancelled: boolean;
  cancellable: boolean;
  legacy: boolean;
};

export type OrderHistoryCompletionCancelEntry = {
  type: 'completion_cancel';
  at: string;
  completionId: string;
  actorEmail: string | null;
};

export type OrderHistoryEntry =
  | OrderHistoryCreatedEntry
  | OrderHistoryStatusEntry
  | OrderHistoryEmailEntry
  | OrderHistoryFulfillmentEntry
  | OrderHistoryFulfillmentCancelEntry
  | OrderHistoryCompletionEntry
  | OrderHistoryCompletionCancelEntry;

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
  fulfillments: OrderFulfillmentHistoryRow[];
  completions: OrderCompletionHistoryRow[];
  lines: OrderHistoryLine[];
};

const OPEN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['pending', 'sending', 'retry_wait']);
const ERROR_SHOWN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['retry_wait', 'dead', 'skipped']);
/** 商品の名前が分からない時に出す名前（注文の商品の行は消えないので、通常は使わない） */
const UNKNOWN_ITEM_NAME = '商品';

function statusLabel(value: string | null): string | null {
  return value && value in ORDER_STATUS_LABELS ? ORDER_STATUS_LABELS[value as OrderStatus] : value;
}

function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

function statusDetail(row: OrderStatusHistoryRow): string | null {
  // Stripe の返金の同期（DB の apply_order_refund_projection）で変わった行は、取消の理由（cancel_reason）が入らず説明が空になるので、
  // 返金として説明する。発送済みへ戻る行は配送業者も入るので、配送業者の説明より先に見る
  if (row.changeReason === 'stripe_refund_projection') {
    if (row.toStatus === 'cancelled') return '理由: 全額返金';
    if (row.fromStatus === 'cancelled') return '返金の取り消し';
  }
  // 発送の取消で、全部を送った注文が発送済みから決済完了に戻った行
  if (row.changeReason === 'admin_cancel_fulfillment') {
    return '発送の取消';
  }
  if (row.toStatus === 'shipped' && isShippingCarrierId(row.shippingCarrier)) {
    return `配送業者: ${SHIPPING_CARRIERS[row.shippingCarrier].label} / 伝票番号: ${row.trackingNumber ?? ''}`;
  }
  if (row.toStatus === 'cancelled' && isCancelReason(row.cancelReason)) {
    return `理由: ${CANCEL_REASON_LABELS[row.cancelReason]}`;
  }
  return null;
}

export function buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse {
  const { order, statusRows, emailRows, sendState, fulfillments, completions, lines } = input;
  const lineByItem = new Map(lines.map((line) => [line.orderItemId, line] as const));
  const itemsOf = (rows: ReadonlyArray<{ orderItemId: string; quantity: number }>) =>
    rows.map((row) => ({ name: lineByItem.get(row.orderItemId)?.name ?? UNKNOWN_ITEM_NAME, quantity: row.quantity }));
  const cancelledFulfillmentIds = new Set(
    fulfillments.filter((row) => row.cancelledAt !== null).map((row) => row.fulfillmentId),
  );
  // 手の再送が送信待ちかは、種類と発送の組で見る（発送のメールは、発送ごとに別の再送を持てる）
  const resendKey = (row: OrderEmailHistoryRow) => `${row.kind}:${row.fulfillmentId ?? ''}`;
  const openManualKeys = new Set(
    emailRows.filter((row) => row.origin === 'manual' && OPEN_STATUSES.has(row.status)).map(resendKey),
  );

  const emailEntries: OrderHistoryEmailEntry[] = emailRows.map((row) => {
    const state = describeOrderEmailState(row.status, row.deliveryStatus);
    return {
      type: 'email',
      at: row.createdAt,
      emailId: row.id,
      kind: row.kind,
      kindLabel:
        row.kind === 'shipped' && row.fulfillmentNumber !== null
          ? `発送（${row.fulfillmentNumber}回目）`
          : ORDER_EMAIL_KIND_LABELS[row.kind],
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
        && !openManualKeys.has(resendKey(row))
        // 取り消した発送のメールは、もう送る意味が無い（DB の関数も断る）
        && !(row.fulfillmentId !== null && cancelledFulfillmentIds.has(row.fulfillmentId)),
      fulfillmentId: row.fulfillmentId,
      fulfillmentNumber: row.fulfillmentNumber,
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

  const fulfillmentEntries: OrderHistoryFulfillmentEntry[] = fulfillments.map((row) => {
    const cancelled = row.cancelledAt !== null;
    return {
      type: 'fulfillment',
      at: row.shippedAt,
      fulfillmentId: row.fulfillmentId,
      number: row.number,
      carrierLabel: isShippingCarrierId(row.shippingCarrier) ? SHIPPING_CARRIERS[row.shippingCarrier].label : null,
      trackingNumber: row.trackingNumber,
      items: itemsOf(row.lines),
      actorEmail: row.createdByEmail,
      notifyCustomer: row.notifyCustomer,
      completesOrder: row.completesOrder,
      cancelled,
      cancellable: !cancelled && (order.status === 'paid' || order.status === 'shipped'),
      legacy: row.legacy,
    };
  });

  const fulfillmentCancelEntries = fulfillments.flatMap((row): OrderHistoryFulfillmentCancelEntry[] =>
    row.cancelledAt === null
      ? []
      : [{ type: 'fulfillment_cancel', at: row.cancelledAt, fulfillmentId: row.fulfillmentId, number: row.number, actorEmail: row.cancelledByEmail }],
  );

  const completionEntries: OrderHistoryCompletionEntry[] = completions.map((row) => {
    const cancelled = row.cancelledAt !== null;
    const line = lineByItem.get(row.orderItemId);
    return {
      type: 'completion',
      at: row.createdAt,
      completionId: row.completionId,
      items: itemsOf([row]),
      actorEmail: row.createdByEmail,
      cancelled,
      // 取り消しても、仕上がった数が送った数を下回らない時だけ（DB の関数も同じ決まりで断る）
      cancellable: !cancelled && order.status === 'paid' && line !== undefined && line.completed - row.quantity >= line.shipped,
      legacy: row.legacy,
    };
  });

  const completionCancelEntries = completions.flatMap((row): OrderHistoryCompletionCancelEntry[] =>
    row.cancelledAt === null
      ? []
      : [{ type: 'completion_cancel', at: row.cancelledAt, completionId: row.completionId, actorEmail: row.cancelledByEmail }],
  );

  // 同じ時刻（同じ取引で書いた行）は、結果が上に来る順に置く: メール → 状態 → 取消 → 発送・仕上がり → 受付
  const entries: OrderHistoryEntry[] = [
    ...emailEntries,
    ...statusEntries,
    ...fulfillmentCancelEntries,
    ...completionCancelEntries,
    ...fulfillmentEntries,
    ...completionEntries,
    { type: 'created', at: order.createdAt },
  ];
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

`Array.prototype.sort` は安定なので、同じ時刻では上の並べた順のまま残る。

Run: `npx jest tests/unit/lib/orders/email/order-history.test.ts --runInBand`
Expected: PASS
（この時点では、履歴の窓口がまだ新しい入力 `fulfillments`・`completions`・`lines` を渡さない。窓口の試験と型の確かめは、Step 11〜13 で通す）

- [ ] **Step 11: 再送の窓口と履歴の窓口の試験を直す**

`tests/unit/api/admin/order-email-routes.test.ts`（全体を次に置き換える。商品の名前を読むため `from` の入れ物を表ごとに分け、履歴に発送・仕上がりが入る試験と、再送の中身 `{ kind, fulfillmentId? }` の試験を足す。メールの中身の describe は変えない）:

```ts
/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

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
const mockOrderItems = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    // 注文の行は eq の後ろの maybeSingle で1行、商品の名前は eq の後ろをそのまま待つ
    from: (table: string) => ({
      select: () => ({
        eq: () => (table === 'order_items' ? mockOrderItems() : { maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }),
      }),
    }),
  })),
}));

import { GET as getHistory } from '@/app/api/admin/orders/[id]/history/route';
import { GET as getContent } from '@/app/api/admin/orders/[id]/emails/[emailId]/route';
import { POST as postResend } from '@/app/api/admin/orders/[id]/emails/resend/route';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const EMAIL_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset();
  mockMaybeSingle.mockReset();
  mockOrderItems.mockReset();
  mockOrderItems.mockResolvedValue({ data: [], error: null });
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
    expect(body.entries[0]).toMatchObject({ emailId: EMAIL_ID, stateLabel: '送信済み', resendable: true, fulfillmentId: null, fulfillmentNumber: null });
    expect(mockRpc).toHaveBeenCalledWith('list_order_status_history', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_email_history', { _order_id: ORDER_ID });
    expect(JSON.stringify(body)).not.toContain('order_confirmed');
  });

  it('発送・仕上がり・発送ごとのメールも新しい順に返し、商品の名前は「商品名（色 / サイズ）」で出す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockOrderItems.mockResolvedValue({
      data: [
        { id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M' },
        { id: ITEM_2, item_name: 'リネンパンツ', color: null, size: null },
      ],
      error: null,
    });
    rpcReturns({
      list_order_email_history: { data: [{
        email_id: EMAIL_ID, kind: 'shipped', variant: null, origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1,
        last_error_code: null, delivery_status: null, delivery_event_at: null, created_at: '2026-10-10T02:00:00+00:00',
        sent_at: '2026-10-10T02:00:05+00:00', finished_at: '2026-10-10T02:00:05+00:00', has_body: true, body_erased: false,
        fulfillment_id: FULFILLMENT_ID, fulfillment_number: 1,
      }] },
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
      list_order_fulfillments: { data: [{
        fulfillment_id: FULFILLMENT_ID, number: 1, shipping_carrier: 'yamato', tracking_number: '1234-5678', notify_customer: true,
        completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
        cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 1 }],
      }] },
      list_order_completions: { data: [{
        completion_id: COMPLETION_ID, order_item_id: ITEM_2, quantity: 1, created_at: '2026-10-10T01:00:00+00:00',
        created_by_email: 'admin@example.com', cancelled_at: null, cancelled_by_email: null, legacy: false,
      }] },
      list_order_line_fulfillment: { data: [
        {
          order_id: ORDER_ID, order_item_id: ITEM_1, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1, completed: 2,
          in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
        {
          order_id: ORDER_ID, order_item_id: ITEM_2, variant_id: 12, fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 1,
          in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
      ] },
    });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { type: string }) => entry.type)).toEqual(['email', 'fulfillment', 'completion', 'created']);
    expect(body.entries[0]).toMatchObject({
      kindLabel: '発送（1回目）', fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, resendable: true,
    });
    expect(body.entries[1]).toMatchObject({
      number: 1, carrierLabel: 'ヤマト運輸', trackingNumber: '1234-5678', cancellable: true,
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 1 }], actorEmail: 'admin@example.com',
    });
    expect(body.entries[2]).toMatchObject({ items: [{ name: 'リネンパンツ', quantity: 1 }], cancellable: true });
    expect(mockRpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_completions', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
  });

  it('権限が無ければ認可の応答、注文番号の形が違えば 400、無ければ 404、DB の失敗は 500', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });
    expect((await getHistory(request(), context)).status).toBe(403);

    expect((await getHistory(request(), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);

    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await getHistory(request(), context)).status).toBe(404);

    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      rpcReturns({ list_order_status_history: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
      const response = await getHistory(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'OrderEmailStoreError', '08006']]);
    } finally {
      error.mockRestore();
    }
  });

  it('発送の一覧・商品の名前の読み込みが失敗しても 500。ログは例外名と DB の記号だけ', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      rpcReturns({ list_order_fulfillments: { data: null, error: { message: '宛先を含む例外', code: '08006' } } });
      expect((await getHistory(request(), context)).status).toBe(500);

      rpcReturns({});
      mockOrderItems.mockResolvedValueOnce({ data: null, error: { message: '宛先を含む例外', code: '42P01' } });
      const response = await getHistory(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([
        ['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '08006'],
        ['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '42P01'],
      ]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('GET /api/admin/orders/[id]/emails/[emailId]', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID, emailId: EMAIL_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/${EMAIL_ID}`);

  it('送信済みのメールの件名と本文を返す', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: '件名', body_text: '本文', sent_at: '2026-10-09T01:00:05.000Z', body_erased: false }] } });

    const response = await getContent(request(), context);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockRpc).toHaveBeenCalledWith('get_order_email_content', { _order_id: ORDER_ID, _email_id: EMAIL_ID });
    await expect(response.json()).resolves.toEqual({ status: 'available', subject: '件名', bodyText: '本文', sentAt: '2026-10-09T01:00:05.000Z' });
  });

  it('本文を消した後は消したことだけ返し、無い・送信済みでなければ 404', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: null, body_text: null, sent_at: '2026-08-01T00:00:00.000Z', body_erased: true }] } });
    const response = await getContent(request(), context);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'erased', sentAt: '2026-08-01T00:00:00.000Z' });

    rpcReturns({ get_order_email_content: { data: [] } });
    expect((await getContent(request(), context)).status).toBe(404);

    expect((await getContent(request(), { params: Promise.resolve({ id: ORDER_ID, emailId: 'x' }) })).status).toBe(400);
  });

  it('中身を見る権限が無ければ 403 で DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });
    expect((await getContent(request(), context)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('中身の DB の失敗は 500 で、ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ get_order_email_content: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await getContent(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load content' });
      expect(error.mock.calls).toEqual([['[admin.orders.email.content] Failed to load content', 'OrderEmailStoreError', '08006']]);
    } finally {
      error.mockRestore();
    }
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

    const req = request({ kind: 'paid' });
    const response = await postResend(req, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, emailId: EMAIL_ID });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600, subject: 'admin-1' });
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', { _order_id: ORDER_ID, _kind: 'paid', _actor_id: 'admin-1', _fulfillment_id: null });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { kind: 'paid', email_id: EMAIL_ID },
    }));
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('発送のメールは、どの発送かを付けて再送を頼む。どの発送かも監査に残す', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const response = await postResend(request({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }), context);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', {
      _order_id: ORDER_ID, _kind: 'shipped', _actor_id: 'admin-1', _fulfillment_id: FULFILLMENT_ID,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: { kind: 'shipped', fulfillment_id: FULFILLMENT_ID, email_id: EMAIL_ID },
    }));
    // 入れた鍵が maskAuditEvent に伏せられることもない
    const { maskAuditEvent } = jest.requireActual('@/lib/audit');
    const audited = mockLogAudit.mock.calls[0][0];
    expect(maskAuditEvent(audited).metadata).toEqual(audited.metadata);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('発送のメール以外は、発送の番号が null でも受ける（持たない扱い）', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const response = await postResend(request({ kind: 'paid', fulfillmentId: null }), context);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', expect.objectContaining({ _kind: 'paid', _fulfillment_id: null }));
  });

  it('権限が無ければ CSRF を確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わない・回数の制限を超えたら、行を足さない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();

    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('知らない種類・形の違う注文番号は 400', async () => {
    expect((await postResend(request({ kind: 'refund' }), context)).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body', metadata: null }));
    expect((await postResend(request({ kind: 'paid' }), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  it.each([
    ['発送のメールに発送の番号が無い', { kind: 'shipped' }],
    ['発送のメールの発送の番号が null', { kind: 'shipped', fulfillmentId: null }],
    ['発送のメールの発送の番号が UUID でない', { kind: 'shipped', fulfillmentId: 'x' }],
    ['発送のメール以外に発送の番号がある', { kind: 'paid', fulfillmentId: FULFILLMENT_ID }],
  ])('%s なら 400。行を足さず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postResend(request(body), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限で 429 なら行・監査・送信予約を作らない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));
    const req = request({ kind: 'paid' });
    expect((await postResend(req, context)).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600, subject: 'admin-1' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each(['null', '{', JSON.stringify({ kind: '宛先・件名・本文' })])('本文の形が誤り（%s）なら固定の文だけで failure の監査を残す', async (body) => {
    const req = new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' }, body,
    });
    expect((await postResend(req, context)).status).toBe(400);
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['RESEND_ALREADY_QUEUED', '23505', 409, '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。'],
    ['RESEND_NOT_ALLOWED', '22023', 409, '今の注文の状態では、このメールは再送できません。'],
    ['ORDER_NOT_FOUND', 'P0002', 404, '注文が見つかりません。'],
  ])('DB が %s（%s）で断ったら %i', async (message, code, status, error) => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message, code } } });

    const response = await postResend(request({ kind: 'paid' }), context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: status === 404 ? 'failure' : 'conflict', metadata: { kind: 'paid' } }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('取り消した発送のメールの再送を DB が断ったら 409。どの発送かを監査に残す', async () => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message: 'RESEND_NOT_ALLOWED', code: '22023' } } });

    const response = await postResend(request({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: '今の注文の状態では、このメールは再送できません。' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'conflict', metadata: { kind: 'shipped', fulfillment_id: FULFILLMENT_ID },
    }));
  });

  it('思いがけない DB の失敗は 500', async () => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postResend(request({ kind: 'paid' }), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '再送を受け付けられませんでした。' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.email.resend] Failed to request resend', 'OrderEmailStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to request resend', metadata: { kind: 'paid' } }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
```

Run: `npx jest tests/unit/api/admin/order-email-routes.test.ts --runInBand`
Expected: FAIL（再送の窓口がまだ `fulfillmentId` を受けず、履歴の窓口が発送・仕上がりを返さない）

- [ ] **Step 12: 再送の窓口を直す**

`src/app/api/admin/orders/[id]/emails/resend/route.ts`（全体を次に置き換える。中身の形・DB への引数・監査の鍵が変わる。守りの順と答えは今のまま）:

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
  OrderEmailStoreError,
  requestOrderEmailResend,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';

// 発送のメールだけが、どの発送のメールかを持つ（DB の表の CHECK `(kind = 'shipped') = (fulfillment_id IS NOT NULL)` と同じ決まり）。
// null は「持たない」として受ける（画面が、発送の番号の無いメールも同じ形で送れるように）
const bodySchema = z
  .object({ kind: z.enum(ORDER_EMAIL_KINDS), fulfillmentId: z.string().uuid().nullish() })
  .refine((body) => (body.kind === 'shipped') === Boolean(body.fulfillmentId));

const RATE_LIMIT = { endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 } as const;

const MESSAGES = {
  already_queued: '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。',
  not_allowed: '今の注文の状態では、このメールは再送できません。',
  order_not_found: '注文が見つかりません。',
  failed: '再送を受け付けられませんでした。',
} as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * お客様へのメールの再送（グループ D 設計書 5-3、グループ E-1 設計書 8-2）。手で足した印の新しい行を作り、今の注文の情報で作り直して送る。
 * 発送のメールは発送ごとに別のメールなので、どの発送かも受ける。
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
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.email.resend',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は個人情報を含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { kind } = parsedBody.data;
  const fulfillmentId = parsedBody.data.fulfillmentId ?? null;
  // 発送の番号は個人情報ではないので、どの発送のメールかを監査に残す
  const target = fulfillmentId ? { kind, fulfillment_id: fulfillmentId } : { kind };

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    const emailId = await requestOrderEmailResend(store, { orderId: parsedId.data, kind, actorId: authz.userId, fulfillmentId });
    await audit('success', 'Order email resend requested', { ...target, email_id: emailId });
    scheduleOrderEmailDelivery();
    return NextResponse.json({ success: true, emailId });
  } catch (error) {
    if (error instanceof OrderEmailResendError) {
      if (error.reason === 'order_not_found') {
        await audit('failure', 'Order not found', target);
        return NextResponse.json({ error: MESSAGES.order_not_found }, { status: 404 });
      }
      await audit('conflict', error.reason === 'already_queued' ? 'Resend already queued' : 'Resend not allowed', target);
      return NextResponse.json({ error: MESSAGES[error.reason] }, { status: 409 });
    }
    console.error('[admin.orders.email.resend] Failed to request resend', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof OrderEmailStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to request resend', target);
    return NextResponse.json({ error: MESSAGES.failed }, { status: 500 });
  }
}
```

Run: `npx jest tests/unit/api/admin/order-email-routes.test.ts --runInBand -t "resend"`
Expected: PASS（再送の describe だけ。履歴の describe は次の手順で通す）

- [ ] **Step 13: 履歴の窓口を直す**

`src/app/api/admin/orders/[id]/history/route.ts`（全体を次に置き換える。発送・仕上がり・商品の名前を足す）:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { buildOrderHistory, type OrderHistoryLine } from '@/lib/orders/email/order-history';
import {
  getOrderEmailSendState,
  listOrderEmailHistory,
  listOrderStatusHistory,
  OrderEmailStoreError,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import {
  FulfillmentStoreError,
  listOrderCompletions,
  listOrderFulfillments,
  listOrderLineFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';

type HistoryOrderRow = { id: string; status: OrderStatus; shipping_email: string | null; created_at: string };
type HistoryItemRow = { id: string; item_name: string; color: string | null; size: string | null };

/**
 * 注文の商品ごとの名前と、発送した数・仕上がった数。名前はメールの明細と同じ「商品名（色 / サイズ）」。
 * 発送と仕上がりの行に商品の名前を出し、仕上がりを取り消せるかを決めるのに使う。
 */
async function loadHistoryLines(client: SupabaseClient, orderId: string): Promise<OrderHistoryLine[]> {
  const [itemsResult, countsByOrder] = await Promise.all([
    client.from('order_items').select('id, item_name, color, size').eq('order_id', orderId),
    listOrderLineFulfillment(client, [orderId]),
  ]);
  if (itemsResult.error) {
    throw new FulfillmentStoreError('load_order_items', itemsResult.error);
  }
  const counts = new Map((countsByOrder.get(orderId) ?? []).map((row) => [row.orderItemId, row] as const));
  return ((itemsResult.data ?? []) as HistoryItemRow[]).flatMap((item): OrderHistoryLine[] => {
    const row = counts.get(item.id);
    if (!row) {
      return [];
    }
    const variant = [item.color, item.size].filter(Boolean).join(' / ');
    return [{
      orderItemId: item.id,
      name: variant ? `${item.item_name}（${variant}）` : item.item_name,
      shipped: row.shipped,
      completed: row.completed,
    }];
  });
}

/** 「この注文の履歴」（グループ D 設計書 5-1、グループ E-1 設計書 9-2）。状態の変化・メール・発送・仕上がりとその取消を新しい順に返す。本文は返さない */
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
    const [statusRows, emailRows, sendState, fulfillments, completions, lines] = await Promise.all([
      listOrderStatusHistory(store, order.id),
      listOrderEmailHistory(store, order.id),
      getOrderEmailSendState(store),
      listOrderFulfillments(supabase, order.id),
      listOrderCompletions(supabase, order.id),
      loadHistoryLines(supabase, order.id),
    ]);

    return NextResponse.json(
      buildOrderHistory({
        order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: order.created_at },
        statusRows,
        emailRows,
        sendState,
        fulfillments,
        completions,
        lines,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin.orders.history] Failed to load history', error instanceof Error ? error.name : 'UnknownError',
      ...((error instanceof OrderEmailStoreError || error instanceof FulfillmentStoreError) && error.code ? [error.code] : []));
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
```

Run: `npx jest tests/unit/api/admin/order-email-routes.test.ts --runInBand`
Expected: PASS
Run: `npx tsc --noEmit`
Expected: 誤りは次の3つのファイルだけ（履歴の型の変更に追いついていない所。次の Step 14 で直す）: `src/components/OrderHistoryDialog.tsx`（`renderEntry` の最後が、メール以外の行を読めない）、`tests/unit/components/OrderHistoryDialog.test.tsx`・`e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`（型付きの見本に `fulfillmentId`・`fulfillmentNumber` が無い）

- [ ] **Step 14: 履歴の型に合わせて、画面の1か所と型付きの見本を直す**

`OrderHistoryEntry` に4つの行が増え、`OrderHistoryEmailEntry` に必須の列が2つ増えたので、型を通す最小の直しを入れる。発送・仕上がりの行の描き方は Task 6 が履歴の画面ごと作り直す（その時この1か所も置き換わる）。

(a) `src/components/OrderHistoryDialog.tsx` の `renderEntry` の中の、`if (entry.type === 'status') { … }` の閉じの `}` の後、メールの行の `return (` の前に足す:

```tsx
    // 発送・仕上がりとその取消の行は Task 6 で描く。それまではメールの行だけを描く
    if (entry.type !== 'email') {
      return null;
    }
```

(b) `tests/unit/components/OrderHistoryDialog.test.tsx` の型付きの見本2か所に、2つの列を足す。

`history()` の中:

置き換える前:

```tsx
        sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z', canViewContent: true, bodyErased: false, resendable: true,
```

置き換えた後:

```tsx
        sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z', canViewContent: true, bodyErased: false, resendable: true,
        fulfillmentId: null, fulfillmentNumber: null,
```

`sentEmailEntry()` の中:

置き換える前:

```tsx
    sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: null, canViewContent: true, bodyErased: false, resendable: true,
```

置き換えた後:

```tsx
    sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: null, canViewContent: true, bodyErased: false, resendable: true,
    fulfillmentId: null, fulfillmentNumber: null,
```

(c) `e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts` の `SENT_EMAIL`（`satisfies OrderHistoryEmailEntry` の見本）:

置き換える前:

```ts
  canViewContent: true, bodyErased: false, resendable: true,
```

置き換えた後:

```ts
  canViewContent: true, bodyErased: false, resendable: true, fulfillmentId: null, fulfillmentNumber: null,
```

Run: `npx tsc --noEmit`
Expected: 誤り0件
Run: `npx jest tests/unit/components/OrderHistoryDialog.test.tsx --runInBand`
Expected: PASS（メールの行の描き方は変わらない）

- [ ] **Step 15: 型・lint・単体の全体を確かめる**

Run: `npx jest tests/unit/api tests/unit/lib/orders tests/unit/components --runInBand`
Expected: PASS（`OrderHistoryDialog.test.tsx`・`AdminOrderHistoryWiring.test.tsx` を含む。履歴の画面は Task 6 まで発送・仕上がりの行を描かないだけで、今の試験は通る。管理画面の「発送済みにする」は、状態の窓口へ `status: 'shipped'` を送って 400 になるが、それを確かめる今の試験は無い。画面のつなぎは Task 6・7 で新しい窓口へ替える）
Run: `npx tsc --noEmit`
Expected: 誤り0件
Run: `npm run lint`
Expected: エラー0件

- [ ] **Step 16: コミット（controller）**

```bash
git add "src/app/api/admin/orders/[id]/fulfillments/route.ts" "src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts" "src/app/api/admin/orders/[id]/completions/route.ts" "src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts" "src/app/api/admin/orders/[id]/status/route.ts" "src/app/api/admin/orders/[id]/emails/resend/route.ts" "src/app/api/admin/orders/[id]/history/route.ts" src/lib/orders/email/order-history.ts tests/unit/api/admin/order-fulfillment-routes.test.ts tests/unit/api/admin/order-completion-routes.test.ts tests/unit/api/admin/order-status-shipped.test.ts tests/unit/api/admin/order-email-routes.test.ts tests/unit/lib/orders/email/order-history.test.ts src/components/OrderHistoryDialog.tsx tests/unit/components/OrderHistoryDialog.test.tsx e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts
git commit -m "feat(admin): 発送・仕上がり・取消・再送・履歴の窓口を足し、状態の窓口から発送の道を消す（グループ E-1）" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 管理画面の発送の画面・仕上がりの画面・履歴の画面

**Files:**
- Create: `src/lib/orders/fulfillment/fulfillment-client.ts`（画面から発送・仕上がりの窓口を呼ぶ道具と、画面で同じに扱う入力の部品。ブラウザだけで動く。T6-2）
- Create: `src/components/OrderCompletionDialog.tsx`
- Modify: `src/components/OrderShipDialog.tsx`（作り直し。今の 1〜117 行を全部置き換える）
- Modify: `src/components/OrderHistoryDialog.tsx`（全体を置き換える。今との違いは Step 10 の一覧）
- Modify: `src/components/ui/Dialog/Dialog_types.ts:19`・`src/components/ui/Dialog/Dialog.tsx:39,122`・`src/components/ui/Dialog/Dialog.css:83`（`fullScreenOnMobile` を足す。T6-1）
- Test: `tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts`（新規）・`tests/unit/components/OrderCompletionDialog.test.tsx`（新規）・`tests/unit/components/OrderShipDialog.test.tsx`（書き直し）・`tests/unit/components/OrderHistoryDialog.test.tsx:3`（import と、ファイルの終わりに試験の追加）・`tests/unit/components/Dialog.test.tsx:1`（追加）

**Interfaces:**
- Consumes:
  - Task 3 の `src/lib/orders/fulfillment/fulfillment-types.ts`: 型 `FulfillmentMaterials`・`FulfillmentMaterialLine`・`FulfillmentLineQuantity`・`CreateFulfillmentRequest`・`CreateFulfillmentResponse`・`RecordCompletionRequest`・`RecordCompletionResponse`・`CancelFulfillmentResponse`・`CancelCompletionResponse`、関数 `initialShipQuantities`・`totalQuantity`
  - Task 3 の `src/lib/orders/fulfillment/fulfillment-messages.ts`: `FULFILLMENT_ERROR_MESSAGES[記号]`（`{ status, message }`。この Task は `.message` だけを読む。発送できない理由の3つ `not_shippable`・`address_incomplete`・`payment_review_required` と、仕上がりを記録できない時の `not_in_production` を使う）、`FULFILLMENT_FAILURE_MESSAGES`（`create`・`cancel`・`completion`・`completion_cancel`・`materials`。窓口が日本語の断りを返さない時の代わりの文に使う）、`UNKNOWN_OUTCOME_MESSAGE`
  - Task 5 の窓口（本文は包みなしで、上の型そのもの。断りは `{ error, code }`）: `GET`・`POST /api/admin/orders/[id]/fulfillments`、`POST /api/admin/orders/[id]/completions`、`POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel`、`POST /api/admin/orders/[id]/completions/[completionId]/cancel`、`POST /api/admin/orders/[id]/emails/resend`（本文 `{ kind, fulfillmentId? }`）、`GET /api/admin/orders/[id]/history`
  - Task 5 の `src/lib/orders/email/order-history.ts`: 型 `OrderHistoryFulfillmentEntry`・`OrderHistoryCompletionEntry`、履歴の4つの新しい行（`fulfillment`・`fulfillment_cancel`・`completion`・`completion_cancel`）、発送のメールの行の `fulfillmentId`・`fulfillmentNumber`
  - 既存: `Dialog`・`Button`・`Checkbox`・`TagLabel`・`StatusBadge`・`clientFetch`・`SHIPPING_CARRIERS`・`isShippingCarrierId`
- Produces:
  - `OrderShipDialog({ orderId: string | null; onClose: () => void; onShipped: (result: CreateFulfillmentResponse) => void })`、`OrderCompletionDialog({ orderId: string | null; onClose: () => void; onRecorded: () => void })`、`OrderHistoryDialog({ orderId: string | null; onClose: () => void; onChanged?: () => void })`（共通の約束のとおり）
  - `Dialog` の新しい props `fullScreenOnMobile?: boolean`（幅 768px 未満で画面いっぱいに開く）
  - `fulfillment-client.ts`: `callFulfillmentApi<T>(url, body, fallbackMessage)`・`fetchFulfillmentMaterials(orderId)`・`lineLabel(line)`・`clampQuantity(raw, max)`・`COMPLETION_RECORDED_MESSAGE`・`NO_COMPLETION_QUANTITY_MESSAGE`・型 `FulfillmentCallResult<T>`・`FulfillmentMaterialsResult`（Task 7 の管理画面が `COMPLETION_RECORDED_MESSAGE` を使う）
  - 画面の作りの約束（Task 10 の E2E が頼る所）: 発送の画面と仕上がりの画面は `role="dialog"` で、名前は `発送済みにする`・`仕上がりを記録する`。商品ごとに `role="group"`（名前は `商品名（色 / サイズ）`）で、入力の名前（`label`）は `今回送る数`・`仕上がった数`。誤りと、答えが分からない時の文は、`role="alert"` の1か所に出る。答えが分からない時は、入力・選択・チェックを全部止め、下のボタンは `もう一度確かめる`・`閉じる` だけになる（在庫の品だけの注文なら、画面の中のボタンはこの2つだけ）。履歴の取消の確かめの画面は `role="dialog"` で、名前は `この発送を取り消す`・`この仕上がりを取り消す`、履歴の行は `li`

**決め事**（本計画 P6 の続き。設計書に書いていない所）:

| ID | 決め事 | 理由 |
|---|---|---|
| T6-1 | 小さい画面で画面いっぱいに開く指定は、`Dialog` に足す任意の prop `fullScreenOnMobile` にする（`data-ui-dialog-fullscreen="mobile"` と、`Dialog.css` の `@media (max-width: 767.98px)`）。`className` は使わない | 今の `Dialog` の `size` は文字の大きさだけで、画面いっぱいの指定が無い。`.dialog-panel` の最大幅と余白は `@layer` の外の CSS なので、`className` の Tailwind では上書きできない。発送の画面と仕上がりの画面だけが使う |
| T6-2 | 窓口を呼ぶ道具は `fulfillment-client.ts` の1か所にする。通信が切れた・500番台・成功なのに答えを読めない → 「分からない」（記録されたかもしれない）、400番台 → 「断られた」（400・404・409 は窓口の日本語の文、401・403 は固定の文、回数の制限などは代わりの文） | 発送・仕上がり・2つの取消で同じ分け方を使う。共通の守り（回数の制限）の英語の短い文を画面に出さない（履歴の再送と同じ決まり） |
| T6-3 | 重複防止キーは画面を開いた時に作る（発送用と、画面の中の仕上がり用の2つ）。窓口が断った時だけ作り直し、答えが分からない時は作り直さない | 二重押しは同じキーで1回になる。断られた操作は記録されていないので、次の送信は別の操作。答えが分からない操作は、同じキーで送り直すと前の結果が返る |
| T6-4 | 画面の中で仕上がりを記録したら、材料を読み直し、記録した数をその商品の今回送る数に足す（発送準備中の数まで）。ほかの商品の入力は変えない | 仕上がった品をそのまま送る流れが自然。設計書 6-1「記録すると、その数が発送準備中に移り、送る数を入れられる」を満たし、入れ直したければ直せる |
| T6-5 | 答えが分からないまま「閉じる」を押しても、一覧は読み直さない。開き直すと材料を読み直すので、記録されていれば発送準備中の数が減って見える | 画面の props は共通の約束のまま増やさない。二重の発送は、開き直しで読む材料と DB の関数の数の確かめで止まる |
| T6-6 | 履歴の取消の答えが分からない時は、履歴へ戻って読み直し、確かめるよう知らせる。確かめ直しの画面は作らない | 取消は何度押しても同じ結果（`already_cancelled`）で、二重にならない |
| T6-7 | 履歴の行のボタンの印は `data-email-id` をやめ、`data-history-id`（メール・発送・仕上がりの行の番号）に統一する | 確かめの画面から戻る時に同じ行のボタンへフォーカスを戻す仕組みを、取消のボタンにも使う |

この Task で足した言葉（`Global Constraints` に無い物。Task 10・11 は同じ言葉を使う）:

| 場所 | 言葉 |
|---|---|
| 発送の画面・仕上がりの画面 | `読み込み中です...`（今の履歴の画面と同じ）・`仕上がった数を入れてください。`（仕上がった数の合計が0）・`受注生産中の商品はありません。`・商品の一覧の名前 `発送する商品`・`仕上がりを記録する商品` |
| 窓口の共通の断り（3つの画面で同じ） | 401 `認証が必要です。再ログインしてください。`、403 `この操作の権限がありません。`（今の履歴・管理画面の文）。窓口の日本語の文が無い時の代わりの文と、材料を読めなかった時の文は、Task 3 の `FULFILLMENT_FAILURE_MESSAGES` の言葉 |
| 履歴の画面 | 印 `取り消し済み`、`配送業者: {名前} / 伝票番号: {番号}`、`商品: {名前} × {数}`（` / ` 区切り）、`お客様へのメール: 送る`／`送らない`、`この発送で全部を送りました`、取消の画面の題 `この発送を取り消す`／`この仕上がりを取り消す`、取消の後の知らせ `発送（{n}回目）を取り消しました。`／`仕上がりを取り消しました。`、取消の答えが分からない時 `結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。` |

Review Focus の 1（同時の発送の 409）・2（通信が切れた後の確かめ直し）・4（送った数を下回る仕上がりの取消）のうち、画面の分はこの Task の試験が確かめる。

既存のファイルは CRLF だが、この計画のコードは LF で書いてある。`git add` の時に改行が整うので、気にしない。置き換えの指示（前→後）は、改行の違いを無視して、中身が同じ所を探す。

- [ ] **Step 1: 共通の道具の試験を書く**

窓口の答えの分け方（記録できた・断られた・分からない）と、数の入力の収め方を試験にする。通信が切れた・500番台・成功なのに答えを読めない時は「分からない」にする（窓口は記録しているかもしれないので、画面は同じ重複防止キーで確かめ直す）。400・404・409 は窓口の日本語の文をそのまま、401・403 は固定の文、回数の制限（429）などの英語の短い文は出さずに代わりの文にする。

`tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts`:

```ts
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import {
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('callFulfillmentApi', () => {
  it('本文を JSON で POST し、成功の答えをそのまま返す', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ fulfillmentId: 'f-1', number: 1 }));

    const result = await callFulfillmentApi<{ fulfillmentId: string }>('/api/x', { requestKey: 'k' }, '失敗');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey: 'k' }),
    });
    expect(result).toEqual({ kind: 'ok', body: { fulfillmentId: 'f-1', number: 1 } });
  });

  it('本文が無い取消の呼び出しは、headers も body も付けない', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ outcome: 'cancelled' }));

    await callFulfillmentApi('/api/cancel', undefined, '失敗');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/cancel', { method: 'POST' });
  });

  it.each([500, 502, 503])('%i は「記録されたか分からない」にする', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, status));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時は「記録されたか分からない」にする', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('成功なのに答えを読めない時も「記録されたか分からない」にする（窓口は記録している）', async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    [400, '入力を確かめてください。'],
    [404, '注文が見つかりません。'],
    [409, '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
  ])('%i は窓口が返した日本語の文をそのまま返す', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'x' }, status));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'refused', message });
  });

  it('窓口の文が無い・文字でない・長すぎる時は、代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ error: 42 }, 409))
      .mockResolvedValueOnce(json({ error: 'あ'.repeat(201) }, 409))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    for (let index = 0; index < 4; index += 1) {
      await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
    }
  });

  it('401・403 は固定の文、回数の制限（429）など共通の守りの英語の文は出さずに代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: '認証が必要です。再ログインしてください。',
    });
    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: 'この操作の権限がありません。',
    });
    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
  });
});

describe('fetchFulfillmentMaterials', () => {
  it('発送の材料の窓口を読み、そのまま返す', async () => {
    const materials = { order: { id: ORDER_ID }, blockedReason: null, lines: [], fulfillments: [] };
    mockClientFetch.mockResolvedValueOnce(json(materials));

    const result = await fetchFulfillmentMaterials(ORDER_ID);

    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/fulfillments`, { cache: 'no-store' });
    expect(result).toEqual({ ok: true, materials });
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
    [429, { error: 'Too many requests' }, '発送の材料を読み込めませんでした。'],
  ])('%i の時は画面に出す文を返す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(fetchFulfillmentMaterials(ORDER_ID)).resolves.toEqual({ ok: false, message });
  });

  it('通信が切れても例外にせず、読めなかった文を返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchFulfillmentMaterials(ORDER_ID)).resolves.toEqual({
      ok: false,
      message: '発送の材料を読み込めませんでした。',
    });
  });
});

describe('lineLabel', () => {
  it('色とサイズを括弧に入れる。片方だけでも、どちらも無くても崩れない', () => {
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: 'M' })).toBe('シルクブラウス（白 / M）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: 'M' })).toBe('シルクブラウス（M）');
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: null })).toBe('シルクブラウス（白）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: null })).toBe('シルクブラウス');
  });
});

describe('clampQuantity', () => {
  it.each([
    ['2', 5, 2],
    ['9', 5, 5],
    ['0', 5, 0],
    ['-3', 5, 0],
    ['', 5, 0],
    ['abc', 5, 0],
    ['1.9', 5, 1],
    ['3', 0, 0],
  ])('%j（上限 %i）は %i にする', (raw, max, expected) => {
    expect(clampQuantity(raw, max)).toBe(expected);
  });
});
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts --runInBand`
Expected: FAIL（`Cannot find module '@/lib/orders/fulfillment/fulfillment-client'`）

- [ ] **Step 2: 共通の道具を書く**

`src/lib/orders/fulfillment/fulfillment-client.ts`:

```ts
import { clientFetch } from '@/lib/client-fetch';
import { FULFILLMENT_FAILURE_MESSAGES } from '@/lib/orders/fulfillment/fulfillment-messages';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 管理画面（ブラウザ）から発送・仕上がりの窓口を呼ぶ道具と、発送の画面・仕上がりの画面・履歴の画面で同じに扱う部品。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 */

/** 仕上がりを記録した後の知らせ（仕上がりの画面は閉じるので、管理画面の一覧が出す） */
export const COMPLETION_RECORDED_MESSAGE = '仕上がりを記録しました。';
export const NO_COMPLETION_QUANTITY_MESSAGE = '仕上がった数を入れてください。';

const UNAUTHENTICATED_MESSAGE = '認証が必要です。再ログインしてください。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';

/** 窓口の答えを、画面が分けて扱う3つにする */
export type FulfillmentCallResult<T> =
  | { kind: 'ok'; body: T }
  // 窓口が断った（記録していない）。画面に出す文を持つ
  | { kind: 'refused'; message: string }
  // 通信が切れた・500番台・成功なのに答えを読めない。記録されたか分からない
  | { kind: 'unknown' };

export type FulfillmentMaterialsResult =
  | { ok: true; materials: FulfillmentMaterials }
  | { ok: false; message: string };

/** 窓口が日本語で返す断りの文（400・404・409 の `{ error }`）。文字でない・長すぎる時は使わない */
function ownErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' && error.length > 0 && error.length <= 200 ? error : null;
}

/**
 * 断られた時に画面へ出す文。回数の制限などの共通の守りは英語の短い文を返すので、窓口が日本語で返す
 * 400・404・409 の文だけをそのまま出し、権限（401・403）は固定の文にする。
 */
function refusalMessage(status: number, body: unknown, fallback: string): string {
  if (status === 401) return UNAUTHENTICATED_MESSAGE;
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 400 || status === 404 || status === 409) return ownErrorMessage(body) ?? fallback;
  return fallback;
}

/**
 * 発送・仕上がり・それぞれの取消の窓口（POST）を呼ぶ。body が undefined なら本文なしで送る。
 * 送信が途中で切れたかもしれない時は、画面が同じ重複防止キーで送り直せるように unknown を返す
 * （clientFetch は書き込みを自動で送り直さない）。
 */
export async function callFulfillmentApi<T>(
  url: string,
  body: unknown,
  fallbackMessage: string,
): Promise<FulfillmentCallResult<T>> {
  let response: Response;
  try {
    response = await clientFetch(url, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return { kind: 'unknown' };
  }

  if (response.status >= 500) return { kind: 'unknown' };
  if (response.ok) {
    try {
      return { kind: 'ok', body: (await response.json()) as T };
    } catch {
      return { kind: 'unknown' };
    }
  }

  const errorBody: unknown = await response.json().catch(() => null);
  return { kind: 'refused', message: refusalMessage(response.status, errorBody, fallbackMessage) };
}

/** 発送の画面と仕上がりの画面が、開いた時と仕上がりの記録の後に読む「発送の材料」 */
export async function fetchFulfillmentMaterials(orderId: string): Promise<FulfillmentMaterialsResult> {
  try {
    const response = await clientFetch(`/api/admin/orders/${orderId}/fulfillments`, { cache: 'no-store' });
    if (response.status >= 500) return { ok: false, message: FULFILLMENT_FAILURE_MESSAGES.materials };
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      return { ok: false, message: refusalMessage(response.status, body, FULFILLMENT_FAILURE_MESSAGES.materials) };
    }
    return { ok: true, materials: (await response.json()) as FulfillmentMaterials };
  } catch {
    return { ok: false, message: FULFILLMENT_FAILURE_MESSAGES.materials };
  }
}

/** 商品の見出し。「シルクブラウス（白 / M）」。色もサイズも無ければ名前だけ */
export function lineLabel(line: Pick<FulfillmentMaterialLine, 'name' | 'color' | 'size'>): string {
  const variant = [line.color, line.size].filter((part): part is string => Boolean(part)).join(' / ');
  return variant ? `${line.name}（${variant}）` : line.name;
}

/** 数の入力。整数にし、0 から上限までに収める（空・文字・負の数は 0） */
export function clampQuantity(raw: string, max: number): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.min(value, Math.max(0, max));
}
```

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts --runInBand`
Expected: PASS（27件）

- [ ] **Step 3: `Dialog` の試験を足す**

`tests/unit/components/Dialog.test.tsx` の先頭の import を直し、ファイルの終わりに `describe` を足す。見た目は CSS の責務なので、付ける属性の契約と、CSS が 768px 未満の幅だけに効くことを確かめる（390px での実際の見え方は Task 10 の E2E が確かめる）。

`tests/unit/components/Dialog.test.tsx`（今の 1 行目から）:

置き換える前:

```tsx
import { useState } from 'react';
```

置き換えた後:

```tsx
import fs from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
```

ファイルの終わりに足す:

```tsx
// 小さい画面で画面いっぱいに開く指定（発送の画面・仕上がりの画面）。見た目は CSS の責務なので、
// ここでは属性の契約と、CSS が 768px 未満だけに効くことを確かめる。実際の見え方は E2E（390px）が確かめる
describe('Dialog の fullScreenOnMobile', () => {
  const dialogOf = (container: HTMLElement) => container.querySelector('[data-ui-dialog]');

  it('付けた時だけ data-ui-dialog-fullscreen="mobile" が付く', () => {
    const { container, rerender } = render(<Dialog open onClose={() => {}} title="T" />);
    expect(dialogOf(container)).not.toHaveAttribute('data-ui-dialog-fullscreen');

    rerender(<Dialog open onClose={() => {}} title="T" fullScreenOnMobile />);
    expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('画面いっぱいの CSS は 768px 未満の幅だけに効き、パネルの最大幅・余白・角を外す', () => {
    // .dialog-panel は @layer の外にある CSS なので、className の Tailwind では上書きできない。Dialog.css が持つ
    const css = fs.readFileSync(path.join(process.cwd(), 'src/components/ui/Dialog/Dialog.css'), 'utf8').replace(/\r\n/g, '\n');
    const rule = css.match(
      /@media \(max-width: 767\.98px\) \{\n\s*\[data-ui-dialog\]\[data-ui-dialog-fullscreen="mobile"\] \.dialog-panel \{([^}]*)\}/,
    );

    expect(rule).not.toBeNull();
    const declarations = rule?.[1] ?? '';
    expect(declarations).toContain('max-width: none;');
    expect(declarations).toContain('height: 100%;');
    expect(declarations).toContain('margin-inline: 0;');
    expect(declarations).toContain('border-radius: 0;');
  });
});
```

Run: `npx jest tests/unit/components/Dialog.test.tsx --runInBand`
Expected: FAIL（`fullScreenOnMobile` の2件。`data-ui-dialog-fullscreen` が付かない・CSS の規則が無い）

- [ ] **Step 4: `Dialog` に `fullScreenOnMobile` を足す**

`src/components/ui/Dialog/Dialog_types.ts`（今の 19 行目から）:

置き換える前:

```ts
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
}
```

置き換えた後:

```ts
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
  /** 幅が 768px 未満の画面では、画面いっぱいに開く（入力と一覧が長い画面向け） */
  fullScreenOnMobile?: boolean;
}
```

`src/components/ui/Dialog/Dialog.tsx`（今の 39 行目から）:

置き換える前:

```tsx
  shape = "square",
  size = "md",
}: DialogProps) {
```

置き換えた後:

```tsx
  shape = "square",
  size = "md",
  fullScreenOnMobile = false,
}: DialogProps) {
```

`src/components/ui/Dialog/Dialog.tsx`（今の 122 行目から）:

置き換える前:

```tsx
    "data-ui-size": size,
  } as const;
```

置き換えた後:

```tsx
    "data-ui-size": size,
    "data-ui-dialog-fullscreen": fullScreenOnMobile ? "mobile" : undefined,
  } as const;
```

`src/components/ui/Dialog/Dialog.css`（今の 83 行目から）:

置き換える前:

```css
/* --- 背景スクリム（対比：背後を暗転させ panel を前面に浮かせる）--- */
```

置き換えた後:

```css
/* --- 小さい画面（768px 未満）で画面いっぱいに開く（fullScreenOnMobile）---
   .dialog-panel は @layer の外にあるので、className の Tailwind では上書きできない。ここで持つ */
@media (max-width: 767.98px) {
  [data-ui-dialog][data-ui-dialog-fullscreen="mobile"] .dialog-panel {
    max-width: none;
    height: 100%;
    margin-inline: 0;
    border-radius: 0;
    box-shadow: none;
    overflow-y: auto;
  }
}

/* --- 背景スクリム（対比：背後を暗転させ panel を前面に浮かせる）--- */
```

Run: `npx jest tests/unit/components/Dialog.test.tsx --runInBand`
Expected: PASS（31件）

- [ ] **Step 5: 発送の画面の試験を書き直す**

今の試験は、追跡番号だけを返す古い画面（`open`・`onSubmit`）のもの。新しい画面（`orderId`・`onShipped`）の試験に全部書き直す。窓口（`clientFetch`）は差し替え、次を確かめる。

- 材料: 開くと窓口を読み、商品ごとに印・発送準備中の数・今回送る数を出す。最初の数は発送準備中の全部（受注生産中の品は入らない）。在庫の品だけの注文・仕上がり済みの受注生産の品・一部を送った品の最初の数。もう全部送った商品は並べない
- 入力: 今回送る数は発送準備中の数までに収まる。合計が変わる。開き直すと既定（ヤマト・空・送る）に戻る。スマホの幅で画面いっぱいに開く指定が付く
- 発送: 重複防止キー・配送業者・追跡番号・メール・送る商品（0の商品は含めない）を窓口へ送り、結果を親へ渡す。合計が0なら `送る数を入れてください。`。追跡番号の形の誤り。送っている間は押せず、二重に送らない
- 断り: 窓口の文を画面の中の `role="alert"` に出し、入力は残し、次の送信は新しい重複防止キー（Review Focus 1）
- 答えが分からない時（通信が切れた・500）: 入力を止め、`もう一度確かめる` と `閉じる` だけを出し、同じ重複防止キー・同じ中身で送り直す。確かめ直しても分からない時はそのまま止まる（Review Focus 2）
- 発送できない理由（3つ）と、材料を読めなかった時: 理由を出し、発送を押せなくする
- 画面の中の仕上がりの記録: 記録 → 材料の読み直し → 記録した数が送る数に足される → そのまま発送。0 のまま押した時の誤り・Enter の扱い・断り・答えが分からない時

`tests/unit/components/OrderShipDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CreateFulfillmentResponse,
  FulfillmentMaterialLine,
  FulfillmentMaterials,
} from '@/lib/orders/fulfillment/fulfillment-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderShipDialog from '@/components/OrderShipDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENTS_URL = `/api/admin/orders/${ORDER_ID}/fulfillments`;
const COMPLETIONS_URL = `/api/admin/orders/${ORDER_ID}/completions`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 在庫の品。2つとも発送準備中 */
const STOCK_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
};

/** 受注生産の品。1つとも受注生産中（まだ仕上がっていない） */
const BACKORDER_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-backorder', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

/** 仕上がりを記録した後の受注生産の品 */
const BACKORDER_READY_LINE: FulfillmentMaterialLine = { ...BACKORDER_LINE, inProduction: 0, readyUnshipped: 1 };

function materials(overrides: Partial<FulfillmentMaterials> = {}): FulfillmentMaterials {
  return {
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [STOCK_LINE, BACKORDER_LINE],
    fulfillments: [],
    ...overrides,
  };
}

function shipped(overrides: Partial<CreateFulfillmentResponse> = {}): CreateFulfillmentResponse {
  return { fulfillmentId: 'fulfillment-1', number: 1, completesOrder: false, orderStatus: 'paid', replayed: false, ...overrides };
}

/** 画面を開き、発送の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: FulfillmentMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const onClose = jest.fn();
  const onShipped = jest.fn();
  const utils = render(<OrderShipDialog orderId={ORDER_ID} onClose={onClose} onShipped={onShipped} />);
  const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, dialog, onClose, onShipped };
}

/** n 番目（0 始まり）の呼び出しが窓口へ送った本文 */
function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function typeTracking(dialog: HTMLElement, value = '1234-5678') {
  fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value } });
}

/** 商品の行の「今回送る数」の入力。行ごとに同じ名前の入力があるので、行の中で探す（既定は在庫のブラウス） */
function shipQuantityInput(dialog: HTMLElement, groupName = 'シルクブラウス（白 / M）') {
  return within(within(dialog).getByRole('group', { name: groupName })).getByLabelText('今回送る数');
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderShipDialog の材料と最初の数', () => {
  it('開くと発送の材料を読み、商品ごとに印・発送準備中の数・今回送る数を出す（受注生産中の品は送る数に入らない）', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(FULFILLMENTS_URL, { cache: 'no-store' });
    const stock = within(dialog).getByRole('group', { name: 'シルクブラウス（白 / M）' });
    expect(within(stock).getByText('在庫')).toBeInTheDocument();
    expect(within(stock).getByText('発送準備中')).toBeInTheDocument();
    expect(within(stock).getByLabelText('今回送る数')).toHaveValue(2);
    expect(within(stock).queryByLabelText('仕上がった数')).not.toBeInTheDocument();

    const backorder = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(backorder).getByText('受注生産')).toBeInTheDocument();
    expect(within(backorder).getByText('受注生産中 1')).toBeInTheDocument();
    expect(within(backorder).getByLabelText('今回送る数')).toHaveValue(0);
    expect(within(backorder).getByLabelText('今回送る数')).toBeDisabled();
    expect(within(backorder).getByLabelText('仕上がった数')).toHaveValue(0);
    expect(within(dialog).getByText('今回送る数の合計: 2点')).toBeInTheDocument();
  });

  it('在庫の品だけの注文は、発送準備中の全部が最初から入り、合計に足される', async () => {
    const pants: FulfillmentMaterialLine = {
      ...STOCK_LINE, orderItemId: 'item-pants', name: 'ウールパンツ', color: null, size: '2', quantity: 3, readyUnshipped: 3, unshipped: 3,
    };
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, pants] }));

    expect(shipQuantityInput(dialog)).toHaveValue(2);
    expect(shipQuantityInput(dialog, 'ウールパンツ（2）')).toHaveValue(3);
    expect(within(dialog).getByText('今回送る数の合計: 5点')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^受注生産中/)).not.toBeInTheDocument();
  });

  it('仕上がりを記録済みの受注生産の品と、一部を送った品は、発送準備中の数が最初から入る', async () => {
    const partlyShipped: FulfillmentMaterialLine = {
      ...BACKORDER_LINE, quantity: 3, shipped: 1, inProduction: 0, readyUnshipped: 2, unshipped: 2,
    };
    const { dialog } = await openDialog(materials({ lines: [partlyShipped] }));

    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(row).getByLabelText('今回送る数')).toHaveValue(2);
    expect(within(row).getByLabelText('今回送る数')).toBeEnabled();
    expect(within(row).queryByLabelText('仕上がった数')).not.toBeInTheDocument();
  });

  it('もう全部送った商品は並べない', async () => {
    const done: FulfillmentMaterialLine = { ...STOCK_LINE, orderItemId: 'item-done', name: '送り済みのシャツ', shipped: 2, readyUnshipped: 0, unshipped: 0 };
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, done] }));

    expect(within(dialog).queryByRole('group', { name: /送り済みのシャツ/ })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('group')).toHaveLength(1);
  });

  it('今回送る数を変えると合計が変わり、発送準備中の数を超える数と負の数は収める', async () => {
    const { dialog } = await openDialog();
    const input = shipQuantityInput(dialog);

    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
    expect(within(dialog).getByText('今回送る数の合計: 1点')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);

    fireEvent.change(input, { target: { value: '-4' } });
    expect(input).toHaveValue(0);
    expect(within(dialog).getByText('今回送る数の合計: 0点')).toBeInTheDocument();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('閉じて開き直すと、材料を読み直し、配送業者・追跡番号・メールの入力は既定（ヤマト・空・送る）へ戻り、誤りの文も消える', async () => {
    const { rerender, dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('配送業者'), { target: { value: 'japanpost' } });
    typeTracking(dialog, '12 34');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();

    rerender(<OrderShipDialog orderId={null} onClose={jest.fn()} onShipped={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json(materials()));
    rerender(<OrderShipDialog orderId={ORDER_ID} onClose={jest.fn()} onShipped={jest.fn()} />);
    const reopened = await screen.findByRole('dialog', { name: '発送済みにする' });
    await waitFor(() => expect(within(reopened).queryByText('読み込み中です...')).not.toBeInTheDocument());

    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(within(reopened).getByLabelText('配送業者')).toHaveValue('yamato');
    expect(within(reopened).getByLabelText('追跡番号')).toHaveValue('');
    expect(within(reopened).getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('OrderShipDialog の発送', () => {
  it('発送すると、重複防止キー・配送業者・追跡番号・メール・送る商品を窓口へ送り、結果を親へ渡す', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    fireEvent.change(within(dialog).getByLabelText('配送業者'), { target: { value: 'sagawa' } });
    typeTracking(dialog, ' 1234-5678 ');
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledWith(shipped()));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, FULFILLMENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    // 送る数が 0 の受注生産の品は含めない
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      carrier: 'sagawa',
      trackingNumber: '1234-5678',
      notifyCustomer: true,
      lines: [{ orderItemId: 'item-stock', quantity: 2 }],
    });
  });

  it('「お客様に発送のメールを送る」は最初から入っていて、外すと「送らない」で発送する', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    const checkbox = within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ carrier: 'yamato', notifyCustomer: false });
  });

  it('一部だけ送る時は、入れた数の商品だけを送る', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '1' } });
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([{ orderItemId: 'item-stock', quantity: 1 }]);
  });

  it('今回送る数の合計が 0 なら、理由を画面の中に出して送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '0' } });
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('送る数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('追跡番号の形が違えば、画面の中で知らせて送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    typeTracking(dialog, '12 34');
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('追跡番号の欄は数字キーパッドに限らない（英字も打てる）', async () => {
    const { dialog } = await openDialog();

    expect(within(dialog).getByLabelText('追跡番号')).not.toHaveAttribute('inputmode');
  });

  it('「キャンセル」では送らずに閉じる', async () => {
    const { dialog, onClose, onShipped } = await openDialog();
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('送っている間は発送のボタンを押せず、二重に送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json(shipped()));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
  });
});

describe('OrderShipDialog の窓口の断り', () => {
  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい重複防止キーにする', async () => {
    const { dialog, onShipped } = await openDialog();
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_ready' }, 409))
      .mockResolvedValueOnce(json(shipped()));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onShipped).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('追跡番号')).toHaveValue('1234-5678');
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('権限が無い・認証が切れた時は固定の文、回数の制限（英語の短い文）は代わりの文を出す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));
    typeTracking(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(await within(dialog).findByText('この操作の権限がありません。')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(await within(dialog).findByText('発送の記録に失敗しました。')).toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });
});

describe('OrderShipDialog の答えが分からない時', () => {
  it.each([
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '発送の記録に失敗しました。', code: 'failed' }, 500))],
  ])('%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ重複防止キーで確かめ直す', async (_label, firstAnswer) => {
    const { dialog, onShipped, onClose } = await openDialog();
    mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json(shipped({ replayed: true })));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    // 入力は変えられない
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    expect(within(dialog).getByLabelText('配送業者')).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeDisabled();
    expect(shipQuantityInput(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '仕上がりを記録' })).toBeDisabled();
    // 操作は「もう一度確かめる」と「閉じる」だけ
    expect(within(dialog).queryByRole('button', { name: '発送する' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledWith(shipped({ replayed: true })));
    // 同じ重複防止キー・同じ中身で送り直す（サーバーが記録していても、二重にならない）
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる', async () => {
    const { dialog, onShipped, onClose } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onShipped).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('確かめ直した答えが窓口の断りなら、その文を出して入力を戻し、新しい重複防止キーで送れる', async () => {
    const { dialog, onShipped } = await openDialog();
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_ready' }, 409))
      .mockResolvedValueOnce(json(shipped()));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('追跡番号')).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(3).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });
});

describe('OrderShipDialog の発送できない注文と読み込み', () => {
  it.each([
    ['not_shippable', '発送できる状態ではありません。一覧を更新してください。'],
    ['address_incomplete', '配送先の必須項目が足りないため発送できません。'],
    ['payment_review_required', '支払額の確認（要対応）が済むまで発送できません。'],
  ] as const)('発送できない理由 %s は画面の中に出し、発送を押せなくする', async (blockedReason, message) => {
    const { dialog } = await openDialog(materials({ blockedReason }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由を出し、発送を押せなくする', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    render(<OrderShipDialog orderId={ORDER_ID} onClose={jest.fn()} onShipped={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
  });
});

describe('OrderShipDialog の画面の中での仕上がりの記録', () => {
  it('受注生産中の品は、画面の中で仕上がりを記録でき、記録した数は発送準備中に移って、そのまま送れる', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })))
      .mockResolvedValueOnce(json(shipped({ completesOrder: true, orderStatus: 'shipped' })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-backorder', quantity: 1 }],
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, FULFILLMENTS_URL, { cache: 'no-store' });

    // 記録した品は発送準備中に移り、送る数にも足される。受注生産中の表示と仕上がりの入力は消える
    const reloaded = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(reloaded).getByLabelText('今回送る数')).toBeEnabled();
    expect(within(reloaded).getByLabelText('今回送る数')).toHaveValue(1);
    expect(within(reloaded).queryByLabelText('仕上がった数')).not.toBeInTheDocument();
    expect(within(dialog).getByText('今回送る数の合計: 3点')).toBeInTheDocument();

    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(3).lines).toEqual([
      { orderItemId: 'item-stock', quantity: 2 },
      { orderItemId: 'item-backorder', quantity: 1 },
    ]);
  });

  it('入れ直した送る数は、仕上がりを記録しても変わらない', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '1' } });
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('仕上がりを記録しました。');

    expect(shipQuantityInput(dialog)).toHaveValue(1);
    expect(within(dialog).getByText('今回送る数の合計: 2点')).toBeInTheDocument();
  });

  it('仕上がった数が 0 のまま押したら、理由を出して送らない。この欄の Enter は発送ではなく仕上がりの記録になる', async () => {
    const { dialog } = await openDialog();
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('仕上がった数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);

    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const input = within(row).getByLabelText('仕上がった数');
    fireEvent.change(input, { target: { value: '1' } });
    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

    await within(dialog).findByText('仕上がりを記録しました。');
    expect(mockClientFetch.mock.calls[1][0]).toBe(COMPLETIONS_URL);
    expect((mockClientFetch.mock.calls[1][1] as RequestInit).method).toBe('POST');
    // 発送の窓口へは何も送っていない
    expect(
      mockClientFetch.mock.calls.filter(([url, init]) => url === FULFILLMENTS_URL && (init as RequestInit).method === 'POST'),
    ).toHaveLength(0);
  });

  it('仕上がりの記録を窓口が断ったら、その文を出し、次の記録は新しい重複防止キーにする', async () => {
    const { dialog } = await openDialog();
    const message = '仕上がった数が受注生産中の数を超えています。一覧を更新してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_in_production' }, 409))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('仕上がりを記録しました。');
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('仕上がりの記録で答えが分からない時も、同じ重複防止キーで確かめ直せる', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: true }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(within(dialog).queryByRole('button', { name: '発送する' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    expect(await within(dialog).findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeEnabled();
  });
});
```

Run: `npx jest tests/unit/components/OrderShipDialog.test.tsx --runInBand`
Expected: FAIL（古い画面は `orderId` を受け取らず開かない。32件が `Unable to find role="dialog"` で落ちる）

- [ ] **Step 6: 発送の画面を作り直す**

`src/components/OrderShipDialog.tsx` の中身を、次に全部置き換える。`OrderShipValues` の型は無くなる（使っているのは `src/app/admin/page.tsx` だけで、Task 7 が直す）。

`src/components/OrderShipDialog.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import {
  COMPLETION_RECORDED_MESSAGE,
  NO_COMPLETION_QUANTITY_MESSAGE,
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';
import {
  FULFILLMENT_ERROR_MESSAGES,
  FULFILLMENT_FAILURE_MESSAGES,
  UNKNOWN_OUTCOME_MESSAGE,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  initialShipQuantities,
  totalQuantity,
  type CreateFulfillmentRequest,
  type CreateFulfillmentResponse,
  type FulfillmentLineQuantity,
  type FulfillmentMaterialLine,
  type FulfillmentMaterials,
  type RecordCompletionRequest,
  type RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
  type ShippingCarrierId,
} from '@/lib/orders/shipping-carriers';
import { cn } from '@/lib/utils';

type OrderShipDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 発送を記録できた（同じ重複防止キーの送り直しで前の結果が返った時も）。親が一覧を読み直す */
  onShipped: (result: CreateFulfillmentResponse) => void;
};

type OrderShipDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onShipped: (result: CreateFulfillmentResponse) => void;
};

/** 答えが分からない操作。「もう一度確かめる」は、保存してある同じ中身（同じ重複防止キー）で送り直す */
type UnknownOutcome =
  | { kind: 'ship'; request: CreateFulfillmentRequest }
  | { kind: 'completion'; request: RecordCompletionRequest };

const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const NO_QUANTITY_MESSAGE = '送る数を入れてください。';

/**
 * 仕上がりを画面の中で記録した後の送る数。記録した数を、その商品の送る数に足す（発送準備中の数までに収める）。
 * 仕上がった品もそのまま送る流れが自然で、入れ直したければ直せる。
 */
function quantitiesAfterCompletion(
  previous: Record<string, number>,
  recorded: readonly FulfillmentLineQuantity[],
  lines: readonly FulfillmentMaterialLine[],
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const line of lines) {
    if (line.unshipped < 1) continue;
    const added = recorded.find((entry) => entry.orderItemId === line.orderItemId)?.quantity ?? 0;
    next[line.orderItemId] = Math.min(line.readyUnshipped, (previous[line.orderItemId] ?? 0) + added);
  }
  return next;
}

/**
 * 発送の画面（グループ E-1 設計書 6-1。Shopify の「発送済みにする」に合わせる）。
 * 開く時に発送の材料を読み、商品ごとに今回送る数を入れて発送する。受注生産中の品は、ここで仕上がりも記録できる。
 * 開くたびに中身を作り直す（key に注文を使う）ので、重複防止キーも入力も開くたびに新しくなる。
 */
export default function OrderShipDialog({ orderId, onClose, onShipped }: OrderShipDialogProps) {
  return orderId ? <OrderShipDialogBody key={orderId} orderId={orderId} onClose={onClose} onShipped={onShipped} /> : null;
}

function OrderShipDialogBody({ orderId, onClose, onShipped }: OrderShipDialogBodyProps) {
  const [materials, setMaterials] = useState<FulfillmentMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [completionInputs, setCompletionInputs] = useState<Record<string, number>>({});
  const [carrier, setCarrier] = useState<ShippingCarrierId>('yamato');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<UnknownOutcome | null>(null);
  // 重複防止キー。画面を開いた時に作り、窓口が断った時だけ作り直す（答えが分からない時は同じキーで確かめ直す）
  const keys = useRef({ ship: '', completion: '' });

  useEffect(() => {
    keys.current = { ship: crypto.randomUUID(), completion: crypto.randomUUID() };
    let active = true;
    void fetchFulfillmentMaterials(orderId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.materials);
      setQuantities(initialShipQuantities(result.materials.lines));
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  const blockedReason = materials?.blockedReason ?? null;
  const blockedMessage = blockedReason ? FULFILLMENT_ERROR_MESSAGES[blockedReason].message : null;
  // 送っている間・答えが分からない間・発送できない注文は、入力も操作も止める
  const locked = busy || unknown !== null || blockedMessage !== null;
  const alertText = unknown ? UNKNOWN_OUTCOME_MESSAGE : (error ?? blockedMessage ?? loadError);
  const rows = materials?.lines.filter((line) => line.unshipped >= 1) ?? [];
  const total = totalQuantity(quantities);

  const postShip = async (request: CreateFulfillmentRequest) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await callFulfillmentApi<CreateFulfillmentResponse>(
      `/api/admin/orders/${orderId}/fulfillments`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.create,
    );
    setBusy(false);
    if (result.kind === 'ok') {
      setUnknown(null);
      onShipped(result.body);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい重複防止キーにする
      keys.current.ship = crypto.randomUUID();
      setUnknown(null);
      setError(result.message);
      return;
    }
    setUnknown({ kind: 'ship', request });
  };

  const postCompletion = async (request: RecordCompletionRequest) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await callFulfillmentApi<RecordCompletionResponse>(
      `/api/admin/orders/${orderId}/completions`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.completion,
    );
    if (result.kind === 'unknown') {
      setBusy(false);
      setUnknown({ kind: 'completion', request });
      return;
    }
    keys.current.completion = crypto.randomUUID();
    setUnknown(null);
    if (result.kind === 'refused') {
      setBusy(false);
      setError(result.message);
      return;
    }
    // 記録できた。材料を読み直し、仕上がった品を発送準備中として出す
    const reloaded = await fetchFulfillmentMaterials(orderId);
    setBusy(false);
    if (!reloaded.ok) {
      setError(reloaded.message);
      return;
    }
    setMaterials(reloaded.materials);
    setQuantities((previous) => quantitiesAfterCompletion(previous, request.lines, reloaded.materials.lines));
    setCompletionInputs({});
    setNotice(COMPLETION_RECORDED_MESSAGE);
  };

  const retry = () => {
    if (!unknown || busy) return;
    void (unknown.kind === 'ship' ? postShip(unknown.request) : postCompletion(unknown.request));
  };

  const recordCompletion = (line: FulfillmentMaterialLine) => {
    if (locked) return;
    const quantity = completionInputs[line.orderItemId] ?? 0;
    if (quantity < 1) {
      setNotice(null);
      setError(NO_COMPLETION_QUANTITY_MESSAGE);
      return;
    }
    void postCompletion({ requestKey: keys.current.completion, lines: [{ orderItemId: line.orderItemId, quantity }] });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!materials || locked) return;
    const lines = rows
      .filter((line) => (quantities[line.orderItemId] ?? 0) > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: quantities[line.orderItemId] }));
    if (lines.length === 0) {
      setNotice(null);
      setError(NO_QUANTITY_MESSAGE);
      return;
    }
    const value = trackingNumber.trim();
    if (!TRACKING_NUMBER_PATTERN.test(value)) {
      setNotice(null);
      setError('追跡番号は英数字とハイフンで入力してください。');
      return;
    }
    void postShip({ requestKey: keys.current.ship, carrier, trackingNumber: value, notifyCustomer, lines });
  };

  return (
    <Dialog open onClose={onClose} title="発送済みにする" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit}>
        {!materials && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}

        {materials ? (
          <>
            <ul className="max-h-[50vh] space-y-3 overflow-y-auto" aria-label="発送する商品">
              {rows.map((line) => {
                const label = lineLabel(line);
                const quantityId = `ship-quantity-${line.orderItemId}`;
                const completionId = `ship-completion-${line.orderItemId}`;
                return (
                  <li key={line.orderItemId}>
                    <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-acumin lk-text-sm text-black">{label}</span>
                        <TagLabel variant="outline" size="2xs">
                          {line.fulfillmentType === 'stock' ? '在庫' : '受注生産'}
                        </TagLabel>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="font-acumin lk-text-3xs text-[#474747]">発送準備中</p>
                          <p className="font-acumin lk-text-sm text-black">{line.readyUnshipped}</p>
                        </div>
                        <div>
                          <label htmlFor={quantityId} className="block font-acumin lk-text-3xs text-[#474747]">
                            今回送る数
                          </label>
                          <input
                            id={quantityId}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={line.readyUnshipped}
                            step={1}
                            value={quantities[line.orderItemId] ?? 0}
                            disabled={locked || line.readyUnshipped < 1}
                            onChange={(event) => {
                              const next = clampQuantity(event.target.value, line.readyUnshipped);
                              setQuantities((previous) => ({ ...previous, [line.orderItemId]: next }));
                            }}
                            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                          />
                        </div>
                      </div>
                      {line.inProduction > 0 ? (
                        <div className="space-y-1 border-t border-[#d4d4d4] pt-2">
                          <p className="font-acumin lk-text-3xs text-[#474747]">{`受注生産中 ${line.inProduction}`}</p>
                          <div className="flex items-end gap-2">
                            <div className="flex-1">
                              <label htmlFor={completionId} className="block font-acumin lk-text-3xs text-[#474747]">
                                仕上がった数
                              </label>
                              <input
                                id={completionId}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={line.inProduction}
                                step={1}
                                value={completionInputs[line.orderItemId] ?? 0}
                                disabled={locked}
                                onChange={(event) => {
                                  const next = clampQuantity(event.target.value, line.inProduction);
                                  setCompletionInputs((previous) => ({ ...previous, [line.orderItemId]: next }));
                                }}
                                // Enter で発送の送信になってしまわないよう、この欄の Enter は仕上がりの記録にする
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter') return;
                                  event.preventDefault();
                                  recordCompletion(line);
                                }}
                                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                              />
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="font-acumin"
                              disabled={locked}
                              onClick={() => recordCompletion(line)}
                            >
                              仕上がりを記録
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="font-acumin lk-text-sm text-black">{`今回送る数の合計: ${total}点`}</p>
            <div>
              <label htmlFor="ship-carrier" className="block font-acumin lk-text-3xs text-[#474747]">
                配送業者
              </label>
              <select
                id="ship-carrier"
                value={carrier}
                disabled={locked}
                onChange={(event) => {
                  if (isShippingCarrierId(event.target.value)) setCarrier(event.target.value);
                }}
                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
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
                maxLength={64}
                value={trackingNumber}
                disabled={locked}
                onChange={(event) => setTrackingNumber(event.target.value)}
                placeholder="1234-5678-9012"
                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
              />
            </div>
            <Checkbox
              label="お客様に発送のメールを送る"
              checked={notifyCustomer}
              disabled={locked}
              onChange={(event) => setNotifyCustomer(event.target.checked)}
            />
            {/* 仕上がりの記録の結果。後から差し込むと読み上げられない環境が多いので、入れ物は最初から置く（空の間は場所を取らない） */}
            <p role="status" aria-live="polite" className={cn('font-acumin lk-text-3xs text-[#474747]', !notice && 'sr-only')}>
              {notice}
            </p>
          </>
        ) : null}

        {alertText ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {alertText}
          </p>
        ) : null}

        {unknown ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              閉じる
            </Button>
            <Button variant="primary" size="sm" className="w-full font-acumin" disabled={busy} onClick={retry}>
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!materials || locked}>
              発送する
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
```

Run: `npx jest tests/unit/components/OrderShipDialog.test.tsx --runInBand`
Expected: PASS（32件）

- [ ] **Step 7: 仕上がりの画面の試験を書く**

`tests/unit/components/OrderCompletionDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderCompletionDialog from '@/components/OrderCompletionDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENTS_URL = `/api/admin/orders/${ORDER_ID}/fulfillments`;
const COMPLETIONS_URL = `/api/admin/orders/${ORDER_ID}/completions`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const STOCK_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
};

/** 受注生産の品。3つのうち 2つが受注生産中、1つは仕上がって発送準備中 */
const COAT_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 3, shipped: 0, inProduction: 2, readyUnshipped: 1, unshipped: 3,
};

const SKIRT_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-skirt', name: 'プリーツスカート', color: null, size: 'S', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

function materials(overrides: Partial<FulfillmentMaterials> = {}): FulfillmentMaterials {
  return {
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [STOCK_LINE, COAT_LINE, SKIRT_LINE],
    fulfillments: [],
    ...overrides,
  };
}

/** 画面を開き、発送の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: FulfillmentMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const onClose = jest.fn();
  const onRecorded = jest.fn();
  const utils = render(<OrderCompletionDialog orderId={ORDER_ID} onClose={onClose} onRecorded={onRecorded} />);
  const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, dialog, onClose, onRecorded };
}

function quantityInput(dialog: HTMLElement, groupName: string) {
  return within(within(dialog).getByRole('group', { name: groupName })).getByLabelText('仕上がった数');
}

function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderCompletionDialog の一覧', () => {
  it('受注生産中の数がある商品だけを並べ、仕上がった数は 0 から始まる', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(FULFILLMENTS_URL, { cache: 'no-store' });
    expect(within(dialog).getAllByRole('group')).toHaveLength(2);
    expect(within(dialog).queryByRole('group', { name: /シルクブラウス/ })).not.toBeInTheDocument();
    const coat = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(coat).getByText('受注生産中 2')).toBeInTheDocument();
    expect(within(coat).getByLabelText('仕上がった数')).toHaveValue(0);
    const skirt = within(dialog).getByRole('group', { name: 'プリーツスカート（S）' });
    expect(within(skirt).getByText('受注生産中 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeEnabled();
  });

  it('入れた数は 0 から受注生産中の数までに収める', async () => {
    const { dialog } = await openDialog();
    const input = quantityInput(dialog, 'ウールコート（黒 / L）');

    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);
    fireEvent.change(input, { target: { value: '-1' } });
    expect(input).toHaveValue(0);
    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('受注生産中の商品が無い時は、その旨を出して記録できなくする', async () => {
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, { ...COAT_LINE, inProduction: 0, readyUnshipped: 3 }] }));

    expect(within(dialog).getByText('受注生産中の商品はありません。')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
  });

  it('決済完了でない注文は、記録できない旨を出して記録できなくする。配送先や支払額の確認は記録を止めない', async () => {
    const blocked = await openDialog(materials({ blockedReason: 'not_shippable' }));
    expect(blocked.dialog).toHaveTextContent('仕上がりを記録できる状態ではありません。一覧を更新してください。');
    expect(within(blocked.dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    expect(quantityInput(blocked.dialog, 'ウールコート（黒 / L）')).toBeDisabled();
    blocked.unmount();

    const addressMissing = await openDialog(materials({ blockedReason: 'address_incomplete' }));
    expect(within(addressMissing.dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(addressMissing.dialog).getByRole('button', { name: '記録する' })).toBeEnabled();
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由を出し、記録できなくする', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    render(<OrderCompletionDialog orderId={ORDER_ID} onClose={jest.fn()} onRecorded={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
  });
});

describe('OrderCompletionDialog の記録', () => {
  it('記録すると、重複防止キーと、数を入れた商品だけを窓口へ送り、親へ知らせる', async () => {
    const { dialog, onRecorded } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-coat', quantity: 2 }],
    });
  });

  it('複数の商品を一度に記録できる', async () => {
    const { dialog, onRecorded } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ completionIds: ['completion-1', 'completion-2'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.change(quantityInput(dialog, 'プリーツスカート（S）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([
      { orderItemId: 'item-coat', quantity: 1 },
      { orderItemId: 'item-skirt', quantity: 1 },
    ]);
  });

  it('仕上がった数の合計が 0 なら、理由を画面の中に出して送らない', async () => {
    const { dialog, onRecorded } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('仕上がった数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('「キャンセル」では送らずに閉じる', async () => {
    const { dialog, onClose, onRecorded } = await openDialog();
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('送っている間は記録のボタンを押せず、二重に送らない', async () => {
    const { dialog, onRecorded } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json({ completionIds: ['completion-1'], replayed: false }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい重複防止キーにする', async () => {
    const { dialog, onRecorded } = await openDialog();
    const message = '仕上がった数が受注生産中の数を超えています。一覧を更新してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_in_production' }, 409))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(quantityInput(dialog, 'ウールコート（黒 / L）')).toHaveValue(2);

    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '仕上がりの記録に失敗しました。', code: 'failed' }, 500))],
  ])('%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ重複防止キーで確かめ直す', async (_label, firstAnswer) => {
    const { dialog, onRecorded, onClose } = await openDialog();
    mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: true }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(quantityInput(dialog, 'ウールコート（黒 / L）')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '記録する' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    // 同じ重複防止キー・同じ中身で送り直す
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「閉じる」で閉じる（答えが分からないまま）', async () => {
    const { dialog, onClose, onRecorded } = await openDialog();
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('閉じて開き直すと、材料を読み直し、入力は 0 に戻り、誤りの文も消える', async () => {
    const { rerender, dialog } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(
      json({ error: '仕上がりを記録できる状態ではありません。一覧を更新してください。', code: 'not_in_production' }, 409),
    );
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    await within(dialog).findByRole('alert');

    rerender(<OrderCompletionDialog orderId={null} onClose={jest.fn()} onRecorded={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json(materials()));
    rerender(<OrderCompletionDialog orderId={ORDER_ID} onClose={jest.fn()} onRecorded={jest.fn()} />);
    const reopened = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    await waitFor(() => expect(within(reopened).queryByText('読み込み中です...')).not.toBeInTheDocument());

    expect(quantityInput(reopened, 'ウールコート（黒 / L）')).toHaveValue(0);
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });
});
```

Run: `npx jest tests/unit/components/OrderCompletionDialog.test.tsx --runInBand`
Expected: FAIL（`Cannot find module '@/components/OrderCompletionDialog'`）

- [ ] **Step 8: 仕上がりの画面を書く**

`src/components/OrderCompletionDialog.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import {
  NO_COMPLETION_QUANTITY_MESSAGE,
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';
import {
  FULFILLMENT_ERROR_MESSAGES,
  FULFILLMENT_FAILURE_MESSAGES,
  UNKNOWN_OUTCOME_MESSAGE,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import type {
  FulfillmentMaterials,
  RecordCompletionRequest,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';

type OrderCompletionDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 仕上がりを記録できた（同じ重複防止キーの送り直しで前の結果が返った時も）。親が一覧を読み直す */
  onRecorded: () => void;
};

type OrderCompletionDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onRecorded: () => void;
};

const NO_IN_PRODUCTION_MESSAGE = '受注生産中の商品はありません。';

/**
 * 仕上がりの画面（グループ E-1 設計書 5-1）。受注生産中の商品ごとに、仕上がった数を入れて記録する。
 * お客様にメールは送らない。開くたびに中身を作り直す（key に注文を使う）ので、重複防止キーも入力も開くたびに新しくなる。
 */
export default function OrderCompletionDialog({ orderId, onClose, onRecorded }: OrderCompletionDialogProps) {
  return orderId ? (
    <OrderCompletionDialogBody key={orderId} orderId={orderId} onClose={onClose} onRecorded={onRecorded} />
  ) : null;
}

function OrderCompletionDialogBody({ orderId, onClose, onRecorded }: OrderCompletionDialogBodyProps) {
  const [materials, setMaterials] = useState<FulfillmentMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 答えが分からない記録。「もう一度確かめる」は、この同じ中身（同じ重複防止キー）で送り直す
  const [unknown, setUnknown] = useState<RecordCompletionRequest | null>(null);
  // 重複防止キー。画面を開いた時に作り、窓口が断った時だけ作り直す
  const requestKey = useRef('');

  useEffect(() => {
    requestKey.current = crypto.randomUUID();
    let active = true;
    void fetchFulfillmentMaterials(orderId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.materials);
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  const rows = materials?.lines.filter((line) => line.inProduction > 0) ?? [];
  // 決済完了でない注文は記録できない（配送先や支払額の確認は、記録には関係しない）
  const blockedMessage = materials?.blockedReason === 'not_shippable' ? FULFILLMENT_ERROR_MESSAGES.not_in_production.message : null;
  const emptyMessage = materials && !blockedMessage && rows.length === 0 ? NO_IN_PRODUCTION_MESSAGE : null;
  const locked = busy || unknown !== null || blockedMessage !== null || rows.length === 0;
  const alertText = unknown ? UNKNOWN_OUTCOME_MESSAGE : (error ?? blockedMessage ?? loadError);

  const post = async (request: RecordCompletionRequest) => {
    setBusy(true);
    setError(null);
    const result = await callFulfillmentApi<RecordCompletionResponse>(
      `/api/admin/orders/${orderId}/completions`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.completion,
    );
    setBusy(false);
    if (result.kind === 'ok') {
      setUnknown(null);
      onRecorded();
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい重複防止キーにする
      requestKey.current = crypto.randomUUID();
      setUnknown(null);
      setError(result.message);
      return;
    }
    setUnknown(request);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) return;
    const lines = rows
      .filter((line) => (quantities[line.orderItemId] ?? 0) > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: quantities[line.orderItemId] }));
    if (lines.length === 0) {
      setError(NO_COMPLETION_QUANTITY_MESSAGE);
      return;
    }
    void post({ requestKey: requestKey.current, lines });
  };

  return (
    <Dialog open onClose={onClose} title="仕上がりを記録する" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit}>
        {!materials && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
        {emptyMessage ? <p className="font-acumin lk-text-3xs text-[#474747]">{emptyMessage}</p> : null}

        {rows.length > 0 ? (
          <ul className="max-h-[50vh] space-y-3 overflow-y-auto" aria-label="仕上がりを記録する商品">
            {rows.map((line) => {
              const label = lineLabel(line);
              const inputId = `completion-quantity-${line.orderItemId}`;
              return (
                <li key={line.orderItemId}>
                  <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-acumin lk-text-sm text-black">{label}</span>
                      <TagLabel variant="outline" size="2xs">
                        受注生産
                      </TagLabel>
                    </div>
                    <p className="font-acumin lk-text-3xs text-[#474747]">{`受注生産中 ${line.inProduction}`}</p>
                    <div>
                      <label htmlFor={inputId} className="block font-acumin lk-text-3xs text-[#474747]">
                        仕上がった数
                      </label>
                      <input
                        id={inputId}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.inProduction}
                        step={1}
                        value={quantities[line.orderItemId] ?? 0}
                        disabled={locked}
                        onChange={(event) => {
                          const next = clampQuantity(event.target.value, line.inProduction);
                          setQuantities((previous) => ({ ...previous, [line.orderItemId]: next }));
                        }}
                        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {alertText ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {alertText}
          </p>
        ) : null}

        {unknown ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              閉じる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={busy}
              onClick={() => void post(unknown)}
            >
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!materials || locked}>
              記録する
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
```

Run: `npx jest tests/unit/components/OrderCompletionDialog.test.tsx --runInBand`
Expected: PASS（18件）

- [ ] **Step 9: 履歴の画面の試験を直し、足す**

履歴の行の型に、Task 5 が `fulfillmentId`・`fulfillmentNumber` を足し、今の見本の2か所（`history()` と `sentEmailEntry()`）にも `fulfillmentId: null, fulfillmentNumber: null` を足してある（Task 5 の Step 14）。ここでは、新しい行の型を import に足し、ファイルの終わりに発送と仕上がりの行・発送のメールの再送・発送の取消・仕上がりの取消の試験を足す。確かめることは、4つの行の言葉、取り消し済みの印と取消のボタンの出し分け、確かめの画面の文（共通の約束のとおりの言葉）、「取り消す」で窓口へ送って履歴を読み直し親に知らせること、「やめる」では送らずフォーカスが戻ること、断られたら確かめの画面に留まって理由を出し親には知らせないこと（Review Focus 4）、答えが分からない時は履歴へ戻って知らせること、送っている間は押せないこと。

`tests/unit/components/OrderHistoryDialog.test.tsx`（今の 3 行目から）:

置き換える前:

```tsx
import type { OrderHistoryEmailEntry, OrderHistoryResponse } from '@/lib/orders/email/order-history';
```

置き換えた後:

```tsx
import type {
  OrderHistoryCompletionEntry,
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
```

ファイルの終わりに足す:

```tsx
// 発送と仕上がり（グループ E-1）。履歴の窓口が返す4つの行の出し方と、発送・仕上がりの取消
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const COMPLETION_ID = 'c1c1c1c1-1111-2222-8333-444455556666';
const CANCEL_FULFILLMENT_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`;
const CANCEL_COMPLETION_URL = `/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`;
const HISTORY_URL = `/api/admin/orders/${ORDER_ID}/history`;

function fulfillmentEntry(overrides: Partial<OrderHistoryFulfillmentEntry> = {}): OrderHistoryFulfillmentEntry {
  return {
    type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 2 }], actorEmail: 'admin@example.com',
    notifyCustomer: true, completesOrder: false, cancelled: false, cancellable: true, legacy: false,
    ...overrides,
  };
}

function completionEntry(overrides: Partial<OrderHistoryCompletionEntry> = {}): OrderHistoryCompletionEntry {
  return {
    type: 'completion', at: '2026-10-10T01:00:00.000Z', completionId: COMPLETION_ID, items: [{ name: 'ウールコート', quantity: 1 }],
    actorEmail: 'admin@example.com', cancelled: false, cancellable: true, legacy: false,
    ...overrides,
  };
}

describe('OrderHistoryDialog の発送と仕上がりの行', () => {
  it('発送・発送の取消・仕上がり・仕上がりの取消の行を、決まった言葉で出す', async () => {
    const entries: OrderHistoryResponse['entries'] = [
      fulfillmentEntry({ number: 2, completesOrder: true, items: [{ name: 'シルクブラウス', quantity: 2 }, { name: 'ウールコート', quantity: 1 }] }),
      { type: 'fulfillment_cancel', at: '2026-10-10T03:00:00.000Z', fulfillmentId: 'fulfillment-0', number: 1, actorEmail: 'admin@example.com' },
      completionEntry(),
      { type: 'completion_cancel', at: '2026-10-10T00:30:00.000Z', completionId: 'completion-0', actorEmail: 'admin@example.com' },
    ];
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('発送（2回目）');
    expect(items[0]).toHaveTextContent('配送業者: ヤマト運輸 / 伝票番号: 1234-5678');
    expect(items[0]).toHaveTextContent('商品: シルクブラウス × 2 / ウールコート × 1');
    expect(items[0]).toHaveTextContent('お客様へのメール: 送る');
    expect(items[0]).toHaveTextContent('この発送で全部を送りました');
    expect(items[0]).toHaveTextContent('操作: admin@example.com');
    expect(items[1]).toHaveTextContent('発送（1回目）を取り消しました');
    expect(items[1]).toHaveTextContent('操作: admin@example.com');
    expect(items[2]).toHaveTextContent('受注生産の品が仕上がりました');
    expect(items[2]).toHaveTextContent('商品: ウールコート × 1');
    expect(items[3]).toHaveTextContent('仕上がりを取り消しました');
    expect(within(items[0]).getByRole('button', { name: 'この発送を取り消す' })).toBeInTheDocument();
    expect(within(items[2]).getByRole('button', { name: 'この仕上がりを取り消す' })).toBeInTheDocument();
  });

  it('メールを送らなかった発送と、一部だけの発送は、その通りに出す。取り消し済みの行には印を出し、取消のボタンは出さない', async () => {
    const entries: OrderHistoryResponse['entries'] = [
      fulfillmentEntry({ notifyCustomer: false, completesOrder: false }),
      fulfillmentEntry({ fulfillmentId: 'fulfillment-2', number: 2, cancelled: true, cancellable: false }),
      completionEntry({ cancelled: true, cancellable: false }),
    ];
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('お客様へのメール: 送らない');
    expect(items[0]).not.toHaveTextContent('この発送で全部を送りました');
    expect(items[0]).not.toHaveTextContent('取り消し済み');
    expect(items[1]).toHaveTextContent('取り消し済み');
    expect(items[2]).toHaveTextContent('取り消し済み');
    expect(within(dialog).getAllByRole('button', { name: 'この発送を取り消す' })).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });

  it('発送のメールの行は「発送（n回目）のメール」と出し、再送はその発送の番号を窓口へ送る', async () => {
    const shippedEmail = sentEmailEntry({
      emailId: 'email-9', kind: 'shipped', kindLabel: '発送（2回目）', fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 2,
    });
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [shippedEmail] })))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-10' }))
      .mockResolvedValueOnce(json(history({ entries: [shippedEmail] })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    expect(await screen.findByText('発送（2回目）のメール')).toBeInTheDocument();
    press(screen.getByRole('button', { name: 'お客様へ再送' }));
    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toHaveTextContent(
      '発送（2回目）のメールを、お客様（注文のメールアドレス）へもう一度送ります',
    );
    press(screen.getByRole('button', { name: '再送する' }));

    await screen.findByText('再送を受け付けました。少し待つと届きます。');
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, `/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }),
    });
  });
});

describe('OrderHistoryDialog の発送の取消', () => {
  it('確かめの画面の文を出し、「取り消す」で窓口へ送り、履歴を読み直して、親に知らせる', async () => {
    const reloaded = history({
      entries: [
        { type: 'fulfillment_cancel', at: '2026-10-10T03:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, actorEmail: 'admin@example.com' },
        fulfillmentEntry({ cancelled: true, cancellable: false }),
        { type: 'created', at: '2026-10-09T00:59:00.000Z' },
      ],
    });
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry(), { type: 'created', at: '2026-10-09T00:59:00.000Z' }] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(reloaded));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));

    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toHaveTextContent(
      '発送（1回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。',
    );
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CANCEL_FULFILLMENT_URL, { method: 'POST' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'この注文の履歴' });
    expect(screen.getByRole('status')).toHaveTextContent('発送（1回目）を取り消しました。');
    expect(within(dialog).queryByRole('button', { name: 'この発送を取り消す' })).not.toBeInTheDocument();
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('発送（1回目）を取り消しました');
    expect(items[1]).toHaveTextContent('取り消し済み');
  });

  it('もう取り消してあった（already_cancelled）時も、取り消せた時と同じ知らせにする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'already_cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('「やめる」では送らず、取消を開いた行のボタンへフォーカスが戻る', async () => {
    mockClientFetch.mockResolvedValueOnce(
      json(history({ entries: [fulfillmentEntry({ number: 2, fulfillmentId: 'fulfillment-2' }), fulfillmentEntry()] })),
    );
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press((await screen.findAllByRole('button', { name: 'この発送を取り消す' }))[1]);
    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toHaveFocus();
    press(screen.getByRole('button', { name: 'やめる' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'この発送を取り消す' })[1]).toHaveFocus();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('取り消せた後は、履歴のパネルにフォーカスが留まる（消えたボタンへ戻さない）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));
    await screen.findByText('発送（1回目）を取り消しました。');

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toHaveFocus());
  });

  it('送っている間は「取り消す」を押せず、二重に送らない', async () => {
    const post = deferredResponse();
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
    press(screen.getByRole('button', { name: '取り消す' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    await act(async () => { post.resolve(json({ outcome: 'cancelled', orderStatus: 'paid' })); });
    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
  });

  it.each([
    [409, { error: 'この発送は取り消せません。注文の状態を確かめてください。', code: 'fulfillment_cancel_not_allowed' }, 'この発送は取り消せません。注文の状態を確かめてください。'],
    [404, { error: '発送の記録が見つかりません。', code: 'fulfillment_not_found' }, '発送の記録が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [429, { error: 'Too many requests' }, '発送の取消に失敗しました。'],
  ])('窓口が断った（%i）時は、確かめの画面に留まって理由を出し、親には知らせない', async (status, body, message) => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json(body, status))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り消す' })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('答えが分からない時は、履歴へ戻って読み直し、取り消されたか確かめるよう知らせて、親にも知らせる', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    const message = '結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('OrderHistoryDialog の仕上がりの取消', () => {
  it('確かめの画面の文を出し、「取り消す」で窓口へ送り、履歴を読み直して、親に知らせる', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [completionEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled' }))
      .mockResolvedValueOnce(json(history({
        entries: [
          { type: 'completion_cancel', at: '2026-10-10T03:00:00.000Z', completionId: COMPLETION_ID, actorEmail: 'admin@example.com' },
          completionEntry({ cancelled: true, cancellable: false }),
        ],
      })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press(await screen.findByRole('button', { name: 'この仕上がりを取り消す' }));

    expect(screen.getByRole('dialog', { name: 'この仕上がりを取り消す' })).toHaveTextContent(
      'この仕上がりを取り消し、その商品を受注生産中に戻します。',
    );
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('仕上がりを取り消しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CANCEL_COMPLETION_URL, { method: 'POST' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });

  it('もう発送した数を下回る取消は断られ、その理由を確かめの画面に出す', async () => {
    const message = 'もう発送した数があるため、取り消せません。';
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [completionEntry()] })))
      .mockResolvedValueOnce(json({ error: message, code: 'completion_already_shipped' }, 409))
      .mockResolvedValueOnce(json(history({ entries: [completionEntry({ cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この仕上がりを取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'この仕上がりを取り消す' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    // 読み直した履歴では、この仕上がりはもう取り消せない行になっている
    press(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });
});
```

Run: `npx jest tests/unit/components/OrderHistoryDialog.test.tsx --runInBand`
Expected: FAIL（足した15件が落ちる。ほかの42件は PASS）

- [ ] **Step 10: 履歴の画面を直す**

`src/components/OrderHistoryDialog.tsx` を次の内容に置き換える。Task 5 が `renderEntry` の最後に足した「メールでない行は描かない」1か所（`if (entry.type !== 'email') { return null; }`）は、ここで4つの行を描く作りに置き換わる。今のファイル（グループ D のまま）との違いは次のとおり（それ以外は変えていない）。

- 取消の確かめの画面 `cancel`（発送・仕上がりの行から開く）を足し、画面の題・文・ボタン（`取り消す`・`やめる`）を共通の約束のとおりにした。送る前に前の知らせを消し、送っている間は `取り消す` を押せない
- 取消は `callFulfillmentApi` で送る（本文なしの POST）。取り消せた（`already_cancelled` も同じ）か、答えが分からない時は `onChanged` を呼んで履歴へ戻り、履歴を読み直す。断られた時は確かめの画面に留まり、理由を知らせの入れ物に出す（親には知らせない）
- 発送・仕上がりとその取消の4つの行の出し方を足した。取り消せる行にだけ `この発送を取り消す`・`この仕上がりを取り消す` を出す
- 発送のメールの再送は、本文に `fulfillmentId` を足す（番号のあるメールだけ）
- 確かめの画面から戻る時のフォーカスの仕組みを、メールだけでなく取消のボタンにも使えるようにした（`returnFocus` と、ボタンの印 `data-history-id`・`data-history-action`。T6-7）。再送を待つ間の知らせを取っておく仕組み（`pendingNotice`）は、行の番号を `targetId` にして取消にも使う

`src/components/OrderHistoryDialog.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import type {
  OrderEmailContentResponse,
  OrderHistoryCompletionEntry,
  OrderHistoryEmailEntry,
  OrderHistoryEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import { callFulfillmentApi } from '@/lib/orders/fulfillment/fulfillment-client';
import { FULFILLMENT_FAILURE_MESSAGES } from '@/lib/orders/fulfillment/fulfillment-messages';
import type { CancelCompletionResponse, CancelFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import { cn } from '@/lib/utils';

/** 取り消せる行（発送か仕上がり） */
type CancelTarget = OrderHistoryFulfillmentEntry | OrderHistoryCompletionEntry;

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry }
  | { name: 'cancel'; entry: CancelTarget };

/** 履歴の行のボタンの種類。確かめの画面から戻る時に、同じ行の同じボタンへフォーカスを戻すのに使う */
type HistoryAction = 'content' | 'resend' | 'cancel';

/** 再送・取消の結果の知らせ。受け付けは status、断り・失敗は alert の入れ物に出す */
type Notice = { tone: 'success' | 'failure'; text: string };

type OrderHistoryDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 発送か仕上がりを取り消した（結果が分からない時も）。管理画面が一覧を読み直す */
  onChanged?: () => void;
};

type OrderHistoryDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onChanged?: () => void;
};

const RESEND_ACCEPTED_MESSAGE = '再送を受け付けました。少し待つと届きます。';
const RESEND_FAILED_MESSAGE = '再送を受け付けられませんでした。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';
const CONTENT_FAILED_MESSAGE = 'メールの中身を読み込めませんでした。';
const CANCEL_UNCERTAIN_MESSAGE =
  '結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。';

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
 * 再送が断られた時の文。窓口が日本語で返す 404（注文が無い）・409（今は再送できない）の文だけを出す。
 * 回数の制限などの共通の守りは英語の短い文なので出さない。権限（403）は、管理画面の隣の操作と同じ文にする。
 */
function resendRefusalMessage(status: number, body: unknown): string {
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 404 || status === 409) return errorMessageOf(body, RESEND_FAILED_MESSAGE);
  return RESEND_FAILED_MESSAGE;
}

/** 手で再送した行の印（履歴の行と中身の画面で同じ表示にする） */
function manualMark(entry: OrderHistoryEmailEntry): string {
  return `手で再送${entry.requestedByEmail ? `（${entry.requestedByEmail}）` : ''}`;
}

function cancelTargetId(entry: CancelTarget): string {
  return entry.type === 'fulfillment' ? entry.fulfillmentId : entry.completionId;
}

/** 確かめ・取消の画面が見ている行の番号。履歴や中身の画面では null */
function viewTargetId(view: View): string | null {
  if (view.name === 'confirm') return view.entry.emailId;
  if (view.name === 'cancel') return cancelTargetId(view.entry);
  return null;
}

function cancelSuccessText(entry: CancelTarget): string {
  return entry.type === 'fulfillment' ? `発送（${entry.number}回目）を取り消しました。` : '仕上がりを取り消しました。';
}

function formatItems(items: Array<{ name: string; quantity: number }>): string {
  return items.map((item) => `${item.name} × ${item.quantity}`).join(' / ');
}

/**
 * 「この注文の履歴」（グループ D 設計書 5 章。Shopify の注文の Timeline とメールの再送に合わせる）。
 * 状態の変化・メール・発送・仕上がり（とその取消）を新しい順に出し、送ったメールの中身・再送の確かめ・
 * 発送と仕上がりの取消の確かめを同じダイアログの中で切り替える（ダイアログを重ねると、Escape で外側も閉じるため）。
 * 再送や取消ができるかは窓口が決めた値に従う。
 *
 * 開くたびに中身を作り直す（key に注文を使う）。前の注文の履歴や画面の切り替えを残したまま開くと、
 * ダイアログが先に中の先頭のボタンへ移したフォーカスが、その後の状態の消去でボタンごと外れてしまう。
 */
export default function OrderHistoryDialog({ orderId, onClose, onChanged }: OrderHistoryDialogProps) {
  return orderId ? <OrderHistoryDialogBody key={orderId} orderId={orderId} onClose={onClose} onChanged={onChanged} /> : null;
}

function OrderHistoryDialogBody({ orderId, onClose, onChanged }: OrderHistoryDialogBodyProps) {
  const [history, setHistory] = useState<OrderHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingNotice, setPendingNotice] = useState<{ targetId: string; notice: Notice } | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [submitting, setSubmitting] = useState(false);
  // いま出ている画面の入れ物。画面ごとに同じ ref を使い、ダイアログのパネルを探す起点にする
  const viewRef = useRef<HTMLDivElement>(null);
  const shownView = useRef<View['name']>('list');
  const contentRequest = useRef(0);
  const returnFocus = useRef<{ id: string; action: HistoryAction } | null>(null);

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
    void load(orderId);
  }, [orderId, load]);

  // 画面を切り替えると、押したボタンは画面ごと消えて、フォーカスがダイアログの外（body）へ落ちる（設計書 5-5、WCAG 2.4.3）。
  // 戻る・やめるでは同じ行のボタンへ戻す。ボタンが消えた場合と、それ以外の切り替えはパネルへ移す
  // （再送や取消の返事を待つ間の「やめる」も、返事の後の読み直しで行のボタンが消えるので、パネルへ移す）。
  // 最初の画面では動かさない（Dialog が開いた時に決めた場所を奪わない）
  useEffect(() => {
    if (shownView.current === view.name) return;
    shownView.current = view.name;
    const panel = viewRef.current?.closest<HTMLElement>('[role="dialog"]');
    const target = returnFocus.current;
    const opener = view.name === 'list' && target
      ? Array.from(panel?.querySelectorAll<HTMLButtonElement>('button[data-history-action]') ?? [])
          .find((button) => button.dataset.historyId === target.id && button.dataset.historyAction === target.action && !button.disabled)
      : null;
    returnFocus.current = null;
    (opener ?? panel)?.focus();
  }, [view.name]);

  // 焦点の移動と polite の文の挿入が同じ描画だと読み上げが落ちるため、上の移動の後の描画で文を入れる。
  // 別の行の確かめ・取消の画面にいる間は、その行の結果と誤解される知らせを出さずに取っておき、その画面を離れた時に出す。
  useEffect(() => {
    if (!pendingNotice) return;
    const viewTarget = viewTargetId(view);
    if (viewTarget !== null && viewTarget !== pendingNotice.targetId) return;
    setNotice(pendingNotice.notice);
    setPendingNotice(null);
  }, [pendingNotice, view]);

  const backToList = (id: string, action: HistoryAction) => {
    // 再送や取消の返事を待つ間は、返事の後の読み直しで行のボタンが消えうる（受け付けた行は再送できなくなり、
    // 取り消した行は取り消せなくなる）。消えるボタンへ戻すとフォーカスが body へ落ちるので、行は覚えず、上の effect でパネルへ移す
    returnFocus.current = action !== 'content' && submitting ? null : { id, action };
    setView({ name: 'list' });
  };

  const openContent = async (entry: OrderHistoryEmailEntry) => {
    const request = ++contentRequest.current;
    setNotice(null);
    setView({ name: 'content', entry, content: null, error: null });
    // 同じメールを開き直した要求も番号で区別し、戻った後や別のメールを開いた後の画面を前の返事で上書きしない
    const settle = (next: View) =>
      setView((current) => (
        contentRequest.current === request && current.name === 'content' && current.entry.emailId === entry.emailId ? next : current
      ));
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/${entry.emailId}`, { cache: 'no-store' });
      if (!response.ok) {
        settle({ name: 'content', entry, content: null, error: CONTENT_FAILED_MESSAGE });
        return;
      }
      settle({ name: 'content', entry, content: (await response.json()) as OrderEmailContentResponse, error: null });
    } catch {
      settle({ name: 'content', entry, content: null, error: CONTENT_FAILED_MESSAGE });
    }
  };

  const askResend = (entry: OrderHistoryEmailEntry) => {
    setNotice(null);
    setView({ name: 'confirm', entry });
  };

  const resend = async (entry: OrderHistoryEmailEntry) => {
    if (submitting) return;
    setSubmitting(true);
    // 前の知らせを消してから結果を出す（同じ文が続いても、入れ物の中の文字が変わって読み上げられる）
    setNotice(null);
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 発送のメールは、どの発送のメールかを窓口へ渡す
        body: JSON.stringify({ kind: entry.kind, ...(entry.fulfillmentId ? { fulfillmentId: entry.fulfillmentId } : {}) }),
      });
      const body: unknown = await response.json().catch(() => null);
      setPendingNotice({
        targetId: entry.emailId,
        notice: response.ok
          ? { tone: 'success', text: RESEND_ACCEPTED_MESSAGE }
          : { tone: 'failure', text: resendRefusalMessage(response.status, body) },
      });
    } catch {
      setPendingNotice({ targetId: entry.emailId, notice: { tone: 'failure', text: RESEND_FAILED_MESSAGE } });
    } finally {
      setSubmitting(false);
      // 履歴へ戻すのは、この行の確かめの画面にいる時だけ。別の画面は変えず、別の行の確かめでは上の effect が知らせを取っておく
      setView((current) =>
        current.name === 'confirm' && current.entry.emailId === entry.emailId ? { name: 'list' } : current,
      );
    }
    await load(orderId);
  };

  const askCancel = (entry: CancelTarget) => {
    setNotice(null);
    setView({ name: 'cancel', entry });
  };

  const cancel = async (entry: CancelTarget) => {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
    const targetId = cancelTargetId(entry);
    const result = await callFulfillmentApi<CancelFulfillmentResponse | CancelCompletionResponse>(
      entry.type === 'fulfillment'
        ? `/api/admin/orders/${orderId}/fulfillments/${entry.fulfillmentId}/cancel`
        : `/api/admin/orders/${orderId}/completions/${entry.completionId}/cancel`,
      undefined,
      entry.type === 'fulfillment' ? FULFILLMENT_FAILURE_MESSAGES.cancel : FULFILLMENT_FAILURE_MESSAGES.completion_cancel,
    );
    setSubmitting(false);
    if (result.kind === 'refused') {
      // 断られた＝何も変わっていない。確かめの画面に留まり、理由をその画面に出す（やめることも、押し直すこともできる）
      setPendingNotice({ targetId, notice: { tone: 'failure', text: result.message } });
    } else {
      // 取り消した（もう取り消してあった時も同じ）か、結果が分からない。どちらも状態が変わりうるので一覧を読み直させ、
      // 履歴へ戻る。取り消した行のボタンは消えるので、フォーカスはパネルへ移す
      onChanged?.();
      returnFocus.current = null;
      setPendingNotice({
        targetId,
        notice: result.kind === 'ok'
          ? { tone: 'success', text: cancelSuccessText(entry) }
          : { tone: 'failure', text: CANCEL_UNCERTAIN_MESSAGE },
      });
      setView((current) => (current.name === 'cancel' && cancelTargetId(current.entry) === targetId ? { name: 'list' } : current));
    }
    await load(orderId);
  };

  const title =
    view.name === 'content'
      ? `${view.entry.kindLabel}のメールの中身`
      : view.name === 'confirm'
        ? 'お客様へ再送'
        : view.name === 'cancel'
          ? (view.entry.type === 'fulfillment' ? 'この発送を取り消す' : 'この仕上がりを取り消す')
          : 'この注文の履歴';
  const statusText = notice?.tone === 'success' ? notice.text : null;
  const failureText = notice?.tone === 'failure' ? notice.text : null;

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
    if (entry.type === 'fulfillment') {
      return (
        <li key={`fulfillment-${entry.fulfillmentId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>{`発送（${entry.number}回目）`}</span>
            {entry.cancelled ? (
              <StatusBadge tone="neutral" size="sm">
                取り消し済み
              </StatusBadge>
            ) : null}
          </div>
          <p className="text-[#474747]">{`配送業者: ${entry.carrierLabel ?? '-'} / 伝票番号: ${entry.trackingNumber ?? '-'}`}</p>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          <p className="text-[#474747]">{`お客様へのメール: ${entry.notifyCustomer ? '送る' : '送らない'}`}</p>
          {entry.completesOrder ? <p className="text-[#474747]">この発送で全部を送りました</p> : null}
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
          {entry.cancellable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="font-acumin"
                data-history-id={entry.fulfillmentId}
                data-history-action="cancel"
                onClick={() => askCancel(entry)}
              >
                この発送を取り消す
              </Button>
            </div>
          ) : null}
        </li>
      );
    }
    if (entry.type === 'fulfillment_cancel') {
      return (
        <li key={`fulfillment-cancel-${entry.fulfillmentId}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> {`発送（${entry.number}回目）を取り消しました`}
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    if (entry.type === 'completion') {
      return (
        <li key={`completion-${entry.completionId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>受注生産の品が仕上がりました</span>
            {entry.cancelled ? (
              <StatusBadge tone="neutral" size="sm">
                取り消し済み
              </StatusBadge>
            ) : null}
          </div>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
          {entry.cancellable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="font-acumin"
                data-history-id={entry.completionId}
                data-history-action="cancel"
                onClick={() => askCancel(entry)}
              >
                この仕上がりを取り消す
              </Button>
            </div>
          ) : null}
        </li>
      );
    }
    if (entry.type === 'completion_cancel') {
      return (
        <li key={`completion-cancel-${entry.completionId}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> 仕上がりを取り消しました
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    return (
      <li key={`email-${entry.emailId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#474747]">{formatJst(entry.at)}</span>
          <span>{entry.kindLabel}のメール</span>
          {entry.manual ? <span className="text-[#474747]">{manualMark(entry)}</span> : null}
          {entry.warning ? <span className="font-semibold text-red-700">注意</span> : null}
          <StatusBadge tone={entry.warning ? 'danger' : 'neutral'} size="sm">
            {entry.stateLabel}
          </StatusBadge>
        </div>
        {entry.errorLabel ? <p className="text-[#474747]">原因: {entry.errorLabel}</p> : null}
        {entry.attempts > 1 ? <p className="text-[#474747]">試した回数: {entry.attempts}回</p> : null}
        <div className="flex flex-wrap gap-2">
          {entry.canViewContent ? (
            <Button variant="secondary" size="sm" className="font-acumin" data-history-id={entry.emailId} data-history-action="content" onClick={() => void openContent(entry)}>
              中身を見る
            </Button>
          ) : null}
          {entry.resendable ? (
            <Button variant="secondary" size="sm" className="font-acumin" data-history-id={entry.emailId} data-history-action="resend" onClick={() => askResend(entry)}>
              お客様へ再送
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Dialog open onClose={onClose} title={title}>
      {/*
        再送・取消の結果と履歴の読み込みの誤りの知らせ。画面を切り替えても履歴を読み直しても消えない入れ物を最初から置き、
        中の文字だけを変える（後から差し込んだ入れ物は、読み上げられない環境が多い）。受け付けは status、断り・失敗は alert
      */}
      <p role="status" aria-live="polite" className={cn('font-acumin lk-text-3xs text-black', statusText && 'mb-3')}>
        {statusText}
      </p>
      <div role="alert" className={cn('font-acumin lk-text-3xs text-red-700', (loadError || failureText) && 'mb-3')}>
        {loadError ? <p>{loadError}</p> : null}
        {failureText ? <p>{failureText}</p> : null}
      </div>

      {view.name === 'list' ? (
        <div ref={viewRef} className="space-y-3">
          {!history && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {history ? (
            <>
              <p className="font-acumin lk-text-3xs text-[#474747]">
                {history.order.orderNumber}（{history.order.statusLabel}）
              </p>
              <p className="font-acumin lk-text-3xs text-black">宛先: {history.order.recipient ?? 'なし'}</p>
              {/* role は付けない（画面へ戻るたびに差し込み直されて、同じ読み上げをくり返すため）。見出しの近くの文として読ませる */}
              {history.sendPaused ? (
                <p className="font-acumin lk-text-3xs text-red-700">
                  メールの送信を一時停止しています（{history.sendPaused.reasonLabel}）
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
        <div ref={viewRef} className="space-y-3">
          {view.error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {view.error}
            </p>
          ) : null}
          {!view.content && !view.error ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {view.content && (view.content.sentAt || view.entry.manual) ? (
            <p className="flex flex-wrap items-center gap-2 font-acumin lk-text-3xs text-[#474747]">
              {view.content.sentAt ? <span>送った時刻: {formatJst(view.content.sentAt)}</span> : null}
              {view.entry.manual ? <span>{manualMark(view.entry)}</span> : null}
            </p>
          ) : null}
          {view.content?.status === 'erased' ? (
            <p className="font-acumin lk-text-3xs text-black">本文の保存期間（45日）を過ぎました</p>
          ) : null}
          {view.content?.status === 'available' ? (
            <>
              <p className="font-acumin lk-text-3xs font-semibold text-black">{view.content.subject}</p>
              {/* 高さを限ってスクロールするので、キーボードでも届いてスクロールできるよう、フォーカスできて名前の付く欄にする */}
              <pre
                role="region"
                aria-label="メールの本文"
                tabIndex={0}
                className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-acumin lk-text-3xs text-black"
              >
                {view.content.bodyText}
              </pre>
            </>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(view.entry.emailId, 'content')}>
            戻る
          </Button>
        </div>
      ) : null}

      {view.name === 'confirm' ? (
        <div ref={viewRef} className="space-y-3">
          <p className="font-acumin lk-text-3xs text-black">
            {view.entry.kindLabel}のメールを、お客様（注文のメールアドレス）へもう一度送ります
          </p>
          {history?.order.recipient ? (
            <p className="font-acumin lk-text-3xs text-[#474747]">宛先: {history.order.recipient}</p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(view.entry.emailId, 'resend')}>
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

      {view.name === 'cancel' ? (
        <div ref={viewRef} className="space-y-3">
          <p className="font-acumin lk-text-3xs text-black">
            {view.entry.type === 'fulfillment'
              ? `発送（${view.entry.number}回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。`
              : 'この仕上がりを取り消し、その商品を受注生産中に戻します。'}
          </p>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(cancelTargetId(view.entry), 'cancel')}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={submitting}
              onClick={() => void cancel(view.entry)}
            >
              取り消す
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
```

Run: `npx jest tests/unit/components/OrderHistoryDialog.test.tsx --runInBand`
Expected: PASS（57件。今の42件も通る）

- [ ] **Step 11: 3つの画面と部品を、まとめて確かめる**

Run: `npx jest tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts tests/unit/components/Dialog.test.tsx tests/unit/components/OrderShipDialog.test.tsx tests/unit/components/OrderCompletionDialog.test.tsx tests/unit/components/OrderHistoryDialog.test.tsx --runInBand`
Expected: PASS（5ファイル）

Run: `npx tsc --noEmit`
Expected: エラーは `src/app/admin/page.tsx` の3か所だけ（`OrderShipValues` の import、`OrderShipDialog` の `open`・`onSubmit` の渡し方）。Task 7 が直すので、Task 6 と 7 は続けて実装し、Task 7 の後で型を全部確かめる。

Run: `npx eslint src/components/OrderShipDialog.tsx src/components/OrderCompletionDialog.tsx src/components/OrderHistoryDialog.tsx src/components/ui/Dialog src/lib/orders/fulfillment/fulfillment-client.ts tests/unit/components/OrderShipDialog.test.tsx tests/unit/components/OrderCompletionDialog.test.tsx tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/Dialog.test.tsx tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts`
Expected: エラー0件

Task 6 の後は、今の `tests/unit/components/AdminOrderHistoryWiring.test.tsx` の発送の試験（古い `/status` の窓口へ送る形）が落ちる。画面が変わったためで、Task 7 の Step 5 で書き直すので、ここでは直さない。

画面の見え方（390・768・1280）は Task 10 の E2E が確かめる。発送の DB の関数は本番に無いので、開発サーバーで管理画面から発送を試さない（本番の DB に発送の予定が溜まる）。

- [ ] **Step 12: コミット（controller）**

```bash
git add src/lib/orders/fulfillment/fulfillment-client.ts src/components/OrderCompletionDialog.tsx src/components/OrderShipDialog.tsx src/components/OrderHistoryDialog.tsx src/components/ui/Dialog/Dialog.tsx src/components/ui/Dialog/Dialog_types.ts src/components/ui/Dialog/Dialog.css tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts tests/unit/components/OrderCompletionDialog.test.tsx tests/unit/components/OrderShipDialog.test.tsx tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/Dialog.test.tsx
git commit -m "feat(admin): 発送の画面を材料から作り直し、仕上がりの画面と履歴の発送・仕上がりの取消を足す（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 管理画面の注文の一覧

**Files:**
- Modify: `src/app/api/admin/orders/route.ts:8,31,99,188,251,310,355,362`（読む列・商品ごとの数・言葉・ボタンの可否）
- Modify: `src/components/OrderSection.tsx`（全体を置き換える。今との違いは Step 4 の一覧）
- Modify: `src/app/admin/page.tsx:20,26,34,82,117,244,368,385,405,481,571,699,971,983,987`（絞り込み・件数・CSV・発送と仕上がりの画面のつなぎ）
- Test: `tests/unit/api/admin/orders-search-route.test.ts:7,55,276,306,312`（直しと追加）・`tests/unit/components/OrderSection.actions.test.tsx`（書き直し）・`tests/unit/components/AdminOrderHistoryWiring.test.tsx`（書き直し）・`tests/unit/components/AdminOrderRefundFlow.test.tsx:63`（見本の言葉）

**Interfaces:**
- Consumes:
  - Task 3 の `src/lib/orders/fulfillment/fulfillment-store.ts`: `listOrderLineFulfillment(store, orderIds)`・型 `OrderLineFulfillmentRow`（窓口は service_role の client を渡す）
  - Task 3 の `src/lib/orders/order-progress.ts`: `deriveOrderProgress(status, lines)`・`PARTIALLY_SHIPPED_LABEL`・型 `OrderProgressKey`
  - Task 6 の `OrderShipDialog({ orderId, onClose, onShipped })`・`OrderCompletionDialog({ orderId, onClose, onRecorded })`・`OrderHistoryDialog({ orderId, onClose, onChanged? })`、`fulfillment-client.ts` の `COMPLETION_RECORDED_MESSAGE`
  - 既存: `authorizeAdminPermission`・`createClient`・`createServiceRoleClient`・`findMissingShippingFields`・`StatusBadge`・`TagLabel`・`toOrderNumber`
- Produces:
  - `GET /api/admin/orders` の各行（共通の約束のとおり）: `status`（注文の言葉）・`orderStatus`（DB の状態）・`progressKey`・`partiallyShipped`・`canShip`・`canRecordCompletion`、`items: Array<{ id, name, color, size, quantity, fulfillmentType, shipped, inProduction, readyUnshipped }>`。今の列（`itemCount`・`canRefund`・`shippedAt` など）は変えない。`status` の問い合わせの値は DB の状態のまま
  - `OrderSection`: 型 `OrderStatus`（9つの言葉）・`OrderLineItem`・`OrderItem`（`orderStatus`・`progressKey`・`partiallyShipped`・`canRecordCompletion` は省略できる）、新しい props `onRecordCompletion?: (id: string) => void`

**決め事**（本計画 P9・P10 の続き）:

| ID | 決め事 | 理由 |
|---|---|---|
| T7-1 | 商品ごとの数を読むのは、支払い済み（`paid`）と発送済み（`shipped`）の注文だけ。ほかの注文は数を0にして返す | 未入金・失敗・キャンセルの注文に「発送準備中 2」と出すのは誤りになる（まだ作る・送る段階ではない）。DB の呼び出しも小さくなる。言葉は `deriveOrderProgress` が状態から出す（`paid`・`shipped` 以外は数を見ない） |
| T7-2 | 数を読めなかった時は一覧全体を 500 にする（数が無いまま「発送済みにする」を出さない） | 一覧が静かに間違うより、読み直してもらう方が安全 |
| T7-3 | 「配送先要確認」と発送を止める理由の出し分けは、言葉ではなく `orderStatus`（無い時は言葉が受注生産中・発送準備中か）で見る。ボタンは `canShip`・`canRecordCompletion` だけで決める | 言葉は表示のため（P10）。受注生産中の言葉の注文にも発送のボタンが出る |
| T7-4 | 絞り込みの値は DB の状態をそのまま持ち（`paid` など）、窓口の `status` へそのまま送る。2つ以上選んだ時は `status` を送らず、`orderStatus` で手元の一覧を絞る | 「発送済み」の絞り込みが窓口へ渡らない前からの不具合（設計書 2章）を、言葉と状態の変換表をやめて直す |
| T7-5 | 注文の取消の後の手元の更新に `orderStatus: 'cancelled'` も入れる | 件数と絞り込みが `orderStatus` を見るようになるため |
| T7-6 | 発送・仕上がりの画面が成功したら、閉じるのはその操作の注文の画面だけにし、一覧を読み直す。仕上がりの後は `仕上がりを記録しました。` を一覧の知らせに出す。発送の後の知らせは出さない | 返事を待つ間に別の注文の画面を開いていても、その画面を閉じない。手元で言葉を書き換えない（言葉は記録から出す） |

古い言葉（`決済完了`・`発送済み`）は、注文の言葉としては無くなる。履歴の画面の「状態」の行（DB の状態の移り変わり。設計書 4-4）と、状態の窓口の試験には残ってよい。

- [ ] **Step 1: 窓口の試験を直し、足す**

`tests/unit/api/admin/orders-search-route.test.ts` を直す。service_role の client に `rpc`（`list_order_line_fulfillment`）を足し、言葉は商品ごとの数から出すようにする。そのあと、いちばん外の `describe` の終わりの直前に、商品ごとの数・注文の言葉・発送と仕上がりのボタンの試験を足す。

`tests/unit/api/admin/orders-search-route.test.ts`（今の 7 行目から）:

置き換える前:

```ts
let shipBlockedRows: Array<{ order_id: string }> = [];
```

置き換えた後:

```ts
let shipBlockedRows: Array<{ order_id: string }> = [];
// public.list_order_line_fulfillment が返す行（service_role の RPC）。支払い済み・発送済みの注文の商品ごとの数
let lineFulfillmentRows: Array<Record<string, unknown>> = [];
const rpcMock = jest.fn();

function lineRow(overrides: Record<string, unknown>) {
  return {
    order_id: 'order-1', order_item_id: 'item-1', variant_id: 1, fulfillment_type: 'stock', quantity: 1,
    shipped: 0, completed: 1, in_production: 0, ready_unshipped: 1, unshipped: 1,
    ...overrides,
  };
}
```

`tests/unit/api/admin/orders-search-route.test.ts`（今の 55 行目から）:

置き換える前:

```ts
    shipBlockedRows = [];
    createServiceRoleClientMock.mockResolvedValue({
      from: jest.fn().mockReturnValue({
        select: () => ({
          in: () => ({
            eq: () => ({
              is: async () => ({ data: shipBlockedRows, error: null }),
            }),
          }),
        }),
      }),
    });
```

置き換えた後:

```ts
    shipBlockedRows = [];
    lineFulfillmentRows = [];
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: lineFulfillmentRows, error: null }));
    createServiceRoleClientMock.mockResolvedValue({
      from: jest.fn().mockReturnValue({
        select: () => ({
          in: () => ({
            eq: () => ({
              is: async () => ({ data: shipBlockedRows, error: null }),
            }),
          }),
        }),
      }),
      rpc: (...args: unknown[]) => rpcMock(...args),
    });
```

`tests/unit/api/admin/orders-search-route.test.ts`（今の 276 行目から）:

置き換える前:

```ts
          review_reason: 'stock_not_reserved',
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
      ],
      count: 3,
      error: null,
    };
    shipBlockedRows = [{ order_id: 'order-mismatch' }];
```

置き換えた後:

```ts
          review_reason: 'stock_not_reserved',
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [
            { id: 'item-mismatch', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillment_type: 'stock' },
          ],
        },
      ],
      count: 3,
      error: null,
    };
    shipBlockedRows = [{ order_id: 'order-mismatch' }];
    lineFulfillmentRows = [lineRow({ order_id: 'order-mismatch', order_item_id: 'item-mismatch' })];
```

`tests/unit/api/admin/orders-search-route.test.ts`（今の 306 行目から）:

置き換える前:

```ts
    expect(byId['order-in-progress']).toMatchObject({ status: '支払い手続き中', canCancel: true, cancelBlockedUntil: null });
    expect(byId['order-voucher']).toMatchObject({
      status: '未決済',
      canCancel: false,
```

置き換えた後:

```ts
    expect(byId['order-in-progress']).toMatchObject({
      status: '支払い手続き中', orderStatus: 'payment_in_progress', canCancel: true, cancelBlockedUntil: null,
    });
    expect(byId['order-voucher']).toMatchObject({
      status: '未決済',
      orderStatus: 'pending',
      canCancel: false,
```

`tests/unit/api/admin/orders-search-route.test.ts`（今の 312 行目から）:

置き換える前:

```ts
    expect(byId['order-mismatch']).toMatchObject({
      status: '決済完了',
      needsReview: true,
```

置き換えた後:

```ts
    expect(byId['order-mismatch']).toMatchObject({
      status: '発送準備中',
      orderStatus: 'paid',
      needsReview: true,
```

いちばん外の `describe` の終わりの `});` の直前に足す:

```ts
  // 注文の言葉と発送・仕上がりのボタンは、商品ごとの数（private.order_line_fulfillment を service_role で読んだ物）から出す。
  // 言葉（status）は表示のため。件数・絞り込み・CSV の判断には DB の状態（orderStatus）を使う（本計画 P9・P10）
  describe('商品ごとの数・注文の言葉・発送と仕上がりのボタン', () => {
    function paidOrderRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        payment_intent_id: null,
        checkout_session_id: 'cs_1',
        status: 'paid',
        total_amount: 30_000,
        currency: 'jpy',
        shipping_email: 'buyer@example.com',
        shipping_full_name: '山田太郎',
        shipping_postal_code: '1000001',
        shipping_prefecture: '東京都',
        shipping_city: '千代田区',
        shipping_address: '丸の内1-1-1',
        shipping_phone: '0312345678',
        review_reason: null,
        reviewed_at: null,
        created_at: '2026-10-10T00:00:00.000Z',
        shipped_at: null,
        shipping_carrier: null,
        tracking_number: null,
        order_items: [
          { id: 'item-stock', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock' },
          { id: 'item-coat', item_name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'backorder' },
        ],
        ...overrides,
      };
    }

    async function listOrders(rows: unknown[], url = 'http://localhost/api/admin/orders') {
      queryResult = { data: rows, count: rows.length, error: null };
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request(url));
      const body = await response.json() as { data: Array<Record<string, any>> };
      return { response, rows: body.data };
    }

    it('商品の番号・色・サイズ・在庫か受注生産かを、注文の商品と一緒に読む', async () => {
      await listOrders([]);

      const selected = String(query.select.mock.calls[0][0]);
      expect(selected).toMatch(/order_items\s*\(\s*id,\s*item_name,\s*color,\s*size,\s*quantity,\s*fulfillment_type\s*\)/);
      expect(query.select.mock.calls[0][1]).toEqual({ count: 'exact' });
    });

    it('一部を送って受注生産の品が残る注文は「受注生産中」＋一部発送済みで、発送も仕上がりの記録もできる', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 1, completed: 2, in_production: 0, ready_unshipped: 1, unshipped: 1 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-1'] });
      expect(rows[0]).toMatchObject({
        status: '受注生産中',
        orderStatus: 'paid',
        progressKey: 'in_production',
        partiallyShipped: true,
        canShip: true,
        canRecordCompletion: true,
        itemCount: '3点',
      });
      expect(rows[0].items).toEqual([
        {
          id: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillmentType: 'stock',
          shipped: 1, inProduction: 0, readyUnshipped: 1,
        },
        {
          id: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder',
          shipped: 0, inProduction: 1, readyUnshipped: 0,
        },
      ]);
    });

    it('全部の商品が発送準備中なら「発送準備中」で、仕上がりの記録は出さない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, completed: 2, ready_unshipped: 2, unshipped: 2 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, completed: 1, ready_unshipped: 1, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({
        status: '発送準備中', orderStatus: 'paid', progressKey: 'ready', partiallyShipped: false, canShip: true, canRecordCompletion: false,
      });
    });

    it('全部を送った注文は「配送中」（DB の状態は shipped）で、発送も仕上がりの記録もできない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, shipped: 1, completed: 1, ready_unshipped: 0, unshipped: 0 }),
      ];

      const { rows } = await listOrders([
        paidOrderRow({ status: 'shipped', shipped_at: '2026-10-10T01:00:00.000Z', shipping_carrier: 'yamato', tracking_number: '1234' }),
      ]);

      expect(rows[0]).toMatchObject({
        status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', partiallyShipped: false, canShip: false, canRecordCompletion: false,
      });
    });

    it('数を読むのは支払い済みと発送済みの注文だけ。ほかの注文は数を 0 にして、言葉は状態のまま', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-paid', order_item_id: 'item-stock', quantity: 2, completed: 2, ready_unshipped: 2, unshipped: 2 }),
      ];

      const { rows } = await listOrders([
        paidOrderRow({ id: 'order-pending', status: 'pending' }),
        paidOrderRow({ id: 'order-failed', status: 'failed' }),
        paidOrderRow({ id: 'order-cancelled', status: 'cancelled' }),
        paidOrderRow({ id: 'order-paid', order_items: [{ id: 'item-stock', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock' }] }),
      ]);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

      expect(rpcMock).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-paid'] });
      expect(byId['order-pending']).toMatchObject({ status: '未決済', orderStatus: 'pending', canShip: false, canRecordCompletion: false, partiallyShipped: false });
      expect(byId['order-failed']).toMatchObject({ status: '決済失敗', orderStatus: 'failed' });
      expect(byId['order-cancelled']).toMatchObject({ status: 'キャンセル', orderStatus: 'cancelled' });
      expect(byId['order-pending'].items.every((item: Record<string, number>) => item.shipped === 0 && item.inProduction === 0 && item.readyUnshipped === 0)).toBe(true);
      expect(byId['order-paid']).toMatchObject({ status: '発送準備中', canShip: true });
    });

    it('支払い済み・発送済みの注文が無い一覧は、数を読みに行かない', async () => {
      const { rows } = await listOrders([paidOrderRow({ status: 'pending' })]);

      expect(rows).toHaveLength(1);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it('支払額の確認が残る注文は発送できないが、受注生産中の数があれば仕上がりは記録できる', async () => {
      shipBlockedRows = [{ order_id: 'order-1' }];
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, completed: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({
        canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）', canRecordCompletion: true,
      });
    });

    it('送る品も作る品も残っていない支払い済みの注文には、発送も仕上がりの記録も出さない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({ canShip: false, canRecordCompletion: false });
    });

    it('数を読めなかった時は 500 にする（数が無いまま発送できる印を出さない）', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      rpcMock.mockResolvedValue({ data: null, error: { message: 'down', code: '08006' } });
      queryResult = { data: [paidOrderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
      } finally {
        consoleError.mockRestore();
      }
    });

    it('状態の絞り込みの値は DB の状態のまま。言葉（発送済み・配送中など）は受け付けない', async () => {
      const { GET } = await import('@/app/api/admin/orders/route');

      expect((await GET(new Request('http://localhost/api/admin/orders?status=shipped'))).status).toBe(200);
      expect(query.eq).toHaveBeenCalledWith('status', 'shipped');
      expect((await GET(new Request(`http://localhost/api/admin/orders?status=${encodeURIComponent('発送済み')}`))).status).toBe(400);
      expect((await GET(new Request(`http://localhost/api/admin/orders?status=${encodeURIComponent('配送中')}`))).status).toBe(400);
    });
  });
```

Run: `npx jest tests/unit/api/admin/orders-search-route.test.ts --runInBand`
Expected: FAIL（足した試験と、言葉を直した試験の9件が落ちる。ほかの16件は PASS）

- [ ] **Step 2: 窓口を直す**

商品の番号・色・サイズ・在庫か受注生産かを読み、商品ごとの数を service_role で読み（T7-1）、言葉・DB の状態・一部発送済みか・ボタンの可否を返す。`canShip` は「支払い済みで、発送準備中か受注生産中の数があり、配送先がそろい、支払額の確かめが残っていない」（共通の約束）。`canRecordCompletion` は「支払い済みで、受注生産中の数がある」。今の `shippedAt`・`shippingCarrier`・`trackingNumber`（全部を送った時の値）は変えずに返す。

`src/app/api/admin/orders/route.ts`（今の 8 行目から）:

置き換える前:

```ts
import { ORDER_STATUS_LABELS, type OrderStatusLabel } from '@/lib/orders/email/order-history';
```

置き換えた後:

```ts
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
```

`src/app/api/admin/orders/route.ts`（今の 31 行目から）:

置き換える前:

```ts
  order_items: Array<{
    item_name: string;
    quantity: number;
  }> | null;
};
```

置き換えた後:

```ts
  order_items: Array<{
    id: string;
    item_name: string;
    color: string | null;
    size: string | null;
    quantity: number;
    fulfillment_type: 'stock' | 'backorder';
  }> | null;
};
```

`src/app/api/admin/orders/route.ts`（今の 99 行目から）:

置き換える前:

```ts
function mapOrderStatusToLabel(status: OrderStatus): OrderStatusLabel {
  return ORDER_STATUS_LABELS[status];
}
```

置き換えた後:

（何も書かない。上の部分を、後ろの空行も含めて消す）

`src/app/api/admin/orders/route.ts`（今の 188 行目から）:

置き換える前:

```ts
  return new Set((data ?? []).map((row: { order_id: string }) => row.order_id));
}

export async function GET(request: Request) {
```

置き換えた後:

```ts
  return new Set((data ?? []).map((row: { order_id: string }) => row.order_id));
}

/**
 * 商品ごとの数（発送した・受注生産中・発送準備中）。支払い済みと発送済みの注文だけ数える。
 * 未入金などの注文は、まだ作る・送る段階に入っていないので数に意味が無い。
 * 数は service_role で読む（新しい表は利用者の JWT からは読めない。設計書 3-4）
 */
async function fetchLineCounts(orderRows: OrderRow[]): Promise<Map<string, OrderLineFulfillmentRow[]>> {
  const orderIds = orderRows
    .filter((order) => order.status === 'paid' || order.status === 'shipped')
    .map((order) => order.id);
  if (orderIds.length === 0) {
    return new Map();
  }

  return listOrderLineFulfillment(await createServiceRoleClient(), orderIds);
}

export async function GET(request: Request) {
```

`src/app/api/admin/orders/route.ts`（今の 251 行目から）:

置き換える前:

```ts
        order_items (
          item_name,
          quantity
        )
```

置き換えた後:

```ts
        order_items (
          id,
          item_name,
          color,
          size,
          quantity,
          fulfillment_type
        )
```

`src/app/api/admin/orders/route.ts`（今の 310 行目から）:

置き換える前:

```ts
    const [paymentIntentMap, shipBlockedOrderIds] = await Promise.all([
      fetchPaymentIntentMap(paymentIntentIds),
      fetchShipBlockedOrderIds(orderRows.map((order) => order.id)),
    ]);

    const responseData = orderRows.map((order) => {
      const items = (order.order_items ?? []).map((item) => ({
        name: item.item_name,
        quantity: item.quantity,
      }));

      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
```

置き換えた後:

```ts
    const [paymentIntentMap, shipBlockedOrderIds, lineCountsByOrder] = await Promise.all([
      fetchPaymentIntentMap(paymentIntentIds),
      fetchShipBlockedOrderIds(orderRows.map((order) => order.id)),
      fetchLineCounts(orderRows),
    ]);

    const responseData = orderRows.map((order) => {
      const lineCounts = lineCountsByOrder.get(order.id) ?? [];
      const countsByItem = new Map(lineCounts.map((row) => [row.orderItemId, row]));
      const items = (order.order_items ?? []).map((item) => {
        const counts = countsByItem.get(item.id);
        return {
          id: item.id,
          name: item.item_name,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          fulfillmentType: item.fulfillment_type,
          shipped: counts?.shipped ?? 0,
          inProduction: counts?.inProduction ?? 0,
          readyUnshipped: counts?.readyUnshipped ?? 0,
        };
      });

      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const inProductionTotal = items.reduce((sum, item) => sum + item.inProduction, 0);
      const readyTotal = items.reduce((sum, item) => sum + item.readyUnshipped, 0);
      const progress = deriveOrderProgress(order.status, lineCounts);
```

`src/app/api/admin/orders/route.ts`（今の 355 行目から）:

置き換える前:

```ts
        status: mapOrderStatusToLabel(order.status),
        paymentMethod: mapPaymentMethodLabel(paymentIntent),
```

置き換えた後:

```ts
        // 言葉（status）は表示のため。件数・絞り込み・CSV の判断には DB の状態（orderStatus）を使う
        status: progress.label,
        orderStatus: order.status,
        progressKey: progress.key,
        partiallyShipped: progress.partiallyShipped,
        paymentMethod: mapPaymentMethodLabel(paymentIntent),
```

`src/app/api/admin/orders/route.ts`（今の 362 行目から）:

置き換える前:

```ts
        canShip: order.status === 'paid' && missingShippingFields.length === 0 && !shipBlockedReason,
```

置き換えた後:

```ts
        // 発送準備中か受注生産中の数があれば発送の画面を開ける（受注生産中の品は、画面の中で仕上がりを記録してから送る）
        canShip:
          order.status === 'paid'
          && readyTotal + inProductionTotal > 0
          && missingShippingFields.length === 0
          && !shipBlockedReason,
        canRecordCompletion: order.status === 'paid' && inProductionTotal > 0,
```

Run: `npx jest tests/unit/api/admin/orders-search-route.test.ts --runInBand`
Expected: PASS（25件）

- [ ] **Step 3: 一覧の部品の試験を書き直す**

今の試験の見本は古い言葉（`決済完了`・`発送済み`）と、`id` の無い商品を使っている。新しい型の見本に書き直し、元の試験は言葉だけ直して残す。新しく確かめることは、言葉ごとの印の色と tone、`一部発送済み` の印、商品の欄（`名前（色 / サイズ）×数（受注生産中 n・発送準備中 n・発送済み n`、0の数は出さない）、同じ名前の商品でも番号で区別して key の警告が出ないこと、`仕上がりを記録する` のボタン、`発送済みにする` を言葉でなく `canShip` で出すこと。

`tests/unit/components/OrderSection.actions.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import OrderSection, { type OrderItem, type OrderLineItem, type OrderStatus } from '@/components/OrderSection';

function line(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 'line-1', name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock',
    shipped: 0, inProduction: 0, readyUnshipped: 1,
    ...overrides,
  };
}

const paidOrder: OrderItem = {
  id: 'paid-order',
  customerName: 'Paid Customer',
  customerEmail: 'paid@example.com',
  orderDate: '2026-09-22',
  itemCount: '1点',
  items: [line()],
  totalAmount: '¥10,000',
  status: '発送準備中',
  orderStatus: 'paid',
  progressKey: 'ready',
  partiallyShipped: false,
  canRefund: true,
  canShip: true,
  canRecordCompletion: false,
};

const pendingOrder: OrderItem = {
  ...paidOrder,
  id: 'pending-order',
  status: '未決済',
  orderStatus: 'pending',
  progressKey: 'unpaid',
  items: [line({ readyUnshipped: 0 })],
  canRefund: false,
  canShip: false,
  canCancel: true,
};

/** 受注生産の品が1つ作り中の注文 */
const inProductionOrder: OrderItem = {
  ...paidOrder,
  id: 'in-production-order',
  status: '受注生産中',
  progressKey: 'in_production',
  items: [line({ id: 'line-coat', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder', inProduction: 1, readyUnshipped: 0 })],
  canRecordCompletion: true,
};

describe('OrderSection order actions', () => {
  it('shows cancel only for an unpaid order', () => {
    const onCancelOrder = jest.fn();

    render(
      <OrderSection
        orders={[paidOrder, pendingOrder]}
        onCancelOrder={onCancelOrder}
        onRefundOrder={jest.fn()}
        onShipOrder={jest.fn()}
      />,
    );

    const cancelButtons = screen.getAllByRole('button', { name: 'キャンセル' });
    expect(cancelButtons).toHaveLength(1);

    fireEvent.click(cancelButtons[0]);
    expect(onCancelOrder).toHaveBeenCalledWith('pending-order');
  });

  it('配送先が欠けた決済済み注文は発送操作を出さず確認を促す', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, canShip: false, missingShippingFields: ['address', 'phone'] }]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
    expect(screen.getByText('配送先要確認')).toBeInTheDocument();
  });

  it('受注生産中の言葉の注文でも、配送先が欠けていれば確認を促し、支払額の確認が必要なら理由を出す', () => {
    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, id: 'no-address', canShip: false, missingShippingFields: ['address'] },
          { ...inProductionOrder, id: 'blocked', canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）' },
        ]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.getAllByText('配送先要確認')).toHaveLength(1);
    expect(screen.getByText('支払額の確認が必要です（要対応）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
  });

  it('要確認の注文に「要確認」の印を出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, needsReview: true }]} />);

    expect(screen.getByText('要確認')).toBeInTheDocument();
  });

  it('支払額の確認が必要な注文は、発送ボタンの代わりに理由を出す', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）' }]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
    expect(screen.getByText('支払額の確認が必要です（要対応）')).toBeInTheDocument();
    expect(screen.queryByText('配送先要確認')).not.toBeInTheDocument();
  });

  it('払込票が有効な注文は、取消の代わりに払込期限を出す', () => {
    render(
      <OrderSection
        orders={[{ ...pendingOrder, canCancel: false, cancelBlockedUntil: '2026-09-30T14:59:59.000Z' }]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/払込票の期限切れが確定するまで取り消せません（払込期限 2026\/09\/30 23:59）/),
    ).toBeInTheDocument();
  });

  it('取り消せず払込期限も無い未決済の注文は、支払いの状態を確かめられないことを出す', () => {
    render(
      <OrderSection
        orders={[{ ...pendingOrder, canCancel: false, cancelBlockedUntil: null }]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(screen.getByText('支払いの状態を確かめられないため、今は取り消せません')).toBeInTheDocument();
  });

  it('取消済みや配送中の注文には、取り消せない理由を出さない', () => {
    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'cancelled-order', status: 'キャンセル', orderStatus: 'cancelled', canRefund: false, canShip: false, canCancel: false },
          { ...paidOrder, id: 'shipped-order', status: '配送中', orderStatus: 'shipped', canShip: false, canCancel: false },
        ]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByText('支払いの状態を確かめられないため、今は取り消せません')).not.toBeInTheDocument();
    expect(screen.queryByText(/払込票の期限切れが確定するまで取り消せません/)).not.toBeInTheDocument();
  });

  it('放棄の印は、灰色の背景に読める文字色（#474747）で出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, status: '放棄', orderStatus: 'abandoned', canRefund: false, canShip: false }]} />);

    const badge = screen.getByText('放棄');
    expect(badge).toHaveClass('bg-gray-100', 'text-[#474747]');
    expect(badge).not.toHaveClass('text-gray-500');
  });

  it('支払い手続き中の注文も取り消せる', () => {
    const onCancelOrder = jest.fn();
    render(
      <OrderSection
        orders={[{ ...pendingOrder, id: 'in-progress', status: '支払い手続き中', orderStatus: 'payment_in_progress' }]}
        onCancelOrder={onCancelOrder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancelOrder).toHaveBeenCalledWith('in-progress');
  });

  it('どの注文にも「履歴」を出し、押すと注文の番号を渡す', () => {
    const onShowHistory = jest.fn();

    render(<OrderSection orders={[paidOrder, pendingOrder]} onShowHistory={onShowHistory} />);

    const buttons = screen.getAllByRole('button', { name: /の履歴$/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('履歴');
    fireEvent.click(buttons[1]);
    expect(onShowHistory).toHaveBeenCalledWith('pending-order');
  });
});

describe('OrderSection の注文の言葉と印', () => {
  it.each<[OrderStatus, string, string]>([
    ['未決済', 'bg-red-100 text-red-800', 'warning'],
    ['受注生産中', 'bg-blue-100 text-blue-800', 'positive'],
    ['発送準備中', 'bg-yellow-100 text-yellow-800', 'positive'],
    ['配送中', 'bg-green-100 text-green-800', 'positive'],
    ['配達済み', 'bg-green-100 text-green-800', 'positive'],
    ['決済失敗', 'bg-orange-100 text-orange-800', 'danger'],
    ['キャンセル', 'bg-gray-100 text-gray-500', 'danger'],
  ])('「%s」の印は %s の色で、tone は %s', (status, classes, tone) => {
    render(<OrderSection orders={[{ ...paidOrder, status }]} />);

    const badge = screen.getByText(status, { selector: 'span' });
    expect(badge).toHaveClass(...classes.split(' '));
    expect(badge).toHaveAttribute('data-ui-badge-tone', tone);
  });

  it('一部を発送した注文には、言葉の隣に「一部発送済み」の印を出す', () => {
    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, id: 'partial', partiallyShipped: true },
          { ...paidOrder, id: 'plain' },
        ]}
      />,
    );

    expect(screen.getAllByText('一部発送済み')).toHaveLength(1);
    const rows = screen.getAllByRole('row');
    expect(within(rows.find((row) => row.textContent?.includes('partial')) as HTMLElement).getByText('一部発送済み')).toBeInTheDocument();
  });

  it('購入商品は「名前（色 / サイズ）×数」と、0でない数だけを括弧に出す', () => {
    render(
      <OrderSection
        orders={[
          {
            ...paidOrder,
            items: [
              line({ id: 'line-a', quantity: 2, inProduction: 1, readyUnshipped: 0, shipped: 1 }),
              line({ id: 'line-b', name: 'ウールパンツ', color: null, size: '2', quantity: 3, readyUnshipped: 3 }),
              line({ id: 'line-c', name: 'ストール', color: null, size: null, quantity: 1, readyUnshipped: 0, shipped: 0 }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('シルクブラウス（白 / M）×2（受注生産中 1・発送済み 1）')).toBeInTheDocument();
    expect(screen.getByText('ウールパンツ（2）×3（発送準備中 3）')).toBeInTheDocument();
    expect(screen.getByText('ストール×1')).toBeInTheDocument();
  });

  it('受注生産中・発送準備中・発送済みが全部ある商品は、手前の段階から順に並べる', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, items: [line({ quantity: 6, inProduction: 1, readyUnshipped: 2, shipped: 3 })] }]}
      />,
    );

    expect(screen.getByText('シルクブラウス（白 / M）×6（受注生産中 1・発送準備中 2・発送済み 3）')).toBeInTheDocument();
  });

  it('同じ名前の商品が色違いで並んでも、商品の番号で区別し、key の警告を出さない', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <OrderSection
          orders={[
            {
              ...paidOrder,
              items: [line({ id: 'line-white', color: '白' }), line({ id: 'line-black', color: '黒' })],
            },
          ]}
        />,
      );

      expect(screen.getByText('シルクブラウス（白 / M）×1（発送準備中 1）')).toBeInTheDocument();
      expect(screen.getByText('シルクブラウス（黒 / M）×1（発送準備中 1）')).toBeInTheDocument();
      expect(error.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

describe('OrderSection の仕上がりと発送のボタン', () => {
  it('受注生産中の数がある注文には「仕上がりを記録する」を出し、押すと注文の番号を渡す', () => {
    const onRecordCompletion = jest.fn();

    render(<OrderSection orders={[inProductionOrder, paidOrder]} onRecordCompletion={onRecordCompletion} />);

    const buttons = screen.getAllByRole('button', { name: '仕上がりを記録する' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onRecordCompletion).toHaveBeenCalledWith('in-production-order');
  });

  it('仕上がりを記録できない注文や、押した時の処理が無い一覧には「仕上がりを記録する」を出さない', () => {
    const { rerender } = render(<OrderSection orders={[inProductionOrder]} />);
    expect(screen.queryByRole('button', { name: '仕上がりを記録する' })).not.toBeInTheDocument();

    rerender(<OrderSection orders={[{ ...inProductionOrder, canRecordCompletion: false }]} onRecordCompletion={jest.fn()} />);
    expect(screen.queryByRole('button', { name: '仕上がりを記録する' })).not.toBeInTheDocument();
  });

  it('「発送済みにする」は言葉ではなく canShip で決める（受注生産中の言葉の注文にも出る。配送中の注文には出ない）', () => {
    const onShipOrder = jest.fn();

    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, canShip: true },
          { ...paidOrder, id: 'shipped-order', status: '配送中', orderStatus: 'shipped', canShip: false },
        ]}
        onShipOrder={onShipOrder}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: '発送済みにする' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onShipOrder).toHaveBeenCalledWith('in-production-order');
  });

  it('処理中の注文のボタンは押せず「処理中...」と出す', () => {
    render(
      <OrderSection
        orders={[{ ...inProductionOrder, canShip: true }]}
        onShipOrder={jest.fn()}
        onRecordCompletion={jest.fn()}
        processingOrderIds={['in-production-order']}
      />,
    );

    expect(screen.getAllByRole('button', { name: '処理中...' })).toHaveLength(2);
    for (const button of screen.getAllByRole('button', { name: '処理中...' })) {
      expect(button).toBeDisabled();
    }
  });
});
```

Run: `npx jest tests/unit/components/OrderSection.actions.test.tsx --runInBand`
Expected: FAIL（新しい言葉・印・ボタンの14件が落ちる。元の試験のうち12件は PASS）

- [ ] **Step 4: 一覧の部品を直す**

`src/components/OrderSection.tsx` を次の内容に置き換える（インデントはタブ。今のファイルと同じ）。今のファイルとの違いは次のとおり（それ以外は変えていない）。

- 型: `OrderStatus` を9つの言葉にする。`OrderLineItem` に `id`・`color`・`size`・`fulfillmentType`・`shipped`・`inProduction`・`readyUnshipped` を足す。`OrderItem` に省略できる `orderStatus`・`progressKey`・`partiallyShipped`・`canRecordCompletion` を足す。props に `onRecordCompletion` を足す
- 言葉の印の色と tone を、コンポーネントの外の2つの表（`STATUS_TONES`・`STATUS_CLASSES`）にした。`受注生産中` は青、`発送準備中` は黄（今の `決済完了`）、`配送中`・`配達済み` は緑（今の `発送済み`）
- 状態の欄に `一部発送済み` の印を足す
- 商品の欄を `formatOrderLineItem` の言葉にし、React の key を商品の番号にする
- 操作の欄に `仕上がりを記録する` を足す。`発送済みにする` は `canShip && onShipOrder` だけで出す。発送を止める理由と `配送先要確認` は、言葉でなく発送待ちか（`isAwaitingShipment`）で出す

`src/components/OrderSection.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/Button/Button';
import { DataTable } from '@/components/ui/DataTable/DataTable';
import { StatusBadge, type StatusBadgeTone } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus as DbOrderStatus } from '@/lib/orders/order-payment-types';
import { PARTIALLY_SHIPPED_LABEL, type OrderProgressKey } from '@/lib/orders/order-progress';

export type OrderStatus =
	| '支払い手続き中'
	| '未決済'
	| '受注生産中'
	| '発送準備中'
	| '配送中'
	| '配達済み'
	| '決済失敗'
	| '放棄'
	| 'キャンセル';

export type OrderLineItem = {
	/** 注文の商品の番号。React の key に使う（同じ商品の色違いが重なるため、名前では区別できない） */
	id: string;
	name: string;
	color: string | null;
	size: string | null;
	quantity: number;
	fulfillmentType: 'stock' | 'backorder';
	/** 発送した数 */
	shipped: number;
	/** 受注生産中の数（まだ仕上がっていない数） */
	inProduction: number;
	/** 発送準備中の数（仕上がっていて、まだ送っていない数） */
	readyUnshipped: number;
};

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	items: OrderLineItem[];
	totalAmount: string;
	/** 注文の言葉（受注生産中・発送準備中・配送中など）。記録から出した物 */
	status: OrderStatus;
	/** DB の注文の状態。件数・絞り込み・CSV の判断はこれを使う（言葉は表示のため） */
	orderStatus?: DbOrderStatus;
	progressKey?: OrderProgressKey;
	/** 発送した数があり、未発送の数も残っている */
	partiallyShipped?: boolean;
	canRefund?: boolean;
	canShip?: boolean;
	/** 受注生産中の数がある決済完了の注文 */
	canRecordCompletion?: boolean;
	missingShippingFields?: string[];
	/** 在庫を確保できなかった入金済みの注文（要確認）。確認済みにするまで印を出す */
	needsReview?: boolean;
	/** 発送できない理由（支払額の違いの要対応）。発送ボタンの代わりに出す */
	shipBlockedReason?: string | null;
	/** 取り消せる未入金の注文（支払い手続き中・入金待ち・失敗） */
	canCancel?: boolean;
	/** 払込票が有効な間は取り消せない。その払込期限（ISO） */
	cancelBlockedUntil?: string | null;
};

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	noticeMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	onShipOrder?: (id: string) => void;
	/** 受注生産の品の仕上がりを記録する画面を開く */
	onRecordCompletion?: (id: string) => void;
	/** 注文の履歴（状態の変化とメール）を開く */
	onShowHistory?: (id: string) => void;
	processingOrderIds?: string[];
}

const STATUS_TONES: Record<OrderStatus, StatusBadgeTone> = {
	支払い手続き中: 'warning',
	未決済: 'warning',
	受注生産中: 'positive',
	発送準備中: 'positive',
	配送中: 'positive',
	配達済み: 'positive',
	決済失敗: 'danger',
	放棄: 'danger',
	キャンセル: 'danger',
};

const STATUS_CLASSES: Record<OrderStatus, string> = {
	支払い手続き中: 'bg-gray-100 text-[#474747]',
	未決済: 'bg-red-100 text-red-800',
	受注生産中: 'bg-blue-100 text-blue-800',
	発送準備中: 'bg-yellow-100 text-yellow-800',
	配送中: 'bg-green-100 text-green-800',
	配達済み: 'bg-green-100 text-green-800',
	決済失敗: 'bg-orange-100 text-orange-800',
	放棄: 'bg-gray-100 text-[#474747]',
	キャンセル: 'bg-gray-100 text-gray-500',
};

function formatDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** 「ブラウス（白 / M）×2（受注生産中 1・発送済み 1）」。括弧の中は0でない数だけ */
function formatOrderLineItem(item: OrderLineItem): string {
	const variant = [item.color, item.size].filter((part): part is string => Boolean(part)).join(' / ');
	const counts = [
		item.inProduction > 0 ? `受注生産中 ${item.inProduction}` : null,
		item.readyUnshipped > 0 ? `発送準備中 ${item.readyUnshipped}` : null,
		item.shipped > 0 ? `発送済み ${item.shipped}` : null,
	].filter((part): part is string => part !== null);
	const name = variant ? `${item.name}（${variant}）` : item.name;
	return counts.length > 0 ? `${name}×${item.quantity}（${counts.join('・')}）` : `${name}×${item.quantity}`;
}

/** 発送待ち（DB の状態が paid）か。受注生産中・発送準備中の言葉がこれにあたる */
function isAwaitingShipment(order: OrderItem): boolean {
	return order.orderStatus ? order.orderStatus === 'paid' : order.status === '受注生産中' || order.status === '発送準備中';
}

export default function OrderSection({
	orders,
	isLoading = false,
	errorMessage = null,
	noticeMessage = null,
	onCancelOrder,
	onRefundOrder,
	onShipOrder,
	onRecordCompletion,
	onShowHistory,
	processingOrderIds = [],
}: OrderSectionProps) {

	if (isLoading) {
		return (
			<section>
				<p className="lk-text-sm text-[#474747] font-acumin">注文一覧を読み込み中です...</p>
			</section>
		);
	}

	return (
		<section>
			{errorMessage ? (
				<p role="alert" className="mb-4 lk-text-sm text-red-700 font-acumin">{errorMessage}</p>
			) : null}
			{noticeMessage ? (
				<p role="status" aria-live="polite" className="mb-4 lk-text-sm text-[#474747] font-acumin">
					{noticeMessage}
				</p>
			) : null}

			<DataTable
				rows={orders}
				rowKey={(order) => order.id}
				emptyLabel="条件に一致する注文はありません"
				columns={[
					{
						key: 'id',
						header: '注文ID',
						render: (order) => <p className="font-medium font-acumin">{order.id}</p>,
					},
					{
						key: 'customer',
						header: '顧客名',
						render: (order) => (
							<div>
								<p className="lk-text-sm text-black font-acumin">{order.customerName}</p>
								<p className="lk-text-3xs text-[#474747] font-acumin">{order.customerEmail}</p>
							</div>
						),
					},
					{ key: 'date', header: '注文日', render: (order) => <p className="text-[#474747] font-acumin">{order.orderDate}</p> },
					{
						key: 'items',
						header: '購入商品',
						render: (order) => (
							<div className="space-y-1">
								{order.items.map((item) => (
									<p key={item.id} className="lk-text-sm text-black font-acumin">
										{formatOrderLineItem(item)}
									</p>
								))}
							</div>
						),
					},
					{ key: 'count', header: '商品数', render: (order) => <p className="font-acumin">{order.itemCount}</p> },
					{ key: 'total', header: '合計金額', render: (order) => <p className="font-acumin">{order.totalAmount}</p> },
					{
						key: 'status',
						header: '決済状況',
						render: (order) => (
							<div className="flex flex-wrap items-center gap-1">
								<StatusBadge tone={STATUS_TONES[order.status]} className={STATUS_CLASSES[order.status]} size="md">
									{order.status}
								</StatusBadge>
								{order.partiallyShipped ? (
									<TagLabel variant="outline" size="2xs">{PARTIALLY_SHIPPED_LABEL}</TagLabel>
								) : null}
								{order.needsReview ? (
									<TagLabel variant="outline" size="2xs">要確認</TagLabel>
								) : null}
							</div>
						),
					},
					{
						key: 'action',
						header: '操作',
						render: (order) => {
							const isProcessing = processingOrderIds.includes(order.id);
							const hasMissingShipping = (order.missingShippingFields?.length ?? 0) > 0;
							const awaitingShipment = isAwaitingShipment(order);

							return (
							<div className="flex flex-wrap items-center gap-2">
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
								{order.canRefund && onRefundOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onRefundOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '返金'}
									</Button>
								) : null}
								{awaitingShipment && order.shipBlockedReason ? (
									<span className="lk-text-xs text-red-700" role="status">{order.shipBlockedReason}</span>
								) : null}
								{awaitingShipment && order.canShip === false && (!order.shipBlockedReason || hasMissingShipping) ? (
									<span className="lk-text-xs text-red-700" role="status">配送先要確認</span>
								) : null}
								{order.canRecordCompletion && onRecordCompletion ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onRecordCompletion(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '仕上がりを記録する'}
									</Button>
								) : null}
								{order.canShip && onShipOrder ? (
									<Button
										variant="primary"
										size="sm"
										className="font-acumin"
										onClick={() => onShipOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '発送済みにする'}
									</Button>
								) : null}
								{order.canCancel && onCancelOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onCancelOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : 'キャンセル'}
									</Button>
								) : null}
								{order.cancelBlockedUntil ? (
									<span className="lk-text-xs text-[#474747]" role="status">
										払込票の期限切れが確定するまで取り消せません（払込期限 {formatDeadline(order.cancelBlockedUntil)}）
									</span>
								) : null}
								{order.status === '未決済' && order.canCancel === false && !order.cancelBlockedUntil ? (
									<span className="lk-text-xs text-[#474747]" role="status">
										支払いの状態を確かめられないため、今は取り消せません
									</span>
								) : null}
							</div>
							);
						},
					},
				]}
			 size="md"/>
		</section>
	);
}
```

Run: `npx jest tests/unit/components/OrderSection.actions.test.tsx --runInBand`
Expected: PASS（26件）

- [ ] **Step 5: 管理画面のつなぎ込みの試験を書き直す**

`AdminOrderHistoryWiring.test.tsx` は、発送の画面を開く → 窓口 `/fulfillments` へ POST → 一覧の読み直し、仕上がりの画面、履歴の取消の後の読み直し、絞り込み（名前と、窓口へ渡す DB の状態）、件数、CSV を確かめる形に書き直す（一覧と画面は本物。窓口の `clientFetch` だけ差し替える）。履歴・送信の停止の帯の元の試験はそのまま残す。`AdminOrderRefundFlow.test.tsx` は見本の言葉だけ直す（`OrderSection` を差し替えて使う試験なので、中身は変わらない）。

`tests/unit/components/AdminOrderHistoryWiring.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、履歴・発送・仕上がりの画面のつなぎ込み（グループ D の Task 7、グループ E-1 の Task 7）。
 * 部品ごとの試験（OrderHistoryDialog・OrderShipDialog・OrderCompletionDialog・OrderSection）では見えない、
 * 管理画面の中での配線を確かめる。一覧と各画面は本物を使い、窓口（clientFetch）だけを差し替える。
 */
const clientFetchMock = jest.fn();
const mockAttention = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=ORDER'),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: 'admin',
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention'
      ? mockAttention(...args)
      : clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const ITEM_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const COAT_ID = 'c1c2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';

const BLOUSE = {
  id: ITEM_ID, name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock',
  shipped: 0, inProduction: 0, readyUnshipped: 1,
};
const COAT_IN_PRODUCTION = {
  id: COAT_ID, name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder',
  shipped: 0, inProduction: 1, readyUnshipped: 0,
};

/** 発送を待つ注文（在庫の品が1つ） */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-09',
    itemCount: '1点',
    items: [BLOUSE],
    totalAmount: '¥28,800',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canShip: true,
    canRecordCompletion: false,
    ...overrides,
  };
}

/** 発送の画面・仕上がりの画面が読む「発送の材料」 */
function materialsBody(lines: unknown[]) {
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', progress: { key: 'ready', label: '発送準備中', partiallyShipped: false } },
    blockedReason: null,
    lines,
    fulfillments: [],
  };
}

const BLOUSE_LINE = {
  orderItemId: ITEM_ID, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 1, shipped: 0, inProduction: 0, readyUnshipped: 1, unshipped: 1,
};
const COAT_LINE = {
  orderItemId: COAT_ID, name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

const historyBody = {
  order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
  sendPaused: null,
  entries: [{ type: 'created', at: '2026-10-09T00:59:00.000Z' }],
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function refused(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: async () => body });
}

/** 管理画面が一覧を読んだ呼び出し（注文一覧の窓口） */
function listRequests() {
  return clientFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/orders?'));
}

/** 窓口（url の終わりが suffix）へ POST した本文。送っていなければ undefined */
function postedBody(suffix: string): Record<string, unknown> | undefined {
  const call = clientFetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST',
  );
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
}

/** 一覧が返す行。窓口を呼んだ後に差し替えて、読み直した結果を再現する */
let orderRows: unknown[] = [];
/** 発送・仕上がり・取消の POST への答え（既定は成功） */
let postAnswer: (url: string) => Promise<unknown> = () => ok({});

describe('管理画面の注文の履歴・発送・仕上がりのつなぎ込み', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    orderRows = [orderRow()];
    postAnswer = (url) => {
      if (url.endsWith('/fulfillments')) {
        return ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false });
      }
      if (url.endsWith('/completions')) return ok({ completionIds: ['completion-1'], replayed: false });
      return ok({ outcome: 'cancelled', orderStatus: 'paid' });
    };
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
      }
      if (target.endsWith('/history')) return ok(historyBody);
      if (target.endsWith('/fulfillments')) return ok(materialsBody([BLOUSE_LINE]));
      return ok({});
    });
  });

  it.each(['送信元のドメインの設定', null])('送信を止めている時は ORDER の帯に原因 %s と再開の案内を出す', async (reasonLabel) => {
    mockAttention.mockImplementation(() => ok({ data: {
      exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 }, emailSending: { paused: true, reasonLabel },
    } }));
    render(<AdminPage />);

    const title = await screen.findByText('お客様への注文のメールの送信を止めています');
    const banner = title.closest('[role="alert"]');
    expect(banner).toHaveAttribute('data-ui-banner-alert-variant', 'error');
    expect(banner).toHaveTextContent(`原因: ${reasonLabel ?? '不明'}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。`);
    expect(await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' })).toBeInTheDocument();
  });

  it.each([
    ['止めていない', { emailSending: { paused: false, reasonLabel: null } }],
    ['値が null', { emailSending: null }],
    ['項目が無い', {}],
  ])('送信状態が %s 時は帯を出さず、注文を読み込める', async (_label, sending) => {
    mockAttention.mockImplementation(() => ok({ data: {
      exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 }, ...sending,
    } }));
    render(<AdminPage />);
    await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });

    expect(screen.queryByText('お客様への注文のメールの送信を止めています')).not.toBeInTheDocument();
    expect(screen.queryByText('要対応・要確認を読み込めませんでした。')).not.toBeInTheDocument();
  });

  it('「履歴」を押すと履歴のダイアログが開き、Escape で閉じると、その「履歴」のボタンへフォーカスが戻る', async () => {
    render(<AdminPage />);
    const historyButton = await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });
    historyButton.focus();
    fireEvent.click(historyButton);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(historyButton).toHaveFocus();
  });

  it('履歴の画面で発送を取り消すと、履歴は開いたまま、一覧を読み直す', async () => {
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      }
      if (target.endsWith('/history')) {
        return ok({
          ...historyBody,
          entries: [
            {
              type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
              trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 1 }], actorEmail: 'admin@example.com',
              notifyCustomer: true, completesOrder: true, cancelled: false, cancellable: true, legacy: false,
            },
          ],
        });
      }
      return ok({});
    });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    expect(listRequests()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(clientFetchMock).toHaveBeenCalledWith(
      `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`,
      { method: 'POST' },
    );
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
  });

  it('発送: 発送の画面が材料を読み、チェックを外すと notifyCustomer=false で発送の窓口へ送り、画面を閉じて、一覧を読み直す', async () => {
    postAnswer = (url) => {
      orderRows = [orderRow({
        status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
        items: [{ ...BLOUSE, shipped: 1, readyUnshipped: 0 }],
      })];
      return url.endsWith('/fulfillments')
        ? ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false })
        : ok({});
    };
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));

    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/fulfillments`, { cache: 'no-store' });
    const checkbox = await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: ' E2E-1 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postedBody('/fulfillments')).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      carrier: 'yamato',
      trackingNumber: 'E2E-1',
      notifyCustomer: false,
      lines: [{ orderItemId: ITEM_ID, quantity: 1 }],
    });
    // 前の状態の窓口（/status）へは送らない。手元で言葉を書き換えず、読み直した一覧の言葉（配送中）を出す
    expect(clientFetchMock.mock.calls.some(([url]) => String(url).endsWith('/status'))).toBe(false);
    expect(await screen.findByText('配送中', { selector: 'span' })).toBeInTheDocument();
    expect(listRequests()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
  });

  it('発送: 既定のままなら notifyCustomer=true で送る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(postedBody('/fulfillments')).toBeDefined());
    expect(postedBody('/fulfillments')).toMatchObject({ carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true });
  });

  it('発送: 追跡番号が不正なら、画面の中に知らせて、送らず、画面は開いたまま', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByLabelText('追跡番号');
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: 'あいう' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(postedBody('/fulfillments')).toBeUndefined();
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
  });

  it('発送: 窓口が断ったら、画面を開いたまま理由を出し、一覧は読み直さない', async () => {
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    postAnswer = () => refused(409, { error: message, code: 'quantity_exceeds_ready' });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByLabelText('追跡番号');
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
    expect(listRequests()).toHaveLength(1);
  });

  it('発送: 「キャンセル」で閉じ、送らない。開き直すと既定（チェックは入っている）に戻る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedBody('/fulfillments')).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: '発送済みにする' }));
    expect(await screen.findByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
  });

  it('仕上がり: 「仕上がりを記録する」で仕上がりの画面を開き、記録すると画面を閉じ、知らせを出して一覧を読み直す', async () => {
    orderRows = [orderRow({
      status: '受注生産中', progressKey: 'in_production', items: [COAT_IN_PRODUCTION], canShip: true, canRecordCompletion: true,
    })];
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      }
      if (target.endsWith('/fulfillments')) return ok(materialsBody([COAT_LINE]));
      return ok({});
    });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '仕上がりを記録する' }));

    const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    const group = await within(dialog).findByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(group).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postedBody('/completions')).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lines: [{ orderItemId: COAT_ID, quantity: 1 }],
    });
    expect(await screen.findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(listRequests()).toHaveLength(2);
  });

  it('一部だけ送った注文には「一部発送済み」の印と、0でない数だけの商品の欄を出す', async () => {
    orderRows = [orderRow({
      status: '受注生産中', progressKey: 'in_production', partiallyShipped: true, itemCount: '3点',
      items: [{ ...BLOUSE, quantity: 2, shipped: 2, readyUnshipped: 0 }, COAT_IN_PRODUCTION],
      canRecordCompletion: true,
    })];
    render(<AdminPage />);

    expect(await screen.findByText('一部発送済み')).toBeInTheDocument();
    expect(screen.getByText('シルクブラウス（白 / M）×2（発送済み 2）')).toBeInTheDocument();
    expect(screen.getByText('ウールコート（黒 / L）×1（受注生産中 1）')).toBeInTheDocument();
  });
});

describe('管理画面の絞り込み・件数・CSV', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    orderRows = [
      orderRow({ id: 'order-paid' }),
      orderRow({ id: 'order-pending', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid', canShip: false }),
      orderRow({ id: 'order-shipped', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
    ];
    clientFetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
      }
      return ok({});
    });
  });

  it('絞り込みは決まった名前で並ぶ', async () => {
    render(<AdminPage />);
    await screen.findByText('order-paid');

    for (const label of [
      'すべて',
      '支払い手続き中',
      '未決済',
      '発送待ち（受注生産中・発送準備中）',
      '発送済み（配送中・配達済み）',
      '決済失敗',
      '放棄',
      'キャンセル',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '決済完了' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送済み' })).not.toBeInTheDocument();
  });

  it.each([
    ['支払い手続き中', 'payment_in_progress'],
    ['未決済', 'pending'],
    ['発送待ち（受注生産中・発送準備中）', 'paid'],
    ['発送済み（配送中・配達済み）', 'shipped'],
    ['決済失敗', 'failed'],
    ['放棄', 'abandoned'],
    ['キャンセル', 'cancelled'],
  ])('絞り込み「%s」を選ぶと、DB の状態 status=%s で窓口へ頼む', async (label, status) => {
    render(<AdminPage />);
    await screen.findByText('order-paid');
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain(`status=${status}`));
  });

  it('2つ選んだ時は status を送らず、DB の状態（orderStatus）で手元の一覧を絞る', async () => {
    render(<AdminPage />);
    await screen.findByText('order-paid');
    fireEvent.click(screen.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）' }));
    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=paid'));
    fireEvent.click(screen.getByRole('button', { name: '未決済' }));

    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).not.toContain('status='));
    await waitFor(() => expect(screen.queryByText('order-shipped')).not.toBeInTheDocument());
    expect(screen.getByText('order-paid')).toBeInTheDocument();
    expect(screen.getByText('order-pending')).toBeInTheDocument();
    expect(screen.getByText(/（表示 2件）/)).toBeInTheDocument();
  });

  it('件数の表示は「未決済」と「発送待ち」。言葉ではなく DB の状態（orderStatus）で数える', async () => {
    orderRows = [
      ...orderRows,
      orderRow({ id: 'order-production', status: '受注生産中', progressKey: 'in_production', items: [COAT_IN_PRODUCTION], canRecordCompletion: true }),
    ];
    render(<AdminPage />);
    await screen.findByText('order-paid');

    expect(screen.getByText('未決済: 1')).toBeInTheDocument();
    // 発送準備中も受注生産中も、DB の状態は決済完了（paid）なので、どちらも発送待ちに数える
    expect(screen.getByText('発送待ち: 2')).toBeInTheDocument();
    expect(screen.queryByText(/決済完了:/)).not.toBeInTheDocument();
  });

  describe('CSV', () => {
    const originalCreateObjectURL = window.URL.createObjectURL;
    const originalRevokeObjectURL = window.URL.revokeObjectURL;

    afterEach(() => {
      window.URL.createObjectURL = originalCreateObjectURL;
      window.URL.revokeObjectURL = originalRevokeObjectURL;
      jest.restoreAllMocks();
    });

    function readBlob(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    }

    it('発送待ち（DB の状態が決済完了）の注文だけを書き出し、商品の欄は発送準備中の数にする', async () => {
      orderRows = [
        orderRow({
          id: 'order-paid',
          status: '受注生産中',
          progressKey: 'in_production',
          items: [{ ...BLOUSE, quantity: 3, shipped: 1, readyUnshipped: 2 }, COAT_IN_PRODUCTION],
        }),
        orderRow({ id: 'order-pending', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid', canShip: false }),
        orderRow({ id: 'order-shipped', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
      ];
      const createObjectURL = jest.fn<string, [Blob]>(() => 'blob:orders');
      window.URL.createObjectURL = createObjectURL;
      window.URL.revokeObjectURL = jest.fn();
      jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      render(<AdminPage />);
      await screen.findByText('order-paid');
      fireEvent.click(screen.getByRole('button', { name: '表示中の注文をCSV出力' }));

      const csv = await readBlob(createObjectURL.mock.calls[0][0]);
      expect(csv).toContain('"order-paid"');
      expect(csv).not.toContain('order-pending');
      expect(csv).not.toContain('order-shipped');
      // 送った品（1つ）と、まだ作っている品（コート）は詰めない
      expect(csv).toContain('"シルクブラウス x2"');
      expect(csv).not.toContain('ウールコート');
      expect(csv).toContain('"受注生産中"');
    });
  });
});
```

`tests/unit/components/AdminOrderRefundFlow.test.tsx` の見本を直す。先にこの置き換えをして、そのあと、ファイルの残りの7か所の `'決済完了'`（`findByText('決済完了')`・`toHaveTextContent('決済完了')`・`orderRequests === 1 ? '決済完了' : 'キャンセル'`）も `'発送準備中'` に置き換える。

`tests/unit/components/AdminOrderRefundFlow.test.tsx`（今の 63 行目から）:

置き換える前:

```tsx
    status: '決済完了',
    canRefund: true,
  }],
```

置き換えた後:

```tsx
    status: '発送準備中',
    orderStatus: 'paid',
    canRefund: true,
  }],
```

Run: `npx jest tests/unit/components/AdminOrderHistoryWiring.test.tsx --runInBand`
Expected: FAIL（足した・直した13件が落ちる。ほかの12件は PASS）

- [ ] **Step 6: 管理画面を直す**

絞り込みの名前と値、窓口へ渡す状態、件数、CSV、発送・仕上がり・履歴の画面のつなぎを直す。`handleShipOrder`（`/status` へ送り、手元で `発送済み` に書き換えていた）は無くなる。

`src/app/admin/page.tsx`（今の 20 行目から）:

置き換える前:

```tsx
import OrderShipDialog, { type OrderShipValues } from '@/components/OrderShipDialog';
```

置き換えた後:

```tsx
import OrderShipDialog from '@/components/OrderShipDialog';
import OrderCompletionDialog from '@/components/OrderCompletionDialog';
```

`src/app/admin/page.tsx`（今の 26 行目から）:

置き換える前:

```tsx
import type { OrderAttention } from '@/lib/orders/order-payment-types';
```

置き換えた後:

```tsx
import { COMPLETION_RECORDED_MESSAGE } from '@/lib/orders/fulfillment/fulfillment-client';
import type { OrderAttention, OrderStatus } from '@/lib/orders/order-payment-types';
```

`src/app/admin/page.tsx`（今の 34 行目から）:

置き換える前:

```tsx
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '支払い手続き中', value: '支払い手続き中' },
  { label: '未決済', value: '未決済' },
  { label: '決済完了', value: '決済完了' },
  { label: '決済失敗', value: '決済失敗' },
  { label: '放棄', value: '放棄' },
  { label: 'キャンセル', value: 'キャンセル' },
  { label: '発送済み', value: '発送済み' },
] as const;
```

置き換えた後:

```tsx
// 絞り込みは DB の状態で行う（段階で絞ると、ページを分けて読む作りが崩れる。設計書 4-4）。value は窓口の status にそのまま送る
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '支払い手続き中', value: 'payment_in_progress' },
  { label: '未決済', value: 'pending' },
  { label: '発送待ち（受注生産中・発送準備中）', value: 'paid' },
  { label: '発送済み（配送中・配達済み）', value: 'shipped' },
  { label: '決済失敗', value: 'failed' },
  { label: '放棄', value: 'abandoned' },
  { label: 'キャンセル', value: 'cancelled' },
] as const satisfies ReadonlyArray<{ label: string; value: 'all' | OrderStatus }>;
```

`src/app/admin/page.tsx`（今の 82 行目から）:

置き換える前:

```tsx
function formatOrderItems(items: OrderItem['items']): string {
  return items.map((item) => `${item.name} x${item.quantity}`).join(' / ');
}
```

置き換えた後:

```tsx
// 発送準備中の数だけ書く。もう送った品と、まだ作っている品を詰めないため（設計書 9-1）
function formatOrderItems(items: OrderItem['items']): string {
  return items
    .filter((item) => item.readyUnshipped > 0)
    .map((item) => `${item.name} x${item.readyUnshipped}`)
    .join(' / ');
}
```

`src/app/admin/page.tsx`（今の 117 行目から）:

置き換える前:

```tsx
  const [shipOrderId, setShipOrderId] = useState<string | null>(null);
```

置き換えた後:

```tsx
  const [shipOrderId, setShipOrderId] = useState<string | null>(null);
  const [completionOrderId, setCompletionOrderId] = useState<string | null>(null);
```

`src/app/admin/page.tsx`（今の 244 行目から）:

置き換える前:

```tsx
      const selectedStatus = orderStatusFilters.length === 1 ? orderStatusFilters[0] : 'all';
      const statusMap: Partial<Record<OrderStatusFilterValue, string>> = {
        '支払い手続き中': 'payment_in_progress',
        '未決済': 'pending',
        '決済完了': 'paid',
        '決済失敗': 'failed',
        '放棄': 'abandoned',
        'キャンセル': 'cancelled',
      };
      const apiStatus = statusMap[selectedStatus];
      if (apiStatus) {
        query.set('status', apiStatus);
      }
```

置き換えた後:

```tsx
      // 2つ以上選んだ時は status を送らず、下の displayedOrders が DB の状態（orderStatus）で絞る
      const selectedStatus = orderStatusFilters.length === 1 ? orderStatusFilters[0] : 'all';
      if (selectedStatus !== 'all') {
        query.set('status', selectedStatus);
      }
```

`src/app/admin/page.tsx`（今の 368 行目から）:

置き換える前:

```tsx
  const pendingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '未決済').length,
    [orders],
  );

  const preparingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '決済完了').length,
    [orders],
  );
```

置き換えた後:

```tsx
  const pendingShipmentCount = useMemo(
    () => orders.filter((order) => order.orderStatus === 'pending').length,
    [orders],
  );

  // 発送待ち＝DB の状態が決済完了（受注生産中・発送準備中。一部を送った注文も含む）
  const awaitingShipmentCount = useMemo(
    () => orders.filter((order) => order.orderStatus === 'paid').length,
    [orders],
  );
```

`src/app/admin/page.tsx`（今の 385 行目から）:

置き換える前:

```tsx
        : orderStatusFilters.some((filter) => filter === order.status);
```

置き換えた後:

```tsx
        : orderStatusFilters.some((filter) => filter === order.orderStatus);
```

`src/app/admin/page.tsx`（今の 405 行目から）:

置き換える前:

```tsx
      if (nextFilter === '放棄') {
        return prev.includes('放棄') ? ['all'] : ['放棄'];
      }

      const nextValues = prev.filter((value) => value !== 'all' && value !== '放棄');
```

置き換えた後:

```tsx
      if (nextFilter === 'abandoned') {
        return prev.includes('abandoned') ? ['all'] : ['abandoned'];
      }

      const nextValues = prev.filter((value) => value !== 'all' && value !== 'abandoned');
```

`src/app/admin/page.tsx`（今の 481 行目から）:

置き換える前:

```tsx
            ? { ...order, status: 'キャンセル', canCancel: false, cancelBlockedUntil: null }
```

置き換えた後:

```tsx
            ? { ...order, status: 'キャンセル', orderStatus: 'cancelled', canCancel: false, cancelBlockedUntil: null }
```

`src/app/admin/page.tsx`（今の 571 行目から）:

置き換える前:

```tsx
  const handleShipOrder = async (values: OrderShipValues) => {
    const id = shipOrderId;
    if (!id) return;

    try {
      setOrdersErrorMessage(null);
      setOrdersNoticeMessage(null);
      updateProcessingOrder(id, true);
      setShipOrderId(null);

      const response = await clientFetch(`/api/admin/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'shipped',
          carrier: values.carrier,
          trackingNumber: values.trackingNumber,
          notifyCustomer: values.notifyCustomer,
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('発送できる状態ではありません。一覧を更新し、決済状態と配送先を確認してください。');
        }
        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }
        throw new Error('発送状態の更新に失敗しました。');
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) => (order.id === id ? { ...order, status: '発送済み' } : order)),
      );
    } catch (error) {
      console.error('Failed to ship order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '発送状態の更新に失敗しました。');
    } finally {
      updateProcessingOrder(id, false);
    }
  };
```

置き換えた後:

```tsx
  const openCompletionDialog = (id: string) => {
    setOrdersNoticeMessage(null);
    setCompletionOrderId(id);
  };

  // 発送・仕上がりの画面は自分で窓口を呼ぶ。成功したら、ここで一覧を読み直す（手元で言葉を書き換えない）。
  // 閉じるのは、その操作の注文の画面だけ（返事を待つ間に別の注文の画面を開いていたら、その画面は閉じない）
  const handleShipped = (id: string) => {
    setShipOrderId((current) => (current === id ? null : current));
    void fetchOrders();
  };

  const handleCompletionRecorded = (id: string) => {
    setCompletionOrderId((current) => (current === id ? null : current));
    setOrdersNoticeMessage(COMPLETION_RECORDED_MESSAGE);
    void fetchOrders();
  };

  // 履歴の画面で発送か仕上がりを取り消した。履歴の画面は開いたまま、一覧だけ読み直す
  const handleFulfillmentChanged = () => {
    void fetchOrders();
  };
```

`src/app/admin/page.tsx`（今の 699 行目から）:

置き換える前:

```tsx
    // only export orders that are in the “決済完了” status
    const filtered = displayedOrders.filter((o) => o.status === '決済完了');
```

置き換えた後:

```tsx
    // 発送待ち（DB の状態が決済完了）の注文だけ書き出す。商品の欄は発送準備中の数（formatOrderItems）
    const filtered = displayedOrders.filter((o) => o.orderStatus === 'paid');
```

`src/app/admin/page.tsx`（今の 971 行目から）:

置き換える前:

```tsx
                  <span className="text-[#474747]">決済完了: {preparingShipmentCount}</span>
```

置き換えた後:

```tsx
                  <span className="text-[#474747]">発送待ち: {awaitingShipmentCount}</span>
```

`src/app/admin/page.tsx`（今の 983 行目から）:

置き換える前:

```tsx
              onShipOrder={openShipDialog}
              onShowHistory={setHistoryOrderId}
```

置き換えた後:

```tsx
              onShipOrder={openShipDialog}
              onRecordCompletion={openCompletionDialog}
              onShowHistory={setHistoryOrderId}
```

`src/app/admin/page.tsx`（今の 987 行目から）:

置き換える前:

```tsx
            <OrderShipDialog
              open={shipOrderId !== null}
              onClose={() => setShipOrderId(null)}
              onSubmit={(values) => void handleShipOrder(values)}
            />
            <OrderHistoryDialog orderId={historyOrderId} onClose={() => setHistoryOrderId(null)} />
```

置き換えた後:

```tsx
            <OrderShipDialog
              orderId={shipOrderId}
              onClose={() => setShipOrderId(null)}
              onShipped={() => {
                if (shipOrderId) handleShipped(shipOrderId);
              }}
            />
            <OrderCompletionDialog
              orderId={completionOrderId}
              onClose={() => setCompletionOrderId(null)}
              onRecorded={() => {
                if (completionOrderId) handleCompletionRecorded(completionOrderId);
              }}
            />
            <OrderHistoryDialog
              orderId={historyOrderId}
              onClose={() => setHistoryOrderId(null)}
              onChanged={handleFulfillmentChanged}
            />
```

Run: `npx jest tests/unit/components/AdminOrderHistoryWiring.test.tsx tests/unit/components/AdminOrderRefundFlow.test.tsx tests/unit/components/AdminOrderSearch.test.tsx --runInBand`
Expected: PASS（`AdminOrderHistoryWiring` 25件・`AdminOrderRefundFlow` 5件・`AdminOrderSearch` 1件）

- [ ] **Step 7: まとめて確かめる**

Run: `npx jest tests/unit/components tests/unit/api/admin --runInBand`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: エラー0件（Task 6 の後に残っていた `src/app/admin/page.tsx` の3か所もここで直る）

Run: `npx eslint src/app/admin/page.tsx src/components/OrderSection.tsx src/app/api/admin/orders/route.ts tests/unit/api/admin/orders-search-route.test.ts tests/unit/components/OrderSection.actions.test.tsx tests/unit/components/AdminOrderHistoryWiring.test.tsx tests/unit/components/AdminOrderRefundFlow.test.tsx`
Expected: エラー0件

Run: `grep -n "決済完了\|発送済み" src/app/admin/page.tsx src/components/OrderSection.tsx src/app/api/admin/orders/route.ts`
Expected: 注文の言葉としては残っていない。出るのは「発送済み（配送中・配達済み）」の絞り込みの名前、`発送済み 数` の商品の欄、`発送済みにする` のボタンの字、コメントだけ。

画面の見え方（390・768・1280）と、本物の DB での発送・仕上がり・取消は Task 10 の E2E が確かめる。発送の DB の関数は本番に無いので、開発サーバーで管理画面から発送を試さない（本番の DB に発送の予定が溜まる）。

- [ ] **Step 8: コミット（controller）**

```bash
git add src/app/api/admin/orders/route.ts src/components/OrderSection.tsx src/app/admin/page.tsx tests/unit/api/admin/orders-search-route.test.ts tests/unit/components/OrderSection.actions.test.tsx tests/unit/components/AdminOrderHistoryWiring.test.tsx tests/unit/components/AdminOrderRefundFlow.test.tsx
git commit -m "feat(admin): 注文の一覧に受注生産中・発送準備中などの言葉と商品ごとの数を出し、発送・仕上がり・履歴の画面をつなぐ（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: お客様の注文の画面

**Files:**
- Modify: `src/app/api/orders/[id]/route.ts:1-204`（ファイル全体。持ち主の確かめの後に、service_role で数と発送を読む。`progress`・`shipments`・商品ごとの数を返し、`shippedAt`・`shippingCarrier`・`trackingNumber` を選ばず返さない）
- Modify: `src/app/api/orders/route.ts:6,65-83,97-173`（一覧の言葉を `deriveOrderProgress` から出す。`mapStatusLabel` を消す）
- Modify: `src/app/account/orders/[id]/page.tsx:9-22,32-47,124,187-250`（進み具合の段・状態の言葉・一部発送済みの印・発送ごとの配送情報・発送準備中と受注生産中の商品）
- Modify: `src/lib/orders/order-status.ts:1,19-37`（`ORDER_PROGRESS_STEPS`・`resolveOrderProgressIndex` を消す。`formatOrderStatus` は残す）
- 変えない（確かめるだけ）: `src/app/account/page.tsx:1191`（一覧は窓口の言葉をそのまま出す。`formatOrderStatus` は日本語の言葉を言い換えない）
- Test（新規）: `tests/unit/api/orders/order-detail-progress.test.ts`・`tests/unit/api/orders/orders-list-progress.test.ts`・`tests/unit/components/AccountOrderDetailPage.test.tsx`・`tests/unit/lib/orders/order-status.test.ts`
- Test（直す）: `tests/integration/api/orders.test.ts:46-48,93-101,117,209-231,242-258`（service_role の client に `rpc` を足し、言葉と新しい答えの形に合わせる）
- Test（変えずに通ること）: `tests/unit/api/orders/orders-hidden-statuses.test.ts`

**Interfaces:**
- Consumes:
  - Task 3 の `src/lib/orders/order-progress.ts`: `deriveOrderProgress`・`buildOrderProgressSteps`・`PARTIALLY_SHIPPED_LABEL`・`ORDER_PROGRESS_LABELS`・型 `OrderProgressKey`・`OrderProgressStep`
  - Task 3 の `src/lib/orders/fulfillment/fulfillment-store.ts`: `listOrderLineFulfillment(store, orderIds)`・`listOrderFulfillments(store, orderId)`・型 `OrderLineFulfillmentRow`・`OrderFulfillmentHistoryRow`（中の DB の関数 `public.list_order_line_fulfillment`・`public.list_order_fulfillments` は Task 1 の移行 A）
  - 既存の `createServiceRoleClient`・`SHIPPING_CARRIERS`・`isShippingCarrierId`・`toOrderNumber`・`HIDDEN_ORDER_STATUS_FILTER`・`signItemImageUrl`
- Produces:
  - `GET /api/orders/[id]` の答え: `status`（DB の値のまま）・`progress: { key, label, partiallyShipped, steps }`・`shipments`・`items` の各行に `shippedQuantity`・`readyQuantity`・`inProductionQuantity`。`shippedAt`・`shippingCarrier`・`trackingNumber` は返さない（共通の約束のとおり）
  - `GET /api/orders` の一覧の `status`: `deriveOrderProgress` の言葉（`受注生産中`・`発送準備中`・`配送中`・`未決済`・`決済失敗`・`キャンセル` など）
  - お客様の注文の画面: 配送ステータスの段（`<ol aria-label="配送ステータス">`）・状態の言葉と `一部発送済み` の印・発送ごとの区切り `配送情報（{n}回目）`・見出し `発送準備中の商品`・`受注生産中の商品`

決め事（本計画 P7・P8 の続き。共通の約束の型は変えない）:
- T8-1: 商品ごとの `readyQuantity`・`inProductionQuantity` は、注文が `paid` か `shipped` の時だけ数を返し、それ以外（未決済・決済失敗・キャンセル）は 0 にする。未入金の注文の品を「発送準備中の商品」「受注生産中の商品」と見せないため。`shippedQuantity` はいつも数える
- T8-2: `shipments` は取り消していない発送だけを、1回目から古い順に返す（DB の関数は新しい順に返すので、窓口で並べ直す）
- T8-3: 発送日は、窓口が時刻（ISO）のまま返し、画面が日本時間の日付（`2026/10/06`）にする
- T8-4: `shipments` と商品の行に、操作した管理者のメール・メールを送ったか・全部送ったか・前からの記録かは入れない（お客様に見せる物だけを名指しで返す）

Review Focus 5（前からの発送済みの注文）のお客様の窓口の確かめ: 移行で写した発送の記録は配送業者・伝票番号が空のことがある。Step 2 と Step 5 の「前からの発送の記録で配送業者・伝票番号が空でも…」の試験が、窓口も画面も落ちず、発送日と商品は出し、リンクは出さないことを固める。

注意:
- この窓口は新しい DB の関数を呼ぶ。移行 A を当てていない DB（本番の DB につないだ普段の開発サーバー）で `/account` の注文の一覧・詳細を開くと、移行 A を当てるまで失敗する。手元の Supabase（`npx supabase db reset` の後）なら動く。画面の見た目は Task 10 の `FR-ACCOUNT-032`（3つの画面幅）で確かめる
- 今の E2E のうち、注文の詳細の窓口を古い形で差し替えている `FR-ACCOUNT-005`・`013`・`015`・`016`・`017`・`018`・`019`・`020`・`031` は、この Task の後は Task 10 で直すまで通らない（この Task では流さない）
- Task 3 の `fulfillment-store.ts` には `import 'server-only'` を付けない。付けると、この窓口を本物の部品のまま読み込む今の試験（`orders-hidden-statuses.test.ts`・`tests/integration/api/orders.test.ts`）が読み込みで落ちる（この repo の注文の部品 `src/lib/orders/**` は、どれも `server-only` を使っていない）

- [ ] **Step 1: 注文の言葉の部品の試験を書く**

一覧の画面（`src/app/account/page.tsx`）は、窓口が返した日本語の言葉を `formatOrderStatus` に通して出す。新しい言葉が言い換えられずに出ることを固める。この試験は今の動きを固めるもので、最初から PASS する（Step 6 の FAIL の一覧には入らない）。

`tests/unit/lib/orders/order-status.test.ts`（新規）:

```ts
import { ORDER_PROGRESS_LABELS } from '@/lib/orders/order-progress';
import { formatOrderStatus } from '@/lib/orders/order-status';

describe('formatOrderStatus', () => {
  // お客様の一覧の窓口は日本語の言葉をそのまま返す。ここで言い換えると、管理画面や注文の画面と言葉が食い違う
  it.each(Object.values(ORDER_PROGRESS_LABELS))('窓口が返す言葉「%s」はそのまま出る', (label) => {
    expect(formatOrderStatus(label)).toBe(label);
  });

  it('英語の状態の値は日本語にし、知らない値はそのまま返す（今のまま）', () => {
    expect(formatOrderStatus('shipped')).toBe('発送済み');
    expect(formatOrderStatus('cancelled')).toBe('キャンセル');
    expect(formatOrderStatus('unknown-status')).toBe('unknown-status');
  });
});
```

- [ ] **Step 2: 詳細の窓口の試験を書く**

`tests/unit/api/orders/order-detail-progress.test.ts`（新規）。数と発送の読み方は Task 3 の部品を差し替え、窓口が「持ち主の確かめの後にだけ」「どの client で」読み、答えをどう組み立てるかを確かめる。言葉と段は本物の `order-progress.ts` を使う。

```ts
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      }),
    },
  };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn().mockResolvedValue({ ok: true, claims: { sub: 'user-1' } }),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_client: unknown, url: string | null) => url),
}));

// 持ち主の確かめ（お客様の権限の client）。ここで見つからなければ 404
const mockOwnerQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  not: jest.fn(),
  maybeSingle: jest.fn(),
};
const mockServiceClient = { from: jest.fn() };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => mockOwnerQuery })),
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

const mockListLines = jest.fn();
const mockListFulfillments = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({
  listOrderLineFulfillment: (...args: unknown[]) => mockListLines(...args),
  listOrderFulfillments: (...args: unknown[]) => mockListFulfillments(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/orders/[id]/route';

type Json = Record<string, any>;
type RouteResponse = { status: number; body: Json; headers: Record<string, string> };

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

async function getDetail(): Promise<RouteResponse> {
  const response = await GET(new NextRequest(`http://localhost/api/orders/${ORDER_ID}`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
  return response as unknown as RouteResponse;
}

const STOCK_ITEM = {
  id: 'line-stock', item_id: 10, variant_id: 101, item_name: 'リネンシャツ', item_image_url: null,
  color: '白', size: 'M', quantity: 2, line_total: 24000,
};
const MADE_ITEM = {
  id: 'line-made', item_id: 11, variant_id: 111, item_name: 'ウールコート', item_image_url: null,
  color: '黒', size: 'L', quantity: 1, line_total: 58000,
};

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID, created_at: '2026-10-01T00:00:00.000Z', status: 'paid', payment_intent_id: null,
    subtotal_amount: 82000, shipping_amount: 0, discount_amount: 0, total_amount: 82000, currency: 'jpy',
    shipping_full_name: '山田 花子', shipping_email: 'hanako@example.com', shipping_postal_code: '1500001',
    shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-2-3', shipping_building: null,
    shipping_phone: '090-1111-2222',
    order_items: [STOCK_ITEM, MADE_ITEM],
    ...overrides,
  };
}

// 在庫の品2点が発送準備中
function stockLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-stock', variantId: 101, fulfillmentType: 'stock', quantity: 2,
    shipped: 0, completed: 2, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides,
  };
}

// 受注生産の品1点が作っている途中
function madeLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-made', variantId: 111, fulfillmentType: 'backorder', quantity: 1,
    shipped: 0, completed: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1, ...overrides,
  };
}

function fulfillment(overrides: Record<string, unknown> = {}) {
  return {
    fulfillmentId: 'ful-1', number: 1, shippingCarrier: 'yamato', trackingNumber: '1234-5678-9012',
    notifyCustomer: true, completesOrder: false, shippedAt: '2026-10-05T15:30:00.000Z',
    createdByEmail: 'admin@example.com', cancelledAt: null, cancelledByEmail: null, legacy: false,
    lines: [{ orderItemId: 'line-stock', quantity: 2 }], ...overrides,
  };
}

function setup(options: { order?: unknown; lines?: unknown[]; fulfillments?: unknown[] } = {}) {
  const { order = orderRow(), lines = [stockLine(), madeLine()], fulfillments = [] } = options;
  mockOwnerQuery.maybeSingle.mockResolvedValue({ data: order, error: null });
  mockListLines.mockResolvedValue(new Map([[ORDER_ID, lines]]));
  mockListFulfillments.mockResolvedValue(fulfillments);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnerQuery.select.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.eq.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.not.mockReturnValue(mockOwnerQuery);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
});

describe('GET /api/orders/[id] の発送と進み具合（グループ E-1）', () => {
  it('持ち主の確かめを通った注文だけ、同じ service_role の client で数と発送を読む', async () => {
    setup();

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(mockOwnerQuery.eq).toHaveBeenCalledWith('id', ORDER_ID);
    expect(mockOwnerQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockListLines).toHaveBeenCalledWith(mockServiceClient, [ORDER_ID]);
    expect(mockListFulfillments).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
  });

  it('他のお客様の注文（持ち主の確かめで見つからない）は 404 で、service_role を使わない', async () => {
    setup({ order: null });

    const response = await getDetail();

    expect(response.status).toBe(404);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockListLines).not.toHaveBeenCalled();
    expect(mockListFulfillments).not.toHaveBeenCalled();
  });

  it('持ち主の確かめの読み取りが失敗したら 500 で、service_role を使わない', async () => {
    setup();
    mockOwnerQuery.maybeSingle.mockResolvedValue({ data: null, error: { message: 'down' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('入金済みで受注生産の品がまだ仕上がっていない注文は「受注生産中」で、5段', async () => {
    setup();

    const { body } = await getDetail();

    expect(body.status).toBe('paid');
    expect(body.progress).toEqual({
      key: 'in_production',
      label: '受注生産中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'in_production', label: '受注生産中', state: 'current' },
        { key: 'ready', label: '発送準備中', state: 'todo' },
        { key: 'in_transit', label: '配送中', state: 'todo' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('在庫の品を先に送った注文は、受注生産中のまま「一部発送済み」', async () => {
    setup({
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 }), madeLine()],
      fulfillments: [fulfillment()],
    });

    const { body } = await getDetail();

    expect(body.progress).toMatchObject({ key: 'in_production', label: '受注生産中', partiallyShipped: true });
  });

  it('在庫の品だけの注文は4段で、発送の前は「発送準備中」', async () => {
    setup({ order: orderRow({ order_items: [STOCK_ITEM] }), lines: [stockLine()] });

    const { body } = await getDetail();

    expect(body.progress).toEqual({
      key: 'ready',
      label: '発送準備中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'ready', label: '発送準備中', state: 'current' },
        { key: 'in_transit', label: '配送中', state: 'todo' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('全部を送った注文（発送済み）は「配送中」で、発送準備中までが済んだ段になる', async () => {
    setup({
      order: orderRow({ status: 'shipped', order_items: [STOCK_ITEM] }),
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 })],
      fulfillments: [fulfillment({ completesOrder: true })],
    });

    const { body } = await getDetail();

    expect(body.status).toBe('shipped');
    expect(body.progress).toEqual({
      key: 'in_transit',
      label: '配送中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'ready', label: '発送準備中', state: 'done' },
        { key: 'in_transit', label: '配送中', state: 'current' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('未決済の注文は「未決済」でお支払いの段が今の段。品を発送準備中や受注生産中として出さない（T8-1）', async () => {
    setup({ order: orderRow({ status: 'pending' }) });

    const { body } = await getDetail();

    expect(body.progress.label).toBe('未決済');
    expect(body.progress.steps[0]).toEqual({ key: 'payment', label: 'お支払い', state: 'current' });
    expect(body.items.map((item: Json) => [item.readyQuantity, item.inProductionQuantity])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('キャンセルの注文は段を出さず、言葉だけ返す', async () => {
    setup({ order: orderRow({ status: 'cancelled' }) });

    const { body } = await getDetail();

    expect(body.progress).toEqual({ key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null });
  });

  it('商品ごとに、発送した数・発送準備中の数・受注生産中の数を返す', async () => {
    setup({ lines: [stockLine({ shipped: 1, readyUnshipped: 1, unshipped: 1 }), madeLine()] });

    const { body } = await getDetail();

    expect(body.items).toEqual([
      expect.objectContaining({ id: 'line-stock', shippedQuantity: 1, readyQuantity: 1, inProductionQuantity: 0 }),
      expect.objectContaining({ id: 'line-made', shippedQuantity: 0, readyQuantity: 0, inProductionQuantity: 1 }),
    ]);
  });

  it('発送は取り消していない分だけを、1回目から順に、その発送の商品つきで返す（T8-2）', async () => {
    setup({
      fulfillments: [
        fulfillment({ fulfillmentId: 'ful-3', number: 3, cancelledAt: '2026-10-07T00:00:00.000Z', cancelledByEmail: 'admin@example.com' }),
        fulfillment({
          fulfillmentId: 'ful-2', number: 2, shippingCarrier: 'sagawa', trackingNumber: 'AB-123',
          shippedAt: '2026-10-20T00:00:00.000Z', lines: [{ orderItemId: 'line-made', quantity: 1 }],
        }),
        fulfillment(),
      ],
    });

    const { body } = await getDetail();

    expect(body.shipments.map((shipment: Json) => shipment.number)).toEqual([1, 2]);
    expect(body.shipments[0]).toEqual({
      id: 'ful-1',
      number: 1,
      shippedAt: '2026-10-05T15:30:00.000Z',
      carrier: 'yamato',
      carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678-9012',
      trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
      items: [{ orderItemId: 'line-stock', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
    });
    expect(body.shipments[1]).toMatchObject({
      id: 'ful-2',
      carrierLabel: '佐川急便',
      trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
      items: [{ orderItemId: 'line-made', name: 'ウールコート', color: '黒', size: 'L', quantity: 1 }],
    });
  });

  it('前からの発送の記録で配送業者・伝票番号が空でも落ちず、発送日と商品は返し、リンクは返さない', async () => {
    setup({ fulfillments: [fulfillment({ legacy: true, shippingCarrier: null, trackingNumber: null })] });

    const { status, body } = await getDetail();

    expect(status).toBe(200);
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0]).toMatchObject({
      carrier: null,
      carrierLabel: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: '2026-10-05T15:30:00.000Z',
      items: [{ orderItemId: 'line-stock', quantity: 2 }],
    });
  });

  it('知らない配送業者の記号は、名前とリンクを空にして返す', async () => {
    setup({ fulfillments: [fulfillment({ shippingCarrier: 'newcarrier' })] });

    const { body } = await getDetail();

    expect(body.shipments[0]).toMatchObject({
      carrier: 'newcarrier',
      carrierLabel: null,
      trackingNumber: '1234-5678-9012',
      trackingUrl: null,
    });
  });

  it('操作した管理者のメールなど内側の情報は、お客様に返さない（T8-4）', async () => {
    setup({ fulfillments: [fulfillment()] });

    const { body } = await getDetail();

    expect(JSON.stringify(body)).not.toContain('admin@example.com');
    expect(Object.keys(body.shipments[0]).sort()).toEqual([
      'carrier', 'carrierLabel', 'id', 'items', 'number', 'shippedAt', 'trackingNumber', 'trackingUrl',
    ]);
  });

  it('注文の行の配送の列は読まず、返さない（発送ごとの shipments に置き換えた）', async () => {
    setup();

    const { body } = await getDetail();

    expect(body).not.toHaveProperty('shippedAt');
    expect(body).not.toHaveProperty('shippingCarrier');
    expect(body).not.toHaveProperty('trackingNumber');
    expect(String(mockOwnerQuery.select.mock.calls[0][0])).not.toMatch(/shipped_at|shipping_carrier|tracking_number/);
  });

  it('今の項目（注文番号・金額・配送先）はそのまま返す', async () => {
    setup();

    const { body } = await getDetail();

    expect(body).toMatchObject({
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      shippingFullName: '山田 花子',
      shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
    });
  });

  it('数や発送の読み取りが失敗したら 500（no-store）で、中身を返さない', async () => {
    setup();
    mockListFulfillments.mockRejectedValue(new Error('rpc failed'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch order detail' });
    consoleError.mockRestore();
  });
});
```

- [ ] **Step 3: 一覧の窓口の試験を書く**

`tests/unit/api/orders/orders-list-progress.test.ts`（新規）:

```ts
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      }),
    },
  };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn().mockResolvedValue({ ok: true, claims: { sub: 'user-1' } }),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_client: unknown, url: string | null) => url),
}));

// お客様の権限の client が読む注文の一覧
const mockOrdersQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  not: jest.fn(),
  order: jest.fn(),
};
const mockServiceClient = { from: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => mockOrdersQuery })),
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockListLines = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({
  listOrderLineFulfillment: (...args: unknown[]) => mockListLines(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/orders/route';

type Json = Record<string, any>;
type RouteResponse = { status: number; body: Json; headers: Record<string, string> };

async function getList(): Promise<RouteResponse> {
  return (await GET(new NextRequest('http://localhost/api/orders'))) as unknown as RouteResponse;
}

function orderRow(id: string, status: string) {
  return {
    id, created_at: '2026-10-01T00:00:00.000Z', status, total_amount: 12000, currency: 'jpy',
    shipping_full_name: '山田 花子', shipping_email: 'hanako@example.com', shipping_phone: '090-1111-2222',
    shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区',
    shipping_address: '神宮前1-2-3', shipping_building: null,
    order_items: [
      { id: `${id}-line`, item_id: 10, item_name: 'リネンシャツ', item_image_url: null, color: '白', size: 'M', quantity: 1, line_total: 12000 },
    ],
  };
}

// 在庫の品1点が発送準備中
function line(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    orderId, orderItemId: `${orderId}-line`, variantId: 101, fulfillmentType: 'stock', quantity: 1,
    shipped: 0, completed: 1, inProduction: 0, readyUnshipped: 1, unshipped: 1, ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersQuery.select.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.eq.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.not.mockReturnValue(mockOrdersQuery);
});

describe('GET /api/orders の言葉（グループ E-1）', () => {
  it('一覧の言葉は、商品の数から出した注文の言葉にする。数は一覧の全部の注文を1回で読む', async () => {
    mockOrdersQuery.order.mockResolvedValue({
      data: [
        orderRow('order-made', 'paid'),
        orderRow('order-ready', 'paid'),
        orderRow('order-sent', 'shipped'),
        orderRow('order-partial', 'paid'),
        orderRow('order-pending', 'pending'),
        orderRow('order-failed', 'failed'),
        orderRow('order-cancelled', 'cancelled'),
      ],
      error: null,
    });
    mockListLines.mockResolvedValue(
      new Map([
        ['order-made', [line('order-made', { fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 })]],
        ['order-ready', [line('order-ready')]],
        ['order-sent', [line('order-sent', { shipped: 1, readyUnshipped: 0, unshipped: 0 })]],
        // 在庫の品は送り、受注生産の品はまだ作っている
        [
          'order-partial',
          [
            line('order-partial', { shipped: 1, readyUnshipped: 0, unshipped: 0 }),
            line('order-partial', { orderItemId: 'order-partial-line-2', fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 }),
          ],
        ],
        ['order-pending', [line('order-pending')]],
      ]),
    );

    const { status, body } = await getList();

    expect(status).toBe(200);
    expect(mockOrdersQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(body.data.map((order: Json) => order.status)).toEqual([
      '受注生産中',
      '発送準備中',
      '配送中',
      '受注生産中',
      '未決済',
      '決済失敗',
      'キャンセル',
    ]);
    expect(mockListLines).toHaveBeenCalledTimes(1);
    expect(mockListLines).toHaveBeenCalledWith(mockServiceClient, [
      'order-made', 'order-ready', 'order-sent', 'order-partial', 'order-pending', 'order-failed', 'order-cancelled',
    ]);
  });

  it('一覧は言葉だけを返す（一部発送済みの印は注文の画面で出す）', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-partial', 'paid')], error: null });
    mockListLines.mockResolvedValue(
      new Map([[
        'order-partial',
        [
          line('order-partial', { shipped: 1, readyUnshipped: 0, unshipped: 0 }),
          line('order-partial', { orderItemId: 'order-partial-line-2', fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 }),
        ],
      ]]),
    );

    const { body } = await getList();

    expect(body.data[0].status).toBe('受注生産中');
    expect(body.data[0]).not.toHaveProperty('partiallyShipped');
  });

  it('数の読み取りが失敗したら 500（no-store）', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-1', 'paid')], error: null });
    mockListLines.mockRejectedValue(new Error('rpc failed'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch orders' });
    consoleError.mockRestore();
  });

  it('一覧の読み取りが失敗したら 500 で、数を読まない', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: null, error: { message: 'down' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(mockListLines).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
```

- [ ] **Step 4: 今の窓口の試験（`tests/integration/api/orders.test.ts`）を新しい形に直す**

この試験は Supabase をモックして窓口を呼ぶ（DB は要らない）。窓口が service_role の `rpc` で数と発送を読むようになるので、モックに `rpc` を足し、言葉と答えの形を直す。数の行の形は Task 1 の `list_order_line_fulfillment` の返す列（C-1）に合わせる。

(a) 先頭の `const { createClient, createServiceRoleClient } = require(...)` などの `require` の並び（46〜48行）の直後に足す:

```ts
// private.order_line_fulfillment の1行（在庫の品1点が仕上がり済みで未発送 = 発送準備中）
const READY_LINE_ROW = {
	order_id: 'order-1',
	order_item_id: 'line-1',
	variant_id: 5,
	fulfillment_type: 'stock',
	quantity: 1,
	shipped: 0,
	completed: 1,
	in_production: 0,
	ready_unshipped: 1,
	unshipped: 1,
};
```

(b) `describe('GET /api/orders', ...)` の最初の試験にある、service_role の client を作る部分（93〜101行）

```ts
		createServiceRoleClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				in: jest.fn().mockResolvedValue({
					data: [{ id: 10, stock_quantity: 5 }],
					error: null,
				}),
			}),
		});
```

を次に置き換える（一覧の窓口は表を直接読まず、DB の関数で数を読む）:

```ts
		const rpc = jest.fn().mockResolvedValue({ data: [READY_LINE_ROW], error: null });
		createServiceRoleClient.mockResolvedValue({ rpc });
```

同じ試験の期待値の `status: '決済完了',`（117行）を `status: '発送準備中',` に直し、`expect(body).toEqual({...});` の閉じの直後に足す:

```ts
		expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-1'] });
```

(c) `describe('GET /api/orders/[id]', ...)` の最初の試験にある、service_role の client を作る部分（209〜231行）の終わり

```ts
					return {
						select: jest.fn().mockReturnThis(),
						in: jest.fn().mockResolvedValue({
							data: [{ id: 10, stock_quantity: 5 }],
							error: null,
						}),
					};
				}),
			});
```

を次に置き換える（`from` の閉じの後に `rpc` を足しただけ）:

```ts
					return {
						select: jest.fn().mockReturnThis(),
						in: jest.fn().mockResolvedValue({
							data: [{ id: 10, stock_quantity: 5 }],
							error: null,
						}),
					};
				}),
				rpc: jest.fn().mockImplementation(async (name: string) => ({
					data: name === 'list_order_line_fulfillment' ? [READY_LINE_ROW] : [],
					error: null,
				})),
			});
```

(d) 同じ試験の `expect(body).toMatchObject({...});`（242〜258行）を次に置き換える:

```ts
		expect(body).toMatchObject({
			id: 'order-1',
			orderNumber: 'ORD-ORDER-1',
			orderDate: '2026/04/01 09:00',
			status: 'paid',
			progress: {
				key: 'ready',
				label: '発送準備中',
				partiallyShipped: false,
				steps: [
					{ key: 'payment', label: 'お支払い', state: 'done' },
					{ key: 'ready', label: '発送準備中', state: 'current' },
					{ key: 'in_transit', label: '配送中', state: 'todo' },
					{ key: 'delivered', label: '配達済み', state: 'todo' },
				],
			},
			shipments: [],
			subtotalAmount: expect.stringMatching(/^[¥￥]12,000$/),
			shippingAmount: expect.stringMatching(/^[¥￥]500$/),
			discountAmount: expect.stringMatching(/^-[¥￥]1,000$/),
			totalAmount: expect.stringMatching(/^[¥￥]11,500$/),
			paymentMethod: 'クレジットカード',
			items: [
				expect.objectContaining({
					id: 'line-1',
					itemId: 10,
					shippedQuantity: 0,
					readyQuantity: 1,
					inProductionQuantity: 0,
				}),
			],
		});
		expect(body).not.toHaveProperty('shippedAt');
		expect(body).not.toHaveProperty('shippingCarrier');
		expect(body).not.toHaveProperty('trackingNumber');
```

- [ ] **Step 5: お客様の注文の画面の試験を書く**

`tests/unit/components/AccountOrderDetailPage.test.tsx`（新規）。窓口の答え（`progress`・`shipments`・商品ごとの数）を差し替えて、画面が段・言葉・印・発送ごとの配送情報・商品の欄を出すことを確かめる。

```tsx
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import AccountOrderDetailPage from '@/app/account/orders/[id]/page';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'order-1' }) }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true }),
}));
jest.mock('@/features/account/hooks/useReorder', () => ({
  useReorder: () => ({ reorderingItemId: null, reorder: jest.fn() }),
}));
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}));

const STEPS_READY = [
  { key: 'payment', label: 'お支払い', state: 'done' },
  { key: 'ready', label: '発送準備中', state: 'current' },
  { key: 'in_transit', label: '配送中', state: 'todo' },
  { key: 'delivered', label: '配達済み', state: 'todo' },
];

const STEPS_IN_PRODUCTION = [
  { key: 'payment', label: 'お支払い', state: 'done' },
  { key: 'in_production', label: '受注生産中', state: 'current' },
  { key: 'ready', label: '発送準備中', state: 'todo' },
  { key: 'in_transit', label: '配送中', state: 'todo' },
  { key: 'delivered', label: '配達済み', state: 'todo' },
];

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1', itemId: 10, variantId: 101, name: 'リネンシャツ', imageUrl: null, color: '白', size: 'M',
    quantity: 2, amount: '¥24,000', shippedQuantity: 0, readyQuantity: 0, inProductionQuantity: 0, ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'ORD-0001', orderDate: '2026/10/01 09:00', status: 'paid',
    progress: { key: 'ready', label: '発送準備中', partiallyShipped: false, steps: STEPS_READY },
    subtotalAmount: '¥24,000', shippingAmount: '¥0', discountAmount: '¥0', totalAmount: '¥24,000',
    paymentMethod: 'クレジットカード', shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
    shipments: [], items: [item({ readyQuantity: 2 })], ...overrides,
  };
}

async function renderPage(body: unknown) {
  mockClientFetch.mockResolvedValue({ ok: true, json: async () => body });
  render(<AccountOrderDetailPage />);
  await screen.findByText('ORD-0001');
}

function stepItems() {
  return within(screen.getByRole('list', { name: '配送ステータス' })).getAllByRole('listitem');
}

describe('お客様の注文の画面（グループ E-1）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('在庫の品だけの注文は4段で、今の段に aria-current が付き、済んだ段だけ塗る。状態の言葉も出る', async () => {
    await renderPage(order());

    const steps = stepItems();
    expect(steps).toHaveLength(4);
    ['お支払い', '発送準備中', '配送中', '配達済み'].forEach((label, index) => {
      expect(steps[index]).toHaveTextContent(label);
    });
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(within(steps[0]).getByText('お支払い')).toHaveClass('text-black');
    expect(within(steps[1]).getByText('発送準備中')).toHaveClass('text-black');
    expect(within(steps[2]).getByText('配送中')).toHaveClass('text-[#999]');
    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('発送準備中');
    expect(screen.queryByText('一部発送済み')).not.toBeInTheDocument();
  });

  it('受注生産の品を含む注文は5段で、一部発送済みの印と、受注生産中の商品を出す', async () => {
    await renderPage(
      order({
        progress: { key: 'in_production', label: '受注生産中', partiallyShipped: true, steps: STEPS_IN_PRODUCTION },
        items: [
          item({ shippedQuantity: 2 }),
          item({ id: 'line-2', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, inProductionQuantity: 1 }),
        ],
      }),
    );

    expect(stepItems()).toHaveLength(5);
    const status = screen.getByTestId('order-progress-status');
    expect(status).toHaveTextContent('受注生産中');
    expect(status).toHaveTextContent('一部発送済み');
    expect(screen.getByRole('region', { name: '受注生産中の商品' })).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(screen.queryByRole('region', { name: '発送準備中の商品' })).not.toBeInTheDocument();
  });

  it('発送準備中の商品・受注生産中の商品には、その数が1以上の商品だけを並べる', async () => {
    await renderPage(
      order({
        items: [
          item({ id: 'a', name: 'リネンシャツ', quantity: 3, shippedQuantity: 1, readyQuantity: 2 }),
          item({ id: 'b', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, inProductionQuantity: 1 }),
          item({ id: 'c', name: 'シルクスカーフ', color: null, size: null, quantity: 1, shippedQuantity: 1 }),
        ],
      }),
    );

    const ready = screen.getByRole('region', { name: '発送準備中の商品' });
    expect(ready).toHaveTextContent('リネンシャツ（白 / M） × 2');
    expect(ready).not.toHaveTextContent('ウールコート');
    expect(ready).not.toHaveTextContent('シルクスカーフ');
    const inProduction = screen.getByRole('region', { name: '受注生産中の商品' });
    expect(inProduction).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(inProduction).not.toHaveTextContent('リネンシャツ');
  });

  it('発送準備中も受注生産中も無い注文には、その見出しを出さない', async () => {
    await renderPage(order({ items: [item({ shippedQuantity: 2 })] }));

    expect(screen.queryByRole('region', { name: '発送準備中の商品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '受注生産中の商品' })).not.toBeInTheDocument();
  });

  it('キャンセルの注文は進み具合の段を出さず、言葉だけ出す', async () => {
    await renderPage(
      order({
        status: 'cancelled',
        progress: { key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null },
        items: [item()],
      }),
    );

    expect(screen.queryByRole('list', { name: '配送ステータス' })).not.toBeInTheDocument();
    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('キャンセル');
  });

  it('発送ごとに「配送情報（n回目）」を出し、発送日・配送業者・追跡番号・リンク・その発送の商品を並べる', async () => {
    await renderPage(
      order({
        status: 'shipped',
        progress: {
          key: 'in_transit',
          label: '配送中',
          partiallyShipped: false,
          steps: [
            { key: 'payment', label: 'お支払い', state: 'done' },
            { key: 'ready', label: '発送準備中', state: 'done' },
            { key: 'in_transit', label: '配送中', state: 'current' },
            { key: 'delivered', label: '配達済み', state: 'todo' },
          ],
        },
        shipments: [
          {
            id: 'f1', number: 1, shippedAt: '2026-10-05T15:30:00.000Z', carrier: 'yamato', carrierLabel: 'ヤマト運輸',
            trackingNumber: '1234-5678-9012',
            trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
            items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
          },
          {
            id: 'f2', number: 2, shippedAt: '2026-10-20T00:00:00.000Z', carrier: 'sagawa', carrierLabel: '佐川急便',
            trackingNumber: 'AB-123',
            trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
            items: [{ orderItemId: 'line-2', name: 'ウールコート', color: '黒', size: 'L', quantity: 1 }],
          },
        ],
        items: [item({ shippedQuantity: 2 })],
      }),
    );

    const first = screen.getByRole('region', { name: '配送情報（1回目）' });
    // 15:30（UTC）は日本時間の翌日 0:30 なので、発送日は 10/06
    expect(first).toHaveTextContent('2026/10/06');
    expect(first).toHaveTextContent('ヤマト運輸');
    expect(first).toHaveTextContent('1234-5678-9012');
    expect(first).toHaveTextContent('リネンシャツ（白 / M） × 2');
    const firstLink = within(first).getByRole('link', { name: '配送状況を確認する' });
    expect(firstLink).toHaveAttribute('href', 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012');
    expect(firstLink).toHaveAttribute('target', '_blank');
    expect(firstLink).toHaveAttribute('rel', 'noopener noreferrer');

    const second = screen.getByRole('region', { name: '配送情報（2回目）' });
    expect(second).toHaveTextContent('2026/10/20');
    expect(second).toHaveTextContent('佐川急便');
    expect(second).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(second).not.toHaveTextContent('リネンシャツ');
    expect(within(second).getByRole('link', { name: '配送状況を確認する' })).toHaveAttribute(
      'href',
      'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
    );
  });

  it('発送が無い注文には配送情報を出さない', async () => {
    await renderPage(order());

    expect(screen.queryAllByRole('region', { name: /配送情報/ })).toHaveLength(0);
  });

  it('前からの発送の記録で配送業者・追跡番号が空でも、発送日と商品は出し、リンクは出さない', async () => {
    await renderPage(
      order({
        status: 'shipped',
        shipments: [
          {
            id: 'f1', number: 1, shippedAt: '2026-08-05T00:00:00.000Z', carrier: null, carrierLabel: null,
            trackingNumber: null, trackingUrl: null,
            items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
          },
        ],
        items: [item({ shippedQuantity: 2 })],
      }),
    );

    const section = screen.getByRole('region', { name: '配送情報（1回目）' });
    expect(section).toHaveTextContent('2026/08/05');
    expect(section).toHaveTextContent('リネンシャツ（白 / M） × 2');
    expect(section).not.toHaveTextContent('配送業者');
    expect(section).not.toHaveTextContent('追跡番号');
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 試験が失敗することを確かめる**

Run: `npx jest tests/unit/api/orders tests/unit/components/AccountOrderDetailPage.test.tsx tests/integration/api/orders.test.ts --runInBand`
Expected: FAIL（まだ窓口も画面も直していない）
- `order-detail-progress`: `progress` が `undefined`（`Received: undefined`）、`mockListLines` が呼ばれていない
- `orders-list-progress`: 一覧の言葉が `決済完了` など今の言葉のまま
- `AccountOrderDetailPage`: 配送ステータスの段が今の4段（`支払い完了`・`受注`・`発送`・`配達`）で、`order-progress-status` が見つからない
- `tests/integration/api/orders`: 一覧の言葉が `決済完了`、詳細に `progress` が無い
- `orders-hidden-statuses` は変えていないので PASS のまま

Run: `npx jest tests/unit/lib/orders/order-status.test.ts --runInBand`
Expected: PASS（今の動きを固める試験なので、最初から通る）

- [ ] **Step 7: 詳細の窓口を直す**

`src/app/api/orders/[id]/route.ts` を次の内容にする（持ち主の確かめ・支払方法・金額の組み立ては今のまま。変えたのは、import、`OrderDetailRow` から配送の3列を外したこと、`STAGE_VISIBLE_STATUSES` と `toShipments`、select から配送の3列を外したこと、service_role で数と発送を読むこと、答えの組み立て。service_role の client の変数名は、署名付き URL・支払方法だけでなく発送の読み取りにも使うので `signSupabase` から `serviceSupabase` に直した）:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { toOrderNumber } from '@/lib/orders/order-number';
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
import { buildOrderProgressSteps, deriveOrderProgress } from '@/lib/orders/order-progress';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
	listOrderFulfillments,
	listOrderLineFulfillment,
	type OrderFulfillmentHistoryRow,
	type OrderLineFulfillmentRow,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';

const NO_STORE_HEADERS = {
	'Cache-Control': 'no-store',
};

type OrderItemRow = {
	id: string;
	item_id: number | null;
	// 再注文でカートに入れるバリアント。バリアントの番号を持たない古い明細は null
	variant_id: number | null;
	item_name: string;
	item_image_url: string | null;
	color: string | null;
	size: string | null;
	quantity: number;
	line_total: number;
};

type OrderDetailRow = {
	id: string;
	created_at: string;
	status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
	payment_intent_id: string | null;
	subtotal_amount: number;
	shipping_amount: number;
	discount_amount: number;
	total_amount: number;
	currency: string;
	shipping_full_name: string | null;
	shipping_email: string | null;
	shipping_postal_code: string | null;
	shipping_prefecture: string | null;
	shipping_city: string | null;
	shipping_address: string | null;
	shipping_building: string | null;
	shipping_phone: string | null;
	order_items: OrderItemRow[] | null;
};

// 商品の段階（発送準備中・受注生産中）は、入金後の注文にだけ出す。未入金・失敗・キャンセルの注文の品を「発送準備中」と見せないため
const STAGE_VISIBLE_STATUSES: ReadonlyArray<OrderDetailRow['status']> = ['paid', 'shipped'];

function formatCurrency(amount: number, currency: string) {
	try {
		return new Intl.NumberFormat('ja-JP', {
			style: 'currency',
			currency: currency.toUpperCase(),
			maximumFractionDigits: 0,
		}).format(amount);
	} catch {
		return `¥${amount.toLocaleString('ja-JP')}`;
	}
}

// 注文詳細は日付に加えて時刻（日本時間）も表示する
function formatOrderDateTime(dateText: string) {
	const date = new Date(dateText);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}

	return new Intl.DateTimeFormat('ja-JP', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Asia/Tokyo',
	}).format(date);
}

function toShippingAddress(order: OrderDetailRow) {
	return [
		order.shipping_postal_code ? `〒${order.shipping_postal_code}` : '',
		order.shipping_prefecture ?? '',
		order.shipping_city ?? '',
		order.shipping_address ?? '',
		order.shipping_building ?? '',
	]
		.filter(Boolean)
		.join(' ')
		.trim();
}

/**
 * お客様に見せる発送。取り消していない分だけを、1回目から古い順に返す。
 * 操作した管理者のメールなど内側の情報は、名指しで選んだ項目以外は渡さない。
 * 前からの記録で配送業者・伝票番号が空でも、知らない配送業者の記号でも、落とさずに空で返す。
 */
function toShipments(fulfillments: readonly OrderFulfillmentHistoryRow[], items: readonly OrderItemRow[]) {
	const itemById = new Map<string, OrderItemRow>(items.map((item) => [item.id, item]));

	return fulfillments
		.filter((fulfillment) => fulfillment.cancelledAt === null)
		.sort((a, b) => a.number - b.number)
		.map((fulfillment) => {
			const carrier = isShippingCarrierId(fulfillment.shippingCarrier)
				? SHIPPING_CARRIERS[fulfillment.shippingCarrier]
				: null;

			return {
				id: fulfillment.fulfillmentId,
				number: fulfillment.number,
				shippedAt: fulfillment.shippedAt,
				carrier: fulfillment.shippingCarrier,
				carrierLabel: carrier?.label ?? null,
				trackingNumber: fulfillment.trackingNumber,
				trackingUrl:
					carrier && fulfillment.trackingNumber ? carrier.trackingUrl(fulfillment.trackingNumber) : null,
				items: fulfillment.lines.flatMap((line) => {
					const item = itemById.get(line.orderItemId);
					return item
						? [{ orderItemId: item.id, name: item.item_name, color: item.color, size: item.size, quantity: line.quantity }]
						: [];
				}),
			};
		});
}

export async function GET(
	request: NextRequest,
	context: { params: Promise<{ id: string }> },
) {
	const { id } = await context.params;
	const supabase = await createClient(request);
	const auth = await authenticateRequest(request);

	if (!auth.ok) {
		console.warn('Order detail auth error:', auth.reason);
		return authFailureResponse(auth.reason, NO_STORE_HEADERS);
	}

	const userId = auth.claims.sub;

	const { data, error } = await supabase
		.from('orders')
		.select(`
			id,
			created_at,
			status,
			payment_intent_id,
			subtotal_amount,
			shipping_amount,
			discount_amount,
			total_amount,
			currency,
			shipping_full_name,
			shipping_email,
			shipping_postal_code,
			shipping_prefecture,
			shipping_city,
			shipping_address,
			shipping_building,
			shipping_phone,
			order_items (
				id,
				item_id,
				variant_id,
				item_name,
				item_image_url,
				color,
				size,
				quantity,
				line_total
			)
		`)
		.eq('id', id)
		.eq('user_id', userId)
		// メールで知らせた注文だけを見せる（支払い手続き中・放棄は出さない。設計書 5-5）
		.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
		.maybeSingle<OrderDetailRow>();

	if (error) {
		console.error('Order detail fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	if (!data) {
		return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE_HEADERS });
	}

	// ここから先は持ち主の確かめを通った注文だけ。発送と数の新しい表はお客様から直接読めないので service_role で読む
	const serviceSupabase = await createServiceRoleClient();

	let lineRows: OrderLineFulfillmentRow[];
	let fulfillments: OrderFulfillmentHistoryRow[];
	try {
		const [lineRowsByOrder, fulfillmentRows] = await Promise.all([
			listOrderLineFulfillment(serviceSupabase, [data.id]),
			listOrderFulfillments(serviceSupabase, data.id),
		]);
		lineRows = lineRowsByOrder.get(data.id) ?? [];
		fulfillments = fulfillmentRows;
	} catch (fulfillmentError) {
		console.error('Order fulfillment fetch error:', fulfillmentError);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const progress = deriveOrderProgress(data.status, lineRows);
	const lineByItemId = new Map<string, OrderLineFulfillmentRow>(lineRows.map((row) => [row.orderItemId, row]));
	const showStages = STAGE_VISIBLE_STATUSES.includes(data.status);

	// 支払方法（checkout_drafts に注文確定時の payment_intent_id が書き戻されている）
	let paymentMethod: string | null = null;
	if (data.payment_intent_id) {
		const { data: draftRow } = await serviceSupabase
			.from('checkout_drafts')
			.select('payment_method')
			.eq('payment_intent_id', data.payment_intent_id)
			.limit(1)
			.maybeSingle<{ payment_method: string }>();
		paymentMethod = draftRow?.payment_method ?? null;
	}

	return NextResponse.json({
		id: data.id,
		orderNumber: toOrderNumber(data.id),
		orderDate: formatOrderDateTime(data.created_at),
		// DB の状態の値。画面の言葉と段は progress を使う
		status: data.status,
		progress: { ...progress, steps: buildOrderProgressSteps(progress, lineRows) },
		subtotalAmount: formatCurrency(data.subtotal_amount, data.currency),
		shippingAmount: formatCurrency(data.shipping_amount, data.currency),
		discountAmount:
			data.discount_amount > 0
				? `-${formatCurrency(data.discount_amount, data.currency)}`
				: formatCurrency(0, data.currency),
		totalAmount: formatCurrency(data.total_amount, data.currency),
		paymentMethod: mapPaymentMethodLabel(paymentMethod),
		shippingFullName: data.shipping_full_name ?? '',
		shippingEmail: data.shipping_email ?? '',
		shippingPhone: data.shipping_phone ?? '',
		shippingAddress: toShippingAddress(data),
		shipments: toShipments(fulfillments, data.order_items ?? []),
		items: await Promise.all((data.order_items ?? []).map(async (item) => {
			const line = lineByItemId.get(item.id);
			return {
				id: item.id,
				itemId: item.item_id,
				variantId: item.variant_id ?? null,
				name: item.item_name,
				imageUrl: await signItemImageUrl(serviceSupabase, item.item_image_url),
				color: item.color,
				size: item.size,
				quantity: item.quantity,
				amount: formatCurrency(item.line_total, data.currency),
				shippedQuantity: line?.shipped ?? 0,
				readyQuantity: showStages ? (line?.readyUnshipped ?? 0) : 0,
				inProductionQuantity: showStages ? (line?.inProduction ?? 0) : 0,
			};
		})),
	}, { headers: NO_STORE_HEADERS });
}
```

- [ ] **Step 8: 一覧の窓口を直す**

`src/app/api/orders/route.ts`:

(a) import に足す（`HIDDEN_ORDER_STATUS_FILTER` の import の次の行）:

```ts
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
```

(b) `mapStatusLabel` の関数（`function mapStatusLabel(status: OrderRow['status']) {` から閉じの `}` まで、65〜83行）を、まるごと消す。

(c) `export async function GET(request: NextRequest) {` から最後までを、次に置き換える（変えたのは、`const signSupabase` の前後の「数を読む」部分、`status` の出し方、client の変数名 `signSupabase` → `serviceSupabase`）:

```ts
export async function GET(request: NextRequest) {
	const supabase = await createClient(request);
	const auth = await authenticateRequest(request);

	if (!auth.ok) {
		console.warn('Orders auth error:', auth.reason);
		return authFailureResponse(auth.reason, NO_STORE_HEADERS);
	}

	const userId = auth.claims.sub;

	const { data, error } = await supabase
		.from('orders')
		.select(`
			id,
			created_at,
			status,
			total_amount,
			currency,
			shipping_full_name,
			shipping_email,
			shipping_phone,
			shipping_postal_code,
			shipping_prefecture,
			shipping_city,
			shipping_address,
			shipping_building,
			order_items (
				id,
				item_id,
				item_name,
				item_image_url,
				color,
				size,
				quantity,
				line_total
			)
		`)
		.eq('user_id', userId)
		// メールで知らせた注文だけを見せる（支払い手続き中・放棄は出さない。設計書 5-5）
		.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
		.order('created_at', { ascending: false });

	if (error) {
		console.error('Orders fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const orders = (data ?? []) as OrderRow[];
	const serviceSupabase = await createServiceRoleClient();

	// 一覧の言葉は商品の数から出す。新しい表はお客様から直接読めないので、持ち主の確かめを通った一覧の分を service_role で1回で読む
	let lineRowsByOrder: Map<string, OrderLineFulfillmentRow[]>;
	try {
		lineRowsByOrder = await listOrderLineFulfillment(serviceSupabase, orders.map((order) => order.id));
	} catch (fulfillmentError) {
		console.error('Orders fulfillment fetch error:', fulfillmentError);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const response = await Promise.all(orders.map(async (order) => ({
		id: order.id,
		orderNumber: toOrderNumber(order.id),
		orderDate: formatOrderDate(order.created_at),
		status: deriveOrderProgress(order.status, lineRowsByOrder.get(order.id) ?? []).label,
		totalAmount: formatCurrency(order.total_amount, order.currency),
		itemCount: (order.order_items ?? []).reduce((sum, item) => sum + item.quantity, 0),
		shippingFullName: order.shipping_full_name ?? '',
		shippingEmail: order.shipping_email ?? '',
		shippingPhone: order.shipping_phone ?? '',
		shippingAddress: formatShippingAddress(order),
		items: await Promise.all((order.order_items ?? []).map(async (item) => ({
			id: item.id,
			itemId: item.item_id,
			name: item.item_name,
			imageUrl: await signItemImageUrl(serviceSupabase, item.item_image_url),
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, order.currency),
		}))),
		detailHref: `/account/orders/${order.id}`,
	})));

	return NextResponse.json({ data: response }, { headers: NO_STORE_HEADERS });
}
```

`tests/unit/api/orders/orders-hidden-statuses.test.ts` の一覧の試験は、注文が 0 件で `listOrderLineFulfillment` が空の一覧を受け取る（Task 3 の部品は空なら呼ばずに空を返す）ので、`rpc` の無い service_role のモックのままで通る。

- [ ] **Step 9: 使わなくなった物を注文の言葉の部品から消す**

`src/lib/orders/order-status.ts` を次の内容にする（`ORDER_PROGRESS_STEPS` と `resolveOrderProgressIndex` を消し、先頭のコメントを今の使い方に合わせた。`formatOrderStatus` は一覧の画面が使うので残す）:

```ts
// 注文ステータスの表示ユーティリティ（購入履歴の一覧で使う）。
// 注文の言葉と進み具合の段は order-progress.ts が出す

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'お支払い待ち',
  paid: '支払い完了',
  processing: '処理中',
  preparing: '発送準備中',
  shipped: '発送済み',
  delivered: '配達完了',
  completed: '完了',
  cancelled: 'キャンセル',
  canceled: 'キャンセル',
  refunded: '返金済み',
};

export function formatOrderStatus(status: string): string {
  return ORDER_STATUS_LABELS[status?.toLowerCase?.() ?? ''] ?? status;
}
```

今の `ORDER_PROGRESS_STEPS`・`resolveOrderProgressIndex` の単体試験は無い（`tests` の中を探して確かめ済み）ので、消す試験も無い。

- [ ] **Step 10: お客様の注文の画面を直す**

`src/app/account/orders/[id]/page.tsx` を4か所直す。

(a) import: `ORDER_PROGRESS_STEPS`・`resolveOrderProgressIndex` の import（9〜12行）を次に置き換え、配送業者の import（`SHIPPING_CARRIERS`・`isShippingCarrierId`。19〜22行）を消す（配送業者の名前とリンクは窓口が返す）。

```tsx
import {
  PARTIALLY_SHIPPED_LABEL,
  type OrderProgressKey,
  type OrderProgressStep,
} from "@/lib/orders/order-progress";
```

(b) 型: `type OrderDetail = {…};`（32〜47行）を次に置き換え、その直後に2つの関数を足す。

```tsx
type OrderDetailItem = OrderLineItem & {
  /** 発送した数 */
  shippedQuantity: number;
  /** 発送準備中の数（入金後の注文だけ。窓口が数える） */
  readyQuantity: number;
  /** 受注生産中の数（入金後の注文だけ。窓口が数える） */
  inProductionQuantity: number;
};

type OrderShipment = {
  id: string;
  number: number;
  shippedAt: string;
  carrier: string | null;
  carrierLabel: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: Array<{
    orderItemId: string;
    name: string;
    color: string | null;
    size: string | null;
    quantity: number;
  }>;
};

type OrderDetail = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  progress: {
    key: OrderProgressKey;
    label: string;
    partiallyShipped: boolean;
    steps: OrderProgressStep[] | null;
  };
  subtotalAmount: string;
  shippingAmount: string;
  discountAmount: string;
  totalAmount: string;
  paymentMethod: string;
  shippingAddress: string;
  items: OrderDetailItem[];
  shipments: OrderShipment[];
};

/** 発送日は日本時間の日付で出す（窓口は時刻のまま返す） */
function formatShippedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

/** 「名前（色 / サイズ）」の形。色もサイズも無い古い明細は名前だけ */
function describeItem(
  name: string,
  color: string | null | undefined,
  size: string | null | undefined,
): string {
  const variant = [color, size].filter(Boolean).join(" / ");
  return variant ? `${name}（${variant}）` : name;
}
```

(c) `const progressIndex = order ? resolveOrderProgressIndex(order.status) : -1;`（124行）を次に置き換える。

```tsx
  // 数は入金後の注文にだけ窓口が返す（未入金・キャンセルの注文の品は 0）
  const readyItems = order?.items.filter((item) => item.readyQuantity > 0) ?? [];
  const inProductionItems =
    order?.items.filter((item) => item.inProductionQuantity > 0) ?? [];
```

(d) 注文番号・注文日時の `<div className="grid gap-4 sm:grid-cols-2">…</div>` と、閉じの `</section>` の間にある2つのブロック、つまり `{order.shippingCarrier &&` で始まる配送情報のブロック（187〜213行）と `{/* OD-4: 進捗の視覚化（受注→発送→配達） */}` で始まる進捗のブロック（215〜250行）を、まるごと次の内容に置き換える（`<ol>` の中の丸数字・ラベルの見た目は今のまま。済んだ段と今の段を塗る）。

```tsx
            {/* 状態の言葉。支払い手続き中・放棄の注文は窓口が返さない（お客様には出さない） */}
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="order-progress-status"
            >
              <span className="account-status">{order.progress.label}</span>
              {order.progress.partiallyShipped ? (
                <span className="account-status account-status-sm">
                  {PARTIALLY_SHIPPED_LABEL}
                </span>
              ) : null}
            </div>

            {/* OD-4: 進捗の視覚化。段は窓口が記録から決める（在庫の品だけなら4段、受注生産の品を含むなら5段） */}
            {order.progress.steps ? (
              // sm 未満はラベルを丸数字の下に置いて折返しを防ぐ（結線は丸数字の中心高さに合わせる）
              <ol
                className="flex items-start sm:items-center gap-1.5 sm:gap-2 pt-2"
                aria-label="配送ステータス"
              >
                {order.progress.steps.map((step, index, steps) => {
                  // 済んだ段と今の段は塗り、結線は済んだ段の後ろだけ塗る
                  const filled = step.state !== "todo";
                  return (
                    <React.Fragment key={step.key}>
                      <li
                        aria-current={step.state === "current" ? "step" : undefined}
                        className="flex flex-col items-center gap-1 sm:flex-row sm:gap-2"
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-6 w-6 items-center justify-center rounded-full border lk-text-6xs ${filled ? "border-black bg-black text-white" : "border-black/25 text-[#999]"}`}
                        >
                          {index + 1}
                        </span>
                        <span
                          className={`whitespace-nowrap ${filled ? "text-black" : "text-[#999]"}`}
                          style={labelStyle}
                        >
                          {step.label}
                        </span>
                      </li>
                      {index < steps.length - 1 ? (
                        <li
                          aria-hidden="true"
                          className={`h-px flex-1 mt-3 sm:mt-0 ${step.state === "done" ? "bg-black" : "bg-black/15"}`}
                        />
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ol>
            ) : null}

            {/* 配送情報は発送ごとに出す。取り消した発送は窓口が返さない */}
            {order.shipments.map((shipment) => (
              <section
                key={shipment.id}
                aria-label={`配送情報（${shipment.number}回目）`}
                className="mt-6"
              >
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  {`配送情報（${shipment.number}回目）`}
                </h2>
                <dl className="space-y-1 lk-text-sm">
                  <div className="flex gap-2">
                    <dt className="text-[#707070]">発送日</dt>
                    <dd className="tabular-nums">
                      {formatShippedDate(shipment.shippedAt)}
                    </dd>
                  </div>
                  {shipment.carrierLabel ? (
                    <div className="flex gap-2">
                      <dt className="text-[#707070]">配送業者</dt>
                      <dd>{shipment.carrierLabel}</dd>
                    </div>
                  ) : null}
                  {shipment.trackingNumber ? (
                    <div className="flex gap-2">
                      <dt className="text-[#707070]">追跡番号</dt>
                      <dd className="tabular-nums">{shipment.trackingNumber}</dd>
                    </div>
                  ) : null}
                </dl>
                {shipment.trackingUrl ? (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block lk-text-sm underline"
                  >
                    配送状況を確認する
                  </a>
                ) : null}
                <ul className="mt-2 space-y-1 lk-text-sm">
                  {shipment.items.map((line) => (
                    <li key={line.orderItemId}>
                      {`${describeItem(line.name, line.color, line.size)} × ${line.quantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {readyItems.length > 0 ? (
              <section aria-label="発送準備中の商品" className="mt-6">
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  発送準備中の商品
                </h2>
                <ul className="space-y-1 lk-text-sm">
                  {readyItems.map((item) => (
                    <li key={item.id}>
                      {`${describeItem(item.name, item.color, item.size)} × ${item.readyQuantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {inProductionItems.length > 0 ? (
              <section aria-label="受注生産中の商品" className="mt-6">
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  受注生産中の商品
                </h2>
                <ul className="space-y-1 lk-text-sm">
                  {inProductionItems.map((item) => (
                    <li key={item.id}>
                      {`${describeItem(item.name, item.color, item.size)} × ${item.inProductionQuantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
```

ほかの部分（配送先情報・支払方法・ご注文商品・支払金額・問い合わせのボタン）は変えない。

- [ ] **Step 11: 試験が通ること、ほかに直す所が無いことを確かめる**

Run: `npx jest tests/unit/api/orders tests/unit/lib/orders/order-status.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/integration/api/orders.test.ts --runInBand`
Expected: PASS（`orders-hidden-statuses.test.ts` も、書き換えずに通る）

Run: `npx tsc --noEmit` と `npm run lint`
Expected: エラー0件

Run: `git grep -n "resolveOrderProgressIndex\|ORDER_PROGRESS_STEPS" -- src tests e2e`
Expected: 出力なし（使う所がもう無い）

Run: `git grep -n "shippingCarrier\|order\.trackingNumber\|order\.shippedAt" -- src/app/account`
Expected: 出力なし（注文の行の配送の3項目は `shipments` に置き換えた。`shipment.trackingNumber` などは残る）

Run: `git diff --stat -- src/app/account/page.tsx`
Expected: 出力なし（一覧の画面は変えていない。窓口の日本語の言葉を `formatOrderStatus` が言い換えずに出すことは、Step 1 の試験が固めている）

- [ ] **Step 12: コミット（controller）**

```bash
git add "src/app/api/orders/[id]/route.ts" src/app/api/orders/route.ts "src/app/account/orders/[id]/page.tsx" src/lib/orders/order-status.ts tests/unit/api/orders/order-detail-progress.test.ts tests/unit/api/orders/orders-list-progress.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/unit/lib/orders/order-status.test.ts tests/integration/api/orders.test.ts
git commit -m "$(cat <<'EOF'
feat(account): お客様の注文の画面に進み具合の段と発送ごとの配送情報を出す（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 在庫の画面

**Files:**
- Modify: `src/app/api/admin/items/[id]/variants/route.ts:5,31-38,40-123`（GET だけ。今の `variant_backorder_summary` と `stock_movements` の読み取りを、DB の関数 `list_variant_stock_states`・`list_item_stock_history` に替える。POST は変えない）
- Modify: `src/app/admin/item/ItemStockSection.tsx:8-17,19-45,174-177,229-239,305-318`（色・サイズごとに4つの数、説明を1回、履歴に変わった後の数・記録した人・注文番号）
- Test（直す）: `tests/unit/api/admin/item-variants-route.test.ts:47-188`（GET の読み取り元を新しい関数に替える。POST の試験は変えない）
- Test（新規）: `tests/unit/components/ItemStockSection.test.tsx`
- Test（直す）: `e2e/FR-ADMIN-058-item-variant-stock.spec.ts:14-31,80-86,101-112`（窓口の答えの形を差し替えている所だけ。流すのは controller）

**Interfaces:**
- Consumes:
  - Task 1 の移行 A の DB の関数: `public.list_variant_stock_states(_variant_ids bigint[])`（返す列 `variant_id`・`committed`・`backorder`。渡した番号ごとに1行）と `public.list_item_stock_history(_item_id bigint, _limit integer)`（返す列 `movement_id`・`variant_id`・`delta`・`reason`・`note`・`created_at`・`actor_email`・`order_id`・`balance_after`。新しい順）
  - 既存の `toOrderNumber`・`authorizeAdminPermission`・`createServiceRoleClient`・`clientFetch`
- Produces:
  - `GET /api/admin/items/[id]/variants` の答え（共通の約束のとおり）: `variants: [{ id, colorName, colorHex, sizeLabel, sku, stockQuantity, isActive, committedQuantity, onHandQuantity, backorderQuantity }]`、`movements: [{ id, variantId, delta, reason, note, createdAt, actorEmail, orderId, orderNumber, balanceAfter }]`。`onHandQuantity = stockQuantity + committedQuantity`。以前の `variant_id`・`created_at` の形（`snake_case`）は返さない
  - 在庫の画面: 色・サイズごとに `すぐ出せる数`・`引き当て済み`・`手元の数`・`受注生産`、説明の1行、履歴の各行に日時・理由・増減・`変わった後 {n}`・記録した人（空なら `自動`）・注文番号（ある時だけ）・備考
  - 画面の `data-testid`: `variant-stock`（すぐ出せる数。今のまま）・`variant-committed`・`variant-on-hand`・`variant-backorder`（今のまま）・`stock-terms-explanation`・`stock-movement-row`（今のまま）・`stock-movement-time`・`stock-movement-variant`・`stock-movement-reason`・`stock-movement-delta`・`stock-movement-balance`・`stock-movement-actor`・`stock-movement-order`・`stock-movement-note`

決め事（共通の約束の型は変えない）:
- T9-1: 引き当て済み・受注生産の数か履歴が読めなければ 500 を返す。今は `variant_backorder_summary` と `stock_movements` の読み取りの失敗を無視して 0 や空に見せているが、引き当て済みを 0 と見せると製造と仕入れの判断を誤るため、新しい読み取りは失敗を隠さない。メッセージは今の `Failed to fetch item variants` と同じ英語（`Failed to fetch variant stock states`・`Failed to fetch stock history`）
- T9-2: 履歴の各行に、その色・サイズの名前（`BLACK / M`）を足す（共通の約束の列に無い画面だけの追加）。`変わった後` の数は色・サイズごとの数で、履歴は商品全体の最新50件なので、どの色・サイズの数か分からないと読めない。名前は画面が持っている `variants` から引き、窓口の答えは増やさない
- T9-3: 4つの言葉の説明は、画面の上に1回だけ書く（設計書 10-1）。色・サイズごとの行には書かない
- T9-4: バリアントが1つも無い商品は、数も履歴も DB の関数を呼ばずに空で返す（今も履歴を読まない）

注意: この窓口は新しい DB の関数を呼ぶ。移行 A を当てていない DB（本番の DB につないだ普段の開発サーバー）で商品の編集画面（`/admin/item/edit/[id]`）の在庫の欄を開くと、移行 A を当てるまで「在庫の取得に失敗しました」が出る。手元の Supabase（`npx supabase db reset` の後）なら動く。画面の見た目（3つの画面幅）は Task 10 の `FR-ADMIN-073` で確かめる。`FR-ADMIN-058` は設計書 14 章の「合わせて直す今の E2E」の一覧に無いが、窓口の答えの形を差し替えているので、この Task で直す（Step 6）。

- [ ] **Step 1: 窓口の試験を直す**

`tests/unit/api/admin/item-variants-route.test.ts` の、47行目のコメント `/** item_variants / stock_movements / variant_backorder_summary の読み取りを組み立てる。 */` から、`describe('GET /api/admin/items/[id]/variants', ...)` の閉じ（188行目の `});`）までを、次にまるごと置き換える（`describe('POST ...')` から後ろ、ファイルの先頭から46行目までは変えない）。読み取り元は `item_variants` だけにし、`from` がほかの表を読もうとしたら落ちる形にして、古い読み取りが残っていないことも確かめる。

```ts
/** バリアントの行（色・サイズつき）。 */
function variantRow(id: number, stockQuantity: number) {
  return {
    id,
    stock_quantity: stockQuantity,
    is_active: true,
    sku: null,
    item_colors: { name: 'BLACK', hex: '#000000', position: 0 },
    item_sizes: { label: id === 11 ? 'M' : 'L', position: id === 11 ? 1 : 2 },
  };
}

/** item_variants の読み取りと、DB の関数（引き当て・受注生産・在庫の履歴）の答えを組み立てる。 */
function setupReads(options: {
  variants?: unknown[];
  variantsError?: { message: string } | null;
  states?: unknown[];
  statesError?: { message: string } | null;
  history?: unknown[];
  historyError?: { message: string } | null;
} = {}) {
  const {
    variants = [variantRow(11, 4)],
    variantsError = null,
    states = [{ variant_id: 11, committed: 3, backorder: 2 }],
    statesError = null,
    history = [
      {
        movement_id: 5,
        variant_id: 11,
        delta: 4,
        reason: 'restock',
        note: '入荷',
        created_at: '2026-09-21T00:00:00Z',
        actor_email: 'admin@example.com',
        order_id: null,
        balance_after: 4,
      },
    ],
    historyError = null,
  } = options;

  // 台帳や view は直接読まない。item_variants 以外を読もうとすると、from が空の物を返して落ちる
  mockFrom.mockImplementation((table: string) => {
    if (table === 'item_variants') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: variants, error: variantsError }),
          }),
        }),
      };
    }

    return {};
  });

  mockRpc.mockImplementation(async (name: string) => {
    if (name === 'list_variant_stock_states') {
      return { data: statesError ? null : states, error: statesError };
    }
    if (name === 'list_item_stock_history') {
      return { data: historyError ? null : history, error: historyError };
    }
    // backfill_item_variants
    return { data: null, error: null };
  });
}

type GetResponse = {
  status: number;
  body: { variants: Array<Record<string, unknown>>; movements: Array<Record<string, unknown>> };
};

async function callGet(): Promise<GetResponse> {
  return (await GET(makeRequest(), params())) as unknown as GetResponse;
}

describe('GET /api/admin/items/[id]/variants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
    setupReads();
  });

  it('admin.items.read を要求する', async () => {
    await GET(makeRequest(), params());

    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.read', expect.anything());
  });

  it('権限が無ければ認可側の応答をそのまま返す', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = (await GET(makeRequest(), params())) as unknown as { status: number };

    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  /**
   * 商品の色・サイズはバリアントとは別のテーブルにある。読む前にそろえないと、
   * 管理画面で色を足した直後に在庫を入れる先が無い（FREQ-399）。
   */
  it('読む前にバリアントをそろえる', async () => {
    await GET(makeRequest(), params());

    expect(mockRpc).toHaveBeenCalledWith('backfill_item_variants', { target_item_id: 7 });
  });

  it('色・サイズと4つの数を返す。手元の数は、すぐ出せる数に引き当て済みを足した数', async () => {
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([
      {
        id: 11,
        colorName: 'BLACK',
        colorHex: '#000000',
        sizeLabel: 'M',
        sku: null,
        stockQuantity: 4,
        isActive: true,
        committedQuantity: 3,
        onHandQuantity: 7,
        backorderQuantity: 2,
      },
    ]);
  });

  it('バリアントごとに自分の引き当て済み・受注生産を結び付け、番号を全部まとめて DB の関数に渡す', async () => {
    setupReads({
      variants: [variantRow(11, 4), variantRow(12, 0)],
      states: [
        { variant_id: 12, committed: 1, backorder: 5 },
        { variant_id: 11, committed: 3, backorder: 2 },
      ],
    });

    const res = await callGet();

    expect(mockRpc).toHaveBeenCalledWith('list_variant_stock_states', { _variant_ids: [11, 12] });
    expect(res.body.variants).toEqual([
      expect.objectContaining({ id: 11, committedQuantity: 3, onHandQuantity: 7, backorderQuantity: 2 }),
      expect.objectContaining({ id: 12, committedQuantity: 1, onHandQuantity: 1, backorderQuantity: 5 }),
    ]);
  });

  it('引き当ても受注生産も無いバリアントは 0 で返し、手元の数はすぐ出せる数と同じ', async () => {
    setupReads({ states: [] });

    const res = await callGet();

    expect(res.body.variants[0]).toMatchObject({
      stockQuantity: 4,
      committedQuantity: 0,
      onHandQuantity: 4,
      backorderQuantity: 0,
    });
  });

  it('在庫の履歴は DB の関数で、この商品の最新50件を読む', async () => {
    await callGet();

    expect(mockRpc).toHaveBeenCalledWith('list_item_stock_history', { _item_id: 7, _limit: 50 });
  });

  it('履歴は誰が・どの注文で・変わった後の数つきで返し、注文は注文番号の形にする', async () => {
    setupReads({
      history: [
        {
          movement_id: 9,
          variant_id: 11,
          delta: -1,
          reason: 'purchase',
          note: null,
          created_at: '2026-09-22T00:00:00Z',
          actor_email: null,
          order_id: 'a1b2c3d4-1111-4222-8333-444455556666',
          balance_after: 3,
        },
        {
          movement_id: 5,
          variant_id: 11,
          delta: 4,
          reason: 'restock',
          note: '入荷',
          created_at: '2026-09-21T00:00:00Z',
          actor_email: 'admin@example.com',
          order_id: null,
          balance_after: 4,
        },
      ],
    });

    const res = await callGet();

    expect(res.body.movements).toEqual([
      {
        id: 9,
        variantId: 11,
        delta: -1,
        reason: 'purchase',
        note: null,
        createdAt: '2026-09-22T00:00:00Z',
        actorEmail: null,
        orderId: 'a1b2c3d4-1111-4222-8333-444455556666',
        orderNumber: 'ORD-A1B2C3D4',
        balanceAfter: 3,
      },
      {
        id: 5,
        variantId: 11,
        delta: 4,
        reason: 'restock',
        note: '入荷',
        createdAt: '2026-09-21T00:00:00Z',
        actorEmail: 'admin@example.com',
        orderId: null,
        orderNumber: null,
        balanceAfter: 4,
      },
    ]);
  });

  it('バリアントが無い商品は、数も履歴も DB の関数を呼ばずに空で返す', async () => {
    setupReads({ variants: [] });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ variants: [], movements: [] });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('backfill_item_variants', { target_item_id: 7 });
  });

  it('台帳の表や、前の受注生産の view は直接読まない', async () => {
    await callGet();

    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual(['item_variants']);
  });

  it('引き当て済み・受注生産の数が読めなければ 500 を返す（0 に見せない）', async () => {
    setupReads({ statesError: { message: 'boom' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callGet();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch variant stock states' });
    consoleError.mockRestore();
  });

  it('在庫の履歴が読めなければ 500 を返す', async () => {
    setupReads({ historyError: { message: 'boom' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callGet();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch stock history' });
    consoleError.mockRestore();
  });

  it('バリアントが引けなければ 500 を返す', async () => {
    setupReads({ variantsError: { message: 'boom' } });

    const res = (await GET(makeRequest(), params())) as unknown as { status: number };

    expect(res.status).toBe(500);
  });

  it('商品 id が数値でなければ 400 を返す', async () => {
    const res = (await GET(makeRequest(), { params: Promise.resolve({ id: 'abc' }) })) as unknown as {
      status: number;
    };

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 在庫の画面の試験を書く**

`tests/unit/components/ItemStockSection.test.tsx`（新規）。窓口の新しい答えの形を差し替えて、4つの数・説明・履歴の列・`自動` を確かめる。日時の表示は画面と同じ書き方で作り、試験をする場所の時刻に左右されないようにする。

```tsx
import { render, screen, within } from '@testing-library/react';
import { ItemStockSection } from '@/app/admin/item/ItemStockSection';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const EXPLANATION =
  'すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function screenTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 4,
  isActive: true,
  committedQuantity: 3,
  onHandQuantity: 7,
  backorderQuantity: 2,
};

// 注文で1点売れた行（記録した人は無い）
const PURCHASE = {
  id: 9,
  variantId: 11,
  delta: -1,
  reason: 'purchase',
  note: null,
  createdAt: '2026-09-22T01:30:00.000Z',
  actorEmail: null,
  orderId: 'a1b2c3d4-1111-4222-8333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  balanceAfter: 4,
};

// 管理者が4点入荷した行（注文は無い）
const RESTOCK = {
  id: 5,
  variantId: 11,
  delta: 4,
  reason: 'restock',
  note: '初回入荷',
  createdAt: '2026-09-21T01:00:00.000Z',
  actorEmail: 'admin@example.com',
  orderId: null,
  orderNumber: null,
  balanceAfter: 5,
};

async function renderLoaded(options: { variants?: unknown[]; movements?: unknown[] } = {}) {
  mockedFetch.mockResolvedValue(
    json({
      variants: options.variants ?? [VARIANT],
      movements: options.movements ?? [PURCHASE, RESTOCK],
    }),
  );
  render(<ItemStockSection itemId="7" />);
  await screen.findByRole('heading', { name: '履歴' });
}

describe('ItemStockSection の4つの数と履歴（グループ E-1）', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('色・サイズごとに、すぐ出せる数・引き当て済み・手元の数・受注生産の4つを出す', async () => {
    await renderLoaded();

    expect(mockedFetch).toHaveBeenCalledWith('/api/admin/items/7/variants');
    const row = screen.getByTestId('variant-row-11');
    expect(within(row).getByText('すぐ出せる数')).toBeInTheDocument();
    expect(within(row).getByText('引き当て済み')).toBeInTheDocument();
    expect(within(row).getByText('手元の数')).toBeInTheDocument();
    expect(within(row).getByText('受注生産')).toBeInTheDocument();
    expect(within(row).getByTestId('variant-stock')).toHaveTextContent(/^4$/);
    expect(within(row).getByTestId('variant-committed')).toHaveTextContent(/^3$/);
    expect(within(row).getByTestId('variant-on-hand')).toHaveTextContent(/^7$/);
    expect(within(row).getByTestId('variant-backorder')).toHaveTextContent(/^2$/);
  });

  it('4つの言葉の説明を、色・サイズが複数あっても画面に1回だけ書く', async () => {
    await renderLoaded({ variants: [VARIANT, { ...VARIANT, id: 12, sizeLabel: 'L' }] });

    expect(screen.getAllByText(EXPLANATION)).toHaveLength(1);
    expect(screen.getByTestId('stock-terms-explanation')).toHaveTextContent(EXPLANATION);
  });

  it('履歴は日時・色とサイズ・理由・増減・変わった後の数・記録した人・注文番号・備考を出す', async () => {
    await renderLoaded();

    const rows = screen.getAllByTestId('stock-movement-row');
    expect(rows).toHaveLength(2);
    const [purchase, restock] = rows;

    expect(within(purchase).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(PURCHASE.createdAt));
    expect(within(purchase).getByTestId('stock-movement-variant')).toHaveTextContent('BLACK / M');
    expect(within(purchase).getByTestId('stock-movement-reason')).toHaveTextContent('販売');
    expect(within(purchase).getByTestId('stock-movement-delta')).toHaveTextContent(/^-1$/);
    expect(within(purchase).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 4');
    expect(within(purchase).getByTestId('stock-movement-order')).toHaveTextContent('ORD-A1B2C3D4');

    expect(within(restock).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(RESTOCK.createdAt));
    expect(within(restock).getByTestId('stock-movement-reason')).toHaveTextContent('入荷');
    expect(within(restock).getByTestId('stock-movement-delta')).toHaveTextContent(/^\+4$/);
    expect(within(restock).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 5');
    expect(within(restock).getByTestId('stock-movement-actor')).toHaveTextContent('admin@example.com');
    expect(within(restock).getByTestId('stock-movement-note')).toHaveTextContent('初回入荷');
  });

  it('記録した人が空の行は「自動」と出し、注文の無い行には注文番号を出さない', async () => {
    await renderLoaded();

    const [purchase, restock] = screen.getAllByTestId('stock-movement-row');
    expect(within(purchase).getByTestId('stock-movement-actor')).toHaveTextContent(/^自動$/);
    expect(within(restock).queryByTestId('stock-movement-order')).not.toBeInTheDocument();
  });

  it('履歴が空なら案内を出す', async () => {
    await renderLoaded({ movements: [] });

    expect(screen.getByText('まだ記録がありません。')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stock-movement-row')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 試験が失敗することを確かめる**

Run: `npx jest tests/unit/api/admin/item-variants-route.test.ts tests/unit/components/ItemStockSection.test.tsx --runInBand`
Expected: FAIL（まだ窓口も画面も直していない）
- `item-variants-route`: 窓口が今の表（`variant_backorder_summary`・`stock_movements`）を読もうとして落ち、GET の多くが 200 でなく 500 になる。`list_variant_stock_states`・`list_item_stock_history` は呼ばれていない。`POST` の試験は通る
- `ItemStockSection`: `すぐ出せる数` などの言葉が見つからない、`stock-terms-explanation` が見つからない、履歴の `stock-movement-time` などが見つからない

- [ ] **Step 4: 窓口を直す**

`src/app/api/admin/items/[id]/variants/route.ts`:

(a) import に足す（`logAudit` の import の次の行）:

```ts
import { toOrderNumber } from '@/lib/orders/order-number';
```

(b) `type VariantRow = {…};`（31〜38行）の直後に足す:

```ts
/** public.list_variant_stock_states の1行（引き当て済みと受注生産の数。設計書 10-1） */
type StockStateRow = {
  variant_id: number;
  committed: number;
  backorder: number;
};

/** public.list_item_stock_history の1行（設計書 10-2） */
type StockHistoryRow = {
  movement_id: number;
  variant_id: number;
  delta: number;
  reason: string;
  note: string | null;
  created_at: string;
  actor_email: string | null;
  order_id: string | null;
  balance_after: number;
};

/** 在庫の画面に出す履歴の件数 */
const STOCK_HISTORY_LIMIT = 50;
```

(c) `export async function GET(...)` を、次にまるごと置き換える（`itemIdSchema` の確かめ・`backfill_item_variants`・`item_variants` の読み取りは今のまま。変えたのは、`const variantRows` から後ろ）。`POST` は変えない。

```ts
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authz = await authorizeAdminPermission('admin.items.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const { id } = await params;
    const parsedItemId = itemIdSchema.safeParse(id);
    if (!parsedItemId.success) {
      return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
    }
    const itemId = parsedItemId.data;

    const supabase = await createServiceRoleClient();

    // 商品の色・サイズは items.colors / items.sizes にも入っている。読む前にそろえないと、
    // 管理画面で色を足した直後に在庫を入れる先が無い。この関数は冪等（ON CONFLICT DO NOTHING）。
    const { error: syncError } = await supabase.rpc('backfill_item_variants', {
      target_item_id: itemId,
    });
    if (syncError) {
      console.error('Failed to sync item variants:', itemId, syncError);
      return NextResponse.json({ error: 'Failed to sync item variants' }, { status: 500 });
    }

    const { data: variants, error: variantsError } = await supabase
      .from('item_variants')
      .select('id, stock_quantity, is_active, sku, item_colors(name, hex, position), item_sizes(label, position)')
      .eq('item_id', itemId)
      .order('id', { ascending: true });

    if (variantsError) {
      console.error('Failed to fetch item variants:', itemId, variantsError);
      return NextResponse.json({ error: 'Failed to fetch item variants' }, { status: 500 });
    }

    const variantRows = (variants ?? []) as unknown as VariantRow[];
    const variantIds = variantRows.map((row) => row.id);

    // 引き当て済みと受注生産の数は DB の関数が1か所で数える。台帳や view を画面の側で数え直さない。
    // 読めなかった時に 0 と見せると製造と仕入れの判断を誤るので、失敗は隠さない
    const { data: stockStates, error: stockStatesError } = variantIds.length
      ? await supabase.rpc('list_variant_stock_states', { _variant_ids: variantIds })
      : { data: [], error: null };
    if (stockStatesError) {
      console.error('Failed to fetch variant stock states:', itemId, stockStatesError);
      return NextResponse.json({ error: 'Failed to fetch variant stock states' }, { status: 500 });
    }

    const { data: history, error: historyError } = variantIds.length
      ? await supabase.rpc('list_item_stock_history', { _item_id: itemId, _limit: STOCK_HISTORY_LIMIT })
      : { data: [], error: null };
    if (historyError) {
      console.error('Failed to fetch stock history:', itemId, historyError);
      return NextResponse.json({ error: 'Failed to fetch stock history' }, { status: 500 });
    }

    const stateByVariant = new Map<number, StockStateRow>(
      ((stockStates ?? []) as StockStateRow[]).map((row) => [row.variant_id, row]),
    );

    return NextResponse.json(
      {
        variants: variantRows.map((row) => {
          const state = stateByVariant.get(row.id);
          const committedQuantity = state?.committed ?? 0;

          return {
            id: row.id,
            colorName: row.item_colors?.name ?? null,
            colorHex: row.item_colors?.hex ?? null,
            sizeLabel: row.item_sizes?.label ?? null,
            sku: row.sku,
            stockQuantity: row.stock_quantity,
            isActive: row.is_active,
            committedQuantity,
            // 手元の数は棚に実際にある数。すぐ出せる数に、注文のために取ってある数を足す（設計書 10-1）
            onHandQuantity: row.stock_quantity + committedQuantity,
            backorderQuantity: state?.backorder ?? 0,
          };
        }),
        movements: ((history ?? []) as StockHistoryRow[]).map((row) => ({
          id: row.movement_id,
          variantId: row.variant_id,
          delta: row.delta,
          reason: row.reason,
          note: row.note,
          createdAt: row.created_at,
          actorEmail: row.actor_email,
          orderId: row.order_id,
          orderNumber: row.order_id ? toOrderNumber(row.order_id) : null,
          balanceAfter: row.balance_after,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/items/:id/variants error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 5: 在庫の画面を直す**

`src/app/admin/item/ItemStockSection.tsx` を6か所直す（`load`・`submit`・`POST` の呼び出し・入力欄は変えない）。

(a) 先頭の説明のコメント（8〜17行）の最後の段落（`在庫が無い組み合わせも受注生産として売れる…` から `製造の判断に使えるようにする。` まで）を、次に置き換える:

```
 * 在庫が無い組み合わせも受注生産として売れる（ブランドの前提）。すぐ出せる数が 0 でも「売れない」
 * ではない。すぐ出せる数・引き当て済み・手元の数・受注生産（まだ仕上がっていない数）を並べて置き、
 * 製造と仕入れの判断に使えるようにする（グループ E-1。数え方は DB の関数が1か所で持つ）。
```

(b) `type Variant`・`type Movement`（19〜37行）を、次に置き換える:

```tsx
type Variant = {
  id: number;
  colorName: string | null;
  colorHex: string | null;
  sizeLabel: string | null;
  sku: string | null;
  /** すぐ出せる数 */
  stockQuantity: number;
  isActive: boolean;
  /** 引き当て済み: 注文のために取ってある数 */
  committedQuantity: number;
  /** 手元の数: 棚に実際にある数（すぐ出せる数 + 引き当て済み） */
  onHandQuantity: number;
  /** 受注生産: これから作る数 */
  backorderQuantity: number;
};

type Movement = {
  id: number;
  variantId: number;
  delta: number;
  reason: string;
  note: string | null;
  createdAt: string;
  /** 記録した管理者のメール。注文や取消の処理が自動で書いた行は null */
  actorEmail: string | null;
  orderId: string | null;
  /** 注文番号の形（ORD-XXXXXXXX）。注文に結び付かない行は null */
  orderNumber: string | null;
  /** その行で変わった後の、この色・サイズのすぐ出せる数 */
  balanceAfter: number;
};
```

(c) `const REASON_LABELS: Record<string, string> = {…};`（39〜45行）の直後に足す:

```tsx
// 4つの数の言葉の説明。画面の上に1回だけ書く（色・サイズごとの行には書かない）
const STOCK_TERMS_EXPLANATION =
  "すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。";
```

(d) 画面の上の説明の段落（`<p className="mt-3 lk-text-3xs leading-relaxed text-black/60">` から `</p>` まで、174〜177行）を、次に置き換える:

```tsx
      <p
        data-testid="stock-terms-explanation"
        className="mt-3 lk-text-3xs leading-relaxed text-black/60"
      >
        {STOCK_TERMS_EXPLANATION}
      </p>
      <p className="mt-1 lk-text-3xs leading-relaxed text-black/60">
        すぐ出せる数が 0 でも、受注生産として注文は受け付ける。
        数を動かすと理由つきで台帳に残り、あとから取り消せない。
      </p>
```

(e) 色・サイズの行の「在庫」と「受注生産」の2つの `<span className="lk-text-2xs text-black">…</span>`（229〜239行）を、次の4つに置き換える（`variant-stock`・`variant-backorder` の `data-testid` は今のまま）:

```tsx
                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">すぐ出せる数 </span>
                    <span data-testid="variant-stock" className="font-medium">
                      {variant.stockQuantity}
                    </span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">引き当て済み </span>
                    <span data-testid="variant-committed">{variant.committedQuantity}</span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">手元の数 </span>
                    <span data-testid="variant-on-hand">{variant.onHandQuantity}</span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">受注生産 </span>
                    <span data-testid="variant-backorder">{variant.backorderQuantity}</span>
                  </span>
```

(f) 履歴の `<ul className="mt-3 flex flex-col gap-2">` から `</ul>` まで（305〜318行）を、次に置き換える（`履歴` の見出しと、空の時の案内はそのまま）。色・サイズの名前（T9-2）は、画面が持っている `variants` から引く:

```tsx
        <ul className="mt-3 flex flex-col gap-2">
          {movements.map((movement) => {
            const variant = variants.find((candidate) => candidate.id === movement.variantId);

            return (
              <li
                key={movement.id}
                data-testid="stock-movement-row"
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-black/5 pb-2 lk-text-3xs text-black/70"
              >
                <span data-testid="stock-movement-time">{formatDateTime(movement.createdAt)}</span>
                {variant && (
                  <span data-testid="stock-movement-variant">{variantLabel(variant)}</span>
                )}
                <span data-testid="stock-movement-reason">
                  {REASON_LABELS[movement.reason] ?? movement.reason}
                </span>
                <span data-testid="stock-movement-delta" className="font-medium text-black">
                  {formatDelta(movement.delta)}
                </span>
                <span data-testid="stock-movement-balance">{`変わった後 ${movement.balanceAfter}`}</span>
                {/* 記録した人が空の行は、注文や取消の処理が自動で書いたもの */}
                <span data-testid="stock-movement-actor">{movement.actorEmail ?? "自動"}</span>
                {movement.orderNumber && (
                  <span data-testid="stock-movement-order">{movement.orderNumber}</span>
                )}
                {movement.note && (
                  <span data-testid="stock-movement-note" className="text-black/50">
                    {movement.note}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
```

- [ ] **Step 6: 今の E2E の窓口の差し替えを新しい形に直す**

`e2e/FR-ADMIN-058-item-variant-stock.spec.ts` は窓口（`**/api/admin/items/7/variants`）を差し替えて流す。窓口の答えの形が変わるので、差し替えの中身だけを直す（試験の内容・`data-testid` は今のまま。4つの数の確かめは Task 10 の `FR-ADMIN-073`）。

(a) `type VariantState`・`type MovementState`（14〜31行）を、次に置き換える:

```ts
type VariantState = {
  id: number;
  colorName: string;
  colorHex: string;
  sizeLabel: string;
  stockQuantity: number;
  isActive: boolean;
  committedQuantity: number;
  onHandQuantity: number;
  backorderQuantity: number;
};

type MovementState = {
  id: number;
  variantId: number;
  delta: number;
  reason: string;
  note: string | null;
  createdAt: string;
  actorEmail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  balanceAfter: number;
};
```

(b) `const variants: VariantState[] = [...]` と `const movements: MovementState[] = [...]`（80〜86行）を、次に置き換える:

```ts
  const variants: VariantState[] = [
    { id: 11, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'M', stockQuantity: 4, isActive: true, committedQuantity: 3, onHandQuantity: 7, backorderQuantity: 2 },
    { id: 12, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'L', stockQuantity: 0, isActive: true, committedQuantity: 0, onHandQuantity: 0, backorderQuantity: 0 },
  ];
  const movements: MovementState[] = [
    { id: 5, variantId: 11, delta: 4, reason: 'restock', note: '初回入荷', createdAt: '2026-09-20T01:00:00Z', actorEmail: 'a@e.com', orderId: null, orderNumber: null, balanceAfter: 4 },
  ];
```

(c) POST の差し替えの中の、`target` を動かす所から `movements.unshift({...});` まで（101〜112行）を、次に置き換える（在庫が動いたら手元の数も動かし、履歴の行に変わった後の数を持たせる）:

```ts
      const target = variants.find((variant) => variant.id === body.variantId);
      if (target) {
        target.stockQuantity += body.delta;
        target.onHandQuantity += body.delta;
      }
      movements.unshift({
        id: nextMovementId++,
        variantId: body.variantId,
        delta: body.delta,
        reason: body.reason,
        note: body.note ?? null,
        createdAt: '2026-09-21T02:00:00Z',
        actorEmail: 'a@e.com',
        orderId: null,
        orderNumber: null,
        balanceAfter: target?.stockQuantity ?? 0,
      });
```

- [ ] **Step 7: 試験が通ることを確かめる**

Run: `npx jest tests/unit/api/admin/item-variants-route.test.ts tests/unit/components/ItemStockSection.test.tsx --runInBand`
Expected: PASS（`POST` の試験も、書き換えずに通る）

Run: `npx tsc --noEmit` と `npm run lint`
Expected: エラー0件（`e2e` の差し替えの型も `tsc` が見る）

Run: `git grep -n "variant_backorder_summary" -- src`
Expected: 出力なし（前の受注生産の view を読む所はもう無い）

- [ ] **Step 8: コミット（controller）**

`FR-ADMIN-058` は、Task 12 の全体の確かめ（E2E の全件）で、手元の Supabase に対して流して通ることを確かめる。

```bash
git add "src/app/api/admin/items/[id]/variants/route.ts" src/app/admin/item/ItemStockSection.tsx tests/unit/api/admin/item-variants-route.test.ts tests/unit/components/ItemStockSection.test.tsx e2e/FR-ADMIN-058-item-variant-stock.spec.ts
git commit -m "$(cat <<'EOF'
feat(admin): 在庫の画面に4つの数と、誰が・どの注文で動かしたかの履歴を出す（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: E2E（3つの画面幅）

**Files:**
- Create: `e2e/order-fulfillment-test-utils.ts`（管理画面の窓口を差し替える道具と、窓口の答えの組み立て）
- Create: `e2e/order-detail-fixtures.ts`（お客様の注文詳細の窓口の答えの共通の部分）
- Create: `e2e/FR-ADMIN-068-partial-fulfillment.spec.ts`・`e2e/FR-ADMIN-069-made-to-order-completion.spec.ts`・`e2e/FR-ADMIN-070-order-progress-labels.spec.ts`・`e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts`・`e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts`・`e2e/FR-ADMIN-073-inventory-states.spec.ts`・`e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts`・`e2e/FR-CHECKOUT-050-split-shipment-notice.spec.ts`
- Modify: `e2e/order-email-test-utils.ts`（明細つきの注文を作る道具・仕上がり/発送/取消の DB の関数の呼び出し・メールの本文を読む道具・worker を繰り返し動かす道具を足す）
- Modify: 今の E2E（Step 11〜12 のとおり）: `e2e/FR-ADMIN-050-order-shipping.spec.ts`・`051-order-refund-safety`・`061-order-list-review-states`・`065-order-history-and-email-resend`・`066-ship-email-opt-out`、`e2e/FR-ACCOUNT-005-order-history`・`013-order-detail`・`015-order-detail-progress-steps`・`016-order-detail-responsive`・`017-order-detail-item-spacing`・`018-order-detail-shipping-band`・`019-order-detail-stepper-mobile`・`020-order-detail-contact-button`・`023-order-history-timeline`・`031-order-shipping-info`

**Interfaces:**
- Consumes: Task 1・2 の DB の関数（`admin_record_completion`・`admin_cancel_completion`・`admin_create_fulfillment`・`admin_cancel_fulfillment`・`list_order_line_fulfillment`・`list_variant_stock_states`・`list_item_stock_history`・`list_order_email_history`、`private.enqueue_order_email` の発送の番号つき）、Task 3 の型（`@/lib/orders/fulfillment/fulfillment-types`・`@/lib/orders/order-progress`）、Task 5 の履歴の型（`@/lib/orders/email/order-history` の `OrderHistoryFulfillmentEntry` など）、Task 6〜9 の画面と窓口の答えの形（共通の約束と Global Constraints の言葉）、今の `e2e/admin-test-utils.ts`・`e2e/account-test-utils.ts`、手元の DB（`E2E_LOCAL_DB_URL`）、手元のメール受け（`MAIL_LOCAL_URL`）、E2E の固定の値 `CRON_SECRET`
- Produces: `e2e/order-email-test-utils.ts` の `createOrderWithLines`・`createFulfillment`・`cancelFulfillment`・`recordCompletion`・`cancelCompletion`・`lineCounts`・`orderState`・`orderItemIdsOf`・`outboxRows`・`expectDbError`・`runWorkerUntil`・`mailBodies`、`e2e/order-fulfillment-test-utils.ts` の `viewports`・`UUID_PATTERN`・`orderNumberOf`・`fulfillJson`・`mockAdminSession`・`mockOrderList`・`openOrderTab`・`READY_PROGRESS`・`orderLine`・`adminOrder`・`materialLine`・`shipMaterials`・`historyOf`、`e2e/order-detail-fixtures.ts` の `withReadyProgress`・`progressOf`・`shipmentOf`

管理画面の E2E は、今までの管理画面の E2E と同じく窓口を差し替えて画面を確かめる（本物の管理者のログインには2段階認証が要り、E2E の仕組みが無い。本計画 P11）。DB の関数が数やメールを守ることは、同じ spec の中で手元の DB の関数を直に呼び、worker の定期処理の入口を叩き、Mailpit を数えて確かめる。差し替える窓口の答えは、共通の約束（C-2）の型に `satisfies` で合わせるので、型が変われば `npx tsc --noEmit` が教える。各テストの題かコメントに、Task 11 で決める受け付け基準の番号（`FREQ-4xx-AC-xx`）を書く。

この Task の試験は、Task 6〜9 の画面の作りに次の所で頼る。画面を作る側（Task 6〜9）は、ここを変えるなら、この Task の試験も一緒に直す。

| 場所 | 試験が頼る作り |
|---|---|
| 発送の画面 | `role="dialog"`、名前 `発送済みにする`。商品ごとの入力は名前に `今回送る数` を含み、並びは窓口の `lines` の順（未発送が1以上の行だけ）。合計は `今回送る数の合計: {n}点`。誤りは `role="alert"` の中の文字。答えが分からない時は、ボタンが `もう一度確かめる`・`閉じる` の2つだけになり、入力は消すか止める |
| 発送の画面の受注生産中の行 | `受注生産中 {n}` の文字、名前 `仕上がった数` の入力、ボタン `仕上がりを記録`。仕上がりを記録した後は、画面の中で材料を読み直し、その商品の今回送る数に入れられる |
| 仕上がりの画面 | `role="dialog"`、名前 `仕上がりを記録する`。受注生産中の行ごとに名前 `仕上がった数` の入力。ボタン `記録する`。成功したら閉じ、一覧の上に文字 `仕上がりを記録しました。` が出る |
| 履歴の画面 | 発送・仕上がりの行は `li`。発送の行には配送業者の名前の文字がある。取消の確かめは同じダイアログの中で、文とボタン `取り消す`・`やめる` を出す。窓口の断りの言葉は同じ画面の中に文字で出る。取り消したら履歴と一覧を読み直す（`onChanged`） |
| 一覧 | 行の最初の列は `order.id`。状態の印は、その言葉だけの要素。`一部発送済み` は別の印。商品欄は `シルクブラウス（ホワイト / M）×2（受注生産中 1・発送済み 1）` の形。ボタン `仕上がりを記録する`・`発送済みにする` |
| 絞り込み | ボタン名は Global Constraints のとおり。`発送待ち（受注生産中・発送準備中）` は `status=paid`、`発送済み（配送中・配達済み）` は `status=shipped` で読む。2つ以上選んだ時は `status` を送らず、画面が `orderStatus`（DB の状態）で絞る |
| お客様の注文の画面 | `ol` の名前 `配送ステータス`。段のラベルの文字は、済み・今の段が `text-black`、これからの段が `text-[#999]`。発送ごとに `section` の名前 `配送情報（{n}回目）`。見出し `発送準備中の商品`・`受注生産中の商品` は `h1`〜`h6` で、その群の商品の名前はその見出しより後ろに置く |
| 在庫の画面 | `data-testid="variant-row-{id}"` の中に `すぐ出せる数 33` のように名前と数を並べる。`variant-stock`（すぐ出せる数）・`variant-backorder`（受注生産）・`stock-movement-row` の `data-testid` は今のまま。説明の文は画面に1回 |

- [ ] **Step 1: 手元の DB の道具を足す**

`e2e/order-email-test-utils.ts` の全部（今の中身は変えずに、下半分を足す。`createPaidOrder` が作る商品は非公開で、ほかの購入の spec が選ぶ商品を入れ替えない。新しい `createOrderWithLines` も同じ）:

```ts
/**
 * 注文のメールの E2E の道具（グループ D）。手元の DB・手元のメール受け（Mailpit）・worker の定期処理の入口だけを使う。
 * 本物の管理者のログインには2段階認証（TOTP）が要るので、管理画面の操作の代わりに DB の関数を直に呼ぶ（本計画 P11）。
 * グループ E-1 で、明細つきの注文を作る道具・仕上がり/発送/取消の DB の関数の呼び出し・メールの本文を読む道具を足した。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import {
  PRICE,
  createCatalogFixture,
  insertOrderWithStockLine,
  uniqueSuffix,
} from '../tests/integration/db/helpers/order-fixtures';
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

/**
 * 入金済みの注文（在庫の明細1行）を、試験ごとの宛先で作る。
 * 商品は非公開にする。公開のままだと、同じ実行の中で並行して流れる他の購入 spec の seedCart が選ぶ
 * 「新しい順の最初の商品」が、この試験用の商品に入れ替わってしまう。
 */
export async function createPaidOrder(db: PgClient, email: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1, itemStatus: 'private' });
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

// ---- ここから下がグループ E-1 で足した物 ----

export type MailBody = { Subject: string; Text: string };

/** その宛先へのメールを、本文つきで読む。件名に含む文字で絞れる（Mailpit は1通ごとに本文の API が別） */
export async function mailBodies(request: APIRequestContext, email: string, subjectIncludes = ''): Promise<MailBody[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const found = (await mailsTo(request, email)).filter((message) => message.Subject.includes(subjectIncludes));
  const bodies: MailBody[] = [];
  for (const message of found) {
    const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailUrl).toString(), {
      timeout: 5_000,
    });
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as MailBody;
    bodies.push({ Subject: body.Subject, Text: body.Text });
  }
  return bodies;
}

/**
 * 条件が満たされるまで、worker の定期処理の入口を叩き直す。
 * worker は10秒の予算で止まり、別の起動が取った行は飛ばすので、1回叩いただけでは送り切った証拠にならない。
 */
export async function runWorkerUntil(
  request: APIRequestContext,
  done: () => Promise<boolean>,
  message: string,
  timeoutMs = 90_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await runWorkerOnce(request);
        return done();
      },
      { timeout: timeoutMs, intervals: [500, 1_000, 2_000], message },
    )
    .toBe(true);
}

/** DB の関数が決まった言葉（例 QUANTITY_EXCEEDS_READY）で断ることを確かめる。pg の誤りの message にその言葉が入る */
export async function expectDbError(operation: Promise<unknown>, code: string): Promise<void> {
  let message = '';
  try {
    await operation;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `${code} で断られること`).toContain(code);
}

export type E2eOrderLine = {
  name: string;
  quantity: number;
  fulfillmentType: 'stock' | 'backorder';
  color?: string;
  size?: string;
};

export type E2eCreatedOrder = { orderId: string; orderItemIds: string[]; itemId: number; variantId: number };

/**
 * 明細を自由に決めた注文を作る。在庫の明細は台帳に確保（purchase）も入れ、受注生産の明細は台帳を動かさない
 * （注文を受け付ける DB の関数と同じ形）。配送先は後から書き換えられないので、発送できる形で最初から入れる。
 * 同じ色・サイズの在庫を複数の注文で使う時は、先の注文の itemId・variantId を catalog に渡す
 * （2件目からは在庫を足さないので、足りる数を最初の注文の在庫の明細で用意する）。
 * 商品は非公開にする（理由は createPaidOrder と同じ）。
 */
export async function createOrderWithLines(
  db: PgClient,
  email: string,
  lines: E2eOrderLine[],
  options: {
    status?: 'paid' | 'pending' | 'payment_in_progress' | 'cancelled';
    reviewReason?: 'stock_not_reserved';
    catalog?: { itemId: number; variantId: number };
  } = {},
): Promise<E2eCreatedOrder> {
  const stockQuantity = lines
    .filter((line) => line.fulfillmentType === 'stock')
    .reduce((sum, line) => sum + line.quantity, 0);
  const catalog = options.catalog ?? (await createCatalogFixture(db, { stock: stockQuantity, itemStatus: 'private' }));
  const suffix = uniqueSuffix();
  const subtotal = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status, review_reason,
        subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, null, $3::public.order_status, $4,
             $5, 0, $5, 'jpy',
             $6, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [`e2e-lines-${suffix}`, `cs_e2e_${suffix}`, options.status ?? 'paid', options.reviewReason ?? null, subtotal, email],
  );
  const orderId = order.rows[0].id as string;
  const orderItemIds: string[] = [];
  for (const line of lines) {
    const saved = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, quantity, line_total, variant_id, fulfillment_type, color, size)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        orderId, catalog.itemId, line.name, PRICE, line.quantity, PRICE * line.quantity,
        catalog.variantId, line.fulfillmentType, line.color ?? 'ホワイト', line.size ?? 'M',
      ],
    );
    const orderItemId = saved.rows[0].id as string;
    orderItemIds.push(orderItemId);
    if (line.fulfillmentType === 'stock') {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [catalog.variantId, -line.quantity, orderId, orderItemId],
      );
    }
  }
  return { orderId, orderItemIds, itemId: catalog.itemId, variantId: catalog.variantId };
}

/** 注文の明細の番号（作った順） */
export async function orderItemIdsOf(db: PgClient, orderId: string): Promise<string[]> {
  const res = await db.query('select id from public.order_items where order_id = $1 order by created_at, id', [orderId]);
  return res.rows.map((row) => row.id as string);
}

export type E2eLineQuantity = { orderItemId: string; quantity: number };

function dbLines(lines: E2eLineQuantity[]): string {
  return JSON.stringify(lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity })));
}

export type E2eFulfillment = {
  fulfillmentId: string;
  number: number;
  completesOrder: boolean;
  orderStatus: string;
  replayed: boolean;
};

/** 発送の DB の関数 admin_create_fulfillment。管理画面の発送の画面の代わりに、同じ関数を直に呼ぶ */
export async function createFulfillment(
  db: PgClient,
  orderId: string,
  actorId: string,
  input: {
    lines: E2eLineQuantity[];
    trackingNumber: string;
    carrier?: 'yamato' | 'sagawa' | 'japanpost';
    notify?: boolean;
    requestKey?: string;
  },
): Promise<E2eFulfillment> {
  const res = await db.query(
    `select * from public.admin_create_fulfillment(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::boolean, $7::jsonb)`,
    [
      orderId, actorId, input.requestKey ?? randomUUID(), input.carrier ?? 'yamato',
      input.trackingNumber, input.notify ?? true, dbLines(input.lines),
    ],
  );
  const row = res.rows[0];
  return {
    fulfillmentId: row.fulfillment_id as string,
    number: Number(row.number),
    completesOrder: row.completes_order as boolean,
    orderStatus: row.order_status as string,
    replayed: row.replayed as boolean,
  };
}

/** 発送の取消の DB の関数 admin_cancel_fulfillment */
export async function cancelFulfillment(
  db: PgClient,
  orderId: string,
  fulfillmentId: string,
  actorId: string,
): Promise<{ outcome: string; orderStatus: string }> {
  const res = await db.query('select * from public.admin_cancel_fulfillment($1::uuid, $2::uuid, $3::uuid)', [
    orderId, fulfillmentId, actorId,
  ]);
  return { outcome: res.rows[0].outcome as string, orderStatus: res.rows[0].order_status as string };
}

/** 仕上がりの記録の DB の関数 admin_record_completion（記録した行ごとに返る） */
export async function recordCompletion(
  db: PgClient,
  orderId: string,
  actorId: string,
  lines: E2eLineQuantity[],
  requestKey: string = randomUUID(),
): Promise<Array<{ completionId: string; orderItemId: string; quantity: number; replayed: boolean }>> {
  const res = await db.query('select * from public.admin_record_completion($1::uuid, $2::uuid, $3::uuid, $4::jsonb)', [
    orderId, actorId, requestKey, dbLines(lines),
  ]);
  return res.rows.map((row) => ({
    completionId: row.completion_id as string,
    orderItemId: row.order_item_id as string,
    quantity: Number(row.quantity),
    replayed: row.replayed as boolean,
  }));
}

/** 仕上がりの取消の DB の関数 admin_cancel_completion。outcome（cancelled・already_cancelled）を返す */
export async function cancelCompletion(
  db: PgClient,
  orderId: string,
  completionId: string,
  actorId: string,
): Promise<string> {
  const res = await db.query('select * from public.admin_cancel_completion($1::uuid, $2::uuid, $3::uuid)', [
    orderId, completionId, actorId,
  ]);
  return res.rows[0].outcome as string;
}

export type E2eLineCounts = {
  quantity: number;
  shipped: number;
  completed: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

/** 商品ごとの数（画面も窓口も同じ数え方を使う公開の関数）。キーは注文の明細の番号 */
export async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, E2eLineCounts>> {
  const res = await db.query('select * from public.list_order_line_fulfillment(array[$1::uuid])', [orderId]);
  const counts: Record<string, E2eLineCounts> = {};
  for (const row of res.rows) {
    counts[row.order_item_id as string] = {
      quantity: Number(row.quantity),
      shipped: Number(row.shipped),
      completed: Number(row.completed),
      inProduction: Number(row.in_production),
      readyUnshipped: Number(row.ready_unshipped),
      unshipped: Number(row.unshipped),
    };
  }
  return counts;
}

/** 注文の状態と、全部を送った時の値（出荷日時・配送業者・伝票番号） */
export async function orderState(db: PgClient, orderId: string) {
  const res = await db.query(
    'select status::text as status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1',
    [orderId],
  );
  return res.rows[0] as {
    status: string;
    shipped_at: Date | null;
    shipping_carrier: string | null;
    tracking_number: string | null;
  };
}

export type OutboxRow = {
  fulfillment_id: string | null;
  origin: string;
  status: string;
  last_error_code: string | null;
};

/** 注文のメールの表の、その種類の行を、書いた順に読む */
export async function outboxRows(db: PgClient, orderId: string, kind = 'shipped'): Promise<OutboxRow[]> {
  const res = await db.query(
    `select fulfillment_id, origin, status, last_error_code
     from private.order_email_outbox where order_id = $1 and kind = $2 order by seq`,
    [orderId, kind],
  );
  return res.rows as OutboxRow[];
}
```

- [ ] **Step 2: 管理画面の道具を書く**

`e2e/order-fulfillment-test-utils.ts`:

```ts
/**
 * 発送・仕上がり・注文の進み具合の管理画面の E2E の道具（グループ E-1）。
 * 管理画面は、今までの管理画面の E2E と同じく窓口を差し替えて確かめる（本物の管理者のログインには2段階認証が要る）。
 * 窓口の答えは、共通の約束（実装計画 C-2）の型に合わせて組み立てる。型が変われば tsc が教えてくれる。
 */
import type { Page, Route } from '@playwright/test';
import type { OrderItem, OrderLineItem } from '@/components/OrderSection';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import { mockAdminBackgroundApis } from './admin-test-utils';

export const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 管理画面の注文番号（src/lib/orders/order-number.ts と同じ形。値の import は避ける） */
export function orderNumberOf(orderId: string): string {
  return `ORD-${orderId.slice(0, 8).toUpperCase()}`;
}

/** 窓口の答えを JSON で返す */
export function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 管理者のログインと、管理画面が裏で読む窓口を固定する */
export async function mockAdminSession(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, { authenticated: true, user: { id: 'a', email: 'admin@example.com', role: 'admin', mfaVerified: true } }));
  await page.route('**/api/admin/kpi', (route) => fulfillJson(route, { error: 'not mocked' }, 500));
}

/**
 * 注文の一覧の窓口。読まれた URL を記録し、その時の一覧を返す。
 * 注文の番号つきの窓口（…/orders/{id}/…）と取り違えないよう、パスが一覧だけの時に当てる。
 * 後から登録した窓口が先に効くので、これを先に呼んでから、注文ごとの窓口を登録する。
 */
export async function mockOrderList(page: Page, current: () => OrderItem[]): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route(
    (url) => url.pathname === '/api/admin/orders',
    (route) => {
      urls.push(route.request().url());
      const orders = current();
      return fulfillJson(route, { data: orders, pagination: { page: 1, pageSize: 20, total: orders.length, totalPages: 1 } });
    },
  );
  return { urls };
}

/** 管理画面を開いて ORDER タブにする */
export async function openOrderTab(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

export const READY_PROGRESS: OrderProgress = { key: 'ready', label: '発送準備中', partiallyShipped: false };

/** 一覧の商品の行（既定は、在庫の品1つが発送準備中） */
export function orderLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 'c1000000-0000-4000-8000-000000000001',
    name: 'シルクブラウス',
    color: 'ホワイト',
    size: 'M',
    quantity: 1,
    fulfillmentType: 'stock',
    shipped: 0,
    inProduction: 0,
    readyUnshipped: 1,
    ...overrides,
  };
}

/** 一覧の注文の行（既定は、発送できる状態の入金済みの注文） */
export function adminOrder(overrides: Partial<OrderItem> & { id: string }): OrderItem {
  const items = overrides.items ?? [orderLine()];
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-10',
    itemCount: `${quantity}点`,
    items,
    totalAmount: '¥28,800',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canShip: true,
    canRecordCompletion: false,
    ...overrides,
  };
}

/** 発送の材料の商品の行。未発送の数は、渡さなければ「数 − 発送した数」 */
export function materialLine(overrides: Partial<FulfillmentMaterialLine> & { orderItemId: string }): FulfillmentMaterialLine {
  const merged = {
    name: 'シルクブラウス',
    color: 'ホワイト',
    size: 'M',
    fulfillmentType: 'stock' as const,
    quantity: 1,
    shipped: 0,
    inProduction: 0,
    readyUnshipped: 1,
    ...overrides,
  };
  return { ...merged, unshipped: overrides.unshipped ?? merged.quantity - merged.shipped };
}

/** GET /api/admin/orders/[id]/fulfillments の答え */
export function shipMaterials(input: {
  orderId: string;
  lines: FulfillmentMaterialLine[];
  status?: OrderStatus;
  progress?: OrderProgress;
  blockedReason?: FulfillmentMaterials['blockedReason'];
  fulfillments?: FulfillmentMaterials['fulfillments'];
}): FulfillmentMaterials {
  return {
    order: {
      id: input.orderId,
      orderNumber: orderNumberOf(input.orderId),
      status: input.status ?? 'paid',
      progress: input.progress ?? READY_PROGRESS,
    },
    blockedReason: input.blockedReason ?? null,
    lines: input.lines,
    fulfillments: input.fulfillments ?? [],
  };
}

/** GET /api/admin/orders/[id]/history の答え */
export function historyOf(orderId: string, entries: OrderHistoryResponse['entries']): OrderHistoryResponse {
  return {
    order: { id: orderId, orderNumber: orderNumberOf(orderId), statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries,
  };
}
```

- [ ] **Step 3: FR-ADMIN-068（部分発送）を書く**

`e2e/FR-ADMIN-068-partial-fulfillment.spec.ts`:

```ts
/**
 * FR-ADMIN-068 発送準備中の品を先に送れる部分発送
 * 対応 FREQ: FREQ-439（AC-01〜AC-06）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P11）。窓口の答えは共通の約束（C-2）の形。
 * 発送の関数が数を守ること（AC-06）は、手元の DB の関数を直に呼んで確かめる。
 * 発送の画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  CreateFulfillmentRequest,
  CreateFulfillmentResponse,
  FulfillmentErrorResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b1b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'b1b2c3d4-0000-4000-8000-000000000002';
const LINES = [
  { id: BLOUSE, name: 'シルクブラウス', quantity: 3 },
  { id: SKIRT, name: 'プリーツスカート', quantity: 2 },
];
const EXCEEDS_READY = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

/** 窓口の向こうの記録の代わり。商品ごとに送った数を持ち、一覧と発送の材料の答えをそこから作る */
type ShipState = {
  shipped: Record<string, number>;
  posts: CreateFulfillmentRequest[];
  /** 発送の窓口の答え。既定は「記録した」で、テストが差し替えて、断りや通信の切れを起こす */
  answer: (route: Route, body: CreateFulfillmentRequest) => Promise<void>;
};

function recordShipment(state: ShipState, body: CreateFulfillmentRequest): void {
  for (const line of body.lines) {
    state.shipped[line.orderItemId] = (state.shipped[line.orderItemId] ?? 0) + line.quantity;
  }
}

function allShipped(state: ShipState): boolean {
  return LINES.every((line) => (state.shipped[line.id] ?? 0) >= line.quantity);
}

function rowOf(state: ShipState) {
  const items = LINES.map((line) => {
    const shipped = state.shipped[line.id] ?? 0;
    return orderLine({ id: line.id, name: line.name, quantity: line.quantity, shipped, readyUnshipped: line.quantity - shipped });
  });
  if (allShipped(state)) {
    return adminOrder({ id: ORDER_ID, items, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false });
  }
  return adminOrder({ id: ORDER_ID, items, partiallyShipped: items.some((item) => item.shipped > 0) });
}

function materialsOf(state: ShipState) {
  return shipMaterials({
    orderId: ORDER_ID,
    lines: LINES.map((line) => {
      const shipped = state.shipped[line.id] ?? 0;
      return materialLine({ orderItemId: line.id, name: line.name, quantity: line.quantity, shipped, readyUnshipped: line.quantity - shipped });
    }),
  });
}

async function mockShipApis(page: Page) {
  const state: ShipState = {
    shipped: {},
    posts: [],
    answer: async (route, body) => {
      recordShipment(state, body);
      const completes = allShipped(state);
      await fulfillJson(route, {
        fulfillmentId: randomUUID(),
        number: state.posts.length,
        completesOrder: completes,
        orderStatus: completes ? 'shipped' : 'paid',
        replayed: false,
      } satisfies CreateFulfillmentResponse);
    },
  };
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments`, async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, materialsOf(state));
      return;
    }
    const body = route.request().postDataJSON() as CreateFulfillmentRequest;
    state.posts.push(body);
    await state.answer(route, body);
  });
  return { state, listUrls: list.urls };
}

async function openShipDialog(page: Page) {
  await page.getByRole('button', { name: '発送済みにする' }).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const failures = [
  {
    name: '通信が切れた',
    fail: async (route: Route) => {
      await route.abort('failed');
    },
  },
  {
    name: 'サーバーが500を返した',
    fail: async (route: Route) => {
      await fulfillJson(route, { error: '発送の記録に失敗しました。', code: 'failed' } satisfies FulfillmentErrorResponse, 500);
    },
  },
];

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-068 partial fulfillment (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送の画面に商品ごとの印と数が並び、今回送る数は発送準備中の全部が最初から入る', async ({ page }) => {
      // FREQ-439-AC-01
      await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);

      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await expect(inputs.nth(0)).toHaveValue('3');
      await expect(inputs.nth(1)).toHaveValue('2');
      await expect(dialog.getByText('シルクブラウス')).toBeVisible();
      await expect(dialog.getByText('プリーツスカート')).toBeVisible();
      await expect(dialog.getByText('在庫', { exact: true })).toHaveCount(2);
      await expect(dialog.getByText('受注生産', { exact: true })).toHaveCount(0);
      await expect(dialog.getByText('発送準備中').first()).toBeVisible();
      await expect(dialog.getByText('今回送る数', { exact: true }).first()).toBeVisible();
      await expect(dialog.getByText('今回送る数の合計: 5点')).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-ship-dialog-${viewport.width}.png`, animations: 'disabled' });
    });

    test('数を減らして一部だけ発送すると「一部発送済み」と残りを送るボタンが出て、残りを全部発送すると「配送中」になる', async ({ page }) => {
      // FREQ-439-AC-02, FREQ-439-AC-03
      const { state, listUrls } = await mockShipApis(page);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });

      // 1回目: ブラウスを3つのうち2つ、スカートは2つとも
      const first = await openShipDialog(page);
      const firstInputs = first.getByLabel('今回送る数');
      await expect(firstInputs).toHaveCount(2);
      await firstInputs.nth(0).fill('2');
      await expect(first.getByText('今回送る数の合計: 4点')).toBeVisible();
      await first.getByLabel('追跡番号').fill('E2E-PARTIAL');
      await first.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.posts).toHaveLength(1);
      expect(state.posts[0]).toMatchObject({
        carrier: 'yamato',
        trackingNumber: 'E2E-PARTIAL',
        notifyCustomer: true,
        lines: [
          { orderItemId: BLOUSE, quantity: 2 },
          { orderItemId: SKIRT, quantity: 2 },
        ],
      });
      expect(state.posts[0].requestKey).toMatch(UUID_PATTERN);
      // 一覧を読み直して、「一部発送済み」と残りを送るボタンが出る
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
      expect(listUrls.length).toBeGreaterThanOrEqual(2);

      // 2回目: 送り終えたスカートは並ばず、ブラウスの残り1つが最初から入る
      const second = await openShipDialog(page);
      const secondInputs = second.getByLabel('今回送る数');
      await expect(secondInputs).toHaveCount(1);
      await expect(secondInputs.nth(0)).toHaveValue('1');
      await expect(second.getByText('プリーツスカート')).toHaveCount(0);
      await second.getByLabel('追跡番号').fill('E2E-REST');
      await second.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.posts).toHaveLength(2);
      expect(state.posts[1].lines).toEqual([{ orderItemId: BLOUSE, quantity: 1 }]);
      expect(state.posts[1].requestKey).not.toBe(state.posts[0].requestKey);
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('送る数の合計が0なら送らずに理由を出し、他の人が先に発送した時の断りの言葉を画面の中に出す', async ({ page }) => {
      // FREQ-439-AC-04
      const { state } = await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);
      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await dialog.getByLabel('追跡番号').fill('E2E-ZERO');

      await inputs.nth(0).fill('0');
      await inputs.nth(1).fill('0');
      await expect(dialog.getByText('今回送る数の合計: 0点')).toBeVisible();
      await dialog.getByRole('button', { name: '発送する' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: '送る数を入れてください。' })).toBeVisible();
      expect(state.posts).toHaveLength(0);

      // 画面を開いた後に、別の人が同じ品を発送した（窓口は 409 で断る）
      state.answer = async (route) => {
        await fulfillJson(route, { error: EXCEEDS_READY, code: 'quantity_exceeds_ready' } satisfies FulfillmentErrorResponse, 409);
      };
      await inputs.nth(0).fill('3');
      await inputs.nth(1).fill('2');
      await dialog.getByRole('button', { name: '発送する' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: EXCEEDS_READY })).toBeVisible();
      expect(state.posts).toHaveLength(1);
      // 画面は閉じず、入力を直して送り直せる
      await expect(dialog).toBeVisible();
      await expect(inputs.nth(0)).toBeEnabled();
    });

    for (const failure of failures) {
      test(`${failure.name}時は、入力を止めて「もう一度確かめる」だけを出し、同じ重複防止キーで確かめ直す`, async ({ page }) => {
        // FREQ-439-AC-05
        const { state } = await mockShipApis(page);
        // サーバーは1回目を記録していたのに、答えが届かなかった
        state.answer = async (route, body) => {
          recordShipment(state, body);
          await failure.fail(route);
        };
        await openOrderTab(page);
        const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
        const dialog = await openShipDialog(page);
        await expect(dialog.getByLabel('今回送る数')).toHaveCount(2);
        await dialog.getByLabel('追跡番号').fill('E2E-UNKNOWN');
        await dialog.getByRole('button', { name: '発送する' }).click();

        await expect(dialog.getByText(UNKNOWN_OUTCOME)).toBeVisible();
        await expect(dialog.getByRole('button')).toHaveCount(2);
        await expect(dialog.getByRole('button', { name: 'もう一度確かめる' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '閉じる' })).toBeVisible();
        await expect(dialog.locator('input:not([disabled]), select:not([disabled])')).toHaveCount(0);

        // 同じ重複防止キーの送り直しには、前の結果（replayed）が返る
        state.answer = async (route) => {
          await fulfillJson(route, {
            fulfillmentId: randomUUID(),
            number: 1,
            completesOrder: true,
            orderStatus: 'shipped',
            replayed: true,
          } satisfies CreateFulfillmentResponse);
        };
        await dialog.getByRole('button', { name: 'もう一度確かめる' }).click();

        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.posts).toHaveLength(2);
        expect(state.posts[1]).toEqual(state.posts[0]);
        await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      });
    }

    test('発送の関数は、発送準備中の数を超える数・注文に無い商品・中身の違う同じ重複防止キーを断り、同じ中身の送り直しは二重にならず、同時の2つの発送は片方だけが通る（手元の DB）', async () => {
      // FREQ-439-AC-06
      const { orderId, actorId, skirt } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const order = await createOrderWithLines(db, uniqueEmail(`ship-guard-${viewport.name}`), [
          { name: 'E2Eブラウス', quantity: 3, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const other = await createOrderWithLines(db, uniqueEmail(`ship-guard-other-${viewport.name}`), [
          { name: 'E2Eほかの注文', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [blouseId, skirtId] = order.orderItemIds;

        // 発送準備中の数（3）を超える数と、ほかの注文の商品は断られる
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-GUARD-0', lines: [{ orderItemId: blouseId, quantity: 4 }] }),
          'QUANTITY_EXCEEDS_READY',
        );
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-GUARD-0', lines: [{ orderItemId: other.orderItemIds[0], quantity: 1 }] }),
          'LINE_NOT_IN_ORDER',
        );

        // 一部の発送。同じ重複防止キーの送り直しは前の結果（replayed）で、二重に記録しない。中身が違えば断る
        const key = randomUUID();
        const first = await createFulfillment(db, order.orderId, actor, {
          requestKey: key,
          trackingNumber: 'E2E-GUARD-1',
          lines: [{ orderItemId: blouseId, quantity: 2 }],
        });
        expect(first).toMatchObject({ number: 1, completesOrder: false, orderStatus: 'paid', replayed: false });
        const replay = await createFulfillment(db, order.orderId, actor, {
          requestKey: key,
          trackingNumber: 'E2E-GUARD-1',
          lines: [{ orderItemId: blouseId, quantity: 2 }],
        });
        expect(replay).toMatchObject({ fulfillmentId: first.fulfillmentId, number: 1, replayed: true });
        await expectDbError(
          createFulfillment(db, order.orderId, actor, {
            requestKey: key,
            trackingNumber: 'E2E-GUARD-1',
            lines: [{ orderItemId: blouseId, quantity: 1 }],
          }),
          'FULFILLMENT_REQUEST_MISMATCH',
        );
        expect((await lineCounts(db, order.orderId))[blouseId]).toMatchObject({ shipped: 2, readyUnshipped: 1 });
        return { orderId: order.orderId, actorId: actor, skirt: skirtId };
      });

      // 同時の2つの発送（別の接続）。注文の行の鍵で1つずつ進み、後の方は発送準備中の数を超えるので断られる。
      // ブラウスが残っているので、1つ目の後も注文は決済完了のままで、断りの言葉は数の超過になる
      const race = await Promise.allSettled([
        withLocalDb((db) =>
          createFulfillment(db, orderId, actorId, { trackingNumber: 'E2E-RACE-A', lines: [{ orderItemId: skirt, quantity: 1 }] })),
        withLocalDb((db) =>
          createFulfillment(db, orderId, actorId, { trackingNumber: 'E2E-RACE-B', lines: [{ orderItemId: skirt, quantity: 1 }] })),
      ]);
      const rejected = race.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toContain('QUANTITY_EXCEEDS_READY');

      await withLocalDb(async (db) => {
        expect((await lineCounts(db, orderId))[skirt]).toMatchObject({ shipped: 1, readyUnshipped: 0 });
        const alive = await db.query(
          'select count(*)::int as count from public.order_fulfillments where order_id = $1 and cancelled_at is null',
          [orderId],
        );
        expect(alive.rows[0].count).toBe(2);
      });
    });

    test('発送の画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockShipApis(page);
      await openOrderTab(page);
      const dialog = await openShipDialog(page);
      await expect(dialog.getByLabel('今回送る数')).toHaveCount(2);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 4: FR-ADMIN-069（受注生産中と仕上がり）を書く**

`e2e/FR-ADMIN-069-made-to-order-completion.spec.ts`:

```ts
/**
 * FR-ADMIN-069 受注生産中と仕上がりの記録
 * 対応 FREQ: FREQ-440（AC-01〜AC-05）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P11）。受注生産中の品が送れないこと・記録の条件（AC-05）は、
 * 手元の DB の関数を直に呼んで確かめる。仕上がりの画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { OrderHistoryCompletionCancelEntry, OrderHistoryCompletionEntry, OrderHistoryResponse } from '@/lib/orders/email/order-history';
import type {
  CreateFulfillmentRequest,
  CreateFulfillmentResponse,
  FulfillmentErrorResponse,
  RecordCompletionRequest,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import {
  cancelCompletion,
  createActor,
  createFulfillment,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  recordCompletion,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  READY_PROGRESS,
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  historyOf,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a2b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b2b2c3d4-0000-4000-8000-000000000001';
const COAT = 'b2b2c3d4-0000-4000-8000-000000000002';
const COMPLETION_ID = 'c2b2c3d4-0000-4000-8000-000000000001';

/** 窓口の向こうの記録の代わり。ブラウス（在庫の品1つ）とコート（受注生産の品2つ）の、送った数とコートの仕上がった数 */
type MadeState = {
  shipped: Record<string, number>;
  completed: number;
  completionPosts: RecordCompletionRequest[];
  shipPosts: CreateFulfillmentRequest[];
};

function newState(shipped: Record<string, number> = {}, completed = 0): MadeState {
  return { shipped, completed, completionPosts: [], shipPosts: [] };
}

function countsOf(state: MadeState) {
  const blouseShipped = state.shipped[BLOUSE] ?? 0;
  const coatShipped = state.shipped[COAT] ?? 0;
  return [
    { id: BLOUSE, name: 'シルクブラウス', type: 'stock' as const, quantity: 1, shipped: blouseShipped, inProduction: 0, ready: 1 - blouseShipped },
    { id: COAT, name: 'ウールコート', type: 'backorder' as const, quantity: 2, shipped: coatShipped, inProduction: 2 - state.completed, ready: state.completed - coatShipped },
  ];
}

function summaryOf(state: MadeState) {
  const lines = countsOf(state);
  const sum = (pick: (line: (typeof lines)[number]) => number) => lines.reduce((total, line) => total + pick(line), 0);
  const shipped = sum((line) => line.shipped);
  const unshipped = sum((line) => line.quantity - line.shipped);
  return { shipped, unshipped, inProduction: sum((line) => line.inProduction), partiallyShipped: shipped > 0 && unshipped > 0 };
}

function progressOf(state: MadeState): OrderProgress {
  const { unshipped, inProduction, partiallyShipped } = summaryOf(state);
  if (unshipped === 0) return { key: 'in_transit', label: '配送中', partiallyShipped };
  if (inProduction > 0) return { key: 'in_production', label: '受注生産中', partiallyShipped };
  return { ...READY_PROGRESS, partiallyShipped };
}

function rowOf(state: MadeState) {
  const items = countsOf(state).map((line) =>
    orderLine({
      id: line.id, name: line.name, quantity: line.quantity, fulfillmentType: line.type,
      shipped: line.shipped, inProduction: line.inProduction, readyUnshipped: line.ready,
    }));
  const progress = progressOf(state);
  if (progress.key === 'in_transit') {
    return adminOrder({ id: ORDER_ID, items, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false });
  }
  return adminOrder({
    id: ORDER_ID,
    items,
    status: progress.label,
    progressKey: progress.key,
    partiallyShipped: progress.partiallyShipped,
    canRecordCompletion: summaryOf(state).inProduction > 0,
  });
}

function materialsOf(state: MadeState) {
  return shipMaterials({
    orderId: ORDER_ID,
    progress: progressOf(state),
    lines: countsOf(state).map((line) =>
      materialLine({
        orderItemId: line.id, name: line.name, quantity: line.quantity, fulfillmentType: line.type,
        shipped: line.shipped, inProduction: line.inProduction, readyUnshipped: line.ready,
      })),
  });
}

async function mockMadeApis(page: Page, state: MadeState) {
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments`, async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, materialsOf(state));
      return;
    }
    const body = route.request().postDataJSON() as CreateFulfillmentRequest;
    state.shipPosts.push(body);
    for (const line of body.lines) state.shipped[line.orderItemId] = (state.shipped[line.orderItemId] ?? 0) + line.quantity;
    const completes = summaryOf(state).unshipped === 0;
    await fulfillJson(route, {
      fulfillmentId: randomUUID(),
      number: state.shipPosts.length,
      completesOrder: completes,
      orderStatus: completes ? 'shipped' : 'paid',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
  await page.route(`**/api/admin/orders/${ORDER_ID}/completions`, async (route) => {
    const body = route.request().postDataJSON() as RecordCompletionRequest;
    state.completionPosts.push(body);
    for (const line of body.lines) if (line.orderItemId === COAT) state.completed += line.quantity;
    await fulfillJson(route, { completionIds: [COMPLETION_ID], replayed: false } satisfies RecordCompletionResponse);
  });
  return list;
}

async function openShipDialog(page: Page) {
  await page.getByRole('button', { name: '発送済みにする' }).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  await expect(dialog).toBeVisible();
  return dialog;
}

function historyEntries(cancelled: boolean): OrderHistoryResponse['entries'] {
  const completion = {
    type: 'completion',
    at: '2026-10-10T04:00:00.000Z',
    completionId: COMPLETION_ID,
    items: [{ name: 'ウールコート', quantity: 2 }],
    actorEmail: 'admin@example.com',
    cancelled,
    cancellable: !cancelled,
    legacy: false,
  } satisfies OrderHistoryCompletionEntry;
  const cancel = {
    type: 'completion_cancel',
    at: '2026-10-10T05:00:00.000Z',
    completionId: COMPLETION_ID,
    actorEmail: 'admin@example.com',
  } satisfies OrderHistoryCompletionCancelEntry;
  return [
    ...(cancelled ? [cancel] : []),
    completion,
    { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-069 made-to-order completion (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('受注生産の品を含む入金済みの注文は「受注生産中」と出て、発送の画面の最初の数に受注生産中の品は入らない', async ({ page }) => {
      // FREQ-440-AC-01
      await mockMadeApis(page, newState());
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });

      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(row).toContainText('受注生産中 2');
      await expect(row.getByRole('button', { name: '仕上がりを記録する' })).toBeVisible();
      await expect(row.getByRole('button', { name: '発送済みにする' })).toBeVisible();

      const dialog = await openShipDialog(page);
      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await expect(inputs.nth(0)).toHaveValue('1');
      await expect(inputs.nth(1)).toHaveValue('0');
      await expect(dialog.getByText('今回送る数の合計: 1点')).toBeVisible();
      await expect(dialog.getByText('在庫', { exact: true })).toHaveCount(1);
      await expect(dialog.getByText('受注生産', { exact: true })).toHaveCount(1);
      await expect(dialog.getByText('受注生産中 2')).toBeVisible();
      await expect(dialog.getByLabel('仕上がった数')).toHaveCount(1);
      await expect(dialog.getByRole('button', { name: '仕上がりを記録', exact: true })).toBeVisible();
    });

    test('仕上がりの画面で仕上がった数を記録すると、その品は「発送準備中」になる（一部発送済みの印は残る）', async ({ page }) => {
      // FREQ-440-AC-02
      const state = newState({ [BLOUSE]: 1 });
      await mockMadeApis(page, state);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();

      await row.getByRole('button', { name: '仕上がりを記録する' }).click();
      const dialog = page.getByRole('dialog', { name: '仕上がりを記録する' });
      await expect(dialog).toBeVisible();
      // 受注生産中の品だけが並ぶ
      await expect(dialog.getByText('ウールコート')).toBeVisible();
      await expect(dialog.getByText('シルクブラウス')).toHaveCount(0);
      const input = dialog.getByLabel('仕上がった数');
      await expect(input).toHaveCount(1);
      await expect(input).toHaveValue('0');
      await input.fill('2');
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-completion-dialog-${viewport.width}.png`, animations: 'disabled' });
      await dialog.getByRole('button', { name: '記録する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('仕上がりを記録しました。')).toBeVisible();
      expect(state.completionPosts).toHaveLength(1);
      expect(state.completionPosts[0]).toMatchObject({ lines: [{ orderItemId: COAT, quantity: 2 }] });
      expect(state.completionPosts[0].requestKey).toMatch(UUID_PATTERN);
      // 一覧を読み直して、発送準備中になる。受注生産中の数が無いので「仕上がりを記録する」は消える
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '仕上がりを記録する' })).toHaveCount(0);
    });

    test('発送の画面の中でも仕上がりを記録でき、その数が発送準備中に移って送る数を入れられる', async ({ page }) => {
      // FREQ-440-AC-03
      const state = newState();
      await mockMadeApis(page, state);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      const dialog = await openShipDialog(page);

      await dialog.getByLabel('仕上がった数').fill('2');
      await dialog.getByRole('button', { name: '仕上がりを記録', exact: true }).click();
      await expect.poll(() => state.completionPosts.length).toBe(1);
      expect(state.completionPosts[0].lines).toEqual([{ orderItemId: COAT, quantity: 2 }]);
      // 画面の中で材料を読み直し、受注生産中の表示は消える
      await expect(dialog.getByText('受注生産中 2')).toHaveCount(0);

      const inputs = dialog.getByLabel('今回送る数');
      await expect(inputs).toHaveCount(2);
      await inputs.nth(0).fill('1');
      await inputs.nth(1).fill('2');
      await expect(dialog.getByText('今回送る数の合計: 3点')).toBeVisible();
      await dialog.getByLabel('追跡番号').fill('E2E-MTO');
      await dialog.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.shipPosts).toHaveLength(1);
      expect(state.shipPosts[0].lines).toEqual([
        { orderItemId: BLOUSE, quantity: 1 },
        { orderItemId: COAT, quantity: 2 },
      ]);
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
    });

    test('履歴から仕上がりを取り消すと受注生産中に戻る。送った数を下回る取消は断られる', async ({ page }) => {
      // FREQ-440-AC-04
      const state = newState({}, 2);
      let cancelled = false;
      let refuse = false;
      const cancelPosts: string[] = [];
      const list = await mockMadeApis(page, state);
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
        fulfillJson(route, historyOf(ORDER_ID, historyEntries(cancelled))));
      await page.route(`**/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`, async (route) => {
        cancelPosts.push(route.request().url());
        if (refuse) {
          await fulfillJson(route, { error: 'もう発送した数があるため、取り消せません。', code: 'completion_already_shipped' } satisfies FulfillmentErrorResponse, 409);
          return;
        }
        cancelled = true;
        state.completed = 0;
        await fulfillJson(route, { outcome: 'cancelled' });
      });
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
      const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
      const entry = dialog.getByRole('listitem').filter({ hasText: '受注生産の品が仕上がりました' });
      await expect(entry).toContainText('ウールコート');
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-history-completion-${viewport.width}.png`, animations: 'disabled' });

      // 送った数を下回る取消（窓口が 409 で断る）は、理由が確かめの画面に出て、記録は変わらない
      refuse = true;
      await entry.getByRole('button', { name: 'この仕上がりを取り消す' }).click();
      await expect(page.getByText('この仕上がりを取り消し、その商品を受注生産中に戻します。')).toBeVisible();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(page.getByText('もう発送した数があるため、取り消せません。')).toBeVisible();
      expect(cancelPosts).toHaveLength(1);
      expect(cancelled).toBe(false);
      await page.getByRole('button', { name: 'やめる', exact: true }).click();

      // 取り消せる時は、取り消すと履歴に残り、一覧が読み直されて受注生産中に戻る
      refuse = false;
      const before = list.urls.length;
      await entry.getByRole('button', { name: 'この仕上がりを取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(dialog.getByRole('listitem').filter({ hasText: '仕上がりを取り消しました' })).toHaveCount(1);
      await expect(entry.getByRole('button', { name: 'この仕上がりを取り消す' })).toHaveCount(0);
      expect(cancelPosts).toHaveLength(2);
      await expect.poll(() => list.urls.length).toBeGreaterThan(before);
      await page.keyboard.press('Escape');
      await expect(row.getByText('受注生産中', { exact: true })).toBeVisible();
    });

    test('受注生産中の品は仕上がりを記録するまで送れず、記録は決済完了の注文の受注生産の品だけで、送った数を下回る取消は断られる（手元の DB）', async () => {
      // FREQ-440-AC-05
      await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const order = await createOrderWithLines(db, uniqueEmail(`mto-${viewport.name}`), [
          { name: 'E2Eブラウス', quantity: 1, fulfillmentType: 'stock' },
          { name: 'E2Eコート', quantity: 2, fulfillmentType: 'backorder' },
        ]);
        const [blouse, coat] = order.orderItemIds;

        // 仕上がりの前は、受注生産の品を送れない。在庫の品は先に送れる（一部の発送）
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ inProduction: 2, readyUnshipped: 0, shipped: 0 });
        await expectDbError(
          createFulfillment(db, order.orderId, actor, { trackingNumber: 'E2E-MTO-0', lines: [{ orderItemId: coat, quantity: 1 }] }),
          'QUANTITY_EXCEEDS_READY',
        );
        const stockShipment = await createFulfillment(db, order.orderId, actor, {
          trackingNumber: 'E2E-MTO-1',
          lines: [{ orderItemId: blouse, quantity: 1 }],
        });
        expect(stockShipment).toMatchObject({ completesOrder: false, orderStatus: 'paid' });

        // 記録できるのは受注生産の品の、受注生産中の数まで
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: blouse, quantity: 1 }]), 'LINE_NOT_IN_PRODUCTION');
        await expectDbError(recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 3 }]), 'QUANTITY_EXCEEDS_IN_PRODUCTION');
        const recorded = await recordCompletion(db, order.orderId, actor, [{ orderItemId: coat, quantity: 2 }]);
        expect(recorded).toHaveLength(1);
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ completed: 2, inProduction: 0, readyUnshipped: 2 });

        // 記録の後は送れる。送った数を下回る取消は断られ、数は変わらない
        const coatShipment = await createFulfillment(db, order.orderId, actor, {
          trackingNumber: 'E2E-MTO-2',
          lines: [{ orderItemId: coat, quantity: 1 }],
        });
        expect(coatShipment).toMatchObject({ number: 2, completesOrder: false });
        await expectDbError(cancelCompletion(db, order.orderId, recorded[0].completionId, actor), 'COMPLETION_ALREADY_SHIPPED');
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ completed: 2, shipped: 1 });

        // まだ送っていない仕上がりは取り消せ、2回目は変わらず already_cancelled
        const waiting = await createOrderWithLines(db, uniqueEmail(`mto-cancel-${viewport.name}`), [
          { name: 'E2Eコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [waitingCoat] = waiting.orderItemIds;
        const [done] = await recordCompletion(db, waiting.orderId, actor, [{ orderItemId: waitingCoat, quantity: 1 }]);
        expect(await cancelCompletion(db, waiting.orderId, done.completionId, actor)).toBe('cancelled');
        expect((await lineCounts(db, waiting.orderId))[waitingCoat]).toMatchObject({ inProduction: 1, readyUnshipped: 0 });
        expect(await cancelCompletion(db, waiting.orderId, done.completionId, actor)).toBe('already_cancelled');

        // 入金の前（未決済）は仕上がりを記録できない
        const unpaid = await createOrderWithLines(
          db,
          uniqueEmail(`mto-unpaid-${viewport.name}`),
          [{ name: 'E2Eコート', quantity: 1, fulfillmentType: 'backorder' }],
          { status: 'pending' },
        );
        await expectDbError(
          recordCompletion(db, unpaid.orderId, actor, [{ orderItemId: unpaid.orderItemIds[0], quantity: 1 }]),
          'ORDER_NOT_IN_PRODUCTION',
        );
      });
    });

    test('仕上がりの画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockMadeApis(page, newState());
      await openOrderTab(page);
      await page.getByRole('button', { name: '仕上がりを記録する' }).click();
      const dialog = page.getByRole('dialog', { name: '仕上がりを記録する' });
      await expect(dialog.getByLabel('仕上がった数')).toHaveCount(1);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 5: FR-ADMIN-070（注文の進み具合の言葉）を書く**

`e2e/FR-ADMIN-070-order-progress-labels.spec.ts`:

```ts
/**
 * FR-ADMIN-070 注文の進み具合の言葉
 * 対応 FREQ: FREQ-441（AC-01〜AC-03）
 *
 * 管理画面の注文の一覧とお客様の購入履歴の一覧に出る言葉を、窓口を差し替えて確かめる。
 * 管理画面の絞り込みは DB の状態で働く（窓口は status=paid・status=shipped、2つ以上選んだ時は画面が orderStatus で絞る）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { adminOrder, mockAdminSession, mockOrderList, openOrderTab, orderLine, viewports } from './order-fulfillment-test-utils';

const ORDERS = [
  adminOrder({
    // 取消のボタンを出さない（出すと、絞り込みの「キャンセル」と同じ名前のボタンが2つになる）
    id: 'order-unpaid', customerName: '未決済 太郎', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid',
    canShip: false,
  }),
  adminOrder({
    id: 'order-production', customerName: '受注 次郎', status: '受注生産中', progressKey: 'in_production', canRecordCompletion: true,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000001', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, inProduction: 2, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-ready', customerName: '準備 三郎',
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000002', name: 'シルクブラウス', quantity: 1, readyUnshipped: 1 })],
  }),
  adminOrder({
    id: 'order-partial', customerName: '一部 四郎', status: '受注生産中', progressKey: 'in_production', partiallyShipped: true,
    canRecordCompletion: true,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000003', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, shipped: 1, inProduction: 1, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-transit', customerName: '配送 五郎', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000004', name: 'リネンシャツ', quantity: 1, shipped: 1, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-cancelled', customerName: '取消 六郎', status: 'キャンセル', orderStatus: 'cancelled', progressKey: 'cancelled', canShip: false,
  }),
];

const CHIPS = [
  'すべて',
  '支払い手続き中',
  '未決済',
  '発送待ち（受注生産中・発送準備中）',
  '発送済み（配送中・配達済み）',
  '決済失敗',
  '放棄',
  'キャンセル',
];

function lastUrl(urls: string[]): string {
  return urls[urls.length - 1] ?? '';
}

function orderRow(page: Page, id: string) {
  return page.getByRole('row', { name: new RegExp(id) });
}

async function openCustomerOrders(page: Page): Promise<void> {
  await mockOtpAuthentication(page);
  // ACCOUNT は配送先も取得する。実 API の 401 → refresh で認証モックが失効しないよう固定する
  await page.route('**/api/profile/addresses', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ addresses: [] }) }));
  await page.route('**/api/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'user@example.com', fullName: '山田 花子', kanaName: 'ヤマダ ハナコ', phone: '090-1111-2222', address: {} }),
    }));
  const customerOrder = (id: string, orderNumber: string, status: string) => ({
    id, orderNumber, orderDate: '2026/10/05', status, totalAmount: '¥28,800', itemCount: 1, items: [], detailHref: `/account/orders/${id}`,
  });
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          customerOrder('order-1', 'LFH-261005-00001', '受注生産中'),
          customerOrder('order-2', 'LFH-261005-00002', '発送準備中'),
          customerOrder('order-3', 'LFH-261005-00003', '配送中'),
          customerOrder('order-4', 'LFH-261005-00004', '未決済'),
        ],
      }),
    }));
  await page.goto('/account?tab=orders');
  await expect(page.getByText('LFH-261005-00001')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-070 order progress labels (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('管理画面の一覧に、未決済・受注生産中・発送準備中・配送中の言葉と、一部発送済みの印が出る', async ({ page }) => {
      // FREQ-441-AC-01
      await mockAdminSession(page);
      await mockOrderList(page, () => ORDERS);
      await openOrderTab(page);
      await expect(orderRow(page, 'order-unpaid')).toBeVisible();

      const words: Array<[string, string]> = [
        ['order-unpaid', '未決済'],
        ['order-production', '受注生産中'],
        ['order-ready', '発送準備中'],
        ['order-partial', '受注生産中'],
        ['order-transit', '配送中'],
        ['order-cancelled', 'キャンセル'],
      ];
      for (const [id, word] of words) {
        await expect(orderRow(page, id).getByText(word, { exact: true })).toBeVisible();
      }
      // 「一部発送済み」の印は、一部だけ送った注文にだけ付く
      await expect(orderRow(page, 'order-partial').getByText('一部発送済み', { exact: true })).toBeVisible();
      for (const id of ['order-unpaid', 'order-production', 'order-ready', 'order-transit', 'order-cancelled']) {
        await expect(orderRow(page, id).getByText('一部発送済み', { exact: true })).toHaveCount(0);
      }
      // 商品の欄は、0でない数だけを括弧の中に出す
      await expect(orderRow(page, 'order-partial')).toContainText(/ウールコート（ホワイト \/ M）\s*×\s*2/);
      await expect(orderRow(page, 'order-partial')).toContainText('受注生産中 1・発送済み 1');
      // 受注生産中の数がある注文にだけ「仕上がりを記録する」が出る
      await expect(orderRow(page, 'order-production').getByRole('button', { name: '仕上がりを記録する' })).toBeVisible();
      await expect(orderRow(page, 'order-ready').getByRole('button', { name: '仕上がりを記録する' })).toHaveCount(0);
      await page.screenshot({ path: `test-results/group-e1/order-list-labels-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('絞り込みの名前が決めた8つになり、DB の状態（paid・shipped）で働く', async ({ page }) => {
      // FREQ-441-AC-02
      await mockAdminSession(page);
      const list = await mockOrderList(page, () => ORDERS);
      await openOrderTab(page);
      await expect(orderRow(page, 'order-unpaid')).toBeVisible();

      for (const name of CHIPS) {
        await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: '決済完了', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '発送済み', exact: true })).toHaveCount(0);

      const waiting = page.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）', exact: true });
      const sent = page.getByRole('button', { name: '発送済み（配送中・配達済み）', exact: true });

      // 1つだけ選ぶと、DB の状態で窓口を絞る
      await waiting.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastUrl(list.urls)).toContain('status=paid');

      // 2つ選ぶと窓口は status を送らず、画面が DB の状態で絞る（窓口の答えは全部の行を返しているままでも、絞られる）
      await sent.click();
      await expect.poll(() => lastUrl(list.urls)).not.toContain('status=');
      await expect(orderRow(page, 'order-unpaid')).toHaveCount(0);
      await expect(orderRow(page, 'order-cancelled')).toHaveCount(0);
      for (const id of ['order-production', 'order-ready', 'order-partial', 'order-transit']) {
        await expect(orderRow(page, id)).toBeVisible();
      }

      // 発送済みだけにすると、配送中の注文だけが残り、窓口には status=shipped を送る
      await waiting.click();
      await expect.poll(() => lastUrl(list.urls)).toContain('status=shipped');
      await expect(orderRow(page, 'order-transit')).toBeVisible();
      await expect(orderRow(page, 'order-ready')).toHaveCount(0);
    });

    test('お客様の購入履歴の一覧にも、同じ言葉が出る', async ({ page }) => {
      // FREQ-441-AC-03
      await openCustomerOrders(page);

      const expected: Array<[string, string]> = [
        ['LFH-261005-00001', '受注生産中'],
        ['LFH-261005-00002', '発送準備中'],
        ['LFH-261005-00003', '配送中'],
        ['LFH-261005-00004', '未決済'],
      ];
      for (const [orderNumber, word] of expected) {
        const row = page.getByRole('link', { name: new RegExp(orderNumber) });
        await expect(row.getByText(word, { exact: true })).toBeVisible();
      }
    });
  });
}
```

- [ ] **Step 6: FR-ADMIN-071（発送ごとの発送のお知らせ）を書く**

`e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts`:

```ts
/**
 * FR-ADMIN-071 発送ごとの発送のお知らせ
 * 対応 FREQ: FREQ-442（AC-01〜AC-04）
 *
 * 管理画面の発送の操作の代わりに、手元の DB の発送の関数を直に呼び、worker の定期処理の入口を叩き、
 * 手元のメール受け（Mailpit）に届いたメールを数えて確かめる（実装計画 P11。FR-ADMIN-066 と同じやり方）。
 */
import { expect, test } from '@playwright/test';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  mailBodies,
  mailsTo,
  outboxRows,
  recordCompletion,
  runWorkerOnce,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';

const SHIPPED_SUBJECT = '商品を発送いたしました';
const REMAINING = '残りの商品は、準備ができ次第お送りします。';

/** 送信済みになった発送のメールの数。メールが着いてから行が送信済みになるまでの、わずかな差を待つために使う */
async function sentShipped(orderId: string): Promise<number> {
  const rows = await withLocalDb((db) => outboxRows(db, orderId));
  return rows.filter((row) => row.status === 'sent').length;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-071 fulfillment shipping email (${viewport.name})`, () => {
    test('発送ごとに発送のメールが1通届き、その発送の商品と数だけが書いてあり、残りの案内は最初の発送のメールにだけ入る（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-442-AC-01, FREQ-442-AC-02, FREQ-442-AC-03
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-split-${viewport.name}`);
      const context = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E在庫のシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2E受注生産のコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [shirt, coat] = order.orderItemIds;
        await recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 1 }]);
        // 1回目: 在庫のシャツだけ。コートが残る
        const first = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-SPLIT-1',
          carrier: 'yamato',
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        expect(first).toMatchObject({ number: 1, completesOrder: false, orderStatus: 'paid' });
        return { actorId, orderId: order.orderId, coat, first };
      });
      await runWorkerUntil(request, async () => (await sentShipped(context.orderId)) >= 1, '1回目の発送のメールが送信済みになること');

      // 2回目: 仕上がったコート。全部送り終わる
      const second = await withLocalDb((db) =>
        createFulfillment(db, context.orderId, context.actorId, {
          trackingNumber: 'E2E-SPLIT-2',
          carrier: 'sagawa',
          lines: [{ orderItemId: context.coat, quantity: 1 }],
        }));
      expect(second).toMatchObject({ number: 2, completesOrder: true, orderStatus: 'shipped' });
      await runWorkerUntil(request, async () => (await sentShipped(context.orderId)) >= 2, '2回目の発送のメールが送信済みになること');

      // 発送ごとに1通（注文で1通ではない）。件名は決まった文と注文番号だけ
      const mails = await mailBodies(request, email, SHIPPED_SUBJECT);
      expect(mails).toHaveLength(2);
      for (const mail of mails) {
        expect(mail.Subject).toBe(`【Le Fil des Heures】${SHIPPED_SUBJECT}（${orderNumberOf(context.orderId)}）`);
      }
      const firstMail = mails.filter((mail) => mail.Text.includes('E2E-SPLIT-1'));
      const secondMail = mails.filter((mail) => mail.Text.includes('E2E-SPLIT-2'));
      expect(firstMail).toHaveLength(1);
      expect(secondMail).toHaveLength(1);

      // 1回目: 送った商品と数・配送業者・残りの案内。まだ送っていないコートと、値段は書かない
      expect(firstMail[0].Text).toMatch(/E2E在庫のシャツ[^\n]*x2/);
      expect(firstMail[0].Text).toContain('ヤマト運輸');
      expect(firstMail[0].Text).toContain(REMAINING);
      expect(firstMail[0].Text).not.toContain('E2E受注生産のコート');
      expect(firstMail[0].Text).not.toMatch(/[¥￥]/);
      // 2回目: コートだけ。全部送ったので、残りの案内は無い
      expect(secondMail[0].Text).toMatch(/E2E受注生産のコート[^\n]*x1/);
      expect(secondMail[0].Text).toContain('佐川急便');
      expect(secondMail[0].Text).not.toContain(REMAINING);
      expect(secondMail[0].Text).not.toContain('E2E在庫のシャツ');
      expect(secondMail[0].Text).not.toMatch(/[¥￥]/);

      // 注文のメールの表には、発送ごとに1行（自動）。履歴は何回目かを返す
      expect(await withLocalDb((db) => outboxRows(db, context.orderId))).toEqual([
        { fulfillment_id: context.first.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
        { fulfillment_id: second.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      const history = await withLocalDb(async (db) =>
        (await db.query(
          "select fulfillment_number from public.list_order_email_history($1::uuid) where kind = 'shipped' order by fulfillment_number",
          [context.orderId],
        )).rows);
      expect(history).toEqual([{ fulfillment_number: 1 }, { fulfillment_number: 2 }]);
    });

    test('知らせない発送にはメールが届かず、知らせる発送の分だけ1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-442-AC-04
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-mixed-${viewport.name}`);
      const { orderId, notified } = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' },
          { name: 'E2E在庫のスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [shirt, skirt] = order.orderItemIds;
        const silent = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-SILENT-1',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 1 }],
        });
        const notifiedShipment = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-NOTIFIED-2',
          carrier: 'japanpost',
          notify: true,
          lines: [{ orderItemId: skirt, quantity: 1 }],
        });
        expect(silent).toMatchObject({ number: 1, completesOrder: false });
        expect(notifiedShipment).toMatchObject({ number: 2, completesOrder: true });
        return { orderId: order.orderId, notified: notifiedShipment };
      });

      await runWorkerUntil(request, async () => (await sentShipped(orderId)) >= 1, '知らせる発送のメールが送信済みになること');
      // 知らせない発送の行は書かれず、知らせる発送の行だけがある
      expect(await withLocalDb((db) => outboxRows(db, orderId))).toEqual([
        { fulfillment_id: notified.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      // もう一度動かしても、メールは増えない
      await runWorkerOnce(request);
      const mails = await mailBodies(request, email, SHIPPED_SUBJECT);
      expect(mails).toHaveLength(1);
      expect(mails[0].Text).toContain('E2E-NOTIFIED-2');
      expect(mails[0].Text).toContain('日本郵便');
      expect(mails[0].Text).toContain('E2E在庫のスカート');
      expect(mails[0].Text).not.toContain('E2E-SILENT-1');
      expect(mails[0].Text).not.toContain('E2E在庫のシャツ');
      expect(mails[0].Text).not.toContain(REMAINING);
      expect(await mailsTo(request, email)).toHaveLength(1);
    });
  });
}
```

- [ ] **Step 7: FR-ADMIN-072（発送の取消）を書く**

`e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts`:

```ts
/**
 * FR-ADMIN-072 発送の取消
 * 対応 FREQ: FREQ-443（AC-01〜AC-04）
 *
 * 履歴の画面の操作は窓口を差し替えて確かめる（実装計画 P11）。取消が数・注文の状態・送る前のメールに及ぶこと（AC-03・AC-04）は、
 * 手元の DB の関数・worker の定期処理の入口・Mailpit で確かめる。履歴の画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type {
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentCancelEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import type { CancelFulfillmentResponse, FulfillmentErrorResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  cancelFulfillment,
  createActor,
  createFulfillment,
  createOrderWithLines,
  lineCounts,
  mailsTo,
  orderState,
  outboxRows,
  recordCompletion,
  runWorkerOnce,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a3b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b3b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'b3b2c3d4-0000-4000-8000-000000000002';
const FULFILLMENT_ID = 'f3b2c3d4-0000-4000-8000-000000000001';
const CONFIRM =
  '発送（1回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。';
const REFUSAL = 'この発送は取り消せません。注文の状態を確かめてください。';
const SHIPPED_SUBJECT = '商品を発送いたしました';

type CancelState = { cancelled: boolean; refuse: boolean; posts: string[] };

function entriesOf(state: CancelState): OrderHistoryResponse['entries'] {
  const shipment = {
    type: 'fulfillment',
    at: '2026-10-10T03:00:00.000Z',
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678-9012',
    items: [{ name: 'シルクブラウス', quantity: 2 }],
    actorEmail: 'admin@example.com',
    notifyCustomer: true,
    completesOrder: false,
    cancelled: state.cancelled,
    cancellable: !state.cancelled,
    legacy: false,
  } satisfies OrderHistoryFulfillmentEntry;
  const mail = {
    type: 'email',
    at: '2026-10-10T03:00:01.000Z',
    emailId: 'e3b2c3d4-0000-4000-8000-000000000001',
    kind: 'shipped',
    kindLabel: '発送（1回目）',
    manual: false,
    requestedByEmail: null,
    stateLabel: '配達済み',
    warning: false,
    attempts: 1,
    errorLabel: null,
    sentAt: '2026-10-10T03:00:05.000Z',
    deliveryEventAt: '2026-10-10T03:01:00.000Z',
    canViewContent: true,
    bodyErased: false,
    resendable: !state.cancelled,
    fulfillmentId: FULFILLMENT_ID,
    fulfillmentNumber: 1,
  } satisfies OrderHistoryEmailEntry;
  const cancel = {
    type: 'fulfillment_cancel',
    at: '2026-10-10T04:00:00.000Z',
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    actorEmail: 'admin@example.com',
  } satisfies OrderHistoryFulfillmentCancelEntry;
  return [
    ...(state.cancelled ? [cancel] : []),
    mail,
    shipment,
    { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
}

function rowOf(state: CancelState) {
  const blouseShipped = state.cancelled ? 0 : 2;
  return adminOrder({
    id: ORDER_ID,
    items: [
      orderLine({ id: BLOUSE, name: 'シルクブラウス', quantity: 2, shipped: blouseShipped, readyUnshipped: 2 - blouseShipped }),
      orderLine({ id: SKIRT, name: 'プリーツスカート', quantity: 1, readyUnshipped: 1 }),
    ],
    partiallyShipped: !state.cancelled,
  });
}

async function mockCancelApis(page: Page) {
  const state: CancelState = { cancelled: false, refuse: false, posts: [] };
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, historyOf(ORDER_ID, entriesOf(state))));
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`, async (route) => {
    state.posts.push(route.request().url());
    if (state.refuse) {
      await fulfillJson(route, { error: REFUSAL, code: 'fulfillment_cancel_not_allowed' } satisfies FulfillmentErrorResponse, 409);
      return;
    }
    state.cancelled = true;
    await fulfillJson(route, { outcome: 'cancelled', orderStatus: 'paid' } satisfies CancelFulfillmentResponse);
  });
  return { state, listUrls: list.urls };
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
  const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 送信済みになった発送のメールの数 */
async function sentShipped(orderId: string): Promise<number> {
  const rows = await withLocalDb((db) => outboxRows(db, orderId));
  return rows.filter((row) => row.status === 'sent').length;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-072 fulfillment cancel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('履歴の発送の行から取り消すと、取消の行が履歴に残り、取り消した発送には取消もメールの再送も出ず、一覧が読み直される', async ({ page }) => {
      // FREQ-443-AC-01
      const { state, listUrls } = await mockCancelApis(page);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();

      const dialog = await openHistory(page);
      const shipment = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });
      await expect(shipment).toContainText('発送（1回目）');
      await expect(shipment).toContainText('1234-5678-9012');
      await expect(shipment).toContainText('シルクブラウス');
      await expect(dialog.getByRole('listitem').filter({ hasText: '発送（1回目）のメール' })).toHaveCount(1);
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-history-fulfillment-${viewport.width}.png`, animations: 'disabled' });

      const before = listUrls.length;
      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await expect(page.getByText(CONFIRM)).toBeVisible();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();

      await expect(dialog.getByRole('listitem').filter({ hasText: '発送（1回目）を取り消しました' })).toHaveCount(1);
      expect(state.posts).toEqual([expect.stringContaining(`/fulfillments/${FULFILLMENT_ID}/cancel`)]);
      await expect(shipment.getByRole('button', { name: 'この発送を取り消す' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);
      await expect.poll(() => listUrls.length).toBeGreaterThan(before);
      await page.keyboard.press('Escape');
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
    });

    test('「やめる」では取り消さず、窓口が取消を断った時は理由が確かめの画面の中に出る', async ({ page }) => {
      // FREQ-443-AC-02
      const { state } = await mockCancelApis(page);
      await openOrderTab(page);
      const dialog = await openHistory(page);
      const shipment = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });

      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await expect(page.getByText(CONFIRM)).toBeVisible();
      await page.getByRole('button', { name: 'やめる', exact: true }).click();
      expect(state.posts).toHaveLength(0);
      await expect(shipment.getByRole('button', { name: 'この発送を取り消す' })).toBeVisible();

      state.refuse = true;
      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(page.getByText(REFUSAL)).toBeVisible();
      expect(state.posts).toHaveLength(1);
      await expect(page.getByText('発送（1回目）を取り消しました')).toHaveCount(0);
    });

    test('履歴の画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockCancelApis(page);
      await openOrderTab(page);
      const dialog = await openHistory(page);
      await expect(dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('発送を取り消すと商品が発送準備中に戻り、全部送っていた注文は決済完了に戻り、送る前のメールは取りやめになり、取消のメールは行かない（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-443-AC-03, FREQ-443-AC-04
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-cancel-${viewport.name}`);
      const setup = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E取消のシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2E取消のコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [shirt, coat] = order.orderItemIds;
        await recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 1 }]);
        const first = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-CANCEL-1',
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        const second = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-CANCEL-2',
          carrier: 'sagawa',
          lines: [{ orderItemId: coat, quantity: 1 }],
        });
        expect(second).toMatchObject({ number: 2, completesOrder: true, orderStatus: 'shipped' });
        return { actorId, orderId: order.orderId, shirt, coat, first, second };
      });

      // 全部を送っていた注文の2回目の発送を、メールが送られる前に取り消す
      const cancelled = await withLocalDb((db) => cancelFulfillment(db, setup.orderId, setup.second.fulfillmentId, setup.actorId));
      expect(cancelled).toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
      await withLocalDb(async (db) => {
        // 決済完了に戻り、全部を送った時の値は空になる。コートは発送準備中に戻る
        expect(await orderState(db, setup.orderId)).toMatchObject({
          status: 'paid',
          shipped_at: null,
          shipping_carrier: null,
          tracking_number: null,
        });
        expect((await lineCounts(db, setup.orderId))[setup.coat]).toMatchObject({ shipped: 0, readyUnshipped: 1 });
        // まだ送っていないその発送のメールは取りやめ
        const rows = await outboxRows(db, setup.orderId);
        expect(rows.find((row) => row.fulfillment_id === setup.second.fulfillmentId)).toMatchObject({
          status: 'skipped',
          last_error_code: 'fulfillment_cancelled',
        });
      });
      // 2回目の取消は、何度押しても同じ結果
      expect(await withLocalDb((db) => cancelFulfillment(db, setup.orderId, setup.second.fulfillmentId, setup.actorId))).toMatchObject({
        outcome: 'already_cancelled',
      });

      // 取り消していない1回目のメールだけが届く
      await runWorkerUntil(request, async () => (await sentShipped(setup.orderId)) >= 1, '取り消していない発送のメールが送信済みになること');
      const delivered = await mailsTo(request, email);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].Subject).toContain(SHIPPED_SUBJECT);

      // 送った後に取り消しても、お客様にメールは行かない（取消のメールの行も書かれない）
      const afterSent = await withLocalDb((db) => cancelFulfillment(db, setup.orderId, setup.first.fulfillmentId, setup.actorId));
      expect(afterSent.outcome).toBe('cancelled');
      await runWorkerOnce(request);
      expect(await mailsTo(request, email)).toHaveLength(1);
      await withLocalDb(async (db) => {
        expect(await outboxRows(db, setup.orderId, 'canceled')).toHaveLength(0);
        expect((await outboxRows(db, setup.orderId)).find((row) => row.fulfillment_id === setup.first.fulfillmentId)).toMatchObject({
          status: 'sent',
        });
        expect((await lineCounts(db, setup.orderId))[setup.shirt]).toMatchObject({ shipped: 0, readyUnshipped: 2 });

        // 取り消した分の番号は使い回さない。コートを送り直すと3回目になる
        const reshipped = await createFulfillment(db, setup.orderId, setup.actorId, {
          trackingNumber: 'E2E-CANCEL-3',
          lines: [{ orderItemId: setup.coat, quantity: 1 }],
        });
        expect(reshipped).toMatchObject({ number: 3, completesOrder: false });
      });
    });
  });
}
```

- [ ] **Step 8: お客様の注文の画面の道具と FR-ACCOUNT-032 を書く**

`e2e/order-detail-fixtures.ts`:

```ts
/**
 * お客様の注文の窓口（GET /api/orders/[id]）の答えのうち、グループ E-1 で足した所（進み具合・発送ごとの配送情報・商品ごとの数）。
 * 古い注文詳細の写しに足して使う。形は共通の約束（実装計画 C-2、Task 8）に合わせる。
 */
import type { OrderProgressKey, OrderProgressStep, OrderProgressStepKey } from '@/lib/orders/order-progress';

export type DetailProgress = {
  key: OrderProgressKey;
  label: string;
  partiallyShipped: boolean;
  steps: OrderProgressStep[] | null;
};

export type DetailShipment = {
  id: string;
  number: number;
  shippedAt: string;
  carrier: string | null;
  carrierLabel: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: Array<{ orderItemId: string; name: string; color: string | null; size: string | null; quantity: number }>;
};

const STEP_LABELS: Record<OrderProgressStepKey, string> = {
  payment: 'お支払い',
  in_production: '受注生産中',
  ready: '発送準備中',
  in_transit: '配送中',
  delivered: '配達済み',
};

/** 進み具合。withProduction は受注生産の品を含む注文（5段）。current が今の段で、それより前は済み、後はこれから */
export function progressOf(input: {
  key: OrderProgressKey;
  label: string;
  current: OrderProgressStepKey;
  withProduction?: boolean;
  partiallyShipped?: boolean;
}): DetailProgress {
  const order: OrderProgressStepKey[] = input.withProduction
    ? ['payment', 'in_production', 'ready', 'in_transit', 'delivered']
    : ['payment', 'ready', 'in_transit', 'delivered'];
  const at = order.indexOf(input.current);
  return {
    key: input.key,
    label: input.label,
    partiallyShipped: input.partiallyShipped ?? false,
    steps: order.map(
      (stepKey, index): OrderProgressStep => ({
        key: stepKey,
        label: STEP_LABELS[stepKey],
        state: index < at ? 'done' : index === at ? 'current' : 'todo',
      }),
    ),
  };
}

/** 発送ごとの配送情報（既定は、ヤマト運輸で送ったシルクブラウス1つ） */
export function shipmentOf(overrides: Partial<DetailShipment> & { number: number }): DetailShipment {
  return {
    id: `f4b2c3d4-0000-4000-8000-00000000000${overrides.number}`,
    shippedAt: '2026-10-05T00:00:00.000Z',
    carrier: 'yamato',
    carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678-9012',
    trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
    items: [{ orderItemId: 'item-1', name: 'シルクブラウス', color: 'ホワイト', size: 'M', quantity: 1 }],
    ...overrides,
  };
}

/** 在庫の品だけの入金済みの注文（発送準備中）の進み具合 */
export const STOCK_READY_PROGRESS = progressOf({ key: 'ready', label: '発送準備中', current: 'ready' });

/** 在庫の品だけで、全部を送った注文（配送中）の進み具合 */
export const STOCK_IN_TRANSIT_PROGRESS = progressOf({ key: 'in_transit', label: '配送中', current: 'in_transit' });

/** 古い注文詳細の写し（在庫の品だけの入金済み）に、E-1 で足した所を足す。商品は全部、発送準備中の数に入る */
export function withReadyProgress<T extends { items: Array<{ quantity: number }> }>(detail: T) {
  return {
    ...detail,
    items: detail.items.map((item) => ({
      ...item,
      shippedQuantity: 0,
      readyQuantity: item.quantity,
      inProductionQuantity: 0,
    })),
    progress: STOCK_READY_PROGRESS,
    shipments: [] as DetailShipment[],
  };
}
```

`e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts`:

```ts
/**
 * FR-ACCOUNT-032 お客様の注文の画面の進み具合と、発送ごとの配送情報
 * 対応 FREQ: FREQ-444（AC-01〜AC-04）
 *
 * 窓口（GET /api/orders/[id]）の答えを差し替えて、画面を確かめる。答えの形は共通の約束（実装計画 C-2、Task 8）。
 * 段のラベルの色（済み・今は text-black、これからは text-[#999]）は、今の画面（FR-ACCOUNT-015）から引き継ぐ。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { progressOf, shipmentOf } from './order-detail-fixtures';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'order-1';
const STEP_LABELS = ['お支払い', '受注生産中', '発送準備中', '配送中', '配達済み'] as const;

const BASE = {
  id: ORDER_ID,
  orderNumber: 'ORD-0001',
  orderDate: '2026/10/01 09:00',
  subtotalAmount: '¥60,000',
  shippingAmount: '¥500',
  discountAmount: '¥0',
  totalAmount: '¥60,500',
  paymentMethod: 'クレジットカード',
  shippingFullName: '山田 花子',
  shippingEmail: 'user@example.com',
  shippingPhone: '090-1111-2222',
  shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
};

function line(input: {
  id: string;
  name: string;
  quantity: number;
  shippedQuantity?: number;
  readyQuantity?: number;
  inProductionQuantity?: number;
}) {
  return {
    itemId: 10,
    imageUrl: null,
    color: 'ホワイト',
    size: 'M',
    amount: '¥20,000',
    stockStatus: 'in_stock',
    shippedQuantity: 0,
    readyQuantity: 0,
    inProductionQuantity: 0,
    ...input,
  };
}

async function openDetail(page: Page, detail: unknown): Promise<void> {
  await mockOtpAuthentication(page);
  await page.route(`**/api/orders/${ORDER_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));
  await page.goto(`/account/orders/${ORDER_ID}`);
  await expect(page.getByText('ORD-0001')).toBeVisible();
}

/** 進み具合の中に出ている段のラベルを、並びの順に返す */
async function stepLabelsOf(list: Locator): Promise<string[]> {
  const text = await list.innerText();
  return STEP_LABELS.filter((label) => text.includes(label)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/**
 * 画面の中でその文字を含む所（商品の欄は「名前（色 / サイズ） × 数」と続けて書かれるので、名前だけの一致にはしない）を探し、
 * その手前にいちばん近い見出し（h1〜h6）の文字を、見つかった所ごとに返す
 */
async function headingsBefore(page: Page, text: string): Promise<string[]> {
  return page.getByText(text).evaluateAll((nodes) =>
    nodes.map((node) => {
      let found = '';
      for (const heading of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        if (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = (heading.textContent ?? '').trim();
      }
      return found;
    }));
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-032 order progress and shipments (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('在庫の品だけの注文は4段の進み具合が出て、発送が1つも無いので配送情報の区切りは出ない', async ({ page }) => {
      // FREQ-444-AC-01, FREQ-444-AC-02
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'ready', label: '発送準備中', current: 'ready' }),
        shipments: [],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 1, readyQuantity: 1 })],
      });
      const four = page.getByRole('list', { name: '配送ステータス' });
      await expect(four).toBeVisible();
      expect(await stepLabelsOf(four)).toEqual(['お支払い', '発送準備中', '配送中', '配達済み']);
      // 済みと今の段は text-black、これからの段は text-[#999]
      await expect(four.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
      await expect(four.getByText('発送準備中', { exact: true })).toHaveClass(/text-black/);
      await expect(four.getByText('配送中', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(four.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(page.getByRole('region', { name: /^配送情報/ })).toHaveCount(0);
    });

    test('受注生産の品を含む注文は5段の進み具合が出る', async ({ page }) => {
      // FREQ-444-AC-01
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true }),
        shipments: [],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 1, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'ウールコート', quantity: 2, inProductionQuantity: 2 }),
        ],
      });
      const five = page.getByRole('list', { name: '配送ステータス' });
      await expect(five).toBeVisible();
      expect(await stepLabelsOf(five)).toEqual(['お支払い', '受注生産中', '発送準備中', '配送中', '配達済み']);
      await expect(five.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
      await expect(five.getByText('受注生産中', { exact: true })).toHaveClass(/text-black/);
      await expect(five.getByText('発送準備中', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(five.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e1/account-order-progress-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('発送ごとに「配送情報（n回目）」の区切りが出て、配送業者・追跡番号・リンク・その発送の商品が並ぶ', async ({ page }) => {
      // FREQ-444-AC-02
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true, partiallyShipped: true }),
        shipments: [
          shipmentOf({
            number: 1,
            items: [{ orderItemId: 'item-1', name: 'シルクブラウス', color: 'ホワイト', size: 'M', quantity: 2 }],
          }),
          shipmentOf({
            number: 2,
            shippedAt: '2026-10-08T00:00:00.000Z',
            carrier: 'sagawa',
            carrierLabel: '佐川急便',
            trackingNumber: 'SG-777-888',
            trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=SG-777-888',
            items: [{ orderItemId: 'item-2', name: 'プリーツスカート', color: 'ホワイト', size: 'M', quantity: 2 }],
          }),
        ],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 3, shippedQuantity: 2, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'プリーツスカート', quantity: 2, shippedQuantity: 2 }),
          line({ id: 'item-3', name: 'ウールコート', quantity: 1, inProductionQuantity: 1 }),
        ],
      });

      await expect(page.getByRole('region', { name: /^配送情報（\d+回目）$/ })).toHaveCount(2);
      const first = page.getByRole('region', { name: '配送情報（1回目）' });
      await expect(first.getByText('ヤマト運輸')).toBeVisible();
      await expect(first.getByText('1234-5678-9012')).toBeVisible();
      const firstLink = first.getByRole('link', { name: '配送状況を確認する' });
      await expect(firstLink).toHaveAttribute('href', /toi\.kuronekoyamato\.co\.jp/);
      await expect(firstLink).toHaveAttribute('rel', /noopener/);
      await expect(first.getByText('シルクブラウス')).toBeVisible();
      await expect(first).toContainText(/(×|x|数量[:：]?)\s*2/);
      await expect(first.getByText('プリーツスカート')).toHaveCount(0);

      const second = page.getByRole('region', { name: '配送情報（2回目）' });
      await expect(second.getByText('佐川急便')).toBeVisible();
      await expect(second.getByText('SG-777-888')).toBeVisible();
      await expect(second.getByRole('link', { name: '配送状況を確認する' })).toHaveAttribute('href', /k2k\.sagawa-exp\.co\.jp/);
      await expect(second.getByText('プリーツスカート')).toBeVisible();
      await expect(second.getByText('シルクブラウス')).toHaveCount(0);
      await page.screenshot({ path: `test-results/group-e1/account-order-shipments-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('まだ送っていない商品が「発送準備中の商品」「受注生産中の商品」の見出しの下に並ぶ', async ({ page }) => {
      // FREQ-444-AC-03
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true }),
        shipments: [],
        items: [
          line({ id: 'item-1', name: 'ガーデンパンツ', quantity: 1, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'ウールコート', quantity: 2, inProductionQuantity: 2 }),
        ],
      });

      await expect(page.getByRole('heading', { name: '発送準備中の商品' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '受注生産中の商品' })).toBeVisible();
      expect(await headingsBefore(page, 'ガーデンパンツ')).toContain('発送準備中の商品');
      expect(await headingsBefore(page, 'ガーデンパンツ')).not.toContain('受注生産中の商品');
      expect(await headingsBefore(page, 'ウールコート')).toContain('受注生産中の商品');
      expect(await headingsBefore(page, 'ウールコート')).not.toContain('発送準備中の商品');
    });

    test('取り消した発送は出ず、窓口が返した発送だけを、その番号で出す', async ({ page }) => {
      // FREQ-444-AC-04
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'ready', label: '発送準備中', current: 'ready', partiallyShipped: true }),
        // 1回目は取り消したので、窓口は2回目だけを返す
        shipments: [shipmentOf({ number: 2, trackingNumber: 'E2E-SECOND' })],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 2, shippedQuantity: 1, readyQuantity: 1 })],
      });
      await expect(page.getByRole('region', { name: '配送情報（2回目）' })).toBeVisible();
      await expect(page.getByRole('region', { name: '配送情報（1回目）' })).toHaveCount(0);
    });

    test('キャンセルした注文には進み具合の段を出さない', async ({ page }) => {
      // FREQ-444-AC-04
      await openDetail(page, {
        ...BASE,
        status: 'cancelled',
        progress: { key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null },
        shipments: [],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 1 })],
      });
      await expect(page.getByRole('list', { name: '配送ステータス' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: /^配送情報/ })).toHaveCount(0);
    });

    test('5段の進み具合と2回分の配送情報でも、段のラベルが1行で並び、横方向のページスクロールが発生しない', async ({ page }) => {
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true, partiallyShipped: true }),
        shipments: [shipmentOf({ number: 1 }), shipmentOf({ number: 2, carrier: 'sagawa', carrierLabel: '佐川急便', trackingNumber: 'SG-777-888' })],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 2, shippedQuantity: 2 }),
          line({ id: 'item-3', name: 'ウールコート', quantity: 1, inProductionQuantity: 1 }),
        ],
      });
      const list = page.getByRole('list', { name: '配送ステータス' });
      await expect(list).toBeVisible();
      for (const label of STEP_LABELS) {
        const box = await list.getByText(label, { exact: true }).boundingBox();
        expect(box, `${label} の位置`).not.toBeNull();
        // 1行で表示される（2行になると高さが2倍近くになる）
        expect(box!.height).toBeLessThan(25);
      }
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 9: FR-ADMIN-073（在庫の4つの数と履歴）を書く**

`e2e/FR-ADMIN-073-inventory-states.spec.ts`:

```ts
/**
 * FR-ADMIN-073 在庫の4つの数と在庫の履歴
 * 対応 FREQ: FREQ-445（AC-01〜AC-03）
 *
 * 商品の編集画面の在庫の欄は窓口を差し替えて確かめる（FR-ADMIN-058 と同じやり方）。
 * 引き当て済みと受注生産の数え方・履歴の変わった後の数（AC-03）は、手元の DB の関数を直に呼んで確かめる。
 * 在庫の欄は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import { mockAdminBackgroundApis } from './admin-test-utils';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  recordCompletion,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import { fulfillJson, viewports } from './order-fulfillment-test-utils';

const ITEM_ID = '7';
const EXPLANATION =
  'すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。';

/** 棚に45入れ、注文のために7を取ってある。すぐ出せる数は38、受注生産の数は2 */
const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 38,
  isActive: true,
  committedQuantity: 7,
  onHandQuantity: 45,
  backorderQuantity: 2,
};

/** 新しい順。最後の入荷は店の人の操作、販売は注文の処理（動かした人が空なら「自動」） */
const MOVEMENTS = [
  {
    id: 9,
    variantId: 11,
    delta: -7,
    reason: 'purchase',
    note: null,
    createdAt: '2026-10-09T05:00:00Z',
    actorEmail: null,
    orderId: 'a4b2c3d4-1111-2222-8333-444455556666',
    orderNumber: 'ORD-A4B2C3D4',
    balanceAfter: 38,
  },
  {
    id: 8,
    variantId: 11,
    delta: 45,
    reason: 'restock',
    note: '初回入荷',
    createdAt: '2026-10-09T01:00:00Z',
    actorEmail: 'admin@example.com',
    orderId: null,
    orderNumber: null,
    balanceAfter: 45,
  },
];

async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, { authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }));
  await page.route('**/api/admin/item-color-presets**', (route) => fulfillJson(route, { data: [] }));
  await page.route(`**/api/admin/items/${ITEM_ID}`, (route) =>
    fulfillJson(route, {
      data: {
        id: Number(ITEM_ID),
        name: 'リネンシャツ',
        description: '説明',
        price: 28000,
        category: 'TOPS',
        colors: [{ name: 'BLACK', hex: '#000000' }],
        sizes: ['M'],
        material: '',
        origin: '',
        care: '',
        product_note: '',
        status: 'published',
        image_url: null,
        image_urls: [],
      },
    }));
  await page.route(`**/api/admin/items/${ITEM_ID}/variants`, (route) =>
    fulfillJson(route, { variants: [VARIANT], movements: MOVEMENTS }));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-073 inventory states (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('色・サイズごとに、すぐ出せる数・引き当て済み・手元の数・受注生産の4つの数と、言葉の説明が出る', async ({ page }) => {
      // FREQ-445-AC-01
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = page.getByTestId('variant-row-11');
      await expect(row).toBeVisible();
      await expect(row).toContainText(/すぐ出せる数\s*38/);
      await expect(row).toContainText(/引き当て済み\s*7/);
      await expect(row).toContainText(/手元の数\s*45/);
      await expect(row).toContainText(/受注生産\s*2/);
      await expect(row.getByTestId('variant-stock')).toHaveText('38');
      await expect(row.getByTestId('variant-backorder')).toHaveText('2');
      // 言葉の説明は画面に1回だけ
      await expect(page.getByText(EXPLANATION)).toHaveCount(1);
      await page.screenshot({ path: `test-results/group-e1/item-stock-states-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('履歴に、動かした人（空なら「自動」）・どの注文か・変わった後の数が出る', async ({ page }) => {
      // FREQ-445-AC-02
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const rows = page.getByTestId('stock-movement-row');
      await expect(rows).toHaveCount(2);
      // 注文の処理が動かした販売: 動かした人は空なので「自動」、注文番号、変わった後の数
      await expect(rows.nth(0)).toContainText('販売');
      await expect(rows.nth(0)).toContainText('-7');
      await expect(rows.nth(0)).toContainText('自動');
      await expect(rows.nth(0)).toContainText('ORD-A4B2C3D4');
      await expect(rows.nth(0)).toContainText('38');
      // 店の人の入荷: 動かした人のメール、備考。注文は無い
      await expect(rows.nth(1)).toContainText('入荷');
      await expect(rows.nth(1)).toContainText('+45');
      await expect(rows.nth(1)).toContainText('初回入荷');
      await expect(rows.nth(1)).toContainText('admin@example.com');
      await expect(rows.nth(1)).not.toContainText('自動');
      await expect(rows.nth(1)).not.toContainText('ORD-');
    });

    test('4つの数と履歴を出しても、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);
      await expect(page.getByTestId('variant-row-11')).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('引き当て済みは発送した数を引いた数、受注生産は未入金・入金済みの注文のまだ仕上がっていない数だけで、履歴は動かした人・注文・変わった後の数を返す（手元の DB）', async () => {
      // FREQ-445-AC-03
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const actorEmail = (await db.query('select email from auth.users where id = $1', [actorId])).rows[0].email as string;
        const fx = await createCatalogFixture(db, { stock: 10, itemStatus: 'private' });
        const catalog = { itemId: fx.itemId, variantId: fx.variantId };
        const email = (label: string) => uniqueEmail(`stock-${label}-${viewport.name}`);

        // 引き当て済み: 入金済みの注文の在庫の品4つのうち1つを発送（4 - 1 = 3）と、
        // 支払い手続き中の注文の在庫の品1つ（棚にあるので数える）で、合わせて4
        const paid = await createOrderWithLines(
          db, email('paid'), [{ name: 'E2E在庫のシャツ', quantity: 4, fulfillmentType: 'stock' }], { catalog });
        const inProgress = await createOrderWithLines(
          db, email('progress'), [{ name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' }],
          { status: 'payment_in_progress', catalog });
        await createFulfillment(db, paid.orderId, actorId, {
          trackingNumber: 'E2E-STOCK-1',
          lines: [{ orderItemId: paid.orderItemIds[0], quantity: 1 }],
        });

        // 受注生産: 未入金の3つ + 入金済みの3つのうち1つが仕上がった残り2つ = 5。取り消した注文の5つは数えない
        await createOrderWithLines(
          db, email('pending'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { status: 'pending', catalog });
        const made = await createOrderWithLines(
          db, email('made'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { catalog });
        await recordCompletion(db, made.orderId, actorId, [{ orderItemId: made.orderItemIds[0], quantity: 1 }]);
        await createOrderWithLines(
          db, email('cancelled'), [{ name: 'E2Eコート', quantity: 5, fulfillmentType: 'backorder' }], { status: 'cancelled', catalog });

        // 店の人の手の調整（動かした人が入る）
        await db.query(
          `insert into public.stock_movements (variant_id, delta, reason, note, created_by)
           values ($1, 2, 'adjustment', 'E2E', $2)`,
          [fx.variantId, actorId],
        );

        const states = (await db.query('select * from public.list_variant_stock_states(array[$1::bigint])', [fx.variantId])).rows;
        expect(states).toHaveLength(1);
        expect(Number(states[0].variant_id)).toBe(fx.variantId);
        expect(states[0]).toMatchObject({ committed: 4, backorder: 5 });
        const stock = (await db.query('select stock_quantity from public.item_variants where id = $1', [fx.variantId])).rows[0];
        expect(Number(stock.stock_quantity)).toBe(7);

        // 履歴は新しい順。変わった後の数は、今の数（7）から、その行より後の動きを引いて出す
        const history = (await db.query('select * from public.list_item_stock_history($1::bigint, 50)', [fx.itemId])).rows;
        expect(
          history.map((row) => ({
            reason: row.reason as string,
            delta: Number(row.delta),
            balance: Number(row.balance_after),
            order: row.order_id as string | null,
            actor: row.actor_email as string | null,
          })),
        ).toEqual([
          { reason: 'adjustment', delta: 2, balance: 7, order: null, actor: actorEmail },
          { reason: 'purchase', delta: -1, balance: 5, order: inProgress.orderId, actor: null },
          { reason: 'purchase', delta: -4, balance: 6, order: paid.orderId, actor: null },
          { reason: 'restock', delta: 10, balance: 10, order: null, actor: null },
        ]);
      });
    });
  });
}
```

- [ ] **Step 10: FR-CHECKOUT-050（分けて送る案内）を書く**

`e2e/FR-CHECKOUT-050-split-shipment-notice.spec.ts`:

```ts
/**
 * FR-CHECKOUT-050 注文の確認のメールの、分けて送る案内
 * 対応 FREQ: FREQ-446（AC-01・AC-02）
 *
 * 手元の DB に注文を作り、確認のメールの予定を書き、worker の定期処理の入口を叩いて、Mailpit に届いた本文を読む
 * （FR-CHECKOUT-049 と同じやり方。実際の決済は使わない）。
 */
import { expect, test } from '@playwright/test';
import {
  createOrderWithLines,
  mailBodies,
  mailsTo,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
  type E2eOrderLine,
} from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const SPLIT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';
const PAID_SUBJECT = 'ご注文ありがとうございます';
const AWAITING_SUBJECT = '承りました';

const STOCK_LINE: E2eOrderLine = { name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' };
const BACKORDER_LINE: E2eOrderLine = { name: 'E2E受注生産のコート', quantity: 1, fulfillmentType: 'backorder' };

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-050 split shipment notice (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('在庫の品と受注生産の品が両方ある注文の確認のメール（入金済み・入金待ち）に、分けて送る案内が1行入る', async ({ request }) => {
      // FREQ-446-AC-01
      test.setTimeout(180_000);
      const paidEmail = uniqueEmail(`split-paid-${viewport.name}`);
      const awaitingEmail = uniqueEmail(`split-awaiting-${viewport.name}`);
      await withLocalDb(async (db) => {
        const paid = await createOrderWithLines(db, paidEmail, [STOCK_LINE, BACKORDER_LINE]);
        await db.query("select private.enqueue_order_email($1::uuid, 'paid', 'order_confirmed')", [paid.orderId]);
        const awaiting = await createOrderWithLines(db, awaitingEmail, [STOCK_LINE, BACKORDER_LINE], { status: 'pending' });
        await db.query("select private.enqueue_order_email($1::uuid, 'awaiting_payment')", [awaiting.orderId]);
      });
      const arrived = async (email: string, subject: string) =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(subject)).length;
      await runWorkerUntil(
        request,
        async () => (await arrived(paidEmail, PAID_SUBJECT)) >= 1 && (await arrived(awaitingEmail, AWAITING_SUBJECT)) >= 1,
        '入金済みと入金待ちの確認のメールが届くこと',
      );

      const [paidMail] = await mailBodies(request, paidEmail, PAID_SUBJECT);
      const [awaitingMail] = await mailBodies(request, awaitingEmail, AWAITING_SUBJECT);
      for (const mail of [paidMail, awaitingMail]) {
        expect(mail.Text).toContain('E2E在庫のシャツ');
        expect(mail.Text).toContain('E2E受注生産のコート');
        expect(occurrences(mail.Text, SPLIT_NOTICE)).toBe(1);
      }
    });

    test('片方の品だけの注文と、在庫を確保し直せなかった注文の確認のメールには、分けて送る案内が入らない', async ({ request }) => {
      // FREQ-446-AC-02
      test.setTimeout(180_000);
      const stockOnly = uniqueEmail(`split-stock-${viewport.name}`);
      const backorderOnly = uniqueEmail(`split-backorder-${viewport.name}`);
      const notReserved = uniqueEmail(`split-notreserved-${viewport.name}`);
      await withLocalDb(async (db) => {
        const orders = [
          await createOrderWithLines(db, stockOnly, [STOCK_LINE]),
          await createOrderWithLines(db, backorderOnly, [BACKORDER_LINE]),
          // 在庫を確保し直せなかった注文は、引き渡しの時期を書かない今の決まりに合わせて、この1行も書かない
          await createOrderWithLines(db, notReserved, [STOCK_LINE, BACKORDER_LINE], { reviewReason: 'stock_not_reserved' }),
        ];
        for (const order of orders) {
          await db.query("select private.enqueue_order_email($1::uuid, 'paid', 'order_confirmed')", [order.orderId]);
        }
      });
      const arrived = async (email: string) =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(PAID_SUBJECT)).length;
      await runWorkerUntil(
        request,
        async () => (await arrived(stockOnly)) >= 1 && (await arrived(backorderOnly)) >= 1 && (await arrived(notReserved)) >= 1,
        '3つの確認のメールが届くこと',
      );

      for (const email of [stockOnly, backorderOnly, notReserved]) {
        const [mail] = await mailBodies(request, email, PAID_SUBJECT);
        expect(mail.Text).not.toContain(SPLIT_NOTICE);
      }
      // 品の欄は今までどおり出ている
      expect((await mailBodies(request, stockOnly, PAID_SUBJECT))[0].Text).toContain('E2E在庫のシャツ');
      expect((await mailBodies(request, backorderOnly, PAID_SUBJECT))[0].Text).toContain('E2E受注生産のコート');
    });
  });
}
```

- [ ] **Step 11: 今の管理画面の E2E を直す（発送・一覧・履歴）**

発送の画面は材料を自分で読む作りに、一覧の言葉は「発送準備中」「配送中」などに変わった（Task 6・7）。次の5本が、そのままでは落ちる。今のファイルは改行が CRLF で、置き換えの文字列が複数行だと一致しないことがある。一致しない時は、その行を Read で確かめて、改行も含めて合わせる（新しく足す行の改行も、そのファイルに合わせる）。

`FR-ADMIN-060`・`063`・`064`・`067` は、一覧の商品の行が古い形（`{ name, quantity }` だけ）のままで、状態の言葉も新しい言葉の中（支払い手続き中・未決済・決済失敗）に収まっているので、直さない。Task 7 の画面が、欠けた欄（`color`・`size`・`fulfillmentType` など）で落ちないことを、Step 14 の流しで確かめる。落ちたら、画面を欠けた欄に強くするのが先（古い形の応答は、画面の作りの確かめとして正しい）。それでも直すなら、商品の行を `orderLine()` の形にする。

**(a) `e2e/FR-ADMIN-050-order-shipping.spec.ts`**（全部を次に置き換える。発送のボタンの出方は今のまま、発送の画面は窓口の差し替えを2つに、一覧の言葉を「配送中」にする）:

```ts
import { test, expect, Page } from '@playwright/test';
import type { CreateFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  adminOrder,
  fulfillJson,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
// 2026-10-10（FREQ-439）: 発送は商品と数を選ぶ1回ごとの記録になった。発送の画面は、開く時に
// GET /api/admin/orders/[id]/fulfillments で材料を読み、POST で発送する。一覧の言葉は、送る前は「発送準備中」、全部を送ると「配送中」。
// FREQ-267-AC-01/02/03 は FREQ-439-AC-01/03/04 に引き継いだ（requirements.md の注記）。

const LINE_ID = 'c1000000-0000-4000-8000-000000000001';

const PAID = adminOrder({ id: 'order-paid', items: [orderLine({ id: LINE_ID })] });
const PAID_SHIPPED = adminOrder({
  id: 'order-paid',
  status: '配送中',
  orderStatus: 'shipped',
  progressKey: 'in_transit',
  canShip: false,
  items: [orderLine({ id: LINE_ID, shipped: 1, readyUnshipped: 0 })],
});
const OTHERS = [
  adminOrder({
    id: 'order-missing-shipping',
    customerName: '配送先 未登録',
    customerEmail: 'missing@example.com',
    totalAmount: '¥18,000',
    canShip: false,
    missingShippingFields: ['address'],
  }),
  adminOrder({
    id: 'order-pending',
    customerName: '佐藤 太郎',
    customerEmail: 'taro@example.com',
    totalAmount: '¥32,000',
    status: '未決済',
    orderStatus: 'pending',
    progressKey: 'unpaid',
    canShip: false,
  }),
  adminOrder({
    id: 'order-shipped',
    customerName: '鈴木 次郎',
    customerEmail: 'jiro@example.com',
    totalAmount: '¥58,000',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canShip: false,
    items: [orderLine({ id: 'c1000000-0000-4000-8000-000000000002', shipped: 1, readyUnshipped: 0 })],
  }),
];

async function mockAdminApis(page: Page): Promise<void> {
  let shipped = false;
  await mockAdminSession(page);
  await mockOrderList(page, () => [shipped ? PAID_SHIPPED : PAID, ...OTHERS]);
  await page.route('**/api/admin/orders/*/fulfillments', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, shipMaterials({ orderId: 'order-paid', lines: [materialLine({ orderItemId: LINE_ID })] }));
      return;
    }
    shipped = true;
    await fulfillJson(route, {
      fulfillmentId: 'f0000000-0000-4000-8000-000000000001',
      number: 1,
      completesOrder: true,
      orderStatus: 'shipped',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('配送先が揃った決済完了注文にだけ発送ボタンが出る', async ({ page }) => {
      // FREQ-267-AC-01 / AC-02, FREQ-365-AC-09
      await openOrderTab(page);

      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
      await expect(page.getByText('配送先要確認')).toBeVisible();
    });

    test('配送業者と追跡番号を入力して発送できる', async ({ page }) => {
      // FREQ-267-AC-02 / AC-03, FREQ-439-AC-03
      await openOrderTab(page);

      await page.getByRole('button', { name: '発送済みにする' }).click();
      // 発送の画面は材料を読み終えてから入力する
      await expect(page.getByLabel('今回送る数')).toHaveCount(1);
      await expect(page.getByLabel('配送業者')).toBeVisible();
      await page.getByLabel('配送業者').selectOption('yamato');
      await page.getByLabel('追跡番号').fill('1234-5678-9012');
      await page.getByRole('button', { name: '発送する' }).click();

      await expect(page.getByRole('row', { name: /order-paid/ }).getByText('配送中', { exact: true })).toBeVisible();
      await expect(page.getByRole('row', { name: /order-shipped/ }).getByText('配送中', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrderTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

**(b) `e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts`**（全部を次に置き換える。発送の関数を `admin_ship_paid_order` から `admin_create_fulfillment` に、窓口の差し替えを `/status` から `/fulfillments` に、発送のメールの行の確かめを「その発送の自動の1行」に直す）:

```ts
/**
 * FR-ADMIN-066 発送の時に、発送のメールを送るかを選べる（最初は送る）
 * 対応 FREQ: FREQ-438（AC-01・AC-02）、FREQ-442（AC-04 は FR-ADMIN-071 が確かめる）
 *
 * 画面は窓口を差し替えて、送る本文に「送るか」が載ることを確かめる。
 * 「外すと届かず、入れると1通届く」は、手元の DB の発送の関数・worker の定期処理の入口・手元のメール受けで確かめる（本計画 P11）。
 * 2026-10-10（グループ E-1）: 発送の画面は商品と数を選ぶ画面になり、窓口は POST /api/admin/orders/[id]/fulfillments に、
 * 発送の関数は admin_create_fulfillment に変わった。発送のメールの行は、その発送の自動の1行になる。
 * 発送の画面（チェックが見える所）は、目で見るために3つの画面幅の写しを test-results/group-d/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type { CreateFulfillmentRequest, CreateFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  createActor,
  createFulfillment,
  createPaidOrder,
  mailsTo,
  orderItemIdsOf,
  outboxRows,
  runWorkerOnce,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';

const SHIPPED_SUBJECT = '商品を発送いたしました';

const ORDER_A = 'd1b2c3d4-1111-2222-8333-444455556666';
const ORDER_B = 'e1b2c3d4-1111-2222-8333-444455556666';
const LINE_A = 'd1000000-0000-4000-8000-000000000001';
const LINE_B = 'e1000000-0000-4000-8000-000000000001';

const ORDERS = [
  adminOrder({ id: ORDER_A, items: [orderLine({ id: LINE_A })] }),
  adminOrder({ id: ORDER_B, items: [orderLine({ id: LINE_B })] }),
];

async function mockAdminApis(page: Page, bodies: CreateFulfillmentRequest[]): Promise<void> {
  await mockAdminSession(page);
  await mockOrderList(page, () => ORDERS);
  await page.route('**/api/admin/orders/*/fulfillments', async (route) => {
    const orderId = new URL(route.request().url()).pathname.split('/')[4];
    if (route.request().method() === 'GET') {
      await fulfillJson(route, shipMaterials({ orderId, lines: [materialLine({ orderItemId: orderId === ORDER_A ? LINE_A : LINE_B })] }));
      return;
    }
    bodies.push(route.request().postDataJSON() as CreateFulfillmentRequest);
    await fulfillJson(route, {
      fulfillmentId: 'f0000000-0000-4000-8000-000000000001',
      number: 1,
      completesOrder: true,
      orderStatus: 'shipped',
      replayed: false,
    } satisfies CreateFulfillmentResponse);
  });
}

/** screenshotPath を渡すと、チェックが入った最初の発送の画面を写す */
async function ship(page: Page, row: number, notify: boolean, screenshotPath?: string): Promise<void> {
  await page.getByRole('button', { name: '発送済みにする' }).nth(row).click();
  const dialog = page.getByRole('dialog', { name: '発送済みにする' });
  // 発送の画面は材料を読み終えてから入力する
  await expect(dialog.getByLabel('今回送る数')).toHaveCount(1);
  const checkbox = dialog.getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
  await expect(checkbox).toBeChecked();
  // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
  if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: 'disabled' });
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
      const bodies: CreateFulfillmentRequest[] = [];
      await mockAdminApis(page, bodies);
      await openOrderTab(page);

      await ship(page, 0, false, `test-results/group-d/order-ship-dialog-${viewport.width}.png`);
      await ship(page, 0, true);

      expect(
        bodies.map((body) => ({
          carrier: body.carrier,
          trackingNumber: body.trackingNumber,
          notifyCustomer: body.notifyCustomer,
          lines: body.lines,
        })),
      ).toEqual([
        { carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: false, lines: [{ orderItemId: LINE_A, quantity: 1 }] },
        { carrier: 'yamato', trackingNumber: 'E2E-0', notifyCustomer: true, lines: [{ orderItemId: LINE_A, quantity: 1 }] },
      ]);
      // 画面を開くたびに、新しい重複防止キーを作る
      expect(bodies[0].requestKey).toMatch(UUID_PATTERN);
      expect(bodies[1].requestKey).toMatch(UUID_PATTERN);
      expect(bodies[1].requestKey).not.toBe(bodies[0].requestKey);
    });

    test('「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-438-AC-02
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(120_000);
      const silentEmail = uniqueEmail(`ship-silent-${viewport.name}`);
      const notifiedEmail = uniqueEmail(`ship-notified-${viewport.name}`);
      const { silentOrder, notifiedOrder, notifiedFulfillmentId } = await withLocalDb(async (db) => {
        const actor = await createActor(db);
        const silent = await createPaidOrder(db, silentEmail);
        const notified = await createPaidOrder(db, notifiedEmail);
        const [silentLine] = await orderItemIdsOf(db, silent);
        const [notifiedLine] = await orderItemIdsOf(db, notified);
        await createFulfillment(db, silent, actor, {
          trackingNumber: 'E2E-SILENT',
          notify: false,
          lines: [{ orderItemId: silentLine, quantity: 1 }],
        });
        const shipment = await createFulfillment(db, notified, actor, {
          trackingNumber: 'E2E-NOTIFIED',
          notify: true,
          lines: [{ orderItemId: notifiedLine, quantity: 1 }],
        });
        return { silentOrder: silent, notifiedOrder: notified, notifiedFulfillmentId: shipment.fulfillmentId };
      });

      await runWorkerOnce(request);

      // worker は時間の予算で止まるため、送る注文の発送の行が、その発送の自動の1行だけで送信済みになるのを先に待つ。
      // 送信済みはメールを送った後に書かれるので、この確かめの後にメール受けを数え直せる。
      await expect.poll(
        async () => withLocalDb((db) => outboxRows(db, notifiedOrder)),
        { timeout: 30_000, message: '送る注文の発送の行は、その発送の自動の1行だけで送信済みであること' },
      ).toEqual([{ fulfillment_id: notifiedFulfillmentId, origin: 'auto', status: 'sent', last_error_code: null }]);
      await expect.poll(
        async () => (await mailsTo(request, notifiedEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT)).length,
        { timeout: 30_000 },
      ).toBe(1);
      expect((await mailsTo(request, silentEmail)).filter((message) => message.Subject.includes(SHIPPED_SUBJECT))).toHaveLength(0);
      expect(await withLocalDb((db) => outboxRows(db, silentOrder))).toHaveLength(0);
    });
  });
}
```

**(c) `e2e/FR-ADMIN-051-order-refund-safety.spec.ts`**（一覧の窓口の答えを新しい形にし、状態の言葉を直す。返金とキャンセルのボタンの出方は今のまま）:

1. 11〜47行目の `const ORDERS = [` から対応する `];` までを、次に置き換える:

```ts
const LINE = {
  id: 'c1000000-0000-4000-8000-000000000001',
  color: 'ホワイト',
  size: 'M',
  quantity: 1,
  fulfillmentType: 'stock',
  shipped: 0,
  inProduction: 0,
  readyUnshipped: 1,
};

const ORDERS = [
  {
    id: 'order-paid',
    customerName: '決済 花子',
    customerEmail: 'paid@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'ブラウス' }],
    totalAmount: '¥10,000',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canRefund: true,
    canShip: true,
  },
  {
    id: 'order-pending',
    customerName: '未決済 太郎',
    customerEmail: 'pending@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'スカート' }],
    totalAmount: '¥12,000',
    status: '未決済',
    orderStatus: 'pending',
    progressKey: 'unpaid',
    canRefund: false,
    canCancel: true,
  },
  {
    id: 'order-shipped',
    customerName: '発送 次郎',
    customerEmail: 'shipped@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [{ ...LINE, name: 'コート', shipped: 1, readyUnshipped: 0 }],
    totalAmount: '¥30,000',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canRefund: true,
  },
];
```

2. 「非同期返金は一覧を再取得し、決済完了を維持して通知する」のテストの、状態の絞り込みのボタンと取り違えないための1行を次に直す（一覧の表の中の、発送準備中の印は1つ。DB の状態は決済完了のまま、画面の言葉は発送準備中のまま）:

置き換え前: `await expect(page.getByRole('table').getByText('決済完了', { exact: true })).toHaveCount(1);`
置き換え後: `await expect(page.getByRole('table').getByText('発送準備中', { exact: true })).toHaveCount(1);`

**(d) `e2e/FR-ADMIN-061-order-list-review-states.spec.ts`**:

1. 11〜30行目の `const BASE = {` から `const ORDERS = [` の `];` までを、次に置き換える（商品の行を新しい形にし、状態の言葉と DB の状態を足す）:

```ts
const BASE = {
  customerEmail: 'buyer@example.com',
  orderDate: '2026-09-27',
  itemCount: '1点',
  items: [
    {
      id: 'c1000000-0000-4000-8000-000000000001',
      name: 'シルクブラウス',
      color: 'ホワイト',
      size: 'M',
      quantity: 1,
      fulfillmentType: 'stock',
      shipped: 0,
      inProduction: 0,
      readyUnshipped: 1,
    },
  ],
  totalAmount: '¥28,800',
};

const ORDERS = [
  {
    ...BASE,
    id: 'order-progress',
    customerName: '手続き 花子',
    status: '支払い手続き中',
    orderStatus: 'payment_in_progress',
    progressKey: 'payment_in_progress',
    canCancel: true,
  },
  {
    ...BASE,
    id: 'order-review',
    customerName: '確認 太郎',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    canShip: true,
    needsReview: true,
  },
  {
    ...BASE,
    id: 'order-blocked',
    customerName: '金額 次郎',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    canShip: false,
    shipBlockedReason: '支払額の確認が必要です（要対応）',
  },
];
```

2. 「「放棄」を選ぶと、選んでいた他の状態が外れる」のテストで、状態の絞り込みの「決済完了」が無くなったので、`paid` を `waiting` にして次の4行を直す（`pending`・`abandoned` の行は今のまま）:

| 置き換え前 | 置き換え後 |
|---|---|
| `const paid = page.getByRole('button', { name: '決済完了', exact: true });` | `const waiting = page.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）', exact: true });` |
| `await paid.click();` | `await waiting.click();` |
| `await expect(paid).toHaveAttribute('aria-pressed', 'true');` | `await expect(waiting).toHaveAttribute('aria-pressed', 'true');` |
| `await expect(paid).toHaveAttribute('aria-pressed', 'false');` | `await expect(waiting).toHaveAttribute('aria-pressed', 'false');` |

**(e) `e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts`**（一覧の行の新しい形だけ。履歴の `SENT_EMAIL` に `fulfillmentId: null, fulfillmentNumber: null` を足す直しは、履歴の型を変える Task 5 の Step 14 が入れる）:

23〜33行目の `const ORDER_ROW = {` から `};` までを、次に置き換える:

```ts
const ORDER_ROW = {
  id: ORDER_ID,
  customerName: '山田 花子',
  customerEmail: 'hanako@example.com',
  orderDate: '2026-10-09',
  itemCount: '1点',
  items: [
    {
      id: 'c1000000-0000-4000-8000-000000000001',
      name: 'シルクブラウス',
      color: 'ホワイト',
      size: 'M',
      quantity: 1,
      fulfillmentType: 'stock',
      shipped: 0,
      inProduction: 0,
      readyUnshipped: 1,
    },
  ],
  totalAmount: '¥28,800',
  status: '発送準備中',
  orderStatus: 'paid',
  progressKey: 'ready',
  partiallyShipped: false,
  canShip: true,
};
```

- [ ] **Step 12: 今のお客様の画面の E2E を直す**

お客様の注文の窓口の答えは、`progress`（言葉と段）・`shipments`（発送ごとの配送情報）・商品ごとの数を足し、`shippedAt`・`shippingCarrier`・`trackingNumber` を返さなくなる。購入履歴の一覧の `status` は進み具合の言葉になる（Task 8）。次のファイルを直す。`FR-ACCOUNT-010`・`014` の一覧の写しは `決済完了` と書いてあるが、言葉を通すだけで確かめていないので、直さなくてよい。

注文の詳細を写す5本（`013`・`016`・`017`・`018`・`020`）は、字下げがタブ。窓口の答えに「発送準備中の在庫の品だけ」の進み具合と商品ごとの数を足すだけなので、各ファイルに次の2つの置き換えを入れる（1行ずつで、字下げは触らない）:

| 置き換え前（各ファイルに1つだけある） | 置き換え後 |
|---|---|
| `import { mockOtpAuthentication } from './account-test-utils';` | 同じ行の次に `import { withReadyProgress } from './order-detail-fixtures';` を足す |
| `body: JSON.stringify(orderDetail),` | `body: JSON.stringify(withReadyProgress(orderDetail)),` |

`FR-ACCOUNT-015`・`019` も同じ2つの置き換えを入れ、段の名前を変える。`FR-ACCOUNT-013`・`005`・`023`・`031` は、次のとおり直す。

**(a) `e2e/FR-ACCOUNT-013-order-detail.spec.ts`**: 上の2つの置き換えの他に、AC-02 の6行（`await expect(page.getByText('支払い完了')).toBeVisible();` から `await expect(progress.getByText('配達')).toBeVisible();` まで）を、次に置き換える。コメントの `AC-02` の行の末尾に `（2026-10-10 FREQ-444 で、段は お支払い・発送準備中・配送中・配達済み）` を足す:

```ts
				const progress = page.getByRole('list', { name: '配送ステータス' });
				await expect(progress).toBeVisible();
				await expect(progress.getByText('お支払い', { exact: true })).toBeVisible();
				await expect(progress.getByText('発送準備中', { exact: true })).toBeVisible();
				await expect(progress.getByText('配送中', { exact: true })).toBeVisible();
				await expect(progress.getByText('配達済み', { exact: true })).toBeVisible();
```

**(b) `e2e/FR-ACCOUNT-015-order-detail-progress-steps.spec.ts`**: 上の2つの置き換えの他に、テストの題を `進捗バーがお支払いから始まる4ステップになり、ステータス行と合計行が表示されない` に変え、`// AC-01:` の行から `// AC-03:` の行の手前までを、次に置き換える（AC-03・AC-04 は今のまま）:

```ts
				// AC-01: 4ステップ表示・先頭はお支払い（2026-10-10 FREQ-444 で、段の名前を お支払い・発送準備中・配送中・配達済み に置き換え）
				const progress = page.getByRole('list', { name: '配送ステータス' });
				await expect(progress).toBeVisible();
				await expect(progress.getByText('お支払い', { exact: true })).toBeVisible();
				await expect(progress.getByText('発送準備中', { exact: true })).toBeVisible();
				await expect(progress.getByText('配送中', { exact: true })).toBeVisible();
				await expect(progress.getByText('配達済み', { exact: true })).toBeVisible();
				await expect(progress.locator('li').first()).toContainText('お支払い');

				// AC-02: 入金済みの在庫の品は お支払い・発送準備中 が済み・今の段（text-black）、配送中・配達済み がこれからの段（text-[#999]）
				await expect(progress.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
				await expect(progress.getByText('発送準備中', { exact: true })).toHaveClass(/text-black/);
				await expect(progress.getByText('配送中', { exact: true })).toHaveClass(/text-\[#999\]/);
				await expect(progress.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
```

**(c) `e2e/FR-ACCOUNT-019-order-detail-stepper-mobile.spec.ts`**: 上の2つの置き換えの他に、段のラベルの並び `['支払い完了', '受注', '発送', '配達']` を、2か所とも（全部置き換える）`['お支払い', '発送準備中', '配送中', '配達済み']` に直す。

**(d) `e2e/FR-ACCOUNT-005-order-history.spec.ts`**（字下げはスペース2つ）:
- `import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';` の次の行に `import { withReadyProgress } from './order-detail-fixtures';` を足す。
- 一覧の窓口の答えの `status: '決済完了',`（`itemCount: 1,` の前）を `status: '発送準備中',` にする。
- 詳細の窓口の答え `body: JSON.stringify({` から `}),`（`/api/orders/order-1` の方）を、次に置き換える:

```ts
        body: JSON.stringify(
          withReadyProgress({
            id: 'order-1',
            orderNumber: 'ORD-0001',
            orderDate: '2026-04-01',
            status: 'paid',
            totalAmount: '¥12,000',
            shippingAddress: '東京都渋谷区神宮前1-2-3 青山ハイツ 101',
            items: [
              { id: 'line-1', name: 'Silk Blouse', quantity: 1, color: 'Black', size: 'M', amount: '¥12,000' },
            ],
          }),
        ),
```
- `await expect(page.getByText('決済完了')).toBeVisible();` を `await expect(page.getByText('発送準備中')).toBeVisible();` にする。

**(e) `e2e/FR-ACCOUNT-023-order-history-timeline.spec.ts`**（字下げはタブ）: `status: '決済完了',` を `status: '発送準備中',` に、`await expect(row.getByText('決済完了')).toBeVisible();` を `await expect(row.getByText('発送準備中')).toBeVisible();` に直す。

**(f) `e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts`**（全部を次に置き換える。配送情報は発送ごとの `配送情報（n回目）` になり、追跡のリンクは窓口が返す）:

```ts
import { test, expect, Page } from '@playwright/test';
import { STOCK_IN_TRANSIT_PROGRESS, shipmentOf, withReadyProgress } from './order-detail-fixtures';

// FREQ-267: 発送済みの注文詳細に配送業者・追跡番号・追跡リンクを出す。
// 2026-10-10（FREQ-444）: 配送情報は発送ごとの「配送情報（n回目）」になり、追跡のリンクは窓口が返す（shipments[].trackingUrl）。
// FREQ-267-AC-05/06 は FREQ-444-AC-02 に引き継いだ（requirements.md の注記）。詳しい確かめは FR-ACCOUNT-032。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const PAID_ORDER = withReadyProgress({
  id: ORDER_ID,
  orderNumber: 'ORD-A1B2C3D4',
  orderDate: '2026/08/01 09:00',
  status: 'paid',
  subtotalAmount: '¥28,000',
  shippingAmount: '¥800',
  discountAmount: '¥0',
  totalAmount: '¥28,800',
  paymentMethod: 'クレジットカード',
  shippingAddress: '〒100-0001 東京都 千代田区 千代田1-1 1F',
  items: [
    {
      id: 'item-1',
      itemId: 1,
      name: 'シルクブラウス',
      imageUrl: null,
      color: 'ホワイト',
      size: 'M',
      quantity: 1,
      amount: '¥28,000',
      stockStatus: 'in_stock',
    },
  ],
});

const SHIPPED_ORDER = {
  ...PAID_ORDER,
  status: 'shipped',
  items: PAID_ORDER.items.map((item) => ({ ...item, shippedQuantity: item.quantity, readyQuantity: 0 })),
  progress: STOCK_IN_TRANSIT_PROGRESS,
  shipments: [shipmentOf({ number: 1 })],
};

async function mockOrderDetail(page: Page, order: unknown): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'user-1', email: 'hanako@example.com', role: 'user', mfaVerified: true },
      }),
    }),
  );

  await page.route(`**/api/orders/${ORDER_ID}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(order),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-031 order shipping info (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送済みの注文に配送情報が出る', async ({ page }) => {
      // FREQ-267-AC-05, FREQ-444-AC-02
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const section = page.getByRole('region', { name: '配送情報（1回目）' });
      await expect(section).toBeVisible();
      await expect(section.getByText('ヤマト運輸')).toBeVisible();
      await expect(section.getByText('1234-5678-9012')).toBeVisible();

      const link = section.getByRole('link', { name: '配送状況を確認する' });
      await expect(link).toHaveAttribute('href', /toi\.kuronekoyamato\.co\.jp/);
      await expect(link).toHaveAttribute('rel', /noopener/);
    });

    test('未発送の注文には配送情報が出ない', async ({ page }) => {
      // FREQ-267-AC-06, FREQ-444-AC-02
      await mockOrderDetail(page, PAID_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      await expect(page.getByRole('region', { name: /配送情報/ })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 13: 型と lint を確かめる**

Run: `npx tsc --noEmit`
Expected: 誤り 0（`@/lib/orders/fulfillment/fulfillment-types`・`@/lib/orders/order-progress`・`@/lib/orders/email/order-history`・`@/components/OrderSection` の型が、共通の約束と合っていること。合わない所は、この Task のコードではなく、その型を作った Task を共通の約束に合わせて直す）

Run: `npm run lint`
Expected: 誤り 0（未使用の import・変数が無いこと）

- [ ] **Step 14: E2E を流す（controller）**

1. 3000番に何も無いことを確かめる: `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue`（何か出たら、そのアプリを止める）
2. `npx supabase db reset`（DB 結合テストを流した後は必ず。移行 A・B が入った状態から始める）
3. 新しい8本: `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/FR-ADMIN-068 e2e/FR-ADMIN-069 e2e/FR-ADMIN-070 e2e/FR-ADMIN-071 e2e/FR-ADMIN-072 e2e/FR-ADMIN-073 e2e/FR-ACCOUNT-032 e2e/FR-CHECKOUT-050 --reporter=list`
   Expected: 105 passed（3つの画面幅 × 35 本。skip 0・failed 0）。メールの試験は、手元のメール受け（Mailpit）と worker の入口（`CRON_SECRET`）が動いている前提
4. 直した今の物: `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/FR-ADMIN-050-order-shipping e2e/FR-ADMIN-051-order-refund-safety e2e/FR-ADMIN-060 e2e/FR-ADMIN-061 e2e/FR-ADMIN-063 e2e/FR-ADMIN-064 e2e/FR-ADMIN-065 e2e/FR-ADMIN-066 e2e/FR-ADMIN-067 e2e/FR-ACCOUNT-005 e2e/FR-ACCOUNT-010 e2e/FR-ACCOUNT-013 e2e/FR-ACCOUNT-014 e2e/FR-ACCOUNT-015 e2e/FR-ACCOUNT-016 e2e/FR-ACCOUNT-017 e2e/FR-ACCOUNT-018 e2e/FR-ACCOUNT-019 e2e/FR-ACCOUNT-020 e2e/FR-ACCOUNT-023 e2e/FR-ACCOUNT-031 --reporter=list`
   Expected: すべて PASS（`FR-ADMIN-058` は Task 9 の Step 6 が直す。流して確かめるのは Task 12 の全件の確かめで行うので、ここでは流さない）
5. 画面の写しを目で見る: `test-results/group-e1/` の発送の画面・仕上がりの画面・履歴・一覧・お客様の注文の画面・在庫の欄の、3つの画面幅の写し（390 で文字が切れない、768・1280 で崩れない）

落ちたら CLAUDE.md の「失敗したときの切り分け」の順（単体で再実行 → 他の画面幅 → 時間切れか中身の違いか）で調べる。`retries` は上げない。アサーションの食い違い（画面の文言・並び・名前）なら、この Task の試験ではなく、Task 6〜9 の画面が共通の約束（Global Constraints の言葉）と違っていないかを先に疑う。

- [ ] **Step 15: コミット（controller）**

```bash
git add e2e/order-email-test-utils.ts e2e/order-fulfillment-test-utils.ts e2e/order-detail-fixtures.ts e2e/FR-ADMIN-068-partial-fulfillment.spec.ts e2e/FR-ADMIN-069-made-to-order-completion.spec.ts e2e/FR-ADMIN-070-order-progress-labels.spec.ts e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts e2e/FR-ADMIN-073-inventory-states.spec.ts e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts e2e/FR-CHECKOUT-050-split-shipment-notice.spec.ts e2e/FR-ADMIN-050-order-shipping.spec.ts e2e/FR-ADMIN-051-order-refund-safety.spec.ts e2e/FR-ADMIN-061-order-list-review-states.spec.ts e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts e2e/FR-ACCOUNT-005-order-history.spec.ts e2e/FR-ACCOUNT-013-order-detail.spec.ts e2e/FR-ACCOUNT-015-order-detail-progress-steps.spec.ts e2e/FR-ACCOUNT-016-order-detail-responsive.spec.ts e2e/FR-ACCOUNT-017-order-detail-item-spacing.spec.ts e2e/FR-ACCOUNT-018-order-detail-shipping-band.spec.ts e2e/FR-ACCOUNT-019-order-detail-stepper-mobile.spec.ts e2e/FR-ACCOUNT-020-order-detail-contact-button.spec.ts e2e/FR-ACCOUNT-023-order-history-timeline.spec.ts e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts
git commit -m "test(e2e): 部分発送・仕上がり・進み具合の言葉・発送ごとのメール・発送の取消・お客様の進み具合・在庫の4つの数・分けて送る案内を3つの画面幅で確かめる（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 要求・設計の文書・手順書

**Files:**
- Modify: `docs/02_Requirements/requirements.md`
- Modify: `docs/03_BasicDesign/data/er.md`・`docs/03_BasicDesign/api/api-spec.md`・`docs/03_BasicDesign/api/route-inventory.md`
- Modify: `docs/04_DetailDesign/states/order-payment.md`・`docs/04_DetailDesign/sequence/order-administration.md`
- Modify: `docs/04_DetailDesign/pages/16_admin.md`・`docs/04_DetailDesign/pages/15_account.md`・`docs/04_DetailDesign/pages/13_checkout.md`
- Modify: `docs/06_Operations/order-email-operations.md`
- Modify: `docs/superpowers/specs/2026-10-09-order-email-outbox-design.md`

**Interfaces:**
- Consumes: Task 1〜10 の名前（表・関数・窓口・画面の言葉・E2E のファイル名）。文書のリンクは、Task 1〜10 が作るファイルを指す（移行 A・B、窓口、`order-progress.ts`、`fulfillment-messages.ts`、`fulfillment-client.ts`、結合テスト、E2E）。管理画面の言葉は、Task 6 が足した言葉（`仕上がった数を入れてください。`・`受注生産中の商品はありません。`・履歴の `取り消し済み`・`お客様へのメール: 送る`／`送らない`・`この発送で全部を送りました`・取消の知らせと、取消の答えが分からない時の文）に合わせる。Task 10 で決めた受け付け基準の番号（`FREQ-439-AC-01` など31個）
- Produces: 文書だけ（コードは変えない）

文書は `documentation-guide` の決まり（頭に「概要」、図は Mermaid、絵文字なし、見出しは H4 まで、関連は相対リンク）に従う。直す文書はどれも「概要」を持っているので、新しい節を足すだけでよい。

**編集の書き方。** 各編集は、Edit ツールの `old_string` と `new_string` と同じ意味。「置き換え前」は、その文書の中でちょうど1か所だけ現れる文字列で、「置き換え後」がそれに替わる。足すだけの編集は、「置き換え後」の先頭に「置き換え前」をそのまま含める。範囲の編集は、「範囲の開始」の行から「範囲の終了」の行の手前までを、「置き換え後」に替える。今の文書は改行が CRLF で、複数行の文字列だと一致しないことがあるので、一致しない時は、その行を Read で確かめて改行ごと合わせる（足す行の改行もそのファイルに合わせる）。置き換え後に出てくる `~~~` の行は、ファイルに書く時に3つのバッククォートに替える（この計画の囲みが崩れないため）。

**受け付け基準の番号。** この Task で要求の表に書く受け付け基準は、Task 10 の E2E の題とコメントが引いている番号と同じ（FREQ-439: AC-01〜06、FREQ-440: AC-01〜05、FREQ-441: AC-01〜03、FREQ-442: AC-01〜04、FREQ-443: AC-01〜04、FREQ-444: AC-01〜04、FREQ-445: AC-01〜03、FREQ-446: AC-01〜02。合わせて31個）。`npm run report:traceability` と `npm run check-coverage`（`scripts/generate-coverage-report.js`）は、要求の表にある受け付け基準の番号が、基本設計・詳細設計（`docs/03_BasicDesign`・`docs/04_DetailDesign`）と試験（`e2e`・`tests`）に文字として現れるかを数える。そのため、各番号を1つ以上の設計の文書にも書く（受け付け基準の表を `16_admin.md`・`15_account.md`・`13_checkout.md` に置く）。なお、今の `check-coverage` は設計に参照の無い番号が1000以上あって元から通らず、報告書 `docs/05_Quality/reports/traceability-report.md` は他のグループの差分も含むので、この Task では再生成しない（確かめは Step 6 の読むだけの数え方で行う）。

- [ ] **Step 1: 要求の行を足し、古い行に引き継ぎの注記を付ける**

まず、今の最大の番号を確かめる:

Run: `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-438`

次に、新しい31個の番号が設計の文書にも試験にも無いことを確かめる（足す前）:

Run: `for id in $(grep -oE "FREQ-(439|44[0-6])-AC-[0-9]+" docs/02_Requirements/requirements.md | sort -u); do echo "$id design=$(grep -rl "$id" docs/03_BasicDesign docs/04_DetailDesign | wc -l) tests=$(grep -rl "$id" e2e tests | wc -l)"; done`
Expected: 何も出ない（要求の表にまだ書いていないため）。Step 6 でもう一度流し、31行すべてが `design=1` 以上・`tests=1` 以上になることを確かめる

`docs/02_Requirements/requirements.md`

**編集 1-1（FREQ-439〜446 の8行を、FREQ-438 の行の次に足す）。** 置き換え前:

```text
・3つの画面幅で、「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届くこと（E2E FR-ADMIN-066） |
```

置き換え後:

```text
・3つの画面幅で、「送らない」で発送した注文には発送のメールが届かず、「送る」なら1通届くこと（E2E FR-ADMIN-066） |
| FREQ-439 | 在庫の品と受注生産の品が両方ある注文で、発送準備中の品を先に送れること。発送は商品と数を選ぶ1回ごとの記録にする（グループ E-1。Shopify の Fulfillment に合わせる。FREQ-267 の発送を置き換える） | FREQ-439-REQ-01<br>FREQ-439-REQ-02<br>FREQ-439-REQ-03<br>FREQ-439-REQ-04 | ・発送を1回ごとの記録（発送と発送の商品）にし、1つの注文に何回でも発送できること。商品ごとに発送した数を数え、発送準備中の数を超えて送れないこと（画面と DB の両方で止め、理由を決まった言葉で返す）<br>・発送の画面は、商品ごとに「在庫」か「受注生産」の印・発送準備中の数・今回送る数の入力を並べ、最初は発送準備中の全部を入れること。今回送る数の合計が0なら送らずに理由を出すこと<br>・一部だけ送った注文は、DB の状態を決済完了のままにして「一部発送済み」の印を出し、残りを送る操作を残すこと。全部を送った発送で DB の状態を発送済み（画面の言葉は「配送中」）にすること<br>・画面を開いた時に作る重複防止キーで、同じ操作を二重に記録しないこと。答えが分からない時（通信が切れた・時間が切れた・500番台）は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じキーで確かめ直すこと | FREQ-439-AC-01<br>FREQ-439-AC-02<br>FREQ-439-AC-03<br>FREQ-439-AC-04<br>FREQ-439-AC-05<br>FREQ-439-AC-06 | ・3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で、発送の画面に商品ごとの印と今回送る数の入力が並び、最初の数が発送準備中の全部で、合計と「お客様に発送のメールを送る」のチェックが出ること（E2E FR-ADMIN-068）<br>・同3画面幅で、今回送る数を減らして発送すると、重複防止キーと商品ごとの数を送り、一覧に「一部発送済み」の印と残りを送る「発送済みにする」が出ること（E2E FR-ADMIN-068）<br>・同3画面幅で、残りを全部発送すると、一覧の言葉が「配送中」になり、「発送済みにする」が消えること（E2E FR-ADMIN-068）<br>・同3画面幅で、合計0の発送は送らずに「送る数を入れてください。」が出て、発送準備中の数を超える発送を窓口が断った時はその言葉が画面の中に出ること（E2E FR-ADMIN-068）<br>・同3画面幅で、通信が切れた時・500番台の時は、入力が止まって「もう一度確かめる」と「閉じる」だけが出て、同じ重複防止キーで確かめ直すこと（E2E FR-ADMIN-068）<br>・発送の DB の関数が、発送準備中の数を超える数・注文に無い商品・中身の違う同じ重複防止キーを断り、同じ中身の送り直しは二重に記録せず、同時の2つの発送は片方だけが通ること（E2E FR-ADMIN-068 の手元の DB・DB 結合） |
| FREQ-440 | 受注生産の品の仕上がりを記録し、記録するまで送れないこと。入金済みの注文の言葉を「受注生産中」と出すこと（グループ E-1。Shopify の発送の保留に合わせる） | FREQ-440-REQ-01<br>FREQ-440-REQ-02<br>FREQ-440-REQ-03 | ・受注生産の品は、仕上がりを記録するまで発送できないこと（画面と DB の両方で止める）。仕上がりを記録できるのは、決済完了の注文の受注生産の品の、受注生産中の数までとすること<br>・一覧に「仕上がりを記録する」を出し、仕上がりの画面と発送の画面の中で、商品ごとに仕上がった数（0から受注生産中の数まで）を記録できること。記録してもお客様にメールは送らないこと<br>・注文の履歴の仕上がりの行から「この仕上がりを取り消す」で取り消せること。もう発送した数を下回る取消は断ること | FREQ-440-AC-01<br>FREQ-440-AC-02<br>FREQ-440-AC-03<br>FREQ-440-AC-04<br>FREQ-440-AC-05 | ・3つの画面幅で、受注生産の品を含む入金済みの注文が「受注生産中」と出て、発送の画面の最初の数に受注生産中の品が入らないこと（E2E FR-ADMIN-069）<br>・同3画面幅で、仕上がりの画面で仕上がった数を記録すると「仕上がりを記録しました。」が出て、その品が「発送準備中」になること（E2E FR-ADMIN-069）<br>・同3画面幅で、発送の画面の中でも仕上がりを記録でき、その数が発送準備中に移って送る数を入れられること（E2E FR-ADMIN-069）<br>・同3画面幅で、履歴の「この仕上がりを取り消す」が確かめの文を出し、取り消すと受注生産中に戻ること。もう発送した数を下回る取消は「もう発送した数があるため、取り消せません。」で断られること（E2E FR-ADMIN-069）<br>・受注生産中の品を送ろうとすると DB の関数が断り、仕上がりを記録できるのは決済完了の注文の受注生産の品の受注生産中の数までで、送った数を下回る仕上がりの取消は断られること（E2E FR-ADMIN-069 の手元の DB・DB 結合） |
| FREQ-441 | 注文の進み具合を「未決済・受注生産中・発送準備中・配送中」の言葉で管理画面とお客様の購入履歴に出すこと。DB の状態の値は変えない（グループ E-1） | FREQ-441-REQ-01<br>FREQ-441-REQ-02 | ・決済完了と発送済みの注文の言葉は、商品ごとの数のうちいちばん手前の段階（受注生産中、なければ発送準備中、なければ配送中）で決め、発送した数が1以上で未発送の数も1以上の注文には管理画面で「一部発送済み」の印を足すこと。お客様の購入履歴には言葉だけを出すこと<br>・管理画面の絞り込みは DB の状態で行い、名前を「すべて・支払い手続き中・未決済・発送待ち（受注生産中・発送準備中）・発送済み（配送中・配達済み）・決済失敗・放棄・キャンセル」にすること。上の件数の表示は「未決済」と「発送待ち」にすること | FREQ-441-AC-01<br>FREQ-441-AC-02<br>FREQ-441-AC-03 | ・3つの画面幅で、管理画面の一覧に「未決済」「受注生産中」「発送準備中」「配送中」の言葉と、一部だけ送った注文の「一部発送済み」の印が出ること（E2E FR-ADMIN-070）<br>・同3画面幅で、絞り込みの名前が決めたとおりで、「発送待ち」は status=paid、「発送済み」は status=shipped で一覧を読み、2つ以上選んだ時は DB の状態で画面が絞ること（E2E FR-ADMIN-070）<br>・同3画面幅で、お客様の購入履歴の一覧にも同じ言葉が出ること（E2E FR-ADMIN-070） |
| FREQ-442 | 発送のお知らせのメールを、発送ごとに1通送ること（グループ E-1。Shopify の Shipping confirmation に合わせる。FREQ-268 を置き換える） | FREQ-442-REQ-01<br>FREQ-442-REQ-02<br>FREQ-442-REQ-03 | ・発送のメールの行を、発送ごとに1行書くこと（行は発送の番号を持つ）。発送のメールの再送は、発送ごとに、取り消していない発送だけにすること<br>・メールには、その発送の商品と数・配送業者・追跡番号・追跡のリンクを書き、値段は書かないこと。未発送の品が残る発送のメールにだけ「残りの商品は、準備ができ次第お送りします。」を書くこと<br>・発送の画面で「お客様に発送のメールを送る」を外した発送には、メールの行を書かないこと（FREQ-438 を引き継ぐ） | FREQ-442-AC-01<br>FREQ-442-AC-02<br>FREQ-442-AC-03<br>FREQ-442-AC-04 | ・発送ごとに発送のメールが1通だけ届き、件名が「【Le Fil des Heures】商品を発送いたしました（注文番号）」であること（E2E FR-ADMIN-071 の手元の DB と Mailpit）<br>・メールの本文に、その発送の商品と数・配送業者・追跡番号が書かれ、別の発送の商品と値段は書かれないこと（E2E FR-ADMIN-071）<br>・未発送の品が残る発送のメールにだけ、残りの案内が入ること（E2E FR-ADMIN-071）<br>・知らせない発送にはメールの行が書かれずメールも届かず、知らせる発送の分だけ1通届くこと（E2E FR-ADMIN-071・FR-ADMIN-066） |
| FREQ-443 | 発送を、注文の履歴から取り消せること（グループ E-1。Shopify の Cancel fulfillment に合わせる） | FREQ-443-REQ-01<br>FREQ-443-REQ-02 | ・履歴の発送の行から「この発送を取り消す」で、確かめの後に取り消せること。取り消した発送の商品は発送準備中に戻り、全部を送っていた注文は DB の状態が決済完了に戻り、出荷日時・配送業者・追跡番号が空になること<br>・取り消した発送の、まだ送っていない発送のメールは取りやめにし、お客様には取消のメールを送らないこと。取り消せない時は理由を確かめの画面の中に出すこと | FREQ-443-AC-01<br>FREQ-443-AC-02<br>FREQ-443-AC-03<br>FREQ-443-AC-04 | ・3つの画面幅で、履歴の発送の行から取り消すと「発送（n回目）を取り消しました」の行が履歴に残り、取り消した発送には取消もメールの再送も出ず、一覧が読み直されること（E2E FR-ADMIN-072）<br>・同3画面幅で、「やめる」では取り消さず、窓口が取消を断った時は理由が確かめの画面の中に出ること（E2E FR-ADMIN-072）<br>・発送を取り消すと商品が発送準備中に戻り、全部送っていた注文が決済完了に戻って出荷日時などが空になり、2回目の取消は変更せず already_cancelled を返し、取り消した分の番号は使い回さないこと（E2E FR-ADMIN-072 の手元の DB・DB 結合）<br>・まだ送っていないその発送のメールは取りやめ（fulfillment_cancelled）になり、送った後に取り消してもお客様に取消のメールは行かないこと（E2E FR-ADMIN-072 の手元の DB と Mailpit） |
| FREQ-444 | お客様の注文の画面に、進み具合の段と、発送ごとの配送情報、まだ送っていない商品を出すこと（グループ E-1。FREQ-267 の配送情報を置き換える） | FREQ-444-REQ-01<br>FREQ-444-REQ-02<br>FREQ-444-REQ-03 | ・進み具合は、在庫の品だけの注文は「お支払い・発送準備中・配送中・配達済み」の4段、受注生産の品を含む注文は「お支払い・受注生産中・発送準備中・配送中・配達済み」の5段とし、キャンセル・決済失敗の注文には段を出さないこと<br>・配送情報は発送ごとに「配送情報（n回目）」の区切りで出し、配送業者・追跡番号・追跡のリンク・その発送の商品と数を並べること。取り消した発送は出さず、発送が無い注文には出さないこと<br>・まだ送っていない商品を「発送準備中の商品」「受注生産中の商品」の見出しで並べること。注文の窓口は、持ち主を確かめた後に service_role で発送と数を読み、注文の行の発送日時・配送業者・伝票番号は返さないこと | FREQ-444-AC-01<br>FREQ-444-AC-02<br>FREQ-444-AC-03<br>FREQ-444-AC-04 | ・3つの画面幅で、在庫の品だけの注文は4段、受注生産の品を含む注文は5段の進み具合が出て、済み・今の段とこれからの段が見分けられること（E2E FR-ACCOUNT-032）<br>・同3画面幅で、発送ごとに「配送情報（n回目）」の区切りが出て、配送業者・追跡番号・追跡のリンク・その発送の商品が並び、発送が無い注文には出ないこと（E2E FR-ACCOUNT-032・FR-ACCOUNT-031）<br>・同3画面幅で、「発送準備中の商品」「受注生産中の商品」の見出しの下に、まだ送っていない商品が並ぶこと（E2E FR-ACCOUNT-032）<br>・同3画面幅で、取り消した発送は出ず（窓口が返した発送だけをその番号で出す）、キャンセルした注文には進み具合の段が出ないこと（E2E FR-ACCOUNT-032） |
| FREQ-445 | 在庫の画面に、すぐ出せる数・引き当て済み・手元の数・受注生産の4つの数と、誰が・どの注文で動かしたかが分かる履歴を出すこと（グループ E-1。Shopify の在庫の状態と在庫の調整の履歴に合わせる） | FREQ-445-REQ-01<br>FREQ-445-REQ-02 | ・色・サイズごとに、すぐ出せる数（今の在庫の数）・引き当て済み（注文のために取ってある数。発送した数を引く）・手元の数（すぐ出せる数と引き当て済みの合計）・受注生産（未入金と入金済みの注文の、まだ仕上がっていない数）を出し、言葉の説明を画面に1回だけ書くこと<br>・履歴は新しい順に、日時・理由・増減・変わった後の数・備考・動かした人（空なら「自動」）・注文番号を出すこと | FREQ-445-AC-01<br>FREQ-445-AC-02<br>FREQ-445-AC-03 | ・3つの画面幅で、色・サイズごとに4つの数と言葉の説明（1回だけ）が出ること（E2E FR-ADMIN-073）<br>・同3画面幅で、履歴に動かした人（空なら「自動」）・注文番号・変わった後の数が出ること（E2E FR-ADMIN-073）<br>・引き当て済みは発送した数を引いた数で、受注生産は未入金と入金済みの注文のまだ仕上がっていない数だけ（取り消した注文は数えない）であり、履歴の関数は動かした人・注文・変わった後の数を返すこと（E2E FR-ADMIN-073 の手元の DB・DB 結合） |
| FREQ-446 | 在庫の品と受注生産の品が両方ある注文の確認のメールに、分けて送る案内を1行入れること（グループ E-1） | FREQ-446-REQ-01 | ・注文の確認のメール（入金済み・入金待ち）に、在庫の品と受注生産の品が両方ある時だけ、ご注文内容の下へ「在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。」を入れること。在庫を確保し直せなかった注文（review_reason が stock_not_reserved）には入れないこと | FREQ-446-AC-01<br>FREQ-446-AC-02 | ・在庫の品と受注生産の品が両方ある注文の確認のメール（入金済み・入金待ち）に、案内が1行だけ入ること（E2E FR-CHECKOUT-050 の手元の DB と Mailpit）<br>・片方の品だけの注文と、在庫を確保し直せなかった注文の確認のメールには、案内が入らないこと（E2E FR-CHECKOUT-050） |
```

**編集 1-2（FREQ-267 の行に、置き換えの注記を付ける）。** 古い行は消さず、変わった所の文の終わりに注記を足す。9つの置き換えを、1つずつ行う:

| 置き換え前（FREQ-267 の行に1つだけある） | 置き換え前の終わりに足す注記 |
|---|---|
| `・ADMIN の ORDER タブで、決済完了かつ未発送の注文にのみ「発送済みにする」操作を出すこと` | `（2026-10-10 FREQ-439・440 で置き換え。発送準備中か受注生産中の数がある決済完了の注文に出し、発送準備中の数がある商品と数を選んで送る）` |
| `・発送時に配送業者と追跡番号を入力させ、発送後は一覧のステータスを「発送済み」にすること` | `（FREQ-439 で置き換え。全部を送ると一覧の言葉は「配送中」、一部だけなら「一部発送済み」の印）` |
| `・発送済みの注文詳細に配送業者・追跡番号・追跡リンクを表示し、未発送では表示しないこと` | `（FREQ-444 で置き換え。発送ごとの「配送情報（n回目）」）` |
| `・mobile（390px）/ tablet（768px）/ desktop（1280px）で、決済完了の注文にのみ「発送済みにする」ボタンが表示されること` | `（FREQ-439-AC-01 に引き継ぐ。発送準備中か受注生産中の数がある注文に表示される）` |
| `・同3ビューポートで、配送業者と追跡番号を入力して発送すると一覧のステータスが「発送済み」になり、発送ボタンが消えること` | `（FREQ-439-AC-03 に引き継ぐ。一覧の言葉は「配送中」）` |
| `・更新対象が0件のとき409を返すこと` | `（FREQ-439-AC-04 に引き継ぐ。発送の窓口は断る理由を決まった言葉で返す）` |
| `・同3ビューポートで、発送済みの注文詳細に「配送情報」領域と「ヤマト運輸」「1234-5678-9012」「配送状況を確認する」リンクが表示されること` | `（FREQ-444-AC-02 に引き継ぐ。区切りの名前は「配送情報（1回目）」）` |
| `・同3ビューポートで、未発送の注文詳細に「配送情報」領域が表示されないこと` | `（FREQ-444-AC-02 に引き継ぐ）` |

FREQ-267-AC-04（横方向のスクロールが無いこと）は変わらない。FREQ-267 の要件の3つめ（決済完了以外のステータスや発送済みの注文は発送できないこと）も、発送準備中の数を超えて送れないことと合わせて、そのまま有効。

**編集 1-3（FREQ-268・FREQ-438 の行に、引き継ぎの注記を付ける）。** 置き換え前を、それぞれ次の文字列に替える（先頭は置き換え前のまま、終わりに注記を足す）:

| 置き換え前（それぞれ1つだけある） | 足す注記 |
|---|---|
| `・発送が成立したとき、注文時のメールアドレス宛に配送業者名・追跡番号・追跡URLを含むメールを送信すること` | `（2026-10-10 FREQ-442 で、発送ごとに1通・その発送の商品と数を書く形に置き換え）` |
| `・発送の画面に「お客様に発送のメールを送る」を置き（最初は入っている）、外したら発送の関数に「送らない」を渡すこと` | `（2026-10-10 FREQ-439・442 で引き継ぐ。発送の窓口の本文 notifyCustomer と発送の関数 admin_create_fulfillment に渡し、発送ごとに知らせるかを選ぶ）` |

- [ ] **Step 2: 基本設計（ER・API・ルート一覧）を直す**

`docs/03_BasicDesign/data/er.md`（概要の数は 63 テーブル・69 FK から 66 テーブル・75 FK になる。増えるのはテーブル3つと、物理 FK 6本: 発送の表 `order_id` の1本、発送の商品の表 `fulfillment_id`・`order_item_id` の2本、仕上がりの表 `order_id`・`order_item_id` の2本、注文のメールの表 `fulfillment_id` の1本。実行した人の列 `created_by`・`cancelled_by` は外部キーにしない（Task 1）ので数えない）

**編集 2-1（概要の数）。** 置き換え前:

```text
基準と本書のカート・お気に入り・グループ D の追記を反映した掲載対象は **63 テーブル（public 58、private 3、security 2）と 69 FK（public 起点 67、private 起点 2）**
```

置き換え後:

```text
基準と本書のカート・お気に入り・グループ D・グループ E-1 の追記を反映した掲載対象は **66 テーブル（public 61、private 3、security 2）と 75 FK（public 起点 72、private 起点 3）**
```

**編集 2-2。** 置き換え前:

```text
現行 SQL にある **1 ビュー** を第 6 節に記録する
```

置き換え後:

```text
グループ E-1 の移行 B で消した **1 ビュー**（消す前の定義）を第 6 節に記録する
```

**編集 2-3。** 置き換え前:

```text
後続の記載済みの追記を含む一覧は2026-10-09に数え直した。
```

置き換え後:

```text
後続の記載済みの追記を含む一覧は2026-10-09に数え直し、グループ E-1 の分を2026-10-10 に足した。
```

**編集 2-4（グループ D の追記の次に、E-1 の追記を足す）。** 置き換え前:

```text
片付けの定期処理が1件なこと、関数・表・制約・索引の定義が手元の移行と一致することを確かめた）。
```

置き換え後:

```text
片付けの定期処理が1件なこと、関数・表・制約・索引の定義が手元の移行と一致することを確かめた）。

2026-10-10 追記（グループ E-1、FREQ-439〜446）: [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) で `public.order_fulfillments`（発送。1回の発送が1行。取り消しても行は残し、番号は使い回さない）・`public.order_fulfillment_lines`（発送の商品と数。追記だけ）・`public.order_item_completions`（受注生産の品の仕上がり。商品ごとに1行）を足した。3つの表は RLS を有効にして表の権限を外し、service_role は読むだけ、書くのは SECURITY DEFINER の DB の関数だけにした。[移行 B](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql) で `private.order_email_outbox` に `fulfillment_id`（発送のメールの行だけが持つ）を足し、ビュー `public.variant_backorder_summary` を消した（受注生産の数は `public.list_variant_stock_states` が返す）。差分はテーブル +3、物理 FK +6（発送と仕上がりの表の5本と outbox の1本。実行した人の列 `created_by`・`cancelled_by` は、取消の列しか変えさせない守りと ON DELETE SET NULL がぶつかるので外部キーにしない）で、前の追記の63テーブル・69 FKから **66テーブル・75 FK** になる。本番の適用状況は未確認（本番へは push の後に当てる）。
```

**編集 2-5（領域の表）。** 置き換え前:

```text
注文のメール（送る予定・送信の一時停止・配達の知らせの受付済み） |
```

置き換え後:

```text
注文のメール（送る予定・送信の一時停止・配達の知らせの受付済み）、発送と仕上がりの記録 |
```

**編集 2-6（2.3 の ER 図の箱。注文のメールの表に発送の番号、新しい3つの表）。** 置き換え前（`ORDER_EMAIL_SEND_PAUSE` の箱の1行目。文書の中で1か所）:

```text
  ORDER_EMAIL_SEND_PAUSE {
```

置き換え後:

```text
  ORDER_FULFILLMENTS {
    uuid id PK "NOT_NULL"
    uuid order_id FK "NOT_NULL"
    uuid request_key UK "NOT_NULL"
    uuid created_by "NULL"
    uuid cancelled_by "NULL"
  }
  ORDER_FULFILLMENT_LINES {
    uuid fulfillment_id PK,FK "NOT_NULL"
    uuid order_item_id PK,FK "NOT_NULL"
  }
  ORDER_ITEM_COMPLETIONS {
    uuid id PK "NOT_NULL"
    uuid order_id FK "NOT_NULL"
    uuid order_item_id FK "NOT_NULL"
    uuid request_key "NOT_NULL"
    uuid created_by "NULL"
    uuid cancelled_by "NULL"
  }
  ORDER_EMAIL_SEND_PAUSE {
```

**編集 2-7（注文のメールの箱に列を1つ）。** 置き換え前（`ORDER_EMAIL_OUTBOX` の箱の中の1行。文書の中で1か所）:

```text
    text delivery_status "NULL"
```

置き換え後:

```text
    text delivery_status "NULL"
    uuid fulfillment_id FK "NULL"
```

**編集 2-8（2.3 の ER 図の関係）。** 置き換え前:

```text
  AUTH_USERS |o..o{ ORDER_EMAIL_OUTBOX : "requested_by"
```

置き換え後:

```text
  AUTH_USERS |o..o{ ORDER_EMAIL_OUTBOX : "requested_by"
  ORDERS ||..o{ ORDER_FULFILLMENTS : "order_id"
  ORDER_FULFILLMENTS ||--o{ ORDER_FULFILLMENT_LINES : "fulfillment_id"
  ORDER_ITEMS ||--o{ ORDER_FULFILLMENT_LINES : "order_item_id"
  ORDERS ||..o{ ORDER_ITEM_COMPLETIONS : "order_id"
  ORDER_ITEMS ||..o{ ORDER_ITEM_COMPLETIONS : "order_item_id"
  ORDER_FULFILLMENTS |o..o{ ORDER_EMAIL_OUTBOX : "fulfillment_id"
```

**編集 2-9（第 3 節の数）。** 置き換え前:

```text
以下は掲載対象の63テーブル・69 FKの定義元とキーの一覧。
```

置き換え後:

```text
以下は掲載対象の66テーブル・75 FKの定義元とキーの一覧。
```

**編集 2-10（3.3 の表。注文の参照元の数）。** 置き換え前:

```text
参照元 8 / 参照先 1 | [20260901102912:718]
```

置き換え後:

```text
参照元 10 / 参照先 1 | [20260901102912:718]
```

**編集 2-11。** 置き換え前:

```text
参照元 1 / 参照先 3 | [20260901102912:677]
```

置き換え後:

```text
参照元 3 / 参照先 3 | [20260901102912:677]
```

**編集 2-12（3.3 の表に新しい3つの表の行を足す）。** 置き換え前（在庫の台帳の行）:

```text
| `public.stock_movements` | `(id)` | なし | 参照元 0 / 参照先 3 | [20260919065355:6](../../../supabase/migrations/20260919065355_add_stock_movements.sql#L6) |
```

置き換え後:

```text
| `public.stock_movements` | `(id)` | なし | 参照元 0 / 参照先 3 | [20260919065355:6](../../../supabase/migrations/20260919065355_add_stock_movements.sql#L6) |
| `public.order_fulfillments` | `(id)` | `(order_id, number)`; `(request_key)` | 参照元 2 / 参照先 1 | [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_fulfillment_lines` | `(fulfillment_id, order_item_id)` | なし | 参照元 0 / 参照先 2 | [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_item_completions` | `(id)` | `(request_key, order_item_id)` | 参照元 0 / 参照先 2 | [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
```

**編集 2-13（注文のメールの表の行）。** 置き換え前:

```text
自動 `(order_id, kind)`; 手の送信待ち `(order_id, kind)`; `(provider_message_id)` | 参照元 0 / 参照先 2（orders・auth.users）
```

置き換え後:

```text
自動 `(order_id, kind)`（発送のメール以外）; 自動の発送のメール `(fulfillment_id)`; 手の送信待ち `(order_id, kind, fulfillment_id)`（NULLS NOT DISTINCT）; `(provider_message_id)` | 参照元 0 / 参照先 3（orders・auth.users・order_fulfillments）
```

**編集 2-14（3.4 の見出しの前に、発送と仕上がりの列・索引の節を足す）。** 置き換え前:

```text
### 3.4 決済・下書き
```

置き換え後:

```text
#### 発送と仕上がりの列・索引（2026-10-10）

| 表 | 列と制約 |
| --- | --- |
| `order_fulfillments` | `id uuid` PK（gen_random_uuid）、`order_id uuid` NOT NULL（RESTRICT）、`number integer` NOT NULL（1以上。`(order_id, number)` UNIQUE。取り消した分の番号は使い回さない）、`request_key uuid` NOT NULL UNIQUE、`shipping_carrier text`（yamato・sagawa・japanpost）、`tracking_number text`（`^[0-9A-Za-z-]{1,64}$`）、`notify_customer boolean` NOT NULL、`completes_order boolean` NOT NULL、`shipped_at timestamptz` NOT NULL（now）、`created_by uuid`・`cancelled_by uuid`（`auth.users` の番号。外部キーにしない: 消した人を空にする ON DELETE SET NULL は UPDATE として動き、取消の列しか変えさせない守りとぶつかるため。`stock_movements.created_by` と同じ）、`cancelled_at timestamptz`、`legacy boolean` NOT NULL（false）。CHECK は `legacy OR (shipping_carrier IS NOT NULL AND tracking_number IS NOT NULL)` と `cancelled_by IS NULL OR cancelled_at IS NOT NULL` |
| `order_fulfillment_lines` | `fulfillment_id uuid`・`order_item_id uuid`（どちらも RESTRICT）、`quantity integer` NOT NULL（1以上）。PK は `(fulfillment_id, order_item_id)`。追記だけ（変更と削除をトリガーで拒む） |
| `order_item_completions` | `id uuid` PK、`order_id uuid`・`order_item_id uuid`（RESTRICT。受注生産の品だけ）、`quantity integer` NOT NULL（1以上）、`request_key uuid` NOT NULL（`(request_key, order_item_id)` UNIQUE）、`created_by uuid`・`cancelled_by uuid`（`auth.users` の番号。外部キーにしない: 消した人を空にする ON DELETE SET NULL は UPDATE として動き、取消の列しか変えさせない守りとぶつかるため。`stock_movements.created_by` と同じ）、`created_at timestamptz` NOT NULL、`cancelled_at timestamptz`、`legacy boolean` NOT NULL。CHECK は `cancelled_by IS NULL OR cancelled_at IS NOT NULL` |
| `private.order_email_outbox` | `fulfillment_id uuid`（`order_fulfillments(id)`、RESTRICT）を足す。CHECK は `(kind = 'shipped') = (fulfillment_id IS NOT NULL)` |

| 索引 | 対象・用途 |
| --- | --- |
| `order_fulfillments(order_id, number)` の UNIQUE | その注文の何回目の発送か |
| `order_fulfillment_lines(order_item_id)` | 商品ごとの発送した数 |
| `stock_movements(order_item_id)` | 引き当て済みの数を、商品の行ごとに台帳から数える |

3つの表は RLS を有効にし、anon・authenticated の権限を外し、service_role は SELECT だけを持つ。書くのは `admin_create_fulfillment`・`admin_cancel_fulfillment`・`admin_record_completion`・`admin_cancel_completion`（どれも SECURITY DEFINER）だけ。商品ごとの数は `private.order_line_fulfillment` の1か所で数え、`shipped ≤ completed ≤ quantity` を DB の関数とトリガーで守る。定義は [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql)・[移行 B](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql) に従う。

### 3.4 決済・下書き
```

**編集 2-15（4.3 の外部キーの表に6行を足す。実行した人の列 `created_by`・`cancelled_by` は外部キーにしないので入れない）。** 置き換え前:

```text
| `private.order_email_outbox.requested_by` | `auth.users(id)` | `uuid` / 可 | 0..N | `SET NULL` | [移行 A:18](../../../supabase/migrations/20261009095633_order_email_outbox.sql#L18) |
```

置き換え後:

```text
| `private.order_email_outbox.requested_by` | `auth.users(id)` | `uuid` / 可 | 0..N | `SET NULL` | [移行 A:18](../../../supabase/migrations/20261009095633_order_email_outbox.sql#L18) |
| `public.order_fulfillments.order_id` | `public.orders(id)` | `uuid` / 不可 | 0..N | `RESTRICT` | [E-1 移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_fulfillment_lines.fulfillment_id` | `public.order_fulfillments(id)` | `uuid` / 不可 | 0..N | `RESTRICT` | [E-1 移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_fulfillment_lines.order_item_id` | `public.order_items(id)` | `uuid` / 不可 | 0..N | `RESTRICT` | [E-1 移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_item_completions.order_id` | `public.orders(id)` | `uuid` / 不可 | 0..N | `RESTRICT` | [E-1 移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `public.order_item_completions.order_item_id` | `public.order_items(id)` | `uuid` / 不可 | 0..N | `RESTRICT` | [E-1 移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| `private.order_email_outbox.fulfillment_id` | `public.order_fulfillments(id)` | `uuid` / 可 | 0..N | `RESTRICT` | [E-1 移行 B](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql) |
```

**編集 2-16（5.2 に E-1 の箇条書きを足す）。** 置き換え前:

```text
会員から空への更新は、その会員の `profiles` の行が無い時、つまり会員を消して FK の `ON DELETE SET NULL` が空にする時だけ通る。
```

置き換え後:

```text
会員から空への更新は、その会員の `profiles` の行が無い時、つまり会員を消して FK の `ON DELETE SET NULL` が空にする時だけ通る。
- [グループ E-1 の移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql) は、発送した数・仕上がった数を、変えられない `order_items` ではなく 3 つの新しい表に持つ（商品ごとの数は `private.order_line_fulfillment` の 1 か所で数え、`shipped ≤ completed ≤ quantity` を DB の関数とトリガーで守る）。`orders.shipped_at`・`shipping_carrier`・`tracking_number` は「全部の商品を発送した時」の値として残し、発送の取消で未発送が出たら空に戻す（`shipped_at` で戻し先を決める返金の取り消しの決まりが、そのまま使える）。`private.order_email_outbox.fulfillment_id` は、種類が `shipped` の行だけが持つ（`(kind = 'shipped') = (fulfillment_id IS NOT NULL)` の CHECK）。
```

**編集 2-17（第 6 節の数）。** 置き換え前:

```text
第 2〜4 節の63テーブル・69 FKには加算していない
```

置き換え後:

```text
第 2〜4 節の66テーブル・75 FKには加算していない
```

**編集 2-18（6.2 のビューは消した）。** 置き換え前:

```text
### 6.2 `public.variant_backorder_summary` ビュー
```

置き換え後:

```text
### 6.2 `public.variant_backorder_summary` ビュー（2026-10-10 に消した）

グループ E-1 の[移行 B](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql)で消した。受注生産の数は、仕上がっていない数だけを数える `public.list_variant_stock_states` が返す（[在庫の画面](../../04_DetailDesign/pages/16_admin.md)）。以下は消す前の定義の記録。
```

**編集 2-19。** 置き換え前:

```text
現行 [商品バリアント API](../../../src/app/api/admin/items/[id]/variants/route.ts#L82) が参照する。
```

置き換え後:

```text
消す前は、[商品バリアント API](../../../src/app/api/admin/items/[id]/variants/route.ts) だけが参照していた。
```

`docs/03_BasicDesign/api/api-spec.md`（5つの窓口を足す。合わせて、注文の状態の窓口から発送を除くこと、お客様の注文の窓口の答えの形、管理画面の注文の一覧の答え、在庫の窓口の答えを直す。ルートのファイル数と組数は、この文書が元から「再集計していない」と書いているので、数え直さずに注記だけ足す）

**編集 2-20（確認日の行）。** 置き換え前:

```text
グループ C の変更を 2026-10-08 に反映）
```

置き換え後:

```text
グループ C の変更を 2026-10-08、注文の発送・仕上がり・お客様の注文・在庫の行はグループ E-1 の変更を 2026-10-10 に反映）
```

**編集 2-21（お客様の注文の一覧の窓口）。** 置き換え前:

```text
JWT subがuser_idの注文。hidden status除外、金額/日付整形、画像署名、no-store
```

置き換え後:

```text
JWT subがuser_idの注文。hidden status除外、金額/日付整形、画像署名、no-store。statusは注文の進み具合の言葉（グループ E-1。deriveOrderProgress）
```

**編集 2-22（お客様の注文の詳細の窓口）。** 置き換え前:

```text
id + JWT subで取得、hidden status除外、no-store
```

置き換え後:

```text
id + JWT subで取得、hidden status除外、no-store。持ち主を確かめた後に service_role で発送と商品ごとの数を読み、progress（言葉と段）・shipments（取り消していない発送）を返す（グループ E-1）
```

**編集 2-23（管理画面の注文の一覧の窓口）。** 置き換え前:

```text
Stripe状態/返金残額/操作可否/レビュー要否を付加
```

置き換え後:

```text
Stripe状態/返金残額/操作可否/レビュー要否を付加。商品の行ごとの数（service_role で読む）から、注文の言葉（status）・DB の状態（orderStatus）・言葉の記号（progressKey）・一部発送済みか・仕上がりを記録できるかを返す（グループ E-1）
```

**編集 2-24（履歴の窓口）。** 置き換え前:

```text
受付・状態の変化（返金を含む）・メールを新しい順、送信の一時停止、no-store
```

置き換え後:

```text
受付・状態の変化（返金を含む）・発送・発送の取消・仕上がり・仕上がりの取消（グループ E-1）・メールを新しい順、送信の一時停止、no-store。発送のメールは何回目の発送かを付ける
```

**編集 2-25（メールの再送の窓口）。** 置き換え前:

```text
Path UUID、JSON `{kind}`（注文のメール5種類）
```

置き換え後:

```text
Path UUID、JSON `{kind,fulfillmentId?}`（注文のメール5種類。発送のメールは発送の番号 fulfillmentId が要る）
```

**編集 2-26。** 置き換え前:

```text
409 送信待ちの再送あり/状態不適合/再送元なし
```

置き換え後:

```text
409 送信待ちの再送あり/状態不適合/再送元なし/発送の番号が無い・取り消し済み
```

**編集 2-27（状態の窓口は取消だけになる。入力）。** 置き換え前:

```text
Path UUID。JSON O-status（cancelled又はshipped。下記）
```

置き換え後:

```text
Path UUID。JSON O-status（cancelledだけ。下記）
```

**編集 2-28（応答）。** 置き換え前:

```text
200 `{success:true,status:"cancelled"&#124;"shipped"}`
```

置き換え後:

```text
200 `{success:true,status:"cancelled"}`
```

**編集 2-29（失敗）。** 置き換え前:

```text
409 発送/取消条件・Stripe支払い競合
```

置き換え後:

```text
409 取消条件・Stripe支払い競合
```

**編集 2-30（状態の窓口の補足を直し、発送と仕上がりの5つの窓口の行を足す）。** 置き換え前:

```text
発送RPC・追跡情報/メール、又は未入金取消/Checkout expiry/例外照合。入金済みはこの操作で返金しない [実装](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
```

置き換え後:

```text
未入金取消/Checkout expiry/例外照合。入金済みはこの操作で返金しない。発送はこの窓口からは受けない（グループ E-1 から `…/fulfillments`） [実装](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `GET /api/admin/orders/[id]/fulfillments` | RBAC `admin.orders.manage` | Path UUID | 200 `{order:{id,orderNumber,status,progress},blockedReason,lines,fulfillments}`。linesは商品ごとの `{orderItemId,name,color,size,fulfillmentType,quantity,shipped,inProduction,readyUnshipped,unshipped}` | 400 id; 404 order; 500 DB/例外 | 発送の画面と仕上がりの画面の材料。service_role で数と発送の一覧（取り消した分も含む）を読む。発送できない理由 `blockedReason`（not_shippable・address_incomplete・payment_review_required）を返す [実装](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) |
| `POST /api/admin/orders/[id]/fulfillments` | RBAC `admin.orders.manage` + CSRF C、送信元・管理者ごと10分に60回 | Path UUID、JSON O-fulfillment（下記） | 200 `{fulfillmentId,number,completesOrder,orderStatus,replayed}` | 400 id/body; 404 order; 409 発送できない状態・配送先不足・支払額の確認・発送準備中の数の超過・同じ番号で中身が違う; 429 回数; 503 制限DB障害; 500 DB/例外 | 発送の関数 `admin_create_fulfillment` で発送を1回分記録し、監査 `admin.orders.fulfillment.create`、応答後 after() で worker。同じ重複防止キーの送り直しは前の結果（`replayed:true`） [実装](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) |
| `POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel` | RBAC `admin.orders.manage` + CSRF C、送信元・管理者ごと10分に30回 | Path 注文UUID・発送UUID、本文なし | 200 `{outcome:"cancelled"&#124;"already_cancelled",orderStatus}` | 400 id; 404 order/発送; 409 取り消せない状態; 429; 503; 500 | 発送の取消の関数 `admin_cancel_fulfillment`。shipped なら paid に戻し、送る前のその発送のメールを取りやめる。監査 `admin.orders.fulfillment.cancel` [実装](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/cancel/route.ts) |
| `POST /api/admin/orders/[id]/completions` | RBAC `admin.orders.manage` + CSRF C、送信元・管理者ごと10分に60回 | Path UUID、JSON O-completion（下記） | 200 `{completionIds,replayed}` | 400 id/body; 404 order; 409 仕上がりを記録できない状態・受注生産中の数の超過・同じ番号で中身が違う; 429; 503; 500 | 仕上がりの記録の関数 `admin_record_completion`。お客様にメールは送らない。監査 `admin.orders.completion.record` [実装](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts) |
| `POST /api/admin/orders/[id]/completions/[completionId]/cancel` | RBAC `admin.orders.manage` + CSRF C、送信元・管理者ごと10分に30回 | Path 注文UUID・仕上がりUUID、本文なし | 200 `{outcome:"cancelled"&#124;"already_cancelled"}` | 400 id; 404 order/仕上がり; 409 もう発送した数を下回る・状態不適合; 429; 503; 500 | 仕上がりの取消の関数 `admin_cancel_completion`。監査 `admin.orders.completion.cancel` [実装](../../../src/app/api/admin/orders/%5Bid%5D/completions/%5BcompletionId%5D/cancel/route.ts) |
```

**編集 2-31（在庫の窓口の答え）。** 置き換え前:

```text
200 `{variants:[{id,colorName,colorHex,sizeLabel,sku,stockQuantity,isActive,backorderQuantity}],movements}`
```

置き換え後:

```text
200 `{variants:[{id,colorName,colorHex,sizeLabel,sku,stockQuantity,isActive,committedQuantity,onHandQuantity,backorderQuantity}],movements:[{id,variantId,delta,reason,note,createdAt,actorEmail,orderId,orderNumber,balanceAfter}]}`
```

**編集 2-32。** 置き換え前:

```text
sync_item_variants_from_itemを先に実行（GETにもDB更新あり）
```

置き換え後:

```text
sync_item_variants_from_itemを先に実行（GETにもDB更新あり）。引き当て済み・受注生産は list_variant_stock_states、履歴は list_item_stock_history で読む（グループ E-1）
```

**編集 2-33（注文の一覧の答えの定義）。** 置き換え前:

```text
金額は通貨整形済みstring、statusは表示label
```

置き換え後:

```text
金額は通貨整形済みstring、statusは進み具合の表示label（未決済・受注生産中・発送準備中・配送中・配達済み・決済失敗・キャンセル。グループ E-1）
```

**編集 2-34（注文の詳細の答えの定義）。** 置き換え前:

```text
shippingAddress,shippedAt,shippingCarrier,trackingNumber,items}
```

置き換え後:

```text
shippingAddress,progress,shipments,items}
```

**編集 2-35。** 置き換え前:

```text
statusはraw、金額は通貨整形済みstring。一覧・詳細ともpayment_in_progress/abandonedを除外
```

置き換え後:

```text
statusはraw。progressは `{key,label,partiallyShipped,steps}`（stepsはお客様の進み具合の段 `{key,label,state}`。キャンセル・決済失敗などはnull）、shipmentsは取り消していない発送ごとの `{id,number,shippedAt,carrier,carrierLabel,trackingNumber,trackingUrl,items:[{orderItemId,name,color,size,quantity}]}`、itemsの各行に `shippedQuantity,readyQuantity,inProductionQuantity` を足す（グループ E-1。注文の行の発送日時・配送業者・伝票番号は返さない）。金額は通貨整形済みstring。一覧・詳細ともpayment_in_progress/abandonedを除外
```

**編集 2-36（発送の本文の定義を、発送と仕上がりの本文の定義に替える）。** 置き換え前:

```text
| O-status: shipped | `{status:"shipped",carrier:SHIPPING_CARRIER_IDS,trackingNumber:trim/1〜64,notifyCustomer?:boolean}`。notifyCustomerは真偽・既定true、falseなら発送のメールの行を書かない。trackingNumberは英数字/hyphenのみ。paid/未発送/配送必須項目充足/支払額の要対応解決などをRPCで確認 | [status Handler](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts)、[shipping-carriers](../../../src/lib/orders/shipping-carriers.ts) |
```

置き換え後:

```text
| O-fulfillment | `{requestKey:UUID,carrier:SHIPPING_CARRIER_IDS,trackingNumber:trim/1〜64,notifyCustomer?:boolean,lines:[{orderItemId:UUID,quantity:1〜999}]}`。linesは1〜100行で、同じ商品は1行だけ。notifyCustomerは真偽・既定true、falseならその発送のメールの行を書かない。trackingNumberは英数字/hyphenのみ。決済完了・配送必須項目充足・支払額の要対応解決・各商品が発送準備中の数以内などをRPCで確認し、断りはDBの決まった言葉（ORDER_NOT_SHIPPABLE・SHIPPING_ADDRESS_INCOMPLETE・PAYMENT_REVIEW_REQUIRED・QUANTITY_EXCEEDS_READY・FULFILLMENT_REQUEST_MISMATCHなど）から画面の言葉とHTTPに直す | [fulfillments Handler](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts)、[fulfillment-messages.ts](../../../src/lib/orders/fulfillment/fulfillment-messages.ts)、[shipping-carriers](../../../src/lib/orders/shipping-carriers.ts) |
| O-completion | `{requestKey:UUID,lines:[{orderItemId:UUID,quantity:1〜999}]}`。linesは1〜100行。決済完了の注文の受注生産の品の、受注生産中の数以内だけ記録できる。断りは ORDER_NOT_IN_PRODUCTION・LINE_NOT_IN_PRODUCTION・QUANTITY_EXCEEDS_IN_PRODUCTION・COMPLETION_REQUEST_MISMATCH（取消は COMPLETION_ALREADY_SHIPPED） | [completions Handler](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts)、[fulfillment-messages.ts](../../../src/lib/orders/fulfillment/fulfillment-messages.ts) |
```

**編集 2-37（管理画面の注文の答えの定義）。** 置き換え前:

```text
canShip/missingShippingFields/shipBlockedReason、needsReview
```

置き換え後:

```text
canShip/canRecordCompletion/missingShippingFields/shipBlockedReason、status（進み具合の言葉）/orderStatus（DBの状態）/progressKey/partiallyShipped、itemsの各行のid/color/size/fulfillmentType/shipped/inProduction/readyUnshipped（グループ E-1）、needsReview
```

**編集 2-38（更新・検証範囲の注記）。** 置き換え前:

```text
上の件数（89・125）は2026-10-03時点のままであり、再集計していない。
```

置き換え後:

```text
上の件数（89・125）は2026-10-03時点のままであり、再集計していない。

2026-10-10にグループ E-1 の入口の変更を表へ反映した（`POST /api/admin/orders/[id]/status` から発送を除き、発送・発送の取消・仕上がり・仕上がりの取消の5組を足し、お客様の注文・管理画面の注文の一覧・在庫の答えと、メールの再送の本文を直した）。実装を読んで書いたもので、上の件数は再集計していない。
```

`docs/03_BasicDesign/api/route-inventory.md`

**編集 2-39（確認日の行）。** 置き換え前:

```text
カートの入口の変更は 2026-10-08 に反映）
```

置き換え後:

```text
カートの入口の変更は 2026-10-08、発送・仕上がりの入口の変更は 2026-10-10 に反映）
```

**編集 2-40（仕上がりの2つのルートを、メールの中身のルートの前に足す）。** 置き換え前:

```text
| `/api/admin/orders/[id]/emails/[emailId]` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/%5BemailId%5D/route.ts) |
```

置き換え後:

```text
| `/api/admin/orders/[id]/completions/[completionId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/%5BcompletionId%5D/cancel/route.ts) |
| `/api/admin/orders/[id]/completions` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts) |
| `/api/admin/orders/[id]/emails/[emailId]` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/%5BemailId%5D/route.ts) |
```

**編集 2-41（発送の2つのルートを、履歴のルートの前に足す）。** 置き換え前:

```text
| `/api/admin/orders/[id]/history` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/history/route.ts) |
```

置き換え後:

```text
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/cancel/route.ts) |
| `/api/admin/orders/[id]/fulfillments` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) |
| `/api/admin/orders/[id]/history` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/history/route.ts) |
```

**編集 2-42（注文のメールと発送の節の説明）。** 置き換え前:

```text
発送は `POST /api/admin/orders/[id]/status` の本文 `notifyCustomer`（真偽、既定 true）で知らせるかを選ぶ。
```

置き換え後:

```text
発送・発送の取消・仕上がり・仕上がりの取消は `admin.orders.manage`・CSRF・回数の制限（発送と仕上がりの記録は10分に60回、取消は30回）で、発送は `POST /api/admin/orders/[id]/fulfillments` の本文 `notifyCustomer`（真偽、既定 true）で知らせるかを選ぶ（グループ E-1。発送ごとに発送のメールを1通送る）。
```

- [ ] **Step 3: 詳細設計（状態・流れ）を直す**

`docs/04_DetailDesign/states/order-payment.md`（DB の状態の値は変えない。一部の発送の間は決済完了のまま、発送の取消で発送済みから決済完了に戻る、`shipped_at` は「全部を送った時」の値、画面の言葉との対応）

**編集 3-1（根拠の略号に E-1 の移行を足す）。** 置き換え前:

```text
| D | [グループ D の移行 B: 入金済み・入金待ち・在庫解放・発送と、同じ取引でのメールの行の作成](../../../supabase/migrations/20261009095736_order_email_enqueue.sql) |
```

置き換え後:

```text
| D | [グループ D の移行 B: 入金済み・入金待ち・在庫解放・発送と、同じ取引でのメールの行の作成](../../../supabase/migrations/20261009095736_order_email_enqueue.sql) |
| FA | [グループ E-1 の移行 A: 発送・仕上がりの記録と商品ごとの数](../../../supabase/migrations/20261010120000_order_fulfillments.sql) |
| FB | [グループ E-1 の移行 B: 発送・発送の取消と、発送ごとのメールの行](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql) |
```

**編集 3-2（状態の意味。決済完了）。** 置き換え前:

```text
| `paid` | Stripe現在値を入金済みと照合した状態。金額不一致や未確保在庫が残る場合もあり得る |
```

置き換え後:

```text
| `paid` | Stripe現在値を入金済みと照合した状態。金額不一致や未確保在庫が残る場合もあり得る。一部の商品だけ発送した間、受注生産の品を作っている間も `paid` のまま（グループ E-1） |
```

**編集 3-3（状態の意味。発送済み）。** 置き換え前:

```text
| `shipped` | 管理出荷RPCで出荷情報を保存した状態 |
```

置き換え後:

```text
| `shipped` | 全部の商品を発送した状態。最後の発送の関数が `paid` から変え、出荷日時・配送業者・追跡番号をその発送の値で保存する。発送の取消で未発送が出たら `paid` に戻して空にする（グループ E-1） |
```

**編集 3-4（状態遷移図）。** 置き換え前:

```text
    paid --> shipped: ST-ORDER-08 / 出荷
```

置き換え後:

```text
    paid --> shipped: ST-ORDER-08 / 最後の発送で未発送が0
    shipped --> paid: ST-ORDER-11 / 発送の取消
    paid --> paid: ST-ORDER-12 / 一部の発送・仕上がり・取消（状態は変えない）
```

**編集 3-5（ST-ORDER-08 を、発送ごとの記録に直す）。** 置き換え前:

```text
| ST-ORDER-08 | admin.orders.manage、actor・配送業者・追跡番号、paid、未出荷、必須配送先が揃い、未解決paid_amount_mismatchがない | shipped、出荷日時・配送情報、`notifyCustomer` が true の時だけ発送メールの行を同じ取引で書く。review_reason未確認自体はこのRPCの拒否条件に含まれていない | D、管理status API |
```

置き換え後:

```text
| ST-ORDER-08 | admin.orders.manage、actor・重複防止キー・配送業者・追跡番号・商品と数、paid、必須配送先が揃い、未解決paid_amount_mismatchがなく、各商品の数が発送準備中の数以内。この発送で未発送の数が全部0になる（`completes_order`） | shipped、出荷日時・配送情報（その発送の値）。発送ごとに発送の記録を1つ書く（全部を送らない発送は ST-ORDER-12）。`notifyCustomer` が true の時だけ、その発送の発送メールの行を同じ取引で書く。review_reason未確認自体はこのRPCの拒否条件に含まれていない | FB、管理発送API |
```

**編集 3-6（ST-ORDER-11・12 の行を足す）。** 置き換え前:

```text
| ST-ORDER-10 | cancelledの旧返金額が全額、新たな成功返金額が全額未満、同じCAS条件 | shipped_atありならshipped、なしならpaid。未入金由来の取消（旧返金額が全額未満）は戻さない | R、返金同期 |
```

置き換え後:

```text
| ST-ORDER-10 | cancelledの旧返金額が全額、新たな成功返金額が全額未満、同じCAS条件 | shipped_atありならshipped、なしならpaid。未入金由来の取消（旧返金額が全額未満）は戻さない | R、返金同期 |
| ST-ORDER-11 | 発送の取消: admin.orders.manage、注文がpaidかshipped、発送がその注文の物で未取消 | 発送に取消の時刻と人を書く。注文がshippedならpaidに戻し、出荷日時・配送業者・追跡番号を空にする。その発送のまだ送っていない発送メールの行を取りやめ（`fulfillment_cancelled`）にする。お客様には知らせない。取消済みなら `already_cancelled`（変更なし） | FB、管理発送の取消API |
| ST-ORDER-12 | 一部の発送、仕上がりの記録、仕上がりの取消。paid（発送の取消はpaidかshipped） | 状態は変えない。発送・仕上がりは別の表に1回ごとに記録する。発送した数は発送準備中の数まで、仕上がりは受注生産中の数まで。画面の言葉（受注生産中・発送準備中・配送中）は記録から出す | FA、FB |
```

**編集 3-7（画面の言葉と DB の状態の節を足す）。** 置き換え前:

```text
## Stripe現在値の分類
```

置き換え後:

```text
## 画面の言葉と DB の状態（グループ E-1）

DB の状態の値（上の7つ）は変えない。管理画面とお客様の画面の言葉は、商品ごとの数（`private.order_line_fulfillment`）から [order-progress.ts](../../../src/lib/orders/order-progress.ts) が出す。管理画面・窓口・お客様の画面が同じ言葉を使う。

| DB の状態 | 商品ごとの数 | 出す言葉 |
| --- | --- | --- |
| `payment_in_progress` | — | 支払い手続き中（管理画面だけ。お客様には出さない） |
| `pending` | — | 未決済 |
| `paid`・`shipped` | 受注生産中の数が1以上の商品がある | 受注生産中 |
| `paid`・`shipped` | 上が無く、発送準備中の数が1以上の商品がある | 発送準備中 |
| `paid`・`shipped` | 上が無く、発送した数が1以上 | 配送中（配達済みは E-4。E-1 では発送した品は全部「配送中」） |
| `failed` | — | 決済失敗 |
| `abandoned` | — | 放棄（管理画面だけ） |
| `cancelled` | — | キャンセル |

- 「一部発送済み」の印は、`paid`・`shipped` の注文で、発送した数が1以上かつ未発送の数も1以上の時に付ける（管理画面だけ）。
- 商品ごとの数: 発送した数（取り消していない発送の合計）、仕上がった数（在庫の品は注文の数、受注生産の品は取り消していない仕上がりの合計）、受注生産中の数（注文の数 − 仕上がった数）、発送準備中の数（仕上がった数 − 発送した数）、未発送の数（注文の数 − 発送した数）。`shipped ≤ completed ≤ quantity` を DB の関数とトリガーで守る。
- お客様の進み具合の段は、在庫の品だけの注文が「お支払い・発送準備中・配送中・配達済み」、受注生産の品を含む注文が「お支払い・受注生産中・発送準備中・配送中・配達済み」。今の段は、注文のいちばん手前の段階で決める。キャンセル・決済失敗の注文には段を出さない。

## Stripe現在値の分類
```

**編集 3-8（独立属性。出荷の拒否の言い方）。** 置き換え前:

```text
解決するまで出荷RPCが拒否する。paidであることだけから出荷可能とは判断しない。
```

置き換え後:

```text
解決するまで発送の関数（`admin_create_fulfillment`）が拒否する。paidであることだけから発送可能とは判断しない。
```

**編集 3-9（独立属性。発送の記録と出荷日時の意味を足す）。** 置き換え前:

```text
- 在庫確保はstock_movementsのpurchase/cancel差で判断する。`stock_released`という列を仮定しない。未入金取消は解放、返金取消は台帳を変更しない。
```

置き換え後:

```text
- 在庫確保はstock_movementsのpurchase/cancel差で判断する。`stock_released`という列を仮定しない。未入金取消は解放、返金取消は台帳を変更しない。
- 発送した数・仕上がった数は、変えられない注文の明細ではなく、`order_fulfillments`・`order_fulfillment_lines`・`order_item_completions` に1回ごとに記録する。発送は在庫の台帳を動かさない（在庫は注文の時に確保済み）。
- `shipped_at`・`shipping_carrier`・`tracking_number` は「全部の商品を発送した時」の値で、一部だけ送った間は空。返金の取り消しの戻し先（ST-ORDER-10）はこの値の有無で決める。発送の取消で未発送が出たら空に戻す（ST-ORDER-11）。
```

**編集 3-10（関連テスト）。** 置き換え前:

```text
[出荷API](../../../tests/unit/api/admin/order-status-shipped.test.ts)
```

置き換え後:

```text
[発送・仕上がりのDB](../../../tests/integration/db/order_fulfillments.integration.test.ts)、[発送ごとのメールのDB](../../../tests/integration/db/fulfillment_order_emails.integration.test.ts)、[発送・仕上がりのE2E](../../../e2e/FR-ADMIN-068-partial-fulfillment.spec.ts)
```

`docs/04_DetailDesign/sequence/order-administration.md`（出荷の節を、仕上がり・発送ごと・取消の節に書き直す）

**編集 3-11（頭の行）。** 置き換え前:

```text
> 状態: 現行ソース確認 | 確認日: 2026-10-04 | 対象: 未入金取消、出荷、管理返金、要対応の解決
```

置き換え後:

```text
> 状態: 現行ソース確認（発送の節はグループ E-1 の変更を 2026-10-10 に反映） | 確認日: 2026-10-04 | 対象: 未入金取消、発送（一部の発送・仕上がり・取消を含む）、管理返金、要対応の解決
```

**編集 3-12（根拠の表。状態の窓口は取消だけ、発送と仕上がりの窓口を足す）。** 置き換え前:

```text
| `POST /api/admin/orders/[id]/status`、取消・出荷 | [status API](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
```

置き換え後:

```text
| `POST /api/admin/orders/[id]/status`、未入金の取消 | [status API](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `GET`・`POST /api/admin/orders/[id]/fulfillments`、発送の取消 `…/fulfillments/[fulfillmentId]/cancel` | [発送API](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts)、[発送の取消API](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/cancel/route.ts) |
| `POST /api/admin/orders/[id]/completions`、仕上がりの取消 `…/completions/[completionId]/cancel` | [仕上がりAPI](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts)、[仕上がりの取消API](../../../src/app/api/admin/orders/%5Bid%5D/completions/%5BcompletionId%5D/cancel/route.ts) |
```

**編集 3-13（根拠の表。出荷の関数）。** 置き換え前:

```text
| 出荷 | [移行 B の最新の発送RPC](../../../supabase/migrations/20261009095736_order_email_enqueue.sql)、[必須配送先判定](../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) |
```

置き換え後:

```text
| 発送・仕上がり | [E-1 移行 A: 商品ごとの数と仕上がりの関数](../../../supabase/migrations/20261010120000_order_fulfillments.sql)、[E-1 移行 B: 発送・発送の取消の関数](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql)、[必須配送先判定](../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) |
```

**編集 3-14（根拠の表。取消・発送のメール）。** 置き換え前:

```text
| 取消・出荷のメール | [送る予定の表](../../../supabase/migrations/20261009095633_order_email_outbox.sql)、[状態を変える関数](../../../supabase/migrations/20261009095736_order_email_enqueue.sql)、
```

置き換え後:

```text
| 取消・発送のメール（発送は発送ごとに1通） | [送る予定の表](../../../supabase/migrations/20261009095633_order_email_outbox.sql)、[状態を変える関数](../../../supabase/migrations/20261009095736_order_email_enqueue.sql)、[発送ごとのメールの行](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql)、
```

**編集 3-15（認可と CSRF の段落）。** 置き換え前:

```text
これはAPI独自のチェックであり、共通proxyのOrigin検査と別に行われる。
```

置き換え後:

```text
これはAPI独自のチェックであり、共通proxyのOrigin検査と別に行われる。発送・仕上がりのAPI（`fulfillments`・`completions`）は、管理認可（`admin.orders.manage`）→ CSRF helper → 回数の制限（送信元ごと・管理者ごと）→ 注文の番号の検証 → 本文の検証の順で、先に断った段階で後ろへ進まない（[メールの再送API](../../../src/app/api/admin/orders/%5Bid%5D/emails/resend/route.ts)と同じ形）。
```

**編集 3-16（照会入口。一覧の窓口）。** 置き換え前:

```text
canShip/canCancel/canRefund等の表示用属性を返す。状態変更はしない。操作時は各POSTが再検証する
```

置き換え後:

```text
canShip/canRecordCompletion/canCancel/canRefund等の表示用属性と、商品ごとの数から出した注文の言葉（status）・一部発送済みかを返す。状態変更はしない。操作時は各POSTが再検証する
```

**編集 3-17（照会入口に発送の材料を足す）。** 置き換え前:

```text
| `GET /api/admin/orders/[id]/status` | 同じread認可でPOSTの説明とrequiredBodyを返す。対象注文の現在状態を取得・変更するAPIではない | [status API](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
```

置き換え後:

```text
| `GET /api/admin/orders/[id]/status` | 同じread認可でPOSTの説明とrequiredBodyを返す。対象注文の現在状態を取得・変更するAPIではない | [status API](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `GET /api/admin/orders/[id]/fulfillments` | `admin.orders.manage` で、発送と仕上がりの画面の材料（商品ごとの数・発送の一覧・発送できない理由）を service_role で読む。状態変更はしない。操作時は各POSTが再検証する | [発送API](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) |
```

**編集 3-18（SQ-ADMIN-02 の節を書き直す）。** 範囲の開始（この行を含む）:

```text
## SQ-ADMIN-02: 入金済み注文の出荷記録
```

範囲の終了（この行は含まない）:

```text
## SQ-ADMIN-03: 管理返金と成功返金の投影
```

置き換え後:

```text
## SQ-ADMIN-02: 入金済み注文の出荷記録（仕上がり・発送ごと・取消）

目的は、入金済みの注文の発送を商品と数ごとに1回ずつ記録し、受注生産の品の仕上がりを記録し、どちらも取り消せるようにすること。事前条件は管理認可（`admin.orders.manage`）・CSRF helper・回数の制限・入力の検証。終了結果は、記録が成立した200、条件不成立の404・409・400、RPC失敗の500。

### 発送を記録する

~~~mermaid
sequenceDiagram
    participant Admin as 管理者
    participant API as 発送API
    participant DB as DB / RPC
    participant Mail as 注文のメールworker
    Admin->>API: GET /api/admin/orders/[id]/fulfillments
    API->>DB: 商品ごとの数・発送の一覧・発送できない理由を読む（service_role）
    DB-->>API: 発送の材料
    API-->>Admin: 200 発送の材料
    Admin->>API: POST /api/admin/orders/[id]/fulfillments（requestKey・配送業者・伝票番号・知らせるか・商品と数）
    API->>API: 管理認可 → CSRF helper → 回数の制限 → 注文の番号 → 中身を検証
    API->>DB: admin_create_fulfillment(order, actor, requestKey, carrier, tracking, notify, lines)
    alt 同じ requestKey が記録済みで同じ中身
        DB-->>API: 前の結果（replayed = true）
        API-->>Admin: 200（二重に記録しない）
    else 条件が成立
        Note over DB: 注文の行を FOR UPDATE。商品ごとに発送準備中の数を確かめて発送を書き、最後の発送なら shipped にし、notify なら発送ごとのメールの行を同じ取引で書く
        DB-->>API: fulfillment_id・number・completes_order・order_status
        API->>DB: 発送成功の監査
        API-->>Admin: 200
        API-->>Mail: after() で worker を動かす
    else 決まった言葉の断り
        DB-->>API: ORDER_NOT_SHIPPABLE・QUANTITY_EXCEEDS_READY など
        API-->>Admin: 404 / 409 / 400 と画面に出す言葉
    else RPCエラー
        DB-->>API: error
        API-->>Admin: 500
    end
~~~

### 仕上がりと取消

~~~mermaid
sequenceDiagram
    participant Admin as 管理者
    participant API as 仕上がり・取消API
    participant DB as DB / RPC
    Admin->>API: POST /api/admin/orders/[id]/completions
    API->>DB: admin_record_completion(order, actor, requestKey, lines)
    Note over DB: 決済完了の注文の受注生産の品だけ。受注生産中の数まで。お客様にメールは送らない
    DB-->>API: 仕上がりの番号（行ごと）・replayed
    API-->>Admin: 200
    Admin->>API: POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel
    API->>DB: admin_cancel_fulfillment(order, fulfillment, actor)
    Note over DB: 取消の時刻と人を書く。shipped なら paid に戻して出荷日時・配送情報を空にする。まだ送っていないその発送のメールの行を取りやめ（fulfillment_cancelled）にする
    DB-->>API: outcome（cancelled か already_cancelled）・order_status
    API-->>Admin: 200
    Admin->>API: POST /api/admin/orders/[id]/completions/[completionId]/cancel
    API->>DB: admin_cancel_completion(order, completion, actor)
    alt 取り消しても発送した数以上が残る
        DB-->>API: outcome（cancelled か already_cancelled）
        API-->>Admin: 200
    else 発送した数を下回る
        DB-->>API: COMPLETION_ALREADY_SHIPPED
        API-->>Admin: 409
    end
~~~

### 発送の条件と永続化

| 条件 | 結果・保存内容 |
| --- | --- |
| 発送できない状態 | 決済完了でない・未発送が無い: `ORDER_NOT_SHIPPABLE`（409）。配送先の必須項目が足りない: `SHIPPING_ADDRESS_INCOMPLETE`（409）。未解決の paid_amount_mismatch: `PAYMENT_REVIEW_REQUIRED`（409）。review_reason の未確認自体は拒否条件に含まれない |
| 数の超過 | 注文に無い商品・発送準備中の数を超える数: `QUANTITY_EXCEEDS_READY`（409）。受注生産中の品は、仕上がりを記録するまで送れない |
| 同時の操作 | 注文の行の鍵で1つずつ進む。後の方は前の結果を見て、上の断りになる。2回目の発送は記録されない |
| 重複防止キー | 同じキーで同じ中身は前の結果（`replayed`）、違う中身は `FULFILLMENT_REQUEST_MISMATCH`（409）。答えが分からない時、画面は同じキーで確かめ直す |
| 保存 | 発送（番号は注文ごとの最大＋1。取り消した番号は使い回さない）・発送の商品。全部を送った時だけ、注文の shipped・出荷日時・配送業者・追跡番号。注文の改訂の理由は `admin_create_fulfillment`・`admin_cancel_fulfillment` |
| メール | `notifyCustomer` が真の時だけ、その発送の発送メールの行を同じ取引で書く。返事の後に worker が送る。失敗はやり直し、送れなければ店へ知らせる |

仕上がりの記録は決済完了の注文だけ（`ORDER_NOT_IN_PRODUCTION`）、受注生産の品だけ（`LINE_NOT_IN_PRODUCTION`）、受注生産中の数まで（`QUANTITY_EXCEEDS_IN_PRODUCTION`）。根拠は [移行 A](../../../supabase/migrations/20261010120000_order_fulfillments.sql)、[移行 B](../../../supabase/migrations/20261010120100_fulfillment_order_emails.sql)、[発送API](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts)、[worker](../../../src/lib/orders/email/order-email-worker.ts)。


```

**編集 3-19（通知・履歴の別軸の表。取消・発送のメール）。** 置き換え前:

```text
| 取消・発送のメール | 取消・発送のメールは、状態を変える関数が同じ取引で送る予定の行を書き、worker が行の番号から作った重複防止キーで送る。失敗はやり直し、送れなければ店へ知らせる（FREQ-434・435） |
```

置き換え後:

```text
| 取消・発送のメール | 取消・発送のメールは、状態を変える関数が同じ取引で送る予定の行を書き、worker が行の番号から作った重複防止キーで送る。失敗はやり直し、送れなければ店へ知らせる（FREQ-434・435）。発送のメールは発送ごとに1行で、取り消した発送のまだ送っていない行は取りやめになる（FREQ-442・443） |
```

**編集 3-20。** 置き換え前:

```text
| 発送の選択 | `notifyCustomer`（真偽、既定 true）が false なら発送のメールの行を書かない（FREQ-438） |
```

置き換え後:

```text
| 発送の選択 | `notifyCustomer`（真偽、既定 true）が false なら、その発送のメールの行を書かない（FREQ-438。グループ E-1 から発送ごとに選ぶ） |
```

**編集 3-21。** 置き換え前:

```text
| 履歴 | RPCがactor・理由を設定し、order_revisionsに変更前後・変更列等を記録する。返金ではrefund_update、状態変更ではstatus_update等として記録 |
```

置き換え後:

```text
| 履歴 | RPCがactor・理由を設定し、order_revisionsに変更前後・変更列等を記録する。返金ではrefund_update、状態変更ではstatus_update等として記録。状態が変わらない一部の発送・仕上がりとそれらの取消は、発送の表・仕上がりの表から読んで同じ履歴に並べる（グループ E-1） |
```

**編集 3-22（関連テスト）。** 置き換え前:

```text
| 出荷・通常取消・競合 | [status API](../../../tests/unit/api/admin/order-status-shipped.test.ts)、[在庫解放RPC](../../../tests/integration/db/release_stock_by_order.integration.test.ts) |
```

置き換え後:

```text
| 発送・仕上がり・取消・競合 | [発送・仕上がりのDB](../../../tests/integration/db/order_fulfillments.integration.test.ts)、[発送ごとのメールのDB](../../../tests/integration/db/fulfillment_order_emails.integration.test.ts)、[E2E 部分発送](../../../e2e/FR-ADMIN-068-partial-fulfillment.spec.ts)、[E2E 発送の取消](../../../e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts) |
| 通常取消・競合 | [在庫解放RPC](../../../tests/integration/db/release_stock_by_order.integration.test.ts) |
```

**編集 3-23（関連テスト。注文のメール）。** 置き換え前:

```text
[行を書く関数](../../../tests/integration/db/order_email_enqueue.integration.test.ts) |
```

置き換え後:

```text
[行を書く関数](../../../tests/integration/db/order_email_enqueue.integration.test.ts)、[発送ごとのメール](../../../e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts) |
```

- [ ] **Step 4: 詳細設計（画面）を直す**

`docs/04_DetailDesign/pages/16_admin.md`（一覧の言葉と絞り込み・発送の画面・仕上がりの画面・履歴・在庫の画面。受け付け基準の表もここに置く）

**編集 4-1（機能要件対応表の ORDER の行）。** 置き換え前:

```text
未決済にキャンセル、決済完了に発送、決済完了・発送済みに返金を表示する。返金後は一覧を再取得し、Stripeの確定状態を表示する
```

置き換え後:

```text
未決済にキャンセル、発送準備中か受注生産中の数がある入金済みの注文に発送と仕上がりの記録、入金済み・配送中の注文に返金を表示する。状態の言葉は商品ごとの数から出す（未決済・受注生産中・発送準備中・配送中。一部発送済みの印）。返金後は一覧を再取得し、Stripeの確定状態を表示する
```

**編集 4-2（API の表。一覧）。** 置き換え前:

```text
各行に要確認・発送止めの理由・取消の可否・払込期限を付ける
```

置き換え後:

```text
各行に要確認・発送止めの理由・取消の可否・払込期限を付け、商品ごとの数から出した注文の言葉と一部発送済みの印、商品の行ごとの数を付ける（FREQ-441）
```

**編集 4-3（API の表。状態の窓口は取消だけ）。** 置き換え前:

```text
、決済完了の発送（用途別RPC）。Stripe が払込票の期限切れを確定するまでの取消は409と払込期限
```

置き換え後:

```text
。Stripe が払込票の期限切れを確定するまでの取消は409と払込期限
```

**編集 4-4（API の表に発送と仕上がりの5行を足す）。** 置き換え前:

```text
| `/api/admin/orders/:id/refund` | POST | 決済完了・発送済み注文の返金とStripe現在値からの状態投影 | `admin` |
```

置き換え後:

```text
| `/api/admin/orders/:id/refund` | POST | 決済完了・発送済み注文の返金とStripe現在値からの状態投影 | `admin` |
| `/api/admin/orders/:id/fulfillments` | GET | 発送の画面と仕上がりの画面の材料（商品ごとの数・発送の一覧・発送できない理由）（FREQ-439・440） | `admin.orders.manage` |
| `/api/admin/orders/:id/fulfillments` | POST | 発送を1回分記録する（重複防止キー・配送業者・追跡番号・知らせるか・商品と数）。発送準備中の数を超えると409（FREQ-439） | `admin.orders.manage` |
| `/api/admin/orders/:id/fulfillments/:fulfillmentId/cancel` | POST | 発送の取消。送る前のその発送のメールを取りやめる（FREQ-443） | `admin.orders.manage` |
| `/api/admin/orders/:id/completions` | POST | 受注生産の品の仕上がりを記録する（FREQ-440） | `admin.orders.manage` |
| `/api/admin/orders/:id/completions/:completionId/cancel` | POST | 仕上がりの取消。もう発送した数を下回る取消は409（FREQ-440） | `admin.orders.manage` |
```

**編集 4-5（API の表。在庫）。** 置き換え前:

```text
色 × サイズの一覧（在庫数・受注生産の受注数）と台帳の履歴（FREQ-399）
```

置き換え後:

```text
色 × サイズの一覧（すぐ出せる数・引き当て済み・手元の数・受注生産）と、動かした人・注文・変わった後の数つきの台帳の履歴（FREQ-399・445）
```

**編集 4-6（注文の遷移の表。発送の行を3行にする）。** 置き換え前:

```text
| `paid` | 発送 | `admin_ship_paid_order`が`paid`かつ未発送・配送先必須項目充足・支払額の違いの要対応が開いていないことを条件に`shipped`へ更新する。満たさないか競合で0件なら409。DBトリガーも直接更新を拒否する。「お客様に発送のメールを送る」（最初は入っている）を外すと、発送のメールの行を書かない（FREQ-438）。 |
```

置き換え後:

```text
| `paid` | 発送（商品と数を選ぶ） | `admin_create_fulfillment`が、`paid`・配送先必須項目充足・支払額の違いの要対応が開いていない・各商品が発送準備中の数以内を条件に、発送を1回分記録する。満たさない時は決まった言葉で止め、窓口が404/409/400と画面の言葉に直す（FREQ-439）。この発送で未発送が0になる時だけ`shipped`へ更新する。DBトリガーも直接更新を拒否する。「お客様に発送のメールを送る」（最初は入っている）を外すと、その発送のメールの行を書かない（FREQ-438・442）。 |
| `paid` | 仕上がりの記録 | `admin_record_completion`が、`paid`の注文の受注生産の品の、受注生産中の数まで記録する。状態は変えず、お客様にメールは送らない（FREQ-440） |
| `paid` / `shipped` | 発送の取消・仕上がりの取消 | `admin_cancel_fulfillment`が取消の時刻と人を書き、`shipped`なら`paid`へ戻して出荷日時・配送情報を空にし、送る前のその発送のメールを取りやめる。`admin_cancel_completion`は、もう発送した数を下回る取消を断る（FREQ-440・443） |
```

**編集 4-7（状態の絞り込みの行）。** 置き換え前:

```text
| 状態の絞り込み | 「支払い手続き中」「放棄」を足す。放棄は既定の一覧に出さず、「放棄」で絞り込めば出る。「放棄」は他の状態と一緒に選べない（選ぶと他の状態が外れ、他の状態を選ぶと「放棄」が外れる） |
```

置き換え後:

```text
| 状態の絞り込み | 「すべて・支払い手続き中・未決済・発送待ち（受注生産中・発送準備中）・発送済み（配送中・配達済み）・決済失敗・放棄・キャンセル」。DB の状態で絞り（発送待ちは paid、発送済みは shipped）、2つ以上選んだ時は画面が DB の状態（`orderStatus`）で絞る（FREQ-441）。放棄は既定の一覧に出さず、「放棄」で絞り込めば出る。「放棄」は他の状態と一緒に選べない（選ぶと他の状態が外れ、他の状態を選ぶと「放棄」が外れる） |
```

**編集 4-8（発送止めの行）。** 置き換え前:

```text
（`admin_ship_paid_order` も断る）
```

置き換え後:

```text
（`admin_create_fulfillment` も断る）
```

**編集 4-9（履歴の「並び」の行）。** 置き換え前:

```text
| 並び | 受付・状態の変化（配送業者と伝票番号、取消の理由、操作した管理者）・メール（種類・状態・時刻・原因・手で再送の印）を新しい順 |
```

置き換え後:

```text
| 並び | 受付・状態の変化（配送業者と伝票番号、取消の理由、操作した管理者）・発送・発送の取消・仕上がり・仕上がりの取消・メール（種類・状態・時刻・原因・手で再送の印）を新しい順 |
```

**編集 4-10（履歴の表に4行を足す）。** 置き換え前:

```text
| お客様へ再送 | 送信済み・送れなかったメールで、今の注文の状態で意味のある種類だけ。「{種類}のメールを、お客様（注文のメールアドレス）へもう一度送ります」で確かめ、「再送する」「やめる」 |
```

置き換え後:

```text
| お客様へ再送 | 送信済み・送れなかったメールで、今の注文の状態で意味のある種類だけ。「{種類}のメールを、お客様（注文のメールアドレス）へもう一度送ります」で確かめ、「再送する」「やめる」。発送のメールは「発送（n回目）のメール」と出し、その発送のメールを再送する（取り消した発送は再送できない） |
| 発送の行 | 「発送（n回目）」。取り消した発送には印「取り消し済み」。「配送業者: {名前} / 伝票番号: {番号}」、「商品: {名前} × {数}」（商品が複数なら「 / 」で区切る）、「お客様へのメール: 送る」か「お客様へのメール: 送らない」、全部を送った発送には「この発送で全部を送りました」、操作した人。取り消せる時は「この発送を取り消す」（FREQ-443） |
| 発送の取消の行 | 「発送（n回目）を取り消しました」、操作した人 |
| 仕上がりの行 | 「受注生産の品が仕上がりました」。取り消した仕上がりには印「取り消し済み」。「商品: {名前} × {数}」、操作した人。取り消せる時は「この仕上がりを取り消す」 |
| 仕上がりの取消の行 | 「仕上がりを取り消しました」、操作した人 |
```

**編集 4-11（履歴の切り替えの文）。** 置き換え前:

```text
中身と再送の確かめは同じダイアログの中で切り替える。
```

置き換え後:

```text
中身・再送の確かめ・発送と仕上がりの取消の確かめは同じダイアログの中で切り替える。
```

**編集 4-12（発送と仕上がりの節と、受け付け基準の表を足す）。** 置き換え前:

```text
返金で状態が変わった行も履歴に含める。全額返金でキャンセルになった行は「理由: 全額返金」、返金が取り消されて戻った行は「返金の取り消し」を出す。
```

置き換え後:

```text
返金で状態が変わった行も履歴に含める。全額返金でキャンセルになった行は「理由: 全額返金」、返金が取り消されて戻った行は「返金の取り消し」を出す。

### 発送と仕上がりの画面と、注文の言葉（FREQ-439〜443）

2026-10-10 から、発送は商品と数を選ぶ1回ごとの記録になり、受注生産の品は仕上がりを記録するまで送れない（[グループ E-1 設計書](../../superpowers/specs/2026-10-10-partial-fulfillment-design.md)）。DB の状態の値（`paid`・`shipped` など）は変えず、一覧の言葉は商品ごとの数から出す（[注文・決済の状態](../states/order-payment.md)、[order-progress.ts](../../../src/lib/orders/order-progress.ts)）。

| 部品 | 内容 |
| --- | --- |
| 一覧の言葉 | 未決済・受注生産中・発送準備中・配送中（配達済みは E-4）・決済失敗・キャンセル・支払い手続き中・放棄。いちばん手前の段階の言葉を出し、発送した数が1以上で未発送の数も1以上なら「一部発送済み」の印を足す（FREQ-441） |
| 商品の欄 | 「ブラウス（白 / M）×2（受注生産中 1・発送済み 1）」のように、0でない数だけを括弧の中に出す。行の key は注文の商品の番号 |
| ボタン | 「仕上がりを記録する」: 決済完了で受注生産中の数がある時。「発送済みにする」: 決済完了で発送準備中か受注生産中の数があり、配送先がそろい、支払額の確かめが残っていない時 |
| 発送の画面（`OrderShipDialog`） | 題「発送済みにする」。開く時に「読み込み中です...」を出して材料（`GET …/fulfillments`）を読み、重複防止キーを作る。商品の一覧（読み上げの名前は「発送する商品」）には、未発送の数が1以上の商品ごとに、印（在庫・受注生産）・発送準備中の数・今回送る数（最初は発送準備中の全部）を並べ、合計「今回送る数の合計: n点」を出す。合計0は「送る数を入れてください。」。受注生産中の品は「受注生産中 n」と「仕上がった数」の入力と「仕上がりを記録」を持つ。仕上がった数の合計が0なら「仕上がった数を入れてください。」を出す。記録できたら材料を読み直し、記録した数をその商品の今回送る数に足す（発送準備中の数まで）。配送業者・追跡番号・「お客様に発送のメールを送る」は今のまま。誤りは画面の中（`role="alert"`）。答えが分からない時は入力を止め、「もう一度確かめる」と「閉じる」だけを出す |
| 仕上がりの画面（`OrderCompletionDialog`） | 題「仕上がりを記録する」。商品の一覧（読み上げの名前は「仕上がりを記録する商品」）には、受注生産中の商品ごとに「仕上がった数」（0〜受注生産中の数）を入れ、「記録する」。受注生産中の商品が無ければ「受注生産中の商品はありません。」を出す。仕上がった数の合計が0なら「仕上がった数を入れてください。」を出す。成功したら「仕上がりを記録しました。」を出し、一覧を読み直す。お客様にメールは送らない |
| 取消 | 注文の履歴の発送・仕上がりの行から。確かめの画面（題「この発送を取り消す」「この仕上がりを取り消す」）に、文（「発送（n回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。…」「この仕上がりを取り消し、その商品を受注生産中に戻します。」）と「取り消す」「やめる」を出す。取り消せない時は理由を確かめの画面の中に出す。取り消せたら履歴へ戻って「発送（n回目）を取り消しました。」「仕上がりを取り消しました。」を出し、履歴と一覧を読み直す。答えが分からない時（通信が切れた・500番台など）も履歴と一覧を読み直し、「結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。」を出す（FREQ-443） |
| 窓口を呼ぶ道具 | 発送・仕上がり・2つの取消の呼び出しは [fulfillment-client.ts](../../../src/lib/orders/fulfillment/fulfillment-client.ts) の1か所にまとめ、答えを3つに分ける。記録できた。断られた（400・404・409 は窓口の日本語の文を出し、401 は「認証が必要です。再ログインしてください。」、403 は「この操作の権限がありません。」、回数の制限などは代わりの文を出す）。分からない（通信が切れた・500番台・成功なのに答えを読めない。記録されたかもしれないので、画面は同じ重複防止キーで確かめ直す） |
| 小さい画面 | 発送の画面と仕上がりの画面は、幅 768px 未満で画面いっぱいに開く（[Dialog](../../../src/components/ui/Dialog/Dialog.tsx) の任意の prop `fullScreenOnMobile`。ほかの画面の `Dialog` は今のまま） |

窓口の答えの誤りの言葉は [fulfillment-messages.ts](../../../src/lib/orders/fulfillment/fulfillment-messages.ts) の1か所で持つ。

#### 受け付け基準と E2E（グループ E-1）

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-439-AC-01 | 発送の画面に商品ごとの印と今回送る数が並び、最初は発送準備中の全部 | [FR-ADMIN-068](../../../e2e/FR-ADMIN-068-partial-fulfillment.spec.ts) |
| FREQ-439-AC-02 | 数を減らして発送すると、一覧に「一部発送済み」と残りを送るボタンが出る | FR-ADMIN-068 |
| FREQ-439-AC-03 | 残りを全部発送すると「配送中」になり、発送のボタンが消える | FR-ADMIN-068 |
| FREQ-439-AC-04 | 合計0は送らずに理由を出し、数の超過の断りの言葉が画面の中に出る | FR-ADMIN-068 |
| FREQ-439-AC-05 | 答えが分からない時は入力を止め、同じ重複防止キーで確かめ直す | FR-ADMIN-068 |
| FREQ-439-AC-06 | 発送の関数が数の超過・注文に無い商品・中身の違う同じキーを断り、同時の発送は片方だけが通る | FR-ADMIN-068（手元の DB） |
| FREQ-440-AC-01 | 受注生産の品を含む注文は「受注生産中」。発送の最初の数に入らない | [FR-ADMIN-069](../../../e2e/FR-ADMIN-069-made-to-order-completion.spec.ts) |
| FREQ-440-AC-02 | 仕上がりの画面で記録すると「発送準備中」になる | FR-ADMIN-069 |
| FREQ-440-AC-03 | 発送の画面の中でも仕上がりを記録できる | FR-ADMIN-069 |
| FREQ-440-AC-04 | 履歴から仕上がりを取り消せる。送った数を下回る取消は断られる | FR-ADMIN-069 |
| FREQ-440-AC-05 | 受注生産中の品は送れず、記録は決済完了の注文の受注生産の品だけ | FR-ADMIN-069（手元の DB） |
| FREQ-441-AC-01 | 一覧に注文の言葉と「一部発送済み」の印が出る | [FR-ADMIN-070](../../../e2e/FR-ADMIN-070-order-progress-labels.spec.ts) |
| FREQ-441-AC-02 | 絞り込みの名前と、DB の状態での絞り込み | FR-ADMIN-070 |
| FREQ-442-AC-01 | 発送ごとに発送のメールが1通届く | [FR-ADMIN-071](../../../e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts) |
| FREQ-442-AC-02 | メールに、その発送の商品と数・配送業者・追跡番号が書かれ、値段は書かれない | FR-ADMIN-071 |
| FREQ-442-AC-03 | 未発送の品が残る発送のメールにだけ、残りの案内が入る | FR-ADMIN-071 |
| FREQ-442-AC-04 | 知らせない発送にはメールが届かない | FR-ADMIN-071、[FR-ADMIN-066](../../../e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts) |
| FREQ-443-AC-01 | 履歴から発送を取り消すと取消の行が残り、一覧が読み直される | [FR-ADMIN-072](../../../e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts) |
| FREQ-443-AC-02 | 「やめる」では取り消さず、断られた理由が確かめの画面に出る | FR-ADMIN-072 |
| FREQ-443-AC-03 | 取消で発送準備中に戻り、決済完了に戻り、2回目は変更なし | FR-ADMIN-072（手元の DB） |
| FREQ-443-AC-04 | 送る前のメールは取りやめになり、取消のメールは行かない | FR-ADMIN-072（手元の DB と Mailpit） |
| FREQ-445-AC-01 | 在庫の欄に4つの数と言葉の説明が出る | [FR-ADMIN-073](../../../e2e/FR-ADMIN-073-inventory-states.spec.ts) |
| FREQ-445-AC-02 | 履歴に動かした人（空なら「自動」）・注文・変わった後の数が出る | FR-ADMIN-073 |
| FREQ-445-AC-03 | 引き当て済み・受注生産の数え方と、履歴の関数の答え | FR-ADMIN-073（手元の DB） |
```

**編集 4-13（在庫の欄の説明を、4つの数と履歴に書き直す）。** 置き換え前:

```text
在庫数は「すぐ出せる数」であって「売れる数」ではない。0 でも受注生産として注文は通る（ブランドの前提）。製造の判断に使えるよう、受注生産の受注数（`variant_backorder_summary`）を同じ行に並べる。
```

置き換え後:

```text
在庫数は「すぐ出せる数」であって「売れる数」ではない。0 でも受注生産として注文は通る（ブランドの前提）。

在庫の欄には、色 × サイズごとに4つの数を並べる（FREQ-445）。

| 数 | 求め方 |
| --- | --- |
| すぐ出せる数 | `item_variants.stock_quantity`（今のまま。今すぐ売れる数） |
| 引き当て済み | その色・サイズの注文の商品ごとに、max(0, 確保中の数 − 発送した数) を足した数（注文のために取ってある数。支払い手続き中の注文も、棚の品を確保しているので入る） |
| 手元の数 | すぐ出せる数 ＋ 引き当て済み（棚に実際にある数） |
| 受注生産 | 未入金（`pending`）と入金済み（`paid`）の注文の、受注生産の商品のまだ仕上がっていない数の合計（これから作る数。取り消した注文と、仕上がった数は入れない） |

数の説明は画面に1回だけ書く。数は `public.list_variant_stock_states` が返す（旧ビュー `variant_backorder_summary` は消した）。履歴は `public.list_item_stock_history` が新しい順に、日時・理由・増減・変わった後の数・備考・動かした人（空なら「自動」）・注文番号を返す。変わった後の数は、今の在庫数から、その行より後の動きの合計を引いて出す。発送は在庫の台帳を動かさない（注文の時に確保済み）ので、履歴に発送は出ない。
```

`docs/04_DetailDesign/pages/15_account.md`

**編集 4-14（注文履歴の行）。** 置き換え前:

```text
`/api/orders` で本人注文一覧を返し、一覧カードと `/account/orders/[id]` の注文詳細導線を実装する
```

置き換え後:

```text
`/api/orders` で本人注文一覧を返し、一覧カードと `/account/orders/[id]` の注文詳細導線を実装する。状態の言葉は進み具合の言葉（未決済・受注生産中・発送準備中・配送中。FREQ-441）で、注文詳細は進み具合の段と発送ごとの配送情報を出す（FREQ-444）
```

**編集 4-15（注文の言葉・進み具合・配送情報の節を、文書の終わりに足す）。** 置き換え前:

```text
- account のプロフィールタブはメールアドレス・氏名・フリガナ・電話番号を扱い、配送情報タブは住所情報のみを扱う。削除操作もタブごとの情報範囲に限定する。
```

置き換え後:

```text
- account のプロフィールタブはメールアドレス・氏名・フリガナ・電話番号を扱い、配送情報タブは住所情報のみを扱う。削除操作もタブごとの情報範囲に限定する。

## 注文の言葉・進み具合・発送ごとの配送情報（ACCOUNT-ORDER / FREQ-441・444）

2026-10-10 から、購入履歴と注文詳細の状態は、商品ごとの数から出した進み具合の言葉で見せる（[グループ E-1 設計書](../../superpowers/specs/2026-10-10-partial-fulfillment-design.md) の 4 章・9-3）。DB の状態の値は変えない。

| 画面 | 内容 |
| --- | --- |
| 購入履歴の一覧（`GET /api/orders`） | 状態の言葉は「未決済・受注生産中・発送準備中・配送中・配達済み・決済失敗・キャンセル」。「支払い手続き中」「放棄」の注文は今までどおり出さない（FREQ-441） |
| 進み具合（注文詳細。名前「配送ステータス」の一覧） | 在庫の品だけの注文は「お支払い・発送準備中・配送中・配達済み」の4段、受注生産の品を含む注文は「お支払い・受注生産中・発送準備中・配送中・配達済み」の5段。済み・今の段は黒、これからの段は灰色。キャンセル・決済失敗の注文には出さない。今の段は、注文のいちばん手前の段階で決める（FREQ-444） |
| 配送情報 | 発送ごとに「配送情報（n回目）」の区切りを出し、発送日・配送業者・追跡番号・追跡のリンク（「配送状況を確認する」）・その発送の商品と数を並べる。取り消した発送と、発送が無い注文には出さない。窓口は注文の行の発送日時・配送業者・伝票番号を返さず、`shipments` に置き換える |
| まだ送っていない商品 | 「発送準備中の商品」「受注生産中の商品」の見出しの下に並べる（窓口が商品ごとの `readyQuantity`・`inProductionQuantity` を返す） |

注文の窓口（`GET /api/orders/[id]`）は、持ち主を確かめた後に、アプリ（service_role）でその注文の発送と数を読む。新しい発送の表はお客様から直接読めない。

### 受け付け基準と E2E（グループ E-1）

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-441-AC-03 | 購入履歴の一覧に進み具合の言葉が出る | [FR-ADMIN-070](../../../e2e/FR-ADMIN-070-order-progress-labels.spec.ts) |
| FREQ-444-AC-01 | 在庫の品だけは4段、受注生産の品を含むと5段の進み具合 | [FR-ACCOUNT-032](../../../e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts) |
| FREQ-444-AC-02 | 発送ごとの配送情報（n回目）。発送が無い注文には出ない | FR-ACCOUNT-032、[FR-ACCOUNT-031](../../../e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts) |
| FREQ-444-AC-03 | 発送準備中の商品・受注生産中の商品の見出し | FR-ACCOUNT-032 |
| FREQ-444-AC-04 | 取り消した発送は出ず、キャンセルした注文には段を出さない | FR-ACCOUNT-032 |
```

`docs/04_DetailDesign/pages/13_checkout.md`（注文のメールは発送のメールだけ発送ごとに1通。確認のメールの1行）

**編集 4-16（注文の表の説明に、発送の記録を足す）。** 置き換え前:

```text
注文と明細には、法定保存のためのトリガーが付いている。削除は拒否され、金額・配送先・作成日時などは更新できない。状態などの更新は `order_revisions` に前後の内容が残る。
```

置き換え後:

```text
注文と明細には、法定保存のためのトリガーが付いている。削除は拒否され、金額・配送先・作成日時などは更新できない。状態などの更新は `order_revisions` に前後の内容が残る。

発送した数と仕上がった数は、変えられない注文の明細ではなく、別の表（`order_fulfillments`・`order_fulfillment_lines`・`order_item_completions`。グループ E-1）に1回ごとに記録する。上の `shipped_at`・`shipping_carrier`・`tracking_number` は「全部の商品を発送した時」の値（最後の発送の値）で、一部だけ送った間は空。発送の取消で未発送が出たら空に戻す。詳しくは [注文・決済の状態](../states/order-payment.md)。
```

**編集 4-17（受注生産の判断に使う数）。** 置き換え前:

```text
「まとまった時点で製造」の判断（`variant_backorder_summary`）も歪む
```

置き換え後:

```text
「まとまった時点で製造」の判断（受注生産の数。グループ E-1 から `list_variant_stock_states` が返し、仕上がっていない数だけを数える）も歪む
```

**編集 4-18（注文のメールの節の1つめの箇条書き）。** 置き換え前:

```text
自動の行は1注文1種類1行なので、画面からの complete・Webhook・毎時の見回りのどれが何回動いても、行は1つ。
```

置き換え後:

```text
自動の行は1注文1種類1行（発送のメールだけは発送ごとに1行。グループ E-1、FREQ-442）なので、画面からの complete・Webhook・毎時の見回りのどれが何回動いても、行は1つ。
```

**編集 4-19（発送のメールと分けて送る案内、受け付け基準の表）。** 置き換え前:

```text
- 一時的な失敗は約4時間で9回までやり直す。駄目なら「送れなかった」にして店へ知らせ、管理画面の注文の「履歴」から再送できる。
```

置き換え後:

```text
- 一時的な失敗は約4時間で9回までやり直す。駄目なら「送れなかった」にして店へ知らせ、管理画面の注文の「履歴」から再送できる。
- 発送のメールは発送ごとに1通で、その発送の商品と数・配送業者・追跡番号を書く（値段は書かない）。未発送の品が残る発送だけに「残りの商品は、準備ができ次第お送りします。」を書く。発送を取り消すと、まだ送っていないその発送のメールは取りやめになる（FREQ-442）。
- 注文の確認のメール（入金済み・入金待ち）には、在庫の品と受注生産の品が両方ある時だけ、ご注文内容の下へ「在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。」を1行足す。在庫を確保し直せなかった注文（`review_reason = 'stock_not_reserved'`）には、引き渡しの時期を書かない今の決まりに合わせて、この1行も書かない（FREQ-446）。

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-446-AC-01 | 在庫の品と受注生産の品が両方ある注文の確認のメール（入金済み・入金待ち）に、案内が1行入る | [FR-CHECKOUT-050](../../../e2e/FR-CHECKOUT-050-split-shipment-notice.spec.ts) |
| FREQ-446-AC-02 | 片方の品だけの注文と、在庫を確保し直せなかった注文には、案内が入らない | FR-CHECKOUT-050 |
```

- [ ] **Step 5: 手順書とグループ D の設計書を直す**

`docs/06_Operations/order-email-operations.md`（発送のメールは発送ごと、再送は発送ごと）

**編集 5-1（頭の行）。** 置き換え前:

```text
> 対象: お客様への注文のメール（注文確認・入金待ち・支払い期限切れ・取消・発送）の送信・やり直し・一時停止・配達の状態と、店への知らせ
```

置き換え後:

```text
> 対象: お客様への注文のメール（注文確認・入金待ち・支払い期限切れ・取消・発送。発送は発送ごとに1通）の送信・やり直し・一時停止・配達の状態と、店への知らせ
```

**編集 5-2（場面の表に7を足す）。** 置き換え前:

```text
| 配達の見回りが失敗する・上限を確かめる | 6 |
```

置き換え後:

```text
| 配達の見回りが失敗する・上限を確かめる | 6 |
| 発送のメール（発送ごとに1通）・発送を取り消した時 | 7 |
```

**編集 5-3（原因の記号に fulfillment_cancelled を足す）。** 置き換え前:

```text
| `legacy_suppressed` | 移行前の注文のため | 取りやめ（移行で移した印、または明示の承認で取りやめた公開前の試しの行） |
```

置き換え後:

```text
| `legacy_suppressed` | 移行前の注文のため | 取りやめ（移行で移した印、または明示の承認で取りやめた公開前の試しの行） |
| `fulfillment_cancelled` | 発送の取消 | 取りやめ（その発送のまだ送っていない発送のメール。送った後に取り消しても、お客様に取消のメールは行かない。必要なら店からお客様に連絡する） |
```

**編集 5-4（発送のメールの節を、文書の終わりに足す）。** 置き換え前:

```text
送信の1回の待機も8秒（`ORDER_EMAIL_SEND_TIMEOUT_MS`）で打ち切り、`network_error` の一時的な失敗として同じ重複防止キーでやり直す。重複防止キーの24時間の限りは3を参照する。
```

置き換え後:

```text
送信の1回の待機も8秒（`ORDER_EMAIL_SEND_TIMEOUT_MS`）で打ち切り、`network_error` の一時的な失敗として同じ重複防止キーでやり直す。重複防止キーの24時間の限りは3を参照する。

## 7. 発送のメールは発送ごとに1通（グループ E-1）

2026-10-10 から、発送のメールは注文ではなく発送ごとに1通送る（[グループ E-1 設計書](../superpowers/specs/2026-10-10-partial-fulfillment-design.md) の 8 章）。在庫の品を先に送り、受注生産の品を後から送ると、メールも2通になる。

| 決まり | 内容 |
| --- | --- |
| 行を書く時 | 発送の関数（`admin_create_fulfillment`）が、発送の画面の「お客様に発送のメールを送る」が入っている時だけ、同じ取引で発送のメールの行を1つ書く。行は発送の番号（`fulfillment_id`）を持つ。外した発送には行を書かない |
| 本文 | その発送の商品と数・配送業者・追跡番号・追跡のリンク。値段は書かない。未発送の品が残る発送だけに「残りの商品は、準備ができ次第お送りします。」を書く |
| 再送 | 管理画面の注文の「履歴」の「発送（n回目）のメール」から、発送ごとに再送する。取り消した発送のメールは再送できない（決済完了・発送済みの注文で、発送が取り消されていない時だけ） |
| 発送を取り消した時 | まだ送っていないその発送のメール（送る前・やり直し待ち）は取りやめ（`fulfillment_cancelled`）になる。送っている途中の行は、worker が中身を作る時に取消を見て取りやめる。すでに送ったメールはそのまま。お客様には取消のメールを送らない（店からお客様に連絡する） |

### 7-1 公開前の送信待ちの確かめ

移行 A・B（グループ E-1）を本番に当てた後も、1-2 と同じく、公開前に本番で発送を試さない。試すと、発送ごとのメールの行が本番に溜まり、公開後の最初の worker が試しの注文の宛先へ送ってしまう。次の読むだけの SQL を、Supabase のダッシュボード（本番のプロジェクト）→ SQL Editor で流して、発送のメールの行を数える。

~~~sql
-- 発送のメールの行。発送ごとに1行で、全部が発送の番号を持つ（with_fulfillment が rows と同じ）
select status, count(*) as rows, count(fulfillment_id) as with_fulfillment
from private.order_email_outbox
where kind = 'shipped'
group by status order by status;

-- 取りやめた発送のメール（理由は fulfillment_cancelled）
select 'ORD-' || upper(left(order_id::text, 8)) as order_number, created_at
from private.order_email_outbox
where kind = 'shipped' and last_error_code = 'fulfillment_cancelled'
order by created_at;
~~~
```

`docs/superpowers/specs/2026-10-09-order-email-outbox-design.md`（グループ D の設計書に、発送のメールの決まりがグループ E-1 で変わることを書き足す。古い文は消さず、変わる所に注記を付ける）

**編集 5-5（頭の注記）。** 置き換え前:

```text
> 関連: [グループ A 設計書](2026-09-26-order-payment-reconciliation-design.md)（照合と注文の状態）、[グループ B 設計書](2026-10-05-webhook-queue-operations-design.md)（キュー・worker・定期処理・店への知らせ）、[グループ F 設計書](2026-10-07-checkout-place-order-payment-design.md)
```

置き換え後:

```text
> 関連: [グループ A 設計書](2026-09-26-order-payment-reconciliation-design.md)（照合と注文の状態）、[グループ B 設計書](2026-10-05-webhook-queue-operations-design.md)（キュー・worker・定期処理・店への知らせ）、[グループ F 設計書](2026-10-07-checkout-place-order-payment-design.md)
> 後の変更: 発送のメールの決まりは、[グループ E-1 設計書](2026-10-10-partial-fulfillment-design.md) の 8 章で「発送ごとに1通」に変わった（この文書の 3-1・3-2・4-1・5-3・5-4・7-1・7-3 の発送の部分。古い文は記録として残し、変わる所に注記を付けた）
```

**編集 5-6（2 章。発送の行）。** 置き換え前:

```text
| 発送 | 管理画面の `admin_ship_paid_order` の後 | 送信権なしで送る | 監査に残すだけ |
```

置き換え後:

```text
| 発送 | 管理画面の `admin_ship_paid_order` の後（2026-10-10 グループ E-1 から、発送ごとの `admin_create_fulfillment`） | 送信権なしで送る | 監査に残すだけ |
```

**編集 5-7（3-1。書く場所の表）。** 置き換え前:

```text
| `admin_ship_paid_order` | 発送 | 発送の画面の「お客様に発送のメールを送る」が入っている時（新しい引数。最初から入った状態） |
```

置き換え後:

```text
| `admin_ship_paid_order` | 発送 | 発送の画面の「お客様に発送のメールを送る」が入っている時（新しい引数。最初から入った状態）。グループ E-1 で `admin_create_fulfillment` に引き継ぎ、発送ごとに1行書く |
```

**編集 5-8（3-2。行の決まり）。** 置き換え前:

```text
- 自動の行は「1つの注文・1つの種類につき1行」に DB の一意の決まりで縛る。2通目の行はそもそも作れない。
```

置き換え後:

```text
- 自動の行は「1つの注文・1つの種類につき1行」に DB の一意の決まりで縛る。2通目の行はそもそも作れない（2026-10-10 グループ E-1 から、発送のメールだけは「1つの発送につき1行」。発送の番号 `fulfillment_id` を持つ）。
```

**編集 5-9（4-1。取りやめの表）。** 置き換え前:

```text
| 入金済み・取消・発送 | 取りやめない（その時の事実を伝える。Shopify も確認と取消を別々に送る） | ― |
```

置き換え後:

```text
| 入金済み・取消・発送 | 取りやめない（その時の事実を伝える。Shopify も確認と取消を別々に送る）。ただし発送のメールは、その発送を取り消した時（E-1） | 発送だけ `fulfillment_cancelled` |
```

**編集 5-10（5-3。再送できる状態の表）。** 置き換え前:

```text
| 発送 | 発送済み（`shipped`） |
```

置き換え後:

```text
| 発送 | 発送済み（`shipped`）。E-1 から、決済完了（`paid`）か発送済みで、その発送が取り消されていない時（発送ごとに再送する） |
```

**編集 5-11（5-4。発送の画面）。** 置き換え前:

```text
- 発送のダイアログに「お客様に発送のメールを送る」のチェックを足す（最初から入った状態）。入っている時だけ発送のメールの行を書く。
```

置き換え後:

```text
- 発送のダイアログに「お客様に発送のメールを送る」のチェックを足す（最初から入った状態）。入っている時だけ発送のメールの行を書く（E-1 で発送の画面は商品と数を選ぶ画面になった。チェックは今のまま、発送ごとに選ぶ）。
```

**編集 5-12（7-1。列の表に発送の番号を足す）。** 置き換え前:

```text
| `requested_by` | 手の再送をした管理者（`auth.users`）。自動は空 |
```

置き換え後:

```text
| `requested_by` | 手の再送をした管理者（`auth.users`）。自動は空 |
| `fulfillment_id` | （E-1 で足した）発送の番号（`order_fulfillments`）。種類が `shipped` の行だけが持つ。自動の発送のメールは発送ごとに1行 |
```

**編集 5-13（7-3。発送の関数）。** 置き換え前:

```text
| `admin_ship_paid_order` | 発送のメールを送るか（`_notify_customer`）を足す |
```

置き換え後:

```text
| `admin_ship_paid_order` | 発送のメールを送るか（`_notify_customer`）を足す（E-1 で `admin_create_fulfillment` に引き継ぎ、発送ごとに行を書く） |
```

**編集 5-14（9 章。FREQ-438 の行）。** 置き換え前:

```text
| FREQ-438 | 発送の時に、発送のメールを送るかを選べる（最初は送る） | 3つの画面幅で、チェックを外すと発送のメールが届かず、入れると1通届くこと | `e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts` |
```

置き換え後:

```text
| FREQ-438 | 発送の時に、発送のメールを送るかを選べる（最初は送る）（2026-10-10 グループ E-1: 発送ごとの選択に引き継ぐ。FREQ-442） | 3つの画面幅で、チェックを外すと発送のメールが届かず、入れると1通届くこと | `e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts` |
```

**編集 5-15（11 章。決め事の記録に1行足す）。** 置き換え前:

```text
| 実装の時（2026-10-09） | 再送の400も監査し、履歴の「戻る」「やめる」で開いた行へ焦点を戻す。状態名は `ORDER_STATUS_LABELS` に揃える（5-1・5-3・5-5） | 不正な入力の記録と行単位の焦点復帰を保ち、一覧と履歴の状態名がずれないようにするため |
```

置き換え後:

```text
| 実装の時（2026-10-09） | 再送の400も監査し、履歴の「戻る」「やめる」で開いた行へ焦点を戻す。状態名は `ORDER_STATUS_LABELS` に揃える（5-1・5-3・5-5） | 不正な入力の記録と行単位の焦点復帰を保ち、一覧と履歴の状態名がずれないようにするため |
| グループ E-1（2026-10-10） | 発送のメールを「発送ごとに1通」に変える。行に発送の番号 `fulfillment_id` を足し、自動の一意を、発送のメール以外は注文と種類、発送のメールは発送の番号にする。再送は発送ごと。取り消した発送の送る前のメールは取りやめ（`fulfillment_cancelled`） | 一部ずつ送ると、1注文に1通のままでは2通目が捨てられ、送った商品が伝わらないため（[E-1 設計書](2026-10-10-partial-fulfillment-design.md) の 8 章） |
```

- [ ] **Step 6: 文書の確かめ**

1. 受け付け基準の数え方（読むだけ）:

Run: `for id in $(grep -oE "FREQ-(439|44[0-6])-AC-[0-9]+" docs/02_Requirements/requirements.md | sort -u); do echo "$id design=$(grep -rl "$id" docs/03_BasicDesign docs/04_DetailDesign | wc -l) tests=$(grep -rl "$id" e2e tests | wc -l)"; done`
Expected: 31行。どの行も `design=1` 以上・`tests=1` 以上（`design=0` や `tests=0` の行が無い）

2. 文書の確かめ:

Run: `npm run -s validate-docs`
Expected: 今からある2件（`docs/superpowers/plans/2026-10-07-checkout-place-order-payment.md` のリンク2つ）だけ。新しい誤り（壊れたリンク・閉じていない囲み・Mermaid の誤り）は0件。`broken relative link` が出たら、その行き先は Task 1〜10 が作るファイルのはずなので、名前の綴りを確かめる（`src/app/api/admin/orders/[id]/fulfillments/route.ts` のように `[` `]` を含む行き先は `%5B` `%5D` で書いてある）

3. 要求の表の数え直し:

Run: `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-446`

Run: `grep -c "^| FREQ-44[0-6] " docs/02_Requirements/requirements.md`
Expected: `7`（FREQ-440〜446。FREQ-439 の行は上の `grep` に `FREQ-439` が含まれないので、別に `grep -c "^| FREQ-439 " docs/02_Requirements/requirements.md` が `1` であることも確かめる）

- [ ] **Step 7: コミット（controller）**

```bash
git add docs/02_Requirements/requirements.md docs/03_BasicDesign/data/er.md docs/03_BasicDesign/api/api-spec.md docs/03_BasicDesign/api/route-inventory.md docs/04_DetailDesign/states/order-payment.md docs/04_DetailDesign/sequence/order-administration.md docs/04_DetailDesign/pages/16_admin.md docs/04_DetailDesign/pages/15_account.md docs/04_DetailDesign/pages/13_checkout.md docs/06_Operations/order-email-operations.md docs/superpowers/specs/2026-10-09-order-email-outbox-design.md
git commit -m "docs(orders): 部分発送・仕上がり・進み具合の言葉・発送ごとのメール・発送の取消・在庫の4つの数の要求 FREQ-439〜446 と、設計の文書・手順書を書く（グループ E-1）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 全体の確かめ

**Files:**
- 作る・直すファイルは無い（確かめで見つけた誤りは、その誤りを持つタスクの直しとして直し、そのタスクのファイルだけをコミットする）
- 使う: `.superpowers/sdd/2026-10-10-partial-fulfillment/e2e-baseline-group-d-2026-10-09-tests.json`（グループ D の全件の結果。2715件・既存の失敗191件。計画を書いた時に `test-results/e2e-results.json` から作った）

**Interfaces:**
- Consumes: Task 1〜11 の全部
- Produces: 台帳（`.superpowers/sdd/2026-10-10-partial-fulfillment/progress.md`）に、各確かめの結果・E2E の前後の比べ・受け付け基準と試験の対応を書く

- [ ] **Step 1: 3000番が空いていることを確かめる**

Run（PowerShell）: `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue`
Expected: 何も出ない。出たら、その番号のアプリを止めてから進む（E2E 用のアプリが残っていると、古いビルドのまま使い回される）

- [ ] **Step 2: 単体テストを全部流す**

Run: `npx jest tests/unit --runInBand`
Expected: PASS（全部）

- [ ] **Step 3: 型と lint**

Run: `npx tsc --noEmit` と `npm run lint`
Expected: どちらも誤り0件

- [ ] **Step 4: DB の結合テストを全部流す**

Run: `npx supabase db reset` の後に、Global Constraints の DB 結合テストのコマンド（`npx jest tests/integration/db --runInBand`）
Expected: PASS（全部）。新しい2本（`order_fulfillments`・`fulfillment_order_emails`）と、直した7本を含む

- [ ] **Step 5: 手元の DB を作り直す**

Run: `npx supabase db reset`
Expected: 終わる。DB 結合テストは保留の守りを当て、決済の関数を消す試験もあるので、E2E の前に必ず作り直す

- [ ] **Step 6: E2E を全件流す（本番ビルド・手元の Supabase）**

Run（Git Bash。15分ほどかかるので後ろで流す）: `PLAYWRIGHT_HTML_OPEN=never npx playwright test > .superpowers/sdd/2026-10-10-partial-fulfillment/full-e2e.log 2>&1`
Expected: 終わる。`playwright.config.ts` の webServer（`scripts/e2e-server.mjs`）が `npm run build` → `next start` を起動する。新しい E2E（`FR-ADMIN-068`〜`073`・`FR-ACCOUNT-032`・`FR-CHECKOUT-050`）は3つの画面幅の全部で通る。全滅（`ERR_CONNECTION_REFUSED`）なら、まず `npm run build` を単独で流し、落ちたら `.next` を消してからやり直す

- [ ] **Step 7: 前の全件と比べる**

Run: `npm run e2e:compare -- .superpowers/sdd/2026-10-10-partial-fulfillment/e2e-baseline-group-d-2026-10-09-tests.json test-results/e2e-results.json > .superpowers/sdd/2026-10-10-partial-fulfillment/e2e-compare.log 2>&1`
Expected: 「前に通っていて後で通らない」と「前は飛ばし・前に無くて、後で失敗」に出たものを、1件ずつ CLAUDE.md の切り分けの順で確かめる。
1. その試験だけを単体で流し直す（`PLAYWRIGHT_HTML_OPEN=never npx playwright test <ファイル> --project=<画面幅>`）。通るなら実装の欠陥ではない
2. 同じ試験のほかの画面幅が同じ実行で通っているかを見る
3. 誤りが `page.goto`・`locator.click` の時間切れか、確かめの中身の違いかを分ける（`test-results/*/error-context.md` の画面の文と alert を読む）

前から揺れると分かっているもの（記録に残っている）: `FR-ADMIN-018`（今日の日付で季節を選ぶ）、`FR-CHECKOUT-049` の tablet・desktop（全件の時だけカートの回数の制限 429）、`FR-ITEM-DETAIL-019`〜`023`（準備の `/api/items` が非 OK）、`FR-WISHLIST-016`、`FR-CART-015`、`FR-CONTACT-006`（1時間の送信の上限）。単体で通れば揺れとして台帳に書く。本物の欠陥なら、その画面・窓口を持つタスクの直しとして直す（台帳に `Ruling:` を残し、直しの後にその試験と関係する単体テスト・E2E を流し直す）。`retries` は上げない

- [ ] **Step 8: 受け付け基準と試験の対応を確かめる**

`docs/02_Requirements/requirements.md` の FREQ-439〜446 の各行の受け付け基準（`FREQ-4xx-AC-nn`）ごとに、それを確かめている試験（E2E のファイルと試験の名前、または単体・DB の試験の名前）と、Step 2〜7 で通ったことを台帳に表で書く。
Expected: 全部の受け付け基準に、通った試験がある。無い基準があれば、その基準の画面・窓口を持つタスクに試験を足す（台帳に `Ruling:` を残す）

- [ ] **Step 9: 知識の地図を新しくする**

Run: `.venv/Scripts/python.exe -m graphify update .`
Expected: 終わる（`graphify-out/` は git の管理の外なので、コミットは無い）

- [ ] **Step 10: 作業ツリーを確かめる**

Run: `git status --short`
Expected: 何も出ない（全部のタスクのファイルはコミット済み。`test-results/`・`.superpowers/` は git の管理の外）。残っていれば、どのタスクの物かを確かめ、そのタスクのファイルだけを名指しでコミットする

---

## 本番への出し方（計画の外。ユーザーの指示があってから）

全部の確かめの後、push と本番の DB への適用はユーザーの指示と許可を得てから行う（設計書 16章）。SDD の中では行わない。

1. **push**: ユーザーが push を指示したら、3000番を止めてから `git push`（pre-push の E2E は `E2E_STRICT=1`）。`--no-verify` は使わない
2. **当てる前の数**（本番の DB を読むだけ。Supabase の接続の `execute_sql`）。どちらも0の見込み。0でなければ、当てる前にユーザーに見せる:

```sql
select count(*) as shipped_without_tracking
from public.orders
where shipped_at is not null and (shipping_carrier is null or tracking_number is null);

select count(distinct e.order_id) as shipped_email_without_shipment
from private.order_email_outbox as e
join public.orders as o on o.id = e.order_id
where e.kind = 'shipped' and o.shipped_at is null;
```

3. **当てる**: ユーザーの許可を得てから、Supabase の接続の `apply_migration` で移行 A（`order_fulfillments`）、移行 B（`fulfillment_order_emails`）の順に当てる。1つずつ許可を得る
4. **当てた版に名前を合わせる**: 本番の台帳（`list_migrations`）の版の番号に合わせて、`git mv` で2つのファイルの名前を直し、ファイル名を書いている所（`grep -rn "20261010120000\|20261010120100" docs supabase tests src`。単体テスト `order-email-types.test.ts`・`order-state-transition-hardening.test.ts` が移行 B のパスを読んでいる）を直す。単体テストを流してからコミットする（`chore(db): …`）
5. **当てた後の確かめ**（本番の DB を読むだけ）:

```sql
-- 前からの発送の記録の数と、発送した時刻がある注文の数が同じ
select (select count(*) from public.orders where shipped_at is not null) as shipped_orders,
       (select count(*) from public.order_fulfillments where legacy) as legacy_fulfillments;

-- 発送のメールの行は、全部が発送の番号を持つ
select count(*) as unlinked_shipped_emails
from private.order_email_outbox
where kind = 'shipped' and fulfillment_id is null;

-- 全部の注文の商品で shipped ≤ completed ≤ quantity
select count(*) as broken_lines
from public.orders as o
cross join lateral private.order_line_fulfillment(o.id) as l
where not (l.shipped <= l.completed and l.completed <= l.quantity);

-- 関数の中身と権限の指紋（手元の DB でも同じ問い合わせを流し、同じになることを比べる）
select p.oid::regprocedure::text as signature, md5(pg_get_functiondef(p.oid)) as body, p.proacl::text as acl
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where (n.nspname, p.proname) in (
  ('private', 'order_line_fulfillment'), ('private', 'parse_fulfillment_lines'), ('private', 'backfill_legacy_fulfillments'),
  ('private', 'link_legacy_shipped_emails'), ('private', 'enqueue_order_email'),
  ('public', 'list_order_line_fulfillment'), ('public', 'admin_record_completion'), ('public', 'admin_cancel_completion'),
  ('public', 'list_order_fulfillments'), ('public', 'list_order_completions'), ('public', 'list_variant_stock_states'),
  ('public', 'list_item_stock_history'), ('public', 'admin_create_fulfillment'), ('public', 'admin_cancel_fulfillment'),
  ('public', 'claim_order_email'), ('public', 'skip_order_email'), ('public', 'request_order_email_resend'),
  ('public', 'list_order_email_history')
)
order by 1;
```

6. **注意**: 普段の開発は本番の DB を使う。当てた後に開発の画面で発送を試すと、本番に発送のメールの予定が溜まる（グループ D の注意と同じ）。公開前の確かめで件数を見る
