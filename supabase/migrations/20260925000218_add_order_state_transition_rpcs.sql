-- 入金済み注文の状態遷移を用途別の service-role RPC に限定する。
--
-- 【保留中・第1段階】アプリのデプロイ前に明示承認を得て昇格する。
-- この段階では既存の orders UPDATE 権限と RLS policy は変更しない。

BEGIN;

-- 人間による管理操作では、サーバーが認証済みセッションから取得した利用者IDを
-- app.order_actor_id に設定する。Webhook は NULL のまま実行する。
CREATE OR REPLACE FUNCTION private.record_order_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed text[];
  revision_operation text;
  revision_reason text;
  revision_source_event_id text;
  revision_actor_id uuid;
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(key ORDER BY key), '{}'::text[])
  INTO changed
  FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(NEW)) AS new_value(key, value)
  WHERE value IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> key);

  IF pg_catalog.cardinality(changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF changed && ARRAY['refunded_amount', 'refunded_at'] THEN
    revision_operation := 'refund_update';
  ELSIF changed && ARRAY['status'] THEN
    revision_operation := 'status_update';
  ELSE
    revision_operation := 'operational_update';
  END IF;

  revision_reason := NULLIF(
    pg_catalog.current_setting('app.order_change_reason', true),
    ''
  );
  revision_source_event_id := NULLIF(
    pg_catalog.current_setting('app.order_source_event_id', true),
    ''
  );
  revision_actor_id := COALESCE(
    NULLIF(pg_catalog.current_setting('app.order_actor_id', true), '')::uuid,
    auth.uid()
  );

  INSERT INTO public.order_revisions (
    order_id,
    operation,
    before_data,
    after_data,
    changed_fields,
    changed_by,
    reason,
    source_event_id
  ) VALUES (
    NEW.id,
    revision_operation,
    pg_catalog.to_jsonb(OLD),
    pg_catalog.to_jsonb(NEW),
    changed,
    revision_actor_id,
    revision_reason,
    revision_source_event_id
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid
)
RETURNS TABLE (
  id uuid,
  status public.order_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_failed_order', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'cancelled'::public.order_status
  WHERE o.id = _order_id
    AND o.status = 'failed'::public.order_status
  RETURNING o.id, o.status;
END;
$$;

-- 配送先の原本は法定記録として変更禁止。発送可否は原本の必須項目から判定し、
-- Web UI・RPC・トリガーが同じ条件を使う。
CREATE OR REPLACE FUNCTION private.order_has_required_shipping_fields(_order public.orders)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.btrim(_order.shipping_email), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_full_name), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_postal_code), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_prefecture), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_city), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_address), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(_order.shipping_phone), '') IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION private.order_has_required_shipping_fields(public.orders) FROM PUBLIC;

CREATE OR REPLACE FUNCTION private.reject_shipping_without_address()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'shipped'::public.order_status
       AND NOT private.order_has_required_shipping_fields(NEW) THEN
      RAISE EXCEPTION 'ORDER_SHIPPING_ADDRESS_INCOMPLETE'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'shipped'::public.order_status
        AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- 後発の refund.failed が、実際に発送済みだった注文を cancelled から復元する
    -- 場合は発送操作ではない。既存の発送記録を失わない。
    IF OLD.status = 'cancelled'::public.order_status
       AND OLD.shipped_at IS NOT NULL
       AND OLD.refunded_amount >= OLD.total_amount
       AND NEW.refunded_amount < NEW.total_amount THEN
      RETURN NEW;
    END IF;

    IF NOT private.order_has_required_shipping_fields(NEW) THEN
      RAISE EXCEPTION 'ORDER_SHIPPING_ADDRESS_INCOMPLETE'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.reject_shipping_without_address() FROM PUBLIC;

DROP TRIGGER IF EXISTS reject_shipping_without_address ON public.orders;
CREATE TRIGGER reject_shipping_without_address
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.reject_shipping_without_address();
CREATE OR REPLACE FUNCTION public.admin_ship_paid_order(
  _order_id uuid,
  _actor_id uuid,
  _shipping_carrier text,
  _tracking_number text
)
RETURNS TABLE (
  id uuid,
  shipping_email text,
  shipping_full_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  IF _shipping_carrier IS NULL
     OR NOT (_shipping_carrier = ANY (ARRAY['yamato', 'sagawa', 'japanpost'])) THEN
    RAISE EXCEPTION 'INVALID_SHIPPING_CARRIER'
      USING ERRCODE = '22023';
  END IF;

  IF _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_TRACKING_NUMBER'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_ship_paid_order', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'shipped'::public.order_status,
      shipped_at = pg_catalog.now(),
      shipping_carrier = _shipping_carrier,
      tracking_number = _tracking_number
  WHERE o.id = _order_id
    AND o.status = 'paid'::public.order_status
    AND o.shipped_at IS NULL
    AND private.order_has_required_shipping_fields(o)
  RETURNING o.id, o.shipping_email, o.shipping_full_name;
END;
$$;

DROP FUNCTION IF EXISTS public.apply_order_refund_projection(
  uuid, public.order_status, integer, integer, timestamptz, timestamptz, uuid
);

CREATE OR REPLACE FUNCTION public.apply_order_refund_projection(
  _order_id uuid,
  _expected_status public.order_status,
  _expected_refunded_amount integer,
  _expected_payment_status_updated_at timestamptz,
  _refunded_amount integer,
  _refunded_at timestamptz,
  _payment_status_updated_at timestamptz,
  _actor_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  status public.order_status,
  refunded_amount integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _expected_status IS NULL
     OR _expected_refunded_amount IS NULL
     OR _refunded_amount IS NULL
     OR _payment_status_updated_at IS NULL THEN
    RAISE EXCEPTION 'REFUND_PROJECTION_ARGUMENT_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  IF _refunded_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_REFUNDED_AMOUNT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.order_actor_id',
    COALESCE(_actor_id::text, ''),
    true
  );
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_refund_projection', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET refunded_amount = _refunded_amount,
      refunded_at = _refunded_at,
      payment_status_updated_at = _payment_status_updated_at,
      status = CASE
        WHEN _refunded_amount >= o.total_amount
          THEN 'cancelled'::public.order_status
        WHEN o.status = 'cancelled'::public.order_status
          AND o.refunded_amount >= o.total_amount
          AND _refunded_amount < o.total_amount
          THEN CASE
            WHEN o.shipped_at IS NOT NULL THEN 'shipped'::public.order_status
            ELSE 'paid'::public.order_status
          END
        ELSE o.status
      END
  WHERE o.id = _order_id
    AND o.status = _expected_status
    AND o.refunded_amount = _expected_refunded_amount
    AND o.payment_status_updated_at IS NOT DISTINCT FROM _expected_payment_status_updated_at
    AND o.status IN (
      'paid'::public.order_status,
      'shipped'::public.order_status,
      'cancelled'::public.order_status
    )
    AND (
      o.status <> 'cancelled'::public.order_status
      OR o.refunded_amount >= o.total_amount
    )
    AND _refunded_amount <= o.total_amount
  RETURNING o.id, o.status, o.refunded_amount;
END;
$$;

REVOKE ALL ON FUNCTION private.record_order_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_cancel_failed_order(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_order_refund_projection(
  uuid, public.order_status, integer, timestamptz, integer, timestamptz, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_cancel_failed_order(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_order_refund_projection(
  uuid, public.order_status, integer, timestamptz, integer, timestamptz, timestamptz, uuid
) TO service_role;

COMMIT;
