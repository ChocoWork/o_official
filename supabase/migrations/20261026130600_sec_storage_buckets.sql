-- Wave 2 / Task 8: the settings of the image buckets look-images and news-images live in a migration (R17.
-- SEC-LOOK-005, SEC-NEWS-003, ADR-0164).
--
-- Why: until now the buckets existed only through the local seed (supabase/seed.sql: id, name, public, no limits) and
-- through old migrations the CI no longer applies. A database built from migrations alone had no bucket, and the
-- production settings were never under version control. Both buckets are private, accept 5 MiB per object, and accept
-- JPEG / PNG / WebP / GIF only (the same limits the admin routes already enforce: allowedImageTypes, maxImageBytes).
--
-- Production already has both buckets, so the insert falls into ON CONFLICT (id) DO UPDATE and brings the three
-- settings in line. Objects that are already stored are left alone: an existing object over 5 MiB stays, and only new
-- uploads are refused (ADR-0164). No policy on storage.objects is created: anon / authenticated can do nothing with
-- the buckets, and reads and writes go through service_role and signed URLs only. The item-images bucket is out of scope
-- (R17 does not cover it) and is not touched.
--
-- BEFORE applying to production (read only, keep the result as the rollback values):
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('look-images', 'news-images');
--   select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects';
--     -- a policy that names either bucket stops this migration at the final assertion (intended)
--   select bucket_id, count(*), max((metadata->>'size')::bigint) from storage.objects
--     where bucket_id in ('look-images', 'news-images') group by bucket_id;   -- objects over 5242880 bytes stay as they are
--
-- ROLLBACK (Task 8): put back the two rows' values recorded before applying. To return to the local seed state:
--   UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id IN ('look-images', 'news-images');
-- (public stays false: a private bucket is never reverted to public by this migration's rollback.)
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('look-images', 'look-images', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('news-images', 'news-images', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- Self check: both buckets are private, 5242880 bytes, exactly the four image types, and no policy on
-- storage.objects names either bucket.
DO $sec_storage_buckets_assert$
DECLARE
  v_bucket text;
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY['look-images', 'news-images'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM storage.buckets b
      WHERE b.id = v_bucket
        AND b.public IS NOT TRUE
        AND b.file_size_limit = 5242880
        AND b.allowed_mime_types IS NOT NULL
        AND cardinality(b.allowed_mime_types) = 4
        AND b.allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
        AND b.allowed_mime_types <@ ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_storage_buckets: bucket settings ' || v_bucket;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policies p
      WHERE p.schemaname = 'storage'
        AND p.tablename = 'objects'
        AND (coalesce(p.qual, '') LIKE '%' || v_bucket || '%'
          OR coalesce(p.with_check, '') LIKE '%' || v_bucket || '%')
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_storage_buckets: storage.objects policy names ' || v_bucket;
    END IF;
  END LOOP;
END
$sec_storage_buckets_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
