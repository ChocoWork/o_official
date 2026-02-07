-- migrations/003_profiles_trigger.sql
-- Create trigger to automatically provision a public.profiles row when a new auth.users is created

-- Function: create_profile_for_new_auth_user
CREATE OR REPLACE FUNCTION public.create_profile_for_new_auth_user()
RETURNS trigger AS $$
BEGIN
  -- Ensure profiles table exists and insert a row if not present.
  INSERT INTO public.profiles(user_id, created_at)
  VALUES (NEW.id, now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant minimal execution permission to auth.role if needed (optional)
-- GRANT EXECUTE ON FUNCTION public.create_profile_for_new_auth_user() TO authenticated;

-- Trigger: after insert on auth.users
DROP TRIGGER IF EXISTS tr_create_profile_on_auth_user_insert ON auth.users;
CREATE TRIGGER tr_create_profile_on_auth_user_insert
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE PROCEDURE public.create_profile_for_new_auth_user();

-- Note: run in a maintenance window on production. This trigger will create a blank profile
-- (only user_id and created_at) for each newly created auth.users row if none exists.
-- Application logic may subsequently fill in display_name, phone, address, etc.
