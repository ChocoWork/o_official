BEGIN;
-- Accounting plan 2 S12 (FREQ-571 AC-01..AC-06, FREQ-569 AC-04): the read functions of the order intake (design 8: "order intake" =
-- orders that were paid, minus the cancels before shipment), the order backlog (the deferred revenue 2150 of the orders), the
-- two-step reconciliation with the books (8-g, 8-g2), and the lists of the deferred revenue carried over and of its anomalies (2-a, 2-e).
-- Read only: this file creates no table, writes no row and changes no group G / H / returns / refund object. Every function is
-- STABLE, takes no actor and is granted to service_role only (private body + public INVOKER entry); the tools are owner only. No
-- function returns a name, an e-mail address or an address of a customer.
--
-- The source of every figure is the saved journal (accounting_journal_entries / accounting_journal_lines), the original entries and
-- the reversal entries alike. A reversal entry (event_kind reversal) counts as the kind and the dedupe key of the entry it reverses
-- (private.accounting_effective_lines), on its own day and with the debit and the credit swapped, so an original and its reversal add
-- up to 0 and nothing is taken twice (the "ignore the reversed original" way is not used with it).
--
-- Where the "from the beginning" figures start (Task 4 review M5, Ruling P2-M8): private.accounting_read_start() = the earliest
-- accounting period starts_on, else accounting_settings.cutover_on. A line dated before it is never read, so no row from before the
-- cutover mixes into a bucket after it (the bucket "before the cutover" is not shown; the books of that time are not orders).
--
-- Reads (public.<name> calls private.<name>):
--   list_order_intake_events(_from date, _to date, _limit integer DEFAULT 5000, _after_date date DEFAULT NULL, _after_key text DEFAULT NULL)
--     -> {events:[{order_id,event_date,kind,amount,key}], next_after_date, next_after_key}. The days are entry_date (Japan days).
--     Signed amounts. kind:
--       payment (+)                     2150 credit - debit of a payment_confirmed entry (and its reversal).
--       pre_shipment_cancel (-)         2150 credit - debit of a pre_shipment_refund entry (and its reversal); zero until plan 3 posts them.
--       dispute_unshipped (-)           a dispute whose loss is confirmed: U (2150 debit - credit of its withdrawal entries) minus R (2150
--                                       credit - debit of its early reversal entries, the memo dispute_reversal_kind:R of the 1160 line),
--                                       on the day of the confirmed entry, or, when that entry was closed as no_revenue, on the lost_on of the
--                                       resolved pending row (both are the day C used, so a later change of the dispute tools cannot make
--                                       the read disagree with the entries). Amount -(U - R) when it is not 0.
--       dispute_unshipped_restored (+)  2150 credit - debit of a late reversal entry (memo dispute_reversal_kind:L), on its own day. An
--                                       early reversal (R) is not added: it is already taken off U.
--     key = <entry_id>:<line_no>; for dispute_unshipped <confirmed entry id or pending row id>:0. Paged in (event_date, key COLLATE "C") order;
--     _limit 1..5000. Bad arguments: ACCOUNTING_ARGUMENT_INVALID / 22023.
--   get_intake_breakdown(_from date, _to date) -> {subtotal_before_discount, discount, shipping, payment, pre_shipment_cancel,
--     dispute_unshipped, dispute_unshipped_restored, intake, order_count, breakdown_ok}. subtotal / discount / shipping are the sums of
--     orders.subtotal_amount / discount_amount / shipping_amount of the orders whose payment events add up to something other than 0
--     in the window (order_count of them). pre_shipment_cancel and dispute_unshipped are signed; dispute_unshipped is the deduction
--     and the restoration together (dispute_unshipped_restored is the restoring part alone). intake = payment + pre_shipment_cancel
--     + dispute_unshipped. breakdown_ok = (subtotal - discount + shipping + pre_shipment_cancel + dispute_unshipped = intake). The returns
--     after shipment and the return fee revenue are neither added nor taken off.
--   get_order_backlog(_as_of date) -> {backlog_total, order_count}: the sum of 2150 credit - debit of the lines that carry an order id up to
--     _as_of (all orders; order_count = the orders whose balance is not 0).
--   get_intake_reconciliation(_from date, _to date) -> one flat object holding the two steps (the keys do not collide):
--     step 1  opening_backlog (as of _from - 1), intake, sales_before_return (4010 credit - debit with an order id of shipment_confirmed /
--             shipment_redated entries and their reversals), closing_backlog (as of _to, read, not computed), exceptions
--             [{kind,label_key,amount[,event_kind]}], unexplained = closing_backlog - (opening_backlog + intake - sales_before_return + sum of exceptions).
--             exceptions: dispute_pending = the 2150 change of the withdrawal entries and the early reversals in the window minus the
--             dispute_unshipped events of the window (the part taken off 2150 at the withdrawal that the intake did not take off yet,
--             and the other way round); return_refund_2130 = the 2150 change of the entries of the other kinds that also hold a 2130 line;
--             other = one row per entry kind not named above that moved an order's 2150 (event_kind). 0 or not, the first two rows are
--             always there; other rows only when the amount is not 0. label_key is the kind (the screen turns it into a sentence).
--     step 2  returns (4020 debit - credit with an order id), booked_sales_net_orders (4010 credit - debit with an order id minus returns),
--             return_fee_revenue_4050 (4050 credit - debit), other_4010 (4010 without an order id), other_4020 (4020 without an order id),
--             book_sales_total (4010 - 4020, 4050 left out) = booked_sales_net_orders + other_4010 - other_4020,
--             unexplained2 = (sales_before_return - returns) - booked_sales_net_orders,
--             dispute_confirmed_by_account [{account_code,sub_account,amount}] (debit - credit of the dispute entries on every account but 1160,
--             2150 and the pending sub-account: the confirmed amount on the account of the setting, or on 1470 dispute_confirmed_unassigned
--             until it is assigned, net of the late reversals).
--   list_deferred_revenue(_as_of date, _limit integer DEFAULT 100, _after_order uuid DEFAULT NULL) -> {orders:[{order_id,order_number,balance,
--     paid_on,unshipped_units,states}], next_after_order, total_balance}: the orders whose 2150 balance as of _as_of is above 0, in order id
--     order, _limit 1..200; total_balance is the sum over all of them. states / unshipped_units come from private.list_admin_order_item_states
--     (the present state of the units of the lines of kind order that are not sent yet: ready, in_production, cancel_requested, unpaid,
--     payment_expired).
--   list_deferred_revenue_anomalies() -> {anomalies:[{order_id,order_number,balance,reason}]}: reason negative_balance (2150 below 0), or
--     balance_after_all_shipped_or_refunded (every unit sent or with no value left, but the balance is not 0).
--
-- ROLLBACK (this file writes no row): DROP FUNCTION public.list_deferred_revenue_anomalies(), public.list_deferred_revenue(date,integer,uuid),
--   public.get_intake_reconciliation(date,date), public.get_order_backlog(date), public.get_intake_breakdown(date,date),
--   public.list_order_intake_events(date,date,integer,date,text), private.list_deferred_revenue_anomalies(),
--   private.list_deferred_revenue(date,integer,uuid), private.get_intake_reconciliation(date,date), private.get_order_backlog(date),
--   private.get_intake_breakdown(date,date), private.list_order_intake_events(date,date,integer,date,text),
--   private.accounting_intake_events(date,date), private.accounting_order_balances(date), private.accounting_effective_lines(date,date),
--   private.accounting_read_start();

-- ACC_S12_BODY_BEGIN
-- 0. The baseline the final assert compares with: this file writes no entry, line, parked row or period. A replay of the assert (tests)
--    pins the current state here first (pinAccountingS12Baseline).
CREATE TEMP TABLE accounting_s12_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s12_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods));

-- 1. The tools (owner only).
-- Where the reads that sum from the beginning start.
CREATE FUNCTION private.accounting_read_start() RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT pg_catalog.min(p.starts_on) FROM public.accounting_periods AS p),
    (SELECT s.cutover_on FROM public.accounting_settings AS s WHERE s.id = 1))
$$;

-- Every saved line between two days (NULL _from = from the start of the reads), with the kind and the dedupe key of the entry it
-- belongs to: a reversal entry takes the kind and the key of the entry it reverses.
CREATE FUNCTION private.accounting_effective_lines(_from date, _to date)
RETURNS TABLE(entry_id uuid, line_no smallint, entry_date date, account_code text, sub_account text, debit bigint, credit bigint,
  order_id uuid, memo text, eff_kind text, eff_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT l.entry_id, l.line_no, e.entry_date, l.account_code, l.sub_account, l.debit, l.credit, l.order_id, l.memo,
    COALESCE(o.event_kind, e.event_kind), COALESCE(o.dedupe_key, e.dedupe_key)
  FROM public.accounting_journal_entries AS e
  JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
  LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
  WHERE e.entry_date >= GREATEST(_from, private.accounting_read_start()) AND e.entry_date <= _to
$$;

-- The 2150 balance of every order that has a line, as of a day.
CREATE FUNCTION private.accounting_order_balances(_as_of date)
RETURNS TABLE(order_id uuid, balance bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT x.order_id, pg_catalog.sum(x.credit - x.debit)::bigint
  FROM private.accounting_effective_lines(NULL, _as_of) AS x
  WHERE x.account_code = '2150' AND x.order_id IS NOT NULL
  GROUP BY x.order_id
$$;

-- The intake events of a window, unpaged (the signed amounts, see the header).
CREATE FUNCTION private.accounting_intake_events(_from date, _to date)
RETURNS TABLE(order_id uuid, event_date date, kind text, amount bigint, key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH lines AS (
    SELECT * FROM private.accounting_effective_lines(_from, _to)
  ), line_events AS (
    SELECT b.order_id, b.entry_date AS event_date,
      CASE b.eff_kind WHEN 'payment_confirmed' THEN 'payment' WHEN 'pre_shipment_refund' THEN 'pre_shipment_cancel'
        ELSE 'dispute_unshipped_restored' END AS kind,
      (b.credit - b.debit)::bigint AS amount, b.entry_id::text || ':' || b.line_no::text AS key
    FROM lines AS b
    WHERE b.account_code = '2150' AND b.order_id IS NOT NULL
      AND (b.eff_kind IN ('payment_confirmed', 'pre_shipment_refund')
        OR (b.eff_kind = 'dispute_event' AND pg_catalog.split_part(b.eff_key, ':', 3) = 'reversal'
          AND EXISTS (SELECT 1 FROM lines AS m WHERE m.entry_id = b.entry_id AND m.account_code = '1160'
            AND m.memo = 'dispute_reversal_kind:L')))
  ), dispute_lines AS (
    SELECT pg_catalog.split_part(d.eff_key, ':', 2) AS dispute_id, pg_catalog.split_part(d.eff_key, ':', 3) AS stage,
      d.order_id, d.debit, d.credit,
      EXISTS (SELECT 1 FROM public.accounting_journal_lines AS m WHERE m.entry_id = d.entry_id AND m.account_code = '1160'
        AND m.memo = 'dispute_reversal_kind:R') AS is_early
    FROM private.accounting_effective_lines(NULL, 'infinity'::date) AS d
    WHERE d.account_code = '2150' AND d.order_id IS NOT NULL AND d.eff_kind = 'dispute_event'
  ), per_dispute AS (
    SELECT dl.dispute_id, pg_catalog.min(dl.order_id::text)::uuid AS order_id,
      COALESCE(pg_catalog.sum(dl.debit - dl.credit) FILTER (WHERE dl.stage = 'withdrawn'), 0) AS unshipped,
      COALESCE(pg_catalog.sum(dl.credit - dl.debit) FILTER (WHERE dl.stage = 'reversal' AND dl.is_early), 0) AS returned_early
    FROM dispute_lines AS dl
    GROUP BY dl.dispute_id
  ), confirmed AS (
    SELECT pd.order_id, COALESCE(c.entry_date, n.lost_on) AS confirm_date, COALESCE(c.id, n.id)::text || ':0' AS key,
      (pd.unshipped - pd.returned_early)::bigint AS pending
    FROM per_dispute AS pd
    LEFT JOIN LATERAL (
      SELECT ce.id, ce.entry_date FROM public.accounting_journal_entries AS ce
      WHERE ce.dedupe_key = 'dispute_event:' || pd.dispute_id || ':confirmed:lost'
    ) AS c ON true
    LEFT JOIN LATERAL (
      SELECT p.id, (p.detail ->> 'lost_on')::date AS lost_on FROM public.accounting_pending_events AS p
      WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = pd.dispute_id
        AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL AND (p.detail ->> 'lost_on') IS NOT NULL
    ) AS n ON true
    WHERE c.id IS NOT NULL OR n.id IS NOT NULL
  )
  SELECT le.order_id, le.event_date, le.kind, le.amount, le.key FROM line_events AS le
  UNION ALL
  SELECT cf.order_id, cf.confirm_date, 'dispute_unshipped', -cf.pending, cf.key FROM confirmed AS cf
  WHERE cf.pending <> 0 AND cf.confirm_date >= GREATEST(_from, private.accounting_read_start()) AND cf.confirm_date <= _to
$$;

-- 2. The reads (private bodies).
CREATE FUNCTION private.list_order_intake_events(_from date, _to date, _limit integer DEFAULT 5000,
  _after_date date DEFAULT NULL, _after_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_events jsonb;
  v_more boolean;
  v_last_date date;
  v_last_key text;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to OR _limit IS NULL OR _limit < 1 OR _limit > 5000
    OR (_after_date IS NULL) <> (_after_key IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_id', n.order_id,
      'event_date', pg_catalog.to_char(n.event_date, 'YYYY-MM-DD'), 'kind', n.kind, 'amount', n.amount, 'key', n.key)
      ORDER BY n.rn) FILTER (WHERE n.rn <= _limit), '[]'::jsonb),
    pg_catalog.count(*) > _limit,
    (pg_catalog.array_agg(n.event_date ORDER BY n.rn) FILTER (WHERE n.rn = _limit))[1],
    (pg_catalog.array_agg(n.key ORDER BY n.rn) FILTER (WHERE n.rn = _limit))[1]
  INTO v_events, v_more, v_last_date, v_last_key
  FROM (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.event_date, p.key COLLATE "C") AS rn
    FROM (
      SELECT e.order_id, e.event_date, e.kind, e.amount, e.key FROM private.accounting_intake_events(_from, _to) AS e
      WHERE _after_date IS NULL OR e.event_date > _after_date OR (e.event_date = _after_date AND e.key COLLATE "C" > _after_key COLLATE "C")
      ORDER BY e.event_date, e.key COLLATE "C"
      LIMIT _limit + 1
    ) AS p
  ) AS n;
  RETURN pg_catalog.jsonb_build_object('events', v_events,
    'next_after_date', CASE WHEN v_more THEN pg_catalog.to_char(v_last_date, 'YYYY-MM-DD') END,
    'next_after_key', CASE WHEN v_more THEN v_last_key END);
END;
$$;

CREATE FUNCTION private.get_intake_breakdown(_from date, _to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_payment bigint;
  v_cancel bigint;
  v_deducted bigint;
  v_restored bigint;
  v_dispute bigint;
  v_intake bigint;
  v_subtotal bigint;
  v_discount bigint;
  v_shipping bigint;
  v_count integer;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'payment'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'pre_shipment_cancel'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped_restored'), 0)
  INTO v_payment, v_cancel, v_deducted, v_restored
  FROM private.accounting_intake_events(_from, _to) AS e;
  v_dispute := v_deducted + v_restored;
  v_intake := v_payment + v_cancel + v_dispute;
  SELECT COALESCE(pg_catalog.sum(o.subtotal_amount), 0), COALESCE(pg_catalog.sum(o.discount_amount), 0),
    COALESCE(pg_catalog.sum(o.shipping_amount), 0), pg_catalog.count(*)
  INTO v_subtotal, v_discount, v_shipping, v_count
  FROM public.orders AS o
  WHERE o.id IN (SELECT e.order_id FROM private.accounting_intake_events(_from, _to) AS e
    WHERE e.kind = 'payment' GROUP BY e.order_id HAVING pg_catalog.sum(e.amount) <> 0);
  RETURN pg_catalog.jsonb_build_object('subtotal_before_discount', v_subtotal, 'discount', v_discount, 'shipping', v_shipping,
    'payment', v_payment, 'pre_shipment_cancel', v_cancel, 'dispute_unshipped', v_dispute,
    'dispute_unshipped_restored', v_restored, 'intake', v_intake, 'order_count', v_count,
    'breakdown_ok', (v_subtotal - v_discount + v_shipping + v_cancel + v_dispute = v_intake));
END;
$$;

CREATE FUNCTION private.get_order_backlog(_as_of date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_total bigint;
  v_count integer;
BEGIN
  IF _as_of IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(b.balance), 0), pg_catalog.count(*) FILTER (WHERE b.balance <> 0)
  INTO v_total, v_count FROM private.accounting_order_balances(_as_of) AS b;
  RETURN pg_catalog.jsonb_build_object('backlog_total', v_total, 'order_count', v_count);
END;
$$;

CREATE FUNCTION private.get_intake_reconciliation(_from date, _to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_opening bigint;
  v_closing bigint;
  v_intake bigint;
  v_deducted bigint;
  v_sales bigint;
  v_returns bigint;
  v_orders_4010 bigint;
  v_fee bigint;
  v_other_4010 bigint;
  v_other_4020 bigint;
  v_pending_move bigint;
  v_pending bigint;
  v_refund_2130 bigint;
  v_other_sum bigint;
  v_others jsonb;
  v_exceptions jsonb;
  v_booked bigint;
  v_by_account jsonb;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_opening := COALESCE((SELECT pg_catalog.sum(b.balance) FROM private.accounting_order_balances(_from - 1) AS b), 0);
  v_closing := COALESCE((SELECT pg_catalog.sum(b.balance) FROM private.accounting_order_balances(_to) AS b), 0);
  SELECT COALESCE(pg_catalog.sum(e.amount), 0), COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped'), 0)
  INTO v_intake, v_deducted FROM private.accounting_intake_events(_from, _to) AS e;

  -- The 2150 change of the window by the kind of entry that made it.
  WITH ln AS (
    SELECT * FROM private.accounting_effective_lines(_from, _to)
  ), ent AS (
    SELECT l.entry_id, pg_catalog.bool_or(l.account_code = '2130') AS has_2130,
      pg_catalog.bool_or(l.account_code = '1160' AND l.memo = 'dispute_reversal_kind:L') AS is_late,
      pg_catalog.bool_or(l.account_code = '1160' AND l.memo = 'dispute_reversal_kind:R') AS is_early
    FROM ln AS l GROUP BY l.entry_id
  ), moves AS (
    SELECT CASE
        WHEN l.eff_kind = 'payment_confirmed' THEN 'payment'
        WHEN l.eff_kind = 'pre_shipment_refund' THEN 'pre_shipment_cancel'
        WHEN l.eff_kind IN ('shipment_confirmed', 'shipment_redated') THEN 'shipment'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'withdrawn' THEN 'dispute_pending'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'reversal' AND e.is_early THEN 'dispute_pending'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'reversal' AND e.is_late THEN 'dispute_late'
        WHEN e.has_2130 THEN 'return_refund_2130'
        ELSE 'other' END AS cls,
      l.eff_kind, (l.credit - l.debit) AS delta
    FROM ln AS l JOIN ent AS e ON e.entry_id = l.entry_id
    WHERE l.account_code = '2150' AND l.order_id IS NOT NULL
  )
  SELECT COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'dispute_pending'), 0),
    COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'return_refund_2130'), 0),
    COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'other'), 0),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', 'other', 'label_key', 'other',
        'event_kind', o.eff_kind, 'amount', o.amount) ORDER BY o.eff_kind COLLATE "C")
      FROM (SELECT m2.eff_kind, pg_catalog.sum(m2.delta)::bigint AS amount FROM moves AS m2 WHERE m2.cls = 'other'
        GROUP BY m2.eff_kind HAVING pg_catalog.sum(m2.delta) <> 0) AS o), '[]'::jsonb)
  INTO v_pending_move, v_refund_2130, v_other_sum, v_others
  FROM moves AS m;
  -- The part of the withdrawals taken off 2150 that the intake has not taken off yet (and the part that came back early).
  v_pending := v_pending_move - v_deducted;
  v_exceptions := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('kind', 'dispute_pending', 'label_key', 'dispute_pending', 'amount', v_pending),
    pg_catalog.jsonb_build_object('kind', 'return_refund_2130', 'label_key', 'return_refund_2130', 'amount', v_refund_2130))
    || v_others;

  -- The sales rows of the window.
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NOT NULL
        AND l.eff_kind IN ('shipment_confirmed', 'shipment_redated')), 0),
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '4020' AND l.order_id IS NOT NULL), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NOT NULL), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4050'), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NULL), 0),
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '4020' AND l.order_id IS NULL), 0)
  INTO v_sales, v_returns, v_orders_4010, v_fee, v_other_4010, v_other_4020
  FROM private.accounting_effective_lines(_from, _to) AS l;
  v_booked := v_orders_4010 - v_returns;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('account_code', x.account_code, 'sub_account', x.sub_account,
      'amount', x.amount) ORDER BY x.account_code COLLATE "C", x.sub_account COLLATE "C" NULLS FIRST), '[]'::jsonb)
  INTO v_by_account
  FROM (
    SELECT l.account_code, l.sub_account, pg_catalog.sum(l.debit - l.credit)::bigint AS amount
    FROM private.accounting_effective_lines(_from, _to) AS l
    WHERE l.eff_kind = 'dispute_event' AND l.account_code NOT IN ('1160', '2150')
      AND NOT (l.account_code = '1470' AND l.sub_account = 'dispute_pending')
    GROUP BY l.account_code, l.sub_account
    HAVING pg_catalog.sum(l.debit - l.credit) <> 0
  ) AS x;

  RETURN pg_catalog.jsonb_build_object(
    'opening_backlog', v_opening, 'intake', v_intake, 'sales_before_return', v_sales, 'closing_backlog', v_closing,
    'exceptions', v_exceptions,
    'unexplained', v_closing - (v_opening + v_intake - v_sales + v_pending + v_refund_2130 + v_other_sum),
    'returns', v_returns, 'booked_sales_net_orders', v_booked, 'return_fee_revenue_4050', v_fee,
    'other_4010', v_other_4010, 'other_4020', v_other_4020,
    'book_sales_total', v_booked + v_other_4010 - v_other_4020,
    'unexplained2', (v_sales - v_returns) - v_booked,
    'dispute_confirmed_by_account', v_by_account);
END;
$$;

CREATE FUNCTION private.list_deferred_revenue(_as_of date, _limit integer DEFAULT 100, _after_order uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_total bigint;
  v_ids uuid[];
  v_more boolean;
  v_orders jsonb;
BEGIN
  IF _as_of IS NULL OR _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_total := COALESCE((SELECT pg_catalog.sum(b.balance) FROM private.accounting_order_balances(_as_of) AS b WHERE b.balance > 0), 0);
  SELECT pg_catalog.array_agg(x.order_id ORDER BY x.order_id) INTO v_ids FROM (
    SELECT b.order_id FROM private.accounting_order_balances(_as_of) AS b
    WHERE b.balance > 0 AND (_after_order IS NULL OR b.order_id > _after_order)
    ORDER BY b.order_id LIMIT _limit + 1
  ) AS x;
  v_ids := COALESCE(v_ids, ARRAY[]::uuid[]);
  v_more := pg_catalog.cardinality(v_ids) > _limit;
  IF v_more THEN
    v_ids := v_ids[1:_limit];
  END IF;
  WITH bal AS (
    SELECT b.order_id, b.balance FROM private.accounting_order_balances(_as_of) AS b WHERE b.order_id = ANY (v_ids)
  ), paid AS (
    SELECT l.order_id, pg_catalog.min(l.entry_date) AS paid_on
    FROM private.accounting_effective_lines(NULL, _as_of) AS l
    WHERE l.account_code = '2150' AND l.eff_kind = 'payment_confirmed' AND l.order_id = ANY (v_ids)
    GROUP BY l.order_id
  ), st AS (
    SELECT s.order_id, s.status, pg_catalog.sum(s.quantity)::integer AS quantity
    FROM private.list_admin_order_item_states(v_ids) AS s
    JOIN public.order_items AS oi ON oi.id = s.order_item_id AND oi.line_kind = 'order'
    WHERE s.status IN ('ready', 'in_production', 'cancel_requested', 'unpaid', 'payment_expired')
    GROUP BY s.order_id, s.status
  ), per_order AS (
    SELECT st.order_id, pg_catalog.sum(st.quantity)::integer AS units, pg_catalog.jsonb_object_agg(st.status, st.quantity) AS states
    FROM st GROUP BY st.order_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_id', bal.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(bal.order_id::text, 8)), 'balance', bal.balance,
      'paid_on', pg_catalog.to_char(paid.paid_on, 'YYYY-MM-DD'), 'unshipped_units', COALESCE(po.units, 0),
      'states', COALESCE(po.states, '{}'::jsonb)) ORDER BY bal.order_id), '[]'::jsonb)
  INTO v_orders
  FROM bal LEFT JOIN paid ON paid.order_id = bal.order_id LEFT JOIN per_order AS po ON po.order_id = bal.order_id;
  RETURN pg_catalog.jsonb_build_object('orders', v_orders,
    'next_after_order', CASE WHEN v_more THEN v_ids[pg_catalog.cardinality(v_ids)] END, 'total_balance', v_total);
END;
$$;

CREATE FUNCTION private.list_deferred_revenue_anomalies() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_id', f.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(f.order_id::text, 8)), 'balance', f.balance, 'reason', f.reason)
      ORDER BY f.order_id), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT b.order_id, b.balance,
      CASE
        WHEN b.balance < 0 THEN 'negative_balance'
        WHEN EXISTS (SELECT 1 FROM private.accounting_unit_values(b.order_id, NULL::bigint) AS v)
          AND NOT EXISTS (SELECT 1 FROM private.accounting_unit_values(b.order_id, NULL::bigint) AS v WHERE NOT v.shipped AND v.value > 0)
          THEN 'balance_after_all_shipped_or_refunded'
      END AS reason
    FROM private.accounting_order_balances('infinity'::date) AS b
    WHERE b.balance <> 0
  ) AS f
  WHERE f.reason IS NOT NULL;
  RETURN pg_catalog.jsonb_build_object('anomalies', v_rows);
END;
$$;

-- 3. The public entries (INVOKER; only service_role may call them).
CREATE FUNCTION public.list_order_intake_events(_from date, _to date, _limit integer DEFAULT 5000,
  _after_date date DEFAULT NULL, _after_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_order_intake_events(_from, _to, _limit, _after_date, _after_key) $$;

CREATE FUNCTION public.get_intake_breakdown(_from date, _to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_intake_breakdown(_from, _to) $$;

CREATE FUNCTION public.get_order_backlog(_as_of date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_order_backlog(_as_of) $$;

CREATE FUNCTION public.get_intake_reconciliation(_from date, _to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_intake_reconciliation(_from, _to) $$;

CREATE FUNCTION public.list_deferred_revenue(_as_of date, _limit integer DEFAULT 100, _after_order uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_deferred_revenue(_as_of, _limit, _after_order) $$;

CREATE FUNCTION public.list_deferred_revenue_anomalies() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_deferred_revenue_anomalies() $$;

-- 4. Owners and EXECUTE. service_role: the six reads (private and public); the four tools are owner only.
ALTER FUNCTION private.accounting_read_start() OWNER TO postgres;
ALTER FUNCTION private.accounting_effective_lines(date,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_order_balances(date) OWNER TO postgres;
ALTER FUNCTION private.accounting_intake_events(date,date) OWNER TO postgres;
ALTER FUNCTION private.list_order_intake_events(date,date,integer,date,text) OWNER TO postgres;
ALTER FUNCTION private.get_intake_breakdown(date,date) OWNER TO postgres;
ALTER FUNCTION private.get_order_backlog(date) OWNER TO postgres;
ALTER FUNCTION private.get_intake_reconciliation(date,date) OWNER TO postgres;
ALTER FUNCTION private.list_deferred_revenue(date,integer,uuid) OWNER TO postgres;
ALTER FUNCTION private.list_deferred_revenue_anomalies() OWNER TO postgres;
ALTER FUNCTION public.list_order_intake_events(date,date,integer,date,text) OWNER TO postgres;
ALTER FUNCTION public.get_intake_breakdown(date,date) OWNER TO postgres;
ALTER FUNCTION public.get_order_backlog(date) OWNER TO postgres;
ALTER FUNCTION public.get_intake_reconciliation(date,date) OWNER TO postgres;
ALTER FUNCTION public.list_deferred_revenue(date,integer,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_deferred_revenue_anomalies() OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_read_start(), private.accounting_effective_lines(date,date), private.accounting_order_balances(date),
  private.accounting_intake_events(date,date),
  private.list_order_intake_events(date,date,integer,date,text), private.get_intake_breakdown(date,date),
  private.get_order_backlog(date), private.get_intake_reconciliation(date,date), private.list_deferred_revenue(date,integer,uuid),
  private.list_deferred_revenue_anomalies(),
  public.list_order_intake_events(date,date,integer,date,text), public.get_intake_breakdown(date,date),
  public.get_order_backlog(date), public.get_intake_reconciliation(date,date), public.list_deferred_revenue(date,integer,uuid),
  public.list_deferred_revenue_anomalies()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.list_order_intake_events(date,date,integer,date,text), private.get_intake_breakdown(date,date),
  private.get_order_backlog(date), private.get_intake_reconciliation(date,date), private.list_deferred_revenue(date,integer,uuid),
  private.list_deferred_revenue_anomalies(),
  public.list_order_intake_events(date,date,integer,date,text), public.get_intake_breakdown(date,date),
  public.get_order_backlog(date), public.get_intake_reconciliation(date,date), public.list_deferred_revenue(date,integer,uuid),
  public.list_deferred_revenue_anomalies()
TO service_role;
-- ACC_S12_BODY_END

-- ACC_S12_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s12_functions: each function exists once and its text keeps the rules of the plan (the
-- kinds and the signs, the reversal entries counted with the kind of the original, the confirmed day from the entry or the resolved
-- row, the exception classes, the unit tools). acc_s12_function_attrs: owner, SECURITY, volatility, language, result, arguments,
-- search_path and EXECUTE (nobody for the tools, service_role only for the reads). acc_s12_reads_stable: the reads are STABLE and write
-- nothing, and name no personal column. acc_s12_existing_dml_allowlist: this migration wrote no row.
DO $acc_s12_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_src text;
  v_baseline jsonb;
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s12_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s12_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s12_baseline) <> 1 THEN
    v_failed := 'acc_s12_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s12_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s12_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s12_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_read_start()', ARRAY['pg_catalog.min(p.starts_on)', 's.cutover_on']),
      ('private.accounting_effective_lines(date,date)', ARRAY[
        'COALESCE(o.event_kind, e.event_kind)', 'COALESCE(o.dedupe_key, e.dedupe_key)', 'o.id = e.reverses_entry_id',
        'GREATEST(_from, private.accounting_read_start())']),
      ('private.accounting_order_balances(date)', ARRAY['''2150''', 'x.credit - x.debit', 'x.order_id IS NOT NULL']),
      ('private.accounting_intake_events(date,date)', ARRAY[
        '''payment_confirmed''', '''pre_shipment_refund''', '''dispute_unshipped_restored''', '''dispute_unshipped''', '''dispute_reversal_kind:L''',
        '''dispute_reversal_kind:R''', ':confirmed:lost', '''no_revenue''', 'lost_on', '''stripe_disputes''', 'p.resolved_at IS NOT NULL',
        '''withdrawn''', '''reversal''', 'dl.credit - dl.debit', 'dl.debit - dl.credit', 'cf.pending <> 0', '''infinity''::date',
        'b.credit - b.debit', 'b.entry_id::text || '':'' || b.line_no::text']),
      ('private.list_order_intake_events(date,date,integer,date,text)', ARRAY[
        '_limit > 5000', 'ACCOUNTING_ARGUMENT_INVALID', 'COLLATE "C"', 'LIMIT _limit + 1', 'next_after_date', 'next_after_key']),
      ('private.get_intake_breakdown(date,date)', ARRAY[
        '''payment''', '''pre_shipment_cancel''', '''dispute_unshipped''', '''dispute_unshipped_restored''', 'o.subtotal_amount', 'o.discount_amount',
        'HAVING pg_catalog.sum(e.amount) <> 0', 'v_subtotal - v_discount + v_shipping + v_cancel + v_dispute = v_intake']),
      ('private.get_order_backlog(date)', ARRAY['private.accounting_order_balances(_as_of)', 'b.balance <> 0']),
      ('private.get_intake_reconciliation(date,date)', ARRAY[
        '''dispute_pending''', '''return_refund_2130''', '''other''', '''2130''', '''4010''', '''4020''', '''4050''', '''shipment_confirmed''',
        '''shipment_redated''', 'dispute_reversal_kind:L', 'dispute_reversal_kind:R', 'v_pending_move - v_deducted',
        'v_closing - (v_opening + v_intake - v_sales + v_pending + v_refund_2130 + v_other_sum)', '(v_sales - v_returns) - v_booked',
        '_from - 1', '''dispute_confirmed_by_account''']),
      ('private.list_deferred_revenue(date,integer,uuid)', ARRAY[
        'private.list_admin_order_item_states(v_ids)', 'oi.line_kind = ''order''', '_limit > 200', 'b.balance > 0', '''payment_confirmed''',
        '''in_production''']),
      ('private.list_deferred_revenue_anomalies()', ARRAY[
        'private.accounting_unit_values(b.order_id, NULL::bigint)', '''negative_balance''', '''balance_after_all_shipped_or_refunded''',
        'NOT v.shipped AND v.value > 0'])
    ) AS x(signature, needles)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL THEN
        v_failed := 'acc_s12_functions';
        EXIT;
      END IF;
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
        WHERE o.pronamespace = 'private'::regnamespace AND o.proname = (SELECT f.proname FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1 THEN
        v_failed := 'acc_s12_functions';
        EXIT;
      END IF;
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF EXISTS (SELECT 1 FROM pg_catalog.unnest(e.needles) AS n(text) WHERE pg_catalog.strpos(v_src, n.text) = 0) THEN
        v_failed := 'acc_s12_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s12_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_read_start()', 'date', false, '', 0, 'sql', false),
      ('private.accounting_effective_lines(date,date)', 'record', true, '_from,_to', 0, 'sql', false),
      ('private.accounting_order_balances(date)', 'record', true, '_as_of', 0, 'sql', false),
      ('private.accounting_intake_events(date,date)', 'record', true, '_from,_to', 0, 'sql', false),
      ('private.list_order_intake_events(date,date,integer,date,text)', 'jsonb', false, '_from,_to,_limit,_after_date,_after_key', 3, 'plpgsql', true),
      ('public.list_order_intake_events(date,date,integer,date,text)', 'jsonb', false, '_from,_to,_limit,_after_date,_after_key', 3, 'sql', true),
      ('private.get_intake_breakdown(date,date)', 'jsonb', false, '_from,_to', 0, 'plpgsql', true),
      ('public.get_intake_breakdown(date,date)', 'jsonb', false, '_from,_to', 0, 'sql', true),
      ('private.get_order_backlog(date)', 'jsonb', false, '_as_of', 0, 'plpgsql', true),
      ('public.get_order_backlog(date)', 'jsonb', false, '_as_of', 0, 'sql', true),
      ('private.get_intake_reconciliation(date,date)', 'jsonb', false, '_from,_to', 0, 'plpgsql', true),
      ('public.get_intake_reconciliation(date,date)', 'jsonb', false, '_from,_to', 0, 'sql', true),
      ('private.list_deferred_revenue(date,integer,uuid)', 'jsonb', false, '_as_of,_limit,_after_order', 2, 'plpgsql', true),
      ('public.list_deferred_revenue(date,integer,uuid)', 'jsonb', false, '_as_of,_limit,_after_order', 2, 'sql', true),
      ('private.list_deferred_revenue_anomalies()', 'jsonb', false, '', 0, 'plpgsql', true),
      ('public.list_deferred_revenue_anomalies()', 'jsonb', false, '', 0, 'sql', true)
    ) AS x(signature, result_type, retset, arg_names, defaults, lang, service_exec)
    LOOP
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef <> (e.signature LIKE 'private.%') OR p.provolatile <> 's'
        OR p.lanname <> e.lang OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset <> e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service_exec
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee <> p.proowner AND NOT (e.service_exec AND a.grantee = 'service_role'::regrole))
        OR (NOT e.service_exec AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = p.proname)) THEN
        v_failed := 'acc_s12_function_attrs';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s12_reads_stable';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_read_start()'), ('private.accounting_effective_lines(date,date)'), ('private.accounting_order_balances(date)'),
      ('private.accounting_intake_events(date,date)'),
      ('private.list_order_intake_events(date,date,integer,date,text)'), ('public.list_order_intake_events(date,date,integer,date,text)'),
      ('private.get_intake_breakdown(date,date)'), ('public.get_intake_breakdown(date,date)'),
      ('private.get_order_backlog(date)'), ('public.get_order_backlog(date)'),
      ('private.get_intake_reconciliation(date,date)'), ('public.get_intake_reconciliation(date,date)'),
      ('private.list_deferred_revenue(date,integer,uuid)'), ('public.list_deferred_revenue(date,integer,uuid)'),
      ('private.list_deferred_revenue_anomalies()'), ('public.list_deferred_revenue_anomalies()')
    ) AS x(signature)
    LOOP
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.provolatile <> 's'
        OR p.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
        OR p.prosrc ~* '(raw_payload|evidence_details|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address|user_id|session_id)' THEN
        v_failed := 'acc_s12_reads_stable';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s12_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint) THEN
    v_failed := 'acc_s12_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s12_functions'), HINT = SQLSTATE;
END;
$acc_s12_final$;
-- ACC_S12_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
