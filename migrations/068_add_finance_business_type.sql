-- ============================================================
-- 068: Business type (sole proprietor / corporation) per season
-- 勘定科目の適用形態を絞り込むための事業形態。法人成りに備えて
-- シーズン単位で保持する。
-- ============================================================

BEGIN;

ALTER TABLE public.admin_finance_seasons
  ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT 'soleProprietor';

ALTER TABLE public.admin_finance_seasons
  DROP CONSTRAINT IF EXISTS admin_finance_seasons_business_type_check;

ALTER TABLE public.admin_finance_seasons
  ADD CONSTRAINT admin_finance_seasons_business_type_check
  CHECK (business_type IN ('soleProprietor', 'corporation'));

COMMIT;
