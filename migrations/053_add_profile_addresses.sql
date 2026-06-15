-- migrations/053_add_profile_addresses.sql
-- Add support for multiple shipping addresses per profile.
-- The existing single `address` jsonb column is kept as a mirror of the default
-- address for backward compatibility (checkout prefill, orders snapshot, /api/profile).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS addresses jsonb NULL;

-- Backfill: convert the existing single address into a one-element array marked default.
UPDATE profiles
SET addresses = jsonb_build_array(
  address || jsonb_build_object('id', gen_random_uuid()::text, 'isDefault', true)
)
WHERE address IS NOT NULL AND addresses IS NULL;
