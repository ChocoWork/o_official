BEGIN;

ALTER TABLE public.checkout_drafts ADD COLUMN stripe_discount_coupon_id text;
ALTER TABLE public.checkout_drafts ADD CONSTRAINT checkout_drafts_h3_created_amount
  CHECK (status <> 'created' OR discount_engine_version IS DISTINCT FROM 1 OR discount_amount = 0);
ALTER TABLE public.checkout_drafts ADD CONSTRAINT checkout_drafts_h3_coupon
  CHECK (stripe_discount_coupon_id IS NULL OR (discount_engine_version = 1 AND discount_result IS NOT NULL
    AND (discount_result->>'discountAmount')::numeric > 0 AND stripe_discount_coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'));

CREATE FUNCTION private.group_h_checkout_integer(_value jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _value IS NULL OR pg_catalog.jsonb_typeof(_value)<>'number' OR _value::text !~ '^[0-9]+$'
    OR (_value::text)::numeric > 2147483647 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  RETURN (_value::text)::bigint;
END;
$$;

-- Canonical JSON uses sorted keys and no insignificant whitespace, matching the server hash.
CREATE FUNCTION private.group_h_checkout_canonical(_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_text text;
BEGIN
  IF pg_catalog.jsonb_typeof(_value)='object' THEN
    SELECT '{'||COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(t.key)::text||':'||private.group_h_checkout_canonical(t.value),',' ORDER BY t.key COLLATE "C"),'')||'}'
      INTO v_text FROM pg_catalog.jsonb_each(_value) AS t;
  ELSIF pg_catalog.jsonb_typeof(_value)='array' THEN
    SELECT '['||COALESCE(pg_catalog.string_agg(private.group_h_checkout_canonical(t.value),',' ORDER BY t.ordinal),'')||']'
      INTO v_text FROM pg_catalog.jsonb_array_elements(_value) WITH ORDINALITY AS t(value,ordinal);
  ELSE v_text := _value::text;
  END IF;
  RETURN v_text;
END;
$$;

CREATE FUNCTION private.group_h_checkout_snapshot_hash(_claim jsonb,_result jsonb,_facts jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_lines jsonb; v_usage jsonb; v_candidates jsonb; v_codes jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lineKey',x->>'source_cart_line_id','itemId',x->'item_id',
    'unitPrice',x->'item_price','quantity',x->'quantity') ORDER BY x->>'source_cart_line_id' COLLATE "C")
    INTO v_lines FROM pg_catalog.jsonb_array_elements(_claim->'itemsSnapshot') AS t(x);
  SELECT COALESCE(pg_catalog.jsonb_agg(x-ARRAY['reserved','confirmed','buyerUses','codeUses']::text[]
    ORDER BY (x->>'discountId')||COALESCE(x->>'codeId','') COLLATE "C"),'[]'::jsonb)
    INTO v_usage FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',d.id,'version',d.version::text) ORDER BY d.id),'[]'::jsonb)
    INTO v_candidates FROM public.discounts AS d WHERE d.id IN
      (SELECT (x->>'discountId')::uuid FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x));
  SELECT COALESCE(pg_catalog.jsonb_agg(c ORDER BY c COLLATE "C"),'[]'::jsonb) INTO v_codes FROM (
    SELECT DISTINCT x->>'code' AS c FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x) WHERE x->>'code' IS NOT NULL
    UNION SELECT x FROM pg_catalog.jsonb_array_elements_text(_result->'unusedCodes') AS t(x)
  ) AS codes;
  RETURN pg_catalog.encode(extensions.digest(pg_catalog.convert_to(private.group_h_checkout_canonical(pg_catalog.jsonb_build_object(
    'version',1,'lines',v_lines,'codes',v_codes,'candidates',v_candidates,
    'facts',pg_catalog.jsonb_build_object('buyer',_facts->'buyer','hasPreviousOrder',_facts->'hasPreviousOrder',
      'hasFirstOrderReservation',_facts->'hasFirstOrderReservation','priorUnitsByItem',_facts->'priorUnitsByItem','usage',v_usage),
    'result',_result)),'UTF8'),'sha256'),'hex');
END;
$$;

CREATE FUNCTION private.group_h_validate_checkout_discount(_claim jsonb,_result jsonb,_facts jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_line jsonb; v_effect jsonb; v_unit jsonb; v_allocation jsonb; v_usage jsonb;
  v_subtotal numeric := 0; v_total numeric := 0; v_discount numeric := 0; v_paid numeric; v_alloc numeric;
  v_key text; v_quantity bigint; v_price bigint; v_count bigint; v_codes text[];
BEGIN
  IF _claim IS NULL OR pg_catalog.jsonb_typeof(_claim)<>'object'
    OR NOT (_claim ?& ARRAY['sessionId','requestVersion','requestFingerprint','checkoutUiMode','checkoutOrigin','paymentMethod','currency',
      'subtotalAmount','taxAmount','shippingAmount','totalAmount','shippingSnapshot','itemsSnapshot','buyerUserId','cartId'])
    OR _claim-ARRAY['sessionId','requestVersion','requestFingerprint','checkoutUiMode','checkoutOrigin','paymentMethod','currency',
      'subtotalAmount','taxAmount','shippingAmount','totalAmount','shippingSnapshot','itemsSnapshot','buyerUserId','cartId']::text[]<>'{}'::jsonb
    OR _claim->>'checkoutUiMode' IS DISTINCT FROM 'custom' OR _claim->>'currency' IS DISTINCT FROM 'jpy'
    OR pg_catalog.jsonb_typeof(_claim->'sessionId') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(_claim->'requestFingerprint') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(_claim->'checkoutOrigin') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(_claim->'cartId') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(_claim->'buyerUserId') NOT IN ('string','null')
    OR _claim->>'paymentMethod' IS NULL OR _claim->>'paymentMethod' NOT IN ('stripe_card','stripe_paypay','stripe_konbini')
    OR pg_catalog.jsonb_typeof(_claim->'itemsSnapshot')<>'array' OR pg_catalog.jsonb_array_length(_claim->'itemsSnapshot') NOT BETWEEN 1 AND 50
    OR pg_catalog.jsonb_typeof(_claim->'shippingSnapshot')<>'object'
    OR _result IS NULL OR pg_catalog.jsonb_typeof(_result)<>'object'
    OR NOT (_result ?& ARRAY['version','subtotalAmount','shippingAmount','discountAmount','totalAmount','applied','allocations','unitAmounts','unusedCodes','provisional','calculationMode'])
    OR _result-ARRAY['version','subtotalAmount','shippingAmount','discountAmount','totalAmount','applied','allocations','unitAmounts','unusedCodes','provisional','calculationMode']::text[]<>'{}'::jsonb
    OR _result->'version' IS DISTINCT FROM '1'::jsonb OR _result->'provisional' IS DISTINCT FROM 'false'::jsonb
    OR _result->>'calculationMode' IS NULL OR _result->>'calculationMode' NOT IN ('exact','fallback')
    OR pg_catalog.jsonb_typeof(_result->'applied')<>'array' OR pg_catalog.jsonb_typeof(_result->'allocations')<>'array'
    OR pg_catalog.jsonb_typeof(_result->'unitAmounts')<>'array' OR pg_catalog.jsonb_typeof(_result->'unusedCodes')<>'array'
    OR _facts IS NULL OR pg_catalog.jsonb_typeof(_facts)<>'object'
    OR NOT (_facts ?& ARRAY['phase','at','buyer','hasPreviousOrder','hasFirstOrderReservation','priorUnitsByItem','usage'])
    OR _facts-ARRAY['phase','at','buyer','hasPreviousOrder','hasFirstOrderReservation','priorUnitsByItem','usage']::text[]<>'{}'::jsonb
    OR _facts->>'phase' IS DISTINCT FROM 'confirm' OR pg_catalog.jsonb_typeof(_facts->'hasPreviousOrder') IS DISTINCT FROM 'boolean'
    OR pg_catalog.jsonb_typeof(_facts->'hasFirstOrderReservation') IS DISTINCT FROM 'boolean' OR pg_catalog.jsonb_typeof(_facts->'priorUnitsByItem') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(_facts->'usage') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF private.group_h_checkout_integer(_claim->'requestVersion') NOT BETWEEN 1 AND 32767 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF pg_catalog.length(_claim->>'sessionId') NOT BETWEEN 1 AND 512
    OR _claim->>'requestFingerprint' !~ ('^v'||(_claim->>'requestVersion')||':[0-9a-f]{64}$')
    OR _claim->>'checkoutOrigin' !~ '^https?://[^/]+$'
    OR NOT ((_claim->'shippingSnapshot') ?& ARRAY['email','fullName','kanaName','postalCode','prefecture','city','address','building','phone'])
    OR (_claim->'shippingSnapshot')-ARRAY['email','fullName','kanaName','postalCode','prefecture','city','address','building','phone']::text[]<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['email','fullName','postalCode','prefecture','city','address','phone']) AS required(field)
      WHERE pg_catalog.jsonb_typeof(_claim->'shippingSnapshot'->required.field) IS DISTINCT FROM 'string'
        OR pg_catalog.length(pg_catalog.btrim(_claim->'shippingSnapshot'->>required.field))=0)
    OR _claim->'shippingSnapshot'->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    OR pg_catalog.length(_claim->'shippingSnapshot'->>'email')>254
    OR _claim->'shippingSnapshot'->>'postalCode' !~ '^[0-9]{7}$'
    OR _claim->'shippingSnapshot'->>'phone' !~ '^[+]?[0-9]{10,15}$' THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT pg_catalog.isfinite((_facts->>'at')::timestamptz) OR _facts->>'at' IS NULL
    OR private.group_h_checkout_integer(_claim->'taxAmount')<>0 OR private.group_h_checkout_integer(_claim->'shippingAmount')<>0
    OR private.group_h_checkout_integer(_result->'shippingAmount')<>0 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF _claim->>'buyerUserId' IS NULL THEN
    IF _facts->'buyer' IS DISTINCT FROM pg_catalog.jsonb_build_object('kind','guest','normalizedEmail',_claim->'shippingSnapshot'->>'email')
      OR _facts->'buyer'->>'normalizedEmail' IS NULL
      OR _facts->'buyer'->>'normalizedEmail' !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
      OR _facts->'buyer'->>'normalizedEmail'<>pg_catalog.lower(pg_catalog.btrim(_facts->'buyer'->>'normalizedEmail')) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  ELSE
    IF _facts->'buyer' IS DISTINCT FROM pg_catalog.jsonb_build_object('kind','member','userId',_claim->>'buyerUserId') THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  -- The legacy claim validates ownership/snapshot invariants; H also requires an owned cart.
  IF NOT EXISTS(SELECT 1 FROM public.carts AS c WHERE c.id=(_claim->>'cartId')::uuid AND
    CASE WHEN _claim->>'buyerUserId' IS NULL THEN c.user_id IS NULL AND c.guest_token_hash IS NOT NULL
      ELSE c.user_id=(_claim->>'buyerUserId')::uuid END) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT x FROM pg_catalog.jsonb_array_elements(_claim->'itemsSnapshot') AS t(x) LOOP
    v_key := v_line->>'source_cart_line_id'; v_quantity := private.group_h_checkout_integer(v_line->'quantity');
    v_price := private.group_h_checkout_integer(v_line->'item_price');
    IF v_key IS NULL OR v_quantity NOT BETWEEN 1 AND 20
      OR pg_catalog.jsonb_typeof(v_line->'item_id') IS DISTINCT FROM 'number' OR (v_line->>'item_id') !~ '^[1-9][0-9]*$'
      OR (v_line->>'item_id')::numeric>9007199254740991
      OR private.group_h_checkout_integer(v_line->'line_total')<>v_quantity::numeric*v_price
      OR NOT EXISTS(SELECT 1 FROM public.cart_lines AS l JOIN public.item_variants AS iv ON iv.id=l.variant_id
        JOIN public.items AS i ON i.id=iv.item_id WHERE l.id=v_key::uuid AND l.cart_id=(_claim->>'cartId')::uuid
        AND l.quantity=v_quantity AND iv.item_id=(v_line->>'item_id')::bigint AND iv.is_active AND i.status='published' AND i.price=v_price)
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_claim->'itemsSnapshot') AS t(x) WHERE x->>'source_cart_line_id'=v_key)<>1 THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_subtotal := v_subtotal+v_quantity::numeric*v_price;
    SELECT pg_catalog.count(*),COALESCE(pg_catalog.sum(private.group_h_checkout_integer(x->'paidAmount')),0) INTO v_count,v_paid
      FROM pg_catalog.jsonb_array_elements(_result->'unitAmounts') AS t(x) WHERE x->>'lineKey'=v_key;
    SELECT COALESCE(pg_catalog.sum(private.group_h_checkout_integer(x->'amount')),0) INTO v_alloc
      FROM pg_catalog.jsonb_array_elements(_result->'allocations') AS t(x) WHERE x->>'lineKey'=v_key;
    IF v_count<>v_quantity OR v_paid+v_alloc<>v_quantity::numeric*v_price THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_total := v_total+v_paid;
  END LOOP;
  FOR v_unit IN SELECT x FROM pg_catalog.jsonb_array_elements(_result->'unitAmounts') AS t(x) LOOP
    IF pg_catalog.jsonb_typeof(v_unit)<>'object' OR NOT (v_unit ?& ARRAY['lineKey','unitIndex','paidAmount'])
      OR v_unit-ARRAY['lineKey','unitIndex','paidAmount']::text[]<>'{}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_claim->'itemsSnapshot') AS t(x) WHERE x->>'source_cart_line_id'=v_unit->>'lineKey'
        AND private.group_h_checkout_integer(v_unit->'unitIndex')<private.group_h_checkout_integer(x->'quantity')
        AND private.group_h_checkout_integer(v_unit->'paidAmount')<=private.group_h_checkout_integer(x->'item_price'))
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_result->'unitAmounts') AS t(x)
        WHERE x->>'lineKey'=v_unit->>'lineKey' AND x->'unitIndex'=v_unit->'unitIndex')<>1 THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR v_usage IN SELECT x FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x) LOOP
    PERFORM private.group_h_checkout_integer(v_usage->'reserved'),private.group_h_checkout_integer(v_usage->'confirmed'),
      private.group_h_checkout_integer(v_usage->'buyerUses'),private.group_h_checkout_integer(v_usage->'codeUses');
    IF pg_catalog.jsonb_typeof(v_usage)<>'object'
      OR NOT (v_usage ?& ARRAY['discountId','reserved','confirmed','buyerUses','assigned','codeId','code','audience','allowGuests','singleUse','codeUses'])
      OR v_usage-ARRAY['discountId','reserved','confirmed','buyerUses','assigned','codeId','code','audience','allowGuests','singleUse','codeUses']::text[]<>'{}'::jsonb
      OR pg_catalog.jsonb_typeof(v_usage->'assigned') IS DISTINCT FROM 'boolean' OR pg_catalog.jsonb_typeof(v_usage->'singleUse') IS DISTINCT FROM 'boolean'
      OR pg_catalog.jsonb_typeof(v_usage->'allowGuests') IS DISTINCT FROM 'boolean' OR v_usage->>'audience' IS NULL OR v_usage->>'audience' NOT IN ('assigned','anyone')
      OR NOT EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=(v_usage->>'discountId')::uuid
        AND ((d.method='automatic' AND v_usage->>'codeId' IS NULL) OR (d.method='code' AND v_usage->>'codeId' IS NOT NULL)))
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x)
        WHERE x->>'discountId'=v_usage->>'discountId' AND x->'codeId'=v_usage->'codeId')<>1
      OR (v_usage->>'codeId' IS NULL AND v_usage->>'code' IS NOT NULL)
      OR (v_usage->>'codeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.discount_codes AS c
        WHERE c.id=(v_usage->>'codeId')::uuid AND c.discount_id=(v_usage->>'discountId')::uuid AND c.code=v_usage->>'code')) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR v_effect IN SELECT x FROM pg_catalog.jsonb_array_elements(_result->'applied') AS t(x) LOOP
    v_discount := v_discount+private.group_h_checkout_integer(v_effect->'amount');
    IF pg_catalog.jsonb_typeof(v_effect)<>'object' OR NOT (v_effect ?& ARRAY['discountId','codeId','name','code','class','amount'])
      OR v_effect-ARRAY['discountId','codeId','name','code','class','amount']::text[]<>'{}'::jsonb
      OR private.group_h_checkout_integer(v_effect->'amount')<1 OR v_effect->>'class' IS NULL OR v_effect->>'class' NOT IN ('product','order')
      OR pg_catalog.jsonb_typeof(v_effect->'name')<>'string'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_result->'applied') AS t(x) WHERE x->>'discountId'=v_effect->>'discountId')<>1
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x)
        WHERE x->>'discountId'=v_effect->>'discountId' AND x->'codeId'=v_effect->'codeId' AND x->'code'=v_effect->'code')
      OR (SELECT COALESCE(pg_catalog.sum(private.group_h_checkout_integer(x->'amount')),0) FROM pg_catalog.jsonb_array_elements(_result->'allocations') AS t(x)
        WHERE x->>'discountId'=v_effect->>'discountId')<>private.group_h_checkout_integer(v_effect->'amount') THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR v_allocation IN SELECT x FROM pg_catalog.jsonb_array_elements(_result->'allocations') AS t(x) LOOP
    IF pg_catalog.jsonb_typeof(v_allocation)<>'object' OR NOT (v_allocation ?& ARRAY['lineKey','discountId','amount'])
      OR v_allocation-ARRAY['lineKey','discountId','amount']::text[]<>'{}'::jsonb
      OR private.group_h_checkout_integer(v_allocation->'amount')<1
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_claim->'itemsSnapshot') AS t(x) WHERE x->>'source_cart_line_id'=v_allocation->>'lineKey')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_result->'applied') AS t(x) WHERE x->>'discountId'=v_allocation->>'discountId')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_result->'allocations') AS t(x)
        WHERE x->>'lineKey'=v_allocation->>'lineKey' AND x->>'discountId'=v_allocation->>'discountId')<>1 THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT pg_catalog.array_agg(x) INTO v_codes FROM pg_catalog.jsonb_array_elements_text(_result->'unusedCodes') AS t(x);
  IF COALESCE(pg_catalog.cardinality(v_codes),0)>5
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_result->'unusedCodes') AS t(x) WHERE pg_catalog.jsonb_typeof(x) IS DISTINCT FROM 'string')
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(v_codes) AS t(c) WHERE c IS NULL OR c !~ '^[A-Z0-9-]{1,64}$')
    OR v_subtotal<>private.group_h_checkout_integer(_claim->'subtotalAmount') OR v_subtotal<>private.group_h_checkout_integer(_claim->'totalAmount')
    OR v_subtotal<>private.group_h_checkout_integer(_result->'subtotalAmount') OR v_total<>private.group_h_checkout_integer(_result->'totalAmount')
    OR v_discount<>private.group_h_checkout_integer(_result->'discountAmount') OR v_total+v_discount<>v_subtotal OR v_total<50 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT x->>'code' FROM pg_catalog.jsonb_array_elements(_facts->'usage') AS t(x) WHERE x->>'code' IS NOT NULL
    UNION SELECT x FROM pg_catalog.jsonb_array_elements_text(_result->'unusedCodes') AS t(x)) AS codes)>5
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(_facts->'priorUnitsByItem') AS t(key,value)
      WHERE t.key !~ '^[1-9][0-9]*$' OR private.group_h_checkout_integer(t.value)<0) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
  RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION private.group_h_checkout_frozen() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.discount_engine_version=1 AND (NEW.discount_result IS DISTINCT FROM OLD.discount_result
    OR NEW.discount_facts IS DISTINCT FROM OLD.discount_facts OR NEW.discount_snapshot_hash IS DISTINCT FROM OLD.discount_snapshot_hash
    OR NEW.discount_engine_version IS DISTINCT FROM OLD.discount_engine_version OR NEW.items_snapshot IS DISTINCT FROM OLD.items_snapshot
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
    OR NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
    OR (OLD.stripe_discount_coupon_id IS NOT NULL AND NEW.stripe_discount_coupon_id IS DISTINCT FROM OLD.stripe_discount_coupon_id)) THEN
    RAISE EXCEPTION 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER h3_checkout_frozen BEFORE UPDATE OF discount_result,discount_facts,discount_snapshot_hash,discount_engine_version,
  items_snapshot,total_amount,subtotal_amount,buyer_user_id,stripe_discount_coupon_id ON public.checkout_drafts
  FOR EACH ROW EXECUTE FUNCTION private.group_h_checkout_frozen();

CREATE FUNCTION private.claim_checkout_discount_draft(_claim jsonb,_discount_result jsonb,_discount_facts jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_claim record; v_draft public.checkout_drafts%ROWTYPE; v_hash text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  PERFORM private.group_h_validate_checkout_discount(_claim,_discount_result,_discount_facts);
  v_hash := private.group_h_checkout_snapshot_hash(_claim,_discount_result,_discount_facts);
  SELECT * INTO v_claim FROM public.claim_checkout_draft(
    _claim->>'sessionId',(_claim->>'requestVersion')::smallint,_claim->>'requestFingerprint',_claim->>'checkoutUiMode',_claim->>'checkoutOrigin',
    _claim->>'paymentMethod',_claim->>'currency',(_claim->>'subtotalAmount')::integer,0,0,(_claim->>'totalAmount')::integer,
    _claim->'shippingSnapshot',_claim->'itemsSnapshot',(_claim->>'buyerUserId')::uuid,(_claim->>'cartId')::uuid);
  SELECT * INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=v_claim.id FOR UPDATE;
  IF v_draft.shipping_snapshot IS DISTINCT FROM _claim->'shippingSnapshot' THEN
    RAISE EXCEPTION 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' USING ERRCODE='22023'; END IF;
  IF v_draft.discount_engine_version IS NOT NULL THEN
    IF v_draft.discount_snapshot_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' USING ERRCODE='22023'; END IF;
  ELSE
    UPDATE public.checkout_drafts SET discount_result=_discount_result,discount_facts=_discount_facts,discount_engine_version=1,discount_snapshot_hash=v_hash
      WHERE id=v_draft.id RETURNING * INTO v_draft;
  END IF;
  RETURN pg_catalog.jsonb_build_object('draftId',v_draft.id,'checkoutSessionId',v_draft.checkout_session_id,'claimCreated',v_claim.claim_created,
    'discountResult',v_draft.discount_result,'discountSnapshotHash',v_draft.discount_snapshot_hash,'stripeDiscountCouponId',v_draft.stripe_discount_coupon_id);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
WHEN check_violation THEN
  IF SQLERRM IN ('CHECKOUT_FINGERPRINT_MISMATCH','CHECKOUT_DRAFT_BUYER_MISMATCH','CHECKOUT_DRAFT_CART_MISMATCH') THEN
    RAISE EXCEPTION 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' USING ERRCODE='22023'; END IF;
  RAISE;
END;
$$;

CREATE FUNCTION private.attach_checkout_discount_coupon(_draft_id uuid,_snapshot_hash text,_coupon_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_draft public.checkout_drafts%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  IF _draft_id IS NULL OR _snapshot_hash IS NULL OR _snapshot_hash !~ '^[0-9a-f]{64}$'
    OR _coupon_id IS NULL OR _coupon_id !~ '^[A-Za-z0-9_-]{1,255}$' THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=_draft_id FOR UPDATE;
  IF NOT FOUND OR v_draft.status<>'created' OR v_draft.discount_engine_version IS DISTINCT FROM 1
    OR v_draft.discount_snapshot_hash IS DISTINCT FROM _snapshot_hash
    OR COALESCE((v_draft.discount_result->>'discountAmount')::bigint,0)<=0
    OR (v_draft.stripe_discount_coupon_id IS NOT NULL AND v_draft.stripe_discount_coupon_id<>_coupon_id) THEN
    RAISE EXCEPTION 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' USING ERRCODE='22023'; END IF;
  UPDATE public.checkout_drafts SET stripe_discount_coupon_id=_coupon_id WHERE id=_draft_id AND stripe_discount_coupon_id IS NULL;
  RETURN true;
END;
$$;

-- H3_EXPOSURE_BEGIN
ALTER FUNCTION private.group_h_checkout_integer(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_checkout_integer(jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_checkout_canonical(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_checkout_canonical(jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_checkout_snapshot_hash(jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_checkout_snapshot_hash(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_validate_checkout_discount(jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_validate_checkout_discount(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_checkout_frozen() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_checkout_frozen() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.claim_checkout_discount_draft(jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_checkout_discount_draft(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.claim_checkout_discount_draft(jsonb,jsonb,jsonb) TO service_role;
CREATE FUNCTION public.claim_checkout_discount_draft(_claim jsonb,_discount_result jsonb,_discount_facts jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.claim_checkout_discount_draft(_claim,_discount_result,_discount_facts) $$;
ALTER FUNCTION public.claim_checkout_discount_draft(jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_checkout_discount_draft(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_checkout_discount_draft(jsonb,jsonb,jsonb) TO service_role;
ALTER FUNCTION private.attach_checkout_discount_coupon(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.attach_checkout_discount_coupon(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.attach_checkout_discount_coupon(uuid,text,text) TO service_role;
CREATE FUNCTION public.attach_checkout_discount_coupon(_draft_id uuid,_snapshot_hash text,_coupon_id text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.attach_checkout_discount_coupon(_draft_id,_snapshot_hash,_coupon_id) $$;
ALTER FUNCTION public.attach_checkout_discount_coupon(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.attach_checkout_discount_coupon(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attach_checkout_discount_coupon(uuid,text,text) TO service_role;

-- H3_FINAL_ASSERT_BEGIN
DO $h3_final$
DECLARE
  expected_function record; function_row record; wrapper_row record; v_oid oid; v_name text;
  v_detail text; v_check text; v_expected text;
BEGIN
  FOR expected_function IN SELECT * FROM (VALUES
    ('group_h_checkout_integer(jsonb)','bigint','i',false,'8ad703bb090ca9f6836d5a773e79bbf9','_value','h3_amount_checks'),
    ('group_h_checkout_canonical(jsonb)','text','i',false,'7092d20fa4006c22e2a10fa58f9b2a58','_value','h3_draft_freeze'),
    ('group_h_checkout_snapshot_hash(jsonb,jsonb,jsonb)','text','s',false,'60725a4777fc6372e68c0f9a2a798ec8','_claim,_result,_facts','h3_draft_freeze'),
    ('group_h_validate_checkout_discount(jsonb,jsonb,jsonb)','void','s',false,'c334a3c0e570728c35fbbae2877da61e','_claim,_result,_facts','h3_amount_checks'),
    ('group_h_checkout_frozen()','trigger','v',false,'4cc6ed037e77f6af0e81939aa839010f','','h3_draft_freeze'),
    ('claim_checkout_discount_draft(jsonb,jsonb,jsonb)','jsonb','v',true,'87db7ce086bf8d4ec229e7d5102da3f5','_claim,_discount_result,_discount_facts','h3_draft_freeze'),
    ('attach_checkout_discount_coupon(uuid,text,text)','boolean','v',true,'1df2dea863d439664540903f752fa5c8','_draft_id,_snapshot_hash,_coupon_id','h3_coupon_binding')
  ) AS expected(signature,result_type,volatility,exposed,body_md5,arg_names,detail) LOOP
    v_name := pg_catalog.split_part(expected_function.signature,'(',1);
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='private' AND f.proname=v_name)<>1
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='public' AND f.proname=v_name)<>(CASE WHEN expected_function.exposed THEN 1 ELSE 0 END) THEN
      v_detail := 'h3_public_acl'; EXIT;
    END IF;
    v_oid := pg_catalog.to_regprocedure('private.'||expected_function.signature);
    SELECT f.*,l.lanname INTO function_row FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF NOT FOUND OR function_row.proowner<>'postgres'::regrole OR NOT function_row.prosecdef
      OR function_row.proconfig IS DISTINCT FROM ARRAY['search_path=""'] OR function_row.prorettype<>pg_catalog.to_regtype(expected_function.result_type)
      OR function_row.proretset OR function_row.prokind<>'f' OR function_row.lanname<>'plpgsql'
      OR function_row.provolatile<>expected_function.volatility::"char" OR function_row.proisstrict OR function_row.proleakproof
      OR function_row.proparallel<>'u' OR function_row.pronargdefaults<>0
      OR COALESCE(pg_catalog.array_to_string(function_row.proargnames,','),'')<>expected_function.arg_names THEN
      v_detail := expected_function.detail; EXIT;
    END IF;
    IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')<>expected_function.exposed
      OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(function_row.proacl,pg_catalog.acldefault('f',function_row.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_detail := 'h3_public_acl'; EXIT;
    END IF;
    IF pg_catalog.md5(pg_catalog.replace(function_row.prosrc,E'\r',''))<>expected_function.body_md5 THEN
      v_detail := expected_function.detail; EXIT;
    END IF;
    IF expected_function.exposed THEN
      v_oid := pg_catalog.to_regprocedure('public.'||expected_function.signature);
      SELECT f.*,l.lanname INTO wrapper_row FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
      IF NOT FOUND OR wrapper_row.proowner<>'postgres'::regrole OR wrapper_row.prosecdef OR wrapper_row.lanname<>'sql'
        OR wrapper_row.proconfig IS DISTINCT FROM ARRAY['search_path=""'] OR wrapper_row.prorettype<>function_row.prorettype OR wrapper_row.proretset
        OR wrapper_row.prokind<>'f' OR wrapper_row.provolatile<>'v' OR wrapper_row.proisstrict OR wrapper_row.proleakproof
        OR wrapper_row.proparallel<>'u' OR wrapper_row.pronargdefaults<>0
        OR pg_catalog.array_to_string(wrapper_row.proargnames,',')<>expected_function.arg_names
        OR pg_catalog.regexp_replace(wrapper_row.prosrc,'[[:space:]]','','g') IS DISTINCT FROM
          'SELECTprivate.'||v_name||'('||expected_function.arg_names||')'
        OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')
        OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(wrapper_row.proacl,pg_catalog.acldefault('f',wrapper_row.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
        v_detail := 'h3_public_acl'; EXIT;
      END IF;
    END IF;
  END LOOP;
  IF v_detail IS NOT NULL THEN RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid='public.checkout_drafts'::regclass
    AND t.tgname='h3_checkout_frozen' AND t.tgfoid='private.group_h_checkout_frozen()'::regprocedure
    AND t.tgenabled='O' AND t.tgtype=19 AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred
    AND t.tgqual IS NULL AND t.tgnargs=0
    AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr::smallint[]))=ARRAY['buyer_user_id','discount_engine_version','discount_facts','discount_result','discount_snapshot_hash','items_snapshot','stripe_discount_coupon_id','subtotal_amount','total_amount']) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL='h3_draft_freeze'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute AS a WHERE a.attrelid='public.checkout_drafts'::regclass
    AND a.attname='stripe_discount_coupon_id' AND a.atttypid='text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL='h3_coupon_binding'; END IF;
  CREATE TEMP TABLE h3_expected_checks(status text,discount_engine_version smallint,discount_amount integer,discount_result jsonb,stripe_discount_coupon_id text,
    CONSTRAINT h3_amount CHECK (status <> 'created' OR discount_engine_version IS DISTINCT FROM 1 OR discount_amount = 0),
    CONSTRAINT h3_coupon CHECK (stripe_discount_coupon_id IS NULL OR (discount_engine_version = 1 AND discount_result IS NOT NULL
      AND (discount_result->>'discountAmount')::numeric > 0 AND stripe_discount_coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'))) ON COMMIT DROP;
  FOR v_check,v_expected IN SELECT * FROM (VALUES ('checkout_drafts_h3_created_amount','h3_amount'),('checkout_drafts_h3_coupon','h3_coupon')) AS checks(actual_name,expected_name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_constraint AS e ON e.conrelid='pg_temp.h3_expected_checks'::regclass AND e.conname=v_expected
      WHERE c.conrelid='public.checkout_drafts'::regclass AND c.conname=v_check AND c.contype='c' AND c.convalidated AND NOT c.connoinherit
      AND pg_catalog.pg_get_expr(c.conbin,c.conrelid) IS NOT DISTINCT FROM pg_catalog.pg_get_expr(e.conbin,e.conrelid)) THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL='h3_amount_checks'; END IF;
  END LOOP;
  DROP TABLE pg_temp.h3_expected_checks;
END;
$h3_final$;
-- H3_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
