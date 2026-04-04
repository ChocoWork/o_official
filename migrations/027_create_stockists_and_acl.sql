-- ============================================================
-- 027: Create stockists table and ACL/RLS policies
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.stockists (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('FLAGSHIP STORE', 'STORE', 'SELECT SHOP')),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  time TEXT NOT NULL,
  holiday TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'private' CHECK (status IN ('private', 'published')),
  is_featured_home BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stockists_status ON public.stockists(status);
CREATE INDEX IF NOT EXISTS idx_stockists_display_order ON public.stockists(display_order, id);
CREATE INDEX IF NOT EXISTS idx_stockists_featured_home ON public.stockists(is_featured_home);

CREATE OR REPLACE FUNCTION public.update_stockists_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_stockists_updated_at ON public.stockists;

CREATE TRIGGER trigger_stockists_updated_at
  BEFORE UPDATE ON public.stockists
  FOR EACH ROW EXECUTE FUNCTION public.update_stockists_updated_at();

INSERT INTO public.permissions(code, name)
VALUES
  ('admin.stockists.read', 'Read admin stockists'),
  ('admin.stockists.manage', 'Manage admin stockists')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.stockists.read', 'admin.stockists.manage')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

ALTER TABLE public.stockists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public stockists read published" ON public.stockists;
CREATE POLICY "public stockists read published"
  ON public.stockists
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

DROP POLICY IF EXISTS "admin stockists read by permission" ON public.stockists;
CREATE POLICY "admin stockists read by permission"
  ON public.stockists
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.stockists.read'));

DROP POLICY IF EXISTS "admin stockists manage by permission" ON public.stockists;
CREATE POLICY "admin stockists manage by permission"
  ON public.stockists
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.stockists.manage'))
  WITH CHECK (public.has_permission('admin.stockists.manage'));

COMMIT;
