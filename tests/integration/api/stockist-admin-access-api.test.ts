export {};

// 窓口・認可（admin-rbac）・回数の制限（admin-security と ratelimit）・認可の拒否の監査（audit-authz-denial と audit）は本物を通し、
// 外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。取扱店の作成の頁が入口で呼ぶ権限の確かめ（SEC-STOCKIST-019）
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
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
const { GET } = require('@/app/api/admin/stockists/access/route');

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
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'x-real-ip') return '203.0.113.9';
        if (key === 'user-agent') return 'jest-agent';
        return null;
      },
    },
  } as unknown as Request;
}

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    rpcImpl?: (call: RpcCall) => Result | Promise<Result>;
  } = {},
) {
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(options.codes ?? ['admin.stockists.manage']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.rpcImpl,
  );
  createServiceRoleClient.mockResolvedValue(serviceClient);
  createClient.mockResolvedValue(createFakeClient({}));
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

function rateEndpoints() {
  return serviceClient.rpcCalls.map((c) => String(c.args._endpoint).split('|')[0]);
}

describe('GET /api/admin/stockists/access（取扱店の作成の頁の入口）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-STOCKIST-007 admin.stockists.manage を持つ利用者には本文の無い 204 を返し、Cache-Control は private, no-store', async () => {
    setup();

    const res = await GET(makeRequest());

    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.text()).toBe('');
  });

  it('API-STOCKIST-007 取扱店の表にも書き込みにも触らず、監査にも残さない', async () => {
    setup();

    await GET(makeRequest());

    expect(createClient).not.toHaveBeenCalled();
    expect(serviceClient.ops.some((o) => o.table === 'stockists')).toBe(false);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-STOCKIST-007 read だけの利用者（サポーター）は 403 で断り、権限の名前を返して、Cache-Control は private, no-store', async () => {
    setup({ codes: ['admin.stockists.read'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.manage' });
  });

  it('API-STOCKIST-007 403 で断った要求は操作者が分かるので、失敗の監査を 1 行残す', async () => {
    setup({ codes: ['admin.stockists.read'] });

    await GET(makeRequest());

    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.access',
        actor_id: 'admin-1',
        resource: 'stockists',
        outcome: 'failure',
        // detail は共有の監査が JWT 風の文字列（a.b.c）を伏せるので、権限の符号は metadata で確かめる
        metadata: expect.objectContaining({ permission: 'admin.stockists.manage', reason: 'permission' }),
        ip: '203.0.113.9',
      }),
    ]);
  });

  it('API-STOCKIST-007 token が無効なら 401 で断り、Cache-Control は private, no-store。監査にも操作者の枠にも数えない', async () => {
    setup({ verified: { ok: false, reason: 'missing' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(auditRows()).toHaveLength(0);
    expect(rateEndpoints()).toEqual(['admin:stockists:read']);
  });

  it('API-STOCKIST-007 session が失効していれば 401、確認ができない時は 503 Retry-After 30 で断る', async () => {
    setup({ liveness: 'revoked' });
    expect((await GET(makeRequest())).status).toBe(401);

    setup({ liveness: 'unavailable' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('API-STOCKIST-007 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.stockists.manage' });
  });

  it('API-STOCKIST-007 読みの枠 admin:stockists:read を送り元（認可の前）、操作者（認可の後）の順に 1 本ずつ数える', async () => {
    setup();
    const order: string[] = [];
    verifyAccessToken.mockImplementation(async () => {
      order.push('authz');
      return { ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } } };
    });
    serviceClient.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      order.push(`rate:${String(args._endpoint).split('|')[0]}:${args._ip === null ? 'actor' : 'ip'}`);
      return { data: 1, error: null };
    });

    await GET(makeRequest());

    expect(order).toEqual(['rate:admin:stockists:read:ip', 'authz', 'rate:admin:stockists:read:actor']);
  });

  it('API-STOCKIST-007 送り元の枠を超えたら認可より前に 429 Retry-After 600 で断り、token の検証を引かない', async () => {
    setup({ rpcImpl: () => ({ data: 121, error: null }) });

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-007 送り元の枠が通っても操作者の枠を超えていれば 429 で断る', async () => {
    setup({ rpcImpl: ({ args }) => ({ data: args._ip === null ? 500 : 1, error: null }) });

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(serviceClient.rpcCalls).toHaveLength(2);
  });

  it('API-STOCKIST-007 想定外の例外は 500 Internal server error で返し、Cache-Control は private, no-store', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
