/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));
jest.mock('@/features/auth/staff/staff-invite-send', () => ({ issueAndSendStaffInvite: jest.fn() }));

import { GET, PATCH } from '@/app/api/admin/users/route';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
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
  (revokeAllSessionsForUser as jest.Mock).mockResolvedValue({ authSessionsDeleted: 0 });
  (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: true });
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
] as const)('降格の拒否%sはstaff_demoteの拒否として既存の本文で返し、ログイン終了なし', async (code, sqlstate, status, outcome, error) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate } });
  const response = await PATCH(request({ userId: ACTOR, role: 'user' }));
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error, code });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('staff_demote', { p_actor_id: ACTOR, p_user_id: ACTOR });
  expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  expect(updateUserById).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.demote', resource_id: ACTOR, outcome, metadata: { requested_role: 'user', result_code: code === 'LAST_ADMIN_REQUIRED' ? 'last_admin' : 'self' } }));
});

test('userへの降格はadmin_set_user_roleでなくstaff_demoteで行い、その後にログインを全部終わらせる', async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  const response = await PATCH(request({ userId: TARGET, role: 'user' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('staff_demote', { p_actor_id: ACTOR, p_user_id: TARGET });
  expect(rpc).not.toHaveBeenCalledWith('admin_set_user_role', expect.anything());
  expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.demote', resource_id: TARGET, outcome: 'success' }));
});

test('降格でログインの終了に失敗したら500', async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  (revokeAllSessionsForUser as jest.Mock).mockRejectedValue(new Error('x'));
  const response = await PATCH(request({ userId: TARGET, role: 'user' }));
  expect(response.status).toBe(500);
});

test('お客さんなどを店員にする要求はSTAFF_INVITE_REQUIREDを受けて直には変えず、promoteの招待を出して{ success, invited }を返す', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_INVITE_REQUIRED', code: '42501' } });
  getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'customer@example.com' } }, error: null });
  const response = await PATCH(request({ userId: TARGET, role: 'admin' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, invited: true });
  expect(issueAndSendStaffInvite).toHaveBeenCalledWith(expect.anything(), {
    userId: TARGET, email: 'customer@example.com', role: 'admin', kind: 'promote', issuedBy: ACTOR, reason: null, hadPasskeys: true,
  });
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.staff.promote', resource_id: TARGET, outcome: 'success' }));
  expect(JSON.stringify(jest.mocked(logAudit).mock.calls)).not.toContain('customer@example.com');
});

test('promoteの招待が断られたら、その理由の応答で返す', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_INVITE_REQUIRED', code: '42501' } });
  getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'customer@example.com' } }, error: null });
  (issueAndSendStaffInvite as jest.Mock).mockResolvedValue({ ok: false, reason: 'mail_failed' });
  const response = await PATCH(request({ userId: TARGET, role: 'supporter' }));
  expect(response.status).toBe(502);
  expect((await response.json()).error).toBe('メールを送れませんでした。もう一度、招待を出してください。');
});

test('promoteで対象のアカウントのメールを読めなければ404で、招待を出さない', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_INVITE_REQUIRED', code: '42501' } });
  getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'x' } });
  const response = await PATCH(request({ userId: TARGET, role: 'admin' }));
  expect(response.status).toBe(404);
  expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
});

test('異なるSQLSTATEのSTAFF_INVITE_REQUIREDは招待に落とさず内部失敗にする', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_INVITE_REQUIRED', code: 'P0001' } });
  const response = await PATCH(request({ userId: TARGET, role: 'admin' }));
  expect(response.status).toBe(500);
  expect(issueAndSendStaffInvite).not.toHaveBeenCalled();
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

describe('GET /api/admin/users の足した列', () => {
  const STAFF = '20000000-0000-4000-8000-000000000001';
  const CUSTOMER = '20000000-0000-4000-8000-000000000002';
  const INVITED = '20000000-0000-4000-8000-000000000003';
  const listUsers = jest.fn();

  function table(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'in', 'eq', 'or', 'order']) chain[name] = () => chain;
    (chain as { then: unknown }).then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
    return chain;
  }

  beforeEach(() => {
    listUsers.mockResolvedValue({
      data: { users: [STAFF, CUSTOMER, INVITED].map((id) => ({ id, email: `${id.slice(-1)}@example.com`, user_metadata: {}, app_metadata: {}, last_sign_in_at: null })) },
      error: null,
    });
    (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, from, auth: { admin: { listUsers } } });
    from.mockImplementation((name: string) => table(name === 'user_roles' ? [{ user_id: STAFF, roles: { code: 'admin' } }] : []));
    rpc.mockImplementation(async (name: string, args: { p_user_id: string }) => {
      if (name === 'passkey_approved_count') return { data: args.p_user_id === STAFF ? 2 : 0, error: null };
      if (name === 'staff_invite_open') return { data: args.p_user_id === INVITED, error: null };
      return { data: null, error: null };
    });
  });

  test('店員には認めた鍵の本数を、店員でない人には開いた招待の有無を付ける', async () => {
    const response = await GET(new Request('https://example.test/api/admin/users'));
    const { data } = await response.json();
    const byId = Object.fromEntries(data.map((row: { id: string }) => [row.id, row]));
    expect(response.status).toBe(200);
    expect(byId[STAFF]).toMatchObject({ approvedPasskeys: 2, invitePending: false });
    expect(byId[CUSTOMER]).toMatchObject({ approvedPasskeys: 0, invitePending: false });
    expect(byId[INVITED]).toMatchObject({ approvedPasskeys: 0, invitePending: true });
    expect(rpc).not.toHaveBeenCalledWith('passkey_approved_count', { p_user_id: CUSTOMER });
    expect(rpc).not.toHaveBeenCalledWith('staff_invite_open', { p_user_id: STAFF });
  });

  test('本数を数える呼びが失敗した店員は0本として返す（閉じる側）', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'passkey_approved_count' ? { data: null, error: { code: 'XX000' } } : { data: false, error: null }));
    const { data } = await (await GET(new Request('https://example.test/api/admin/users'))).json();
    expect(data.find((row: { id: string }) => row.id === STAFF).approvedPasskeys).toBe(0);
  });
});
