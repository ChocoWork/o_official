/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

import { POST } from '@/app/api/admin/role-permissions/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const rpc = jest.fn();
const CHANGE = { roleCode: 'supporter', permissionCodes: ['admin.shipping.manage'], expectedVersion: '0', requestKey: '10000000-0000-4000-8000-000000000001' };
const SAVED = { role: { code: 'supporter', version: '1', permissionCodes: ['admin.shipping.manage'] }, changedCount: 1 };
const request = (body: unknown = CHANGE, raw = false) => new Request('https://example.test/api/admin/role-permissions', {
  method: 'POST', body: raw ? String(body) : JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5, 203.0.113.6', 'user-agent': 'jest' },
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin', actorEmail: 'PRIVATE' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  (logAudit as jest.Mock).mockResolvedValue(undefined);
  rpc.mockResolvedValue({ data: SAVED, error: null });
});
afterEach(() => jest.restoreAllMocks());

test.each([undefined, { rotatedCsrfToken: 'legacy' }])('CSRF成功%jは通過し、依存を自動付与せず200・許可した監査だけ', async (csrf) => {
  (requireCsrfOrDeny as jest.Mock).mockResolvedValue(csrf);
  const req = request(); const response = await POST(req);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ data: { ...SAVED, role: { ...SAVED.role, label: 'サポーター' } } });
  expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.permissions.manage', req);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('admin_set_role_permissions', { _actor_id: 'authorized-actor', _role_code: 'supporter', _permission_codes: ['admin.shipping.manage'], _expected_version: '0', _request_key: CHANGE.requestKey });
  expect(enforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:role-permissions:update', limit: 30, windowSeconds: 600 });
  expect(enforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:role-permissions:update', limit: 30, windowSeconds: 600, subject: 'authorized-actor' });
  expect((authorizeAdminPermission as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((requireCsrfOrDeny as jest.Mock).mock.invocationCallOrder[0]);
  expect((requireCsrfOrDeny as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((enforceRateLimit as jest.Mock).mock.invocationCallOrder[0]);
  expect((enforceRateLimit as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(rpc.mock.invocationCallOrder[0]).toBeLessThan((logAudit as jest.Mock).mock.invocationCallOrder[0]);
  expect(logAudit).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith({ action: 'admin.permissions.update', resource: 'role_permissions', resource_id: 'supporter', actor_id: 'authorized-actor', outcome: 'success', detail: 'Role permissions saved', ip: '203.0.113.5', user_agent: 'jest', metadata: { role_code: 'supporter', request_key: CHANGE.requestKey, changed_count: 1, result_code: 'OK' } });
});

test.each([401, 403, 503])('認可%sで本文を読まずCSRF・RPC・監査0回', async (status) => {
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('denied', { status }) });
  const req = request(); const read = jest.spyOn(req, 'json');
  const response = await POST(req);
  expect(response.status).toBe(status); expect(await response.text()).toBe('denied');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(read).not.toHaveBeenCalled(); expect(requireCsrfOrDeny).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
});

test.each(['csrf', 'ip', 'actor'] as const)('%sの拒否Responseを保持し、RPC・監査0回', async (stage) => {
  const status = stage === 'csrf' ? 403 : 429;
  const denied = new Response('refused', { status, headers: { 'retry-after': '600' } });
  if (stage === 'csrf') (requireCsrfOrDeny as jest.Mock).mockResolvedValue(denied);
  else (enforceRateLimit as jest.Mock).mockResolvedValueOnce(stage === 'ip' ? denied : undefined).mockResolvedValueOnce(denied);
  const req = request(); const read = jest.spyOn(req, 'json'); const response = await POST(req);
  expect(response.status).toBe(status); expect(await response.text()).toBe('refused');
  expect(response.headers.get('retry-after')).toBe('600'); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(enforceRateLimit).toHaveBeenCalledTimes(stage === 'csrf' ? 0 : stage === 'ip' ? 1 : 2);
  expect(read).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
});

test.each(['authz', 'csrf', 'ip', 'actor'] as const)('%sの例外は固定500・no-store、本文を読まずRPC・監査0回', async (stage) => {
  const thrown = new Error('PRIVATE');
  if (stage === 'authz') (authorizeAdminPermission as jest.Mock).mockRejectedValue(thrown);
  else if (stage === 'csrf') (requireCsrfOrDeny as jest.Mock).mockRejectedValue(thrown);
  else if (stage === 'ip') (enforceRateLimit as jest.Mock).mockRejectedValueOnce(thrown);
  else (enforceRateLimit as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(thrown);
  const req = request(); const read = jest.spyOn(req, 'json'); const response = await POST(req);
  expect(response.status).toBe(500); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: '権限を保存できませんでした。', code: 'PERMISSION_UPDATE_FAILED' });
  expect(read).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith('[admin.permissions] operation failed');
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});

test.each([
  null, [], {}, { ...CHANGE, actorId: 'spoof' }, { ...CHANGE, roleId: 1 }, { ...CHANGE, extra: true },
  { ...CHANGE, roleCode: 'user' }, { ...CHANGE, roleCode: 'other' },
  { ...CHANGE, permissionCodes: ['other.permission'] }, { ...CHANGE, permissionCodes: ['admin.users.read', 'admin.users.read'] },
  { ...CHANGE, permissionCodes: Array(31).fill('admin.users.read') }, { ...CHANGE, permissionCodes: null },
  { ...CHANGE, permissionCodes: [null] }, { ...CHANGE, requestKey: 'invalid' },
  ...['00', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '1\n', '0\r\n', '9223372036854775808', '', 'PRIVATE'].map((expectedVersion) => ({ ...CHANGE, expectedVersion })),
  { ...CHANGE, expectedVersion: 1 },
])('strict入力%jは400、未検証role/keyを監査に入れない', async (body) => {
  const response = await POST(request(body));
  expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: '入力を確かめてください。', code: 'ROLE_PERMISSION_ARGUMENT_INVALID' });
  expect(rpc).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null, outcome: 'failure', detail: 'Role permissions refused', metadata: { result_code: 'ROLE_PERMISSION_ARGUMENT_INVALID' } }));
});

test('不正JSONも400で監査しRPCを呼ばない', async () => {
  const response = await POST(request('{', true));
  expect(response.status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null, metadata: { result_code: 'ROLE_PERMISSION_ARGUMENT_INVALID' } }));
});

test.each(['0', '9007199254740993', '9223372036854775807'])('version %sと空配列を精度を落とさず渡す', async (expectedVersion) => {
  rpc.mockResolvedValue({ data: { role: { code: 'supporter', version: expectedVersion, permissionCodes: [] }, changedCount: 0 }, error: null });
  expect((await POST(request({ ...CHANGE, expectedVersion, permissionCodes: [] }))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('admin_set_role_permissions', expect.objectContaining({ _expected_version: expectedVersion, _permission_codes: [] }));
});

test.each([
  ['ROLE_PERMISSION_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
  ['ROLE_PERMISSION_FORBIDDEN', '42501', 403, '権限を変更する権限がありません。'],
  ['ROLE_PERMISSION_FIXED', '42501', 403, '権限管理と利用者管理は店長のみ・変更不可です。'],
  ['ROLE_PERMISSION_VERSION_CONFLICT', 'P0001', 409, 'ほかの人が権限を変更しました。現在の設定を読み直してください。'],
  ['ROLE_PERMISSION_REQUEST_KEY_CONFLICT', 'P0001', 409, '同じ要求番号で異なる変更は保存できません。現在の設定を読み直してください。'],
] as const)('%sはstatus/code/文言を固定し、409をconflict監査', async (code, sqlstate, status, error) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate } });
  const response = await POST(request());
  expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error, code });
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: status === 409 ? 'conflict' : 'failure', detail: 'Role permissions refused', metadata: { role_code: 'supporter', request_key: CHANGE.requestKey, result_code: code } }));
});

test.each(['admin.users.manage', 'admin.permissions.manage'])('固定%sの店長解除・サポーター追加はDB拒否403', async (fixed) => {
  rpc.mockResolvedValue({ data: null, error: { message: 'ROLE_PERMISSION_FIXED', code: '42501' } });
  const remainingFixed = fixed === 'admin.users.manage' ? 'admin.permissions.manage' : 'admin.users.manage';
  for (const body of [{ ...CHANGE, roleCode: 'admin', permissionCodes: [remainingFixed] }, { ...CHANGE, permissionCodes: [fixed] }]) {
    const response = await POST(request(body));
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('ROLE_PERMISSION_FIXED');
  }
});

test.each(['error', 'malformed'] as const)('未知DB%sは固定500と安全な監査・ログ', async (source) => {
  rpc.mockResolvedValue(source === 'error' ? { data: null, error: { message: 'ROLE_PERMISSION_FIXED PRIVATE', code: '42501', details: 'PRIVATE' } } : { data: { role: { ...SAVED.role, permissionCodes: ['PRIVATE'] }, changedCount: 1 }, error: null });
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: '権限を保存できませんでした。', code: 'PERMISSION_UPDATE_FAILED' });
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to save role permissions', metadata: { role_code: 'supporter', request_key: CHANGE.requestKey, result_code: 'PERMISSION_UPDATE_FAILED' } }));
  expect(console.error).toHaveBeenCalledWith('[admin.permissions] operation failed');
  expect(JSON.stringify([jest.mocked(logAudit).mock.calls, jest.mocked(console.error).mock.calls])).not.toContain('PRIVATE');
});

test('監査が例外でも保存成功を失敗にせず、再送も同じRPC契約で操作監査する', async () => {
  (logAudit as jest.Mock).mockRejectedValue(new Error('PRIVATE'));
  const first = await POST(request()); const replay = await POST(request());
  expect(first.status).toBe(200); expect(replay.status).toBe(200);
  expect(await first.json()).toEqual(await replay.json());
  expect(rpc).toHaveBeenCalledTimes(2); expect(logAudit).toHaveBeenCalledTimes(2);
});
