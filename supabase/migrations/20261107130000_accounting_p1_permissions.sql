BEGIN;
-- Accounting plan 1 S0: add six accounting permissions (32 -> 38), granted to the owner role (admin) only.

-- ACC_S0_BODY_BEGIN
-- Same bodies as H1 (20261029130000); only both catalogs gain the six accounting codes.
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
    'admin.discounts.read', 'admin.discounts.manage', 'admin.accounting.settings.manage',
    'admin.accounting.entries.correct', 'admin.accounting.close.manage', 'admin.accounting.inventory.manage',
    'admin.accounting.export.read', 'admin.accounting.integration.manage'
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
    'admin.discounts.read', 'admin.discounts.manage', 'admin.accounting.settings.manage',
    'admin.accounting.entries.correct', 'admin.accounting.close.manage', 'admin.accounting.inventory.manage',
    'admin.accounting.export.read', 'admin.accounting.integration.manage'
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

ALTER FUNCTION private.admin_get_permissions(uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_role_permissions(uuid,text,text[],bigint,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_get_permissions(uuid), private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.admin_get_permissions(uuid), private.admin_set_role_permissions(uuid,text,text[],bigint,uuid) TO service_role;
-- ACC_S0_BODY_END

-- ACC_S0_PERMISSION_SEED_BEGIN
SELECT pg_catalog.pg_advisory_xact_lock(190519,0);
CREATE TEMP TABLE accounting_permission_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_permission_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'permissions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id) FROM public.permissions AS p
    WHERE p.code NOT IN ('admin.accounting.settings.manage','admin.accounting.entries.correct','admin.accounting.close.manage','admin.accounting.inventory.manage','admin.accounting.export.read','admin.accounting.integration.manage')),'[]'::jsonb),
  'role_permissions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rp) ORDER BY rp.role_id,rp.permission_id)
    FROM public.role_permissions AS rp),'[]'::jsonb),
  'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r.id,'code',r.code,'permissions_version',r.permissions_version)
    ORDER BY r.id) FROM public.roles AS r),
  'acc_permissions',(SELECT pg_catalog.count(*) FROM public.permissions AS p WHERE p.code IN ('admin.accounting.settings.manage','admin.accounting.entries.correct','admin.accounting.close.manage','admin.accounting.inventory.manage','admin.accounting.export.read','admin.accounting.integration.manage')),
  'acc_grants',(SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
    WHERE p.code IN ('admin.accounting.settings.manage','admin.accounting.entries.correct','admin.accounting.close.manage','admin.accounting.inventory.manage','admin.accounting.export.read','admin.accounting.integration.manage')));
INSERT INTO public.permissions(code,name) VALUES
  ('admin.accounting.settings.manage','Manage accounting settings and periods'),
  ('admin.accounting.entries.correct','Correct and reverse journal entries'),
  ('admin.accounting.close.manage','Close and reopen accounting periods'),
  ('admin.accounting.inventory.manage','Confirm stocktaking and cost of goods'),
  ('admin.accounting.export.read','Export books and ledger copies'),
  ('admin.accounting.integration.manage','Manage accounting software integration')
  ON CONFLICT(code) DO NOTHING;
INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles AS r CROSS JOIN public.permissions AS p
WHERE r.code='admin' AND p.code IN ('admin.accounting.settings.manage','admin.accounting.entries.correct','admin.accounting.close.manage','admin.accounting.inventory.manage','admin.accounting.export.read','admin.accounting.integration.manage') ON CONFLICT DO NOTHING;
UPDATE public.roles SET permissions_version=permissions_version+1 WHERE code='admin';
-- ACC_S0_PERMISSION_SEED_END

-- ACC_S0_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (attributes, ACL entries, body fingerprints, row diffs), never ACL text serialization.
DO $acc_s0_final$
DECLARE
  v_failed text;
  v_baseline jsonb;
  v_record record;
  v_a jsonb;
  v_e jsonb;
  v_catalog CONSTANT text[] := ARRAY[
    'admin.accounting.close.manage', 'admin.accounting.entries.correct', 'admin.accounting.export.read', 'admin.accounting.integration.manage',
    'admin.accounting.inventory.manage', 'admin.accounting.settings.manage', 'admin.audit.read', 'admin.contact.manage',
    'admin.contact.read', 'admin.discounts.manage', 'admin.discounts.read', 'admin.finance.manage',
    'admin.finance.read', 'admin.items.manage', 'admin.items.read', 'admin.looks.manage',
    'admin.looks.read', 'admin.news.manage', 'admin.news.read', 'admin.orders.allocate',
    'admin.orders.manage', 'admin.orders.read', 'admin.orders.refund', 'admin.orders.return',
    'admin.permissions.manage', 'admin.purchase_orders.manage', 'admin.purchase_orders.read', 'admin.receiving.manage',
    'admin.settings.manage', 'admin.shipping.correct_date', 'admin.shipping.manage', 'admin.shipping.read',
    'admin.stock.manage', 'admin.stock.read', 'admin.stockists.manage', 'admin.stockists.read',
    'admin.users.manage', 'admin.users.read'
  ];
  v_new CONSTANT text[] := ARRAY['admin.accounting.settings.manage', 'admin.accounting.entries.correct', 'admin.accounting.close.manage', 'admin.accounting.inventory.manage', 'admin.accounting.export.read', 'admin.accounting.integration.manage'];
BEGIN
  -- The permission tables keep RLS on and give anon, authenticated and PUBLIC no table privilege at all.
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['public.roles','public.permissions','public.role_permissions']) AS t(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid=pg_catalog.to_regclass(t.name)
        AND c.relkind='r' AND c.relrowsecurity)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) AS acl
        WHERE c.oid=pg_catalog.to_regclass(t.name)
          AND acl.grantee IN (0,'anon'::regrole::oid,'authenticated'::regrole::oid))) THEN
    v_failed := 'acc_s0_permission_catalogs';
  END IF;

  -- Private bodies: exact attributes, fingerprint, one overload each, service-only execution, the 38-code catalog.
  IF v_failed IS NULL THEN
    FOR v_record IN SELECT * FROM (VALUES
      ('private.admin_get_permissions(uuid)','admin_get_permissions','57b375f57488317d34e9b4b5aa9b8e10'),
      ('private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)','admin_set_role_permissions','340c33e13641a27bbad4080f23931b94')
    ) AS e(signature,name,body_md5) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid=p.prolang
        WHERE p.oid=pg_catalog.to_regprocedure(v_record.signature) AND p.proowner='postgres'::regrole AND p.prosecdef
          AND p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.provolatile='v' AND l.lanname='plpgsql'
          AND p.proconfig=ARRAY['search_path=""'] AND p.prokind='f' AND NOT p.proleakproof AND NOT p.proisstrict
          AND p.proparallel='u' AND p.pronargdefaults=0
          AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))=v_record.body_md5
          AND (SELECT pg_catalog.array_agg(m.code[1] ORDER BY m.code[1] COLLATE "C") FROM pg_catalog.regexp_matches(
            pg_catalog.substring(p.prosrc,'catalog CONSTANT text\[\] := ARRAY\[([^]]*)\]'),'''([a-z_.]+)''','g') AS m(code))=v_catalog
          AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
          WHERE n.nspname='private' AND p.proname=v_record.name)<>1 THEN
        v_failed := 'acc_s0_permission_catalogs'; EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Public G0 wrappers remain invokers with their exact delegation and service-only execution.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('public.admin_get_permissions(uuid)','admin_get_permissions',' SELECT private.admin_get_permissions(_actor_id); '),
    ('public.admin_set_role_permissions(uuid,text,text[],bigint,uuid)','admin_set_role_permissions',
      ' SELECT private.admin_set_role_permissions(_actor_id, _role_code, _permission_codes, _expected_version, _request_key); ')
  ) AS e(signature,name,body) WHERE NOT EXISTS (
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
      WHERE n.nspname='public' AND p.proname=e.name)<>1
  ) THEN v_failed := 'acc_s0_permission_catalogs'; END IF;

  -- Every catalog code is a registered permission: the catalog holds exactly 38 live codes.
  IF v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM public.permissions AS p WHERE p.code=ANY(v_catalog))<>38 THEN
    v_failed := 'acc_s0_permission_catalogs';
  END IF;

  IF v_failed IS NULL THEN
    IF pg_catalog.to_regclass('pg_temp.accounting_permission_baseline') IS NULL THEN v_failed := 'acc_s0_permission_seed';
    ELSE
      SELECT b.payload INTO v_baseline FROM pg_temp.accounting_permission_baseline AS b;
      IF (SELECT pg_catalog.count(*) FROM pg_temp.accounting_permission_baseline)<>1
        OR (v_baseline->>'acc_permissions')::integer<>0 OR (v_baseline->>'acc_grants')::integer<>0
        OR (SELECT pg_catalog.count(*) FROM public.permissions AS p WHERE (p.code,p.name) IN (
          ('admin.accounting.settings.manage','Manage accounting settings and periods'),
          ('admin.accounting.entries.correct','Correct and reverse journal entries'),
          ('admin.accounting.close.manage','Close and reopen accounting periods'),
          ('admin.accounting.inventory.manage','Confirm stocktaking and cost of goods'),
          ('admin.accounting.export.read','Export books and ledger copies'),
          ('admin.accounting.integration.manage','Manage accounting software integration')))<>6
        OR (SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
          WHERE p.code=ANY(v_new))<>6
        OR (SELECT pg_catalog.count(*) FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
          JOIN public.roles AS r ON r.id=rp.role_id WHERE r.code='admin' AND p.code=ANY(v_new))<>6
        OR NOT EXISTS (SELECT 1 FROM public.roles AS r JOIN pg_catalog.jsonb_to_recordset(v_baseline->'roles') AS b(id bigint,code text,permissions_version bigint)
          ON b.id=r.id AND b.code=r.code WHERE r.code='admin' AND r.permissions_version=b.permissions_version+1) THEN
        v_failed := 'acc_s0_permission_seed';
      END IF;
      -- Outside the six new codes, permissions, grants and versions are untouched (admin version only +1).
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id),'[]'::jsonb) INTO v_a
        FROM public.permissions AS p WHERE NOT (p.code=ANY(v_new));
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rp) ORDER BY rp.role_id,rp.permission_id),'[]'::jsonb) INTO v_e
        FROM public.role_permissions AS rp JOIN public.permissions AS p ON p.id=rp.permission_id
        WHERE NOT (p.code=ANY(v_new));
      IF v_failed IS NULL AND (v_a IS DISTINCT FROM v_baseline->'permissions' OR v_e IS DISTINCT FROM v_baseline->'role_permissions'
        OR (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r.id,'code',r.code,'permissions_version',
          r.permissions_version-CASE WHEN r.code='admin' THEN 1 ELSE 0 END) ORDER BY r.id) FROM public.roles AS r)
          IS DISTINCT FROM v_baseline->'roles') THEN v_failed := 'acc_s0_existing_dml_allowlist'; END IF;
    END IF;
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with a fixed DETAIL; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed,'acc_s0_permission_catalogs'), HINT = SQLSTATE;
END;
$acc_s0_final$;
-- ACC_S0_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
