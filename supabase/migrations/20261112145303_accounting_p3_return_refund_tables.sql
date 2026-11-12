BEGIN;
-- Accounting plan 3 S15 (FREQ-575 AC-01/AC-02/AC-04, FREQ-576 AC-01..AC-04, FREQ-569 AC-01, FREQ-580 AC-01): the facts
-- of refunds and returns that tasks 3-9 build on, the arrival date of a return receipt, the return options, two new
-- parked reasons, the detail keys of plan 3 and the dispute-hold tools.
--
-- Column: order_return_receipts.arrived_on date NOT NULL DEFAULT the day of the recording in Japan. The receipts are
-- append only (UPDATE is refused), so nothing is backfilled: the table must be empty when this runs (production and a
-- reset local database hold none; design 0-4). arrived_on of a row whose kind is not 'receive' has no meaning.
-- Tables (all public, owned by postgres, RLS on and no policy; PUBLIC, anon and authenticated hold nothing;
-- service_role holds SELECT only; written by private functions of later tasks):
--   order_return_arrival_corrections    one row per correction of the arrival date of a receipt (append only)
--   accounting_return_options           one row: use the carrier's delivery date (off by default)
--   accounting_refund_events            the state history of a refund, one row per state (append only)
--   accounting_refund_facts             the amounts of a refund, written once when it starts (append only)
--   accounting_refund_transfer_adjusts  the price changes of units already shipped when a pre-shipment cancel event
--                                       happened, per event and unit (append only)
--   accounting_unit_price_adjusts       the price changes of units not shipped yet at that event (append only)
--   accounting_return_facts             the arrival and the decision of a return (append only)
-- The rows of accounting_refund_events, accounting_refund_transfer_adjusts and accounting_unit_price_adjusts carry the
-- number of plan 2 (private.accounting_take_g_fact_seq, inside the group G lock); this file adds no writer.
-- accounting_pending_events_reason_check gets refund_prior_unposted and refund_cancel_undecided (the rows are kept).
-- private.accounting_pending_detail_valid (CREATE OR REPLACE; arguments, attributes and ACL unchanged) accepts:
--   amount_mismatch.mismatch (split, refund_amount, allocation_overflow, unit_value_left),
--   refund_prior_unposted.why (return_prior, original, failure_txn_missing),
--   refund_cancel_undecided.refund_id (a lower-case uuid) and .canceled_on (a date),
--   dispute_refund_overlap.why and dispute_return_refund_pending.why (refund, return).
-- Tools (private, no entry point, no grant): accounting_dispute_holds (a thin wrapper of get_order_dispute_holds) and
--   accounting_assert_no_dispute_hold (ACCOUNTING_DISPUTE_HOLD / 55000, DETAIL order_count=<n>).
--
-- ROLLBACK (only while no row exists in the six append-only tables and no parked row uses the two new reasons):
--   DROP FUNCTION private.accounting_assert_no_dispute_hold(uuid[]), private.accounting_dispute_holds(uuid[]);
--   re-run CREATE OR REPLACE FUNCTION private.accounting_pending_detail_valid from
--     20261108150000_accounting_p2_posting_tables.sql;
--   restore accounting_pending_events_reason_check with the 18 reasons of 20261108150000;
--   DROP TABLE public.accounting_return_facts, public.accounting_unit_price_adjusts,
--     public.accounting_refund_transfer_adjusts, public.accounting_refund_facts, public.accounting_refund_events,
--     public.accounting_return_options, public.order_return_arrival_corrections;
--   ALTER TABLE public.order_return_receipts DROP COLUMN arrived_on;   -- only while the table is still empty

-- ACC_S15_BODY_BEGIN

-- 0. Before anything is changed: no return receipt may exist yet (an existing row would get today as its arrival date
--    and could not be corrected, because the receipts refuse UPDATE). The baseline the final assert compares with is
--    taken after this check; a replay of the assert (tests) pins the current state first (pinAccountingS15Baseline).
DO $acc_s15_precheck$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_return_receipts) THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s15_receipt_backfill';
  END IF;
END
$acc_s15_precheck$;

CREATE TEMP TABLE accounting_s15_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s15_baseline(payload)
SELECT pg_catalog.jsonb_build_object('receipts', 0,
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'arrival_corrections', 0, 'refund_events', 0, 'refund_facts', 0, 'refund_transfer_adjusts', 0,
  'unit_price_adjusts', 0, 'return_facts', 0);

-- 1. The arrival date of a receipt (the day of Japan when it was recorded, unless the writer passes another one).
ALTER TABLE public.order_return_receipts
  ADD COLUMN arrived_on date NOT NULL DEFAULT ((pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date);

-- 2. Tables.
CREATE TABLE public.order_return_arrival_corrections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL,
  version integer NOT NULL,
  previous_on date NOT NULL,
  new_on date NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_return_arrival_corrections_pkey PRIMARY KEY (id),
  CONSTRAINT order_return_arrival_corrections_receipt_id_fkey FOREIGN KEY (receipt_id)
    REFERENCES public.order_return_receipts (id) ON DELETE RESTRICT,
  CONSTRAINT order_return_arrival_corrections_request_key_key UNIQUE (request_key),
  CONSTRAINT order_return_arrival_corrections_receipt_version_key UNIQUE (receipt_id, version),
  CONSTRAINT order_return_arrival_corrections_version_check CHECK (version >= 1),
  CONSTRAINT order_return_arrival_corrections_new_on_check CHECK (new_on <> previous_on),
  CONSTRAINT order_return_arrival_corrections_reason_check CHECK (char_length(reason) BETWEEN 1 AND 500)
);

-- One row (id = true). The writer of the setting comes in Task 4.
CREATE TABLE public.accounting_return_options (
  id boolean NOT NULL DEFAULT true,
  use_carrier_delivery_date boolean NOT NULL DEFAULT false,
  changed_at timestamptz NULL,
  changed_by uuid NULL,
  version bigint NOT NULL DEFAULT 1,
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_return_options_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_return_options_id_check CHECK (id)
);

-- The state history of a refund. abandoned / owed are the decided kinds of a cancelled refund (reason, person and
-- request key). release_shortfall (s) and carried_adjust (d) are counted once by the writer when the shop gave up the
-- refund; nobody counts them again. occurred_at is when we learned the state, never used to compare two facts.
CREATE TABLE public.accounting_refund_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  seq integer NOT NULL,
  state text NOT NULL,
  stripe_status text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NULL,
  reason text NULL,
  request_key uuid NULL,
  request_hash text NULL,
  release_shortfall integer NULL,
  carried_adjust integer NULL,
  fact_seq bigint NOT NULL,
  CONSTRAINT accounting_refund_events_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_refund_events_refund_id_fkey FOREIGN KEY (refund_id)
    REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_events_request_key_key UNIQUE (request_key),
  CONSTRAINT accounting_refund_events_fact_seq_key UNIQUE (fact_seq),
  CONSTRAINT accounting_refund_events_refund_seq_key UNIQUE (refund_id, seq),
  CONSTRAINT accounting_refund_events_refund_state_key UNIQUE (refund_id, state),
  CONSTRAINT accounting_refund_events_seq_check CHECK (seq >= 1),
  CONSTRAINT accounting_refund_events_state_check CHECK (state = ANY (ARRAY['requested', 'accepted', 'succeeded', 'failed',
    'canceled', 'abandoned', 'owed', 'error', 'settled'])),
  CONSTRAINT accounting_refund_events_stripe_status_check CHECK (char_length(stripe_status) <= 64),
  CONSTRAINT accounting_refund_events_reason_check CHECK (char_length(reason) <= 500),
  CONSTRAINT accounting_refund_events_decided_check CHECK ((state IN ('abandoned', 'owed'))
    = (reason IS NOT NULL AND actor_id IS NOT NULL AND request_key IS NOT NULL)),
  CONSTRAINT accounting_refund_events_release_shortfall_check CHECK (state = 'abandoned' OR release_shortfall IS NULL),
  CONSTRAINT accounting_refund_events_carried_adjust_check CHECK (state = 'abandoned' OR carried_adjust IS NULL)
);

-- The amounts of a refund, written once when it starts (P, Q, shipping, the link to the unit event). The price change d
-- is not here (accounting_refund_transfer_adjusts). started_at is a record only, never used to compare.
CREATE TABLE public.accounting_refund_facts (
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  source text NOT NULL,
  return_id uuid NULL,
  event_id uuid NULL,
  event_kind text NOT NULL DEFAULT 'none',
  pre_shipment_amount integer NOT NULL,
  post_shipment_amount integer NOT NULL,
  shipping_amount integer NOT NULL,
  fee_amount integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_refund_facts_pkey PRIMARY KEY (refund_id),
  CONSTRAINT accounting_refund_facts_refund_id_fkey FOREIGN KEY (refund_id)
    REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_facts_event_id_fkey FOREIGN KEY (event_id)
    REFERENCES public.order_unit_events (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_facts_event_kind_check CHECK (event_kind IN ('none', 'pre_shipment_cancel', 'return_receipt',
    'holdback_release')),
  CONSTRAINT accounting_refund_facts_pre_shipment_amount_check CHECK (pre_shipment_amount >= 0),
  CONSTRAINT accounting_refund_facts_post_shipment_amount_check CHECK (post_shipment_amount >= 0),
  CONSTRAINT accounting_refund_facts_shipping_amount_check CHECK (shipping_amount >= 0),
  CONSTRAINT accounting_refund_facts_fee_amount_check CHECK (fee_amount >= 0),
  CONSTRAINT accounting_refund_facts_return_check CHECK ((source = 'return') = (return_id IS NOT NULL)),
  CONSTRAINT accounting_refund_facts_return_pre_shipment_check CHECK (source <> 'return' OR pre_shipment_amount = 0),
  CONSTRAINT accounting_refund_facts_event_check CHECK ((event_kind = 'none') = (event_id IS NULL)),
  CONSTRAINT accounting_refund_facts_fee_check CHECK (event_kind = 'holdback_release' OR fee_amount = 0),
  CONSTRAINT accounting_refund_facts_holdback_check CHECK (event_kind <> 'holdback_release' OR pre_shipment_amount = 0)
);

-- Rule 3-2: the price change d of a remaining unit that was already shipped when the pre-shipment cancel event happened,
-- one row per unit. Keys: <event id> at the event, release:<event id>:<n> when the shop gave the refund up.
CREATE TABLE public.accounting_refund_transfer_adjusts (
  event_id uuid NOT NULL,
  adjust_key text NOT NULL,
  order_item_id uuid NOT NULL,
  unit_index integer NOT NULL,
  amount integer NOT NULL,
  fact_seq bigint NOT NULL,
  locked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_refund_transfer_adjusts_pkey PRIMARY KEY (event_id, adjust_key, order_item_id, unit_index),
  CONSTRAINT accounting_refund_transfer_adjusts_fact_seq_key UNIQUE (fact_seq),
  CONSTRAINT accounting_refund_transfer_adjusts_event_id_fkey FOREIGN KEY (event_id)
    REFERENCES public.order_unit_events (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_transfer_adjusts_unit_fkey FOREIGN KEY (order_item_id, unit_index)
    REFERENCES public.order_line_unit_amounts (order_item_id, unit_index) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_transfer_adjusts_adjust_key_check CHECK (adjust_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  CONSTRAINT accounting_refund_transfer_adjusts_amount_check CHECK (amount <> 0)
);

-- Rule 3-1: the price change of a remaining unit not shipped yet at the pre-shipment cancel event (the shipment posts the
-- price of now). Same keys as above. The sum check over this table and the allocations comes in S17 (Task 3).
CREATE TABLE public.accounting_unit_price_adjusts (
  order_item_id uuid NOT NULL,
  unit_index integer NOT NULL,
  adjust_key text NOT NULL,
  event_id uuid NOT NULL,
  amount integer NOT NULL,
  fact_seq bigint NOT NULL,
  locked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_unit_price_adjusts_pkey PRIMARY KEY (order_item_id, unit_index, adjust_key),
  CONSTRAINT accounting_unit_price_adjusts_fact_seq_key UNIQUE (fact_seq),
  CONSTRAINT accounting_unit_price_adjusts_event_id_fkey FOREIGN KEY (event_id)
    REFERENCES public.order_unit_events (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_unit_price_adjusts_unit_fkey FOREIGN KEY (order_item_id, unit_index)
    REFERENCES public.order_line_unit_amounts (order_item_id, unit_index) ON DELETE RESTRICT,
  CONSTRAINT accounting_unit_price_adjusts_adjust_key_check CHECK (adjust_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  CONSTRAINT accounting_unit_price_adjusts_amount_check CHECK (amount <> 0)
);

-- The arrival (a receipt, no refund, the goods at least the fee) and the decision of a return. A decision either starts a
-- refund (the refund; the receipt only when the receive path started it) or ends the return with 0 yen (no refund, the
-- receipt, decided 0 and no goods amount). The kind of the receipt and its return are checked by the writer (Task 4).
CREATE TABLE public.accounting_return_facts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL,
  order_id uuid NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  receipt_id uuid NULL,
  refund_id uuid NULL,
  goods_amount integer NOT NULL DEFAULT 0,
  fee_amount integer NOT NULL DEFAULT 0,
  covers_amount integer NOT NULL DEFAULT 0,
  decided_amount integer NULL,
  payable_delta integer NOT NULL DEFAULT 0,
  decided_on date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_return_facts_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_return_facts_return_id_fkey FOREIGN KEY (return_id)
    REFERENCES public.order_returns (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_return_facts_receipt_id_fkey FOREIGN KEY (receipt_id)
    REFERENCES public.order_return_receipts (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_return_facts_refund_id_fkey FOREIGN KEY (refund_id)
    REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_return_facts_return_seq_key UNIQUE (return_id, seq),
  CONSTRAINT accounting_return_facts_seq_check CHECK (seq >= 1),
  CONSTRAINT accounting_return_facts_kind_check CHECK (kind IN ('arrival', 'decision')),
  CONSTRAINT accounting_return_facts_goods_amount_check CHECK (goods_amount >= 0),
  CONSTRAINT accounting_return_facts_fee_amount_check CHECK (fee_amount >= 0),
  CONSTRAINT accounting_return_facts_covers_amount_check CHECK (covers_amount >= 0),
  CONSTRAINT accounting_return_facts_decided_amount_check CHECK (decided_amount >= 0),
  CONSTRAINT accounting_return_facts_arrival_check CHECK (kind <> 'arrival'
    OR (receipt_id IS NOT NULL AND refund_id IS NULL AND goods_amount >= fee_amount)),
  CONSTRAINT accounting_return_facts_decision_check CHECK (kind <> 'decision'
    OR (decided_amount IS NOT NULL AND decided_on IS NOT NULL
      AND (refund_id IS NOT NULL OR (receipt_id IS NOT NULL AND decided_amount = 0 AND goods_amount = 0))))
);
CREATE UNIQUE INDEX accounting_return_facts_arrival_receipt_key
  ON public.accounting_return_facts (receipt_id) WHERE kind = 'arrival';
CREATE UNIQUE INDEX accounting_return_facts_decision_refund_key
  ON public.accounting_return_facts (refund_id) WHERE kind = 'decision' AND refund_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_return_facts_decision_receipt_key
  ON public.accounting_return_facts (receipt_id) WHERE kind = 'decision';

ALTER TABLE public.order_return_arrival_corrections OWNER TO postgres;
ALTER TABLE public.accounting_return_options OWNER TO postgres;
ALTER TABLE public.accounting_refund_events OWNER TO postgres;
ALTER TABLE public.accounting_refund_facts OWNER TO postgres;
ALTER TABLE public.accounting_refund_transfer_adjusts OWNER TO postgres;
ALTER TABLE public.accounting_unit_price_adjusts OWNER TO postgres;
ALTER TABLE public.accounting_return_facts OWNER TO postgres;
ALTER TABLE public.order_return_arrival_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_return_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_refund_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_refund_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_refund_transfer_adjusts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_unit_price_adjusts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_return_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.order_return_arrival_corrections, public.accounting_return_options, public.accounting_refund_events,
  public.accounting_refund_facts, public.accounting_refund_transfer_adjusts, public.accounting_unit_price_adjusts,
  public.accounting_return_facts
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.order_return_arrival_corrections, public.accounting_return_options, public.accounting_refund_events,
  public.accounting_refund_facts, public.accounting_refund_transfer_adjusts, public.accounting_unit_price_adjusts,
  public.accounting_return_facts
TO service_role;

-- The one options row (off by default).
INSERT INTO public.accounting_return_options (id, use_carrier_delivery_date, changed_at, changed_by, version, admin_requests)
VALUES (true, false, NULL, NULL, 1, '{}'::jsonb);

-- 3. Append only (UPDATE, DELETE and TRUNCATE are refused for every role; ALWAYS so a replica-mode load cannot rewrite
--    them either). The options row is a setting and is not append only.
CREATE TRIGGER order_return_arrival_corrections_no_update_delete BEFORE UPDATE OR DELETE
  ON public.order_return_arrival_corrections FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER order_return_arrival_corrections_no_truncate BEFORE TRUNCATE
  ON public.order_return_arrival_corrections FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_events_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_refund_events FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_events_no_truncate BEFORE TRUNCATE
  ON public.accounting_refund_events FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_facts_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_refund_facts FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_facts_no_truncate BEFORE TRUNCATE
  ON public.accounting_refund_facts FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_transfer_adjusts_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_refund_transfer_adjusts FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_transfer_adjusts_no_truncate BEFORE TRUNCATE
  ON public.accounting_refund_transfer_adjusts FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_unit_price_adjusts_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_unit_price_adjusts FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_unit_price_adjusts_no_truncate BEFORE TRUNCATE
  ON public.accounting_unit_price_adjusts FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_return_facts_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_return_facts FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_return_facts_no_truncate BEFORE TRUNCATE
  ON public.accounting_return_facts FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.order_return_arrival_corrections ENABLE ALWAYS TRIGGER order_return_arrival_corrections_no_update_delete;
ALTER TABLE public.order_return_arrival_corrections ENABLE ALWAYS TRIGGER order_return_arrival_corrections_no_truncate;
ALTER TABLE public.accounting_refund_events ENABLE ALWAYS TRIGGER accounting_refund_events_no_update_delete;
ALTER TABLE public.accounting_refund_events ENABLE ALWAYS TRIGGER accounting_refund_events_no_truncate;
ALTER TABLE public.accounting_refund_facts ENABLE ALWAYS TRIGGER accounting_refund_facts_no_update_delete;
ALTER TABLE public.accounting_refund_facts ENABLE ALWAYS TRIGGER accounting_refund_facts_no_truncate;
ALTER TABLE public.accounting_refund_transfer_adjusts ENABLE ALWAYS TRIGGER accounting_refund_transfer_adjusts_no_update_delete;
ALTER TABLE public.accounting_refund_transfer_adjusts ENABLE ALWAYS TRIGGER accounting_refund_transfer_adjusts_no_truncate;
ALTER TABLE public.accounting_unit_price_adjusts ENABLE ALWAYS TRIGGER accounting_unit_price_adjusts_no_update_delete;
ALTER TABLE public.accounting_unit_price_adjusts ENABLE ALWAYS TRIGGER accounting_unit_price_adjusts_no_truncate;
ALTER TABLE public.accounting_return_facts ENABLE ALWAYS TRIGGER accounting_return_facts_no_update_delete;
ALTER TABLE public.accounting_return_facts ENABLE ALWAYS TRIGGER accounting_return_facts_no_truncate;

-- 4. The two new parked reasons (both move money; neither can be closed by hand). The rows are kept as they are.
ALTER TABLE public.accounting_pending_events DROP CONSTRAINT accounting_pending_events_reason_check,
  ADD CONSTRAINT accounting_pending_events_reason_check CHECK (reason IN (
    'payment_journal_missing', 'order_not_postable', 'amount_mismatch', 'no_order', 'units_insufficient',
    'shipment_date_mismatch', 'deferred_revenue_short', 'period_missing', 'posting_error', 'before_cutover',
    'unknown_category', 'payout_mismatch', 'dispute_refund_overlap', 'dispute_return_refund_pending',
    'dispute_withdrawal_missing', 'dispute_shipment_pending', 'shipment_lines_mismatch', 'no_revenue',
    'refund_prior_unposted', 'refund_cancel_undecided'));

-- 5. The detail keys of plan 3. A parked row is written inside the functions that record a cancel, a refund or a Stripe
--    result, so a key or value outside this list rolls the whole record back (accounting_park_event raises 22023): plan
--    3 parks only these. why is checked together with its reason. entry_date stays on period_missing / posting_error.
CREATE OR REPLACE FUNCTION private.accounting_pending_detail_valid(_reason text, _detail jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_allowed text[];
  v_key text;
  v_value jsonb;
  v_number numeric;
BEGIN
  IF _reason IS NULL OR _detail IS NULL OR pg_catalog.jsonb_typeof(_detail) <> 'object' THEN
    RETURN false;
  END IF;
  v_allowed := CASE _reason
    WHEN 'period_missing' THEN ARRAY['entry_date', 'cause']
    WHEN 'posting_error' THEN ARRAY['error_sqlstate', 'error_code', 'entry_date']
    WHEN 'amount_mismatch' THEN ARRAY['stripe_amount', 'order_total', 'mismatch']
    WHEN 'order_not_postable' THEN ARRAY['reason']
    WHEN 'payment_journal_missing' THEN ARRAY['order_count']
    WHEN 'deferred_revenue_short' THEN ARRAY['shortage']
    WHEN 'payout_mismatch' THEN ARRAY['payout_state']
    WHEN 'dispute_withdrawal_missing' THEN ARRAY['waiting_on', 'dispute_status']
    WHEN 'no_revenue' THEN ARRAY['lost_on']
    WHEN 'refund_prior_unposted' THEN ARRAY['why']
    WHEN 'refund_cancel_undecided' THEN ARRAY['refund_id', 'canceled_on']
    WHEN 'dispute_refund_overlap' THEN ARRAY['why']
    WHEN 'dispute_return_refund_pending' THEN ARRAY['why']
    ELSE ARRAY[]::text[] END;
  IF _reason = 'period_missing' AND NOT (_detail ? 'entry_date') THEN
    RETURN false;
  END IF;
  FOR v_key, v_value IN SELECT d.key, d.value FROM pg_catalog.jsonb_each(_detail) AS d(key, value) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RETURN false;
    END IF;
    IF v_key IN ('entry_date', 'lost_on', 'canceled_on') THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'string' OR (v_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN false;
      END IF;
      BEGIN
        PERFORM (v_value #>> '{}')::date;
      EXCEPTION WHEN OTHERS THEN
        RETURN false;
      END;
    ELSIF v_key IN ('stripe_amount', 'order_total', 'order_count', 'shortage') THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'number' THEN
        RETURN false;
      END IF;
      v_number := (v_value #>> '{}')::numeric;
      IF v_number < 0 OR v_number <> pg_catalog.trunc(v_number) OR v_number > 9007199254740991 THEN
        RETURN false;
      END IF;
    ELSIF pg_catalog.jsonb_typeof(v_value) <> 'string' THEN
      RETURN false;
    ELSIF v_key = 'cause' THEN
      IF (v_value #>> '{}') <> 'sole_ended_not_switched' THEN RETURN false; END IF;
    ELSIF v_key = 'error_sqlstate' THEN
      IF (v_value #>> '{}') !~ '^[0-9A-Z]{5}$' THEN RETURN false; END IF;
    ELSIF v_key = 'error_code' THEN
      IF (v_value #>> '{}') <> 'unexpected_error' AND (v_value #>> '{}') !~ '^(ACCOUNTING|GROUP_G|GROUP_H)_[A-Z0-9_]{1,80}$' THEN
        RETURN false;
      END IF;
    ELSIF v_key = 'reason' THEN
      IF (v_value #>> '{}') NOT IN ('shipping', 'units_sum', 'units_missing') THEN RETURN false; END IF;
    ELSIF v_key = 'payout_state' THEN
      IF (v_value #>> '{}') NOT IN ('payout_not_posted', 'payout_net_zero') THEN RETURN false; END IF;
    ELSIF v_key = 'waiting_on' THEN
      IF (v_value #>> '{}') NOT IN ('dispute_account_unassigned', 'dispute_withdrawn') THEN RETURN false; END IF;
    ELSIF v_key = 'dispute_status' THEN
      IF (v_value #>> '{}') !~ '^[a-z_]{1,40}$' THEN RETURN false; END IF;
    ELSIF v_key = 'mismatch' THEN
      IF (v_value #>> '{}') NOT IN ('split', 'refund_amount', 'allocation_overflow', 'unit_value_left') THEN RETURN false; END IF;
    ELSIF v_key = 'why' THEN
      IF NOT ((_reason = 'refund_prior_unposted' AND (v_value #>> '{}') IN ('return_prior', 'original', 'failure_txn_missing'))
        OR (_reason IN ('dispute_refund_overlap', 'dispute_return_refund_pending') AND (v_value #>> '{}') IN ('refund', 'return'))) THEN
        RETURN false;
      END IF;
    ELSIF v_key = 'refund_id' THEN
      IF (v_value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- 6. The dispute-hold tools. The condition lives in private.get_order_dispute_holds only; this is a thin wrapper.
CREATE FUNCTION private.accounting_dispute_holds(_order_ids uuid[]) RETURNS TABLE(order_id uuid, dispute_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT h.order_id, h.dispute_id FROM private.get_order_dispute_holds(_order_ids) AS h
$$;

-- Refuse when a dispute holds one of the orders. The DETAIL carries the number of orders only.
CREATE FUNCTION private.accounting_assert_no_dispute_hold(_order_ids uuid[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count bigint;
BEGIN
  SELECT pg_catalog.count(DISTINCT h.order_id) INTO v_count FROM private.accounting_dispute_holds(_order_ids) AS h;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_DISPUTE_HOLD' USING ERRCODE = '55000', DETAIL = 'order_count=' || v_count::text;
  END IF;
END;
$$;

ALTER FUNCTION private.accounting_dispute_holds(uuid[]) OWNER TO postgres;
ALTER FUNCTION private.accounting_assert_no_dispute_hold(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.accounting_dispute_holds(uuid[]), private.accounting_assert_no_dispute_hold(uuid[])
FROM PUBLIC, anon, authenticated, service_role;
-- ACC_S15_BODY_END

-- ACC_S15_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (columns, constraint definitions, triggers, ACL entries, has_*_privilege, function
-- attributes), never ACL text serialization. Foreign keys are compared by column and table names, so the result does
-- not depend on the caller's search_path.
DO $acc_s15_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_tables CONSTANT text[] := ARRAY['order_return_arrival_corrections', 'accounting_return_options',
    'accounting_refund_events', 'accounting_refund_facts', 'accounting_refund_transfer_adjusts',
    'accounting_unit_price_adjusts', 'accounting_return_facts'];
  v_append_only CONSTANT text[] := ARRAY['order_return_arrival_corrections', 'accounting_refund_events',
    'accounting_refund_facts', 'accounting_refund_transfer_adjusts', 'accounting_unit_price_adjusts',
    'accounting_return_facts'];
  e record;
  p record;
  v_oid oid;
  v_stage text;
  v_baseline jsonb;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s15_existing_dml_allowlist';
  -- The baseline must exist with one well-formed row (else acc_s15_existing_dml_allowlist).
  IF pg_catalog.to_regclass('pg_temp.accounting_s15_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s15_baseline) <> 1 THEN
    v_failed := 'acc_s15_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s15_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['receipts', 'pending_events', 'arrival_corrections', 'refund_events',
          'refund_facts', 'refund_transfer_adjusts', 'unit_price_adjusts', 'return_facts']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s15_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s15_tables';
  -- acc_s15_tables: the seven tables exist in public, are ordinary tables owned by postgres, and have exactly these
  -- columns (name, type, NOT NULL, default) in this order.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('order_return_arrival_corrections', 'id uuid not null default gen_random_uuid(), receipt_id uuid not null, version integer not null, previous_on date not null, new_on date not null, reason text not null, actor_id uuid not null, request_key uuid not null, request_hash text not null, created_at timestamp with time zone not null default now()'),
    ('accounting_return_options', 'id boolean not null default true, use_carrier_delivery_date boolean not null default false, changed_at timestamp with time zone, changed_by uuid, version bigint not null default 1, admin_requests jsonb not null default ''{}''::jsonb'),
    ('accounting_refund_events', 'id uuid not null default gen_random_uuid(), refund_id uuid not null, order_id uuid not null, seq integer not null, state text not null, stripe_status text, occurred_at timestamp with time zone not null default now(), actor_id uuid, reason text, request_key uuid, request_hash text, release_shortfall integer, carried_adjust integer, fact_seq bigint not null'),
    ('accounting_refund_facts', 'refund_id uuid not null, order_id uuid not null, source text not null, return_id uuid, event_id uuid, event_kind text not null default ''none''::text, pre_shipment_amount integer not null, post_shipment_amount integer not null, shipping_amount integer not null, fee_amount integer not null default 0, started_at timestamp with time zone not null default now(), created_at timestamp with time zone not null default now()'),
    ('accounting_refund_transfer_adjusts', 'event_id uuid not null, adjust_key text not null, order_item_id uuid not null, unit_index integer not null, amount integer not null, fact_seq bigint not null, locked_at timestamp with time zone not null, created_at timestamp with time zone not null default now()'),
    ('accounting_unit_price_adjusts', 'order_item_id uuid not null, unit_index integer not null, adjust_key text not null, event_id uuid not null, amount integer not null, fact_seq bigint not null, locked_at timestamp with time zone not null, created_at timestamp with time zone not null default now()'),
    ('accounting_return_facts', 'id uuid not null default gen_random_uuid(), return_id uuid not null, order_id uuid not null, seq integer not null, kind text not null, receipt_id uuid, refund_id uuid, goods_amount integer not null default 0, fee_amount integer not null default 0, covers_amount integer not null default 0, decided_amount integer, payable_delta integer not null default 0, decided_on date, created_at timestamp with time zone not null default now()')
  ) AS t(name, columns)
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
  WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns) THEN
    v_failed := 'acc_s15_tables';
  END IF;

  v_stage := 'acc_s15_constraints';
  -- acc_s15_constraints: every CHECK / PRIMARY KEY / UNIQUE / FOREIGN KEY below exists, is validated and is not
  -- deferrable; the seven tables have no other one (and no constraint trigger); the three partial unique indexes of the
  -- return facts exist as they were made.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_pkey', 'p', 'id'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_receipt_id_fkey', 'f', 'receipt_id>public.order_return_receipts(id)ras'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_request_key_key', 'u', 'request_key'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_receipt_version_key', 'u', 'receipt_id,version'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_version_check', 'c', 'CHECK ((version >= 1))'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_new_on_check', 'c', 'CHECK ((new_on <> previous_on))'),
    ('order_return_arrival_corrections', 'order_return_arrival_corrections_reason_check', 'c', 'CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 500)))'),
    ('accounting_return_options', 'accounting_return_options_pkey', 'p', 'id'),
    ('accounting_return_options', 'accounting_return_options_id_check', 'c', 'CHECK (id)'),
    ('accounting_refund_events', 'accounting_refund_events_pkey', 'p', 'id'),
    ('accounting_refund_events', 'accounting_refund_events_refund_id_fkey', 'f', 'refund_id>public.order_refunds(id)ras'),
    ('accounting_refund_events', 'accounting_refund_events_request_key_key', 'u', 'request_key'),
    ('accounting_refund_events', 'accounting_refund_events_fact_seq_key', 'u', 'fact_seq'),
    ('accounting_refund_events', 'accounting_refund_events_refund_seq_key', 'u', 'refund_id,seq'),
    ('accounting_refund_events', 'accounting_refund_events_refund_state_key', 'u', 'refund_id,state'),
    ('accounting_refund_events', 'accounting_refund_events_seq_check', 'c', 'CHECK ((seq >= 1))'),
    ('accounting_refund_events', 'accounting_refund_events_state_check', 'c', 'CHECK ((state = ANY (ARRAY[''requested''::text, ''accepted''::text, ''succeeded''::text, ''failed''::text, ''canceled''::text, ''abandoned''::text, ''owed''::text, ''error''::text, ''settled''::text])))'),
    ('accounting_refund_events', 'accounting_refund_events_stripe_status_check', 'c', 'CHECK ((char_length(stripe_status) <= 64))'),
    ('accounting_refund_events', 'accounting_refund_events_reason_check', 'c', 'CHECK ((char_length(reason) <= 500))'),
    ('accounting_refund_events', 'accounting_refund_events_decided_check', 'c', 'CHECK (((state = ANY (ARRAY[''abandoned''::text, ''owed''::text])) = ((reason IS NOT NULL) AND (actor_id IS NOT NULL) AND (request_key IS NOT NULL))))'),
    ('accounting_refund_events', 'accounting_refund_events_release_shortfall_check', 'c', 'CHECK (((state = ''abandoned''::text) OR (release_shortfall IS NULL)))'),
    ('accounting_refund_events', 'accounting_refund_events_carried_adjust_check', 'c', 'CHECK (((state = ''abandoned''::text) OR (carried_adjust IS NULL)))'),
    ('accounting_refund_facts', 'accounting_refund_facts_pkey', 'p', 'refund_id'),
    ('accounting_refund_facts', 'accounting_refund_facts_refund_id_fkey', 'f', 'refund_id>public.order_refunds(id)ras'),
    ('accounting_refund_facts', 'accounting_refund_facts_event_id_fkey', 'f', 'event_id>public.order_unit_events(id)ras'),
    ('accounting_refund_facts', 'accounting_refund_facts_event_kind_check', 'c', 'CHECK ((event_kind = ANY (ARRAY[''none''::text, ''pre_shipment_cancel''::text, ''return_receipt''::text, ''holdback_release''::text])))'),
    ('accounting_refund_facts', 'accounting_refund_facts_pre_shipment_amount_check', 'c', 'CHECK ((pre_shipment_amount >= 0))'),
    ('accounting_refund_facts', 'accounting_refund_facts_post_shipment_amount_check', 'c', 'CHECK ((post_shipment_amount >= 0))'),
    ('accounting_refund_facts', 'accounting_refund_facts_shipping_amount_check', 'c', 'CHECK ((shipping_amount >= 0))'),
    ('accounting_refund_facts', 'accounting_refund_facts_fee_amount_check', 'c', 'CHECK ((fee_amount >= 0))'),
    ('accounting_refund_facts', 'accounting_refund_facts_return_check', 'c', 'CHECK (((source = ''return''::text) = (return_id IS NOT NULL)))'),
    ('accounting_refund_facts', 'accounting_refund_facts_return_pre_shipment_check', 'c', 'CHECK (((source <> ''return''::text) OR (pre_shipment_amount = 0)))'),
    ('accounting_refund_facts', 'accounting_refund_facts_event_check', 'c', 'CHECK (((event_kind = ''none''::text) = (event_id IS NULL)))'),
    ('accounting_refund_facts', 'accounting_refund_facts_fee_check', 'c', 'CHECK (((event_kind = ''holdback_release''::text) OR (fee_amount = 0)))'),
    ('accounting_refund_facts', 'accounting_refund_facts_holdback_check', 'c', 'CHECK (((event_kind <> ''holdback_release''::text) OR (pre_shipment_amount = 0)))'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_pkey', 'p', 'event_id,adjust_key,order_item_id,unit_index'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_fact_seq_key', 'u', 'fact_seq'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_event_id_fkey', 'f', 'event_id>public.order_unit_events(id)ras'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_unit_fkey', 'f', 'order_item_id,unit_index>public.order_line_unit_amounts(order_item_id,unit_index)ras'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_adjust_key_check', 'c', 'CHECK ((adjust_key ~ ''^[A-Za-z0-9_.:-]{1,200}$''::text))'),
    ('accounting_refund_transfer_adjusts', 'accounting_refund_transfer_adjusts_amount_check', 'c', 'CHECK ((amount <> 0))'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_pkey', 'p', 'order_item_id,unit_index,adjust_key'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_fact_seq_key', 'u', 'fact_seq'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_event_id_fkey', 'f', 'event_id>public.order_unit_events(id)ras'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_unit_fkey', 'f', 'order_item_id,unit_index>public.order_line_unit_amounts(order_item_id,unit_index)ras'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_adjust_key_check', 'c', 'CHECK ((adjust_key ~ ''^[A-Za-z0-9_.:-]{1,200}$''::text))'),
    ('accounting_unit_price_adjusts', 'accounting_unit_price_adjusts_amount_check', 'c', 'CHECK ((amount <> 0))'),
    ('accounting_return_facts', 'accounting_return_facts_pkey', 'p', 'id'),
    ('accounting_return_facts', 'accounting_return_facts_return_id_fkey', 'f', 'return_id>public.order_returns(id)ras'),
    ('accounting_return_facts', 'accounting_return_facts_receipt_id_fkey', 'f', 'receipt_id>public.order_return_receipts(id)ras'),
    ('accounting_return_facts', 'accounting_return_facts_refund_id_fkey', 'f', 'refund_id>public.order_refunds(id)ras'),
    ('accounting_return_facts', 'accounting_return_facts_return_seq_key', 'u', 'return_id,seq'),
    ('accounting_return_facts', 'accounting_return_facts_seq_check', 'c', 'CHECK ((seq >= 1))'),
    ('accounting_return_facts', 'accounting_return_facts_kind_check', 'c', 'CHECK ((kind = ANY (ARRAY[''arrival''::text, ''decision''::text])))'),
    ('accounting_return_facts', 'accounting_return_facts_goods_amount_check', 'c', 'CHECK ((goods_amount >= 0))'),
    ('accounting_return_facts', 'accounting_return_facts_fee_amount_check', 'c', 'CHECK ((fee_amount >= 0))'),
    ('accounting_return_facts', 'accounting_return_facts_covers_amount_check', 'c', 'CHECK ((covers_amount >= 0))'),
    ('accounting_return_facts', 'accounting_return_facts_decided_amount_check', 'c', 'CHECK ((decided_amount >= 0))'),
    ('accounting_return_facts', 'accounting_return_facts_arrival_check', 'c', 'CHECK (((kind <> ''arrival''::text) OR ((receipt_id IS NOT NULL) AND (refund_id IS NULL) AND (goods_amount >= fee_amount))))'),
    ('accounting_return_facts', 'accounting_return_facts_decision_check', 'c', 'CHECK (((kind <> ''decision''::text) OR ((decided_amount IS NOT NULL) AND (decided_on IS NOT NULL) AND ((refund_id IS NOT NULL) OR ((receipt_id IS NOT NULL) AND (decided_amount = 0) AND (goods_amount = 0))))))')
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
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)) <> 60
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS x ON x.oid = i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid = x.relam
      WHERE i.indrelid = 'public.accounting_return_facts'::regclass
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND am.amname = 'btree'
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conindid = i.indexrelid)
        AND (x.relname::text, (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.num),
          COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '')) IN (
          ('accounting_return_facts_arrival_receipt_key', 'receipt_id', '(kind = ''arrival''::text)'),
          ('accounting_return_facts_decision_refund_key', 'refund_id', '((kind = ''decision''::text) AND (refund_id IS NOT NULL))'),
          ('accounting_return_facts_decision_receipt_key', 'receipt_id', '(kind = ''decision''::text)'))) <> 3) THEN
    v_failed := 'acc_s15_constraints';
  END IF;

  v_stage := 'acc_s15_immutable';
  -- acc_s15_immutable: BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) on the six append-only tables,
  -- enabled ALWAYS (also under session_replication_role = replica), calling the reject function, and no other user
  -- trigger on the seven tables.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM pg_catalog.unnest(v_append_only) AS t(name)
      CROSS JOIN (VALUES ('_no_update_delete', 27), ('_no_truncate', 34)) AS k(suffix, kind)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
        WHERE g.tgrelid = pg_catalog.to_regclass('public.' || t.name) AND g.tgname::text = t.name || k.suffix
          AND g.tgfoid = 'private.reject_accounting_mutation()'::regprocedure AND g.tgtype = k.kind
          AND g.tgenabled = 'A' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
          AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT pg_catalog.to_regclass('public.' || t)
        FROM pg_catalog.unnest(v_tables) AS t)) <> 12) THEN
    v_failed := 'acc_s15_immutable';
  END IF;

  v_stage := 'acc_s15_rls_acl';
  -- acc_s15_rls_acl: RLS on and no policy; PUBLIC, anon and authenticated hold nothing (table or column);
  -- service_role holds SELECT and nothing else.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
          OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT'))
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type = 'SELECT')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s15_rls_acl';
  END IF;

  v_stage := 'acc_s15_receipt_column';
  -- acc_s15_receipt_column: arrived_on is the last column of the receipts, a date NOT NULL whose default is the day of
  -- Japan of now(), with no grant of its own; the receipts still refuse UPDATE, DELETE and TRUNCATE.
  IF v_failed IS NULL AND (
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.order_return_receipts'::regclass AND a.attname = 'arrived_on' AND NOT a.attisdropped
        AND a.atttypid = 'date'::regtype AND a.attnotnull AND a.attacl IS NULL
        AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '((now() AT TIME ZONE ''Asia/Tokyo''::text))::date'
        AND a.attnum = (SELECT pg_catalog.max(b.attnum) FROM pg_catalog.pg_attribute AS b
          WHERE b.attrelid = a.attrelid AND b.attnum > 0 AND NOT b.attisdropped))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = 'public.order_return_receipts'::regclass AND NOT g.tgisinternal
        AND g.tgfoid = 'private.reject_order_return_record_change()'::regprocedure AND g.tgenabled <> 'D'
        AND ((g.tgname = 'order_return_receipts_no_change' AND g.tgtype = 27)
          OR (g.tgname = 'order_return_receipts_no_truncate' AND g.tgtype = 34))) <> 2
    OR pg_catalog.has_column_privilege('anon', 'public.order_return_receipts', 'arrived_on', 'SELECT')
    OR pg_catalog.has_column_privilege('authenticated', 'public.order_return_receipts', 'arrived_on', 'SELECT')
    OR NOT pg_catalog.has_column_privilege('service_role', 'public.order_return_receipts', 'arrived_on', 'SELECT')) THEN
    v_failed := 'acc_s15_receipt_column';
  END IF;

  v_stage := 'acc_s15_receipt_backfill';
  -- acc_s15_receipt_backfill: this migration wrote no receipt (the receipts hold what the baseline counted; zero at apply
  -- time, so no row was given a made-up arrival date).
  IF v_failed IS NULL
    AND (SELECT pg_catalog.count(*) FROM public.order_return_receipts) IS DISTINCT FROM (v_baseline ->> 'receipts')::bigint THEN
    v_failed := 'acc_s15_receipt_backfill';
  END IF;

  v_stage := 'acc_s15_pending_reason_check';
  -- acc_s15_pending_reason_check: the reason CHECK names the 18 reasons of plan 2 and the two of plan 3, and nothing else.
  IF v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.accounting_pending_events'::regclass AND c.conname = 'accounting_pending_events_reason_check'
        AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          = 'CHECK ((reason = ANY (ARRAY[''payment_journal_missing''::text, ''order_not_postable''::text, ''amount_mismatch''::text, ''no_order''::text, ''units_insufficient''::text, ''shipment_date_mismatch''::text, ''deferred_revenue_short''::text, ''period_missing''::text, ''posting_error''::text, ''before_cutover''::text, ''unknown_category''::text, ''payout_mismatch''::text, ''dispute_refund_overlap''::text, ''dispute_return_refund_pending''::text, ''dispute_withdrawal_missing''::text, ''dispute_shipment_pending''::text, ''shipment_lines_mismatch''::text, ''no_revenue''::text, ''refund_prior_unposted''::text, ''refund_cancel_undecided''::text])))') <> 1 THEN
    v_failed := 'acc_s15_pending_reason_check';
  END IF;

  v_stage := 'acc_s15_pending_detail_valid';
  -- acc_s15_pending_detail_valid: the detail list is the text of this file (md5 with the white space removed) and keeps
  -- the attributes and the ACL of plan 2 (owner postgres, SECURITY DEFINER, IMMUTABLE, plpgsql, boolean, the two
  -- arguments, search_path '', one function of the name, no EXECUTE for PUBLIC, anon, authenticated or service_role);
  -- the parking tool still calls it.
  v_oid := pg_catalog.to_regprocedure('private.accounting_pending_detail_valid(text,jsonb)');
  IF v_failed IS NULL AND (v_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid AND f.proowner = 'postgres'::regrole AND f.prosecdef AND f.provolatile = 'i' AND l.lanname = 'plpgsql'
        AND f.prorettype = 'boolean'::regtype AND NOT f.proretset AND f.prokind = 'f' AND NOT f.proisstrict AND NOT f.proleakproof
        AND f.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
        AND pg_catalog.array_to_string(f.proargnames, ',') = '_reason,_detail' AND f.pronargdefaults = 0
        AND pg_catalog.md5(pg_catalog.regexp_replace(f.prosrc, '[[:space:]]+', '', 'g')) = '603ac7e9dd93f22a6c8fbfc54d68726e')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
      WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_pending_detail_valid') <> 1
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
      WHERE pg_catalog.has_function_privilege(r.role, v_oid, 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f,
        pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE f.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_park_event(text,text,text,uuid,text,jsonb)')
        AND pg_catalog.strpos(f.prosrc, 'private.accounting_pending_detail_valid(_reason,') > 0)) THEN
    v_failed := 'acc_s15_pending_detail_valid';
  END IF;

  v_stage := 'acc_s15_hold_tools';
  -- acc_s15_hold_tools: the two tools are owned by postgres, SECURITY DEFINER, STABLE, search_path '', one function per
  -- name, no public entry, no EXECUTE for any role; the holds tool is the thin wrapper of get_order_dispute_holds.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('accounting_dispute_holds(uuid[])', 'sql', 'record', true, '_order_ids,order_id,dispute_id'),
      ('accounting_assert_no_dispute_hold(uuid[])', 'plpgsql', 'void', false, '_order_ids')
    ) AS x(signature, language, result_type, retset, arg_names)
    LOOP
      v_oid := pg_catalog.to_regprocedure('private.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s15_hold_tools'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR NOT p.prosecdef OR p.provolatile <> 's' OR p.lanname <> e.language
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset IS DISTINCT FROM e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames, ','), '') <> e.arg_names OR p.pronargdefaults <> 0
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = p.proname)
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
          WHERE pg_catalog.has_function_privilege(r.role, v_oid, 'EXECUTE'))
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        v_failed := 'acc_s15_hold_tools'; EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_failed IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
    WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_dispute_holds(uuid[])')
      AND pg_catalog.regexp_replace(pg_catalog.lower(f.prosrc), '[[:space:];]', '', 'g')
        = 'selecth.order_id,h.dispute_idfromprivate.get_order_dispute_holds(_order_ids)ash') THEN
    v_failed := 'acc_s15_hold_tools';
  END IF;

  v_stage := 'acc_s15_existing_dml_allowlist';
  -- acc_s15_existing_dml_allowlist: the only row this migration writes is the options row (exactly one, id true). The
  -- six append-only tables and the parked rows hold what the baseline counted (zero at apply time).
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_return_options) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.accounting_return_options AS o WHERE o.id)
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.order_return_arrival_corrections)
      IS DISTINCT FROM (v_baseline ->> 'arrival_corrections')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_events) IS DISTINCT FROM (v_baseline ->> 'refund_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_facts) IS DISTINCT FROM (v_baseline ->> 'refund_facts')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_transfer_adjusts)
      IS DISTINCT FROM (v_baseline ->> 'refund_transfer_adjusts')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_unit_price_adjusts)
      IS DISTINCT FROM (v_baseline ->> 'unit_price_adjusts')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_return_facts) IS DISTINCT FROM (v_baseline ->> 'return_facts')::bigint) THEN
    v_failed := 'acc_s15_existing_dml_allowlist';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s15_tables'), HINT = SQLSTATE;
END;
$acc_s15_final$;
-- ACC_S15_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
