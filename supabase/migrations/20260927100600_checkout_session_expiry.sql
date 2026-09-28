-- 決済画面の期限（グループ A 設計書 2-2、R-25）。
--
-- 規則は「開いてから30分ちょうどまで有効、30分を超えたら失効」。Stripe は30分未満の expires_at を
-- 受け付けないので、通信の遅れと時計のずれで下限を割らないよう30秒足して、作成から30分30秒後にする。
-- Stripe の冪等キーは同じパラメータでしか再利用できない。失効時刻は下書きに1回だけ決めて保存し、
-- キーに含める。15秒以内の再送は同じ値（同じキー）になり、Stripe は同じ Session を返す。

BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS checkout_session_expires_at timestamptz;

COMMENT ON COLUMN public.checkout_drafts.checkout_session_expires_at IS
  'Stripe の Checkout Session に渡した expires_at（設計書 2-2）';

CREATE OR REPLACE FUNCTION public.reserve_checkout_session_expiry(_draft_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  reserved timestamptz;
BEGIN
  UPDATE public.checkout_drafts AS d
  SET checkout_session_expires_at = CASE
    WHEN d.checkout_session_expires_at > pg_catalog.now() + interval '30 minutes 15 seconds'
      THEN d.checkout_session_expires_at
    ELSE pg_catalog.date_trunc('second', pg_catalog.now() + interval '30 minutes 30 seconds')
  END
  WHERE d.id = _draft_id
    AND d.status = 'created'
    AND d.checkout_session_id IS NULL
  RETURNING d.checkout_session_expires_at INTO reserved;

  IF reserved IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_NOT_RESERVABLE' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.date_part('epoch', reserved)::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_checkout_session_expiry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_checkout_session_expiry(uuid) TO service_role;

COMMIT;
