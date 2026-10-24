-- G-2 writers (Tasks 4, 6, 7 and 8): the purchase-order lock helper, create a purchase order (FREQ-526), correct the supplier and
-- memo, confirm / correct the quantities and short close the rest (FREQ-527, FREQ-528), receive goods and cancel / correct a
-- receipt (FREQ-529), reserve / attach / revise the original documents (FREQ-530) and the writer allowlist (56 G-1 entries +
-- the 9 purchase-order writers = 65). Later G-2 tasks extend the body section of this file.
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

-- 6. Receive goods against a purchase order (FREQ-529, Task 7): the only G-2 writer that adds stock. One database
--    transaction, in this order: argument check (22023; no table is read) -> lock helper WITH inventory (advisory first, then
--    the lines' variants read after it, the inventory closure, the order, its lines) -> permission (admin.receiving.manage +
--    admin.purchase_orders.read, 42501) -> fingerprint (no version) and replay / conflict (23505) -> existence (P0002) ->
--    stage (GROUP_G_PO_NOT_CONFIRMED / 55000) -> version (GROUP_G_PO_VERSION_CONFLICT / 55000) -> received_on between the order
--    date and today in Asia/Tokyo (GROUP_G_PO_RECEIVED_ON_INVALID / 22023) -> every line belongs to the order (22023) and
--    quantity <= outstanding (GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING / 23514). Nothing is written before every check passed.
--    _lines = [{"lineId": uuid, "quantity": 1..99999}] (1 to 100 lines, a line at most once, exactly these two keys).
--    Writes (G-1 ledger form): one receipt header (kind receive); per line (lineId ascending) a stock_movements row
--    (delta +quantity, reason restock, note "<PO number> receipt", NO allocation_operation_id, so the G-1 consistency trigger of
--    tagged rows never applies) and the receipt line tied to it, received_quantity += quantity and the line version + 1; the
--    order version + 1. Then private.allocate_group_g_fifo for exactly the variants received (oldest waiting order first; a
--    buyer's own hold or allocation is never taken; only FIFO tags a ledger row) and one item state record of reason
--    purchase_order_receive. The result {receiptId, version, allocatedQuantity, replayed} is stored in group_g_operations
--    (operation purchase_order_receive, cause_type purchase_order, cause_id = the order). app.group_g_operation_id is set just
--    before the first write and restored on success and on failure (the G-1 form). The note is built from unicode escapes
--    because this file is ASCII only.
CREATE FUNCTION private.admin_receive_purchase_order(_purchase_order_id uuid, _expected_version integer, _received_on date,
  _memo text, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_memo text := NULLIF(pg_catalog.regexp_replace(_memo, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_orders uuid[];
  v_before jsonb;
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order public.purchase_orders%ROWTYPE;
  v_line record;
  v_receipt uuid;
  v_movement bigint;
  v_variants bigint[] := ARRAY[]::bigint[];
  v_allocated integer;
  v_version integer;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _received_on IS NULL
    OR _actor_id IS NULL OR _request_key IS NULL OR pg_catalog.char_length(v_memo) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- every element is an object with exactly lineId and quantity; each value is checked as text before any cast
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(e.value) <> 'object' THEN true
      WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e.value)) <> 2 THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'lineId') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(e.value -> 'quantity') IS DISTINCT FROM 'number' THEN true
      WHEN (e.value ->> 'lineId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
      WHEN (e.value ->> 'quantity') !~ '^[1-9][0-9]{0,4}$' THEN true
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT (e.value ->> 'lineId')::uuid) FROM pg_catalog.jsonb_array_elements(_lines) AS e(value))
     <> pg_catalog.jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.receiving.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_receive', 'purchase_order_id', _purchase_order_id,
    'received_on', pg_catalog.to_char(_received_on, 'YYYY-MM-DD'), 'memo', v_memo,
    'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lineId', (e.value ->> 'lineId')::uuid,
                'quantity', (e.value ->> 'quantity')::integer) ORDER BY (e.value ->> 'lineId')::uuid)
              FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)),
    'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_receive' AND op.request_key = _request_key;
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
  IF v_order.stage <> 'quantity_confirmed' THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_CONFIRMED' USING ERRCODE = '55000';
  END IF;
  IF v_order.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_PO_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF _received_on < (v_order.ordered_at AT TIME ZONE 'Asia/Tokyo')::date
     OR _received_on > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIVED_ON_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_lines AS l
                      WHERE l.id = (e.value ->> 'lineId')::uuid AND l.purchase_order_id = _purchase_order_id)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_lines AS l
    JOIN pg_catalog.jsonb_array_elements(_lines) AS e(value) ON l.id = (e.value ->> 'lineId')::uuid
    WHERE (e.value ->> 'quantity')::integer > COALESCE(l.outstanding_quantity, 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING' USING ERRCODE = '23514';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  INSERT INTO public.purchase_order_receipts(purchase_order_id, kind, received_on, memo, actor_id, operation_id)
    VALUES(_purchase_order_id, 'receive', _received_on, v_memo, _actor_id, v_operation) RETURNING id INTO v_receipt;
  FOR v_line IN
    SELECT l.id AS line_id, l.variant_id, (e.value ->> 'quantity')::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    JOIN public.purchase_order_lines AS l ON l.id = (e.value ->> 'lineId')::uuid
    ORDER BY l.id
  LOOP
    INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)
      VALUES(v_line.variant_id, v_line.quantity, 'restock',
        U&'\767A\6CE8 ' || v_order.number || U&' \306E\53D7\3051\53D6\308A', _actor_id)
      RETURNING id INTO v_movement;
    INSERT INTO public.purchase_order_receipt_lines(receipt_id, line_id, quantity, stock_movement_id)
      VALUES(v_receipt, v_line.line_id, v_line.quantity, v_movement);
    UPDATE public.purchase_order_lines SET received_quantity = received_quantity + v_line.quantity, version = version + 1,
        updated_at = pg_catalog.now()
      WHERE id = v_line.line_id;
    v_variants := v_variants || v_line.variant_id;
  END LOOP;
  v_version := v_order.version + 1;
  UPDATE public.purchase_orders SET version = v_version, updated_at = pg_catalog.now() WHERE id = _purchase_order_id;

  v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'purchase_order_receive', _actor_id);

  v_result := pg_catalog.jsonb_build_object('receiptId', v_receipt::text, 'version', v_version,
    'allocatedQuantity', v_allocated, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_receive', _request_key, v_fingerprint, 'purchase_order', _purchase_order_id::text,
      _actor_id, v_result);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_receive_purchase_order(_purchase_order_id uuid, _expected_version integer, _received_on date,
  _memo text, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_receive_purchase_order(_purchase_order_id, _expected_version, _received_on, _memo, _lines, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid) TO service_role;

-- 7. Cancel a receipt or correct its quantity (FREQ-529): the same operation. Cancel = every line of the receipt by its whole
--    reversible quantity, correct = some lines by a part. An offsetting receipt (kind reverse, received_on today in Asia/Tokyo,
--    the reason) is appended; the receipt and its lines are never changed. _lines = [{"receiptLineId": uuid, "quantity": 1..99999}]
--    (1 to 100 lines, once each, exactly these two keys, all positive lines of _receipt_id). _expected_release_quantity (NULL
--    allowed, never negative) is the confirmation of how many allocated units will be taken back: the same "confirm, then resend
--    with a new request key" promise as the G-1 stock decrease. Order of work as in section 6, with the reason required in the
--    argument stage (GROUP_G_PO_REASON_REQUIRED / 22023, after the other argument checks; also when nothing is released).
--    Checks, all before the first write: existence (P0002) -> version -> _receipt_id is a kind receive receipt of this order (22023)
--    -> each line is a positive line of it (22023; an offsetting row cannot be cancelled) -> quantity <= reversible quantity
--    (quantity minus the offsets already pointing at the line; GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED / 23514) -> per variant
--    q (to cancel), F (item_variants.stock_quantity read after the lock) and A (remaining_quantity of kind paid allocations of the
--    locked orders; a payment hold is never taken): q > F + A is GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT / 23514; units to take
--    back = max(q - F, 0) per variant, releasedQuantity = their sum; releasedQuantity > 0 with no expected value, or a different
--    expected value, is GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED / 55000 with DETAIL {"releasedQuantity": n} (the G-1 test).
--    Writes (the G-1 decrease form, admin_record_stock_movement): per line (receiptLineId ascending) free stock first, then paid
--    allocations newest order first (orders.created_at DESC, id DESC, order item DESC, allocation DESC): remaining_quantity
--    and version, an allocation_release ledger row (+n, tagged, with the order and item, note = the reason) and a release
--    allocation event of reason stock_adjustment; then the adjustment ledger row (-q, NOT tagged, note "<PO number> receipt
--    cancelled"), the offsetting receipt line (-q, reverses_receipt_line_id, tied to that row), received_quantity -= q and the line
--    version + 1; the order version + 1. Then FIFO (nothing is left over, so 0 units) and one item state record of reason
--    stock_move (the reason G-1 uses for a stock decrease; the plan's stock_adjustment wording lost to G-1 parity). Only
--    unshipped paid allocations exist (shipping consumes remaining_quantity), so shipped units are never taken back.
--    The result {receiptId (the offsetting receipt), version, releasedQuantity, replayed} is stored in group_g_operations
--    (operation purchase_order_receipt_reverse, cause_type purchase_order, cause_id = the order).
CREATE FUNCTION private.admin_reverse_purchase_order_receipt(_purchase_order_id uuid, _expected_version integer, _receipt_id uuid,
  _lines jsonb, _reason text, _expected_release_quantity integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reason text := NULLIF(pg_catalog.regexp_replace(_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_orders uuid[];
  v_before jsonb;
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_order public.purchase_orders%ROWTYPE;
  v_line record;
  v_allocation record;
  v_receipt uuid;
  v_free integer;
  v_remaining integer;
  v_quantity integer;
  v_release integer;
  v_release_movement bigint;
  v_movement bigint;
  v_variants bigint[] := ARRAY[]::bigint[];
  v_version integer;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _receipt_id IS NULL
    OR _actor_id IS NULL OR _request_key IS NULL OR _expected_release_quantity < 0 OR pg_catalog.char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- every element is an object with exactly receiptLineId and quantity; each value is checked as text before any cast
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(e.value) <> 'object' THEN true
      WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e.value)) <> 2 THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'receiptLineId') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(e.value -> 'quantity') IS DISTINCT FROM 'number' THEN true
      WHEN (e.value ->> 'receiptLineId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
      WHEN (e.value ->> 'quantity') !~ '^[1-9][0-9]{0,4}$' THEN true
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT (e.value ->> 'receiptLineId')::uuid) FROM pg_catalog.jsonb_array_elements(_lines) AS e(value))
     <> pg_catalog.jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_PO_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.receiving.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_receipt_reverse', 'purchase_order_id', _purchase_order_id, 'receipt_id', _receipt_id,
    'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('receiptLineId', (e.value ->> 'receiptLineId')::uuid,
                'quantity', (e.value ->> 'quantity')::integer) ORDER BY (e.value ->> 'receiptLineId')::uuid)
              FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)),
    'reason', v_reason, 'expected_release_quantity', _expected_release_quantity, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_receipt_reverse' AND op.request_key = _request_key;
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
  IF NOT EXISTS (SELECT 1 FROM public.purchase_order_receipts AS r
                 WHERE r.id = _receipt_id AND r.purchase_order_id = _purchase_order_id AND r.kind = 'receive') THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_receipt_lines AS rl
                      WHERE rl.id = (e.value ->> 'receiptLineId')::uuid AND rl.receipt_id = _receipt_id AND rl.quantity > 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- the reversible quantity is the line's quantity minus the offsets already pointing at it (the offsets are negative)
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    JOIN public.purchase_order_receipt_lines AS rl ON rl.id = (e.value ->> 'receiptLineId')::uuid
    WHERE (e.value ->> 'quantity')::integer > rl.quantity + COALESCE(
      (SELECT pg_catalog.sum(n.quantity) FROM public.purchase_order_receipt_lines AS n WHERE n.reverses_receipt_line_id = rl.id), 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED' USING ERRCODE = '23514';
  END IF;
  -- q > F + A for one variant is a refusal; the units to take back are max(q - F, 0) per variant (F and A are read under the lock;
  -- only allocations of the locked orders count, so the loop below never touches an unlocked order)
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    JOIN public.purchase_order_receipt_lines AS rl ON rl.id = (e.value ->> 'receiptLineId')::uuid
    JOIN public.purchase_order_lines AS l ON l.id = rl.line_id
    JOIN public.item_variants AS v ON v.id = l.variant_id
    WHERE (e.value ->> 'quantity')::bigint > v.stock_quantity::bigint + COALESCE((
      SELECT pg_catalog.sum(a.remaining_quantity) FROM public.order_item_allocations AS a
      JOIN public.order_items AS oi ON oi.id = a.order_item_id
      WHERE a.variant_id = v.id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders)), 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(pg_catalog.sum(GREATEST((e.value ->> 'quantity')::integer - v.stock_quantity, 0)), 0)::integer INTO v_release
  FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
  JOIN public.purchase_order_receipt_lines AS rl ON rl.id = (e.value ->> 'receiptLineId')::uuid
  JOIN public.purchase_order_lines AS l ON l.id = rl.line_id
  JOIN public.item_variants AS v ON v.id = l.variant_id;
  IF (v_release > 0 AND _expected_release_quantity IS NULL)
    OR (_expected_release_quantity IS NOT NULL AND _expected_release_quantity <> v_release) THEN
    RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' USING ERRCODE = '55000',
      DETAIL = pg_catalog.jsonb_build_object('releasedQuantity', v_release)::text;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  INSERT INTO public.purchase_order_receipts(purchase_order_id, kind, received_on, reason, actor_id, operation_id)
    VALUES(_purchase_order_id, 'reverse', (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date, v_reason, _actor_id, v_operation)
    RETURNING id INTO v_receipt;
  FOR v_line IN
    SELECT rl.id AS receipt_line_id, rl.line_id, l.variant_id, (e.value ->> 'quantity')::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    JOIN public.purchase_order_receipt_lines AS rl ON rl.id = (e.value ->> 'receiptLineId')::uuid
    JOIN public.purchase_order_lines AS l ON l.id = rl.line_id
    ORDER BY rl.id
  LOOP
    SELECT v.stock_quantity INTO v_free FROM public.item_variants AS v WHERE v.id = v_line.variant_id;
    v_remaining := GREATEST(v_line.quantity - v_free, 0);
    FOR v_allocation IN
      SELECT a.id, a.remaining_quantity, a.order_item_id, oi.order_id
      FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
      JOIN public.orders AS o ON o.id = oi.order_id
      WHERE a.variant_id = v_line.variant_id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders)
      ORDER BY o.created_at DESC, o.id DESC, oi.id DESC, a.id DESC
    LOOP
      EXIT WHEN v_remaining = 0;
      v_quantity := LEAST(v_remaining, v_allocation.remaining_quantity);
      UPDATE public.order_item_allocations AS a SET remaining_quantity = a.remaining_quantity - v_quantity, version = a.version + 1
        WHERE a.id = v_allocation.id;
      INSERT INTO public.stock_movements(variant_id, delta, reason, note, order_id, order_item_id, allocation_operation_id, created_by)
        VALUES(v_line.variant_id, v_quantity, 'allocation_release', v_reason, v_allocation.order_id, v_allocation.order_item_id,
          v_operation, _actor_id)
        RETURNING id INTO v_release_movement;
      INSERT INTO public.order_item_allocation_events(allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
        VALUES(v_allocation.id, 'release', v_quantity, v_operation, 1, v_release_movement, 'stock_adjustment', _actor_id);
      v_remaining := v_remaining - v_quantity;
    END LOOP;
    INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)
      VALUES(v_line.variant_id, -v_line.quantity, 'adjustment',
        U&'\767A\6CE8 ' || v_order.number || U&' \306E\53D7\3051\53D6\308A\53D6\6D88', _actor_id)
      RETURNING id INTO v_movement;
    INSERT INTO public.purchase_order_receipt_lines(receipt_id, line_id, quantity, reverses_receipt_line_id, stock_movement_id)
      VALUES(v_receipt, v_line.line_id, -v_line.quantity, v_line.receipt_line_id, v_movement);
    UPDATE public.purchase_order_lines SET received_quantity = received_quantity - v_line.quantity, version = version + 1,
        updated_at = pg_catalog.now()
      WHERE id = v_line.line_id;
    v_variants := v_variants || v_line.variant_id;
  END LOOP;
  v_version := v_order.version + 1;
  UPDATE public.purchase_orders SET version = v_version, updated_at = pg_catalog.now() WHERE id = _purchase_order_id;

  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stock_move', _actor_id);

  v_result := pg_catalog.jsonb_build_object('receiptId', v_receipt::text, 'version', v_version,
    'releasedQuantity', v_release, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_receipt_reverse', _request_key, v_fingerprint, 'purchase_order', _purchase_order_id::text,
      _actor_id, v_result);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_reverse_purchase_order_receipt(_purchase_order_id uuid, _expected_version integer, _receipt_id uuid,
  _lines jsonb, _reason text, _expected_release_quantity integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_reverse_purchase_order_receipt(_purchase_order_id, _expected_version, _receipt_id, _lines, _reason, _expected_release_quantity, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid) TO service_role;

-- 8. Original documents (quotes and invoices) of a purchase order (FREQ-530, Task 8): three writers, none of which touches
--    stock, the ledger, allocations or orders, and none of which changes the purchase order or its version. They follow the
--    order of work of the writers above: argument check (22023; no table is read) -> lock helper (advisory first, then the
--    order and its lines) -> permission check (admin.purchase_orders.manage + admin.purchase_orders.read, 42501) ->
--    fingerprint and replay / conflict (23505) -> existence (GROUP_G_PO_NOT_FOUND / P0002) -> business rules -> writes ->
--    private.group_g_operations last. The file itself is never read or written here: the caller (the server) has already
--    checked the stored object (kind, size, hash) and hands in the results. No database lock is held while the storage is used.
--    Reserve: promises one storage key <order id>/<random uuid>.<pdf|jpg|jpeg|png> for 24 hours and returns it (the server turns it
--    into a signed upload destination afterwards). An expired reservation is never deleted or changed; it stays and can still be
--    attached. For a replacement upload the replaced attachment (_replaces_attachment_id, an attachment of this order, else
--    GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID) is stored on the reservation, so a stopped upload keeps the link across a page
--    reload. Attach: turns a reservation of this order that no attachment points at into an attachment (revision 1 carries the
--    transaction details and the replaced attachment copied from the reservation, whose own rows stay untouched; the caller
--    cannot pass it). Revise: appends the next revision (a correction or a void; the reason is required and the content must
--    differ from the latest revision). The currency is JPY only for now (the column allows any three capital letters).
CREATE FUNCTION private.admin_reserve_purchase_order_attachment(_purchase_order_id uuid, _kind text, _file_name text,
  _replaces_attachment_id uuid, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_file_name text := NULLIF(pg_catalog.regexp_replace(_file_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_extension text;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_reservation uuid := pg_catalog.gen_random_uuid();
  v_path text;
  v_expires timestamptz;
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_result jsonb;
BEGIN
  IF _purchase_order_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _kind IS NULL OR _kind NOT IN ('quote', 'invoice')
    OR v_file_name IS NULL OR pg_catalog.char_length(v_file_name) > 255 OR v_file_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_extension := pg_catalog.lower(pg_catalog.substring(v_file_name, '\.([A-Za-z0-9]+)$'));
  IF v_extension IS NULL OR v_extension NOT IN ('pdf', 'jpg', 'jpeg', 'png') THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_attachment_reserve', 'purchase_order_id', _purchase_order_id, 'kind', _kind,
    'file_name', v_file_name, 'replaces_attachment_id', _replaces_attachment_id, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_attachment_reserve' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id) THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _replaces_attachment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_order_attachments AS prev
    WHERE prev.id = _replaces_attachment_id AND prev.purchase_order_id = _purchase_order_id) THEN
    RAISE EXCEPTION 'GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_path := _purchase_order_id::text || '/' || pg_catalog.gen_random_uuid()::text || '.' || v_extension;
  v_expires := pg_catalog.now() + INTERVAL '24 hours';
  INSERT INTO public.purchase_order_attachment_reservations(id, purchase_order_id, kind, original_file_name, storage_path,
      created_by, operation_id, expires_at, replaces_attachment_id)
    VALUES(v_reservation, _purchase_order_id, _kind, v_file_name, v_path, _actor_id, v_operation, v_expires,
      _replaces_attachment_id);

  v_result := pg_catalog.jsonb_build_object('reservationId', v_reservation, 'storagePath', v_path, 'expiresAt', v_expires,
    'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_attachment_reserve', _request_key, v_fingerprint, 'purchase_order',
      _purchase_order_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_reserve_purchase_order_attachment(_purchase_order_id uuid, _kind text, _file_name text,
  _replaces_attachment_id uuid, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_reserve_purchase_order_attachment(_purchase_order_id, _kind, _file_name, _replaces_attachment_id, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION private.admin_attach_purchase_order_document(_reservation_id uuid, _purchase_order_id uuid, _mime_type text,
  _size_bytes bigint, _sha256 text, _sha256_source text, _transaction_date date, _amount_yen bigint, _currency text,
  _counterparty text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_counterparty text := NULLIF(pg_catalog.regexp_replace(_counterparty, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_attachment uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_reservation public.purchase_order_attachment_reservations%ROWTYPE;
  v_result jsonb;
BEGIN
  IF _reservation_id IS NULL OR _purchase_order_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL
    OR _mime_type IS NULL OR _mime_type NOT IN ('application/pdf', 'image/jpeg', 'image/png')
    OR _size_bytes IS NULL OR _size_bytes NOT BETWEEN 1 AND 20971520
    OR _sha256 IS NULL OR _sha256 !~ '^[0-9a-f]{64}$'
    OR _sha256_source IS NULL OR _sha256_source NOT IN ('browser', 'server')
    OR _transaction_date IS NULL OR NOT pg_catalog.isfinite(_transaction_date) OR _transaction_date < DATE '2000-01-01'
    OR _amount_yen IS NULL OR _amount_yen NOT BETWEEN 0 AND 99999999999
    OR _currency IS NULL OR _currency <> 'JPY'
    OR v_counterparty IS NULL OR pg_catalog.char_length(v_counterparty) > 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_purchase_orders(ARRAY[_purchase_order_id], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.manage', 'admin.purchase_orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'purchase_order_attachment_attach', 'reservation_id', _reservation_id, 'purchase_order_id', _purchase_order_id,
    'mime_type', _mime_type, 'size_bytes', _size_bytes, 'sha256', _sha256, 'sha256_source', _sha256_source,
    'transaction_date', _transaction_date, 'amount_yen', _amount_yen, 'currency', _currency, 'counterparty', v_counterparty,
    'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_attachment_attach' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id) THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT rv.* INTO v_reservation FROM public.purchase_order_attachment_reservations AS rv
    WHERE rv.id = _reservation_id AND rv.purchase_order_id = _purchase_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_order_attachments AS ax WHERE ax.reservation_id = _reservation_id) THEN
    RAISE EXCEPTION 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.purchase_order_attachments(id, purchase_order_id, reservation_id, kind, original_file_name, storage_path,
      mime_type, size_bytes, sha256, sha256_source, uploaded_by, operation_id)
    VALUES(v_attachment, _purchase_order_id, _reservation_id, v_reservation.kind, v_reservation.original_file_name,
      v_reservation.storage_path, _mime_type, _size_bytes, _sha256, _sha256_source, _actor_id, v_operation);
  INSERT INTO public.purchase_order_attachment_revisions(attachment_id, revision_no, transaction_date, amount_yen, currency,
      counterparty, voided, reason, replaces_attachment_id, actor_id, operation_id)
    VALUES(v_attachment, 1, _transaction_date, _amount_yen, _currency, v_counterparty, false, NULL, v_reservation.replaces_attachment_id,
      _actor_id, v_operation);

  v_result := pg_catalog.jsonb_build_object('attachmentId', v_attachment, 'revisionNo', 1, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_attachment_attach', _request_key, v_fingerprint, 'purchase_order',
      _purchase_order_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_attach_purchase_order_document(_reservation_id uuid, _purchase_order_id uuid, _mime_type text,
  _size_bytes bigint, _sha256 text, _sha256_source text, _transaction_date date, _amount_yen bigint, _currency text,
  _counterparty text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_attach_purchase_order_document(_reservation_id, _purchase_order_id, _mime_type, _size_bytes, _sha256, _sha256_source, _transaction_date, _amount_yen, _currency, _counterparty, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid) TO service_role;

CREATE FUNCTION private.admin_revise_purchase_order_document(_attachment_id uuid, _purchase_order_id uuid, _transaction_date date,
  _amount_yen bigint, _currency text, _counterparty text, _voided boolean, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_counterparty text := NULLIF(pg_catalog.regexp_replace(_counterparty, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_reason text := NULLIF(pg_catalog.regexp_replace(_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_latest public.purchase_order_attachment_revisions%ROWTYPE;
  v_revision_no integer;
  v_result jsonb;
BEGIN
  IF _attachment_id IS NULL OR _purchase_order_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _voided IS NULL
    OR _transaction_date IS NULL OR NOT pg_catalog.isfinite(_transaction_date) OR _transaction_date < DATE '2000-01-01'
    OR _amount_yen IS NULL OR _amount_yen NOT BETWEEN 0 AND 99999999999
    OR _currency IS NULL OR _currency <> 'JPY'
    OR v_counterparty IS NULL OR pg_catalog.char_length(v_counterparty) > 100
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
    'operation', 'purchase_order_attachment_revise', 'attachment_id', _attachment_id, 'purchase_order_id', _purchase_order_id,
    'transaction_date', _transaction_date, 'amount_yen', _amount_yen, 'currency', _currency, 'counterparty', v_counterparty,
    'voided', _voided, 'reason', v_reason, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'purchase_order_attachment_revise' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders AS po WHERE po.id = _purchase_order_id) THEN
    RAISE EXCEPTION 'GROUP_G_PO_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- an attachment of another order (or none) is a plain argument error: the caller only sends attachments it has just read
  SELECT r.* INTO v_latest FROM public.purchase_order_attachment_revisions AS r
    JOIN public.purchase_order_attachments AS a ON a.id = r.attachment_id
    WHERE a.id = _attachment_id AND a.purchase_order_id = _purchase_order_id
    ORDER BY r.revision_no DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_latest.transaction_date = _transaction_date AND v_latest.amount_yen = _amount_yen AND v_latest.currency = _currency
    AND v_latest.counterparty = v_counterparty AND v_latest.voided = _voided THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_revision_no := v_latest.revision_no + 1;
  INSERT INTO public.purchase_order_attachment_revisions(attachment_id, revision_no, transaction_date, amount_yen, currency,
      counterparty, voided, reason, replaces_attachment_id, actor_id, operation_id)
    VALUES(_attachment_id, v_revision_no, _transaction_date, _amount_yen, _currency, v_counterparty, _voided, v_reason, NULL,
      _actor_id, v_operation);

  v_result := pg_catalog.jsonb_build_object('attachmentId', _attachment_id, 'revisionNo', v_revision_no, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'purchase_order_attachment_revise', _request_key, v_fingerprint, 'purchase_order',
      _purchase_order_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_revise_purchase_order_document(_attachment_id uuid, _purchase_order_id uuid, _transaction_date date,
  _amount_yen bigint, _currency text, _counterparty text, _voided boolean, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_revise_purchase_order_document(_attachment_id, _purchase_order_id, _transaction_date, _amount_yen, _currency, _counterparty, _voided, _reason, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid) TO service_role;

-- 9. The closed list of writers. The 56 entries of 20261023211425_group_g1_allocation.sql:8897 stay exactly as they were;
--    Task 4 added private.admin_create_purchase_order (it writes private.group_g_operations) as the 57th, Task 6 added three
--    writers (58th to 60th), Task 7 adds the receipt and the receipt cancellation (each one writes the ledger, the
--    allocations and private.group_g_operations) as the 61st and 62nd, and Task 8 adds the three document writers (63rd to
--    65th; each one writes private.group_g_operations). Later G-2 tasks
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
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
    'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
    'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
    'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
    'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G2B_BODY_END

-- G2B_FINAL_ASSERT_BEGIN
-- Expectation of Tasks 4, 6, 7 and 8: the nineteen new functions (owner, SECURITY, language, result type, argument names, search_path,
-- and the EXECUTE rights read from the effective ACL where a NULL proacl means the default that includes PUBLIC), the order of
-- the lock helper (the common advisory before any other lock), and the allowlist: exactly the 56 G-1 entries plus the nine
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
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
    'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
    'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
    'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
    'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)'
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
        ARRAY['_purchase_order_id', '_expected_version', '_line_ids', '_reason', '_actor_id', '_request_key']),
      ('private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_received_on', '_memo', '_lines', '_actor_id', '_request_key']),
      ('public.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_received_on', '_memo', '_lines', '_actor_id', '_request_key']),
      ('private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_receipt_id', '_lines', '_reason', '_expected_release_quantity', '_actor_id', '_request_key']),
      ('public.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_expected_version', '_receipt_id', '_lines', '_reason', '_expected_release_quantity', '_actor_id', '_request_key']),
      ('private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_purchase_order_id', '_kind', '_file_name', '_replaces_attachment_id', '_actor_id', '_request_key']),
      ('public.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_purchase_order_id', '_kind', '_file_name', '_replaces_attachment_id', '_actor_id', '_request_key']),
      ('private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_reservation_id', '_purchase_order_id', '_mime_type', '_size_bytes', '_sha256', '_sha256_source', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_actor_id', '_request_key']),
      ('public.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_reservation_id', '_purchase_order_id', '_mime_type', '_size_bytes', '_sha256', '_sha256_source', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_actor_id', '_request_key']),
      ('private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_attachment_id', '_purchase_order_id', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_voided', '_reason', '_actor_id', '_request_key']),
      ('public.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_attachment_id', '_purchase_order_id', '_transaction_date', '_amount_yen', '_currency', '_counterparty', '_voided', '_reason', '_actor_id', '_request_key'])
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
     OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 65
     OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 65 THEN
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
      ('public.purchase_order_receipts'),
      ('public.purchase_order_receipt_lines'),
      ('public.purchase_order_attachment_revisions'),
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
