-- Migration: Add security fields to sessions for refresh rotation and CSRF
-- WARNING: This is a draft migration. Review & test before applying to production.

ALTER TABLE sessions
  ADD COLUMN previous_refresh_token_hash TEXT,
  ADD COLUMN quarantined BOOLEAN DEFAULT FALSE,
  ADD COLUMN csrf_token_hash TEXT,
  ADD COLUMN csrf_prev_token_hash TEXT;

-- Consider adding indices if you query by previous_refresh_token_hash frequently
CREATE INDEX IF NOT EXISTS sessions_previous_refresh_token_hash_idx ON sessions (previous_refresh_token_hash);

-- Add comments:
COMMENT ON COLUMN sessions.previous_refresh_token_hash IS 'Previous refresh token sha256 hash for rotation/replay detection';
COMMENT ON COLUMN sessions.quarantined IS 'If true, session is quarantined due to detected token replay or compromise';
COMMENT ON COLUMN sessions.csrf_token_hash IS 'Current csrf token sha256 hash used for double-submit verification';
COMMENT ON COLUMN sessions.csrf_prev_token_hash IS 'Previous csrf token hash (for rotation grace period)';
