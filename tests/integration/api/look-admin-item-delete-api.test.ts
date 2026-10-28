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
type Removal = { bucket: string; paths: string[] };

// 表への呼び出しを、最初の操作（select・insert・update・delete）ごとに用意した結果で返す
function createFakeClient(
  tables: Tables,
  storage: { uploadResult?: Result; sign?: (path: string) => Result; removeResult?: Outcome } = {}
) {
  const removals: Removal[] = [];
  const ops: TableOp[] = [];
  const seq: string[] = [];
  const uploads: Upload[] = [];
  const signed: Signed[] = [];
  const client = {
    ops,
    seq,
    uploads,
    signed,
    removals,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, op: 'select', calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'single', 'maybeSingle']) {
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
        remove: jest.fn(async (paths: string[]) => {
          removals.push({ bucket, paths });
          const outcome = storage.removeResult ?? { data: [], error: null };
          if ('throws' in outcome) throw outcome.throws;
          return outcome;
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
  if (lower === 'x-real-ip') return '203.0.113.9';
  return null;
}

const { DELETE } = require('@/app/api/admin/looks/[id]/route');

// 削除は本文を読まないので、route が使う headers だけを持つ形を渡す（本文を読めば例外になる）
function makeRequest(options: { userAgent?: string | null } = {}) {
  return { headers: { get: (name: string) => baseHeaders(name, options.userAgent) } } as unknown as Request;
}

type Overrides = { existing?: Outcome; remove?: Outcome };

const OWN_IMAGE = 'looks/2026-10-01/a.jpg';

function lookTables(overrides: Overrides = {}): Tables {
  return {
    looks: {
      select: overrides.existing ?? { data: { id: 7, status: 'published', image_urls: [OWN_IMAGE] }, error: null },
      delete: overrides.remove ?? { data: null, error: null },
    },
  };
}

const BUCKET_ISO = '2026-10-24T12:00:00.000Z';

describe('DELETE /api/admin/looks/[id]（LOOK の削除）', () => {
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

  test('API-LOOK-006 admin.looks.manage が無ければ 403 で断り、回数を数えず何も消さない', async () => {
    setup({ codes: ['admin.looks.read'], tables: lookTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.manage' });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-006 token が検証で断られたら 401 で断り、何も消さない', async () => {
    setup({ tables: lookTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-006 aal2 でない session は 403 MFA required で断り、何も消さない', async () => {
    setup({ aal: 'aal1', tables: lookTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.looks.manage' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-006 削除30回／10分を送り元と操作者の2段で数える', async () => {
    setup({ tables: lookTables() });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:delete',
      bucket: BUCKET_ISO,
      subject: null,
    });
    expect(incrementCounter).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:delete',
      bucket: BUCKET_ISO,
      subject: 'admin-1',
    });
  });

  test('API-LOOK-006 30回目までは通し、送り元の段で31回目になると 429 Retry-After 600 で断り何も消さない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(30);
    const atLimit = await DELETE(makeRequest(), ctx());
    expect(atLimit.status).toBe(200);
    jest.clearAllMocks();

    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(31);
    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-006 送り元が空いていても操作者の段が31回目なら 429 で断り、何も消さない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValueOnce(1).mockResolvedValueOnce(31);

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(429);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'admin-1' }));
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-006 回数の数え場所が使えなければ 503 で断り、何も消さない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockRejectedValue(new Error('counter down'));

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-006 有無を確かめてから looks の行を消し、200 と消した時の状態を含む成功の監査を残す', async () => {
    setup({ tables: lookTables() });

    const res = await DELETE(makeRequest(), ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dataSeq()).toEqual(['looks.select', 'looks.delete']);
    expect(tableCalls('looks', 'select')).toEqual([[['select', ['id,status,image_urls']], ['eq', ['id', '7']], ['maybeSingle', []]]]);
    expect(tableCalls('looks', 'delete')).toEqual([[['delete', []], ['eq', ['id', '7']]]]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.delete',
      actor_id: 'admin-1',
      resource: 'look',
      resource_id: '7',
      outcome: 'success',
      detail: 'Look deleted',
      user_agent: 'jest-agent',
      metadata: { deleted_status: 'published' },
    });
  });

  test('API-LOOK-006 関連の行は外部キーに任せて消さず、行を消した後に自分の画像だけを置き場から消す', async () => {
    setup({
      tables: lookTables({
        existing: {
          data: {
            id: 7,
            status: 'published',
            image_urls: [OWN_IMAGE, 'e2e/look-1-1.png', 'https://evil.example/looks/x.png', 'looks/../y.png'],
          },
          error: null,
        },
      }),
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(client.ops.some((o) => o.table === 'look_items')).toBe(false);
    expect(client.removals).toEqual([{ bucket: 'look-images', paths: [OWN_IMAGE] }]);
    expect(incrementCounterBy).not.toHaveBeenCalled();
    expect(client.seq.indexOf('looks.delete')).toBeGreaterThan(-1);
  });

  test('API-LOOK-006 消せる画像が無ければ置き場を呼ばない', async () => {
    setup({ tables: lookTables({ existing: { data: { id: 7, status: 'published', image_urls: ['e2e/look-1-1.png'] }, error: null } }) });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(client.storage.from).not.toHaveBeenCalled();
  });

  test('API-LOOK-006 行の削除が失敗したら画像は消さない', async () => {
    setup({ tables: lookTables({ remove: { data: null, error: { message: 'fk violation' } } }) });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(client.removals).toEqual([]);
  });

  test('API-LOOK-006 置き場の削除が失敗しても 200 のままで、監査の metadata に件数を残し、置き場の文を記録しない', async () => {
    setup({
      tables: lookTables(),
      storage: { removeResult: { data: null, error: { message: 'storage SECRET' } } },
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()[0]).toMatchObject({
      outcome: 'success',
      metadata: { deleted_status: 'published', image_cleanup: 'failed', orphaned_count: 1 },
    });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
  });

  test('API-LOOK-006 置き場の削除が例外を投げても 200 のまま返す', async () => {
    setup({ tables: lookTables(), storage: { removeResult: { throws: new Error('storage down') } } });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(auditRows()[0]).toMatchObject({ outcome: 'success', metadata: expect.objectContaining({ image_cleanup: 'failed' }) });
  });

  test('API-LOOK-006 LOOK が無ければ 404 Look not found と失敗の監査を残し、消さない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: null } }) });

    const res = await DELETE(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Look not found' });
    expect(dataSeq()).toEqual(['looks.select']);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.delete',
      outcome: 'failure',
      detail: 'Look not found',
      resource_id: '999',
    });
  });

  test('API-LOOK-006 有無の確認が DB の失敗なら「無い」と分けて 500 Failed to fetch look にし、失敗の監査を残して消さない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: { code: '08006', message: 'connection reset SECRET' } } }) });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch look' });
    expect(dataSeq()).toEqual(['looks.select']);
    expect(client.removals).toEqual([]);
    expect(auditRows()[0]).toMatchObject({ outcome: 'failure', detail: 'Failed to fetch look' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
  });

  test.each(['abc', '1e3', '0', '-1', '1.5'])(
    'API-LOOK-006 id が %s の時は認可と回数の後で 400 Invalid look id と監査（id の生の値は残さず長さだけ）を返し、何も消さない',
    async (badId) => {
      setup({ tables: lookTables() });

      const res = await DELETE(makeRequest(), ctx(badId));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid look id' });
      expect(dataSeq()).toEqual([]);
      expect(client.removals).toEqual([]);
      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Invalid look id',
        resource_id: null,
        metadata: { id_length: badId.length },
      });
    },
  );

  test('API-LOOK-006 削除の失敗は 500 Failed to delete look と、消そうとした状態を含む失敗の監査を残す', async () => {
    setup({ tables: lookTables({ remove: { data: null, error: { message: 'fk violation' } } }) });

    const res = await DELETE(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete look' });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.delete',
      outcome: 'failure',
      detail: 'Failed to delete look',
      resource_id: '7',
      metadata: { deleted_status: 'published' },
    });
  });

  test('API-LOOK-006 表の呼び出しで例外が出たら 500 Internal server error と Unexpected delete error の監査を残す', async () => {
    setup({ tables: lookTables({ remove: { throws: new Error('boom') } }) });

    const res = await DELETE(makeRequest({ userAgent: null }), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.delete',
      actor_id: 'admin-1',
      outcome: 'failure',
      detail: 'Unexpected delete error',
      resource_id: null,
      user_agent: null,
    });
  });

  test('API-LOOK-006 監査の書き込みが失敗しても削除の成功は 200 のまま返す', async () => {
    setup({
      tables: { ...lookTables(), audit_logs: { insert: { data: null, error: { message: 'audit down' } } } },
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()).toHaveLength(1);
  });

  test('API-LOOK-006 認可の前に道の params を解けなければ 500 Internal server error で、何も消さず監査も残さない', async () => {
    setup({ tables: lookTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });
});
