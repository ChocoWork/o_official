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

const { GET } = require('@/app/api/admin/looks/[id]/route');

const lookRow = {
  id: 7,
  season_year: 2026,
  season_type: 'AW',
  theme: 'Dusk',
  theme_description: 'Quiet evening',
  image_urls: ['looks/2026-10-01/a.jpg', 'looks/2026-10-01/b.png'],
  status: 'private',
  created_at: '2026-10-01T00:00:00.000Z',
};

function makeRequest() {
  return { headers: { get: (name: string) => baseHeaders(name, undefined) } } as unknown as Request;
}

function lookTables(overrides: { look?: Outcome; items?: Outcome } = {}) {
  return {
    looks: { select: overrides.look ?? { data: lookRow, error: null } },
    look_items: { select: overrides.items ?? { data: [{ item_id: 3 }, { item_id: 5 }], error: null } },
  };
}

describe('GET /api/admin/looks/[id]（管理の LOOK の1件の取り出し）', () => {
  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    // 信頼する origin は自分のプロジェクト 1 つだけ（parseOwnObjectPath）
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('API-LOOK-003 admin.looks.read が無ければ 403 で断り、LOOK の表も置き場も触らない', async () => {
    setup({ codes: ['admin.looks.manage'], tables: lookTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.read' });
    expect(dataSeq()).toEqual([]);
    expect(client.storage.from).not.toHaveBeenCalled();
  });

  test('API-LOOK-003 token が検証で断られたら 401 で断り、LOOK の表を触らない', async () => {
    setup({ tables: lookTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-003 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1', tables: lookTables() });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', reason: 'MFA required', permission: 'admin.looks.read' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-003 全部の列と紐づけた商品の ID を 200 の data に返し、画像は署名つき URL にする', async () => {
    setup({ tables: lookTables() });

    const res = await GET(makeRequest(), ctx('7'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      data: {
        ...lookRow,
        image_urls: ['https://signed.example/looks/2026-10-01/a.jpg', 'https://signed.example/looks/2026-10-01/b.png'],
        linkedItemIds: [3, 5],
      },
    });
    expect(tableCalls('looks', 'select')).toEqual([[['select', ['*']], ['eq', ['id', '7']], ['maybeSingle', []]]]);
    expect(tableCalls('look_items', 'select')).toEqual([[['select', ['item_id']], ['eq', ['look_id', '7']]]]);
    expect(client.signed).toEqual([
      { bucket: 'look-images', path: 'looks/2026-10-01/a.jpg', expiresIn: 3600 },
      { bucket: 'look-images', path: 'looks/2026-10-01/b.png', expiresIn: 3600 },
    ]);
  });

  test('API-LOOK-003 回数の制限も監査も使わず、読むだけで表を書き換えない', async () => {
    setup({ tables: lookTables() });

    await GET(makeRequest(), ctx());

    expect(incrementCounter).not.toHaveBeenCalled();
    expect(incrementCounterBy).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
    expect(dataSeq()).toEqual(['looks.select', 'look_items.select']);
  });

  test('API-LOOK-003 紐づけが0件なら linkedItemIds は空の配列で、取れた結果が null でも同じにする', async () => {
    setup({ tables: lookTables({ items: { data: [], error: null } }) });
    const empty = await GET(makeRequest(), ctx());
    expect((await empty.json()).data.linkedItemIds).toEqual([]);

    setup({ tables: lookTables({ items: { data: null, error: null } }) });
    const nullData = await GET(makeRequest(), ctx());
    expect(nullData.status).toBe(200);
    expect((await nullData.json()).data.linkedItemIds).toEqual([]);
  });

  test('API-LOOK-003 古い公開 URL の画像は置き場の道筋に直して署名し、署名に失敗した画像は元の値を返さず落とす', async () => {
    const legacy = 'https://x.supabase.co/storage/v1/object/public/look-images/looks/2025-01-01/old.jpg';
    setup({
      tables: lookTables({ look: { data: { ...lookRow, image_urls: [legacy, 'looks/broken.jpg'] }, error: null } }),
      storage: {
        sign: (path) =>
          path === 'looks/broken.jpg'
            ? { data: null, error: { message: 'object not found' } }
            : { data: { signedUrl: `https://signed.example/${path}` }, error: null },
      },
    });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data.image_urls).toEqual(['https://signed.example/looks/2025-01-01/old.jpg']);
    expect(client.signed.map((s) => s.path)).toEqual(['looks/2025-01-01/old.jpg', 'looks/broken.jpg']);
  });

  test('API-LOOK-003 image_urls が配列でなければ空の配列として扱い、署名を作らない', async () => {
    setup({ tables: lookTables({ look: { data: { ...lookRow, image_urls: null }, error: null } }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data.image_urls).toEqual([]);
    expect(client.signed).toHaveLength(0);
  });

  test('API-LOOK-003 行が無ければ 404 Look not found で、紐づけの表を引かない', async () => {
    setup({ tables: lookTables({ look: { data: null, error: null } }) });

    const res = await GET(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Look not found' });
    expect(dataSeq()).toEqual(['looks.select']);
  });

  test('API-LOOK-003 DB の失敗は「無い」と分けて 500 Failed to fetch look にし、DB の文を応答にも記録にも出さない', async () => {
    setup({ tables: lookTables({ look: { data: null, error: { code: '08006', message: 'connection reset SECRET' } } }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch look' });
    expect(dataSeq()).toEqual(['looks.select']);
    expect(console.error).toHaveBeenCalledWith('Failed to fetch look:', { name: 'UnknownError', code: '08006' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
  });

  test.each(['abc', '1e3', '0', '-1', '1.5'])(
    'API-LOOK-003 id が %s の時は認可の後で 400 Invalid look id を返し、LOOK の表を引かない',
    async (badId) => {
      setup({ tables: lookTables() });

      const res = await GET(makeRequest(), ctx(badId));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid look id' });
      expect(dataSeq()).toEqual([]);
    },
  );

  test('API-LOOK-003 紐づけの取り出しに失敗したら 500 Failed to fetch look items を返し、画像を署名しない', async () => {
    setup({ tables: lookTables({ items: { data: null, error: { message: 'timeout' } } }) });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch look items' });
    expect(client.signed).toHaveLength(0);
  });

  test('API-LOOK-003 署名で例外が出たら 500 Internal server error を返す', async () => {
    setup({
      tables: lookTables(),
      storage: {
        sign: () => {
          throw new Error('storage down');
        },
      },
    });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-LOOK-003 道の params を解けない例外も 500 Internal server error を返す', async () => {
    setup({ tables: lookTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(dataSeq()).toEqual([]);
  });
});
