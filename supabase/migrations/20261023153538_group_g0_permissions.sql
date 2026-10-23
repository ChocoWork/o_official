-- G-0: reconcile the initial matrix once, then edit through audited private functions.
BEGIN;

-- BEGIN G0_PERMISSION_SEED_RECONCILE
INSERT INTO public.roles (code, name)
VALUES ('admin', '店長'), ('supporter', 'サポーター'), ('user', '一般利用者')
ON CONFLICT (code) DO NOTHING;

WITH catalog(code, name) AS (VALUES
  ('admin.users.read', '利用者の閲覧'),
  ('admin.users.manage', '利用者の管理'),
  ('admin.items.read', '商品の閲覧'),
  ('admin.items.manage', '商品の管理'),
  ('admin.news.read', 'お知らせの閲覧'),
  ('admin.news.manage', 'お知らせの管理'),
  ('admin.looks.read', 'LOOKの閲覧'),
  ('admin.looks.manage', 'LOOKの管理'),
  ('admin.stockists.read', '取扱店の閲覧'),
  ('admin.stockists.manage', '取扱店の管理'),
  ('admin.orders.read', '注文一覧・詳細・CSV・履歴・要対応の閲覧'),
  ('admin.orders.manage', '未入金取消・取消申請審査・要確認解消・メール再送'),
  ('admin.contact.read', '問い合わせの閲覧'),
  ('admin.contact.manage', '問い合わせの管理'),
  ('admin.finance.read', '会計の閲覧'),
  ('admin.finance.manage', '会計の管理'),
  ('admin.audit.read', '監査の閲覧'),
  ('admin.orders.refund', '返金・返金再試行・金額決定'),
  ('admin.settings.manage', 'ショップ設定'),
  ('admin.orders.return', '返品作成・審査・受取・検品・取消・開き直し・金額相談'),
  ('admin.stock.read', '在庫一覧'),
  ('admin.stock.manage', '入荷・棚卸・割当強制解除'),
  ('admin.orders.allocate', '割り当てを入れ替える'),
  ('admin.purchase_orders.read', '発注一覧・発注書・取引添付の閲覧/取得'),
  ('admin.purchase_orders.manage', '発注入力/確認/確定・数量/単価訂正・添付追加・打切り/再確定'),
  ('admin.receiving.manage', '全部/一部受取・受取取消/訂正'),
  ('admin.shipping.read', '荷作り・発送票閲覧'),
  ('admin.shipping.manage', '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消'),
  ('admin.shipping.correct_date', '確定後の出荷日訂正'),
  ('admin.permissions.manage', '権限設定の閲覧・保存')
)
INSERT INTO public.permissions (code, name)
SELECT code, name FROM catalog
ON CONFLICT (code) DO NOTHING;

-- Restrict reconciliation to these three roles and these thirty permission codes.
WITH catalog(code, supporter) AS (VALUES
  ('admin.users.read', true), ('admin.users.manage', false),
  ('admin.items.read', false), ('admin.items.manage', false),
  ('admin.news.read', false), ('admin.news.manage', false),
  ('admin.looks.read', false), ('admin.looks.manage', false),
  ('admin.stockists.read', false), ('admin.stockists.manage', false),
  ('admin.orders.read', true), ('admin.orders.manage', true),
  ('admin.contact.read', true), ('admin.contact.manage', true),
  ('admin.finance.read', false), ('admin.finance.manage', false),
  ('admin.audit.read', false), ('admin.orders.refund', false),
  ('admin.settings.manage', false), ('admin.orders.return', true),
  ('admin.stock.read', false), ('admin.stock.manage', false),
  ('admin.orders.allocate', false), ('admin.purchase_orders.read', false),
  ('admin.purchase_orders.manage', false), ('admin.receiving.manage', false),
  ('admin.shipping.read', true), ('admin.shipping.manage', true),
  ('admin.shipping.correct_date', false), ('admin.permissions.manage', false)
), removed AS (
  DELETE FROM public.role_permissions rp
  USING public.roles r, public.permissions p, catalog c
  WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.code = c.code
    AND r.code IN ('admin', 'supporter', 'user')
    AND NOT (r.code = 'admin' OR (r.code = 'supporter' AND c.supporter))
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r
CROSS JOIN catalog c JOIN public.permissions p ON p.code = c.code
WHERE r.code = 'admin' OR (r.code = 'supporter' AND c.supporter)
ON CONFLICT DO NOTHING;
-- END G0_PERMISSION_SEED_RECONCILE

ALTER TABLE public.roles ADD COLUMN permissions_version bigint NOT NULL DEFAULT 0
  CHECK (permissions_version >= 0);

CREATE TABLE public.role_permission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('admin', 'supporter')),
  permission_code text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_key uuid NOT NULL,
  UNIQUE (request_key, role, permission_code)
);
ALTER TABLE public.role_permission_events OWNER TO postgres;
CREATE INDEX role_permission_events_role_created_id_idx
  ON public.role_permission_events (role, created_at, id);

CREATE TABLE private.role_permission_requests (
  request_key uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'supporter')),
  permission_codes text[] NOT NULL,
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.role_permission_requests OWNER TO postgres;

CREATE FUNCTION private.reject_role_permission_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_IMMUTABLE', ERRCODE = '55000';
END;
$$;
ALTER FUNCTION private.reject_role_permission_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reject_role_permission_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER role_permission_events_no_update BEFORE UPDATE ON public.role_permission_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_role_permission_mutation();
CREATE TRIGGER role_permission_events_no_delete BEFORE DELETE ON public.role_permission_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_role_permission_mutation();
CREATE TRIGGER role_permission_events_no_truncate BEFORE TRUNCATE ON public.role_permission_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_role_permission_mutation();
CREATE TRIGGER role_permission_requests_no_update BEFORE UPDATE ON private.role_permission_requests
  FOR EACH ROW EXECUTE FUNCTION private.reject_role_permission_mutation();
CREATE TRIGGER role_permission_requests_no_delete BEFORE DELETE ON private.role_permission_requests
  FOR EACH ROW EXECUTE FUNCTION private.reject_role_permission_mutation();
CREATE TRIGGER role_permission_requests_no_truncate BEFORE TRUNCATE ON private.role_permission_requests
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_role_permission_mutation();

ALTER TABLE public.role_permission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.role_permission_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permission_events_deny_all ON public.role_permission_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY role_permission_requests_deny_all ON private.role_permission_requests
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.role_permission_events, private.role_permission_requests
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.role_permission_events, private.role_permission_requests TO service_role;

DROP POLICY IF EXISTS "acl permissions readable" ON public.permissions;
DROP POLICY IF EXISTS "acl role_permissions readable" ON public.role_permissions;
DROP POLICY IF EXISTS "acl roles readable" ON public.roles;
REVOKE ALL ON TABLE public.roles, public.permissions, public.role_permissions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.roles, public.permissions, public.role_permissions TO service_role;
REVOKE ALL ON SEQUENCE public.roles_id_seq, public.permissions_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON TABLE public.user_roles FROM anon, authenticated;
GRANT SELECT ON TABLE public.user_roles TO authenticated;
DROP POLICY IF EXISTS "acl user_roles managed insert" ON public.user_roles;
DROP POLICY IF EXISTS "acl user_roles managed update" ON public.user_roles;
DROP POLICY IF EXISTS "acl user_roles managed delete" ON public.user_roles;

CREATE FUNCTION private.guard_fixed_role_permissions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  old_fixed boolean;
  new_fixed boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT r.code = 'admin' AND p.code IN ('admin.users.manage', 'admin.permissions.manage')
      INTO old_fixed FROM public.roles r CROSS JOIN public.permissions p
      WHERE r.id = OLD.role_id AND p.id = OLD.permission_id;
    IF old_fixed AND (TG_OP = 'DELETE' OR NEW.role_id IS DISTINCT FROM OLD.role_id
      OR NEW.permission_id IS DISTINCT FROM OLD.permission_id) THEN
      RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FIXED', ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT r.code <> 'admin' AND p.code IN ('admin.users.manage', 'admin.permissions.manage')
      INTO new_fixed FROM public.roles r CROSS JOIN public.permissions p
      WHERE r.id = NEW.role_id AND p.id = NEW.permission_id;
    IF new_fixed THEN
      RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FIXED', ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION private.guard_fixed_role_permissions() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_fixed_role_permissions() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER role_permissions_fixed_guard BEFORE INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION private.guard_fixed_role_permissions();

-- Last body: 20260901102912; settings/ACL: 20260921011535. Remove only role shortcuts.
CREATE OR REPLACE FUNCTION public.has_permission (
  permission_code text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
  AS $function$
DECLARE
  uid uuid;
  acl_allowed boolean;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = uid
      AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND p.code = permission_code
  ) INTO acl_allowed;

  RETURN COALESCE(acl_allowed, false);
END;
$function$;
-- CREATE OR REPLACE preserves owner and EXECUTE grants (anon remains revoked).

CREATE FUNCTION private.admin_get_permissions(_actor_id uuid) RETURNS jsonb
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
    'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage'
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

CREATE FUNCTION private.admin_set_role_permissions(
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
    'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage'
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

CREATE FUNCTION private.admin_set_user_role(_actor_id uuid, _user_id uuid, _role_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  metadata jsonb;
  previous_role text;
  target_role_id bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190519, 0);
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = _actor_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND r.code = 'admin' AND p.code = 'admin.users.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  IF _user_id IS NULL OR _role_code IS NULL OR _role_code NOT IN ('admin', 'supporter', 'user') THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  SELECT r.id INTO target_role_id FROM public.roles r WHERE r.code = _role_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  SELECT u.raw_app_meta_data INTO metadata FROM auth.users u WHERE u.id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  -- Match the existing PATCH audit contract; metadata is never used for authorization.
  previous_role := CASE WHEN pg_catalog.jsonb_typeof(metadata -> 'role') = 'string'
    THEN metadata ->> 'role' ELSE 'unknown' END;
  IF _role_code <> 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    WHERE r.code = 'admin' AND ur.user_id <> _user_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'LAST_ADMIN_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF _actor_id = _user_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_ROLE_CHANGE_FORBIDDEN', ERRCODE = '42501';
  END IF;
  UPDATE public.user_roles SET active = false WHERE user_id = _user_id;
  INSERT INTO public.user_roles (user_id, role_id, active, expires_at, assigned_by, assigned_at)
    VALUES (_user_id, target_role_id, true, NULL, _actor_id, now())
    ON CONFLICT (user_id, role_id) DO UPDATE SET active = true, expires_at = NULL,
      assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at;
  UPDATE auth.users SET raw_app_meta_data = pg_catalog.jsonb_set(
    COALESCE(metadata, '{}'::jsonb), '{role}', pg_catalog.to_jsonb(_role_code)), updated_at = now()
    WHERE id = _user_id;
  RETURN pg_catalog.jsonb_build_object('previousRole', previous_role, 'role', _role_code);
END;
$$;

CREATE FUNCTION public.admin_get_permissions(_actor_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_get_permissions(_actor_id); $$;
CREATE FUNCTION public.admin_set_role_permissions(
  _actor_id uuid, _role_code text, _permission_codes text[], _expected_version bigint, _request_key uuid
) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_role_permissions(_actor_id, _role_code, _permission_codes, _expected_version, _request_key); $$;
CREATE FUNCTION public.admin_set_user_role(_actor_id uuid, _user_id uuid, _role_code text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_user_role(_actor_id, _user_id, _role_code); $$;

ALTER FUNCTION private.admin_get_permissions(uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_get_permissions(uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_role_permissions(uuid, text, text[], bigint, uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_set_role_permissions(uuid, text, text[], bigint, uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_user_role(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.admin_set_user_role(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_get_permissions(uuid), public.admin_get_permissions(uuid),
  private.admin_set_role_permissions(uuid, text, text[], bigint, uuid),
  public.admin_set_role_permissions(uuid, text, text[], bigint, uuid),
  private.admin_set_user_role(uuid, uuid, text), public.admin_set_user_role(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.admin_get_permissions(uuid), public.admin_get_permissions(uuid),
  private.admin_set_role_permissions(uuid, text, text[], bigint, uuid),
  public.admin_set_role_permissions(uuid, text, text[], bigint, uuid),
  private.admin_set_user_role(uuid, uuid, text), public.admin_set_user_role(uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
