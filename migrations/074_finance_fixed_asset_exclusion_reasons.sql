-- 固定資産候補を対象外と判断した根拠を監査可能な形で保持する。
BEGIN;

ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS fixed_asset_exempt_reason text NULL,
  ADD COLUMN IF NOT EXISTS fixed_asset_reviewed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS fixed_asset_reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.admin_finance_expenses
  DROP CONSTRAINT IF EXISTS admin_finance_expenses_asset_exempt_reason_required;

ALTER TABLE public.admin_finance_expenses
  ADD CONSTRAINT admin_finance_expenses_asset_exempt_reason_required
  CHECK (
    (fixed_asset_exempt = false AND fixed_asset_exempt_reason IS NULL)
    OR
    (fixed_asset_exempt = true AND length(btrim(fixed_asset_exempt_reason)) > 0)
  );

COMMENT ON COLUMN public.admin_finance_expenses.fixed_asset_exempt_reason IS
  '固定資産候補を対象外と判断した理由。fixed_asset_exempt=true の場合は必須。';
COMMENT ON COLUMN public.admin_finance_expenses.fixed_asset_reviewed_at IS
  '固定資産候補の対象外判定日時。';
COMMENT ON COLUMN public.admin_finance_expenses.fixed_asset_reviewed_by IS
  '固定資産候補の対象外判定者。';

-- 候補判定だけの更新は取引訂正履歴へ混ぜない。
CREATE OR REPLACE FUNCTION public.record_admin_finance_entry_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'insert', NULL, to_jsonb(NEW), NEW.created_by);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      actor := COALESCE(NEW.deleted_by, NEW.updated_by);
      INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
      VALUES (NEW.id, 'delete', to_jsonb(OLD), to_jsonb(NEW), actor);
      RETURN NEW;
    END IF;

    IF to_jsonb(OLD) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
         - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by'
       = to_jsonb(NEW) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
         - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by' THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW), NEW.updated_by);
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
  VALUES (OLD.id, 'delete', to_jsonb(OLD), NULL, OLD.updated_by);
  RETURN OLD;
END;
$$;

COMMIT;
