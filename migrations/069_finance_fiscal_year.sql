-- ============================================================
-- 069: 取引・決算を暦年（1/1〜12/31）ベースへ移行
--
-- 個人事業主の課税期間は暦年固定であり、シーズン（YYYYSS / YYYYAW）の
-- A/W は 10月〜翌3月で暦年をまたぐため、シーズンは会計期間として使えない。
-- 会計期間は expense_date から導出する fiscal_year に一本化し、
-- season_key はコレクション別分析用の任意タグへ降格する。
-- シーズン軸は商品原価（admin_product_costs）専用として残す。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) 暦年マスタ。事業形態と期首残高は「年度」に属する（シーズンではない）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_finance_years (
  fiscal_year integer PRIMARY KEY CHECK (fiscal_year BETWEEN 2000 AND 2999),
  business_type text NOT NULL DEFAULT 'soleProprietor'
    CHECK (business_type IN ('soleProprietor', 'corporation')),
  sales_revenue bigint NOT NULL DEFAULT 0 CHECK (sales_revenue >= 0),
  opening_cash bigint NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  accounts_receivable bigint NOT NULL DEFAULT 0 CHECK (accounts_receivable >= 0),
  fixed_assets bigint NOT NULL DEFAULT 0 CHECK (fixed_assets >= 0),
  accounts_payable bigint NOT NULL DEFAULT 0 CHECK (accounts_payable >= 0),
  opening_capital bigint NOT NULL DEFAULT 0 CHECK (opening_capital >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trigger_admin_finance_years_updated_at ON public.admin_finance_years;
CREATE TRIGGER trigger_admin_finance_years_updated_at
  BEFORE UPDATE ON public.admin_finance_years
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_years ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance years read" ON public.admin_finance_years;
CREATE POLICY "admin finance years read"
  ON public.admin_finance_years
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance years manage" ON public.admin_finance_years;
CREATE POLICY "admin finance years manage"
  ON public.admin_finance_years
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

-- ------------------------------------------------------------
-- 2) 既存のシーズン別データを暦年へ集約
--    売上目標は年内シーズンの合計、期首残高・事業形態は年内で
--    最初のシーズン（S/S）の値を採用する。
-- ------------------------------------------------------------
INSERT INTO public.admin_finance_years (
  fiscal_year,
  business_type,
  sales_revenue,
  opening_cash,
  accounts_receivable,
  fixed_assets,
  accounts_payable,
  opening_capital
)
SELECT
  s.fiscal_year,
  (array_agg(s.business_type ORDER BY s.season_order))[1],
  SUM(s.sales_revenue),
  (array_agg(s.opening_cash ORDER BY s.season_order))[1],
  (array_agg(s.accounts_receivable ORDER BY s.season_order))[1],
  (array_agg(s.fixed_assets ORDER BY s.season_order))[1],
  (array_agg(s.accounts_payable ORDER BY s.season_order))[1],
  (array_agg(s.opening_capital ORDER BY s.season_order))[1]
FROM (
  SELECT
    LEFT(season_key, 4)::int AS fiscal_year,
    CASE WHEN RIGHT(season_key, 2) = 'SS' THEN 0 ELSE 1 END AS season_order,
    business_type,
    sales_revenue,
    opening_cash,
    accounts_receivable,
    fixed_assets,
    accounts_payable,
    opening_capital
  FROM public.admin_finance_seasons
) s
GROUP BY s.fiscal_year
ON CONFLICT (fiscal_year) DO NOTHING;

-- ------------------------------------------------------------
-- 3) 取引テーブルを暦年ベースへ
-- ------------------------------------------------------------

-- 会計期間は日付から自動導出する。手入力させないことで年度のドリフトを防ぐ。
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS fiscal_year integer
  GENERATED ALWAYS AS (EXTRACT(YEAR FROM expense_date)::int) STORED;

-- season_key はコレクション別分析用の任意タグへ降格（NULL 許容）。
ALTER TABLE public.admin_finance_expenses
  ALTER COLUMN season_key DROP NOT NULL;

ALTER TABLE public.admin_finance_expenses
  DROP CONSTRAINT IF EXISTS admin_finance_expenses_season_key_fkey;

ALTER TABLE public.admin_finance_expenses
  ADD CONSTRAINT admin_finance_expenses_season_key_fkey
  FOREIGN KEY (season_key) REFERENCES public.admin_finance_seasons(season_key)
  ON DELETE SET NULL;

COMMENT ON COLUMN public.admin_finance_expenses.season_key IS
  'コレクション別分析用の任意タグ。会計期間は fiscal_year（expense_date 由来）で決まる。';

CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_year_date
  ON public.admin_finance_expenses(fiscal_year, expense_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_year_type_date
  ON public.admin_finance_expenses(fiscal_year, entry_type, expense_date DESC, id DESC);

-- シーズン単位の旧インデックスは年度インデックスで置き換わるため削除。
DROP INDEX IF EXISTS public.idx_admin_finance_expenses_season_date;
DROP INDEX IF EXISTS public.idx_admin_finance_expenses_season_type_date;

-- タグとしての絞り込み用（NULL は除外）。
CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_season_tag
  ON public.admin_finance_expenses(season_key, expense_date DESC)
  WHERE season_key IS NOT NULL;

-- ------------------------------------------------------------
-- 4) admin_finance_seasons は商品原価のシーズン登録簿だけに戻す
--    （事業形態・期首残高は 2) で admin_finance_years へ移設済み）
-- ------------------------------------------------------------
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS business_type;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS sales_revenue;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS opening_cash;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS accounts_receivable;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS fixed_assets;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS accounts_payable;
ALTER TABLE public.admin_finance_seasons DROP COLUMN IF EXISTS opening_capital;

COMMENT ON TABLE public.admin_finance_seasons IS
  '商品原価（コレクション）のシーズン登録簿。会計期間は admin_finance_years が持つ。';

COMMIT;
