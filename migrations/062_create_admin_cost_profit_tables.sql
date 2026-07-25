-- ============================================================
-- 062: Cost & Profit accounting data for the admin dashboard
-- ============================================================

BEGIN;

-- Finance permissions are admin-only.
INSERT INTO public.permissions(code, name)
VALUES
  ('admin.finance.read', 'Read finance and accounting data'),
  ('admin.finance.manage', 'Manage finance and accounting data')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.finance.read', 'admin.finance.manage')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.admin_finance_seasons (
  season_key text PRIMARY KEY CHECK (season_key ~ '^[0-9]{4}(SS|AW)$'),
  sales_revenue bigint NOT NULL DEFAULT 0 CHECK (sales_revenue >= 0),
  opening_cash bigint NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  accounts_receivable bigint NOT NULL DEFAULT 0 CHECK (accounts_receivable >= 0),
  fixed_assets bigint NOT NULL DEFAULT 0 CHECK (fixed_assets >= 0),
  accounts_payable bigint NOT NULL DEFAULT 0 CHECK (accounts_payable >= 0),
  opening_capital bigint NOT NULL DEFAULT 0 CHECK (opening_capital >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_finance_expenses (
  id bigserial PRIMARY KEY,
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE CASCADE,
  expense_date date NOT NULL,
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 160),
  amount bigint NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (char_length(payment_method) BETWEEN 1 AND 80),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 500),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_season_date
  ON public.admin_finance_expenses(season_key, expense_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.admin_product_costs (
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE CASCADE,
  sku text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  production_method text NOT NULL CHECK (char_length(production_method) BETWEEN 1 AND 80),
  planned_quantity integer NOT NULL DEFAULT 0 CHECK (planned_quantity >= 0),
  selling_price bigint NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  material_cost bigint NOT NULL DEFAULT 0 CHECK (material_cost >= 0),
  sewing_cost bigint NOT NULL DEFAULT 0 CHECK (sewing_cost >= 0),
  pattern_cost bigint NOT NULL DEFAULT 0 CHECK (pattern_cost >= 0),
  accessories_cost bigint NOT NULL DEFAULT 0 CHECK (accessories_cost >= 0),
  processing_cost bigint NOT NULL DEFAULT 0 CHECK (processing_cost >= 0),
  finishing_cost bigint NOT NULL DEFAULT 0 CHECK (finishing_cost >= 0),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_key, sku)
);

CREATE INDEX IF NOT EXISTS idx_admin_product_costs_season
  ON public.admin_product_costs(season_key);

CREATE OR REPLACE FUNCTION public.update_admin_finance_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_admin_finance_seasons_updated_at ON public.admin_finance_seasons;
CREATE TRIGGER trigger_admin_finance_seasons_updated_at
  BEFORE UPDATE ON public.admin_finance_seasons
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

DROP TRIGGER IF EXISTS trigger_admin_finance_expenses_updated_at ON public.admin_finance_expenses;
CREATE TRIGGER trigger_admin_finance_expenses_updated_at
  BEFORE UPDATE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

DROP TRIGGER IF EXISTS trigger_admin_product_costs_updated_at ON public.admin_product_costs;
CREATE TRIGGER trigger_admin_product_costs_updated_at
  BEFORE UPDATE ON public.admin_product_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_finance_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_product_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance seasons read" ON public.admin_finance_seasons;
CREATE POLICY "admin finance seasons read"
  ON public.admin_finance_seasons
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance seasons manage" ON public.admin_finance_seasons;
CREATE POLICY "admin finance seasons manage"
  ON public.admin_finance_seasons
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

DROP POLICY IF EXISTS "admin finance expenses read" ON public.admin_finance_expenses;
CREATE POLICY "admin finance expenses read"
  ON public.admin_finance_expenses
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance expenses manage" ON public.admin_finance_expenses;
CREATE POLICY "admin finance expenses manage"
  ON public.admin_finance_expenses
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

DROP POLICY IF EXISTS "admin product costs read" ON public.admin_product_costs;
CREATE POLICY "admin product costs read"
  ON public.admin_product_costs
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin product costs manage" ON public.admin_product_costs;
CREATE POLICY "admin product costs manage"
  ON public.admin_product_costs
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

-- Initial 2026 S/S planning data currently shown in the dashboard.
INSERT INTO public.admin_finance_seasons (
  season_key,
  sales_revenue,
  opening_cash,
  accounts_receivable,
  fixed_assets,
  accounts_payable,
  opening_capital
)
VALUES ('2026SS', 3240000, 420000, 324000, 260000, 430000, 1091000)
ON CONFLICT (season_key) DO NOTHING;

INSERT INTO public.admin_product_costs (
  season_key,
  sku,
  name,
  category,
  production_method,
  planned_quantity,
  selling_price,
  material_cost,
  sewing_cost,
  pattern_cost,
  accessories_cost,
  processing_cost,
  finishing_cost
)
VALUES
  ('2026SS', 'LFDH-SS26-T001', 'ドローストリングシャツ', 'トップス', '国内縫製', 60, 24800, 3200, 3000, 500, 800, 600, 900),
  ('2026SS', 'LFDH-SS26-P001', 'ワイドテーパードパンツ', 'ボトムス', '国内縫製', 65, 34800, 3800, 3900, 540, 720, 650, 698)
ON CONFLICT (season_key, sku) DO NOTHING;

INSERT INTO public.admin_finance_expenses (
  season_key,
  expense_date,
  category,
  item_name,
  amount,
  payment_method,
  memo
)
SELECT seed.season_key, seed.expense_date, seed.category, seed.item_name, seed.amount, seed.payment_method, seed.memo
FROM (
  VALUES
    ('2026SS', DATE '2026-05-24', '販売費・マーケティング', 'Instagram広告費', 32000::bigint, 'クレジットカード', 'S/S 広告運用'),
    ('2026SS', DATE '2026-05-23', '材料費', 'サンプル生地費', 15400::bigint, '銀行振込', '生地サンプル代'),
    ('2026SS', DATE '2026-05-22', '外注費', '撮影費', 28600::bigint, '銀行振込', 'LOOK撮影'),
    ('2026SS', DATE '2026-05-21', '外注費', '外注パターン作成費', 22000::bigint, 'クレジットカード', 'パターン制作'),
    ('2026SS', DATE '2026-05-20', '荷造運賃', '梱包資材費', 8250::bigint, 'クレジットカード', '発送用資材'),
    ('2026SS', DATE '2026-05-18', '通信費', 'オンラインストレージ', 1980::bigint, 'クレジットカード', 'クラウド利用料'),
    ('2026SS', DATE '2026-05-15', '消耗品費', 'プリンター用紙・インク', 2750::bigint, 'クレジットカード', '事務用品'),
    ('2026SS', DATE '2026-05-14', '旅費交通費', '打ち合わせ交通費', 3420::bigint, '交通系IC', '都内打ち合わせ'),
    ('2026SS', DATE '2026-05-10', '水道光熱費', '電気代（自宅兼事務所）', 6180::bigint, '口座振替', '家事按分後'),
    ('2026SS', DATE '2026-05-05', '諸会費', '会計ソフト利用料', 1100::bigint, 'クレジットカード', '月額利用料'),
    ('2026SS', DATE '2026-04-28', '販売費・マーケティング', 'シーズン広告制作', 198000::bigint, '銀行振込', 'キービジュアル制作'),
    ('2026SS', DATE '2026-04-16', '人件費', '制作アシスタント', 160000::bigint, '銀行振込', '4月分'),
    ('2026SS', DATE '2026-04-03', '地代家賃', 'アトリエ賃料', 110000::bigint, '口座振替', '4月分'),
    ('2026SS', DATE '2026-03-29', 'その他経費', '展示会関連費', 60620::bigint, 'クレジットカード', '合同展示会')
) AS seed(season_key, expense_date, category, item_name, amount, payment_method, memo)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.admin_finance_expenses existing
  WHERE existing.season_key = seed.season_key
    AND existing.expense_date = seed.expense_date
    AND existing.item_name = seed.item_name
    AND existing.amount = seed.amount
);

COMMIT;
