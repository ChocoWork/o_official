BEGIN;

-- H2_BODY_BEGIN
-- Retain only the member identifier needed to join a deleted assignee's immutable usage.
ALTER TABLE public.discount_assignments ADD COLUMN original_user_id uuid;
ALTER TABLE public.discount_codes ADD COLUMN unassigned_at timestamptz;
UPDATE public.discount_assignments SET original_user_id=user_id;
CREATE FUNCTION private.group_h_assignment_identity() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.original_user_id := NEW.user_id;
  ELSIF NEW.original_user_id IS DISTINCT FROM OLD.original_user_id THEN
    RAISE EXCEPTION 'GROUP_H_ASSIGNMENT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER h2_assignment_identity BEFORE INSERT OR UPDATE ON public.discount_assignments
  FOR EACH ROW EXECUTE FUNCTION private.group_h_assignment_identity();
-- All constants used by the save-time sweep live here. TS equality is pinned by a source test.
CREATE FUNCTION private.group_h_check_catalog() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_automatic_limit CONSTANT integer := 25;
  v_stackable_limit CONSTANT integer := 6;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  -- A half-open interval can attain its maximum only at a start. Future windows count too.
  -- Ended windows (ends_at <= now) are neither edges nor counted: they never overlap a live window
  -- from now on, so they must not block unrelated saves.
  IF EXISTS (SELECT 1 FROM public.discounts AS edge WHERE NOT edge.stopped AND edge.method='automatic'
    AND (edge.ends_at IS NULL OR edge.ends_at>pg_catalog.now())
    AND (SELECT pg_catalog.count(*) FROM public.discounts AS d WHERE NOT d.stopped AND d.method='automatic'
      AND (d.ends_at IS NULL OR d.ends_at>pg_catalog.now())
      AND d.starts_at<=edge.starts_at AND (d.ends_at IS NULL OR edge.starts_at<d.ends_at))>v_automatic_limit) THEN
    RAISE EXCEPTION 'GROUP_H_AUTOMATIC_LIMIT' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.discounts AS edge WHERE NOT edge.stopped AND edge.method='automatic'
    AND (edge.ends_at IS NULL OR edge.ends_at>pg_catalog.now())
    AND (edge.combines_with_product OR edge.combines_with_order)
    AND (SELECT pg_catalog.count(*) FROM public.discounts AS d WHERE NOT d.stopped AND d.method='automatic'
      AND (d.ends_at IS NULL OR d.ends_at>pg_catalog.now())
      AND (d.combines_with_product OR d.combines_with_order)
      AND (d.kind IN ('order_percent','order_amount'))=(edge.kind IN ('order_percent','order_amount'))
      AND d.starts_at<=edge.starts_at AND (d.ends_at IS NULL OR edge.starts_at<d.ends_at))>v_stackable_limit) THEN
    RAISE EXCEPTION 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.discounts AS a JOIN public.discounts AS b ON a.id<b.id
    AND a.kind='set' AND b.kind='set' AND NOT a.stopped AND NOT b.stopped
    AND a.combines_with_product AND b.combines_with_product
    AND (a.ends_at IS NULL OR a.ends_at>pg_catalog.now()) AND (b.ends_at IS NULL OR b.ends_at>pg_catalog.now())
    AND (a.ends_at IS NULL OR b.starts_at<a.ends_at) AND (b.ends_at IS NULL OR a.starts_at<b.ends_at)
    JOIN public.discount_items AS ai ON ai.discount_id=a.id
    JOIN public.discount_items AS bi ON bi.discount_id=b.id AND bi.item_id=ai.item_id) THEN
    RAISE EXCEPTION 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION private.group_h_catalog_constraint() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.group_h_check_catalog();
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER h2_discounts_catalog AFTER INSERT OR UPDATE OF kind,method,starts_at,ends_at,stopped,combines_with_product,combines_with_order
  ON public.discounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_catalog_constraint();
CREATE CONSTRAINT TRIGGER h2_items_catalog AFTER INSERT OR UPDATE OR DELETE ON public.discount_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_catalog_constraint();

CREATE FUNCTION private.group_h_require_permission(_actor_id uuid,_permission text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id,ARRAY[_permission]) THEN
    RAISE EXCEPTION 'GROUP_H_FORBIDDEN' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE FUNCTION private.group_h_lock(_ids uuid[],_identities text[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_identity text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  FOR v_identity IN SELECT DISTINCT i FROM pg_catalog.unnest(_identities) AS t(i) ORDER BY i LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(190523,pg_catalog.hashtext(v_identity));
  END LOOP;
  PERFORM d.id FROM public.discounts AS d WHERE d.id=ANY(_ids) ORDER BY d.id FOR UPDATE;
END;
$$;

CREATE FUNCTION private.group_h_hash(_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(_body::text,'UTF8')),'hex') $$;

CREATE FUNCTION private.group_h_replay(_request_key uuid,_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_row record; v_prior jsonb;
BEGIN
  IF _request_key IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT d.id,d.creation_request_hash INTO v_row FROM public.discounts AS d WHERE d.creation_request_key=_request_key;
  IF FOUND THEN
    IF v_row.creation_request_hash<>_hash THEN RAISE EXCEPTION 'GROUP_H_REQUEST_KEY_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('discountId',v_row.id,'version','1','replayed',true);
  END IF;
  SELECT d.admin_requests->_request_key::text INTO v_prior FROM public.discounts AS d WHERE d.admin_requests ? _request_key::text;
  IF FOUND THEN
    IF v_prior->>'hash'<>_hash THEN RAISE EXCEPTION 'GROUP_H_REQUEST_KEY_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN v_prior->'result' || '{"replayed":true}'::jsonb;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION private.group_h_remember(_id uuid,_request_key uuid,_hash text,_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.discounts SET admin_requests=admin_requests || pg_catalog.jsonb_build_object(_request_key::text,
    pg_catalog.jsonb_build_object('hash',_hash,'result',_result)) WHERE id=_id;
  RETURN _result;
END;
$$;

CREATE FUNCTION private.group_h_definition(_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('id',d.id,'version',d.version::text,'name',d.name,'kind',d.kind,'method',d.method,
    'value',pg_catalog.jsonb_build_object('type',d.value_type,'value',d.value),'targetMode',d.target_mode,
    'itemIds',COALESCE((SELECT pg_catalog.jsonb_agg(i.item_id ORDER BY i.item_id) FROM public.discount_items AS i WHERE i.discount_id=d.id),'[]'::jsonb),
    'minimum',pg_catalog.jsonb_build_object('type',d.minimum_type,'value',d.minimum_value),
    'audience',d.audience,'allowGuests',d.allow_guests,'firstOrderOnly',d.first_order_only,'oncePerCustomer',d.once_per_customer,
    'usageLimit',d.usage_limit,'startsAt',d.starts_at,'endsAt',d.ends_at,'stopped',d.stopped,
    'combinesWithProduct',d.combines_with_product,'combinesWithOrder',d.combines_with_order,'advertise',d.advertise,
    'advertisingText',d.advertising_text,'repeatPrevious',d.repeat_previous,'repeatInOrder',d.repeat_in_order)
    FROM public.discounts AS d WHERE d.id=_id
$$;

-- The same strict candidate validation is used by writers and the activation reader.
CREATE FUNCTION private.group_h_candidate(_id uuid,_patch jsonb,_activation boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v jsonb; k text; v_start timestamptz; v_end timestamptz; v_used boolean;
  v_keys CONSTANT text[] := ARRAY['name','kind','method','value','targetMode','itemIds','minimum','audience','allowGuests',
    'firstOrderOnly','oncePerCustomer','usageLimit','startsAt','endsAt','stopped','combinesWithProduct','combinesWithOrder',
    'advertise','advertisingText','repeatPrevious','repeatInOrder','code','userIds'];
BEGIN
  IF _patch IS NULL OR pg_catalog.jsonb_typeof(_patch)<>'object' THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(_patch) AS p(key) WHERE key<>ALL(v_keys) AND key<>'acknowledgeSearchAttention') THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF _id IS NOT NULL THEN
    v := private.group_h_definition(_id)-'id'-'version';
    IF v IS NULL THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.discount_id=_id) INTO v_used;
    IF _patch ? 'acknowledgeSearchAttention' THEN
      IF _patch<>'{"acknowledgeSearchAttention":true}'::jsonb THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
      RETURN v;
    END IF;
    IF v_used AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(_patch) AS p(key)
      WHERE key<>ALL(ARRAY['name','startsAt','endsAt','usageLimit','advertise','advertisingText'])
        AND NOT (_activation AND key='stopped')) THEN
      RAISE EXCEPTION 'GROUP_H_USED_FIELDS_LOCKED' USING ERRCODE='55000';
    END IF;
    IF (_patch ? 'stopped' AND NOT _activation) OR _patch ? 'userIds' THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    v := v || _patch;
  ELSE v := _patch; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(_patch) AS p(key) WHERE key<>ALL(v_keys))
    OR NOT v ?& v_keys[1:21] THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT pg_catalog.unnest(ARRAY['allowGuests','firstOrderOnly','oncePerCustomer','stopped','combinesWithProduct',
    'combinesWithOrder','advertise','repeatPrevious','repeatInOrder']) LOOP
    IF pg_catalog.jsonb_typeof(v->k)<>'boolean' THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR k IN SELECT pg_catalog.unnest(ARRAY['name','kind','method','targetMode','audience']) LOOP
    IF pg_catalog.jsonb_typeof(v->k)<>'string' THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(v->'value')<>'object' OR pg_catalog.jsonb_typeof(v->'minimum')<>'object' THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF pg_catalog.jsonb_typeof(v->'name')<>'string' OR pg_catalog.char_length(pg_catalog.btrim(v->>'name')) NOT BETWEEN 1 AND 100
    OR v->>'kind' NOT IN ('order_percent','order_amount','product','repeat','set')
    OR v->>'method' NOT IN ('automatic','code') OR v->>'audience' NOT IN ('assigned','anyone')
    OR pg_catalog.jsonb_typeof(v->'value')<>'object' OR NOT (v->'value') ?& ARRAY['type','value']
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(v->'value') AS p(key) WHERE key NOT IN ('type','value'))
    OR pg_catalog.jsonb_typeof(v#>'{value,type}')<>'string' OR v#>>'{value,type}' NOT IN ('amount','percent') OR pg_catalog.jsonb_typeof(v#>'{value,value}')<>'number'
    OR (v#>>'{value,value}')!~'^[1-9][0-9]*$' OR (v#>>'{value,value}')::numeric>2147483647
    OR (v#>>'{value,type}'='percent' AND (v#>>'{value,value}')::numeric>99)
    OR pg_catalog.jsonb_typeof(v->'minimum')<>'object' OR NOT (v->'minimum') ?& ARRAY['type','value']
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(v->'minimum') AS p(key) WHERE key NOT IN ('type','value'))
    OR pg_catalog.jsonb_typeof(v#>'{minimum,type}')<>'string' OR v#>>'{minimum,type}' NOT IN ('none','amount','quantity') OR pg_catalog.jsonb_typeof(v#>'{minimum,value}')<>'number'
    OR (v#>>'{minimum,value}')!~'^[0-9]+$' OR (v#>>'{minimum,value}')::numeric>2147483647
    OR (v#>>'{minimum,type}'='none' AND (v#>>'{minimum,value}')::numeric<>0)
    OR (v#>>'{minimum,type}'<>'none' AND (v#>>'{minimum,value}')::numeric<1)
    OR (v#>>'{value,type}'='amount' AND (v#>>'{minimum,type}'<>'amount' OR (v#>>'{minimum,value}')::numeric<=(v#>>'{value,value}')::numeric))
    OR (v->>'kind'='order_percent' AND v#>>'{value,type}'<>'percent') OR (v->>'kind'='order_amount' AND v#>>'{value,type}'<>'amount')
    OR (v->>'kind' IN ('order_percent','order_amount') AND v->>'targetMode'<>'all')
    OR (v->>'kind'='product' AND v->>'targetMode' NOT IN ('all','exclude'))
    OR (v->>'kind' IN ('repeat','set') AND v->>'targetMode'<>'include') THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.jsonb_typeof(v->'itemIds')<>'array' THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v->'itemIds') AS p(x) WHERE pg_catalog.jsonb_typeof(x)<>'number'
    OR x::text!~'^[1-9][0-9]*$' OR x::text::numeric>9007199254740991)
    OR (SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT x) FROM pg_catalog.jsonb_array_elements(v->'itemIds') AS p(x))
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v->'itemIds') AS p(x) WHERE NOT EXISTS(SELECT 1 FROM public.items AS i WHERE i.id=x::bigint))
    OR (v->>'targetMode'='all' AND pg_catalog.jsonb_array_length(v->'itemIds')<>0)
    OR (v->>'kind'='set' AND pg_catalog.jsonb_array_length(v->'itemIds') NOT BETWEEN 2 AND 10)
    OR (v->>'kind'='repeat' AND (pg_catalog.jsonb_array_length(v->'itemIds')=0 OR NOT ((v->>'repeatPrevious')::boolean OR (v->>'repeatInOrder')::boolean)))
    OR (v->>'audience'='assigned' AND (v->>'allowGuests')::boolean)
    OR (v->>'method'='automatic' AND (v->>'audience'<>'anyone' OR NOT (v->>'allowGuests')::boolean))
    OR ((v->>'advertise')::boolean AND v->>'method'<>'automatic') THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF v->'usageLimit'<>'null'::jsonb AND (pg_catalog.jsonb_typeof(v->'usageLimit')<>'number' OR v->>'usageLimit'!~'^[1-9][0-9]*$' OR (v->>'usageLimit')::numeric>2147483647)
    OR v->'advertisingText'<>'null'::jsonb AND (pg_catalog.jsonb_typeof(v->'advertisingText')<>'string' OR pg_catalog.char_length(pg_catalog.btrim(v->>'advertisingText')) NOT BETWEEN 1 AND 200)
    OR pg_catalog.jsonb_typeof(v->'startsAt')<>'string' OR pg_catalog.jsonb_typeof(v->'endsAt') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  v_start := (v->>'startsAt')::timestamptz; v_end := (v->>'endsAt')::timestamptz;
  IF NOT pg_catalog.isfinite(v_start) OR (v_end IS NOT NULL AND (NOT pg_catalog.isfinite(v_end) OR v_end<=v_start)) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF v ? 'code' THEN
    IF pg_catalog.jsonb_typeof(v->'code')<>'string' OR pg_catalog.upper(pg_catalog.btrim(v->>'code'))!~'^[A-Z0-9-]{1,64}$'
      OR v->>'method'<>'code' OR EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=_id AND c.single_use) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    v := pg_catalog.jsonb_set(v,'{code}',pg_catalog.to_jsonb(pg_catalog.upper(pg_catalog.btrim(v->>'code'))));
    IF EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.code=v->>'code' AND c.discount_id IS DISTINCT FROM _id) THEN
      RAISE EXCEPTION 'GROUP_H_CODE_CONFLICT' USING ERRCODE='23505'; END IF;
    -- A batch prefix alone must never become a valid code, not even through another discount's shared code.
    IF EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.single_use
      AND pg_catalog.regexp_replace(c.code,'-[^-]+$','')=v->>'code') THEN
      RAISE EXCEPTION 'GROUP_H_CODE_CONFLICT' USING ERRCODE='23505'; END IF;
  END IF;
  IF v ? 'userIds' THEN
    IF pg_catalog.jsonb_typeof(v->'userIds')<>'array' OR pg_catalog.jsonb_array_length(v->'userIds') NOT BETWEEN 1 AND 100
      OR v->>'audience'<>'assigned' OR NOT v ? 'code' THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    IF (SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT x) FROM pg_catalog.jsonb_array_elements_text(v->'userIds') AS p(x))
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v->'userIds') AS p(x) WHERE NOT EXISTS(
        SELECT 1 FROM auth.users AS u WHERE u.id=x::uuid AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=pg_catalog.now()))) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
  END IF;
  IF _id IS NOT NULL AND v->>'method'='automatic'
    AND EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=_id) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Activating (or switching to) the code method needs a code: shared, being saved now, or a generated batch.
  IF _id IS NOT NULL AND v->>'method'='code' AND NOT (v->>'stopped')::boolean AND (_activation OR _patch ? 'method')
    AND NOT v ? 'code' AND NOT EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=_id) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  RETURN v;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION private.group_h_validate_members(_user_ids uuid[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _user_ids IS NULL OR pg_catalog.cardinality(_user_ids) NOT BETWEEN 1 AND 100
    OR pg_catalog.array_ndims(_user_ids)<>1 OR pg_catalog.array_lower(_user_ids,1)<>1
    OR (SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT u) FROM pg_catalog.unnest(_user_ids) AS t(u))
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_user_ids) AS t(id) WHERE NOT EXISTS(
      SELECT 1 FROM auth.users AS u WHERE u.id=t.id AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=pg_catalog.now()))) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION private.admin_assign_discount(_discount_id uuid,_code_id uuid,_user_ids uuid[],_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_hash text; v_prior jsonb; v_count integer; v_identities text[];
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  -- Bound the array before taking one advisory lock per member.
  IF _user_ids IS NOT NULL AND pg_catalog.cardinality(_user_ids)>100 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT pg_catalog.array_agg('member:'||u::text ORDER BY u) INTO v_identities FROM pg_catalog.unnest(_user_ids) AS t(u);
  PERFORM private.group_h_lock(ARRAY[_discount_id],v_identities);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('assign',_discount_id,_code_id,_user_ids,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  PERFORM private.group_h_validate_members(_user_ids);
  IF _discount_id IS NULL OR _code_id IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=_discount_id) THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.id=_code_id AND c.discount_id=_discount_id AND c.audience='assigned' AND NOT c.single_use) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO public.discount_assignments(discount_id,code_id,user_id)
    SELECT _discount_id,_code_id,u FROM pg_catalog.unnest(_user_ids) AS t(u) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN private.group_h_remember(_discount_id,_request_key,v_hash,
    pg_catalog.jsonb_build_object('discountId',_discount_id,'changedCount',v_count,'replayed',false));
END;
$$;

CREATE FUNCTION private.admin_unassign_discount(_discount_id uuid,_code_id uuid,_user_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_hash text; v_prior jsonb; v_count integer; v_code public.discount_codes%ROWTYPE;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  PERFORM private.group_h_lock(ARRAY[_discount_id],ARRAY['member:'||_user_id::text]);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('unassign',_discount_id,_code_id,_user_id,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  IF _discount_id IS NULL OR _code_id IS NULL OR _user_id IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=_discount_id) THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT c.* INTO v_code FROM public.discount_codes AS c WHERE c.id=_code_id AND c.discount_id=_discount_id AND c.audience='assigned';
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.discount_id=_discount_id AND r.code_id=_code_id
    AND (r.user_id=_user_id OR r.identity_key='member:'||_user_id::text) AND r.state IN ('reserved','confirmed')) THEN
    RAISE EXCEPTION 'GROUP_H_ASSIGNMENT_USED' USING ERRCODE='55000'; END IF;
  IF v_code.single_use THEN
    -- A removed single-use assignee must never turn into an anyone code or be resurrected.
    IF v_code.assigned_user_id=_user_id THEN
      UPDATE public.discount_codes SET unassigned_at=pg_catalog.now() WHERE id=_code_id AND unassigned_at IS NULL;
      GET DIAGNOSTICS v_count=ROW_COUNT;
    ELSE v_count := 0; END IF;
  ELSE
    DELETE FROM public.discount_assignments WHERE discount_id=_discount_id AND code_id=_code_id AND user_id=_user_id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  RETURN private.group_h_remember(_discount_id,_request_key,v_hash,
    pg_catalog.jsonb_build_object('discountId',_discount_id,'changedCount',v_count,'replayed',false));
END;
$$;

-- Rejection sampling avoids modulo bias. This helper cannot be invoked by service_role.
CREATE FUNCTION private.group_h_random_suffix(_length integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; v_result text := ''; v_byte integer;
BEGIN
  WHILE pg_catalog.length(v_result)<_length LOOP
    v_byte := pg_catalog.get_byte(extensions.gen_random_bytes(1),0);
    IF v_byte<248 THEN v_result := v_result || pg_catalog.substr(v_alphabet,(v_byte % 31)+1,1); END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.admin_generate_discount_codes(_discount_id uuid,_prefix text,_user_ids uuid[],_count integer,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_hash text; v_prior jsonb; v_batch uuid := pg_catalog.gen_random_uuid(); v_discount public.discounts%ROWTYPE;
  v_code text; v_id uuid; v_user uuid; v_i integer; v_attempt integer; v_codes jsonb := '[]'::jsonb; v_identities text[];
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  -- Bound the array before taking one advisory lock per member.
  IF _user_ids IS NOT NULL AND pg_catalog.cardinality(_user_ids)>100 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT pg_catalog.array_agg('member:'||u::text ORDER BY u) INTO v_identities FROM pg_catalog.unnest(_user_ids) AS t(u);
  PERFORM private.group_h_lock(ARRAY[_discount_id],v_identities);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('generate',_discount_id,_prefix,_user_ids,_count,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  IF _discount_id IS NULL OR _prefix IS NULL OR _prefix!~'^[A-Z0-9]([A-Z0-9-]{0,53}[A-Z0-9])?$'
    OR _count IS NULL OR _count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF _user_ids IS NOT NULL THEN
    PERFORM private.group_h_validate_members(_user_ids);
    IF pg_catalog.cardinality(_user_ids)<>_count THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  SELECT d.* INTO v_discount FROM public.discounts AS d WHERE d.id=_discount_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_discount.method<>'code' OR (_user_ids IS NULL AND v_discount.audience<>'anyone')
    OR EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=_discount_id AND NOT c.single_use) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- The prefix alone must never be a valid code, so no shared code may already equal it.
  IF EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE NOT c.single_use AND c.code=_prefix) THEN
    RAISE EXCEPTION 'GROUP_H_CODE_CONFLICT' USING ERRCODE='23505'; END IF;
  FOR v_i IN 1.._count LOOP
    v_user := CASE WHEN _user_ids IS NULL THEN NULL ELSE _user_ids[v_i] END;
    v_id := NULL;
    FOR v_attempt IN 1..32 LOOP
      v_code := _prefix || '-' || private.group_h_random_suffix(CASE WHEN _user_ids IS NULL THEN 8 ELSE 4 END);
      INSERT INTO public.discount_codes(discount_id,code,audience,allow_guests,single_use,assigned_user_id,batch_id)
        VALUES(_discount_id,v_code,CASE WHEN _user_ids IS NULL THEN v_discount.audience ELSE 'assigned' END,
          CASE WHEN _user_ids IS NULL THEN v_discount.allow_guests ELSE false END,true,v_user,v_batch)
        ON CONFLICT (code) DO NOTHING RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN EXIT; END IF;
    END LOOP;
    IF v_id IS NULL THEN RAISE EXCEPTION 'GROUP_H_CODE_GENERATION_FAILED' USING ERRCODE='54000'; END IF;
    v_codes := v_codes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('codeId',v_id,'code',v_code,'userId',v_user));
  END LOOP;
  RETURN private.group_h_remember(_discount_id,_request_key,v_hash,pg_catalog.jsonb_build_object(
    'discountId',_discount_id,'batchId',v_batch,'codes',v_codes,'replayed',false));
END;
$$;

CREATE FUNCTION private.list_admin_discounts(_filters jsonb,_limit integer,_offset integer,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_result jsonb; v_query text;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.read');
  IF _filters IS NULL OR pg_catalog.jsonb_typeof(_filters)<>'object' OR _limit IS NULL OR _limit NOT BETWEEN 1 AND 100
    OR _offset IS NULL OR _offset<0 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(_filters) AS p(key) WHERE key NOT IN ('status','kind','method','query'))
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(_filters) AS p(key,v) WHERE pg_catalog.jsonb_typeof(v)<>'string')
    OR (_filters ? 'status' AND _filters->>'status' NOT IN ('scheduled','active','expired','stopped'))
    OR (_filters ? 'kind' AND _filters->>'kind' NOT IN ('order_percent','order_amount','product','repeat','set'))
    OR (_filters ? 'method' AND _filters->>'method' NOT IN ('code','automatic')) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_query := pg_catalog.btrim(_filters->>'query');
  IF _filters ? 'query' AND pg_catalog.char_length(v_query) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- strpos is a literal substring search, including percent, underscore and backslash.
  WITH rows AS (
    SELECT d.*,CASE WHEN d.stopped THEN 'stopped' WHEN d.starts_at>pg_catalog.now() THEN 'scheduled'
      WHEN d.ends_at<=pg_catalog.now() THEN 'expired' ELSE 'active' END AS status
      FROM public.discounts AS d
  ), filtered AS (
    SELECT d.* FROM rows AS d WHERE (NOT _filters ? 'status' OR d.status=_filters->>'status')
      AND (NOT _filters ? 'kind' OR d.kind=_filters->>'kind') AND (NOT _filters ? 'method' OR d.method=_filters->>'method')
      AND (v_query IS NULL OR pg_catalog.strpos(pg_catalog.lower(d.name),pg_catalog.lower(v_query))>0 OR EXISTS(
        SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=d.id AND pg_catalog.strpos(c.code,pg_catalog.upper(v_query))>0))
  ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT _limit OFFSET _offset),
  uses AS (SELECT r.discount_id,pg_catalog.count(*)::integer AS n FROM public.discount_redemptions AS r
    JOIN page AS p ON p.id=r.discount_id WHERE r.state IN ('reserved','confirmed') GROUP BY r.discount_id)
  SELECT pg_catalog.jsonb_build_object('total',(SELECT pg_catalog.count(*) FROM filtered),'rows',COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',p.id,'name',p.name,'kind',p.kind,'method',p.method,'status',p.status,
      'startsAt',p.starts_at,'endsAt',p.ends_at,'usedCount',COALESCE(u.n,0),'usageLimit',p.usage_limit,
      'searchAttention',CASE WHEN p.search_attention_at IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('openedAt',p.search_attention_at,'count',p.search_attention_count) END)
      ORDER BY p.created_at DESC,p.id) FROM page AS p LEFT JOIN uses AS u ON u.discount_id=p.id),'[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.get_admin_discount(_discount_id uuid,_assignment_limit integer,_assignment_offset integer,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.read');
  IF _discount_id IS NULL OR _assignment_limit IS NULL OR _assignment_limit NOT BETWEEN 1 AND 100 OR _assignment_offset IS NULL OR _assignment_offset<0 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=_discount_id) THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  WITH assigned AS (
    SELECT a.id::text AS row_id,c.id AS code_id,c.code,a.user_id,a.original_user_id AS original_user,true AS assigned,a.user_id IS NULL AS deleted
      FROM public.discount_assignments AS a JOIN public.discount_codes AS c ON c.id=a.code_id WHERE a.discount_id=_discount_id
    UNION ALL
    SELECT c.id::text,c.id,c.code,c.assigned_user_id,c.assigned_user_id,true,c.assigned_user_id IS NULL FROM public.discount_codes AS c
      WHERE c.discount_id=_discount_id AND c.single_use AND c.audience='assigned' AND c.unassigned_at IS NULL
  ), anyone_identity AS (
    SELECT r.*,c.code,COALESCE(r.user_id,(SELECT linked.user_id FROM public.discount_redemptions AS linked
      WHERE linked.code_id=r.code_id AND linked.user_id IS NOT NULL
        AND pg_catalog.lower(pg_catalog.btrim(linked.normalized_email))=pg_catalog.lower(pg_catalog.btrim(r.normalized_email))
      ORDER BY COALESCE(linked.confirmed_at,linked.reserved_at) DESC,linked.id DESC LIMIT 1)) AS effective_user
      FROM public.discount_redemptions AS r JOIN public.discount_codes AS c ON c.id=r.code_id
      WHERE r.discount_id=_discount_id AND c.audience='anyone'
  ), anyone_person AS (
    SELECT r.*,COALESCE('member:'||r.effective_user::text,'guest:'||NULLIF(pg_catalog.lower(pg_catalog.btrim(r.normalized_email)),''),r.identity_key) AS person
      FROM anyone_identity AS r
  ), anyone_ranked AS (
    SELECT r.*,
      pg_catalog.row_number() OVER (PARTITION BY r.code_id,r.person
        ORDER BY CASE WHEN r.state IN ('reserved','confirmed') THEN 0 ELSE 1 END,
          COALESCE(r.confirmed_at,r.reserved_at) DESC,r.id DESC) AS rank,
      -- The row id comes from a redemption id, never from a hash of the person's email.
      pg_catalog.first_value(r.id) OVER (PARTITION BY r.code_id,r.person ORDER BY r.id) AS first_redemption_id
      FROM anyone_person AS r
  ), all_rows AS (
    SELECT a.row_id,a.code_id,a.code,a.user_id,a.deleted,NULL::text AS email,
      COALESCE(r.state,'unused') AS status,CASE WHEN r.state='confirmed' THEN COALESCE(r.confirmed_at,r.reserved_at) ELSE r.reserved_at END AS used_at,r.order_id
      FROM assigned AS a LEFT JOIN LATERAL (
        SELECT r.* FROM public.discount_redemptions AS r WHERE r.code_id=a.code_id AND r.state IN ('reserved','confirmed')
          AND (r.user_id=a.user_id OR r.identity_key='member:'||a.original_user::text OR (a.deleted AND a.code_id=r.code_id AND
            ((SELECT c.single_use FROM public.discount_codes AS c WHERE c.id=a.code_id)
              OR r.identity_key='deleted-assignment:'||a.row_id)))
          ORDER BY COALESCE(r.confirmed_at,r.reserved_at) DESC,r.id DESC LIMIT 1
      ) AS r ON true
    UNION ALL
    SELECT 'usage:'||r.code_id::text||':'||r.first_redemption_id::text,r.code_id,r.code,r.effective_user,false,
      CASE WHEN r.effective_user IS NULL THEN COALESCE(r.normalized_email,'') END,
      CASE WHEN r.state='cancelled' THEN 'unused' ELSE r.state END,
      CASE WHEN r.state='confirmed' THEN COALESCE(r.confirmed_at,r.reserved_at) WHEN r.state='reserved' THEN r.reserved_at END,
      CASE WHEN r.state IN ('reserved','confirmed') THEN r.order_id END FROM anyone_ranked AS r WHERE r.rank=1
    UNION ALL
    SELECT c.id::text,c.id,c.code,NULL::uuid,false,NULL::text,'unused',NULL::timestamptz,NULL::uuid FROM public.discount_codes AS c
      WHERE c.discount_id=_discount_id AND c.single_use AND c.audience='anyone'
        AND NOT EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.code_id=c.id)
  ), page AS (SELECT * FROM all_rows ORDER BY code COLLATE "C",row_id COLLATE "C" LIMIT _assignment_limit OFFSET _assignment_offset)
  SELECT pg_catalog.jsonb_build_object('discount',private.group_h_definition(d.id),
    'used',EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.discount_id=d.id),
    'assignmentTotal',(SELECT pg_catalog.count(*) FROM all_rows),'assignments',COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('rowId',p.row_id,'codeId',p.code_id,'code',p.code,'userId',p.user_id,
        'assigneeDeleted',p.deleted,'assigneeName',profile.display_name,
        'guestEmailMasked',CASE WHEN p.email IS NULL THEN NULL WHEN p.email~'^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
          THEN pg_catalog.left(p.email,1)||'***@'||pg_catalog.split_part(p.email,'@',2) ELSE '***' END,
        'status',p.status,'usedAt',p.used_at,'orderId',p.order_id) ORDER BY p.code COLLATE "C",p.row_id COLLATE "C")
      FROM page AS p LEFT JOIN public.profiles AS profile ON profile.user_id=p.user_id),'[]'::jsonb),
    'searchAttention',CASE WHEN d.search_attention_at IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('openedAt',d.search_attention_at,'count',d.search_attention_count) END)
    INTO v_result FROM public.discounts AS d WHERE d.id=_discount_id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.search_admin_discount_members(_query text,_limit integer,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_result jsonb; v_query text := pg_catalog.btrim(_query);
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  IF v_query IS NULL OR pg_catalog.char_length(v_query) NOT BETWEEN 2 AND 100 OR _limit IS NULL OR _limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT pg_catalog.jsonb_build_object('rows',COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId',p.id,'name',p.name,'email',p.email)
    ORDER BY p.id),'[]'::jsonb)) INTO v_result FROM (
      SELECT u.id,profile.display_name AS name,u.email FROM auth.users AS u LEFT JOIN public.profiles AS profile ON profile.user_id=u.id
        WHERE u.deleted_at IS NULL AND u.email IS NOT NULL AND (u.banned_until IS NULL OR u.banned_until<=pg_catalog.now())
          AND (pg_catalog.strpos(pg_catalog.lower(u.email),pg_catalog.lower(v_query))>0
            OR pg_catalog.strpos(pg_catalog.lower(profile.display_name),pg_catalog.lower(v_query))>0) ORDER BY u.id LIMIT _limit
    ) AS p;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.get_admin_discount_activation_context(_discount_id uuid,_patch jsonb,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v jsonb; v_result jsonb;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  v := private.group_h_candidate(_discount_id,_patch,true)-'code'-'userIds';
  SELECT pg_catalog.jsonb_build_object('candidate',v,'existing',COALESCE(pg_catalog.jsonb_agg(private.group_h_definition(d.id) ORDER BY d.id),'[]'::jsonb))
    INTO v_result FROM public.discounts AS d WHERE NOT d.stopped AND d.id IS DISTINCT FROM _discount_id
      AND (d.ends_at IS NULL OR (v->>'startsAt')::timestamptz<d.ends_at)
      AND (v->>'endsAt' IS NULL OR d.starts_at<(v->>'endsAt')::timestamptz)
      AND (d.method='automatic' OR (d.kind='set' AND d.combines_with_product AND v->>'kind'='set' AND (v->>'combinesWithProduct')::boolean
        AND EXISTS(SELECT 1 FROM public.discount_items AS i WHERE i.discount_id=d.id AND (v->'itemIds') @> pg_catalog.jsonb_build_array(i.item_id))));
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.record_discount_search_fallback(_discount_ids uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _discount_ids IS NULL OR pg_catalog.cardinality(_discount_ids) NOT BETWEEN 1 AND 30
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_discount_ids) AS t(id) WHERE NOT EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=t.id)) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM private.group_h_lock(_discount_ids,ARRAY[]::text[]);
  UPDATE public.discounts SET search_attention_at=pg_catalog.now(),search_attention_count=search_attention_count+1
    WHERE id=ANY(_discount_ids) AND (search_attention_at IS NULL OR search_attention_at<=pg_catalog.now()-interval '10 minutes');
END;
$$;

-- One write projection prevents candidate/writer field drift. The caller already owns all locks.
CREATE FUNCTION private.group_h_save(_id uuid,_v jsonb,_actor_id uuid,_key uuid,_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_code uuid;
BEGIN
  INSERT INTO public.discounts AS d (id,name,kind,method,value_type,value,target_mode,minimum_type,minimum_value,
    audience,allow_guests,first_order_only,once_per_customer,usage_limit,starts_at,ends_at,stopped,
    combines_with_product,combines_with_order,advertise,advertising_text,repeat_previous,repeat_in_order,
    created_by,updated_by,creation_request_key,creation_request_hash)
  VALUES (_id,_v->>'name',_v->>'kind',_v->>'method',_v#>>'{value,type}',(_v#>>'{value,value}')::integer,
    _v->>'targetMode',_v#>>'{minimum,type}',(_v#>>'{minimum,value}')::integer,_v->>'audience',(_v->>'allowGuests')::boolean,
    (_v->>'firstOrderOnly')::boolean,(_v->>'oncePerCustomer')::boolean,(_v->>'usageLimit')::integer,
    (_v->>'startsAt')::timestamptz,(_v->>'endsAt')::timestamptz,(_v->>'stopped')::boolean,
    (_v->>'combinesWithProduct')::boolean,(_v->>'combinesWithOrder')::boolean,(_v->>'advertise')::boolean,
    _v->>'advertisingText',(_v->>'repeatPrevious')::boolean,(_v->>'repeatInOrder')::boolean,_actor_id,_actor_id,_key,_hash)
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,method=EXCLUDED.method,value_type=EXCLUDED.value_type,
    value=EXCLUDED.value,target_mode=EXCLUDED.target_mode,minimum_type=EXCLUDED.minimum_type,minimum_value=EXCLUDED.minimum_value,
    audience=EXCLUDED.audience,allow_guests=EXCLUDED.allow_guests,first_order_only=EXCLUDED.first_order_only,
    once_per_customer=EXCLUDED.once_per_customer,usage_limit=EXCLUDED.usage_limit,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,
    stopped=EXCLUDED.stopped,combines_with_product=EXCLUDED.combines_with_product,combines_with_order=EXCLUDED.combines_with_order,
    advertise=EXCLUDED.advertise,advertising_text=EXCLUDED.advertising_text,repeat_previous=EXCLUDED.repeat_previous,
    repeat_in_order=EXCLUDED.repeat_in_order,updated_by=_actor_id,updated_at=pg_catalog.now(),version=d.version+1;
  DELETE FROM public.discount_items AS i WHERE i.discount_id=_id
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(_v->'itemIds') AS p(x) WHERE x::bigint=i.item_id);
  INSERT INTO public.discount_items(discount_id,item_id) SELECT _id,x::bigint FROM pg_catalog.jsonb_array_elements_text(_v->'itemIds') AS p(x)
    ON CONFLICT DO NOTHING;
  IF _v->>'audience'='anyone' THEN DELETE FROM public.discount_assignments WHERE discount_id=_id; END IF;
  IF _v ? 'code' THEN
    SELECT c.id INTO v_code FROM public.discount_codes AS c WHERE c.discount_id=_id AND NOT c.single_use;
    IF FOUND THEN UPDATE public.discount_codes SET code=_v->>'code',audience=_v->>'audience',allow_guests=(_v->>'allowGuests')::boolean WHERE id=v_code;
    ELSE INSERT INTO public.discount_codes(discount_id,code,audience,allow_guests)
      VALUES(_id,_v->>'code',_v->>'audience',(_v->>'allowGuests')::boolean) RETURNING id INTO v_code; END IF;
  END IF;
  UPDATE public.discount_codes SET audience=_v->>'audience',allow_guests=(_v->>'allowGuests')::boolean WHERE discount_id=_id AND NOT single_use;
  IF _v ? 'userIds' THEN
    INSERT INTO public.discount_assignments(discount_id,code_id,user_id)
      SELECT _id,v_code,x::uuid FROM pg_catalog.jsonb_array_elements_text(_v->'userIds') AS p(x) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM private.group_h_check_catalog();
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'GROUP_H_CODE_CONFLICT' USING ERRCODE='23505';
END;
$$;

CREATE FUNCTION private.admin_create_discount(_input jsonb,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id uuid := pg_catalog.gen_random_uuid(); v_hash text; v_prior jsonb; v jsonb; v_identities text[];
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  PERFORM private.group_h_lock(ARRAY[]::uuid[],ARRAY[]::text[]);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('create',_input,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  v := private.group_h_candidate(NULL,_input,false);
  IF v ? 'userIds' THEN
    SELECT pg_catalog.array_agg('member:'||x ORDER BY x) INTO v_identities FROM pg_catalog.jsonb_array_elements_text(v->'userIds') AS p(x);
    PERFORM private.group_h_lock(ARRAY[]::uuid[],v_identities);
  END IF;
  PERFORM private.group_h_save(v_id,v,_actor_id,_request_key,v_hash);
  RETURN pg_catalog.jsonb_build_object('discountId',v_id,'version','1','replayed',false);
END;
$$;

CREATE FUNCTION private.admin_update_discount(_discount_id uuid,_patch jsonb,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_hash text; v_prior jsonb; v jsonb; v_version bigint; v_identities text[];
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  PERFORM private.group_h_lock(ARRAY[]::uuid[],ARRAY[]::text[]);
  IF _patch->>'audience'='anyone' THEN
    SELECT pg_catalog.array_agg('member:'||a.user_id::text ORDER BY a.user_id) INTO v_identities
      FROM public.discount_assignments AS a WHERE a.discount_id=_discount_id AND a.user_id IS NOT NULL;
  END IF;
  PERFORM private.group_h_lock(ARRAY[_discount_id],v_identities);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('update',_discount_id,_patch,_expected_version,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  IF _discount_id IS NULL OR _expected_version IS NULL OR _expected_version<1 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT d.version INTO v_version FROM public.discounts AS d WHERE d.id=_discount_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_version<>_expected_version THEN RAISE EXCEPTION 'GROUP_H_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  v := private.group_h_candidate(_discount_id,_patch,false);
  IF _patch ? 'acknowledgeSearchAttention' THEN
    UPDATE public.discounts SET search_attention_at=NULL,version=version+1,updated_by=_actor_id,updated_at=pg_catalog.now() WHERE id=_discount_id;
  ELSE PERFORM private.group_h_save(_discount_id,v,_actor_id,_request_key,v_hash); END IF;
  RETURN private.group_h_remember(_discount_id,_request_key,v_hash,
    pg_catalog.jsonb_build_object('discountId',_discount_id,'version',(v_version+1)::text,'replayed',false));
END;
$$;

CREATE FUNCTION private.admin_set_discount_stopped(_discount_id uuid,_stopped boolean,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_hash text; v_prior jsonb; v_version bigint;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  PERFORM private.group_h_lock(ARRAY[_discount_id],ARRAY[]::text[]);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('stop',_discount_id,_stopped,_expected_version,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  IF _discount_id IS NULL OR _stopped IS NULL OR _expected_version IS NULL OR _expected_version<1 THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT d.version INTO v_version FROM public.discounts AS d WHERE d.id=_discount_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_version<>_expected_version THEN RAISE EXCEPTION 'GROUP_H_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT _stopped AND EXISTS(SELECT 1 FROM public.discounts AS d WHERE d.id=_discount_id AND d.method='code')
    AND NOT EXISTS(SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id=_discount_id) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE public.discounts SET stopped=_stopped,version=version+1,updated_at=pg_catalog.now(),updated_by=_actor_id WHERE id=_discount_id;
  PERFORM private.group_h_check_catalog();
  RETURN private.group_h_remember(_discount_id,_request_key,v_hash,
    pg_catalog.jsonb_build_object('discountId',_discount_id,'version',(v_version+1)::text,'replayed',false));
END;
$$;

CREATE FUNCTION private.admin_duplicate_discount(_discount_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id uuid := pg_catalog.gen_random_uuid(); v_hash text; v_prior jsonb; v jsonb;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.discounts.manage');
  PERFORM private.group_h_lock(ARRAY[_discount_id],ARRAY[]::text[]);
  v_hash := private.group_h_hash(pg_catalog.jsonb_build_array('duplicate',_discount_id,_actor_id));
  v_prior := private.group_h_replay(_request_key,v_hash); IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  IF _discount_id IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v := private.group_h_definition(_discount_id)-'id'-'version';
  IF v IS NULL THEN RAISE EXCEPTION 'GROUP_H_DISCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  v := v || '{"stopped":true}'::jsonb;
  PERFORM private.group_h_save(v_id,v,_actor_id,_request_key,v_hash);
  RETURN pg_catalog.jsonb_build_object('discountId',v_id,'version','1','replayed',false);
END;
$$;

CREATE FUNCTION private.get_checkout_discount_context(_buyer_user_id uuid,_guest_email text,_codes text[],_item_ids bigint[],_at timestamptz,_phase text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_preview boolean; v_email text; v_identity text; v_previous boolean; v_reservation boolean;
  v_units jsonb := '{}'::jsonb; v_codes text[]; v_usage jsonb; v_discounts jsonb; v_refusals jsonb;
BEGIN
  IF _phase IS NULL OR _phase NOT IN ('preview','confirm','acceptance') OR _at IS NULL OR NOT pg_catalog.isfinite(_at)
    OR _codes IS NULL OR _item_ids IS NULL OR pg_catalog.cardinality(_codes)>5 OR pg_catalog.cardinality(_item_ids)>50
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_codes) AS t(c) WHERE c IS NULL OR pg_catalog.upper(pg_catalog.btrim(c))!~'^[A-Z0-9-]{1,64}$')
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_item_ids) AS t(id) WHERE id IS NULL OR id<1 OR id>9007199254740991) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT pg_catalog.upper(pg_catalog.btrim(c)) ORDER BY pg_catalog.upper(pg_catalog.btrim(c))),ARRAY[]::text[])
    INTO v_codes FROM pg_catalog.unnest(_codes) AS t(c);
  v_preview := _buyer_user_id IS NULL AND _phase='preview';
  IF _buyer_user_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM auth.users AS u WHERE u.id=_buyer_user_id AND u.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_identity := 'member:'||_buyer_user_id::text;
  ELSIF NOT v_preview THEN
    v_email := pg_catalog.lower(pg_catalog.btrim(_guest_email));
    IF v_email IS NULL OR v_email!~'^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' OR pg_catalog.length(v_email)>320 THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_identity := 'guest:'||v_email;
  END IF;
  -- This branch is deliberate: guest preview never executes an orders, refund, or identity-history query.
  IF NOT v_preview THEN
    SELECT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.paid_at IS NOT NULL AND o.status IN ('paid','shipped','cancelled')
      AND CASE WHEN _buyer_user_id IS NOT NULL THEN o.user_id=_buyer_user_id
        ELSE pg_catalog.lower(pg_catalog.btrim(o.shipping_email))=v_email END) INTO v_previous;
    SELECT EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.state='reserved' AND r.first_order_only_snapshot
      AND CASE WHEN _buyer_user_id IS NOT NULL THEN r.user_id=_buyer_user_id OR r.identity_key=v_identity
        ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END) INTO v_reservation;
    IF _buyer_user_id IS NOT NULL THEN
      WITH refunds AS (SELECT l.order_item_id,pg_catalog.sum(l.quantity) AS n FROM public.order_refund_lines AS l
        JOIN public.order_refunds AS r ON r.id=l.refund_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
        JOIN public.orders AS o ON o.id=oi.order_id WHERE r.status='succeeded' AND o.user_id=_buyer_user_id
          AND oi.item_id=ANY(_item_ids) GROUP BY l.order_item_id),
      units AS (SELECT oi.item_id,pg_catalog.sum(GREATEST(oi.quantity-COALESCE(r.n,0),0))::bigint AS n
        FROM public.orders AS o JOIN public.order_items AS oi ON oi.order_id=o.id LEFT JOIN refunds AS r ON r.order_item_id=oi.id
        WHERE o.user_id=_buyer_user_id AND o.paid_at IS NOT NULL AND o.status IN ('paid','shipped','cancelled')
          AND oi.line_kind='order' AND oi.item_id=ANY(_item_ids) GROUP BY oi.item_id)
      SELECT COALESCE(pg_catalog.jsonb_object_agg(u.item_id::text,u.n),'{}'::jsonb) INTO v_units FROM units AS u;
    END IF;
  END IF;
  WITH selected AS (
    SELECT d.id AS discount_id,c.id AS code_id,c.code,COALESCE(c.audience,'anyone') AS audience,
      COALESCE(c.allow_guests,true) AS allow_guests,COALESCE(c.single_use,false) AS single_use,
      CASE WHEN c.single_use THEN c.assigned_user_id=_buyer_user_id AND c.unassigned_at IS NULL
        ELSE EXISTS(SELECT 1 FROM public.discount_assignments AS a WHERE a.code_id=c.id AND a.user_id=_buyer_user_id) END AS assigned
    FROM public.discounts AS d LEFT JOIN public.discount_codes AS c ON c.discount_id=d.id AND c.code=ANY(v_codes)
    WHERE (d.method='automatic' AND NOT d.stopped AND d.starts_at<=_at AND (d.ends_at IS NULL OR _at<d.ends_at))
      OR (d.method='code' AND c.id IS NOT NULL AND c.unassigned_at IS NULL
        AND CASE WHEN _buyer_user_id IS NULL THEN c.audience='anyone' AND c.allow_guests AND d.allow_guests
          ELSE c.audience='anyone' OR (c.single_use AND c.assigned_user_id=_buyer_user_id)
            OR EXISTS(SELECT 1 FROM public.discount_assignments AS a WHERE a.code_id=c.id AND a.user_id=_buyer_user_id) END)
  ), totals AS (
    SELECT r.discount_id,pg_catalog.count(*) FILTER(WHERE r.state='reserved')::integer AS reserved,
      pg_catalog.count(*) FILTER(WHERE r.state='confirmed')::integer AS confirmed
      FROM public.discount_redemptions AS r WHERE r.discount_id IN (SELECT s.discount_id FROM selected AS s)
      GROUP BY r.discount_id
  ), code_totals AS (
    SELECT r.code_id,pg_catalog.count(*)::integer AS n FROM public.discount_redemptions AS r
      WHERE r.code_id IN (SELECT s.code_id FROM selected AS s) AND r.state IN ('reserved','confirmed') GROUP BY r.code_id
  )
  SELECT COALESCE((SELECT pg_catalog.jsonb_agg(private.group_h_definition(x.discount_id) ORDER BY x.discount_id)
    FROM (SELECT DISTINCT s.discount_id FROM selected AS s) AS x),'[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('discountId',s.discount_id,
      'reserved',COALESCE(t.reserved,0),'confirmed',COALESCE(t.confirmed,0),
      'buyerUses',NULL,'assigned',COALESCE(s.assigned,false),'codeId',s.code_id,'code',s.code,
      'audience',s.audience,'allowGuests',s.allow_guests,'singleUse',s.single_use,'codeUses',COALESCE(ct.n,0)) ORDER BY s.discount_id,s.code_id)
      FROM selected AS s LEFT JOIN totals AS t ON t.discount_id=s.discount_id LEFT JOIN code_totals AS ct ON ct.code_id=s.code_id),'[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code',c,'reason',CASE WHEN _buyer_user_id IS NULL THEN 'not_eligible'
      WHEN EXISTS(SELECT 1 FROM public.discount_codes AS known WHERE known.code=c) THEN 'not_eligible' ELSE 'not_found' END) ORDER BY c)
      FROM pg_catalog.unnest(v_codes) AS codes(c) WHERE NOT EXISTS(SELECT 1 FROM selected AS s WHERE s.code=c)),'[]'::jsonb)
    INTO v_discounts,v_usage,v_refusals;
  IF NOT v_preview THEN
    -- Personal usage is deliberately a separate statement that cannot execute during guest preview.
    WITH uses AS (SELECT r.discount_id,pg_catalog.count(*)::integer AS n FROM public.discount_redemptions AS r
      WHERE r.state IN ('reserved','confirmed') AND CASE WHEN _buyer_user_id IS NOT NULL THEN r.user_id=_buyer_user_id OR r.identity_key=v_identity
        ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END GROUP BY r.discount_id)
    SELECT COALESCE(pg_catalog.jsonb_agg(u.x || pg_catalog.jsonb_build_object('buyerUses',COALESCE(p.n,0)) ORDER BY u.ordinal),'[]'::jsonb)
      INTO v_usage FROM pg_catalog.jsonb_array_elements(v_usage) WITH ORDINALITY AS u(x,ordinal)
      LEFT JOIN uses AS p ON p.discount_id=(u.x->>'discountId')::uuid;
  END IF;
  RETURN pg_catalog.jsonb_build_object('discounts',v_discounts,'facts',pg_catalog.jsonb_build_object('phase',_phase,'at',_at,
    'buyer',CASE WHEN _buyer_user_id IS NULL THEN pg_catalog.jsonb_build_object('kind','guest','normalizedEmail',v_email)
      ELSE pg_catalog.jsonb_build_object('kind','member','userId',_buyer_user_id) END,
    'hasPreviousOrder',v_previous,'hasFirstOrderReservation',v_reservation,'priorUnitsByItem',v_units,'usage',v_usage),'refusals',v_refusals);
END;
$$;

-- H2_EXPOSURE_BEGIN
ALTER FUNCTION private.group_h_assignment_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_assignment_identity() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_check_catalog() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_check_catalog() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_catalog_constraint() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_catalog_constraint() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_require_permission(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_require_permission(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_lock(uuid[],text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_lock(uuid[],text[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_hash(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_hash(jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_replay(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_replay(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_remember(uuid,uuid,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_remember(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_definition(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_definition(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_candidate(uuid,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_candidate(uuid,jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_validate_members(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_validate_members(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_assign_discount(_discount_id uuid,_code_id uuid,_user_ids uuid[],_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_assign_discount(_discount_id,_code_id,_user_ids,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_assign_discount(uuid,uuid,uuid[],uuid,uuid) TO service_role;
ALTER FUNCTION private.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_unassign_discount(_discount_id uuid,_code_id uuid,_user_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_unassign_discount(_discount_id,_code_id,_user_id,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_unassign_discount(uuid,uuid,uuid,uuid,uuid) TO service_role;
ALTER FUNCTION private.group_h_random_suffix(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_random_suffix(integer) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_generate_discount_codes(_discount_id uuid,_prefix text,_user_ids uuid[],_count integer,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_generate_discount_codes(_discount_id,_prefix,_user_ids,_count,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid) TO service_role;
ALTER FUNCTION private.list_admin_discounts(jsonb,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_discounts(jsonb,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_discounts(jsonb,integer,integer,uuid) TO service_role;
CREATE FUNCTION public.list_admin_discounts(_filters jsonb,_limit integer,_offset integer,_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_admin_discounts(_filters,_limit,_offset,_actor_id) $$;
ALTER FUNCTION public.list_admin_discounts(jsonb,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_discounts(jsonb,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_discounts(jsonb,integer,integer,uuid) TO service_role;
ALTER FUNCTION private.get_admin_discount(uuid,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_discount(uuid,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_discount(uuid,integer,integer,uuid) TO service_role;
CREATE FUNCTION public.get_admin_discount(_discount_id uuid,_assignment_limit integer,_assignment_offset integer,_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_admin_discount(_discount_id,_assignment_limit,_assignment_offset,_actor_id) $$;
ALTER FUNCTION public.get_admin_discount(uuid,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_discount(uuid,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_discount(uuid,integer,integer,uuid) TO service_role;
ALTER FUNCTION private.search_admin_discount_members(text,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.search_admin_discount_members(text,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.search_admin_discount_members(text,integer,uuid) TO service_role;
CREATE FUNCTION public.search_admin_discount_members(_query text,_limit integer,_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.search_admin_discount_members(_query,_limit,_actor_id) $$;
ALTER FUNCTION public.search_admin_discount_members(text,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_admin_discount_members(text,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_admin_discount_members(text,integer,uuid) TO service_role;
ALTER FUNCTION private.get_admin_discount_activation_context(uuid,jsonb,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_discount_activation_context(uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_discount_activation_context(uuid,jsonb,uuid) TO service_role;
CREATE FUNCTION public.get_admin_discount_activation_context(_discount_id uuid,_patch jsonb,_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_admin_discount_activation_context(_discount_id,_patch,_actor_id) $$;
ALTER FUNCTION public.get_admin_discount_activation_context(uuid,jsonb,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_discount_activation_context(uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_discount_activation_context(uuid,jsonb,uuid) TO service_role;
ALTER FUNCTION private.record_discount_search_fallback(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_discount_search_fallback(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_discount_search_fallback(uuid[]) TO service_role;
CREATE FUNCTION public.record_discount_search_fallback(_discount_ids uuid[]) RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.record_discount_search_fallback(_discount_ids) $$;
ALTER FUNCTION public.record_discount_search_fallback(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_discount_search_fallback(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_discount_search_fallback(uuid[]) TO service_role;
ALTER FUNCTION private.group_h_save(uuid,jsonb,uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_save(uuid,jsonb,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.admin_create_discount(jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_create_discount(jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_create_discount(jsonb,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_create_discount(_input jsonb,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_create_discount(_input,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_create_discount(jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_discount(jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_discount(jsonb,uuid,uuid) TO service_role;
ALTER FUNCTION private.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_update_discount(_discount_id uuid,_patch jsonb,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_update_discount(_discount_id,_patch,_expected_version,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_discount(uuid,jsonb,bigint,uuid,uuid) TO service_role;
ALTER FUNCTION private.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_set_discount_stopped(_discount_id uuid,_stopped boolean,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_discount_stopped(_discount_id,_stopped,_expected_version,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid) TO service_role;
ALTER FUNCTION private.admin_duplicate_discount(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_duplicate_discount(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_duplicate_discount(uuid,uuid,uuid) TO service_role;
CREATE FUNCTION public.admin_duplicate_discount(_discount_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_duplicate_discount(_discount_id,_request_key,_actor_id) $$;
ALTER FUNCTION public.admin_duplicate_discount(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_duplicate_discount(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_duplicate_discount(uuid,uuid,uuid) TO service_role;
ALTER FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) TO service_role;
CREATE FUNCTION public.get_checkout_discount_context(_buyer_user_id uuid,_guest_email text,_codes text[],_item_ids bigint[],_at timestamptz,_phase text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_checkout_discount_context(_buyer_user_id,_guest_email,_codes,_item_ids,_at,_phase) $$;
ALTER FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) TO service_role;

-- H2_FINAL_ASSERT_BEGIN
DO $h2_final$
DECLARE
  e record; p record; w record; v_detail text; v_oid oid; v_name text;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('group_h_assignment_identity()','trigger','plpgsql','v',false,'1b5ec4196b51a037e5847754ed4684ca','','h2_functions'),
    ('group_h_check_catalog()','void','plpgsql','v',false,'0c6959fbfba075bf44e5b144d3c7665b','','h2_stackable_cap'),
    ('group_h_catalog_constraint()','trigger','plpgsql','v',false,'7d65064758af40d7b98753845ec084f7','','h2_stackable_cap'),
    ('group_h_require_permission(uuid,text)','void','plpgsql','s',false,'38bf59e95d2ca3bc29596566bf039d75','_actor_id,_permission','h2_permission_checks'),
    ('group_h_lock(uuid[],text[])','void','plpgsql','v',false,'623cf990882313fb993f6281420b689c','_ids,_identities','h2_automatic_lock'),
    ('group_h_hash(jsonb)','text','sql','i',false,'67e319a008d0ff9055de3f402619fcdf','_body','h2_admin_requests'),
    ('group_h_replay(uuid,text)','jsonb','plpgsql','s',false,'a79c805d71533bbc8f34b8a1de976d7e','_request_key,_hash','h2_admin_requests'),
    ('group_h_remember(uuid,uuid,text,jsonb)','jsonb','plpgsql','v',false,'8f6d1326ae504198174817e0e877045a','_id,_request_key,_hash,_result','h2_admin_requests'),
    ('group_h_definition(uuid)','jsonb','sql','s',false,'54d907cb1bb23753c84141c3ea6a5742','_id','h2_permission_checks'),
    ('group_h_candidate(uuid,jsonb,boolean)','jsonb','plpgsql','s',false,'7b4d37f0dab67880dfc2488f779815ee','_id,_patch,_activation','h2_permission_checks'),
    ('group_h_validate_members(uuid[])','void','plpgsql','s',false,'273d0f54fed92097126c91fc5d7142a0','_user_ids','h2_permission_checks'),
    ('admin_assign_discount(uuid,uuid,uuid[],uuid,uuid)','jsonb','plpgsql','v',true,'b73d0427ff38a6060b1d1fcf704e869c','_discount_id,_code_id,_user_ids,_request_key,_actor_id','h2_permission_checks'),
    ('admin_unassign_discount(uuid,uuid,uuid,uuid,uuid)','jsonb','plpgsql','v',true,'2f5ba26e0a9de1b15f518b1657dcbee0','_discount_id,_code_id,_user_id,_request_key,_actor_id','h2_permission_checks'),
    ('group_h_random_suffix(integer)','text','plpgsql','v',false,'6bc37ba1f95f29452bf103421d965355','_length','h2_permission_checks'),
    ('admin_generate_discount_codes(uuid,text,uuid[],integer,uuid,uuid)','jsonb','plpgsql','v',true,'90b85c8b4d2877046a5236db3ab0c4e6','_discount_id,_prefix,_user_ids,_count,_request_key,_actor_id','h2_permission_checks'),
    ('list_admin_discounts(jsonb,integer,integer,uuid)','jsonb','plpgsql','s',true,'579a26d0087655b73c00c6d9ff641394','_filters,_limit,_offset,_actor_id','h2_permission_checks'),
    ('get_admin_discount(uuid,integer,integer,uuid)','jsonb','plpgsql','s',true,'148e2fc9df369f529d07d9b6d83619d8','_discount_id,_assignment_limit,_assignment_offset,_actor_id','h2_permission_checks'),
    ('search_admin_discount_members(text,integer,uuid)','jsonb','plpgsql','s',true,'6ab884596d0f271a4edd84289a479767','_query,_limit,_actor_id','h2_permission_checks'),
    ('get_admin_discount_activation_context(uuid,jsonb,uuid)','jsonb','plpgsql','s',true,'7eb074e03d0f740340742bd1d3c2a21a','_discount_id,_patch,_actor_id','h2_permission_checks'),
    ('record_discount_search_fallback(uuid[])','void','plpgsql','v',true,'be0f6807e1dad1a05396b9daaa3f2be3','_discount_ids','h2_search_attention'),
    ('group_h_save(uuid,jsonb,uuid,uuid,text)','void','plpgsql','v',false,'6a07cef1925c173e58144e1020e99e7a','_id,_v,_actor_id,_key,_hash','h2_permission_checks'),
    ('admin_create_discount(jsonb,uuid,uuid)','jsonb','plpgsql','v',true,'7dd513dd43cbbdf7d3f108e4a7b900ad','_input,_request_key,_actor_id','h2_permission_checks'),
    ('admin_update_discount(uuid,jsonb,bigint,uuid,uuid)','jsonb','plpgsql','v',true,'3f13e111b9219e2d74d1e92aa13f0485','_discount_id,_patch,_expected_version,_request_key,_actor_id','h2_permission_checks'),
    ('admin_set_discount_stopped(uuid,boolean,bigint,uuid,uuid)','jsonb','plpgsql','v',true,'d87190dd7a80dd292a8b041960a516fc','_discount_id,_stopped,_expected_version,_request_key,_actor_id','h2_permission_checks'),
    ('admin_duplicate_discount(uuid,uuid,uuid)','jsonb','plpgsql','v',true,'140f3f8d38857ab190c21613ece62169','_discount_id,_request_key,_actor_id','h2_permission_checks'),
    ('get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)','jsonb','plpgsql','s',true,'e95df5ff839cd450e6243d4220491742','_buyer_user_id,_guest_email,_codes,_item_ids,_at,_phase','h2_permission_checks')
  ) AS expected(signature,result_type,language,volatility,service,body_md5,arg_names,detail) LOOP
    v_name := pg_catalog.split_part(e.signature,'(',1);
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='private' AND f.proname=v_name)<>1
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='public' AND f.proname=v_name)<>(CASE WHEN e.service THEN 1 ELSE 0 END) THEN
      v_detail := 'h2_functions'; EXIT;
    END IF;
    v_oid := pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.*,l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF NOT FOUND THEN v_detail := 'h2_functions'; EXIT; END IF;
    IF e.volatility='s' AND p.provolatile<>'s' THEN v_detail := 'h2_reads_stable'; EXIT; END IF;
    IF p.proowner<>'postgres'::regrole OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
      OR p.prorettype<>pg_catalog.to_regtype(e.result_type) OR p.proretset OR p.prokind<>'f'
      OR p.provolatile<>e.volatility::"char" OR p.lanname<>e.language OR p.proisstrict OR p.proleakproof
      OR p.proparallel<>'u' OR p.pronargdefaults<>0
      OR COALESCE(pg_catalog.array_to_string(p.proargnames,','),'')<>e.arg_names THEN
      v_detail := 'h2_functions'; EXIT;
    END IF;
    IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')<>e.service
      OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_detail := 'h2_public_acl'; EXIT;
    END IF;
    IF pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5 THEN v_detail := e.detail; EXIT; END IF;
    IF e.service THEN
      v_oid := pg_catalog.to_regprocedure('public.'||e.signature);
      SELECT f.*,l.lanname INTO w FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
      IF NOT FOUND THEN v_detail := 'h2_functions'; EXIT; END IF;
      IF e.volatility='s' AND w.provolatile<>'s' THEN v_detail := 'h2_reads_stable'; EXIT; END IF;
      IF w.proowner<>'postgres'::regrole OR w.prosecdef OR w.lanname<>'sql'
        OR w.proconfig IS DISTINCT FROM ARRAY['search_path=""'] OR w.prorettype<>p.prorettype OR w.proretset
        OR w.prokind<>'f' OR w.provolatile<>p.provolatile OR w.proisstrict OR w.proleakproof OR w.proparallel<>'u' OR w.pronargdefaults<>0
        OR w.proargnames IS DISTINCT FROM p.proargnames
        OR pg_catalog.regexp_replace(pg_catalog.lower(w.prosrc),'[[:space:];]','','g')<>'selectprivate.'||v_name||'('||e.arg_names||')'
        OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')
        OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(w.proacl,pg_catalog.acldefault('f',w.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
        v_detail := 'h2_public_acl'; EXIT;
      END IF;
    END IF;
  END LOOP;
  IF v_detail IS NULL AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute AS a WHERE a.attrelid='public.discounts'::regclass
    AND a.attname='admin_requests' AND a.atttypid='jsonb'::regtype AND a.attnotnull AND NOT a.attisdropped
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid=a.attrelid AND c.contype='c' AND c.convalidated
      AND pg_catalog.pg_get_expr(c.conbin,c.conrelid)='(jsonb_typeof(admin_requests) = ''object''::text)')) THEN v_detail := 'h2_admin_requests'; END IF;
  IF v_detail IS NULL AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indrelid='public.discount_codes'::regclass AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=1
      AND i.indnatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname='code' AND a.attnotnull
      AND a.attcollation='pg_catalog."C"'::regcollation) THEN v_detail := 'h2_code_unique'; END IF;
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('h2_discounts_catalog','discounts','group_h_catalog_constraint',21,true,
        ARRAY['combines_with_order','combines_with_product','ends_at','kind','method','starts_at','stopped']::text[],'h2_stackable_cap'),
      ('h2_items_catalog','discount_items','group_h_catalog_constraint',29,true,ARRAY[]::text[],'h2_set_items_disjoint'),
      ('h2_assignment_identity','discount_assignments','group_h_assignment_identity',23,false,ARRAY[]::text[],'h2_functions')
    ) AS t(name,table_name,function_name,type,deferred,columns,detail) LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgname=e.name
        AND t.tgrelid=pg_catalog.to_regclass('public.'||e.table_name) AND t.tgfoid=pg_catalog.to_regprocedure('private.'||e.function_name||'()')
        AND t.tgtype=e.type AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
        AND t.tgqual IS NULL AND t.tgnargs=0 AND COALESCE((SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
          FROM pg_catalog.unnest(t.tgattr) AS k(num) JOIN pg_catalog.pg_attribute AS a ON a.attrelid=t.tgrelid AND a.attnum=k.num),ARRAY[]::text[])=e.columns) THEN
        v_detail := e.detail; EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_detail IS NULL AND EXISTS(SELECT 1 FROM (VALUES
    ('discounts','search_attention_at','timestamptz'),('discounts','search_attention_count','integer'),
    ('discount_assignments','original_user_id','uuid'),('discount_codes','unassigned_at','timestamptz')
  ) AS x(table_name,column_name,type_name) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid=pg_catalog.to_regclass('public.'||x.table_name) AND a.attname=x.column_name
      AND a.atttypid=pg_catalog.to_regtype(x.type_name) AND NOT a.attisdropped)) THEN v_detail := 'h2_search_attention'; END IF;
  IF v_detail IS NULL AND EXISTS(SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('discounts','discount_items','discount_codes','discount_assignments','discount_redemptions',
      'order_line_discount_allocations','order_line_unit_amounts') AND (c.relowner<>'postgres'::regrole OR NOT c.relrowsecurity
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon','authenticated','service_role')
          AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) AS a WHERE a.grantee=0)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute AS attr CROSS JOIN LATERAL pg_catalog.aclexplode(attr.attacl) AS a
          WHERE attr.attrelid=c.oid AND a.grantee=0))) THEN v_detail := 'h2_public_acl'; END IF;
  IF v_detail IS NOT NULL THEN RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL=v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='GROUP_H_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An error inside the assert itself is not a genuine check result: keep it distinguishable.
  RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h2_internal', HINT=SQLSTATE||': '||SQLERRM;
END;
$h2_final$;
-- H2_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
