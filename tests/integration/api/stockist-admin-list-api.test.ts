export {};

// 窓口・認可（admin-rbac）・回数の制限（admin-security と ratelimit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 取扱店の表は利用者の JWT の client（createClient）、認可の照会と回数の数えは service role の client で触る
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

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { GET } = require('@/app/api/admin/stockists/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type RpcCall = { name: string; args: Record<string, unknown> };

function createFakeClient(tables: Record<string, Result>, rpcImpl?: (call: RpcCall) => Result | Promise<Result>) {
  const ops: TableOp[] = [];
  const rpcCalls: RpcCall[] = [];
  return {
    ops,
    rpcCalls,
    rpc: jest.fn(async (name: string, args: Record<string, unknown>) => {
      const call = { name, args };
      rpcCalls.push(call);
      return rpcImpl ? rpcImpl(call) : { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
  };
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest() {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : null),
    },
  } as unknown as Request;
}

const ROWS = [
  {
    id: 1,
    name: 'A Shop',
    address: 'Tokyo',
    phone: '03-0000-0000',
    time: '11:00-19:00',
    holiday: 'Mon',
    status: 'published',
    type: 'select',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 2,
    name: 'B Shop',
    address: 'Osaka',
    phone: '06-0000-0000',
    time: '12:00-20:00',
    holiday: 'Tue',
    status: 'private',
    type: 'select',
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-02T00:00:00Z',
  },
];

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    stockistsResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    rpcImpl?: (call: RpcCall) => Result | Promise<Result>;
  } = {},
) {
  userClient = createFakeClient({ stockists: options.stockistsResult ?? { data: ROWS, error: null } });
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(options.codes ?? ['admin.stockists.read']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.rpcImpl,
  );
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function stockistsOp() {
  return userClient.ops.find((o) => o.table === 'stockists');
}

describe('GET /api/admin/stockists（管理の取扱店の一覧）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-STOCKIST-001 非公開を含む全部の行を id の昇順に取り、200 で data を返す', async () => {
    setup();

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([1, 2]);
    expect(body.data.map((r: { status: string }) => r.status)).toEqual(['published', 'private']);
    expect(stockistsOp()?.calls).toEqual([
      ['select', ['id, name, address, phone, time, holiday, status, updated_at']],
      ['order', ['id', { ascending: true }]],
    ]);
    // status で絞らない・件数の上限も付けない
    expect(stockistsOp()?.calls.some(([m]) => ['eq', 'in', 'limit'].includes(m))).toBe(false);
  });

  it('API-STOCKIST-001 取り出す列を 8 列に絞り（type・created_at を求めない）、DB が返した行の中身を変えずに返す', async () => {
    setup();

    const body = await (await GET(makeRequest())).json();

    const selected = String(stockistsOp()?.calls.find(([m]) => m === 'select')?.[1][0]);
    expect(selected.split(',').map((c) => c.trim())).toEqual([
      'id',
      'name',
      'address',
      'phone',
      'time',
      'holiday',
      'status',
      'updated_at',
    ]);
    expect(selected).not.toMatch(/\*|type|created_at/);
    expect(body.data).toEqual(ROWS);
  });

  it('API-STOCKIST-001 表が 0 件なら空の配列を 200 で返す', async () => {
    setup({ stockistsResult: { data: [], error: null } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('API-STOCKIST-001 表は要求の JWT の client で読み、service role の client では触らない', async () => {
    setup();

    await GET(makeRequest());

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(stockistsOp()).toBeDefined();
    expect(serviceClient.ops.some((o) => o.table === 'stockists')).toBe(false);
  });

  it('API-STOCKIST-001 一覧の読みは監査に残さない', async () => {
    setup();

    await GET(makeRequest());

    expect(serviceClient.ops.some((o) => o.table === 'audit_logs')).toBe(false);
  });

  it('API-STOCKIST-001 読みの枠 admin:stockists:read を送り元と操作者の2本で数える', async () => {
    setup();

    await GET(makeRequest());

    expect(serviceClient.rpcCalls).toHaveLength(2);
    const [ipCall, actorCall] = serviceClient.rpcCalls;
    expect(ipCall.name).toBe('increment_rate_limit_counter');
    expect(ipCall.args._ip).toBe('203.0.113.9');
    expect(ipCall.args._endpoint).toBe('admin:stockists:read');
    expect(actorCall.args._ip).toBeNull();
    expect(String(actorCall.args._endpoint)).toMatch(/^admin:stockists:read\|acct:[0-9a-f]{128}$/);
  });

  it('API-STOCKIST-001 読みの回数が 120 回ちょうどなら通し、121 回目は 429 と Retry-After で断って表を読まない', async () => {
    setup({ rpcImpl: () => ({ data: 120, error: null }) });
    const okRes = await GET(makeRequest());
    expect(okRes.status).toBe(200);

    setup({ rpcImpl: () => ({ data: 121, error: null }) });
    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(stockistsOp()).toBeUndefined();
  });

  it('API-STOCKIST-001 送り元の枠が通っても操作者の枠を超えていれば 429 で断る', async () => {
    setup({ rpcImpl: ({ args }) => ({ data: args._ip === null ? 500 : 1, error: null }) });

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(serviceClient.rpcCalls).toHaveLength(2);
    expect(stockistsOp()).toBeUndefined();
  });

  it('API-STOCKIST-001 回数を数える DB が使えない時は 503 と Retry-After で断り、表を読まない', async () => {
    setup({ rpcImpl: () => ({ data: null, error: { message: 'rpc down' } }) });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(stockistsOp()).toBeUndefined();
  });

  it('API-STOCKIST-001 admin.stockists.read の権限を確かめ、manage だけでは 403 で、表も読まない', async () => {
    setup({ codes: ['admin.stockists.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.read' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-001 ほかの領域の権限（looks）だけでは 403 で断る', async () => {
    setup({ codes: ['admin.looks.read', 'admin.looks.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-001 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.stockists.read' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-001 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-001 session が失効していれば 401 で断る', async () => {
    setup({ liveness: 'revoked' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-001 session の確認ができない時は 503 と Retry-After 30 で断る', async () => {
    setup({ liveness: 'unavailable' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
  });

  it('API-STOCKIST-001 表の読みが失敗したら 500 Failed to fetch stockists を返し、行を漏らさない', async () => {
    setup({ stockistsResult: { data: ROWS, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch stockists' });
  });

  it('API-STOCKIST-001 client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createClient.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
