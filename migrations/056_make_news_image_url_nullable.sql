-- migrations/056_make_news_image_url_nullable.sql
-- News articles no longer require an image. Drop the NOT NULL constraint on image_url
-- so articles can be created and updated without uploading an image.

BEGIN;

ALTER TABLE public.news_articles
  ALTER COLUMN image_url DROP NOT NULL;

COMMIT;
