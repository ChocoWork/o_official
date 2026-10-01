# 1.13 チェックアウトページ（CHECKOUT）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.13 チェックアウトページ（CHECKOUT）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

## 現行実装の確認事項（2026-10-02）

- 現行の画面は [`src/app/checkout/page.tsx`](../../../src/app/checkout/page.tsx) の `CheckoutProvider` と `PaymentElement` を使い、[`create-session`](../../../src/app/api/checkout/create-session/route.ts) を呼ぶ。決済後の注文照合は [注文・決済状態図](../states/order-payment.md) と [システム構成](../../03_BasicDesign/architecture/system-overview.md) を参照する。
- この文書の表と後続説明には、固定の決済手段、旧在庫列、過去の画面遷移について作成時点の記述が残る。下の「済」は現在の実装状況を保証しない。該当要件を変更するときはコードとテストに照らして個別に改訂する。
## 機能要件対応表

| 要件ID          | 要件内容                                                                                                                     | 実装ID            | 実装対象ファイル                                                                           | 実装概要                                                                                                                | 実装ステータス |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------- |
| FR-CHECKOUT-001 | チェックアウトは Stripe の `CheckoutProvider` と `PaymentElement` を使用しカード・PayPay・コンビニ決済を提供する             | IMPL-CHECKOUT-001 | `src/app/checkout/page.tsx`, `src/app/api/checkout/route.ts`                               | `CheckoutProvider` + `PaymentElement` を実装。paymentMethodTypes でカード・PayPay・コンビニを設定                       | 済             |
| FR-CHECKOUT-002 | クレジットカード情報の入力・保持は Stripe Elements に委譲しサーバサイドはカード番号を一切保存しない                          | IMPL-CHECKOUT-002 | `src/app/checkout/page.tsx`                                                                | Stripe Elements ホスト型 UI を使用、PCI DSS 準拠。自サーバへのカードデータ送信なし                                      | 済             |
| FR-CHECKOUT-003 | 注文サマリーに小計・税・送料・合計を明示する                                                                                 | IMPL-CHECKOUT-003 | `src/app/checkout/page.tsx`                                                                | 小計・消費税（10%）・配送料・合計を表示                                                                                 | 済             |
| FR-CHECKOUT-004 | 住所入力フォームの各フィールドにバリデーションメッセージと `aria-describedby` を実装しユーザーが誤入力を確認できるようにする | IMPL-CHECKOUT-004 | `src/app/checkout/page.tsx`, `src/components/ui/TextField.tsx`                             | フィールド別バリデーション、`errorText`、`aria-describedby`、`aria-invalid` を実装                                      | 済             |
| FR-CHECKOUT-005 | 郵便番号入力に自動補完機能を実装し `GET /api/checkout/postal-code` で住所を取得してフォームに反映する                        | IMPL-CHECKOUT-005 | `src/app/checkout/page.tsx`, `src/app/api/checkout/postal-code/route.ts`                   | `useEffect` + `latestPostalLookupRef` でレース防止。郵便番号7桁入力で市区町村・都道府県を自動補完                       | 済             |
| FR-CHECKOUT-006 | 決済完了時に確認メールを送信し画面に完了メッセージを表示する                                                                 | IMPL-CHECKOUT-006 | `src/app/checkout/page.tsx`                                                                | `onComplete` コールバックで「確認メールをお送りしました」テキストを表示。実際のメール送信は Webhook 側で処理            | 済             |
| FR-CHECKOUT-007 | 決済確定前に在庫チェックを行い枯渇時はエラーメッセージと代替案を表示する                                                     | IMPL-CHECKOUT-007 | `src/app/api/checkout/create-session/route.ts`, `src/app/checkout/page.tsx`                | `stock_quantity` を参照した在庫チェックを追加し、409 と在庫切れメッセージを返却・表示                                   | 済             |
| FR-CHECKOUT-008 | 決済エラー発生時は明確なメッセージと再試行導線を表示する                                                                     | IMPL-CHECKOUT-008 | `src/app/checkout/page.tsx`                                                                | `checkoutError` の表示に加え、「再試行する」ボタンで決済セッション再作成を実装                                          | 済             |
| FR-CHECKOUT-009 | Stripe Webhook の冪等性を実装しネットワーク障害や再送による二重注文を防ぐ                                                    | IMPL-CHECKOUT-009 | `src/app/checkout/page.tsx`, `src/app/api/webhook/stripe/route.ts`                         | クライアント側 `processedCallback` とサーバ側の署名検証済みイベントの原子的enqueueとworkerのlease処理、および `payment_intent_id` 重複防止を実装 | 済             |
| FR-CHECKOUT-010 | 郵便番号 API に `postal_code_cache` テーブルを利用しキャッシュ済みの住所は外部 API を再呼び出しせず返す                      | IMPL-CHECKOUT-010 | `src/app/api/checkout/postal-code/route.ts`, `migrations/024_create_postal_code_cache.sql` | `postal_code_cache` テーブルへの SELECT + キャッシュミス時に外部 API 問い合わせ後に INSERT                              | 済             |
| FR-CHECKOUT-012 | ログイン済みユーザーの配送情報入力は account に保存済みのプロフィール・配送情報を既定値として表示する                        | IMPL-CHECKOUT-012 | `src/app/checkout/page.tsx`, `e2e/FR-CHECKOUT-012-account-profile-defaults.spec.ts`        | `/api/profile` を読み込み、メールアドレス・氏名・電話番号・住所を checkout 配送フォームの初期値へ反映する               | 済             |
| FR-CHECKOUT-011 | 消費税の自動計算と詳細な税率表示（WONT）                                                                                     | —                 | —                                                                                          | 現フェーズ対象外                                                                                                        | 未             |

---

## 実装タスク管理 (CHECKOUT-01)

**タスクID**: CHECKOUT-01
**ステータス**: 一部未実装「況」あり
**元ファイル**: `docs/tasks/04_checkout_ticket.md`

### Stripe 実装チェックリスト

| 要件ID          | 要件内容                                                       | 実装ID                    | 実装対象ファイル                                                                                                                                                             | 実装概要                                                                                                                                                                 | 実装ステータス |
| --------------- | -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| CHECKOUT-01-001 | Stripe セッション作成実装                                      | IMPL-CHECKOUT-SESSION-01  | `src/app/api/checkout/route.ts`                                                                                                                                              | Stripe セッション作成実装済み                                                                                                                                            | 済             |
| CHECKOUT-01-002 | Payment Element + PaymentIntent 初期化 API                     | IMPL-CHECKOUT-PI-01       | `src/app/api/checkout/route.ts`                                                                                                                                              | PaymentIntent 初期化 API 実装済み                                                                                                                                        | 済             |
| CHECKOUT-01-003 | `POST /api/checkout/complete`（Stripe Checkout Session のみ）  | IMPL-CHECKOUT-COMPLETE-01 | `src/app/api/checkout/complete/route.ts`                                                                                                                                     | `checkoutSessionId` と `draft_id` を必須化し、公開 complete API では Stripe セッション検証後にのみ注文確定する                                                           | 済             |
| CHECKOUT-01-004 | Webhook 受信と署名検証                                         | IMPL-CHECKOUT-WEBHOOK-01  | `src/app/api/webhook/stripe/route.ts`                                                                                                                                      | Stripe 署名検証付き Webhook 実装済み                                                                                                                                     | 済             |
| CHECKOUT-01-005 | 注文確定ロジック（orders/order_items 保存、カートクリア）      | IMPL-CHECKOUT-ORDER-01    | `src/app/api/checkout/create-session/route.ts`, `src/app/api/checkout/complete/route.ts`, `src/app/api/webhook/stripe/route.ts`, `migrations/040_create_checkout_drafts.sql` | create-session 時点で immutable な checkout draft を保存し、complete / webhook は `finalize_order_from_checkout_draft` RPC で draft スナップショットからのみ注文確定する | 済             |
| CHECKOUT-01-006 | 郵便番号住所自動補完（同一オリジン API + `postal_code_cache`） | IMPL-CHECKOUT-POSTAL-01   | `src/app/api/checkout/postal-code/route.ts`                                                                                                                                  | キャッシュ付き郵便番号補完実装済み                                                                                                                                       | 済             |
| CHECKOUT-01-007 | Payment Element Accordion UI + Appearance API                  | IMPL-CHECKOUT-UI-01       | `src/app/checkout/page.tsx`                                                                                                                                                  | Accordion UI + Appearance API 実装済み                                                                                                                                   | 済             |
| CHECKOUT-01-008 | Checkout Sessions API（custom UI モード）                      | IMPL-CHECKOUT-SESSION-02  | `src/app/api/checkout/route.ts`                                                                                                                                              | custom UI モード実装済み                                                                                                                                                 | 済             |
| CHECKOUT-01-009 | `metadata`（注文ID/カートID）を Stripe セッションに付与        | IMPL-CHECKOUT-META-01     | `src/app/api/checkout/route.ts`                                                                                                                                              | metadata 付与実装済み                                                                                                                                                    | 済             |
| CHECKOUT-01-010 | Dynamic Payment Methods（Stripe 最適表示）                     | IMPL-CHECKOUT-DPM-01      | `src/app/api/checkout/route.ts`                                                                                                                                              | 未実装                                                                                                                                                                   | 未             |
| CHECKOUT-01-011 | Stripe SDK バージョン確認・アップデート                        | IMPL-CHECKOUT-SDK-01      | `package.json`                                                                                                                                                               | 未確認                                                                                                                                                                   | 未             |
| CHECKOUT-01-012 | Payment Element の iframe 非埋め込み確認                       | IMPL-CHECKOUT-IFRAME-01   | `src/app/checkout/page.tsx`                                                                                                                                                  | 未確認                                                                                                                                                                   | 未             |
| CHECKOUT-01-013 | Dashboard 支払い方法確認・Payment Method Rules                 | —                         | Stripe Dashboard 設定                                                                                                                                                        | 未確認                                                                                                                                                                   | 未             |

### 依存関係

- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` は環境変数管理
- メール送信サービス: Webhook 側で SendGrid 実装（型紙未作成、要実装）

---

## 外部連携 実装タスク管理 (INTEG-01)

**タスクID**: INTEG-01
**ステータス**: 一部実装済み
**元ファイル**: `docs/tasks/09_integrations_ticket.md`

### チェックリスト

| 要件ID       | 要件内容                                                                     | 実装ID                 | 実装対象ファイル                                | 実装概要                       | 実装ステータス |
| ------------ | ---------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------- | ------------------------------ | -------------- |
| INTEG-01-001 | Stripe 統合 + Webhook 署名検証                                               | IMPL-INTEG-STRIPE-01   | `src/app/api/webhook/stripe/route.ts`         | Stripe 統合 + 署名検証実装済み | 済             |
| INTEG-01-002 | 管理画面 ORDER 向け Stripe Refund API（`POST /api/admin/orders/:id/refund`） | IMPL-INTEG-REFUND-01   | `src/app/api/admin/orders/[id]/refund/route.ts` | 返金 API 実装済み              | 済             |
| INTEG-01-003 | SendGrid テンプレート連携                                                    | IMPL-INTEG-EMAIL-01    | `src/features/notifications/services/email.ts`  | 未実装                         | 未             |
| INTEG-01-004 | 配送 API 初期連携（ラベル発行・追跡）                                        | IMPL-INTEG-SHIPPING-01 | `src/features/shipping/`                        | 未実装                         | 未             |

### 実装ノート

- 各種シークレットは `.env.local` で管理。本番は Vercel Environment Variables に設定
- Webhook の冪等性: クライアント側 `processedCallback` フラグに加え、サーバ側で `stripe_webhook_events` への原子的enqueueとworkerのlease処理、および `payment_intent_id` の重複注文防止を実装

---

## データモデル（CHECKOUT-DATA）

```sql
-- 注文テーブル（本番の定義。2026-09-20 時点）
orders (
  id                        uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                text                NOT NULL,                      -- ゲストの注文をセッションで引く
  user_id                   uuid                NULL REFERENCES profiles(user_id) ON DELETE SET NULL,  -- ゲスト注文は NULL
  payment_intent_id         text                NOT NULL UNIQUE,               -- 同じ支払いで注文を二重に作らせない
  checkout_session_id       text                NULL,
  status                    public.order_status NOT NULL DEFAULT 'pending',    -- 列挙型: pending / paid / failed / cancelled / shipped
  subtotal_amount           integer             NOT NULL CHECK (subtotal_amount >= 0),
  shipping_amount           integer             NOT NULL DEFAULT 500 CHECK (shipping_amount >= 0),
  discount_amount           integer             NOT NULL DEFAULT 0,
  total_amount              integer             NOT NULL CHECK (total_amount > 0),  -- JPY 整数（最小単位）
  currency                  text                NOT NULL DEFAULT 'jpy',
  refunded_amount           integer             NOT NULL DEFAULT 0 CHECK (refunded_amount BETWEEN 0 AND total_amount),
  refunded_at               timestamptz         NULL,
  payment_status_updated_at timestamptz         NULL,
  shipped_at                timestamptz         NULL,
  shipping_carrier          text                NULL CHECK (shipping_carrier IN ('yamato','sagawa','japanpost')),
  tracking_number           text                NULL CHECK (tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  shipping_email            text,                                              -- ここから下は配送先の写し
  shipping_full_name        text,
  shipping_postal_code      text,
  shipping_prefecture       text,
  shipping_city             text,
  shipping_address          text,
  shipping_building         text,
  shipping_phone            text,
  shipping_kana             text,                                              -- フリガナ（FREQ-384）
  created_at                timestamptz         NOT NULL DEFAULT now(),
  updated_at                timestamptz         NOT NULL DEFAULT now(),
  CHECK (shipped_at IS NOT NULL OR (shipping_carrier IS NULL AND tracking_number IS NULL))  -- 発送情報は発送日時とセット
)

-- 注文明細（注文時点の内容を写して固定する）
order_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id          bigint      NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  variant_id       bigint      NULL REFERENCES item_variants(id) ON DELETE RESTRICT,  -- バリアント在庫の移行用。アプリは未使用
  item_name        text        NOT NULL,
  item_price       integer     NOT NULL CHECK (item_price >= 0),
  item_image_url   text,
  color            text,
  size             text,
  quantity         integer     NOT NULL CHECK (quantity > 0),
  line_total       integer     NOT NULL CHECK (line_total >= 0),
  fulfillment_type text        NOT NULL DEFAULT 'stock' CHECK (fulfillment_type IN ('stock','backorder')),
  created_at       timestamptz NOT NULL DEFAULT now()
)
```

注文と明細には、法定保存のためのトリガーが付いている。削除は拒否され、金額・配送先・作成日時などは更新できない。状態などの更新は `order_revisions` に前後の内容が残る。

フリガナ（`shipping_kana`）は、checkout の入力を配送先の写し（`checkout_drafts.shipping_snapshot.kanaName`）に保存し、注文確定のときに注文へ写す（FREQ-384）。配送伝票の記入と、返品などのあとのやり取りに使う。送り状の必須項目ではない（ヤマトの B2クラウドが外部データに求める項目にフリガナは無い）ので、注文確定の必須検証（`findMissingShippingFields`）には入れない。フリガナの無い古い draft からでも注文は作れる。

> **注意**: 金額（`total_amount`）は必ずサーバ側で再計算して検証する。クライアント送信値は参照のみとして利用しない。

---

## Stripe Webhook 冪等性設計（CHECKOUT-WEBHOOK / FREQ-406）

### 処理フロー

```mermaid
flowchart TD
  A[POST /api/webhook/stripe] --> B{raw bodyの署名検証}
  B -- 失敗 --> C[400]
  B -- 成功 --> D[原子的enqueue: stripe_webhook_events]
  D -- DB障害 --> E[500: Stripe再送]
  D -- 保存または一致する重複 --> F[200: 受信完了]
  F --> G[pg_cron: 10秒ごとにworker起動]
  G --> H[claim: SKIP LOCKEDと5分lease]
  H --> I[注文・会計・メール処理]
  I -- 成功 --> J[claim token一致ならcompleted]
  I -- 失敗 --> K[failedと次回時刻を保存]
  K --> G
```

受信ルートは業務処理を待たない。StripeのイベントIDを主キーに、署名検証済みのpayloadをservice-role専用RPCで永続化してから2xxを返す。同じIDの再送では種別・不変の`data`・`account`・`livemode`を照合して重複扱いにする。`pending_webhooks`など配信状況メタデータの差は許容し、不変部分の差は衝突として拒否する。保存が失敗したときだけ5xxにしてStripe再送を受ける。

worker（[route.ts](../../../src/app/api/cron/process-stripe-webhooks/route.ts)）は`CRON_SECRET`で認証し、1回に1件を処理する。DBのclaimは`FOR UPDATE SKIP LOCKED`、5分lease、claim tokenを使う。処理に失敗したイベントは30秒×試行回数（上限30分）後に再試行する。workerが停止した場合もlease期限後に再claimでき、古いworkerは完了を確定できない。注文確定とメール送信は既存の冪等処理を維持する。

`stripe_webhook_events`には`queued / processing / completed / failed`、`attempt_count`、`next_attempt_at`、`claim_token`、`lease_expires_at`を保持する。既存表への列追加と権限制限は[キューmigration](../../../supabase/migrations/20260925000303_add_stripe_webhook_queue.sql)として本番適用済み。Vaultを参照する起動ジョブは[スケジュールmigration](../../../supabase/pending/schedule_stripe_webhook_worker.sql)に保留する。本番ではworkerとCronの稼働を確認してから新しい受信ルートを公開する。

### ハンドラが失敗したときの扱い（FREQ-369）

| 失敗の種類 | 例 | 処理 |
| --- | --- | --- |
| 署名・保存の失敗 | 署名不一致、DB保存エラー | 受信ルートが400または500を返す |
| 入力が恒久的に使えない | `draft_id`が無い、支払IDが無い | 監査ログに残し、業務上の処理済みとする |
| 一時的な障害・DBエラー | 注文・返金・会計RPCがerrorを返した | workerが`failed`と次回時刻を保存し、再試行する |

Supabase clientの`{ error }`を見逃すと、入金済み注文を`pending`のまま完了扱いにしてしまう。業務ハンドラはエラーを例外へ変換する。再試行でpaid更新が0件（既にpaid）なら確認メールを重ねて送らない。
### 同じ支払いの注文確定が並行したとき（FREQ-363）

注文確定 RPC `finalize_order_from_checkout_draft` は次の3経路から呼ばれる。いずれも Checkout Session / PaymentIntent の metadata から同じ `draft_id` を受け取るため、同じ draft 行を奪い合う。

| 経路    | 呼び出し元                    |
| ------- | ----------------------------- |
| 画面    | `POST /api/checkout/complete` |
| webhook | `checkout.session.completed`  |
| webhook | `payment_intent.succeeded`    |

関数内の冪等性の確認は3段構えにする。

1. draft 行のロック前に、同じ `payment_intent_id` の注文を確認する（再送の大半はここで返るのでロック待ちが起きない）
2. draft 行を `FOR UPDATE` でロックした直後に、もう一度確認する（先に走っていた確定処理がロック待ちの間にコミットした場合はここで返る）
3. 注文 INSERT の一意制約違反（`orders_payment_intent_id_key`）で既存注文を返す（最後の防御）

2 が無いと、後から来た呼び出しはロック解放後の在庫（先発が減らした後）を読み、最後の1点を買う注文で `INSUFFICIENT_STOCK` を返す。Read Committed では SQL 文ごとに最新のコミット済みデータを読み、`FOR UPDATE` は待機後に最新の行を返すため。呼び出し元は画面なら 409 となり、支払い済みの客に「注文確定に失敗しました」と表示することになる。Stripe の注文確定ガイドも、同じ決済に対して確定処理が複数回・同時に呼ばれうることを前提に安全にするよう求めている。

検証は次の2本で行う。E2E は API をモックするため、この並行性は再現できない。

| テスト                                                                | 実行方法                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/migrations/finalize-order-idempotency-recheck.test.ts`    | `npm test`。再確認がロックの後・在庫確認の前にあることを SQL で確認する                                                                                                                                                                                                 |
| `tests/integration/db/finalize_order_concurrency.integration.test.ts` | ローカル Supabase（`npm run db:start`）に対して `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/finalize_order_concurrency`。2セッションを実際に競わせる。削除できない試験注文が残るため localhost 以外では動かない |

### 商品行のロック順（FREQ-364）

注文確定と在庫復元は同じ商品行を触る。ロックを取る順が食い違うと、同時に走ったときデッドロックになり、Postgres が1秒後（`deadlock_timeout`）に片方を打ち切る。打ち切られたのが画面からの注文確定なら、支払い済みの客に注文失敗が表示される。

| 処理                       | ロックの取り方                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 注文確定（在庫検証ループ） | `order by 1`（item_id の昇順）で1行ずつ `FOR UPDATE`。減算の UPDATE はこの時点で全行ロック済みなので順序を問わない                                           |
| 在庫復元                   | 在庫を戻す UPDATE の前に、その注文の商品行を `order by i.id ... for update` でまとめてロックする。在庫数が空の商品も含めて、注文確定と同じ集合・同じ順にする |

修正前のローカル DB での実測（同じ6商品、id 昇順は 42〜47）。

| 処理                     | 実際の順                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| 注文確定の在庫検証ループ | 45, 44, 42, 46, 43, 47（ハッシュ集約の出力順。商品の組み合わせごとに変わる） |
| 在庫復元の UPDATE        | その時点のテーブルの物理順（行を更新するたびに変わる）                       |

検証は次の2本で行う。

| テスト                                                     | 実行方法                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/migrations/item-lock-order.test.ts`            | `npm test`。順序の指定が消えていないことを SQL で確認する                                                                                                                                        |
| `tests/integration/db/item_lock_order.integration.test.ts` | ローカル Supabase に対して `DATABASE_URL=... npx jest tests/integration/db/item_lock_order`。k 番目の商品行を別セッションで塞ぎ、k より小さい行だけがロック済みであることを全 k について確認する |

### 在庫の単位を色 × サイズにする 第1段（FREQ-398）

ブランドの前提は受注生産（`docs/01_Planning/brand.md`、法令ページ）。「在庫がある場合は3〜7営業日で発送。無い場合は一定数の注文がまとまった時点で製造」。つまり**在庫の有無は「買えるか」ではなく「納期」を分ける**。在庫の無い組み合わせも受注生産として受ける。

第1段は記録と引き当てだけを切り替える。客に見える変化は無い。

| やること                                                    | やらないこと                           |
| ----------------------------------------------------------- | -------------------------------------- |
| `order_items.variant_id` と `fulfillment_type` を正しく記録 | 店頭表示（第3段）                      |
| 在庫で賄える分を台帳へ `purchase` で引き当て                | 管理画面の在庫入力（第2段）            |
| 未入金の取り消しで `cancel` として戻す                      | `items.stock_quantity` の廃止（第3段） |

#### 引き当ての決め方

```mermaid
flowchart TD
    A[明細の色・サイズ] --> B{対応するバリアントがある}
    B -- ない --> D[backorder / variant_id は空]
    B -- ある --> C{有効かつ 在庫 >= 必要数}
    C -- いいえ --> D
    C -- はい --> E[stock / 台帳へ purchase を追記]
```

- 判定はバリアント単位で**合算**する。1つの注文で同じバリアントが複数明細に分かれることがある
- 在庫が足りなければ明細を分割せず全量 `backorder`。部分的に引き当てると、残りを待つ客に対して在庫だけ先に確保した状態になり、「まとまった時点で製造」の判断（`variant_backorder_summary`）も歪む
- 対応表の不足で支払い済みの注文を失わせない。バリアントが引けなければ `variant_id` は空のまま注文を作る

#### ロックの順序

items（id 昇順）→ item_variants（id 昇順）。注文確定と在庫戻しでそろえる。逆順で取る経路があるとデッドロックになる。引当区分は**ロックした後に読んだ在庫**で決める（先に読んで後でロックすると、その間に別の注文が引き当てる。OWASP ASVS V11.1.6）。

#### items.stock_quantity は残す

本番は全商品 NULL なので減算は実質無効。第3段で表示側をバリアントへ切り替えるときに外す。今外すと2系統の在庫が併存する期間が延びる。

#### 旧スキーマ向けのフォールバックを廃止

`orders.checkout_session_id` が無い時代のために、確定 RPC が失敗したらアプリ側で注文を組み立てる経路が残っていた。この列は既に本番にあり到達しないが、注文作成の二つ目の経路として残すと、上の引き当てを書かない注文ができる。読んでから書く在庫の減算も抱えていたため、経路ごと畳んで RPC 1本にした。旧スキーマのエラーでも注文は作らず 500 を返し、監査ログに残す。

### 在庫復元の遷移先（FREQ-383）

`release_stock_for_unpaid_order(_payment_intent_id, _next_status default 'failed')` は、pending の注文を `_next_status` へ移してから在庫を戻す。移せる先は `failed` と `cancelled` だけにする。それ以外の値と NULL は、行ロックを取る前に `INVALID_NEXT_STATUS`（SQLSTATE 22023 invalid_parameter_value）で失敗させる。

| 呼び出し元                                                                                                        | 渡す遷移先       |
| ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| webhook（`checkout.session.async_payment_failed` / `checkout.session.expired` / `payment_intent.payment_failed`） | 省略（`failed`） |
| 掃除ジョブ（`/api/cron/expire-pending-orders`）                                                                   | 省略（`failed`） |
| 管理画面での pending 注文のキャンセル                                                                             | `cancelled`      |

以前はどの値でも通った。呼び出し側を誤ると次が起き、どれもエラーにならないので気づけなかった（修正前のローカル DB での実測。在庫 5 の商品を 2 個含む注文）。

| 渡した値           | 修正前の結果                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `pending`          | 注文は pending のまま在庫だけ 7 に戻る。呼ぶたびに在庫と注文の改訂履歴が増える |
| `paid` / `shipped` | 未入金の注文が入金済み・発送済みになり、在庫も 7 に戻る                        |

検査には `ASSERT` を使わない。`plpgsql.check_asserts` で無効にでき、PostgreSQL は通常のエラーに `RAISE` を使うよう定めているため。

検証は次の2本で行う。

| テスト                                                               | 実行方法                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/migrations/restrict-release-stock-next-status.test.ts`   | `npm test`。検査が行ロックより前にあること、検査以外が前回の定義と同じことを SQL で確認する                                                                                                                            |
| `tests/integration/db/release_stock_next_status.integration.test.ts` | ローカル Supabase に対して `DATABASE_URL=... npx jest tests/integration/db/release_stock_next_status`。許可しない値では注文・在庫・改訂履歴が変わらないこと、failed / cancelled では今まで通り在庫が戻ることを確認する |

### 決済セッション ID の書き戻し（FREQ-397）

Stripe セッションを作ったら、その ID を下書き（`checkout_drafts.checkout_session_id`）へ書き戻す。以前はこの更新の結果を見ておらず、失敗しても画面には成功に見えていた。

書けないと、支払い前の段階で次が起きる。

| 影響                                     | 理由                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 配送先を1文字も保存できない              | `update-shipping` は `checkout_session_id` で下書きを引くため、0件で 404         |
| 画面を開くたび Stripe セッションが増える | 再利用の判定が「`checkout_session_id` が入った下書き」を探すため、対象から外れる |

- まだ支払いは発生していないので、500 を返して作り直させる（`Failed to prepare checkout`）
- 理由は監査ログに残す（`Failed to store checkout session id on draft`）
- custom と hosted が同じ書き込みをするため、`storeCheckoutSessionIdOnDraft` に1つだけ置く

### Checkout Session 作成の原子性と冪等性（FREQ-405）

`POST /api/checkout/create-session`は、Stripeを呼ぶ前に`claim_checkout_draft`で要求を1つの下書きへ収束させる。画面から来た値をそのまま冪等キーの意味にせず、次のサーバー算出値を固定順序でJSON化し、`v1:<sha256>`のfingerprintを作る。

| fingerprintに含める値                          | 理由                                                  |
| ---------------------------------------------- | ----------------------------------------------------- |
| カート明細、サーバー算出の小計・税・送料・合計 | 同じ請求内容だけを再利用する                          |
| custom / hosted                                | Stripeの必須パラメータが異なる                        |
| 許可リストで検証したorigin                     | hostedの戻り先を同じ値に固定する                      |
| 要求版                                         | Stripeの固定オプションを変えたときに旧Sessionと分ける |

配送先と申告支払方法はfingerprintに含めない。同じカートで入力中に値が変わってもSessionを増やさず、最初にclaimした下書きの値をStripe作成パラメータの正本にする。配送先は`shipping_revision`付きの別同期で更新する。

旧互換の再利用検索は`checkout_request_version`が未設定または`v0`の下書きだけを対象にし、旧Session作成時に固定された支払方法と、商品名・単価を含むStripe関連内容が完全一致する場合だけ再利用する。`v1`以降は動的支払方法を前提に、必ずfingerprint付きのclaim経路を使う。

```mermaid
sequenceDiagram
    participant C as checkout画面
    participant A as create-session
    participant D as Supabase
    participant S as Stripe

    C->>A: 同じcheckout要求を並行送信
    A->>D: claim_checkout_draft(fingerprint)
    D-->>A: 同じdraft ID
    A->>S: Session作成(draft ID由来の冪等キー)
    S-->>A: 同じCheckout Session
    A->>D: attach_checkout_session_to_draft(CAS)
    D-->>A: 同じIDは成功、異なるIDは0件
```

状態ごとの扱いは次のとおり。

| Stripeの確認結果                       | 処理                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `open`                                 | customは`client_secret`、hostedは`url`を同じ下書きから返す                                    |
| `complete`                             | 決済処理中を含むため409を返し、新規Sessionを作らない                                          |
| `expired`                              | 下書きID・セッションID・fingerprint・`created`をすべて照合して退役する。更新0件なら500で停止し、成功時だけ新しい下書きをclaimする |
| 取得失敗、`resource_missing`、未知状態 | 未入金と推定せず500を返し、新規Sessionを作らない                                              |

Stripe作成には`checkout-session:create:v1:<draft ID>`を冪等キー、下書きIDを`client_reference_id`として渡す。同じキーのパラメータが変わらないよう、明細・metadata・メール・戻り先はすべてclaim済み下書きから組み立てる。Session IDの書き戻しは`attach_checkout_session_to_draft`で行い、未設定または同じIDだけを受け入れる。

別IDとのCAS競合が確定した場合は、後発Sessionが`open`と確認できたときだけ、Session IDを含む別の冪等キーで失効する。RPC通信エラーは書き込み結果が不明なのでSessionを失効せず、再送で同じStripe冪等キーと下書きを回収する。

DB変更は2段階で適用する。

1. `supabase/migrations/20260925000132_add_checkout_session_claim_rpcs.sql`で列・一意索引・service-role専用RPCを追加する。
2. 対応アプリの本番動作を確認した後、`supabase/pending/harden_checkout_session_claims.sql`で既存行を`v0`へ補完し、直接INSERTを剥奪する。

第1段階は本番適用済み。第2段階は対応アプリの本番動作を確認してから新しいversionで`supabase/migrations/`へ昇格する。関数は`SECURITY DEFINER`、空の`search_path`、完全修飾名を使い、`PUBLIC` / `anon` / `authenticated`から実行権限を剥奪する。

### 配送先の書き込み順（FREQ-365）

draft の配送先（`shipping_snapshot`）を書き換える経路は2つに絞る。

| 経路                                              | 役割                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/checkout/update-shipping`              | 画面からの同期。入力が止まって0.5秒後（デバウンス）と、「確認へ進む」押下時に必ず呼ぶ  |
| `POST /api/checkout/create-session`（再利用経路） | draft にまだ住所が無いときだけ、今回の配送先で埋める。既に入っている住所は上書きしない |

書き込みは版番号（`checkout_drafts.shipping_revision`）の照合つきで行う。

1. create-session の応答に現在の版番号が入る。画面はそれを保持する。
2. update-shipping は `expectedRevision` を受け取り、`shipping_revision` が一致する行だけを1文の条件付き更新で書き換え、版番号を1つ進めて返す。
3. 一致しなければ 409 と現在の版番号を返す。画面は版番号を取り込み直し、次の同期で書き直す。

これで、遅れて届いた古い内容が新しい内容を消すこと（lost update）を防ぐ。「読んでから書く」の2段構えにはしない。RFC 9110 の条件付きリクエスト（If-Match）と同じ考え方で、Read Committed の Postgres は競合した更新の条件を評価し直すため、同時に走っても勝つのは片方だけになる。

同じタブからの書き込みは直列化する。デバウンスの同期が飛んでいる最中に「確認へ進む」を押すと、同じ版番号で2つ投げることになり、後から届いた確定直前の同期が 409 で弾かれて決済に進めなくなる。前の同期の完了を待ってから、更新された版番号で書き込む。これで 409 は本来の意味（別タブ・別端末が書き換えた）だけになる。

版番号を伴わない更新要求は 428（RFC 6585 Precondition Required）で拒否し、「再読み込みしてからやり直す」案内を返す。この仕組みが入る前に開いたまま放置されたタブから届くケースがこれにあたる。入力そのものの不備（負の値・整数でない値）は 400 で区別する。428 は監査ログにも残すので、古い版のまま使われているタブがあることを運用側から検知できる。

確定直前は、画面の「同期済み」の記憶にかかわらず必ず書き込む。記憶だけで省略すると、確認（check）と決済（use）の間にサーバ側が変わっていても気づけない（OWASP ASVS V11.1.6 の TOCTOU）。

注文確定の前には配送先の必須項目（メールアドレス・氏名・郵便番号・都道府県・市区町村・番地・電話番号）を検証する。欠けていても支払いは成立しているので注文は作り、欠けた項目を監査ログにエラーとして残す。注文一覧は`配送先要確認`を表示して発送操作を隠し、`admin_ship_paid_order`とDBトリガーも`shipped`への遷移を拒否する（ASVS V11.1.5 / V11.1.7）。

| テスト                                                                      | 内容                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tests/unit/api/checkout/update-shipping-route.test.ts`                     | 版の照合、409、不正な版番号の拒否                               |
| `tests/unit/api/checkout/create-session-route.test.ts`                      | 再利用時に既存の住所を上書きしないこと、空の draft を埋めること |
| `tests/unit/api/checkout/complete-route.test.ts`                            | 配送先の欠落を監査ログに残しつつ注文は作ること                  |
| `tests/integration/db/checkout_draft_shipping_revision.integration.test.ts` | 実 DB で古い書き込みが弾かれること、同時でも片方だけが勝つこと  |
| `e2e/FR-CHECKOUT-027-shipping-sync-before-confirm.spec.ts`                  | 確定直前に必ず同期すること、拒否されたら決済へ進まないこと      |

### 確定ボタンの有効・無効（FREQ-367）

| 状態                                                     | 確定ボタン                                                    | 表示                    |
| -------------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| 決済セッションを取得中                                   | 押せない                                                      | 確認へ進む（無効）      |
| 決済セッション未取得（失敗・再試行待ちを含む）           | 押せる（入力検証のフィードバックを返すため。FREQ-354-REQ-02） | 確認へ進む              |
| セッションは取得済みだが Stripe の決済フォームが初期化中 | 押せない                                                      | 決済フォームを準備中... |
| 決済フォームの初期化が完了                               | 押せる                                                        | 確認へ進む              |
| 決済処理中                                               | 押せない                                                      | 決済処理中...           |

押せる状態＝決済に進める状態に揃える。以前は初期化中でも押せてしまい、「決済フォームの初期化が完了していません」と表示されるだけで先に進めなかった。無効化した操作は理由が伝わらないと迷わせるので、表示を「準備中」に変えて理由を示す。押下時の初期化チェックは、UI から到達しなくなっても安全策として残す。

### 配送先の保存（FREQ-366）

「この配送先を保存する」は、住所の入力フォームと同じ条件でのみ表示し、同じ条件でのみ保存する。

| 状態                                      | 入力フォーム | 保存                                   |
| ----------------------------------------- | ------------ | -------------------------------------- |
| 保存済み住所が0件（初めて買うログイン客） | 出す         | チェック ON なら保存する               |
| 「新規」を選択                            | 出す         | チェック ON なら保存する               |
| 保存済み住所を選択                        | 出さない     | 保存しない（同じ住所の二重登録を防ぐ） |

表示と保存を別々の条件で書くと、保存済み住所が0件のときだけ「フォームは出るのに保存されない」ようにずれる。判定は `isEnteringNewAddress` の1か所にまとめる。

チェックが OFF のときは何も保存しない（OWASP ASVS 8.3.3 の opt-in 同意）。保存は決済確定の直前に走るので、保存に失敗したときは決済へ進まずエラーを出す（支払い前に止まるため、二重課金にはならない）。検証は `e2e/FR-CHECKOUT-017-save-address-control.spec.ts` の「保存済み住所が0件でも配送先を保存する」。

### 確認画面の支払方法（FREQ-371）

確認画面は、決済フォーム（PaymentElement）の change イベントの `value.type` を丸めずに持ち、サーバが注文に記録するのと同じ変換を経て、注文詳細（`/api/orders/[id]`）と共通の `mapPaymentMethodLabel` で表示する。変換は `src/features/checkout/services/payment-method.service.ts` にまとめる。

| `value.type`                  | 注文に記録される値 | 表示             | API に送る値     |
| ----------------------------- | ------------------ | ---------------- | ---------------- |
| `card`                        | `stripe_card`      | クレジットカード | `stripe_card`    |
| `apple_pay` / `google_pay`    | `stripe_card`      | クレジットカード | `stripe_card`    |
| `paypay`                      | `stripe_paypay`    | PayPay           | `stripe_paypay`  |
| `konbini`                     | `stripe_konbini`   | コンビニ払い     | `stripe_konbini` |
| `link`                        | `link`             | Link             | 送らない         |
| `customer_balance`            | `customer_balance` | 銀行振込         | 送らない         |
| その他                        | 値のまま           | 値のまま         | 送らない         |
| 未選択（change イベントの前） | `stripe_card`      | クレジットカード | `stripe_card`    |

- 以前はカード・PayPay・コンビニ以外をすべて `stripe_card` に丸めていたため、Link や銀行振込で払っても確認画面に「カード決済」と表示され、注文詳細の表示と食い違っていた
- Apple Pay / Google Pay はカードで決済され、Stripe の PaymentMethod は `type: card`（ウォレットの種別は `card.wallet`）になるので、カードとして扱う
- create-session / complete の入力検証は3手段（`STRIPE_CHECKOUT_PAYMENT_METHODS`）だけを受け付ける。それ以外を送ると 400 になるので送らない。サーバはクライアントの申告を採用せず Stripe から決める（`resolvePaymentMethodFromSession`）ため、送らなくても記録は変わらない
- PayPay のようなリダイレクト型は確認画面を通らず、戻り先で注文を確定する

| テスト                                                      | 確認すること                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `tests/unit/features/checkout/payment-method-label.test.ts` | 各 `value.type` の表示名と、API に送る値が入力検証を通ること               |
| `e2e/FR-CHECKOUT-029-payment-method-label.spec.ts`          | テスト用カードで決済を確定すると、確認画面に「クレジットカード」と出ること |

テストモードでは Link（登録済みの Link アカウントが要る）と銀行振込（ダッシュボードで無効）の確認画面まで E2E で進めないため、これらは単体テストで確かめる。

### 画面の部品の定義場所（FREQ-372）

checkout の部品は `CheckoutPageContent` の外（モジュールの最上位）で定義し、必要な値は props で渡す。画面の関数の中で定義すると、再描画のたびに別の部品として作り直され（React は部品の関数が変わると、その下の state と DOM を捨てて作り直す）、次のことが起きていた。

| 起きていたこと                                             | きっかけ                                     |
| ---------------------------------------------------------- | -------------------------------------------- |
| 入力中のプロモーションコードが消える                       | 氏名などほかの欄への入力、支払方法の切り替え |
| 「このプロモーションコードは無効です。」などの案内が消える | 同上                                         |
| 「確認へ進む」のキーボードフォーカスが外れる               | 配送先の同期の完了など、画面の再描画全般     |

| 部品                                   | 受け取る値                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PromoCodeField` / `StripeOrderTotals` | なし（`useCheckout()` から読む）                                                                                |
| `ConfirmPaymentButton`                 | `onConfirm`（押したときの処理。親の `handleConfirmPayment`）、`sessionLoading`、`confirming`、`hasClientSecret` |
| `OrderItems`                           | `cartItems`                                                                                                     |
| `CartTotals`                           | `subtotal` / `shipping` / `total`                                                                               |
| `AddressCard`                          | `address`（配送先フォームの値）                                                                                 |

- `useCheckout()` を使う部品は `CheckoutProvider` の内側で部品として描画する必要があるため、`renderAddressFields()` のような「JSX を返す関数の呼び出し」にはできない。モジュールの最上位の部品にする
- 再発防止に、lint ルール `react-hooks/static-components`（eslint-config-next の推奨設定）を有効に戻した。以前は `eslint.config.mjs` で無効化されていた
- lint は描画用の関数（`renderCheckoutSections()` など）の中での使用を検出しないため、「確認へ進む」のフォーカスは E2E で確かめる

| テスト                                               | 確認すること                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `e2e/FR-CHECKOUT-030-keep-input-on-rerender.spec.ts` | 入力中のコード・案内・フォーカスが、ほかの操作による再描画で消えないこと |

### プロモーションコード欄の見出し（FREQ-373）

見出し「プロモーションコード」の `label` の `htmlFor` と入力欄の `id` を一致させる（W3C H44）。id は `useId()` で作る。以前は見出しが入力欄に結びついておらず、入力欄の名前はプレースホルダ「コードを入力」で代用されていた（入力を始めると消えるので名前にならない）。

- コードの適用後は入力欄が無いので、見出しは結びつけない（`htmlFor` を付けない）
- `TextField` は `label` を渡すと部品の中に見出しを描くが、ここでは見出しが入力欄と「適用」ボタンの上にまたがるので、外の `label` を `htmlFor` で結びつける
- 検証は `e2e/FR-CHECKOUT-031-promo-code-label.spec.ts`（欄の名前と、見出しを押したときのフォーカス）

### プロモーションコードを適用できなかった案内（FREQ-374）

適用できなかった理由（例: 「このプロモーションコードは無効です。」）を、表示と同時に読み上げ、入力欄に結びつける。

| 状態     | 案内の要素                                    | 入力欄                                                 |
| -------- | --------------------------------------------- | ------------------------------------------------------ |
| 案内なし | 空の `role="alert"`。`sr-only` で画面から外す | `aria-invalid` と `aria-describedby` を付けない        |
| 案内あり | 同じ要素に文言が入り、赤字で表示する          | `aria-invalid="true"`、`aria-describedby` で案内を指す |

- `role="alert"` の要素を文言ごと後から差し込むと、中身の変化とみなされず読み上げられないことがある（MDN alert role）。入れ物を最初から置き、中身だけを入れ替える。WAI-ARIA APG の Alert の例も同じ作り
- 空の要素をそのまま置くと、`.checkout-section` の `gap` で余白が1つ増える。空のあいだは `sr-only`（絶対配置で flex の並びから外れる）にする
- 同じコードを続けて適用しても、適用の開始で案内を空にしてから入れ直すので、毎回読み上げられる
- `TextField` の `errorText` は使わず、案内は入力欄と「適用」ボタンの下に全幅で出す。`errorText` だと案内が入力欄の列の中に入り、横並びのボタンが縦に伸びる。`TextField` 側の案内の入れ物（FREQ-375）は、この欄では空のまま（空の読み上げ領域は読み上げられない）
- 検証は `e2e/FR-CHECKOUT-032-promo-error-a11y.spec.ts`

### 確定時の欄ごとの誤りの読み上げ（FREQ-376）

空のまま「確認へ進む」を押すと、欄ごとの誤りが一度に最大8件出る（メール・氏名・フリガナ・郵便番号・都道府県・市区町村・番地・電話番号）。

| 案内                                                                                                                                        | 読み上げ                          | 理由                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| 欄ごとの誤り（`TextField` / `SingleSelect` の `errorText`。都道府県は `#prefecture-error`）                                                 | 割り込まない `aria-live="polite"` | 割り込む `role="alert"` だと8件が一斉に読み上げられる |
| お客様情報・配送先の保存の失敗（`customerError`、`profileSaveError`）、プロモーションコードの案内、決済の準備・注文の確定の失敗（FREQ-377） | `role="alert"`                    | 操作の結果として出る単発の案内                        |

- 先頭の誤りの欄（氏名）へフォーカスを移して知らせる（FREQ-354）。移った欄の名前と説明（誤りの文言）が読まれる
- 案内はすべて `LiveMessage` で出す（入れ物を最初から置き、中身だけを入れ替える。`21_design_system.md` 参照）
- 都道府県の欄は FREQ-379 で `SingleSelect` の `errorText` に移した。欄の説明（`aria-describedby`）と誤りの状態（`aria-invalid`）が付き、枠がエラー色になる。キーボードだけでも選べる
- 検証は `e2e/FR-UI-007-live-message.spec.ts`、`e2e/FR-UI-009-select-combobox.spec.ts`

### 決済まわりの失敗の案内（FREQ-377）

| 案内                               | 置き場所                                                                     | 目印                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 決済の準備（create-session）の失敗 | 決済フォームの下。エラー ID と「再試行する」は案内の後ろに、入れ物の外で出す | `data-testid="checkout-session-error"` |
| 決済から戻って注文の確定に失敗     | 入力画面（step 1）の先頭。確定は入力画面のまま走るため                       | `data-testid="checkout-return-error"`  |
| 確認画面の「注文する」の失敗       | 確認画面の操作ボタンの上                                                     | —                                      |

- 以前は決済から戻って確定に失敗しても、案内が確認画面（step 2）の中にしか無く、画面にも出ていなかった
- 確認画面から「戻る」で入力画面に戻るときは、確認画面の案内を消す（入力画面の先頭に持ち越さない）
- 検証は `e2e/FR-UI-008-status-messages.spec.ts`（AC-01・AC-02）

### 割引が付いた注文の確定（FREQ-389）

チェックアウト画面にプロモーションコードの入力欄があり、Stripe セッションも `allow_promotion_codes: true` で作る（custom / hosted の両方。片方だけ許すと、生成経路によって同じコードが使えたり使えなかったりする。FREQ-397）。割引が付くと Stripe の `amount_total` は割引後、`total_details.amount_discount` が値引額になる。下書き（`checkout_drafts`）は割引前の合計を持っているので、注文確定の前にそろえる。

| 時点                                        | `checkout_drafts.total_amount` | `discount_amount` |
| ------------------------------------------- | ------------------------------ | ----------------- |
| 作成時                                      | 割引前の合計                   | 0                 |
| 確定の直前（complete / webhook が書き戻す） | 割引後の実請求額               | 値引額            |
| 注文（`orders`）へ                          | 同じ値を引き写す               | 同じ値を引き写す  |

そろえないと、注文確定が `_expected_total_amount`（割引後）と下書きの合計（割引前）を比べて `CHECKOUT_TOTAL_MISMATCH` で落ちる。支払い済みの客に 409 が返り、注文は1件も作られない。

- 書き戻しは complete と webhook の両方で行う。ブラウザが戻らない経路（コンビニ・銀行振込、webhook 先行のカード）では complete が走らないため
- 書き戻しに失敗したら、そのまま進めても必ず落ちるので注文確定を呼ばない。complete は 500、webhook のworkerは例外にして永続キューから再試行する。理由は監査ログに残す（握りつぶすと本番で原因が読めない）
- 注文確定は `COALESCE(draft_row.discount_amount, 0)` を注文へ入れる。以前は 0 を直書きしていたため、注文詳細に値引額が出なかった

### 何度呼ばれてもそろう形にする（FREQ-394）

上の書き戻しは、注文確定の金額検査が見ている値そのもの（`checkout_drafts.total_amount`）を書き換える。検査の基準に割引後の額を使うと、書き戻しが済んだ2回目から必ず外れる。

確定は1つの注文につき何度でも走る。

| 2回目が走る場面                                | 起きること（対策前）                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| webhook が先に注文を作り、その後ブラウザが戻る | 注文はあるのに complete が 400 を返し、客の画面は失敗表示 |
| 注文確定が落ちて客が再試行する                 | 何度押しても 400。その注文は二度と確定できない            |

対策は、同期で動かない値を基準にすること。

- 比べるのは割引前どうし。`下書きの total_amount + 下書きの discount_amount` と `Stripe の amount_total + total_details.amount_discount`。この和は同期の前後で変わらない
- 支払いに対応する注文が既にあるときは、書き戻しを行わずその注文を返す。確定処理を通らない以上、そろえる必要も余計な書き込みも無い
- 金額の食い違いそのものは従来どおり 400 で弾く（不正な減額を通さないための検査であり、緩めていない）

#### イベントの順序（FREQ-394）

Stripe はイベントの配信順を保証しない。`payment_intent.succeeded` が `checkout.session.completed` より先に届くと、下書きは割引前のままで注文確定が落ち、500 を返し続ける。`payment_intent.succeeded` のペイロードに値引額は無いため、`checkout.sessions.list({ payment_intent })` でセッションを引いてそろえる。

- セッションを引けない場合（Checkout 経由でない PaymentIntent、Stripe 側の一時障害）は割引なしとして進む。金額の根拠を推測で埋めない。合計が食い違えば注文確定が弾き、後から届く `checkout.session.completed` が処理する
- 書き戻しは両経路で同じ関数を通す。片方だけ直しても、もう片方が同じ落ち方をするため

### 合計が 0 になる割引は受け付けない（FREQ-389）

Stripe 公式（無料の注文）に「無料注文のフルフィルメントを行うには、PaymentIntent イベントではなく、`checkout.session.completed` イベントを処理してください。**支払いのない完了済みの Checkout セッションでは PaymentIntent の関連付けが行われません**」とある。この店の注文の冪等キーは `orders.payment_intent_id` なので、PaymentIntent が無いと注文を一意にできない。

- `amount_total` が 0 のセッションは、注文を作らず 400（`Zero-amount checkout is not supported`）を返し、監査ログに残す
- webhook も同じ判定・同じ文言で記録する（FREQ-397）。以前は「payment_intent が無い」としか残らず、本番のログで Stripe 側の不具合と区別がつかなかった。判定と文言は `isZeroAmountCheckoutSession` / `ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL` に1つだけ置く
- 「PaymentIntent が無い」で弾くと理由が読めないため、こちらを先に判定する
- 運用上は、合計が 0 になるクーポン（100%割引・合計以上の割引）を Stripe 側で作らない
- 支えるなら、注文の冪等キーを `checkout_session_id` へ広げ、`payment_intent_id` を null 可にする改修が要る

### 商品が引けないときの注文確定（FREQ-387）

管理画面の商品削除は実削除で、カートや checkout draft は止めない（注文済みの商品は注文明細の外部キーが守る）。削除された商品を含む draft で注文確定を呼ぶと、以前は次の順で落ちていた。

1. 商品を1件ずつ `SELECT ... INTO` で引く。行が無いので `item_status` は NULL、`FOUND` は false（PostgreSQL 公式の動作）
2. `item_status <> 'published'` は NULL との比較で NULL になり、条件が成立せず公開判定を素通りする
3. 注文明細の INSERT が外部キー違反（23503）で落ちる。支払いは済んでいるので、客には理由の分からない失敗が返る

いまは `IF NOT FOUND OR item_status IS DISTINCT FROM 'published'` で、行が無いときも非公開と同じ `ITEM_NOT_PUBLISHED` で止める。アプリはこのエラーを 409「非公開商品が含まれているため、購入手続きを完了できませんでした。」に変換する。検証は `tests/unit/migrations/reject-missing-item-on-finalize.test.ts` と `tests/integration/db/finalize_missing_item.integration.test.ts`。

### 注文メールは1注文・1種類につき1通（FREQ-386）

注文確定は「画面からの complete」と「webhook」の2経路から走り、どちらも同じ注文を受け取る（確定の関数は既存の注文をそのまま返すため）。送信済みの記録が無いと、次のことが起きる。

| 場面                                     | 直す前                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| カードで webhook が先に注文を作る        | webhook は入金待ちのときしか送らず、complete は既存注文として何も送らずに返す。**0通**  |
| コンビニ・銀行振込で complete が先に作る | complete が送り、そのあと webhook が同じ入金待ちの注文を受け取ってもう一度送る。**2通** |
| 掃除ジョブが pending を paid に上げる    | 更新できた行数を見ずに送るため、webhook と重なると**2通**                               |

Stripe は「同じイベントを複数回受信する可能性」と「配信順は保証しない」を明記しているので、受け取り側で重複を排除する。これは OWASP ASVS V11.1.6（TOCTOU・競合）の対象でもある。

- 送る直前に `public.claim_order_email(order_id, kind)` で送信権を取り、取れた経路だけが送る。送信に失敗したら `public.release_order_email` で戻し、あとの経路（webhook の再送・掃除ジョブ）に譲る
- `kind` は `awaiting_payment` と `paid` の2つ。コンビニは「お支払い待ち」と「入金確認」で2通届くのが正しい
- 記録は `private.order_emails`（Data API から触れないスキーマ。Supabase のドキュメントが示す置き方）。関数は SECURITY DEFINER・`search_path = ''` で、実行できるのは service_role だけ
- 権利の確認そのものが失敗したときは、届かないより重複を選んで送り、監査ログ（`order.confirmation.mail` / `mail_claim_failed`）に残す
- webhook は入金済みの注文を作ったときも送る。掃除ジョブは paid に更新できた行があるときだけ送り、0件なら `alreadyPaid` として数える
- 注文 ID から注文行と明細を引いて本文を組み立てる処理は `sendOrderConfirmationEmailForOrderId`（`src/lib/orders/order-confirmation-email.ts`）に1つだけ置く。以前は webhook の2か所と掃除ジョブの計3か所が同じ列の並びと同じ組み立てを別々に持っていて、片方だけ直すと経路によって客に届く内容が食い違う状態だった
- 明細が引けないとき、および0件のときは送らない（空の注文内容を客に見せない）。送信権を取る前に止めるので、後の経路が送り直せる。呼び出し側は送れなくても注文の成否を変えない
- 検証は `tests/unit/lib/orders/order-confirmation-email.test.ts`、`tests/integration/db/order_email_claims.integration.test.ts`、各経路の単体テスト

#### 本文は注文行だけから作る（FREQ-396）

確定（complete）だけは下書きのスナップショットから本文を組み立てていた。値引額は注文行（`orders.discount_amount`）にしか無いため、割引が付いた注文のメールは**小計＋送料と合計が合わない**まま届いていた。注文詳細の画面は `-￥1,000` を出しているので、同じ注文について画面とメールで見え方が違っていた。

- 本文の組み立ては `sendOrderConfirmationEmailForOrderId` に一本化する。complete も注文 ID だけを渡す（`logLabel: '[checkout]'`）
- 値引がある注文では、送料の次に `割引: -￥1,000` を出す。0 のときは行ごと出さない
- 低レベルの `sendOrderConfirmationEmail` は直接呼ばない。`discountAmount` を必須の引数にしてあるので、新しい呼び出し側が割引を落とすと型で落ちる

| 行   | 出典                                               |
| ---- | -------------------------------------------------- |
| 小計 | `orders.subtotal_amount`                           |
| 送料 | `orders.shipping_amount`（0 なら「無料」）         |
| 割引 | `orders.discount_amount`（0 のときは行を出さない） |
| 合計 | `orders.total_amount`（割引後の実請求額）          |

### 直らない失敗のあとの「確認へ進む」（FREQ-385）

決済の準備が、待っても直らない理由（在庫切れ、`retryable: false` の 422 など）で失敗したとき、決済フォームはまだ無いので代替の「確認へ進む」が出る。以前はこれを押すと、原因の案内が「決済フォームを準備しています。少し待ってから再度お試しください。」に置き換わっていた。再試行ボタンも出ない状態なので、直らないものを待たせることになる。

- 再試行できない失敗のあいだ（`checkoutError` があり `sessionErrorRetryable` が false）は、「確認へ進む」を押せなくする
- 押せない理由が分かるよう、ボタンの `aria-describedby` で案内の要素（`id="checkout-session-error-message"`）を指す
- 案内は今まで通り読み上げ領域（`data-testid="checkout-session-error"`）に出す。在庫切れなら、カートを直してから進んでもらう
- 検証は `e2e/FR-CHECKOUT-034-session-error-keeps-message.spec.ts`（3ビューポート）

### 決済から戻ったときの確定は1回だけ（FREQ-378）

`/checkout?session_id=…` で開くと、effect が `/api/checkout/complete` を送る。送ったことを state（`processedCallback`）で覚えていたが、state は次の描画まで反映されない。カートの再描画で依存の `updateCartCount`（メモ化されていない）が先に変わった描画で effect が走り直し、3ms 差で2回送ることがあった（15回中4回。変更前のコードでも同じ率で再現）。

- 送った決済セッションを ref（`finalizedSessionIdRef`）で覚える。ref は即座に変わるので、走り直しても同じ決済セッションでは送らない
- 部品の作り直しではないことを、計測ログ（部品ごとの識別子）で確かめた
- サーバー側は、順番に来た重複には既存の注文を返す。同時に来た重複の扱いは、確認メールの重複と合わせて別の課題
- 検証は `e2e/FR-CHECKOUT-033-complete-once-on-return.spec.ts`（幅ごとに8回繰り返す）、`e2e/FR-CHECKOUT-005-006-009-checkout-postal-complete-idempotent.spec.ts`

---

## API 仕様（CHECKOUT-API）

| エンドポイント                 | メソッド | 概要                                    | 認証                | 主なレスポンス                |
| ------------------------------ | -------- | --------------------------------------- | ------------------- | ----------------------------- |
| `/api/checkout/create-session` | POST     | カート内容から Stripe セッションを作成  | 任意（ゲスト/会員） | `{ sessionId, clientSecret }` |
| `/api/checkout/complete`       | POST     | Webhook/サーバ確認後に注文を確定        | 任意                | `{ orderId, status }`         |
| `/api/webhook/stripe`          | POST     | Stripe Webhook 受信・署名検証・冪等処理 | Stripe 署名         | `200` or `400`                |

> **決済成功率目標**: 99% 以上。支払失敗時は注文を `failed` ステータスに更新し、ユーザへ再試行導線を提示すること。

> **`/api/checkout/create-session` のレート制限**: IP 単位は「10秒10回」と「10分60回」の二段、セッション単位は 10 回/分（FREQ-362）。この API は呼ぶたびに Stripe を最低1回呼ぶ（再利用時は取得、新規は作成）。10秒の上限は一瞬の集中を抑え、時間枠の境目をまたいでも1つの IP から毎秒10回程度に収まるので、Stripe の上限（エンドポイントごとに毎秒25回）を超えない。10分の上限は1つの IP から続けて呼べる総量（1時間360回）を抑える。1つの長い時間枠だけで絞ると、共有 IP（携帯回線・社内）からの短い集中まで止めてしまうため二段にしている。セッション単位の上限は Cookie を捨てれば回避できるので、1つのブラウザでの誤操作の連打対策であり、IP 側を緩める根拠にしない。上限に達したら 429 で時間をおいて再試行するよう案内する文を返し、画面はそれをそのまま表示する。E2E はすべて 127.0.0.1 から呼ぶため、`scripts/e2e-server.mjs` が起動するサーバーだけ `E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER=30` で IP 単位の上限を引き上げる（`VERCEL=1` のとき無視、30 倍まで）。

---

## イベントスキーマ管理（INTEG-EVENT）

| バージョン | 方針                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `v1`       | 現行スキーマ。破壊的変更は禁止                                                                    |
| `v2` 以降  | 新バージョンを追加し、旧バージョンは deprecation スケジュールを公開後、十分な猶予期間を設けて廃止 |

- 後方互換性: 新フィールド追加は `v1` に許可（オプション）。型変更・フィールド削除は新バージョン必須。
- スキーマは OpenAPI / JSON Schema で管理し、CI で diff を自動検出する。

---

## API バージョニング方針（INTEG-APIVER）

- バージョンは URL パス（`/api/v1/items`）または `Accept: application/vnd.api+json;version=1` ヘッダーで明示する。
- 非互換変更は新バージョンとして追加し、旧バージョンは **最低 6 か月** の deprecation 期間を設けて廃止する。
- 廃止予定の API は `Deprecation` / `Sunset` レスポンスヘッダーで通知する。

---

## シークレットローテーション方針（INTEG-SECRETS）

| シークレット種別        | ローテーション周期 | 緊急時                    |
| ----------------------- | ------------------ | ------------------------- |
| `STRIPE_SECRET_KEY`     | 90 日              | 漏洩疑い発生後 1 時間以内 |
| `STRIPE_WEBHOOK_SECRET` | 90 日              | 漏洩疑い発生後 1 時間以内 |
| Supabase サービスキー   | 90 日              | 漏洩疑い発生後 1 時間以内 |

- ローテーション手順: Secrets Manager に新バージョン登録 → CI/CD で新 Secret を取得 → ローリングデプロイ → Health Check 確認 → 旧 Secret 無効化 → 監査ログ記録。

---

## 新しい決済手段をダッシュボードで有効化するときの手順（CHECKOUT-DPM-OPS）

決済手段の動的化（FREQ-356）により、決済手段の追加は Stripe ダッシュボードの操作だけで反映される。時間差決済（コンビニ払い・銀行振込など、入金確定が即時でない方式）を有効化する場合は次を確認する。

1. その方式の入金確定が `checkout.session.async_payment_succeeded` で通知されるか（Stripe のドキュメントで「delayed notification」に分類されるか）を確認する
2. 支払期限を指定できる方式なら `payment_method_options` に設定する（コンビニは `expires_after_days` に `KONBINI_PAYMENT_DAYS`（7日。`src/lib/constants/konbini.ts`）を設定済み。/legal の表記も同じ定数を読む。FREQ-106・R-57）。指定できない方式は Checkout Session をアプリ側で強制終了できない場合があるため、失効・返金・長期保留の運用を決めてから有効化する。`PENDING_ORDER_EXPIRY_DAYS` は再照合を始める閾値であり、支払期限ではない
3. その方式が Customer を要求するか確認する（`customer_creation: if_required` の既定で足りるか）
4. テストモードで「確定 → `pending` 注文と在庫減 → `async_payment_failed` で在庫復元 → `async_payment_succeeded` で `paid` と確認メール」を一巡させる
5. 返金の可否と手数料の扱いを確認する（返金非対応の方式がある）
6. 確認画面と注文詳細の表示名を確認する。`mapPaymentMethodLabel` に無い方式は Stripe の種別名（例: `alipay`）がそのまま表示されるので、必要なら表示名を追加する（FREQ-371）

Link を独立した支払手段として有効化する、または Express Checkout（Apple Pay / Google Pay などのボタン）を導入する場合は、`src/proxy.ts` の CSP に Stripe 公式ガイドの Link 用ディレクティブ（`frame-src` と `connect-src` に `https://link.com https://*.link.com`、`img-src` に `https://*.link.com`）を追加し、`e2e/FR-CHECKOUT-025-stripe-csp-guard.spec.ts` を実 Stripe で実行して外部リソースの CSP ブロックが0件であることを確認する（FREQ-359）。現状の Link はカード欄内の保存機能として `js.stripe.com` から配信されるため、追加は不要。

`e2e/FR-CHECKOUT-025-stripe-csp-guard.spec.ts` の PayPay の検証は、PayPay が選ばれたこと（決済フォームの項目の `aria-expanded="true"`）を確かめてから観測する（`e2e/checkout-test-utils.ts` の `selectPaymentMethod`）。以前は画面外の決済フォームを押して選べないまま観測しており、mobile と desktop では PayPay を選ばずに通っていた。

### 掃除ジョブの環境変数

既定日数を超えた `pending` 注文を日次で Stripe と再照合する `POST /api/cron/expire-pending-orders` は次の環境変数を使う。pg_net は POST リクエストのみ発行できるため POST となる。

| 環境変数                    | 用途                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CRON_SECRET`               | 掃除ジョブ呼び出しの認証に使う `Authorization: Bearer <CRON_SECRET>` の照合値。不一致は 401                    |
| `PENDING_ORDER_EXPIRY_DAYS` | `pending` 注文を Stripe と再照合し始めるまでの日数（既定 5。5未満を指定しても5に底上げする）。支払期限ではない |

Checkout Session が所有する PaymentIntent は直接 cancel しない。Stripe の現状態を検証し、次の状態遷移だけを許可する。在庫復元と注文状態の変更は `release_stock_for_unpaid_order` で原子的に行う。

| Stripe の状態                                                                               | 処理                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| PaymentIntent `succeeded`                                                                   | 注文を `paid` に救済し、在庫を戻さない                                                                       |
| PaymentIntent `processing`                                                                  | 注文と在庫を維持し、次回再照合する                                                                           |
| PaymentIntent `canceled`                                                                    | 未払い終了状態として在庫復元 RPC を呼ぶ                                                                      |
| Checkout Session `open` かつ `unpaid`                                                       | Session を冪等に expire し、応答または再取得で `expired` かつ `unpaid` を確認した場合だけ在庫復元 RPC を呼ぶ |
| Checkout Session `expired` かつ `unpaid`                                                    | 在庫復元 RPC を呼ぶ                                                                                          |
| Checkout Session `complete`、支払い済み、PaymentIntent との関連付け不一致、または再検証不能 | 注文と在庫を維持し、監査ログを失敗として残す                                                                 |

下限を5日にする理由（FREQ-388）。Stripe は「保留中のコンビニ決済は、指定された日付の深夜直前 (23:59:59) に有効期限が切れます」と定めている。`expires_after_days: 3` で 0:00 に確定した払込票は、約4日（3日23時間59分）支払える。さらに「期限が切れる前に有効な払込取扱票を発行した場合には、`expires_at` の後でもレジで決済を『完了』できます」とあり、期限ちょうどで打ち切ると支払い中の客とぶつかる（Stripe 側でも、支払い中のキャンセル要求は失敗する）。日本時間と UTC の9時間差も踏まえ、1日以上の余裕を取る。

呼ぶ側（pg_net）と呼ばれる側（ルート）の時間の関係も合わせる。

| 場所                                                  | 値                              | 意味                                             |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `supabase/pending/schedule_expire_pending_orders.sql` | `timeout_milliseconds := 60000` | pg_net が応答を待つ上限                          |
| `src/app/api/cron/expire-pending-orders/route.ts`     | `maxDuration = 60`（秒）        | ルートの実行上限                                 |
| 同上                                                  | `TIME_BUDGET_MS = 45_000`       | ルートが自分で処理を打ち切り、監査ログを残す時刻 |

pg_net の待ち時間を短くすると、ルートがまだ働いている最中に呼ぶ側が諦める。`cron.job_run_details` と `net._http_response` にはタイムアウトだけが残り、運用からは「毎晩失敗している」としか見えない（実際は片付いている）。`timeout_milliseconds` は `maxDuration` 以上にする。この関係は `tests/unit/migrations/schedule-expire-pending-orders.test.ts` が両方のファイルを読んで確かめる。

1回に処理する注文は最大50件とする。`pending` の候補件数から50件単位の範囲を求め、`created_at, id` の安定順序で UTC 日ごとに範囲を巡回する。これにより、長期保留する `complete` / `unpaid` 注文が先頭50件を占めても後続注文を再照合できる。count と一覧取得の間に状態が変わって選択範囲が空になった場合は、その実行だけ先頭範囲へ戻す。監査メタデータに `candidateCount` と `batchOffset` を残す。

### 認証失敗の記録と監視（FREQ-370）

`/api/cron/expire-pending-orders` は誰でも叩ける。認証の失敗は記録するが、1回ごとに監査ログの INSERT と外部アラート（`ALERT_AUDIT_URL`）を起こすと、未認証の要求だけでログとアラートを際限なく増やせる（OWASP Logging Cheat Sheet の「ログで資源を枯渇させない」、OWASP API4:2023）。

| 失敗の理由                             | 応答 | 記録先                                                                  |
| -------------------------------------- | ---- | ----------------------------------------------------------------------- |
| Authorization ヘッダが無い・一致しない | 401  | アプリのログだけ（ヘッダの値は出さない）                                |
| `CRON_SECRET` 未設定（設定ミス）       | 401  | アプリのログと監査ログ。監査ログは IP に依らない共通の枠で10分に1回まで |

「ジョブがそもそも呼ばれていない」「401 で失敗している」は、DB 側の記録で確認する。pg_net の応答は既定で6時間だけ `net._http_response` に残るので、実行時刻（04:00 UTC）から6時間以内に見る。

```sql
-- ジョブの実行結果（Vault の秘密が欠けていれば failed と理由が残る。FREQ-368）
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'expire-pending-orders')
order by start_time desc
limit 5;

-- 送信した HTTP 要求の応答（401 なら CRON_SECRET の不一致・未設定を疑う）
select id, status_code, error_msg, timed_out, created
from net._http_response
order by created desc
limit 20;
```

### pg_cron 登録

掃除ジョブを日次実行するための pg_cron + pg_net 登録 SQL は、本番の公開時まで `supabase/pending/schedule_expire_pending_orders.sql` に保留している（`supabase/migrations/` に置くと CI の `db push` が本番へ流すため。FREQ-380）。入れるときは新しい version で `supabase/migrations/` へ移す（[supabase/pending/README.md](../../../supabase/pending/README.md)）。

### 本番デプロイの前提条件（レビュー指摘 I8）

決済手段の動的化と在庫復元の機能を本番へ入れる際は、次の順序で確認・実施する。どれか1つでも欠けると、機能の一部または全部が「エラーは出ないが動いていない」状態になる。

1. **Stripe Webhook エンドポイントの購読イベントを確認する。** `checkout.session.expired` / `checkout.session.async_payment_failed` / `checkout.session.async_payment_succeeded` / `payment_intent.payment_failed` の4つが Stripe ダッシュボードのエンドポイント設定で有効になっていること。これが漏れていると webhook 側の在庫復元・入金確認は一切発火せず、日次の掃除ジョブだけが唯一の在庫復元経路になる（サイレントな機能欠落）。
2. **`CRON_SECRET` を本番環境変数に設定し、Vault にも登録する。** `supabase/pending/schedule_expire_pending_orders.sql`（pg_cron 登録マイグレーション。公開時に新しい version で適用する）は Vault に秘密が無くても適用できるが、秘密が揃うまでジョブは毎回失敗する（FREQ-368）。失敗は `cron.job_run_details` に status=failed と理由が残り、認証ヘッダの無い要求は送られない。適用後に次を確認する。

   ```sql
   select status, return_message, start_time
   from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'expire-pending-orders')
   order by start_time desc limit 5;
   ```

3. **バリアント在庫の6本は 2026-09-19 に本番へ適用済み（`20260919065336`〜`20260919065518`。FREQ-380）。** `finalize_order_from_checkout_draft` を再定義せず、`REVOKE` も `item_variants` に閉じているため本機能と衝突しない。ただし `items.stock_quantity`（本機能が使う在庫）と `item_variants.stock_quantity`（バリアント側の在庫台帳）は別々に存在し、互いに整合を取る仕組みはない。アプリをバリアント在庫へ切り替えるときに在庫を入れ直す。`order_items.item_id` は同じ適用で bigint になった（`items.id` と同じ型）。
4. **マイグレーションをアプリのデプロイより先に適用する。** `release_stock_for_unpaid_order` RPC が存在しない状態でアプリをデプロイすると、webhook の該当ハンドラは例外を投げて 500 を返す（Stripe は再送するため在庫はサイレントには失われないが、再送枠を消費する）。逆に、アプリを先にデプロイしてマイグレーションを後回しにする理由はないため、常に「マイグレーション適用 → アプリデプロイ」の順を守る。

### 在庫は色 × サイズだけ（FREQ-401）

`items.stock_quantity`（商品単位の在庫数）を廃止し、在庫の正を `item_variants` と在庫台帳（`stock_movements`）に一本化した。2系統が併存していると、どちらを見ているかで答えが変わる。

在庫の有無は「買えるか」ではなく「納期」を分ける（FREQ-400）。したがって在庫を理由にカートも注文も止めない。落としたのは「足りなければ断る」判定そのもの。

| 場面             | 以前                            | いま                                 |
| ---------------- | ------------------------------- | ------------------------------------ |
| カートに追加     | 合計が在庫を超えると 409        | 断らない（公開商品かどうかだけ見る） |
| カートの数量変更 | 在庫を超えると 409              | 断らない（同上）                     |
| 注文確定         | 在庫不足で `INSUFFICIENT_STOCK` | 断らない。引き当ては台帳だけ         |
| 未入金の取り消し | 商品行の在庫を戻す              | 台帳へ `cancel` を追記するだけ       |
| バリアント生成   | 旧在庫を台帳へ移す              | 移さない（在庫は台帳でだけ動く）     |

数量の上限はアプリ側（`MAX_CART_ITEM_QUANTITY`）とゲスト用関数の 1..20 で担保する。

**列を落とす前に関数を作り直す。** plpgsql の本体は依存関係として追跡されないため、参照が残っていても `DROP COLUMN` は成功し、実行時に初めて壊れる。同じマイグレーション（トランザクション）の中で、作り直し → 削除の順に並べる。
