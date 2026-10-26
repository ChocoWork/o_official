-- Wave 2 / Task 2: stockists.type becomes optional (only the NOT NULL constraint goes).
--
-- Why: the admin create route never sends `type` (ADR-0256), but the column is
-- NOT NULL with no default, so every admin create fails with 23502.
-- Keep the column and its CHECK (FLAGSHIP STORE / STORE / SELECT SHOP); a NULL
-- type is allowed, an unknown value is still rejected (Q21).
--
-- Idempotent: relaxing an already-nullable column is a no-op, and the
-- block does nothing when the column does not exist.
--
-- ROLLBACK (Task 2):
--   UPDATE public.stockists SET type = 'STORE' WHERE type IS NULL;   -- fill rows created without a type first
--   ALTER TABLE public.stockists ALTER COLUMN type SET NOT NULL;
BEGIN;

DO $stockists_type_optional$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stockists' AND column_name = 'type'
  ) THEN
    ALTER TABLE public.stockists ALTER COLUMN type DROP NOT NULL;
  END IF;
END
$stockists_type_optional$;

-- Self check: when the column exists it is nullable and the CHECK is still there.
DO $stockists_type_optional_assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stockists' AND column_name = 'type'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stockists' AND column_name = 'type'
        AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'stockists_type_optional';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.stockists'::regclass
        AND conname = 'stockists_type_check'
        AND contype = 'c'
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'stockists_type_optional';
    END IF;
  END IF;
END
$stockists_type_optional_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
