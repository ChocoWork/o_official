# 決済手段の動的化と create-session のエラー分類 設計書

- 日付: 2026-09-12
- 対象: `src/app/api/checkout/create-session/route.ts`、`src/app/api/webhook/stripe/route.ts`、`src/app/api/checkout/complete/route.ts`、`src/app/checkout/page.tsx`、`src/lib/orders/order-confirmation-email.ts`、DB 関数1本の追加
- 分類: architectural（顧客が使える決済手段と、未入金注文の在庫の扱いが変わる）
- 前提: [2026-09-11-checkout-single-step-design.md](2026-09-11-checkout-single-step-design.md)（checkout の1画面化）が実装済み

## 1. 目的

1. 決済手段を Stripe の Dynamic payment methods に切り替え、**ダッシュボードで有効化した手段がそのまま表示される**ようにする（現在はコードが `payment_method_types: ['card']` で固定している）
2. 動的化の前提として、**未入金（コンビニ払い等）の注文で在庫が失われる穴を塞ぐ**
3. `create-session` の失敗を種別ごとに分類し、原因を運用で追えるようにする（現在はすべて HTTP 500「Internal server error」）

## 2. 現状と、動的化を阻む事実

調査で確認した事実。カッコ内は根拠。

| # | 事実 |
|---|---|
| 1 | セッションは `paymentMethod` 初期値 `stripe_card` から `payment_method_types: ['card']` で作られる。PaymentElement の `onChange` にある paypay / konbini 分岐は事実上デッドコード（`create-session/route.ts` の `paymentMethodTypes` 導出）|
| 2 | `payment_method_types` を送らない場合に返る手段（テストキーで実測）: 調査開始時は `["card","link"]`、約30分後の再測定では `["card","link","paypay"]`。**調査中にダッシュボード側で PayPay が有効化され、コードを変えずに一覧が変わった**。`konbini` は現時点で動的一覧に載っていない（明示指定なら作成できるのでアカウントとしては利用可）。動的化するとこの一覧がそのまま顧客に出る |
| 3 | `finalize_order_from_checkout_draft` は `_order_status` が `paid` / `pending` のいずれでも**無条件に在庫を減らす**（本番 DB の関数定義を確認）|
| 4 | webhook の `checkout.session.async_payment_failed` / `checkout.session.expired` は注文を `failed` にするだけで**在庫を戻さない**（`webhook/stripe/route.ts`）|
| 5 | `checkout.session.async_payment_succeeded` は `pending` の注文を `paid` に更新する（同上）|
| 6 | 注文確認メールは `complete` から**入金状態に関係なく**送られる（`complete/route.ts`）|
| 7 | 1画面化により、Stripe セッションは空の配送先で作られる。したがって **Stripe 側に `customer_email` が入らない**。コンビニ払いは支払票をメールで送るため、このままでは成立しない |
| 8 | `@stripe/stripe-js@8.9.0` の Custom Checkout は `updateEmail` / `updatePhoneNumber` / `updateShippingAddress` / `canConfirm` を提供する（型定義で確認）|
| 9 | 注文ステータスの表示は `pending → 「お支払い待ち」` が実装済みで、進捗ステップからも除外されている（`src/lib/orders/order-status.ts`）。UI 側の追加対応は不要 |
| 10 | `create-session` の catch は原因を `audit_logs.metadata.error_message` に残している（本番に「must add up to at least ¥50 JPY」の行を確認）。欠けているのは画面への手がかりと、種別に応じたステータスコード |
| 11 | `resolvePaymentMethod` は **クライアント申告 → セッション metadata の `selected_payment_method` → PaymentIntent** の順で支払方法を決める。metadata に入るのは**セッション生成時点のクライアント初期値（`stripe_card`）**なので、動的化して客が別の手段を選ぶと**注文に誤った支払方法が記録される**（`complete/route.ts:705-725`）|
| 12 | リダイレクト復帰（`/checkout?session_id=...`）は `{ checkoutSessionId }` だけを POST し、注文の配送先はサーバが draft の `shipping_snapshot` から組み立てる。したがって **PayPay のようなリダイレクト型でページが再読み込みされても配送先は失われない**（`page.tsx` の finalizeOrder と `complete/route.ts:138-145`）|
| 13 | `orders.status` の enum は `pending, paid, failed, cancelled, shipped`。`order_items` は `item_id` と `quantity` を持つ（本番DBで確認）。在庫復元に必要な情報は揃っている |
| 14 | 本番の `finalize_order_from_checkout_draft` は**バリアント在庫にも `stock_movements` にも触れていない**（`prosrc` を検索して0件）。リポジトリにはバリアント在庫のマイグレーションがあるが、本番の `order_items` にバリアント列がないため**未適用**。在庫復元は現行どおり `items.stock_quantity` だけを対象にする |

**3 + 4 + 6 の合成が本設計の中心的リスク**: コンビニ払いを有効化すると、未入金のまま期限切れになった注文ごとに在庫が永久に減り、客には「ご注文ありがとうございました」が届く。カード専用の現在は `pending` 注文が発生しないため顕在化していない。

## 3. スコープ

動的化（A）だけを入れると、ダッシュボードのトグル操作だけで上記リスクが顕在化する。よって B・C を同一プロジェクトに含める。

- **A.** 決済手段の動的化
- **B.** 時間差決済（未入金注文）の在庫引当と復元、および掃除ジョブ
- **C.** 未入金時のメール分岐
- **D.** `create-session` のエラー分類

## 4. A. 決済手段の動的化

### A-1. `payment_method_types` を送らない

`create-session` から `paymentMethodTypes` の導出と `sessionParams.payment_method_types` への代入を削除する（custom / hosted 両方）。Stripe はダッシュボードの設定に従って手段を決める。

`paymentMethod`（`stripe_card` / `stripe_paypay` / `stripe_konbini`）はリクエストボディと `checkout_drafts.payment_method` の記録用として残す。これは「客が最終的に選んだ手段」を注文に残すためのもので、セッション生成の入力ではなくなる。

### A-2. 再利用の照合キーから支払方法を外す

`isSameCheckoutContent` の `payment_method` 比較を削除する。セッションが支払方法に依存しなくなるため、客が PaymentElement で手段を切り替えても既存セッションを再利用してよい。金額・通貨・明細の一致判定は維持する。

なお、セッションに載る手段は**生成時点のダッシュボード設定で固定**される。手段を新たに有効化しても、それ以前に作られて再利用中のセッションには反映されない。Stripe の Checkout Session は既定24時間で失効するので、遅くとも翌日には解消する。許容する。

### A-3. 時間差決済の支払期限を明示する

> 2026-09-27 更新: 日数を3日から7日に変えた（/legal の表記と FREQ-106 に合わせる。R-57）。日数は `src/lib/constants/konbini.ts` の定数1か所に置く。根拠は[グループ A 設計書](2026-09-26-order-payment-reconciliation-design.md)の 5-7。

`sessionParams.payment_method_options = { konbini: { expires_after_days: 3 } }` を指定する。B の引当モデルでは、この期限がそのまま「在庫を押さえたまま入金を待つ上限」になる。コンビニが無効なアカウントでもこの指定はエラーにならない（テストキーで実測。動的化と併用してセッション作成が成功することを確認済み）。

方式ごとに期限の指定方法は異なる（boleto は `expires_after_days`、oxxo は `expires_after_days`、銀行振込＝`customer_balance` は**期限の概念がなく、入金がなければ PaymentIntent が開いたまま残る**）。B-5 の掃除ジョブは古い注文を再照合するが、期限を指定できない方式をアプリ独自の上限で強制終了しない。

### A-4. Customer の自動生成

銀行振込（`customer_balance`）は Stripe 側に Customer を要求する。`mode: 'payment'` の `customer_creation` は既定が `if_required` で、必要な方式が選ばれたときだけ Customer が作られる。**既定のまま明示しない**（`always` にするとゲスト全員分の Customer が増え、個人情報の保管先が増えるだけで利点がない）。

### A-5. 確定前に Stripe セッションへメールを渡す

`ConfirmPaymentButton` の `handleConfirmPayment` で、配送先同期のあと `checkout.confirm()` の前に `await checkout.updateEmail(shippingForm.email)` を呼ぶ。失敗した場合は確定せず、`checkoutError` に「メールアドレスの反映に失敗しました」を出す。

理由: コンビニの支払票送付先であり、カード決済でも Stripe 側の領収メールと Radar のシグナルになる。現在は Stripe セッションにメールが一切入っていない。

### A-6. 注文に記録する支払方法をサーバ側で確定させる

現在の `resolvePaymentMethod`（`complete/route.ts:705-725`）は **クライアントの申告 → セッション metadata の `selected_payment_method` → PaymentIntent** の順で決める。metadata に入るのはセッション生成時点のクライアント初期値（`stripe_card`）なので、動的化して客が PayPay やコンビニを選ぶと**注文に「カード」と記録される**。リダイレクト型（PayPay）はページが再読み込みされてクライアント申告すら送られないため、必ず誤る。

優先順位を逆にする。

1. PaymentIntent の `latest_charge.payment_method_details.type`（実際に使われた手段。最も確か）
2. PaymentIntent の `payment_method_types[0]`（charge 前＝コンビニ等の未入金時）
3. セッション metadata の `selected_payment_method`（デバッグ用の記録として残すが最後の砦）

クライアントから送られる `paymentMethod` は**採用しない**（リクエストボディのフィールド自体は後方互換のため残すが、値は無視する）。決済手段は金額と同じく、クライアント申告を信じてはいけない種類の情報にあたる。

Stripe が返す文字列（`card` / `konbini` / `paypay` / その他）から内部 enum への写像は既存の `mapStripePaymentMethodType` を使い、**未知の手段が来たらエラーにせず `stripe_card` へ丸めず、記録専用の値として通す**。`STRIPE_CHECKOUT_PAYMENT_METHODS` に収まらない手段（銀行振込 = `customer_balance` など）が有効化されたとき、注文作成そのものが失敗するのを避けるため、`checkout_drafts.payment_method` / 注文表示は文字列をそのまま保持できるようにする。

## 5. B. 時間差決済（未入金注文）の在庫引当と復元

本章の仕組みは**方式名に依存しない**。判定はすべて「Stripe の `payment_status` が `paid` か」と「注文が `pending` か」で行うため、コンビニ払い・銀行振込・boleto・OXXO など、後から入金が確定する方式がダッシュボードで有効化されても同じ経路で処理される。

### B-1. モデルの選択

引当モデルを採る。注文作成時に在庫を減らす現在の挙動は変えず、入金されなかったときに戻す。

採らなかった案: 「入金確定まで減らさない」。コンビニ支払い中に他の客が買い切った場合、入金後に在庫がなく返金フローが必要になる。期限3日で押さえるほうが運用が単純で、客にとっても「支払えば必ず買える」ほうが納得的。

### B-2. 在庫復元の DB 関数

`release_stock_for_failed_order(_payment_intent_id text)` を追加する。要件:

- `orders` を `payment_intent_id` で引き、`status = 'pending'` の行だけを対象にする
- `status` を `failed` に更新し、更新できた場合のみ `order_items` の数量を `items.stock_quantity` に戻す（`stock_quantity IS NOT NULL` の行のみ）
- すでに `failed` / `paid` / その他の状態なら何もしない（**冪等**。Stripe は同じイベントを再送するため必須）
- 1トランザクションで完結させ、対象行は `FOR UPDATE` で確保する（`finalize_order_from_checkout_draft` と同じ作法）
- 戻り値は `(released boolean, order_id uuid)`。呼び出し側が監査ログに残せるようにする
- `REVOKE ALL FROM PUBLIC` し、`service_role` にのみ `EXECUTE` を与える（既存関数と同じ権限方針）
- 復元元は `order_items`（`item_id` / `quantity` を保持することを本番DBで確認済み）。対象商品が削除済みなら黙って飛ばす
- 本番の `finalize_order_from_checkout_draft` はバリアント在庫にも `stock_movements` にも触れていないため、復元側も `items.stock_quantity` のみを対象にして**減算側と対称**にする。リポジトリにあるバリアント在庫のマイグレーションが本番へ適用される際は、**減算・復元の両方を同時に更新する**（片側だけ直すと在庫が壊れる）。この注意書きを関数のコメントに残す

### B-3. webhook からの呼び出し

`handleCheckoutSessionAsyncPaymentFailed` と `handleCheckoutSessionExpired` の「`orders` を直接 `failed` に更新する」処理を、この関数の呼び出しに置き換える。監査ログには `released` と `order_id` を残す。

### B-4. 取りこぼしへの備え

Stripe は支払期限切れで `checkout.session.expired` / `async_payment_failed` を送るが、webhook が落ちていた期間のイベントを取りこぼす可能性がある。B-5 の掃除ジョブは古い `pending` 注文を再照合する。期限のない方式はアプリ独自の上限で強制終了せず、Checkout Session の終了状態を Stripe で確認できるまで注文と在庫を維持する。

### B-5. 未入金注文の掃除ジョブ

`GET /api/cron/expire-pending-orders` を追加する。既存の cron ルート（`src/app/api/cron/stripe-reconcile` 等）と同じ作法にそろえる。

- 認証: `Authorization: Bearer ${CRON_SECRET}` を検証し、不一致は 401（既存ルートと同一）。比較は長さを揃えたうえで `crypto.timingSafeEqual` を使う（既存ルートは単純比較だが、新規ルートでは定数時間比較を採る。差分は数行で、後から既存ルートへ広げられる）
- 対象: `orders.status = 'pending'` かつ `created_at < now() - interval '<保持日数>'`。保持日数は環境変数 `PENDING_ORDER_EXPIRY_DAYS`（既定 5。コンビニの支払期限3日＋余裕2日）
- 各注文について、PaymentIntent と Checkout Session の状態を検証して分岐する。Checkout Session が所有する PaymentIntent は直接 cancel しない:
  - PaymentIntent `succeeded` → 注文を `paid` に更新して次へ（入金済みなのに webhook を取りこぼした場合の救済）
  - PaymentIntent `processing` → **何もしない**。次回実行で再評価する
  - PaymentIntent `canceled` → `release_stock_for_unpaid_order()` を呼び、`failed` へ遷移させ在庫を戻す
  - Checkout Session `open` かつ `unpaid` → Session を expire し、応答または再取得で `expired` かつ `unpaid` を確認できた場合だけ `release_stock_for_unpaid_order()` を呼ぶ
  - Checkout Session `expired` かつ `unpaid` → `release_stock_for_unpaid_order()` を呼ぶ
  - Checkout Session `complete`、支払い済み、関連付け不一致、または再検証不能 → 注文と在庫を維持し、監査対象にする
- 1件の失敗で全体を止めない。注文ごとに try/catch し、失敗は件数と理由を集計して返す
- 1回は最大50件とし、候補件数を50件単位に分けて UTC 日ごとに `created_at, id` の安定順序で範囲を巡回する。長期保留注文が先頭を占有しても後続を飢餓させない
- 監査ログに内訳（`cancelled` / `recovered_as_paid` / `skipped_processing` / `skipped_uncancelable` / `failed`）を残す。`skipped_uncancelable` が1件以上なら成功扱いにしない
- 実行間隔は日次。スケジューラは **pg_cron + pg_net** で登録する（Supabase のドキュメントに載っている方式。`CRON_SECRET` は Supabase Vault に置き、`net.http_post` の `Authorization` ヘッダに復号して渡す）。リポジトリに `vercel.json` がなく、既存 cron ルートの起動方法がコードから辿れないため、**自前で検証できる方式を採る**。運用者が Vercel Cron に一本化したい場合は、`vercel.json` に `crons` を足して pg_cron 側を `cron.unschedule` すれば置き換えられる

```sql
-- 参考: Supabase ドキュメント（Scheduling Edge Functions）の書式に合わせた登録例
select vault.create_secret('<CRON_SECRET と同じ値>', 'cron_secret');

select cron.schedule(
  'expire-pending-orders',
  '0 4 * * *',
  $$
    select net.http_post(
      url := '<本番URL>/api/cron/expire-pending-orders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      timeout_milliseconds := 30000
    );
  $$
);
```

`net.http_post` は POST しか送れないため、ルートは `GET` ではなく **`POST` で実装する**（既存 cron ルートは GET だが、ここは起動方式に合わせる。認証は同じ `Authorization: Bearer ${CRON_SECRET}`）。`/api/cron` 配下は proxy の Origin 検査から除外済み（FREQ-327-REQ-02）なので、Origin なしの POST でも 403 にならない。

この1本で、期限のない方式も含めて「在庫を押さえたまま放置される上限」が保証される。

## 6. C. 未入金時のメール

`complete` は `session.payment_status === 'paid'` かどうかを既に判定している。この値をメール送信に渡し、文面を分岐する。

- **入金済み（カード等）**: 現行どおり「ご注文ありがとうございました」
- **未入金（コンビニ・銀行振込など時間差決済）**: 件名と本文を「お支払い待ち」に変更する。方式名を本文に埋め込まず、「お支払い手続きの案内は決済画面および Stripe からのメールをご確認ください」「ご入金の確認後にあらためて確認メールをお送りします」と方式非依存の文面にする。注文番号・明細・配送先は現行と同じものを載せる
- **入金確定時**: `handleCheckoutSessionAsyncPaymentSucceeded` から正式な確認メールを送る。同ハンドラは現在ステータスを更新するだけなので、更新が実際に行われた場合（`pending → paid` の行が1件更新された場合）に限り、`orders` と `order_items` を読み直して明細・配送先・宛先メールを組み立てる。更新行数が0なら再送イベントなので何もしない（冪等）

`sendOrderConfirmationEmail` に `paymentState: 'paid' | 'awaiting_payment'` を追加し、件名と冒頭文だけを分岐する。テンプレートを2つに分けない（明細・配送先の組み立ては共通のまま）。

## 7. D. create-session のエラー分類

### D-1. 分類とステータスコード

`src/features/checkout/services/checkout-error.service.ts` を新設し、Stripe の例外を分類する関数を置く。

| Stripe 例外 | HTTP | クライアント向け文言（例） | 再試行ボタン |
|---|---|---|---|
| `StripeInvalidRequestError`（`amount_too_small` など）| 422 | ご注文内容では決済を開始できません。カート内容をご確認ください | 出さない |
| `StripeRateLimitError` | 429 | 混み合っています。しばらく待ってから再度お試しください | 出す |
| `StripeConnectionError` / `StripeAPIError` | 503 | 決済サービスに接続できませんでした。時間をおいて再度お試しください | 出す |
| `StripeAuthenticationError` / `StripePermissionError` | 500 | 決済を開始できませんでした（運用者向けに別途通知）| 出さない |
| それ以外の例外 | 500 | 決済を開始できませんでした | 出す |

`StripeAuthenticationError` は設定ミスなので、audit の `action` を `checkout.session.create.misconfigured` として分け、アラート対象にできるようにする。

`StripeInvalidRequestError` は「客のカート内容が Stripe の制約に合わない」場合と「こちらのパラメータの組み立てが誤っている」場合の両方で出る。客には 422 と定型文を返すが、**audit の outcome は `error` のまま**にして運用側から気づけるようにする（客には落ち度がないケースを静かに握り潰さない）。

### D-2. 監査ログと相関ID

- 相関ID を `crypto.randomUUID()` で発行し、レスポンスの `correlationId` と audit の `metadata.correlation_id` の両方に入れる。`logAudit` は挿入行の id を返さないため自前生成が必要
- metadata に `stripe_type` / `stripe_code` / `stripe_status` / `stripe_request_id` を追加する。Stripe サポートへの問い合わせには `request_id` が要る
- キー名は `maskAuditEvent` の伏字パターン（`/number/`・`/card/`・`/token/`・`/secret/` 等）に当たらないものを選ぶ

### D-3. クライアント表示

- レスポンス形: `{ error: 'checkout_session_failed', message: string, correlationId: string, retryable: boolean }`
- **Stripe の生メッセージは返さない**（OWASP Error Handling / ASVS: 内部詳細はサーバ側に留め、クライアントには参照IDのみ渡す）
- 支払方法セクションに `message` を表示し、その下に小さく `エラーID: <correlationId の先頭8文字>` を出す
- 再試行ボタンの描画条件は、現在の `!customCheckoutClientSecret`（セッション未取得時のみ）に `retryable === true` を加えた論理積にする。`retryable` は生成失敗時に state で保持する

## 7.5. 新しい決済手段をダッシュボードで有効化するときの手順

動的化により、決済手段の追加は運用操作だけで反映される。時間差決済を有効化する場合は次を確認する。この手順書を `docs/4_DetailDesign/13_checkout.md` に追記する。

1. その方式の入金確定が `checkout.session.async_payment_succeeded` で通知されるか（Stripe のドキュメントで「delayed notification」に分類されるか）を確認する
2. 支払期限を指定できる方式なら `payment_method_options` に設定する（A-3）。指定できない方式は B-5 の `PENDING_ORDER_EXPIRY_DAYS` が上限になる
3. その方式が Customer を要求するか確認する（`customer_creation: if_required` の既定で足りるか）
4. テストモードで「確定 → `pending` 注文と在庫減 → `async_payment_failed` で在庫復元 → `async_payment_succeeded` で `paid` と確認メール」を一巡させる
5. 返金の可否と手数料の扱いを確認する（返金非対応の方式がある）

## 8. セキュリティ上の判断

| 観点 | 判断 |
|---|---|
| 情報漏洩（OWASP API8 / ASVS V7）| Stripe の例外メッセージをクライアントへ返さない。相関IDのみ渡し、詳細は audit_logs に残す |
| 決済手段の追加による露出 | 動的化で手段が増えても、金額はセッション固定、`complete` は Stripe の実請求額と draft 合計の一致を検証する。既存のガードは有効 |
| ガバナンス | 「どの決済手段まで自社が settle できるか」がダッシュボードのトグルに移る。本設計は B を同梱することでコンビニ払いを安全側に倒すが、**将来 delayed notification 系の手段（boleto / oxxo 等）を有効化する場合は、同じ在庫引当の検証が必要**である旨を運用手順に残す |
| 冪等性 | 在庫復元関数は `pending` からの遷移でのみ動作する。Stripe のイベント再送で二重に在庫が戻らない |
| 権限 | 新規 DB 関数は `service_role` のみ実行可。`anon` / `authenticated` には付与しない（Supabase advisor の `anon_security_definer_function_executable` 指摘を増やさない）|

## 9. スコープ外

- 決済手段のダッシュボード有効化そのもの（運用者の操作）
- `update-shipping` / `complete` へのエラー分類の展開（共有ユーティリティの置き場所だけ先に決める）
- `checkout.updateShippingAddress()` による配送先の Stripe 側同期（今回はメールのみ）

## 10. テスト

### 単体（Jest）

- `checkout-error.service`: Stripe 例外の各種別 → ステータスコード・`retryable`・文言のマッピング
- `create-session`: `payment_method_types` を送らないこと、`payment_method_options.konbini.expires_after_days` を送ること、再利用判定が支払方法の違いで落ちないこと
- webhook: `async_payment_failed` / `expired` が在庫復元関数を呼ぶこと、`pending` 以外では呼んでも何も起きないこと、`async_payment_succeeded` が更新行ありのときだけ確認メールを送ること
- 掃除ジョブ: `CRON_SECRET` 不一致で 401、`open` / `unpaid` の Checkout Session を expire してから在庫を戻し PaymentIntent を直接 cancel しないこと、`complete` / `unpaid` は注文と在庫を維持すること、PaymentIntent が `succeeded` の注文は `paid` に寄せて在庫を戻さないこと、`processing` の注文は手を付けずに次回へ送ること、1件が例外を投げても残りを処理して集計を返すこと、対象なしで 200 を返すこと
- メール: `paymentState` による件名・冒頭文の分岐
- `resolvePaymentMethod`: PaymentIntent の `latest_charge.payment_method_details.type` を最優先すること、charge 前は `payment_method_types[0]` を使うこと、**クライアント申告の `paymentMethod` を無視すること**、未知の手段名でも例外を投げずに記録できること

### DB

- `release_stock_for_failed_order`: `pending` の注文で在庫が戻る / 二重呼び出しで二重に戻らない / `paid` の注文では何もしない

### E2E（mobile 390 / tablet 768 / desktop 1280）

- `FR-CHECKOUT-022`: 支払方法セクションに Stripe が返した手段が描画される（カード有効時に PaymentElement が出ること。手段の内訳はダッシュボード設定に依存するため、特定手段名のアサートはしない）
- `FR-CHECKOUT-023`: `create-session` が 422 を返すとき再試行ボタンが出ない／503 のときは出る（`page.route` でスタブ）、`エラーID` が表示される

### 手動（Stripe テストキー）

ダッシュボードでコンビニ払いを一時的に有効化して確認する。

1. コンビニを選んで確定 → 支払票が発行され、注文が `pending`、在庫が減る
2. Stripe CLI で `checkout.session.async_payment_failed` を発火 → 注文が `failed`、**在庫が戻る**
3. 入金成功（`async_payment_succeeded`）→ 注文が `paid`、確認メールが届く
4. 確認後、ダッシュボードの設定を元に戻すか、そのまま運用するかを判断する

## 11. 仕様追記

`docs/2_Specs/spec.md` に2行追加する。

- `FREQ-356`: 決済手段をダッシュボード設定に追従させ、時間差決済（コンビニ・銀行振込等）が有効化されても未入金注文で在庫が失われないこと（A + B + C）
- `FREQ-357`: `create-session` の失敗を種別ごとに区別し、再試行可否と参照IDを画面に出すこと（D）
