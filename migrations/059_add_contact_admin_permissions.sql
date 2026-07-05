-- 059_add_contact_admin_permissions.sql
-- Add contact management permissions and grant them to admin (all) and
-- supporter (customer-facing role). Follows the seed pattern of 023.

-- 1) Seed permissions
INSERT INTO public.permissions(code, name)
VALUES
  ('admin.contact.read', 'Read contact inquiries'),
  ('admin.contact.manage', 'Manage contact inquiries')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- 2) admin: grant both contact permissions
INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.contact.read', 'admin.contact.manage')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- 3) supporter: grant both contact permissions (handles customer replies)
INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.contact.read', 'admin.contact.manage')
WHERE r.code = 'supporter'
ON CONFLICT DO NOTHING;
