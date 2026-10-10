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

-- 守る関係 shipped ≤ completed ≤ quantity を、関数の確かめに重ねてトリガーでも確かめる（設計書 3-3）
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
  SELECT NOT (l.shipped <= l.completed AND l.completed <= l.quantity) INTO v_broken
  FROM private.order_line_fulfillment(v_order_id) AS l
  WHERE l.order_item_id = NEW.order_item_id;
  IF v_broken THEN
    RAISE EXCEPTION 'FULFILLMENT_BOUNDS_VIOLATED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS order_fulfillment_lines_bounds_check ON public.order_fulfillment_lines;
CREATE TRIGGER order_fulfillment_lines_bounds_check
  AFTER INSERT ON public.order_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_order_line_fulfillment_bounds();
DROP TRIGGER IF EXISTS order_item_completions_bounds_check ON public.order_item_completions;
CREATE TRIGGER order_item_completions_bounds_check
  AFTER INSERT OR UPDATE ON public.order_item_completions
  FOR EACH ROW EXECUTE FUNCTION private.check_order_line_fulfillment_bounds();

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
         FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
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
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
    LEFT JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE l.order_item_id IS NULL
       OR l.fulfillment_type <> 'backorder'
  ) THEN
    RAISE EXCEPTION 'LINE_NOT_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE r.quantity > l.in_production
  ) THEN
    RAISE EXCEPTION 'QUANTITY_EXCEEDS_IN_PRODUCTION' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  INSERT INTO public.order_item_completions AS c (order_id, order_item_id, quantity, request_key, created_by)
  SELECT _order_id, r.order_item_id, r.quantity, _request_key, _actor_id
  FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
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

  -- 送った受注生産の品は作り終えている（shipped ≤ completed を守る）。
  -- 数の関係は行ごとにトリガーがすぐ確かめるので、仕上がりを発送の商品より先に書く
  INSERT INTO public.order_item_completions (order_id, order_item_id, quantity, request_key, legacy)
  SELECT oi.order_id, oi.id, oi.quantity, pg_catalog.gen_random_uuid(), true
  FROM public.order_items AS oi
  JOIN public.order_fulfillments AS f ON f.order_id = oi.order_id AND f.legacy
  WHERE oi.fulfillment_type = 'backorder'
    AND NOT EXISTS (SELECT 1 FROM public.order_item_completions AS c WHERE c.order_item_id = oi.id);

  INSERT INTO public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity)
  SELECT f.id, oi.id, oi.quantity
  FROM public.order_fulfillments AS f
  JOIN public.order_items AS oi ON oi.order_id = f.order_id
  WHERE f.legacy
    AND NOT EXISTS (SELECT 1 FROM public.order_fulfillment_lines AS l WHERE l.fulfillment_id = f.id);

  RETURN v_created;
END;
$$;

SELECT private.backfill_legacy_fulfillments();

-- 10. 権限。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.reject_fulfillment_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.restrict_fulfillment_record_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_fulfillment_line_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_completion_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_order_line_fulfillment_bounds() FROM PUBLIC;
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
