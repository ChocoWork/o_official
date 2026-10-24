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
           -- Task 7: the exact active-hold condition (never result.active alone).
           EXISTS (
             SELECT 1 FROM private.group_g_operations AS h
             JOIN public.payment_exceptions AS e ON e.id = h.exception_id
             WHERE h.operation = 'payment_review_hold' AND e.reason = 'paid_amount_mismatch'
               AND e.order_id = o.id AND e.resolved_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM private.group_g_operations AS r
                 WHERE r.operation = 'payment_review_release' AND r.cause_type = 'payment_review_hold'
                   AND r.cause_id = h.id::text)
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

-- Task 7: payment (H -> A, first paid_at), the payment-review hold and both resolvers.
-- Last definitions replaced here (signature/defaults/returns kept): mark_order_paid
-- 20261011222930_order_refund_records.sql:574, record_cancelled_order_paid_amount
-- 20261011223147_order_refund_requests.sql:758, record_payment_exception/mark_order_reviewed
-- 20260927100500_payment_exceptions.sql:53/:223, resolve_payment_exception
-- 20261023061434_payment_exception_refund_failed_note.sql:5, resolve_payment_exception_by_system
-- 20261011223453_order_refund_results.sql:1260.

-- orders.paid_at is written once (first real payment) and never changed or cleared, by any role.
CREATE FUNCTION private.guard_group_g_paid_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
    RAISE EXCEPTION 'GROUP_G_PAID_AT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.guard_group_g_paid_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_group_g_paid_at() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER orders_paid_at_once BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_g_paid_at();

-- Internal core: close every still-active review hold of one exception (one release row per hold, once).
-- The caller owns the common lock and resolves the exception in the same transaction. No lock, FIFO or RPC.
CREATE FUNCTION private.release_group_g_payment_review_holds(_exception_id uuid, _actor_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hold record;
  v_count integer := 0;
BEGIN
  IF _exception_id IS NULL THEN
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
    SELECT h.id FROM private.group_g_operations AS h
    WHERE h.operation = 'payment_review_hold' AND h.exception_id = _exception_id
      AND NOT EXISTS (SELECT 1 FROM private.group_g_operations AS r
        WHERE r.operation = 'payment_review_release' AND r.cause_type = 'payment_review_hold'
          AND r.cause_id = h.id::text)
    ORDER BY h.id
  LOOP
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      pg_catalog.gen_random_uuid(),
      'payment_review_release',
      pg_catalog.md5('review-release:' || v_hold.id::text)::uuid,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', 'payment_review_release', 'hold_id', v_hold.id, 'exception_id', _exception_id)::text, 'UTF8')), 'hex'),
      'payment_review_hold',
      v_hold.id::text,
      _actor_id,
      pg_catalog.jsonb_build_object('active', false)
    )
    ON CONFLICT (operation, request_key) DO NOTHING;
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
ALTER FUNCTION private.release_group_g_payment_review_holds(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.release_group_g_payment_review_holds(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- mark_paid: common lock -> H -> A (the buyer keeps its own hold) -> paid/paid_at/review -> on a mismatch the
-- exception and its hold together -> state seq 1 -> FIFO for the order's variants (held lines are excluded by the
-- projection) -> state seq 2 -> operation. The draft is no longer written back after payment.
CREATE FUNCTION private.mark_order_paid(
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_matches boolean;
  v_missing_variant boolean;
  v_hold record;
  v_promoted integer := 0;
  v_variants bigint[];
  v_allocated integer := 0;
  v_draft_id uuid;
  v_exception_id uuid;
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

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id;

  -- Replays and CAS mismatches change nothing (no paid_at, no operation).
  IF target.id IS NULL OR target.status IS DISTINCT FROM _expected_status THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_matches := target.total_amount = _paid_amount
    AND pg_catalog.lower(target.currency) = pg_catalog.lower(_paid_currency);
  -- Only a line without a variant needs the existing review; a normal backorder shortage waits for FIFO.
  SELECT EXISTS (
    SELECT 1 FROM public.order_items AS oi WHERE oi.order_id = _order_id AND oi.variant_id IS NULL
  ) INTO v_missing_variant;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_paid', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  -- The buyer's own H becomes A first (kept even when the amount differs).
  FOR v_hold IN
    SELECT a.id, a.remaining_quantity
    FROM public.order_item_allocations AS a
    JOIN public.order_items AS oi ON oi.id = a.order_item_id
    WHERE oi.order_id = _order_id AND a.kind = 'payment_hold' AND a.remaining_quantity > 0
    ORDER BY a.id
  LOOP
    UPDATE public.order_item_allocations AS a
    SET kind = 'paid', version = a.version + 1, updated_at = pg_catalog.now()
    WHERE a.id = v_hold.id;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, reason, actor_id)
    VALUES (v_hold.id, 'promote', v_hold.remaining_quantity, v_operation, 1, 'stripe_payment_paid', NULL);
    v_promoted := v_promoted + v_hold.remaining_quantity;
  END LOOP;

  UPDATE public.orders AS o
  SET status = 'paid'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      paid_amount = _paid_amount,
      paid_at = COALESCE(o.paid_at, pg_catalog.clock_timestamp()),
      review_reason = CASE WHEN v_missing_variant THEN 'stock_not_reserved' ELSE o.review_reason END,
      review_marked_at = CASE WHEN v_missing_variant THEN pg_catalog.now() ELSE o.review_marked_at END
  WHERE o.id = _order_id;

  -- A different amount: the exception and its hold are created together, before any new FIFO.
  -- The payment reference is the one record_payment_exception resolves to (order Session, then PaymentIntent).
  IF NOT v_matches THEN
    SELECT d.id INTO v_draft_id
    FROM public.checkout_drafts AS d
    WHERE target.checkout_session_id IS NOT NULL AND d.checkout_session_id = target.checkout_session_id
    ORDER BY d.id
    LIMIT 1;
    v_exception_id := private.ensure_group_g_payment_review_hold(
      _order_id, _payment_intent_id, target.checkout_session_id, _payment_intent_id, v_draft_id);
  END IF;

  PERFORM private.clear_cart_for_order(_order_id);

  -- A different amount is reviewed by the shop before the customer hears anything.
  IF v_matches AND _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'paid', _paid_email_variant);
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stripe_payment_paid', NULL);

  SELECT pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id) INTO v_variants
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id AND oi.variant_id IS NOT NULL;
  IF COALESCE(pg_catalog.cardinality(v_variants), 0) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, NULL);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', NULL);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_paid',
    CASE WHEN NULLIF(pg_catalog.btrim(_source_event_id), '') IS NOT NULL
      THEN pg_catalog.md5('stripe:' || _source_event_id)::uuid
      ELSE pg_catalog.md5('mark_order_paid:' || _order_id::text || ':' || _payment_intent_id)::uuid END,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_paid', 'order_id', _order_id, 'expected_status', _expected_status,
      'payment_intent_id', _payment_intent_id, 'paid_amount', _paid_amount, 'paid_currency', _paid_currency,
      'notify_customer', _notify_customer, 'paid_email_variant', _paid_email_variant,
      'source_event_id', _source_event_id)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', 'paid', 'amount_matches', v_matches,
      'needs_review', v_missing_variant, 'promoted_quantity', v_promoted, 'allocated_quantity', v_allocated,
      'exception_id', v_exception_id, 'source_event_id', _source_event_id)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true, v_matches, v_missing_variant;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) TO service_role;

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
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.mark_order_paid(_order_id, _expected_status, _payment_intent_id, _paid_amount, _paid_currency,
    _notify_customer, _paid_email_variant, _source_event_id);
$$;
ALTER FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) TO service_role;

-- A payment that reached a cancelled order: the received amount and the first paid_at, once, under the common lock.
CREATE FUNCTION private.record_cancelled_order_paid_amount(
  _order_id uuid,
  _payment_intent_id text,
  _received_amount integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _order_id IS NULL
     OR _received_amount IS NULL
     OR _received_amount < 1
     OR _payment_intent_id IS NULL
     OR _payment_intent_id !~ '^pi_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Not cancelled, already written, or another PaymentIntent: nothing is written (replay).
  IF v_order.status <> 'cancelled'::public.order_status
     OR v_order.paid_amount IS NOT NULL
     OR (v_order.payment_intent_id IS NOT NULL AND v_order.payment_intent_id <> _payment_intent_id) THEN
    RETURN false;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET paid_amount = _received_amount,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      paid_at = COALESCE(o.paid_at, pg_catalog.clock_timestamp())
  WHERE o.id = _order_id;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'record_cancelled_order_payment', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'record_cancelled_order_paid_amount',
    pg_catalog.md5('record_cancelled_order_paid_amount:' || _order_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'record_cancelled_order_paid_amount', 'order_id', _order_id,
      'payment_intent_id', _payment_intent_id, 'received_amount', _received_amount)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'paid_amount', _received_amount)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.record_cancelled_order_paid_amount(
  _order_id uuid,
  _payment_intent_id text,
  _received_amount integer
)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.record_cancelled_order_paid_amount(_order_id, _payment_intent_id, _received_amount); $$;
ALTER FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) TO service_role;

-- Record an exception. A paid_amount_mismatch with an order goes through the common lock and the Task 2 helper,
-- so the exception and its hold are created together under one key (order Session, then PaymentIntent, then ref).
-- A mismatch the payment already created (mark_paid) and that was never dispatched is the same detection: this
-- call only fills empty columns and becomes its first dispatch (detection_count unchanged). is_new is true only
-- for the first successful dispatch claim of an unresolved exception; later detections count +1 as before.
-- Other reasons never create a hold. Their public entry still takes the common lock (Task 8: every public entry
-- locks whatever the setting); the refund writers, which already own the lock, call the row core below directly.
-- Internal core (Task 8): the plain exception row write and its first dispatch claim. The caller owns the common lock.
CREATE FUNCTION private.record_group_g_payment_exception_row(
  _payment_ref text,
  _reason text,
  _detail text,
  _checkout_session_id text,
  _payment_intent_id text,
  _draft_id uuid,
  _order_id uuid
)
RETURNS TABLE (exception_id uuid, is_new boolean, is_resolved boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_exception public.payment_exceptions%ROWTYPE;
  v_claimed uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.payment_exceptions (
    payment_ref, reason, detail, checkout_session_id, payment_intent_id, draft_id, order_id
  ) VALUES (
    _payment_ref, _reason, _detail, _checkout_session_id, _payment_intent_id, _draft_id, _order_id
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
    WHERE e.payment_ref = _payment_ref
      AND e.reason = _reason
    RETURNING e.* INTO v_exception;
  END IF;

  IF v_exception.resolved_at IS NULL THEN
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      pg_catalog.gen_random_uuid(),
      'payment_exception_dispatch',
      pg_catalog.md5('exception-dispatch:' || v_exception.id::text)::uuid,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', 'payment_exception_dispatch', 'exception_id', v_exception.id)::text, 'UTF8')), 'hex'),
      'payment_exception',
      v_exception.id::text,
      NULL,
      pg_catalog.jsonb_build_object('exception_id', v_exception.id, 'reason', v_exception.reason)
    )
    ON CONFLICT (operation, request_key) DO NOTHING
    RETURNING id INTO v_claimed;
  END IF;

  RETURN QUERY SELECT v_exception.id, v_claimed IS NOT NULL, v_exception.resolved_at IS NOT NULL;
END;
$$;
ALTER FUNCTION private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Internal core (Task 8): resolve a reason that can carry no review hold. The caller owns the common lock.
CREATE FUNCTION private.resolve_group_g_payment_exception_row(_exception_id uuid, _note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = NULL,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id
    AND e.resolved_at IS NULL;
  RETURN FOUND;
END;
$$;
ALTER FUNCTION private.resolve_group_g_payment_exception_row(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.resolve_group_g_payment_exception_row(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.record_payment_exception(
  _payment_ref text,
  _reason text,
  _detail text DEFAULT NULL,
  _checkout_session_id text DEFAULT NULL,
  _payment_intent_id text DEFAULT NULL,
  _draft_id uuid DEFAULT NULL,
  _order_id uuid DEFAULT NULL
)
RETURNS TABLE (exception_id uuid, is_new boolean, is_resolved boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_exception public.payment_exceptions%ROWTYPE;
  v_session text;
  v_ref text;
  v_claimed uuid;
BEGIN
  IF NOT (_reason = 'paid_amount_mismatch' AND _order_id IS NOT NULL) THEN
    -- Every reason holds the common lock (and the order's closure) at its public entry.
    PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[],
      CASE WHEN _order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[_order_id] END, NULL);
    RETURN QUERY SELECT r.exception_id, r.is_new, r.is_resolved
      FROM private.record_group_g_payment_exception_row(_payment_ref, _reason, _detail, _checkout_session_id,
        _payment_intent_id, _draft_id, _order_id) AS r;
    RETURN;
  END IF;

  -- paid_amount_mismatch with an order.
  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.checkout_session_id INTO v_session FROM public.orders AS o WHERE o.id = _order_id;
  v_ref := COALESCE(v_session, NULLIF(pg_catalog.btrim(_payment_intent_id), ''), NULLIF(pg_catalog.btrim(_payment_ref), ''));
  SELECT e.* INTO v_exception
  FROM public.payment_exceptions AS e
  WHERE e.payment_ref = v_ref AND e.reason = 'paid_amount_mismatch';

  IF v_exception.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM private.group_g_operations AS d
    WHERE d.operation = 'payment_exception_dispatch' AND d.cause_type = 'payment_exception'
      AND d.cause_id = v_exception.id::text
  ) THEN
    IF v_exception.order_id IS DISTINCT FROM _order_id THEN
      RAISE EXCEPTION 'GROUP_G_PAYMENT_REVIEW_CONFLICT' USING ERRCODE = '55000';
    END IF;
    UPDATE public.payment_exceptions AS e
    SET checkout_session_id = COALESCE(e.checkout_session_id, _checkout_session_id),
        payment_intent_id = COALESCE(e.payment_intent_id, _payment_intent_id),
        draft_id = COALESCE(e.draft_id, _draft_id),
        detail = COALESCE(e.detail, _detail)
    WHERE e.id = v_exception.id
    RETURNING e.* INTO v_exception;
  ELSE
    PERFORM private.ensure_group_g_payment_review_hold(_order_id, _payment_ref, _checkout_session_id, _payment_intent_id, _draft_id);
    UPDATE public.payment_exceptions AS e
    SET detail = COALESCE(e.detail, _detail)
    WHERE e.payment_ref = v_ref AND e.reason = 'paid_amount_mismatch'
    RETURNING e.* INTO v_exception;
  END IF;

  -- One dispatch per exception: the first caller of an unresolved exception owns the first notification/refund.
  IF v_exception.resolved_at IS NULL THEN
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      pg_catalog.gen_random_uuid(),
      'payment_exception_dispatch',
      pg_catalog.md5('exception-dispatch:' || v_exception.id::text)::uuid,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', 'payment_exception_dispatch', 'exception_id', v_exception.id)::text, 'UTF8')), 'hex'),
      'payment_exception',
      v_exception.id::text,
      NULL,
      pg_catalog.jsonb_build_object('exception_id', v_exception.id, 'reason', v_exception.reason)
    )
    ON CONFLICT (operation, request_key) DO NOTHING
    RETURNING id INTO v_claimed;
  END IF;

  RETURN QUERY SELECT v_exception.id, v_claimed IS NOT NULL, v_exception.resolved_at IS NOT NULL;
END;
$$;
ALTER FUNCTION private.record_payment_exception(text,text,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_payment_exception(text,text,text,text,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_payment_exception(text,text,text,text,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.record_payment_exception(
  _payment_ref text,
  _reason text,
  _detail text DEFAULT NULL,
  _checkout_session_id text DEFAULT NULL,
  _payment_intent_id text DEFAULT NULL,
  _draft_id uuid DEFAULT NULL,
  _order_id uuid DEFAULT NULL
)
RETURNS TABLE (exception_id uuid, is_new boolean, is_resolved boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.record_payment_exception(_payment_ref, _reason, _detail, _checkout_session_id,
    _payment_intent_id, _draft_id, _order_id);
$$;
ALTER FUNCTION public.record_payment_exception(text,text,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_payment_exception(text,text,text,text,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_payment_exception(text,text,text,text,text,uuid,uuid) TO service_role;

-- Human resolve: non-locking read of the order -> common lock and the order closure -> the exception row ->
-- (cancel through the held-row release core, no nested public RPC) -> close the review holds -> resolve ->
-- state seq 1 -> FIFO -> state seq 2 -> operation, all in one transaction.
CREATE FUNCTION private.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.payment_exceptions%ROWTYPE;
  v_order_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_cancel boolean := COALESCE(_cancel_order, false);
  current_status public.order_status;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
  v_holds integer := 0;
  v_allocated integer := 0;
BEGIN
  IF _exception_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.order_id INTO v_order_id FROM public.payment_exceptions AS e WHERE e.id = _exception_id;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[],
    CASE WHEN v_order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_order_id] END, NULL);
  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;

  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
    RETURN;
  END IF;

  -- The order was attached after the non-locking read; it cannot be locked late.
  IF target.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  IF target.reason = 'refund_failed' AND (_note IS NULL OR _note ~ '^[[:space:]]*$') THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF v_cancel THEN
    IF NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
      RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT o.status INTO current_status FROM public.orders AS o WHERE o.id = target.order_id;

    IF current_status IS NULL
       OR current_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
      RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
    END IF;

    -- The unpaid-release contract for a cancel (actor and one of the six reasons).
    IF _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other') THEN
      RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  IF v_cancel THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'resolve_payment_exception', true);
    PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

    UPDATE public.orders AS o
    SET status = 'cancelled'::public.order_status,
        cancel_reason = _cancel_reason,
        cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
        cancel_notify_customer = _notify_customer
    WHERE o.id = target.order_id
      AND o.status = current_status;

    SELECT h.released_variant_ids, h.released_quantity INTO v_variants, v_released
    FROM private.release_group_g_payment_holds(target.order_id, v_operation, 'resolve_payment_exception', _actor_id) AS h;

    IF COALESCE(_notify_customer, false) THEN
      PERFORM private.enqueue_order_email(target.order_id, 'canceled', current_status::text);
    END IF;
  END IF;

  v_holds := private.release_group_g_payment_review_holds(_exception_id, _actor_id);

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'resolve_payment_exception', _actor_id);

  -- Released H goes to the oldest waiting orders; a released review hold lets the order rejoin FIFO
  -- (the projection still excludes it while any other block remains).
  IF v_holds > 0 AND target.order_id IS NOT NULL THEN
    v_variants := v_variants || ARRAY(
      SELECT oi.variant_id FROM public.order_items AS oi
      WHERE oi.order_id = target.order_id AND oi.variant_id IS NOT NULL);
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM pg_catalog.unnest(v_variants) AS x(id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'resolve_payment_exception',
    pg_catalog.md5('resolve_payment_exception:' || _exception_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'resolve_payment_exception', 'exception_id', _exception_id, 'actor_id', _actor_id,
      'note', _note, 'cancel_order', v_cancel, 'cancel_reason', _cancel_reason,
      'notify_customer', _notify_customer)::text, 'UTF8')), 'hex'),
    'payment_exception',
    _exception_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('exception_id', _exception_id, 'order_id', target.order_id,
      'cancelled_from', CASE WHEN v_cancel THEN current_status END, 'released_quantity', v_released,
      'released_holds', v_holds, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT
    true,
    target.order_id,
    CASE WHEN v_cancel THEN current_status ELSE NULL::public.order_status END;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.resolve_payment_exception(_exception_id, _actor_id, _note, _cancel_order, _cancel_reason,
    _notify_customer);
$$;
ALTER FUNCTION public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) TO service_role;

-- System resolve (automatic refund, refund found). A paid_amount_mismatch (the only reason that can carry a review
-- hold) takes the same locked path as the human resolve. Other reasons have no hold: the common lock, then the
-- single-row update (Task 8; the refund writers call that row core under their own lock).
CREATE FUNCTION private.resolve_payment_exception_by_system(_exception_id uuid, _note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  target public.payment_exceptions%ROWTYPE;
  v_order_id uuid;
  v_reason text;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_variants bigint[];
  v_holds integer := 0;
  v_allocated integer := 0;
BEGIN
  IF _exception_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.order_id, e.reason INTO v_order_id, v_reason FROM public.payment_exceptions AS e WHERE e.id = _exception_id;

  IF v_reason IS DISTINCT FROM 'paid_amount_mismatch' THEN
    -- No hold to release, but the public entry still holds the common lock (Task 8). The refund writers that
    -- already own it call the row core directly.
    PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[],
      CASE WHEN v_order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_order_id] END, NULL);
    RETURN private.resolve_group_g_payment_exception_row(_exception_id, _note);
  END IF;

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[],
    CASE WHEN v_order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_order_id] END, NULL);
  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;
  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF target.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  v_holds := private.release_group_g_payment_review_holds(_exception_id, NULL);

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = NULL,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'resolve_payment_exception_by_system', NULL);

  IF v_holds > 0 AND target.order_id IS NOT NULL THEN
    SELECT pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id) INTO v_variants
    FROM public.order_items AS oi
    WHERE oi.order_id = target.order_id AND oi.variant_id IS NOT NULL;
    IF COALESCE(pg_catalog.cardinality(v_variants), 0) > 0 THEN
      v_middle := private.capture_group_g_item_states(v_orders);
      v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, NULL);
      PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', NULL);
    END IF;
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'resolve_payment_exception_by_system',
    pg_catalog.md5('resolve_payment_exception_by_system:' || _exception_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'resolve_payment_exception_by_system', 'exception_id', _exception_id, 'note', _note)::text,
      'UTF8')), 'hex'),
    'payment_exception',
    _exception_id::text,
    NULL,
    pg_catalog.jsonb_build_object('exception_id', _exception_id, 'order_id', target.order_id,
      'released_holds', v_holds, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.resolve_payment_exception_by_system(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.resolve_payment_exception_by_system(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.resolve_payment_exception_by_system(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_payment_exception_by_system(_exception_id uuid, _note text)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.resolve_payment_exception_by_system(_exception_id, _note); $$;
ALTER FUNCTION public.resolve_payment_exception_by_system(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_payment_exception_by_system(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception_by_system(uuid,text) TO service_role;

-- Marking the review only confirms the existing review_reason. It never releases a mismatch hold and never
-- repairs a NULL variant (that line stays outside FIFO).
CREATE FUNCTION private.mark_order_reviewed(_order_id uuid, _actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_marked_at timestamptz;
  v_cause text;
BEGIN
  IF _order_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_mark_order_reviewed', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET reviewed_at = pg_catalog.now(),
      reviewed_by = _actor_id
  WHERE o.id = _order_id
    AND o.review_reason IS NOT NULL
    AND o.reviewed_at IS NULL
  RETURNING o.review_marked_at INTO v_marked_at;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_cause := _order_id::text || ':' || COALESCE(v_marked_at::text, '');
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    pg_catalog.gen_random_uuid(),
    'mark_order_reviewed',
    pg_catalog.md5('mark_order_reviewed:' || v_cause)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_reviewed', 'order_id', _order_id, 'actor_id', _actor_id,
      'review_marked_at', v_marked_at)::text, 'UTF8')), 'hex'),
    'order_review',
    v_cause,
    _actor_id,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'reviewed', true)
  )
  ON CONFLICT (operation, request_key) DO NOTHING;
  RETURN true;
END;
$$;
ALTER FUNCTION private.mark_order_reviewed(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_reviewed(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_reviewed(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_order_reviewed(_order_id uuid, _actor_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.mark_order_reviewed(_order_id, _actor_id); $$;
ALTER FUNCTION public.mark_order_reviewed(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_reviewed(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_reviewed(uuid,uuid) TO service_role;

DO $g1_payment_assert$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)'),
    pg_catalog.to_regprocedure('private.record_cancelled_order_paid_amount(uuid,text,integer)'),
    pg_catalog.to_regprocedure('private.record_payment_exception(text,text,text,text,text,uuid,uuid)'),
    pg_catalog.to_regprocedure('private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'),
    pg_catalog.to_regprocedure('private.resolve_payment_exception_by_system(uuid,text)'),
    pg_catalog.to_regprocedure('private.mark_order_reviewed(uuid,uuid)')
  ) AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 6
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)'),
    pg_catalog.to_regprocedure('public.record_cancelled_order_paid_amount(uuid,text,integer)'),
    pg_catalog.to_regprocedure('public.record_payment_exception(text,text,text,text,text,uuid,uuid)'),
    pg_catalog.to_regprocedure('public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'),
    pg_catalog.to_regprocedure('public.resolve_payment_exception_by_system(uuid,text)'),
    pg_catalog.to_regprocedure('public.mark_order_reviewed(uuid,uuid)')
  ) AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 6
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.release_group_g_payment_review_holds(uuid,uuid)'),
    pg_catalog.to_regprocedure('private.guard_group_g_paid_at()')
  ) AND p.proowner = 'postgres'::regrole AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 2
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'orders_paid_at_once'
      AND t.tgfoid = 'private.guard_group_g_paid_at()'::regprocedure AND t.tgtype = 19 AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_payment_functions';
  END IF;
END;
$g1_payment_assert$;

-- Task 8: refund begin, results, external refunds and errors under the common lock; release and failure restore
-- through FIFO. Last definitions replaced (signature/defaults/returns kept): begin_order_refund
-- 20261013001143_order_return_receipts.sql:482, begin_order_refund_core 20261023061408_order_cancel_reasons.sql:181,
-- apply_order_refund_state/apply_return_refund_outcome/record_order_refund_result/mark_order_refund_error
-- 20261013001143_order_return_receipts.sql:922/1263/1309/1483, record_external_order_refund
-- 20261011223453_order_refund_results.sql:973.
-- Each public entry delegates (SECURITY INVOKER) to a private body that takes the common lock and the order closure
-- before any row read, captures the item states, sets app.group_g_operation_id, runs the internal cores on the held
-- rows (no nested public RPC, no lock helper), records the state changes once and writes the operation.

-- Internal core. The G-1 entries own the common lock and the order closure, so the core only reads those rows.
-- The return writers (admin_receive_return / admin_refund_return) still lock here until Task 11 moves them under
-- the common lock; return refunds have no pre-shipment line, so they never touch an allocation.
CREATE OR REPLACE FUNCTION private.begin_order_refund_core(
  _order_id uuid,
  _source text,
  _request_key uuid,
  _lines jsonb,
  _restock boolean,
  _shipping_amount integer,
  _amount integer,
  _note text,
  _stripe_reason text,
  _cancel_reason text,
  _notify_customer boolean,
  _actor_id uuid,
  _received_amount integer,
  _return_id uuid,
  _return_fee_deduction integer
)
RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_is_admin boolean;
  v_is_auto boolean;
  v_is_cancel boolean;
  v_restock boolean;
  v_notify boolean;
  v_note text;
  v_stripe_reason text;
  v_cancel_reason text;
  v_actor uuid;
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_refunds;
  v_refundable integer;
  v_refundable_shipping integer;
  v_shipped_total integer;
  v_unshipped_total integer;
  v_resolved jsonb;
  v_included integer;
  v_shipping integer;
  v_amount integer;
  v_priced jsonb;
  v_lines_amount integer;
  v_refund_id uuid;
  v_constraint text;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL
     OR _source IS NULL
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'return')
     OR ((_source = 'return') IS DISTINCT FROM (_return_id IS NOT NULL))
     OR (_source = 'return' AND (_return_fee_deduction IS NULL OR _return_fee_deduction < 0))
     OR (_source <> 'return' AND _return_fee_deduction IS NOT NULL)
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source IN ('admin', 'return');
  v_is_auto := _source IN ('auto_cancelled_order_payment', 'auto_amount_mismatch');
  v_is_cancel := _source IN ('order_cancel', 'auto_amount_mismatch');

  -- 商品の行を渡してよいのはアだけ（イ・オは DB が残りの未発送を全部入れ、エは行なし）。ア・イには二重防止の番号と実行した人が要る
  IF (NOT v_is_admin AND pg_catalog.jsonb_array_length(_lines) > 0)
     OR (NOT v_is_auto AND (_request_key IS NULL OR _actor_id IS NULL))
     OR (_note IS NOT NULL AND pg_catalog.char_length(_note) > 500)
     OR (_stripe_reason IS NOT NULL AND _stripe_reason NOT IN ('requested_by_customer', 'duplicate', 'fraudulent')) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- アの送料と額は呼ぶ側が決める。「うち送料」が額を超える返金は作らない
  IF v_is_admin AND (
       _shipping_amount IS NULL OR _shipping_amount < 0
       OR _amount IS NULL OR _amount < 1
       OR _shipping_amount > _amount
       OR _cancel_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- イの取消の理由は6つ。「その他」はメモも要る（未入金の取消の CANCEL_NOTE_REQUIRED と同じ決まり）
  IF _source = 'order_cancel' AND (
       _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')
       OR (_cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL)
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 自動の返金（エ・オ）は、呼ぶ側の値を使わず DB が決める。知らせる・Stripe に理由を伝えない。
  -- オは在庫に戻し、取消の理由は other、メモは決まった文。実行した人は空
  v_restock := CASE WHEN _source = 'auto_amount_mismatch' THEN true ELSE _restock END;
  v_notify := CASE WHEN v_is_auto THEN true ELSE _notify_customer END;
  v_note := CASE _source
    WHEN 'auto_amount_mismatch' THEN '支払額の違いの自動の取消'
    WHEN 'auto_cancelled_order_payment' THEN NULL
    ELSE _note
  END;
  v_stripe_reason := CASE WHEN v_is_auto THEN NULL ELSE _stripe_reason END;
  v_cancel_reason := CASE _source
    WHEN 'order_cancel' THEN _cancel_reason
    WHEN 'auto_amount_mismatch' THEN 'other'
    ELSE NULL
  END;
  v_actor := CASE WHEN v_is_auto THEN NULL ELSE _actor_id END;

  -- 二重防止の指紋（本計画 P2）: 呼ぶ側が渡した入力を、渡されたままの値で決まった順に並べた JSON の md5。
  IF _request_key IS NOT NULL THEN
    v_fingerprint := pg_catalog.md5(
      pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'source', _source,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_object(
                     'order_item_id', p.order_item_id,
                     'before_shipment', p.before_shipment,
                     'quantity', p.quantity
                   )
                   ORDER BY p.order_item_id, p.before_shipment
                 )
          FROM private.parse_refund_lines(_lines) AS p
        ), '[]'::jsonb),
        'restock', _restock,
        'shipping_amount', _shipping_amount,
        'amount', _amount,
        'note', _note,
        'stripe_reason', _stripe_reason,
        'cancel_reason', _cancel_reason,
        'notify_customer', _notify_customer,
        'received_amount', _received_amount
      )::text
    );
  END IF;

  -- Task 10: every core caller owns the advisory and the full ordered row closure.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _source = 'return' THEN
    PERFORM 1 FROM public.order_returns AS r WHERE r.id=_return_id AND r.order_id=_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT rr.request_fingerprint INTO v_fingerprint FROM public.order_return_receipts AS rr
    WHERE rr.request_key=_request_key AND rr.return_id=_return_id AND rr.kind='receive';
    IF NOT FOUND THEN
      v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_received_amount,
        'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
    END IF;
  END IF;

  -- 3. 同じ二重防止の番号の送り直し。同じ中身なら前の記録を返し、中身が違えば断る
  IF _request_key IS NOT NULL THEN
    SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.request_key = _request_key;
    IF FOUND THEN
      IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
      END IF;
      RETURN QUERY SELECT v_existing.id, v_existing.amount, v_existing.status, true;
      RETURN;
    END IF;
  END IF;

  -- 4. エは取り消した注文だけ。受け取った額が空なら、入金を見つけた額を注文に書く
  IF _source = 'auto_cancelled_order_payment' THEN
    IF v_order.status <> 'cancelled'::public.order_status THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
    END IF;
    IF v_order.paid_amount IS NULL THEN
      IF _received_amount IS NULL OR _received_amount < 1 THEN
        RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
      PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);
      UPDATE public.orders AS o SET paid_amount = _received_amount WHERE o.id = _order_id;
      v_order.paid_amount := _received_amount;
    END IF;
  END IF;

  -- 5. 返金できる状態: 支払い済み・発送済み・取り消した注文で、受け取った額がある
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status, 'cancelled'::public.order_status)
     OR v_order.paid_amount IS NULL
     OR v_order.paid_amount < 1 THEN
    RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 6. 返事待ちの返金がある注文には、新しい返金を作れない
  IF EXISTS (
    SELECT 1
    FROM public.order_refunds AS r
    WHERE r.order_id = _order_id
      AND r.status = 'awaiting_response'
  ) THEN
    RAISE EXCEPTION 'AWAITING_REFUND_EXISTS' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.shipped), 0)::integer, COALESCE(pg_catalog.sum(l.unshipped), 0)::integer
  INTO v_shipped_total, v_unshipped_total
  FROM private.order_line_fulfillment(_order_id) AS l;

  -- 7. キャンセルは、支払い済みで1つも発送していない注文だけ
  IF v_is_cancel AND (v_order.status <> 'paid'::public.order_status OR v_shipped_total > 0) THEN
    RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
  END IF;

  -- 8. 返せる額 = 受け取った額 − 返事待ち・保留・成功の返金。0なら何も返せない
  SELECT a.refundable_amount, a.refundable_shipping INTO v_refundable, v_refundable_shipping
  FROM private.order_refund_amounts(_order_id) AS a;
  IF v_refundable IS NULL OR v_refundable < 1 THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 9. 商品の行。イ・オは残りの未発送を全部、発送前の行に入れる。エは行なし
  IF v_is_admin THEN
    v_resolved := _lines;
  ELSIF v_is_cancel THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('order_item_id', l.order_item_id, 'before_shipment', true, 'quantity', l.unshipped)
               ORDER BY l.order_item_id
             ),
             '[]'::jsonb
           )
    INTO v_resolved
    FROM private.order_line_fulfillment(_order_id) AS l
    WHERE l.unshipped > 0;
  ELSE
    v_resolved := '[]'::jsonb;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.order_items AS oi WHERE oi.id = p.order_item_id AND oi.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'REFUND_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE p.before_shipment
      AND p.quantity > l.unshipped
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_return_counts(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE NOT p.before_shipment AND _source <> 'return'
      AND p.quantity > l.refundable_after_shipment
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_SHIPPED' USING ERRCODE = '22023';
  END IF;

  -- 返品の返金は、受け取った返金の品で覆われていない数まで。発送前には使わせない。
  IF _source='return' AND EXISTS (
    SELECT 1 FROM private.parse_refund_lines(v_resolved) AS p
    WHERE p.before_shipment OR p.quantity > COALESCE((
      SELECT pg_catalog.sum(g.refund_waiting)::integer
      FROM private.order_return_line_progress(_return_id) AS g
      JOIN public.order_return_lines AS rl ON rl.id=g.return_line_id
      WHERE rl.order_item_id=p.order_item_id
    ),0)
  ) THEN RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;

  -- 10. 送料と額。アは呼ぶ側の値。イ・エ・オは返せる額の全部で、送料はイ・オだけ返せる送料の全部
  IF v_is_admin THEN
    v_shipping := _shipping_amount;
    v_amount := _amount;
  ELSE
    v_amount := v_refundable;
    v_shipping := CASE
      WHEN _source = 'auto_cancelled_order_payment' THEN 0
      ELSE LEAST(v_refundable_shipping, v_refundable)
    END;
  END IF;
  IF v_shipping > v_refundable_shipping THEN
    RAISE EXCEPTION 'REFUND_SHIPPING_EXCEEDS' USING ERRCODE = '22023';
  END IF;
  IF v_amount > v_refundable THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 11. 全額の時の決まり（アだけ）
  IF v_is_admin THEN
    SELECT COALESCE(pg_catalog.sum(p.quantity) FILTER (WHERE p.before_shipment), 0)::integer INTO v_included
    FROM private.parse_refund_lines(v_resolved) AS p;

    IF v_amount = v_refundable AND v_unshipped_total - v_included > 0 THEN
      RAISE EXCEPTION 'REFUND_MUST_INCLUDE_UNSHIPPED' USING ERRCODE = '22023';
    END IF;
    IF v_shipped_total = 0
       AND v_included > 0
       AND v_unshipped_total - v_included = 0
       AND (v_shipping <> LEAST(v_refundable_shipping, v_refundable) OR v_amount <> v_refundable) THEN
      RAISE EXCEPTION 'REFUND_MUST_BE_FULL' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 12. 商品ごとの額（設計書 4-5）。在庫に戻すのは、発送前・在庫の品・チェックありの行だけ
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', q.order_item_id,
               'before_shipment', q.before_shipment,
               'quantity', q.quantity,
               'restock_type', CASE
                 WHEN _source='return' THEN 'return'::text
                 WHEN q.before_shipment AND q.fulfillment_type = 'stock' AND v_restock THEN 'cancel'::text
                 ELSE 'no_restock'::text
               END,
               'amount', private.return_units_amount(q.order_item_id,q.quantity,q.earlier_in_refund)
             )
             ORDER BY q.order_item_id, q.before_shipment DESC
           ),
           '[]'::jsonb
         )
  INTO v_priced
  FROM (
    SELECT p.order_item_id,
           p.before_shipment,
           p.quantity,
           l.fulfillment_type,
           oi.item_price,
           oi.quantity AS ordered,
           d.line_discount,
           l.refunded_before_shipment + l.refunded_after_shipment AS already_refunded,
           COALESCE(pg_catalog.sum(p.quantity) OVER (
             PARTITION BY p.order_item_id
             ORDER BY p.before_shipment DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0)::integer AS earlier_in_refund
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = p.order_item_id
  ) AS q;

  SELECT COALESCE(pg_catalog.sum(x.amount), 0)::integer INTO v_lines_amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  -- 13. 記録。計算との差 = 返金額 − （行の額の合計 + 送料）
  BEGIN
    INSERT INTO public.order_refunds AS r
      (id, return_id, order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount,
       note, stripe_reason, cancel_reason, notify_customer, actor_id, return_fee_deduction)
    VALUES
      (COALESCE((SELECT rr.refund_id FROM public.order_return_receipts AS rr WHERE rr.return_id=_return_id AND rr.request_key=_request_key),pg_catalog.gen_random_uuid()),
       _return_id, _order_id, _source, _request_key, v_fingerprint, 'awaiting_response', v_amount, v_shipping,
       v_amount - (v_lines_amount + v_shipping), v_note, v_stripe_reason, v_cancel_reason, v_notify, v_actor, COALESCE(_return_fee_deduction, 0))
    RETURNING r.id INTO v_refund_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_refunds_request_key_key' THEN
      RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
  SELECT v_refund_id, x.order_item_id, x.quantity, x.before_shipment, x.restock_type, x.amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  IF _source <> 'return' THEN
    -- 返金の行が覆った後の数で完了を確かめ、返品が操作できない受付中のまま残るのを防ぐ。
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id;
  END IF;
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;
ALTER FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- begin: common lock and the order closure -> before -> core (awaiting_response: the coverage makes the units
-- cancelled / not shippable, every A is kept) -> state seq 1 -> operation. A replay changes nothing.
CREATE FUNCTION private.begin_order_refund(
  _order_id uuid, _source text, _request_key uuid, _lines jsonb, _restock boolean,
  _shipping_amount integer, _amount integer, _note text, _stripe_reason text, _cancel_reason text,
  _notify_customer boolean, _actor_id uuid, _received_amount integer DEFAULT NULL
) RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_result record;
BEGIN
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[],
    CASE WHEN _order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[_order_id] END, NULL);
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  SELECT c.refund_id AS id, c.amount AS refund_amount, c.status AS refund_status, c.replayed AS was_replayed
  INTO v_result
  FROM private.begin_order_refund_core(_order_id, _source, _request_key, _lines, _restock, _shipping_amount,
    _amount, _note, _stripe_reason, _cancel_reason, _notify_customer, _actor_id, _received_amount,
    NULL::uuid, NULL::integer) AS c;

  IF NOT v_result.was_replayed THEN
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'begin_order_refund', _actor_id);
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      v_operation,
      'begin_order_refund',
      COALESCE(_request_key, pg_catalog.md5('begin_order_refund:' || v_result.id::text)::uuid),
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', 'begin_order_refund', 'order_id', _order_id, 'source', _source, 'request_key', _request_key,
        'lines', _lines, 'restock', _restock, 'shipping_amount', _shipping_amount, 'amount', _amount, 'note', _note,
        'stripe_reason', _stripe_reason, 'cancel_reason', _cancel_reason, 'notify_customer', _notify_customer,
        'actor_id', _actor_id, 'received_amount', _received_amount, 'refund_id', v_result.id)::text, 'UTF8')), 'hex'),
      'order_refund',
      v_result.id::text,
      _actor_id,
      pg_catalog.jsonb_build_object('refund_id', v_result.id, 'order_id', _order_id, 'amount', v_result.refund_amount,
        'status', v_result.refund_status)
    );
  END IF;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_result.id, v_result.refund_amount, v_result.refund_status, v_result.was_replayed;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.begin_order_refund(
  _order_id uuid, _source text, _request_key uuid, _lines jsonb, _restock boolean,
  _shipping_amount integer, _amount integer, _note text, _stripe_reason text, _cancel_reason text,
  _notify_customer boolean, _actor_id uuid, _received_amount integer DEFAULT NULL
) RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.begin_order_refund(_order_id, _source, _request_key, _lines, _restock, _shipping_amount,
    _amount, _note, _stripe_reason, _cancel_reason, _notify_customer, _actor_id, _received_amount);
$$;
ALTER FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
  TO service_role;

-- Internal core: the refund's money/notice state after a result. The caller owns the common lock, the order
-- closure and the operation (app.group_g_operation_id). No lock, no nested public RPC, no I/O.
--  2. First acceptance (pending/succeeded) only: each pre-shipment line releases only the A that the unshipped,
--     not-yet-accepted units no longer need (unallocated units are covered first), from the line's A of any
--     original kind. cancel (and a backorder line's A) -> refund/+n then FIFO; an in-stock no_restock line ->
--     refund/+n paired with adjustment/-n (same refund, no FIFO in between). After-shipment lines never add stock.
--  4. First failure: the coverage is gone; what the refund released returns to waiting and joins the normal FIFO
--     by the original order date. Another order's A is never taken; the shortage stays on the line and marks the
--     existing review (stock_not_reserved).
CREATE OR REPLACE FUNCTION private.apply_order_refund_state(_refund_id uuid)
RETURNS TABLE (
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_operation uuid;
  v_line record;
  v_allocation record;
  v_left integer;
  v_take integer;
  v_movement bigint;
  v_accepted boolean := false;
  v_failed boolean := false;
  v_rereserve boolean := false;
  v_email boolean := false;
  v_exception uuid;
  v_shortage integer := 0;
  v_fifo_variants bigint[] := ARRAY[]::bigint[];
  v_kind text;
  v_variant text;
  v_succeeded integer;
  v_succeeded_at timestamptz;
  v_full integer;
  v_refunded integer;
  v_unshipped integer;
  v_shipped integer;
  v_target public.order_status;
  v_reason text := 'refund_projection';
  v_cancel_reason text;
  v_cancel_note text;
  v_cancel_notify boolean;
  v_shipped_at timestamptz;
  v_carrier text;
  v_tracking text;
  v_last_shipped_at timestamptz;
  v_last_carrier text;
  v_last_tracking text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  v_operation := NULLIF(pg_catalog.current_setting('app.group_g_operation_id', true), '')::uuid;
  IF v_operation IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_refund.order_id;
  v_target := v_order.status;
  v_refunded := v_order.refunded_amount;

  -- 2. Stripe が受け付けた時（保留か成功に初めてなった時）の1回だけ、割当を外す。写しは動かさない
  IF v_refund.source <> 'legacy'
     AND v_refund.stock_applied_at IS NULL
     AND v_refund.status IN ('pending', 'succeeded') THEN
    FOR v_line IN
      -- Controller ruling: an allocated unit is physical stock whatever the line's original kind. Only an in-stock
      -- line whose refund chose not to restock writes its released A off; a backorder line's A goes back to stock
      -- (its recorded no_restock only meant "nothing reserved"), and unallocated units add nothing.
      SELECT rl.id AS line_id, rl.order_item_id, oi.variant_id,
             CASE WHEN rl.restock_type = 'no_restock' AND oi.fulfillment_type = 'stock' THEN 'no_restock'
                  ELSE 'cancel' END AS restock_type,
             LEAST(rl.quantity, GREATEST(
               COALESCE((SELECT pg_catalog.sum(a.remaining_quantity) FROM public.order_item_allocations AS a
                         WHERE a.order_item_id = oi.id AND a.kind = 'paid'), 0)
               - GREATEST(oi.quantity
                   - COALESCE((SELECT pg_catalog.sum(fl.quantity) FROM public.order_fulfillment_lines AS fl
                               JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
                               WHERE fl.order_item_id = oi.id AND f.cancelled_at IS NULL), 0)
                   - COALESCE((SELECT pg_catalog.sum(x.quantity) FROM public.order_refund_lines AS x
                               JOIN public.order_refunds AS r ON r.id = x.refund_id
                               WHERE x.order_item_id = oi.id AND x.before_shipment
                                 AND r.status IN ('pending', 'succeeded')
                                 AND (r.stock_applied_at IS NOT NULL OR r.id = v_refund.id)), 0), 0), 0))::integer
               AS release_quantity
      FROM public.order_refund_lines AS rl
      JOIN public.order_items AS oi ON oi.id = rl.order_item_id
      WHERE rl.refund_id = v_refund.id
        AND rl.before_shipment
        AND oi.variant_id IS NOT NULL
      ORDER BY oi.variant_id, rl.order_item_id
    LOOP
      CONTINUE WHEN v_line.release_quantity <= 0;
      v_left := v_line.release_quantity;
      FOR v_allocation IN
        SELECT a.id, a.remaining_quantity
        FROM public.order_item_allocations AS a
        WHERE a.order_item_id = v_line.order_item_id AND a.kind = 'paid' AND a.remaining_quantity > 0
        ORDER BY a.created_at DESC, a.id DESC
      LOOP
        EXIT WHEN v_left = 0;
        v_take := LEAST(v_left, v_allocation.remaining_quantity);
        UPDATE public.order_item_allocations AS a
        SET remaining_quantity = a.remaining_quantity - v_take, version = a.version + 1, updated_at = pg_catalog.now()
        WHERE a.id = v_allocation.id;
        INSERT INTO public.stock_movements
          (variant_id, delta, reason, order_id, order_item_id, note, created_by, refund_id, allocation_operation_id)
        VALUES
          (v_line.variant_id, v_take, 'refund', v_order.id, v_line.order_item_id,
           CASE WHEN v_line.restock_type = 'cancel' THEN 'refund_restock' ELSE 'refund_release' END,
           v_refund.actor_id, v_refund.id, v_operation)
        RETURNING id INTO v_movement;
        INSERT INTO public.order_item_allocation_events
          (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
        VALUES
          (v_allocation.id, 'release', v_take, v_operation, 1, v_movement,
           CASE WHEN v_line.restock_type = 'cancel' THEN 'refund_restock' ELSE 'refund_release' END, v_refund.actor_id);
        v_left := v_left - v_take;
      END LOOP;
      IF v_line.restock_type = 'no_restock' THEN
        -- The written-off pair: free stock never rises between +n and -n, so FIFO does not run for it.
        INSERT INTO public.stock_movements
          (variant_id, delta, reason, order_id, order_item_id, note, created_by, refund_id)
        VALUES
          (v_line.variant_id, -v_line.release_quantity, 'adjustment', v_order.id, v_line.order_item_id,
           'refund_no_restock', v_refund.actor_id, v_refund.id);
      ELSE
        v_fifo_variants := v_fifo_variants || v_line.variant_id;
      END IF;
      UPDATE public.order_refund_lines AS l
      SET released_quantity = v_line.release_quantity,
          restocked_quantity = CASE WHEN v_line.restock_type = 'cancel' THEN v_line.release_quantity ELSE 0 END
      WHERE l.id = v_line.line_id;
    END LOOP;

    UPDATE public.order_refunds AS r SET stock_applied_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_accepted := true;
  END IF;

  -- 3. お客様へのメールの予定（1回だけ）。残高不足の保留は、お金が動く成功まで待つ。写しは書かない
  IF v_refund.source <> 'legacy'
     AND v_refund.notify_customer
     AND v_refund.email_enqueued_at IS NULL
     AND (v_refund.status = 'succeeded'
          OR (v_refund.status = 'pending' AND v_refund.stripe_pending_reason IS DISTINCT FROM 'insufficient_funds')) THEN
    IF v_refund.source IN ('order_cancel', 'auto_amount_mismatch') THEN
      v_kind := 'canceled';
      v_variant := 'paid';
    ELSIF v_refund.source = 'auto_cancelled_order_payment' THEN
      v_kind := 'refund';
      v_variant := 'after_cancel';
    ELSIF v_refund.source = 'return' THEN
      v_kind := 'refund';
      v_variant := 'return';
    ELSE
      v_kind := 'refund';
      v_variant := 'standard';
    END IF;
    PERFORM private.enqueue_order_email(v_order.id, v_kind, v_variant, NULL::uuid, v_refund.id);
    UPDATE public.order_refunds AS r SET email_enqueued_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_email := true;
  END IF;

  -- 4. 初めて失敗になった時の後始末（1回だけ）。写しは店へ知らせない
  IF v_refund.source <> 'legacy'
     AND v_refund.status = 'failed'
     AND v_refund.failure_applied_at IS NULL THEN
    -- 外した分は、注文の状態を戻した後の通常の FIFO で、元の注文日の順に確保し直す（下の 6）
    v_rereserve := v_refund.stock_applied_at IS NOT NULL;

    -- 要対応の支払いの印は Stripe の返金の番号。ただし、エラーにした後に受け付けられないまま失敗した記録は、
    -- エラーの時の要対応と同じ行になるよう記録の番号にする（P23）。共通の lock の下なので行の core を直に呼ぶ
    SELECT x.exception_id INTO v_exception
    FROM private.record_group_g_payment_exception_row(
      CASE
        WHEN v_refund.errored_at IS NOT NULL AND v_refund.accepted_at IS NULL THEN v_refund.id::text
        ELSE COALESCE(v_refund.stripe_refund_id, v_refund.id::text)
      END,
      'refund_failed',
      COALESCE(v_refund.stripe_failure_reason, 'unknown'),
      NULL::text,
      v_order.payment_intent_id,
      NULL::uuid,
      v_order.id
    ) AS x;

    UPDATE public.order_refunds AS r SET failure_applied_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_failed := true;
  END IF;

  -- 5. 注文の返金済みの額と状態（設計書 4-7）。支払い手続き中・未入金・失敗・放棄の注文は触らない
  IF v_order.status IN ('paid', 'shipped', 'cancelled') THEN
    SELECT COALESCE(pg_catalog.sum(r.amount), 0)::integer, pg_catalog.max(r.succeeded_at)
    INTO v_succeeded, v_succeeded_at
    FROM public.order_refunds AS r
    WHERE r.order_id = v_order.id
      AND r.status = 'succeeded';

    v_full := COALESCE(NULLIF(v_order.paid_amount, 0), v_order.total_amount);
    v_refunded := LEAST(v_succeeded, GREATEST(v_order.total_amount, COALESCE(v_order.paid_amount, 0)));

    SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer, COALESCE(pg_catalog.sum(l.shipped), 0)::integer
    INTO v_unshipped, v_shipped
    FROM private.order_line_fulfillment(v_order.id) AS l;

    IF v_order.status IN ('paid', 'shipped') AND v_succeeded >= v_full THEN
      v_target := 'cancelled'::public.order_status;
    ELSIF v_order.status = 'cancelled'
          AND v_succeeded < v_full
          AND private.order_cancelled_by_refund(v_order.id) THEN
      v_target := CASE
        WHEN v_unshipped = 0 AND v_shipped > 0 THEN 'shipped'::public.order_status
        ELSE 'paid'::public.order_status
      END;
    ELSIF v_order.status = 'paid' AND v_unshipped = 0 AND v_shipped > 0 THEN
      v_target := 'shipped'::public.order_status;
      v_reason := 'refund_completed_order';
    ELSIF v_order.status = 'shipped' AND v_unshipped > 0 THEN
      v_target := 'paid'::public.order_status;
      v_reason := 'refund_failed_reopened';
    END IF;

    v_cancel_reason := v_order.cancel_reason;
    v_cancel_note := v_order.cancel_note;
    v_cancel_notify := v_order.cancel_notify_customer;
    IF v_target = 'cancelled'::public.order_status AND v_order.status <> 'cancelled'::public.order_status THEN
      v_cancel_reason := v_refund.cancel_reason;
      v_cancel_note := CASE
        WHEN v_refund.cancel_reason IS NOT NULL THEN NULLIF(pg_catalog.btrim(v_refund.note), '')
      END;
      v_cancel_notify := CASE WHEN v_refund.cancel_reason IS NOT NULL THEN v_refund.notify_customer END;
    ELSIF v_target <> 'cancelled'::public.order_status AND v_order.status = 'cancelled'::public.order_status THEN
      v_cancel_reason := NULL;
      v_cancel_note := NULL;
      v_cancel_notify := NULL;
    END IF;

    v_shipped_at := v_order.shipped_at;
    v_carrier := v_order.shipping_carrier;
    v_tracking := v_order.tracking_number;
    IF v_target = 'shipped'::public.order_status AND v_order.status <> 'shipped'::public.order_status THEN
      SELECT f.shipped_at, f.shipping_carrier, f.tracking_number
      INTO v_last_shipped_at, v_last_carrier, v_last_tracking
      FROM public.order_fulfillments AS f
      WHERE f.order_id = v_order.id
        AND f.cancelled_at IS NULL
      ORDER BY f.number DESC
      LIMIT 1;
      IF FOUND THEN
        v_shipped_at := v_last_shipped_at;
        v_carrier := v_last_carrier;
        v_tracking := v_last_tracking;
      END IF;
    ELSIF v_target = 'paid'::public.order_status AND v_order.status <> 'paid'::public.order_status THEN
      v_shipped_at := NULL;
      v_carrier := NULL;
      v_tracking := NULL;
    END IF;

    IF v_target <> v_order.status
       OR v_refunded <> v_order.refunded_amount
       OR v_succeeded_at IS DISTINCT FROM v_order.refunded_at THEN
      PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_refund.actor_id::text, ''), true);
      PERFORM pg_catalog.set_config('app.order_change_reason', v_reason, true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

      UPDATE public.orders AS o
      SET status = v_target,
          refunded_amount = v_refunded,
          refunded_at = v_succeeded_at,
          payment_status_updated_at = CASE
            WHEN v_refunded <> o.refunded_amount THEN pg_catalog.now()
            ELSE o.payment_status_updated_at
          END,
          cancel_reason = v_cancel_reason,
          cancel_note = v_cancel_note,
          cancel_notify_customer = v_cancel_notify,
          shipped_at = v_shipped_at,
          shipping_carrier = v_carrier,
          tracking_number = v_tracking
      WHERE o.id = v_order.id;
    END IF;
  END IF;

  -- 6. FIFO after the order's status: released cancel stock goes to the oldest waiting orders, and a failed
  --    refund's released units wait again by their original order date (no A is taken from another order).
  IF v_rereserve THEN
    v_fifo_variants := v_fifo_variants || ARRAY(
      SELECT oi.variant_id
      FROM public.order_refund_lines AS rl
      JOIN public.order_items AS oi ON oi.id = rl.order_item_id
      WHERE rl.refund_id = v_refund.id AND rl.released_quantity > 0 AND oi.variant_id IS NOT NULL);
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_fifo_variants
  FROM pg_catalog.unnest(v_fifo_variants) AS x(id);
  IF pg_catalog.cardinality(v_fifo_variants) > 0 THEN
    PERFORM private.allocate_group_g_fifo(v_fifo_variants, v_operation, v_refund.actor_id);
  END IF;

  -- 7. 失敗の確保し直しの結果を行に一度だけ書く。足りない時は既存の要確認（理由が空か確認済みの時だけ付け直す）
  IF v_rereserve THEN
    FOR v_line IN
      SELECT rl.id AS line_id, rl.order_item_id, rl.released_quantity
      FROM public.order_refund_lines AS rl
      WHERE rl.refund_id = v_refund.id AND rl.released_quantity > 0
      ORDER BY rl.order_item_id
    LOOP
      SELECT LEAST(v_line.released_quantity, COALESCE(pg_catalog.sum(a.quantity), 0))::integer INTO v_take
      FROM public.order_item_allocations AS a
      WHERE a.order_item_id = v_line.order_item_id AND a.operation_id = v_operation;
      UPDATE public.order_refund_lines AS l
      SET rereserved_quantity = v_take,
          rereserve_shortage = v_line.released_quantity - v_take
      WHERE l.id = v_line.line_id;
      v_shortage := v_shortage + (v_line.released_quantity - v_take);
    END LOOP;

    IF v_shortage > 0 AND (v_order.review_reason IS NULL OR v_order.reviewed_at IS NOT NULL) THEN
      PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_refund.actor_id::text, ''), true);
      PERFORM pg_catalog.set_config('app.order_change_reason', v_reason, true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);
      UPDATE public.orders AS o
      SET review_reason = 'stock_not_reserved',
          review_marked_at = pg_catalog.now(),
          reviewed_at = NULL,
          reviewed_by = NULL
      WHERE o.id = v_order.id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT v_accepted,
         v_failed,
         v_target,
         v_refunded,
         COALESCE((
           SELECT pg_catalog.sum(rl.rereserve_shortage)
           FROM public.order_refund_lines AS rl
           WHERE rl.refund_id = v_refund.id
         ), 0)::integer,
         v_email,
         v_exception;
END;
$$;
ALTER FUNCTION private.apply_order_refund_state(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.apply_order_refund_state(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 返品の返金の状態が変わった後の、返品の後始末（P25・P26）。中身は最後の定義のまま。呼ぶ側が共通の lock と
-- 注文の閉包（返品・返金の行を含む）を持ち、返金の記録の状態を書いた後に、前の状態を渡して呼ぶ。
CREATE OR REPLACE FUNCTION private.apply_return_refund_outcome(_refund_id uuid, _from_status text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_receipt public.order_return_receipts%ROWTYPE;
  v_from_covers boolean;
  v_to_covers boolean;
  v_enqueued boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND OR v_refund.source <> 'return' OR v_refund.return_id IS NULL THEN
    RETURN false;
  END IF;
  v_from_covers := _from_status IN ('awaiting_response', 'pending', 'succeeded');
  v_to_covers := v_refund.status IN ('awaiting_response', 'pending', 'succeeded');

  IF v_refund.return_fee_deduction > 0 AND v_from_covers AND NOT v_to_covers THEN
    UPDATE public.order_returns AS rt
    SET fee_pending_deduction = rt.fee_pending_deduction + v_refund.return_fee_deduction
    WHERE rt.id = v_refund.return_id;
  ELSIF v_refund.return_fee_deduction > 0 AND NOT v_from_covers AND v_to_covers THEN
    UPDATE public.order_returns AS rt
    SET fee_pending_deduction = GREATEST(rt.fee_pending_deduction - v_refund.return_fee_deduction, 0)
    WHERE rt.id = v_refund.return_id;
  END IF;

  IF v_from_covers AND NOT v_to_covers
     AND v_refund.accepted_at IS NULL
     AND v_refund.email_enqueued_at IS NULL THEN
    SELECT rr.* INTO v_receipt
    FROM public.order_return_receipts AS rr
    WHERE rr.refund_id = _refund_id
      AND rr.kind = 'receive';
    IF FOUND AND v_receipt.notify_customer THEN
      v_enqueued := private.enqueue_return_email(v_refund.order_id, 'return_received', v_refund.return_id, v_receipt.id);
    END IF;
  END IF;

  PERFORM private.refresh_order_return_status(v_refund.return_id);
  RETURN v_enqueued;
END;
$$;
ALTER FUNCTION private.apply_return_refund_outcome(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.apply_return_refund_outcome(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- Internal core shared by record_order_refund_result and record_external_order_refund. The caller has validated
-- the Stripe fields, owns the common lock and the order closure, and captured the before-states. One operation per
-- refund transition (from -> to): it is written before FIFO so a re-reserved allocation keeps the refund as its
-- origin, and a repeated report of the same transition reuses it (the existing guards add nothing).
CREATE FUNCTION private.record_group_g_refund_result(
  _refund_id uuid,
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _operation text,
  _orders uuid[],
  _before jsonb
)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_current public.order_refunds%ROWTYPE;
  v_next text;
  v_request_key uuid;
  v_operation uuid;
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_error_exception uuid;
  v_applied record;
  v_return_email boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_current FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Stripe の返金の番号は、記録に1つだけ。別の記録がもう使っている番号も断る
  IF (v_current.stripe_refund_id IS NOT NULL AND v_current.stripe_refund_id <> _stripe_refund_id)
     OR (v_current.stripe_refund_id IS NULL AND EXISTS (
       SELECT 1
       FROM public.order_refunds AS x
       WHERE x.stripe_refund_id = _stripe_refund_id
         AND x.id <> _refund_id
     )) THEN
    RAISE EXCEPTION 'REFUND_STRIPE_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_next := CASE
    WHEN _stripe_status IN ('pending', 'requires_action') THEN 'pending'
    WHEN _stripe_status = 'succeeded' THEN 'succeeded'
    ELSE 'failed'
  END;

  -- 許す移り方。同じ状態のままの細目の更新も許す。許さない移り方は何も書かず今の値を返す（P22）
  IF v_next <> v_current.status AND NOT (
       (v_current.status = 'awaiting_response' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'error' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'pending' AND v_next IN ('succeeded', 'failed'))
    OR (v_current.status = 'succeeded' AND v_next = 'failed')
  ) THEN
    RETURN QUERY
    SELECT v_current.id,
           v_current.order_id,
           v_current.status,
           false,
           false,
           o.status,
           o.refunded_amount,
           COALESCE((
             SELECT pg_catalog.sum(rl.rereserve_shortage)
             FROM public.order_refund_lines AS rl
             WHERE rl.refund_id = v_current.id
           ), 0)::integer,
           false,
           NULL::uuid
    FROM public.orders AS o
    WHERE o.id = v_current.order_id;
    RETURN;
  END IF;

  v_request_key := pg_catalog.md5(_operation || ':' || _refund_id::text || ':' || v_current.status || ':' || v_next)::uuid;
  SELECT op.id INTO v_operation
  FROM private.group_g_operations AS op
  WHERE op.operation = _operation AND op.request_key = v_request_key;
  IF v_operation IS NULL THEN
    v_operation := pg_catalog.gen_random_uuid();
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      v_operation,
      _operation,
      v_request_key,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', _operation, 'refund_id', _refund_id, 'from_status', v_current.status,
        'to_status', v_next)::text, 'UTF8')), 'hex'),
      'order_refund',
      _refund_id::text,
      v_current.actor_id,
      pg_catalog.jsonb_build_object('refund_id', _refund_id, 'order_id', v_current.order_id,
        'from_status', v_current.status, 'to_status', v_next)
    );
  END IF;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  -- 番号・支払いの種類・時刻は、空から値へ1回だけ書く。細目は新しい値で上書きする
  UPDATE public.order_refunds AS r
  SET status = v_next,
      stripe_refund_id = COALESCE(r.stripe_refund_id, _stripe_refund_id),
      stripe_status = _stripe_status,
      stripe_pending_reason = _stripe_pending_reason,
      stripe_failure_reason = _stripe_failure_reason,
      customer_action_expires_at = COALESCE(_customer_action_expires_at, r.customer_action_expires_at),
      payment_method_type = COALESCE(r.payment_method_type, _payment_method_type),
      reference_number = COALESCE(NULLIF(pg_catalog.btrim(_reference_number), ''), r.reference_number),
      reference_type = COALESCE(_reference_type, r.reference_type),
      accepted_at = CASE
        WHEN v_next IN ('pending', 'succeeded') THEN COALESCE(r.accepted_at, pg_catalog.now())
        ELSE r.accepted_at
      END,
      succeeded_at = CASE WHEN v_next = 'succeeded' THEN COALESCE(r.succeeded_at, pg_catalog.now()) ELSE r.succeeded_at END,
      failed_at = CASE WHEN v_next = 'failed' THEN COALESCE(r.failed_at, pg_catalog.now()) ELSE r.failed_at END
  WHERE r.id = _refund_id;

  -- エラーにした記録が Stripe で見つかって保留・成功になった時は、エラーの時の要対応をシステムが閉じる（P23）。
  -- 発送前の行の商品が全部 s + rb ≤ q を保つ時だけ（controller ruling）
  IF v_current.status = 'error'
     AND v_next IN ('pending', 'succeeded')
     AND NOT EXISTS (
       SELECT 1
       FROM public.order_refund_lines AS rl
       JOIN private.order_line_fulfillment(v_current.order_id) AS l ON l.order_item_id = rl.order_item_id
       WHERE rl.refund_id = _refund_id
         AND rl.before_shipment
         AND l.shipped + l.refunded_before_shipment > l.quantity
     ) THEN
    SELECT e.id INTO v_error_exception
    FROM public.payment_exceptions AS e
    WHERE e.payment_ref = _refund_id::text
      AND e.reason = 'refund_failed'
      AND e.resolved_at IS NULL;
    IF FOUND THEN
      PERFORM private.resolve_group_g_payment_exception_row(v_error_exception, 'Stripe で返金が見つかったため自動で解決');
    END IF;
  END IF;

  SELECT a.* INTO v_applied FROM private.apply_order_refund_state(_refund_id) AS a;
  IF v_current.return_id IS NOT NULL THEN
    v_return_email := private.apply_return_refund_outcome(_refund_id, v_current.status);
  ELSE
    -- 普通の返金の結果が書かれた後の覆いで、受付中の返品を確かめ直す。
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id = v_current.order_id AND rt.status = 'open' ORDER BY rt.id;
  END IF;

  PERFORM private.record_group_g_item_state_changes(_before, _orders, v_operation, 1, _operation, v_current.actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY
  SELECT _refund_id,
         v_current.order_id,
         v_next,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued OR v_return_email,
         v_applied.exception_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.record_order_refund_result(
  _refund_id uuid,
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text
)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_orders uuid[];
  v_before jsonb;
BEGIN
  IF _refund_id IS NULL
     OR NOT private.refund_stripe_fields_valid(
       _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
       _payment_method_type, _reference_number, _reference_type
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- The refund's order (immutable) is read without a lock; the common lock and its closure come first.
  SELECT r.order_id INTO v_order_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  v_before := private.capture_group_g_item_states(v_orders);

  RETURN QUERY
  SELECT x.refund_id, x.order_id, x.status, x.newly_accepted, x.newly_failed, x.order_status, x.refunded_amount,
         x.rereserve_shortage, x.email_enqueued, x.exception_id
  FROM private.record_group_g_refund_result(_refund_id, _stripe_refund_id, _stripe_status, _stripe_pending_reason,
    _stripe_failure_reason, _customer_action_expires_at, _payment_method_type, _reference_number, _reference_type,
    'record_order_refund_result', v_orders, v_before) AS x;
END;
$$;
ALTER FUNCTION private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_order_refund_result(
  _refund_id uuid,
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text
)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.record_order_refund_result(_refund_id, _stripe_refund_id, _stripe_status,
    _stripe_pending_reason, _stripe_failure_reason, _customer_action_expires_at, _payment_method_type,
    _reference_number, _reference_type);
$$;
ALTER FUNCTION public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)
  TO service_role;

-- 印の無い返金（Stripe の画面からの返金・前からの写し）。中身は最後の定義のまま、共通の lock の下で記録を作り、
-- 結果は同じ取引の内部 core で書く（公開の結果の関数へ入れ子にしない）。
CREATE FUNCTION private.record_external_order_refund(
  _order_id uuid,
  _stripe_refund_id text,
  _amount integer,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _stripe_reason text,
  _stripe_created_at timestamptz
)
RETURNS TABLE (
  refund_id uuid,
  created boolean,
  source text,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_orders uuid[];
  v_before jsonb;
  v_order public.orders%ROWTYPE;
  v_existing public.order_refunds%ROWTYPE;
  v_refund_id uuid;
  v_created boolean := false;
  v_source text;
  v_started timestamptz;
  v_open integer := 0;
  v_open_shipping integer := 0;
  v_lines jsonb := '[]'::jsonb;
  v_lines_amount integer := 0;
  v_shipping integer := 0;
  v_applied record;
BEGIN
  IF _order_id IS NULL
     OR _amount IS NULL
     OR _amount < 1
     OR _stripe_created_at IS NULL
     OR NOT private.refund_stripe_fields_valid(
       _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
       _payment_method_type, _reference_number, _reference_type
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);

  SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.stripe_refund_id = _stripe_refund_id;
  IF FOUND THEN
    -- 同じ Stripe の返金は、ほかの注文の記録にならない
    IF v_existing.order_id <> _order_id THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_refund_id := v_existing.id;
    v_source := v_existing.source;
  ELSE
    SELECT s.started_at INTO v_started FROM private.refund_ledger_state AS s WHERE s.id = 1;
    v_source := CASE WHEN _stripe_created_at < v_started THEN 'legacy' ELSE 'stripe_dashboard' END;

    -- 返事待ち・保留・成功の合計にこの額を足すと全額に届く時は、残りの未発送を全部発送前の行にする
    IF v_source = 'stripe_dashboard'
       AND _stripe_status IN ('pending', 'requires_action', 'succeeded')
       AND v_order.status IN ('paid', 'shipped') THEN
      SELECT COALESCE(pg_catalog.sum(r.amount), 0)::integer, COALESCE(pg_catalog.sum(r.shipping_amount), 0)::integer
      INTO v_open, v_open_shipping
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
        AND r.status IN ('awaiting_response', 'pending', 'succeeded');

      IF v_open + _amount >= COALESCE(NULLIF(v_order.paid_amount, 0), v_order.total_amount) THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'order_item_id', x.order_item_id,
                   'quantity', x.unshipped,
                   'restock_type', x.restock_type,
                   'amount', x.line_amount
                 ) ORDER BY x.created_at, x.order_item_id
               ), '[]'::jsonb)
        INTO v_lines
        FROM (
          SELECT l.order_item_id,
                 l.unshipped,
                 CASE WHEN l.fulfillment_type = 'stock' THEN 'cancel' ELSE 'no_restock' END AS restock_type,
                 oi.item_price * l.unshipped
                   - (private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment + l.unshipped
                      )
                      - private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment
                      )) AS line_amount,
                 oi.created_at
          FROM private.order_line_fulfillment(_order_id) AS l
          JOIN public.order_items AS oi ON oi.id = l.order_item_id
          LEFT JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = l.order_item_id
          WHERE l.unshipped > 0
        ) AS x;

        v_shipping := LEAST(GREATEST(v_order.shipping_amount - v_open_shipping, 0), _amount);
      END IF;
    END IF;

    SELECT COALESCE(pg_catalog.sum((e.value ->> 'amount')::integer), 0)::integer
    INTO v_lines_amount
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

    INSERT INTO public.order_refunds AS r
      (order_id, source, stripe_refund_id, status, amount, shipping_amount, adjustment_amount,
       stripe_reason, notify_customer, created_at)
    VALUES
      (_order_id, v_source, _stripe_refund_id, 'awaiting_response', _amount, v_shipping,
       _amount - v_lines_amount - v_shipping,
       CASE WHEN _stripe_reason IN ('requested_by_customer', 'duplicate', 'fraudulent') THEN _stripe_reason END,
       v_source <> 'legacy', _stripe_created_at)
    RETURNING r.id INTO v_refund_id;

    INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
    SELECT v_refund_id,
           (e.value ->> 'order_item_id')::uuid,
           (e.value ->> 'quantity')::integer,
           true,
           e.value ->> 'restock_type',
           (e.value ->> 'amount')::integer
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

    v_created := true;
  END IF;

  SELECT x.* INTO v_applied
  FROM private.record_group_g_refund_result(
    v_refund_id, _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
    _customer_action_expires_at, _payment_method_type, _reference_number, _reference_type,
    'record_external_order_refund', v_orders, v_before
  ) AS x;

  RETURN QUERY
  SELECT v_refund_id,
         v_created,
         v_source,
         v_applied.status,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued,
         v_applied.exception_id;
END;
$$;
ALTER FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_external_order_refund(
  _order_id uuid,
  _stripe_refund_id text,
  _amount integer,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _stripe_reason text,
  _stripe_created_at timestamptz
)
RETURNS TABLE (
  refund_id uuid,
  created boolean,
  source text,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.record_external_order_refund(_order_id, _stripe_refund_id, _amount, _stripe_status,
    _stripe_pending_reason, _stripe_failure_reason, _customer_action_expires_at, _payment_method_type,
    _reference_number, _reference_type, _stripe_reason, _stripe_created_at);
$$;
ALTER FUNCTION public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  TO service_role;

-- 返事待ちだけをエラーにする（E-2 の本文のまま）。共通の lock の下で、覆いを外すだけ: 外していない A は持ったまま
-- 増やさず（FIFO を動かさない）、在庫・メールの予定・失敗の後始末は動かない。
CREATE FUNCTION private.mark_order_refund_error(_refund_id uuid, _reason text, _raise_exception boolean)
RETURNS TABLE (outcome text, order_id uuid, exception_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_order public.orders%ROWTYPE;
  v_refund public.order_refunds%ROWTYPE;
  v_exception uuid;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _refund_id IS NULL
     OR _raise_exception IS NULL
     OR _reason IS NULL
     OR _reason !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_order_id;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;

  IF v_refund.status <> 'awaiting_response' THEN
    RETURN QUERY SELECT 'not_awaiting'::text, v_order_id, NULL::uuid;
    RETURN;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_refunds AS r
  SET status = 'error',
      stripe_failure_reason = _reason,
      errored_at = pg_catalog.now()
  WHERE r.id = _refund_id;

  IF _raise_exception THEN
    SELECT x.exception_id INTO v_exception
    FROM private.record_group_g_payment_exception_row(
      _refund_id::text,
      'refund_failed',
      _reason,
      NULL::text,
      v_order.payment_intent_id,
      NULL::uuid,
      v_order_id
    ) AS x;
  END IF;

  -- エラーの記録では、在庫・メールの予定・失敗の後始末は動かず、注文の状態だけが動く（E-2 のまま）
  PERFORM 1 FROM private.apply_order_refund_state(_refund_id);

  IF v_refund.return_id IS NOT NULL THEN
    PERFORM private.apply_return_refund_outcome(_refund_id, 'awaiting_response');
  ELSE
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id = v_order_id AND rt.status = 'open' ORDER BY rt.id;
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'mark_order_refund_error',
    v_refund.actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_refund_error',
    pg_catalog.md5('mark_order_refund_error:' || _refund_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_refund_error', 'refund_id', _refund_id, 'reason', _reason,
      'raise_exception', _raise_exception)::text, 'UTF8')), 'hex'),
    'order_refund',
    _refund_id::text,
    v_refund.actor_id,
    pg_catalog.jsonb_build_object('refund_id', _refund_id, 'order_id', v_order_id, 'exception_id', v_exception)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT 'errored'::text, v_order_id, v_exception;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.mark_order_refund_error(uuid,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_refund_error(uuid,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_refund_error(uuid,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_order_refund_error(_refund_id uuid, _reason text, _raise_exception boolean)
RETURNS TABLE (outcome text, order_id uuid, exception_id uuid)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.mark_order_refund_error(_refund_id, _reason, _raise_exception); $$;
ALTER FUNCTION public.mark_order_refund_error(uuid,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_refund_error(uuid,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_refund_error(uuid,text,boolean) TO service_role;

DO $g1_refund_assert$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)'),
    pg_catalog.to_regprocedure('private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)'),
    pg_catalog.to_regprocedure('private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)'),
    pg_catalog.to_regprocedure('private.mark_order_refund_error(uuid,text,boolean)')
  ) AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 4
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)'),
    pg_catalog.to_regprocedure('public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)'),
    pg_catalog.to_regprocedure('public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)'),
    pg_catalog.to_regprocedure('public.mark_order_refund_error(uuid,text,boolean)')
  ) AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 4
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)'),
    pg_catalog.to_regprocedure('private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)'),
    pg_catalog.to_regprocedure('private.resolve_group_g_payment_exception_row(uuid,text)'),
    pg_catalog.to_regprocedure('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)'),
    pg_catalog.to_regprocedure('private.apply_order_refund_state(uuid)'),
    pg_catalog.to_regprocedure('private.apply_return_refund_outcome(uuid,text)')
  ) AND p.proowner = 'postgres'::regrole AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 6 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_refund_functions';
  END IF;
END;
$g1_refund_assert$;

-- Task 9: cancel request intake / decline / close / resolve under the common lock. Last definitions replaced
-- (signature/defaults/returns kept): customer_order_for_request/customer_request_cancel
-- 20261020144842_order_return_customer_requests.sql:22/922, lock_order_cancel_request/admin_decline_cancel_request/
-- admin_close_cancel_request/admin_resolve_cancel_request 20261020150415_order_return_request_reviews.sql:937/980/1006/1026.
-- A request only changes the state of the requested units and keeps every A (FIFO skips cancel_requested units).
-- Decline/close return the units to waiting: the existing A becomes ready again and the unallocated units rejoin FIFO.
-- Resolve releases nothing itself: the refund/cancel body already released once; it only reruns FIFO for the units
-- the refund did not cover. The order closure (orders -> ... -> refunds -> cancel requests) is locked once by the
-- private body before the request row is read for update, so no request -> refund reverse order remains.

-- Ownership is read without any lock first, so a stranger's call never waits on (or locks) somebody else's order.
-- _lock=false stays a plain read. Task 10: _lock=true requires the caller's pre-acquired closure.
CREATE OR REPLACE FUNCTION private.customer_order_for_request(_order_id uuid, _customer_id uuid, _lock boolean)
RETURNS public.orders
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
BEGIN
  IF _order_id IS NULL OR _customer_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.user_id = _customer_id;
  IF NOT FOUND
     OR v_order.status IN ('payment_in_progress'::public.order_status, 'abandoned'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(_lock, false) THEN
    RETURN v_order;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  -- The closure already holds this row; the re-read sees the state after any concurrent writer committed.
  SELECT o.* INTO v_order
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.user_id = _customer_id;
  IF NOT FOUND
     OR v_order.status IN ('payment_in_progress'::public.order_status, 'abandoned'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_order;
END;
$$;
ALTER FUNCTION private.customer_order_for_request(uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.customer_order_for_request(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;

-- The request row is read for update only after the caller locked the whole order closure under the advisory
-- (the request rows come last in that order). It never goes back to the order row.
CREATE OR REPLACE FUNCTION private.lock_order_cancel_request(_cancel_request_id uuid)
RETURNS public.order_cancel_requests
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_request public.order_cancel_requests;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_request FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN v_request;
END;
$$;
ALTER FUNCTION private.lock_order_cancel_request(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_order_cancel_request(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The customer's cancel request (E-3 body). Refusal order kept: arguments -> owner -> request key -> settings ->
-- order status -> open request -> quantities. The owner check reads without a lock; the common lock comes next.
-- Only the requested units change state (ready/in_production/unpaid -> cancel_requested); A/H stay, FIFO does not run.
CREATE FUNCTION private.customer_request_cancel(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb,
  _customer_note text
)
RETURNS TABLE (cancel_request_id uuid, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- Trims half-width space, tab, CR, LF and the ideographic space U+3000 (as parse_customer_return_lines does).
  v_note text := NULLIF(pg_catalog.btrim(_customer_note, E' \t\r\n\u3000'), '');
  v_item jsonb;
  v_item_id uuid;
  v_quantity integer;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_cancel_requests;
  v_settings public.shop_return_settings;
  v_cancel_id uuid;
  v_constraint text;
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _order_id IS NULL OR _customer_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND pg_catalog.char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) < 1 OR pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'order_item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_item ->> 'order_item_id')::uuid;
      v_quantity := (v_item ->> 'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF v_quantity < 1 OR v_quantity > 999 OR v_item_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_item_id;
  END LOOP;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', (
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('order_item_id', x.order_item_id, 'quantity', x.quantity)
                 ORDER BY x.order_item_id
               )
        FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer)
      ),
      'customer_note', v_note
    )::text
  );

  -- Owner (plain read, no lock) -> common advisory and the order closure -> owner again under the lock.
  PERFORM private.customer_order_for_request(_order_id, _customer_id, false);
  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  v_order := private.customer_order_for_request(_order_id, _customer_id, true);

  -- The same request key replays the earlier request (no record, mail, state history or operation).
  SELECT c.* INTO v_existing FROM public.order_cancel_requests AS c WHERE c.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, 'requested'::text, true;
    RETURN;
  END IF;

  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;
  IF NOT v_settings.requests_enabled
     OR v_settings.request_types NOT IN ('returns_and_cancellations', 'cancellations_only') THEN
    RAISE EXCEPTION 'RETURN_REQUESTS_CLOSED' USING ERRCODE = '22023';
  END IF;

  IF v_order.status NOT IN ('pending'::public.order_status, 'paid'::public.order_status) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_cancel_requests AS c
    WHERE c.order_id = _order_id
      AND c.status = 'requested'
  ) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_EXISTS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer)
    LEFT JOIN private.order_line_fulfillment(_order_id) AS f ON f.order_item_id = x.order_item_id
    WHERE f.order_item_id IS NULL
       OR x.quantity > f.unshipped
  ) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(ARRAY[_order_id]);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  BEGIN
    INSERT INTO public.order_cancel_requests AS c
      (order_id, status, request_key, request_fingerprint, customer_note, requested_by)
    VALUES
      (_order_id, 'requested', _request_key, v_fingerprint, v_note, _customer_id)
    RETURNING c.id INTO v_cancel_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_cancel_requests_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_cancel_request_lines (cancel_request_id, order_item_id, quantity)
  SELECT v_cancel_id, x.order_item_id, x.quantity
  FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer);

  PERFORM private.enqueue_cancel_request_email(_order_id, 'cancel_request_received', v_cancel_id);
  PERFORM private.enqueue_cancel_request_email(_order_id, 'cancel_request_shop', v_cancel_id);

  PERFORM private.record_group_g_item_state_changes(v_before, ARRAY[_order_id], v_operation, 1,
    'customer_request_cancel', _customer_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'customer_request_cancel',
    _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'customer_request_cancel', 'order_id', _order_id, 'customer_id', _customer_id,
      'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_cancel_request',
    v_cancel_id::text,
    _customer_id,
    pg_catalog.jsonb_build_object('cancel_request_id', v_cancel_id, 'order_id', _order_id)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_cancel_id, 'requested'::text, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.customer_request_cancel(uuid,uuid,uuid,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.customer_request_cancel(uuid,uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.customer_request_cancel(uuid,uuid,uuid,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.customer_request_cancel(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb,
  _customer_note text
)
RETURNS TABLE (cancel_request_id uuid, status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.customer_request_cancel(_order_id, _customer_id, _request_key, _lines, _customer_note); $$;
ALTER FUNCTION public.customer_request_cancel(uuid,uuid,uuid,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.customer_request_cancel(uuid,uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_request_cancel(uuid,uuid,uuid,jsonb,text) TO service_role;

-- Decline (E-3 body): the order is unchanged, the message mail is always queued. The requested units return to
-- waiting (existing A -> ready, the rest -> in_production), then FIFO on the requested variants (sequence 2).
CREATE FUNCTION private.admin_decline_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_request public.order_cancel_requests;
  v_message text := NULLIF(pg_catalog.btrim(_decline_message),'');
  v_order_id uuid;
  v_orders uuid[];
  v_variants bigint[];
  v_before jsonb;
  v_middle jsonb;
  v_allocated integer := 0;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL OR _decline_reason IS NULL
    OR _decline_reason NOT IN ('window_passed','final_sale','other') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_message IS NULL OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RETURN_DECLINE_MESSAGE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.order_cancel_request_lines AS l JOIN public.order_items AS oi ON oi.id = l.order_item_id
  WHERE l.cancel_request_id = _cancel_request_id AND oi.variant_id IS NOT NULL;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  UPDATE public.order_cancel_requests AS r SET status='declined',declined_at=pg_catalog.now(),declined_by=_actor_id,
    decline_reason=_decline_reason,decline_message=v_message WHERE r.id=_cancel_request_id;
  PERFORM private.enqueue_cancel_request_email(v_request.order_id,'cancel_request_declined',_cancel_request_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'admin_decline_cancel_request', _actor_id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'admin_decline_cancel_request',
    pg_catalog.md5('admin_decline_cancel_request:' || _cancel_request_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_decline_cancel_request', 'cancel_request_id', _cancel_request_id, 'actor_id', _actor_id,
      'decline_reason', _decline_reason, 'decline_message', v_message)::text, 'UTF8')), 'hex'),
    'order_cancel_request',
    _cancel_request_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('cancel_request_id', _cancel_request_id, 'order_id', v_order_id,
      'status', 'declined', 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN QUERY SELECT _cancel_request_id,'declined'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_decline_cancel_request(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_decline_cancel_request(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_decline_cancel_request(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_decline_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_decline_cancel_request(_cancel_request_id, _actor_id, _decline_reason, _decline_message); $$;
ALTER FUNCTION public.admin_decline_cancel_request(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_decline_cancel_request(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decline_cancel_request(uuid,uuid,text,text) TO service_role;

-- Close (E-3 body): no order change and no mail. The units return to waiting exactly as on decline.
CREATE FUNCTION private.admin_close_cancel_request(_cancel_request_id uuid, _actor_id uuid)
RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_request public.order_cancel_requests;
  v_order_id uuid;
  v_orders uuid[];
  v_variants bigint[];
  v_before jsonb;
  v_middle jsonb;
  v_allocated integer := 0;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.order_cancel_request_lines AS l JOIN public.order_items AS oi ON oi.id = l.order_item_id
  WHERE l.cancel_request_id = _cancel_request_id AND oi.variant_id IS NOT NULL;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  UPDATE public.order_cancel_requests AS r SET status='closed',closed_at=pg_catalog.now(),closed_by=_actor_id
  WHERE r.id=_cancel_request_id;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'admin_close_cancel_request', _actor_id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'admin_close_cancel_request',
    pg_catalog.md5('admin_close_cancel_request:' || _cancel_request_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_close_cancel_request', 'cancel_request_id', _cancel_request_id,
      'actor_id', _actor_id)::text, 'UTF8')), 'hex'),
    'order_cancel_request',
    _cancel_request_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('cancel_request_id', _cancel_request_id, 'order_id', v_order_id,
      'status', 'closed', 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN QUERY SELECT _cancel_request_id,'closed'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_close_cancel_request(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_close_cancel_request(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_close_cancel_request(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_close_cancel_request(_cancel_request_id uuid, _actor_id uuid)
RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_close_cancel_request(_cancel_request_id, _actor_id); $$;
ALTER FUNCTION public.admin_close_cancel_request(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_close_cancel_request(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_close_cancel_request(uuid,uuid) TO service_role;

-- Resolve (E-3 body): exactly one ground (a later live refund of the same order, or the cancelled order). The
-- refund/cancel body already released the A once; resolve releases nothing. The refund rows were locked by the
-- closure before the request row, so the request -> refund reverse order of the old body is gone. Units the refund
-- did not cover leave cancel_requested and rejoin FIFO (sequence 2).
CREATE FUNCTION private.admin_resolve_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _refund_id uuid, _order_cancelled boolean
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_request public.order_cancel_requests;
  v_order_id uuid;
  v_orders uuid[];
  v_variants bigint[];
  v_before jsonb;
  v_middle jsonb;
  v_allocated integer := 0;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _order_cancelled IS NULL OR NOT ((_refund_id IS NOT NULL) <> _order_cancelled) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF _refund_id IS NOT NULL THEN
    -- Read only: a refund of this order is already held by the closure; any other refund cannot qualify.
    IF NOT EXISTS (
      SELECT 1 FROM public.order_refunds AS rf
      WHERE rf.id=_refund_id AND rf.order_id=v_request.order_id AND rf.created_at>=v_request.requested_at
        AND rf.status IN ('awaiting_response','pending','succeeded')
    ) THEN
      RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id=v_request.order_id AND o.status='cancelled') THEN
      RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.order_cancel_request_lines AS l JOIN public.order_items AS oi ON oi.id = l.order_item_id
  WHERE l.cancel_request_id = _cancel_request_id AND oi.variant_id IS NOT NULL;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  UPDATE public.order_cancel_requests AS r SET status='resolved',resolved_at=pg_catalog.now(),resolved_by=_actor_id,
    resolved_refund_id=_refund_id,resolved_by_cancel_at=CASE WHEN _order_cancelled THEN pg_catalog.now() ELSE NULL END
  WHERE r.id=_cancel_request_id;
  -- The refund/cancel mails were queued by the original operation; resolving queues none.
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'admin_resolve_cancel_request', _actor_id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'admin_resolve_cancel_request',
    pg_catalog.md5('admin_resolve_cancel_request:' || _cancel_request_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_resolve_cancel_request', 'cancel_request_id', _cancel_request_id, 'actor_id', _actor_id,
      'refund_id', _refund_id, 'order_cancelled', _order_cancelled)::text, 'UTF8')), 'hex'),
    'order_cancel_request',
    _cancel_request_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('cancel_request_id', _cancel_request_id, 'order_id', v_order_id,
      'status', 'resolved', 'refund_id', _refund_id, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN QUERY SELECT _cancel_request_id,'resolved'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_resolve_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _refund_id uuid, _order_cancelled boolean
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_resolve_cancel_request(_cancel_request_id, _actor_id, _refund_id, _order_cancelled); $$;
ALTER FUNCTION public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) TO service_role;

DO $g1_cancel_request_assert$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)'),
    pg_catalog.to_regprocedure('private.admin_decline_cancel_request(uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('private.admin_close_cancel_request(uuid,uuid)'),
    pg_catalog.to_regprocedure('private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)')
  ) AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 4
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('public.customer_request_cancel(uuid,uuid,uuid,jsonb,text)'),
    pg_catalog.to_regprocedure('public.admin_decline_cancel_request(uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('public.admin_close_cancel_request(uuid,uuid)'),
    pg_catalog.to_regprocedure('public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)')
  ) AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 4
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p WHERE p.oid IN (
    pg_catalog.to_regprocedure('private.customer_order_for_request(uuid,uuid,boolean)'),
    pg_catalog.to_regprocedure('private.lock_order_cancel_request(uuid)')
  ) AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 2 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'g1_cancel_request_functions';
  END IF;
END;
$g1_cancel_request_assert$;

-- Task 10: return request / create / approve / decline / cancel (six replaced functions).
-- Last definitions: actions 20261013000456:150/629/897, customer requests 20261020144842:578,
-- request reviews 20261020150415:18/137. Signatures, defaults, return shapes and refusal codes are retained.
-- Private bodies acquire one complete closure before business rows; public INVOKER entries only delegate.
-- These operations cover shipped units only: they neither release unshipped A/H nor restock/allocate exchange stock.
-- Capture / business change / state history / operation are atomic; replay and existing CAS keep their old answers.

CREATE OR REPLACE FUNCTION private.lock_order_return(_return_id uuid)
RETURNS public.order_returns
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_return public.order_returns;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  -- Returns follow allocations in the caller's pre-acquired closure. No row lock here.
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN v_return;
END;
$$;
ALTER FUNCTION private.lock_order_return(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_order_return(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.customer_request_return(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- 期限の比べは日本時間の日付（接続の時間帯に左右されない）。now() は取引の中で動かない
  v_today date := (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_returns;
  v_settings public.shop_return_settings;
  v_payer text;
  v_method text;
  v_shipping_fee integer;
  v_restocking_percent integer;
  v_exchange_fee integer;
  v_exchange_shipping_fee integer;
  v_number integer;
  v_return_id uuid;
  v_constraint text;
  v_line record;
  v_line_id uuid;
  v_photo record;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  -- 1. 引数
  IF _order_id IS NULL OR _customer_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. 二重防止の指紋: 注文と、行を発送・商品の順に並べた JSON の md5（画面の入力を決まった順に並べた物。写真は送り先の番号を昇順にし、
  --    種類と大きさは入れない。お客様の番号は入れない）。行の形が違えばここで RETURN_ARGUMENT_INVALID 等で止まる
  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'fulfillment_id', p.fulfillment_id,
                   'order_item_id', p.order_item_id,
                   'quantity', p.quantity,
                   'reason', p.reason,
                   'customer_note', p.customer_note,
                   'requested_resolution', p.requested_resolution,
                   'requested_exchange_variant_id', p.requested_exchange_variant_id,
                   'photo_upload_ids', COALESCE((
                     SELECT pg_catalog.jsonb_agg(x.upload_id ORDER BY x.upload_id)
                     FROM pg_catalog.jsonb_to_recordset(p.photos) AS x(upload_id uuid)
                   ), '[]'::jsonb)
                 )
                 ORDER BY p.fulfillment_id, p.order_item_id
               )
        FROM private.parse_customer_return_lines(_lines) AS p
      ), '[]'::jsonb)
    )::text
  );

  -- Discover exchange variants with reads, then acquire the complete ordered closure.
  PERFORM private.customer_order_for_request(_order_id, _customer_id, false);
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT p.requested_exchange_variant_id ORDER BY p.requested_exchange_variant_id),
    ARRAY[]::bigint[]) INTO v_variants
  FROM private.parse_customer_return_lines(_lines) AS p WHERE p.requested_exchange_variant_id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[_order_id], NULL);
  v_order := private.customer_order_for_request(_order_id, _customer_id, true);

  -- 4. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」。Review Focus 1）。持ち主を確かめた後に、
  --    同じ中身なら前の返品を返す: 写真の送り先が使い済みでも、設定や注文の状態が変わっていても確かめ直さず、
  --    返品・写真・メールの予定を増やさない。中身が違えば断る
  SELECT r.* INTO v_existing FROM public.order_returns AS r WHERE r.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.number, 'requested'::text, true;
    RETURN;
  END IF;

  -- 5. 設定の受付: 受け付けていて、種類に返品が入っている時だけ
  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;
  IF NOT v_settings.requests_enabled
     OR v_settings.request_types NOT IN ('returns_and_cancellations', 'returns_only') THEN
    RAISE EXCEPTION 'RETURN_REQUESTS_CLOSED' USING ERRCODE = '22023';
  END IF;

  -- 6. 申し込める注文は、支払い済みか発送済みだけ
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_RETURNABLE' USING ERRCODE = '22023';
  END IF;

  -- 7. 発送の行: この注文の、取り消していない発送の行でなければ引数の誤り（取り消した発送はお客様の画面に出ない）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_fulfillment_lines AS fl
      JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
      WHERE fl.fulfillment_id = p.fulfillment_id
        AND fl.order_item_id = p.order_item_id
        AND f.order_id = _order_id
        AND f.cancelled_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 8. 期限: 日本時間の今日が期限の日より後の品は申し込めない（期限の日の 23:59:59 までは申し込める）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = p.fulfillment_id AND fr.order_item_id = p.order_item_id
    WHERE fr.deadline_date IS NOT NULL
      AND fr.deadline_date < v_today
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 9. 返品できる数。画面の数を信じず、二つの段を数え直す。発送の行ごと（その行の数 − 返品が指す数 + 届かなかった数）と、
  --    注文の商品ごと（発送した数 − 返金した数 − 申し込み・受付中・返金待ち・交換・お返しの数）。別の発送の同じ商品は合計で確かめる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    LEFT JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = p.fulfillment_id AND fr.order_item_id = p.order_item_id
    WHERE p.quantity > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_customer_return_lines(_lines) AS p
      GROUP BY p.order_item_id
    ) AS g
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(c.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 10. 理由: 設定で「出す」にした理由だけ（unknown はいつも出さない）。返品不可の商品は破損・不良と注文と違う品だけ
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    LEFT JOIN public.items AS it ON it.id = oi.item_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE p.reason = 'unknown'
       OR rs.shown IS NOT TRUE
       OR (COALESCE(it.return_ineligible, false) AND p.reason NOT IN ('defective', 'wrong_item'))
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 11. 詳しい内容: 破損・不良とその他は必須（前後の空白を外して 1〜300 字。300 字の上限は行の形の確かめで済んでいる）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    WHERE p.reason IN ('defective', 'other')
      AND p.customer_note IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_CUSTOMER_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 12. ご希望: 理由の設定の「ご希望」に無い物は受けない（交換だけの理由に返金、返金だけの理由に交換）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE (rs.resolutions = 'exchange_only' AND p.requested_resolution <> 'exchange')
       OR (rs.resolutions = 'refund_only' AND p.requested_resolution <> 'refund')
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 13. 交換の色・サイズ: 同じ商品の使える（is_active）物だけ。在庫が申し込む数より少ない物は、
  --     理由の設定の在庫の無い交換が make（作って送る）の時だけ選べる（decline なら受けない）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    WHERE p.requested_resolution = 'exchange'
      AND NOT EXISTS (
        SELECT 1
        FROM public.item_variants AS v
        WHERE v.id = p.requested_exchange_variant_id
          AND v.item_id = oi.item_id
          AND v.is_active
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    JOIN public.item_variants AS v ON v.id = p.requested_exchange_variant_id
    WHERE p.requested_resolution = 'exchange'
      AND v.stock_quantity < p.quantity
      AND rs.out_of_stock_exchange = 'decline'
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 14. 写真: 理由の設定の「写真」に合う枚数（なしは 0 枚、必須は 1 枚以上、任意は 5 枚まで）で、
  --     全部の送り先がこの注文とこのお客様の、まだ使っていない・消していない物であること。
  --     作ってから 23 時間以内であること（消す処理の「1 日を過ぎた使っていない送り先」と重ならないよう 1 時間あける。P6）。
  --     写真の値（種類・大きさ・5 枚まで・同じ送り先の重複）は行の形の確かめで済んでいる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE (rs.photo = 'none' AND pg_catalog.jsonb_array_length(p.photos) > 0)
       OR (rs.photo = 'required' AND pg_catalog.jsonb_array_length(p.photos) = 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(p.photos) AS e(photo)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_return_photo_uploads AS u
      WHERE u.id = (e.photo ->> 'upload_id')::uuid
        AND u.order_id = _order_id
        AND u.customer_id = _customer_id
        AND u.attached_at IS NULL
        AND u.purged_at IS NULL
        AND u.created_at > pg_catalog.now() - interval '23 hours'
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 15. 返送の方法と負担、手数料の仮の値（P5）。負担は、申し込んだ行の理由のどれかがお店の負担ならお店、ほかはお客様。
  --     方法は、お店の負担なら customer_ships（着払い）、お客様の負担なら設定のお客様負担の時の送り方。
  --     返送料の定額は、お客様の負担でお店の送り状（shop_label）の時だけ付く。返品の手数料・交換の手数料と送料は、
  --     設定で使う時だけ設定の値を入れる（段 1 の作ると同じ）。お店は承認で全部直せる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE rs.shipping_payer = 'shop'
  ) THEN
    v_payer := 'shop';
  ELSE
    v_payer := 'customer';
  END IF;
  v_method := CASE WHEN v_payer = 'shop' THEN 'customer_ships' ELSE v_settings.customer_paid_method END;
  v_shipping_fee := CASE WHEN v_method = 'shop_label' AND v_payer = 'customer' THEN v_settings.shop_label_fee ELSE 0 END;
  v_restocking_percent := CASE WHEN v_settings.restocking_fee_enabled THEN v_settings.restocking_fee_percent ELSE 0 END;
  v_exchange_fee := CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_fee ELSE 0 END;
  v_exchange_shipping_fee := CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_shipping_fee ELSE 0 END;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  -- 16. 記録。番号は注文の鍵の中で「その注文の返品の数 + 1」（お断り・取消の返品も数える。番号が飛ばない）。
  --     お客様の申し込みは承認の前なので、approved_*・shop_note・created_by は空のまま。知らせる印は常に真
  SELECT pg_catalog.count(*)::integer + 1 INTO v_number FROM public.order_returns AS r WHERE r.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_returns AS r
      (order_id, number, source, status, request_key, request_fingerprint, requested_at, requested_by,
       return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent,
       exchange_fee, exchange_shipping_fee, notify_customer)
    VALUES
      (_order_id, v_number, 'customer_request', 'requested', _request_key, v_fingerprint, pg_catalog.now(), _customer_id,
       v_method, v_payer, v_shipping_fee, v_restocking_percent,
       v_exchange_fee, v_exchange_shipping_fee, true)
    RETURNING r.id INTO v_return_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の申し込みが同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_returns_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  -- 17. 返品の行。解決の仮の値はご希望と同じ。交換は、その色・サイズの在庫が申し込む数以上なら stock、足りなければ make
  --     （足りない時に選べるのは、理由の設定が make の時だけ。上の 13 で確かめ済み）。
  --     写真は返品の行ごとに写真の行を書き、送り先に使った時刻（attached_at）を書く
  FOR v_line IN
    SELECT p.fulfillment_id,
           p.order_item_id,
           p.quantity,
           p.reason,
           p.customer_note,
           p.requested_resolution,
           p.requested_exchange_variant_id,
           p.photos,
           (SELECT v.stock_quantity FROM public.item_variants AS v WHERE v.id = p.requested_exchange_variant_id) AS exchange_stock
    FROM private.parse_customer_return_lines(_lines) AS p
    ORDER BY p.fulfillment_id, p.order_item_id
  LOOP
    INSERT INTO public.order_return_lines AS l
      (return_id, fulfillment_id, order_item_id, quantity, reason, customer_note,
       requested_resolution, requested_exchange_variant_id, resolution, exchange_variant_id, exchange_method)
    VALUES
      (v_return_id, v_line.fulfillment_id, v_line.order_item_id, v_line.quantity, v_line.reason, v_line.customer_note,
       v_line.requested_resolution, v_line.requested_exchange_variant_id, v_line.requested_resolution,
       v_line.requested_exchange_variant_id,
       CASE
         WHEN v_line.requested_resolution = 'exchange' THEN
           CASE WHEN v_line.exchange_stock >= v_line.quantity THEN 'stock' ELSE 'make' END
       END)
    RETURNING l.id INTO v_line_id;

    FOR v_photo IN
      SELECT x.upload_id, x.content_type, x.size_bytes
      FROM pg_catalog.jsonb_to_recordset(v_line.photos) AS x(upload_id uuid, content_type text, size_bytes integer)
    LOOP
      INSERT INTO public.order_return_photos (return_line_id, upload_id, storage_path, content_type, size_bytes)
      SELECT v_line_id, u.id, u.storage_path, v_photo.content_type, v_photo.size_bytes
      FROM public.order_return_photo_uploads AS u
      WHERE u.id = v_photo.upload_id;

      UPDATE public.order_return_photo_uploads AS u
      SET attached_at = pg_catalog.now()
      WHERE u.id = v_photo.upload_id;
    END LOOP;
  END LOOP;

  -- 18. 申し込みのメールの予定: お客様への受付と、店への知らせ（それぞれ返品ごとに 1 行）
  PERFORM private.enqueue_return_email(_order_id, 'return_requested', v_return_id, NULL::uuid);
  PERFORM private.enqueue_return_email(_order_id, 'return_request_shop', v_return_id, NULL::uuid);

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'customer_request_return', _customer_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'customer_request_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'customer_request_return', 'order_id', _order_id, 'actor_id', _customer_id,
      'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', v_return_id::text, _customer_id,
    pg_catalog.jsonb_build_object('return_id', v_return_id, 'order_id', _order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_return_id, v_number, 'requested'::text, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.customer_request_return(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.customer_request_return(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.customer_request_return(uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.customer_request_return(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.customer_request_return(_order_id, _customer_id, _request_key, _lines); $$;
ALTER FUNCTION public.customer_request_return(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.customer_request_return(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_request_return(uuid,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION private.admin_create_return(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb,
  _return_method text,
  _return_shipping_payer text,
  _return_carrier text,
  _return_tracking_number text,
  _return_shipping_fee integer,
  _restocking_fee_percent integer,
  _exchange_fee integer,
  _exchange_shipping_fee integer,
  _shop_note text,
  _notify_customer boolean
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_fingerprint text;
  v_note text;
  v_order public.orders;
  v_existing public.order_returns;
  v_settings public.shop_return_settings;
  v_shipping_fee integer;
  v_restocking_percent integer;
  v_exchange_fee integer;
  v_exchange_shipping_fee integer;
  v_number integer;
  v_return_id uuid;
  v_constraint text;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  -- 1. 引数
  IF _order_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _return_method IS NULL
     OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
     OR _return_shipping_payer IS NULL
     OR _return_shipping_payer NOT IN ('shop', 'customer')
     OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
     OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
     OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
     OR (_shop_note IS NOT NULL AND pg_catalog.char_length(_shop_note) > 500) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. 手数料。引数が空なら設定の値を使うので、ここでは渡された値だけを確かめる（円は0〜1,000,000＝計画の冒頭の Global Constraints の金額の入力の上限、返品の手数料は0〜100%）
  IF (_return_shipping_fee IS NOT NULL AND (_return_shipping_fee < 0 OR _return_shipping_fee > 1000000))
     OR (_exchange_fee IS NOT NULL AND (_exchange_fee < 0 OR _exchange_fee > 1000000))
     OR (_exchange_shipping_fee IS NOT NULL AND (_exchange_shipping_fee < 0 OR _exchange_shipping_fee > 1000000))
     OR (_restocking_fee_percent IS NOT NULL AND (_restocking_fee_percent < 0 OR _restocking_fee_percent > 100)) THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(pg_catalog.btrim(_shop_note), '');

  -- 3. 二重防止の指紋: 呼ぶ側が渡した入力を、渡されたままの値で決まった順に並べた JSON の md5。
  --    行は発送・商品・解決・理由…の順に並べ替えるので、並びだけが違う送り直しは同じ中身。
  --    設定から入る手数料は、渡された空のまま入れる（設定が後で変わっても、同じ送り直しとして見分ける）。実行した人は入れない
  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'fulfillment_id', p.fulfillment_id,
                   'order_item_id', p.order_item_id,
                   'quantity', p.quantity,
                   'reason', p.reason,
                   'reason_note', p.reason_note,
                   'resolution', p.resolution,
                   'exchange_variant_id', p.exchange_variant_id,
                   'exchange_method', p.exchange_method
                 )
                 ORDER BY p.fulfillment_id, p.order_item_id, p.resolution, p.reason,
                          p.exchange_variant_id NULLS FIRST, p.exchange_method NULLS FIRST, p.quantity,
                          p.reason_note NULLS FIRST
               )
        FROM private.parse_return_lines(_lines) AS p
      ), '[]'::jsonb),
      'return_method', _return_method,
      'return_shipping_payer', _return_shipping_payer,
      'return_carrier', _return_carrier,
      'return_tracking_number', _return_tracking_number,
      'return_shipping_fee', _return_shipping_fee,
      'restocking_fee_percent', _restocking_fee_percent,
      'exchange_fee', _exchange_fee,
      'exchange_shipping_fee', _exchange_shipping_fee,
      'shop_note', _shop_note,
      'notify_customer', _notify_customer
    )::text
  );

  -- Discover exchange variants with reads, then acquire the complete ordered closure.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT p.exchange_variant_id ORDER BY p.exchange_variant_id), ARRAY[]::bigint[])
    INTO v_variants FROM private.parse_return_lines(_lines) AS p WHERE p.exchange_variant_id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 5. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」）。同じ中身なら前の記録を返し、
  --    注文の状態や数が変わっていても確かめ直さない。受付のお知らせも二度は書かない。中身が違えば断る
  SELECT r.* INTO v_existing FROM public.order_returns AS r WHERE r.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.number, v_existing.status, true;
    RETURN;
  END IF;

  -- 6. 返品を作れる注文は、支払い済みか発送済みだけ
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_RETURNABLE' USING ERRCODE = '22023';
  END IF;

  -- 7. 返送先が空の間は、返送不要の返品も含めて作れない（設計書 8-3）
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;

  -- 8. 返送不要は、設定で出している時だけ選べる
  IF _return_method = 'not_required' AND NOT v_settings.no_return_needed_enabled THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 9. 行の発送。この注文の発送の行でなければ引数の誤り。取り消した発送の品は、返品できる数が無い物として扱う
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_fulfillment_lines AS fl
      JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
      WHERE fl.fulfillment_id = p.fulfillment_id
        AND fl.order_item_id = p.order_item_id
        AND f.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_fulfillments AS f ON f.id = p.fulfillment_id
    WHERE f.cancelled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 10. 返品できる数。画面の数を信じず、二つの段を数え直す。発送の行ごと（その行の数 − 返品が指す数 + 届かなかった数）と、
  --     注文の商品ごと（発送した数 − 返金した数 − 申し込み・受付中・返金待ち・交換・お返しの数）。同じ商品を返金と交換の2行に分けた時は合計で確かめる
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.fulfillment_id, p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.fulfillment_id, p.order_item_id
    ) AS g
    LEFT JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = g.fulfillment_id AND fr.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.order_item_id
    ) AS g
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(c.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 11. 交換の色・サイズは、同じ商品の使える（有効な）物だけ
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    WHERE p.resolution = 'exchange'
      AND NOT EXISTS (
        SELECT 1
        FROM public.item_variants AS v
        WHERE v.id = p.exchange_variant_id
          AND v.item_id = oi.item_id
          AND v.is_active
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 12. 手数料。引数が空なら設定の値、設定で使わない手数料は0。
  --     返送料の定額は、お客様の負担でお店の送り状（shop_label）の時だけ付く。shop_label でない返品と、返送料の負担がお店の返品は、
  --     渡された値があっても0にする（受付のお知らせは、負担がお店なら送り方にかかわらず「当店が負担」と書く。共通の約束 C-6）
  v_shipping_fee := CASE
    WHEN _return_method <> 'shop_label' OR _return_shipping_payer = 'shop' THEN 0
    WHEN _return_shipping_fee IS NOT NULL THEN _return_shipping_fee
    ELSE v_settings.shop_label_fee
  END;
  v_restocking_percent := COALESCE(
    _restocking_fee_percent,
    CASE WHEN v_settings.restocking_fee_enabled THEN v_settings.restocking_fee_percent ELSE 0 END
  );
  v_exchange_fee := COALESCE(
    _exchange_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_fee ELSE 0 END
  );
  v_exchange_shipping_fee := COALESCE(
    _exchange_shipping_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_shipping_fee ELSE 0 END
  );

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  -- 13. 記録。番号は注文の鍵の中で「その注文の返品の数 + 1」（お断り・取消の返品も数える。番号が飛ばない）
  SELECT pg_catalog.count(*)::integer + 1 INTO v_number FROM public.order_returns AS r WHERE r.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_returns AS r
      (order_id, number, source, status, request_key, request_fingerprint, approved_at, approved_by,
       return_method, return_shipping_payer, return_carrier, return_tracking_number,
       return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee,
       notify_customer, shop_note, created_by)
    VALUES
      (_order_id, v_number, 'shop', 'open', _request_key, v_fingerprint, pg_catalog.now(), _actor_id,
       _return_method, _return_shipping_payer, _return_carrier, _return_tracking_number,
       v_shipping_fee, v_restocking_percent, v_exchange_fee, v_exchange_shipping_fee,
       _notify_customer, v_note, _actor_id)
    RETURNING r.id INTO v_return_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の返品が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_returns_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_return_lines
    (return_id, fulfillment_id, order_item_id, quantity, reason, reason_note, resolution, exchange_variant_id, exchange_method)
  SELECT v_return_id, p.fulfillment_id, p.order_item_id, p.quantity, p.reason, p.reason_note, p.resolution,
         p.exchange_variant_id, p.exchange_method
  FROM private.parse_return_lines(_lines) AS p;

  -- 14. 受付のお知らせの予定（「お客様に知らせる」の時だけ）
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(_order_id, 'return_accepted', v_return_id, NULL::uuid);
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_create_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_create_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_create_return', 'order_id', _order_id, 'actor_id', _actor_id,
      'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', v_return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', v_return_id, 'order_id', _order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_return_id, v_number, 'open'::text, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_create_return(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb,
  _return_method text,
  _return_shipping_payer text,
  _return_carrier text,
  _return_tracking_number text,
  _return_shipping_fee integer,
  _restocking_fee_percent integer,
  _exchange_fee integer,
  _exchange_shipping_fee integer,
  _shop_note text,
  _notify_customer boolean
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_create_return(_order_id, _actor_id, _request_key, _lines, _return_method, _return_shipping_payer, _return_carrier, _return_tracking_number, _return_shipping_fee, _restocking_fee_percent, _exchange_fee, _exchange_shipping_fee, _shop_note, _notify_customer); $$;
ALTER FUNCTION public.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE FUNCTION private.admin_approve_return(
  _return_id uuid, _actor_id uuid, _lines jsonb, _return_method text,
  _return_shipping_payer text, _return_carrier text, _return_tracking_number text,
  _return_shipping_fee integer, _restocking_fee_percent integer, _exchange_fee integer,
  _exchange_shipping_fee integer, _shop_note text, _notify_customer boolean
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_j jsonb; v_id uuid; v_variant bigint; v_seen uuid[] := ARRAY[]::uuid[];
  v_lines jsonb := '[]'::jsonb;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _notify_customer IS NULL
    OR _return_method IS NULL OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
    OR _return_shipping_payer IS NULL OR _return_shipping_payer NOT IN ('shop', 'customer')
    OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
    OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
    OR pg_catalog.char_length(_shop_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- 設定からの補完はしない。承認で決めた額が必ず送られていることを DB でも守る。
  IF _return_shipping_fee IS NULL OR _return_shipping_fee NOT BETWEEN 0 AND 1000000
    OR _restocking_fee_percent IS NULL OR _restocking_fee_percent NOT BETWEEN 0 AND 100
    OR _exchange_fee IS NULL OR _exchange_fee NOT BETWEEN 0 AND 1000000
    OR _exchange_shipping_fee IS NULL OR _exchange_shipping_fee NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_lines) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'resolution', '') NOT IN ('refund', 'exchange')
      OR NOT (v_j ?& ARRAY['return_line_id','resolution','exchange_variant_id','exchange_method']) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_id := (v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF v_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_id;
    v_variant := NULL;
    IF v_j->>'resolution' = 'refund' THEN
      IF v_j->>'exchange_variant_id' IS NOT NULL OR v_j->>'exchange_method' IS NOT NULL THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF pg_catalog.jsonb_typeof(v_j->'exchange_variant_id') IS DISTINCT FROM 'number'
        OR (v_j->>'exchange_variant_id') !~ '^-?[0-9]{1,18}$'
        OR COALESCE(v_j->>'exchange_method','') NOT IN ('stock','make') THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_variant := (v_j->>'exchange_variant_id')::bigint;
    END IF;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'return_line_id',v_id,'resolution',v_j->>'resolution',
      'exchange_variant_id',v_variant,'exchange_method',v_j->>'exchange_method'));
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id) AND (
    pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id))
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.exchange_variant_id ORDER BY x.exchange_variant_id), ARRAY[]::bigint[])
    INTO v_variants FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(exchange_variant_id bigint)
    WHERE x.exchange_variant_id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _return_method = 'not_required' AND NOT (
    SELECT s.no_return_needed_enabled FROM public.shop_return_settings AS s WHERE s.id = 1
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  -- 注文の鍵を取った後にも全行を確かめ、並行した追記を一部承認にしない。
  IF pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint)
    JOIN public.order_return_lines AS l ON l.id = x.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE x.resolution = 'exchange' AND NOT EXISTS (
      SELECT 1 FROM public.item_variants AS v WHERE v.id = x.exchange_variant_id AND v.item_id = oi.item_id AND v.is_active
    )
  ) THEN RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_return_lines AS l
  SET resolution = x.resolution, exchange_variant_id = x.exchange_variant_id, exchange_method = x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint,exchange_method text)
  WHERE l.id = x.return_line_id AND l.return_id = _return_id;
  UPDATE public.order_returns AS r
  SET status = 'open', approved_at = pg_catalog.now(), approved_by = _actor_id,
      return_method = _return_method, return_shipping_payer = _return_shipping_payer,
      return_carrier = _return_carrier, return_tracking_number = _return_tracking_number,
      return_shipping_fee = CASE WHEN _return_method = 'shop_label' AND _return_shipping_payer = 'customer'
        THEN _return_shipping_fee ELSE 0 END,
      restocking_fee_percent = _restocking_fee_percent, exchange_fee = _exchange_fee,
      exchange_shipping_fee = _exchange_shipping_fee, shop_note = NULLIF(pg_catalog.btrim(_shop_note), ''),
      notify_customer = _notify_customer
  WHERE r.id = _return_id;
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(v_return.order_id, 'return_accepted', _return_id, NULL);
  END IF;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_approve_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_approve_return', pg_catalog.md5('admin_approve_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_approve_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id, 'lines', _lines, 'return_method', _return_method, 'return_shipping_payer', _return_shipping_payer, 'return_carrier', _return_carrier, 'return_tracking_number', _return_tracking_number, 'return_shipping_fee', _return_shipping_fee, 'restocking_fee_percent', _restocking_fee_percent, 'exchange_fee', _exchange_fee, 'exchange_shipping_fee', _exchange_shipping_fee, 'shop_note', _shop_note, 'notify_customer', _notify_customer)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id, 'open'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_approve_return(
  _return_id uuid, _actor_id uuid, _lines jsonb, _return_method text,
  _return_shipping_payer text, _return_carrier text, _return_tracking_number text,
  _return_shipping_fee integer, _restocking_fee_percent integer, _exchange_fee integer,
  _exchange_shipping_fee integer, _shop_note text, _notify_customer boolean
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_approve_return(_return_id, _actor_id, _lines, _return_method, _return_shipping_payer, _return_carrier, _return_tracking_number, _return_shipping_fee, _restocking_fee_percent, _exchange_fee, _exchange_shipping_fee, _shop_note, _notify_customer); $$;
ALTER FUNCTION public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE FUNCTION private.admin_decline_return(
  _return_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_return public.order_returns; v_message text := NULLIF(pg_catalog.btrim(_decline_message), '');
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _decline_reason IS NULL
    OR _decline_reason NOT IN ('window_passed','final_sale','other') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_message IS NULL OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RETURN_DECLINE_MESSAGE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_returns AS r SET status='declined',declined_at=pg_catalog.now(),declined_by=_actor_id,
    decline_reason=_decline_reason,decline_message=v_message WHERE r.id=_return_id;
  PERFORM private.enqueue_return_email(v_return.order_id,'return_declined',_return_id,NULL);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'return_declined_restore', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_decline_return', pg_catalog.md5('admin_decline_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_decline_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id, 'decline_reason', _decline_reason, 'decline_message', _decline_message)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id,'declined'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_decline_return(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_decline_return(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_decline_return(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_decline_return(
  _return_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_decline_return(_return_id, _actor_id, _decline_reason, _decline_message); $$;
ALTER FUNCTION public.admin_decline_return(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_decline_return(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decline_return(uuid,uuid,text,text) TO service_role;

CREATE FUNCTION private.admin_cancel_return(_return_id uuid, _actor_id uuid)
RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);

  IF v_return.status <> 'open'
     OR EXISTS (
       SELECT 1
       FROM private.order_return_line_progress(_return_id) AS p
       WHERE p.processed > 0
     ) THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_returns AS r
  SET status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE r.id = _return_id;

  -- まだ送っていない受付のお知らせ（送る前・やり直し待ち）は取りやめる（取り消した返品の受付を知らせない。設計書 7-3）。
  -- 送っている途中の行と送り済みの行は触らない（途中の行を止めるかは、メールの worker 側の仕事）
  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      last_error_code = 'return_cancelled'
  WHERE e.return_id = _return_id
    AND e.kind = 'return_accepted'
    AND e.status IN ('pending', 'retry_wait');

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_cancel_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_cancel_return', pg_catalog.md5('admin_cancel_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_cancel_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id, 'cancelled'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_cancel_return(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_cancel_return(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_cancel_return(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_cancel_return(_return_id uuid, _actor_id uuid)
RETURNS TABLE (return_id uuid, status text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.admin_cancel_return(_return_id, _actor_id); $$;
ALTER FUNCTION public.admin_cancel_return(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_cancel_return(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_return(uuid,uuid) TO service_role;

DO $g1_return_request_assert$
DECLARE v_name text; v_schema text; v_oid oid;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'customer_request_return(uuid,uuid,uuid,jsonb)',
    'admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'admin_decline_return(uuid,uuid,text,text)',
    'admin_cancel_return(uuid,uuid)'
  ] LOOP
    FOREACH v_schema IN ARRAY ARRAY['public','private'] LOOP
      v_oid := pg_catalog.to_regprocedure(v_schema || '.' || v_name);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=v_oid AND p.prosecdef=(v_schema='private') AND p.proowner='postgres'::regrole
          AND p.proconfig=ARRAY['search_path=""']::text[])
        OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') THEN
        RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE='55000', DETAIL='g1_return_request_functions';
      END IF;
    END LOOP;
  END LOOP;
  v_oid := pg_catalog.to_regprocedure('private.lock_order_return(uuid)');
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_oid AND NOT p.prosecdef
    AND p.proowner='postgres'::regrole AND p.proconfig=ARRAY['search_path=""']::text[])
    OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE='55000', DETAIL='g1_return_lock';
  END IF;
END;
$g1_return_request_assert$;

-- Task 11: receipt / inspection / amount decision / missing / reopen and ordinary exchange FIFO.
-- Last bodies: receive=20261020150415, refund=20261013001143, actions=20261013000456.

CREATE OR REPLACE FUNCTION private.refresh_order_return_status(_return_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_return public.order_returns;
  v_blocked boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_return.status <> 'open' THEN
    RETURN v_return.status;
  END IF;

  SELECT EXISTS (
           SELECT 1
           FROM private.order_return_line_states(v_return.order_id) AS s
           WHERE s.return_id = v_return.id
             AND (s.unprocessed > 0 OR s.pending_inspection > 0 OR s.refund_waiting > 0)
         )
         OR (v_return.fee_due_amount > 0 AND v_return.fee_received_at IS NULL)
  INTO v_blocked;

  IF v_blocked THEN
    RETURN v_return.status;
  END IF;

  UPDATE public.order_returns AS r
  SET status = 'closed',
      closed_at = pg_catalog.now()
  WHERE r.id = v_return.id;
  RETURN 'closed';
END;
$$;
ALTER FUNCTION private.refresh_order_return_status(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.refresh_order_return_status(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_order uuid; v_return public.order_returns%ROWTYPE; v_old public.order_return_receipts%ROWTYPE;
  v_units jsonb; v_effective jsonb; v_overrides jsonb; v_fp text; v_j jsonb; v_id uuid; v_n integer; v_seen text[]:=ARRAY[]::text[];
  v_receipt uuid:=pg_catalog.gen_random_uuid(); v_refund uuid; v_amount integer; v_status text; v_choice text;
  v_lines jsonb:='[]'::jsonb; v_goods integer:=0; v_exchange integer:=0; v_sent integer:=0;
  v_fees integer:=0; v_due integer:=0; v_pending integer:=0; v_shop boolean:=false;
  v_first_goods boolean; v_first_exchange boolean; v_line record; v_action text; v_available integer;
  v_exchange_ids uuid[]:=ARRAY[]::uuid[]; v_item uuid; v_offset integer; v_paid integer; v_waived boolean:=false;
  v_free_by_variant jsonb;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','none')
    OR _refund_shipping_amount IS NULL OR _refund_shipping_amount<0
    OR (_refund_amount IS NOT NULL AND _refund_amount<0) OR pg_catalog.char_length(_note)>500
    OR pg_catalog.char_length(_sent_back_message)>1000
    OR (_sent_back_carrier IS NOT NULL AND _sent_back_carrier NOT IN ('yamato','sagawa','japanpost','other'))
    OR (_sent_back_tracking_number IS NOT NULL AND _sent_back_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR pg_catalog.jsonb_typeof(_units) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_units) NOT BETWEEN 1 AND 100
    OR pg_catalog.jsonb_array_length(_exchange_overrides)>100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF NOT _actor_can_refund AND (_refund_amount IS NOT NULL
      OR _refund_shipping_amount<>0 OR pg_catalog.jsonb_array_length(_exchange_overrides)>0) THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  IF _refund_choice<>'now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition'))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition'));
  END LOOP;
  v_seen:=ARRAY[]::text[];
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_exchange_overrides) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'action','') NOT IN ('make','refund') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF v_id::text=ANY(v_seen) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||v_id::text;
  END LOOP;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
    ORDER BY x.return_line_id,x.disposition) INTO v_units
  FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'action',x.action)
    ORDER BY x.return_line_id),'[]'::jsonb) INTO v_overrides
  FROM pg_catalog.jsonb_to_recordset(_exchange_overrides) AS x(return_line_id uuid,action text);
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'units',v_units,'exchange_overrides',v_overrides,
    'refund_choice',_refund_choice,'refund_amount',_refund_amount,'refund_shipping_amount',_refund_shipping_amount,
    'note',_note,'notify_customer',_notify_customer,'sent_back_message',_sent_back_message,
    'sent_back_carrier',_sent_back_carrier,'sent_back_tracking_number',_sent_back_tracking_number,
    'actor_can_refund',_actor_can_refund)::text);
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT rr.* INTO v_old FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id<>_return_id OR v_old.kind<>'receive' OR v_old.request_fingerprint<>v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    -- 交換の行の番号は受け取りと返品の行から決まるので、再送で新しい行を作る必要がない。
    RETURN QUERY SELECT v_old.id,v_return.status,r.id,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 0 ELSE r.amount END,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 'waived' ELSE r.status END,
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT oi.id ORDER BY oi.id) FROM public.order_return_receipt_lines AS u
        JOIN public.order_items AS oi ON oi.id=private.return_exchange_item_id(v_old.id,u.return_line_id,u.exchange_method)
        WHERE u.receipt_id=v_old.id),ARRAY[]::uuid[]),v_return.fee_due_amount,
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF NOT _actor_can_refund AND _refund_choice='now' AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    WHERE NOT EXISTS(SELECT 1 FROM public.order_return_lines AS l WHERE l.id=x.return_line_id AND l.return_id=_return_id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id=x.return_line_id
    GROUP BY x.return_line_id,g.unprocessed HAVING pg_catalog.sum(x.quantity)>g.unprocessed) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_sent
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text,quantity integer) WHERE x.disposition='sent_back';
  IF v_sent>0 AND NULLIF(pg_catalog.btrim(_sent_back_message),'') IS NULL THEN
    RAISE EXCEPTION 'RETURN_SENT_BACK_MESSAGE_REQUIRED' USING ERRCODE='22023'; END IF;
  -- お返しのメッセージは必ず届ける（仕様書 6-1・9-1）
  IF v_sent>0 AND NOT _notify_customer THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text) WHERE x.disposition='pending_inspection')
    AND NOT (SELECT s.inspection_enabled FROM public.shop_return_settings AS s WHERE s.id=1) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 上書きの形（C-1）: この返品の、交換（在庫から）の予定の行で、今回受け取る点（お返しでない）がある行だけ。
  -- 理由の設定が decline の行は make・refund、make の行は refund だけ（何も送らなければ自動で作って送る。仕様書 6-5）。
  -- 在庫不足の行かどうかは、下の割り当ての中で確かめる（在庫が足りる行への上書きは RETURN_ARGUMENT_INVALID）
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text)
    LEFT JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason=l.reason
    WHERE l.return_id IS DISTINCT FROM _return_id OR l.resolution IS DISTINCT FROM 'exchange'
      OR l.exchange_method IS DISTINCT FROM 'stock' OR rs.out_of_stock_exchange IS NULL
      OR (rs.out_of_stock_exchange='make' AND x.action<>'refund')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
        WHERE u.return_line_id=l.id AND u.disposition<>'sent_back')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 返品行の予定は不変。上書きは今回受け取る数だけの実際の解決方法として保持する。
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,
      'disposition',u.disposition,'quantity',u.quantity,
      'resolution',CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END,
      'exchange_method',CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
        WHEN x.action='make' THEN 'make' ELSE l.exchange_method END) ORDER BY u.return_line_id,u.disposition)
    INTO v_effective
  FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
  JOIN public.order_return_lines AS l ON l.id=u.return_line_id
  LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id;
  -- Select methods from pre-receipt F in the existing line order, without reserving stock.
  -- Fees and receipt rows are final before ordinary FIFO can allocate any exchange line.
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  SELECT COALESCE(pg_catalog.jsonb_object_agg(v.id::text, v.stock_quantity), '{}'::jsonb)
    INTO v_free_by_variant FROM public.item_variants AS v WHERE v.id = ANY(v_variants);
  FOR v_line IN SELECT l.*,pg_catalog.sum(x.quantity)::integer AS picked,ov.action AS override_action
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_fulfillments AS f ON f.id=l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS ov(return_line_id uuid,action text) ON ov.return_line_id=l.id
    WHERE l.resolution='exchange' AND x.disposition<>'sent_back'
    GROUP BY l.id,f.number,oi.created_at,ov.action
    ORDER BY f.number,oi.created_at,l.order_item_id,l.id
  LOOP
    IF v_line.exchange_method='make' THEN
      v_action:='make';
    ELSE
      v_available := COALESCE((v_free_by_variant->>v_line.exchange_variant_id::text)::integer, 0);
      IF v_available>=v_line.picked THEN
        -- 在庫が足りる行は在庫から。上書きは在庫不足の行だけ（C-1）
        IF v_line.override_action IS NOT NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
        v_action:='stock';
        v_free_by_variant := pg_catalog.jsonb_set(v_free_by_variant, ARRAY[v_line.exchange_variant_id::text],
          pg_catalog.to_jsonb(v_available-v_line.picked));
      ELSIF v_line.override_action IS NOT NULL THEN
        v_action:=v_line.override_action;
      ELSIF (SELECT rs.out_of_stock_exchange FROM public.shop_return_reason_settings AS rs WHERE rs.reason=v_line.reason)='make' THEN
        v_action:='make';
      ELSE
        RAISE EXCEPTION 'RETURN_EXCHANGE_OUT_OF_STOCK' USING ERRCODE='22023';
      END IF;
    END IF;
    -- 返金に変えた行は交換の品を作らない（上の v_effective で返金の品になっていて、下の返金の数に入る）
    CONTINUE WHEN v_action='refund';
    SELECT COALESCE(pg_catalog.sum(e.quantity),0)::integer INTO v_offset FROM public.order_items AS e
    JOIN public.order_return_lines AS old ON old.id=e.exchange_return_line_id WHERE old.order_item_id=v_line.order_item_id;
    v_paid:=private.return_units_amount(v_line.order_item_id,v_line.picked,v_offset);
    -- 自動の make と店長の選択を含む実際の送り方だけを、受け取り明細へ保存する。
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,'disposition',u.disposition,
        'quantity',u.quantity,'resolution',u.resolution,'exchange_method',CASE WHEN u.return_line_id=v_line.id
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END) ORDER BY u.return_line_id,u.disposition)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
    v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
    INSERT INTO public.order_items(id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,
      fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
    SELECT v_item,v_order,v.item_id,v.id,i.name,0,c.name,z.label,v_line.picked,0,
      CASE WHEN v_action='stock' THEN 'stock' ELSE 'backorder' END,'exchange',v_line.id,v_paid
    FROM public.item_variants AS v JOIN public.items AS i ON i.id=v.item_id
    LEFT JOIN public.item_colors AS c ON c.id=v.color_id LEFT JOIN public.item_sizes AS z ON z.id=v.size_id
    WHERE v.id=v_line.exchange_variant_id;
    v_exchange_ids:=v_exchange_ids||v_item;v_exchange:=v_exchange+v_line.picked;
  END LOOP;
  -- Preserve the original restock rejection before any refund validation or fee decision.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' AND oi.variant_id IS NULL
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 受け取り後にこの返品のrwが増える数だけを返金する。rfと開き直した品への優先の覆いも、移行Aの本体で数える。
  -- 未保存の明細を本体に渡すため、追記専用の受け取りは返金IDをINSERT時に確定したまま書ける。
  WITH before_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states(v_order) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,'before_shipment',false,'quantity',t.quantity)
      ORDER BY t.order_item_id) FILTER(WHERE t.quantity>0),'[]'::jsonb),
    COALESCE(pg_catalog.sum(private.return_units_amount(t.order_item_id,t.quantity)) FILTER(WHERE t.quantity>0),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,LEAST(pg_catalog.sum(x.quantity)::integer,
        GREATEST(a.waiting-b.waiting,0)) AS quantity
      FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text)
      JOIN public.order_return_lines AS l ON l.id=x.return_line_id
      JOIN before_receive AS b ON b.order_item_id=l.order_item_id
      JOIN after_receive AS a ON a.order_item_id=l.order_item_id
      WHERE x.resolution='refund'
      GROUP BY l.order_item_id,a.waiting,b.waiting
    ) AS t;
  -- 先にふつうの返金で返した品（覆い）があると、画面の見込みより返金する品が少なくなる。
  -- 店長が見込みから直した額や送料をそのまま付けると多く返りうるため、計算どおりか相談で受け取り直してもらう。
  -- 全部が覆われて返金する品が0点の時も、入れた額や送料を黙って捨てずに同じ断りにする。
  IF _refund_choice='now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0)
    AND (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
      FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(quantity integer))
      < (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(resolution text,quantity integer)
        WHERE x.resolution='refund') THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF _refund_choice='none' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- この受け取りで返金する品が無い時（覆われた品だけ・交換だけ・お返しだけ）は、相談・今返金を選んでも返金は起きない。
  -- 記録・履歴・メールを実際と合わせるため none で残す。指紋は入力から作るので、同じ入力の送り直しは前の結果を返す。
  v_choice:=CASE WHEN pg_catalog.jsonb_array_length(v_lines)=0 THEN 'none' ELSE _refund_choice END;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer
    +CASE WHEN v_first_goods AND (pg_catalog.jsonb_array_length(v_lines)>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF _refund_choice='consult' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN v_pending:=v_fees;
  ELSIF _refund_choice='now' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    -- 店長が直した額の上限は返せる額（E-2 の値。仕様書 6-3・P8）。計算との差は core が adjustment_amount に残す
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount<_refund_shipping_amount
        OR _refund_amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a) THEN
        RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    v_due:=GREATEST(v_fees-v_goods,0);
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
  ELSE v_due:=v_fees;
  END IF;
  -- 非0円の返金を頼めない注文には受け取りを残さない。0円と受け取りだけの道は Stripe を必要としない。
  IF v_refund IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0
      AND pg_catalog.left(o.payment_intent_id,3)='pi_' AND pg_catalog.char_length(o.payment_intent_id)>3
  ) THEN RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  BEGIN
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund)
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',v_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
  IF v_waived THEN
    -- 0円で終える数は、今回の実際の返金の数だけ。普通の返金で既に覆われた数は再び覆わない。
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_refund IS NOT NULL THEN
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods)) AS r;
  END IF;
  -- 新たに付く未収手数料は前の免除に含まれないため、受領を戻す時は免除の印も外す。
  UPDATE public.order_returns AS rt SET fee_due_amount=rt.fee_due_amount+v_due,
    fee_pending_deduction=rt.fee_pending_deduction+v_pending,
    fee_waived=CASE WHEN v_due>0 THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_note END WHERE rt.id=_return_id;
  -- Restock after method selection; receipt rows and fees precede ordinary FIFO.
  FOR v_line IN SELECT l.order_item_id,oi.variant_id,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' GROUP BY l.order_item_id,oi.variant_id ORDER BY oi.variant_id,l.order_item_id
  LOOP
    IF v_line.variant_id IS NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
    VALUES(v_line.variant_id,v_line.quantity,'return',v_order,v_line.order_item_id,_actor_id,_return_id);
  END LOOP;
  IF v_exchange>0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id',_actor_id::text,true);
    PERFORM pg_catalog.set_config('app.order_change_reason','return_exchange_added',true);
    PERFORM pg_catalog.set_config('app.order_source_event_id','',true);
    UPDATE public.orders AS o SET status='paid',shipped_at=NULL,shipping_carrier=NULL,tracking_number=NULL
    WHERE o.id=v_order AND o.status='shipped';
  END IF;
  IF NOT _actor_can_refund AND v_choice='consult' THEN
    v_shop:=private.enqueue_return_email(v_order,'return_refund_pending_shop',_return_id,v_receipt);
  END IF;
  IF _notify_customer AND v_refund IS NULL THEN
    PERFORM private.enqueue_return_email(v_order,CASE WHEN v_sent=(SELECT pg_catalog.sum(x.quantity)
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(quantity integer)) THEN 'return_sent_back' ELSE 'return_received' END,_return_id,v_receipt);
  END IF;
  return_status:=private.refresh_order_return_status(_return_id);
  SELECT rt.fee_due_amount INTO fee_due_amount FROM public.order_returns AS rt WHERE rt.id=_return_id;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_receive_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_receive_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_receive_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt,return_status,v_refund,v_amount,v_status,
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_receive_return(_return_id, _actor_id, _actor_can_refund, _request_key, _units, _exchange_overrides, _refund_choice, _refund_amount, _refund_shipping_amount, _note, _notify_customer, _sent_back_message, _sent_back_carrier, _sent_back_tracking_number);
$$;
ALTER FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;

CREATE FUNCTION private.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns%ROWTYPE;v_order uuid;v_fp text;v_old public.order_refunds%ROWTYPE;
  v_lines jsonb;v_goods integer;v_cap integer;v_amount integer;v_result record;v_receipt public.order_return_receipts%ROWTYPE;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _notify_customer IS NULL
    OR _shipping_amount IS NULL OR _shipping_amount<0 OR (_amount IS NOT NULL AND _amount<0)
    OR pg_catalog.char_length(_note)>500 THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_amount,
    'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT r.* INTO v_old FROM public.order_refunds AS r WHERE r.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id IS DISTINCT FROM _return_id OR v_old.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT v_old.id,v_old.amount,v_old.status,true;RETURN;
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_receipt.return_id IS DISTINCT FROM _return_id OR v_receipt.kind<>'waive_refund'
      OR v_receipt.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT NULL::uuid,0,'waived'::text,true;RETURN;
  END IF;
  -- closed の失敗した返金も受け直せる。P19 の保存した状態を巻き戻す必要はない。
  IF v_return.status NOT IN ('open','closed') THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,
      'before_shipment',false,'quantity',t.quantity) ORDER BY t.order_item_id),'[]'::jsonb),
    COALESCE(pg_catalog.sum(private.return_units_amount(t.order_item_id,t.quantity)),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,pg_catalog.sum(g.refund_waiting)::integer AS quantity
      FROM private.order_return_line_progress(_return_id) AS g JOIN public.order_return_lines AS l ON l.id=g.return_line_id
      WHERE g.refund_waiting>0 GROUP BY l.order_item_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_lines)=0 THEN RAISE EXCEPTION 'RETURN_NOTHING_TO_REFUND' USING ERRCODE='22023'; END IF;
  -- 計算どおり（相談の手数料を引いた額）が既定。店長が直した額の上限は返せる額（E-2 の値。仕様書 6-3・P8）で、
  -- 計算との差は core が adjustment_amount に残す
  v_cap:=GREATEST(v_goods-v_return.fee_pending_deduction,0)+_shipping_amount;
  v_amount:=COALESCE(_amount,v_cap);
  IF v_amount<_shipping_amount
    OR (_amount IS NOT NULL AND _amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a)) THEN
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  IF v_amount=0 THEN
    -- 返金の記録もメールも作らず、支払いの移動を伴わない処理済みの数を追記する。
    BEGIN
      INSERT INTO public.order_return_receipts(return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
        notify_customer,note,actor_id,actor_can_refund)
      VALUES(_return_id,_request_key,v_fp,'waive_refund',NULL,NULL,_notify_customer,_note,_actor_id,true)
      RETURNING * INTO v_receipt;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt.id,g.return_line_id,'refund_waived',g.refund_waiting,NULL,NULL
    FROM private.order_return_line_progress(_return_id) AS g WHERE g.refund_waiting>0;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0 AND pg_catalog.left(o.payment_intent_id,3)='pi_'
      AND pg_catalog.char_length(o.payment_intent_id)>3) THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  SELECT r.* INTO v_result FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,
    _shipping_amount,v_amount,_note,'requested_by_customer',NULL,_notify_customer,_actor_id,_amount,_return_id,
    LEAST(v_return.fee_pending_deduction,v_goods)) AS r;
  END IF;
  -- 新たに付く未収手数料は前の免除に含まれないため、受領を戻す時は免除の印も外す。
  UPDATE public.order_returns AS rt SET fee_pending_deduction=0,
    fee_due_amount=rt.fee_due_amount+GREATEST(v_return.fee_pending_deduction-v_goods,0),
    fee_waived=CASE WHEN v_return.fee_pending_deduction>v_goods THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_note END
  WHERE rt.id=_return_id;
  PERFORM private.refresh_order_return_status(_return_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_refund_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_refund_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_refund_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  IF v_amount=0 THEN RETURN QUERY SELECT NULL::uuid,0,'waived'::text,false;
  ELSE RETURN QUERY SELECT v_result.refund_id,v_result.amount,v_result.status,v_result.replayed; END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_refund_return(_return_id, _actor_id, _request_key, _amount, _shipping_amount, _note, _notify_customer);
$$;
ALTER FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) TO service_role;

CREATE FUNCTION private.admin_close_return_missing(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_units jsonb;
  v_status text;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object('return_id', _return_id, 'kind', 'close_missing')::text
  );

  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  -- 未処理の数を先に読む（書く表を、書きながら読まない）
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('return_line_id', p.return_line_id, 'quantity', p.unprocessed)
           ),
           '[]'::jsonb
         )
  INTO v_units
  FROM private.order_return_line_progress(_return_id) AS p
  WHERE p.unprocessed > 0;

  IF v_return.status <> 'open' OR pg_catalog.jsonb_array_length(v_units) = 0 THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'close_missing', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, x.return_line_id, 'missing', x.quantity
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer);

  v_status := private.refresh_order_return_status(_return_id);

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_close_return_missing', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_close_return_missing', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_close_return_missing', 'return_id', _return_id, 'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt_id, v_status, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_close_return_missing(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_close_return_missing(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_close_return_missing(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_close_return_missing(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_close_return_missing(_return_id, _actor_id, _request_key);
$$;
ALTER FUNCTION public.admin_close_return_missing(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_close_return_missing(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_close_return_missing(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION private.admin_reopen_return(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_units jsonb;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object('return_id', _return_id, 'kind', 'reopen')::text
  );

  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('return_line_id', p.return_line_id, 'quantity', p.missing)
           ),
           '[]'::jsonb
         )
  INTO v_units
  FROM private.order_return_line_progress(_return_id) AS p
  WHERE p.missing > 0;

  IF v_return.status <> 'closed' OR pg_catalog.jsonb_array_length(v_units) = 0 THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  -- 開き直す数は、その発送の行が今空けている数（行の数 − 返品が指す数 + 届かなかった数）を超えられない
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT l.fulfillment_id, l.order_item_id, pg_catalog.sum(x.quantity)::integer AS reopening
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer)
      JOIN public.order_return_lines AS l ON l.id = x.return_line_id
      GROUP BY l.fulfillment_id, l.order_item_id
    ) AS g
    LEFT JOIN private.fulfillment_line_returnable(v_return.order_id) AS fr
      ON fr.fulfillment_id = g.fulfillment_id AND fr.order_item_id = g.order_item_id
    WHERE g.reopening > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'reopen', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, x.return_line_id, 'missing_reopened', x.quantity
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer);

  UPDATE public.order_returns AS r
  SET status = 'open',
      reopened_at = pg_catalog.now(),
      reopened_by = _actor_id
  WHERE r.id = _return_id;

  -- 開き直すと未処理の数が戻って同じ商品の上限が下がり、ほかの返品の返金待ちが覆われることがある。
  -- 返金待ちも未処理も無い返品が受付中のまま固まらないよう、注文の鍵の下でほかの受付中を id の順（ふつうの返金と同じ）に確かめ直す。
  PERFORM private.refresh_order_return_status(rt.id)
  FROM public.order_returns AS rt
  WHERE rt.order_id = v_return.order_id AND rt.id <> _return_id AND rt.status = 'open'
  ORDER BY rt.id;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_reopen_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_reopen_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_reopen_return', 'return_id', _return_id, 'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt_id, 'open'::text, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_reopen_return(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_reopen_return(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_reopen_return(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_reopen_return(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_reopen_return(_return_id, _actor_id, _request_key);
$$;
ALTER FUNCTION public.admin_reopen_return(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_reopen_return(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reopen_return(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION private.admin_inspect_return(
  _return_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_status text;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'return_id', _return_id,
      'kind', 'inspect',
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'return_line_id', p.return_line_id,
                   'restocked', p.restocked,
                   'not_restocked', p.not_restocked
                 )
                 ORDER BY p.return_line_id
               )
        FROM private.parse_return_inspect_lines(_lines) AS p
      ), '[]'::jsonb)
    )::text
  );

  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  IF v_return.status <> 'open' THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_return_lines AS l
      WHERE l.id = p.return_line_id
        AND l.return_id = _return_id
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    LEFT JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id = p.return_line_id
    WHERE p.restocked + p.not_restocked > COALESCE(g.pending_inspection, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 色・サイズの無い古い商品は在庫に戻せない（受け取りの「在庫に戻す」と同じ断り）。戻さない検品なら決められる
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    JOIN public.order_return_lines AS l ON l.id = p.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE p.restocked > 0
      AND oi.variant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'inspect', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, p.return_line_id, 'inspected_restocked', p.restocked
  FROM private.parse_return_inspect_lines(_lines) AS p
  WHERE p.restocked > 0
  UNION ALL
  SELECT v_receipt_id, p.return_line_id, 'inspected_not_restocked', p.not_restocked
  FROM private.parse_return_inspect_lines(_lines) AS p
  WHERE p.not_restocked > 0;

  -- 台帳のメモ（note）は書かない（NULL。受け取りの台帳と同じ。在庫の履歴の画面は理由の言葉だけを出す。英字の記号を入れると画面にそのまま出る）
  INSERT INTO public.stock_movements
    (variant_id, delta, reason, order_id, order_item_id, note, created_by, return_id)
  SELECT oi.variant_id, p.restocked, 'return', v_return.order_id, l.order_item_id,
         NULL, _actor_id, _return_id
  FROM private.parse_return_inspect_lines(_lines) AS p
  JOIN public.order_return_lines AS l ON l.id = p.return_line_id
  JOIN public.order_items AS oi ON oi.id = l.order_item_id
  WHERE p.restocked > 0
    AND oi.variant_id IS NOT NULL
  ORDER BY oi.variant_id, l.order_item_id;

  v_status := private.refresh_order_return_status(_return_id);

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_inspect_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_inspect_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_inspect_return', 'return_id', _return_id, 'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt_id, v_status, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_inspect_return(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_inspect_return(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_inspect_return(uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_inspect_return(
  _return_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_inspect_return(_return_id, _actor_id, _request_key, _lines);
$$;
ALTER FUNCTION public.admin_inspect_return(uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_inspect_return(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_inspect_return(uuid,uuid,uuid,jsonb) TO service_role;

DO $g1_return_exchange_assert$
DECLARE v_signature text; v_oid oid; v_schema text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
    'admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
    'admin_close_return_missing(uuid,uuid,uuid)',
    'admin_reopen_return(uuid,uuid,uuid)',
    'admin_inspect_return(uuid,uuid,uuid,jsonb)'
  ] LOOP
    FOREACH v_schema IN ARRAY ARRAY['public', 'private'] LOOP
      v_oid := pg_catalog.to_regprocedure(v_schema || '.' || v_signature);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
        WHERE p.oid = v_oid AND p.proowner = 'postgres'::regrole
          AND p.prosecdef = (v_schema = 'private') AND 'search_path=""' = ANY(p.proconfig))
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'GROUP_G_RETURN_EXCHANGE_ACL_INVALID' USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p WHERE p.oid = 'private.refresh_order_return_status(uuid)'::regprocedure
    AND (p.prosecdef OR p.proowner <> 'postgres'::regrole OR NOT 'search_path=""' = ANY(p.proconfig)))
    OR pg_catalog.has_function_privilege('anon', 'private.refresh_order_return_status(uuid)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', 'private.refresh_order_return_status(uuid)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('service_role', 'private.refresh_order_return_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'GROUP_G_RETURN_EXCHANGE_ACL_INVALID' USING ERRCODE = '55000';
  END IF;
END;
$g1_return_exchange_assert$;

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
