/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
// 認可の実装(admin-rbac)は本物を使い、その下の依存(トークン検証・session生存・ACL照会)だけを差し替える。
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as periodsGet, POST as periodsPost } from '@/app/api/admin/accounting/periods/route';
import { POST as finalSolePost } from '@/app/api/admin/accounting/periods/[id]/final-sole/route';
import { PUT as filingPut } from '@/app/api/admin/accounting/periods/[id]/filing/route';
import { filingDeadlines } from '@/lib/accounting/filing-deadlines';
import { isJpHoliday } from '@/lib/accounting/jp-holidays';
import { startupDeadlines } from '@/lib/accounting/startup-deadlines';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = uuid(90); const KEY = uuid(91); const SOLE = uuid(1); const CORP = uuid(2); const NEW = uuid(3);
const READ = 'admin.finance.read'; const MANAGE = 'admin.accounting.settings.manage';
const claims = (aal: string) => ({ sub: ACTOR, session_id: 'session-1', aal, email: 'owner@example.test', app_metadata: { role: 'admin' } });

const periodRow = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, business_type: 'soleProprietor', name: '2026年（個人）', starts_on: '2026-01-01', ends_on: '2026-12-31',
  corporate_tax_extension_months: 0, consumption_tax_extension_months: 0, consumption_tax_status: 'exempt',
  consumption_taxable_from: null, version: '1', legacy_fiscal_year: 2026, ...overrides,
});
const corpRow = periodRow(CORP, {
  business_type: 'corporation', name: '第1期', starts_on: '2027-07-01', ends_on: '2028-06-30', consumption_tax_status: 'taxable',
  consumption_taxable_from: '2027-07-01', legacy_fiscal_year: null,
});
const settingsRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  business_start_date: '2025-04-01', cutover_on: '2026-11-07', current_business_type: 'soleProprietor', sole_business_ended_on: null,
  version: '4', sole_end_changes: [], ...overrides,
});
const camel = (row: Record<string, unknown>) => ({
  id: row.id, businessType: row.business_type, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on,
  corporateTaxExtensionMonths: row.corporate_tax_extension_months, consumptionTaxExtensionMonths: row.consumption_tax_extension_months,
  consumptionTaxStatus: row.consumption_tax_status, consumptionTaxableFrom: row.consumption_taxable_from, version: row.version,
});

const seq: string[] = [];
const rpcImpl = jest.fn();
const grants = { current: [READ, MANAGE] as string[] };
const db = { periods: [] as Record<string, unknown>[], settings: settingsRow() };
const service = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, or: async () => ({ data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }], error: null }) };
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => { seq.push(`rpc:${name}`); return rpcImpl(name, args); },
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
  switch (name) {
    case 'list_accounting_periods': return { data: db.periods, error: null };
    case 'get_accounting_settings': return { data: db.settings, error: null };
    case 'admin_create_accounting_period': return { data: periodRow(NEW, { starts_on: '2027-01-01', ends_on: '2027-12-31', name: '2027年（個人）', legacy_fiscal_year: 2027 }), error: null };
    case 'admin_shorten_final_sole_period': return { data: periodRow(SOLE, { ends_on: '2026-08-31', version: '2' }), error: null };
    case 'admin_update_accounting_period_filing': return { data: { ...corpRow, version: '2' }, error: null };
    default: throw new Error(`unexpected rpc ${name}`);
  }
};
const dbError = (message: string, code: string) => ({ data: null, error: { message, code, details: null, hint: null } });

const base = 'https://example.test/api/admin/accounting/periods';
const ctx = (value = SOLE) => ({ params: Promise.resolve({ id: value }) });
const createBody = { businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-12-31', requestKey: KEY };
const finalSoleBody = { endedOn: '2026-08-31', expectedPeriodVersion: '1', expectedSettingsVersion: '4', requestKey: KEY };
const filingBody = {
  corporateTaxExtensionMonths: 1, consumptionTaxExtensionMonths: 1, consumptionTaxStatus: 'taxable',
  consumptionTaxableFrom: '2027-07-01', expectedVersion: '1', requestKey: KEY,
};
const post = (body: unknown, method = 'POST', suffix = '') =>
  new Request(`${base}${suffix}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'x-forwarded-for': '203.0.113.9' } });

type WriteCase = { name: string; call: (body?: unknown) => Promise<Response>; body: Record<string, unknown>; rpc: string; action: string; status: number; resourceId: string };
const writes: WriteCase[] = [
  { name: 'create', call: (b = createBody) => periodsPost(post(b)), body: createBody, rpc: 'admin_create_accounting_period', action: 'admin.accounting.period.create', status: 201, resourceId: NEW },
  { name: 'final-sole', call: (b = finalSoleBody) => finalSolePost(post(b, 'POST', `/${SOLE}/final-sole`), ctx()), body: finalSoleBody, rpc: 'admin_shorten_final_sole_period', action: 'admin.accounting.period.final_sole', status: 200, resourceId: SOLE },
  { name: 'filing', call: (b = filingBody) => filingPut(post(b, 'PUT', `/${CORP}/filing`), ctx(CORP)), body: filingBody, rpc: 'admin_update_accounting_period_filing', action: 'admin.accounting.period.filing', status: 200, resourceId: CORP },
];
async function read(response: Response) {
  expect(response.headers.get('cache-control')).toContain('no-store');
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  jest.resetAllMocks();
  seq.length = 0; grants.current = [READ, MANAGE];
  db.periods = [periodRow(SOLE)]; db.settings = settingsRow();
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
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('GET /api/admin/accounting/periods', () => {
  test('FREQ-561-AC-01: 期間の一覧は期間ごとの期限と開業日の期限を含む', async () => {
    // Date だけを止める（Promise・stream の timer は本物のまま）。2026-11-07 12:00 JST。
    jest.useFakeTimers({ now: new Date('2026-11-07T03:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
    db.periods = [periodRow(SOLE), corpRow];
    const response = await periodsGet(new Request(base));
    expect(response.status).toBe(200);
    const body = await read(response);
    const sole = camel(periodRow(SOLE)) as never; const corp = camel(corpRow) as never;
    expect(body).toEqual({
      data: {
        periods: [sole, corp],
        settings: { businessStartDate: '2025-04-01', cutoverOn: '2026-11-07', currentBusinessType: 'soleProprietor', soleBusinessEndedOn: null, version: '4', soleEndChanges: [] },
        deadlines: { [SOLE]: filingDeadlines(sole, isJpHoliday).deadlines, [CORP]: filingDeadlines(corp, isJpHoliday).deadlines },
        interim: { [SOLE]: [], [CORP]: filingDeadlines(corp, isJpHoliday).interim },
        startup: startupDeadlines('2025-04-01', '2026-11-07', isJpHoliday),
      },
      permissions: { manageSettings: true },
    });
    const data = body.data as { deadlines: Record<string, { tax: string; due: string }[]>; startup: { kind: string; passed: boolean }[] };
    // 個人の2026年分は所得税だけ（免税）。法人の第1期は法人税・地方税・課税なので消費税も。
    expect(data.deadlines[SOLE].map((d) => [d.tax, d.due])).toEqual([['income_tax', '2027-03-15']]);
    expect(data.deadlines[CORP].map((d) => [d.tax, d.due])).toEqual([['corporate_tax', '2028-08-31'], ['local_tax', '2028-08-31'], ['consumption_tax_corporate', '2028-08-31']]);
    expect(data.startup.find((s) => s.kind === 'inventory_method_notice')).toMatchObject({ dueOn: '2026-03-16', passed: true });
    expect(seq).toEqual(['auth', 'rpc:list_accounting_periods', 'rpc:get_accounting_settings']);
    expect(mockRate).not.toHaveBeenCalled(); expect(mockCsrf).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });

  test('FREQ-561-AC-01: 祝日の表の無い年の期限は落とさずholidayTableMissingで返す', async () => {
    db.periods = [periodRow(SOLE, { starts_on: '2030-01-01', ends_on: '2030-12-31', name: '2030年（個人）' })];
    const response = await periodsGet(new Request(base));
    expect(response.status).toBe(200);
    const data = (await read(response)).data as { deadlines: Record<string, unknown[]> };
    expect(data.deadlines[SOLE]).toEqual([{ tax: 'income_tax', baseDue: '2031-03-15', due: '2031-03-15', rolled: false, extended: false, holidayTableMissing: true, note: '' }]);
  });

  test('FREQ-555-AC-04: 期間が1つも無いときは404でなく空の一覧を返す', async () => {
    db.periods = []; db.settings = settingsRow({ business_start_date: null });
    grants.current = [READ];
    const response = await periodsGet(new Request(base));
    expect(response.status).toBe(200);
    const body = await read(response);
    expect(body).toEqual({
      data: { periods: [], settings: expect.objectContaining({ businessStartDate: null }), deadlines: {}, interim: {}, startup: [] },
      permissions: { manageSettings: false },
    });
  });

  test('FREQ-555-AC-04: 読みはadmin.finance.readを求め、DBの失敗は固定の500で返す', async () => {
    grants.current = [MANAGE];
    expect((await periodsGet(new Request(base))).status).toBe(403);
    (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
    grants.current = [READ];
    expect((await periodsGet(new Request(base))).status).toBe(403);
    expect(seq.filter((s) => s.startsWith('rpc:'))).toEqual([]);
    rpcImpl.mockResolvedValueOnce(dbError('relation "secret" does not exist', '42P01'));
    const failed = await periodsGet(new Request(base));
    expect(failed.status).toBe(500);
    expect(await read(failed)).toEqual({ error: '会計の処理に失敗しました。' });
  });
});

describe('accounting period writes', () => {
  test('FREQ-555-AC-01: 期間の作成routeはaal1/権限なし/CSRF欠落/429/不正入力でstoreを呼ばない', async () => {
    for (const c of writes) {
      // 全部通る順序。actor は認可結果の userId だけ、IP は request を渡して getClientIp に任せる。
      seq.length = 0; mockRate.mockClear(); mockAudit.mockClear();
      const ok = await c.call();
      expect([c.name, ok.status]).toEqual([c.name, c.status]);
      const reads = c.name === 'create' ? ['rpc:list_accounting_periods'] : [];
      const reloads = c.name === 'final-sole' ? ['rpc:list_accounting_periods', 'rpc:get_accounting_settings'] : [];
      expect(seq).toEqual(['auth', 'csrf', 'admin.accounting.write:ip', 'admin.accounting.write:actor', ...reads, `rpc:${c.rpc}`, 'audit', ...reloads]);
      for (const [arg] of mockRate.mock.calls as [Record<string, unknown>][]) expect(arg).toMatchObject({ endpoint: 'admin.accounting.write', limit: 30, windowSeconds: 600 });
      expect((mockRate.mock.calls[1][0] as { subject: string }).subject).toBe(ACTOR);
      expect(mockAudit).toHaveBeenCalledWith({ action: c.action, actor_id: ACTOR, resource: 'accounting', resource_id: c.resourceId, outcome: 'success', metadata: { period_id: c.resourceId, result_code: 'ok' } });
      expect((rpcImpl.mock.calls.find(([name]) => name === c.rpc) as [string, Record<string, unknown>])[1]._actor_id).toBe(ACTOR);

      const stops: [string, () => void, number, string[]][] = [
        ['aal1', () => (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => { seq.push('auth'); return { ok: true, claims: claims('aal1') }; }), 403, ['auth']],
        ['権限なし', () => { grants.current = [READ]; }, 403, ['auth']],
        ['CSRF', () => mockCsrf.mockImplementationOnce(() => { seq.push('csrf'); return new Response('{}', { status: 403 }); }), 403, ['auth', 'csrf']],
        ['IP 429', () => mockRate.mockImplementationOnce(async () => { seq.push('ip'); return new Response('{}', { status: 429, headers: { 'Retry-After': '600' } }); }), 429, ['auth', 'csrf', 'ip']],
        ['actor 429', () => mockRate.mockImplementationOnce(async () => { seq.push('ip'); }).mockImplementationOnce(async () => { seq.push('actor'); return new Response('{}', { status: 429 }); }), 429, ['auth', 'csrf', 'ip', 'actor']],
      ];
      for (const [label, arrange, status, expected] of stops) {
        seq.length = 0; grants.current = [READ, MANAGE]; mockAudit.mockClear(); rpcImpl.mockClear();
        arrange();
        const denied = await c.call();
        expect([c.name, label, denied.status, seq]).toEqual([c.name, label, status, expected]);
        expect(denied.headers.get('cache-control')).toContain('no-store');
        if (label === 'IP 429') expect(denied.headers.get('retry-after')).toBe('600');
        expect(rpcImpl).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
        mockRate.mockReset().mockImplementation(async (arg: { endpoint: string; subject?: string }) => { seq.push(`${arg.endpoint}:${arg.subject ? 'actor' : 'ip'}`); return undefined; });
      }

      // 不正な入力: store を呼ばず 400 と固定コード。監査は結果コードだけ。
      rpcImpl.mockClear(); mockAudit.mockClear();
      const bodies: unknown[] = [null, 'x', {}, { ...c.body, requestKey: 'bad' }, { ...c.body, actorId: ACTOR }, { ...c.body, name: '勝手な名前' }];
      for (const body of bodies) {
        const bad = await c.call(body);
        expect([c.name, bad.status, await read(bad)]).toEqual([c.name, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
      }
      expect(rpcImpl).not.toHaveBeenCalled();
      const failed = c.name === 'create' ? { result_code: 'ACCOUNTING_ARGUMENT_INVALID' } : { period_id: c.resourceId, result_code: 'ACCOUNTING_ARGUMENT_INVALID' };
      expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: c.action, outcome: 'failure', metadata: failed }));
    }
    // [id] が UUID でなければ store を呼ばない。
    rpcImpl.mockClear();
    expect((await finalSolePost(post(finalSoleBody), ctx('not-a-uuid'))).status).toBe(400);
    expect((await filingPut(post(filingBody, 'PUT'), ctx('1'))).status).toBe(400);
    expect(rpcImpl).not.toHaveBeenCalled();
  });

  test('FREQ-555-AC-01: 期間の作成は事前検査と同じcodeでDBの拒否を返す', async () => {
    const cases: [string, Record<string, string>, Record<string, unknown>[], string, string][] = [
      ['overlap', { businessType: 'corporation', startsOn: '2028-01-01', endsOn: '2028-12-31' }, [corpRow], 'ACCOUNTING_PERIOD_OVERLAP', '会計の期間が重なっています。'],
      ['gap', { businessType: 'corporation', startsOn: '2028-08-01', endsOn: '2029-06-30' }, [corpRow], 'ACCOUNTING_PERIOD_GAP', '会計の期間にすき間があります。'],
      ['too_long', { businessType: 'corporation', startsOn: '2028-07-01', endsOn: '2029-07-01' }, [corpRow], 'ACCOUNTING_PERIOD_TOO_LONG', '会計の期間は1年を超えられません。'],
    ];
    for (const [label, range, existing, code, message] of cases) {
      const body = { ...range, requestKey: KEY };
      // ① 事前検査で断る: 書き込みは呼ばない。
      db.periods = existing; seq.length = 0; mockAudit.mockClear();
      const early = await periodsPost(post(body));
      expect([label, early.status, await read(early)]).toEqual([label, 409, { code, error: message }]);
      expect(seq.filter((s) => s.startsWith('rpc:'))).toEqual(['rpc:list_accounting_periods']);
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { result_code: code } }));
      // ② 事前検査を通っても DB が同じ code で断れば、同じ応答。
      db.periods = []; seq.length = 0;
      rpcImpl.mockImplementation(async (name: string) => (name === 'admin_create_accounting_period' ? dbError(code, '23514') : defaultRpc(name)));
      const late = await periodsPost(post({ ...body, ...(label === 'too_long' ? { startsOn: '2028-07-01', endsOn: '2029-06-30' } : {}) }));
      expect([label, late.status, await read(late)]).toEqual([label, 409, { code, error: message }]);
      expect(seq.filter((s) => s.startsWith('rpc:'))).toEqual(['rpc:list_accounting_periods', 'rpc:admin_create_accounting_period']);
      rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
    }
    // 始まりより前の終わり・暦年でない個人は 400 の入力の拒否（code は DB と同じ ACCOUNTING_ARGUMENT_INVALID）。
    for (const range of [{ businessType: 'corporation', startsOn: '2028-07-01', endsOn: '2028-06-30' }, { businessType: 'soleProprietor', startsOn: '2027-02-01', endsOn: '2027-12-31' }]) {
      db.periods = [periodRow(SOLE)]; rpcImpl.mockClear();
      const bad = await periodsPost(post({ ...range, requestKey: KEY }));
      expect([bad.status, await read(bad)]).toEqual([400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
      expect(rpcImpl.mock.calls.map(([name]) => name)).toEqual(['list_accounting_periods']);
    }
    // 成功: name はサーバーが作り、201 で期間を返す。
    db.periods = [periodRow(SOLE)];
    const created = await periodsPost(post(createBody));
    expect(created.status).toBe(201);
    expect(await read(created)).toEqual({ data: { period: expect.objectContaining({ id: NEW, name: '2027年（個人）', startsOn: '2027-01-01' }) } });
    expect(rpcImpl).toHaveBeenLastCalledWith('admin_create_accounting_period', expect.objectContaining({ _name: '2027年（個人）', _request_key: KEY }));
  });

  test('FREQ-555-AC-07: 最後の個人の期間のrouteは権限・CSRF・版を確かめ後の日の仕訳の拒否を409で返す', async () => {
    const changed = { previousEndedOn: null, newEndedOn: '2026-08-31', reason: '', changedAt: '2026-11-07T03:00:00+00:00' };
    db.periods = [periodRow(SOLE, { ends_on: '2026-08-31', version: '2' })];
    db.settings = settingsRow({ sole_business_ended_on: '2026-08-31', version: '5', sole_end_changes: [changed] });
    const ok = await finalSolePost(post({ ...finalSoleBody, reason: '法人へ移るため' }), ctx());
    expect(ok.status).toBe(200);
    // 成功後は期間と設定を読み直して返す。
    expect(await read(ok)).toEqual({
      data: {
        period: expect.objectContaining({ id: SOLE, endsOn: '2026-08-31', version: '2' }),
        periods: [expect.objectContaining({ id: SOLE, endsOn: '2026-08-31' })],
        settings: expect.objectContaining({ soleBusinessEndedOn: '2026-08-31', version: '5', soleEndChanges: [changed] }),
      },
    });
    expect(rpcImpl).toHaveBeenCalledWith('admin_shorten_final_sole_period', {
      _actor_id: ACTOR, _period_id: SOLE, _ended_on: '2026-08-31', _expected_period_version: '1', _expected_settings_version: '4', _reason: '法人へ移るため', _request_key: KEY,
    });
    // 監査は期間の番号と結果だけ。日付・理由は入れない。
    const audit = JSON.stringify(mockAudit.mock.calls);
    expect(audit).not.toContain('2026-08-31'); expect(audit).not.toContain('法人へ移るため');

    // 版の誤り（10進でない版）は store を呼ばず 400。
    rpcImpl.mockClear();
    for (const body of [{ ...finalSoleBody, expectedPeriodVersion: 'v1' }, { ...finalSoleBody, expectedSettingsVersion: 1 }, { ...finalSoleBody, endedOn: '2026-02-30' }, { ...finalSoleBody, reason: 'x'.repeat(501) }]) {
      const bad = await finalSolePost(post(body), ctx());
      expect([body, bad.status, await read(bad)]).toEqual([body, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
    }
    expect(rpcImpl).not.toHaveBeenCalled();

    // DB の拒否: 版の衝突・後の日の仕訳・権限。
    const rejections: [string, string, number, string][] = [
      ['ACCOUNTING_VERSION_CONFLICT', '40001', 409, '設定が変わりました。読み直してください。'],
      ['ACCOUNTING_PERIOD_SHORTEN_BLOCKED', '55000', 409, 'やめた日を変えられません。やめた日より後の日付の仕訳が無いか確かめてください。'],
      ['ACCOUNTING_FORBIDDEN', '42501', 403, '会計を操作する権限がありません。'],
    ];
    for (const [code, sqlstate, status, message] of rejections) {
      rpcImpl.mockImplementation(async (name: string) => (name === 'admin_shorten_final_sole_period' ? dbError(code, sqlstate) : defaultRpc(name)));
      mockAudit.mockClear(); seq.length = 0;
      const denied = await finalSolePost(post(finalSoleBody), ctx());
      expect([code, denied.status, await read(denied)]).toEqual([code, status, { code, error: message }]);
      expect(seq).not.toContain('rpc:list_accounting_periods');
      expect(mockAudit).toHaveBeenCalledWith({ action: 'admin.accounting.period.final_sole', actor_id: ACTOR, resource: 'accounting', resource_id: SOLE, outcome: 'failure', metadata: { period_id: SOLE, result_code: code } });
    }
  });

  test('FREQ-561-AC-01: 申告の設定のPUTは課税事業者になった日と延長を渡し、免税で日付があれば断る', async () => {
    const ok = await filingPut(post(filingBody, 'PUT'), ctx(CORP));
    expect(ok.status).toBe(200);
    expect(await read(ok)).toEqual({ data: { period: expect.objectContaining({ id: CORP, version: '2' }) } });
    expect(rpcImpl).toHaveBeenCalledWith('admin_update_accounting_period_filing', {
      _actor_id: ACTOR, _period_id: CORP, _corporate_tax_extension_months: 1, _consumption_tax_extension_months: 1,
      _consumption_tax_status: 'taxable', _consumption_taxable_from: '2027-07-01', _expected_version: '1', _request_key: KEY,
    });
    rpcImpl.mockClear();
    for (const body of [
      { ...filingBody, consumptionTaxStatus: 'exempt' },
      { ...filingBody, consumptionTaxableFrom: null },
      { ...filingBody, corporateTaxExtensionMonths: 0 },
      { ...filingBody, corporateTaxExtensionMonths: 2 },
    ]) expect((await filingPut(post(body, 'PUT'), ctx(CORP))).status).toBe(400);
    expect(rpcImpl).not.toHaveBeenCalled();
  });

  test('FREQ-561-AC-04: 期間の監査に名前・日付・メールを入れない', async () => {
    await periodsPost(post(createBody));
    await finalSolePost(post(finalSoleBody), ctx());
    await filingPut(post(filingBody, 'PUT'), ctx(CORP));
    const audit = JSON.stringify(mockAudit.mock.calls);
    for (const secret of ['2027年（個人）', '2027-01-01', '2026-08-31', '2027-07-01', 'owner@example.test', '第1期']) expect(audit).not.toContain(secret);
    for (const [event] of mockAudit.mock.calls as [{ metadata: Record<string, unknown> }][]) expect(Object.keys(event.metadata).sort()).toEqual(['period_id', 'result_code']);
  });
});
