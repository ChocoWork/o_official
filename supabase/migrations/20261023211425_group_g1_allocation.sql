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

-- 11. Task 2 の確かめ: 新しい 4 表（空・RLS・所有者）、足した 2 列、操作への遅延の外部キー、台帳の理由、12 のトリガー。
--     違えば GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 で全部を戻す（全体の期待一覧は最後の確かめが Task 14 で持つ）
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
