/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/admin/accounting/settings/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = uuid(90); const KEY = uuid(91);
const READ = 'admin.finance.read'; const MANAGE = 'admin.accounting.settings.manage';
const claims = (aal: string) => ({ sub: ACTOR, session_id: 'session-1', aal, email: 'owner@example.test', app_metadata: { role: 'admin' } });
const settingsRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  business_start_date: null, cutover_on: '2026-11-07', current_business_type: 'soleProprietor', sole_business_ended_on: null,
  version: '1', sole_end_changes: [], ...overrides,
});

const seq: string[] = [];
const rpcImpl = jest.fn();
const grants = { current: [READ, MANAGE] as string[] };
const state = { before: settingsRow(), after: settingsRow({ business_start_date: '2025-04-01', version: '2' }) };
const service = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, or: async () => ({ data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }], error: null }) };
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => { seq.push(`rpc:${name}`); return rpcImpl(name, args); },
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
  switch (name) {
    case 'get_accounting_settings': return { data: state.before, error: null };
    case 'admin_update_accounting_settings': return { data: state.after, error: null };
    default: throw new Error(`unexpected rpc ${name}`);
  }
};
const dbError = (message: string, code: string) => ({ data: null, error: { message, code, details: null, hint: null } });
const url = 'https://example.test/api/admin/accounting/settings';
const body = { businessStartDate: '2025-04-01', currentBusinessType: 'soleProprietor', expectedVersion: '1', requestKey: KEY };
const put = (value: unknown = body) => new Request(url, { method: 'PUT', body: JSON.stringify(value) });
async function read(response: Response) {
  expect(response.headers.get('cache-control')).toContain('no-store');
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  jest.resetAllMocks();
  seq.length = 0; grants.current = [READ, MANAGE];
  state.before = settingsRow(); state.after = settingsRow({ business_start_date: '2025-04-01', version: '2' });
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

describe('/api/admin/accounting/settings', () => {
  test('FREQ-561-AC-02: 設定のGETはadmin.finance.readで設定と画面の権限を返す', async () => {
    const change = { previousEndedOn: null, newEndedOn: '2026-08-31', reason: '法人へ移るため', changedAt: '2026-09-01T00:00:00+00:00' };
    state.before = settingsRow({ sole_business_ended_on: '2026-08-31', sole_end_changes: [change] });
    grants.current = [READ];
    const response = await settingsGet(new Request(url));
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({
      data: { settings: { businessStartDate: null, cutoverOn: '2026-11-07', currentBusinessType: 'soleProprietor', soleBusinessEndedOn: '2026-08-31', version: '1', soleEndChanges: [change] } },
      permissions: { manageSettings: false },
    });
    expect(seq).toEqual(['auth', 'rpc:get_accounting_settings']);
    grants.current = [MANAGE];
    expect((await settingsGet(new Request(url))).status).toBe(403);
  });

  test('FREQ-561-AC-03: 設定のPUTは開業日の選び直しを409とSETTINGS_LOCKEDで返す', async () => {
    state.before = settingsRow({ business_start_date: '2025-04-01', version: '2' });
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_update_accounting_settings' ? dbError('ACCOUNTING_SETTINGS_LOCKED', '55000') : defaultRpc(name)));
    const response = await settingsPut(put({ ...body, businessStartDate: '2025-05-01', expectedVersion: '2' }));
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({ code: 'ACCOUNTING_SETTINGS_LOCKED', error: '開業日は一度入れると選び直せません。' });
    expect(mockAudit).toHaveBeenCalledWith({ action: 'admin.accounting.settings.update', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'failure', metadata: { result_code: 'ACCOUNTING_SETTINGS_LOCKED' } });
  });

  test('FREQ-555-AC-06: 設定の版が違えばVERSION_CONFLICTを返す', async () => {
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_update_accounting_settings' ? dbError('ACCOUNTING_VERSION_CONFLICT', '40001') : defaultRpc(name)));
    const response = await settingsPut(put());
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({ code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' });
    // 同じ文でも SQLSTATE が違えば分類しない（固定の500）。
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_update_accounting_settings' ? dbError('ACCOUNTING_VERSION_CONFLICT', '23505') : defaultRpc(name)));
    const unknown = await settingsPut(put());
    expect([unknown.status, await read(unknown)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
  });

  test('FREQ-561-AC-04: 監査に名前・金額・開業日の値を入れない', async () => {
    const response = await settingsPut(new Request(url, { method: 'PUT', body: JSON.stringify(body), headers: { 'x-forwarded-for': '203.0.113.9' } }));
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({ data: { settings: expect.objectContaining({ businessStartDate: '2025-04-01', version: '2' }) } });
    // 認可 → CSRF → IP → actor → 入力 → 前の設定の読み → 書き込み → 監査。
    expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', 'rpc:get_accounting_settings', 'rpc:admin_update_accounting_settings', 'audit']);
    expect(rpcImpl).toHaveBeenLastCalledWith('admin_update_accounting_settings', {
      _actor_id: ACTOR, _business_start_date: '2025-04-01', _current_business_type: 'soleProprietor', _expected_version: '1', _request_key: KEY,
    });
    expect(mockAudit).toHaveBeenCalledWith({ action: 'admin.accounting.settings.update', actor_id: ACTOR, resource: 'accounting', resource_id: null, outcome: 'success', metadata: { changed_fields: ['businessStartDate'] } });
    // 事業の形だけを変えた時は名前だけ。再送（変わらない）は空。
    state.before = settingsRow({ business_start_date: '2025-04-01', version: '2' });
    state.after = settingsRow({ business_start_date: '2025-04-01', current_business_type: 'corporation', version: '3' });
    await settingsPut(put({ ...body, currentBusinessType: 'corporation', expectedVersion: '2' }));
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { changed_fields: ['currentBusinessType'] } }));
    state.before = state.after;
    await settingsPut(put({ ...body, currentBusinessType: 'corporation', expectedVersion: '3' }));
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { changed_fields: [] } }));
    const audit = JSON.stringify(mockAudit.mock.calls);
    for (const secret of ['2025-04-01', 'owner@example.test', '2026-11-07']) expect(audit).not.toContain(secret);
  });

  test('FREQ-561-AC-03: 設定のPUTは権限・CSRF・回数の制限・入力で断るとstoreを呼ばない', async () => {
    const stops: [string, () => void, number][] = [
      ['aal1', () => (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') })), 403],
      ['権限なし', () => { grants.current = [READ]; }, 403],
      ['CSRF', () => mockCsrf.mockImplementationOnce(() => new Response('{}', { status: 403 })), 403],
      ['IP 429', () => mockRate.mockImplementationOnce(async () => new Response('{}', { status: 429 })), 429],
    ];
    for (const [label, arrange, status] of stops) {
      grants.current = [READ, MANAGE]; rpcImpl.mockClear(); mockAudit.mockClear();
      arrange();
      const denied = await settingsPut(put());
      expect([label, denied.status]).toEqual([label, status]);
      expect(denied.headers.get('cache-control')).toContain('no-store');
      expect(rpcImpl).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
    }
    rpcImpl.mockClear();
    for (const value of [{ ...body, businessStartDate: '2025-13-01' }, { ...body, currentBusinessType: 'other' }, { ...body, expectedVersion: '0x1' }, { ...body, soleBusinessEndedOn: '2026-08-31' }, { businessStartDate: null }]) {
      const bad = await settingsPut(put(value));
      expect([bad.status, await read(bad)]).toEqual([400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
    }
    expect(rpcImpl).not.toHaveBeenCalled();
    // 開業日を空のまま事業の形だけ変える本文は受ける（NULL は DB が判定する）。
    state.after = settingsRow({ current_business_type: 'corporation', version: '2' });
    expect((await settingsPut(put({ ...body, businessStartDate: null, currentBusinessType: 'corporation' }))).status).toBe(200);
  });
});
