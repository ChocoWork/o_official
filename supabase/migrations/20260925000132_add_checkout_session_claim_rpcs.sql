-- Checkout Session 作成の TOCTOU 競合と外部APIの重複実行を防ぐ。
--
-- 【保留中・互換段階】アプリのデプロイ前に明示承認を得て昇格する。
-- 既存アプリの直接 INSERT をこの段階では残し、新アプリは service-role 専用 RPC を使う。

BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN checkout_request_version smallint,
  ADD COLUMN checkout_request_fingerprint text,
  ADD COLUMN checkout_ui_mode text,
  ADD COLUMN checkout_origin text,
  ADD COLUMN tax_amount integer NOT NULL DEFAULT 0;

ALTER TABLE public.checkout_drafts
  ADD CONSTRAINT checkout_drafts_request_identity_check CHECK (
    (
      checkout_request_version IS NULL
      AND checkout_request_fingerprint IS NULL
      AND checkout_ui_mode IS NULL
      AND checkout_origin IS NULL
    )
    OR (
      checkout_request_version = 0
      AND checkout_request_fingerprint ~ '^v0:[0-9a-f]{64}$'
      AND checkout_ui_mode IS NULL
      AND checkout_origin IS NULL
    )
    OR (
      checkout_request_version > 0
      AND checkout_request_fingerprint ~ ('^v' || checkout_request_version::text || ':[0-9a-f]{64}$')
      AND checkout_ui_mode = ANY (ARRAY['custom'::text, 'hosted'::text])
      AND checkout_origin ~ '^https?://[^/]+$'
    )
  ),
  ADD CONSTRAINT checkout_drafts_tax_amount_check CHECK (tax_amount >= 0);

CREATE UNIQUE INDEX checkout_drafts_active_request_key
  ON public.checkout_drafts (
    session_id,
    checkout_request_version,
    checkout_request_fingerprint
  )
  WHERE status = 'created'
    AND checkout_request_fingerprint IS NOT NULL;

COMMENT ON COLUMN public.checkout_drafts.checkout_request_version IS
  'Checkout Session 作成パラメータ契約の版。固定オプション変更時に版を上げる。';
COMMENT ON COLUMN public.checkout_drafts.checkout_request_fingerprint IS
  'サーバー算出のカート内容・金額・UIモード・正規originから作るSHA-256 fingerprint。';
COMMENT ON COLUMN public.checkout_drafts.checkout_ui_mode IS
  'Stripe Checkout Session の ui_mode。';
COMMENT ON COLUMN public.checkout_drafts.checkout_origin IS
  '許可リストで検証済みの success/cancel URL origin。';
COMMENT ON COLUMN public.checkout_drafts.tax_amount IS
  'Checkout Session 作成時のサーバー算出税額。';

CREATE OR REPLACE FUNCTION public.claim_checkout_draft(
  _session_id text,
  _request_version smallint,
  _request_fingerprint text,
  _checkout_ui_mode text,
  _checkout_origin text,
  _payment_method text,
  _currency text,
  _subtotal_amount integer,
  _tax_amount integer,
  _shipping_amount integer,
  _total_amount integer,
  _shipping_snapshot jsonb,
  _items_snapshot jsonb
)
RETURNS TABLE (
  id uuid,
  session_id text,
  checkout_session_id text,
  payment_method text,
  currency text,
  subtotal_amount integer,
  tax_amount integer,
  shipping_amount integer,
  total_amount integer,
  shipping_snapshot jsonb,
  items_snapshot jsonb,
  shipping_revision bigint,
  checkout_request_version smallint,
  checkout_request_fingerprint text,
  checkout_ui_mode text,
  checkout_origin text,
  claim_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  claimed public.checkout_drafts%ROWTYPE;
  inserted boolean := false;
BEGIN
  IF _session_id IS NULL
     OR pg_catalog.char_length(_session_id) NOT BETWEEN 1 AND 512
     OR _request_version IS NULL
     OR _request_version <= 0
     OR _request_fingerprint IS NULL
     OR _request_fingerprint !~ ('^v' || _request_version::text || ':[0-9a-f]{64}$')
     OR _checkout_ui_mode IS NULL
     OR NOT (_checkout_ui_mode = ANY (ARRAY['custom'::text, 'hosted'::text]))
     OR _checkout_origin IS NULL
     OR _checkout_origin !~ '^https?://[^/]+$'
     OR _payment_method IS NULL
     OR NOT (_payment_method = ANY (ARRAY['stripe_card'::text, 'stripe_paypay'::text, 'stripe_konbini'::text]))
     OR _currency <> 'jpy'
     OR _subtotal_amount < 0
     OR _tax_amount < 0
     OR _shipping_amount < 0
     OR _total_amount <= 0
     OR _total_amount <> _subtotal_amount + _tax_amount + _shipping_amount
     OR _items_snapshot IS NULL
     OR pg_catalog.jsonb_typeof(_items_snapshot) <> 'array'
     OR pg_catalog.jsonb_array_length(_items_snapshot) = 0 THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT_CLAIM'
      USING ERRCODE = '22023';
  END IF;

  FOR attempt IN 1..3 LOOP
    claimed := NULL;
    inserted := false;

    INSERT INTO public.checkout_drafts AS d (
      session_id,
      payment_method,
      currency,
      subtotal_amount,
      tax_amount,
      shipping_amount,
      total_amount,
      shipping_snapshot,
      items_snapshot,
      checkout_request_version,
      checkout_request_fingerprint,
      checkout_ui_mode,
      checkout_origin
    ) VALUES (
      _session_id,
      _payment_method,
      _currency,
      _subtotal_amount,
      _tax_amount,
      _shipping_amount,
      _total_amount,
      _shipping_snapshot,
      _items_snapshot,
      _request_version,
      _request_fingerprint,
      _checkout_ui_mode,
      _checkout_origin
    )
    ON CONFLICT (
      session_id,
      checkout_request_version,
      checkout_request_fingerprint
    ) WHERE status = 'created'
      AND checkout_request_fingerprint IS NOT NULL
    DO NOTHING
    RETURNING d.* INTO claimed;

    IF FOUND THEN
      inserted := true;
      EXIT;
    END IF;

    SELECT d.*
    INTO claimed
    FROM public.checkout_drafts AS d
    WHERE d.session_id = _session_id
      AND d.checkout_request_version = _request_version
      AND d.checkout_request_fingerprint = _request_fingerprint
      AND d.status = 'created'
    LIMIT 1;

    IF FOUND THEN
      EXIT;
    END IF;
  END LOOP;

  IF claimed.id IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_CLAIM_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  IF claimed.currency IS DISTINCT FROM _currency
     OR claimed.subtotal_amount IS DISTINCT FROM _subtotal_amount
     OR claimed.tax_amount IS DISTINCT FROM _tax_amount
     OR claimed.shipping_amount IS DISTINCT FROM _shipping_amount
     OR claimed.total_amount IS DISTINCT FROM _total_amount
     OR claimed.items_snapshot IS DISTINCT FROM _items_snapshot
     OR claimed.checkout_ui_mode IS DISTINCT FROM _checkout_ui_mode
     OR claimed.checkout_origin IS DISTINCT FROM _checkout_origin THEN
    RAISE EXCEPTION 'CHECKOUT_FINGERPRINT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT
    claimed.id,
    claimed.session_id,
    claimed.checkout_session_id,
    claimed.payment_method,
    claimed.currency,
    claimed.subtotal_amount,
    claimed.tax_amount,
    claimed.shipping_amount,
    claimed.total_amount,
    claimed.shipping_snapshot,
    claimed.items_snapshot,
    claimed.shipping_revision,
    claimed.checkout_request_version,
    claimed.checkout_request_fingerprint,
    claimed.checkout_ui_mode,
    claimed.checkout_origin,
    inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_checkout_session_to_draft(
  _draft_id uuid,
  _session_id text,
  _request_version smallint,
  _request_fingerprint text,
  _checkout_session_id text
)
RETURNS TABLE (
  checkout_session_id text,
  attached boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  stored_checkout_session_id text;
BEGIN
  IF _draft_id IS NULL
     OR _session_id IS NULL
     OR _request_version IS NULL
     OR _request_fingerprint IS NULL
     OR _checkout_session_id IS NULL
     OR pg_catalog.char_length(_checkout_session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_SESSION_ATTACHMENT'
      USING ERRCODE = '22023';
  END IF;

  SELECT d.checkout_session_id
  INTO stored_checkout_session_id
  FROM public.checkout_drafts AS d
  WHERE d.id = _draft_id
    AND d.session_id = _session_id
    AND d.checkout_request_version = _request_version
    AND d.checkout_request_fingerprint = _request_fingerprint
    AND d.status = 'created'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF stored_checkout_session_id IS NULL THEN
    UPDATE public.checkout_drafts AS d
    SET checkout_session_id = _checkout_session_id
    WHERE d.id = _draft_id;

    checkout_session_id := _checkout_session_id;
    attached := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF stored_checkout_session_id = _checkout_session_id THEN
    checkout_session_id := stored_checkout_session_id;
    attached := false;
    RETURN NEXT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.retire_expired_checkout_draft(
  _draft_id uuid,
  _session_id text,
  _checkout_session_id text,
  _request_version smallint DEFAULT NULL,
  _request_fingerprint text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  changed boolean;
BEGIN
  IF _draft_id IS NULL OR _session_id IS NULL OR _checkout_session_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_EXPIRED_DRAFT_RETIREMENT'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.checkout_drafts AS d
  SET status = 'failed'
  WHERE d.id = _draft_id
    AND d.session_id = _session_id
    AND d.checkout_session_id = _checkout_session_id
    AND d.status = 'created'
    AND d.checkout_request_version IS NOT DISTINCT FROM _request_version
    AND d.checkout_request_fingerprint IS NOT DISTINCT FROM _request_fingerprint;

  changed := FOUND;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_checkout_session_to_draft(
  uuid, text, smallint, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retire_expired_checkout_draft(
  uuid, text, text, smallint, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_checkout_session_to_draft(
  uuid, text, smallint, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.retire_expired_checkout_draft(
  uuid, text, text, smallint, text
) TO service_role;

COMMIT;
