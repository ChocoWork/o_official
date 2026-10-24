-- G-2 writers (Tasks 4 and 6): the purchase-order lock helper, create a purchase order (FREQ-526), correct the supplier and
-- memo, confirm / correct the quantities and short close the rest (FREQ-527, FREQ-528) and the writer allowlist
-- (56 G-1 entries + the 4 purchase-order writers = 60). Later G-2 tasks extend the body section of this file.
-- Always applied after 20261024153505_group_g2_purchasing_foundation.sql. Applied SQL is never edited.
BEGIN;

-- G2B_BODY_BEGIN

-- 1. Lock helper for every purchase-order writer. The common advisory (190521,1) is the first statement; the targets are
--    only discovered by reads after it (the same rule as lock_group_g_inventory). With _with_inventory the variants of the
--    purchase order lines are read after the advisory and handed to lock_group_g_inventory (the advisory is re-entrant),
--    whose result (the locked order ids, ascending) is kept; without it nothing but the purchase order rows is locked.
--    The purchase orders (id ascending) and then their lines (id ascending) are locked last, after every inventory row,
--    so a caller never waits for a purchase order row while it still has to wait for an earlier-stage row. A caller must
--    not add targets afterwards and go back to an earlier stage. Internal helper: nobody but the owner can EXECUTE it.
CREATE FUNCTION private.lock_group_g_purchase_orders(_purchase_order_ids uuid[], _with_inventory boolean)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[] := ARRAY[]::uuid[];
  v_variants bigint[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  IF _with_inventory IS TRUE THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT l.variant_id ORDER BY l.variant_id), ARRAY[]::bigint[]) INTO v_variants
    FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = ANY(_purchase_order_ids);
    v_orders := private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], NULL);
  END IF;
  PERFORM po.id FROM public.purchase_orders AS po WHERE po.id = ANY(_purchase_order_ids) ORDER BY po.id FOR UPDATE;
  PERFORM l.id FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = ANY(_purchase_order_ids) ORDER BY l.id FOR UPDATE;
  RETURN v_orders;
END;
$$;
ALTER FUNCTION private.lock_group_g_purchase_orders(uuid[],boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_group_g_purchase_orders(uuid[],boolean) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Create a purchase order (input -> confirm -> finalize; only the finalize reaches the database).
--    _lines = [{"variantId": <bigint>, "quantity": <int>}], 1 to 100 lines, a variant at most once, quantity 1 to 99999.
--    Order of work: argument check (22023) -> lock helper (advisory first, no other row yet) -> permission check
--    (admin.purchase_orders.manage + admin.purchase_orders.read, 42501) -> fingerprint and replay / conflict -> variant
--    check (22023) -> number -> insert. The number is PO- + the JST date + - + a 4 digit sequence (the largest of the day
--    + 1, taken under the advisory and guarded by the UNIQUE constraint); above 9999 the call fails with
--    GROUP_G_PO_NUMBER_EXHAUSTED / 55000. line_no follows the order of _lines (from 1). The names are copied from items,
--    item_colors and item_sizes. Stock, allocations, the ledger and orders are never touched.
--    The result {id, number, version, replayed} is stored in group_g_operations (operation purchase_order_create,
--    cause_type purchase_order, cause_id = the new id); a replay returns it with replayed = true.
CREATE FUNCTION private.admin_create_purchase_order(_supplier_name text, _memo text, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_supplier text := NULLIF(pg_catalog.regexp_replace(_supplier_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_memo text := NULLIF(pg_catalog.regexp_replace(_memo, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order_id uuid;
  v_prefix text;
  v_sequence integer;
  v_number text;
  v_result jsonb;
BEGIN
  IF _actor_id IS NULL OR _request_key IS NULL OR v_supplier IS NULL OR pg_catalog.char_length(v_supplier) > 100
    OR pg_catalog.char_length(v_memo) > 500 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- every element is an object with exactly variantId and quantity, both plain positive integers in range
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(e.value) <> 'object' THEN true
      WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e.value)) <> 2 THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'variantId') IS DISTINCT FROM 'number'
        OR pg_catalog.jsonb_typeof(e.value -> 'quantity') IS DISTINCT FROM 'number' THEN true
      WHEN (e.value ->> 'variantId') !~ '^[1-9][0-9]{0,17}$' OR (e.value ->> 'quantity') !~ '^[1-9][0-9]{0,4}$' THEN true
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT (e.value ->> 'variantId')::bigint) FROM pg_catalog.jsonb_array_elements(_lines) AS e(value))
     <> pg_catalog.jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[]::uuid[], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_create', 'supplier_name', v_supplier, 'memo', v_memo,
    'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('variantId', (e.value ->> 'variantId')::bigint,
                'quantity', (e.value ->> 'quantity')::integer) ORDER BY (e.value ->> 'variantId')::bigint)
              FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)),
    'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_create' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.item_variants AS v
      WHERE v.id IN (SELECT (e.value ->> 'variantId')::bigint FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)))
     <> pg_catalog.jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_prefix := 'PO-' || pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Tokyo', 'YYYYMMDD') || '-';
  SELECT COALESCE(pg_catalog.max(pg_catalog.substr(po.number, pg_catalog.length(v_prefix) + 1)::integer), 0) + 1 INTO v_sequence
  FROM public.purchase_orders AS po WHERE pg_catalog.starts_with(po.number, v_prefix);
  IF v_sequence > 9999 THEN
    RAISE EXCEPTION 'GROUP_G_PO_NUMBER_EXHAUSTED' USING ERRCODE = '55000';
  END IF;
  v_number := v_prefix || pg_catalog.lpad(v_sequence::text, 4, '0');

  INSERT INTO public.purchase_orders(number, supplier_name, memo, created_by)
    VALUES(v_number, v_supplier, v_memo, _actor_id) RETURNING id INTO v_order_id;
  INSERT INTO public.purchase_order_lines(purchase_order_id, line_no, variant_id, item_name, color_name, size_label, provisional_quantity)
    SELECT v_order_id, e.ordinality::integer, v.id, i.name, c.name, s.label, (e.value ->> 'quantity')::integer
    FROM pg_catalog.jsonb_array_elements(_lines) WITH ORDINALITY AS e(value, ordinality)
    JOIN public.item_variants AS v ON v.id = (e.value ->> 'variantId')::bigint
    JOIN public.items AS i ON i.id = v.item_id
    LEFT JOIN public.item_colors AS c ON c.id = v.color_id
    LEFT JOIN public.item_sizes AS s ON s.id = v.size_id
    ORDER BY e.ordinality;
  INSERT INTO public.purchase_order_revisions(purchase_order_id, line_id, revision_no, kind, after_supplier_name, after_memo,
      actor_id, operation_id)
    VALUES(v_order_id, NULL, 1, 'order', v_supplier, v_memo, _actor_id, v_operation);
  INSERT INTO public.purchase_order_revisions(purchase_order_id, line_id, revision_no, kind, after_quantity, actor_id, operation_id)
    SELECT l.purchase_order_id, l.id, 1, 'order', l.provisional_quantity, _actor_id, v_operation
    FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = v_order_id ORDER BY l.line_no;

  v_result := pg_catalog.jsonb_build_object('id', v_order_id::text, 'number', v_number, 'version', 1, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_create', _request_key, v_fingerprint, 'purchase_order', v_order_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_create_purchase_order(text,text,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_create_purchase_order(text,text,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_create_purchase_order(text,text,jsonb,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_create_purchase_order(_supplier_name text, _memo text, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_create_purchase_order(_supplier_name, _memo, _lines, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_create_purchase_order(text,text,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_purchase_order(text,text,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_purchase_order(text,text,jsonb,uuid,uuid) TO service_role;

-- 3. Correct the supplier and memo of a purchase order (FREQ-527). Every writer of this section follows the order of the
--    create function: argument check (22023; no table is read) -> lock helper (advisory first, then the order and its lines)
--    -> permission check (admin.purchase_orders.manage + admin.purchase_orders.read, 42501) -> fingerprint and replay /
--    conflict (23505) -> existence (GROUP_G_PO_NOT_FOUND / P0002) -> version (GROUP_G_PO_VERSION_CONFLICT / 55000) -> business
--    rules. The fingerprint never holds the version, so a resend after the order moved on still replays the stored result.
--    The reason is required (GROUP_G_PO_REASON_REQUIRED / 22023, after the other argument checks). Supplier and memo are
--    trimmed (a blank memo is NULL); when neither changes the call is 22023. One revision of kind header (line_id NULL, the
--    supplier and the memo before and after) is appended with revision_no = the new version. Any stage may be corrected.
CREATE FUNCTION private.admin_update_purchase_order_header(_purchase_order_id uuid, _expected_version integer, _supplier_name text,
  _memo text, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_supplier text := NULLIF(pg_catalog.regexp_replace(_supplier_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_memo text := NULLIF(pg_catalog.regexp_replace(_memo, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_reason text := NULLIF(pg_catalog.regexp_replace(_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order public.purchase_orders%ROWTYPE;
  v_version integer;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR v_supplier IS NULL OR pg_catalog.char_length(v_supplier) > 100 OR pg_catalog.char_length(v_memo) > 500
    OR pg_catalog.char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_PO_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_header_update', 'purchase_order_id', _purchase_order_id, 'supplier_name', v_supplier,
    'memo', v_memo, 'reason', v_reason, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_header_update' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT po.* INTO v_order FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF v_supplier IS NOT DISTINCT FROM v_order.supplier_name AND v_memo IS NOT DISTINCT FROM v_order.memo THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_version := v_order.version + 1;
  UPDATE public.purchase_orders SET supplier_name = v_supplier, memo = v_memo, version = v_version, updated_at = pg_catalog.now()
    WHERE id = _purchase_order_id;
  INSERT INTO public.purchase_order_revisions(purchase_order_id, line_id, revision_no, kind, before_supplier_name,
      after_supplier_name, before_memo, after_memo, reason, actor_id, operation_id)
    VALUES(_purchase_order_id, NULL, v_version, 'header', v_order.supplier_name, v_supplier, v_order.memo, v_memo, v_reason,
      _actor_id, v_operation);

  v_result := pg_catalog.jsonb_build_object('version', v_version, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_header_update', _request_key, v_fingerprint, 'purchase_order', _purchase_order_id::text,
      _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_update_purchase_order_header(_purchase_order_id uuid, _expected_version integer, _supplier_name text,
  _memo text, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_update_purchase_order_header(_purchase_order_id, _expected_version, _supplier_name, _memo, _reason, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid) TO service_role;

-- 4. Confirm or correct the quantities and unit prices of a purchase order (FREQ-527), same order of work as above.
--    _lines = [{"lineId": uuid, "quantity": 0..99999, "unitPriceYen": 0..9999999 | null}], exactly three keys per element,
--    every line of the order exactly once (22023 when one is missing, repeated or belongs to another order). unitPriceYen null
--    means "not registered" and 0 means 0 yen. Stage ordered: the first confirmation (the reason is optional) sets the
--    confirmed quantity of every line, moves the order to quantity_confirmed and always raises every line version. Stage
--    quantity_confirmed: a correction; the reason is required (GROUP_G_PO_REASON_REQUIRED / 22023), a quantity below the
--    received quantity is GROUP_G_PO_QUANTITY_BELOW_RECEIVED / 23514, and a correction that changes nothing is 22023. The first
--    confirmation writes a revision of kind quantity for EVERY line (the confirmation itself is business history: who, when,
--    the optional reason), even when the quantity equals the provisional quantity and there is no price; a correction writes
--    one only for the lines whose quantity or unit price changed (NULL to a value, and NULL against 0, count). changedLines
--    counts the real changes only. Every revision comes with the order version raised by one. The quantity before is the
--    confirmed quantity, or the provisional quantity on the first confirmation. A change of the price alone writes before_quantity = after_quantity (the
--    current quantity): the display stage counts a quantity revision only when the two differ, so a price never undoes a
--    short close. Stock, allocations, the ledger and receipts are never touched.
CREATE FUNCTION private.admin_confirm_purchase_order_quantities(_purchase_order_id uuid, _expected_version integer, _lines jsonb,
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reason text := NULLIF(pg_catalog.regexp_replace(_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order public.purchase_orders%ROWTYPE;
  v_line record;
  v_version integer;
  v_before integer;
  v_changed boolean;
  v_changed_lines integer := 0;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR pg_catalog.char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- every element is an object with exactly lineId, quantity and unitPriceYen; each value is checked as text before any cast
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(e.value) <> 'object' THEN true
      WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e.value)) <> 3 THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'lineId') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(e.value -> 'quantity') IS DISTINCT FROM 'number'
        OR COALESCE(pg_catalog.jsonb_typeof(e.value -> 'unitPriceYen'), 'absent') NOT IN ('number', 'null') THEN true
      WHEN (e.value ->> 'lineId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
      WHEN (e.value ->> 'quantity') !~ '^(0|[1-9][0-9]{0,4})$' THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'unitPriceYen') = 'number' AND (e.value ->> 'unitPriceYen') !~ '^(0|[1-9][0-9]{0,6})$' THEN true
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT (e.value ->> 'lineId')::uuid) FROM pg_catalog.jsonb_array_elements(_lines) AS e(value))
     <> pg_catalog.jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_quantities', 'purchase_order_id', _purchase_order_id, 'reason', v_reason,
    'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lineId', (e.value ->> 'lineId')::uuid,
                'quantity', (e.value ->> 'quantity')::integer, 'unitPriceYen', (e.value ->> 'unitPriceYen')::integer)
                ORDER BY (e.value ->> 'lineId')::uuid)
              FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)),
    'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_quantities' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT po.* INTO v_order FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF v_order.stage = 'quantity_confirmed' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_PO_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- the lines must be exactly the lines of this order (the elements are distinct, so equal counts and membership are enough)
  IF (SELECT pg_catalog.count(*) FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = _purchase_order_id)
       <> pg_catalog.jsonb_array_length(_lines)
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_lines AS l
                         WHERE l.id = (e.value ->> 'lineId')::uuid AND l.purchase_order_id = _purchase_order_id)
     ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_lines AS l
    JOIN pg_catalog.jsonb_array_elements(_lines) AS e(value) ON l.id = (e.value ->> 'lineId')::uuid
    WHERE (e.value ->> 'quantity')::integer < l.received_quantity
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_QUANTITY_BELOW_RECEIVED' USING ERRCODE = '23514';
  END IF;
  IF v_order.stage = 'quantity_confirmed' AND NOT EXISTS (
    SELECT 1 FROM public.purchase_order_lines AS l
    JOIN pg_catalog.jsonb_array_elements(_lines) AS e(value) ON l.id = (e.value ->> 'lineId')::uuid
    WHERE (e.value ->> 'quantity')::integer <> l.confirmed_quantity
       OR (e.value ->> 'unitPriceYen')::integer IS DISTINCT FROM l.unit_price_yen
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_version := v_order.version + 1;
  FOR v_line IN
    SELECT l.id, l.provisional_quantity, l.confirmed_quantity, l.unit_price_yen,
      (e.value ->> 'quantity')::integer AS new_quantity, (e.value ->> 'unitPriceYen')::integer AS new_price
    FROM public.purchase_order_lines AS l
    JOIN pg_catalog.jsonb_array_elements(_lines) AS e(value) ON l.id = (e.value ->> 'lineId')::uuid
    WHERE l.purchase_order_id = _purchase_order_id
    ORDER BY l.line_no
  LOOP
    v_before := COALESCE(v_line.confirmed_quantity, v_line.provisional_quantity);
    v_changed := v_line.new_quantity <> v_before OR v_line.new_price IS DISTINCT FROM v_line.unit_price_yen;
    -- the first confirmation is itself recorded: every line gets a revision (also when nothing changed); later only changed lines
    IF v_order.stage = 'ordered' OR v_changed THEN
      INSERT INTO public.purchase_order_revisions(purchase_order_id, line_id, revision_no, kind, before_quantity, after_quantity,
          before_unit_price_yen, after_unit_price_yen, reason, actor_id, operation_id)
        VALUES(_purchase_order_id, v_line.id, v_version, 'quantity', v_before, v_line.new_quantity, v_line.unit_price_yen,
          v_line.new_price, v_reason, _actor_id, v_operation);
    END IF;
    IF v_changed THEN
      v_changed_lines := v_changed_lines + 1;
    END IF;
    IF v_order.stage = 'ordered' OR v_changed THEN
      UPDATE public.purchase_order_lines SET confirmed_quantity = v_line.new_quantity, unit_price_yen = v_line.new_price,
          version = version + 1, updated_at = pg_catalog.now()
        WHERE id = v_line.id;
    END IF;
  END LOOP;
  UPDATE public.purchase_orders SET stage = 'quantity_confirmed', version = v_version, updated_at = pg_catalog.now()
    WHERE id = _purchase_order_id;

  v_result := pg_catalog.jsonb_build_object('version', v_version, 'changedLines', v_changed_lines, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_quantities', _request_key, v_fingerprint, 'purchase_order', _purchase_order_id::text,
      _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_confirm_purchase_order_quantities(_purchase_order_id uuid, _expected_version integer, _lines jsonb,
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_confirm_purchase_order_quantities(_purchase_order_id, _expected_version, _lines, _reason, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid) TO service_role;

-- 5. Short close the rest of the lines of a purchase order (FREQ-528), same order of work as above. The reason is required
--    (GROUP_G_PO_REASON_REQUIRED / 22023, after the other argument checks). _line_ids is a non-empty one dimensional array
--    without NULL or repeated ids (22023); an id of another order is 22023 as well. Nothing is moved: no receipt, no ledger
--    row, no stock, no allocation. For each closed line a revision of kind short_close and a purchase_order_short_closures
--    row (closed_quantity, reason, actor, time) are appended and the line version is raised; the order version rises by one.
--    Stage quantity_confirmed: a line without an outstanding quantity makes the call GROUP_G_PO_NOTHING_TO_CLOSE / 55000.
--    Each line's confirmed quantity becomes its received quantity (confirmed 10, received 6: before 10, after 6, closed 4).
--    Stage ordered (cancelling before the quantities are confirmed): only the whole set of lines is accepted (a part is
--    22023). Every confirmed quantity becomes 0 (before = the provisional quantity, closed = the provisional quantity) and the
--    stage moves to quantity_confirmed; the display stage is then closed. A closed line is reopened only by a later
--    correction that changes its quantity (admin_confirm_purchase_order_quantities, reason required).
CREATE FUNCTION private.admin_short_close_purchase_order(_purchase_order_id uuid, _expected_version integer, _line_ids uuid[],
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reason text := NULLIF(pg_catalog.regexp_replace(_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order public.purchase_orders%ROWTYPE;
  v_line record;
  v_version integer;
  v_before integer;
  v_after integer;
  v_closed integer;
  v_revision uuid;
  v_total integer := 0;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR _line_ids IS NULL OR pg_catalog.array_ndims(_line_ids) IS DISTINCT FROM 1
    OR pg_catalog.cardinality(_line_ids) NOT BETWEEN 1 AND 100 OR pg_catalog.char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(_line_ids) AS u(id) WHERE u.id IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT u.id) FROM pg_catalog.unnest(_line_ids) AS u(id)) <> pg_catalog.cardinality(_line_ids) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_PO_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_short_close', 'purchase_order_id', _purchase_order_id, 'reason', v_reason,
    'line_ids', (SELECT pg_catalog.jsonb_agg(u.id ORDER BY u.id) FROM pg_catalog.unnest(_line_ids) AS u(id)),
    'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_short_close' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT po.* INTO v_order FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(_line_ids) AS u(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_lines AS l WHERE l.id = u.id AND l.purchase_order_id = _purchase_order_id)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_order.stage = 'ordered' THEN
    IF pg_catalog.cardinality(_line_ids)
       <> (SELECT pg_catalog.count(*) FROM public.purchase_order_lines AS l WHERE l.purchase_order_id = _purchase_order_id) THEN
      RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.purchase_order_lines AS l WHERE l.id = ANY(_line_ids) AND l.outstanding_quantity = 0
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOTHING_TO_CLOSE' USING ERRCODE = '55000';
  END IF;

  v_version := v_order.version + 1;
  FOR v_line IN
    SELECT l.id, l.provisional_quantity, l.confirmed_quantity, l.received_quantity, l.outstanding_quantity
    FROM public.purchase_order_lines AS l
    WHERE l.id = ANY(_line_ids)
    ORDER BY l.line_no
  LOOP
    IF v_order.stage = 'ordered' THEN
      v_before := v_line.provisional_quantity;
      v_after := 0;
      v_closed := v_line.provisional_quantity;
    ELSE
      v_before := v_line.confirmed_quantity;
      v_after := v_line.received_quantity;
      v_closed := v_line.outstanding_quantity;
    END IF;
    INSERT INTO public.purchase_order_revisions(purchase_order_id, line_id, revision_no, kind, before_quantity, after_quantity,
        reason, actor_id, operation_id)
      VALUES(_purchase_order_id, v_line.id, v_version, 'short_close', v_before, v_after, v_reason, _actor_id, v_operation)
      RETURNING id INTO v_revision;
    INSERT INTO public.purchase_order_short_closures(line_id, revision_id, closed_quantity, reason, actor_id)
      VALUES(v_line.id, v_revision, v_closed, v_reason, _actor_id);
    UPDATE public.purchase_order_lines SET confirmed_quantity = v_after, version = version + 1, updated_at = pg_catalog.now()
      WHERE id = v_line.id;
    v_total := v_total + v_closed;
  END LOOP;
  UPDATE public.purchase_orders SET stage = 'quantity_confirmed', version = v_version, updated_at = pg_catalog.now()
    WHERE id = _purchase_order_id;

  v_result := pg_catalog.jsonb_build_object('version', v_version, 'closedQuantity', v_total, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_short_close', _request_key, v_fingerprint, 'purchase_order', _purchase_order_id::text,
      _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_short_close_purchase_order(_purchase_order_id uuid, _expected_version integer, _line_ids uuid[],
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_short_close_purchase_order(_purchase_order_id, _expected_version, _line_ids, _reason, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid) TO service_role;

-- 6. The closed list of writers. The 56 entries of 20261023211425_group_g1_allocation.sql:8897 stay exactly as they were;
--    Task 4 added private.admin_create_purchase_order (it writes private.group_g_operations) as the 57th, and this Task adds
--    the three writers above (each one writes private.group_g_operations) as the 58th to the 60th. Later G-2 tasks
--    append their writers. Owner, ACL and signature of the function are unchanged (CREATE OR REPLACE keeps them).
--    group_g1_writer_inventory scans pg_proc.prosrc against it.
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
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
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
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
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
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G2B_BODY_END

-- G2B_FINAL_ASSERT_BEGIN
-- Expectation of Tasks 4 and 6: the seven new functions (owner, SECURITY, language, result type, argument names, search_path,
-- and the EXECUTE rights read from the effective ACL where a NULL proacl means the default that includes PUBLIC), the order of
-- the lock helper (the common advisory before any other lock), and the allowlist: exactly the 56 G-1 entries plus the four
-- purchase-order writers, every one resolving to a function. The expected sets grow with every Task that adds to this file.
DO $g2b_final_objects$
DECLARE
  v_failed text;
  v_writers text[] := ARRAY[
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
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
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
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
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
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)'
  ];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('private.lock_group_g_purchase_orders(uuid[],boolean)', true, false, 'plpgsql', 'uuid[]',
        ARRAY['_purchase_order_ids', '_with_inventory']),
      ('private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_supplier_name', '_memo', '_lines', '_actor_id', '_request_key']),
      ('public.admin_create_purchase_order(text,text,jsonb,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_supplier_name', '_memo', '_lines', '_actor_id', '_request_key']),
      ('private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_supplier_name', '_memo', '_reason', '_actor_id', '_request_key']),
      ('public.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_supplier_name', '_memo', '_reason', '_actor_id', '_request_key']),
      ('private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_lines', '_reason', '_actor_id', '_request_key']),
      ('public.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_lines', '_reason', '_actor_id', '_request_key']),
      ('private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_line_ids', '_reason', '_actor_id', '_request_key']),
      ('public.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_line_ids', '_reason', '_actor_id', '_request_key'])
    ) AS e(sig, definer, service, lang, ret, names)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR p.prosecdef <> e.definer
       OR p.provolatile <> 'v'
       OR p.proretset
       OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
       OR p.prorettype <> e.ret::regtype::oid
       OR p.proargnames IS DISTINCT FROM e.names
       OR NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'purchase_writer_functions';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'private.lock_group_g_purchase_orders(uuid[],boolean)'::regprocedure
      AND pg_catalog.strpos(p.prosrc, 'PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);') > 0
      AND pg_catalog.strpos(p.prosrc, 'PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);')
        < pg_catalog.strpos(p.prosrc, 'private.lock_group_g_inventory(')
      AND pg_catalog.strpos(p.prosrc, 'private.lock_group_g_inventory(') < pg_catalog.strpos(p.prosrc, 'FOR UPDATE')
  ) THEN
    v_failed := 'purchase_writer_lock_order';
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_writers) AS w(s) WHERE pg_catalog.to_regprocedure(w.s) IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 60
     OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 60 THEN
    v_failed := 'purchase_writer_allowlist_missing';
  ELSIF (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS a(x))
     IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(w.s)::oid ORDER BY pg_catalog.to_regprocedure(w.s)::oid)
                       FROM pg_catalog.unnest(v_writers) AS w(s)) THEN
    v_failed := 'purchase_writer_allowlist';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g2b_final_objects$;

-- The privileges on the tables this file writes through its functions, compared by meaning (production may carry other
-- grantees such as supabase_admin): postgres holds every privilege; PUBLIC, anon, authenticated and service_role hold
-- none (column privileges too), and MAINTAIN (PostgreSQL 17 and later) belongs to the owner alone.
DO $g2b_final_table_acl$
DECLARE
  v_failed text;
  v_maintain text[] := CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_all text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] || v_maintain;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.purchase_orders'),
      ('public.purchase_order_lines'),
      ('public.purchase_order_revisions'),
      ('public.purchase_order_short_closures'),
      ('private.group_g_operations')
    ) AS e(rel)
    CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(e.rel) AS r) AS t
    WHERE t.r IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
                  WHERE NOT pg_catalog.has_table_privilege('postgres', t.r, p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),
                    pg_catalog.acldefault('r', 'postgres'::regrole))) AS x WHERE x.grantee = 0)
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS g(role)
                  CROSS JOIN pg_catalog.unnest(v_all) AS p(priv)
                  WHERE pg_catalog.has_table_privilege(g.role, t.r, p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS g(role)
                  CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
                  WHERE pg_catalog.has_any_column_privilege(g.role, t.r, p.priv))
  ) THEN
    v_failed := 'purchase_writer_table_acl';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g2b_final_table_acl$;
-- G2B_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
