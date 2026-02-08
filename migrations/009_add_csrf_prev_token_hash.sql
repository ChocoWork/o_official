-- 009_add_csrf_prev_token_hash.sql
-- Adds `csrf_prev_token_hash` to `public.sessions` to support CSRF token rotation.
-- Reversible: DROP COLUMN in rollback.

BEGIN;

-- Add previous CSRF token hash (hex SHA-256 expected, nullable)
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS csrf_prev_token_hash varchar(64);

-- Optional index to help lookup when needed
CREATE INDEX IF NOT EXISTS idx_sessions_csrf_prev_token_hash
  ON public.sessions (csrf_prev_token_hash);

COMMIT;

-- DOWN (rollback):
-- NOTE: Run only if you are sure there is no data dependency on this column.
-- ALTER TABLE public.sessions DROP COLUMN IF EXISTS csrf_prev_token_hash;
-- DROP INDEX IF EXISTS idx_sessions_csrf_prev_token_hash;
