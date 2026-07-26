-- ============================================================
-- 066: Expense入力テンプレート（勘定科目・摘要・金額・支払い方法・メモ）
--      全シーズン共通（グローバル）のマスタ
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_expense_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 160),
  amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
  payment_method text NOT NULL CHECK (char_length(payment_method) BETWEEN 1 AND 80),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 500),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trigger_admin_finance_expense_templates_updated_at ON public.admin_finance_expense_templates;
CREATE TRIGGER trigger_admin_finance_expense_templates_updated_at
  BEFORE UPDATE ON public.admin_finance_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_expense_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance expense templates read" ON public.admin_finance_expense_templates;
CREATE POLICY "admin finance expense templates read"
  ON public.admin_finance_expense_templates
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance expense templates manage" ON public.admin_finance_expense_templates;
CREATE POLICY "admin finance expense templates manage"
  ON public.admin_finance_expense_templates
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
