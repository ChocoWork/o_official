export {};

// 窓口・認可（admin-rbac）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 返信テンプレートの窓口は service role の client 1つで表を読むので、差し替える client もその1つだけ
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
const { GET } = require('@/app/api/admin/contact/templates/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>) {
  const ops: TableOp[] = [];
  const client = {
    ops,
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
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest() {
  return { headers: { get: () => null } } as unknown as Request;
}

const ROWS = [
  {
    id: 't1',
    title: '発送のご案内',
    category: 'order',
    body: '本日発送しました。',
    sort_order: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  },
  {
    id: 't2',
    title: 'お詫び',
    category: null,
    body: '申し訳ありません。',
    sort_order: 5,
    created_at: '2026-10-03T00:00:00Z',
    updated_at: '2026-10-03T00:00:00Z',
  },
];

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    templatesResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient({
    contact_reply_templates: options.templatesResult ?? { data: ROWS, error: null },
    user_roles: { data: aclRows(options.codes ?? ['admin.contact.read']), error: null },
    audit_logs: { data: null, error: null },
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

function templatesOp() {
  return serviceClient.ops.find((o) => o.table === 'contact_reply_templates');
}

describe('GET /api/admin/contact/templates（管理の返信テンプレートの一覧）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-009 全部のテンプレートを 200 の data で返す', async () => {
    setup();

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ROWS });
  });

  it('API-ADMIN-009 id・題・分類・本文・並び順・作った時刻・直した時刻の列だけを取り、絞り込みも件数の上限も付けない', async () => {
    setup();

    await GET(makeRequest());

    const calls = templatesOp()?.calls ?? [];
    expect(calls[0]).toEqual(['select', ['id, title, category, body, sort_order, created_at, updated_at']]);
    expect(calls.some(([m]) => ['eq', 'in', 'or', 'limit'].includes(m))).toBe(false);
  });

  it('API-ADMIN-009 並び順の小さい順、同じなら作った順の2段で並べる', async () => {
    setup();

    await GET(makeRequest());

    const orders = (templatesOp()?.calls ?? []).filter(([m]) => m === 'order');
    expect(orders).toEqual([
      ['order', ['sort_order', { ascending: true }]],
      ['order', ['created_at', { ascending: true }]],
    ]);
  });

  it('API-ADMIN-009 表が空なら空の配列を 200 で返す', async () => {
    setup({ templatesResult: { data: [], error: null } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('API-ADMIN-009 表が null を返した時も空の配列を 200 で返す', async () => {
    setup({ templatesResult: { data: null, error: null } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('API-ADMIN-009 表は contact_reply_templates を service role の client で読み、利用者の JWT の client は使わない', async () => {
    setup();

    await GET(makeRequest());

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(templatesOp()).toBeDefined();
  });

  it('API-ADMIN-009 一覧の読みは監査に残さない', async () => {
    setup();

    await GET(makeRequest());

    expect(serviceClient.ops.some((o) => o.table === 'audit_logs')).toBe(false);
  });

  it('API-ADMIN-009 admin.contact.read だけの権限でも読める', async () => {
    setup({ codes: ['admin.contact.read'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
  });

  it('API-ADMIN-009 admin.contact.read が無く manage だけでは 403 で表を読まない', async () => {
    setup({ codes: ['admin.contact.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.read' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 ほかの領域の権限（looks）だけでは 403 で断る', async () => {
    setup({ codes: ['admin.looks.read', 'admin.looks.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.read' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 session が失効していれば 401 で断る', async () => {
    setup({ liveness: 'revoked' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 session の確認ができない時は 503 と Retry-After で断る', async () => {
    setup({ liveness: 'unavailable' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-009 表の読みが失敗したら 500 Failed to fetch templates を返し、中身を漏らさない', async () => {
    setup({ templatesResult: { data: ROWS, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to fetch templates' });
  });

  it('API-ADMIN-009 認可の後の client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
