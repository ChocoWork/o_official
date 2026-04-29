-- 041_create_contact_inquiries.sql
-- Store contact submissions separately from audit logs to minimize PII exposure in audit data.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.contact_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  email text NOT NULL,
  inquiry_type text NOT NULL CHECK (inquiry_type IN ('product', 'order', 'other')),
  subject text NOT NULL,
  message text NOT NULL,
  submitted_ip text NULL,
  user_agent text NULL
);

CREATE INDEX IF NOT EXISTS contact_inquiries_created_at_idx
  ON public.contact_inquiries (created_at DESC);

CREATE INDEX IF NOT EXISTS contact_inquiries_email_idx
  ON public.contact_inquiries (email);

ALTER TABLE public.contact_inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct select on contact_inquiries" ON public.contact_inquiries;
DROP POLICY IF EXISTS "Deny direct insert on contact_inquiries" ON public.contact_inquiries;
DROP POLICY IF EXISTS "Deny direct update on contact_inquiries" ON public.contact_inquiries;
DROP POLICY IF EXISTS "Deny direct delete on contact_inquiries" ON public.contact_inquiries;

CREATE POLICY "Deny direct select on contact_inquiries"
  ON public.contact_inquiries
  FOR SELECT
  USING (false);

CREATE POLICY "Deny direct insert on contact_inquiries"
  ON public.contact_inquiries
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Deny direct update on contact_inquiries"
  ON public.contact_inquiries
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_inquiries"
  ON public.contact_inquiries
  FOR DELETE
  USING (false);

COMMENT ON TABLE public.contact_inquiries IS 'Raw contact inquiry payload including message body and sender information';
