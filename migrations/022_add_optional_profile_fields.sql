-- migrations/022_add_optional_profile_fields.sql
-- Add optional_name and optional_phone for user-controlled profile data (Data Minimization)
-- Ref: docs/specs/01_auth.md - Data Minimization

BEGIN;

-- Add optional_name and optional_phone columns to profiles table
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS optional_name text NULL,
ADD COLUMN IF NOT EXISTS optional_phone text NULL,
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Create RLS policy for authenticated users to manage their own optional profile data
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any to avoid conflict
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

-- Allow users to view, insert, update, and delete their own profile only
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own profile"
  ON profiles FOR DELETE
  USING (auth.uid() = user_id);

-- Create index on updated_at for query optimization
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles (updated_at);

COMMIT;

-- Notes:
-- 1. optional_name: User's full name saved at checkout (optional consent)
-- 2. optional_phone: User's phone number saved at checkout (optional consent)
-- 3. RLS policies ensure only the user can access their own profile data
-- 4. updated_at tracks when optional fields were last modified
