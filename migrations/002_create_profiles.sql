-- migrations/002_create_profiles.sql
-- Create profiles table linked to auth.users and migrate existing public.users data

-- Conditional handling: only reference public.users if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    -- Create a backup table (schema-only) if public.users exists
    EXECUTE 'CREATE TABLE IF NOT EXISTS public.users_backup AS TABLE public.users WITH NO DATA';
  END IF;
END
$$;

BEGIN;

-- Create profiles table referencing auth.users(id)
CREATE TABLE IF NOT EXISTS profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NULL,
  kana_name text NULL,
  phone text NULL,
  address jsonb NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id);

-- Migrate data from public.users (if present). Only insert where matching auth.users id exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    EXECUTE $sql$
      INSERT INTO profiles(user_id, display_name, kana_name, phone, address, created_at)
      SELECT u.id, u.display_name, u.kana_name, u.phone, u.address, u.created_at
      FROM public.users u
      JOIN auth.users a ON a.id = u.id;
    $sql$;

    -- Rename public.users to indicate deprecated (keeps data for audit/rollback)
    EXECUTE 'ALTER TABLE IF EXISTS public.users RENAME TO users_deprecated';
  END IF;
END
$$;

COMMIT;

-- Notes:
-- 1) This migration assumes auth.users is the canonical user table managed by Supabase Auth.
-- 2) After running this migration, application code should read profile data from public.profiles
--    and user identity from auth.users. The `users_deprecated` table is kept for rollback/audit.
-- 3) Run in a maintenance window on production and verify counts between auth.users and profiles.
