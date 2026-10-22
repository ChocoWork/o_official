-- 注文状況のリンク・本人確認・公開材料（E-5、移行 A）。
-- 既存注文へリンクを一括作成せず、メール材料を初めて用意する時に作る。
BEGIN;

-- 1. P26: 既存の pgcrypto を移設せず、指定した配置と関数だけを認める。
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $order_status_crypto$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension AS e
    JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto'
      AND n.nspname = 'extensions'
  ) OR pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'ORDER_STATUS_CRYPTO_UNAVAILABLE';
  END IF;
END;
$order_status_crypto$;

-- 2. 注文ごとに1本。期限の検索用索引や定期削除は作らない。
CREATE TABLE private.order_status_links (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  token text NOT NULL,
  verify_until timestamptz DEFAULT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_status_links_token_key UNIQUE (token),
  CONSTRAINT order_status_links_token_check CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT order_status_links_failed_attempts_check CHECK (failed_attempts BETWEEN 0 AND 20)
);

ALTER TABLE private.order_status_links OWNER TO postgres;
ALTER TABLE private.order_status_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_status_links_deny_clients ON private.order_status_links
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- 3. 電話と照合値は DB の外へ返さない。全角数字をそろえてから数字以外を取り除く。
CREATE OR REPLACE FUNCTION private.order_status_phone_last_four(_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE WHEN pg_catalog.length(p.digits) >= 4 THEN pg_catalog.right(p.digits, 4) ELSE NULL END
  FROM (
    SELECT pg_catalog.regexp_replace(
      pg_catalog.translate(_phone, '０１２３４５６７８９', '0123456789'), '[^0-9]', '', 'g'
    ) AS digits
  ) AS p;
$$;

CREATE OR REPLACE FUNCTION private.order_status_four_equal(_actual text, _provided text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_difference integer := 0;
BEGIN
  IF _actual IS NULL OR _provided IS NULL
     OR _actual !~ '^[0-9]{4}$' OR _provided !~ '^[0-9]{4}$' THEN
    RETURN false;
  END IF;

  FOR v_index IN 1..4 LOOP
    v_difference := v_difference | (
      pg_catalog.ascii(pg_catalog.substr(_actual, v_index, 1))
      # pg_catalog.ascii(pg_catalog.substr(_provided, v_index, 1))
    );
  END LOOP;

  RETURN v_difference = 0;
END;
$$;

-- 4. 新しい public RPC。既存値を返し、注文ごとの競合と token の衝突を分ける。
CREATE OR REPLACE FUNCTION public.ensure_order_status_link(_order_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
  v_constraint text;
BEGIN
  IF _order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_STATUS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT l.token INTO v_token
  FROM private.order_status_links AS l
  WHERE l.order_id = _order_id;
  IF FOUND THEN
    RETURN v_token;
  END IF;

  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO private.order_status_links (order_id, token)
      VALUES (
        _order_id,
        pg_catalog.translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')
      )
      ON CONFLICT (order_id) DO NOTHING;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'order_status_links_token_key' THEN
        RAISE;
      END IF;
      CONTINUE;
    END;

    -- INSERT と同じ文の snapshot に頼らず、競合した接続が保存した値も別の SELECT で読む。
    SELECT l.token INTO v_token
    FROM private.order_status_links AS l
    WHERE l.order_id = _order_id;
    IF FOUND THEN
      RETURN v_token;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'ORDER_STATUS_TOKEN_COLLISION' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_order_status_link(_token text)
RETURNS TABLE (
  order_id uuid,
  customer_id uuid,
  verify_until timestamptz,
  failed_attempts integer,
  phone_available boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _token IS NULL OR _token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT l.order_id, o.user_id, l.verify_until, l.failed_attempts,
         private.order_status_phone_last_four(o.shipping_phone) IS NOT NULL
  FROM private.order_status_links AS l
  JOIN public.orders AS o ON o.id = l.order_id
  WHERE l.token = _token
    AND o.status NOT IN ('payment_in_progress', 'abandoned');
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_order_status_phone(_token text, _last_four text)
RETURNS TABLE (result text, verify_until timestamptz, failed_attempts integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid;
  v_verify_until timestamptz;
  v_failed_attempts integer;
  v_status public.order_status;
  v_actual text;
  v_result text;
BEGIN
  IF _token IS NULL OR _token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN;
  END IF;

  SELECT l.order_id, l.verify_until, l.failed_attempts
  INTO v_order_id, v_verify_until, v_failed_attempts
  FROM private.order_status_links AS l
  WHERE l.token = _token
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 行の鍵を得てから、現在の注文状態と電話を別の文で読み直す。
  SELECT o.status, private.order_status_phone_last_four(o.shipping_phone)
  INTO v_status, v_actual
  FROM public.orders AS o
  WHERE o.id = v_order_id;
  IF NOT FOUND OR v_status IN ('payment_in_progress', 'abandoned') THEN
    RETURN;
  END IF;
  IF _last_four IS NULL OR _last_four !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'ORDER_STATUS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_verify_until IS NULL OR v_verify_until <= pg_catalog.now() THEN
    v_result := 'expired';
  ELSIF v_actual IS NULL THEN
    v_result := 'unavailable';
  ELSIF v_failed_attempts >= 20 THEN
    v_result := 'locked';
  ELSIF private.order_status_four_equal(v_actual, _last_four) THEN
    v_result := 'ok';
  ELSE
    UPDATE private.order_status_links AS l
    SET failed_attempts = l.failed_attempts + 1
    WHERE l.order_id = v_order_id
    RETURNING l.failed_attempts INTO v_failed_attempts;
    v_result := 'mismatch';
  END IF;

  RETURN QUERY SELECT v_result, v_verify_until, v_failed_attempts;
END;
$$;

-- 公開用の列だけを取得する。個人情報を持つ既存 RPC や注文全行の JSON 化は使わない。
CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order jsonb;
BEGIN
  IF _order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'id', o.id,
    'created_at', o.created_at,
    'status', o.status,
    'subtotal_amount', o.subtotal_amount,
    'shipping_amount', o.shipping_amount,
    'discount_amount', o.discount_amount,
    'total_amount', o.total_amount,
    'currency', o.currency,
    'order_items', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', oi.id,
        'item_id', oi.item_id,
        'variant_id', oi.variant_id,
        'item_name', oi.item_name,
        'item_image_url', oi.item_image_url,
        'color', oi.color,
        'size', oi.size,
        'quantity', oi.quantity,
        'line_total', oi.line_total,
        'line_kind', oi.line_kind
      ) ORDER BY oi.created_at, oi.id)
      FROM public.order_items AS oi
      WHERE oi.order_id = o.id
    ), '[]'::jsonb)
  ) INTO v_order
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.status NOT IN ('payment_in_progress', 'abandoned');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order', v_order,
    'line_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'order_item_id', l.order_item_id,
        'variant_id', l.variant_id,
        'fulfillment_type', l.fulfillment_type,
        'quantity', l.quantity,
        'shipped', l.shipped,
        'completed', l.completed,
        'refunded_before_shipment', l.refunded_before_shipment,
        'refunded_after_shipment', l.refunded_after_shipment,
        'in_production', l.in_production,
        'ready_unshipped', l.ready_unshipped,
        'unshipped', l.unshipped
      ) ORDER BY l.order_item_id)
      FROM private.order_line_fulfillment(_order_id) AS l
    ), '[]'::jsonb),
    'fulfillments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'fulfillment_id', f.id,
        'number', f.number,
        'shipping_carrier', f.shipping_carrier,
        'shipped_at', f.shipped_at,
        'cancelled_at', f.cancelled_at,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'order_item_id', fl.order_item_id, 'quantity', fl.quantity
          ) ORDER BY fl.order_item_id)
          FROM public.order_fulfillment_lines AS fl
          WHERE fl.fulfillment_id = f.id
        ), '[]'::jsonb)
      ) ORDER BY f.number)
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ), '[]'::jsonb),
    'delivery_detail', pg_catalog.jsonb_build_object(
      'enabled', COALESCE((
        SELECT s.delivery_tracking_enabled FROM public.shop_settings AS s WHERE s.id = 1
      ), false),
      'fulfillments', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'fulfillment_id', f.id,
          'cancelled_at', f.cancelled_at,
          'tracking_version', f.tracking_version,
          'delivery_status', f.delivery_status,
          'delivery_status_at', f.delivery_status_at,
          'delivered_at', f.delivered_at,
          'registration', (
            SELECT pg_catalog.jsonb_build_object('state', r.state, 'ever_registered', r.ever_registered)
            FROM private.fulfillment_tracking_registrations AS r
            WHERE r.fulfillment_id = f.id
              AND r.tracking_version = f.tracking_version
          ),
          'events', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'tracking_version', e.tracking_version,
              'status', e.status,
              'happened_at', e.happened_at,
              'recorded_at', e.recorded_at
            ) ORDER BY e.happened_at DESC, e.recorded_at DESC, e.id)
            FROM public.order_fulfillment_events AS e
            WHERE e.fulfillment_id = f.id
              AND e.tracking_version = f.tracking_version
          ), '[]'::jsonb)
        ) ORDER BY f.number)
        FROM public.order_fulfillments AS f
        WHERE f.order_id = _order_id
      ), '[]'::jsonb)
    ),
    'delivery_summary', (
      SELECT pg_catalog.jsonb_build_object(
        'active_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL))::integer,
        'delivered_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL))::integer
      )
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ),
    'refund_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'refund_id', r.id, 'created_at', r.created_at, 'amount', r.amount, 'status', r.status
      ) ORDER BY r.created_at DESC, r.id DESC)
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
    ), '[]'::jsonb)
  );
END;
$$;

-- 5. 最新の既存本文を維持し、成功 UPDATE の結果だけで P4 の期限を進める。
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
DECLARE
  v_order_id uuid;
  v_kind text;
  v_sent_at timestamptz;
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
    AND e.lease_token = _lease_token
  RETURNING e.order_id, e.kind, e.sent_at INTO v_order_id, v_kind, v_sent_at;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- P4: 同じ注文の行の鍵で直列化し、更新時点の期限と比べる。リンク行の新設はしない。
  IF v_kind IN (
    'paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
    'return_accepted', 'return_received', 'return_sent_back', 'return_requested', 'return_declined',
    'cancel_request_received', 'cancel_request_declined', 'out_for_delivery', 'delivered', 'shipping_update'
  ) THEN
    UPDATE private.order_status_links AS l
    SET verify_until = GREATEST(l.verify_until, v_sent_at + interval '21 days'),
        failed_attempts = CASE
          WHEN l.verify_until IS NULL OR l.verify_until < v_sent_at + interval '21 days' THEN 0
          ELSE l.failed_attempts
        END
    WHERE l.order_id = v_order_id;
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

-- 6. private の schema USAGE は既存の移行が service_role へ付与済み。顧客への権限は追加しない。
ALTER FUNCTION private.order_status_phone_last_four(text) OWNER TO postgres;
ALTER FUNCTION private.order_status_four_equal(text, text) OWNER TO postgres;
ALTER FUNCTION public.ensure_order_status_link(uuid) OWNER TO postgres;
ALTER FUNCTION public.get_order_status_link(text) OWNER TO postgres;
ALTER FUNCTION public.verify_order_status_phone(text, text) OWNER TO postgres;
ALTER FUNCTION public.get_order_status_public_material(uuid) OWNER TO postgres;
ALTER FUNCTION public.complete_order_email(uuid, uuid, text) OWNER TO postgres;

REVOKE ALL ON TABLE private.order_status_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE private.order_status_links TO service_role;

REVOKE ALL ON FUNCTION private.order_status_phone_last_four(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_status_four_equal(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ensure_order_status_link(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_order_status_link(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.verify_order_status_phone(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_order_status_public_material(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.ensure_order_status_link(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_status_link(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_order_status_phone(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_status_public_material(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_email(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
