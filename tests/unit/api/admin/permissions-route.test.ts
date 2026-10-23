/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

import { GET } from '@/app/api/admin/permissions/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';

const rpc = jest.fn();
const request = () => new Request('https://example.test/api/admin/permissions');
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: { permissionCodes: ROLE_PERMISSION_CATALOG.map((p) => p.code).sort(), roles: [
    { code: 'admin', version: '9007199254740993', permissionCodes: [] },
    { code: 'supporter', version: '0', permissionCodes: ['admin.orders.read'] },
  ] }, error: null });
});
afterEach(() => jest.restoreAllMocks());

test('200は表示定義を付け、DBに無い固定権限を追加せず、CSRF不要・監査なし', async () => {
  const req = request();
  const response = await GET(req);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ data: { permissions: ROLE_PERMISSION_CATALOG, roles: [
    { code: 'admin', label: '店長', version: '9007199254740993', permissionCodes: [] },
    { code: 'supporter', label: 'サポーター', version: '0', permissionCodes: ['admin.orders.read'] },
  ] } });
  expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.permissions.manage', req);
  expect(rpc).toHaveBeenCalledWith('admin_get_permissions', { _actor_id: 'authorized-actor' });
  expect(requireCsrfOrDeny).not.toHaveBeenCalled();
  expect(enforceRateLimit).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test.each([
  [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden' }],
  [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
])('認可拒否%sを保持してno-storeにし、RPC・監査0回', async (status, body) => {
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
  const response = await GET(request());
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('retry-after')).toBe('30');
  expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
});

test('DBの正確な認可拒否を403へ変換する', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'ROLE_PERMISSION_FORBIDDEN', code: '42501' } });
  const response = await GET(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: '権限を変更する権限がありません。', code: 'ROLE_PERMISSION_FORBIDDEN' });
  expect(logAudit).not.toHaveBeenCalled();
});

test.each(['rpc', 'malformed', 'client'] as const)('内部失敗%sは固定500・固定ログだけで生情報を漏らさない', async (source) => {
  if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE', code: '42501', details: 'PRIVATE', hint: 'PRIVATE' } });
  if (source === 'malformed') rpc.mockResolvedValue({ data: { permissionCodes: ['PRIVATE'], roles: [] }, error: null });
  if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE'));
  const response = await GET(request());
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: '権限を読み込めませんでした。', code: 'PERMISSION_LOAD_FAILED' });
  expect(console.error).toHaveBeenCalledWith('[admin.permissions] operation failed');
  expect(logAudit).not.toHaveBeenCalled();
});
