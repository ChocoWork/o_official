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
-- Task 2: 割当・履歴のモデル（設計書 7-1・8-1）。
-- 操作の受付（private.group_g_operations）、割当の現在値（order_item_allocations）、割当の履歴（order_item_allocation_events）、
-- 品物ごとの状態の履歴（order_item_state_events）と、orders.paid_at・stock_movements.allocation_operation_id を足す。
-- 書くのは後の Task の SECURITY DEFINER の関数だけ。service_role は読むだけで、直接の DML で割当・履歴を作らせない。
-- 操作の ID は先に作り、受付の行は処理の終わりに一度だけ書く（参照は取引の終わりに確かめる遅延の外部キー）。

-- 1. 操作の受付。追記だけ。actor_id は利用者の削除で変わらない写しなので外部キーにしない。
--    支払額の違いの保留（payment_review_hold）は要対応の行が必ず要る（外部キーと CHECK で単独の INSERT を断る）
CREATE TABLE private.group_g_operations (
  id uuid NOT NULL,
  operation text NOT NULL,
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  cause_type text NOT NULL,
  cause_id text NOT NULL,
  exception_id uuid,
  actor_id uuid,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT group_g_operations_pkey PRIMARY KEY (id),
  CONSTRAINT group_g_operations_operation_request_key_key UNIQUE (operation, request_key),
  CONSTRAINT group_g_operations_exception_id_fkey FOREIGN KEY (exception_id)
    REFERENCES public.payment_exceptions (id) ON DELETE RESTRICT,
  CONSTRAINT group_g_operations_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_g_operations_exception_check CHECK ((operation = 'payment_review_hold') = (exception_id IS NOT NULL)),
  CONSTRAINT group_g_operations_review_hold_check CHECK (
    operation <> 'payment_review_hold'
    OR (cause_type = 'payment_exception'
        AND cause_id = exception_id::text
        AND result -> 'active' = 'true'::jsonb
        AND pg_catalog.jsonb_typeof(result -> 'order_id') = 'string')
  )
);
ALTER TABLE private.group_g_operations OWNER TO postgres;

-- 2. 割当の現在値。仮確保（payment_hold = H）と入金済みの割当（paid = A）。数量と作った操作は変えない。
--    残数量と種類（H → A だけ）は変わるたびに version を 1 つ進め、同じ取引で履歴を追記する（下の守り）
CREATE TABLE public.order_item_allocations (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  order_item_id uuid NOT NULL,
  variant_id bigint NOT NULL,
  quantity integer NOT NULL,
  remaining_quantity integer NOT NULL,
  kind text NOT NULL,
  operation_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_item_allocations_pkey PRIMARY KEY (id),
  CONSTRAINT order_item_allocations_order_item_id_fkey FOREIGN KEY (order_item_id)
    REFERENCES public.order_items (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocations_variant_id_fkey FOREIGN KEY (variant_id)
    REFERENCES public.item_variants (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocations_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT order_item_allocations_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_item_allocations_remaining_check CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
  CONSTRAINT order_item_allocations_kind_check CHECK (kind IN ('payment_hold', 'paid')),
  CONSTRAINT order_item_allocations_version_check CHECK (version >= 0)
);
ALTER TABLE public.order_item_allocations OWNER TO postgres;
CREATE INDEX order_item_allocations_variant_kind_item_idx
  ON public.order_item_allocations (variant_id, kind, order_item_id);
CREATE INDEX order_item_allocations_item_id_idx
  ON public.order_item_allocations (order_item_id, id);

-- 3. 割当の履歴。追記だけ。
--    作る: hold（H）・allocate（A）・restore（発送の消費を戻した新しい A）・transfer の受け手（入替で作る新しい A）。
--    減らす: release（空き在庫へ戻す）・consume（発送で使う）・transfer の出し手。promote は H → A（数は変えない）。
--    在庫の台帳は、作る3つ（負数）と release（正数）だけが1行ずつ持つ（H → A・発送・入替は台帳を足さない）
CREATE TABLE public.order_item_allocation_events (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  allocation_id uuid NOT NULL,
  event_type text NOT NULL,
  quantity integer NOT NULL,
  operation_id uuid NOT NULL,
  sequence integer NOT NULL,
  counterpart_allocation_id uuid,
  reverses_event_id uuid,
  stock_movement_id bigint,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_item_allocation_events_pkey PRIMARY KEY (id),
  CONSTRAINT order_item_allocation_events_allocation_id_fkey FOREIGN KEY (allocation_id)
    REFERENCES public.order_item_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocation_events_counterpart_allocation_id_fkey FOREIGN KEY (counterpart_allocation_id)
    REFERENCES public.order_item_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocation_events_reverses_event_id_fkey FOREIGN KEY (reverses_event_id)
    REFERENCES public.order_item_allocation_events (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocation_events_stock_movement_id_fkey FOREIGN KEY (stock_movement_id)
    REFERENCES public.stock_movements (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_allocation_events_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT order_item_allocation_events_operation_key UNIQUE (operation_id, allocation_id, event_type, sequence),
  CONSTRAINT order_item_allocation_events_stock_movement_id_key UNIQUE (stock_movement_id),
  CONSTRAINT order_item_allocation_events_reverses_event_id_key UNIQUE (reverses_event_id),
  CONSTRAINT order_item_allocation_events_event_type_check CHECK (
    event_type IN ('hold', 'promote', 'allocate', 'release', 'consume', 'restore', 'transfer')
  ),
  CONSTRAINT order_item_allocation_events_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_item_allocation_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT order_item_allocation_events_counterpart_check CHECK (
    (event_type = 'transfer') = (counterpart_allocation_id IS NOT NULL)
    AND counterpart_allocation_id IS DISTINCT FROM allocation_id
  ),
  CONSTRAINT order_item_allocation_events_reverses_check CHECK ((event_type = 'restore') = (reverses_event_id IS NOT NULL)),
  CONSTRAINT order_item_allocation_events_movement_check CHECK (
    (event_type IN ('hold', 'allocate', 'restore', 'release')) = (stock_movement_id IS NOT NULL)
  )
);
ALTER TABLE public.order_item_allocation_events OWNER TO postgres;
CREATE INDEX order_item_allocation_events_allocation_created_idx
  ON public.order_item_allocation_events (allocation_id, created_at, id);

-- 4. 品物ごとの状態の履歴。追記だけ。数量は 0 始まりの半開区間 [unit_from, unit_to)。
--    状態は 12 の値だけ（設計書 6-2）。新しく表に出た数量だけ from が空、表から外れた数量だけ to が空
CREATE TABLE public.order_item_state_events (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  order_item_id uuid NOT NULL,
  unit_from integer NOT NULL,
  unit_to integer NOT NULL,
  quantity integer GENERATED ALWAYS AS (unit_to - unit_from) STORED,
  from_status text,
  to_status text,
  operation_id uuid NOT NULL,
  sequence integer NOT NULL,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  version bigint NOT NULL,
  CONSTRAINT order_item_state_events_pkey PRIMARY KEY (id),
  CONSTRAINT order_item_state_events_order_item_id_fkey FOREIGN KEY (order_item_id)
    REFERENCES public.order_items (id) ON DELETE RESTRICT,
  CONSTRAINT order_item_state_events_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT order_item_state_events_operation_key UNIQUE (operation_id, order_item_id, sequence, unit_from),
  CONSTRAINT order_item_state_events_unit_from_check CHECK (unit_from >= 0),
  CONSTRAINT order_item_state_events_unit_to_check CHECK (unit_to > unit_from),
  CONSTRAINT order_item_state_events_from_status_check CHECK (from_status IN (
    'unpaid', 'payment_expired', 'in_production', 'ready', 'shipped', 'delivered',
    'cancel_requested', 'cancelled', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned'
  )),
  CONSTRAINT order_item_state_events_to_status_check CHECK (to_status IN (
    'unpaid', 'payment_expired', 'in_production', 'ready', 'shipped', 'delivered',
    'cancel_requested', 'cancelled', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned'
  )),
  CONSTRAINT order_item_state_events_transition_check CHECK (
    (from_status IS NOT NULL OR to_status IS NOT NULL) AND from_status IS DISTINCT FROM to_status
  ),
  CONSTRAINT order_item_state_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT order_item_state_events_version_check CHECK (version > 0)
);
ALTER TABLE public.order_item_state_events OWNER TO postgres;
CREATE INDEX order_item_state_events_item_version_idx
  ON public.order_item_state_events (order_item_id, version, id);

-- 5. 既存の表に足す物。
--    orders.paid_at は初めて入金を DB に記録した時刻（後の Task の入金の関数と不変のトリガーで守る）。店内だけの列
--    （列の権限は後から足した列に及ばないので、お客様の Data API からは隠れる）
ALTER TABLE public.orders ADD COLUMN paid_at timestamptz;
COMMENT ON COLUMN public.orders.paid_at IS
  '初めて入金を DB に記録した時刻（グループ G 設計書 8-2）。一度だけ書き、変えない。店内だけの列';

-- 在庫の台帳を割当の操作と結び付ける。理由に allocation_release（割当の解放。正数）を足す（過去の SQL は変えない）
ALTER TABLE public.stock_movements
  ADD COLUMN allocation_operation_id uuid
    CONSTRAINT stock_movements_allocation_operation_id_fkey
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.stock_movements DROP CONSTRAINT stock_movements_reason_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_reason_check CHECK (reason IN (
    'purchase', 'restock', 'adjustment', 'cancel', 'refund', 'return', 'exchange', 'allocation_release'
  ));

-- 6. 追記だけの3表の守り。所有者の通常の SQL による UPDATE・DELETE・TRUNCATE もトリガーで断る
CREATE FUNCTION private.reject_group_g_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
ALTER FUNCTION private.reject_group_g_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reject_group_g_event_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER order_item_allocation_events_no_update BEFORE UPDATE ON public.order_item_allocation_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER order_item_allocation_events_no_delete BEFORE DELETE ON public.order_item_allocation_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER order_item_allocation_events_no_truncate BEFORE TRUNCATE ON public.order_item_allocation_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER order_item_state_events_no_update BEFORE UPDATE ON public.order_item_state_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER order_item_state_events_no_delete BEFORE DELETE ON public.order_item_state_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER order_item_state_events_no_truncate BEFORE TRUNCATE ON public.order_item_state_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER group_g_operations_no_update BEFORE UPDATE ON private.group_g_operations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER group_g_operations_no_delete BEFORE DELETE ON private.group_g_operations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER group_g_operations_no_truncate BEFORE TRUNCATE ON private.group_g_operations
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();

-- 7. 割当の現在値の守り。削除と、ID・明細・variant・数量・作った操作・作った時刻の変更を断る。
--    種類は H → A だけ。残数量は減るだけ（戻す時は restore で新しい行を作る）。
--    残数量か種類が変わる時は version をちょうど 1 進め、変わらない時は version も変えない。
--    同じ取引の履歴との突き合わせは、下の遅延の確かめが commit の時にも行う
CREATE FUNCTION private.guard_group_g_allocation_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
     OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.kind IS DISTINCT FROM OLD.kind AND NOT (OLD.kind = 'payment_hold' AND NEW.kind = 'paid'))
     OR NEW.remaining_quantity > OLD.remaining_quantity
     OR NEW.version IS DISTINCT FROM (
       CASE
         WHEN NEW.remaining_quantity <> OLD.remaining_quantity OR NEW.kind <> OLD.kind THEN OLD.version + 1
         ELSE OLD.version
       END
     ) THEN
    RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION private.guard_group_g_allocation_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_group_g_allocation_change() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER order_item_allocations_change_guard BEFORE UPDATE OR DELETE ON public.order_item_allocations
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_g_allocation_change();

-- 8. 割当の数の確かめ（commit の時に、触れた割当と相手の割当ごとに見る）。違反は GROUP_G_ALLOCATION_BOUNDS / 23514、
--    DETAIL に違反の種類（ID は出さない）。
--    ・variant は明細の variant と同じ（variant が空の明細は割り当てない）
--    ・作る履歴はちょうど 1 つで、数量と操作が行と同じ。H で作った行だけが promote を 1 回持てる
--    ・残数量 = 数量 − （release + consume + transfer の出し手）。consume は A だけ
--    ・台帳の行は同じ variant・同じ操作で、作る履歴は −数量（purchase / exchange）、release は +数量（cancel / refund / allocation_release）
--    ・restore は別の割当の同じ明細・同じ variant・同じ数量の consume を 1 回だけ戻す（一意の制約）
--    ・transfer は同じ操作・同じ variant・同じ数量の両側の履歴と、互いの相手を持ち、片方だけが受け手。両側とも A
--    ・明細ごとに H と A を同時に持たず、A + H の残数量 ≤ 明細の数量 − 取り消していない発送の数量（物理的な上限。
--      返金・申請の覆いはここでは引かない。購入時の区分 stock / backorder でも分けない）
CREATE FUNCTION private.check_group_g_allocation_bounds() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_allocation public.order_item_allocations%ROWTYPE;
  v_creation public.order_item_allocation_events%ROWTYPE;
  v_transfer public.order_item_allocation_events%ROWTYPE;
  v_mirror public.order_item_allocation_events%ROWTYPE;
  v_reversed public.order_item_allocation_events%ROWTYPE;
  v_partner public.order_item_allocations%ROWTYPE;
  v_reversed_allocation public.order_item_allocations%ROWTYPE;
  v_item_quantity integer;
  v_item_variant bigint;
  v_direct integer;
  v_count integer;
  v_promotes integer;
  v_decrease integer;
  v_partner_direct integer;
  v_shipped integer;
  v_remaining_total integer;
  v_has_hold boolean;
  v_has_paid boolean;
BEGIN
  IF TG_TABLE_NAME = 'order_item_allocations' THEN
    v_ids := ARRAY[NEW.id];
  ELSE
    v_ids := ARRAY[NEW.allocation_id];
    IF NEW.counterpart_allocation_id IS NOT NULL THEN
      v_ids := v_ids || NEW.counterpart_allocation_id;
    END IF;
  END IF;

  FOR v_allocation IN
    SELECT a.* FROM public.order_item_allocations AS a WHERE a.id = ANY (v_ids) ORDER BY a.id
  LOOP
    SELECT oi.quantity, oi.variant_id INTO v_item_quantity, v_item_variant
    FROM public.order_items AS oi
    WHERE oi.id = v_allocation.order_item_id;
    IF v_item_variant IS NULL OR v_item_variant <> v_allocation.variant_id THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'variant_mismatch';
    END IF;

    -- 作る履歴。hold・allocate・restore が無ければ、行と同じ操作の transfer（受け手）がちょうど 1 つ
    SELECT pg_catalog.count(*)::integer INTO v_direct
    FROM public.order_item_allocation_events AS e
    WHERE e.allocation_id = v_allocation.id AND e.event_type IN ('hold', 'allocate', 'restore');
    IF v_direct = 1 THEN
      SELECT e.* INTO v_creation
      FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type IN ('hold', 'allocate', 'restore');
    ELSIF v_direct = 0 THEN
      SELECT pg_catalog.count(*)::integer INTO v_count
      FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type = 'transfer' AND e.operation_id = v_allocation.operation_id;
      IF v_count <> 1 THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'creation_event';
      END IF;
      SELECT e.* INTO v_creation
      FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type = 'transfer' AND e.operation_id = v_allocation.operation_id;
    ELSE
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'creation_event';
    END IF;
    IF v_creation.quantity <> v_allocation.quantity OR v_creation.operation_id <> v_allocation.operation_id THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'creation_event';
    END IF;

    -- 種類の履歴。H で作った行は H のままか、promote 1 回で A。ほかは A で、promote を持たない
    SELECT pg_catalog.count(*)::integer INTO v_promotes
    FROM public.order_item_allocation_events AS e
    WHERE e.allocation_id = v_allocation.id AND e.event_type = 'promote';
    IF v_creation.event_type = 'hold' THEN
      IF NOT ((v_allocation.kind = 'payment_hold' AND v_promotes = 0) OR (v_allocation.kind = 'paid' AND v_promotes = 1)) THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'kind_history';
      END IF;
    ELSIF v_allocation.kind <> 'paid' OR v_promotes <> 0 THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'kind_history';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type = 'promote' AND e.quantity > v_allocation.quantity
    ) THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'kind_history';
    END IF;

    -- 残数量と減らす履歴。同じ数量を二度使わない
    SELECT COALESCE(pg_catalog.sum(e.quantity), 0)::integer INTO v_decrease
    FROM public.order_item_allocation_events AS e
    WHERE e.allocation_id = v_allocation.id
      AND (e.event_type IN ('release', 'consume') OR (e.event_type = 'transfer' AND e.id <> v_creation.id));
    IF v_decrease <> v_allocation.quantity - v_allocation.remaining_quantity THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'remaining_events';
    END IF;
    IF v_allocation.kind <> 'paid' AND EXISTS (
      SELECT 1 FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type = 'consume'
    ) THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'consume_kind';
    END IF;

    -- 在庫の台帳との対応
    IF EXISTS (
      SELECT 1
      FROM public.order_item_allocation_events AS e
      JOIN public.stock_movements AS m ON m.id = e.stock_movement_id
      WHERE e.allocation_id = v_allocation.id
        AND NOT (
          m.variant_id = v_allocation.variant_id
          AND m.allocation_operation_id IS NOT DISTINCT FROM e.operation_id
          AND (
            (e.event_type IN ('hold', 'allocate', 'restore') AND m.delta = -e.quantity AND m.reason IN ('purchase', 'exchange'))
            OR (e.event_type = 'release' AND m.delta = e.quantity AND m.reason IN ('cancel', 'refund', 'allocation_release'))
          )
        )
    ) THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'stock_movement';
    END IF;

    -- 発送の消費を戻す: 別の割当の、同じ明細・同じ variant・同じ数量の consume だけ
    IF v_creation.event_type = 'restore' THEN
      SELECT r.* INTO v_reversed FROM public.order_item_allocation_events AS r WHERE r.id = v_creation.reverses_event_id;
      SELECT a.* INTO v_reversed_allocation FROM public.order_item_allocations AS a WHERE a.id = v_reversed.allocation_id;
      IF v_reversed.event_type IS DISTINCT FROM 'consume'
         OR v_reversed.quantity <> v_creation.quantity
         OR v_reversed_allocation.id = v_allocation.id
         OR v_reversed_allocation.order_item_id <> v_allocation.order_item_id
         OR v_reversed_allocation.variant_id <> v_allocation.variant_id THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'restore';
      END IF;
    END IF;

    -- 入替: 両側の履歴が 1 つずつ対になり、片方だけが受け手
    FOR v_transfer IN
      SELECT e.* FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_allocation.id AND e.event_type = 'transfer'
    LOOP
      SELECT a.* INTO v_partner FROM public.order_item_allocations AS a WHERE a.id = v_transfer.counterpart_allocation_id;
      SELECT pg_catalog.count(*)::integer INTO v_count
      FROM public.order_item_allocation_events AS s
      WHERE s.allocation_id = v_allocation.id AND s.event_type = 'transfer'
        AND s.counterpart_allocation_id = v_partner.id AND s.operation_id = v_transfer.operation_id;
      IF v_count <> 1 THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'transfer_pair';
      END IF;
      SELECT pg_catalog.count(*)::integer INTO v_count
      FROM public.order_item_allocation_events AS m
      WHERE m.allocation_id = v_partner.id AND m.event_type = 'transfer'
        AND m.counterpart_allocation_id = v_allocation.id AND m.operation_id = v_transfer.operation_id;
      IF v_count <> 1 THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'transfer_pair';
      END IF;
      SELECT m.* INTO v_mirror
      FROM public.order_item_allocation_events AS m
      WHERE m.allocation_id = v_partner.id AND m.event_type = 'transfer'
        AND m.counterpart_allocation_id = v_allocation.id AND m.operation_id = v_transfer.operation_id;
      SELECT pg_catalog.count(*)::integer INTO v_partner_direct
      FROM public.order_item_allocation_events AS e
      WHERE e.allocation_id = v_partner.id AND e.event_type IN ('hold', 'allocate', 'restore');
      IF v_mirror.quantity <> v_transfer.quantity
         OR v_partner.variant_id <> v_allocation.variant_id
         OR v_partner.kind <> 'paid'
         OR v_allocation.kind <> 'paid'
         OR (v_transfer.id = v_creation.id)
            = (v_partner_direct = 0 AND v_mirror.operation_id = v_partner.operation_id) THEN
        RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'transfer_pair';
      END IF;
    END LOOP;

    -- 明細ごとの上限と H / A の排他
    SELECT COALESCE(pg_catalog.sum(fl.quantity), 0)::integer INTO v_shipped
    FROM public.order_fulfillment_lines AS fl
    JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
    WHERE fl.order_item_id = v_allocation.order_item_id
      AND f.cancelled_at IS NULL;
    SELECT COALESCE(pg_catalog.sum(a.remaining_quantity), 0)::integer,
           COALESCE(pg_catalog.bool_or(a.kind = 'payment_hold' AND a.remaining_quantity > 0), false),
           COALESCE(pg_catalog.bool_or(a.kind = 'paid' AND a.remaining_quantity > 0), false)
      INTO v_remaining_total, v_has_hold, v_has_paid
    FROM public.order_item_allocations AS a
    WHERE a.order_item_id = v_allocation.order_item_id;
    IF v_has_hold AND v_has_paid THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'hold_paid_overlap';
    END IF;
    IF v_remaining_total > v_item_quantity - v_shipped THEN
      RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'item_bounds';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
ALTER FUNCTION private.check_group_g_allocation_bounds() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_group_g_allocation_bounds() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER group_g_allocation_bounds AFTER INSERT OR UPDATE ON public.order_item_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_group_g_allocation_bounds();
CREATE CONSTRAINT TRIGGER group_g_allocation_bounds AFTER INSERT OR UPDATE ON public.order_item_allocation_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_group_g_allocation_bounds();

-- 9. 支払額の違いの要対応と保留を同じ取引で作る（後の Task の入金と要対応の記録が、共通の在庫 lock を取った後に呼ぶ）。
--    要対応は payment_ref = COALESCE(注文の Checkout Session, 支払いの番号) と理由 paid_amount_mismatch の 1 行にまとめる
--    （既存の record_payment_exception と同じく、前からある行は最後の検知時刻と回数だけ進め、空の列だけ埋める）。
--    解決済みの要対応は開き直さず、保留も作らない。保留は要対応ごとに 1 つ（再送の番号が同じなので、既存の保留を使う）
CREATE FUNCTION private.ensure_group_g_payment_review_hold(
  _order_id uuid,
  _payment_ref text,
  _checkout_session_id text,
  _payment_intent_id text,
  _draft_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_session_id text;
  v_payment_ref text;
  v_exception public.payment_exceptions%ROWTYPE;
BEGIN
  IF _order_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 呼ぶ側が共通の在庫 lock を先に取っている（ここで取り直さない）
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.locktype = 'advisory'
      AND l.pid = pg_catalog.pg_backend_pid()
      AND l.classid = 190521
      AND l.objid = 1
      AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock'
      AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT o.checkout_session_id INTO v_order_session_id FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_payment_ref := COALESCE(
    v_order_session_id,
    NULLIF(pg_catalog.btrim(_payment_intent_id), ''),
    NULLIF(pg_catalog.btrim(_payment_ref), '')
  );
  IF v_payment_ref IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_exceptions (
    payment_ref, reason, detail, checkout_session_id, payment_intent_id, draft_id, order_id
  ) VALUES (
    v_payment_ref, 'paid_amount_mismatch', NULL, _checkout_session_id, _payment_intent_id, _draft_id, _order_id
  )
  ON CONFLICT (payment_ref, reason) DO NOTHING
  RETURNING * INTO v_exception;

  IF v_exception.id IS NULL THEN
    UPDATE public.payment_exceptions AS e
    SET last_detected_at = pg_catalog.now(),
        detection_count = e.detection_count + 1,
        checkout_session_id = COALESCE(e.checkout_session_id, _checkout_session_id),
        payment_intent_id = COALESCE(e.payment_intent_id, _payment_intent_id),
        draft_id = COALESCE(e.draft_id, _draft_id),
        order_id = COALESCE(e.order_id, _order_id)
    WHERE e.payment_ref = v_payment_ref
      AND e.reason = 'paid_amount_mismatch'
    RETURNING e.* INTO v_exception;
  END IF;

  -- 別の注文の要対応に保留を付けない
  IF v_exception.order_id IS DISTINCT FROM _order_id THEN
    RAISE EXCEPTION 'GROUP_G_PAYMENT_REVIEW_CONFLICT' USING ERRCODE = '55000';
  END IF;

  IF v_exception.resolved_at IS NOT NULL THEN
    RETURN v_exception.id;
  END IF;

  INSERT INTO private.group_g_operations (
    id, operation, request_key, fingerprint, cause_type, cause_id, exception_id, actor_id, result
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'payment_review_hold',
    pg_catalog.md5('review-hold:' || v_exception.id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'operation', 'payment_review_hold', 'exception_id', v_exception.id, 'order_id', _order_id
      )::text,
      'UTF8'
    )), 'hex'),
    'payment_exception',
    v_exception.id::text,
    v_exception.id,
    NULL,
    pg_catalog.jsonb_build_object('active', true, 'order_id', _order_id)
  )
  ON CONFLICT (operation, request_key) DO NOTHING;

  RETURN v_exception.id;
END;
$$;
ALTER FUNCTION private.ensure_group_g_payment_review_hold(uuid, text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.ensure_group_g_payment_review_hold(uuid, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- 10. 行の守りと権限。新しい表は anon・authenticated に自動で権限が付くので、まず全部外し、service_role には public の3表の SELECT だけ。
--     private の USAGE と private.set_request_context() の実行権限（PostgREST の要求の前の処理）には触れない
ALTER TABLE private.group_g_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_allocation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_state_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY group_g_operations_deny_all ON private.group_g_operations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY order_item_allocations_deny_all ON public.order_item_allocations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY order_item_allocation_events_deny_all ON public.order_item_allocation_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY order_item_state_events_deny_all ON public.order_item_state_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE private.group_g_operations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_item_allocations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_item_allocation_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_item_state_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.order_item_allocations TO service_role;
GRANT SELECT ON TABLE public.order_item_allocation_events TO service_role;
GRANT SELECT ON TABLE public.order_item_state_events TO service_role;

-- Task 3: 現在値は原本から投影する。数量を1点ずつ展開せず、発送内と未発送の半開区間を分割する。
CREATE FUNCTION private.group_g_item_state_ranges(_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_item_id uuid, status text, unit_from integer, unit_to integer, blocked_reasons text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _order_ids IS NULL OR pg_catalog.cardinality(_order_ids) = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH orders AS MATERIALIZED (
    SELECT o.id, o.status, o.paid_at, o.paid_amount,
           EXISTS (
             SELECT 1 FROM private.group_g_operations AS g
             JOIN public.payment_exceptions AS e ON e.id = g.exception_id
             WHERE g.operation = 'payment_review_hold' AND g.result->>'order_id' = o.id::text
               AND e.resolved_at IS NULL
           ) AS review_hold,
           (SELECT r.reason FROM public.order_revisions AS r
            WHERE r.order_id = o.id AND 'status' = ANY(r.changed_fields) AND r.after_data->>'status' = 'failed'
            ORDER BY r.changed_at DESC, r.id DESC LIMIT 1) AS failed_reason
    FROM public.orders AS o
    WHERE o.id = ANY(_order_ids) AND o.status NOT IN ('payment_in_progress', 'abandoned')
  ), items AS MATERIALIZED (
    SELECT o.id AS order_id, oi.id AS order_item_id, oi.quantity, oi.variant_id, o.status AS order_status,
           o.failed_reason, o.review_hold,
           (o.status IN ('paid', 'shipped') OR o.paid_at IS NOT NULL OR COALESCE(o.paid_amount, 0) > 0) AS paid,
           EXISTS (
             SELECT 1 FROM public.order_return_lines AS el
             JOIN public.order_returns AS er ON er.id = el.return_id
             WHERE el.id = oi.exchange_return_line_id AND er.fee_due_amount > 0
               AND er.fee_received_at IS NULL AND er.exchange_released_at IS NULL
           ) AS fee_waiting,
           COALESCE((SELECT pg_catalog.sum(a.remaining_quantity) FROM public.order_item_allocations AS a
                     WHERE a.order_item_id = oi.id AND a.kind = 'paid'), 0)::integer AS allocated
    FROM orders AS o JOIN public.order_items AS oi ON oi.order_id = o.id
  ), shipments AS MATERIALIZED (
    SELECT i.order_id, i.order_item_id, f.id AS fulfillment_id, f.delivered_at, fl.quantity,
           COALESCE(pg_catalog.sum(fl.quantity) OVER (
             PARTITION BY i.order_item_id ORDER BY f.shipped_at, f.id, fl.order_item_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::integer AS start_unit
    FROM items AS i JOIN public.order_fulfillment_lines AS fl ON fl.order_item_id = i.order_item_id
    JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id AND f.cancelled_at IS NULL
  ), refunds AS MATERIALIZED (
    SELECT rl.order_item_id, r.return_id, rl.before_shipment,
           pg_catalog.sum(rl.quantity)::integer AS covered,
           COALESCE(pg_catalog.sum(rl.quantity) FILTER (WHERE r.status = 'succeeded'), 0)::integer AS succeeded,
           COALESCE(pg_catalog.sum(rl.quantity) FILTER (WHERE r.status IN ('awaiting_response', 'pending')), 0)::integer AS processing
    FROM items AS i JOIN public.order_refund_lines AS rl ON rl.order_item_id = i.order_item_id
    JOIN public.order_refunds AS r ON r.id = rl.refund_id AND r.status IN ('awaiting_response', 'pending', 'succeeded')
    GROUP BY rl.order_item_id, r.return_id, rl.before_shipment
  ), failed_return_refunds AS MATERIALIZED (
    -- 額を決めた返金の失敗は店長相談へ戻さない。同じ数量の再試行を重ねて足さない。
    SELECT rl.order_item_id, r.return_id, pg_catalog.max(rl.quantity)::integer AS quantity
    FROM items AS i JOIN public.order_refund_lines AS rl ON rl.order_item_id = i.order_item_id
    JOIN public.order_refunds AS r ON r.id = rl.refund_id
    WHERE NOT rl.before_shipment AND r.return_id IS NOT NULL AND r.status IN ('error', 'failed')
    GROUP BY rl.order_item_id, r.return_id
  ), return_states AS MATERIALIZED (
    -- 最新の既存core（20261012235910）を使う。processed と refund_covered は足さない。
    SELECT s.*, l.created_at, COALESCE(pi.refund_quantity, 0)::integer AS pending_refund_inspection,
           COALESCE(pg_catalog.sum(s.refund_covered + s.refund_waiting) OVER (
             PARTITION BY s.return_id, s.order_item_id ORDER BY l.created_at, l.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::integer AS previous_refund_units
    FROM orders AS o CROSS JOIN LATERAL private.order_return_line_states(o.id) AS s
    JOIN public.order_return_lines AS l ON l.id = s.return_line_id
    CROSS JOIN LATERAL (
      -- 検品済みの記録はresolutionを持たない。受付順で検品を当て、残る検品待ちの返金分だけを求める。
      SELECT pg_catalog.sum(GREATEST(p.quantity - GREATEST(t.inspected - p.previous_quantity, 0), 0))
        FILTER (WHERE p.resolution = 'refund') AS refund_quantity
      FROM (
        SELECT x.quantity, x.resolution, COALESCE(pg_catalog.sum(x.quantity) OVER (
          ORDER BY rc.created_at, rc.id, x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previous_quantity
        FROM public.order_return_receipt_lines AS x
        JOIN public.order_return_receipts AS rc ON rc.id = x.receipt_id
        WHERE x.return_line_id = s.return_line_id AND x.disposition = 'pending_inspection'
      ) AS p
      CROSS JOIN LATERAL (
        SELECT COALESCE(pg_catalog.sum(x.quantity), 0) AS inspected FROM public.order_return_receipt_lines AS x
        WHERE x.return_line_id = s.return_line_id AND x.disposition IN ('inspected_restocked', 'inspected_not_restocked')
      ) AS t
    ) AS pi
  ), return_coverage AS (
    SELECT s.*,
           LEAST(s.refund_covered + s.refund_waiting,
             GREATEST(COALESCE(r.covered, 0) - s.previous_refund_units, 0)) AS covered_by_return,
           LEAST(s.refund_covered + s.refund_waiting,
             GREATEST(COALESCE(r.succeeded, 0) - s.previous_refund_units, 0)) AS succeeded_by_return,
           LEAST(s.refund_covered + s.refund_waiting,
             GREATEST(COALESCE(f.quantity, 0) - s.previous_refund_units, 0)) AS fixed_refund_units
    FROM return_states AS s LEFT JOIN refunds AS r ON r.order_item_id = s.order_item_id
      AND r.return_id = s.return_id AND NOT r.before_shipment
    LEFT JOIN failed_return_refunds AS f ON f.order_item_id = s.order_item_id AND f.return_id = s.return_id
  ), return_extra AS (
    SELECT s.*,
           GREATEST(s.refund_covered - s.covered_by_return, 0) AS covered_extra,
           COALESCE(pg_catalog.sum(GREATEST(s.refund_covered - s.covered_by_return, 0)) OVER (
             PARTITION BY s.order_item_id ORDER BY s.return_number, s.created_at, s.return_line_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::integer AS previous_extra
    FROM return_coverage AS s
  ), return_work AS (
    SELECT s.*,
           -- 検品待ちが金銭の覆いにも含まれる時は一度だけ数える。
           LEAST(GREATEST(s.quantity - s.unprocessed - s.pending_inspection, 0),
             GREATEST(s.refund_waiting - s.pending_refund_inspection
               - GREATEST(s.fixed_refund_units - s.refund_covered, 0), 0)) AS waiting,
           GREATEST(s.refund_covered - s.succeeded_by_return
             - LEAST(s.covered_extra, GREATEST(COALESCE(r.succeeded, 0) - s.previous_extra, 0))
             - GREATEST(s.pending_refund_inspection - s.refund_waiting, 0), 0) AS processing,
           -- The overlap stays in inspection's status quantity, but retains its active-refund reason.
           LEAST(s.pending_inspection, GREATEST(s.pending_refund_inspection - s.refund_waiting, 0),
             GREATEST(s.refund_covered - s.succeeded_by_return
               - LEAST(s.covered_extra, GREATEST(COALESCE(r.succeeded, 0) - s.previous_extra, 0)), 0)) AS inspection_processing,
           LEAST(GREATEST(s.fixed_refund_units - s.refund_covered, 0),
                 GREATEST(s.refund_waiting - s.pending_refund_inspection, 0)) AS fixed_processing
    FROM return_extra AS s LEFT JOIN refunds AS r ON r.order_item_id = s.order_item_id
      AND r.return_id IS NULL AND NOT r.before_shipment
  ), return_counts AS (
    SELECT s.*,
           LEAST(s.processing, GREATEST(s.quantity - s.unprocessed - s.pending_inspection - s.waiting, 0)) AS active_refund,
           LEAST(s.fixed_processing,
             GREATEST(s.quantity - s.unprocessed - s.pending_inspection - s.waiting - s.processing, 0)) AS failed_refund,
           GREATEST(s.quantity - s.unprocessed - s.pending_inspection - s.waiting
             - s.processing - s.fixed_processing, 0) AS done
    FROM return_work AS s
  ), shipping_counts AS (
    SELECT sh.*, COALESCE(x.done, 0)::integer AS done, COALESCE(x.waiting, 0)::integer AS waiting,
           COALESCE(x.working, 0)::integer AS working, COALESCE(x.processing, 0)::integer AS processing,
           COALESCE(x.inspection_processing, 0)::integer AS inspection_processing,
           COALESCE(x.failed_refund, 0)::integer AS failed_refund,
           COALESCE(x.requested, 0)::integer AS requested, COALESCE(x.declined, 0)::integer AS declined
    FROM shipments AS sh
    CROSS JOIN LATERAL (
      SELECT pg_catalog.sum(s.done) FILTER (WHERE s.return_status IN ('open', 'closed')) AS done,
             pg_catalog.sum(s.waiting) FILTER (WHERE s.return_status IN ('open', 'closed')) AS waiting,
             pg_catalog.sum(s.unprocessed + s.pending_inspection) FILTER (WHERE s.return_status IN ('open', 'closed')) AS working,
             pg_catalog.sum(s.active_refund) FILTER (WHERE s.return_status IN ('open', 'closed')) AS processing,
             pg_catalog.sum(s.inspection_processing) FILTER (WHERE s.return_status IN ('open', 'closed')) AS inspection_processing,
             pg_catalog.sum(s.failed_refund) FILTER (WHERE s.return_status IN ('open', 'closed')) AS failed_refund,
             pg_catalog.sum(s.quantity) FILTER (WHERE s.return_status = 'requested') AS requested,
             -- 同じ品の申請を繰り返し却下しても実配達の数量を増やさない。
             pg_catalog.max(s.quantity) FILTER (WHERE s.return_status = 'declined') AS declined
      FROM return_counts AS s WHERE s.fulfillment_id = sh.fulfillment_id AND s.order_item_id = sh.order_item_id
    ) AS x
  ), shipping_buckets AS (
    SELECT sh.order_id, sh.order_item_id, sh.fulfillment_id, sh.start_unit, sh.quantity AS domain_quantity,
           b.priority, b.status, b.quantity, b.processing
    FROM shipping_counts AS sh CROSS JOIN LATERAL (VALUES
      (1, 'returned'::text, sh.done, false), (2, 'refund_waiting', sh.waiting, false),
      (3, 'return_in_progress', sh.processing, true), (4, 'return_in_progress', sh.failed_refund, false),
      (5, 'return_in_progress', sh.inspection_processing, true),
      (6, 'return_in_progress', sh.working - sh.inspection_processing, false),
      (7, 'return_requested', sh.requested, false), (8, 'delivered', sh.declined, false),
      (9, 'delivered', CASE WHEN sh.delivered_at IS NOT NULL THEN sh.quantity ELSE 0 END, false),
      (10, 'shipped', sh.quantity, false)
    ) AS b(priority, status, quantity, processing)
  ), shipping_positioned AS (
    SELECT b.*, COALESCE(pg_catalog.sum(b.quantity) OVER (
      PARTITION BY b.order_item_id, b.fulfillment_id ORDER BY b.priority
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previous_quantity
    FROM shipping_buckets AS b
  ), shipped_ranges AS (
    SELECT b.order_id, b.order_item_id, b.status,
           (b.start_unit + LEAST(b.domain_quantity, b.previous_quantity))::integer AS unit_from,
           (b.start_unit + LEAST(b.domain_quantity, b.previous_quantity + b.quantity))::integer AS unit_to,
           b.processing
    FROM shipping_positioned AS b
    WHERE b.quantity > 0 AND b.previous_quantity < b.domain_quantity
  ), unshipped AS (
    SELECT i.*, COALESCE(sh.quantity, 0)::integer AS shipped,
           GREATEST(i.quantity - COALESCE(sh.quantity, 0), 0)::integer AS remaining,
           COALESCE(r.covered, 0)::integer AS refunded, COALESCE(r.processing, 0)::integer AS processing,
           COALESCE(c.quantity, 0)::integer AS requested
    FROM items AS i
    LEFT JOIN (SELECT s.order_item_id, pg_catalog.sum(s.quantity) AS quantity FROM shipments AS s GROUP BY s.order_item_id) AS sh
      ON sh.order_item_id = i.order_item_id
    LEFT JOIN (SELECT r.order_item_id, pg_catalog.sum(r.covered) AS covered, pg_catalog.sum(r.processing) AS processing
               FROM refunds AS r WHERE r.before_shipment GROUP BY r.order_item_id) AS r ON r.order_item_id = i.order_item_id
    CROSS JOIN LATERAL (
      SELECT pg_catalog.sum(l.quantity) AS quantity FROM public.order_cancel_request_lines AS l
      JOIN public.order_cancel_requests AS cr ON cr.id = l.cancel_request_id AND cr.status = 'requested'
      WHERE l.order_item_id = i.order_item_id
    ) AS c
  ), unshipped_counts AS (
    SELECT u.*, CASE WHEN u.order_status = 'cancelled' AND NOT u.paid AND u.shipped = 0 AND u.allocated = 0
                      THEN u.remaining ELSE LEAST(u.remaining, u.refunded) END AS cancelled,
           (u.paid OR u.shipped > 0 OR u.allocated > 0) AS is_paid
    FROM unshipped AS u
  ), unshipped_points AS (
    SELECT u.*, p.point, pg_catalog.lead(p.point) OVER (PARTITION BY u.order_item_id ORDER BY p.point) AS next_point
    FROM unshipped_counts AS u CROSS JOIN LATERAL (
      SELECT DISTINCT v.point FROM (VALUES (0), (u.remaining), (u.cancelled),
        (LEAST(u.cancelled, u.processing)), (LEAST(u.remaining, u.cancelled + u.requested)),
        (GREATEST(u.remaining - u.allocated, 0))) AS v(point)
    ) AS p
  ), unshipped_ranges AS (
    SELECT u.order_id, u.order_item_id,
           CASE WHEN u.point < u.cancelled THEN 'cancelled'
                WHEN u.point < u.cancelled + u.requested THEN 'cancel_requested'
                WHEN NOT u.is_paid AND u.order_status = 'failed' AND u.failed_reason = 'stripe_voucher_expired' THEN 'payment_expired'
                WHEN NOT u.is_paid THEN 'unpaid'
                WHEN u.point >= GREATEST(u.remaining - u.allocated, 0) THEN 'ready'
                ELSE 'in_production' END AS status,
           (u.shipped + u.point)::integer AS unit_from, (u.shipped + u.next_point)::integer AS unit_to,
           (u.point < LEAST(u.cancelled, u.processing)) AS processing
    FROM unshipped_points AS u WHERE u.next_point > u.point
  ), all_ranges AS (
    SELECT * FROM shipped_ranges UNION ALL SELECT * FROM unshipped_ranges
  ), blocked AS (
    SELECT r.*, pg_catalog.array_remove(ARRAY[
      CASE WHEN i.variant_id IS NULL THEN 'variant_missing' END,
      CASE WHEN i.review_hold THEN 'payment_review' END,
      CASE WHEN i.fee_waiting THEN 'exchange_fee_waiting' END,
      CASE WHEN r.status = 'cancel_requested' THEN 'cancel_requested' END,
      CASE WHEN r.processing THEN 'refund_processing' END,
      CASE WHEN r.status = 'in_production' AND i.variant_id IS NOT NULL
                  AND NOT i.review_hold AND NOT i.fee_waiting THEN 'stock_shortage' END
    ]::text[], NULL) AS reasons
    FROM all_ranges AS r JOIN items AS i ON i.order_item_id = r.order_item_id
  ), marked AS (
    SELECT b.*, CASE WHEN pg_catalog.lag(b.status) OVER w = b.status
                         AND pg_catalog.lag(b.reasons) OVER w = b.reasons
                         AND pg_catalog.lag(b.unit_to) OVER w = b.unit_from THEN 0 ELSE 1 END AS boundary
    FROM blocked AS b WINDOW w AS (PARTITION BY b.order_item_id ORDER BY b.unit_from)
  ), islands AS (
    SELECT m.*, pg_catalog.sum(m.boundary) OVER (PARTITION BY m.order_item_id ORDER BY m.unit_from) AS island
    FROM marked AS m
  )
  SELECT r.order_id, r.order_item_id, r.status, pg_catalog.min(r.unit_from), pg_catalog.max(r.unit_to), r.reasons
  FROM islands AS r GROUP BY r.order_id, r.order_item_id, r.status, r.reasons, r.island
  ORDER BY r.order_id, r.order_item_id, pg_catalog.min(r.unit_from);
END;
$$;
ALTER FUNCTION private.group_g_item_state_ranges(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_item_state_ranges(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.list_admin_order_item_states(_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_item_id uuid, status text, quantity integer, blocked_reasons text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Bound only the service-role read entry; inventory/history cores accept the complete lock set.
  IF pg_catalog.cardinality(_order_ids) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_ORDERS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT r.order_id, r.order_item_id, r.status, pg_catalog.sum(r.unit_to - r.unit_from)::integer, r.blocked_reasons
  FROM private.group_g_item_state_ranges(_order_ids) AS r
  GROUP BY r.order_id, r.order_item_id, r.status, r.blocked_reasons
  ORDER BY r.order_id, r.order_item_id, r.status, r.blocked_reasons;
END;
$$;
ALTER FUNCTION private.list_admin_order_item_states(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_order_item_states(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_order_item_states(uuid[]) TO service_role;

CREATE FUNCTION public.list_admin_order_item_states(_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_item_id uuid, status text, quantity integer, blocked_reasons text[])
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_order_item_states(_order_ids) $$;
ALTER FUNCTION public.list_admin_order_item_states(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_order_item_states(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_order_item_states(uuid[]) TO service_role;

CREATE FUNCTION private.capture_group_g_item_states(_order_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.order_id, r.order_item_id, r.unit_from), '[]'::jsonb)
  FROM private.group_g_item_state_ranges(_order_ids) AS r
$$;
ALTER FUNCTION private.capture_group_g_item_states(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.capture_group_g_item_states(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- 呼出元が共通lockと全対象の事前lockを持ち、原因の変更と同じ取引でbefore/afterを一度だけ記録する。
CREATE FUNCTION private.record_group_g_item_state_changes(
  _before jsonb, _order_ids uuid[], _operation_id uuid, _sequence integer, _reason text, _actor_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF _operation_id IS NULL OR _sequence IS NULL OR _sequence <= 0
     OR _before IS NULL OR pg_catalog.jsonb_typeof(_before) <> 'array' THEN
    RAISE EXCEPTION 'GROUP_G_STATE_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  WITH before_ranges AS MATERIALIZED (
    SELECT b.* FROM pg_catalog.jsonb_to_recordset(_before)
      AS b(order_id uuid, order_item_id uuid, status text, unit_from integer, unit_to integer)
    JOIN public.order_items AS oi ON oi.id = b.order_item_id AND oi.order_id = b.order_id
    WHERE b.order_id = ANY(_order_ids)
  ), after_ranges AS MATERIALIZED (
    SELECT * FROM private.group_g_item_state_ranges(_order_ids)
  ), points AS (
    SELECT b.order_item_id, b.unit_from AS point FROM before_ranges AS b
    UNION SELECT b.order_item_id, b.unit_to FROM before_ranges AS b
    UNION SELECT a.order_item_id, a.unit_from FROM after_ranges AS a
    UNION SELECT a.order_item_id, a.unit_to FROM after_ranges AS a
  ), segments AS (
    SELECT p.*, pg_catalog.lead(p.point) OVER (PARTITION BY p.order_item_id ORDER BY p.point) AS next_point
    FROM points AS p
  ), compared AS (
    SELECT s.*, b.status AS from_status, a.status AS to_status
    FROM segments AS s
    LEFT JOIN before_ranges AS b ON b.order_item_id = s.order_item_id AND b.unit_from <= s.point AND b.unit_to > s.point
    LEFT JOIN after_ranges AS a ON a.order_item_id = s.order_item_id AND a.unit_from <= s.point AND a.unit_to > s.point
    WHERE s.next_point > s.point
  ), marked AS (
    SELECT c.*, CASE WHEN pg_catalog.lag(c.from_status) OVER w IS NOT DISTINCT FROM c.from_status
                         AND pg_catalog.lag(c.to_status) OVER w IS NOT DISTINCT FROM c.to_status
                         AND pg_catalog.lag(c.next_point) OVER w = c.point THEN 0 ELSE 1 END AS boundary
    FROM compared AS c WHERE c.from_status IS DISTINCT FROM c.to_status
    WINDOW w AS (PARTITION BY c.order_item_id ORDER BY c.point)
  ), islands AS (
    SELECT m.*, pg_catalog.sum(m.boundary) OVER (PARTITION BY m.order_item_id ORDER BY m.point) AS island
    FROM marked AS m
  ), changes AS (
    SELECT i.order_item_id, i.from_status, i.to_status, pg_catalog.min(i.point) AS unit_from,
           pg_catalog.max(i.next_point) AS unit_to
    FROM islands AS i GROUP BY i.order_item_id, i.from_status, i.to_status, i.island
  ), numbered AS (
    SELECT c.*, COALESCE((SELECT pg_catalog.max(e.version) FROM public.order_item_state_events AS e
                         WHERE e.order_item_id = c.order_item_id), 0)
      + pg_catalog.row_number() OVER (PARTITION BY c.order_item_id ORDER BY c.unit_from) AS version
    FROM changes AS c
    WHERE NOT EXISTS (SELECT 1 FROM public.order_item_state_events AS e
      WHERE e.operation_id = _operation_id AND e.order_item_id = c.order_item_id AND e.sequence = _sequence)
  )
  INSERT INTO public.order_item_state_events
    (order_item_id, unit_from, unit_to, from_status, to_status, operation_id, sequence, reason, actor_id, version)
  SELECT n.order_item_id, n.unit_from, n.unit_to, n.from_status, n.to_status, _operation_id, _sequence,
         _reason, _actor_id, n.version
  FROM numbered AS n ORDER BY n.order_item_id, n.unit_from;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
ALTER FUNCTION private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- 最終assert区間は触らず、Task 3の追加物はbody内で検査する。
DO $g1_states_assert$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.group_g_item_state_ranges(uuid[])'),
    pg_catalog.to_regprocedure('private.list_admin_order_item_states(uuid[])'),
    pg_catalog.to_regprocedure('public.list_admin_order_item_states(uuid[])'),
    pg_catalog.to_regprocedure('private.capture_group_g_item_states(uuid[])'),
    pg_catalog.to_regprocedure('private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)')
  ) AND p.proowner = 'postgres'::regrole AND p.proconfig @> ARRAY['search_path=""']) <> 5 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_states_functions';
  END IF;
END;
$g1_states_assert$;

-- 11. Task 2 の確かめ: 新しい 4 表（空・RLS・所有者）、足した 2 列、操作への遅延の外部キー、台帳の理由、12 のトリガー。
--     違えば GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 で全部を戻す（全体の期待一覧は最後の確かめが Task 14 で持つ）
-- Task 4. Every business writer calls this once, before any row write/lock.
-- Close the target set by reads only; never discover another variant after locking orders.
CREATE FUNCTION private.lock_group_g_inventory(
  _variant_ids bigint[], _order_ids uuid[], _draft_id uuid DEFAULT NULL
) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_variants bigint[] := ARRAY[]::bigint[];
  v_orders uuid[] := ARRAY[]::uuid[];
  v_previous_variants bigint[];
  v_previous_orders uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);
  -- Discover the active closure using reads only, before taking even the draft row lock.
  SELECT COALESCE(pg_catalog.array_agg(v.id ORDER BY v.id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.item_variants AS v WHERE v.id = ANY(_variant_ids);
  SELECT COALESCE(pg_catalog.array_agg(o.id ORDER BY o.id), ARRAY[]::uuid[]) INTO v_orders
  FROM public.orders AS o WHERE o.id = ANY(_order_ids);
  LOOP
    v_previous_variants := v_variants;
    v_previous_orders := v_orders;
    SELECT COALESCE(pg_catalog.array_agg(x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
    FROM (
      SELECT pg_catalog.unnest(v_variants) AS id
      UNION SELECT oi.variant_id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders) AND oi.variant_id IS NOT NULL
      UNION SELECT a.variant_id FROM public.order_item_allocations AS a
        JOIN public.order_items AS oi ON oi.id = a.order_item_id WHERE oi.order_id = ANY(v_orders)
      UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l
        JOIN public.order_returns AS r ON r.id = l.return_id
        WHERE r.order_id = ANY(v_orders) AND r.status IN ('requested', 'open') AND l.exchange_variant_id IS NOT NULL
      UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l
        JOIN public.order_returns AS r ON r.id = l.return_id
        WHERE r.order_id = ANY(v_orders) AND r.status IN ('requested', 'open') AND l.requested_exchange_variant_id IS NOT NULL
    ) AS x;
    -- A historical match on a variant does not make an order an inventory target.
    -- Explicit targets remain in v_orders; only mutable neighbours may extend it.
    WITH related AS MATERIALIZED (
      SELECT oi.order_id AS id FROM public.order_items AS oi WHERE oi.variant_id = ANY(v_variants)
      UNION SELECT oi.order_id FROM public.order_item_allocations AS a
        JOIN public.order_items AS oi ON oi.id = a.order_item_id
        WHERE a.variant_id = ANY(v_variants) AND a.remaining_quantity > 0
      UNION SELECT r.order_id FROM public.order_return_lines AS l
        JOIN public.order_returns AS r ON r.id = l.return_id
        WHERE r.status IN ('requested', 'open')
          AND (l.exchange_variant_id = ANY(v_variants) OR l.requested_exchange_variant_id = ANY(v_variants))
    )
    SELECT COALESCE(pg_catalog.array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_orders
    FROM (
      SELECT pg_catalog.unnest(v_orders) AS id
      UNION SELECT o.id FROM related AS target JOIN public.orders AS o ON o.id = target.id
      WHERE o.status IN ('payment_in_progress', 'pending')
        OR (o.status = 'failed' AND COALESCE((
          SELECT r.reason FROM public.order_revisions AS r
          WHERE r.order_id = o.id AND 'status' = ANY(r.changed_fields) AND r.after_data->>'status' = 'failed'
          ORDER BY r.changed_at DESC, r.id DESC LIMIT 1
        ), '') <> 'stripe_voucher_expired')
        OR (o.status = 'paid' AND (
          EXISTS (SELECT 1 FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
            WHERE oi.order_id = o.id AND a.variant_id = ANY(v_variants) AND a.remaining_quantity > 0)
          OR EXISTS (SELECT 1 FROM private.order_line_fulfillment(o.id) AS f
            WHERE f.variant_id = ANY(v_variants) AND f.in_production > 0)
        ))
        OR (o.status = 'shipped' AND (
          EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.order_id = o.id AND r.status IN ('requested', 'open'))
          OR EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.order_id = o.id AND r.status IN ('awaiting_response', 'pending', 'error'))
          OR EXISTS (SELECT 1 FROM public.order_cancel_requests AS r WHERE r.order_id = o.id AND r.status = 'requested')
          -- A failed/error pre-shipment refund returns its units to waiting on a shipped order.
          OR (EXISTS (SELECT 1 FROM public.order_refund_lines AS rl JOIN public.order_refunds AS r ON r.id = rl.refund_id
                WHERE r.order_id = o.id AND rl.before_shipment AND r.status IN ('error', 'failed'))
              AND EXISTS (SELECT 1 FROM private.order_line_fulfillment(o.id) AS f
                WHERE f.variant_id = ANY(v_variants) AND f.in_production > 0))
        ))
        -- Whoever still holds a remaining A/H on a target variant is a target, whatever its status.
        OR EXISTS (SELECT 1 FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
          WHERE oi.order_id = o.id AND a.variant_id = ANY(v_variants) AND a.remaining_quantity > 0)
    ) AS x;
    EXIT WHEN v_variants = v_previous_variants AND v_orders = v_previous_orders;
  END LOOP;

  IF _draft_id IS NOT NULL THEN
    PERFORM d.id FROM public.checkout_drafts AS d WHERE d.id = _draft_id FOR UPDATE;
  END IF;
  PERFORM i.id FROM public.items AS i
    WHERE i.id IN (SELECT v.item_id FROM public.item_variants AS v WHERE v.id = ANY(v_variants)
                   UNION SELECT oi.item_id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders))
    ORDER BY i.id FOR KEY SHARE;
  PERFORM v.id FROM public.item_variants AS v WHERE v.id = ANY(v_variants) ORDER BY v.id FOR UPDATE;
  PERFORM o.id FROM public.orders AS o WHERE o.id = ANY(v_orders) ORDER BY o.id FOR UPDATE;
  PERFORM oi.id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders) ORDER BY oi.id FOR UPDATE;
  PERFORM a.id FROM public.order_item_allocations AS a
    WHERE a.order_item_id IN (SELECT oi.id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders))
    ORDER BY a.id FOR UPDATE;
  PERFORM r.id FROM public.order_returns AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
  PERFORM l.id FROM public.order_return_lines AS l
    WHERE l.return_id IN (SELECT r.id FROM public.order_returns AS r WHERE r.order_id = ANY(v_orders))
    ORDER BY l.id FOR UPDATE;
  PERFORM r.id FROM public.order_return_receipts AS r
    WHERE r.return_id IN (SELECT x.id FROM public.order_returns AS x WHERE x.order_id = ANY(v_orders))
    ORDER BY r.id FOR UPDATE;
  PERFORM l.id FROM public.order_return_receipt_lines AS l
    WHERE l.receipt_id IN (SELECT r.id FROM public.order_return_receipts AS r
      JOIN public.order_returns AS x ON x.id = r.return_id WHERE x.order_id = ANY(v_orders))
    ORDER BY l.id FOR UPDATE;
  PERFORM r.id FROM public.order_refunds AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
  PERFORM l.id FROM public.order_refund_lines AS l
    WHERE l.refund_id IN (SELECT r.id FROM public.order_refunds AS r WHERE r.order_id = ANY(v_orders))
    ORDER BY l.id FOR UPDATE;
  PERFORM r.id FROM public.order_cancel_requests AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
  PERFORM l.id FROM public.order_cancel_request_lines AS l
    WHERE l.cancel_request_id IN (SELECT r.id FROM public.order_cancel_requests AS r WHERE r.order_id = ANY(v_orders))
    ORDER BY l.id FOR UPDATE;

  -- Auxiliary rows follow the complete inventory/return/refund/request set.
  PERFORM f.id FROM public.order_fulfillments AS f WHERE f.order_id = ANY(v_orders) ORDER BY f.id FOR UPDATE;
  PERFORM e.id FROM public.payment_exceptions AS e WHERE e.order_id = ANY(v_orders) ORDER BY e.id FOR UPDATE;
  RETURN v_orders;
END;
$$;
ALTER FUNCTION private.lock_group_g_inventory(bigint[],uuid[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_group_g_inventory(bigint[],uuid[],uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Internal core: the caller already owns the entire row set. No lock acquisition, public RPC or I/O here.
CREATE FUNCTION private.allocate_group_g_fifo(_variant_ids bigint[], _operation_id uuid, _actor_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_line record;
  v_free integer;
  v_quantity integer;
  v_allocation uuid;
  v_movement bigint;
  v_total integer := 0;
  v_refund_id uuid;
  v_return_id uuid;
BEGIN
  IF _operation_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  FOR v_line IN
    -- Canonical fulfillment quantities cheaply prefilter the waiting set. MATERIALIZED
    -- prevents the detailed 12-state projection from running on closed order history.
    WITH waiting_orders AS MATERIALIZED (
      SELECT o.id FROM public.orders AS o
      WHERE o.status IN ('paid', 'shipped')
        AND EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.order_id = o.id AND oi.variant_id = ANY(_variant_ids))
        AND (o.status = 'paid'
          OR EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.order_id = o.id AND r.status IN ('requested', 'open'))
          OR EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.order_id = o.id AND r.status IN ('awaiting_response', 'pending', 'error'))
          OR EXISTS (SELECT 1 FROM public.order_cancel_requests AS r WHERE r.order_id = o.id AND r.status = 'requested')
          OR EXISTS (SELECT 1 FROM public.order_refund_lines AS rl JOIN public.order_refunds AS r ON r.id = rl.refund_id
            WHERE r.order_id = o.id AND rl.before_shipment AND r.status IN ('error', 'failed')))
        AND EXISTS (SELECT 1 FROM private.order_line_fulfillment(o.id) AS f
          WHERE f.variant_id = ANY(_variant_ids) AND f.in_production > 0)
    )
    SELECT o.id AS order_id, oi.id AS order_item_id, oi.variant_id, oi.exchange_return_line_id,
           pg_catalog.sum(s.unit_to - s.unit_from)::integer AS unallocated
    FROM waiting_orders AS w JOIN public.orders AS o ON o.id = w.id
    JOIN public.order_items AS oi ON oi.order_id = o.id
    CROSS JOIN LATERAL private.group_g_item_state_ranges(ARRAY[o.id]) AS s
    WHERE oi.variant_id = ANY(_variant_ids) AND o.status IN ('paid', 'shipped')
      AND s.order_item_id = oi.id AND s.status = 'in_production'
      AND s.blocked_reasons = ARRAY['stock_shortage']::text[]
      AND NOT EXISTS (SELECT 1 FROM public.order_item_allocations AS h
                      WHERE h.order_item_id = oi.id AND h.kind = 'payment_hold' AND h.remaining_quantity > 0)
    GROUP BY o.id, o.created_at, oi.id
    ORDER BY o.created_at, o.id, oi.id
  LOOP
    SELECT v.stock_quantity INTO v_free FROM public.item_variants AS v WHERE v.id = v_line.variant_id;
    v_quantity := LEAST(v_line.unallocated, v_free);
    CONTINUE WHEN v_quantity IS NULL OR v_quantity <= 0;
    -- A refund release can precede the final operation row; keep its tagged origin.
    -- Exchange allocations also retain their original return when receipt/FIFO share an operation.
    SELECT COALESCE(m.refund_id, r.id), COALESCE(m.return_id, ret.id, r.return_id, rl.return_id)
      INTO v_refund_id, v_return_id
    FROM (SELECT 1) AS source
    LEFT JOIN LATERAL (SELECT x.refund_id, x.return_id FROM public.stock_movements AS x
      WHERE x.allocation_operation_id = _operation_id AND (x.refund_id IS NOT NULL OR x.return_id IS NOT NULL)
      ORDER BY x.id LIMIT 1) AS m ON true
    LEFT JOIN private.group_g_operations AS op ON op.id = _operation_id
    LEFT JOIN public.order_refunds AS r ON op.cause_type IN ('refund', 'order_refund') AND r.id::text = op.cause_id
    LEFT JOIN public.order_return_lines AS rl ON rl.id = v_line.exchange_return_line_id
    LEFT JOIN public.order_returns AS ret ON op.cause_type IN ('return', 'order_return') AND ret.id::text = op.cause_id;
    INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, allocation_operation_id, created_by, refund_id, return_id)
    VALUES (v_line.variant_id, -v_quantity,
      CASE WHEN v_line.exchange_return_line_id IS NULL THEN 'purchase' ELSE 'exchange' END,
      v_line.order_id, v_line.order_item_id, _operation_id, _actor_id, v_refund_id, v_return_id)
    RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
    VALUES (v_line.order_item_id, v_line.variant_id, v_quantity, v_quantity, 'paid', _operation_id)
    RETURNING id INTO v_allocation;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
    VALUES (v_allocation, 'allocate', v_quantity, _operation_id, 1, v_movement, 'fifo', _actor_id);
    v_total := v_total + v_quantity;
  END LOOP;
  RETURN v_total;
END;
$$;
ALTER FUNCTION private.allocate_group_g_fifo(bigint[],uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.allocate_group_g_fifo(bigint[],uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Only the existing ledger trigger changes F. The caller must prelock before INSERT;
-- neither this core nor its trigger wrapper takes a late advisory/explicit row lock or calls FIFO.
CREATE FUNCTION private.apply_group_g_stock_movement(_variant_id bigint, _delta integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.item_variants AS v
  SET stock_quantity = v.stock_quantity + _delta, updated_at = pg_catalog.now()
  WHERE v.id = _variant_id;
END;
$$;
ALTER FUNCTION private.apply_group_g_stock_movement(bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.apply_group_g_stock_movement(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  PERFORM private.apply_group_g_stock_movement(NEW.variant_id, NEW.delta);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.apply_stock_movement() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_stock_movement() FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT ON TABLE public.stock_movements FROM service_role;
REVOKE USAGE ON SEQUENCE public.stock_movements_id_seq FROM service_role;

-- Reverse link: every tagged ledger row has exactly one event (the existing UNIQUE
-- stock_movement_id supplies at most one). Check the final transaction, including its item.
-- Ordinary receipts use allocation_operation_id=NULL; their separate purchase/exchange is tagged.
CREATE FUNCTION private.check_group_g_stock_movement_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.allocation_operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.order_item_allocation_events AS e
    JOIN public.order_item_allocations AS a ON a.id = e.allocation_id
    JOIN public.order_items AS oi ON oi.id = a.order_item_id
    WHERE e.stock_movement_id = NEW.id AND e.operation_id = NEW.allocation_operation_id
      AND a.variant_id = NEW.variant_id AND a.order_item_id = NEW.order_item_id
      AND (NEW.order_id IS NULL OR NEW.order_id = oi.order_id)
      AND ((e.event_type IN ('hold', 'allocate', 'restore') AND NEW.delta = -e.quantity AND NEW.reason IN ('purchase', 'exchange'))
        OR (e.event_type = 'release' AND NEW.delta = e.quantity AND NEW.reason IN ('cancel', 'refund', 'allocation_release')))
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ALLOCATION_BOUNDS' USING ERRCODE = '23514', DETAIL = 'stock_movement';
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.check_group_g_stock_movement_consistency() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_group_g_stock_movement_consistency() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER group_g_stock_movement_consistency AFTER INSERT ON public.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_group_g_stock_movement_consistency();

DO $g1_fifo_assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.stock_movements'::regclass AND t.tgname = 'stock_movements_apply'
      AND t.tgfoid = 'public.apply_stock_movement()'::regprocedure AND t.tgtype = 5 AND t.tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.stock_movements'::regclass AND t.tgname = 'group_g_stock_movement_consistency'
        AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O')
    OR pg_catalog.has_table_privilege('service_role', 'public.stock_movements', 'INSERT')
    OR pg_catalog.has_sequence_privilege('service_role', 'public.stock_movements_id_seq', 'USAGE')
    OR (SELECT p.prosecdef FROM pg_catalog.pg_proc AS p WHERE p.oid = 'public.apply_stock_movement()'::regprocedure)
  THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_fifo';
  END IF;
END;
$g1_fifo_assert$;

-- Task 5: canonical inventory snapshot, compatible projections, stock entry and history.
CREATE FUNCTION private.list_group_g_variant_inventory(_variant_ids bigint[])
RETURNS TABLE(variant_id bigint, free integer, paid_allocated integer, payment_held integer, on_hand integer, waiting integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _variant_ids IS NULL OR pg_catalog.cardinality(_variant_ids) = 0 THEN RETURN; END IF;
  IF pg_catalog.cardinality(_variant_ids) > 500 THEN
    RAISE EXCEPTION 'TOO_MANY_VARIANTS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH wanted AS MATERIALIZED (
    SELECT v.id, v.stock_quantity FROM public.item_variants AS v WHERE v.id = ANY(_variant_ids)
  ), allocations AS (
    SELECT a.variant_id,
      COALESCE(pg_catalog.sum(a.remaining_quantity) FILTER (WHERE a.kind = 'paid'), 0)::integer AS paid,
      COALESCE(pg_catalog.sum(a.remaining_quantity) FILTER (WHERE a.kind = 'payment_hold'), 0)::integer AS held
    FROM public.order_item_allocations AS a WHERE a.variant_id IN (SELECT w.id FROM wanted AS w)
    GROUP BY a.variant_id
  ), production AS (
    SELECT oi.variant_id, pg_catalog.sum(s.unit_to - s.unit_from)::integer AS quantity
    FROM private.group_g_item_state_ranges(ARRAY(
      SELECT DISTINCT oi.order_id FROM public.order_items AS oi WHERE oi.variant_id IN (SELECT w.id FROM wanted AS w)
    )) AS s JOIN public.order_items AS oi ON oi.id = s.order_item_id
    WHERE s.status = 'in_production' GROUP BY oi.variant_id
  )
  SELECT w.id, w.stock_quantity, COALESCE(a.paid, 0), COALESCE(a.held, 0),
    w.stock_quantity + COALESCE(a.paid, 0) + COALESCE(a.held, 0), COALESCE(p.quantity, 0)
  FROM wanted AS w LEFT JOIN allocations AS a ON a.variant_id = w.id
  LEFT JOIN production AS p ON p.variant_id = w.id ORDER BY w.id;
END;
$$;
ALTER FUNCTION private.list_group_g_variant_inventory(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_group_g_variant_inventory(bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_group_g_variant_inventory(bigint[]) TO service_role;

CREATE FUNCTION public.list_group_g_variant_inventory(_variant_ids bigint[])
RETURNS TABLE(variant_id bigint, free integer, paid_allocated integer, payment_held integer, on_hand integer, waiting integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_group_g_variant_inventory(_variant_ids); $$;
ALTER FUNCTION public.list_group_g_variant_inventory(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_group_g_variant_inventory(bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_group_g_variant_inventory(bigint[]) TO service_role;

-- Replace the last E-3 reservation and E-2 fulfillment definitions. Remaining A/H
-- already exclude consumption; subtracting shipped again would undercount them.
CREATE OR REPLACE FUNCTION private.order_line_reservations(_order_id uuid)
RETURNS TABLE(order_item_id uuid, variant_id bigint, quantity integer, reserved integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT oi.id, oi.variant_id, oi.quantity, COALESCE(pg_catalog.sum(a.remaining_quantity), 0)::integer
  FROM public.order_items AS oi LEFT JOIN public.order_item_allocations AS a ON a.order_item_id = oi.id
  WHERE oi.order_id = _order_id GROUP BY oi.id;
$$;
ALTER FUNCTION private.order_line_reservations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_line_reservations(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.order_line_fulfillment(_order_id uuid)
RETURNS TABLE(order_item_id uuid, variant_id bigint, fulfillment_type text, quantity integer, shipped integer,
  completed integer, refunded_before_shipment integer, refunded_after_shipment integer,
  in_production integer, ready_unshipped integer, unshipped integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH counted AS (
    SELECT oi.id, oi.variant_id, oi.fulfillment_type, oi.quantity, o.status,
      COALESCE((SELECT pg_catalog.sum(fl.quantity) FROM public.order_fulfillment_lines AS fl
        JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
        WHERE fl.order_item_id = oi.id AND f.cancelled_at IS NULL), 0)::integer AS shipped,
      COALESCE((SELECT pg_catalog.sum(a.remaining_quantity) FROM public.order_item_allocations AS a
        WHERE a.order_item_id = oi.id AND a.kind = 'paid'), 0)::integer AS paid,
      COALESCE((SELECT pg_catalog.sum(rl.quantity) FROM public.order_refund_lines AS rl
        JOIN public.order_refunds AS r ON r.id = rl.refund_id WHERE rl.order_item_id = oi.id
        AND rl.before_shipment AND r.status IN ('awaiting_response', 'pending', 'succeeded')), 0)::integer AS refunded_before,
      COALESCE((SELECT pg_catalog.sum(rl.quantity) FROM public.order_refund_lines AS rl
        JOIN public.order_refunds AS r ON r.id = rl.refund_id WHERE rl.order_item_id = oi.id
        AND NOT rl.before_shipment AND r.status IN ('awaiting_response', 'pending', 'succeeded')), 0)::integer AS refunded_after
    FROM public.order_items AS oi JOIN public.orders AS o ON o.id = oi.order_id WHERE oi.order_id = _order_id
  ), quantities AS (
    SELECT c.*, GREATEST(c.quantity - c.shipped - c.refunded_before, 0) AS unshipped,
      CASE WHEN c.status IN ('paid', 'shipped') THEN LEAST(c.paid, GREATEST(c.quantity - c.shipped - c.refunded_before, 0))
        ELSE 0 END AS ready FROM counted AS c
  )
  SELECT c.id, c.variant_id, c.fulfillment_type, c.quantity, c.shipped, c.shipped + c.paid,
    c.refunded_before, c.refunded_after,
    CASE WHEN c.status IN ('paid', 'shipped') THEN c.unshipped - c.ready ELSE 0 END, c.ready, c.unshipped
  FROM quantities AS c;
$$;
ALTER FUNCTION private.order_line_fulfillment(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_line_fulfillment(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.check_order_line_fulfillment_bounds() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_order_id uuid; v_broken boolean;
BEGIN
  SELECT oi.order_id INTO v_order_id FROM public.order_items AS oi WHERE oi.id = NEW.order_item_id;
  SELECT NOT (l.shipped + l.refunded_before_shipment <= l.quantity
    AND l.refunded_after_shipment <= l.shipped AND l.shipped <= l.completed AND l.completed <= l.quantity)
    INTO v_broken FROM private.order_line_fulfillment(v_order_id) AS l WHERE l.order_item_id = NEW.order_item_id;
  IF v_broken THEN RAISE EXCEPTION 'FULFILLMENT_BOUNDS_VIOLATED' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.check_order_line_fulfillment_bounds() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_order_line_fulfillment_bounds() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_variant_stock_states(_variant_ids bigint[])
RETURNS TABLE(variant_id bigint, committed integer, backorder integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT s.variant_id, s.paid_allocated + s.payment_held, s.waiting
  FROM private.list_group_g_variant_inventory(_variant_ids) AS s; $$;
ALTER FUNCTION public.list_variant_stock_states(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_variant_stock_states(bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_variant_stock_states(bigint[]) TO service_role;

CREATE FUNCTION private.list_item_stock_history(_item_id bigint, _limit integer)
RETURNS TABLE(movement_id bigint, variant_id bigint, delta integer, reason text, note text, created_at timestamptz,
  actor_email text, order_id uuid, balance_after integer, refund_id uuid, return_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT h.id, h.variant_id, h.delta, h.reason, h.note, h.created_at, h.actor_email, h.order_id,
    h.balance_after, h.refund_id, h.return_id
  FROM (
    SELECT m.id, m.variant_id, m.delta, m.reason, m.note, m.created_at, u.email::text AS actor_email, m.order_id,
      (v.stock_quantity - COALESCE(pg_catalog.sum(m.delta) OVER (PARTITION BY m.variant_id ORDER BY m.id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))::integer AS balance_after, m.refund_id, m.return_id
    FROM public.stock_movements AS m JOIN public.item_variants AS v ON v.id = m.variant_id
    LEFT JOIN auth.users AS u ON u.id = m.created_by WHERE v.item_id = _item_id
  ) AS h ORDER BY h.id DESC LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200);
$$;
ALTER FUNCTION private.list_item_stock_history(bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_item_stock_history(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_item_stock_history(bigint,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.list_item_stock_history(_item_id bigint, _limit integer)
RETURNS TABLE(movement_id bigint, variant_id bigint, delta integer, reason text, note text, created_at timestamptz,
  actor_email text, order_id uuid, balance_after integer, refund_id uuid, return_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_item_stock_history(_item_id, _limit); $$;
ALTER FUNCTION public.list_item_stock_history(bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_item_stock_history(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_item_stock_history(bigint,integer) TO service_role;

CREATE FUNCTION private.list_item_allocation_history(_item_id bigint, _limit integer)
RETURNS TABLE(event_id uuid, allocation_id uuid, order_id uuid, order_item_id uuid, variant_id bigint,
  event_type text, quantity integer, operation_id uuid, counterpart_allocation_id uuid, reverses_event_id uuid,
  stock_movement_id bigint, reason text, actor_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.id, e.allocation_id, oi.order_id, a.order_item_id, a.variant_id, e.event_type, e.quantity,
    e.operation_id, e.counterpart_allocation_id, e.reverses_event_id, e.stock_movement_id, e.reason, e.actor_id, e.created_at
  FROM public.order_item_allocation_events AS e JOIN public.order_item_allocations AS a ON a.id = e.allocation_id
  JOIN public.order_items AS oi ON oi.id = a.order_item_id JOIN public.item_variants AS v ON v.id = a.variant_id
  WHERE v.item_id = _item_id ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200);
$$;
ALTER FUNCTION private.list_item_allocation_history(bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_item_allocation_history(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_item_allocation_history(bigint,integer) TO service_role;

CREATE FUNCTION public.list_item_allocation_history(_item_id bigint, _limit integer)
RETURNS TABLE(event_id uuid, allocation_id uuid, order_id uuid, order_item_id uuid, variant_id bigint,
  event_type text, quantity integer, operation_id uuid, counterpart_allocation_id uuid, reverses_event_id uuid,
  stock_movement_id bigint, reason text, actor_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_item_allocation_history(_item_id, _limit); $$;
ALTER FUNCTION public.list_item_allocation_history(bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_item_allocation_history(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_item_allocation_history(bigint,integer) TO service_role;

CREATE FUNCTION private.admin_record_stock_movement(_item_id bigint, _variant_id bigint, _delta integer, _reason text,
  _note text, _actor_id uuid, _request_key uuid, _expected_release_quantity integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_note text := NULLIF(pg_catalog.regexp_replace(_note, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_free integer;
  v_paid integer;
  v_allocation record;
  v_release integer := 0;
  v_remaining integer;
  v_quantity integer;
  v_release_movement bigint;
  v_movement bigint;
  v_allocated integer;
  v_result jsonb;
BEGIN
  IF _item_id IS NULL OR _variant_id IS NULL OR _item_id <= 0 OR _variant_id <= 0 OR _delta IS NULL OR _delta = 0
    OR _reason IS NULL OR _reason NOT IN ('restock', 'adjustment') OR (_reason = 'restock' AND _delta < 0)
    OR _actor_id IS NULL OR _request_key IS NULL OR pg_catalog.length(v_note) > 200
    OR _expected_release_quantity < 0 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[_variant_id], ARRAY[]::uuid[], NULL);
  IF NOT EXISTS (SELECT 1 FROM public.user_roles AS ur JOIN public.roles AS r ON r.id = ur.role_id
    JOIN public.role_permissions AS rp ON rp.role_id = r.id JOIN public.permissions AS p ON p.id = rp.permission_id
    WHERE ur.user_id = _actor_id AND ur.active AND (ur.expires_at IS NULL OR ur.expires_at > pg_catalog.now())
      AND p.code = 'admin.items.manage') THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'stock_move', 'item_id', _item_id, 'variant_ids', ARRAY[_variant_id], 'delta', _delta,
    'reason', _reason, 'note', v_note, 'actor_id', _actor_id, 'expected_release_quantity', _expected_release_quantity)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op WHERE op.operation = 'stock_move' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.item_variants AS v WHERE v.id = _variant_id AND v.item_id = _item_id) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- F and the releasable A are read directly under the lock (no projection of historical orders).
  -- Only allocations of locked orders count, so the release loop below never touches an unlocked order.
  SELECT v.stock_quantity INTO v_free FROM public.item_variants AS v WHERE v.id = _variant_id;
  SELECT COALESCE(pg_catalog.sum(a.remaining_quantity), 0)::integer INTO v_paid
  FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
  WHERE a.variant_id = _variant_id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders);
  IF _delta < 0 THEN
    IF -_delta::bigint > v_free::bigint + v_paid THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_INSUFFICIENT' USING ERRCODE = '23514';
    END IF;
    v_release := GREATEST(-_delta::bigint - v_free, 0)::integer;
    IF (v_release > 0 AND _expected_release_quantity IS NULL)
      OR (_expected_release_quantity IS NOT NULL AND _expected_release_quantity <> v_release) THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' USING ERRCODE = '55000',
        DETAIL = pg_catalog.jsonb_build_object('releasedQuantity', v_release)::text;
    END IF;
    IF v_release > 0 AND v_note IS NULL THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_REASON_REQUIRED' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  v_remaining := v_release;
  FOR v_allocation IN
    SELECT a.id, a.remaining_quantity, a.order_item_id, oi.order_id
    FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
    JOIN public.orders AS o ON o.id = oi.order_id
    WHERE a.variant_id = _variant_id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders)
    ORDER BY o.created_at DESC, o.id DESC, oi.id DESC, a.id DESC
  LOOP
    EXIT WHEN v_remaining = 0;
    v_quantity := LEAST(v_remaining, v_allocation.remaining_quantity);
    UPDATE public.order_item_allocations AS a SET remaining_quantity = a.remaining_quantity - v_quantity, version = a.version + 1
      WHERE a.id = v_allocation.id;
    INSERT INTO public.stock_movements(variant_id, delta, reason, note, order_id, order_item_id, allocation_operation_id, created_by)
      VALUES(_variant_id, v_quantity, 'allocation_release', v_note, v_allocation.order_id, v_allocation.order_item_id, v_operation, _actor_id)
      RETURNING id INTO v_release_movement;
    INSERT INTO public.order_item_allocation_events(allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
      VALUES(v_allocation.id, 'release', v_quantity, v_operation, 1, v_release_movement, v_note, _actor_id);
    v_remaining := v_remaining - v_quantity;
  END LOOP;
  INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)
    VALUES(_variant_id, _delta, _reason, v_note, _actor_id) RETURNING id INTO v_movement;
  v_allocated := private.allocate_group_g_fifo(ARRAY[_variant_id], v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stock_move', _actor_id);
  v_result := pg_catalog.jsonb_build_object('movementId', v_movement::text, 'releasedQuantity', v_release,
    'allocatedQuantity', v_allocated, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'stock_move', _request_key, v_fingerprint, 'variant', _variant_id::text, _actor_id, v_result);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) TO service_role;

CREATE FUNCTION public.admin_record_stock_movement(_item_id bigint, _variant_id bigint, _delta integer, _reason text,
  _note text, _actor_id uuid, _request_key uuid, _expected_release_quantity integer) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_record_stock_movement(_item_id, _variant_id, _delta, _reason, _note, _actor_id, _request_key, _expected_release_quantity); $$;
ALTER FUNCTION public.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) TO service_role;

-- Task 6: order intake (H only), awaiting payment, unpaid release/cancel and guest order linking.
-- Each public entry keeps its last signature/defaults/return and delegates (SECURITY INVOKER) to a
-- private body that takes the common advisory before any row lock. Last definitions:
-- place_order 20261023082740_item_variant_retire.sql:166, awaiting 20261009095736_order_email_enqueue.sql:147,
-- release/admin_cancel 20261023061408_order_cancel_reasons.sql:63/:12.
CREATE FUNCTION private.place_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text DEFAULT NULL,
  _shown_in_stock_variant_ids bigint[] DEFAULT NULL,
  _buyer_user_id uuid DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  existing_id uuid;
  existing_status public.order_status;
  existing_owner uuid;
  inserted_id uuid;
  v_snapshot jsonb;
  v_variants bigint[];
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_line record;
  v_movement bigint;
  v_allocation uuid;
  v_held integer := 0;
BEGIN
  IF _draft_id IS NULL
     OR NULLIF(pg_catalog.btrim(_checkout_session_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(_cart_session_id), '') IS NULL
     OR _stripe_amount_total IS NULL
     OR _stripe_amount_discount IS NULL
     OR _stripe_amount_discount < 0
     OR NULLIF(pg_catalog.btrim(_stripe_currency), '') IS NULL
     OR _checkout_session_created_at IS NULL
     OR (_buyer_user_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL) THEN
    RAISE EXCEPTION 'PLACE_ORDER_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The reconciler gets the existing order of the same Session back without any lock (read only).
  SELECT o.id, o.status INTO existing_id, existing_status
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
  IF existing_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  -- Close the variant set by an unlocked read of the draft, then take the common advisory first,
  -- the draft next, then items/variants/waiting orders in the global order (Task 4 helper).
  SELECT d.items_snapshot INTO v_snapshot FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT r.variant_id ORDER BY r.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.resolve_checkout_item_variants(COALESCE(v_snapshot, '[]'::jsonb)) AS r
  WHERE r.variant_id IS NOT NULL;
  PERFORM private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], _draft_id);

  SELECT d.* INTO draft_row FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  -- A variant resolved only after the lock was taken cannot be locked any more in the global order.
  IF EXISTS (
    SELECT 1 FROM public.resolve_checkout_item_variants(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS r
    WHERE r.variant_id IS NOT NULL AND NOT (r.variant_id = ANY (v_variants))
  ) THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  -- 「注文する」の経路では、「確認へ進む」の時の買い手と今の買い手が同じ時だけ進む（グループ C 設計書 5-3）。
  IF _shown_in_stock_variant_ids IS NOT NULL
     AND draft_row.id IS NOT NULL
     AND draft_row.checkout_session_id IS NOT DISTINCT FROM _checkout_session_id
     AND draft_row.session_id IS NOT DISTINCT FROM _cart_session_id
     AND draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
    RETURN;
  END IF;

  -- ロックを待つ間に、並行した受付が同じ Session の注文を作っていれば、それを返す。
  SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND (draft_row.id IS NULL
            OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
            OR draft_row.session_id IS DISTINCT FROM _cart_session_id)
       AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
      RETURN;
    END IF;
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND existing_status = 'payment_in_progress'::public.order_status
       AND private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  IF draft_row.id IS NULL
     OR draft_row.session_id IS DISTINCT FROM _cart_session_id
     OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
     OR draft_row.status IS DISTINCT FROM 'created' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'draft_not_found'::text;
    RETURN;
  END IF;

  IF _stripe_amount_total <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'zero_amount'::text;
    RETURN;
  END IF;

  IF pg_catalog.lower(draft_row.currency) <> pg_catalog.lower(_stripe_currency) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'currency_mismatch'::text;
    RETURN;
  END IF;

  IF draft_row.total_amount + COALESCE(draft_row.discount_amount, 0)
     <> _stripe_amount_total + _stripe_amount_discount THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  -- Items of resolved variants are already FOR KEY SHARE (R-42) and variants FOR UPDATE by the helper.
  -- A line whose variant does not resolve is only read here; its order_items FK takes KEY SHARE on insert.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
    LEFT JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
    WHERE i.id IS NULL OR i.status IS DISTINCT FROM 'published'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
    RETURN;
  END IF;

  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
      LEFT JOIN public.item_variants AS v ON v.id = r.variant_id
      WHERE v.id IS NULL OR NOT v.is_active
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
      RETURN;
    END IF;

    IF private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
      JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
      WHERE i.price IS DISTINCT FROM (e.value->>'item_price')::integer
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'price_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.preview_checkout_fulfillment(draft_row.items_snapshot) AS p
      WHERE p.variant_id = ANY (_shown_in_stock_variant_ids)
        AND p.fulfillment = 'backorder'
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'stock_changed'::text;
      RETURN;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  BEGIN
    INSERT INTO public.orders (
      session_id, user_id, checkout_session_id, payment_intent_id, status,
      subtotal_amount, shipping_amount, discount_amount, total_amount, currency,
      shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city,
      shipping_address, shipping_building, shipping_phone, shipping_kana, checkout_session_created_at
    ) VALUES (
      draft_row.session_id,
      CASE WHEN _shown_in_stock_variant_ids IS NOT NULL THEN draft_row.buyer_user_id ELSE NULL END,
      _checkout_session_id,
      _payment_intent_id,
      'payment_in_progress'::public.order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      _stripe_amount_discount,
      _stripe_amount_total,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName',
      _checkout_session_created_at
    )
    RETURNING id INTO inserted_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
      FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
        IF _shown_in_stock_variant_ids IS NOT NULL AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
          RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
          RETURN;
        END IF;
        RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
        RETURN;
      END IF;
      RAISE;
  END;

  -- 明細を写しから作る。同じ variant の合計が空き在庫で全部賄える時だけ在庫の明細にする（今までの規則）。
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, pg_catalog.sum(r.quantity)::integer AS quantity
    FROM resolved AS r WHERE r.variant_id IS NOT NULL GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active AND v.stock_quantity >= n.quantity
  )
  INSERT INTO public.order_items (
    order_id, item_id, item_name, item_price, item_image_url, color, size,
    quantity, line_total, variant_id, fulfillment_type
  )
  SELECT inserted_id, r.item_id, r.item_name, r.item_price, r.item_image_url, r.color, r.size,
         r.quantity, r.line_total, r.variant_id,
         CASE WHEN r.variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM covered AS c WHERE c.variant_id = r.variant_id)
           THEN 'stock' ELSE 'backorder' END
  FROM resolved AS r
  ORDER BY r.line_no;

  -- Each stock line takes its purchase/-n and exactly one payment hold (H) in this operation. No A before payment.
  FOR v_line IN
    SELECT oi.id AS order_item_id, oi.variant_id, oi.quantity
    FROM public.order_items AS oi
    WHERE oi.order_id = inserted_id AND oi.fulfillment_type = 'stock' AND oi.variant_id IS NOT NULL AND oi.quantity > 0
    ORDER BY oi.variant_id, oi.id
  LOOP
    INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, allocation_operation_id)
    VALUES (v_line.variant_id, -v_line.quantity, 'purchase', inserted_id, v_line.order_item_id, v_operation)
    RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
    VALUES (v_line.order_item_id, v_line.variant_id, v_line.quantity, v_line.quantity, 'payment_hold', v_operation)
    RETURNING id INTO v_allocation;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason)
    VALUES (v_allocation, 'hold', v_line.quantity, v_operation, 1, v_movement, 'checkout');
    v_held := v_held + v_line.quantity;
  END LOOP;

  -- 下書きは受付済みにする。割引額だけを書き戻し、合計は割引前のまま残す（R-26）。カートは消さない。
  UPDATE public.checkout_drafts AS d
  SET status = 'completed',
      discount_amount = _stripe_amount_discount,
      payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE d.id = _draft_id;

  -- payment_in_progress is not displayed (0 ranges); the before/after call keeps one recorder per operation.
  PERFORM private.record_group_g_item_state_changes('[]'::jsonb, ARRAY[inserted_id], v_operation, 1,
    'place_order_from_checkout_draft', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'place_order_from_checkout_draft',
    pg_catalog.md5('place_order_from_checkout_draft:' || inserted_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'place_order_from_checkout_draft', 'order_id', inserted_id, 'draft_id', _draft_id,
      'checkout_session_id', _checkout_session_id)::text, 'UTF8')), 'hex'),
    'order',
    inserted_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', inserted_id, 'held_quantity', v_held)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT inserted_id, 'payment_in_progress'::public.order_status, true, NULL::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.place_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text DEFAULT NULL,
  _shown_in_stock_variant_ids bigint[] DEFAULT NULL,
  _buyer_user_id uuid DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.place_order_from_checkout_draft(_draft_id, _checkout_session_id, _cart_session_id,
    _stripe_amount_total, _stripe_amount_discount, _stripe_currency, _checkout_session_created_at,
    _payment_intent_id, _shown_in_stock_variant_ids, _buyer_user_id);
$$;
ALTER FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)
  TO service_role;

CREATE FUNCTION private.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _order_id IS NULL OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_AWAITING_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id;

  IF target.id IS NULL OR target.status IS DISTINCT FROM 'payment_in_progress'::public.order_status THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(ARRAY[_order_id]);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_awaiting', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  -- The order keeps its H (no A before payment); only the status and its item states change.
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

  PERFORM private.record_group_g_item_state_changes(v_before, ARRAY[_order_id], v_operation, 1,
    'stripe_payment_awaiting', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_awaiting_payment',
    CASE WHEN NULLIF(pg_catalog.btrim(_source_event_id), '') IS NOT NULL
      THEN pg_catalog.md5('stripe:' || _source_event_id)::uuid
      ELSE pg_catalog.md5('mark_order_awaiting_payment:' || _order_id::text || ':' || _payment_intent_id)::uuid END,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_awaiting_payment', 'order_id', _order_id, 'payment_intent_id', _payment_intent_id,
      'source_event_id', _source_event_id)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', 'pending', 'source_event_id', _source_event_id)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.mark_order_awaiting_payment(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_awaiting_payment(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_awaiting_payment(uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.mark_order_awaiting_payment(_order_id, _payment_intent_id, _source_event_id); $$;
ALTER FUNCTION public.mark_order_awaiting_payment(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid,text,text) TO service_role;

-- Internal core shared by the unpaid release and the failed-order cancel: release every remaining H of
-- one order (cancel/+n and one release event per allocation) under the caller's prelock. Idempotent:
-- an order whose H is already released writes nothing. No lock acquisition, FIFO or public RPC here.
CREATE FUNCTION private.release_group_g_payment_holds(_order_id uuid, _operation_id uuid, _reason text, _actor_id uuid)
RETURNS TABLE (released_variant_ids bigint[], released_quantity integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_hold record;
  v_movement bigint;
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
BEGIN
  IF _order_id IS NULL OR _operation_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  FOR v_hold IN
    SELECT a.id, a.variant_id, a.order_item_id, a.remaining_quantity
    FROM public.order_item_allocations AS a
    JOIN public.order_items AS oi ON oi.id = a.order_item_id
    WHERE oi.order_id = _order_id AND a.kind = 'payment_hold' AND a.remaining_quantity > 0
    ORDER BY a.variant_id, a.order_item_id, a.id
  LOOP
    UPDATE public.order_item_allocations AS a
    SET remaining_quantity = 0, version = a.version + 1, updated_at = pg_catalog.now()
    WHERE a.id = v_hold.id;
    INSERT INTO public.stock_movements
      (variant_id, delta, reason, order_id, order_item_id, note, created_by, allocation_operation_id)
    VALUES (v_hold.variant_id, v_hold.remaining_quantity, 'cancel', _order_id, v_hold.order_item_id,
      _reason, _actor_id, _operation_id)
    RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
    VALUES (v_hold.id, 'release', v_hold.remaining_quantity, _operation_id, 1, v_movement, _reason, _actor_id);
    v_released := v_released + v_hold.remaining_quantity;
    IF NOT (v_hold.variant_id = ANY (v_variants)) THEN
      v_variants := v_variants || v_hold.variant_id;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_variants, v_released;
END;
$$;
ALTER FUNCTION private.release_group_g_payment_holds(uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.release_group_g_payment_holds(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.release_stock_for_unpaid_order(
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  updated_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
  v_allocated integer := 0;
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
          OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')) THEN
    RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
  END IF;

  IF _next_status = 'cancelled'::public.order_status
     AND _cancel_reason = 'other'
     AND NULLIF(pg_catalog.btrim(_cancel_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The order, its variants and every waiting order of those variants are locked for the FIFO below.
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);

  -- Replays and other states change nothing (CAS); no operation is recorded for them.
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id AND o.status = _expected_status) THEN
    RETURN QUERY SELECT false, _order_id, o.status FROM public.orders AS o WHERE o.id = _order_id;
    RETURN;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
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

  -- Only the existing H is released (cancel/+n, one event per allocation). Untracked legacy ledger rows stay (R-41).
  SELECT h.released_variant_ids, h.released_quantity INTO v_variants, v_released
  FROM private.release_group_g_payment_holds(updated_id, v_operation, _change_reason, _actor_id) AS h;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, _change_reason, _actor_id);

  -- The released units go to the oldest waiting orders of the same variants (separate state sequence).
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;

  IF _next_status = 'failed'::public.order_status THEN
    PERFORM private.enqueue_order_email(updated_id, 'payment_expired', NULL);
  ELSIF _next_status = 'cancelled'::public.order_status AND COALESCE(_notify_customer, false) THEN
    PERFORM private.enqueue_order_email(updated_id, 'canceled', _expected_status::text);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'release_stock_for_unpaid_order',
    pg_catalog.md5('release_stock_for_unpaid_order:' || _order_id::text || ':' || _expected_status::text || ':'
      || _next_status::text || ':' || COALESCE(_source_event_id, ''))::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'release_stock_for_unpaid_order', 'order_id', _order_id, 'expected_status', _expected_status,
      'next_status', _next_status, 'change_reason', _change_reason, 'actor_id', _actor_id,
      'source_event_id', _source_event_id, 'cancel_reason', _cancel_reason, 'cancel_note', _cancel_note,
      'notify_customer', _notify_customer)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', _next_status,
      'released_quantity', v_released, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true, updated_id, _next_status;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  TO service_role;

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
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.release_stock_for_unpaid_order(_order_id, _expected_status, _next_status, _change_reason,
    _actor_id, _source_event_id, _cancel_reason, _cancel_note, _notify_customer);
$$;
ALTER FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
  TO service_role;

CREATE FUNCTION private.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid,
  _cancel_reason text,
  _note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status public.order_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_status public.order_status;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
  v_allocated integer := 0;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason IS NULL
     OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other') THEN
    RAISE EXCEPTION 'CANCEL_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'CANCEL_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  -- Only failed orders are cancelled here (CAS). Their H is normally released when they failed.
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id AND o.status = 'failed'::public.order_status) THEN
    RETURN;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_failed_order', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET status = 'cancelled'::public.order_status,
      cancel_reason = _cancel_reason,
      cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
      cancel_notify_customer = false
  WHERE o.id = _order_id
    AND o.status = 'failed'::public.order_status
  RETURNING o.id, o.status INTO v_id, v_status;

  -- Leak guard: any H still left on the order is released (0 rows when already released), then FIFO.
  SELECT h.released_variant_ids, h.released_quantity INTO v_variants, v_released
  FROM private.release_group_g_payment_holds(_order_id, v_operation, 'admin_cancel_failed_order', _actor_id) AS h;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'admin_cancel_failed_order', _actor_id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'admin_cancel_failed_order',
    pg_catalog.md5('admin_cancel_failed_order:' || _order_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_cancel_failed_order', 'order_id', _order_id, 'actor_id', _actor_id,
      'cancel_reason', _cancel_reason, 'note', _note)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', v_status,
      'released_quantity', v_released, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_id, v_status;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_cancel_failed_order(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_cancel_failed_order(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_cancel_failed_order(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid,
  _cancel_reason text,
  _note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status public.order_status)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_cancel_failed_order(_order_id, _actor_id, _cancel_reason, _note); $$;
ALTER FUNCTION public.admin_cancel_failed_order(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_cancel_failed_order(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_failed_order(uuid,uuid,text,text) TO service_role;

-- Guest orders are linked under the common advisory and in id order (replaces the unordered bulk UPDATE
-- of src/lib/orders/link-guest-orders.ts). No stock/variant row is touched. The e-mail is compared
-- case-insensitively as plain text, so %, _ and \ are ordinary characters.
CREATE FUNCTION private.link_guest_orders(_user_id uuid, _email text)
RETURNS TABLE (id uuid, shipping_full_name text, shipping_postal_code text, shipping_prefecture text,
  shipping_city text, shipping_address text, shipping_building text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim(_email));
  v_ids uuid[];
  v_id uuid;
BEGIN
  IF _user_id IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Non-locking read of the account; only a confirmed owner of the same address may link.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users AS u
    WHERE u.id = _user_id AND u.email_confirmed_at IS NOT NULL AND pg_catalog.lower(u.email) = v_email
  ) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);
  SELECT COALESCE(pg_catalog.array_agg(t.id ORDER BY t.id), ARRAY[]::uuid[]) INTO v_ids
  FROM (
    SELECT o.id FROM public.orders AS o
    WHERE o.user_id IS NULL AND pg_catalog.lower(o.shipping_email) = v_email
    ORDER BY o.id
    FOR UPDATE
  ) AS t;

  -- Same id order; re-check user_id so another owner is never replaced.
  FOREACH v_id IN ARRAY v_ids LOOP
    RETURN QUERY
    UPDATE public.orders AS o SET user_id = _user_id
    WHERE o.id = v_id AND o.user_id IS NULL
    RETURNING o.id, o.shipping_full_name, o.shipping_postal_code, o.shipping_prefecture, o.shipping_city,
      o.shipping_address, o.shipping_building, o.created_at;
  END LOOP;
END;
$$;
ALTER FUNCTION private.link_guest_orders(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.link_guest_orders(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.link_guest_orders(uuid,text) TO service_role;

CREATE FUNCTION public.link_guest_orders(_user_id uuid, _email text)
RETURNS TABLE (id uuid, shipping_full_name text, shipping_postal_code text, shipping_prefecture text,
  shipping_city text, shipping_address text, shipping_building text, created_at timestamptz)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.link_guest_orders(_user_id, _email); $$;
ALTER FUNCTION public.link_guest_orders(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_guest_orders(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_guest_orders(uuid,text) TO service_role;

-- Task 5 review fix: reserved is now the remaining A+H after shipment consumption, so the restockable
-- count no longer subtracts the shipped quantity again. Last definition:
-- 20261013001143_order_return_receipts.sql:494; only the restockable expression changes.
CREATE OR REPLACE FUNCTION public.load_order_refund_materials(_order_id uuid)
RETURNS TABLE (
  order_id uuid,
  order_status public.order_status,
  total_amount integer,
  shipping_amount integer,
  discount_amount integer,
  paid_amount integer,
  succeeded_amount integer,
  open_amount integer,
  refundable_amount integer,
  refunded_shipping integer,
  refundable_shipping integer,
  shipped_total integer,
  unshipped_total integer,
  awaiting_refund_id uuid,
  awaiting_refund_amount integer,
  awaiting_refund_created_at timestamptz,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id,
         o.status,
         o.total_amount,
         o.shipping_amount,
         o.discount_amount,
         a.paid_amount,
         a.succeeded_amount,
         a.open_amount,
         a.refundable_amount,
         a.refunded_shipping,
         a.refundable_shipping,
         c.shipped_total,
         c.unshipped_total,
         w.id,
         w.amount,
         w.created_at,
         c.lines
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_refund_amounts(o.id) AS a
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(f.shipped), 0)::integer AS shipped_total,
           COALESCE(pg_catalog.sum(f.unshipped), 0)::integer AS unshipped_total,
           COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'order_item_id', f.order_item_id,
                 'fulfillment_type', f.fulfillment_type,
                 'item_price', oi.item_price,
                 'quantity', f.quantity,
                 'line_total', oi.line_total,
                 'exchange_paid_amount', oi.exchange_paid_amount,
                 'shipped', f.shipped,
                 'unshipped', f.unshipped,
                 'refunded_before_shipment', f.refunded_before_shipment,
                 'refunded_after_shipment', f.refunded_after_shipment,
                 'shipped_refundable', rc.refundable_after_shipment,
                 -- 在庫に戻せる数は、残っている確保（発送で使った分は既に引かれている）まで。確保の無い古い商品と受注生産は0
                 'restockable', CASE
                   WHEN f.fulfillment_type = 'stock' THEN LEAST(f.unshipped, r.reserved)
                   ELSE 0
                 END,
                 'line_discount', d.line_discount,
                 'refunded_units', f.refunded_before_shipment + f.refunded_after_shipment
               )
               ORDER BY oi.created_at, oi.id
             ),
             '[]'::jsonb
           ) AS lines
    FROM private.order_line_fulfillment(o.id) AS f
    JOIN private.order_line_return_counts(o.id) AS rc ON rc.order_item_id=f.order_item_id
    JOIN public.order_items AS oi ON oi.id = f.order_item_id
    JOIN private.order_line_reservations(o.id) AS r ON r.order_item_id = f.order_item_id
    JOIN private.order_line_discounts(o.id) AS d ON d.order_item_id = f.order_item_id
  ) AS c
  LEFT JOIN LATERAL (
    SELECT ar.id, ar.amount, ar.created_at
    FROM public.order_refunds AS ar
    WHERE ar.order_id = o.id
      AND ar.status = 'awaiting_response'
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT 1
  ) AS w ON true
  WHERE o.id = _order_id
$$;
ALTER FUNCTION public.load_order_refund_materials(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.load_order_refund_materials(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_order_refund_materials(uuid) TO service_role;

DO $g1_checkout_assert$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)'),
    pg_catalog.to_regprocedure('private.mark_order_awaiting_payment(uuid,text,text)'),
    pg_catalog.to_regprocedure('private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)'),
    pg_catalog.to_regprocedure('private.admin_cancel_failed_order(uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('private.link_guest_orders(uuid,text)')
  ) AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) <> 5
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)'),
    pg_catalog.to_regprocedure('public.mark_order_awaiting_payment(uuid,text,text)'),
    pg_catalog.to_regprocedure('public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)'),
    pg_catalog.to_regprocedure('public.admin_cancel_failed_order(uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('public.link_guest_orders(uuid,text)')
  ) AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 5 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_checkout_functions';
  END IF;
END;
$g1_checkout_assert$;

DO $g1_model_assert$
DECLARE
  v_failed text;
BEGIN
  IF to_regclass('private.group_g_operations') IS NULL
     OR to_regclass('public.order_item_allocations') IS NULL
     OR to_regclass('public.order_item_allocation_events') IS NULL
     OR to_regclass('public.order_item_state_events') IS NULL THEN
    v_failed := 'g1_model_tables';
  ELSIF EXISTS (SELECT 1 FROM private.group_g_operations)
     OR EXISTS (SELECT 1 FROM public.order_item_allocations)
     OR EXISTS (SELECT 1 FROM public.order_item_allocation_events)
     OR EXISTS (SELECT 1 FROM public.order_item_state_events) THEN
    v_failed := 'g1_model_rows';
  ELSIF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS c
    WHERE c.oid IN ('private.group_g_operations'::regclass, 'public.order_item_allocations'::regclass,
                    'public.order_item_allocation_events'::regclass, 'public.order_item_state_events'::regclass)
      AND c.relrowsecurity
      AND c.relowner = 'postgres'::regrole
  ) <> 4 THEN
    v_failed := 'g1_model_rls_owner';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'paid_at'
      AND a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.stock_movements'::regclass AND a.attname = 'allocation_operation_id'
      AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.attisdropped
  ) THEN
    v_failed := 'g1_model_columns';
  ELSIF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confrelid = 'private.group_g_operations'::regclass
      AND c.condeferrable AND c.condeferred AND c.confdeltype = 'r'
      AND (c.conrelid, c.conname::text) IN (
        VALUES ('public.order_item_allocations'::regclass::oid, 'order_item_allocations_operation_id_fkey'),
               ('public.order_item_allocation_events'::regclass::oid, 'order_item_allocation_events_operation_id_fkey'),
               ('public.order_item_state_events'::regclass::oid, 'order_item_state_events_operation_id_fkey'),
               ('public.stock_movements'::regclass::oid, 'stock_movements_allocation_operation_id_fkey')
      )
  ) <> 4 THEN
    v_failed := 'g1_model_operation_fkeys';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.stock_movements'::regclass AND c.conname = 'stock_movements_reason_check'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%allocation_release%'
  ) THEN
    v_failed := 'g1_model_reason_check';
  ELSIF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
    WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
      AND (t.tgrelid, t.tgname::text, t.tgfoid, t.tgtype::integer) IN (
        VALUES
          ('public.order_item_allocation_events'::regclass::oid, 'order_item_allocation_events_no_update',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 19),
          ('public.order_item_allocation_events'::regclass::oid, 'order_item_allocation_events_no_delete',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 11),
          ('public.order_item_allocation_events'::regclass::oid, 'order_item_allocation_events_no_truncate',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 34),
          ('public.order_item_state_events'::regclass::oid, 'order_item_state_events_no_update',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 19),
          ('public.order_item_state_events'::regclass::oid, 'order_item_state_events_no_delete',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 11),
          ('public.order_item_state_events'::regclass::oid, 'order_item_state_events_no_truncate',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 34),
          ('private.group_g_operations'::regclass::oid, 'group_g_operations_no_update',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 19),
          ('private.group_g_operations'::regclass::oid, 'group_g_operations_no_delete',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 11),
          ('private.group_g_operations'::regclass::oid, 'group_g_operations_no_truncate',
           'private.reject_group_g_event_mutation()'::regprocedure::oid, 34),
          ('public.order_item_allocations'::regclass::oid, 'order_item_allocations_change_guard',
           'private.guard_group_g_allocation_change()'::regprocedure::oid, 27),
          ('public.order_item_allocations'::regclass::oid, 'group_g_allocation_bounds',
           'private.check_group_g_allocation_bounds()'::regprocedure::oid, 21),
          ('public.order_item_allocation_events'::regclass::oid, 'group_g_allocation_bounds',
           'private.check_group_g_allocation_bounds()'::regprocedure::oid, 21)
      )
  ) <> 12 THEN
    v_failed := 'g1_model_triggers';
  ELSIF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
    WHERE t.tgname = 'group_g_allocation_bounds'
      AND t.tgrelid IN ('public.order_item_allocations'::regclass, 'public.order_item_allocation_events'::regclass)
      AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
  ) <> 2 THEN
    v_failed := 'g1_model_deferred_bounds';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g1_model_assert$;
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
