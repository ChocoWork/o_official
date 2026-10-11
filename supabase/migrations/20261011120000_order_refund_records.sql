-- 返金の記録と数え方（グループ E-2 設計書 4・7・10・11 章）の移行 A
--
-- 返金の記録（Shopify の Refund と RefundLineItem）の2つの表と守り、お客様から受け取った額 orders.paid_amount、
-- 在庫の台帳の返金の番号、ショップの設定、返金の記録を数え始めた時刻（切り替えの時刻）、権限の行を足す。
-- 商品ごとの数 private.order_line_fulfillment と確保中の数 private.order_line_reservations に返金を組み込み、
-- 割引の割り振りと返金の額の数え方、前からの写しを作る。
-- 表は public に置き（切り替えの時刻だけ private）、書くのは SECURITY DEFINER の関数だけ（service_role は読むだけ）。
-- 返金を始める関数は移行 B、結果を書く関数は注文のメールの表の列を使うので移行 C で作る。
BEGIN;

-- 1. 返金の記録（Shopify の Refund）と、返金した商品の行（RefundLineItem）。
--    実行した人の列は外部キーにしない: ON DELETE SET NULL は UPDATE として動くので、書き換えを止める守りとぶつかり、
--    利用者の削除そのものが失敗する（stock_movements と同じ考え）
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN (
    'admin', 'order_cancel', 'stripe_dashboard', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'legacy'
  )),
  -- 二重防止の番号と、その送り直しを見分ける指紋（入力を決まった順に並べた JSON の md5。本計画 P2）。
  -- 一意の制約と形の CHECK には名前を付ける: 移行 B の返金を始める関数が制約の名前で番号のぶつかりを見分け、
  -- 試験が CHECK の名前で形の断りを見分ける（自動の名前に頼らない）
  request_key uuid CONSTRAINT order_refunds_request_key_key UNIQUE,
  request_fingerprint text,
  -- Stripe の返金の番号。形は re_ に限らない（カード以外の支払いの返金は別の頭になりうる。本計画 P29）
  stripe_refund_id text CONSTRAINT order_refunds_stripe_refund_id_key UNIQUE
    CONSTRAINT order_refunds_stripe_refund_id_check CHECK (stripe_refund_id IS NULL OR stripe_refund_id ~ '^[a-z]{2,4}_[A-Za-z0-9]+$'),
  status text NOT NULL CHECK (status IN ('awaiting_response', 'error', 'pending', 'succeeded', 'failed')),
  stripe_status text CHECK (
    stripe_status IS NULL OR stripe_status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
  ),
  stripe_pending_reason text CHECK (
    stripe_pending_reason IS NULL OR stripe_pending_reason IN ('processing', 'insufficient_funds', 'charge_pending')
  ),
  -- エラーの時はこちらの理由（stripe_rejected・not_found_in_stripe）か、Stripe の誤りの記号
  stripe_failure_reason text CHECK (stripe_failure_reason IS NULL OR stripe_failure_reason ~ '^[a-z0-9_]{1,64}$'),
  customer_action_expires_at timestamptz,
  payment_method_type text CHECK (payment_method_type IS NULL OR payment_method_type ~ '^[a-z0-9_]{1,32}$'),
  amount integer NOT NULL CHECK (amount > 0),
  shipping_amount integer NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  -- 計算との差（手で額を直した分。正も負もある）
  adjustment_amount integer NOT NULL DEFAULT 0,
  note text CHECK (note IS NULL OR pg_catalog.char_length(note) <= 500),
  stripe_reason text CHECK (
    stripe_reason IS NULL OR stripe_reason IN ('requested_by_customer', 'duplicate', 'fraudulent')
  ),
  -- 列の CHECK に自動で付く名前（order_refunds_cancel_reason_check）は、下の表の CHECK の名前とぶつかって表を作れないので、別の名前を付ける
  cancel_reason text CONSTRAINT order_refunds_cancel_reason_value_check CHECK (
    cancel_reason IS NULL OR cancel_reason IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')
  ),
  notify_customer boolean NOT NULL,
  actor_id uuid,
  reference_number text CHECK (reference_number IS NULL OR pg_catalog.char_length(reference_number) BETWEEN 1 AND 64),
  reference_type text CHECK (reference_type IS NULL OR reference_type ~ '^[a-z0-9_]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  accepted_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  errored_at timestamptz,
  -- 1回だけにする印（在庫を動かした・メールの予定を書いた・失敗の後始末をした）
  stock_applied_at timestamptz,
  email_enqueued_at timestamptz,
  failure_applied_at timestamptz,
  CONSTRAINT order_refunds_request_check CHECK (
    ((source IN ('admin', 'order_cancel')) <= (request_key IS NOT NULL))
    AND ((request_key IS NULL) = (request_fingerprint IS NULL))
  ),
  CONSTRAINT order_refunds_external_check CHECK (
    source NOT IN ('stripe_dashboard', 'legacy') OR (stripe_refund_id IS NOT NULL AND request_key IS NULL)
  ),
  CONSTRAINT order_refunds_cancel_reason_check CHECK (
    (cancel_reason IS NOT NULL) = (source IN ('order_cancel', 'auto_amount_mismatch'))
  ),
  CONSTRAINT order_refunds_legacy_check CHECK (
    source <> 'legacy' OR (stock_applied_at IS NULL AND email_enqueued_at IS NULL AND notify_customer = false)
  )
);

CREATE TABLE IF NOT EXISTS public.order_refund_lines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items (id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  before_shipment boolean NOT NULL,
  restock_type text NOT NULL CHECK (restock_type IN ('cancel', 'no_restock')),
  amount integer NOT NULL CHECK (amount >= 0),
  -- 確保を外した数・在庫に戻した数・失敗で確保し直した数と足りなかった数。Stripe が返金を受け付けた時と、失敗した時に、0 から1回だけ書く
  released_quantity integer NOT NULL DEFAULT 0 CHECK (released_quantity >= 0),
  restocked_quantity integer NOT NULL DEFAULT 0 CHECK (restocked_quantity >= 0),
  rereserved_quantity integer NOT NULL DEFAULT 0 CHECK (rereserved_quantity >= 0),
  rereserve_shortage integer NOT NULL DEFAULT 0 CHECK (rereserve_shortage >= 0),
  CONSTRAINT order_refund_lines_refund_item_key UNIQUE (refund_id, order_item_id, before_shipment),
  CONSTRAINT order_refund_lines_restock_check CHECK (before_shipment OR restock_type = 'no_restock'),
  CONSTRAINT order_refund_lines_release_check CHECK (
    released_quantity <= quantity
    AND restocked_quantity <= released_quantity
    AND rereserved_quantity + rereserve_shortage <= released_quantity
  )
);

CREATE INDEX IF NOT EXISTS order_refunds_order_idx ON public.order_refunds (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_refunds_awaiting_idx ON public.order_refunds (created_at) WHERE status = 'awaiting_response';
CREATE INDEX IF NOT EXISTS order_refunds_pending_idx ON public.order_refunds (order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS order_refund_lines_item_idx ON public.order_refund_lines (order_item_id);

-- 2. 受け取った額と、在庫の台帳の返金の番号。
--    orders.paid_amount は店内だけの列（お客様の Data API には出さない。列の権限は後から足した列に及ばないので、何もしなければ隠れる。
--    tests/integration/db/order_internal_columns.integration.test.ts の店内の列に足してある）。
--    入金を記録する時（mark_order_paid）と、取り消した注文への入金を見つけた時に書く。普通は注文の合計と同じ
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_amount integer
    CONSTRAINT orders_paid_amount_check CHECK (paid_amount IS NULL OR paid_amount >= 0);

COMMENT ON COLUMN public.orders.paid_amount IS
  'お客様から受け取った額（円）。返金の全額の基準。入金を記録する時に書く（E-2 設計書 4-3）。店内だけの列';

-- 支払額が注文の合計より多い注文で、受け取った額の全部を返せるようにする（本計画 P6）
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_refunded_amount_range,
  ADD CONSTRAINT orders_refunded_amount_range
    CHECK (refunded_amount >= 0 AND refunded_amount <= GREATEST(total_amount, COALESCE(paid_amount, 0)));

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS refund_id uuid REFERENCES public.order_refunds (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS stock_movements_refund_id_idx ON public.stock_movements (refund_id) WHERE refund_id IS NOT NULL;

-- 3. 守り。書くのは SECURITY DEFINER の関数だけだが、関数の書き間違いも DB で止める（E-1 の発送の記録と同じ考え）。
--    記録は消さない。中身も直さない。進むのは状態とその細目・時刻・印だけ（Shopify も、始めた返金は取り消せない）
CREATE OR REPLACE FUNCTION private.guard_order_refund_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- 変えてよい列。ほかの列が変われば止める
  v_movable CONSTANT text[] := ARRAY[
    'status', 'stripe_status', 'stripe_pending_reason', 'stripe_failure_reason', 'customer_action_expires_at',
    'reference_number', 'reference_type', 'stripe_refund_id', 'payment_method_type', 'accepted_at',
    'succeeded_at', 'failed_at', 'errored_at', 'stock_applied_at', 'email_enqueued_at', 'failure_applied_at'
  ];
BEGIN
  -- DELETE と TRUNCATE。文のトリガーには OLD も NEW も無いので、先に抜ける
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_REFUND_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_REFUND_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  -- 空から値へ1回だけ書く列は、書いた後は変えない。同じ値の書き直しは通す（知らせの取り込みは何度でも同じ値を書く）
  IF (OLD.stripe_refund_id IS NOT NULL AND NEW.stripe_refund_id IS DISTINCT FROM OLD.stripe_refund_id)
     OR (OLD.payment_method_type IS NOT NULL AND NEW.payment_method_type IS DISTINCT FROM OLD.payment_method_type)
     OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
     OR (OLD.succeeded_at IS NOT NULL AND NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at)
     OR (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at)
     OR (OLD.errored_at IS NOT NULL AND NEW.errored_at IS DISTINCT FROM OLD.errored_at)
     OR (OLD.stock_applied_at IS NOT NULL AND NEW.stock_applied_at IS DISTINCT FROM OLD.stock_applied_at)
     OR (OLD.email_enqueued_at IS NOT NULL AND NEW.email_enqueued_at IS DISTINCT FROM OLD.email_enqueued_at)
     OR (OLD.failure_applied_at IS NOT NULL AND NEW.failure_applied_at IS DISTINCT FROM OLD.failure_applied_at) THEN
    RAISE EXCEPTION 'ORDER_REFUND_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  -- 状態の移り方。エラーから先へ進むのは、エラーにした後に Stripe で返金が見つかった時だけ（本計画 P23）
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'awaiting_response' AND NEW.status IN ('pending', 'succeeded', 'error', 'failed'))
    OR (OLD.status = 'error' AND NEW.status IN ('pending', 'succeeded', 'failed'))
    OR (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'succeeded' AND NEW.status = 'failed')
  ) THEN
    RAISE EXCEPTION 'ORDER_REFUND_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_order_refund_line_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- 確保を外した・戻した・確保し直した数。0 から1回だけ書ける
  v_movable CONSTANT text[] := ARRAY[
    'released_quantity', 'restocked_quantity', 'rereserved_quantity', 'rereserve_shortage'
  ];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_REFUND_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable)
     OR (OLD.released_quantity <> 0 AND NEW.released_quantity <> OLD.released_quantity)
     OR (OLD.restocked_quantity <> 0 AND NEW.restocked_quantity <> OLD.restocked_quantity)
     OR (OLD.rereserved_quantity <> 0 AND NEW.rereserved_quantity <> OLD.rereserved_quantity)
     OR (OLD.rereserve_shortage <> 0 AND NEW.rereserve_shortage <> OLD.rereserve_shortage) THEN
    RAISE EXCEPTION 'ORDER_REFUND_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 返金の商品は、その返金の注文の商品だけ
CREATE OR REPLACE FUNCTION private.check_refund_line_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_refunds AS r
    JOIN public.order_items AS oi ON oi.order_id = r.order_id
    WHERE r.id = NEW.refund_id
      AND oi.id = NEW.order_item_id
  ) THEN
    RAISE EXCEPTION 'REFUND_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_refunds_guard ON public.order_refunds;
CREATE TRIGGER order_refunds_guard
  BEFORE UPDATE OR DELETE ON public.order_refunds
  FOR EACH ROW EXECUTE FUNCTION private.guard_order_refund_change();
DROP TRIGGER IF EXISTS order_refunds_no_truncate ON public.order_refunds;
CREATE TRIGGER order_refunds_no_truncate
  BEFORE TRUNCATE ON public.order_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_order_refund_change();

DROP TRIGGER IF EXISTS order_refund_lines_guard ON public.order_refund_lines;
CREATE TRIGGER order_refund_lines_guard
  BEFORE UPDATE OR DELETE ON public.order_refund_lines
  FOR EACH ROW EXECUTE FUNCTION private.guard_order_refund_line_change();
DROP TRIGGER IF EXISTS order_refund_lines_no_truncate ON public.order_refund_lines;
CREATE TRIGGER order_refund_lines_no_truncate
  BEFORE TRUNCATE ON public.order_refund_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_order_refund_line_change();
DROP TRIGGER IF EXISTS order_refund_lines_order_check ON public.order_refund_lines;
CREATE TRIGGER order_refund_lines_order_check
  BEFORE INSERT ON public.order_refund_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_refund_line_order();

-- 4. ショップの設定（1行だけ。書くのは移行 B の関数）と、返金の記録を数え始めた時刻（切り替えの時刻。1行だけ）。
--    切り替えの時刻より前に Stripe で作られた返金は、後から取り込んでも写しとして扱い、在庫もメールも動かさない（設計書 10章）
CREATE TABLE IF NOT EXISTS public.shop_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_refund_cancelled_order_payment boolean NOT NULL DEFAULT true,
  auto_refund_cancelled_order_payment_updated_by uuid,
  auto_refund_cancelled_order_payment_updated_at timestamptz,
  auto_cancel_amount_mismatch boolean NOT NULL DEFAULT false,
  auto_cancel_amount_mismatch_updated_by uuid,
  auto_cancel_amount_mismatch_updated_at timestamptz
);

INSERT INTO public.shop_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS private.refund_ledger_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at timestamptz NOT NULL
);

INSERT INTO private.refund_ledger_state (id, started_at) VALUES (1, pg_catalog.now()) ON CONFLICT (id) DO NOTHING;

-- 5. 行の守りと権限。新しい public の表は anon・authenticated に自動で権限が付くので、まず全部外す
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_refund_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.refund_ledger_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.order_refunds;
CREATE POLICY "deny direct client access" ON public.order_refunds
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_refund_lines;
CREATE POLICY "deny direct client access" ON public.order_refund_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.shop_settings;
CREATE POLICY "deny direct client access" ON public.shop_settings
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_refunds FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_refund_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.shop_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_refunds TO service_role;
GRANT SELECT ON public.order_refund_lines TO service_role;
GRANT SELECT ON public.shop_settings TO service_role;
-- 切り替えの時刻の表は、関数（所有者の権限）だけが読む
REVOKE ALL ON TABLE private.refund_ledger_state FROM PUBLIC, anon, authenticated, service_role;

-- 6. 権限の行。返金と支払い済みのキャンセルは admin.orders.refund、ショップの設定は admin.settings.manage。店長の役割だけに付ける
INSERT INTO public.permissions (code, name)
VALUES ('admin.orders.refund', '注文の返金'), ('admin.settings.manage', 'ショップの設定')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles AS r
JOIN public.permissions AS p ON p.code IN ('admin.orders.refund', 'admin.settings.manage')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- 7. 確保中の数（設計書 7-1）。台帳の確保（purchase）と戻し（cancel・refund）を足して符号を反転する。
--    返金で戻した分も数えるので、返金で確保を外した注文の分は「引き当て済み」に残らない（R-16）。
--    「戻さない」返金の棚卸調整の行は数えない（確保は返金の行で外れている）
CREATE OR REPLACE FUNCTION private.order_line_reservations(_order_id uuid)
RETURNS TABLE (order_item_id uuid, variant_id bigint, quantity integer, reserved integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT oi.id,
         oi.variant_id,
         oi.quantity,
         GREATEST(0, -COALESCE((
           SELECT pg_catalog.sum(m.delta)
           FROM public.stock_movements AS m
           WHERE m.order_item_id = oi.id
             AND m.reason IN ('purchase', 'cancel', 'refund')
         ), 0))::integer
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id;
$$;

-- 8. 商品ごとの数に返金を入れる（設計書 4-4・7-6）。返す列が変わるので消して作り直す。
--    数えるのは返事待ち・保留・成功の返金の行だけ（エラーと失敗はお金が動いていない）。
--    未発送 = q − s − rb、まだ作っていない = max(q − rb − c, 0)、発送準備中 = max(min(c, q − rb) − s, 0)。
--    受注生産の品は、まだ作っていない分から先に返金で減る。発送後の返金（ra）は未発送を変えない
DROP FUNCTION IF EXISTS public.list_order_line_fulfillment(uuid[]);
DROP FUNCTION IF EXISTS private.order_line_fulfillment(uuid);

CREATE OR REPLACE FUNCTION private.order_line_fulfillment(_order_id uuid)
RETURNS TABLE (
  order_item_id uuid,
  variant_id bigint,
  fulfillment_type text,
  quantity integer,
  shipped integer,
  completed integer,
  refunded_before_shipment integer,
  refunded_after_shipment integer,
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
           END AS completed,
           COALESCE((
             SELECT pg_catalog.sum(rl.quantity)
             FROM public.order_refund_lines AS rl
             JOIN public.order_refunds AS r ON r.id = rl.refund_id
             WHERE rl.order_item_id = oi.id
               AND rl.before_shipment
               AND r.status IN ('awaiting_response', 'pending', 'succeeded')
           ), 0)::integer AS refunded_before,
           COALESCE((
             SELECT pg_catalog.sum(rl.quantity)
             FROM public.order_refund_lines AS rl
             JOIN public.order_refunds AS r ON r.id = rl.refund_id
             WHERE rl.order_item_id = oi.id
               AND NOT rl.before_shipment
               AND r.status IN ('awaiting_response', 'pending', 'succeeded')
           ), 0)::integer AS refunded_after
    FROM public.order_items AS oi
    WHERE oi.order_id = _order_id
  )
  SELECT c.id,
         c.variant_id,
         c.fulfillment_type,
         c.quantity,
         c.shipped,
         c.completed,
         c.refunded_before,
         c.refunded_after,
         GREATEST(c.quantity - c.refunded_before - c.completed, 0),
         GREATEST(LEAST(c.completed, c.quantity - c.refunded_before) - c.shipped, 0),
         GREATEST(c.quantity - c.shipped - c.refunded_before, 0)
  FROM counted AS c
$$;

-- 一覧の1ページ分の注文の数を1回で読む（E-1 から変えない。返す列に返金した数を足しただけ）
CREATE OR REPLACE FUNCTION public.list_order_line_fulfillment(_order_ids uuid[])
RETURNS TABLE (
  order_id uuid,
  order_item_id uuid,
  variant_id bigint,
  fulfillment_type text,
  quantity integer,
  shipped integer,
  completed integer,
  refunded_before_shipment integer,
  refunded_after_shipment integer,
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
         l.shipped, l.completed, l.refunded_before_shipment, l.refunded_after_shipment,
         l.in_production, l.ready_unshipped, l.unshipped
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_line_fulfillment(o.id) AS l
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id, l.order_item_id;
END;
$$;

-- 守る関係 s + rb ≤ q・ra ≤ s・s ≤ c（受注生産）を、関数の確かめに重ねてトリガーでも確かめる（設計書 4-4・7-6）。
-- E-1 の c ≤ q も残す（仕上がりの関数は q − rb − c までしか記録しないので、返金を入れても成り立つ）。
-- 発送の商品・仕上がりに加えて、返金の商品の行を足す時にも働く
CREATE OR REPLACE FUNCTION private.check_order_line_fulfillment_bounds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid;
  v_broken boolean;
BEGIN
  SELECT oi.order_id INTO v_order_id FROM public.order_items AS oi WHERE oi.id = NEW.order_item_id;
  SELECT NOT (
           l.shipped + l.refunded_before_shipment <= l.quantity
           AND l.refunded_after_shipment <= l.shipped
           AND l.shipped <= l.completed
           AND l.completed <= l.quantity
         ) INTO v_broken
  FROM private.order_line_fulfillment(v_order_id) AS l
  WHERE l.order_item_id = NEW.order_item_id;
  IF v_broken THEN
    RAISE EXCEPTION 'FULFILLMENT_BOUNDS_VIOLATED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS order_refund_lines_bounds_check ON public.order_refund_lines;
CREATE TRIGGER order_refund_lines_bounds_check
  AFTER INSERT ON public.order_refund_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_order_line_fulfillment_bounds();

-- 9. 割引の割り振りと返金の額の数え方（設計書 4-3・4-5）。SQL が正で、TS は同じ式で見込みだけ出す（本計画 P4）。
--    商品の割引は「累積で丸める」: 注文の商品を登録順（created_at、同じ時刻は id）に並べ、小計 Lᵢ を足していった和を Cᵢ として
--    R(C) = floor((2·D·C + ΣL) / (2·ΣL))（D は注文の割引、ΣL は小計の合計）を当て、商品 i の割引 Dᵢ = R(Cᵢ) − R(Cᵢ₋₁)（R(C₀) = 0）にする。
--    R は C が増えると減らないので、どの Dᵢ も 0 以上。最後の Cᵢ は ΣL で R(ΣL) = D なので、和は必ず D。
--    商品ごとに四捨五入して最後を残りにすると、小計が同じ4つの商品に割引 2 円で 1・1・1・−1 のように負になる。
--    D・C・ΣL は 0 以上なので、bigint の割り算の切り捨ては floor と同じ。
--    小計の合計が 0 の注文は R が決まらないので、最後の商品が割引の全部を受け、ほかは 0 にする
CREATE OR REPLACE FUNCTION private.order_line_discounts(_order_id uuid)
RETURNS TABLE (order_item_id uuid, line_discount integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH lines AS (
    SELECT oi.id,
           pg_catalog.row_number() OVER (ORDER BY oi.created_at, oi.id) AS line_no,
           pg_catalog.count(*) OVER () AS line_count,
           (pg_catalog.sum(oi.line_total) OVER (
             ORDER BY oi.created_at, oi.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ))::bigint AS running_total,
           (pg_catalog.sum(oi.line_total) OVER ())::bigint AS lines_total
    FROM public.order_items AS oi
    WHERE oi.order_id = _order_id
  ),
  rounded AS (
    SELECT l.id,
           l.line_no,
           CASE
             WHEN l.lines_total = 0 THEN
               CASE WHEN l.line_no = l.line_count THEN o.discount_amount::bigint ELSE 0::bigint END
             ELSE (2 * o.discount_amount::bigint * l.running_total + l.lines_total) / (2 * l.lines_total)
           END AS cumulative_discount
    FROM lines AS l
    CROSS JOIN public.orders AS o
    WHERE o.id = _order_id
  )
  SELECT r.id,
         (r.cumulative_discount - pg_catalog.lag(r.cumulative_discount, 1, 0::bigint) OVER (ORDER BY r.line_no))::integer
  FROM rounded AS r
  ORDER BY r.line_no
$$;

-- n 点分の割引 disc(n) = floor((2·Dᵢ·n + q) / (2·q))（Dᵢ は商品の割引、q は注文の数）。
-- 前に b 点返した後に k 点返す額は 単価 × k − (disc(b + k) − disc(b))。全部の点数を返すと disc(q) = Dᵢ になり、合計がぴったり合う
CREATE OR REPLACE FUNCTION private.refund_units_discount(_line_discount integer, _quantity integer, _units integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ((2 * _line_discount::bigint * _units + _quantity) / (2 * _quantity::bigint))::integer
$$;

-- 返金の額の数え方（設計書 4-3）。全額 = 受け取った額 paid_amount。返せる額 = 受け取った額 − 返事待ち・保留・成功の合計。
-- open_amount は返事待ちと保留。返せる送料 = 注文の送料 − 返事待ち・保留・成功の返金の送料の合計。
-- 受け取った額が空の注文は paid_amount を空のまま返し、返せる額を 0 にする（返金できない注文）
CREATE OR REPLACE FUNCTION private.order_refund_amounts(_order_id uuid)
RETURNS TABLE (
  paid_amount integer,
  succeeded_amount integer,
  open_amount integer,
  refundable_amount integer,
  shipping_amount integer,
  refunded_shipping integer,
  refundable_shipping integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT o.paid_amount,
         t.succeeded_total,
         t.open_total,
         GREATEST(COALESCE(o.paid_amount, 0) - t.succeeded_total - t.open_total, 0),
         o.shipping_amount,
         t.shipping_total,
         GREATEST(o.shipping_amount - t.shipping_total, 0)
  FROM public.orders AS o
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.status = 'succeeded'), 0)::integer AS succeeded_total,
           COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.status IN ('awaiting_response', 'pending')), 0)::integer AS open_total,
           COALESCE(
             pg_catalog.sum(r.shipping_amount) FILTER (WHERE r.status IN ('awaiting_response', 'pending', 'succeeded')),
             0
           )::integer AS shipping_total
    FROM public.order_refunds AS r
    WHERE r.order_id = o.id
  ) AS t
  WHERE o.id = _order_id
$$;

-- 10. 入金済みにする。本文は 20261009095736_order_email_enqueue.sql のままで、UPDATE に paid_amount = _paid_amount を足しただけ
--     （設計書 4-3。支払額が注文の合計と違っても、実際に受け取った額を残す。引数と答えは今のまま）
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
      paid_amount = _paid_amount,
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

-- 11. 在庫の履歴に、どの返金で動いたかを出す（設計書 9-5）。返す列に refund_id を足すので消して作り直す。
--     変わった後の数は、今の在庫数からその行より後の動きの合計を引いて出す（今のまま）
DROP FUNCTION IF EXISTS public.list_item_stock_history(bigint, integer);

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
  balance_after integer,
  refund_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.id, h.variant_id, h.delta, h.reason, h.note, h.created_at, h.actor_email, h.order_id, h.balance_after, h.refund_id
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
           ), 0))::integer AS balance_after,
           m.refund_id
    FROM public.stock_movements AS m
    JOIN public.item_variants AS v ON v.id = m.variant_id
    LEFT JOIN auth.users AS u ON u.id = m.created_by
    WHERE v.item_id = _item_id
  ) AS h
  ORDER BY h.id DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

-- 12. 前からの写し（設計書 10章）。何度呼んでも同じ結果。作った写しの数を返す。
--     会計の stripe_refunds の行ごとに、写し（source = 'legacy'）を作る。状態は Stripe の状態の対応のとおり
--     （pending・requires_action → 保留、succeeded → 成功、failed・canceled → 失敗）。商品の行は無く、在庫もメールも動かさない。
--     失敗した写しは failure_applied_at を入れ、後の同期が前からの失敗に要対応「返金の失敗」を作らないようにする。
--     受け取った額は、支払いの番号がある注文のうち、入金済み・発送済みと、返金済みの額があるキャンセルの注文に、合計と同じ額で書く
CREATE OR REPLACE FUNCTION private.backfill_legacy_order_refunds()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_created integer;
BEGIN
  WITH inserted AS (
    INSERT INTO public.order_refunds
      (order_id, source, stripe_refund_id, status, stripe_status, amount, adjustment_amount, stripe_reason,
       notify_customer, created_at, accepted_at, succeeded_at, failed_at, failure_applied_at)
    SELECT sr.order_id,
           'legacy',
           sr.id,
           CASE sr.status
             WHEN 'succeeded' THEN 'succeeded'
             WHEN 'failed' THEN 'failed'
             WHEN 'canceled' THEN 'failed'
             ELSE 'pending'
           END,
           sr.status,
           sr.amount,
           sr.amount,
           CASE WHEN sr.reason IN ('requested_by_customer', 'duplicate', 'fraudulent') THEN sr.reason END,
           false,
           sr.stripe_created_at,
           sr.stripe_created_at,
           CASE WHEN sr.status = 'succeeded' THEN sr.succeeded_at END,
           CASE WHEN sr.status IN ('failed', 'canceled') THEN sr.synced_at END,
           CASE WHEN sr.status IN ('failed', 'canceled') THEN sr.synced_at END
    FROM public.stripe_refunds AS sr
    WHERE NOT EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.stripe_refund_id = sr.id)
    RETURNING id
  )
  SELECT pg_catalog.count(*)::integer INTO v_created FROM inserted;

  PERFORM pg_catalog.set_config('app.order_change_reason', 'refund_ledger_backfill', true);
  UPDATE public.orders AS o
  SET paid_amount = o.total_amount
  WHERE o.paid_amount IS NULL
    AND o.payment_intent_id IS NOT NULL
    AND (
      o.status IN ('paid'::public.order_status, 'shipped'::public.order_status)
      OR (o.status = 'cancelled'::public.order_status AND o.refunded_amount > 0)
    );

  RETURN v_created;
END;
$$;

SELECT private.backfill_legacy_order_refunds();

-- 13. 関数の権限。private の関数は PUBLIC から外すだけ。作り直した public の関数は、権限を付け直す
REVOKE ALL ON FUNCTION private.guard_order_refund_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_order_refund_line_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_refund_line_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_reservations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_fulfillment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_order_line_fulfillment_bounds() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_discounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_units_discount(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_refund_amounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.backfill_legacy_order_refunds() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.list_order_line_fulfillment(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_item_stock_history(bigint, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_order_line_fulfillment(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_item_stock_history(bigint, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
