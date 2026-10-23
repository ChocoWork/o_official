-- 波1 Task 3（K-3）: 監査ログの閲覧権限を登録し、店長に付ける。
-- ほかの役割に既にある付与は消さない。適用前の確認は Task 11 で行う。
BEGIN;

INSERT INTO public.permissions (code, name)
VALUES ('admin.audit.read', '監査ログの閲覧')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles AS r
JOIN public.permissions AS p ON p.code IN ('admin.audit.read')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
