-- orders の Data API 更新経路を閉じ、入金・返金の不変条件をDBでも強制する。
--
-- 【保留中・第2段階】第1段階のRPC利用アプリを本番確認した後、再度の明示承認を得て昇格する。

BEGIN;

REVOKE UPDATE ON TABLE public.orders FROM anon, authenticated;

DROP POLICY IF EXISTS "admin orders manage by permission update"
  ON public.orders;

-- 注文と明細は RPC だけで作り・変える（R-04 の不足分。グループ A 設計書 4-7）
REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.order_items FROM anon, authenticated;

DROP POLICY IF EXISTS "admin orders manage by permission insert" ON public.orders;
DROP POLICY IF EXISTS "admin orders manage by permission delete" ON public.orders;
DROP POLICY IF EXISTS "admin order items manage by permission insert" ON public.order_items;
DROP POLICY IF EXISTS "admin order items manage by permission update" ON public.order_items;
DROP POLICY IF EXISTS "admin order items manage by permission delete" ON public.order_items;

CREATE OR REPLACE FUNCTION private.enforce_order_payment_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  required_restored_status public.order_status;
BEGIN
  -- 状態の変更は RPC だけが行う。RPC は必ず変更理由を設定する（R-04。設計書 4-7）
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NULLIF(pg_catalog.current_setting('app.order_change_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'ORDER_STATUS_CHANGE_REQUIRES_REASON'
      USING ERRCODE = '23514';
  END IF;

  -- 設計書 4-1 の表に無い遷移は拒否する（取消の注文の復元は、全額返金の失敗で入金済み・発送済みへ戻すため。
  -- 発送済みから入金済みへは、発送の取消で未発送の品が戻った時だけ。グループ E-1 設計書 7-3）
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'payment_in_progress' AND NEW.status IN ('paid', 'pending', 'failed', 'abandoned', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
    OR (OLD.status = 'failed' AND NEW.status IN ('paid', 'cancelled'))
    OR (OLD.status = 'paid' AND NEW.status IN ('shipped', 'cancelled'))
    OR (OLD.status = 'shipped' AND NEW.status = 'cancelled')
    OR (OLD.status = 'shipped' AND NEW.status = 'paid'
        AND pg_catalog.current_setting('app.order_change_reason', true) = 'admin_cancel_fulfillment')
    OR (OLD.status = 'cancelled' AND NEW.status IN ('paid', 'shipped'))
  ) THEN
    RAISE EXCEPTION 'ORDER_STATUS_TRANSITION_NOT_ALLOWED:%->%', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

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
