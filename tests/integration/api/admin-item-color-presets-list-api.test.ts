export {};

// 窓口・認可（admin-rbac）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 色見本の窓口は service role の client 1つで表を読み書きするので、差し替える client もその1つだけ
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

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type TableResults = { default?: Result; maybeSingle?: Result; single?: Result };

function createFakeClient(tables: Record<string, TableResults>) {
  const ops: TableOp[] = [];
  const client = {
    ops,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = (terminal?: 'maybeSingle' | 'single') =>
        (terminal ? tables[table]?.[terminal] : undefined) ?? tables[table]?.default ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result('single'));
      builder.maybeSingle = () => Promise.resolve(result('maybeSingle'));
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    presets?: TableResults;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient({
    item_color_presets: options.presets ?? { default: { data: null, error: null } },
    user_roles: { default: { data: aclRows(options.codes ?? ['admin.items.read', 'admin.items.manage']), error: null } },
    audit_logs: { default: { data: null, error: null } },
  });
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function presetsOp() {
  return serviceClient.ops.find((o) => o.table === 'item_color_presets');
}

function callsOf(method: string) {
  return serviceClient.ops
    .filter((o) => o.table === 'item_color_presets')
    .flatMap((o) => o.calls)
    .filter(([m]) => m === method);
}
const { GET } = require('@/app/api/admin/item-color-presets/route');

function makeRequest() {
  return { url: 'http://localhost/api/admin/item-color-presets', headers: { get: () => null } } as unknown as Request;
}

describe('API-ADMIN-013 GET /api/admin/item-color-presets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-013 admin.items.read が無く別の権限だけでは 403 で断り、表に触れない', async () => {
    setup({ codes: ['admin.items.manage', 'admin.looks.read'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.items.read' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-013 aal2 でない session は 403 MFA required で断り、表に触れない', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.items.read' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-013 token が無効なら 401 で断り、表に触れない', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-013 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await GET(makeRequest());
    setup({ liveness: 'unavailable' });
    const unavailable = await GET(makeRequest());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-013 認可の途中で例外が出たら 500 Internal server error にし、表に触れない', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-013 admin.items.read だけの権限でも読め、全部の列を作った時刻の新しい順で引いて 200 の data で返す', async () => {
    const rows = [
      { id: 'b', name: 'ネイビー', hex: '#000080', created_at: '2026-10-02T00:00:00Z' },
      { id: 'a', name: 'ホワイト', hex: '#FFFFFF', created_at: '2026-10-01T00:00:00Z' },
    ];
    setup({ codes: ['admin.items.read'], presets: { default: { data: rows, error: null } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: rows });
    expect(callsOf('select')).toEqual([['select', ['*']]]);
    expect(callsOf('order')).toEqual([['order', ['created_at', { ascending: false }]]]);
  });

  it('API-ADMIN-013 表は service role の client で読み、利用者の JWT の client は使わず、監査にも残さない', async () => {
    setup();

    await GET(makeRequest());

    expect(createClient).not.toHaveBeenCalled();
    expect(presetsOp()).toBeDefined();
    expect(serviceClient.ops.some((o) => o.table === 'audit_logs')).toBe(false);
  });

  it('API-ADMIN-013 色見本が1件も無いときは空の配列を 200 で返す', async () => {
    setup({ presets: { default: { data: [], error: null } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('API-ADMIN-013 DB の誤りは 500 Failed to fetch color presets にし、内部の誤りを本文に出さない', async () => {
    setup({ presets: { default: { data: null, error: { message: 'relation exploded' } } } });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to fetch color presets' });
    expect(JSON.stringify(body)).not.toContain('exploded');
  });

  it('API-ADMIN-013 認可の後に表のための client を作れず例外が出たら 500 Internal server error にする', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('no key');
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
