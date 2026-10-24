export {};

// 窓口・認可（admin-rbac）・回数の制限（rateLimit）・CSRF の確かめ・監査（audit）は本物を通し、
// 外との境目（Supabase の client・token の検証・回数の数え場所・Cookie と見出し・応答の型）だけを差し替える
// 応答の型は、拒否の応答を状態と本文だけの入れ物で渡す CSRF の確かめの形（_body）に合わせる
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      _body: body,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
  incrementCounterBy: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { cookies, headers } = require('next/headers');
const { tokenHashSha256 } = require('@/lib/hash');

type Result = { data: unknown; error: unknown };
type Outcome = Result | { throws: unknown };
type Op = 'select' | 'insert' | 'update' | 'delete';
type Call = [string, unknown[]];
type TableOp = { table: string; op: Op; calls: Call[] };
type Tables = Record<string, Partial<Record<Op, Outcome>>>;

// 表への呼び出しを、最初の操作（select・insert・update・delete）ごとに用意した結果で返す
function createFakeClient(tables: Tables) {
  const ops: TableOp[] = [];
  const seq: string[] = [];
  return {
    ops,
    seq,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, op: 'select', calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'single', 'maybeSingle']) {
        builder[m] = (...args: unknown[]) => {
          if (op.calls.length === 0 && (m === 'select' || m === 'insert' || m === 'update' || m === 'delete')) {
            op.op = m;
            seq.push(`${table}.${m}`);
          }
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
        const outcome = tables[table]?.[op.op] ?? { data: null, error: null };
        if ('throws' in outcome) return Promise.reject(outcome.throws).then(onF, onR);
        return Promise.resolve(outcome).then(onF, onR);
      };
      return builder;
    }),
  };
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let client: ReturnType<typeof createFakeClient>;

// 認可に使う user_roles と監査の audit_logs は既定で用意し、取扱店の表の結果だけを呼び側が渡す。
// refreshCookie を渡すと session のある要求になり、csrfHeader を渡すと X-CSRF-Token の見出しも付く
function setup(
  options: {
    codes?: string[];
    aal?: string;
    tables?: Tables;
    refreshCookie?: string;
    csrfHeader?: string;
  } = {}
) {
  client = createFakeClient({
    user_roles: {
      select: { data: aclRows(options.codes ?? ['admin.stockists.read', 'admin.stockists.manage']), error: null },
    },
    audit_logs: { insert: { data: null, error: null } },
    ...options.tables,
  });
  createClient.mockResolvedValue(client);
  createServiceRoleClient.mockResolvedValue(client);
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
  incrementCounter.mockResolvedValue(1);
  cookies.mockResolvedValue({
    get: (name: string) => (name === 'sb-refresh-token' && options.refreshCookie ? { value: options.refreshCookie } : undefined),
  });
  headers.mockResolvedValue({
    get: (name: string) => (name === 'x-csrf-token' ? (options.csrfHeader ?? null) : null),
  });
}

function auditRows() {
  return client.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

// 認可・CSRF・監査の呼び出しを除いた、取扱店の表への操作の順番
function dataSeq() {
  return client.seq.filter((s) => !['user_roles.select', 'audit_logs.insert', 'sessions.select'].includes(s));
}

function tableCalls(table: string, op: Op) {
  return client.ops.filter((o) => o.table === table && o.op === op).map((o) => o.calls);
}

// 日付だけ固定する（タイマーと microtask は本物のまま）。0時をまたぐ実行で「今日」が割れないようにする
const FROZEN_NOW = new Date('2026-10-24T12:00:00.000Z');
const BUCKET_ISO = '2026-10-24T12:00:00.000Z';
function freezeDateOnly() {
  jest.useFakeTimers({
    now: FROZEN_NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
}

function baseHeaders(name: string, userAgent: string | null | undefined, forwarded: string | null | undefined) {
  const lower = name.toLowerCase();
  if (lower === 'user-agent') return userAgent === undefined ? 'jest-agent' : userAgent;
  if (lower === 'x-forwarded-for') return forwarded === undefined ? '203.0.113.9, 10.0.0.1' : forwarded;
  return null;
}

// 試験の環境の Request は使わず、route が読む headers と json だけを持つ形を渡す
function makeRequest(
  options: { body?: unknown; jsonError?: Error; userAgent?: string | null; forwarded?: string | null } = {}
) {
  return {
    headers: { get: (name: string) => baseHeaders(name, options.userAgent, options.forwarded) },
    json: jest.fn(async () => {
      if (options.jsonError) throw options.jsonError;
      return options.body;
    }),
  } as unknown as Request;
}

function jsonMock(request: Request) {
  return (request as unknown as { json: jest.Mock }).json;
}

function beforeEachCommon() {
  freezeDateOnly();
  jest.clearAllMocks();
  delete process.env.ALERT_AUDIT_URL;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
}

function afterEachCommon() {
  jest.restoreAllMocks();
  jest.useRealTimers();
}

const { GET } = require('@/app/api/admin/stockists/[id]/route');

const stockistRow = {
  id: 7,
  name: 'ATELIER SHIBUYA',
  address: '東京都渋谷区神南1-2-3',
  phone: '03-1234-5678',
  time: '11:00-19:00',
  holiday: '水曜',
  status: 'private',
  type: 'select',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
};

function stockistTables(select: Outcome = { data: stockistRow, error: null }): Tables {
  return { stockists: { select } };
}

describe('GET /api/admin/stockists/[id]（管理の取扱店の1件）', () => {
  beforeEach(beforeEachCommon);
  afterEach(afterEachCommon);

  test.each(['abc', '0', '-1', '1.5', '', ' ', 'NaN', 'Infinity'])(
    'API-STOCKIST-003 id が正の整数でない %j は認可より前に 400 Invalid stockist id で断り、何も触らない',
    async (id) => {
      setup({ tables: stockistTables() });

      const res = await GET(makeRequest(), ctx(id));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid stockist id' });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(client.seq).toEqual([]);
    }
  );

  test('API-STOCKIST-003 ログインしていない要求にも、id の形が悪ければ 401 でなく 400 を返す（推定）', async () => {
    setup({ tables: stockistTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

    const res = await GET(makeRequest(), ctx('abc'));

    expect(res.status).toBe(400);
  });

  test('API-STOCKIST-003 token が検証で断られたら 401 で断り、取扱店の表を触らない', async () => {
    setup({ tables: stockistTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 session が失効していれば 401、確かめられなければ 503 Retry-After 30 で断る', async () => {
    setup({ tables: stockistTables() });
    checkAuthSessionLiveness.mockResolvedValue('revoked');
    const revoked = await GET(makeRequest(), ctx());
    expect(revoked.status).toBe(401);

    checkAuthSessionLiveness.mockResolvedValue('unavailable');
    const unavailable = await GET(makeRequest(), ctx());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 admin.stockists.read が無ければ（manage だけでは）403 で断り、表も触らない', async () => {
    setup({ codes: ['admin.stockists.manage'], tables: stockistTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.read' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1', tables: stockistTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', reason: 'MFA required', permission: 'admin.stockists.read' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 閲覧の権限だけで読め、読みの枠 120回／10分を送り元と操作者の2段で数える', async () => {
    setup({ codes: ['admin.stockists.read'], tables: stockistTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.9',
      endpoint: 'admin:stockists:read',
      bucket: BUCKET_ISO,
      subject: null,
    });
    expect(incrementCounter).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9',
      endpoint: 'admin:stockists:read',
      bucket: BUCKET_ISO,
      subject: 'admin-1',
    });
  });

  test('API-STOCKIST-003 送り元の段で121回目になると 429 Retry-After 600 で断り、操作者の段を数えず表も触らない', async () => {
    setup({ tables: stockistTables() });
    incrementCounter.mockResolvedValue(121);

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 両方の段が120回目までは通し、送り元が空いていても操作者の段が121回目なら 429 で断る', async () => {
    setup({ tables: stockistTables() });
    incrementCounter.mockResolvedValue(120);
    const ok = await GET(makeRequest(), ctx());
    expect(ok.status).toBe(200);

    incrementCounter.mockReset();
    incrementCounter.mockResolvedValueOnce(1).mockResolvedValueOnce(121);
    const limited = await GET(makeRequest(), ctx());

    expect(limited.status).toBe(429);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'admin-1' }));
  });

  test('API-STOCKIST-003 回数の数え場所が使えなければ 503 Retry-After 600 で断り、表を触らない', async () => {
    setup({ tables: stockistTables() });
    incrementCounter.mockRejectedValue(new Error('counter down'));

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-003 全部の列を 200 の data に返し、id は数に直して利用者の client で引く', async () => {
    setup({ tables: stockistTables() });
    const request = makeRequest();

    const res = await GET(request, ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: stockistRow });
    expect(createClient).toHaveBeenCalledWith(request);
    expect(tableCalls('stockists', 'select')).toEqual([[['select', ['*']], ['eq', ['id', 7]], ['single', []]]]);
  });

  test('API-STOCKIST-003 先頭の 0 や指数の書き方の id も、数に直した値で引く（推定）', async () => {
    setup({ tables: stockistTables() });

    await GET(makeRequest(), ctx('007'));
    await GET(makeRequest(), ctx('1e2'));

    expect(tableCalls('stockists', 'select').map((c) => c[1])).toEqual([['eq', ['id', 7]], ['eq', ['id', 100]]]);
  });

  test('API-STOCKIST-003 読むだけで、CSRF の token も監査も使わず表を書き換えない', async () => {
    setup({ refreshCookie: 'refresh-1', tables: stockistTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(0);
    expect(client.seq.filter((s) => s === 'sessions.select')).toHaveLength(0);
    expect(dataSeq()).toEqual(['stockists.select']);
  });

  test('API-STOCKIST-003 行が無ければ 404 Stockist not found を返す', async () => {
    setup({ tables: stockistTables({ data: null, error: null }) });

    const res = await GET(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Stockist not found' });
  });

  test('API-STOCKIST-003 DB の誤りも無い行と同じ 404 Stockist not found にする（推定）', async () => {
    setup({ tables: stockistTables({ data: null, error: { message: 'connection reset' } }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Stockist not found' });
  });

  test('API-STOCKIST-003 誤りと行が両方返っても、誤りがあれば 404 にする', async () => {
    setup({ tables: stockistTables({ data: stockistRow, error: { message: 'partial' } }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(404);
  });

  test('API-STOCKIST-003 表の引きで例外が出たら 500 Internal server error を返す', async () => {
    setup({ tables: stockistTables({ throws: new Error('db down') }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-STOCKIST-003 client を作れない例外も 500 Internal server error を返す', async () => {
    setup({ tables: stockistTables() });
    createClient.mockRejectedValue(new Error('no client'));

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-STOCKIST-003 道の params を解けない例外も 500 Internal server error を返す', async () => {
    setup({ tables: stockistTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
