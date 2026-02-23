-- migrations/023_add_acl_rbac_tables_and_policies.sql
-- Hybrid RBAC foundation (token role + DB ACL) with RLS helper functions

BEGIN;

-- 1) ACL master tables
CREATE TABLE IF NOT EXISTS public.roles (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.permissions (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id bigint NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id bigint NOT NULL REFERENCES public.roles(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  assigned_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id_active ON public.user_roles(user_id, active);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON public.user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON public.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON public.role_permissions(permission_id);

-- 2) Seed roles
INSERT INTO public.roles(code, name)
VALUES
  ('admin', 'Administrator'),
  ('supporter', 'Supporter'),
  ('user', 'User')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- 3) Seed permissions
INSERT INTO public.permissions(code, name)
VALUES
  ('admin.users.read', 'Read admin users'),
  ('admin.users.manage', 'Manage admin users'),
  ('admin.items.read', 'Read admin items'),
  ('admin.items.manage', 'Manage admin items'),
  ('admin.news.read', 'Read admin news'),
  ('admin.news.manage', 'Manage admin news'),
  ('admin.looks.read', 'Read admin looks'),
  ('admin.looks.manage', 'Manage admin looks'),
  ('admin.orders.read', 'Read admin orders'),
  ('admin.orders.manage', 'Manage admin orders')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- 4) Role-permission mapping
-- admin: all permissions
INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON TRUE
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- supporter: order read/manage + users read
INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.orders.read', 'admin.orders.manage', 'admin.users.read')
WHERE r.code = 'supporter'
ON CONFLICT DO NOTHING;

-- user: no admin permissions

-- 5) Backfill user_roles from auth.users raw_app_meta_data->>role
INSERT INTO public.user_roles(user_id, role_id, active)
SELECT
  u.id,
  r.id,
  TRUE
FROM auth.users u
JOIN public.roles r
  ON r.code = COALESCE(NULLIF(u.raw_app_meta_data->>'role', ''), 'user')
ON CONFLICT (user_id, role_id)
DO UPDATE SET active = EXCLUDED.active;

-- 6) Permission helper functions
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), 'user');
$$;

CREATE OR REPLACE FUNCTION public.has_permission(permission_code text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid;
  role_code text;
  acl_allowed boolean;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RETURN false;
  END IF;

  role_code := public.current_app_role();

  -- Token-role fallback (legacy fast path)
  IF role_code = 'admin' THEN
    RETURN true;
  END IF;

  IF role_code = 'supporter' AND permission_code IN ('admin.orders.read', 'admin.orders.manage', 'admin.users.read') THEN
    RETURN true;
  END IF;

  -- DB ACL authoritative path
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
$$;

REVOKE ALL ON FUNCTION public.has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated, service_role;

-- 7) Enable RLS on ACL tables
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acl roles readable" ON public.roles;
CREATE POLICY "acl roles readable"
  ON public.roles
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.users.read'));

DROP POLICY IF EXISTS "acl permissions readable" ON public.permissions;
CREATE POLICY "acl permissions readable"
  ON public.permissions
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.users.read'));

DROP POLICY IF EXISTS "acl role_permissions readable" ON public.role_permissions;
CREATE POLICY "acl role_permissions readable"
  ON public.role_permissions
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.users.read'));

DROP POLICY IF EXISTS "acl user_roles readable" ON public.user_roles;
CREATE POLICY "acl user_roles readable"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.users.read'));

DROP POLICY IF EXISTS "acl user_roles managed" ON public.user_roles;
CREATE POLICY "acl user_roles managed"
  ON public.user_roles
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.users.manage'))
  WITH CHECK (public.has_permission('admin.users.manage'));

-- 8) Business table RLS policies (defense-in-depth)
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.looks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.look_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_color_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin items read by permission" ON public.items;
CREATE POLICY "admin items read by permission"
  ON public.items
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.items.read'));

DROP POLICY IF EXISTS "admin items manage by permission" ON public.items;
CREATE POLICY "admin items manage by permission"
  ON public.items
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.items.manage'))
  WITH CHECK (public.has_permission('admin.items.manage'));

DROP POLICY IF EXISTS "admin news read by permission" ON public.news_articles;
CREATE POLICY "admin news read by permission"
  ON public.news_articles
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.news.read'));

DROP POLICY IF EXISTS "admin news manage by permission" ON public.news_articles;
CREATE POLICY "admin news manage by permission"
  ON public.news_articles
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.news.manage'))
  WITH CHECK (public.has_permission('admin.news.manage'));

DROP POLICY IF EXISTS "admin looks read by permission" ON public.looks;
CREATE POLICY "admin looks read by permission"
  ON public.looks
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.looks.read'));

DROP POLICY IF EXISTS "admin looks manage by permission" ON public.looks;
CREATE POLICY "admin looks manage by permission"
  ON public.looks
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.looks.manage'))
  WITH CHECK (public.has_permission('admin.looks.manage'));

DROP POLICY IF EXISTS "admin look_items read by permission" ON public.look_items;
CREATE POLICY "admin look_items read by permission"
  ON public.look_items
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.looks.read'));

DROP POLICY IF EXISTS "admin look_items manage by permission" ON public.look_items;
CREATE POLICY "admin look_items manage by permission"
  ON public.look_items
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.looks.manage'))
  WITH CHECK (public.has_permission('admin.looks.manage'));

DROP POLICY IF EXISTS "admin item_color_presets read by permission" ON public.item_color_presets;
CREATE POLICY "admin item_color_presets read by permission"
  ON public.item_color_presets
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.items.read'));

DROP POLICY IF EXISTS "admin item_color_presets manage by permission" ON public.item_color_presets;
CREATE POLICY "admin item_color_presets manage by permission"
  ON public.item_color_presets
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.items.manage'))
  WITH CHECK (public.has_permission('admin.items.manage'));

COMMIT;
