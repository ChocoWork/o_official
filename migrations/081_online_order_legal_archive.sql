-- ============================================================
-- 081: Online orders as immutable electronic transaction evidence
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- Append-only history for the operational fields that may change after an
-- order is finalized. Transaction snapshots themselves are protected below.
CREATE TABLE IF NOT EXISTS public.order_revisions (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  operation text NOT NULL
    CHECK (operation IN ('status_update', 'refund_update', 'operational_update')),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  changed_fields text[] NOT NULL CHECK (cardinality(changed_fields) > 0),
  changed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  source_event_id text NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_revisions_order_changed_at
  ON public.order_revisions(order_id, changed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_order_revisions_changed_at
  ON public.order_revisions(changed_at DESC, id DESC);

ALTER TABLE public.order_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_revisions FROM anon, authenticated;
GRANT SELECT ON public.order_revisions TO authenticated;
GRANT ALL ON public.order_revisions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.order_revisions_id_seq TO service_role;

DROP POLICY IF EXISTS "order revisions read by finance permission"
  ON public.order_revisions;
CREATE POLICY "order revisions read by finance permission"
  ON public.order_revisions
  FOR SELECT
  TO authenticated
  USING ((SELECT public.has_permission('admin.finance.read')));

-- One row per scheduled archive date and kind. Detailed artifact metadata is
-- kept in the signed manifest; this table only powers health and audit views.
CREATE TABLE IF NOT EXISTS public.legal_archive_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_date date NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  run_kind text NOT NULL CHECK (run_kind IN ('daily', 'annual', 'restore_check')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  storage_targets text[] NOT NULL DEFAULT '{}',
  manifest_path text NULL,
  manifest_sha256 text NULL
    CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  UNIQUE (archive_date, run_kind)
);

CREATE INDEX IF NOT EXISTS idx_legal_archive_runs_latest
  ON public.legal_archive_runs(fiscal_year, run_kind, completed_at DESC)
  WHERE status = 'completed';

ALTER TABLE public.legal_archive_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legal_archive_runs FROM anon, authenticated;
GRANT SELECT ON public.legal_archive_runs TO authenticated;
GRANT ALL ON public.legal_archive_runs TO service_role;

DROP POLICY IF EXISTS "legal archive runs read by finance permission"
  ON public.legal_archive_runs;
CREATE POLICY "legal archive runs read by finance permission"
  ON public.legal_archive_runs
  FOR SELECT
  TO authenticated
  USING ((SELECT public.has_permission('admin.finance.read')));

CREATE OR REPLACE FUNCTION private.protect_legal_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'legal order records cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'legal order records cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.session_id,
    OLD.checkout_session_id,
    OLD.user_id,
    OLD.payment_intent_id,
    OLD.subtotal_amount,
    OLD.shipping_amount,
    OLD.discount_amount,
    OLD.total_amount,
    OLD.currency,
    OLD.shipping_email,
    OLD.shipping_full_name,
    OLD.shipping_postal_code,
    OLD.shipping_prefecture,
    OLD.shipping_city,
    OLD.shipping_address,
    OLD.shipping_building,
    OLD.shipping_phone,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.session_id,
    NEW.checkout_session_id,
    NEW.user_id,
    NEW.payment_intent_id,
    NEW.subtotal_amount,
    NEW.shipping_amount,
    NEW.discount_amount,
    NEW.total_amount,
    NEW.currency,
    NEW.shipping_email,
    NEW.shipping_full_name,
    NEW.shipping_postal_code,
    NEW.shipping_prefecture,
    NEW.shipping_city,
    NEW.shipping_address,
    NEW.shipping_building,
    NEW.shipping_phone,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_item_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'immutable legal order item fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_order_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed text[];
  revision_operation text;
  revision_reason text;
  revision_source_event_id text;
BEGIN
  SELECT COALESCE(array_agg(key ORDER BY key), '{}')
  INTO changed
  FROM jsonb_each(to_jsonb(NEW)) AS new_value(key, value)
  WHERE value IS DISTINCT FROM (to_jsonb(OLD) -> key);

  IF cardinality(changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF changed && ARRAY['refunded_amount', 'refunded_at'] THEN
    revision_operation := 'refund_update';
  ELSIF changed && ARRAY['status'] THEN
    revision_operation := 'status_update';
  ELSE
    revision_operation := 'operational_update';
  END IF;

  revision_reason := NULLIF(
    current_setting('app.order_change_reason', true),
    ''
  );
  revision_source_event_id := NULLIF(
    current_setting('app.order_source_event_id', true),
    ''
  );

  INSERT INTO public.order_revisions (
    order_id,
    operation,
    before_data,
    after_data,
    changed_fields,
    changed_by,
    reason,
    source_event_id
  ) VALUES (
    NEW.id,
    revision_operation,
    to_jsonb(OLD),
    to_jsonb(NEW),
    changed,
    auth.uid(),
    revision_reason,
    revision_source_event_id
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.protect_legal_order_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_legal_order_item_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_legal_order_immutable_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_legal_order_item_immutable_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.record_order_revision() FROM PUBLIC;

DROP TRIGGER IF EXISTS protect_legal_order_delete ON public.orders;
CREATE TRIGGER protect_legal_order_delete
  BEFORE DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.protect_legal_order_delete();

DROP TRIGGER IF EXISTS protect_legal_order_immutable_fields ON public.orders;
CREATE TRIGGER protect_legal_order_immutable_fields
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.protect_legal_order_immutable_fields();

DROP TRIGGER IF EXISTS record_order_revision ON public.orders;
CREATE TRIGGER record_order_revision
  AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.record_order_revision();

DROP TRIGGER IF EXISTS protect_legal_order_item_delete ON public.order_items;
CREATE TRIGGER protect_legal_order_item_delete
  BEFORE DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION private.protect_legal_order_item_delete();

DROP TRIGGER IF EXISTS protect_legal_order_item_immutable_fields
  ON public.order_items;
CREATE TRIGGER protect_legal_order_item_immutable_fields
  BEFORE UPDATE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_legal_order_item_immutable_fields();

-- No storage.objects policies are created. Archive objects are written and
-- read only by trusted service-role clients, which bypass Storage RLS.
INSERT INTO storage.buckets (id, name, public)
VALUES ('legal-archive', 'legal-archive', false)
ON CONFLICT (id) DO UPDATE SET public = false;

COMMIT;
