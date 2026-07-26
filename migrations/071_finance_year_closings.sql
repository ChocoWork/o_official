-- ============================================================
-- 071: 決算処理（年度締め）
--
-- 期末残高をスナップショットとして保存し、翌年度の期首残高として使う。
-- スナップショットを持つ理由:
--   1. 確定申告を提出した後に過去の取引を編集しても申告値が変わらない
--   2. 個人事業主の元入金振替（元入金 = 前年元入金 + 所得 + 事業主借 − 事業主貸）は
--      年度をまたぐ不可逆な変換なので、計算結果を記録する必要がある
--   3. 翌年期首BS = 当年期末BS を構造的に保証できる
--
-- 期首棚卸高は入力させない（前年の期末棚卸高がそのまま期首になる）。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_year_closings (
  fiscal_year integer PRIMARY KEY
    REFERENCES public.admin_finance_years(fiscal_year) ON DELETE CASCADE,
  -- 決算整理：実地棚卸の結果
  closing_inventory_goods bigint NOT NULL DEFAULT 0
    CHECK (closing_inventory_goods >= 0),
  closing_inventory_materials bigint NOT NULL DEFAULT 0
    CHECK (closing_inventory_materials >= 0),
  -- 決算整理：貸倒引当金繰入額
  allowance_for_doubtful bigint NOT NULL DEFAULT 0
    CHECK (allowance_for_doubtful >= 0),
  -- 期末残高スナップショット。{"科目コード": 金額} を normalSide 基準で保持する。
  -- closed_at が NULL の間は空（未確定）。
  closing_balances jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 締めた日時。NULL なら未確定で、取引の追加・修正が反映され続ける。
  closed_at timestamptz NULL,
  closed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trigger_admin_finance_year_closings_updated_at ON public.admin_finance_year_closings;
CREATE TRIGGER trigger_admin_finance_year_closings_updated_at
  BEFORE UPDATE ON public.admin_finance_year_closings
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_year_closings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance year closings read" ON public.admin_finance_year_closings;
CREATE POLICY "admin finance year closings read"
  ON public.admin_finance_year_closings
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance year closings manage" ON public.admin_finance_year_closings;
CREATE POLICY "admin finance year closings manage"
  ON public.admin_finance_year_closings
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
