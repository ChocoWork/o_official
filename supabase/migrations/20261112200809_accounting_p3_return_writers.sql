BEGIN;
-- Accounting plan 3 S18 (FREQ-575 AC-01/AC-02/AC-03/AC-04/AC-05, FREQ-576 AC-03/AC-05/AC-06, FREQ-578 AC-01/AC-02/AC-04/AC-07/
-- AC-08/AC-10, FREQ-581 AC-07): the return writers keep the accounting facts of a return (the arrival and the decision), and
-- the arrival date can be chosen at the receipt and corrected later.
--
-- Rebuilt (the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, replaced text between
-- ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END):
--   private.admin_receive_return (D 20261110135232)   17th argument _arrived_on date DEFAULT NULL; arrival and decision facts.
--                                                      The 16 argument form is dropped. Result, attributes, owner, ACL unchanged.
--   public.admin_receive_return (C 20261110120611)    17th argument passed on; the 16 argument form is dropped.
--   private.admin_refund_return (X4 20261112064013)   decision facts (the refund it starts, or the refund of nothing).
--   private.group_g_writer_allowlist (D)               the receive writer in its 17 argument form; still 77 entries.
-- New tools (private, SECURITY DEFINER, no EXECUTE for anyone): accounting_order_dispute_confirmed_on,
--   accounting_return_arrival_on, accounting_assert_arrival_date, accounting_record_return_arrival,
--   accounting_record_return_decision.
-- New writers for service_role (private body + public entry): admin_correct_return_arrival_date,
--   admin_set_return_arrival_option. New readers for service_role: get_return_arrival_option, get_return_arrival_info,
--   get_return_carrier_arrival.
--
-- ROLLBACK (only while accounting_return_facts and order_return_arrival_corrections hold no row written by these functions):
--   recreate the 16 argument private and public admin_receive_return from D :960-1623 and C :712-723 with their ACL (D
--   :1105-1110 form), re-run CREATE OR REPLACE of private.group_g_writer_allowlist from D :1625-1707, then DROP the 17 argument
--   pair; re-run CREATE OR REPLACE of private.admin_refund_return from X4 :648-841; DROP the public and private writers and
--   readers and the five tools of this file.

-- ACC_S18_BODY_BEGIN

CREATE TEMP TABLE accounting_s18_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s18_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'receive16', pg_catalog.to_regprocedure('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean)')::oid::bigint,
  'counts', pg_catalog.jsonb_build_object(
    'facts', (SELECT pg_catalog.count(*) FROM public.accounting_return_facts),
    'corrections', (SELECT pg_catalog.count(*) FROM public.order_return_arrival_corrections),
    'receipts', (SELECT pg_catalog.count(*) FROM public.order_return_receipts),
    'options', (SELECT pg_catalog.md5(pg_catalog.string_agg(o::text, ',')) FROM public.accounting_return_options AS o)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(f.oid::regprocedure::text, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::regtype::text, pg_catalog.pg_get_function_arguments(f.oid), pg_catalog.pg_get_function_result(f.oid),
      f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f
    WHERE f.oid IN ('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)'::regprocedure,
      'private.group_g_writer_allowlist()'::regprocedure)),
  'receive_attrs', (SELECT pg_catalog.jsonb_object_agg(n.nspname, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::regtype::text, pg_catalog.pg_get_function_result(f.oid),
      f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
    WHERE f.oid IN (
      'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean)'::regprocedure,
      'public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean)'::regprocedure)));

-- 1. Tools (private, SECURITY DEFINER, no EXECUTE for anyone).

-- The day of Japan the latest card dispute of the order was confirmed lost (NULL when none). Per lost dispute of the order:
-- the date of its confirmed entry (C, [dispute,'confirmed','lost']) when it exists, else the Japan day of its loss time;
-- the latest of those days. Two disputes are each looked at on their own (one may have C, the other not yet).
CREATE FUNCTION private.accounting_order_dispute_confirmed_on(_order_id uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.max(COALESCE(
    (SELECT pg_catalog.max(e.entry_date) FROM public.accounting_journal_entries AS e
      WHERE e.dedupe_key = private.accounting_dispute_key(d.id, 'confirmed', 'lost')),
    private.accounting_jst_date(private.accounting_dispute_lost_at(d.id))))
  FROM public.stripe_disputes AS d
  WHERE _order_id IS NOT NULL AND d.status = 'lost' AND private.accounting_dispute_order(d.id) = _order_id
$$;

-- The arrival date of a receipt now: the newest correction (the largest version), else the date on the receipt row.
CREATE FUNCTION private.accounting_return_arrival_on(_receipt_id uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT c.new_on FROM public.order_return_arrival_corrections AS c WHERE c.receipt_id = _receipt_id
      ORDER BY c.version DESC LIMIT 1),
    (SELECT r.arrived_on FROM public.order_return_receipts AS r WHERE r.id = _receipt_id))
$$;

-- An arrival date may be any day from the Japan day the return was requested up to today in Japan, and must be after the
-- day the order's card dispute was confirmed lost. Otherwise RETURN_ARRIVAL_DATE_INVALID / 22023 with DETAIL future,
-- before_request or dispute_confirmed.
CREATE FUNCTION private.accounting_assert_arrival_date(_return_id uuid, _order_id uuid, _arrived_on date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_requested timestamptz;
  v_confirmed date;
BEGIN
  SELECT COALESCE(r.requested_at, r.created_at) INTO v_requested FROM public.order_returns AS r
  WHERE r.id = _return_id AND r.order_id = _order_id;
  IF NOT FOUND OR _arrived_on IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _arrived_on > private.accounting_jst_date(pg_catalog.now()) THEN
    RAISE EXCEPTION 'RETURN_ARRIVAL_DATE_INVALID' USING ERRCODE = '22023', DETAIL = 'future';
  END IF;
  IF _arrived_on < private.accounting_jst_date(v_requested) THEN
    RAISE EXCEPTION 'RETURN_ARRIVAL_DATE_INVALID' USING ERRCODE = '22023', DETAIL = 'before_request';
  END IF;
  v_confirmed := private.accounting_order_dispute_confirmed_on(_order_id);
  IF v_confirmed IS NOT NULL AND _arrived_on <= v_confirmed THEN
    RAISE EXCEPTION 'RETURN_ARRIVAL_DATE_INVALID' USING ERRCODE = '22023', DETAIL = 'dispute_confirmed';
  END IF;
END;
$$;

-- The arrival fact of a receive receipt (G = the goods amount before the fee, F = the fee). Nothing when G is 0 or the
-- receipt has one already. Needs the group G lock.
CREATE FUNCTION private.accounting_record_return_arrival(_receipt_id uuid, _return_id uuid, _order_id uuid,
  _goods_amount integer, _fee_amount integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _receipt_id IS NULL OR _goods_amount IS NULL OR _fee_amount IS NULL OR _goods_amount < 0 OR _fee_amount < 0
    OR _fee_amount > _goods_amount
    OR NOT EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id AND r.order_id = _order_id)
    OR NOT EXISTS (SELECT 1 FROM public.order_return_receipts AS rr
      WHERE rr.id = _receipt_id AND rr.return_id = _return_id AND rr.kind = 'receive') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _goods_amount = 0 OR EXISTS (SELECT 1 FROM public.accounting_return_facts AS f
      WHERE f.receipt_id = _receipt_id AND f.kind = 'arrival') THEN
    RETURN;
  END IF;
  SELECT COALESCE(pg_catalog.max(f.seq), 0) + 1 INTO v_next FROM public.accounting_return_facts AS f WHERE f.return_id = _return_id;
  INSERT INTO public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, goods_amount, fee_amount)
  VALUES (_return_id, _order_id, v_next, 'arrival', _receipt_id, _goods_amount, _fee_amount);
END;
$$;

-- The decision fact of a return (plan 3 Task 4). Paths, by the receipt passed:
--   receive receipt (admin_receive_return): _goods_now (G now) and _fee_now (F now) are required, 0 <= F now <= G now.
--     A refund started: _fee_amount = F now; covers = max(G now - F now, 0) capped by the payable left (0 when G now is 0).
--     No refund (the receipt waived the refund): covers as above, fee = F now (both 0 when G now is 0).
--   no receipt (admin_refund_return started a refund): the two now values are NULL. Snapshot orders: covers = the stored
--     amount of each (event, part) the refund is linked to (now_refund / consult_refund) plus the payable_delta of each
--     earlier failed refund linked to one of the same (event, part), once per earlier refund. Other orders: the payable left.
--   waive_refund receipt (admin_refund_return with amount 0): covers = the payable left; fee = the arrival fees less the fees
--     of the refund decisions (not of refunds that did not succeed) and of the earlier 0 yen decisions (not below 0).
-- payable left = sum(arrival G - F) + sum(all decisions' payable_delta) - sum(decided of refunds that did not end unsuccessful
-- [failed, or canceled and abandoned]); not below 0. payable_delta = decided - covers; decided_on = today in Japan.
-- Any other receipt kind, a receipt or refund of another return, or arguments that break the path rules:
-- ACCOUNTING_ARGUMENT_INVALID. A decision already written for the refund (or for the receipt, without a refund) is kept.
CREATE FUNCTION private.accounting_record_return_decision(_return_id uuid, _order_id uuid, _refund_id uuid,
  _decided_amount integer, _receipt_id uuid DEFAULT NULL, _fee_amount integer DEFAULT 0, _goods_now integer DEFAULT NULL,
  _fee_now integer DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_refund public.order_refunds%ROWTYPE;
  v_left bigint;
  v_covers bigint;
  v_fee bigint;
  v_next integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _return_id IS NULL OR _order_id IS NULL OR _decided_amount IS NULL OR _decided_amount < 0
    OR _fee_amount IS NULL OR _fee_amount < 0
    OR NOT EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id AND r.order_id = _order_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _receipt_id IS NOT NULL THEN
    SELECT rr.kind INTO v_kind FROM public.order_return_receipts AS rr WHERE rr.id = _receipt_id AND rr.return_id = _return_id;
    IF v_kind IS NULL OR v_kind NOT IN ('receive', 'waive_refund') THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_kind = 'receive' THEN
    IF _goods_now IS NULL OR _fee_now IS NULL OR _goods_now < 0 OR _fee_now < 0 OR _fee_now > _goods_now THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF _goods_now IS NOT NULL OR _fee_now IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _refund_id IS NOT NULL THEN
    IF (v_kind IS NOT NULL AND v_kind <> 'receive') OR (v_kind = 'receive' AND _fee_amount <> _fee_now) THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
    IF NOT FOUND OR v_refund.return_id IS DISTINCT FROM _return_id OR v_refund.order_id <> _order_id THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS f WHERE f.kind = 'decision' AND f.refund_id = _refund_id) THEN
      RETURN;
    END IF;
  ELSE
    IF _receipt_id IS NULL OR _decided_amount <> 0 OR _fee_amount <> 0 THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS f WHERE f.kind = 'decision' AND f.receipt_id = _receipt_id) THEN
      RETURN;
    END IF;
  END IF;
  SELECT COALESCE((SELECT pg_catalog.sum(f.goods_amount - f.fee_amount) FROM public.accounting_return_facts AS f
      WHERE f.return_id = _return_id AND f.kind = 'arrival'), 0)
    + COALESCE((SELECT pg_catalog.sum(f.payable_delta) FROM public.accounting_return_facts AS f
      WHERE f.return_id = _return_id AND f.kind = 'decision'), 0)
    - COALESCE((SELECT pg_catalog.sum(f.decided_amount) FROM public.accounting_return_facts AS f
      JOIN public.order_refunds AS rf ON rf.id = f.refund_id
      WHERE f.return_id = _return_id AND f.kind = 'decision'
        AND NOT (rf.status = 'failed' OR (rf.status = 'canceled' AND EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
          WHERE x.refund_id = rf.id AND x.state = 'abandoned')))), 0)
  INTO v_left;
  v_left := GREATEST(v_left, 0);
  IF v_kind = 'receive' THEN
    v_covers := CASE WHEN _goods_now = 0 THEN 0 ELSE LEAST(GREATEST(_goods_now - _fee_now, 0), v_left) END;
    v_fee := CASE WHEN _refund_id IS NOT NULL THEN _fee_amount WHEN _goods_now = 0 THEN 0 ELSE _fee_now END;
  ELSIF v_kind = 'waive_refund' THEN
    v_covers := v_left;
    SELECT GREATEST(
      COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        WHERE f.return_id = _return_id AND f.kind = 'arrival'), 0)
      - COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        JOIN public.order_refunds AS rf ON rf.id = f.refund_id
        WHERE f.return_id = _return_id AND f.kind = 'decision'
          AND NOT (rf.status = 'failed' OR (rf.status = 'canceled' AND EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
            WHERE x.refund_id = rf.id AND x.state = 'abandoned')))), 0)
      - COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        WHERE f.return_id = _return_id AND f.kind = 'decision' AND f.refund_id IS NULL), 0), 0)
    INTO v_fee;
  ELSIF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = _order_id) THEN
    -- Ruling P3-C8: the (event, part) rows this refund is linked to (the core linked them from the reader), each counted once
    -- (primary key event, refund, part), plus each earlier failed refund linked to one of the same (event, part), once.
    SELECT COALESCE((SELECT pg_catalog.sum(CASE er.part WHEN 'now' THEN e.now_refund ELSE e.consult_refund END)
        FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
        WHERE er.refund_id = _refund_id AND er.part IN ('now', 'consult')), 0)
      + COALESCE((SELECT pg_catalog.sum(f.payable_delta) FROM public.accounting_return_facts AS f
        WHERE f.kind = 'decision' AND f.refund_id IN (
          SELECT p.refund_id FROM public.order_unit_event_refunds AS p
          JOIN public.order_refunds AS rf ON rf.id = p.refund_id
          JOIN public.order_unit_event_refunds AS n ON n.refund_id = _refund_id AND n.event_id = p.event_id AND n.part = p.part
          WHERE p.refund_id <> _refund_id AND rf.status = 'failed')), 0)
    INTO v_covers;
    v_covers := GREATEST(v_covers, 0);
    v_fee := _fee_amount;
  ELSE
    v_covers := v_left;
    v_fee := _fee_amount;
  END IF;
  SELECT COALESCE(pg_catalog.max(f.seq), 0) + 1 INTO v_next FROM public.accounting_return_facts AS f WHERE f.return_id = _return_id;
  INSERT INTO public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, refund_id, goods_amount, fee_amount,
    covers_amount, decided_amount, payable_delta, decided_on)
  VALUES (_return_id, _order_id, v_next, 'decision', _receipt_id, _refund_id, 0, v_fee, v_covers, _decided_amount,
    _decided_amount - v_covers, private.accounting_jst_date(pg_catalog.now()));
END;
$$;
-- 2. admin_receive_return with the arrival date (17 arguments). The body is migration D's, with the ACC_P3 blocks.
CREATE FUNCTION private.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text, _pricing jsonb DEFAULT NULL,
  _restocking_fee_waived boolean DEFAULT false, _arrived_on date DEFAULT NULL
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean,
  release_refund_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_order uuid; v_return public.order_returns%ROWTYPE; v_old public.order_return_receipts%ROWTYPE;
  v_units jsonb; v_effective jsonb; v_overrides jsonb; v_fp text; v_j jsonb; v_id uuid; v_n integer; v_seen text[]:=ARRAY[]::text[];
  v_receipt uuid:=pg_catalog.gen_random_uuid(); v_refund uuid; v_amount integer; v_status text; v_choice text;
  v_lines jsonb:='[]'::jsonb; v_goods integer:=0; v_exchange integer:=0; v_sent integer:=0;
  v_fees integer:=0; v_due integer:=0; v_pending integer:=0; v_shop boolean:=false;
  v_first_goods boolean; v_first_exchange boolean; v_line record; v_action text; v_available integer;
  v_exchange_ids uuid[]:=ARRAY[]::uuid[]; v_item uuid; v_offset integer; v_paid integer; v_waived boolean:=false;
  v_free_by_variant jsonb;
  v_exchange_used jsonb:='{}'::jsonb; v_h_offset integer; v_h_used integer; v_h_take integer;
  v_h_own integer[]; v_h_free integer[]; v_h_part integer[];
  v_qty jsonb; v_now_effective jsonb; v_now_elements jsonb; v_consult_elements jsonb; v_goods_consult integer:=0;
  v_fee_consult integer:=0; v_fixed integer:=0; v_has_now boolean; v_has_consult boolean; v_unresolved boolean;
  v_derived text; v_now_total integer:=0; v_consult_total integer:=0; v_total integer:=0; v_now_picked integer:=0;
  v_refundable integer; v_refundable_shipping integer;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_pricing jsonb := CASE WHEN pg_catalog.jsonb_typeof(_pricing) = 'null' THEN NULL ELSE _pricing END;
  v_slot boolean := false;
  v_related uuid[];
  v_event uuid;
  v_taken text[] := ARRAY[]::text[];
  v_links jsonb := '[]'::jsonb;
  v_pick record;
  v_k integer;
  v_price_sum integer;
  v_version text;
  v_rel record;
  v_rid uuid;
  v_released uuid[] := ARRAY[]::uuid[];
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  -- ACC_P3_BEGIN
  -- Accounting plan 3 (FREQ-578-AC-01): the arrival amounts G and F, and the now part G now and F now.
  v_acc_g integer; v_acc_f integer; v_acc_gnow integer; v_acc_fnow integer;
  -- ACC_P3_END
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _restocking_fee_waived IS NULL OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','mixed','none')
    OR _refund_shipping_amount IS NULL OR _refund_shipping_amount<0
    OR (_refund_amount IS NOT NULL AND _refund_amount<0) OR pg_catalog.char_length(_note)>500
    OR pg_catalog.char_length(_sent_back_message)>1000
    OR (_sent_back_carrier IS NOT NULL AND _sent_back_carrier NOT IN ('yamato','sagawa','japanpost','other'))
    OR (_sent_back_tracking_number IS NOT NULL AND _sent_back_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR pg_catalog.jsonb_typeof(_units) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array'
    OR (_pricing IS NOT NULL AND pg_catalog.jsonb_typeof(_pricing) NOT IN ('object', 'null')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_units) NOT BETWEEN 1 AND 100
    OR pg_catalog.jsonb_array_length(_exchange_overrides)>100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF NOT _actor_can_refund AND (_refund_amount IS NOT NULL
      OR _refund_shipping_amount<>0 OR pg_catalog.jsonb_array_length(_exchange_overrides)>0 OR _restocking_fee_waived) THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  IF _refund_choice NOT IN ('now','mixed') AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back')
      OR (COALESCE(pg_catalog.jsonb_typeof(v_j->'refund_choice'),'null')<>'null'
        AND (pg_catalog.jsonb_typeof(v_j->'refund_choice')<>'string' OR (v_j->>'refund_choice') NOT IN ('now','consult'))) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition')||':'||COALESCE(v_j->>'refund_choice',''))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition')||':'||COALESCE(v_j->>'refund_choice',''));
  END LOOP;
  v_seen:=ARRAY[]::text[];
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_exchange_overrides) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'action','') NOT IN ('make','refund') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF v_id::text=ANY(v_seen) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||v_id::text;
  END LOOP;
  -- A body without any line choice keeps the H5 fingerprint; otherwise each line carries its choice.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(_units) AS x(refund_choice text) WHERE x.refund_choice IS NOT NULL) THEN
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,
        'quantity',x.quantity,'refund_choice',x.refund_choice)
      ORDER BY x.return_line_id,x.disposition,x.refund_choice NULLS FIRST) INTO v_units
    FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer,refund_choice text);
  ELSE
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
      ORDER BY x.return_line_id,x.disposition) INTO v_units
    FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'action',x.action)
    ORDER BY x.return_line_id),'[]'::jsonb) INTO v_overrides
  FROM pg_catalog.jsonb_to_recordset(_exchange_overrides) AS x(return_line_id uuid,action text);
  v_fp:=pg_catalog.md5((pg_catalog.jsonb_build_object('return_id',_return_id,'units',v_units,'exchange_overrides',v_overrides,
    'refund_choice',_refund_choice,'refund_amount',_refund_amount,'refund_shipping_amount',_refund_shipping_amount,
    'note',_note,'notify_customer',_notify_customer,'sent_back_message',_sent_back_message,
    'sent_back_carrier',_sent_back_carrier,'sent_back_tracking_number',_sent_back_tracking_number,
    'actor_can_refund',_actor_can_refund)
    || CASE WHEN _restocking_fee_waived THEN pg_catalog.jsonb_build_object('restocking_fee_waived',true) ELSE '{}'::jsonb END)::text);
  -- ACC_P3_BEGIN
  -- The chosen arrival date joins the fingerprint only when given, so a call without it keeps the fingerprint it had (FREQ-576-AC-06).
  IF _arrived_on IS NOT NULL THEN
    v_fp:=pg_catalog.md5(v_fp||':'||pg_catalog.to_char(_arrived_on,'YYYY-MM-DD'));
  END IF;
  -- ACC_P3_END
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  -- Unit binding: an order with a discount snapshot also locks the member's related orders (the plan may touch their holds), in the same
  -- lock order and after the (190521,1) advisory lock, with the one call below. The related orders are read first; a change seen after the
  -- lock (a related order that appeared or went away) is a stale plan: UNIT_PRICING_STALE.
  IF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = v_order_id) THEN
    v_related := private.order_unit_related_orders(v_order_id);
  END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id] || COALESCE(v_related, ARRAY[]::uuid[]), NULL);
  IF v_related IS NOT NULL AND v_related IS DISTINCT FROM private.order_unit_related_orders(v_order_id) THEN
    RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001';
  END IF;
  -- Approval may have changed the exchange target while this entry waited on the advisory.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT rr.* INTO v_old FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id<>_return_id OR v_old.kind<>'receive' OR v_old.request_fingerprint<>v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    -- Existing business rule (unchanged).
    RETURN QUERY SELECT v_old.id,v_return.status,r.id,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 0 ELSE r.amount END,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 'waived' ELSE r.status END,
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT oi.id ORDER BY oi.id) FROM public.order_return_receipt_lines AS u
        JOIN public.order_items AS oi ON oi.id=private.return_exchange_item_id(v_old.id,u.return_line_id,u.exchange_method)
        WHERE u.receipt_id=v_old.id),ARRAY[]::uuid[]),v_return.fee_due_amount,
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true,
      private.order_unit_release_refund_ids(_request_key,v_order_id)
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF NOT _actor_can_refund AND (_refund_choice IN ('now','mixed') OR EXISTS (SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(refund_choice text) WHERE x.refund_choice='now'))
    AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  -- Unit binding: an order with a discount snapshot is priced by a plan; an older order is not. Looked at only after the replay above.
  v_slot:=EXISTS(SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id=v_order);
  IF v_slot AND v_pricing IS NULL THEN RAISE EXCEPTION 'UNIT_PRICING_REQUIRED' USING ERRCODE='22023'; END IF;
  IF NOT v_slot AND v_pricing IS NOT NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_legacy'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    WHERE NOT EXISTS(SELECT 1 FROM public.order_return_lines AS l WHERE l.id=x.return_line_id AND l.return_id=_return_id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id=x.return_line_id
    GROUP BY x.return_line_id,g.unprocessed HAVING pg_catalog.sum(x.quantity)>g.unprocessed) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_sent
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text,quantity integer) WHERE x.disposition='sent_back';
  IF v_sent>0 AND NULLIF(pg_catalog.btrim(_sent_back_message),'') IS NULL THEN
    RAISE EXCEPTION 'RETURN_SENT_BACK_MESSAGE_REQUIRED' USING ERRCODE='22023'; END IF;
  -- Existing business rule (unchanged).
  IF v_sent>0 AND NOT _notify_customer THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text) WHERE x.disposition='pending_inspection')
    AND NOT (SELECT s.inspection_enabled FROM public.shop_return_settings AS s WHERE s.id=1) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Existing business rule (unchanged).
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text)
    LEFT JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason=l.reason
    WHERE l.return_id IS DISTINCT FROM _return_id OR l.resolution IS DISTINCT FROM 'exchange'
      OR l.exchange_method IS DISTINCT FROM 'stock' OR rs.out_of_stock_exchange IS NULL
      OR (rs.out_of_stock_exchange='make' AND x.action<>'refund')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
        WHERE u.return_line_id=l.id AND u.disposition<>'sent_back')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Effective rows: a refund row takes its own choice or the parent now/consult; other rows keep NULL.
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',e.return_line_id,
      'disposition',e.disposition,'quantity',e.quantity,'resolution',e.resolution,
      'exchange_method',e.exchange_method,'refund_choice',e.refund_choice)
      ORDER BY e.return_line_id,e.disposition,e.refund_choice NULLS FIRST)
    INTO v_effective
  FROM (
    SELECT y.return_line_id,y.disposition,y.resolution,y.exchange_method,
      CASE WHEN y.resolution='refund' THEN COALESCE(y.unit_choice,
        CASE WHEN _refund_choice IN ('now','consult') THEN _refund_choice END) END AS refund_choice,
      pg_catalog.sum(y.quantity)::integer AS quantity
    FROM (
      SELECT u.return_line_id,u.disposition,u.quantity,u.refund_choice AS unit_choice,
        CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END AS resolution,
        CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
          WHEN x.action='make' THEN 'make' ELSE l.exchange_method END AS exchange_method
      FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer,refund_choice text)
      JOIN public.order_return_lines AS l ON l.id=u.return_line_id
      LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id
    ) AS y
    GROUP BY 1,2,3,4,5
  ) AS e;
  SELECT COALESCE(pg_catalog.bool_or(x.refund_choice='now'),false),COALESCE(pg_catalog.bool_or(x.refund_choice='consult'),false),
    COALESCE(pg_catalog.bool_or(x.resolution='refund' AND x.refund_choice IS NULL),false)
    INTO v_has_now,v_has_consult,v_unresolved
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(resolution text,refund_choice text);
  v_derived:=CASE WHEN v_has_now AND v_has_consult THEN 'mixed' WHEN v_has_now THEN 'now' WHEN v_has_consult THEN 'consult' END;
  IF (v_unresolved AND _refund_choice<>'none')
    OR (_refund_choice='none' AND v_derived IS NOT NULL)
    OR (v_derived IS NOT NULL AND v_derived<>_refund_choice)
    OR (_refund_choice='mixed' AND v_derived IS NULL)
    OR ((_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) AND NOT v_has_now) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF v_slot THEN
    BEGIN
      IF pg_catalog.jsonb_typeof(v_pricing->'orderId') IS DISTINCT FROM 'string' OR (v_pricing->>'orderId') IS DISTINCT FROM v_order::text
        OR (v_pricing->>'kind') IS DISTINCT FROM 'return_receive'
        OR pg_catalog.jsonb_typeof(v_pricing->'lines') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(COALESCE(v_pricing->'treatments','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines';
      END IF;
      IF pg_catalog.jsonb_typeof(v_pricing->'nowRefund') IS DISTINCT FROM 'number' OR (v_pricing->>'nowRefund') !~ '^[0-9]{1,9}$'
        OR pg_catalog.jsonb_typeof(v_pricing->'consultRefund') IS DISTINCT FROM 'number' OR (v_pricing->>'consultRefund') !~ '^[0-9]{1,9}$' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1';
      END IF;
      -- The returned lines of the plan are exactly the refund units of this receipt, per return line and per part (now / consult).
      IF EXISTS (
        SELECT 1 FROM (
          SELECT x.return_line_id,x.refund_choice AS part,pg_catalog.sum(x.quantity)::integer AS n
          FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,refund_choice text)
          WHERE x.resolution='refund' AND x.refund_choice IN ('now','consult') AND x.disposition IN ('restocked','not_restocked','pending_inspection')
          GROUP BY 1,2
        ) AS w FULL JOIN (
          SELECT l."returnLineId" AS return_line_id,l.part,pg_catalog.count(*)::integer AS n
          FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,part text)
          WHERE l."lineKind"='returned' GROUP BY 1,2
        ) AS h ON h.return_line_id=w.return_line_id AND h.part=w.part
        WHERE w.n IS DISTINCT FROM h.n
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines'; END IF;
      -- Every returned plan line is held by the item of its return line (for an exchange item return, the exchange item).
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,"holderOrderItemId" uuid)
        LEFT JOIN public.order_return_lines AS rl ON rl.id=l."returnLineId"
        WHERE l."lineKind"='returned' AND l."holderOrderItemId" IS DISTINCT FROM rl.order_item_id
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines'; END IF;
      -- A discount treatment names a returned line and agrees with the side the plan gave that line.
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_to_recordset(COALESCE(v_pricing->'treatments','[]'::jsonb)) AS t("returnLineId" uuid,treatment text)
        WHERE t."returnLineId" IS NULL OR t.treatment IS NULL OR t.treatment NOT IN ('shop','customer')
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid)
            WHERE l."lineKind"='returned' AND l."returnLineId"=t."returnLineId")
          OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,"stateAfter" text)
            WHERE l."lineKind"='returned' AND l."returnLineId"=t."returnLineId"
              AND l."stateAfter" IS DISTINCT FROM CASE t.treatment WHEN 'shop' THEN 'returned_shop' ELSE 'returned_customer' END)
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_treatment'; END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datatype_mismatch OR invalid_parameter_value THEN
      IF SQLSTATE='22023' AND SQLERRM='UNIT_PRICING_INVALID' THEN RAISE; END IF;
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1';
    END;
  END IF;
  -- Select methods from pre-receipt F in the existing line order, without reserving stock.
  -- Fees and receipt rows are final before ordinary FIFO can allocate any exchange line.
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  SELECT COALESCE(pg_catalog.jsonb_object_agg(v.id::text, v.stock_quantity), '{}'::jsonb)
    INTO v_free_by_variant FROM public.item_variants AS v WHERE v.id = ANY(v_variants);
  FOR v_line IN SELECT l.*,pg_catalog.sum(x.quantity)::integer AS picked,ov.action AS override_action
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_fulfillments AS f ON f.id=l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS ov(return_line_id uuid,action text) ON ov.return_line_id=l.id
    WHERE l.resolution='exchange' AND x.disposition<>'sent_back'
    GROUP BY l.id,f.number,oi.created_at,ov.action
    ORDER BY f.number,oi.created_at,l.order_item_id,l.id
  LOOP
    IF v_line.exchange_method='make' THEN
      v_action:='make';
    ELSE
      v_available := COALESCE((v_free_by_variant->>v_line.exchange_variant_id::text)::integer, 0);
      IF v_available>=v_line.picked THEN
        -- Existing business rule (unchanged).
        IF v_line.override_action IS NOT NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
        v_action:='stock';
        v_free_by_variant := pg_catalog.jsonb_set(v_free_by_variant, ARRAY[v_line.exchange_variant_id::text],
          pg_catalog.to_jsonb(v_available-v_line.picked));
      ELSIF v_line.override_action IS NOT NULL THEN
        v_action:=v_line.override_action;
      ELSIF (SELECT rs.out_of_stock_exchange FROM public.shop_return_reason_settings AS rs WHERE rs.reason=v_line.reason)='make' THEN
        v_action:='make';
      ELSE
        RAISE EXCEPTION 'RETURN_EXCHANGE_OUT_OF_STOCK' USING ERRCODE='22023';
      END IF;
    END IF;
    -- Existing business rule (unchanged).
    CONTINUE WHEN v_action='refund';
    SELECT COALESCE(pg_catalog.sum(e.quantity),0)::integer INTO v_offset FROM public.order_items AS e
    JOIN public.order_return_lines AS old ON old.id=e.exchange_return_line_id WHERE old.order_item_id=v_line.order_item_id;
    IF v_slot THEN
      -- Unit binding: the exchange units take kept slots held by the returned line's item: the slots bound to this return line
      -- (FREQ-641 return_line_id) first, then the cheapest slot (the H cheapest-first order the design allows, 4-1), then the order item
      -- and unit_index order. A slot the plan returns, or a slot another refund holds (refund_id), is not taken. The exchange
      -- price (display only) is the sum of the slots' prices after this event.
      v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
      v_price_sum:=0;v_k:=0;
      FOR v_pick IN SELECT s.order_item_id AS slot_item,s.unit_index AS slot_index,COALESCE(pk."priceAfter",s.current_price) AS price,
          s.holder_order_item_id AS holder_item,s.holder_unit_index AS holder_index
        FROM public.order_unit_slots AS s
        JOIN public.order_line_unit_amounts AS u ON u.order_item_id=s.order_item_id AND u.unit_index=s.unit_index
        LEFT JOIN pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS pk("lineKind" text,"orderItemId" uuid,"unitIndex" integer,"priceAfter" integer)
          ON pk."lineKind" IN ('returned','kept') AND pk."orderItemId"=s.order_item_id AND pk."unitIndex"=s.unit_index
        WHERE s.order_id=v_order AND s.state='kept' AND s.holder_order_item_id=v_line.order_item_id AND u.refund_id IS NULL
          AND (pk."lineKind" IS NULL OR pk."lineKind"<>'returned')
          AND NOT ((s.order_item_id::text||':'||s.unit_index::text)=ANY(v_taken))
        ORDER BY (u.return_line_id IS NOT DISTINCT FROM v_line.id) DESC,s.current_price,s.order_item_id,s.unit_index
        LIMIT v_line.picked LOOP
        v_taken:=v_taken||(v_pick.slot_item::text||':'||v_pick.slot_index::text);
        v_links:=v_links||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('exchange',v_item,'index',v_k,
          'slot_item',v_pick.slot_item,'slot_index',v_pick.slot_index,
          'prev_item',CASE WHEN v_pick.holder_item<>v_pick.slot_item OR v_pick.holder_index<>v_pick.slot_index THEN v_pick.holder_item END,
          'prev_index',CASE WHEN v_pick.holder_item<>v_pick.slot_item OR v_pick.holder_index<>v_pick.slot_index THEN v_pick.holder_index END));
        v_price_sum:=v_price_sum+v_pick.price;v_k:=v_k+1;
      END LOOP;
      IF v_k<>v_line.picked THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_exchange_slots'; END IF;
      v_paid:=v_price_sum;
    ELSIF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=v_line.order_item_id) THEN
      -- I-1: own units after the waiting ones, then free units from one queue per item, so two exchange lines
      -- of the same item never price the same free unit (the old per-line call restarted the free units each time).
      SELECT p.refund_waiting INTO v_h_offset FROM private.order_return_line_progress(_return_id) AS p WHERE p.return_line_id=v_line.id;
      SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_h_own
        FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
      SELECT COALESCE(pg_catalog.array_agg(u.paid_amount ORDER BY u.paid_amount,u.unit_index),ARRAY[]::integer[]) INTO v_h_free
        FROM public.order_line_unit_amounts AS u
        WHERE u.order_item_id=v_line.order_item_id AND u.return_line_id IS NULL AND u.refund_id IS NULL;
      IF v_h_offset IS NULL OR v_h_offset<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_h_used:=COALESCE((v_exchange_used->>v_line.order_item_id::text)::integer,0)
        +GREATEST(v_h_offset-pg_catalog.cardinality(v_h_own),0);
      v_h_take:=LEAST(v_line.picked,GREATEST(pg_catalog.cardinality(v_h_own)-v_h_offset,0));
      v_h_part:=v_h_own[(v_h_offset+1):(v_h_offset+v_h_take)]
        ||COALESCE(v_h_free[(v_h_used+1):(v_h_used+v_line.picked-v_h_take)],ARRAY[]::integer[]);
      IF pg_catalog.cardinality(v_h_part)<>v_line.picked THEN
        RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_paid:=COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_h_part) AS x(amount)),0)::integer;
      v_exchange_used:=pg_catalog.jsonb_set(v_exchange_used,ARRAY[v_line.order_item_id::text],
        pg_catalog.to_jsonb(v_h_used+v_line.picked-v_h_take));
    ELSE
      v_paid:=private.return_units_amount(v_line.order_item_id,v_line.picked,v_offset);
    END IF;
    -- Existing business rule (unchanged).
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,'disposition',u.disposition,
        'quantity',u.quantity,'resolution',u.resolution,'exchange_method',CASE WHEN u.return_line_id=v_line.id
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END,'refund_choice',u.refund_choice)
        ORDER BY u.return_line_id,u.disposition,u.refund_choice NULLS FIRST)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,
      resolution text,exchange_method text,refund_choice text);
    v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
    INSERT INTO public.order_items(id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,
      fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
    SELECT v_item,v_order,v.item_id,v.id,i.name,0,c.name,z.label,v_line.picked,0,
      CASE WHEN v_action='stock' THEN 'stock' ELSE 'backorder' END,'exchange',v_line.id,v_paid
    FROM public.item_variants AS v JOIN public.items AS i ON i.id=v.item_id
    LEFT JOIN public.item_colors AS c ON c.id=v.color_id LEFT JOIN public.item_sizes AS z ON z.id=v.size_id
    WHERE v.id=v_line.exchange_variant_id;
    v_exchange_ids:=v_exchange_ids||v_item;v_exchange:=v_exchange+v_line.picked;
  END LOOP;
  -- Preserve the original restock rejection before any refund validation or fee decision.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' AND oi.variant_id IS NULL
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_slot THEN
    -- Unit binding: the units, the amounts and the item lines come from the plan, not from the position counting below.
    SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='now'),0)::integer,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='consult'),0)::integer
      INTO v_total,v_now_total,v_consult_total
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(quantity integer,disposition text,resolution text,refund_choice text)
    WHERE x.resolution='refund' AND x.refund_choice IN ('now','consult') AND x.disposition IN ('restocked','not_restocked','pending_inspection');
    v_now_picked:=v_now_total;
    v_goods:=(v_pricing->>'nowRefund')::integer;
    v_goods_consult:=(v_pricing->>'consultRefund')::integer;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',c.item,'before_shipment',false,'quantity',c.n) ORDER BY c.item),'[]'::jsonb)
      INTO v_lines
    FROM (SELECT rl.order_item_id AS item,pg_catalog.count(*)::integer AS n
      FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,part text)
      JOIN public.order_return_lines AS rl ON rl.id=l."returnLineId"
      WHERE l."lineKind"='returned' AND l.part='now' GROUP BY rl.order_item_id) AS c;
  ELSE
  -- Per item: T from all effective rows, now from the rows without consult, consult from the rest of T.
  v_now_effective:=COALESCE((SELECT pg_catalog.jsonb_agg(e.value) FROM pg_catalog.jsonb_array_elements(v_effective) AS e(value)
    WHERE (e.value->>'refund_choice') IS DISTINCT FROM 'consult'),'[]'::jsonb);
  WITH before_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states(v_order) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_now AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_now_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), picked AS (
    SELECT l.order_item_id,pg_catalog.sum(x.quantity)::integer AS total,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='now'),0)::integer AS now_n,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='consult'),0)::integer AS consult_n
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,quantity integer,resolution text,refund_choice text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    WHERE x.resolution='refund' GROUP BY l.order_item_id
  ), counted AS (
    SELECT p.order_item_id,p.now_n,p.consult_n,LEAST(p.total,GREATEST(a.waiting-b.waiting,0)) AS total_q,
      LEAST(p.now_n,p.total,GREATEST(COALESCE(n.waiting,b.waiting)-b.waiting,0)) AS now_q
    FROM picked AS p JOIN before_receive AS b ON b.order_item_id=p.order_item_id
    JOIN after_receive AS a ON a.order_item_id=p.order_item_id
    LEFT JOIN after_now AS n ON n.order_item_id=p.order_item_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',c.order_item_id,'total',c.total_q,
      'now',LEAST(c.now_q,c.total_q),'consult',LEAST(c.consult_n,GREATEST(c.total_q-LEAST(c.now_q,c.total_q),0)),
      'now_picked',c.now_n) ORDER BY c.order_item_id),'[]'::jsonb)
    INTO v_qty FROM counted AS c;
  SELECT COALESCE(pg_catalog.sum(q.total),0)::integer,COALESCE(pg_catalog.sum(q.now),0)::integer,
    COALESCE(pg_catalog.sum(q.consult),0)::integer,COALESCE(pg_catalog.sum(q.now_picked),0)::integer
    INTO v_total,v_now_total,v_consult_total,v_now_picked
  FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(total integer,now integer,consult integer,now_picked integer);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',q.order_item_id,'before_shipment',false,'quantity',q.now)
      ORDER BY q.order_item_id) FILTER (WHERE q.now>0),'[]'::jsonb)
    INTO v_lines FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer);
  -- H rows: now skips W0=max(own-unprocessed,0); consult also skips the now units of the same line.
  WITH choice_rows AS (
    SELECT x.return_line_id,x.refund_choice,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,quantity integer,resolution text,refund_choice text)
    WHERE x.resolution='refund' AND x.refund_choice IS NOT NULL GROUP BY x.return_line_id,x.refund_choice
  ), placed AS (
    SELECT r.*,GREATEST((SELECT pg_catalog.count(*)::integer FROM private.group_h_return_unit_rows(r.return_line_id) AS b
        WHERE b.remaining_index IS NOT NULL)-p.unprocessed,0)
      +CASE WHEN r.refund_choice='consult' THEN COALESCE((SELECT o.quantity FROM choice_rows AS o
        WHERE o.return_line_id=r.return_line_id AND o.refund_choice='now'),0) ELSE 0 END AS unit_offset
    FROM choice_rows AS r JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=r.return_line_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'resolution','refund',
      'quantity',x.quantity,'unit_offset',x.unit_offset,'refund_choice','now')) FILTER (WHERE x.refund_choice='now'),'[]'::jsonb),
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'resolution','refund',
      'quantity',x.quantity,'unit_offset',x.unit_offset,'refund_choice','consult')) FILTER (WHERE x.refund_choice='consult'),'[]'::jsonb)
    INTO v_now_elements,v_consult_elements FROM placed AS x;
  -- I-1: cap the now rows of each item at the counted now units in line order (the order the cap and the
  -- slices take them), so the consult pass below starts after exactly the free units the now pass used.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_set(e.value,ARRAY['quantity'],pg_catalog.to_jsonb(e.capped))
      ORDER BY e.line_id) FILTER (WHERE e.capped>0),'[]'::jsonb) INTO v_now_elements
  FROM (
    SELECT x.value,l.id AS line_id,LEAST((x.value->>'quantity')::integer,GREATEST(q.now-COALESCE(pg_catalog.sum((x.value->>'quantity')::integer)
      OVER (PARTITION BY l.order_item_id ORDER BY l.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0),0)) AS capped
    FROM pg_catalog.jsonb_array_elements(v_now_elements) AS x(value)
    JOIN public.order_return_lines AS l ON l.id=(x.value->>'return_line_id')::uuid
    JOIN pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer) ON q.order_item_id=l.order_item_id
  ) AS e;
  SELECT COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.now,v_now_elements)
      ELSE private.return_units_amount(q.order_item_id,q.now,0) END),0)::integer,
    COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      -- I-1: the consult units come after the now units of the same item; the now pass's free units are not reused.
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.now+q.consult,v_now_elements||v_consult_elements)
        -private.group_h_receiving_amount(_return_id,q.order_item_id,q.now,v_now_elements)
      ELSE private.return_units_amount(q.order_item_id,q.now+q.consult,0)-private.return_units_amount(q.order_item_id,q.now,0) END),0)::integer
    INTO v_goods,v_goods_consult
  FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer,consult integer);
  END IF;
  IF (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) AND v_now_total<v_now_picked THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF _refund_choice='none' AND v_total>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_choice:=CASE WHEN v_now_total>0 AND v_consult_total>0 THEN 'mixed' WHEN v_now_total>0 THEN 'now'
    WHEN v_consult_total>0 THEN 'consult' ELSE 'none' END;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fixed:=CASE WHEN v_first_goods AND (v_total>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF v_slot THEN
    -- The restocking rate is inside E: the plan's nowRefund and consultRefund are already net of it. Only the fixed fees remain.
    v_fees:=v_fixed;v_fee_consult:=0;
  ELSE
    v_fees:=(v_goods::bigint*(CASE WHEN _restocking_fee_waived THEN 0 ELSE v_return.restocking_fee_percent END)/100)::integer+v_fixed;
    v_fee_consult:=(v_goods_consult::bigint*(CASE WHEN _restocking_fee_waived THEN 0 ELSE v_return.restocking_fee_percent END)/100)::integer;
  END IF;
  IF v_now_total>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    SELECT a.refundable_amount,a.refundable_shipping INTO v_refundable,v_refundable_shipping
      FROM private.order_refund_amounts(v_order) AS a;
    IF _refund_amount IS NOT NULL AND _refund_amount<_refund_shipping_amount THEN
      RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
    IF _refund_shipping_amount>COALESCE(v_refundable_shipping,0) THEN
      RAISE EXCEPTION 'REFUND_SHIPPING_EXCEEDS' USING ERRCODE='22023'; END IF;
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount>LEAST(COALESCE(v_refundable,0),v_goods+_refund_shipping_amount) THEN
        RAISE EXCEPTION 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    IF v_slot THEN v_amount:=LEAST(v_amount,COALESCE(v_refundable,0)); END IF;
    IF v_consult_total>0 THEN
      v_pending:=GREATEST(v_fees-v_goods,0)+v_fee_consult;
    ELSE
      v_due:=GREATEST(v_fees-v_goods,0);
    END IF;
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
  ELSIF v_consult_total>0 THEN v_pending:=v_fee_consult+v_fixed;
  ELSE v_due:=v_fees;
  END IF;
  -- Existing business rule (unchanged).
  IF v_refund IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0
      AND pg_catalog.left(o.payment_intent_id,3)='pi_' AND pg_catalog.char_length(o.payment_intent_id)>3
  ) THEN RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  -- ACC_P3_BEGIN
  -- The chosen arrival date (FREQ-575-AC-01): from the day the return was requested up to today in Japan, after the day a card
  -- dispute of the order was confirmed lost. Checked under the locks, after the replay above.
  IF _arrived_on IS NOT NULL THEN
    PERFORM private.accounting_assert_arrival_date(_return_id,v_order,_arrived_on);
  END IF;
  -- ACC_P3_END
  BEGIN
    -- N-1: keep the consult units this receipt made waiting (after the cover cap); not part of the fingerprint.
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund,consult_quantity,restocking_fee_waived
      -- ACC_P3_BEGIN
      ,arrived_on
      -- ACC_P3_END
      )
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',v_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund,v_consult_total,_restocking_fee_waived
      -- ACC_P3_BEGIN
      ,COALESCE(_arrived_on,private.accounting_jst_date(pg_catalog.now()))
      -- ACC_P3_END
      );
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
  IF v_slot THEN
    -- The discount treatment of each returned line (who set it and when stays on the receipt), then the plan: the version and the
    -- formula are checked there and nothing is written when they do not hold.
    INSERT INTO public.order_return_line_treatments(return_line_id,treatment,receipt_id,actor_id)
    SELECT DISTINCT ON (t."returnLineId") t."returnLineId",t.treatment,v_receipt,_actor_id
    FROM pg_catalog.jsonb_to_recordset(COALESCE(v_pricing->'treatments','[]'::jsonb)) AS t("returnLineId" uuid,treatment text)
    ORDER BY t."returnLineId";
    -- An exchange-only receipt changes no slot state, price or hold: the plan has no line, and no event is written for it.
    v_version:=private.order_unit_version(v_order);
    IF pg_catalog.jsonb_array_length(v_pricing->'lines')>0 OR pg_catalog.jsonb_array_length(COALESCE(v_pricing->'holds','[]'::jsonb))>0 THEN
      v_event:=private.order_unit_apply_plan(v_pricing,_request_key,_return_id,v_receipt,_actor_id);
    END IF;
  END IF;
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method,refund_choice)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method,x.refund_choice
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,
    resolution text,exchange_method text,refund_choice text);
  IF v_waived THEN
    -- Only the now units end here; consultation units stay waiting.
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer,refund_choice text)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' AND x.refund_choice='now' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_slot THEN
    -- Exchange links: one row per exchange unit; the slot's holder becomes the exchange unit (price and state are unchanged).
    INSERT INTO public.order_unit_exchange_links(exchange_order_item_id,exchange_unit_index,slot_order_item_id,slot_unit_index,
      previous_order_item_id,previous_unit_index,receipt_id)
    SELECT (x.value->>'exchange')::uuid,(x.value->>'index')::integer,(x.value->>'slot_item')::uuid,(x.value->>'slot_index')::integer,
      (x.value->>'prev_item')::uuid,(x.value->>'prev_index')::integer,v_receipt
    FROM pg_catalog.jsonb_array_elements(v_links) AS x(value);
    UPDATE public.order_unit_slots AS s SET holder_order_item_id=(x.value->>'exchange')::uuid,holder_unit_index=(x.value->>'index')::integer
    FROM pg_catalog.jsonb_array_elements(v_links) AS x(value)
    WHERE s.order_item_id=(x.value->>'slot_item')::uuid AND s.unit_index=(x.value->>'slot_index')::integer;
  END IF;
  IF v_refund IS NOT NULL THEN
    -- Every refund of a receive passes through the core. For an order with a discount snapshot the core takes the line amounts from the
    -- event's allocations, claims no unit by position and ties the refund to the event (order_unit_link_refund, part now).
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods),
      CASE WHEN v_slot THEN v_event END) AS r;
    -- The claim may change which units stay bound; settle the release in the same lock.
    PERFORM private.group_h_release_return_units(_return_id);
  END IF;
  -- ACC_P3_BEGIN
  -- Accounting plan 3 (FREQ-578-AC-01 / AC-02 / AC-08, FREQ-576-AC-03): the arrival fact (the goods before the fee G and the fee
  -- F of every unit of this receipt) and, when this receipt starts a refund or ends its now units with no refund, the decision.
  -- Ruling B2: an order with a discount snapshot reads the receipt event (G = standard_refund + fee_amount, F = fee_amount, F now =
  -- fee_amount unless the event returns a consult unit, then 0, G now = now_refund + F now); an older order uses the amounts above.
  IF v_slot THEN
    SELECT e.standard_refund+e.fee_amount,e.fee_amount,e.now_refund,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_unit_event_lines AS l
        WHERE l.event_id=e.id AND l.line_kind='returned' AND l.part='consult') THEN 0 ELSE e.fee_amount END
      INTO v_acc_g,v_acc_f,v_acc_gnow,v_acc_fnow
    FROM public.order_unit_events AS e WHERE e.id=v_event;
    v_acc_g:=COALESCE(v_acc_g,0);v_acc_f:=COALESCE(v_acc_f,0);v_acc_fnow:=COALESCE(v_acc_fnow,0);
    v_acc_gnow:=COALESCE(v_acc_gnow,0)+v_acc_fnow;
  ELSE
    v_acc_g:=v_goods+v_goods_consult;v_acc_f:=LEAST(v_fees+v_fee_consult,v_acc_g);
    v_acc_gnow:=v_goods;v_acc_fnow:=LEAST(v_fees,v_goods);
  END IF;
  IF v_acc_g>0 THEN
    PERFORM private.accounting_record_return_arrival(v_receipt,_return_id,v_order,v_acc_g,v_acc_f);
  END IF;
  IF v_refund IS NOT NULL THEN
    PERFORM private.accounting_record_return_decision(_return_id,v_order,v_refund,v_amount-_refund_shipping_amount,v_receipt,
      v_acc_fnow,v_acc_gnow,v_acc_fnow);
  ELSIF v_waived THEN
    PERFORM private.accounting_record_return_decision(_return_id,v_order,NULL,0,v_receipt,0,v_acc_gnow,v_acc_fnow);
  END IF;
  -- ACC_P3_END
  -- Unit binding: money held back on earlier orders that this receive gives back is refunded here, each as its own event and refund.
  IF v_slot AND pg_catalog.jsonb_array_length(COALESCE(v_pricing->'releases','[]'::jsonb))>0 THEN
    FOR v_rel IN SELECT * FROM private.order_unit_apply_releases(v_pricing,v_version,v_order,_request_key,_actor_id) LOOP
      IF v_rel.refund_amount>0 THEN
        SELECT c.refund_id INTO v_rid FROM private.begin_order_refund_core(v_rel.held_order_id,'unit_hold_release',v_rel.request_key,
          '[]'::jsonb,false,0,v_rel.refund_amount,NULL,'requested_by_customer',NULL,false,_actor_id,NULL,
          NULL::uuid,NULL::integer,v_rel.event_id) AS c;
        v_released:=v_released||v_rid;
      END IF;
    END LOOP;
  END IF;
  -- Existing business rule (unchanged).
  UPDATE public.order_returns AS rt SET fee_due_amount=rt.fee_due_amount+v_due,
    fee_pending_deduction=rt.fee_pending_deduction+v_pending,
    fee_waived=CASE WHEN v_due>0 THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_note END WHERE rt.id=_return_id;
  -- Restock after method selection; receipt rows and fees precede ordinary FIFO.
  FOR v_line IN SELECT l.order_item_id,oi.variant_id,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' GROUP BY l.order_item_id,oi.variant_id ORDER BY oi.variant_id,l.order_item_id
  LOOP
    IF v_line.variant_id IS NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
    VALUES(v_line.variant_id,v_line.quantity,'return',v_order,v_line.order_item_id,_actor_id,_return_id);
  END LOOP;
  IF v_exchange>0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id',_actor_id::text,true);
    PERFORM pg_catalog.set_config('app.order_change_reason','return_exchange_added',true);
    PERFORM pg_catalog.set_config('app.order_source_event_id','',true);
    UPDATE public.orders AS o SET status='paid',shipped_at=NULL,shipping_carrier=NULL,tracking_number=NULL
    WHERE o.id=v_order AND o.status='shipped';
  END IF;
  IF NOT _actor_can_refund AND v_choice IN ('consult','mixed') THEN
    v_shop:=private.enqueue_return_email(v_order,'return_refund_pending_shop',_return_id,v_receipt);
  END IF;
  IF _notify_customer AND v_refund IS NULL THEN
    PERFORM private.enqueue_return_email(v_order,CASE WHEN v_sent=(SELECT pg_catalog.sum(x.quantity)
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(quantity integer)) THEN 'return_sent_back' ELSE 'return_received' END,_return_id,v_receipt);
  END IF;
  return_status:=private.refresh_order_return_status(_return_id);
  SELECT rt.fee_due_amount INTO fee_due_amount FROM public.order_returns AS rt WHERE rt.id=_return_id;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_receive_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_receive_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_receive_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt,return_status,v_refund,v_amount,v_status,
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false,v_released;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE FUNCTION public.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text, _pricing jsonb DEFAULT NULL,
  _restocking_fee_waived boolean DEFAULT false, _arrived_on date DEFAULT NULL
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean,
  release_refund_ids uuid[])
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_receive_return(_return_id, _actor_id, _actor_can_refund, _request_key, _units, _exchange_overrides, _refund_choice, _refund_amount, _refund_shipping_amount, _note, _notify_customer, _sent_back_message, _sent_back_carrier, _sent_back_tracking_number, _pricing, _restocking_fee_waived
  -- ACC_P3_BEGIN
  , _arrived_on
  -- ACC_P3_END
  );
$$;

ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) TO service_role;
ALTER FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date) TO service_role;

-- 3. admin_refund_return keeps the decision of a refund it starts or of a refund of nothing (X4 body, ACC_P3 blocks).
CREATE OR REPLACE FUNCTION private.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean,_pricing jsonb DEFAULT NULL
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean,release_refund_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns%ROWTYPE;v_order uuid;v_fp text;v_old public.order_refunds%ROWTYPE;
  v_lines jsonb;v_goods integer;v_cap integer;v_amount integer;v_result record;v_receipt public.order_return_receipts%ROWTYPE;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_pricing jsonb := CASE WHEN pg_catalog.jsonb_typeof(_pricing) = 'null' THEN NULL ELSE _pricing END;
  v_slot boolean := false;
  v_related uuid[];
  v_event uuid;
  v_version text;
  v_released uuid[] := ARRAY[]::uuid[];
  v_rel record;
  v_rid uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _notify_customer IS NULL
    OR _shipping_amount IS NULL OR _shipping_amount<0 OR (_amount IS NOT NULL AND _amount<0)
    OR pg_catalog.char_length(_note)>500
    OR (_pricing IS NOT NULL AND pg_catalog.jsonb_typeof(_pricing) NOT IN ('object', 'null')) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_amount,
    'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  -- Unit binding: an order with a discount snapshot also locks the member's related orders (a release may touch their holds), with the one call below.
  IF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = v_order_id) THEN
    v_related := private.order_unit_related_orders(v_order_id);
  END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id] || COALESCE(v_related, ARRAY[]::uuid[]), NULL);
  -- Approval may have changed the exchange target while this entry waited on the advisory.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT r.* INTO v_old FROM public.order_refunds AS r WHERE r.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id IS DISTINCT FROM _return_id OR v_old.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT v_old.id,v_old.amount,v_old.status,true,private.order_unit_release_refund_ids(_request_key,v_old.order_id);RETURN;
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_receipt.return_id IS DISTINCT FROM _return_id OR v_receipt.kind<>'waive_refund'
      OR v_receipt.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT NULL::uuid,0,'waived'::text,true,private.order_unit_release_refund_ids(_request_key,v_order_id);RETURN;
  END IF;
  -- Existing business rule (unchanged).
  IF v_return.status NOT IN ('open','closed') THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  -- Unit binding: the pricing is looked at only after the replays above. A consult refund changes no slot state, so the pricing carries
  -- only the releases of money held on earlier orders (and the version it was made from); an older order carries none.
  v_slot:=EXISTS(SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id=v_order);
  IF NOT v_slot AND v_pricing IS NOT NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_legacy'; END IF;
  IF v_slot THEN
    IF v_related IS DISTINCT FROM private.order_unit_related_orders(v_order) THEN
      RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001'; END IF;
    IF v_pricing IS NOT NULL THEN
      IF pg_catalog.jsonb_typeof(v_pricing->'orderId') IS DISTINCT FROM 'string' OR (v_pricing->>'orderId') IS DISTINCT FROM v_order::text
        OR pg_catalog.jsonb_typeof(v_pricing->'version') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(v_pricing->'releases') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1'; END IF;
      v_version:=private.order_unit_version(v_order);
      IF v_pricing->>'version' IS DISTINCT FROM v_version THEN RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001'; END IF;
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,
      'before_shipment',false,'quantity',t.quantity) ORDER BY t.order_item_id),'[]'::jsonb),
    COALESCE(pg_catalog.sum(CASE WHEN v_slot THEN 0
      WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=t.order_item_id)
      THEN private.group_h_return_refund_amount(_return_id,t.order_item_id,t.quantity)
      ELSE private.return_units_amount(t.order_item_id,t.quantity) END),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,pg_catalog.sum(g.refund_waiting)::integer AS quantity
      FROM private.order_return_line_progress(_return_id) AS g JOIN public.order_return_lines AS l ON l.id=g.return_line_id
      WHERE g.refund_waiting>0 GROUP BY l.order_item_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_lines)=0 THEN RAISE EXCEPTION 'RETURN_NOTHING_TO_REFUND' USING ERRCODE='22023'; END IF;
  IF v_slot THEN
    -- The standard amount is the stored amount of every (event, part) the refund covers (R34, FREQ-642-AC-37): the consult part no live
    -- consult refund covers and the now part whose now refund failed. The core links the same (event, part) and the screen
    -- (loadConsultOutstanding) counts the same. A manager's change of an earlier refund is not carried.
    SELECT COALESCE(pg_catalog.sum(c.amount),0)::integer INTO v_goods
    FROM private.order_unit_return_refund_parts(_return_id) AS c
    JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order;
    SELECT c.event_id INTO v_event FROM private.order_unit_return_refund_parts(_return_id) AS c
    JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order
    ORDER BY c.seq DESC LIMIT 1;
    IF v_event IS NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_refund_event'; END IF;
  END IF;
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_cap:=GREATEST(v_goods-v_return.fee_pending_deduction,0)+_shipping_amount;
  v_amount:=COALESCE(_amount,v_cap);
  IF v_amount<_shipping_amount
    OR (_amount IS NOT NULL AND _amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a)) THEN
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  -- A refund of nothing closes every waiting unit, so on the slot path it is refused, as the core refuses a refund, unless the units of
  -- the parts it records are exactly the waiting units (a now refund in error keeps its units waiting but its part live) (FREQ-642-AC-37).
  IF v_slot AND v_amount=0 AND EXISTS (
    SELECT 1 FROM (SELECT l.holder_order_item_id AS item,pg_catalog.count(*)::integer AS n
        FROM public.order_unit_event_lines AS l
        JOIN private.order_unit_return_refund_parts(_return_id) AS c ON c.event_id=l.event_id AND c.part=COALESCE(l.part,'now')
        WHERE l.line_kind='returned' GROUP BY l.holder_order_item_id) AS g
    FULL JOIN pg_catalog.jsonb_to_recordset(v_lines) AS p(order_item_id uuid,quantity integer) ON p.order_item_id=g.item
    WHERE g.item IS NULL OR p.order_item_id IS NULL OR g.n<>p.quantity) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_refund_lines'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  IF v_amount=0 THEN
    -- Existing business rule (unchanged).
    BEGIN
      INSERT INTO public.order_return_receipts(return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
        notify_customer,note,actor_id,actor_can_refund)
      VALUES(_return_id,_request_key,v_fp,'waive_refund',NULL,NULL,_notify_customer,_note,_actor_id,true)
      RETURNING * INTO v_receipt;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
    -- ACC_P3_BEGIN
    -- Accounting plan 3 (FREQ-578-AC-08): the refund of nothing ends every waiting unit of the return; the decision is tied to this
    -- receipt (path 2 of accounting_record_return_decision).
    PERFORM private.accounting_record_return_decision(_return_id,v_order,NULL,0,v_receipt.id,0,NULL,NULL);
    -- ACC_P3_END
    -- The (event, part) this refund of nothing closes are never covered again (FREQ-642-AC-37); read before the receipt lines.
    IF v_slot THEN
      INSERT INTO public.order_unit_event_waives(event_id,part,receipt_id)
      SELECT c.event_id,c.part,v_receipt.id FROM private.order_unit_return_refund_parts(_return_id) AS c
      JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order;
    END IF;
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt.id,g.return_line_id,'refund_waived',g.refund_waiting,NULL,NULL
    FROM private.order_return_line_progress(_return_id) AS g WHERE g.refund_waiting>0;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0 AND pg_catalog.left(o.payment_intent_id,3)='pi_'
      AND pg_catalog.char_length(o.payment_intent_id)>3) THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  SELECT r.* INTO v_result FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,
    _shipping_amount,v_amount,_note,'requested_by_customer',NULL,_notify_customer,_actor_id,_amount,_return_id,
    LEAST(v_return.fee_pending_deduction,v_goods),CASE WHEN v_slot THEN v_event END) AS r;
  -- ACC_P3_BEGIN
  -- Accounting plan 3 (FREQ-578-AC-02): the decision of the refund just started (shipping left out); v_return is still the row
  -- read before the fee_pending_deduction update below.
  PERFORM private.accounting_record_return_decision(_return_id,v_order,v_result.refund_id,v_result.amount-_shipping_amount,NULL,
    LEAST(v_return.fee_pending_deduction,v_goods),NULL,NULL);
  -- ACC_P3_END
  END IF;
  -- Unit binding: money held back on earlier orders that the pricing gives back is refunded here, each as its own event and refund.
  IF v_slot AND v_pricing IS NOT NULL THEN
    FOR v_rel IN SELECT * FROM private.order_unit_apply_releases(v_pricing,v_version,v_order,_request_key,_actor_id) LOOP
      IF v_rel.refund_amount>0 THEN
        SELECT c.refund_id INTO v_rid FROM private.begin_order_refund_core(v_rel.held_order_id,'unit_hold_release',v_rel.request_key,
          '[]'::jsonb,false,0,v_rel.refund_amount,NULL,'requested_by_customer',NULL,false,_actor_id,NULL,
          NULL::uuid,NULL::integer,v_rel.event_id) AS c;
        v_released:=v_released||v_rid;
      END IF;
    END LOOP;
  END IF;
  -- Existing business rule (unchanged).
  UPDATE public.order_returns AS rt SET fee_pending_deduction=0,
    fee_due_amount=rt.fee_due_amount+GREATEST(v_return.fee_pending_deduction-v_goods,0),
    fee_waived=CASE WHEN v_return.fee_pending_deduction>v_goods THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_note END
  WHERE rt.id=_return_id;
  PERFORM private.refresh_order_return_status(_return_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_refund_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_refund_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_refund_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  IF v_amount=0 THEN RETURN QUERY SELECT NULL::uuid,0,'waived'::text,false,v_released;
  ELSE RETURN QUERY SELECT v_result.refund_id,v_result.amount,v_result.status,v_result.replayed,v_released; END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

-- 4. The group G writer list: the receive writer in its 17 argument form (77 entries as before). Rebuilt after the new form
-- exists and before the old form is dropped.
CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist() RETURNS pg_catalog.regprocedure[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ARRAY[
    'private.apply_group_g_stock_movement(bigint,integer)',
    'private.allocate_group_g_fifo(bigint[],uuid,uuid)',
    'private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)',
    'private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)',
    'private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)',
    'private.release_group_g_payment_review_holds(uuid,uuid)',
    'private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
    'private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
    'private.mark_order_awaiting_payment(uuid,text,text)',
    'private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)',
    'private.record_cancelled_order_paid_amount(uuid,text,integer)',
    'private.admin_cancel_failed_order(uuid,uuid,text,text)',
    'private.link_guest_orders(uuid,text)',
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)',
    'private.apply_order_refund_state(uuid)',
    'private.apply_return_refund_outcome(uuid,text)',
    'private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)',
    'private.mark_order_refund_error(uuid,text,boolean)',
    'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)',
    'private.mark_order_reviewed(uuid,uuid)',
    'private.record_payment_exception(text,text,text,text,text,uuid,uuid)',
    'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
    'private.resolve_payment_exception_by_system(uuid,text)',
    'private.customer_order_for_request(uuid,uuid,boolean)',
    'private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)',
    'private.lock_order_cancel_request(uuid)',
    'private.admin_decline_cancel_request(uuid,uuid,text,text)',
    'private.admin_close_cancel_request(uuid,uuid)',
    'private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)',
    'private.lock_order_return(uuid)',
    'private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_cancel_return(uuid,uuid)',
    'private.customer_request_return(uuid,uuid,uuid,jsonb)',
    'private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_decline_return(uuid,uuid,text,text)',
    'private.admin_close_return_missing(uuid,uuid,uuid)',
    'private.admin_reopen_return(uuid,uuid,uuid)',
    'private.admin_inspect_return(uuid,uuid,uuid,jsonb)',
-- ACC_P3_REPLACE_BEGIN bffb3e697a390137c36dd77c4e39c0fb
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date)',
-- ACC_P3_REPLACE_END
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)',
    'private.refresh_order_return_status(uuid)',
    'private.admin_record_return_fee_payment(uuid,uuid,text,boolean)',
    'private.admin_release_return_exchange(uuid,uuid)',
    'private.record_delivery_read_result(uuid,integer,uuid,jsonb)',
    'private.apply_tracking_status(uuid,text,timestamptz,timestamptz)',
    'public.apply_stock_movement()',
    'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
    'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
    'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)',
    'public.admin_record_completion(uuid,uuid,uuid,jsonb)',
    'public.admin_cancel_completion(uuid,uuid,uuid)',
    'private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)',
    'private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)',
    'private.release_group_g_payment_holds(uuid,uuid,text,uuid)',
    'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)',
    'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
    'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
    'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
    'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
    'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
    'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)',
    'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
    'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
    'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
    'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
    'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
    'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
    'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)',
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)'
  ]::pg_catalog.regprocedure[];
$$;

DROP FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean);
DROP FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean);

-- 5. The arrival date correction (FREQ-575-AC-02 / AC-03 / AC-05, FREQ-581-AC-07). The receipt row keeps the date first
-- written; each correction adds a row with the next version. Refused when the old or the new day is on or before the day
-- the order's card dispute was confirmed lost (the confirmed offset entry was made on that ground).
CREATE FUNCTION private.admin_correct_return_arrival_date(_actor_id uuid, _receipt_id uuid, _new_on date, _reason text,
  _expected_version integer, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior public.order_return_arrival_corrections%ROWTYPE;
  v_receipt public.order_return_receipts%ROWTYPE;
  v_order uuid;
  v_version integer;
  v_previous date;
  v_confirmed date;
  v_id uuid;
BEGIN
  IF NOT COALESCE(private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']), false) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _receipt_id IS NULL OR _new_on IS NULL OR _request_key IS NULL OR _expected_version IS NULL OR _expected_version < 0
    OR _reason IS NULL OR pg_catalog.btrim(_reason) = '' OR pg_catalog.char_length(_reason) > 500 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'correct_return_arrival_date',
    'actor', _actor_id, 'receipt_id', _receipt_id, 'new_on', _new_on, 'reason', _reason, 'version', _expected_version));
  SELECT c.* INTO v_prior FROM public.order_return_arrival_corrections AS c WHERE c.request_key = _request_key;
  IF FOUND THEN
    IF v_prior.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('receipt_id', v_prior.receipt_id, 'version', v_prior.version,
      'previous_on', v_prior.previous_on, 'new_on', v_prior.new_on, 'correction_id', v_prior.id, 'replayed', true);
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.id = _receipt_id AND rr.kind = 'receive';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT r.order_id INTO v_order FROM public.order_returns AS r WHERE r.id = v_receipt.return_id;
  SELECT COALESCE(pg_catalog.max(c.version), 0) INTO v_version FROM public.order_return_arrival_corrections AS c
  WHERE c.receipt_id = _receipt_id;
  IF v_version <> _expected_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  v_previous := private.accounting_return_arrival_on(_receipt_id);
  IF v_previous = _new_on THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_confirmed := private.accounting_order_dispute_confirmed_on(v_order);
  IF v_confirmed IS NOT NULL AND v_previous <= v_confirmed THEN
    RAISE EXCEPTION 'RETURN_ARRIVAL_DATE_INVALID' USING ERRCODE = '22023', DETAIL = 'dispute_confirmed';
  END IF;
  PERFORM private.accounting_assert_arrival_date(v_receipt.return_id, v_order, _new_on);
  INSERT INTO public.order_return_arrival_corrections (receipt_id, version, previous_on, new_on, reason, actor_id, request_key,
    request_hash)
  VALUES (_receipt_id, v_version + 1, v_previous, _new_on, _reason, _actor_id, _request_key, v_hash)
  RETURNING id INTO v_id;
  RETURN pg_catalog.jsonb_build_object('receipt_id', _receipt_id, 'version', v_version + 1, 'previous_on', v_previous,
    'new_on', _new_on, 'correction_id', v_id, 'replayed', false);
END;
$$;

CREATE FUNCTION public.admin_correct_return_arrival_date(_actor_id uuid, _receipt_id uuid, _new_on date, _reason text,
  _expected_version integer, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_correct_return_arrival_date(_actor_id, _receipt_id, _new_on, _reason, _expected_version, _request_key) $$;

-- 6. The carrier delivery date option (FREQ-575-AC-04): off by default; the change keeps the day and the person.
CREATE FUNCTION private.admin_set_return_arrival_option(_actor_id uuid, _enabled boolean, _expected_version bigint,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_row public.accounting_return_options%ROWTYPE;
  v_at timestamptz;
  v_result jsonb;
BEGIN
  IF NOT COALESCE(private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']), false) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _enabled IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _request_key IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'set_return_arrival_option', 'actor', _actor_id,
    'enabled', _enabled, 'version', _expected_version::text));
  SELECT o.* INTO v_row FROM public.accounting_return_options AS o WHERE o.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_prior := v_row.admin_requests -> (_request_key::text);
  IF v_prior IS NOT NULL THEN
    IF v_prior ->> 'hash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN (v_prior -> 'result') || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  IF v_row.version <> _expected_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  v_at := pg_catalog.now();
  v_result := pg_catalog.jsonb_build_object('use_carrier_delivery_date', _enabled, 'changed_at', v_at, 'changed_by', _actor_id,
    'version', (v_row.version + 1)::text, 'replayed', false);
  UPDATE public.accounting_return_options AS o
  SET use_carrier_delivery_date = _enabled, changed_at = v_at, changed_by = _actor_id, version = v_row.version + 1,
    admin_requests = o.admin_requests || pg_catalog.jsonb_build_object(_request_key::text,
      pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result))
  WHERE o.id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.admin_set_return_arrival_option(_actor_id uuid, _enabled boolean, _expected_version bigint,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_return_arrival_option(_actor_id, _enabled, _expected_version, _request_key) $$;

-- 7. Readers (service_role only).
CREATE FUNCTION public.get_return_arrival_option() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('use_carrier_delivery_date', o.use_carrier_delivery_date, 'changed_at', o.changed_at,
    'changed_by', o.changed_by, 'version', o.version::text)
  FROM public.accounting_return_options AS o WHERE o.id
$$;

-- The original and the current arrival date of receive receipts, with their corrections (oldest first); 200 ids at most.
CREATE FUNCTION public.get_return_arrival_info(_receipt_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _receipt_ids IS NULL OR COALESCE(pg_catalog.cardinality(_receipt_ids), 0) > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('receipt_id', rr.id,
      'arrived_on_original', rr.arrived_on, 'arrived_on_current', private.accounting_return_arrival_on(rr.id),
      'version', COALESCE((SELECT pg_catalog.max(c.version) FROM public.order_return_arrival_corrections AS c
        WHERE c.receipt_id = rr.id), 0),
      'corrections', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', c.version,
          'previous_on', c.previous_on, 'new_on', c.new_on, 'reason', c.reason, 'actor_id', c.actor_id,
          'created_at', c.created_at) ORDER BY c.version)
        FROM public.order_return_arrival_corrections AS c WHERE c.receipt_id = rr.id), '[]'::jsonb))
    ORDER BY rr.created_at, rr.id), '[]'::jsonb)
    FROM public.order_return_receipts AS rr
    WHERE rr.id = ANY (_receipt_ids) AND rr.kind = 'receive');
END;
$$;

-- The delivery day the tracking service reports for the return's own parcel, when the option is on. Returns are not
-- registered with the tracking service yet, so there is never such a day: always NULL.
CREATE FUNCTION public.get_return_carrier_arrival(_return_id uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT NULL::date FROM public.accounting_return_options AS o WHERE o.id AND _return_id IS NOT NULL
$$;

ALTER FUNCTION private.accounting_order_dispute_confirmed_on(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_return_arrival_on(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_assert_arrival_date(uuid,uuid,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_return_arrival_option(uuid,boolean,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_set_return_arrival_option(uuid,boolean,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_return_arrival_option() OWNER TO postgres;
ALTER FUNCTION public.get_return_arrival_info(uuid[]) OWNER TO postgres;
ALTER FUNCTION public.get_return_carrier_arrival(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_order_dispute_confirmed_on(uuid), private.accounting_return_arrival_on(uuid),
  private.accounting_assert_arrival_date(uuid,uuid,date), private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer),
  private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer),
  private.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid),
  public.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid),
  private.admin_set_return_arrival_option(uuid,boolean,bigint,uuid), public.admin_set_return_arrival_option(uuid,boolean,bigint,uuid),
  public.get_return_arrival_option(), public.get_return_arrival_info(uuid[]), public.get_return_carrier_arrival(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid),
  public.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid),
  private.admin_set_return_arrival_option(uuid,boolean,bigint,uuid), public.admin_set_return_arrival_option(uuid,boolean,bigint,uuid),
  public.get_return_arrival_option(), public.get_return_arrival_info(uuid[]), public.get_return_carrier_arrival(uuid)
TO service_role;
-- ACC_S18_BODY_END

-- ACC_S18_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. A rebuilt body is compared after its replaced parts are restored
-- from the list below (by the md5 on the marker) and every ACC_P<n> block and all white space are removed.
DO $acc_s18_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_sig16 CONSTANT text := 'uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean';
  v_expected CONSTANT text[][] := ARRAY[
    ARRAY['private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date)', '957ea5ee31058c08f6a3de67398987a9'],
    ARRAY['public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date)', '4e00a11c05a45e06f7a988115b6ed267'],
    ARRAY['private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', '22c59ef8caa636149f2755838a42831e'],
    ARRAY['private.group_g_writer_allowlist()', '44a0d9a14dac9ee691d2bc5517481f44']
  ];
  v_tools CONSTANT text[] := ARRAY[
    'private.accounting_order_dispute_confirmed_on(uuid)', 'private.accounting_return_arrival_on(uuid)',
    'private.accounting_assert_arrival_date(uuid,uuid,date)', 'private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer)',
    'private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer)'];
  v_served CONSTANT text[] := ARRAY[
    'private.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid)',
    'public.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid)',
    'private.admin_set_return_arrival_option(uuid,boolean,bigint,uuid)', 'public.admin_set_return_arrival_option(uuid,boolean,bigint,uuid)',
    'public.get_return_arrival_option()', 'public.get_return_arrival_info(uuid[])', 'public.get_return_carrier_arrival(uuid)'];
  v_tables CONSTANT text[] := ARRAY['accounting_return_facts', 'order_return_arrival_corrections', 'accounting_return_options'];
  v_i integer;
  v_src text;
  v_match text[];
  v_original text;
  v_oid oid;
  v_new17 oid;
  v_role text;
  v_schema text;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s18_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s18_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s18_baseline) <> 1 THEN
    v_failed := 'acc_s18_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s18_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR pg_catalog.jsonb_typeof(v_baseline -> 'receive16') IS DISTINCT FROM 'number'
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') OR NOT (v_baseline ? 'receive_attrs') THEN
      v_failed := 'acc_s18_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s18_functions';
  -- acc_s18_functions: the tools are private, SECURITY DEFINER with search_path '', owned by postgres, and nobody may run them.
  -- The writers (private bodies SECURITY DEFINER, public entries SECURITY INVOKER) and the readers (SECURITY DEFINER) are
  -- owned by postgres with search_path '' and only service_role may run them; PUBLIC holds nothing.
  IF v_failed IS NULL THEN
    FOREACH v_src IN ARRAY v_tools || v_served LOOP
      v_oid := pg_catalog.to_regprocedure(v_src);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid
          AND f.prosecdef = NOT (v_src LIKE 'public.admin_%')
          AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""']) THEN
        v_failed := 'acc_s18_functions';
        EXIT;
      END IF;
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF v_failed IS NULL AND pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE')
            <> (v_role = 'service_role' AND v_src = ANY (v_served)) THEN
          v_failed := 'acc_s18_functions';
        END IF;
      END LOOP;
      IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee = 0) THEN
        v_failed := 'acc_s18_functions';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s18_receive_signature';
  -- acc_s18_receive_signature: private and public admin_receive_return exist once each, with 17 arguments (the 16th
  -- _restocking_fee_waived boolean DEFAULT false, the 17th _arrived_on date DEFAULT NULL, three defaults); the 16 argument
  -- form is gone from both schemas.
  IF v_failed IS NULL THEN
    FOREACH v_schema IN ARRAY ARRAY['private', 'public'] LOOP
      IF pg_catalog.to_regprocedure(v_schema || '.admin_receive_return(' || v_sig16 || ')') IS NOT NULL
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
          WHERE n.nspname = v_schema AND f.proname = 'admin_receive_return') <> 1
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          WHERE f.oid = pg_catalog.to_regprocedure(v_schema || '.admin_receive_return(' || v_sig16 || ',date)')
            AND f.pronargs = 17 AND f.pronargdefaults = 3
            AND f.proargnames[16] = '_restocking_fee_waived' AND f.proargnames[17] = '_arrived_on'
            AND pg_catalog.pg_get_function_arguments(f.oid)
              LIKE '%, \_restocking\_fee\_waived boolean DEFAULT false, \_arrived\_on date DEFAULT NULL::date') THEN
        v_failed := 'acc_s18_receive_signature';
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s18_function_attrs';
  -- acc_s18_function_attrs: admin_refund_return and the writer list keep their arguments, result, language, volatility,
  -- security, owner, search_path and ACL; both admin_receive_return keep everything but the arguments. Type names are printed
  -- under the search_path the baseline was read with.
  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'receive_attrs')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::regtype::text, pg_catalog.pg_get_function_arguments(f.oid), pg_catalog.pg_get_function_result(f.oid),
        f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'receive_attrs') AS b(nsp, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f
        ON f.oid = pg_catalog.to_regprocedure(b.nsp || '.admin_receive_return(' || v_sig16 || ',date)')
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::regtype::text, pg_catalog.pg_get_function_result(f.oid),
        f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s18_function_attrs';
  END IF;
  PERFORM pg_catalog.set_config('search_path', '', true);

  v_stage := 'acc_s18_body_unchanged';
  -- acc_s18_body_unchanged: each rebuilt body, with its replaced parts restored and every ACC_P<n> block and the white space
  -- removed, is the latest definition (the md5 of that text).
  IF v_failed IS NULL THEN
    FOR v_i IN 1 .. pg_catalog.array_length(v_expected, 1) LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(v_expected[v_i][1]);
      IF v_src IS NULL THEN
        v_failed := 'acc_s18_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        v_original := NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('bffb3e697a390137c36dd77c4e39c0fb', $acc_s18_orig$    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean)',
$acc_s18_orig$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s18_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
      END LOOP;
      EXIT WHEN v_failed IS NOT NULL;
      IF pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM v_expected[v_i][2] THEN
        v_failed := 'acc_s18_body_unchanged';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s18_g_allowlist_replaced';
  -- acc_s18_g_allowlist_replaced: 77 entries; the 17 argument receive writer is in and the 16 argument one is out; the other
  -- 76 are the entries the list had at the start of this migration.
  v_new17 := pg_catalog.to_regprocedure('private.admin_receive_return(' || v_sig16 || ',date)');
  IF v_failed IS NULL AND (
    v_new17 IS NULL
    OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 77
    OR pg_catalog.jsonb_array_length(v_baseline -> 'allowlist') <> 77
    OR NOT ((v_baseline -> 'allowlist') @> (v_baseline -> 'receive16'))
    OR NOT (v_new17::regprocedure = ANY (private.group_g_writer_allowlist()))
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)
      WHERE w.proc::oid = (v_baseline ->> 'receive16')::oid)
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)
        WHERE w.proc::oid <> v_new17)
      IS DISTINCT FROM (SELECT pg_catalog.jsonb_agg(x.v ORDER BY x.v::text::bigint) FROM pg_catalog.jsonb_array_elements(v_baseline -> 'allowlist') AS x(v)
        WHERE x.v <> (v_baseline -> 'receive16'))) THEN
    v_failed := 'acc_s18_g_allowlist_replaced';
  END IF;

  v_stage := 'acc_s18_rls_acl';
  -- acc_s18_rls_acl: the three tables these functions write keep RLS on with no policy; PUBLIC, anon and authenticated hold
  -- nothing (table or column); service_role holds SELECT and nothing else.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE c.oid IS NULL OR NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
          OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s18_rls_acl';
  END IF;

  v_stage := 'acc_s18_existing_dml_allowlist';
  -- acc_s18_existing_dml_allowlist: this migration writes no row.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_return_facts) IS DISTINCT FROM (v_baseline #>> '{counts,facts}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.order_return_arrival_corrections) IS DISTINCT FROM (v_baseline #>> '{counts,corrections}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.order_return_receipts) IS DISTINCT FROM (v_baseline #>> '{counts,receipts}')::bigint
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(o::text, ',')) FROM public.accounting_return_options AS o)
      IS DISTINCT FROM (v_baseline #>> '{counts,options}')) THEN
    v_failed := 'acc_s18_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s18_functions'), HINT = SQLSTATE;
END;
$acc_s18_final$;
-- ACC_S18_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
