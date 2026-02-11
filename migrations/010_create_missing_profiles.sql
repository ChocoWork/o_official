-- 010_create_missing_profiles.sql
-- Purpose: Ensure every auth.user has a corresponding public.profiles row.
-- Non-destructive: inserts only for users without profiles.

BEGIN;

INSERT INTO public.profiles (user_id, display_name, kana_name, phone, address, created_at)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'display_name', NULL),
  NULL,
  NULL,
  '{}'::jsonb,
  now()
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.user_id = u.id
);

COMMIT;

-- NOTE:
-- This migration is intentionally non-destructive and idempotent.
-- If rollback is required, identify inserted rows by created_at range
-- or run a manual delete filtering by known defaults. Review before
-- applying in production.
