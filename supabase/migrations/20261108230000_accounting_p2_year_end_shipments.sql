BEGIN;
-- Accounting plan 2 S14 (FREQ-574 AC-01..AC-04, design 6-d and 6-d2): the year-end shipment check list, the check mark of a slip, and
-- the carrier receipt-date check that a setting turns on. Reads and settings only: the group G tables (shipment_slips,
-- shipment_slip_fulfillments, order_fulfillment_events) are only read, and no group G / H / returns / refund object is changed.
--
-- Tables (public, owner postgres, RLS on and no policy, PUBLIC / anon / authenticated hold nothing, service_role can only SELECT):
--   accounting_shipment_checks: one check mark per slip AND per state of the slip that was checked: the key is (slip_id,
--     checked_shipment_date, checked_tracking_version), snapshotted from the slip when the mark is put (RESTRICT on the slip), so a slip
--     whose shipment date or tracking was corrected after the check can be marked again. Append only (UPDATE, DELETE
--     and TRUNCATE are refused for every role). request_key / request_hash make a retry of the same request return the same mark.
--   accounting_shipping_options: one row (id = 1), made here with the default (carrier_date_check_enabled false, version 1). The row
--     cannot be deleted or truncated; it changes only through admin_set_shipping_options. admin_requests keeps the request keys.
--
-- Functions (public.<name> calls private.<name>; SECURITY INVOKER entries for service_role only):
--   list_year_end_shipments(_from, _to, _limit 100, _after_date, _after_slip) -> {slips:[{slip_id, number, shipment_date, confirmed_at,
--     stage, shipping_carrier, tracking_number, checked_at, checked_by}], next_after_date, next_after_slip}: the confirmed and cancelled
--     slips whose shipment_date is in the range, by shipment_date then slip number; the range is at most 60 days (both ends in) and the
--     limit 1..200. checked_at / checked_by are of the latest mark of the slip; check_stale is true when that mark was put for another
--     shipment date or tracking version than the slip has now (false when there is no mark). The cursor is the last slip of the page (both halves or none). No customer name, mail address or address is read.
--   admin_check_year_end_shipment(_actor_id, _slip_id, _note, _request_key) -> {slip_id, checked_by, checked_at, note, created}: permission
--     admin.finance.manage (ACCOUNTING_FORBIDDEN / 42501) first. Puts the mark; a slip that is checked already returns the first mark as
--     it is (created false, 'it' = the mark for the present shipment date and tracking version of the slip); the same request key with other content is ACCOUNTING_REQUEST_KEY_CONFLICT; a slip that is not confirmed
--     or cancelled is ACCOUNTING_NOT_FOUND; the note is at most 200 characters (blank is no note).
--   get_shipping_options() -> {carrier_date_check_enabled, changed_at, changed_by, version}.
--   admin_set_shipping_options(_actor_id, _carrier_date_check_enabled, _expected_version, _request_key): permission
--     admin.accounting.settings.manage; a different version is ACCOUNTING_VERSION_CONFLICT; keeps the time and the person of the change.
--   list_carrier_date_gaps(_from, _to, _limit 100) -> {enabled, slips:[{slip_id, number, shipment_date, carrier_accepted_date,
--     gap_days}], has_more}: has_more is true when more slips than _limit are one day or more away; empty and enabled false while the option is off. When on: for each confirmed slip in the range, the day (Japan time) of
--     the first in_transit tracking event (source tracking, the slip's present tracking version) of the fulfillments of the slip is the
--     carrier accepted day; the slips that are one day or more away from shipment_date are listed (gap_days = accepted day - shipment
--     day). A slip with no such event is not listed. ASSUMPTION (unconfirmed item 3): in_transit is read as the carrier receipt; the
--     meaning of the tracking states is to be checked when the tracking runs for real (group E-4).
--
-- ROLLBACK (the check table has no row; the options table has the one default row): DROP FUNCTION public.list_carrier_date_gaps(date,date,integer),
--   public.admin_set_shipping_options(uuid,boolean,bigint,uuid), public.get_shipping_options(), public.admin_check_year_end_shipment(uuid,uuid,text,uuid),
--   public.list_year_end_shipments(date,date,integer,date,uuid), private.list_carrier_date_gaps(date,date,integer),
--   private.admin_set_shipping_options(uuid,boolean,bigint,uuid), private.get_shipping_options(),
--   private.admin_check_year_end_shipment(uuid,uuid,text,uuid), private.list_year_end_shipments(date,date,integer,date,uuid);
--   DROP TABLE public.accounting_shipping_options, public.accounting_shipment_checks;

-- ACC_S14_BODY_BEGIN
-- 0. The baseline the final assert compares with: this file writes no entry, line, parked row or period. A replay of the assert (tests)
--    pins the current state here first (pinAccountingS14Baseline).
CREATE TEMP TABLE accounting_s14_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s14_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods));

-- 1. The tables.
CREATE TABLE public.accounting_shipment_checks (
  slip_id uuid NOT NULL CONSTRAINT accounting_shipment_checks_slip_id_fkey REFERENCES public.shipment_slips (id) ON DELETE RESTRICT,
  checked_shipment_date date NOT NULL,
  checked_tracking_version integer NOT NULL,
  checked_by uuid NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  note text NULL CONSTRAINT accounting_shipment_checks_note_check CHECK (pg_catalog.char_length(note) <= 200),
  request_key uuid NOT NULL CONSTRAINT accounting_shipment_checks_request_key_key UNIQUE,
  request_hash text NOT NULL,
  CONSTRAINT accounting_shipment_checks_pkey PRIMARY KEY (slip_id, checked_shipment_date, checked_tracking_version)
);
CREATE TABLE public.accounting_shipping_options (
  id smallint NOT NULL CONSTRAINT accounting_shipping_options_pkey PRIMARY KEY
    CONSTRAINT accounting_shipping_options_id_check CHECK (id = 1),
  carrier_date_check_enabled boolean NOT NULL DEFAULT false,
  changed_at timestamptz NULL,
  changed_by uuid NULL,
  version bigint NOT NULL DEFAULT 1,
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT accounting_shipping_options_admin_requests_check CHECK (pg_catalog.jsonb_typeof(admin_requests) = 'object')
);
ALTER TABLE public.accounting_shipment_checks OWNER TO postgres;
ALTER TABLE public.accounting_shipping_options OWNER TO postgres;
ALTER TABLE public.accounting_shipment_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_shipping_options ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_shipment_checks, public.accounting_shipping_options FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_shipment_checks, public.accounting_shipping_options TO service_role;

-- 2. The one row of the options: the default (off, version 1). The only data this file writes.
INSERT INTO public.accounting_shipping_options (id) VALUES (1);

-- 3. Append only for the marks; the one row of the options cannot be deleted or emptied (ALWAYS: also under replica mode).
CREATE TRIGGER accounting_shipment_checks_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_shipment_checks
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_shipment_checks_no_truncate BEFORE TRUNCATE ON public.accounting_shipment_checks
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_shipping_options_no_delete BEFORE DELETE ON public.accounting_shipping_options
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_shipping_options_no_truncate BEFORE TRUNCATE ON public.accounting_shipping_options
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.accounting_shipment_checks ENABLE ALWAYS TRIGGER accounting_shipment_checks_no_update_delete;
ALTER TABLE public.accounting_shipment_checks ENABLE ALWAYS TRIGGER accounting_shipment_checks_no_truncate;
ALTER TABLE public.accounting_shipping_options ENABLE ALWAYS TRIGGER accounting_shipping_options_no_delete;
ALTER TABLE public.accounting_shipping_options ENABLE ALWAYS TRIGGER accounting_shipping_options_no_truncate;

-- 4. The year-end list. Reads the slips and the marks only; the customer columns of the slip are not read.
CREATE FUNCTION private.list_year_end_shipments(_from date, _to date, _limit integer, _after_date date, _after_slip uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cursor_number text;
  v_slips jsonb;
  v_next_date date;
  v_next_slip uuid;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _to < _from OR (_to - _from) > 59 OR _limit IS NULL OR _limit < 1 OR _limit > 200
    OR ((_after_date IS NULL) <> (_after_slip IS NULL)) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _after_slip IS NOT NULL THEN
    SELECT s.number INTO v_cursor_number
    FROM public.shipment_slips AS s
    WHERE s.id = _after_slip AND s.shipment_date = _after_date AND s.stage IN ('confirmed', 'cancelled');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  WITH page AS (
    SELECT s.id, s.number, s.shipment_date, s.confirmed_at, s.stage, s.shipping_carrier, s.tracking_number, c.checked_at, c.checked_by,
      (c.slip_id IS NOT NULL AND (c.checked_shipment_date <> s.shipment_date OR c.checked_tracking_version <> s.tracking_version)) AS check_stale,
      pg_catalog.row_number() OVER (ORDER BY s.shipment_date, s.number) AS rn
    FROM public.shipment_slips AS s
    LEFT JOIN LATERAL (SELECT k.slip_id, k.checked_shipment_date, k.checked_tracking_version, k.checked_at, k.checked_by
      FROM public.accounting_shipment_checks AS k WHERE k.slip_id = s.id
      ORDER BY k.checked_at DESC, k.checked_shipment_date DESC, k.checked_tracking_version DESC LIMIT 1) AS c ON true
    WHERE s.stage IN ('confirmed', 'cancelled') AND s.shipment_date BETWEEN _from AND _to
      AND (_after_slip IS NULL OR (s.shipment_date, s.number) > (_after_date, v_cursor_number))
    ORDER BY s.shipment_date, s.number
    LIMIT _limit + 1)
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'slip_id', p.id, 'number', p.number, 'shipment_date', pg_catalog.to_char(p.shipment_date, 'YYYY-MM-DD'),
      'confirmed_at', p.confirmed_at, 'stage', p.stage, 'shipping_carrier', p.shipping_carrier, 'tracking_number', p.tracking_number,
      'checked_at', p.checked_at, 'checked_by', p.checked_by, 'check_stale', p.check_stale) ORDER BY p.rn) FILTER (WHERE p.rn <= _limit), '[]'::jsonb),
    CASE WHEN pg_catalog.max(p.rn) > _limit THEN (pg_catalog.array_agg(p.shipment_date ORDER BY p.rn) FILTER (WHERE p.rn = _limit))[1] END,
    CASE WHEN pg_catalog.max(p.rn) > _limit THEN (pg_catalog.array_agg(p.id ORDER BY p.rn) FILTER (WHERE p.rn = _limit))[1] END
  INTO v_slips, v_next_date, v_next_slip
  FROM page AS p;
  RETURN pg_catalog.jsonb_build_object('slips', v_slips, 'next_after_date', pg_catalog.to_char(v_next_date, 'YYYY-MM-DD'),
    'next_after_slip', v_next_slip);
END;
$$;

-- 5. The check mark. The permission comes first; the mark is one per slip and state (shipment date, tracking version) of the slip
--    (ON CONFLICT DO NOTHING, then the first mark is read back).
CREATE FUNCTION private.admin_check_year_end_shipment(_actor_id uuid, _slip_id uuid, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_note text;
  v_hash text;
  v_row public.accounting_shipment_checks%ROWTYPE;
  v_date date;
  v_version integer;
  v_created boolean;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(_note), '');
  IF _slip_id IS NULL OR _request_key IS NULL OR pg_catalog.char_length(v_note) > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'check_year_end_shipment', 'actor', _actor_id,
    'slip_id', _slip_id, 'note', v_note));
  SELECT * INTO v_row FROM public.accounting_shipment_checks AS c WHERE c.request_key = _request_key;
  IF FOUND THEN
    IF v_row.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    v_created := false;
  ELSE
    -- The state of the slip that is checked now (the mark keeps it, so a later correction makes the mark stale).
    SELECT s.shipment_date, s.tracking_version INTO v_date, v_version
    FROM public.shipment_slips AS s WHERE s.id = _slip_id AND s.stage IN ('confirmed', 'cancelled');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_row FROM public.accounting_shipment_checks AS c
    WHERE c.slip_id = _slip_id AND c.checked_shipment_date = v_date AND c.checked_tracking_version = v_version;
    IF FOUND THEN
      v_created := false;
    ELSE
      INSERT INTO public.accounting_shipment_checks AS c (slip_id, checked_shipment_date, checked_tracking_version, checked_by,
        checked_at, note, request_key, request_hash)
      VALUES (_slip_id, v_date, v_version, _actor_id, pg_catalog.clock_timestamp(), v_note, _request_key, v_hash)
      ON CONFLICT DO NOTHING
      RETURNING c.* INTO v_row;
      IF FOUND THEN
        v_created := true;
      ELSE
        -- Somebody else marked the same state of the slip a moment ago (or used the same key for another slip).
        SELECT * INTO v_row FROM public.accounting_shipment_checks AS c
        WHERE c.slip_id = _slip_id AND c.checked_shipment_date = v_date AND c.checked_tracking_version = v_version;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
        END IF;
        v_created := false;
      END IF;
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('slip_id', v_row.slip_id, 'checked_by', v_row.checked_by, 'checked_at', v_row.checked_at,
    'note', v_row.note, 'checked_shipment_date', pg_catalog.to_char(v_row.checked_shipment_date, 'YYYY-MM-DD'),
    'checked_tracking_version', v_row.checked_tracking_version, 'created', v_created);
END;
$$;

-- 6. The options: the read and the writer.
CREATE FUNCTION private.get_shipping_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.accounting_shipping_options%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.accounting_shipping_options AS o WHERE o.id = 1;
  RETURN pg_catalog.jsonb_build_object('carrier_date_check_enabled', v_row.carrier_date_check_enabled, 'changed_at', v_row.changed_at,
    'changed_by', v_row.changed_by, 'version', v_row.version::text);
END;
$$;

CREATE FUNCTION private.admin_set_shipping_options(_actor_id uuid, _carrier_date_check_enabled boolean, _expected_version bigint,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.accounting_shipping_options%ROWTYPE;
  v_hash text;
  v_prior jsonb;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _carrier_date_check_enabled IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _request_key IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The row is held until the end, so two requests at once are taken one after the other.
  SELECT * INTO v_row FROM public.accounting_shipping_options AS o WHERE o.id = 1 FOR UPDATE;
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'set_shipping_options', 'actor', _actor_id,
    'enabled', _carrier_date_check_enabled, 'version', _expected_version::text));
  v_prior := v_row.admin_requests -> (_request_key::text);
  IF v_prior IS NOT NULL THEN
    IF v_prior ->> 'hash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior -> 'result';
  END IF;
  IF v_row.version <> _expected_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  v_result := pg_catalog.jsonb_build_object('carrier_date_check_enabled', _carrier_date_check_enabled, 'changed_at', pg_catalog.now(),
    'changed_by', _actor_id, 'version', (v_row.version + 1)::text);
  UPDATE public.accounting_shipping_options AS o
  SET carrier_date_check_enabled = _carrier_date_check_enabled, changed_at = pg_catalog.now(), changed_by = _actor_id,
    version = v_row.version + 1,
    admin_requests = o.admin_requests || pg_catalog.jsonb_build_object(_request_key::text,
      pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result))
  WHERE o.id = 1;
  RETURN v_result;
END;
$$;

-- 7. The carrier receipt-date check. Off: nothing is read. On: the first in_transit tracking event of the slip's fulfillments (the slip's
--    present tracking version), in Japan time, against the shipment day. Only the confirmed slips; a slip with no such event is left out.
CREATE FUNCTION private.list_carrier_date_gaps(_from date, _to date, _limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
  v_slips jsonb;
  v_more boolean;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _to < _from OR (_to - _from) > 59 OR _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT o.carrier_date_check_enabled INTO v_enabled FROM public.accounting_shipping_options AS o WHERE o.id = 1;
  IF v_enabled IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('enabled', false, 'slips', '[]'::jsonb, 'has_more', false);
  END IF;
  WITH accepted AS (
    SELECT s.id, s.number, s.shipment_date,
      (SELECT (pg_catalog.min(e.happened_at) AT TIME ZONE 'Asia/Tokyo')::date
       FROM public.shipment_slip_fulfillments AS f
       JOIN public.order_fulfillment_events AS e ON e.fulfillment_id = f.fulfillment_id
       WHERE f.slip_id = s.id AND e.status = 'in_transit' AND e.source = 'tracking' AND e.tracking_version = s.tracking_version) AS accepted_date
    FROM public.shipment_slips AS s
    WHERE s.stage = 'confirmed' AND s.shipment_date BETWEEN _from AND _to),
  gaps AS (
    SELECT a.id, a.number, a.shipment_date, a.accepted_date, (a.accepted_date - a.shipment_date) AS gap_days,
      pg_catalog.row_number() OVER (ORDER BY a.shipment_date, a.number) AS rn
    FROM accepted AS a
    WHERE a.accepted_date IS NOT NULL AND pg_catalog.abs(a.accepted_date - a.shipment_date) >= 1
    ORDER BY a.shipment_date, a.number
    LIMIT _limit + 1)
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'slip_id', g.id, 'number', g.number, 'shipment_date', pg_catalog.to_char(g.shipment_date, 'YYYY-MM-DD'),
    'carrier_accepted_date', pg_catalog.to_char(g.accepted_date, 'YYYY-MM-DD'), 'gap_days', g.gap_days)
    ORDER BY g.rn) FILTER (WHERE g.rn <= _limit), '[]'::jsonb),
    COALESCE(pg_catalog.max(g.rn) > _limit, false)
  INTO v_slips, v_more
  FROM gaps AS g;
  RETURN pg_catalog.jsonb_build_object('enabled', true, 'slips', v_slips, 'has_more', v_more);
END;
$$;

-- 8. The public entries (SECURITY INVOKER; only service_role can call them).
CREATE FUNCTION public.list_year_end_shipments(_from date, _to date, _limit integer DEFAULT 100, _after_date date DEFAULT NULL,
  _after_slip uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_year_end_shipments(_from, _to, _limit, _after_date, _after_slip) $$;

CREATE FUNCTION public.admin_check_year_end_shipment(_actor_id uuid, _slip_id uuid, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_check_year_end_shipment(_actor_id, _slip_id, _note, _request_key) $$;

CREATE FUNCTION public.get_shipping_options() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_shipping_options() $$;

CREATE FUNCTION public.admin_set_shipping_options(_actor_id uuid, _carrier_date_check_enabled boolean, _expected_version bigint,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_shipping_options(_actor_id, _carrier_date_check_enabled, _expected_version, _request_key) $$;

CREATE FUNCTION public.list_carrier_date_gaps(_from date, _to date, _limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_carrier_date_gaps(_from, _to, _limit) $$;

-- 9. Owners and EXECUTE: service_role only (private and public).
ALTER FUNCTION private.list_year_end_shipments(date,date,integer,date,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_check_year_end_shipment(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.get_shipping_options() OWNER TO postgres;
ALTER FUNCTION private.admin_set_shipping_options(uuid,boolean,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION private.list_carrier_date_gaps(date,date,integer) OWNER TO postgres;
ALTER FUNCTION public.list_year_end_shipments(date,date,integer,date,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_check_year_end_shipment(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_shipping_options() OWNER TO postgres;
ALTER FUNCTION public.admin_set_shipping_options(uuid,boolean,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_carrier_date_gaps(date,date,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.list_year_end_shipments(date,date,integer,date,uuid), private.admin_check_year_end_shipment(uuid,uuid,text,uuid),
  private.get_shipping_options(), private.admin_set_shipping_options(uuid,boolean,bigint,uuid),
  private.list_carrier_date_gaps(date,date,integer),
  public.list_year_end_shipments(date,date,integer,date,uuid), public.admin_check_year_end_shipment(uuid,uuid,text,uuid),
  public.get_shipping_options(), public.admin_set_shipping_options(uuid,boolean,bigint,uuid),
  public.list_carrier_date_gaps(date,date,integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.list_year_end_shipments(date,date,integer,date,uuid), private.admin_check_year_end_shipment(uuid,uuid,text,uuid),
  private.get_shipping_options(), private.admin_set_shipping_options(uuid,boolean,bigint,uuid),
  private.list_carrier_date_gaps(date,date,integer),
  public.list_year_end_shipments(date,date,integer,date,uuid), public.admin_check_year_end_shipment(uuid,uuid,text,uuid),
  public.get_shipping_options(), public.admin_set_shipping_options(uuid,boolean,bigint,uuid),
  public.list_carrier_date_gaps(date,date,integer)
TO service_role;
-- ACC_S14_BODY_END

-- ACC_S14_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s14_tables: the two tables, their columns in order, their owner. acc_s14_constraints: the
-- constraints and the indexes, and no other trigger. acc_s14_immutable: the reject triggers (marks: no update / delete / truncate;
-- options: no delete / truncate), enabled ALWAYS. acc_s14_rls_acl: RLS on, no policy, nothing for PUBLIC / anon / authenticated, SELECT only
-- for service_role. acc_s14_function_attrs: owner, SECURITY, volatility, language, result, arguments, defaults, search_path and EXECUTE, and
-- the text rules. acc_s14_existing_dml_allowlist: this migration wrote no entry, line, parked row or period; the marks are empty and the
-- options are the one default row.
DO $acc_s14_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_checks oid;
  v_options oid;
  v_src text;
  v_baseline jsonb;
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s14_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s14_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s14_baseline) <> 1 THEN
    v_failed := 'acc_s14_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s14_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s14_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s14_tables';
  v_checks := pg_catalog.to_regclass('public.accounting_shipment_checks');
  v_options := pg_catalog.to_regclass('public.accounting_shipping_options');
  IF v_failed IS NULL AND (
    v_checks IS NULL OR v_options IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_checks, v_options]) AS t(oid)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
        WHERE c.oid = t.oid AND c.relkind = 'r' AND c.relpersistence = 'p' AND c.relowner = 'postgres'::regrole
          AND NOT c.relispartition AND NOT c.relhassubclass)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits AS i WHERE i.inhrelid = t.oid))
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = v_checks AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'slip_id uuid not null, checked_shipment_date date not null, checked_tracking_version integer not null, checked_by uuid not null, checked_at timestamp with time zone not null default now(), note text, request_key uuid not null, request_hash text not null'
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = v_options AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'id smallint not null, carrier_date_check_enabled boolean not null default false, changed_at timestamp with time zone, changed_by uuid, version bigint not null default 1, admin_requests jsonb not null default ''{}''::jsonb') THEN
    v_failed := 'acc_s14_tables';
  END IF;

  v_stage := 'acc_s14_constraints';
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('accounting_shipment_checks', 'accounting_shipment_checks_pkey', 'p', 'slip_id,checked_shipment_date,checked_tracking_version'),
      ('accounting_shipment_checks', 'accounting_shipment_checks_request_key_key', 'u', 'request_key'),
      ('accounting_shipment_checks', 'accounting_shipment_checks_note_check', 'c', 'CHECK ((char_length(note) <= 200))'),
      ('accounting_shipping_options', 'accounting_shipping_options_pkey', 'p', 'id'),
      ('accounting_shipping_options', 'accounting_shipping_options_id_check', 'c', 'CHECK ((id = 1))'),
      ('accounting_shipping_options', 'accounting_shipping_options_admin_requests_check', 'c', 'CHECK ((jsonb_typeof(admin_requests) = ''object''::text))')
    ) AS x(table_name, name, kind, definition)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name AND c.contype = x.kind::"char"
        AND c.convalidated AND NOT c.condeferrable
        AND CASE WHEN c.contype = 'c'
          THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
            FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
            JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num) END = x.definition))
    -- The mark's slip is a foreign key to shipment_slips(id), RESTRICT on delete and on update.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_checks AND c.conname = 'accounting_shipment_checks_slip_id_fkey' AND c.contype = 'f' AND c.convalidated
        AND NOT c.condeferrable AND c.confrelid = 'public.shipment_slips'::regclass AND c.confdeltype = 'r' AND c.confupdtype = 'a'
        AND c.confmatchtype = 's'
        AND (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num) = 'slip_id'
        AND (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num) = 'id') <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_checks AND c.contype IN ('c', 'p', 'u', 'f', 'x')) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_options AND c.contype IN ('c', 'p', 'u', 'f', 'x')) <> 3
    -- The indexes are the ones that belong to the constraints: the key and the unique request key; the key of the options.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i WHERE i.indrelid = v_checks) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i WHERE i.indrelid = v_options) <> 1) THEN
    v_failed := 'acc_s14_constraints';
  END IF;

  v_stage := 'acc_s14_immutable';
  -- BEFORE UPDATE OR DELETE (row, 27) and BEFORE TRUNCATE (statement, 34) on the marks; BEFORE DELETE (row, 11) and BEFORE TRUNCATE
  -- on the options; each enabled ALWAYS, calling the reject function; and no other user trigger on the two tables.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('accounting_shipment_checks', 'accounting_shipment_checks_no_update_delete', 27),
      ('accounting_shipment_checks', 'accounting_shipment_checks_no_truncate', 34),
      ('accounting_shipping_options', 'accounting_shipping_options_no_delete', 11),
      ('accounting_shipping_options', 'accounting_shipping_options_no_truncate', 34)
    ) AS x(table_name, name, kind)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = pg_catalog.to_regclass('public.' || x.table_name) AND g.tgname::text = x.name
        AND g.tgfoid = 'private.reject_accounting_mutation()'::regprocedure AND g.tgtype = x.kind
        AND g.tgenabled = 'A' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
        AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (v_checks, v_options)) <> 4) THEN
    v_failed := 'acc_s14_immutable';
  END IF;

  v_stage := 'acc_s14_rls_acl';
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_checks, v_options]) AS t(oid)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid = t.oid AND c.relrowsecurity)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = t.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
          WHERE c.oid = t.oid AND (acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
            OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT')))
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
          WHERE c.oid = t.oid AND acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type = 'SELECT')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
          CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
          WHERE pg_catalog.has_table_privilege(r.role, t.oid, q.privilege))
        OR pg_catalog.has_table_privilege('anon', t.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('authenticated', t.oid, 'SELECT')
        OR NOT pg_catalog.has_table_privilege('service_role', t.oid, 'SELECT'))) THEN
    v_failed := 'acc_s14_rls_acl';
  END IF;

  v_stage := 'acc_s14_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'list_year_end_shipments(date,date,integer,date,uuid)', 's', 'plpgsql', '_from,_to,_limit,_after_date,_after_slip', 0, true, ''),
      ('private', 'admin_check_year_end_shipment(uuid,uuid,text,uuid)', 'v', 'plpgsql', '_actor_id,_slip_id,_note,_request_key', 0, true, ''),
      ('private', 'get_shipping_options()', 's', 'plpgsql', '', 0, true, ''),
      ('private', 'admin_set_shipping_options(uuid,boolean,bigint,uuid)', 'v', 'plpgsql',
        '_actor_id,_carrier_date_check_enabled,_expected_version,_request_key', 0, true, ''),
      ('private', 'list_carrier_date_gaps(date,date,integer)', 's', 'plpgsql', '_from,_to,_limit', 0, true, ''),
      ('public', 'list_year_end_shipments(date,date,integer,date,uuid)', 's', 'sql', '_from,_to,_limit,_after_date,_after_slip', 3, false,
        'selectprivate.list_year_end_shipments(_from,_to,_limit,_after_date,_after_slip)'),
      ('public', 'admin_check_year_end_shipment(uuid,uuid,text,uuid)', 'v', 'sql', '_actor_id,_slip_id,_note,_request_key', 0, false,
        'selectprivate.admin_check_year_end_shipment(_actor_id,_slip_id,_note,_request_key)'),
      ('public', 'get_shipping_options()', 's', 'sql', '', 0, false, 'selectprivate.get_shipping_options()'),
      ('public', 'admin_set_shipping_options(uuid,boolean,bigint,uuid)', 'v', 'sql',
        '_actor_id,_carrier_date_check_enabled,_expected_version,_request_key', 0, false,
        'selectprivate.admin_set_shipping_options(_actor_id,_carrier_date_check_enabled,_expected_version,_request_key)'),
      ('public', 'list_carrier_date_gaps(date,date,integer)', 's', 'sql', '_from,_to,_limit', 1, false,
        'selectprivate.list_carrier_date_gaps(_from,_to,_limit)')
    ) AS x(schema_name, signature, volatility, language, arg_names, defaults, definer, public_body)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s14_function_attrs'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
        OR p.provolatile <> e.volatility::"char" OR p.lanname <> e.language
        OR p.prorettype <> 'jsonb'::regtype OR p.proretset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        OR (e.schema_name = 'public' AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:];]', '', 'g') <> e.public_body) THEN
        v_failed := 'acc_s14_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- The text rules of the private bodies (each text sits on one line of the body).
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.list_year_end_shipments(date,date,integer,date,uuid)', ARRAY[
        '(_to - _from) > 59', '_limit > 200', '(_after_date IS NULL) <> (_after_slip IS NULL)', '''22023''',
        'AND s.stage IN (''confirmed'', ''cancelled'')', 'ORDER BY s.shipment_date, s.number',
        '(s.shipment_date, s.number) > (_after_date, v_cursor_number)', 'FROM public.accounting_shipment_checks AS k WHERE k.slip_id = s.id', 'ORDER BY k.checked_at DESC', '''check_stale'', p.check_stale',
        'c.checked_shipment_date <> s.shipment_date OR c.checked_tracking_version <> s.tracking_version']),
      ('private.admin_check_year_end_shipment(uuid,uuid,text,uuid)', ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.finance.manage''])', '''ACCOUNTING_FORBIDDEN''', '''42501''',
        'pg_catalog.char_length(v_note) > 200', 'private.accounting_request_hash(', '''ACCOUNTING_REQUEST_KEY_CONFLICT''', '''23505''',
        '''ACCOUNTING_NOT_FOUND''', '''P0002''', 'ON CONFLICT DO NOTHING', 's.stage IN (''confirmed'', ''cancelled'')']),
      ('private.get_shipping_options()', ARRAY['WHERE o.id = 1', '''version'', v_row.version::text']),
      ('private.admin_set_shipping_options(uuid,boolean,bigint,uuid)', ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.accounting.settings.manage''])', '''ACCOUNTING_FORBIDDEN''', '''42501''',
        'WHERE o.id = 1 FOR UPDATE', 'private.accounting_request_hash(', '''ACCOUNTING_REQUEST_KEY_CONFLICT''',
        'IF v_row.version <> _expected_version THEN', '''ACCOUNTING_VERSION_CONFLICT''', '''40001''',
        'version = v_row.version + 1', 'changed_at = pg_catalog.now()', 'changed_by = _actor_id']),
      ('private.list_carrier_date_gaps(date,date,integer)', ARRAY[
        '(_to - _from) > 59', '_limit > 200', '''22023''', 'o.carrier_date_check_enabled', 'IF v_enabled IS DISTINCT FROM true THEN',
        'e.status = ''in_transit''', 'e.source = ''tracking''', 'e.tracking_version = s.tracking_version', 'pg_catalog.min(e.happened_at)',
        'AT TIME ZONE ''Asia/Tokyo''', 's.stage = ''confirmed''', 'pg_catalog.abs(a.accepted_date - a.shipment_date) >= 1',
        'LIMIT _limit + 1', '''has_more'', v_more', 'g.rn <= _limit'])
    ) AS x(signature, needles)
    LOOP
      v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature));
      IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(e.needles) AS n(needle) WHERE pg_catalog.strpos(v_src, n.needle) = 0) THEN
        v_failed := 'acc_s14_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- The permission check comes first in the two writers; the three reads write nothing, take no row lock and read no customer column.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.admin_check_year_end_shipment(uuid,uuid,text,uuid)'), ('private.admin_set_shipping_options(uuid,boolean,bigint,uuid)')
    ) AS x(signature)
    LOOP
      v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature));
      IF pg_catalog.strpos(v_src, 'group_g_actor_has_permissions') = 0
        OR pg_catalog.strpos(v_src, 'group_g_actor_has_permissions') > pg_catalog.strpos(v_src, 'ACCOUNTING_ARGUMENT_INVALID')
        OR pg_catalog.strpos(v_src, 'group_g_actor_has_permissions') > pg_catalog.strpos(v_src, 'private.accounting_request_hash(') THEN
        v_failed := 'acc_s14_function_attrs'; EXIT;
      END IF;
    END LOOP;
    FOR e IN SELECT * FROM (VALUES
      ('private.list_year_end_shipments(date,date,integer,date,uuid)'), ('private.get_shipping_options()'),
      ('private.list_carrier_date_gaps(date,date,integer)')
    ) AS x(signature)
    LOOP
      v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature));
      IF v_failed IS NULL AND (v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE))\M'
        OR v_src ~* '(customer_|ship_to_|draft_lines)') THEN
        v_failed := 'acc_s14_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s14_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_shipment_checks) <> 0
    OR (SELECT pg_catalog.count(*) FROM public.accounting_shipping_options) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.accounting_shipping_options AS o
      WHERE o.id = 1 AND NOT o.carrier_date_check_enabled AND o.changed_at IS NULL AND o.changed_by IS NULL AND o.version = 1
        AND o.admin_requests = '{}'::jsonb)) THEN
    v_failed := 'acc_s14_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s14_tables'), HINT = SQLSTATE;
END;
$acc_s14_final$;
-- ACC_S14_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
