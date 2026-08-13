BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_evidence_unavailable_records (
  entry_id bigint PRIMARY KEY
    REFERENCES public.admin_finance_expenses(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (
    reason IN (
      'bank_history_expired',
      'not_issued',
      'paper_storage',
      'external_electronic_storage',
      'other'
    )
  ),
  note varchar(500) NULL CHECK (
    note IS NULL OR (
      note = btrim(note)
      AND char_length(note) BETWEEN 1 AND 500
    )
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT admin_finance_evidence_unavailable_note_required CHECK (
    reason NOT IN ('bank_history_expired', 'other')
    OR char_length(btrim(coalesce(note, ''))) BETWEEN 1 AND 500
  )
);

ALTER TABLE public.admin_finance_evidence_unavailable_records
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance evidence unavailable read"
  ON public.admin_finance_evidence_unavailable_records;
CREATE POLICY "admin finance evidence unavailable read"
  ON public.admin_finance_evidence_unavailable_records
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance evidence unavailable manage"
  ON public.admin_finance_evidence_unavailable_records;
CREATE POLICY "admin finance evidence unavailable manage"
  ON public.admin_finance_evidence_unavailable_records
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
