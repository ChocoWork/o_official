-- 044: Harden item-images bucket to private
-- Public image delivery is handled via signed URLs in API responses.

BEGIN;

UPDATE storage.buckets
SET public = false
WHERE id = 'item-images';

COMMIT;
