BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_summary_options (
  id bigserial PRIMARY KEY,
  entry_type text NOT NULL CHECK (entry_type IN ('expense', 'income')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160 AND name = btrim(name)),
  normalized_name text NOT NULL CHECK (
    char_length(normalized_name) BETWEEN 1 AND 160
    AND normalized_name = lower(btrim(name))
  ),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_type, normalized_name)
);

ALTER TABLE public.admin_finance_summary_options ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY に IF NOT EXISTS は無いので、migration 072/082 と同じく
-- DROP してから足して再実行可能にする。
DROP POLICY IF EXISTS "admin finance summary options read"
  ON public.admin_finance_summary_options;
CREATE POLICY "admin finance summary options read" ON public.admin_finance_summary_options
  FOR SELECT TO authenticated USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance summary options manage"
  ON public.admin_finance_summary_options;
CREATE POLICY "admin finance summary options manage" ON public.admin_finance_summary_options
  FOR ALL TO authenticated USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
