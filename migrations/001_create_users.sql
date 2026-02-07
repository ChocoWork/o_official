-- DEPRECATED: migrations/001_create_users.sql
-- Previously created a `public.users` table. This project now uses `auth.users` as the
-- source-of-truth and `public.profiles` for application profile data.
-- Do NOT apply this migration. Left in the repository for historical/context purposes only.
-- If you need to remove the table from an environment, use an explicit DROP with backup:
--   CREATE TABLE public.users_backup AS TABLE public.users;
--   DROP TABLE IF EXISTS public.users;
-- The canonical migration to implement the chosen policy is `migrations/002_create_profiles.sql`.

-- (File intentionally deprecated.)
