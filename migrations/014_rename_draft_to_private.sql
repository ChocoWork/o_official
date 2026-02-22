-- migrations/014_rename_draft_to_private.sql
-- Rename status 'draft' to 'private' in news_articles

BEGIN;

-- Drop old constraint first
ALTER TABLE public.news_articles DROP CONSTRAINT IF EXISTS news_articles_status_check;

-- Update existing 'draft' values to 'private'
UPDATE public.news_articles SET status = 'private' WHERE status = 'draft';

-- Add new constraint with 'private' and 'published'
ALTER TABLE public.news_articles ADD CONSTRAINT news_articles_status_check CHECK (status IN ('private', 'published'));

COMMIT;
