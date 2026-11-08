BEGIN;
-- Accounting plan 2 S10 (FREQ-567 AC-01..AC-04): receiving the card network disputes. A dispute Stripe sends
-- (charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated) is kept in stripe_disputes (one row per
-- dispute, only the mutable columns change) and every time it is read from Stripe one row is added to stripe_dispute_events
-- (append only). No journal entry is posted here: Task 6 posts from these two tables. The group G / H tables and functions and
-- every returns / refund object are not touched; the stripe_balance_transactions of a dispute are written by the existing
-- TypeScript adapter (src/lib/stripe/dispute-sync.ts), as for a charge or a payout.
--
-- stripe_disputes (RLS on, no policy, owner postgres, service_role SELECT only; written by private.record_stripe_dispute):
--   id (dp_...), payment_intent_id / charge_id / order_id (no foreign key, a dispute that matches no order is kept), amount (> 0),
--   currency, reason, status, is_charge_refundable, evidence_due_by, evidence_details (may hold customer personal data: service_role
--   SELECT only, never logged, Ruling P2-R6), stripe_created_at, synced_at.
--   Only status, is_charge_refundable, evidence_due_by, evidence_details, order_id and synced_at may change (a BEFORE UPDATE
--   trigger refuses any other change); DELETE and TRUNCATE are refused.
-- stripe_dispute_events (same access; append only): one row per notification or per nightly re-read. status is the state read
--   from Stripe at occurred_at; stripe_event_created_at is Stripe's own time of the event and is only set for a lost dispute
--   (Task 6 takes the time of the loss from it); raw_payload is the dispute as it was read (cause, due date, list of submitted
--   evidence) and is never rewritten (4-f, an electronic transaction record).
--
-- private.record_stripe_dispute(_dispute jsonb, _event jsonb) RETURNS jsonb  +  public.record_stripe_dispute (INVOKER, service_role).
--   _dispute {id, payment_intent_id, charge_id, order_id, amount, currency, reason, status, is_charge_refundable, evidence_due_by,
--   evidence_details, stripe_created_at}; _event {stripe_event_id, event_type, status, occurred_at, stripe_event_created_at,
--   balance_transaction_ids, raw_payload}, or NULL for a re-read that adds no history row (the state did not change). The dispute
--   is created or its mutable columns are updated (order_id is never cleared); the history row is added ON CONFLICT
--   (stripe_event_id) DO NOTHING. Result {dispute_id, event_inserted}. A second call with the same stripe_event_id adds nothing.
--   It takes no accounting lock and posts nothing.
--
-- ROLLBACK (only while no dispute has been recorded):
--   DROP FUNCTION public.record_stripe_dispute(jsonb,jsonb), private.record_stripe_dispute(jsonb,jsonb),
--     private.stripe_disputes_guard_update();
--   DROP TABLE public.stripe_dispute_events, public.stripe_disputes;

-- ACC_S10_BODY_BEGIN
-- 1. The tables.
CREATE TABLE public.stripe_disputes (
  id text NOT NULL,
  payment_intent_id text NULL,
  charge_id text NULL,
  order_id uuid NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL,
  is_charge_refundable boolean NULL,
  evidence_due_by timestamptz NULL,
  evidence_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_created_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_disputes_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_disputes_id_check CHECK (id ~ '^dp_[A-Za-z0-9]+$'),
  CONSTRAINT stripe_disputes_amount_check CHECK (amount > 0),
  CONSTRAINT stripe_disputes_reason_check CHECK (char_length(reason) BETWEEN 1 AND 64),
  CONSTRAINT stripe_disputes_status_check CHECK (char_length(status) BETWEEN 1 AND 64)
);

CREATE TABLE public.stripe_dispute_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dispute_id text NOT NULL,
  stripe_event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  stripe_event_created_at timestamptz NULL,
  balance_transaction_ids text[] NOT NULL DEFAULT '{}'::text[],
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_dispute_events_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_dispute_events_stripe_event_id_key UNIQUE (stripe_event_id),
  CONSTRAINT stripe_dispute_events_dispute_id_fkey FOREIGN KEY (dispute_id)
    REFERENCES public.stripe_disputes (id) ON DELETE RESTRICT
);
CREATE INDEX stripe_dispute_events_dispute_idx ON public.stripe_dispute_events (dispute_id, occurred_at);

ALTER TABLE public.stripe_disputes OWNER TO postgres;
ALTER TABLE public.stripe_dispute_events OWNER TO postgres;
ALTER TABLE public.stripe_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_dispute_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_disputes, public.stripe_dispute_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.stripe_disputes, public.stripe_dispute_events TO service_role;

-- The baseline the final assert compares with: no migration step writes an entry, a line, a parked row, a period or a dispute.
-- A replay of the assert (tests) pins the current state here first (pinAccountingS10Baseline).
CREATE TEMP TABLE accounting_s10_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s10_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods),
  'disputes', (SELECT pg_catalog.count(*) FROM public.stripe_disputes),
  'dispute_events', (SELECT pg_catalog.count(*) FROM public.stripe_dispute_events));

-- 2. Append only (every role, also under session_replication_role = replica) and the guard of the fixed columns.
CREATE FUNCTION private.stripe_disputes_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.charge_id IS DISTINCT FROM OLD.charge_id
    OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
    OR NEW.stripe_created_at IS DISTINCT FROM OLD.stripe_created_at THEN
    RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stripe_disputes_guard_update BEFORE UPDATE ON public.stripe_disputes
  FOR EACH ROW EXECUTE FUNCTION private.stripe_disputes_guard_update();
CREATE TRIGGER stripe_disputes_no_delete BEFORE DELETE ON public.stripe_disputes
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER stripe_disputes_no_truncate BEFORE TRUNCATE ON public.stripe_disputes
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER stripe_dispute_events_no_update_delete BEFORE UPDATE OR DELETE ON public.stripe_dispute_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER stripe_dispute_events_no_truncate BEFORE TRUNCATE ON public.stripe_dispute_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.stripe_disputes ENABLE ALWAYS TRIGGER stripe_disputes_guard_update;
ALTER TABLE public.stripe_disputes ENABLE ALWAYS TRIGGER stripe_disputes_no_delete;
ALTER TABLE public.stripe_disputes ENABLE ALWAYS TRIGGER stripe_disputes_no_truncate;
ALTER TABLE public.stripe_dispute_events ENABLE ALWAYS TRIGGER stripe_dispute_events_no_update_delete;
ALTER TABLE public.stripe_dispute_events ENABLE ALWAYS TRIGGER stripe_dispute_events_no_truncate;

-- 3. The writer. Plain upsert of the dispute, then the history row; no lock of the accounting tables.
CREATE FUNCTION private.record_stripe_dispute(_dispute jsonb, _event jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id text;
  v_rows integer := 0;
BEGIN
  IF _dispute IS NULL OR pg_catalog.jsonb_typeof(_dispute) <> 'object'
    OR (_event IS NOT NULL AND pg_catalog.jsonb_typeof(_event) <> 'object') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_id := _dispute ->> 'id';
  IF v_id IS NULL OR v_id !~ '^dp_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _event IS NOT NULL AND (
    COALESCE(_event ->> 'stripe_event_id', '') = '' OR COALESCE(_event ->> 'event_type', '') = ''
    OR COALESCE(_event ->> 'status', '') = '' OR _event ->> 'occurred_at' IS NULL
    OR pg_catalog.jsonb_typeof(_event -> 'raw_payload') IS DISTINCT FROM 'object'
    OR (_event -> 'balance_transaction_ids' IS NOT NULL
      AND pg_catalog.jsonb_typeof(_event -> 'balance_transaction_ids') <> 'array')) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_disputes (id, payment_intent_id, charge_id, order_id, amount, currency, reason, status,
    is_charge_refundable, evidence_due_by, evidence_details, stripe_created_at, synced_at)
  VALUES (v_id, _dispute ->> 'payment_intent_id', _dispute ->> 'charge_id', (_dispute ->> 'order_id')::uuid,
    (_dispute ->> 'amount')::bigint, _dispute ->> 'currency', _dispute ->> 'reason', _dispute ->> 'status',
    (_dispute ->> 'is_charge_refundable')::boolean, (_dispute ->> 'evidence_due_by')::timestamptz,
    CASE WHEN pg_catalog.jsonb_typeof(_dispute -> 'evidence_details') = 'object' THEN _dispute -> 'evidence_details'
      ELSE '{}'::jsonb END,
    (_dispute ->> 'stripe_created_at')::timestamptz, pg_catalog.now())
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    is_charge_refundable = EXCLUDED.is_charge_refundable,
    evidence_due_by = EXCLUDED.evidence_due_by,
    evidence_details = EXCLUDED.evidence_details,
    order_id = COALESCE(EXCLUDED.order_id, public.stripe_disputes.order_id),
    synced_at = EXCLUDED.synced_at;

  IF _event IS NOT NULL THEN
    INSERT INTO public.stripe_dispute_events (dispute_id, stripe_event_id, event_type, status, occurred_at,
      stripe_event_created_at, balance_transaction_ids, raw_payload)
    VALUES (v_id, _event ->> 'stripe_event_id', _event ->> 'event_type', _event ->> 'status',
      (_event ->> 'occurred_at')::timestamptz, (_event ->> 'stripe_event_created_at')::timestamptz,
      COALESCE(ARRAY(SELECT pg_catalog.jsonb_array_elements_text(_event -> 'balance_transaction_ids')), '{}'::text[]),
      _event -> 'raw_payload')
    ON CONFLICT (stripe_event_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;
  RETURN pg_catalog.jsonb_build_object('dispute_id', v_id, 'event_inserted', v_rows = 1);
END;
$$;

-- 4. The public entry (same name, arguments and result; LANGUAGE sql SECURITY INVOKER; service_role only).
CREATE FUNCTION public.record_stripe_dispute(_dispute jsonb, _event jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.record_stripe_dispute(_dispute, _event) $$;

ALTER FUNCTION private.stripe_disputes_guard_update() OWNER TO postgres;
ALTER FUNCTION private.record_stripe_dispute(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.record_stripe_dispute(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.stripe_disputes_guard_update(), private.record_stripe_dispute(jsonb,jsonb),
  public.record_stripe_dispute(jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_stripe_dispute(jsonb,jsonb), public.record_stripe_dispute(jsonb,jsonb) TO service_role;
-- ACC_S10_BODY_END

-- ACC_S10_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s10_tables: both tables (owner, columns with type, null and default).
-- acc_s10_constraints: every CHECK / PRIMARY KEY / UNIQUE / FOREIGN KEY, validated and not deferrable, and no other one; the
-- reading index. acc_s10_immutable: the five triggers (ALWAYS, reject function or the guard) and no other user trigger, and the
-- guard compares exactly the fixed columns. acc_s10_rls_acl: RLS on, no policy, service_role holds SELECT only.
-- acc_s10_function_attrs: owner, SECURITY, volatility, language, result, arguments, search_path and EXECUTE (service_role only for
-- the writer and its public entry, nobody for the guard), the text of the writer keeps the rules above.
-- acc_s10_existing_dml_allowlist: this migration wrote no row.
DO $acc_s10_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_src text;
  v_baseline jsonb;
  v_tables text[] := ARRAY['stripe_disputes', 'stripe_dispute_events'];
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s10_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s10_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s10_baseline) <> 1 THEN
    v_failed := 'acc_s10_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s10_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods', 'disputes', 'dispute_events']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s10_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s10_tables';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('stripe_disputes', 'id text not null, payment_intent_id text, charge_id text, order_id uuid, amount bigint not null, currency text not null, reason text not null, status text not null, is_charge_refundable boolean, evidence_due_by timestamp with time zone, evidence_details jsonb not null default ''{}''::jsonb, stripe_created_at timestamp with time zone not null, synced_at timestamp with time zone not null default now()'),
    ('stripe_dispute_events', 'id uuid not null default gen_random_uuid(), dispute_id text not null, stripe_event_id text not null, event_type text not null, status text not null, occurred_at timestamp with time zone not null, stripe_event_created_at timestamp with time zone, balance_transaction_ids text[] not null default ''{}''::text[], raw_payload jsonb not null, created_at timestamp with time zone not null default now()')
    ) AS t(name, columns)
    LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
      OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
            || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute AS a
          LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns) THEN
    v_failed := 'acc_s10_tables';
  END IF;

  v_stage := 'acc_s10_constraints';
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
    ('stripe_disputes', 'stripe_disputes_amount_check', 'c', 'CHECK ((amount > 0))'),
    ('stripe_disputes', 'stripe_disputes_id_check', 'c', 'CHECK ((id ~ ''^dp_[A-Za-z0-9]+$''::text))'),
    ('stripe_disputes', 'stripe_disputes_pkey', 'p', 'id'),
    ('stripe_disputes', 'stripe_disputes_reason_check', 'c', 'CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 64)))'),
    ('stripe_disputes', 'stripe_disputes_status_check', 'c', 'CHECK (((char_length(status) >= 1) AND (char_length(status) <= 64)))'),
    ('stripe_dispute_events', 'stripe_dispute_events_dispute_id_fkey', 'f', 'dispute_id>public.stripe_disputes(id)ras'),
    ('stripe_dispute_events', 'stripe_dispute_events_pkey', 'p', 'id'),
    ('stripe_dispute_events', 'stripe_dispute_events_stripe_event_id_key', 'u', 'stripe_event_id')
    ) AS x(table_name, name, kind, definition)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name
        AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
        AND CASE WHEN c.contype = 'c'
          THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
              FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
              JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num)
            || CASE WHEN c.contype = 'f' THEN '>'
              || (SELECT n.nspname::text || '.' || r.relname::text FROM pg_catalog.pg_class AS r
                JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace WHERE r.oid = c.confrelid)
              || '(' || (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num) || ')'
              || c.confdeltype::text || c.confupdtype::text || c.confmatchtype::text
            ELSE '' END
          END = x.definition))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)) <> 8
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS x ON x.oid = i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid = x.relam
      WHERE i.indrelid = 'public.stripe_dispute_events'::regclass AND x.relname = 'stripe_dispute_events_dispute_idx'
        AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname = 'btree'
        AND (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.num) = 'dispute_id,occurred_at') <> 1) THEN
    v_failed := 'acc_s10_constraints';
  END IF;

  v_stage := 'acc_s10_immutable';
  -- tgtype: 19 = BEFORE UPDATE row, 11 = BEFORE DELETE row, 27 = BEFORE UPDATE OR DELETE row, 34 = BEFORE TRUNCATE statement.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('stripe_disputes', 'stripe_disputes_guard_update', 19, 'private.stripe_disputes_guard_update()'),
      ('stripe_disputes', 'stripe_disputes_no_delete', 11, 'private.reject_accounting_mutation()'),
      ('stripe_disputes', 'stripe_disputes_no_truncate', 34, 'private.reject_accounting_mutation()'),
      ('stripe_dispute_events', 'stripe_dispute_events_no_update_delete', 27, 'private.reject_accounting_mutation()'),
      ('stripe_dispute_events', 'stripe_dispute_events_no_truncate', 34, 'private.reject_accounting_mutation()')
    ) AS x(table_name, name, kind, fn)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = pg_catalog.to_regclass('public.' || x.table_name) AND g.tgname::text = x.name
        AND g.tgfoid = pg_catalog.to_regprocedure(x.fn) AND g.tgtype = x.kind
        AND g.tgenabled = 'A' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
        AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)) <> 5) THEN
    v_failed := 'acc_s10_immutable';
  END IF;
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
    WHERE f.oid = pg_catalog.to_regprocedure('private.stripe_disputes_guard_update()');
    IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['id', 'amount', 'currency', 'reason', 'charge_id',
        'payment_intent_id', 'stripe_created_at']) AS c(name)
      WHERE pg_catalog.strpos(v_src, 'NEW.' || c.name || ' IS DISTINCT FROM OLD.' || c.name) = 0)
      OR pg_catalog.strpos(v_src, '''ACCOUNTING_HISTORY_IMMUTABLE''') = 0
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['status', 'is_charge_refundable', 'evidence_due_by', 'evidence_details',
        'order_id', 'synced_at']) AS c(name) WHERE pg_catalog.strpos(v_src, 'NEW.' || c.name) > 0) THEN
      v_failed := 'acc_s10_immutable';
    END IF;
  END IF;

  v_stage := 'acc_s10_rls_acl';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee <> c.relowner AND (acl.grantee <> 'service_role'::regrole::oid OR acl.privilege_type <> 'SELECT'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s10_rls_acl';
  END IF;

  v_stage := 'acc_s10_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.record_stripe_dispute(jsonb,jsonb)', 'jsonb', '_dispute,_event', 'v', true, 'plpgsql', true),
      ('public.record_stripe_dispute(jsonb,jsonb)', 'jsonb', '_dispute,_event', 'v', false, 'sql', true),
      ('private.stripe_disputes_guard_update()', 'trigger', '', 'v', false, 'plpgsql', false)
    ) AS x(signature, result_type, arg_names, volatility, definer, lang, service_exec)
    LOOP
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.provolatile::text <> e.volatility
        OR p.lanname <> e.lang OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset OR p.prokind <> 'f'
        OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> 0
        OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service_exec
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee <> p.proowner AND NOT (e.service_exec AND a.grantee = 'service_role'::regrole))
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1 THEN
        v_failed := 'acc_s10_function_attrs';
        EXIT;
      END IF;
    END LOOP;
    -- The writer keeps the rules: it adds the history row once per Stripe event, never clears an order, posts nothing, takes no
    -- accounting lock, and refuses a malformed argument with the fixed code. The public entry only calls it.
    IF v_failed IS NULL THEN
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.record_stripe_dispute(jsonb,jsonb)');
      IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['ON CONFLICT (stripe_event_id) DO NOTHING', 'ON CONFLICT (id) DO UPDATE SET',
          'order_id = COALESCE(EXCLUDED.order_id, public.stripe_disputes.order_id)', '''ACCOUNTING_ARGUMENT_INVALID''',
          'GET DIAGNOSTICS v_rows = ROW_COUNT', '''event_inserted''']) AS n(text) WHERE pg_catalog.strpos(v_src, n.text) = 0)
        OR v_src ~* '(accounting_lock_all|accounting_post_journal|accounting_journal|accounting_pending|DELETE FROM|TRUNCATE|PG_EXCEPTION_CONTEXT)'
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['    amount = ', '    reason = ', '    charge_id = ', '    payment_intent_id = ',
          '    stripe_created_at = ', '    currency = ']) AS n(text) WHERE pg_catalog.strpos(v_src, n.text) > 0) THEN
        v_failed := 'acc_s10_function_attrs';
      END IF;
    END IF;
    IF v_failed IS NULL THEN
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('public.record_stripe_dispute(jsonb,jsonb)');
      IF pg_catalog.btrim(v_src) <> 'SELECT private.record_stripe_dispute(_dispute, _event)' THEN
        v_failed := 'acc_s10_function_attrs';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s10_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.stripe_disputes) IS DISTINCT FROM (v_baseline ->> 'disputes')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.stripe_dispute_events) IS DISTINCT FROM (v_baseline ->> 'dispute_events')::bigint) THEN
    v_failed := 'acc_s10_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the
  -- SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s10_tables'), HINT = SQLSTATE;
END;
$acc_s10_final$;
-- ACC_S10_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
