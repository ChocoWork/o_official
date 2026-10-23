/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

import { PATCH } from '@/app/api/admin/users/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TARGET = '10000000-0000-4000-8000-000000000002';
const rpc = jest.fn(); const from = jest.fn();
const getUserById = jest.fn(); const updateUserById = jest.fn();
const request = (body: unknown = { userId: TARGET, role: 'supporter' }) => new Request('https://example.test/api/admin/users', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  jest.resetAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {});
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: ACTOR, role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, from, auth: { admin: { getUserById, updateUserById } } });
  rpc.mockResolvedValue({ data: { previousRole: 'user', role: 'supporter' }, error: null });
  (logAudit as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test.each([undefined, { rotatedCsrfToken: 'legacy' }])('CSRF成功%jの別人変更はRPC1回で200、Auth Admin更新・直接ACL書込み0回', async (csrf) => {
  (requireCsrfOrDeny as jest.Mock).mockResolvedValue(csrf);
  const req = request(); const response = await PATCH(req);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', req);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('admin_set_user_role', { _actor_id: ACTOR, _user_id: TARGET, _role_code: 'supporter' });
  expect(getUserById).not.toHaveBeenCalled(); expect(updateUserById).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  expect(enforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:users:role-update', limit: 30, windowSeconds: 600 });
  expect(enforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:users:role-update', limit: 30, windowSeconds: 600, subject: ACTOR });
  expect((authorizeAdminPermission as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((requireCsrfOrDeny as jest.Mock).mock.invocationCallOrder[0]);
  expect((requireCsrfOrDeny as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((enforceRateLimit as jest.Mock).mock.invocationCallOrder[0]);
  expect((enforceRateLimit as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(rpc.mock.invocationCallOrder[0]).toBeLessThan((logAudit as jest.Mock).mock.invocationCallOrder[0]);
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.users.role.update', resource_id: TARGET, outcome: 'success', detail: 'User role updated', metadata: { previous_role: 'user', requested_role: 'supporter', assigned_by: ACTOR } }));
});

test.each([401, 403, 503])('supporter等の認可拒否%sではRPC・監査0回', async (status) => {
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('denied', { status }) });
  const response = await PATCH(request());
  expect(response.status).toBe(status); expect(await response.text()).toBe('denied');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled(); expect(requireCsrfOrDeny).not.toHaveBeenCalled();
});

test.each(['csrf', 'ip', 'actor'] as const)('%s拒否の本文・statusを保ち、RPC・監査0回', async (stage) => {
  const status = stage === 'csrf' ? 403 : 429;
  const denied = new Response('refused', { status, headers: { 'retry-after': '600' } });
  if (stage === 'csrf') (requireCsrfOrDeny as jest.Mock).mockResolvedValue(denied);
  else (enforceRateLimit as jest.Mock).mockResolvedValueOnce(stage === 'ip' ? denied : undefined).mockResolvedValueOnce(denied);
  const req = request(); const read = jest.spyOn(req, 'json'); const response = await PATCH(req);
  expect(response.status).toBe(status); expect(await response.text()).toBe('refused');
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('retry-after')).toBe('600');
  expect(enforceRateLimit).toHaveBeenCalledTimes(stage === 'csrf' ? 0 : stage === 'ip' ? 1 : 2);
  expect(read).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
});

test.each([
  ['SELF_ROLE_CHANGE_FORBIDDEN', '42501', 403, 'failure', '自分自身の役割は変更できません。'],
  ['LAST_ADMIN_REQUIRED', 'P0001', 409, 'conflict', '店長を1人以上残してください。'],
] as const)('自己変更%sはDBの優先順位で拒否し、ACL/metadata更新なし', async (code, sqlstate, status, outcome, error) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate } });
  const response = await PATCH(request({ userId: ACTOR, role: 'user' }));
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error, code });
  expect(rpc).toHaveBeenCalledTimes(1); expect(updateUserById).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.users.role.update', resource_id: ACTOR, outcome, detail: 'User role change refused', metadata: { requested_role: 'user', result_code: code } }));
});

test('対象なしは既存404本文を保つ', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'USER_NOT_FOUND', code: 'P0002' } });
  const response = await PATCH(request());
  expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'User not found' });
  expect(updateUserById).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
});

test.each([null, {}, { userId: 'invalid', role: 'admin' }, { userId: TARGET, role: 'other' }])('不正本文%jは既存400でRPCなし', async (body) => {
  const response = await PATCH(request(body));
  expect(response.status).toBe(400); expect((await response.json()).error).toBe('Invalid request');
  expect(rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(jest.mocked(logAudit).mock.calls)).not.toContain('invalid');
});

test('異なるSQLSTATEの拒否名は内部失敗として扱い生情報を漏らさない', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'LAST_ADMIN_REQUIRED', code: 'PRIVATE', details: 'PRIVATE' } });
  const response = await PATCH(request());
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'Internal server error' });
  expect(console.error).toHaveBeenCalledWith('[admin.permissions] operation failed');
  expect(JSON.stringify(jest.mocked(logAudit).mock.calls)).not.toContain('PRIVATE');
});

test('監査例外でも役割変更の成功は200', async () => {
  (logAudit as jest.Mock).mockRejectedValue(new Error('PRIVATE'));
  expect((await PATCH(request())).status).toBe(200);
});

test('既存本文の余分なactor指定を認可actorとして使わない', async () => {
  const response = await PATCH(request({ userId: TARGET, role: 'supporter', actorId: TARGET }));
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('admin_set_user_role', { _actor_id: ACTOR, _user_id: TARGET, _role_code: 'supporter' });
});
