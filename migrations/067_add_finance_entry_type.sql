-- ============================================================
-- 067: 収支区分（支出/収入）を finance entries とテンプレートに追加
--      既存行は 'expense'（支出）として扱う
-- ============================================================

BEGIN;

ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'expense'
  CHECK (entry_type IN ('expense', 'income'));

ALTER TABLE public.admin_finance_expense_templates
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'expense'
  CHECK (entry_type IN ('expense', 'income'));

CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_season_type_date
  ON public.admin_finance_expenses(season_key, entry_type, expense_date DESC, id DESC);

COMMIT;
