-- 057_contact_threads_and_messages.sql
-- Extend contact_inquiries into a conversation "thread header" and store the
-- individual messages (customer + admin, web + email) in contact_messages.
-- Access stays service-role only (RLS denies all direct access), matching 041.

-- 1) Thread header columns on contact_inquiries
ALTER TABLE public.contact_inquiries
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'answered', 'closed')),
  ADD COLUMN IF NOT EXISTS user_id uuid NULL,
  ADD COLUMN IF NOT EXISTS order_id uuid NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS contact_inquiries_status_idx
  ON public.contact_inquiries (status);

CREATE INDEX IF NOT EXISTS contact_inquiries_user_id_idx
  ON public.contact_inquiries (user_id);

CREATE INDEX IF NOT EXISTS contact_inquiries_last_message_at_idx
  ON public.contact_inquiries (last_message_at DESC);

-- 2) Conversation messages
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES public.contact_inquiries(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('user', 'admin')),
  author_id uuid NULL,
  body text NOT NULL,
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'email')),
  inbound_provider_id text NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_messages_inquiry_created_idx
  ON public.contact_messages (inquiry_id, created_at);

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct select on contact_messages" ON public.contact_messages;
DROP POLICY IF EXISTS "Deny direct insert on contact_messages" ON public.contact_messages;
DROP POLICY IF EXISTS "Deny direct update on contact_messages" ON public.contact_messages;
DROP POLICY IF EXISTS "Deny direct delete on contact_messages" ON public.contact_messages;

CREATE POLICY "Deny direct select on contact_messages"
  ON public.contact_messages
  FOR SELECT
  USING (false);

CREATE POLICY "Deny direct insert on contact_messages"
  ON public.contact_messages
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Deny direct update on contact_messages"
  ON public.contact_messages
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_messages"
  ON public.contact_messages
  FOR DELETE
  USING (false);

COMMENT ON TABLE public.contact_messages IS 'Individual messages of a contact inquiry thread (customer and admin, web and email channels)';

-- 3) Backfill: seed the opening message for existing inquiries that predate the
-- thread model, so their chat view renders. Idempotent via NOT EXISTS.
INSERT INTO public.contact_messages (inquiry_id, sender_role, author_id, body, channel, created_at)
SELECT ci.id, 'user', ci.user_id, ci.message, 'web', ci.created_at
FROM public.contact_inquiries ci
WHERE NOT EXISTS (
  SELECT 1 FROM public.contact_messages cm WHERE cm.inquiry_id = ci.id
);
