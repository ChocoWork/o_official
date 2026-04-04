-- ============================================================
-- 029: Drop stockists home feature and display order columns
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_stockists_featured_home;
DROP INDEX IF EXISTS public.idx_stockists_display_order;

ALTER TABLE public.stockists
  DROP COLUMN IF EXISTS is_featured_home,
  DROP COLUMN IF EXISTS display_order;

COMMIT;
