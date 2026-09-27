-- orders の Data API 更新経路を閉じ、入金・返金の不変条件をDBでも強制する。
--
-- 【保留中・第2段階】第1段階のRPC利用アプリを本番確認した後、再度の明示承認を得て昇格する。

BEGIN;

REVOKE UPDATE ON TABLE public.orders FROM anon, authenticated;

DROP POLICY IF EXISTS "admin orders manage by permission update"
  ON public.orders;

CREATE OR REPLACE FUNCTION private.enforce_order_payment_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  required_restored_status public.order_status;
BEGIN
  -- 入金済み・発送済みの注文は、成功済み返金合計が注文総額に達する同一更新でだけ
  -- cancelled へ遷移できる。
  IF OLD.status IN ('paid', 'shipped')
     AND NEW.status = 'cancelled'::public.order_status
     AND NEW.refunded_amount < NEW.total_amount THEN
    RAISE EXCEPTION 'PAID_ORDER_REQUIRES_FULL_REFUND_BEFORE_CANCELLATION'
      USING ERRCODE = '23514';
  END IF;

  -- 全額返金で cancelled になった注文から成功済み返金が失われた場合は、
  -- 発送記録の有無に従って shipped / paid へ同じ更新で復元する。
  -- 未決済由来の既存 cancelled（OLD.refunded_amount < OLD.total_amount）は対象外。
  IF OLD.status = 'cancelled'::public.order_status
     AND OLD.refunded_amount >= OLD.total_amount
     AND NEW.refunded_amount < NEW.total_amount THEN
    required_restored_status := CASE
      WHEN NEW.shipped_at IS NOT NULL THEN 'shipped'::public.order_status
      ELSE 'paid'::public.order_status
    END;

    IF NEW.status = 'cancelled'::public.order_status THEN
      RAISE EXCEPTION 'FAILED_FULL_REFUND_CANNOT_REMAIN_CANCELLED'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status IS DISTINCT FROM required_restored_status THEN
      RAISE EXCEPTION 'FAILED_FULL_REFUND_REQUIRES_STATUS_RESTORATION'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_order_payment_invariants() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_order_payment_invariants ON public.orders;
CREATE TRIGGER enforce_order_payment_invariants
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_order_payment_invariants();

COMMIT;
