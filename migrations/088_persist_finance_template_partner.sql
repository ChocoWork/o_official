-- Keep a template's counterparty together with its other reusable entry fields.

BEGIN;

ALTER TABLE public.admin_finance_expense_templates
  ADD COLUMN IF NOT EXISTS partner text NOT NULL DEFAULT ''
  CHECK (char_length(partner) <= 160);

COMMIT;
