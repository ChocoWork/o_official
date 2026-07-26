-- ============================================================
-- 070: 固定資産台帳（補助簿）
--
-- 減価償却費は取得日と耐用年数から毎年算出するため、資産は年度に属さない。
-- 会計期間（fiscal_year）で切るのは減価償却費の「計上」だけ。
--
-- 償却方法（国税庁 No.2100 / No.2106）:
--   straightLine   定額法。個人事業主の法定償却方法。残存簿価1円まで
--   lumpSum3Year   一括償却資産（取得価額10万円以上20万円未満）。3年均等・月割なし
--   immediate      即時償却。10万円未満の少額資産、または青色申告者の
--                  中小企業者等の少額減価償却資産の特例（30万円未満・年300万円まで）
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_fixed_assets (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  -- 資産の勘定科目名（工具器具備品 / ソフトウェア 等）。accounts.ts の name と対応。
  account text NOT NULL CHECK (char_length(account) BETWEEN 1 AND 80),
  acquired_on date NOT NULL,
  acquisition_cost bigint NOT NULL CHECK (acquisition_cost > 0),
  useful_life integer NOT NULL CHECK (useful_life BETWEEN 1 AND 100),
  method text NOT NULL DEFAULT 'straightLine'
    CHECK (method IN ('straightLine', 'lumpSum3Year', 'immediate')),
  -- 事業専用割合（%）。自宅兼用の資産は家事按分してから必要経費に算入する。
  business_use_ratio integer NOT NULL DEFAULT 100
    CHECK (business_use_ratio BETWEEN 1 AND 100),
  -- 売却・除却した日。以後は償却しない。
  disposed_on date NULL,
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 500),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_finance_fixed_assets_disposal_after_acquisition
    CHECK (disposed_on IS NULL OR disposed_on >= acquired_on)
);

CREATE INDEX IF NOT EXISTS idx_admin_finance_fixed_assets_acquired
  ON public.admin_finance_fixed_assets(acquired_on);

DROP TRIGGER IF EXISTS trigger_admin_finance_fixed_assets_updated_at ON public.admin_finance_fixed_assets;
CREATE TRIGGER trigger_admin_finance_fixed_assets_updated_at
  BEFORE UPDATE ON public.admin_finance_fixed_assets
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_fixed_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance fixed assets read" ON public.admin_finance_fixed_assets;
CREATE POLICY "admin finance fixed assets read"
  ON public.admin_finance_fixed_assets
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance fixed assets manage" ON public.admin_finance_fixed_assets;
CREATE POLICY "admin finance fixed assets manage"
  ON public.admin_finance_fixed_assets
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
