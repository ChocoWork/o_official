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

// 回数の制限は DB に触るので差し替える（呼ばれ方は窓口の単体試験で確かめる）
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

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
      claims: {
        sub: 'admin-1',
        email: 'admin@example.com',
        session_id: 'sess-1',
        aal: options.aal ?? 'aal2',
        app_metadata: { role: 'admin' },
      },
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
const { DELETE } = require('@/app/api/admin/item-color-presets/[id]/route');

function makeRequest() {
  return {
    url: 'http://localhost/api/admin/item-color-presets/12',
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        return key === 'user-agent' ? 'jest-agent' : key === 'x-real-ip' ? '198.51.100.7' : null;
      },
    },
  } as unknown as Request;
}

function auditRows(): Array<Record<string, unknown>> {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .flatMap((o) => o.calls)
    .filter(([m]) => m === 'insert')
    .flatMap(([, args]) => args[0] as Array<Record<string, unknown>>);
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('API-ADMIN-015 DELETE /api/admin/item-color-presets/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-015 admin.items.manage が無く別の権限だけでは 403 で断り、表に触れない', async () => {
    setup({ codes: ['admin.items.read'] });

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.items.manage' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 aal2 でない session は 403 MFA required で断り、表に触れない', async () => {
    setup({ aal: 'aal1' });

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.items.manage' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 token が無効なら 401 で断り、表に触れない', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await DELETE(makeRequest(), context('12'));
    setup({ liveness: 'unavailable' });
    const unavailable = await DELETE(makeRequest(), context('12'));

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 認可の途中で例外が出たら 500 Internal server error にし、表に触れない', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 道の id の行だけを消し、消した行の id を取り直して 200 success true を返す', async () => {
    setup({ presets: { default: { data: [{ id: 12 }], error: null } } });

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(callsOf('delete')).toHaveLength(1);
    expect(callsOf('eq')).toEqual([['eq', ['id', '12']]]);
    expect(callsOf('select')).toEqual([['select', ['id']]]);
  });

  it('API-ADMIN-015 SEC-ADMIN-022-AC-01 消せた時だけ、操作した人・IP・端末つきで admin.item_color_preset.delete を監査に1行残す', async () => {
    setup({ presets: { default: { data: [{ id: 12 }], error: null } } });

    await DELETE(makeRequest(), context('12'));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.item_color_preset.delete',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'item_color_preset',
      resource_id: '12',
      outcome: 'success',
      ip: '198.51.100.7',
      user_agent: 'jest-agent',
    });
  });

  it('API-ADMIN-015 消した行が0行・DB の誤り・形の悪い id・断った時は監査を書かない', async () => {
    setup({ presets: { default: { data: [], error: null } } });
    await DELETE(makeRequest(), context('999'));
    expect(auditRows()).toHaveLength(0);

    setup({ presets: { default: { data: null, error: { message: 'fk violation' } } } });
    await DELETE(makeRequest(), context('12'));
    expect(auditRows()).toHaveLength(0);

    setup();
    await DELETE(makeRequest(), context('abc'));
    expect(auditRows()).toHaveLength(0);

    setup({ codes: ['admin.items.read'] });
    await DELETE(makeRequest(), context('12'));
    expect(auditRows()).toHaveLength(0);
  });

  it.each([['not-a-uuid'], ['p1'], ['-1'], ['1 or 1=1'], ['9'.repeat(19)]])(
    'API-ADMIN-015 id が %s のように数字18桁以下でなければ DB に渡さず 404 を返す',
    async (id) => {
      setup();

      const res = await DELETE(makeRequest(), context(id));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Color preset not found' });
      expect(presetsOp()).toBeUndefined();
    },
  );

  it('API-ADMIN-015 消した行が0行なら 404 Color preset not found を返し、成功と偽らない', async () => {
    setup({ presets: { default: { data: [], error: null } } });

    const res = await DELETE(makeRequest(), context('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Color preset not found' });
  });

  it('API-ADMIN-015 回数の枠は認可を通った管理者の ID で数え、超えたら 429 を返して表に触れない', async () => {
    setup();
    enforceRateLimit.mockResolvedValue({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const res = await DELETE(makeRequest(), context('12'));

    expect(res.status).toBe(429);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'admin:color-presets:write', limit: 60, windowSeconds: 600, subject: 'admin-1' }),
    );
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 DB の誤りは 500 Failed to delete color preset にし、内部の誤りを出さない', async () => {
    setup({ presets: { default: { data: null, error: { message: 'fk violation' } } } });

    const res = await DELETE(makeRequest(), context('12'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to delete color preset' });
    expect(JSON.stringify(body)).not.toContain('fk violation');
  });

  it('API-ADMIN-015 params の解決が失敗して例外が出たら 500 Internal server error にし、消さない', async () => {
    setup();

    const res = await DELETE(makeRequest(), { params: Promise.reject(new Error('bad params')) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-015 表は service role の client で消し、利用者の JWT の client は使わない', async () => {
    setup();

    await DELETE(makeRequest(), context('12'));

    expect(createClient).not.toHaveBeenCalled();
  });
});
