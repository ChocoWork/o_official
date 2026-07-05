-- 058_create_contact_reply_templates.sql
-- Admin-managed canned reply templates, selectable when replying to an inquiry.
-- Access stays service-role only (RLS denies all direct access).

CREATE TABLE IF NOT EXISTS public.contact_reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NULL CHECK (category IN ('product', 'order', 'other', 'general')),
  body text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_reply_templates_category_idx
  ON public.contact_reply_templates (category);

CREATE INDEX IF NOT EXISTS contact_reply_templates_sort_order_idx
  ON public.contact_reply_templates (sort_order);

ALTER TABLE public.contact_reply_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct select on contact_reply_templates" ON public.contact_reply_templates;
DROP POLICY IF EXISTS "Deny direct insert on contact_reply_templates" ON public.contact_reply_templates;
DROP POLICY IF EXISTS "Deny direct update on contact_reply_templates" ON public.contact_reply_templates;
DROP POLICY IF EXISTS "Deny direct delete on contact_reply_templates" ON public.contact_reply_templates;

CREATE POLICY "Deny direct select on contact_reply_templates"
  ON public.contact_reply_templates
  FOR SELECT
  USING (false);

CREATE POLICY "Deny direct insert on contact_reply_templates"
  ON public.contact_reply_templates
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Deny direct update on contact_reply_templates"
  ON public.contact_reply_templates
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_reply_templates"
  ON public.contact_reply_templates
  FOR DELETE
  USING (false);

-- Seed a couple of default templates.
INSERT INTO public.contact_reply_templates (title, category, body, sort_order)
VALUES
  (
    'お問い合わせ御礼（汎用）',
    'general',
    E'お問い合わせいただきありがとうございます。\n\n内容を確認のうえ、担当者より改めてご連絡いたします。\nしばらくお待ちくださいますようお願い申し上げます。\n\nLe Fil des Heures',
    10
  ),
  (
    'ご注文状況のご案内',
    'order',
    E'お問い合わせいただきありがとうございます。\n\nご注文状況について確認いたしました。\n\n（ここに状況を記載）\n\nご不明な点がございましたら、本メールにご返信ください。\n\nLe Fil des Heures',
    20
  )
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.contact_reply_templates IS 'Admin-managed canned reply templates for contact inquiries';
