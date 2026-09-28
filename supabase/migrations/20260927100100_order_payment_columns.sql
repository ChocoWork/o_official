-- 受付を先にする方式の列と制約（グループ A 設計書 4-2）。

BEGIN;

-- PaymentIntent は Session の支払いの確定時にできる（Stripe API 2022-08-01 以降）ので、受付の時点では空。
ALTER TABLE public.orders ALTER COLUMN payment_intent_id DROP NOT NULL;

-- 照合は Session ID で注文を引く。UNIQUE は NULL どうしを区別するので、空は何件でもよい。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'orders_checkout_session_id_key'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_checkout_session_id_key UNIQUE (checkout_session_id);
  END IF;
END
$$;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS review_reason text
    CONSTRAINT orders_review_reason_check CHECK (review_reason IN ('stock_not_reserved')),
  ADD COLUMN IF NOT EXISTS review_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text
    CONSTRAINT orders_cancel_reason_check
    CHECK (cancel_reason IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')),
  ADD COLUMN IF NOT EXISTS cancel_note text
    CONSTRAINT orders_cancel_note_length_check CHECK (pg_catalog.char_length(cancel_note) <= 500),
  ADD COLUMN IF NOT EXISTS cancel_notify_customer boolean,
  ADD COLUMN IF NOT EXISTS checkout_session_created_at timestamptz;

COMMENT ON COLUMN public.orders.checkout_session_created_at IS
  'Stripe の Checkout Session を作った時刻。見回りが「開いてから30分を超えたか」を判定する（設計書 2-2）';

-- 法定の不変条件。PaymentIntent は空から値へ1回だけ書ける。それ以外の項目は今までどおり変えられない。
CREATE OR REPLACE FUNCTION private.protect_legal_order_immutable_fields()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  IF OLD.payment_intent_id IS NOT NULL
     AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(
    OLD.id,
    OLD.session_id,
    OLD.checkout_session_id,
    OLD.subtotal_amount,
    OLD.shipping_amount,
    OLD.discount_amount,
    OLD.total_amount,
    OLD.currency,
    OLD.shipping_email,
    OLD.shipping_full_name,
    OLD.shipping_postal_code,
    OLD.shipping_prefecture,
    OLD.shipping_city,
    OLD.shipping_address,
    OLD.shipping_building,
    OLD.shipping_phone,
    OLD.shipping_kana,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.session_id,
    NEW.checkout_session_id,
    NEW.subtotal_amount,
    NEW.shipping_amount,
    NEW.discount_amount,
    NEW.total_amount,
    NEW.currency,
    NEW.shipping_email,
    NEW.shipping_full_name,
    NEW.shipping_postal_code,
    NEW.shipping_prefecture,
    NEW.shipping_city,
    NEW.shipping_address,
    NEW.shipping_building,
    NEW.shipping_phone,
    NEW.shipping_kana,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
