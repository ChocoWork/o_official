BEGIN;

-- H1_BODY_BEGIN
CREATE TABLE public.discounts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('order_percent','order_amount','product','repeat','set')),
  method text NOT NULL CHECK (method IN ('code','automatic')),
  value_type text NOT NULL CHECK (value_type IN ('percent','amount')),
  value integer NOT NULL,
  target_mode text NOT NULL CHECK (target_mode IN ('all','exclude','include')),
  minimum_type text NOT NULL CHECK (minimum_type IN ('none','amount','quantity')),
  minimum_value integer NOT NULL,
  audience text NOT NULL CHECK (audience IN ('assigned','anyone')),
  allow_guests boolean NOT NULL DEFAULT false,
  first_order_only boolean NOT NULL DEFAULT false,
  once_per_customer boolean NOT NULL DEFAULT false,
  combines_with_product boolean NOT NULL DEFAULT false,
  combines_with_order boolean NOT NULL DEFAULT false,
  advertise boolean NOT NULL DEFAULT false,
  repeat_previous boolean NOT NULL DEFAULT false,
  repeat_in_order boolean NOT NULL DEFAULT false,
  stopped boolean NOT NULL DEFAULT false,
  usage_limit integer CHECK (usage_limit >= 1),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  advertising_text text CHECK (pg_catalog.char_length(pg_catalog.btrim(advertising_text)) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  creation_request_key uuid NOT NULL UNIQUE,
  creation_request_hash text NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(admin_requests) = 'object'),
  search_attention_at timestamptz,
  search_attention_count integer NOT NULL DEFAULT 0 CHECK (search_attention_count >= 0),
  CONSTRAINT discounts_value_check CHECK ((value_type = 'percent' AND value BETWEEN 1 AND 99)
    OR (value_type = 'amount' AND value >= 1 AND minimum_type = 'amount' AND minimum_value > value)),
  CONSTRAINT discounts_minimum_check CHECK ((minimum_type = 'none' AND minimum_value = 0)
    OR (minimum_type IN ('amount','quantity') AND minimum_value >= 1)),
  CONSTRAINT discounts_period_check CHECK (ends_at IS NULL OR starts_at < ends_at),
  CONSTRAINT discounts_assigned_guest_check CHECK (audience <> 'assigned' OR NOT allow_guests),
  CONSTRAINT discounts_automatic_check CHECK (method <> 'automatic' OR (audience = 'anyone' AND allow_guests)),
  CONSTRAINT discounts_advertise_check CHECK (NOT advertise OR method = 'automatic'),
  CONSTRAINT discounts_repeat_check CHECK (kind <> 'repeat' OR repeat_previous OR repeat_in_order),
  CONSTRAINT discounts_kind_value_check CHECK ((kind <> 'order_percent' OR value_type = 'percent')
    AND (kind <> 'order_amount' OR value_type = 'amount')),
  CONSTRAINT discounts_target_check CHECK ((kind IN ('order_percent','order_amount') AND target_mode = 'all')
    OR (kind = 'product' AND target_mode IN ('all','exclude'))
    OR (kind IN ('repeat','set') AND target_mode = 'include'))
);

CREATE TABLE public.discount_items (
  discount_id uuid NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (discount_id,item_id)
);

CREATE TABLE public.discount_codes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  discount_id uuid NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  code text COLLATE "C" NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{1,64}$'),
  audience text NOT NULL CHECK (audience IN ('assigned','anyone')),
  allow_guests boolean NOT NULL DEFAULT false,
  single_use boolean NOT NULL DEFAULT false,
  assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (discount_id,id),
  CONSTRAINT discount_codes_assigned_guest_check CHECK (audience <> 'assigned' OR NOT allow_guests),
  CONSTRAINT discount_codes_assignment_check CHECK (assigned_user_id IS NULL OR (single_use AND audience = 'assigned')),
  CONSTRAINT discount_codes_batch_check CHECK (single_use = (batch_id IS NOT NULL)
    AND (NOT single_use OR code ~ '^.+-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8}$'))
);

CREATE TABLE public.discount_assignments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  discount_id uuid NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  code_id uuid NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (code_id,user_id),
  FOREIGN KEY (discount_id,code_id) REFERENCES public.discount_codes(discount_id,id) ON DELETE RESTRICT
);

CREATE TABLE public.discount_redemptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  discount_id uuid NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  code_id uuid,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  identity_key text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(identity_key)) > 0),
  normalized_email text,
  state text NOT NULL CHECK (state IN ('reserved','confirmed','cancelled')),
  reserved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  name_snapshot text NOT NULL,
  code_snapshot text,
  class_snapshot text NOT NULL CHECK (class_snapshot IN ('product','order')),
  amount integer NOT NULL CHECK (amount >= 0),
  first_order_only_snapshot boolean NOT NULL,
  reconciliation_fallback boolean NOT NULL DEFAULT false,
  attention_kind text CHECK (attention_kind IN ('discount_limit_exceeded','discount_reconciliation_recovered')),
  attention_resolved_at timestamptz,
  attention_resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (order_id,discount_id),
  FOREIGN KEY (discount_id,code_id) REFERENCES public.discount_codes(discount_id,id) ON DELETE RESTRICT
);
CREATE INDEX discount_redemptions_discount_state_idx ON public.discount_redemptions(discount_id,state);
CREATE INDEX discount_redemptions_identity_discount_state_idx ON public.discount_redemptions(identity_key,discount_id,state);
CREATE INDEX discount_redemptions_code_state_idx ON public.discount_redemptions(code_id,state);
CREATE INDEX discount_redemptions_order_idx ON public.discount_redemptions(order_id);

CREATE TABLE public.order_line_discount_allocations (
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  discount_id uuid NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  amount integer NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (order_item_id,discount_id)
);
CREATE TABLE public.order_line_unit_amounts (
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  unit_index integer NOT NULL CHECK (unit_index >= 0),
  paid_amount integer NOT NULL CHECK (paid_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (order_item_id,unit_index)
);

CREATE INDEX discounts_created_by_idx ON public.discounts(created_by);
CREATE INDEX discounts_updated_by_idx ON public.discounts(updated_by);
CREATE INDEX discount_items_item_idx ON public.discount_items(item_id);
CREATE INDEX discount_codes_assigned_user_idx ON public.discount_codes(assigned_user_id);
CREATE INDEX discount_assignments_user_idx ON public.discount_assignments(user_id);
CREATE INDEX discount_assignments_discount_idx ON public.discount_assignments(discount_id);
CREATE INDEX discount_redemptions_user_idx ON public.discount_redemptions(user_id);
CREATE INDEX discount_redemptions_attention_resolver_idx ON public.discount_redemptions(attention_resolved_by);
CREATE INDEX order_line_discount_allocations_order_idx ON public.order_line_discount_allocations(order_id);
CREATE INDEX order_line_discount_allocations_discount_idx ON public.order_line_discount_allocations(discount_id);
CREATE INDEX order_line_unit_amounts_order_idx ON public.order_line_unit_amounts(order_id);

ALTER TABLE public.checkout_drafts
  ADD COLUMN discount_result jsonb,
  ADD COLUMN discount_facts jsonb,
  ADD COLUMN discount_engine_version smallint,
  ADD COLUMN discount_snapshot_hash text,
  ADD CONSTRAINT checkout_drafts_h_discount_check CHECK (
    (discount_result IS NULL AND discount_facts IS NULL AND discount_engine_version IS NULL AND discount_snapshot_hash IS NULL)
    OR (discount_result IS NOT NULL AND discount_facts IS NOT NULL AND discount_engine_version IS NOT NULL AND discount_snapshot_hash IS NOT NULL
      AND discount_engine_version = 1 AND discount_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND pg_catalog.jsonb_typeof(discount_result) = 'object' AND pg_catalog.jsonb_typeof(discount_facts) = 'object'
      AND discount_result -> 'version' = '1'::jsonb
      AND pg_catalog.jsonb_typeof(discount_result -> 'allocations') = 'array'
      AND pg_catalog.jsonb_typeof(discount_result -> 'unitAmounts') = 'array'
      AND discount_result ?& ARRAY['version','allocations','unitAmounts'])
  );

CREATE FUNCTION private.group_h_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'GROUP_H_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION private.group_h_validate_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_item uuid;
  v_order uuid;
  v_quantity integer;
  v_total bigint;
  v_kind text;
  v_count bigint;
  v_max integer;
  v_min integer;
  v_paid bigint;
  v_discount bigint;
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN v_item := NEW.id; ELSE v_item := NEW.order_item_id; END IF;
  SELECT oi.order_id,oi.quantity,oi.line_total,oi.line_kind INTO v_order,v_quantity,v_total,v_kind
    FROM public.order_items AS oi WHERE oi.id = v_item;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.order_line_discount_allocations AS a WHERE a.order_item_id = v_item AND a.order_id <> v_order)
    OR EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id = v_item AND u.order_id <> v_order) THEN
    RAISE EXCEPTION 'GROUP_H_LINE_ORDER_MISMATCH' USING ERRCODE = '23503';
  END IF;
  SELECT pg_catalog.count(*),pg_catalog.min(u.unit_index),pg_catalog.max(u.unit_index),COALESCE(pg_catalog.sum(u.paid_amount),0)
    INTO v_count,v_min,v_max,v_paid FROM public.order_line_unit_amounts AS u WHERE u.order_item_id = v_item;
  SELECT COALESCE(pg_catalog.sum(a.amount),0) INTO v_discount
    FROM public.order_line_discount_allocations AS a WHERE a.order_item_id = v_item;
  IF v_count = 0 AND NOT EXISTS (SELECT 1 FROM public.order_line_discount_allocations AS a WHERE a.order_item_id = v_item) THEN RETURN NULL; END IF;
  IF (v_kind = 'exchange' AND v_discount <> 0) OR v_count <> v_quantity OR v_min <> 0 OR v_max <> v_quantity - 1
    OR v_paid <> v_total - v_discount THEN
    RAISE EXCEPTION 'GROUP_H_LINE_AMOUNTS_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION private.group_h_validate_definition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_old uuid;
  v_discount public.discounts%ROWTYPE;
  v_count bigint;
BEGIN
  -- Serialize cross-row constraints, including changes made outside future writers.
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  IF TG_TABLE_NAME = 'discounts' THEN
    v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_id := OLD.discount_id;
  ELSE
    v_id := NEW.discount_id;
    IF TG_OP = 'UPDATE' THEN v_old := OLD.discount_id; END IF;
  END IF;
  FOR v_discount IN SELECT d.* FROM public.discounts AS d WHERE d.id IN (v_id,v_old) ORDER BY d.id FOR UPDATE LOOP
    SELECT pg_catalog.count(*) INTO v_count FROM public.discount_items AS i WHERE i.discount_id = v_discount.id;
    IF (v_discount.kind = 'set' AND v_count NOT BETWEEN 2 AND 10)
      OR (v_count > 0 AND NOT ((v_discount.kind = 'product' AND v_discount.target_mode = 'exclude')
        OR (v_discount.kind IN ('repeat','set') AND v_discount.target_mode = 'include')))
      OR (v_discount.method = 'automatic' AND EXISTS (SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id = v_discount.id)) THEN
      RAISE EXCEPTION 'GROUP_H_DEFINITION_INVALID' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.discount_codes AS c WHERE c.discount_id = v_discount.id AND NOT c.single_use
      AND EXISTS (SELECT 1 FROM public.discount_codes AS other WHERE other.discount_id = c.discount_id AND other.id <> c.id))
      OR EXISTS (SELECT 1 FROM public.discount_assignments AS a JOIN public.discount_codes AS c ON c.id = a.code_id
        WHERE a.discount_id = v_discount.id AND (c.single_use OR c.audience <> 'assigned')) THEN
      RAISE EXCEPTION 'GROUP_H_CODES_INVALID' USING ERRCODE = '23514';
    END IF;
    IF v_discount.kind = 'set' AND v_discount.combines_with_product AND NOT v_discount.stopped AND EXISTS (
      SELECT 1 FROM public.discounts AS d JOIN public.discount_items AS theirs ON theirs.discount_id = d.id
      JOIN public.discount_items AS ours ON ours.item_id = theirs.item_id AND ours.discount_id = v_discount.id
      WHERE d.id <> v_discount.id AND d.kind = 'set' AND d.combines_with_product AND NOT d.stopped
        AND (d.ends_at IS NULL OR v_discount.starts_at < d.ends_at)
        AND (v_discount.ends_at IS NULL OR d.starts_at < v_discount.ends_at)
    ) THEN RAISE EXCEPTION 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' USING ERRCODE = '23514'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Immediate relation checks accompany deferred whole-definition and whole-line checks.
CREATE FUNCTION private.group_h_validate_relation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_kind text; v_mode text; v_method text;
BEGIN
  IF TG_TABLE_NAME = 'discount_items' THEN
    SELECT d.kind,d.target_mode INTO v_kind,v_mode FROM public.discounts AS d WHERE d.id = NEW.discount_id;
    IF FOUND AND NOT ((v_kind = 'product' AND v_mode = 'exclude') OR (v_kind IN ('repeat','set') AND v_mode = 'include')) THEN
      RAISE EXCEPTION 'GROUP_H_TARGET_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'discount_codes' THEN
    IF NEW.single_use AND NEW.audience = 'assigned' AND NEW.assigned_user_id IS NULL THEN
      IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'GROUP_H_CODES_INVALID' USING ERRCODE = '23514';
      ELSIF NOT OLD.single_use OR OLD.audience <> 'assigned' THEN
        RAISE EXCEPTION 'GROUP_H_CODES_INVALID' USING ERRCODE = '23514';
      END IF;
    END IF;
    SELECT d.method INTO v_method FROM public.discounts AS d WHERE d.id = NEW.discount_id;
    IF v_method = 'automatic' THEN RAISE EXCEPTION 'GROUP_H_CODES_INVALID' USING ERRCODE = '23514'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.id = NEW.order_item_id AND oi.order_id <> NEW.order_id) THEN
      RAISE EXCEPTION 'GROUP_H_LINE_ORDER_MISMATCH' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION private.group_h_preserve_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'discount_assignments' THEN
    IF NEW.id <> OLD.id OR NEW.code_id <> OLD.code_id OR NEW.discount_id <> OLD.discount_id
      OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'GROUP_H_ASSIGNMENT_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.single_use AND OLD.audience = 'assigned' AND OLD.assigned_user_id IS NULL
    AND (NOT NEW.single_use OR NEW.audience <> 'assigned' OR NEW.assigned_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'GROUP_H_ASSIGNMENT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION private.group_h_order_has_units(_order_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_id = _order_id)
$$;

CREATE TRIGGER h1_assignments_preserve BEFORE UPDATE ON public.discount_assignments FOR EACH ROW EXECUTE FUNCTION private.group_h_preserve_assignment();
CREATE TRIGGER h1_codes_preserve BEFORE UPDATE ON public.discount_codes FOR EACH ROW EXECUTE FUNCTION private.group_h_preserve_assignment();

CREATE TRIGGER h1_items_relation BEFORE INSERT OR UPDATE OF discount_id,item_id ON public.discount_items FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_relation();
CREATE TRIGGER h1_codes_relation BEFORE INSERT OR UPDATE OF discount_id,single_use,audience ON public.discount_codes FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_relation();
CREATE TRIGGER h1_allocations_relation BEFORE INSERT ON public.order_line_discount_allocations FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_relation();
CREATE TRIGGER h1_units_relation BEFORE INSERT ON public.order_line_unit_amounts FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_relation();
CREATE TRIGGER h1_allocations_immutable BEFORE UPDATE OR DELETE ON public.order_line_discount_allocations FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER h1_units_immutable BEFORE UPDATE OR DELETE ON public.order_line_unit_amounts FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER h1_allocations_truncate BEFORE TRUNCATE ON public.order_line_discount_allocations FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER h1_units_truncate BEFORE TRUNCATE ON public.order_line_unit_amounts FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE CONSTRAINT TRIGGER h1_allocations_sum AFTER INSERT ON public.order_line_discount_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_line();
CREATE CONSTRAINT TRIGGER h1_units_sum AFTER INSERT ON public.order_line_unit_amounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_line();
CREATE CONSTRAINT TRIGGER h1_order_items_sum AFTER UPDATE OF order_id,quantity,line_total,line_kind ON public.order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (private.group_h_order_has_units(OLD.order_id) OR private.group_h_order_has_units(NEW.order_id))
  EXECUTE FUNCTION private.group_h_validate_line();
CREATE CONSTRAINT TRIGGER h1_discounts_definition AFTER INSERT OR UPDATE OF id,kind,method,target_mode,stopped,starts_at,ends_at,combines_with_product ON public.discounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_definition();
CREATE CONSTRAINT TRIGGER h1_items_definition AFTER INSERT OR UPDATE OF discount_id,item_id OR DELETE ON public.discount_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_definition();
CREATE CONSTRAINT TRIGGER h1_codes_definition AFTER INSERT OR UPDATE OF id,discount_id,audience,single_use,batch_id OR DELETE ON public.discount_codes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_definition();
CREATE CONSTRAINT TRIGGER h1_assignments_definition AFTER INSERT OR UPDATE OF discount_id,code_id OR DELETE ON public.discount_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.group_h_validate_definition();

CREATE OR REPLACE FUNCTION private.admin_get_permissions(_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  catalog CONSTANT text[] := ARRAY[
    'admin.users.read', 'admin.users.manage', 'admin.items.read', 'admin.items.manage',
    'admin.news.read', 'admin.news.manage', 'admin.looks.read', 'admin.looks.manage',
    'admin.stockists.read', 'admin.stockists.manage', 'admin.orders.read', 'admin.orders.manage',
    'admin.contact.read', 'admin.contact.manage', 'admin.finance.read', 'admin.finance.manage',
    'admin.audit.read', 'admin.orders.refund', 'admin.settings.manage', 'admin.orders.return',
    'admin.stock.read', 'admin.stock.manage', 'admin.orders.allocate', 'admin.purchase_orders.read',
    'admin.purchase_orders.manage', 'admin.receiving.manage', 'admin.shipping.read',
    'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage',
    'admin.discounts.read', 'admin.discounts.manage'
  ];
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = _actor_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND r.code = 'admin' AND p.code = 'admin.permissions.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;

  -- One SQL statement supplies the catalog, both versions and both ACL projections.
  SELECT pg_catalog.jsonb_build_object(
    'permissionCodes', (SELECT pg_catalog.jsonb_agg(code ORDER BY code) FROM pg_catalog.unnest(catalog) AS c(code)),
    'roles', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'code', r.code, 'version', r.permissions_version::text,
      'permissionCodes', (SELECT COALESCE(pg_catalog.jsonb_agg(p.code ORDER BY p.code), '[]'::jsonb)
        FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = r.id AND p.code = ANY(catalog))
      ) ORDER BY CASE r.code WHEN 'admin' THEN 0 ELSE 1 END)
      FROM public.roles r WHERE r.code IN ('admin', 'supporter'))
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_set_role_permissions(
  _actor_id uuid, _role_code text, _permission_codes text[], _expected_version bigint, _request_key uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  catalog CONSTANT text[] := ARRAY[
    'admin.users.read', 'admin.users.manage', 'admin.items.read', 'admin.items.manage',
    'admin.news.read', 'admin.news.manage', 'admin.looks.read', 'admin.looks.manage',
    'admin.stockists.read', 'admin.stockists.manage', 'admin.orders.read', 'admin.orders.manage',
    'admin.contact.read', 'admin.contact.manage', 'admin.finance.read', 'admin.finance.manage',
    'admin.audit.read', 'admin.orders.refund', 'admin.settings.manage', 'admin.orders.return',
    'admin.stock.read', 'admin.stock.manage', 'admin.orders.allocate', 'admin.purchase_orders.read',
    'admin.purchase_orders.manage', 'admin.receiving.manage', 'admin.shipping.read',
    'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage',
    'admin.discounts.read', 'admin.discounts.manage'
  ];
  fixed CONSTANT text[] := ARRAY['admin.users.manage', 'admin.permissions.manage'];
  codes text[];
  prior private.role_permission_requests%ROWTYPE;
  target_role_id bigint;
  version bigint;
  changed_count integer;
  result jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190519, 0);
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = _actor_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND r.code = 'admin' AND p.code = 'admin.permissions.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  IF _role_code IS NULL OR _role_code NOT IN ('admin', 'supporter')
    OR _permission_codes IS NULL OR _expected_version IS NULL OR _expected_version < 0
    OR _request_key IS NULL OR pg_catalog.array_ndims(_permission_codes) > 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(_permission_codes) AS c(code)
    WHERE code IS NULL OR NOT (code = ANY(catalog))
      OR NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.code = c.code))
    OR (SELECT count(*) <> count(DISTINCT code) FROM pg_catalog.unnest(_permission_codes) AS c(code)) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(code ORDER BY code), ARRAY[]::text[])
    INTO codes FROM pg_catalog.unnest(_permission_codes) AS c(code);
  IF (_role_code = 'admin' AND NOT (fixed <@ codes))
    OR (_role_code = 'supporter' AND fixed && codes) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FIXED', ERRCODE = '42501';
  END IF;

  SELECT * INTO prior FROM private.role_permission_requests q WHERE q.request_key = _request_key;
  IF FOUND THEN
    IF prior.actor_id IS DISTINCT FROM _actor_id OR prior.role IS DISTINCT FROM _role_code
      OR prior.permission_codes IS DISTINCT FROM codes OR prior.expected_version IS DISTINCT FROM _expected_version THEN
      RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN prior.result;
  END IF;

  SELECT r.id, r.permissions_version INTO target_role_id, version FROM public.roles r WHERE r.code = _role_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  IF version <> _expected_version THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_VERSION_CONFLICT', ERRCODE = 'P0001';
  END IF;

  WITH revoked AS (
    DELETE FROM public.role_permissions rp USING public.permissions p
    WHERE rp.role_id = target_role_id AND rp.permission_id = p.id
      AND p.code = ANY(catalog) AND NOT (p.code = ANY(codes))
    RETURNING rp.permission_id
  ), granted AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT target_role_id, p.id FROM public.permissions p
    WHERE p.code = ANY(codes)
      AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = target_role_id AND rp.permission_id = p.id)
    ON CONFLICT DO NOTHING RETURNING permission_id
  ), events AS (
    INSERT INTO public.role_permission_events (role, permission_code, action, actor_id, request_key)
    SELECT _role_code, p.code, diff.action, _actor_id, _request_key
    FROM (SELECT permission_id, 'revoke'::text AS action FROM revoked
      UNION ALL SELECT permission_id, 'grant'::text FROM granted) diff
    JOIN public.permissions p ON p.id = diff.permission_id
    RETURNING id
  ) SELECT count(*)::integer INTO changed_count FROM events;

  IF changed_count > 0 THEN
    UPDATE public.roles r SET permissions_version = r.permissions_version + 1
      WHERE r.id = target_role_id RETURNING r.permissions_version INTO version;
  END IF;
  result := pg_catalog.jsonb_build_object('role', pg_catalog.jsonb_build_object(
    'code', _role_code, 'version', version::text, 'permissionCodes', pg_catalog.to_jsonb(codes)),
    'changedCount', changed_count);
  INSERT INTO private.role_permission_requests (request_key, actor_id, role, permission_codes, expected_version, result)
    VALUES (_request_key, _actor_id, _role_code, codes, _expected_version, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION private.order_line_discounts(_order_id uuid)
RETURNS TABLE (order_item_id uuid, line_discount integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH stored AS MATERIALIZED (
    SELECT EXISTS (SELECT 1 FROM public.order_line_discount_allocations AS a WHERE a.order_id = _order_id) AS present
  ), lines AS (
    SELECT oi.id,
           pg_catalog.row_number() OVER (ORDER BY oi.created_at, oi.id) AS line_no,
           pg_catalog.count(*) OVER () AS line_count,
           (pg_catalog.sum(oi.line_total) OVER (
             ORDER BY oi.created_at, oi.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ))::bigint AS running_total,
           (pg_catalog.sum(oi.line_total) OVER ())::bigint AS lines_total
    FROM public.order_items AS oi
    WHERE oi.order_id = _order_id AND oi.line_kind = 'order' AND NOT (SELECT present FROM stored)
  ),
  rounded AS (
    SELECT l.id,
           l.line_no,
           CASE
             WHEN l.lines_total = 0 THEN
               CASE WHEN l.line_no = l.line_count THEN o.discount_amount::bigint ELSE 0::bigint END
             ELSE (2 * o.discount_amount::bigint * l.running_total + l.lines_total) / (2 * l.lines_total)
           END AS cumulative_discount
    FROM lines AS l
    CROSS JOIN public.orders AS o
    WHERE o.id = _order_id
  )
  SELECT oi.id, COALESCE(pg_catalog.sum(a.amount),0)::integer
  FROM public.order_items AS oi
  LEFT JOIN public.order_line_discount_allocations AS a ON a.order_item_id = oi.id AND a.order_id = oi.order_id
  WHERE oi.order_id = _order_id AND oi.line_kind = 'order' AND (SELECT present FROM stored)
  GROUP BY oi.id
  UNION ALL
  SELECT r.id,
         (r.cumulative_discount - pg_catalog.lag(r.cumulative_discount, 1, 0::bigint) OVER (ORDER BY r.line_no))::integer
  FROM rounded AS r
  UNION ALL
  SELECT oi.id, 0 FROM public.order_items AS oi
  WHERE oi.order_id = _order_id AND oi.line_kind = 'exchange'
$$;
ALTER TABLE public.discounts OWNER TO postgres;
ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discounts FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.discount_items OWNER TO postgres;
ALTER TABLE public.discount_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discount_items FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.discount_codes OWNER TO postgres;
ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discount_codes FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.discount_assignments OWNER TO postgres;
ALTER TABLE public.discount_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discount_assignments FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.discount_redemptions OWNER TO postgres;
ALTER TABLE public.discount_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discount_redemptions FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.order_line_discount_allocations OWNER TO postgres;
ALTER TABLE public.order_line_discount_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_line_discount_allocations FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.order_line_unit_amounts OWNER TO postgres;
ALTER TABLE public.order_line_unit_amounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_line_unit_amounts FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_immutable() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_validate_line() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_validate_line() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_validate_definition() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_validate_definition() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_validate_relation() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_validate_relation() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_preserve_assignment() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_preserve_assignment() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_order_has_units(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_order_has_units(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.order_line_discounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_line_discounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.admin_get_permissions(uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_role_permissions(uuid,text,text[],bigint,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_get_permissions(uuid), private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.admin_get_permissions(uuid), private.admin_set_role_permissions(uuid,text,text[],bigint,uuid) TO service_role;
-- H1_BODY_END

-- H1_PERMISSION_SEED_BEGIN
SELECT pg_catalog.pg_advisory_xact_lock(190519,0);
CREATE TEMP TABLE group_h_permission_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.group_h_permission_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'permissions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id) FROM public.permissions AS p
    WHERE p.code NOT IN ('admin.discounts.read','admin.discounts.manage')),'[]'::jsonb),
  'role_permissions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rp) ORDER BY rp.role_id,rp.permission_id)
    FROM public.role_permissions AS rp),'[]'::jsonb),
  'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r.id,'code',r.code,'permissions_version',r.permissions_version)
    ORDER BY r.id) FROM public.roles AS r),
  'h_permissions',(SELECT pg_catalog.count(*) FROM public.permissions AS p WHERE p.code IN ('admin.discounts.read','admin.discounts.manage')),
  'h_grants',(SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
    WHERE p.code IN ('admin.discounts.read','admin.discounts.manage')));
INSERT INTO public.permissions(code,name) VALUES
  ('admin.discounts.read','Read discounts'),('admin.discounts.manage','Manage discounts') ON CONFLICT(code) DO NOTHING;
INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles AS r CROSS JOIN public.permissions AS p
WHERE r.code='admin' AND p.code IN ('admin.discounts.read','admin.discounts.manage') ON CONFLICT DO NOTHING;
UPDATE public.roles SET permissions_version=permissions_version+1 WHERE code='admin';
-- H1_PERMISSION_SEED_END

-- H1_FINAL_ASSERT_BEGIN
-- Compile independent expected shapes and compare catalog meaning, never ACL text serialization.
DO $h1_final$
DECLARE
  v_failed text;
  v_name text;
  v_actual oid;
  v_expected oid;
  v_a jsonb;
  v_e jsonb;
  v_baseline jsonb;
  v_record record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['discounts','discount_items','discount_codes','discount_assignments',
    'discount_redemptions','order_line_discount_allocations','order_line_unit_amounts']) AS e(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid=pg_catalog.to_regclass('public.' || e.name)
      AND c.relkind='r' AND c.relowner='postgres'::regrole)) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = 'h1_tables';
  END IF;
  IF pg_catalog.to_regclass('public.checkout_drafts') IS NULL THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = 'h1_draft_columns';
  END IF;
  -- Expected FKs stay entirely temporary; PostgreSQL rejects temporary-to-permanent FKs.
  CREATE TEMP TABLE h1_expected_auth_users (id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_items (id bigint PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_orders (id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_order_items (id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_discounts (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    name text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) BETWEEN 1 AND 100),
    kind text NOT NULL CHECK (kind IN ('order_percent','order_amount','product','repeat','set')),
    method text NOT NULL CHECK (method IN ('code','automatic')),
    value_type text NOT NULL CHECK (value_type IN ('percent','amount')),
    value integer NOT NULL,
    target_mode text NOT NULL CHECK (target_mode IN ('all','exclude','include')),
    minimum_type text NOT NULL CHECK (minimum_type IN ('none','amount','quantity')),
    minimum_value integer NOT NULL,
    audience text NOT NULL CHECK (audience IN ('assigned','anyone')),
    allow_guests boolean NOT NULL DEFAULT false,
    first_order_only boolean NOT NULL DEFAULT false,
    once_per_customer boolean NOT NULL DEFAULT false,
    combines_with_product boolean NOT NULL DEFAULT false,
    combines_with_order boolean NOT NULL DEFAULT false,
    advertise boolean NOT NULL DEFAULT false,
    repeat_previous boolean NOT NULL DEFAULT false,
    repeat_in_order boolean NOT NULL DEFAULT false,
    stopped boolean NOT NULL DEFAULT false,
    usage_limit integer CHECK (usage_limit >= 1),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    advertising_text text CHECK (pg_catalog.char_length(pg_catalog.btrim(advertising_text)) BETWEEN 1 AND 200),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    creation_request_key uuid NOT NULL UNIQUE,
    creation_request_hash text NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
    admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(admin_requests) = 'object'),
    search_attention_at timestamptz,
    search_attention_count integer NOT NULL DEFAULT 0 CHECK (search_attention_count >= 0),
    CONSTRAINT discounts_value_check CHECK ((value_type = 'percent' AND value BETWEEN 1 AND 99)
      OR (value_type = 'amount' AND value >= 1 AND minimum_type = 'amount' AND minimum_value > value)),
    CONSTRAINT discounts_minimum_check CHECK ((minimum_type = 'none' AND minimum_value = 0)
      OR (minimum_type IN ('amount','quantity') AND minimum_value >= 1)),
    CONSTRAINT discounts_period_check CHECK (ends_at IS NULL OR starts_at < ends_at),
    CONSTRAINT discounts_assigned_guest_check CHECK (audience <> 'assigned' OR NOT allow_guests),
    CONSTRAINT discounts_automatic_check CHECK (method <> 'automatic' OR (audience = 'anyone' AND allow_guests)),
    CONSTRAINT discounts_advertise_check CHECK (NOT advertise OR method = 'automatic'),
    CONSTRAINT discounts_repeat_check CHECK (kind <> 'repeat' OR repeat_previous OR repeat_in_order),
    CONSTRAINT discounts_kind_value_check CHECK ((kind <> 'order_percent' OR value_type = 'percent')
      AND (kind <> 'order_amount' OR value_type = 'amount')),
    CONSTRAINT discounts_target_check CHECK ((kind IN ('order_percent','order_amount') AND target_mode = 'all')
      OR (kind = 'product' AND target_mode IN ('all','exclude'))
      OR (kind IN ('repeat','set') AND target_mode = 'include'))
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_discount_items (
    discount_id uuid NOT NULL REFERENCES pg_temp.h1_expected_discounts(id) ON DELETE RESTRICT,
    item_id bigint NOT NULL REFERENCES pg_temp.h1_expected_items(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (discount_id,item_id)
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_discount_codes (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    discount_id uuid NOT NULL REFERENCES pg_temp.h1_expected_discounts(id) ON DELETE RESTRICT,
    code text COLLATE "C" NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{1,64}$'),
    audience text NOT NULL CHECK (audience IN ('assigned','anyone')),
    allow_guests boolean NOT NULL DEFAULT false,
    single_use boolean NOT NULL DEFAULT false,
    assigned_user_id uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    batch_id uuid,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    UNIQUE (discount_id,id),
    CONSTRAINT discount_codes_assigned_guest_check CHECK (audience <> 'assigned' OR NOT allow_guests),
    CONSTRAINT discount_codes_assignment_check CHECK (assigned_user_id IS NULL OR (single_use AND audience = 'assigned')),
    CONSTRAINT discount_codes_batch_check CHECK (single_use = (batch_id IS NOT NULL)
      AND (NOT single_use OR code ~ '^.+-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8}$'))
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_discount_assignments (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    discount_id uuid NOT NULL REFERENCES pg_temp.h1_expected_discounts(id) ON DELETE RESTRICT,
    code_id uuid NOT NULL,
    user_id uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    UNIQUE (code_id,user_id),
    FOREIGN KEY (discount_id,code_id) REFERENCES pg_temp.h1_expected_discount_codes(discount_id,id) ON DELETE RESTRICT
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_discount_redemptions (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    discount_id uuid NOT NULL REFERENCES pg_temp.h1_expected_discounts(id) ON DELETE RESTRICT,
    code_id uuid,
    order_id uuid NOT NULL REFERENCES pg_temp.h1_expected_orders(id) ON DELETE RESTRICT,
    user_id uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    identity_key text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(identity_key)) > 0),
    normalized_email text,
    state text NOT NULL CHECK (state IN ('reserved','confirmed','cancelled')),
    reserved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    confirmed_at timestamptz,
    cancelled_at timestamptz,
    name_snapshot text NOT NULL,
    code_snapshot text,
    class_snapshot text NOT NULL CHECK (class_snapshot IN ('product','order')),
    amount integer NOT NULL CHECK (amount >= 0),
    first_order_only_snapshot boolean NOT NULL,
    reconciliation_fallback boolean NOT NULL DEFAULT false,
    attention_kind text CHECK (attention_kind IN ('discount_limit_exceeded','discount_reconciliation_recovered')),
    attention_resolved_at timestamptz,
    attention_resolved_by uuid REFERENCES pg_temp.h1_expected_auth_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    UNIQUE (order_id,discount_id),
    FOREIGN KEY (discount_id,code_id) REFERENCES pg_temp.h1_expected_discount_codes(discount_id,id) ON DELETE RESTRICT
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_order_line_discount_allocations (
    order_id uuid NOT NULL REFERENCES pg_temp.h1_expected_orders(id) ON DELETE RESTRICT,
    order_item_id uuid NOT NULL REFERENCES pg_temp.h1_expected_order_items(id) ON DELETE RESTRICT,
    discount_id uuid NOT NULL REFERENCES pg_temp.h1_expected_discounts(id) ON DELETE RESTRICT,
    amount integer NOT NULL CHECK (amount >= 0),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (order_item_id,discount_id)
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_order_line_unit_amounts (
    order_id uuid NOT NULL REFERENCES pg_temp.h1_expected_orders(id) ON DELETE RESTRICT,
    order_item_id uuid NOT NULL REFERENCES pg_temp.h1_expected_order_items(id) ON DELETE RESTRICT,
    unit_index integer NOT NULL CHECK (unit_index >= 0),
    paid_amount integer NOT NULL CHECK (paid_amount >= 0),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (order_item_id,unit_index)
  ) ON COMMIT DROP;
  CREATE TEMP TABLE h1_expected_checkout_drafts (discount_result jsonb,discount_facts jsonb,discount_engine_version smallint,discount_snapshot_hash text,
  CONSTRAINT checkout_drafts_h_discount_check CHECK (
      (discount_result IS NULL AND discount_facts IS NULL AND discount_engine_version IS NULL AND discount_snapshot_hash IS NULL)
      OR (discount_result IS NOT NULL AND discount_facts IS NOT NULL AND discount_engine_version IS NOT NULL AND discount_snapshot_hash IS NOT NULL
        AND discount_engine_version = 1 AND discount_snapshot_hash ~ '^[0-9a-f]{64}$'
        AND pg_catalog.jsonb_typeof(discount_result) = 'object' AND pg_catalog.jsonb_typeof(discount_facts) = 'object'
        AND discount_result -> 'version' = '1'::jsonb
        AND pg_catalog.jsonb_typeof(discount_result -> 'allocations') = 'array'
        AND pg_catalog.jsonb_typeof(discount_result -> 'unitAmounts') = 'array'
        AND discount_result ?& ARRAY['version','allocations','unitAmounts'])
  )) ON COMMIT DROP;
  FOR v_name IN SELECT pg_catalog.unnest(ARRAY['discounts','discount_items','discount_codes','discount_assignments',
    'discount_redemptions','order_line_discount_allocations','order_line_unit_amounts','checkout_drafts']) LOOP
    v_actual := pg_catalog.to_regclass('public.' || v_name);
    v_expected := pg_catalog.to_regclass('pg_temp.h1_expected_' || v_name);
    IF v_actual IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid=v_actual
      AND c.relkind='r' AND c.relowner='postgres'::regrole) THEN
      v_failed := CASE WHEN v_name='checkout_drafts' THEN 'h1_draft_columns' ELSE 'h1_tables' END; EXIT;
    END IF;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',a.atttypid,'mod',a.atttypmod,
      'null',a.attnotnull,'collation',a.attcollation,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO v_a
      FROM pg_catalog.pg_attribute AS a LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_actual AND a.attnum>0 AND NOT a.attisdropped
        AND (v_name<>'checkout_drafts' OR a.attname IN ('discount_result','discount_facts','discount_engine_version','discount_snapshot_hash'));
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',a.atttypid,'mod',a.atttypmod,
      'null',a.attnotnull,'collation',a.attcollation,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO v_e
      FROM pg_catalog.pg_attribute AS a LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_expected AND a.attnum>0 AND NOT a.attisdropped;
    IF v_a IS DISTINCT FROM v_e THEN
      v_failed := CASE WHEN v_name='checkout_drafts' THEN 'h1_draft_columns' ELSE 'h1_tables' END; EXIT;
    END IF;
    -- attnums on checkout_drafts differ; compare column names, FK destinations/actions and parsed expressions.
    SELECT pg_catalog.jsonb_agg(x.j ORDER BY x.j::text) INTO v_a FROM (
      SELECT pg_catalog.jsonb_build_object('type',c.contype,'keys',(SELECT pg_catalog.array_agg(a.attname ORDER BY k.n)
        FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num,n)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.num),
        'expr',pg_catalog.pg_get_expr(c.conbin,c.conrelid),'ref',(SELECT pg_catalog.jsonb_build_array(
          CASE WHEN rc.relnamespace=pg_catalog.pg_my_temp_schema() THEN
            CASE WHEN rc.relname='h1_expected_auth_users' THEN 'auth' ELSE 'public' END ELSE rn.nspname END,
          CASE WHEN rc.relnamespace=pg_catalog.pg_my_temp_schema() AND rc.relname='h1_expected_auth_users'
            THEN 'users' ELSE pg_catalog.regexp_replace(rc.relname,'^h1_expected_','') END)
          FROM pg_catalog.pg_class AS rc JOIN pg_catalog.pg_namespace AS rn ON rn.oid=rc.relnamespace WHERE rc.oid=c.confrelid),'refkeys',(SELECT pg_catalog.array_agg(a.attname ORDER BY k.n)
          FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num,n)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.confrelid AND a.attnum=k.num),
        'delete',c.confdeltype,'update',c.confupdtype,'match',c.confmatchtype,'defer',c.condeferrable,
        'deferred',c.condeferred,'valid',c.convalidated) AS j FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid=v_actual AND c.contype IN ('c','p','u','f')
        AND (v_name<>'checkout_drafts' OR c.conname='checkout_drafts_h_discount_check')) AS x;
    SELECT pg_catalog.jsonb_agg(x.j ORDER BY x.j::text) INTO v_e FROM (
      SELECT pg_catalog.jsonb_build_object('type',c.contype,'keys',(SELECT pg_catalog.array_agg(a.attname ORDER BY k.n)
        FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num,n)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.num),
        'expr',pg_catalog.pg_get_expr(c.conbin,c.conrelid),'ref',(SELECT pg_catalog.jsonb_build_array(
          CASE WHEN rc.relnamespace=pg_catalog.pg_my_temp_schema() THEN
            CASE WHEN rc.relname='h1_expected_auth_users' THEN 'auth' ELSE 'public' END ELSE rn.nspname END,
          CASE WHEN rc.relnamespace=pg_catalog.pg_my_temp_schema() AND rc.relname='h1_expected_auth_users'
            THEN 'users' ELSE pg_catalog.regexp_replace(rc.relname,'^h1_expected_','') END)
          FROM pg_catalog.pg_class AS rc JOIN pg_catalog.pg_namespace AS rn ON rn.oid=rc.relnamespace WHERE rc.oid=c.confrelid),'refkeys',(SELECT pg_catalog.array_agg(a.attname ORDER BY k.n)
          FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num,n)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.confrelid AND a.attnum=k.num),
        'delete',c.confdeltype,'update',c.confupdtype,'match',c.confmatchtype,'defer',c.condeferrable,
        'deferred',c.condeferred,'valid',c.convalidated) AS j FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid=v_expected AND c.contype IN ('c','p','u','f')) AS x;
    IF v_a IS DISTINCT FROM v_e THEN
      v_failed := CASE WHEN v_name='checkout_drafts' THEN 'h1_draft_columns' ELSE 'h1_constraints' END; EXIT;
    END IF;
    IF v_name<>'checkout_drafts' AND (NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid=v_actual)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon','authenticated','service_role')
        AND (pg_catalog.has_table_privilege(r.oid,v_actual,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,v_actual,'SELECT,INSERT,UPDATE,REFERENCES')))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) AS acl WHERE c.oid=v_actual AND acl.grantee=0)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
        WHERE a.attrelid=v_actual AND acl.grantee=0)) THEN v_failed := 'h1_rls_acl'; EXIT; END IF;
  END LOOP;

  IF v_failed IS NULL AND EXISTS (
    SELECT 1 FROM (VALUES
      ('discount_redemptions','discount_redemptions_discount_state_idx',ARRAY['discount_id','state']),
      ('discount_redemptions','discount_redemptions_identity_discount_state_idx',ARRAY['identity_key','discount_id','state']),
      ('discount_redemptions','discount_redemptions_code_state_idx',ARRAY['code_id','state']),
      ('discount_redemptions','discount_redemptions_order_idx',ARRAY['order_id']),
      ('discounts','discounts_created_by_idx',ARRAY['created_by']),
      ('discounts','discounts_updated_by_idx',ARRAY['updated_by']),
      ('discount_items','discount_items_item_idx',ARRAY['item_id']),
      ('discount_codes','discount_codes_assigned_user_idx',ARRAY['assigned_user_id']),
      ('discount_assignments','discount_assignments_user_idx',ARRAY['user_id']),
      ('discount_assignments','discount_assignments_discount_idx',ARRAY['discount_id']),
      ('discount_redemptions','discount_redemptions_user_idx',ARRAY['user_id']),
      ('discount_redemptions','discount_redemptions_attention_resolver_idx',ARRAY['attention_resolved_by']),
      ('order_line_discount_allocations','order_line_discount_allocations_order_idx',ARRAY['order_id']),
      ('order_line_discount_allocations','order_line_discount_allocations_discount_idx',ARRAY['discount_id']),
      ('order_line_unit_amounts','order_line_unit_amounts_order_idx',ARRAY['order_id'])
    ) AS e(table_name,name,columns) WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid=i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid=c.relam
      WHERE i.indexrelid=pg_catalog.to_regclass('public.' || e.name) AND i.indrelid=pg_catalog.to_regclass('public.' || e.table_name)
        AND i.indisvalid AND i.indisready AND NOT i.indisunique AND am.amname='btree'
        AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts AND i.indnkeyatts=pg_catalog.cardinality(e.columns)
        AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY k.n) FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(num,n)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid=i.indrelid AND a.attnum=k.num)=e.columns
    )) THEN v_failed := 'h1_constraints'; END IF;

  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('h1_assignments_preserve','discount_assignments','group_h_preserve_assignment',19,false,ARRAY[]::text[],false),
    ('h1_codes_preserve','discount_codes','group_h_preserve_assignment',19,false,ARRAY[]::text[],false),
    ('h1_items_relation','discount_items','group_h_validate_relation',23,false,ARRAY['discount_id','item_id']::text[],false),
    ('h1_codes_relation','discount_codes','group_h_validate_relation',23,false,ARRAY['audience','discount_id','single_use']::text[],false),
    ('h1_allocations_relation','order_line_discount_allocations','group_h_validate_relation',7,false,ARRAY[]::text[],false),
    ('h1_units_relation','order_line_unit_amounts','group_h_validate_relation',7,false,ARRAY[]::text[],false),
    ('h1_allocations_immutable','order_line_discount_allocations','group_h_immutable',27,false,ARRAY[]::text[],false),
    ('h1_units_immutable','order_line_unit_amounts','group_h_immutable',27,false,ARRAY[]::text[],false),
    ('h1_allocations_truncate','order_line_discount_allocations','group_h_immutable',34,false,ARRAY[]::text[],false),
    ('h1_units_truncate','order_line_unit_amounts','group_h_immutable',34,false,ARRAY[]::text[],false),
    ('h1_allocations_sum','order_line_discount_allocations','group_h_validate_line',5,true,ARRAY[]::text[],false),
    ('h1_units_sum','order_line_unit_amounts','group_h_validate_line',5,true,ARRAY[]::text[],false),
    ('h1_order_items_sum','order_items','group_h_validate_line',17,true,ARRAY['line_kind','line_total','order_id','quantity']::text[],true),
    ('h1_discounts_definition','discounts','group_h_validate_definition',21,true,ARRAY['combines_with_product','ends_at','id','kind','method','starts_at','stopped','target_mode']::text[],false),
    ('h1_items_definition','discount_items','group_h_validate_definition',29,true,ARRAY['discount_id','item_id']::text[],false),
    ('h1_codes_definition','discount_codes','group_h_validate_definition',29,true,ARRAY['audience','batch_id','discount_id','id','single_use']::text[],false),
    ('h1_assignments_definition','discount_assignments','group_h_validate_definition',29,true,ARRAY['code_id','discount_id']::text[],false)
    ) AS e(name,table_name,function_name,type,deferred,columns,has_when) WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid=pg_catalog.to_regclass('public.' || e.table_name)
        AND t.tgname=e.name AND t.tgfoid=pg_catalog.to_regprocedure('private.' || e.function_name || '()')
        AND t.tgtype=e.type AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0
        AND COALESCE((SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
          FROM pg_catalog.unnest(t.tgattr) AS k(num) JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid=t.tgrelid AND a.attnum=k.num),ARRAY[]::text[])=e.columns
        AND ((NOT e.has_when AND t.tgqual IS NULL) OR (e.has_when AND t.tgqual IS NOT NULL
          AND pg_catalog.split_part(pg_catalog.split_part(pg_catalog.replace(pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.pg_get_triggerdef(t.oid,true)),'[[:space:]()]','','g'),'private.',''),'when',2),'execute',1)
            = 'group_h_order_has_unitsold.order_idorgroup_h_order_has_unitsnew.order_id'
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS d WHERE d.classid='pg_catalog.pg_trigger'::regclass AND d.objid=t.oid
            AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=pg_catalog.to_regprocedure('private.group_h_order_has_units(uuid)'))))
        AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred)) THEN v_failed := 'h1_immutable'; END IF;

  IF v_failed IS NULL THEN
    FOR v_record IN SELECT * FROM (VALUES
      ('private.group_h_immutable()','trigger','v',false,'7d1e2953a87b01b2067b3c2784967f7f'),
      ('private.group_h_validate_line()','trigger','v',false,'9638a70ed3a11f3761f1b363aa121aaf'),
      ('private.group_h_validate_definition()','trigger','v',false,'b403bd14f6988e868c7e592e433d7bd7'),
      ('private.group_h_validate_relation()','trigger','v',false,'acf19812f064ff9b3797bb9ff0fdbe84'),
      ('private.group_h_preserve_assignment()','trigger','v',false,'aaf72d9e69ea09ad3c716db8ed6f6607'),
      ('private.group_h_order_has_units(uuid)','boolean','s',false,'328d47e3716a5dbdb4ba1eb6af2e941a'),
      ('private.order_line_discounts(uuid)','record','s',false,'cc4ce385173ab4e94c9c384e97b11d21'),
      ('private.admin_get_permissions(uuid)','jsonb','v',true,'e74dab48011008b34e1c42f06f75efcf'),
      ('private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)','jsonb','v',true,'8dd855720e3442134a80e240e8474185')
    ) AS e(signature,result_type,volatility,service,body_md5) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid=p.prolang
        WHERE p.oid=pg_catalog.to_regprocedure(v_record.signature) AND p.proowner='postgres'::regrole AND p.prosecdef=(v_record.result_type<>'record')
          AND p.prorettype=pg_catalog.to_regtype(v_record.result_type) AND p.provolatile=v_record.volatility::"char"
          AND p.proconfig=ARRAY['search_path=""'] AND p.prokind='f' AND NOT p.proleakproof
          AND NOT p.proisstrict AND p.proparallel='u' AND p.pronargdefaults=0
          AND l.lanname=CASE WHEN v_record.result_type IN ('record','boolean') THEN 'sql' ELSE 'plpgsql' END
          AND p.proretset=(v_record.result_type='record') AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))=v_record.body_md5
          AND (v_record.result_type<>'record' OR (p.proallargtypes=ARRAY['uuid'::regtype::oid,'uuid'::regtype::oid,'integer'::regtype::oid]
            AND p.proargmodes=ARRAY['i','t','t']::"char"[] AND p.proargnames=ARRAY['_order_id','order_item_id','line_discount']))
          AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
          AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')=v_record.service
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
          WHERE n.nspname='private' AND p.proname=pg_catalog.split_part(pg_catalog.split_part(v_record.signature,'.',2),'(',1))<>1
        OR (NOT v_record.service AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=pg_catalog.split_part(pg_catalog.split_part(v_record.signature,'.',2),'(',1))) THEN
        v_failed := CASE WHEN v_record.result_type='record' THEN 'h1_line_reader'
          WHEN v_record.service THEN 'h1_permission_catalogs' ELSE 'h1_immutable' END; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- Public G0 wrappers remain invokers with their exact delegation and service-only execution.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('public.admin_get_permissions(uuid)',' SELECT private.admin_get_permissions(_actor_id); '),
    ('public.admin_set_role_permissions(uuid,text,text[],bigint,uuid)',
      ' SELECT private.admin_set_role_permissions(_actor_id, _role_code, _permission_codes, _expected_version, _request_key); ')
  ) AS e(signature,body) WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid=p.prolang
    WHERE p.oid=pg_catalog.to_regprocedure(e.signature) AND NOT p.prosecdef AND p.proowner='postgres'::regrole
      AND l.lanname='sql' AND p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.proconfig=ARRAY['search_path=""']
      AND p.prokind='f' AND p.provolatile='v' AND NOT p.proleakproof AND NOT p.proisstrict AND p.pronargdefaults=0
      AND pg_catalog.regexp_replace(p.prosrc,'[[:space:]]+',' ','g')=e.body
      AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=pg_catalog.split_part(pg_catalog.split_part(e.signature,'.',2),'(',1))<>1
  ) THEN v_failed := 'h1_permission_catalogs'; END IF;

  IF v_failed IS NULL THEN
    IF pg_catalog.to_regclass('pg_temp.group_h_permission_baseline') IS NULL THEN v_failed := 'h1_permission_seed';
    ELSE
      SELECT b.payload INTO v_baseline FROM pg_temp.group_h_permission_baseline AS b;
      IF (SELECT pg_catalog.count(*) FROM pg_temp.group_h_permission_baseline)<>1
        OR (v_baseline->>'h_permissions')::integer<>0 OR (v_baseline->>'h_grants')::integer<>0
        OR (SELECT pg_catalog.count(*) FROM public.permissions AS p WHERE (p.code,p.name) IN
          (('admin.discounts.read','Read discounts'),('admin.discounts.manage','Manage discounts')))<>2
        OR (SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
          WHERE p.code IN ('admin.discounts.read','admin.discounts.manage'))<>2
        OR (SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
          JOIN public.roles AS r ON r.id=rp.role_id WHERE r.code='admin' AND p.code IN ('admin.discounts.read','admin.discounts.manage'))<>2
        OR NOT EXISTS (SELECT 1 FROM public.roles AS r JOIN pg_catalog.jsonb_to_recordset(v_baseline->'roles') AS b(id bigint,code text,permissions_version bigint)
          ON b.id=r.id AND b.code=r.code WHERE r.code='admin' AND r.permissions_version=b.permissions_version+1) THEN
        v_failed := 'h1_permission_seed';
      END IF;
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id),'[]'::jsonb) INTO v_a
        FROM public.permissions AS p WHERE p.code NOT IN ('admin.discounts.read','admin.discounts.manage');
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rp) ORDER BY rp.role_id,rp.permission_id),'[]'::jsonb) INTO v_e
        FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
        WHERE p.code NOT IN ('admin.discounts.read','admin.discounts.manage');
      IF v_failed IS NULL AND (v_a IS DISTINCT FROM v_baseline->'permissions' OR v_e IS DISTINCT FROM v_baseline->'role_permissions'
        OR (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r.id,'code',r.code,'permissions_version',
          r.permissions_version-CASE WHEN r.code='admin' THEN 1 ELSE 0 END) ORDER BY r.id) FROM public.roles AS r)
          IS DISTINCT FROM v_baseline->'roles') THEN v_failed := 'h1_existing_dml_allowlist'; END IF;
    END IF;
  END IF;
  DROP TABLE pg_temp.h1_expected_checkout_drafts;
  DROP TABLE pg_temp.h1_expected_order_line_unit_amounts;
  DROP TABLE pg_temp.h1_expected_order_line_discount_allocations;
  DROP TABLE pg_temp.h1_expected_discount_redemptions;
  DROP TABLE pg_temp.h1_expected_discount_assignments;
  DROP TABLE pg_temp.h1_expected_discount_codes;
  DROP TABLE pg_temp.h1_expected_discount_items;
  DROP TABLE pg_temp.h1_expected_discounts;
  DROP TABLE pg_temp.h1_expected_order_items;
  DROP TABLE pg_temp.h1_expected_orders;
  DROP TABLE pg_temp.h1_expected_items;
  DROP TABLE pg_temp.h1_expected_auth_users;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'GROUP_H_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = COALESCE(v_failed,'h1_constraints');
END;
$h1_final$;
-- H1_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
