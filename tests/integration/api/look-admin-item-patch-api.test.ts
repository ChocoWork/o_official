export {};

// 窓口・認可（admin-rbac）・回数の制限（rateLimit）・監査（audit）・画像の署名は本物を通し、
// 外との境目（Supabase の client・token の検証・回数の数え場所・応答の型）だけを差し替える
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
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

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { incrementCounter, incrementCounterBy } = require('@/features/auth/ratelimit');

type Result = { data: unknown; error: unknown };
type Outcome = Result | { throws: unknown };
type Op = 'select' | 'insert' | 'update' | 'delete';
type Call = [string, unknown[]];
type TableOp = { table: string; op: Op; calls: Call[] };
type Tables = Record<string, Partial<Record<Op, Outcome>>>;
type Upload = { bucket: string; path: string; body: unknown; options: Record<string, unknown> };
type Signed = { bucket: string; path: string; expiresIn: number };

// 表への呼び出しを、最初の操作（select・insert・update・delete）ごとに用意した結果で返す
function createFakeClient(
  tables: Tables,
  storage: { uploadResult?: Result; sign?: (path: string) => Result } = {}
) {
  const ops: TableOp[] = [];
  const seq: string[] = [];
  const uploads: Upload[] = [];
  const signed: Signed[] = [];
  const client = {
    ops,
    seq,
    uploads,
    signed,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, op: 'select', calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'single']) {
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
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, body, options });
          return storage.uploadResult ?? { data: {}, error: null };
        }),
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signed.push({ bucket, path, expiresIn });
          return storage.sign ? storage.sign(path) : { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let client: ReturnType<typeof createFakeClient>;

// 認可に使う user_roles と監査の audit_logs は既定で用意し、LOOK の表の結果だけを呼び側が渡す
function setup(
  options: {
    codes?: string[];
    aal?: string;
    tables?: Tables;
    storage?: Parameters<typeof createFakeClient>[1];
  } = {}
) {
  client = createFakeClient(
    {
      user_roles: { select: { data: aclRows(options.codes ?? ['admin.looks.read', 'admin.looks.manage']), error: null } },
      audit_logs: { insert: { data: null, error: null } },
      ...options.tables,
    },
    options.storage
  );
  createServiceRoleClient.mockResolvedValue(client);
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
  incrementCounter.mockResolvedValue(1);
  incrementCounterBy.mockResolvedValue(1);
}

function auditRows() {
  return client.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

// 認可と監査の呼び出しを除いた、LOOK 関連の表への操作の順番
function dataSeq() {
  return client.seq.filter((s) => s !== 'user_roles.select' && s !== 'audit_logs.insert');
}

function tableCalls(table: string, op: Op) {
  return client.ops.filter((o) => o.table === table && o.op === op).map((o) => o.calls);
}

// 日付だけ固定する（タイマーと microtask は本物のまま）。0時をまたぐ実行で「今日」が割れないようにする
const FROZEN_NOW = new Date('2026-10-24T12:00:00.000Z');
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

function baseHeaders(name: string, userAgent: string | null | undefined) {
  const lower = name.toLowerCase();
  if (lower === 'user-agent') return userAgent === undefined ? 'jest-agent' : userAgent;
  if (lower === 'x-forwarded-for') return '203.0.113.9, 10.0.0.1';
  return null;
}

const { PATCH } = require('@/app/api/admin/looks/[id]/route');

// 状態の切り替えは JSON の本文だけを読むので、route が使う json と headers だけを持つ形を渡す
function makeRequest(options: { body?: unknown; jsonError?: Error; userAgent?: string | null } = {}) {
  return {
    headers: { get: (name: string) => baseHeaders(name, options.userAgent) },
    json: jest.fn(async () => {
      if (options.jsonError) throw options.jsonError;
      return 'body' in options ? options.body : { status: 'published' };
    }),
  } as unknown as Request;
}

function jsonMock(request: Request) {
  return (request as unknown as { json: jest.Mock }).json;
}

type Overrides = { existing?: Outcome; update?: Outcome };

function lookTables(overrides: Overrides = {}): Tables {
  return {
    looks: {
      select: overrides.existing ?? { data: { id: 7, status: 'private' }, error: null },
      update: overrides.update ?? { data: null, error: null },
    },
  };
}

const BUCKET_ISO = '2026-10-24T12:00:00.000Z';

describe('PATCH /api/admin/looks/[id]（公開の状態だけの切り替え）', () => {
  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('API-LOOK-005 admin.looks.manage が無ければ 403 で断り、回数を数えず本文も読まない', async () => {
    setup({ codes: ['admin.looks.read'], tables: lookTables() });
    const request = makeRequest();

    const res = await PATCH(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.manage' });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-005 token が検証で断られたら 401 で断り、本文を読まない', async () => {
    setup({ tables: lookTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });
    const request = makeRequest();

    const res = await PATCH(request, ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(jsonMock(request)).not.toHaveBeenCalled();
  });

  test('API-LOOK-005 aal2 でない session は 403 MFA required で断り、状態を変えない', async () => {
    setup({ aal: 'aal1', tables: lookTables() });

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.looks.manage' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-005 状態の変更30回／10分を送り元と操作者の2段で数える', async () => {
    setup({ tables: lookTables() });

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:status',
      bucket: BUCKET_ISO,
      subject: null,
    });
    expect(incrementCounter).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:status',
      bucket: BUCKET_ISO,
      subject: 'admin-1',
    });
  });

  test('API-LOOK-005 30回目までは通し、送り元の段で31回目になると 429 Retry-After 600 で断り本文も読まない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(30);
    const atLimit = await PATCH(makeRequest(), ctx());
    expect(atLimit.status).toBe(200);
    jest.clearAllMocks();

    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(31);
    const request = makeRequest();
    const res = await PATCH(request, ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-005 送り元が空いていても操作者の段が31回目なら 429 で断る', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValueOnce(1).mockResolvedValueOnce(31);
    const request = makeRequest();

    const res = await PATCH(request, ctx());

    expect(res.status).toBe(429);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'admin-1' }));
    expect(jsonMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-005 回数の数え場所が使えなければ 503 で断り、状態を変えない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockRejectedValue(new Error('counter down'));

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(dataSeq()).toEqual([]);
  });

  test.each([
    ['published', 'private'],
    ['private', 'published'],
  ])('API-LOOK-005 状態 %s を送ると status の列だけを更新し、200 と成功の監査（前の状態 %s）を残す', async (next, previous) => {
    setup({ tables: lookTables({ existing: { data: { id: 7, status: previous }, error: null } }) });

    const res = await PATCH(makeRequest({ body: { status: next } }), ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(tableCalls('looks', 'select')).toEqual([[['select', ['id,status']], ['eq', ['id', '7']], ['single', []]]]);
    expect(tableCalls('looks', 'update')).toEqual([[['update', [{ status: next }]], ['eq', ['id', '7']]]]);
    expect(dataSeq()).toEqual(['looks.select', 'looks.update']);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.status_update',
      actor_id: 'admin-1',
      resource: 'look',
      resource_id: '7',
      outcome: 'success',
      detail: 'Look status updated',
      user_agent: 'jest-agent',
      metadata: { previous_status: previous, next_status: next },
    });
  });

  test('API-LOOK-005 状態の列だけを変え、他の列と関連の表と置き場には触らない', async () => {
    setup({ tables: lookTables() });

    await PATCH(makeRequest({ body: { status: 'published', theme: 'Ignored', image_urls: ['x'] } }), ctx());

    expect(Object.keys(tableCalls('looks', 'update')[0].find(([m]) => m === 'update')?.[1][0] as object)).toEqual(['status']);
    expect(client.ops.some((o) => o.table === 'look_items' || o.table === 'items')).toBe(false);
    expect(client.storage.from).not.toHaveBeenCalled();
    expect(incrementCounterBy).not.toHaveBeenCalled();
  });

  test.each([
    ['決まりに無い値', { status: 'draft' }],
    ['状態の欄が無い本文', {}],
    ['文字でない状態', { status: 1 }],
    ['大文字の状態', { status: 'Published' }],
  ])('API-LOOK-005 %s は 400 Invalid request と失敗の監査（invalid_fields）を残し、LOOK の表に触らない', async (_label, body) => {
    setup({ tables: lookTables() });

    const res = await PATCH(makeRequest({ body }), ctx('7'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toHaveProperty('fieldErrors');
    expect(dataSeq()).toEqual([]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.status_update',
      outcome: 'failure',
      detail: 'Invalid status payload',
      resource_id: '7',
      metadata: { invalid_fields: ['status'] },
    });
  });

  test('API-LOOK-005 本文が配列や null のように決まりの形でなくても、zod が断って 500 でなく 400 を返す', async () => {
    setup({ tables: lookTables() });

    const res = await PATCH(makeRequest({ body: null }), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid request');
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-005 LOOK が無ければ 404 Look not found と失敗の監査を残し、更新しない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: null } }) });

    const res = await PATCH(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Look not found' });
    expect(dataSeq()).toEqual(['looks.select']);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.status_update',
      outcome: 'failure',
      detail: 'Look not found',
      resource_id: '999',
    });
  });

  test('API-LOOK-005 有無の確認が DB の失敗でも 404 Look not found にする', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: { message: 'connection reset' } } }) });

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Look not found' });
    expect(dataSeq()).toEqual(['looks.select']);
  });

  test('API-LOOK-005 更新の失敗は 500 Failed to update status と、前後の状態を含む失敗の監査を残す', async () => {
    setup({ tables: lookTables({ update: { data: null, error: { message: 'rls denied' } } }) });

    const res = await PATCH(makeRequest({ body: { status: 'published' } }), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update status' });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.status_update',
      outcome: 'failure',
      detail: 'Failed to update look status',
      resource_id: '7',
      metadata: { previous_status: 'private', next_status: 'published' },
    });
  });

  test('API-LOOK-005 本文が JSON でないと 500 Internal server error になり、400 にそろわない', async () => {
    setup({ tables: lookTables() });

    const res = await PATCH(makeRequest({ jsonError: new SyntaxError('Unexpected token') }), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(dataSeq()).toEqual([]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.status_update',
      actor_id: 'admin-1',
      outcome: 'failure',
      detail: 'Unexpected status update error',
      resource_id: null,
      metadata: null,
    });
  });

  test('API-LOOK-005 表の呼び出しで例外が出たら 500 Internal server error と失敗の監査を残す', async () => {
    setup({ tables: lookTables({ update: { throws: new Error('boom') } }) });

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(auditRows()[0]).toMatchObject({ detail: 'Unexpected status update error', outcome: 'failure' });
  });

  test('API-LOOK-005 監査の書き込みが失敗しても切り替えの成功は 200 のまま返す', async () => {
    setup({
      tables: { ...lookTables(), audit_logs: { insert: { data: null, error: { message: 'audit down' } } } },
    });

    const res = await PATCH(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()).toHaveLength(1);
  });

  test('API-LOOK-005 認可の前に道の params を解けなければ 500 Internal server error で、監査も回数も残さない', async () => {
    setup({ tables: lookTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await PATCH(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(auditRows()).toHaveLength(0);
    expect(incrementCounter).not.toHaveBeenCalled();
  });
});
