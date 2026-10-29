/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
// 認可の実装(admin-rbac)は丸ごとmockせず、その下の依存(トークン検証・session生存・ACL照会)だけを差し替える。
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import fs from 'node:fs';
import path from 'node:path';
import { GET as listGet, POST as createPost } from '@/app/api/admin/discounts/route';
import { GET as detailGet, PATCH as updatePatch } from '@/app/api/admin/discounts/[id]/route';
import { POST as stopPost } from '@/app/api/admin/discounts/[id]/stop/route';
import { POST as resumePost } from '@/app/api/admin/discounts/[id]/resume/route';
import { POST as duplicatePost } from '@/app/api/admin/discounts/[id]/duplicate/route';
import { POST as assignPost } from '@/app/api/admin/discounts/[id]/assign/route';
import { POST as unassignPost } from '@/app/api/admin/discounts/[id]/unassign/route';
import { POST as codesPost } from '@/app/api/admin/discounts/[id]/codes/route';
import { GET as membersGet } from '@/app/api/admin/discounts/members/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { GROUP_H_ERRORS } from '@/lib/discounts/admin-discount-types';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = uuid(1); const key = uuid(2); const codeId = uuid(3); const newId = uuid(4); const user1 = uuid(5); const user2 = uuid(6);
const ACTOR = 'actor-1';
const claims = (aal: string) => ({ sub: ACTOR, session_id: 'session-1', aal, email: 'admin@example.test', app_metadata: { role: 'admin' } });
const candidate = {
  name: '春の割引', kind: 'order_percent', method: 'automatic', value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [],
  minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true, firstOrderOnly: false, usageLimit: null, oncePerCustomer: false,
  startsAt: '2030-11-01T00:00:00.000Z', endsAt: null, stopped: false, combinesWithProduct: false, combinesWithOrder: false,
  advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false,
};
const definition = { id, version: '3', ...candidate };
const assignmentRow = { rowId: 'r1', codeId, code: 'SECRETCODE-1', userId: user1, assigneeDeleted: false, assigneeName: '花', guestEmailMasked: null, status: 'unused', usedAt: null, orderId: null };
const MANAGE = 'admin.discounts.manage'; const READ = 'admin.discounts.read';

const seq: string[] = [];
const rpcImpl = jest.fn();
const grants = { current: [READ, MANAGE] as string[] };
const service = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, or: async () => ({ data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }], error: null }) };
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => { seq.push(`rpc:${name}`); return rpcImpl(name, args); },
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
  const write = (discountId: string) => ({ data: { discountId, version: '4', replayed: false }, error: null as null });
  switch (name) {
    case 'admin_create_discount': return write(newId);
    case 'admin_update_discount': case 'admin_set_discount_stopped': return write(id);
    case 'admin_duplicate_discount': return write(newId);
    case 'admin_assign_discount': return { data: { discountId: id, changedCount: 2, replayed: false }, error: null };
    case 'admin_unassign_discount': return { data: { discountId: id, changedCount: 1, replayed: false }, error: null };
    case 'admin_generate_discount_codes': return { data: { discountId: id, batchId: uuid(8), replayed: false, codes: [{ codeId, code: 'SECRETCODE-2345', userId: null }, { codeId: uuid(7), code: 'SECRETCODE-6789', userId: null }] }, error: null };
    case 'list_admin_discounts': return { data: { total: 0, rows: [] }, error: null };
    case 'get_admin_discount': return { data: { discount: definition, used: false, assignmentTotal: 1, assignments: [assignmentRow], searchAttention: null }, error: null };
    case 'search_admin_discount_members': return { data: { rows: [{ userId: user1, name: null, email: 'member@example.test' }] }, error: null };
    default: throw new Error(`unexpected rpc ${name}`);
  }
};

const createInput = { ...candidate, code: null, codeMode: 'shared' };
type WriteCase = {
  name: string; call: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>; method: string; withId: boolean; body: Record<string, unknown>;
  rpc: string[]; status: number; action: string; metadata: Record<string, unknown>; codes?: boolean; resourceId: string | null;
};
const writes: WriteCase[] = [
  { name: 'create', call: (r) => createPost(r), method: 'POST', withId: false, body: { input: createInput, requestKey: key }, rpc: ['admin_create_discount'], status: 201, action: 'admin.discounts.create', metadata: { replayed: false }, resourceId: newId },
  { name: 'update', call: updatePatch, method: 'PATCH', withId: true, body: { patch: { name: '改名' }, expectedVersion: '3', requestKey: key }, rpc: ['admin_update_discount'], status: 200, action: 'admin.discounts.update', metadata: { replayed: false }, resourceId: id },
  { name: 'stop', call: stopPost, method: 'POST', withId: true, body: { expectedVersion: '3', requestKey: key }, rpc: ['admin_set_discount_stopped'], status: 200, action: 'admin.discounts.stop', metadata: { replayed: false }, resourceId: id },
  { name: 'resume', call: resumePost, method: 'POST', withId: true, body: { expectedVersion: '3', requestKey: key }, rpc: ['admin_set_discount_stopped'], status: 200, action: 'admin.discounts.resume', metadata: { replayed: false }, resourceId: id },
  { name: 'duplicate', call: duplicatePost, method: 'POST', withId: true, body: { requestKey: key }, rpc: ['admin_duplicate_discount'], status: 201, action: 'admin.discounts.duplicate', metadata: { replayed: false }, resourceId: newId },
  { name: 'assign', call: assignPost, method: 'POST', withId: true, body: { codeId, userIds: [user1, user2], requestKey: key }, rpc: ['admin_assign_discount'], status: 200, action: 'admin.discounts.assign', metadata: { changed_count: 2, replayed: false }, resourceId: id },
  { name: 'unassign', call: unassignPost, method: 'POST', withId: true, body: { codeId, userId: user1, requestKey: key }, rpc: ['admin_unassign_discount'], status: 200, action: 'admin.discounts.unassign', metadata: { changed_count: 1, replayed: false }, resourceId: id },
  { name: 'codes', call: codesPost, method: 'POST', withId: true, body: { prefix: 'SECRETCODE', userIds: [], count: 2, requestKey: key }, rpc: ['admin_generate_discount_codes'], status: 201, action: 'admin.discounts.generate_codes', metadata: { generated_count: 2, replayed: false }, codes: true, resourceId: id },
];
const ctx = (value = id) => ({ params: Promise.resolve({ id: value }) });
const url = (suffix = '') => `https://example.test/api/admin/discounts${suffix}`;
function build(c: WriteCase, body: unknown = c.body, headers: Record<string, string> = {}): Request {
  return new Request(url(), { method: c.method, body: body === undefined ? undefined : JSON.stringify(body), headers });
}
async function run(c: WriteCase, request = build(c), value = id) {
  const response = await c.call(request, ctx(value));
  expect(response.headers.get('cache-control')).toContain('no-store');
  return { response, json: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  jest.resetAllMocks();
  seq.length = 0; grants.current = [READ, MANAGE];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (verifyAccessToken as jest.Mock).mockImplementation(async () => { seq.push('auth'); return { ok: true, claims: claims('aal2') }; });
  (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
  (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
  mockCsrf.mockImplementation(() => { seq.push('csrf'); });
  mockRate.mockImplementation(async (arg: { endpoint: string; subject?: string }) => { seq.push(`${arg.endpoint}:${arg.subject ? 'actor' : 'ip'}`); return undefined; });
  mockAudit.mockImplementation(async () => { seq.push('audit'); });
  rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('admin discount routes', () => {
  test('FREQ-543-AC-01: routeは結付いたaal1を403、失効・期限切れのapp sessionを401、確認不能を503で拒否してRPCを呼ばない', async () => {
    // 認可の実装は本物。aal1(結び付いた session)は403 MFA、aal2でも失効/期限切れは401・確認不能は503で、RPCもCSRFも通らない。
    // (失効を403にするのは誤り: authorizeAdminPermissions は失効を401、確認不能を503にする)
    const callers: { name: string; permission: string; call: () => Promise<Response> }[] = [
      { name: 'list', permission: READ, call: () => listGet(new Request(url())) },
      { name: 'detail', permission: READ, call: () => detailGet(new Request(url(`/${id}`)), ctx()) },
      { name: 'members', permission: MANAGE, call: () => membersGet(new Request(url('/members?query=ab'))) },
      ...writes.map((c) => ({ name: c.name, permission: MANAGE, call: () => c.call(build(c), ctx()) })),
    ];
    for (const caller of callers) {
      // 結び付いたaal1: 権限があっても403 (MFA required)
      seq.length = 0; rpcImpl.mockClear(); mockCsrf.mockClear(); mockRate.mockClear(); mockAudit.mockClear();
      (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => { seq.push('auth'); return { ok: true, claims: claims('aal1') }; });
      const aal1 = await caller.call();
      expect([caller.name, aal1.status]).toEqual([caller.name, 403]);
      expect(await aal1.json()).toEqual({ error: 'Forbidden', reason: 'MFA required', permission: caller.permission, role: 'admin' });
      expect(aal1.headers.get('cache-control')).toContain('no-store');
      // 失効した/期限切れのapp session(aal2): 401。確認できない時は503。
      for (const [liveness, status] of [['revoked', 401], ['unavailable', 503]] as const) {
        (checkAuthSessionLiveness as jest.Mock).mockResolvedValueOnce(liveness);
        const denied = await caller.call();
        expect([caller.name, liveness, denied.status]).toEqual([caller.name, liveness, status]);
        expect(denied.headers.get('cache-control')).toContain('no-store');
      }
      // トークン自体が不正: 401
      (verifyAccessToken as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'invalid' });
      expect((await caller.call()).status).toBe(401);
      // 拒否のどれもRPC・CSRF・回数制限・監査へ進まない
      expect(rpcImpl).not.toHaveBeenCalled(); expect(mockCsrf).not.toHaveBeenCalled();
      expect(mockRate).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
    }
    // 成功: aal2 かつ live session の時だけRPCへ届く
    seq.length = 0;
    const success = await listGet(new Request(url()));
    expect(success.status).toBe(200);
    expect(seq).toEqual(['auth', 'rpc:list_admin_discounts']);
    // 権限が足りない役割は、aal2でも403 permission。manage だけの人は read を満たさない。
    grants.current = [MANAGE];
    const noRead = await listGet(new Request(url()));
    expect(noRead.status).toBe(403); expect(await noRead.json()).toEqual({ error: 'Forbidden', permission: READ, role: 'admin' });
    grants.current = [READ];
    for (const c of writes) {
      const noManage = await c.call(build(c), ctx());
      expect([c.name, noManage.status]).toEqual([c.name, 403]);
    }
    expect((await membersGet(new Request(url('/members?query=ab')))).status).toBe(403);
    expect(seq.filter((s) => s.startsWith('rpc:'))).toEqual(['rpc:list_admin_discounts']);
  });

  test('FREQ-543-AC-02: 管理writeは認可・CSRF・IP・actor・入力・RPC・監査の順で途中拒否後の処理を呼ばない', async () => {
    for (const c of writes) {
      const spyJson = (request: Request) => { const original = request.json.bind(request); jest.spyOn(request, 'json').mockImplementation(async () => { seq.push('validation'); return original(); }); return request; };
      const limits = c.codes ? ['admin.discounts.write:ip', 'admin.discounts.write:actor', 'admin.discounts.codes:ip', 'admin.discounts.codes:actor'] : ['admin.discounts.write:ip', 'admin.discounts.write:actor'];
      // 全部通る順序。actorは認可結果の userId だけ、IPは request を渡して getClientIp に任せる
      seq.length = 0; mockAudit.mockClear(); mockRate.mockClear();
      const request = spyJson(build(c, c.body, { 'x-forwarded-for': '203.0.113.9', 'x-actor-id': 'forged' }));
      const ok = await c.call(request, ctx());
      expect([c.name, ok.status]).toEqual([c.name, c.status]);
      expect(seq).toEqual(['auth', 'csrf', ...limits, 'validation', ...c.rpc.map((n) => `rpc:${n}`), 'audit']);
      const rates = c.codes ? [['admin.discounts.write', 30], ['admin.discounts.codes', 10]] : [['admin.discounts.write', 30]];
      expect(mockRate.mock.calls).toEqual(rates.flatMap(([endpoint, limit]) => [
        [{ request, endpoint, limit, windowSeconds: 600 }], [{ request, endpoint, limit, windowSeconds: 600, subject: ACTOR }],
      ]));
      expect(mockAudit).toHaveBeenCalledWith({ action: c.action, actor_id: ACTOR, resource: 'discounts', resource_id: c.resourceId, outcome: 'success', metadata: c.metadata });
      for (const [, args] of rpcImpl.mock.calls as [string, Record<string, unknown>][]) expect(args._actor_id).toBe(ACTOR);
      rpcImpl.mockClear();

      // 途中で拒否したら、以降は何も呼ばない
      const stops: [string, () => void, number, string[]][] = [
        ['未認証', () => (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => { seq.push('auth'); return { ok: false, reason: 'missing' }; }), 401, ['auth']],
        ['権限なし', () => { grants.current = [READ]; }, 403, ['auth']],
        ['CSRF', () => mockCsrf.mockImplementationOnce(() => { seq.push('csrf'); return new Response('{}', { status: 403 }); }), 403, ['auth', 'csrf']],
        ['IP', () => mockRate.mockImplementationOnce(async () => { seq.push('ip'); return new Response('{}', { status: 429 }); }), 429, ['auth', 'csrf', 'ip']],
        ['actor', () => mockRate.mockImplementationOnce(async () => { seq.push('ip'); }).mockImplementationOnce(async () => { seq.push('actor'); return new Response('{}', { status: 503 }); }), 503, ['auth', 'csrf', 'ip', 'actor']],
      ];
      if (c.codes) stops.push(['codes IP', () => mockRate.mockImplementationOnce(async () => { seq.push('w-ip'); }).mockImplementationOnce(async () => { seq.push('w-actor'); }).mockImplementationOnce(async () => { seq.push('c-ip'); return new Response('{}', { status: 429 }); }), 429, ['auth', 'csrf', 'w-ip', 'w-actor', 'c-ip']]);
      for (const [label, arrange, status, expected] of stops) {
        seq.length = 0; grants.current = [READ, MANAGE]; mockAudit.mockClear(); mockCsrf.mockClear();
        arrange();
        const denied = spyJson(build(c));
        const response = await c.call(denied, ctx());
        expect([c.name, label, response.status, seq]).toEqual([c.name, label, status, expected]);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(denied.json).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
        mockRate.mockReset().mockImplementation(async (arg: { endpoint: string; subject?: string }) => { seq.push(`${arg.endpoint}:${arg.subject ? 'actor' : 'ip'}`); return undefined; });
      }

      // 入力の拒否: RPCは呼ばず、監査は失敗の結果コードだけ
      seq.length = 0; mockAudit.mockClear();
      const bodies: unknown[] = [null, 'x', {}, { ...c.body, actorId: 'forged' }, { ...c.body, _actor_id: 'forged' }, { ...c.body, requestKey: 'bad' }];
      for (const body of bodies) {
        const bad = await run(c, build(c, body));
        expect([c.name, bad.response.status, bad.json]).toEqual([c.name, 400, { code: 'GROUP_H_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
      }
      expect(rpcImpl).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledTimes(bodies.length);
      expect(mockAudit).toHaveBeenLastCalledWith({ action: c.action, actor_id: ACTOR, resource: 'discounts', resource_id: c.withId ? id : null, outcome: 'failure', metadata: { result_code: 'GROUP_H_ARGUMENT_INVALID' } });
      if (c.withId) {
        mockAudit.mockClear();
        const badId = await run(c, build(c), 'not-a-uuid');
        expect(badId.response.status).toBe(400);
        expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null, outcome: 'failure' }));
        expect(rpcImpl).not.toHaveBeenCalled();
      }
    }
  });

  test('FREQ-543-AC-02: DB拒否は固定本文と結果コードだけを監査し、未知の失敗は固定500で秘密を出さない', async () => {
    const secrets = ['SECRETCODE', '春の割引', 'member@example.test', user1, user2, 'PRIVATE'];
    for (const c of writes) {
      for (const [message, [sqlstate, status, text]] of Object.entries(GROUP_H_ERRORS)) {
        mockAudit.mockClear();
        rpcImpl.mockImplementation(async () => ({ data: null, error: { message, code: sqlstate, details: 'PRIVATE', hint: 'PRIVATE' } }));
        const result = await run(c);
        expect([c.name, message, result.response.status, result.json]).toEqual([c.name, message, status, { code: message, error: text }]);
        expect(mockAudit).toHaveBeenCalledWith({ action: c.action, actor_id: ACTOR, resource: 'discounts', resource_id: c.withId ? id : null, outcome: status >= 500 ? 'error' : 'failure', metadata: { result_code: message } });
      }
      // 未知: 500 + outcome error。固定コードの500(LOCK_REQUIRED等の内部の失敗)もerror、409等はfailure。ログはエラー名とSQLSTATEだけ
      mockAudit.mockClear(); jest.mocked(console.error).mockClear();
      rpcImpl.mockImplementation(async () => ({ data: null, error: { message: 'PRIVATE SECRETCODE', code: '40P01', details: 'PRIVATE' } }));
      const unknown = await run(c);
      expect([unknown.response.status, unknown.json]).toEqual([500, { error: '割引の処理に失敗しました。' }]);
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { result_code: 'DISCOUNT_FAILED' } }));
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/error:$/), 'AdminDiscountStoreError', '40P01');
      // 監査の障害でも結果は変えない
      rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
      mockAudit.mockRejectedValue(new Error('PRIVATE'));
      expect((await run(c)).response.status).toBe(c.status);
      mockAudit.mockImplementation(async () => { seq.push('audit'); });
      const logged = JSON.stringify([mockAudit.mock.calls, jest.mocked(console.error).mock.calls]);
      for (const secret of secrets) expect(logged).not.toContain(secret);
    }
    // 成功時の監査にもコード・名前・userIds・prefixは載らない
    mockAudit.mockClear();
    for (const c of writes) await run(c);
    const audited = JSON.stringify(mockAudit.mock.calls);
    for (const secret of ['SECRETCODE', '春の割引', '改名', user1, user2, 'member@example.test']) expect(audited).not.toContain(secret);
    for (const [event] of mockAudit.mock.calls as [{ metadata: Record<string, unknown> }][]) {
      expect(Object.keys(event.metadata).every((k) => ['changed_count', 'generated_count', 'replayed', 'result_code'].includes(k))).toBe(true);
    }
  });

  test('FREQ-543-AC-02: 管理readの全応答はno-storeで監査を呼ばない（10.1）', async () => {
    const reads: { name: string; call: () => Promise<Response>; okBody: (json: Record<string, unknown>) => void; bad: string }[] = [
      { name: 'list', call: () => listGet(new Request(url())), bad: 'page=0', okBody: (j) => expect(j).toEqual({ data: { total: 0, rows: [] }, permissions: { read: true, manage: true } }) },
      { name: 'detail', call: () => detailGet(new Request(url(`/${id}`)), ctx()), bad: 'page=0', okBody: (j) => expect(j).toMatchObject({ data: { discount: { id }, used: false, permissions: { read: true, manage: true } } }) },
      { name: 'members', call: () => membersGet(new Request(url('/members?query=ab'))), bad: 'query=a', okBody: (j) => expect(j).toEqual({ data: [{ userId: user1, name: null, email: 'member@example.test' }] }) },
    ];
    for (const r of reads) {
      seq.length = 0; mockAudit.mockClear();
      // 200
      const ok = await r.call();
      expect([r.name, ok.status, ok.headers.get('cache-control')]).toEqual([r.name, 200, 'private, no-store']);
      r.okBody(await ok.json() as Record<string, unknown>);
      // 400
      const badRequest = r.name === 'detail' ? new Request(url(`/${id}?${r.bad}`)) : r.name === 'members' ? new Request(url(`/members?${r.bad}`)) : new Request(url(`?${r.bad}`));
      const bad = r.name === 'detail' ? await detailGet(badRequest, ctx()) : r.name === 'members' ? await membersGet(badRequest) : await listGet(badRequest);
      expect([r.name, bad.status, bad.headers.get('cache-control')]).toEqual([r.name, 400, 'private, no-store']);
      expect(await bad.json()).toEqual({ code: 'GROUP_H_ARGUMENT_INVALID', error: '入力を確かめてください。' });
      // 403 (権限) は共通本文のまま。DB側の403(役割の失効)は固定本文
      for (const [state, expected] of [['GROUP_H_FORBIDDEN', 403], ['GROUP_H_DISCOUNT_NOT_FOUND', 404]] as const) {
        rpcImpl.mockImplementation(async () => ({ data: null, error: { message: state, code: GROUP_H_ERRORS[state][0], details: 'PRIVATE' } }));
        const denied = await r.call();
        expect([r.name, denied.status, denied.headers.get('cache-control')]).toEqual([r.name, expected, 'private, no-store']);
        expect(await denied.json()).toEqual({ code: state, error: GROUP_H_ERRORS[state][2] });
      }
      // 500: 秘密を出さない
      rpcImpl.mockImplementation(async () => { throw new Error('PRIVATE SECRETCODE member@example.test'); });
      const failed = await r.call();
      expect([r.name, failed.status, failed.headers.get('cache-control')]).toEqual([r.name, 500, 'private, no-store']);
      expect(await failed.json()).toEqual({ error: '割引の処理に失敗しました。' });
      expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE|SECRETCODE|member@example/);
      rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
      // 権限なしの共通403
      grants.current = [];
      const noPermission = await r.call();
      expect([r.name, noPermission.status, noPermission.headers.get('cache-control')]).toEqual([r.name, 403, 'private, no-store']);
      grants.current = [READ, MANAGE];
      // 不正なidは404でなく400
      if (r.name === 'detail') expect((await detailGet(new Request(url('/x')), ctx('x'))).status).toBe(400);
      // 結果が不正JSONでも500。監査・CSRFは使わない
      rpcImpl.mockImplementation(async () => ({ data: { unexpected: true }, error: null }));
      expect((await r.call()).status).toBe(500);
      rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
      expect(mockAudit).not.toHaveBeenCalled(); expect(mockCsrf).not.toHaveBeenCalled();
      mockRate.mockClear();
    }
    // 回数制限: 通常のreadには増やさず、会員検索だけ IP60 / actor60
    mockRate.mockClear(); seq.length = 0;
    await listGet(new Request(url())); await detailGet(new Request(url(`/${id}`)), ctx());
    expect(mockRate).not.toHaveBeenCalled();
    const members = new Request(url('/members?query=ab'));
    await membersGet(members);
    expect(mockRate.mock.calls).toEqual([
      [{ request: members, endpoint: 'admin.discounts.members', limit: 60, windowSeconds: 600 }],
      [{ request: members, endpoint: 'admin.discounts.members', limit: 60, windowSeconds: 600, subject: ACTOR }],
    ]);
    // 会員検索は 認可 → IP → actor → 検証 → RPC。CSRFは使わない。429は検証より前
    seq.length = 0; mockCsrf.mockClear();
    await membersGet(new Request(url('/members?query=ab')));
    expect(seq).toEqual(['auth', 'admin.discounts.members:ip', 'admin.discounts.members:actor', 'rpc:search_admin_discount_members']);
    expect(mockCsrf).not.toHaveBeenCalled();
    seq.length = 0; rpcImpl.mockClear();
    mockRate.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const limited = await membersGet(new Request(url('/members?query=a')));
    expect(limited.status).toBe(429); expect(limited.headers.get('cache-control')).toContain('no-store');
    expect(rpcImpl).not.toHaveBeenCalled();
    // 一覧/詳細は頁と絞り込みをstoreへ渡す
    rpcImpl.mockClear();
    await listGet(new Request(url('?status=active&kind=set&method=code&query=ab&page=3')));
    expect(rpcImpl).toHaveBeenCalledWith('list_admin_discounts', { _filters: { status: 'active', kind: 'set', method: 'code', query: 'ab' }, _limit: 20, _offset: 40, _actor_id: ACTOR });
    // 読取だけの役割: 一覧は200で manage=false
    grants.current = [READ];
    const readOnly = await listGet(new Request(url()));
    expect((await readOnly.json() as { permissions: unknown }).permissions).toEqual({ read: true, manage: false });
  });

  test('FREQ-547-AC-04: 共有コードの作成・更新・再開の再送は、初回の確定後に目録が拒否しても元の結果で201/200になる', async () => {
    // 本物のDBの順番: 初回が確定した後は、要求キーを知らない目録の読取が自分の行を理由に拒否する(CODE_CONFLICT等)。
    // writerは鍵の下で最初に再送を探して元の結果を返すので、routeは目録を呼ばずwriterへ進み、同じ本文を返す。
    for (const [c, writer, discountId] of [[writes[0], 'admin_create_discount', newId], [writes[1], 'admin_update_discount', id], [writes[3], 'admin_set_discount_stopped', id]] as const) {
      let committed = false;
      rpcImpl.mockImplementation(async (name: string) => {
        if (name === 'get_admin_discount_activation_context') {
          return committed ? { data: null, error: { message: 'GROUP_H_CODE_CONFLICT', code: '23505' } } : { data: { candidate, existing: [] }, error: null };
        }
        const replayed = committed; committed = true;
        return { data: { discountId, version: replayed ? '1' : '4', replayed }, error: null };
      });
      mockAudit.mockClear(); seq.length = 0;
      const first = await run(c);
      const again = await run(c);
      expect([c.name, first.response.status, again.response.status]).toEqual([c.name, c.status, c.status]);
      expect(first.json).toEqual({ data: { discountId, version: '4', replayed: false } });
      expect(again.json).toEqual({ data: { discountId, version: '1', replayed: true } });
      expect(seq.filter((s) => s.startsWith('rpc:'))).toEqual([`rpc:${writer}`, `rpc:${writer}`]);
      expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ resource_id: discountId, outcome: 'success', metadata: { replayed: true } }));
    }
    // 別のdiscountを返す更新は成功にしない
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_update_discount' ? { data: { discountId: uuid(77), version: '4', replayed: false }, error: null } : defaultRpc(name)));
    expect((await run(writes[1])).response.status).toBe(500);
  });

  test('FREQ-543-AC-02: IPは getClientIp だけから取り、x-forwarded-for を読まない', () => {
    const root = path.resolve(__dirname, '../../../../src');
    for (const file of ['lib/discounts/admin-discount-route.ts', 'lib/discounts/admin-discount-store.ts', 'lib/discounts/admin-discount-schema.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/x-forwarded-for|x-real-ip|headers\.get\(/i);
    }
  });
});
