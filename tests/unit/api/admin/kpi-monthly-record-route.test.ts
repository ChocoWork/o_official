/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
import { GET, PUT } from '@/app/api/admin/kpi/monthly-record/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { MONTHLY_KPI_FORMULAS, SOURCE_METRIC_KEYS, kpiOverrideStorageKey, seasonMonthKeys, sourceStorageKey } from '@/lib/kpi/monthly-metrics';

// Accounting plan 2 Task 8 (FREQ-573-AC-02, AC-03): the monthly record route reads through list_kpi_monthly_records and writes through
// admin_set_kpi_monthly_records. It never touches the table directly.
const ACTOR = '00000000-0000-4000-8000-000000000090';
const READ = 'admin.orders.read';
const claims = (aal: string, role = 'admin') => ({ sub: ACTOR, session_id: 'session-1', aal, email: 'owner@example.test', app_metadata: { role } });
const grants = { current: [READ] as string[] };
const fromCalls: string[] = [];
const rpcImpl = jest.fn();
const service = {
  from: (table: string) => {
    fromCalls.push(table);
    const chain = { select: () => chain, eq: () => chain, or: async () => ({ data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }], error: null }) };
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => rpcImpl(name, args),
};
const SEASON = '2026SS';
const MONTHS = seasonMonthKeys(SEASON);
const url = `https://example.test/api/admin/kpi/monthly-record?season=${SEASON}`;
const put = (updates: unknown, season = SEASON) => new Request(url, { method: 'PUT', body: JSON.stringify({ season, updates }) });
const dbError = (message: string, code: string) => ({ data: null, error: { message, code, details: null, hint: null } });
let stored: Array<{ month_key: string; metric_key: string; value: number | string }>;
const defaultRpc = (name: string) => {
  switch (name) {
    case 'list_kpi_monthly_records': return { data: stored, error: null };
    case 'admin_set_kpi_monthly_records': return { data: 1, error: null };
    default: throw new Error(`unexpected rpc ${name}`);
  }
};
const rpcCalls = (name: string) => rpcImpl.mock.calls.filter(([called]) => called === name) as Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  jest.resetAllMocks();
  fromCalls.length = 0; grants.current = [READ]; stored = [];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal2') }));
  (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
  (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
  rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('/api/admin/kpi/monthly-record', () => {
  test('FREQ-573-AC-03: 月の記録のrouteはaal1・権限なし・サポーターを断り、店長だけ保存できる', async () => {
    const body = [{ monthKey: MONTHS[0], metricKey: 'kpi:reach', value: 5 }];
    const cases: Array<[string, () => void, number]> = [
      ['aal1', () => (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal1') })), 403],
      ['権限なし', () => { grants.current = []; }, 403],
      ['サポーター', () => (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal2', 'supporter') })), 403],
      ['未認証', () => (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: false, reason: 'missing' })), 401],
    ];
    for (const [label, arrange, status] of cases) {
      grants.current = [READ]; rpcImpl.mockClear();
      (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal2') }));
      arrange();
      const getResponse = await GET(new Request(url));
      const putResponse = await PUT(put(body));
      expect([label, getResponse.status, putResponse.status]).toEqual([label, status, status]);
      expect(rpcImpl).not.toHaveBeenCalled();
    }
    // The owner: both go through.
    grants.current = [READ];
    (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal2') }));
    rpcImpl.mockClear();
    expect((await GET(new Request(url))).status).toBe(200);
    const saved = await PUT(put(body));
    expect(saved.status).toBe(200);
    expect(rpcCalls('admin_set_kpi_monthly_records')).toHaveLength(1);
    // The supporter's refusal keeps the body it always had.
    (verifyAccessToken as jest.Mock).mockImplementation(async () => ({ ok: true, claims: claims('aal2', 'supporter') }));
    const forbidden = await PUT(put(body));
    expect(await forbidden.json()).toEqual({ error: 'Forbidden' });
  });

  test('FREQ-573-AC-03: 保存の失敗でも本文に表の名前や作り方の案内を出さない', async () => {
    const updates = [{ monthKey: MONTHS[0], metricKey: 'kpi:reach', value: 5 }];
    const messages: Array<[string, string]> = [
      ['relation "public.admin_kpi_monthly_records" does not exist', '42P01'],
      ['migrations/063_create_admin_kpi_monthly_records.sql をSupabaseダッシュボード > SQL Editor で実行してください。', '42P01'],
      ['could not find the function public.admin_set_kpi_monthly_records in the schema cache', 'PGRST202'],
    ];
    for (const [message, code] of messages) {
      rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_kpi_monthly_records' ? dbError(message, code) : defaultRpc(name)));
      const response = await PUT(put(updates));
      const text = await response.text();
      expect([code, response.status]).toEqual([code, 500]);
      expect(JSON.parse(text)).toEqual({ error: 'Failed to update monthly record' });
      expect(text).not.toMatch(/admin_kpi_monthly_records|063|SQL Editor|テーブル|migrations?/i);
    }
    // 503 is gone: a missing table is an ordinary failure now.
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_kpi_monthly_records' ? dbError('x', '42P01') : defaultRpc(name)));
    expect((await PUT(put(updates))).status).not.toBe(503);
    // DB refusals keep their meaning: not allowed -> 403 Forbidden, a bad argument -> 400.
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_kpi_monthly_records' ? dbError('ACCOUNTING_FORBIDDEN', '42501') : defaultRpc(name)));
    const forbidden = await PUT(put(updates));
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: 'Forbidden' }]);
    rpcImpl.mockImplementation(async (name: string) => (name === 'admin_set_kpi_monthly_records' ? dbError('ACCOUNTING_ARGUMENT_INVALID', '22023') : defaultRpc(name)));
    const invalid = await PUT(put(updates));
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: 'Invalid request body' }]);
  });

  test('FREQ-573-AC-02: GETは期間の月の値を返し、表が空でも空の値を返す', async () => {
    // The table is empty: every month of the season is there, with no value.
    const empty = await GET(new Request(url));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ data: { season: SEASON, monthKeys: MONTHS, values: Object.fromEntries(MONTHS.map((month) => [month, {}])) } });
    expect(rpcCalls('list_kpi_monthly_records')[0][1]).toEqual({ _month_keys: MONTHS });
    // Values of the season (numeric comes back as a string from PostgREST), unknown keys dropped, other months not asked for.
    stored = [
      { month_key: MONTHS[0], metric_key: 'kpi:sales', value: '123.4' },
      { month_key: MONTHS[0], metric_key: 'src:reach', value: 10 },
      { month_key: MONTHS[2], metric_key: 'src:reach', value: 0 },
      { month_key: MONTHS[1], metric_key: 'src:not_a_metric', value: 7 },
      { month_key: '2020-01', metric_key: 'src:reach', value: 9 },
    ];
    const filled = await GET(new Request(url));
    const json = (await filled.json()) as { data: { values: Record<string, Record<string, number>> } };
    expect(json.data.values[MONTHS[0]]).toEqual({ 'kpi:sales': 123.4, 'src:reach': 10 });
    expect(json.data.values[MONTHS[1]]).toEqual({});
    expect(json.data.values[MONTHS[2]]).toEqual({ 'src:reach': 0 });
    expect(json.data.values['2020-01']).toBeUndefined();
    // A read that fails still answers with empty values (the screen shows an empty form), without any table text.
    rpcImpl.mockImplementation(async () => dbError('relation "public.admin_kpi_monthly_records" does not exist', '42P01'));
    const failed = await GET(new Request(url));
    expect(failed.status).toBe(200);
    const text = await failed.text();
    expect(JSON.parse(text).data.values).toEqual(Object.fromEntries(MONTHS.map((month) => [month, {}])));
    expect(text).not.toMatch(/admin_kpi_monthly_records/);
    // A season that does not exist falls back to the current one.
    rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
    expect((await GET(new Request(`${url.split('?')[0]}?season=bad`))).status).toBe(200);
  });

  test('FREQ-573-AC-02: PUTは更新を月・指標・値の形でDBの関数へ渡し、空値は削除（null）にする。表は直接読み書きしない', async () => {
    const response = await PUT(put([
      { monthKey: MONTHS[0], metricKey: 'kpi:sales', value: 123.4 },
      { monthKey: MONTHS[1], metricKey: 'src:reach', value: '' },
      { monthKey: MONTHS[2], metricKey: 'src:reach', value: 0 },
      // Outside the season, and not a known key: dropped, as before.
      { monthKey: '2020-01', metricKey: 'src:reach', value: 1 },
      { monthKey: MONTHS[3], metricKey: 'src:not_a_metric', value: 1 },
    ]));
    expect(response.status).toBe(200);
    expect(rpcCalls('admin_set_kpi_monthly_records')).toEqual([['admin_set_kpi_monthly_records', {
      _actor_id: ACTOR,
      _updates: [
        { month_key: MONTHS[0], metric_key: 'kpi:sales', value: 123.4 },
        { month_key: MONTHS[1], metric_key: 'src:reach', value: null },
        { month_key: MONTHS[2], metric_key: 'src:reach', value: 0 },
      ],
    }]]);
    // The answer is the season's values after the save (a read through the reader).
    expect(rpcImpl.mock.calls.map(([name]) => name)).toEqual(['admin_set_kpi_monthly_records', 'list_kpi_monthly_records']);
    expect(await response.json()).toEqual({ data: { season: SEASON, monthKeys: MONTHS, values: Object.fromEntries(MONTHS.map((month) => [month, {}])) } });
    // Only the access control reads a table (roles); the monthly table is never named.
    expect(fromCalls).not.toContain('admin_kpi_monthly_records');
    // Nothing to save after the filter: no call to the writer.
    rpcImpl.mockClear();
    expect((await PUT(put([{ monthKey: '2020-01', metricKey: 'src:reach', value: 1 }]))).status).toBe(200);
    expect(rpcCalls('admin_set_kpi_monthly_records')).toHaveLength(0);
    // Bad bodies are refused before the DB.
    for (const bad of [{ season: 'x', updates: [] }, { season: SEASON }, { season: SEASON, updates: [{ monthKey: '2026-04', metricKey: 'kpi:sales', value: 'a' }] }]) {
      rpcImpl.mockClear();
      expect((await PUT(new Request(url, { method: 'PUT', body: JSON.stringify(bad) }))).status).toBe(400);
      expect(rpcImpl).not.toHaveBeenCalled();
    }
    expect((await PUT(new Request(url, { method: 'PUT', body: '{' }))).status).toBe(400);
  });

  test('FREQ-573-AC-02: 1回の保存が200件を超えても、200件ずつに分けてDBの関数へ渡す', async () => {
    const keys = [...SOURCE_METRIC_KEYS.map(sourceStorageKey), ...MONTHLY_KPI_FORMULAS.map((formula) => kpiOverrideStorageKey(formula.key))];
    const updates = MONTHS.flatMap((monthKey) => keys.map((metricKey, index) => ({ monthKey, metricKey, value: index })));
    expect(updates.length).toBeGreaterThan(200);
    const response = await PUT(put(updates));
    expect(response.status).toBe(200);
    const sizes = rpcCalls('admin_set_kpi_monthly_records').map(([, args]) => (args._updates as unknown[]).length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(updates.length);
    expect(Math.max(...sizes)).toBe(200);
    expect(sizes[0]).toBe(200);
  });
});
