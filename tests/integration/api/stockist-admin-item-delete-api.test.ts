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

const { DELETE } = require('@/app/api/admin/stockists/[id]/route');

// 削除の結果は .select('id, name, address, status') で返る、消した行。1 行なら成功、0 行は「無い」か RLS が隠した場合で 404
const DELETED_ROW = { id: 7, name: 'ATELIER SHIBUYA', address: '東京都渋谷区神南1-2-3', status: 'published' };

function okTables(del: Outcome = { data: [DELETED_ROW], error: null }): Tables {
  return { stockists: { delete: del } };
}

describe('DELETE /api/admin/stockists/[id]（取扱店の削除）', () => {
  beforeEach(beforeEachCommon);
  afterEach(afterEachCommon);

  test.each(['abc', '0', '-1', '1.5', '', ' ', 'NaN', 'Infinity', '1e30', '9007199254740993'])(
    'API-STOCKIST-006 id が正の整数でない %j は認可より前に 400 Invalid stockist id で断り、本文も表も触らない',
    async (id) => {
      setup({ tables: okTables() });
      const request = makeRequest();

      const res = await DELETE(request, ctx(id));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid stockist id' });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(jsonMock(request)).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(client.seq).toEqual([]);
    }
  );

  test('API-STOCKIST-006 token が検証で断られたら 401 で断り、本文も読まず表も触らない', async () => {
    setup({ tables: okTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 session が失効していれば 401、確かめられなければ 503 Retry-After 30 で断る', async () => {
    setup({ tables: okTables() });
    checkAuthSessionLiveness.mockResolvedValue('revoked');
    const revoked = await DELETE(makeRequest(), ctx());
    expect(revoked.status).toBe(401);

    checkAuthSessionLiveness.mockResolvedValue('unavailable');
    const unavailable = await DELETE(makeRequest(), ctx());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(dataSeq()).toEqual([]);
  });

  // 現状の記録。認可で断った要求を監査に残さないのは SEC-STOCKIST-021 を満たさない欠け。直したらこの件を直す。
  test('API-STOCKIST-006 現状の記録 admin.stockists.manage が無ければ（read だけでは）403 で断り、本文も読まず表も触らず監査にも残さない', async () => {
    setup({ codes: ['admin.stockists.read'], tables: okTables() });
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.manage' });
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1', tables: okTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.stockists.manage' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-006 変更の枠 20回／10分を送り元と操作者の2段で数え、送り元の段の印は IP、操作者の段の印は操作者にする', async () => {
    setup({ tables: okTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.9',
      endpoint: 'admin:stockists:mutation',
      bucket: BUCKET_ISO,
      subject: null,
    });
    expect(incrementCounter).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9',
      endpoint: 'admin:stockists:mutation',
      bucket: BUCKET_ISO,
      subject: 'admin-1',
    });
  });

  test('API-STOCKIST-006 送り元の段で21回目になると 429 Retry-After 600 で断り、操作者の段も CSRF も本文も触らない', async () => {
    setup({ refreshCookie: 'refresh-1', tables: okTables() });
    incrementCounter.mockResolvedValue(21);
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(cookies).not.toHaveBeenCalled();
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 両方の段が20回目までは通し、送り元が空いていても操作者の段が21回目なら 429 で断る', async () => {
    setup({ tables: okTables() });
    incrementCounter.mockResolvedValue(20);
    const ok = await DELETE(makeRequest(), ctx());
    expect(ok.status).toBe(200);

    incrementCounter.mockReset();
    incrementCounter.mockResolvedValueOnce(1).mockResolvedValueOnce(21);
    const request = makeRequest();
    const limited = await DELETE(request, ctx());

    expect(limited.status).toBe(429);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'admin-1' }));
    expect(jsonMock(request)).not.toHaveBeenCalled();
  });

  test('API-STOCKIST-006 回数の数え場所が使えなければ 503 Retry-After 600 で断り、表を触らない', async () => {
    setup({ tables: okTables() });
    incrementCounter.mockRejectedValue(new Error('counter down'));
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-006 session の Cookie が無ければ CSRF の token を求めず、そのまま通す', async () => {
    setup({ tables: okTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(client.seq).not.toContain('sessions.select');
  });

  test('API-STOCKIST-006 session があるのに X-CSRF-Token の見出しが無ければ 403 CSRF validation failed で断り、本文も表も監査も触らない', async () => {
    setup({ refreshCookie: 'refresh-1', tables: okTables() });
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
    expect(client.seq).not.toContain('sessions.select');
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 token が session に結んだ値と合わなければ 403 CSRF validation failed で断る', async () => {
    const stored = await tokenHashSha256('another-token');
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: 'csrf-token-1',
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: stored }, error: null } } },
    });
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 session の行が無い、または token の控えが空なら 403 CSRF validation failed で断る', async () => {
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: 'csrf-token-1',
      tables: { ...okTables(), sessions: { select: { data: null, error: null } } },
    });
    const noRow = await DELETE(makeRequest(), ctx());
    expect(noRow.status).toBe(403);

    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: 'csrf-token-1',
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: null }, error: null } } },
    });
    const emptyHash = await DELETE(makeRequest(), ctx());
    expect(emptyHash.status).toBe(403);
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-006 token が session に結んだ値と合えば通し、refresh token の hash で session を引く', async () => {
    const stored = await tokenHashSha256('csrf-token-1');
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: 'csrf-token-1',
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: stored }, error: null } } },
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(tableCalls('sessions', 'select')).toEqual([
      [['select', ['csrf_token_hash']], ['eq', ['refresh_token_hash', await tokenHashSha256('refresh-1')]], ['maybeSingle', []]],
    ]);
  });

  test('API-STOCKIST-006 URL 符号化された token の見出しも、復号した値で突き合わせる', async () => {
    const stored = await tokenHashSha256('tok/en+1');
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: encodeURIComponent('tok/en+1'),
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: stored }, error: null } } },
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
  });

  test('API-STOCKIST-006 復号できない token の見出しはそのままの値で突き合わせ、合わなければ 403 で断る', async () => {
    const stored = await tokenHashSha256('%E0%A4%A');
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: '%E0%A4%A',
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: stored }, error: null } } },
    });
    const same = await DELETE(makeRequest(), ctx());
    expect(same.status).toBe(200);

    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: '%E0%A4%A',
      tables: { ...okTables(), sessions: { select: { data: { csrf_token_hash: await tokenHashSha256('x') }, error: null } } },
    });
    const different = await DELETE(makeRequest(), ctx());
    expect(different.status).toBe(403);
  });

  test('API-STOCKIST-006 session の照会で例外が出たら 500 Internal server error で断り、表を触らない', async () => {
    setup({
      refreshCookie: 'refresh-1',
      csrfHeader: 'csrf-token-1',
      tables: { ...okTables(), sessions: { select: { throws: new Error('sessions down') } } },
    });
    const request = makeRequest();

    const res = await DELETE(request, ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
  });

  test('API-STOCKIST-006 道の params を解けない例外も 500 Internal server error を返す', async () => {
    setup({ tables: okTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  test('API-STOCKIST-006 client を作れない例外も 500 Internal server error を返し、監査を残さない', async () => {
    setup({ tables: okTables() });
    createClient.mockRejectedValue(new Error('no client'));

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(auditRows()).toHaveLength(0);
  });

  test('API-STOCKIST-006 id の行だけを消し、本文を読まず、200 と消した行の中身を残した成功の監査を残す', async () => {
    setup({ tables: okTables() });
    const request = makeRequest();

    const res = await DELETE(request, ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(createClient).toHaveBeenCalledWith(request);
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(tableCalls('stockists', 'delete')).toEqual([
      [['delete', []], ['eq', ['id', 7]], ['select', ['id, name, address, status']]],
    ]);
    expect(dataSeq()).toEqual(['stockists.delete']);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.delete',
        actor_id: 'admin-1',
        resource: 'stockists',
        resource_id: '7',
        outcome: 'success',
        detail: 'Deleted stockist id: 7',
        ip: '203.0.113.9',
        user_agent: 'jest-agent',
      }),
    ]);
  });

  test('API-STOCKIST-006 監査の detail に店の名前も住所も入れず、消した店の id・name・address・status だけを metadata.deleted に残す', async () => {
    setup({
      tables: okTables({
        data: [{ ...DELETED_ROW, id: 12, phone: '03-1234-5678', time: '11:00-19:00', holiday: '水曜' }],
        error: null,
      }),
    });

    await DELETE(makeRequest(), ctx('12'));

    const [row] = auditRows();
    expect(row.detail).toBe('Deleted stockist id: 12');
    expect(row.metadata).toEqual({
      deleted: { id: 12, name: 'ATELIER SHIBUYA', address: '東京都渋谷区神南1-2-3', status: 'published' },
    });
    expect(JSON.stringify(row)).not.toContain('03-1234-5678');
    expect(JSON.stringify(row)).not.toContain('11:00-19:00');
  });

  test('API-STOCKIST-006 監査の送り元と user-agent が無ければ null で残す', async () => {
    setup({ tables: okTables() });

    await DELETE(makeRequest({ forwarded: null, userAgent: null }), ctx());

    expect(auditRows()[0]).toMatchObject({ outcome: 'success', ip: null, user_agent: null });
  });

  test('API-STOCKIST-006 x-forwarded-for の先頭の値の前後の空白を除いて監査に残す', async () => {
    setup({ tables: okTables() });

    await DELETE(makeRequest({ forwarded: '  198.51.100.4 , 10.0.0.1' }), ctx());

    expect(auditRows()[0]).toMatchObject({ outcome: 'success', ip: '198.51.100.4' });
  });

  test('API-STOCKIST-006 DB の誤りは 500 Failed to delete stockist で返し、誤りの監査を残す', async () => {
    setup({ tables: okTables({ data: null, error: { message: 'foreign key violation' } }) });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete stockist' });
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'admin.stockists.delete', outcome: 'error', detail: 'DB delete failed', resource_id: '7' }),
    ]);
  });

  test.each([
    ['空の配列', []],
    ['null', null],
  ])('API-STOCKIST-006 削除の結果が %s（0 行）なら 404 Stockist not found で断り、成功の監査を書かず failure を残す', async (_label, data) => {
    setup({ tables: okTables({ data, error: null }) });

    const res = await DELETE(makeRequest(), ctx('99999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Stockist not found' });
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.delete',
        outcome: 'failure',
        detail: 'Stockist not found',
        resource_id: '99999',
      }),
    ]);
    expect(auditRows()[0].metadata ?? null).toBeNull();
  });

  test('API-STOCKIST-006 DB の誤りの記録には符号だけを残し、誤りの本文を残さない', async () => {
    setup({ tables: okTables({ data: null, error: { code: '23503', message: 'foreign key violation' } }) });

    await DELETE(makeRequest(), ctx());

    expect(console.error).toHaveBeenCalledWith('Failed to delete stockist:', { code: '23503' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('foreign key violation');
  });

  test('API-STOCKIST-006 表の削除で例外が出たら 500 Internal server error を返す', async () => {
    setup({ tables: okTables({ throws: new Error('db down') }) });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-STOCKIST-006 CSRF の拒否では行を消さず、監査も残さない', async () => {
    setup({ refreshCookie: 'refresh-1', tables: okTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(tableCalls('stockists', 'delete')).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });
});
