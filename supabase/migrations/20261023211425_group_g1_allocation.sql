-- グループ G-1: 試験データの清掃と、品物ごとの状態・FIFO の割り当て（設計書 2026-10-23 グループ G の 11 章）。
--
-- 1本の取引で「清掃 → 本体 → 最後の確かめ」を行い、どこかで失敗したら全部を戻す。
-- 本番は試験データだけなので、旧注文・在庫・仕上がりを移さずに消し、在庫を 0 に戻す。
-- 清掃だけを先に当てない（清掃と本体の両方を同じ取引で戻せるようにするため）。
--
-- 清掃の対象は 31 表だけ（全件削除 25 表・注文に結び付く行の削除 2 表・問い合わせの注文の関連を外す 1 表・
-- 在庫を 0 に戻す 1 表・入金（payout）の集計を直す 1 表・未完了の Stripe の知らせを dead にする 1 表）。
-- 残す物: 商品・色・サイズ・利用者・権限・G-0 の記録・問い合わせの本文と子のメッセージ・注文に結び付かない Stripe の写し・
-- payout の行・Resend の受付済みの番号・Stripe の知らせの全行（対象だけ状態を変える）・
-- private.refund_ledger_state・private.order_email_send_pause・private.delivery_tracking_provider_gate・
-- audit_logs・legal_archive_runs・Storage の全オブジェクト。
--
-- 消せない記録を守るトリガー（法定保存・追記専用）は、この取引の中だけ USER トリガーを止めて戻す。
-- 内部の外部キーのトリガー・RLS・session_replication_role は変えない。
BEGIN;
-- G1_CLEANUP_BEGIN
SET LOCAL lock_timeout = '15s';
SELECT pg_catalog.pg_advisory_xact_lock(190521,1);
LOCK TABLE
  private.fulfillment_tracking_registrations,
  private.order_email_outbox,
  private.order_status_links,
  public.checkout_drafts,
  public.contact_inquiries,
  public.item_variants,
  public.order_cancel_request_lines,
  public.order_cancel_requests,
  public.order_fulfillment_attention,
  public.order_fulfillment_events,
  public.order_fulfillment_lines,
  public.order_fulfillment_tracking_changes,
  public.order_fulfillments,
  public.order_item_completions,
  public.order_items,
  public.order_refund_lines,
  public.order_refunds,
  public.order_return_lines,
  public.order_return_photo_uploads,
  public.order_return_photos,
  public.order_return_receipt_lines,
  public.order_return_receipts,
  public.order_returns,
  public.order_revisions,
  public.orders,
  public.payment_exceptions,
  public.stock_movements,
  public.stripe_balance_transactions,
  public.stripe_payouts,
  public.stripe_refunds,
  public.stripe_webhook_events
IN ACCESS EXCLUSIVE MODE;

-- 前提の確かめ: 削除する 27 表の USER トリガーが全部ふつうに有効（O）で、循環する外部キーが決まった形であること。
-- 違えば何も変えずに止める（止めたままのトリガーや形の違う外部キーを、清掃の後に「戻した」と誤らないため）。
DO $g1_precondition$
DECLARE
  v_delete_tables regclass[] := ARRAY[
    'private.order_email_outbox'::regclass,
    'private.order_status_links'::regclass,
    'private.fulfillment_tracking_registrations'::regclass,
    'public.order_fulfillment_attention'::regclass,
    'public.order_fulfillment_events'::regclass,
    'public.order_fulfillment_tracking_changes'::regclass,
    'public.order_return_photos'::regclass,
    'public.order_return_photo_uploads'::regclass,
    'public.order_cancel_request_lines'::regclass,
    'public.order_cancel_requests'::regclass,
    'public.order_return_receipt_lines'::regclass,
    'public.order_return_receipts'::regclass,
    'public.order_refund_lines'::regclass,
    'public.stock_movements'::regclass,
    'public.order_refunds'::regclass,
    'public.order_return_lines'::regclass,
    'public.order_fulfillment_lines'::regclass,
    'public.order_item_completions'::regclass,
    'public.order_items'::regclass,
    'public.order_fulfillments'::regclass,
    'public.order_returns'::regclass,
    'public.order_revisions'::regclass,
    'public.payment_exceptions'::regclass,
    'public.checkout_drafts'::regclass,
    'public.stripe_refunds'::regclass,
    'public.stripe_balance_transactions'::regclass,
    'public.orders'::regclass
  ];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = ANY (v_delete_tables)
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'O'
  ) THEN
    RAISE EXCEPTION 'GROUP_G_CLEANUP_PRECONDITION' USING ERRCODE = '55000', DETAIL = 'user_trigger_not_enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'protect_legal_order_delete' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.order_items'::regclass AND t.tgname = 'protect_legal_order_item_delete' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'GROUP_G_CLEANUP_PRECONDITION' USING ERRCODE = '55000', DETAIL = 'legal_trigger_missing';
  END IF;

  IF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.order_items'::regclass
      AND c.conname = 'order_items_exchange_return_line_id_fkey'
      AND c.contype = 'f'
      AND c.confrelid = 'public.order_return_lines'::regclass
      AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                            WHERE a.attrelid = 'public.order_items'::regclass AND a.attname = 'exchange_return_line_id')]
      AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                             WHERE a.attrelid = 'public.order_return_lines'::regclass AND a.attname = 'id')]
      AND c.confdeltype = 'r'
      AND c.confupdtype = 'a'
      AND NOT c.condeferrable
      AND c.convalidated
  ) <> 1 THEN
    RAISE EXCEPTION 'GROUP_G_CLEANUP_PRECONDITION' USING ERRCODE = '55000', DETAIL = 'exchange_fkey_shape';
  END IF;
END
$g1_precondition$;

-- 清掃の始めの全注文 O と、O に結び付く入金の番号を固定する（ID は外へ出さない）
CREATE TEMPORARY TABLE pg_temp.group_g_cleanup_order_ids (
  id uuid PRIMARY KEY,
  checkout_session_id text,
  payment_intent_id text
) ON COMMIT DROP;

INSERT INTO pg_temp.group_g_cleanup_order_ids (id, checkout_session_id, payment_intent_id)
SELECT o.id, o.checkout_session_id, o.payment_intent_id
FROM public.orders o;

CREATE TEMPORARY TABLE pg_temp.group_g_cleanup_payout_ids (
  id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO pg_temp.group_g_cleanup_payout_ids (id)
SELECT DISTINCT b.payout_id
FROM public.stripe_balance_transactions b
WHERE b.order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids)
  AND b.payout_id IS NOT NULL;

-- Stripe の知らせの総行数（最後の確かめで、行を消していないことを見る）
SELECT pg_catalog.set_config(
  'group_g1.webhook_total',
  (SELECT pg_catalog.count(*) FROM public.stripe_webhook_events)::text,
  true
);

-- 未完了の知らせのうち O に結び付く物 W を、revision を消す前に固定する
CREATE TEMPORARY TABLE pg_temp.group_g_cleanup_webhook_ids (
  id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO pg_temp.group_g_cleanup_webhook_ids (id)
SELECT e.id
FROM public.stripe_webhook_events e
WHERE e.processing_status IN ('queued','processing','failed')
  AND e.next_attempt_at IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM pg_temp.group_g_cleanup_order_ids o
      WHERE e.raw_payload #>> '{data,object,metadata,order_id}' = o.id::text
         OR e.raw_payload #>> '{data,object,order_id}' = o.id::text
         OR (o.checkout_session_id IS NOT NULL
             AND e.raw_payload #>> '{data,object,id}' = o.checkout_session_id)
         OR (o.payment_intent_id IS NOT NULL AND (
              e.raw_payload #>> '{data,object,id}' = o.payment_intent_id
           OR e.raw_payload #>> '{data,object,payment_intent}' = o.payment_intent_id
           OR e.raw_payload #>> '{data,object,payment_intent,id}' = o.payment_intent_id
         ))
    )
    OR EXISTS (
      SELECT 1 FROM public.order_revisions r
      JOIN pg_temp.group_g_cleanup_order_ids o ON o.id = r.order_id
      WHERE r.source_event_id = e.id
    )
  );

-- 最初のデータの変更: W をこれ以上処理しない dead にし、店への知らせも済みにする（試験データの知らせのメールを送らない）。
-- 受け取った時刻・次の試行・試行の回数・中身・番号・種類は残し、行は消さない
UPDATE public.stripe_webhook_events
SET processing_status = 'dead',
    dead_at = pg_catalog.clock_timestamp(),
    dead_notified_at = pg_catalog.clock_timestamp(),
    completed_at = NULL,
    claim_token = NULL,
    lease_expires_at = NULL,
    last_error = 'group_g1_test_data_cleanup'
WHERE id IN (SELECT id FROM pg_temp.group_g_cleanup_webhook_ids);

-- 削除する 27 表の USER トリガー（法定保存・追記専用の守りを含む）を、この取引の中だけ止める
ALTER TABLE private.order_email_outbox DISABLE TRIGGER USER;
ALTER TABLE private.order_status_links DISABLE TRIGGER USER;
ALTER TABLE private.fulfillment_tracking_registrations DISABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_attention DISABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_events DISABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_tracking_changes DISABLE TRIGGER USER;
ALTER TABLE public.order_return_photos DISABLE TRIGGER USER;
ALTER TABLE public.order_return_photo_uploads DISABLE TRIGGER USER;
ALTER TABLE public.order_cancel_request_lines DISABLE TRIGGER USER;
ALTER TABLE public.order_cancel_requests DISABLE TRIGGER USER;
ALTER TABLE public.order_return_receipt_lines DISABLE TRIGGER USER;
ALTER TABLE public.order_return_receipts DISABLE TRIGGER USER;
ALTER TABLE public.order_refund_lines DISABLE TRIGGER USER;
ALTER TABLE public.stock_movements DISABLE TRIGGER USER;
ALTER TABLE public.order_refunds DISABLE TRIGGER USER;
ALTER TABLE public.order_return_lines DISABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_lines DISABLE TRIGGER USER;
ALTER TABLE public.order_item_completions DISABLE TRIGGER USER;
ALTER TABLE public.order_items DISABLE TRIGGER USER;
ALTER TABLE public.order_fulfillments DISABLE TRIGGER USER;
ALTER TABLE public.order_returns DISABLE TRIGGER USER;
ALTER TABLE public.order_revisions DISABLE TRIGGER USER;
ALTER TABLE public.payment_exceptions DISABLE TRIGGER USER;
ALTER TABLE public.checkout_drafts DISABLE TRIGGER USER;
ALTER TABLE public.stripe_refunds DISABLE TRIGGER USER;
ALTER TABLE public.stripe_balance_transactions DISABLE TRIGGER USER;
ALTER TABLE public.orders DISABLE TRIGGER USER;

-- 交換の品の行 → 返品の行 → 発送の行 → 注文の行 と循環する外部キーだけを外す（削除の後、同じ名前・同じ形で戻す）
ALTER TABLE public.order_items DROP CONSTRAINT order_items_exchange_return_line_id_fkey;

-- 参照する側から消す（外部キーはすべて RESTRICT のまま。順番は FK 試験で確かめた）
DELETE FROM private.order_email_outbox WHERE TRUE;
DELETE FROM private.order_status_links WHERE TRUE;
DELETE FROM private.fulfillment_tracking_registrations WHERE TRUE;
DELETE FROM public.order_fulfillment_attention WHERE TRUE;
DELETE FROM public.order_fulfillment_events WHERE TRUE;
DELETE FROM public.order_fulfillment_tracking_changes WHERE TRUE;
DELETE FROM public.order_return_photos WHERE TRUE;
DELETE FROM public.order_return_photo_uploads WHERE TRUE;
DELETE FROM public.order_cancel_request_lines WHERE TRUE;
DELETE FROM public.order_cancel_requests WHERE TRUE;
DELETE FROM public.order_return_receipt_lines WHERE TRUE;
-- 台帳は返金・返品を参照するので、返金・返品・受け取りより先に消す
DELETE FROM public.stock_movements WHERE TRUE;
DELETE FROM public.order_return_receipts WHERE TRUE;
DELETE FROM public.order_refund_lines WHERE TRUE;
DELETE FROM public.order_refunds WHERE TRUE;
DELETE FROM public.order_return_lines WHERE TRUE;
DELETE FROM public.order_fulfillment_lines WHERE TRUE;
DELETE FROM public.order_item_completions WHERE TRUE;
DELETE FROM public.order_items WHERE TRUE;
DELETE FROM public.order_fulfillments WHERE TRUE;
DELETE FROM public.order_returns WHERE TRUE;
DELETE FROM public.order_revisions WHERE TRUE;
DELETE FROM public.payment_exceptions WHERE TRUE;

-- Stripe の写し: O に結び付く返金を先に消して balance への参照を解き、次に O に結び付く balance を消す
DELETE FROM public.stripe_refunds
WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids);
DELETE FROM public.stripe_balance_transactions
WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids);

-- 影響する payout だけ、残った balance の net の合計へ直し、照合を pending に戻す（再照合は会計の同期に任せる）
UPDATE public.stripe_payouts
SET reconciled_net = COALESCE((
      SELECT pg_catalog.sum(b.net)
      FROM public.stripe_balance_transactions b
      WHERE b.payout_id = public.stripe_payouts.id
    ), 0),
    reconciliation_status = 'pending'
WHERE id IN (SELECT id FROM pg_temp.group_g_cleanup_payout_ids);

-- 問い合わせは本文と子のメッセージを残し、注文との関連だけを外す
UPDATE public.contact_inquiries
SET order_id = NULL
WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids);

DELETE FROM public.orders WHERE TRUE;
DELETE FROM public.checkout_drafts WHERE TRUE;

-- 在庫は止めている商品も含めて全部 0 に戻す（台帳を消したので、台帳と在庫を 0 でそろえる）
UPDATE public.item_variants
SET stock_quantity = 0,
    updated_at = pg_catalog.now()
WHERE stock_quantity <> 0;

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_exchange_return_line_id_fkey
  FOREIGN KEY (exchange_return_line_id) REFERENCES public.order_return_lines (id) ON DELETE RESTRICT NOT DEFERRABLE;

ALTER TABLE private.order_email_outbox ENABLE TRIGGER USER;
ALTER TABLE private.order_status_links ENABLE TRIGGER USER;
ALTER TABLE private.fulfillment_tracking_registrations ENABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_attention ENABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_events ENABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_tracking_changes ENABLE TRIGGER USER;
ALTER TABLE public.order_return_photos ENABLE TRIGGER USER;
ALTER TABLE public.order_return_photo_uploads ENABLE TRIGGER USER;
ALTER TABLE public.order_cancel_request_lines ENABLE TRIGGER USER;
ALTER TABLE public.order_cancel_requests ENABLE TRIGGER USER;
ALTER TABLE public.order_return_receipt_lines ENABLE TRIGGER USER;
ALTER TABLE public.order_return_receipts ENABLE TRIGGER USER;
ALTER TABLE public.order_refund_lines ENABLE TRIGGER USER;
ALTER TABLE public.stock_movements ENABLE TRIGGER USER;
ALTER TABLE public.order_refunds ENABLE TRIGGER USER;
ALTER TABLE public.order_return_lines ENABLE TRIGGER USER;
ALTER TABLE public.order_fulfillment_lines ENABLE TRIGGER USER;
ALTER TABLE public.order_item_completions ENABLE TRIGGER USER;
ALTER TABLE public.order_items ENABLE TRIGGER USER;
ALTER TABLE public.order_fulfillments ENABLE TRIGGER USER;
ALTER TABLE public.order_returns ENABLE TRIGGER USER;
ALTER TABLE public.order_revisions ENABLE TRIGGER USER;
ALTER TABLE public.payment_exceptions ENABLE TRIGGER USER;
ALTER TABLE public.checkout_drafts ENABLE TRIGGER USER;
ALTER TABLE public.stripe_refunds ENABLE TRIGGER USER;
ALTER TABLE public.stripe_balance_transactions ENABLE TRIGGER USER;
ALTER TABLE public.orders ENABLE TRIGGER USER;
-- G1_CLEANUP_END

-- G1_BODY_BEGIN
-- G1_BODY_END

-- G1_FINAL_ASSERT_BEGIN
DO $g1_final_assert$
DECLARE
  v_delete_tables regclass[] := ARRAY[
    'private.order_email_outbox'::regclass,
    'private.order_status_links'::regclass,
    'private.fulfillment_tracking_registrations'::regclass,
    'public.order_fulfillment_attention'::regclass,
    'public.order_fulfillment_events'::regclass,
    'public.order_fulfillment_tracking_changes'::regclass,
    'public.order_return_photos'::regclass,
    'public.order_return_photo_uploads'::regclass,
    'public.order_cancel_request_lines'::regclass,
    'public.order_cancel_requests'::regclass,
    'public.order_return_receipt_lines'::regclass,
    'public.order_return_receipts'::regclass,
    'public.order_refund_lines'::regclass,
    'public.stock_movements'::regclass,
    'public.order_refunds'::regclass,
    'public.order_return_lines'::regclass,
    'public.order_fulfillment_lines'::regclass,
    'public.order_item_completions'::regclass,
    'public.order_items'::regclass,
    'public.order_fulfillments'::regclass,
    'public.order_returns'::regclass,
    'public.order_revisions'::regclass,
    'public.payment_exceptions'::regclass,
    'public.checkout_drafts'::regclass,
    'public.stripe_refunds'::regclass,
    'public.stripe_balance_transactions'::regclass,
    'public.orders'::regclass
  ];
  v_failed text;
BEGIN
  -- 全件削除の 25 表が空
  IF EXISTS (SELECT 1 FROM private.order_email_outbox) THEN v_failed := 'order_email_outbox';
  ELSIF EXISTS (SELECT 1 FROM private.order_status_links) THEN v_failed := 'order_status_links';
  ELSIF EXISTS (SELECT 1 FROM private.fulfillment_tracking_registrations) THEN v_failed := 'fulfillment_tracking_registrations';
  ELSIF EXISTS (SELECT 1 FROM public.order_fulfillment_attention) THEN v_failed := 'order_fulfillment_attention';
  ELSIF EXISTS (SELECT 1 FROM public.order_fulfillment_events) THEN v_failed := 'order_fulfillment_events';
  ELSIF EXISTS (SELECT 1 FROM public.order_fulfillment_tracking_changes) THEN v_failed := 'order_fulfillment_tracking_changes';
  ELSIF EXISTS (SELECT 1 FROM public.order_return_photos) THEN v_failed := 'order_return_photos';
  ELSIF EXISTS (SELECT 1 FROM public.order_return_photo_uploads) THEN v_failed := 'order_return_photo_uploads';
  ELSIF EXISTS (SELECT 1 FROM public.order_cancel_request_lines) THEN v_failed := 'order_cancel_request_lines';
  ELSIF EXISTS (SELECT 1 FROM public.order_cancel_requests) THEN v_failed := 'order_cancel_requests';
  ELSIF EXISTS (SELECT 1 FROM public.order_return_receipt_lines) THEN v_failed := 'order_return_receipt_lines';
  ELSIF EXISTS (SELECT 1 FROM public.order_return_receipts) THEN v_failed := 'order_return_receipts';
  ELSIF EXISTS (SELECT 1 FROM public.order_refund_lines) THEN v_failed := 'order_refund_lines';
  ELSIF EXISTS (SELECT 1 FROM public.stock_movements) THEN v_failed := 'stock_movements';
  ELSIF EXISTS (SELECT 1 FROM public.order_refunds) THEN v_failed := 'order_refunds';
  ELSIF EXISTS (SELECT 1 FROM public.order_return_lines) THEN v_failed := 'order_return_lines';
  ELSIF EXISTS (SELECT 1 FROM public.order_fulfillment_lines) THEN v_failed := 'order_fulfillment_lines';
  ELSIF EXISTS (SELECT 1 FROM public.order_item_completions) THEN v_failed := 'order_item_completions';
  ELSIF EXISTS (SELECT 1 FROM public.order_items) THEN v_failed := 'order_items';
  ELSIF EXISTS (SELECT 1 FROM public.order_fulfillments) THEN v_failed := 'order_fulfillments';
  ELSIF EXISTS (SELECT 1 FROM public.order_returns) THEN v_failed := 'order_returns';
  ELSIF EXISTS (SELECT 1 FROM public.order_revisions) THEN v_failed := 'order_revisions';
  ELSIF EXISTS (SELECT 1 FROM public.payment_exceptions) THEN v_failed := 'payment_exceptions';
  ELSIF EXISTS (SELECT 1 FROM public.checkout_drafts) THEN v_failed := 'checkout_drafts';
  ELSIF EXISTS (SELECT 1 FROM public.orders) THEN v_failed := 'orders';
  -- O に結び付く Stripe の写しと、問い合わせの O との関連が残っていない
  ELSIF EXISTS (SELECT 1 FROM public.stripe_refunds
                WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids)) THEN
    v_failed := 'stripe_refunds_linked';
  ELSIF EXISTS (SELECT 1 FROM public.stripe_balance_transactions
                WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids)) THEN
    v_failed := 'stripe_balance_transactions_linked';
  ELSIF EXISTS (SELECT 1 FROM public.contact_inquiries
                WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids)) THEN
    v_failed := 'contact_inquiries_linked';
  -- 全 variant の在庫が 0
  ELSIF EXISTS (SELECT 1 FROM public.item_variants WHERE stock_quantity <> 0) THEN
    v_failed := 'item_variants_stock';
  -- 影響する payout は残った balance の net の合計で、照合は pending
  ELSIF EXISTS (
    SELECT 1 FROM public.stripe_payouts p
    WHERE p.id IN (SELECT id FROM pg_temp.group_g_cleanup_payout_ids)
      AND (p.reconciliation_status <> 'pending'
        OR p.reconciled_net <> COALESCE((SELECT pg_catalog.sum(b.net)
                                         FROM public.stripe_balance_transactions b
                                         WHERE b.payout_id = p.id), 0))
  ) THEN
    v_failed := 'stripe_payouts_recompute';
  -- W は全部 dead・決まった理由・借りなし・完了なし・知らせ済み（この取引の中の時刻）
  ELSIF (SELECT pg_catalog.count(*) FROM public.stripe_webhook_events e
         WHERE e.id IN (SELECT id FROM pg_temp.group_g_cleanup_webhook_ids)
           AND e.processing_status = 'dead'
           AND e.last_error = 'group_g1_test_data_cleanup'
           AND e.claim_token IS NULL
           AND e.lease_expires_at IS NULL
           AND e.completed_at IS NULL
           AND e.dead_at IS NOT NULL
           AND e.dead_notified_at IS NOT NULL
           AND e.dead_notified_at >= pg_catalog.now()
           AND e.dead_notified_at <= pg_catalog.clock_timestamp())
        <> (SELECT pg_catalog.count(*) FROM pg_temp.group_g_cleanup_webhook_ids) THEN
    v_failed := 'webhook_terminalized';
  -- W は店へ知らせる退避の一覧に出ない（上限で切らないよう、全行数を上限に渡す）
  ELSIF EXISTS (
    SELECT 1
    FROM public.list_unnotified_dead_stripe_webhook_events(
      GREATEST((SELECT pg_catalog.count(*) FROM public.stripe_webhook_events)::integer, 1)
    ) n
    WHERE n.event_id IN (SELECT id FROM pg_temp.group_g_cleanup_webhook_ids)
  ) THEN
    v_failed := 'webhook_unnotified';
  -- 知らせの行は消していない
  ELSIF (SELECT pg_catalog.count(*) FROM public.stripe_webhook_events)::text
        IS DISTINCT FROM pg_catalog.current_setting('group_g1.webhook_total', true) THEN
    v_failed := 'webhook_total';
  -- 止めた USER トリガーは全部ふつうに有効へ戻っている
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = ANY (v_delete_tables)
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'O'
  ) THEN
    v_failed := 'user_trigger_restored';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'protect_legal_order_delete'
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.order_items'::regclass AND t.tgname = 'protect_legal_order_item_delete'
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN
    v_failed := 'legal_trigger_restored';
  -- 外した外部キーは同じ名前・同じ形で戻っている
  ELSIF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.order_items'::regclass
      AND c.conname = 'order_items_exchange_return_line_id_fkey'
      AND c.contype = 'f'
      AND c.confrelid = 'public.order_return_lines'::regclass
      AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                            WHERE a.attrelid = 'public.order_items'::regclass AND a.attname = 'exchange_return_line_id')]
      AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                             WHERE a.attrelid = 'public.order_return_lines'::regclass AND a.attname = 'id')]
      AND c.confdeltype = 'r'
      AND c.confupdtype = 'a'
      AND NOT c.condeferrable
      AND c.convalidated
  ) <> 1 OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.order_items'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.order_return_lines'::regclass
  ) <> 1 THEN
    v_failed := 'exchange_fkey_restored';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g1_final_assert$;
-- G1_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
