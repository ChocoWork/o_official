-- 要対応の記録・要確認の確認・メールの種類・発送止め（グループ A 設計書 4-1・4-2・4-4・5-2・第7章）。

BEGIN;

-- 1. 要対応の記録。同じ支払い・同じ理由は1行にまとめる。個人情報は入れない。
CREATE TABLE IF NOT EXISTS public.payment_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_ref          text NOT NULL CHECK (char_length(payment_ref) BETWEEN 1 AND 255),
  checkout_session_id  text,
  payment_intent_id    text,
  draft_id             uuid,
  order_id             uuid REFERENCES public.orders (id),
  reason               text NOT NULL CHECK (reason IN (
                         'order_not_creatable',
                         'paid_amount_mismatch',
                         'cancelled_order_paid',
                         'state_conflict',
                         'unexpected_state',
                         'stripe_object_missing'
                       )),
  detail               text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,64}$'),
  first_detected_at    timestamptz NOT NULL DEFAULT now(),
  last_detected_at     timestamptz NOT NULL DEFAULT now(),
  detection_count      integer NOT NULL DEFAULT 1 CHECK (detection_count >= 1),
  shop_notified_at     timestamptz,
  customer_notified_at timestamptz,
  resolved_at          timestamptz,
  resolved_by          uuid,
  resolution_note      text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  CONSTRAINT payment_exceptions_ref_reason_key UNIQUE (payment_ref, reason)
);

CREATE INDEX IF NOT EXISTS payment_exceptions_order_id_idx ON public.payment_exceptions (order_id);
CREATE INDEX IF NOT EXISTS payment_exceptions_open_idx
  ON public.payment_exceptions (first_detected_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.payment_exceptions IS
  '支払いの要対応（設計書 4-4）。読み書きは service_role の RPC と管理 API だけ';

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.payment_exceptions;
CREATE POLICY "deny direct client access" ON public.payment_exceptions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- このプロジェクトは public の新しい表に anon・authenticated の全権限を自動で付けるので、先に剥がす。
REVOKE ALL ON TABLE public.payment_exceptions FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.payment_exceptions TO service_role;

-- 2. 要対応を記録する。解決済みの行は開き直さず、最後の検知時刻と回数だけ更新する。
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  inserted_id uuid;
  existing public.payment_exceptions%ROWTYPE;
BEGIN
  INSERT INTO public.payment_exceptions (
    payment_ref, reason, detail, checkout_session_id, payment_intent_id, draft_id, order_id
  ) VALUES (
    _payment_ref, _reason, _detail, _checkout_session_id, _payment_intent_id, _draft_id, _order_id
  )
  ON CONFLICT (payment_ref, reason) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_id, true, false;
    RETURN;
  END IF;

  UPDATE public.payment_exceptions AS e
  SET last_detected_at = pg_catalog.now(),
      detection_count = e.detection_count + 1,
      checkout_session_id = COALESCE(e.checkout_session_id, _checkout_session_id),
      payment_intent_id = COALESCE(e.payment_intent_id, _payment_intent_id),
      draft_id = COALESCE(e.draft_id, _draft_id),
      order_id = COALESCE(e.order_id, _order_id)
  WHERE e.payment_ref = _payment_ref
    AND e.reason = _reason
  RETURNING e.* INTO existing;

  RETURN QUERY SELECT existing.id, false, existing.resolved_at IS NOT NULL;
END;
$$;

-- 3. 通知の送信権。送る前に押さえ、送れなければ戻す（二重にも0通にもしない）。
CREATE OR REPLACE FUNCTION public.claim_payment_exception_notification(_exception_id uuid, _channel text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _channel = 'shop' THEN
    UPDATE public.payment_exceptions
    SET shop_notified_at = pg_catalog.now()
    WHERE id = _exception_id AND shop_notified_at IS NULL;
  ELSIF _channel = 'customer' THEN
    UPDATE public.payment_exceptions
    SET customer_notified_at = pg_catalog.now()
    WHERE id = _exception_id AND customer_notified_at IS NULL;
  ELSE
    RAISE EXCEPTION 'INVALID_NOTIFICATION_CHANNEL' USING ERRCODE = '22023';
  END IF;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_payment_exception_notification(_exception_id uuid, _channel text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _channel = 'shop' THEN
    UPDATE public.payment_exceptions SET shop_notified_at = NULL WHERE id = _exception_id;
  ELSIF _channel = 'customer' THEN
    UPDATE public.payment_exceptions SET customer_notified_at = NULL WHERE id = _exception_id;
  ELSE
    RAISE EXCEPTION 'INVALID_NOTIFICATION_CHANNEL' USING ERRCODE = '22023';
  END IF;

  RETURN FOUND;
END;
$$;

-- 4. 解決済みにする。未入金の注文が付いていれば、取り消して解決することもできる（メモ必須）。
CREATE OR REPLACE FUNCTION public.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.payment_exceptions%ROWTYPE;
  current_status public.order_status;
  was_released boolean;
BEGIN
  IF _exception_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;

  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
    RETURN;
  END IF;

  IF COALESCE(_cancel_order, false) THEN
    IF NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
      RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT o.status INTO current_status FROM public.orders AS o WHERE o.id = target.order_id;

    IF current_status IS NULL
       OR current_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
      RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
    END IF;

    SELECT r.released INTO was_released
    FROM public.release_stock_for_unpaid_order(
      target.order_id,
      current_status,
      'cancelled'::public.order_status,
      'resolve_payment_exception',
      _actor_id,
      NULL,
      _cancel_reason,
      _note,
      _notify_customer
    ) AS r;

    IF NOT COALESCE(was_released, false) THEN
      RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
      RETURN;
    END IF;
  END IF;

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  RETURN QUERY SELECT
    true,
    target.order_id,
    CASE WHEN COALESCE(_cancel_order, false) THEN current_status ELSE NULL::public.order_status END;
END;
$$;

-- 5. 要確認を確認済みにする。手動の操作でだけ付く（発送や返金で自動では付かない）。
CREATE OR REPLACE FUNCTION public.mark_order_reviewed(_order_id uuid, _actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _order_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_mark_order_reviewed', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET reviewed_at = pg_catalog.now(),
      reviewed_by = _actor_id
  WHERE o.id = _order_id
    AND o.review_reason IS NOT NULL
    AND o.reviewed_at IS NULL;

  RETURN FOUND;
END;
$$;

-- 6. 失敗の注文の取消。理由とメモを残す。お客様には送らない（期限切れで知らせ済み）。
CREATE OR REPLACE FUNCTION public.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid,
  _cancel_reason text,
  _note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason IS NULL
     OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other') THEN
    RAISE EXCEPTION 'CANCEL_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'CANCEL_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_failed_order', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'cancelled'::public.order_status,
      cancel_reason = _cancel_reason,
      cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
      cancel_notify_customer = false
  WHERE o.id = _order_id
    AND o.status = 'failed'::public.order_status
  RETURNING o.id, o.status;
END;
$$;

-- 7. 発送は、支払額の違いの要対応が開いている注文を断る（金額を確かめてから発送する）。
CREATE OR REPLACE FUNCTION public.admin_ship_paid_order(
  _order_id uuid,
  _actor_id uuid,
  _shipping_carrier text,
  _tracking_number text
)
RETURNS TABLE (id uuid, shipping_email text, shipping_full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _shipping_carrier IS NULL
     OR NOT (_shipping_carrier = ANY (ARRAY['yamato', 'sagawa', 'japanpost'])) THEN
    RAISE EXCEPTION 'INVALID_SHIPPING_CARRIER' USING ERRCODE = '22023';
  END IF;

  IF _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_TRACKING_NUMBER' USING ERRCODE = '22023';
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
    AND NOT EXISTS (
      SELECT 1
      FROM public.payment_exceptions AS e
      WHERE e.order_id = o.id
        AND e.reason = 'paid_amount_mismatch'
        AND e.resolved_at IS NULL
    )
  RETURNING o.id, o.shipping_email, o.shipping_full_name;
END;
$$;

-- 8. メールの送信権に「期限切れ」と「取消」を加える（E で返金系を足す）。
ALTER TABLE private.order_emails DROP CONSTRAINT IF EXISTS order_emails_kind_check;
ALTER TABLE private.order_emails
  ADD CONSTRAINT order_emails_kind_check
  CHECK (kind IN ('awaiting_payment', 'paid', 'payment_expired', 'canceled'));

-- 9. 移行前の未入金の注文（Session ID なし。アプリ未公開の時期の注文）に、半年後のメールが
--    届かないよう、お客様向けメールの送信権をすべて送信済みとして登録する（設計書 7-1）。
CREATE OR REPLACE FUNCTION private.suppress_legacy_unpaid_order_emails()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO private.order_emails (order_id, kind)
  SELECT o.id, k.kind
  FROM public.orders AS o
  CROSS JOIN (VALUES ('awaiting_payment'), ('paid'), ('payment_expired'), ('canceled')) AS k(kind)
  WHERE o.status = 'pending'::public.order_status
    AND o.checkout_session_id IS NULL
  ON CONFLICT (order_id, kind) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION private.suppress_legacy_unpaid_order_emails() FROM PUBLIC;

SELECT private.suppress_legacy_unpaid_order_emails();

-- 10. 権限。新しく作った関数は既定で PUBLIC が実行できるので剥がす。
REVOKE ALL ON FUNCTION public.record_payment_exception(text, text, text, text, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_payment_exception_notification(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_payment_exception_notification(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_reviewed(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_payment_exception(text, text, text, text, text, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_payment_exception_notification(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_payment_exception_notification(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_reviewed(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text) TO service_role;

COMMIT;
