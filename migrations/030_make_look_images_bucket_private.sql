-- migrations/030_make_look_images_bucket_private.sql
-- Security hardening: make look-images bucket private so that
-- unpublished look images are not accessible via public URLs.
-- After this migration the application layer generates signed URLs
-- when serving look images (both admin and public views).

BEGIN;

UPDATE storage.buckets
SET public = false
WHERE id = 'look-images';

-- Service role already bypasses storage RLS.
-- Add an explicit policy so that future authenticated requests from the
-- server (using service role) can manage all objects in the bucket.
-- NOTE: The application uses createServiceRoleClient which bypasses RLS,
-- so this policy is documentation-level; service role access is implicit.

COMMIT;
