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
function auditRows(): Array<Record<string, unknown>> {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .flatMap((o) => o.calls)
    .filter(([m]) => m === 'insert')
    .flatMap(([, args]) => args[0] as Array<Record<string, unknown>>);
}
const { POST } = require('@/app/api/admin/item-color-presets/route');

function makeRequest(body: unknown, rejectJson = false) {
  return {
    url: 'http://localhost/api/admin/item-color-presets',
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        return key === 'user-agent' ? 'jest-agent' : key === 'x-real-ip' ? '198.51.100.7' : null;
      },
    },
    json: rejectJson ? jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')) : jest.fn().mockResolvedValue(body),
  } as unknown as Request;
}

const VALID = { name: 'ネイビー', hex: '#000080' };

describe('API-ADMIN-014 POST /api/admin/item-color-presets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-014 admin.items.manage が無く別の権限だけでは 403 で断り、表に触れない', async () => {
    setup({ codes: ['admin.items.read'] });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.items.manage' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 aal2 でない session は 403 MFA required で断り、表に触れない', async () => {
    setup({ aal: 'aal1' });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.items.manage' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 token が無効なら 401 で断り、表に触れない', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await POST(makeRequest(VALID));
    setup({ liveness: 'unavailable' });
    const unavailable = await POST(makeRequest(VALID));

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 認可の途中で例外が出たら 500 Internal server error にし、表に触れない', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 拒否された時は本文を読まない', async () => {
    setup({ codes: ['admin.items.read'] });
    const req = makeRequest(VALID);

    await POST(req);

    expect(req.json).not.toHaveBeenCalled();
  });

  it.each([
    ['name が無い', { hex: '#000080' }],
    ['name が前後の空白だけ', { name: '   ', hex: '#000080' }],
    ['name が 41 字', { name: 'あ'.repeat(41), hex: '#000080' }],
    ['name が文字列でない', { name: 1, hex: '#000080' }],
    ['hex が無い', { name: 'ネイビー' }],
    ['hex に # が無い', { name: 'ネイビー', hex: '000080' }],
    ['hex が 3 桁', { name: 'ネイビー', hex: '#008' }],
    ['hex が 7 桁', { name: 'ネイビー', hex: '#0000800' }],
    ['hex に 16 進でない字がある', { name: 'ネイビー', hex: '#00008G' }],
  ])('API-ADMIN-014 形の誤り（%s）は details 付きの 400 にし、表を引かない', async (_label, body) => {
    setup();

    const res = await POST(makeRequest(body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 name は前後の空白を除いた値で引き、40 字ちょうどと大文字小文字まじりの hex を受ける', async () => {
    const name = 'あ'.repeat(40);
    const existing = { id: 'p1', name, hex: '#aBcDeF', created_at: '2026-10-01T00:00:00Z' };
    setup({ presets: { maybeSingle: { data: existing, error: null } } });

    const res = await POST(makeRequest({ name: `  ${name}  `, hex: '#aBcDeF' }));

    expect(res.status).toBe(200);
    expect(callsOf('eq')).toEqual([
      ['eq', ['name', name]],
      ['eq', ['hex', '#aBcDeF']],
    ]);
  });

  it('API-ADMIN-014 同じ名前と色の値の行が既にあれば作らずその行を 200 で返す', async () => {
    const existing = { id: 'p1', name: 'ネイビー', hex: '#000080', created_at: '2026-10-01T00:00:00Z' };
    setup({ presets: { maybeSingle: { data: existing, error: null } } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: existing });
    expect(callsOf('select')).toEqual([['select', ['id, name, hex, created_at']]]);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('API-ADMIN-014 無ければ名前と色の値だけを入れて作り、全部の列を 201 で返す', async () => {
    const created = { id: 'p2', name: 'ネイビー', hex: '#000080', created_at: '2026-10-24T00:00:00Z', extra: 1 };
    setup({ presets: { single: { data: created, error: null } } });

    const res = await POST(makeRequest({ name: '  ネイビー ', hex: '#000080', role: 'admin' }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: created });
    expect(callsOf('insert')).toEqual([['insert', [[{ name: 'ネイビー', hex: '#000080' }]]]]);
  });

  it('API-ADMIN-014 SEC-ADMIN-022-AC-01 作れた（201）時だけ、操作した人・IP・端末つきで admin.item_color_preset.create を監査に1行残し、色の名前と値は入れない', async () => {
    const created = { id: 42, name: 'ネイビー', hex: '#000080', created_at: '2026-10-24T00:00:00Z' };
    setup({ presets: { single: { data: created, error: null } } });

    await POST(makeRequest(VALID));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.item_color_preset.create',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'item_color_preset',
      resource_id: '42',
      outcome: 'success',
      ip: '198.51.100.7',
      user_agent: 'jest-agent',
    });
    expect(JSON.stringify(rows[0])).not.toContain('ネイビー');
    expect(JSON.stringify(rows[0])).not.toContain('#000080');
  });

  it('API-ADMIN-014 既にある行を返す（200）時と、断った・誤りの時は監査を書かない', async () => {
    setup({ presets: { maybeSingle: { data: { id: 'p1', name: 'ネイビー', hex: '#000080' }, error: null } } });
    await POST(makeRequest(VALID));
    expect(auditRows()).toHaveLength(0);

    setup({ presets: { single: { data: null, error: { code: '23505', message: 'duplicate key value' } } } });
    await POST(makeRequest(VALID));
    expect(auditRows()).toHaveLength(0);

    setup({ codes: ['admin.items.read'] });
    await POST(makeRequest(VALID));
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-014 既にあるかを引く時の誤りは 500 Failed to save color preset にし、作らず、内部の誤りを出さない', async () => {
    const created = { id: 'p3', name: 'ネイビー', hex: '#000080', created_at: '2026-10-24T00:00:00Z' };
    setup({
      presets: {
        maybeSingle: { data: null, error: { code: 'XX000', message: 'lookup failed' } },
        single: { data: created, error: null },
      },
    });

    const res = await POST(makeRequest(VALID));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to save color preset' });
    expect(JSON.stringify(body)).not.toContain('lookup failed');
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('API-ADMIN-014 作る時の DB の誤り（一意の制約を含む）は 500 Failed to save color preset にし、内部の誤りを出さない', async () => {
    setup({ presets: { single: { data: null, error: { code: '23505', message: 'duplicate key value' } } } });

    const res = await POST(makeRequest(VALID));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to save color preset' });
    expect(JSON.stringify(body)).not.toContain('duplicate');
  });

  it('API-ADMIN-014 本文の JSON が壊れていれば 500 でなく 400 Invalid request にし、表に触れない', async () => {
    setup();

    const res = await POST(makeRequest(undefined, true));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'Invalid request' }));
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 回数の枠は認可を通った管理者の ID で数え、超えたら 429 を返して本文も表も触らない', async () => {
    setup();
    enforceRateLimit.mockResolvedValue({ status: 429, json: async () => ({ error: 'Too many requests' }) });
    const req = makeRequest(VALID);

    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'admin:color-presets:write', limit: 60, windowSeconds: 600, subject: 'admin-1' }),
    );
    expect(req.json).not.toHaveBeenCalled();
    expect(presetsOp()).toBeUndefined();
  });

  it('API-ADMIN-014 拒否された要求は回数に数えない', async () => {
    setup({ codes: ['admin.items.read'] });

    await POST(makeRequest(VALID));

    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('API-ADMIN-014 表は service role の client で読み書きし、利用者の JWT の client は使わない', async () => {
    setup();

    await POST(makeRequest(VALID));

    expect(createClient).not.toHaveBeenCalled();
  });
});
