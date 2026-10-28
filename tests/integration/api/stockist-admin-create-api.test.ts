export {};

// 窓口・認可（admin-rbac）・回数の制限・守りの部品（admin-security）・監査（audit）は本物を通し、外との境目
// （Supabase の client・token の検証・CSRF の token の照合・応答の型）だけを差し替える
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

jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { requireCsrfOrDeny } = require('@/lib/csrfMiddleware');
const { POST } = require('@/app/api/admin/stockists/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type RpcCall = { name: string; args: Record<string, unknown> };

function createFakeClient(tables: Record<string, Result>, rpcImpl?: (call: RpcCall) => Result) {
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

const VALID = {
  name: 'A Shop',
  address: 'Tokyo, Shibuya 1-1',
  phone: '03-0000-0000',
  time: '11:00-19:00',
  holiday: 'Mon',
  status: 'published',
};

function makeRequest(body: unknown = VALID, options: { jsonThrows?: boolean } = {}) {
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return 'jest-agent';
        if (key === 'x-real-ip') return ' 203.0.113.9 ';
        return null;
      },
    },
    json: jest.fn(async () => {
      if (options.jsonThrows) throw new SyntaxError('Unexpected token');
      return body;
    }),
  } as unknown as Request & { json: jest.Mock };
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    insertResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    rpcImpl?: (call: RpcCall) => Result;
  } = {},
) {
  // 書き込みは認可の後に service role の client 1 つで行う（ADR-0267）。利用者の JWT の client は作られないので、userClient は空のまま。
  userClient = createFakeClient({});
  serviceClient = createFakeClient(
    {
      stockists: options.insertResult ?? { data: { id: 42 }, error: null },
      user_roles: { data: aclRows(options.codes ?? ['admin.stockists.manage']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.rpcImpl,
  );
  createClient.mockResolvedValue(userClient);
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
  requireCsrfOrDeny.mockResolvedValue(undefined);
}

function stockistsOp() {
  return serviceClient.ops.find((o) => o.table === 'stockists');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('POST /api/admin/stockists（取扱店の作成）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-STOCKIST-002 6つの値で1行を入れて新しい id を取り、201 で success と id を返す', async () => {
    setup();

    const res = await POST(makeRequest());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: 42 });
    expect(createClient).not.toHaveBeenCalled();
    expect(userClient.ops).toHaveLength(0);
    expect(stockistsOp()?.calls).toEqual([
      ['insert', [[VALID]]],
      ['select', ['id']],
    ]);
  });

  it('API-STOCKIST-002 type を入れず、本文に余計な項目があっても表へ渡さない', async () => {
    setup();

    await POST(makeRequest({ ...VALID, type: 'select', id: 999, created_at: 'x' }));

    const inserted = (stockistsOp()?.calls[0][1][0] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(inserted).sort()).toEqual(['address', 'holiday', 'name', 'phone', 'status', 'time']);
    expect(inserted).not.toHaveProperty('type');
  });

  it('API-STOCKIST-002 前後の空白を除いて入れ、private の状態も受ける', async () => {
    setup();

    const res = await POST(
      makeRequest({ ...VALID, name: '  A Shop  ', address: '\tTokyo\n', status: 'private' }),
    );

    expect(res.status).toBe(201);
    const inserted = (stockistsOp()?.calls[0][1][0] as Array<Record<string, unknown>>)[0];
    expect(inserted).toMatchObject({ name: 'A Shop', address: 'Tokyo', status: 'private' });
  });

  it('API-STOCKIST-002 各項目の上限ちょうど（255・500・50・120・120 字）は通す', async () => {
    setup();

    const res = await POST(
      makeRequest({
        ...VALID,
        name: 'n'.repeat(255),
        address: 'a'.repeat(500),
        phone: '1'.repeat(50),
        time: 't'.repeat(120),
        holiday: 'h'.repeat(120),
      }),
    );

    expect(res.status).toBe(201);
  });

  it.each([
    ['name', 'n'.repeat(256)],
    ['address', 'a'.repeat(501)],
    ['phone', '1'.repeat(51)],
    ['time', 't'.repeat(121)],
    ['holiday', 'h'.repeat(121)],
  ])('API-STOCKIST-002 %s が上限を 1 字超えると 400 で断り、表に入れない', async (field, value) => {
    setup();

    const res = await POST(makeRequest({ ...VALID, [field]: value }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid request', fields: [field] });
    expect(stockistsOp()).toBeUndefined();
  });

  it.each(['name', 'address', 'phone', 'time', 'holiday', 'status'])(
    'API-STOCKIST-002 %s が無ければ 400 で断り、項目の名前だけの固定の本文を返す',
    async (field) => {
      setup();
      const body: Record<string, unknown> = { ...VALID };
      delete body[field];

      const res = await POST(makeRequest(body));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid request', fields: [field] });
      expect(JSON.stringify(json)).not.toMatch(/details|fieldErrors|formErrors/);
      expect(stockistsOp()).toBeUndefined();
    },
  );

  it('API-STOCKIST-002 空白だけの値は空として 400 で断る', async () => {
    setup();

    const res = await POST(makeRequest({ ...VALID, name: '   ', phone: '\t' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request', fields: ['name', 'phone'] });
  });

  it.each(['draft', 'PUBLISHED', '', null, 1])(
    'API-STOCKIST-002 status が private・published 以外（%p）なら 400 で断る',
    async (status) => {
      setup();

      const res = await POST(makeRequest({ ...VALID, status }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid request', fields: ['status'] });
      expect(stockistsOp()).toBeUndefined();
    },
  );

  it('API-STOCKIST-002 項目の型が文字列でない時も 400 で断る', async () => {
    setup();

    const res = await POST(makeRequest({ ...VALID, name: 123, phone: ['03'] }));

    expect(res.status).toBe(400);
  });

  it('API-STOCKIST-002 成功を監査に残し、操作者・送り元の先頭・user agent・店名を記録する', async () => {
    setup();

    await POST(makeRequest());

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.stockists.create',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'stockists',
      resource_id: '42',
      outcome: 'success',
      detail: 'Created stockist: A Shop',
      ip: '203.0.113.9',
      user_agent: 'jest-agent',
    });
  });

  it('API-STOCKIST-002 入力の誤りは failure として監査に残し、resource_id は付けない', async () => {
    setup();

    await POST(makeRequest({ ...VALID, name: '' }));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.stockists.create',
      outcome: 'failure',
      detail: 'Validation failed',
      actor_id: 'admin-1',
    });
    expect(rows[0].resource_id).toBeUndefined();
  });

  it('API-STOCKIST-002 DB の誤りは 500 Failed to save stockist を返し、error として監査に残す', async () => {
    setup({ insertResult: { data: null, error: { code: '23502', message: 'null value in column "type"' } } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save stockist' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'admin.stockists.create', outcome: 'error', detail: 'DB insert failed' });
    expect(JSON.stringify(rows[0])).not.toContain('23502');
  });

  it('API-STOCKIST-002 x-real-ip が無ければ送り元を null で監査に残す', async () => {
    setup();
    const request = makeRequest();
    (request.headers as unknown as { get: (n: string) => string | null }).get = (name: string) =>
      name.toLowerCase() === 'user-agent' ? 'jest-agent' : null;

    await POST(request);

    expect(auditRows()[0].ip ?? null).toBeNull();
  });

  it('API-STOCKIST-002 JSON でない本文は 500 でなく 400 Invalid request で断り、表に触らず failure を監査に残す', async () => {
    setup();

    const res = await POST(makeRequest(undefined, { jsonThrows: true }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(stockistsOp()).toBeUndefined();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.stockists.create',
      outcome: 'failure',
      detail: 'Invalid JSON',
    });
  });

  it.each([
    ['name', '本店\nInjected'],
    ['address', '東京\u200b都'],
    ['time', '11:00\u2028-19:00'],
    ['holiday', '水曜\r\n木曜'],
    ['phone', '03-1234-5678（代表）'],
  ])('API-STOCKIST-002 %s に許可外の字（改行・書式文字・行区切り・電話の漢字）があると 400 で断り、表に入れない', async (field, value) => {
    setup();

    const res = await POST(makeRequest({ ...VALID, [field]: value }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request', fields: [field] });
    expect(stockistsOp()).toBeUndefined();
  });

  it('API-STOCKIST-002 電話の括弧・プラス・全角の括弧と空白は通す', async () => {
    setup();

    const res = await POST(makeRequest({ ...VALID, phone: '+81 （03）1234-5678　' }));

    expect(res.status).toBe(201);
  });

  it('API-STOCKIST-002 admin.stockists.manage を求め、read だけでは 403 で断って表も触らず、断った要求を失敗の監査に 1 行残す', async () => {
    setup({ codes: ['admin.stockists.read'] });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.manage' });
    expect(requireCsrfOrDeny).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(stockistsOp()).toBeUndefined();
    // detail は共有の監査が JWT 風の文字列（a.b.c）を伏せるので、権限の符号は metadata で確かめる
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.create',
        actor_id: 'admin-1',
        resource: 'stockists',
        outcome: 'failure',
        detail: expect.stringMatching(/^Forbidden: .+ \(permission\)$/),
        metadata: expect.objectContaining({ permission: 'admin.stockists.manage', reason: 'permission' }),
      }),
    ]);
  });

  it('API-STOCKIST-002 aal2 でない session は 403 MFA required で断り、理由 mfa の失敗の監査を 1 行残す', async () => {
    setup({ aal: 'aal1' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.stockists.manage' });
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.create',
        actor_id: 'admin-1',
        outcome: 'failure',
        metadata: expect.objectContaining({ permission: 'admin.stockists.manage', reason: 'mfa' }),
      }),
    ]);
  });

  it('API-STOCKIST-002 token が無効なら 401、session が失効していても 401、確認できなければ 503 で断る', async () => {
    setup({ verified: { ok: false, reason: 'missing' } });
    expect((await POST(makeRequest())).status).toBe(401);
    // token の無い 401 は操作者が分からないので、監査にも操作者の枠にも数えない。数えるのは送り元の枠 1 回だけ（SEC-STOCKIST-021）
    expect(auditRows()).toHaveLength(0);
    expect(serviceClient.rpcCalls.map((c) => String(c.args._endpoint).split('|')[0])).toEqual(['admin:stockists:mutation']);

    // 失効した session の 401 は操作者（token の sub）が分かるので 1 行残す
    setup({ liveness: 'revoked' });
    expect((await POST(makeRequest())).status).toBe(401);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'admin.stockists.create',
        actor_id: 'admin-1',
        outcome: 'failure',
        metadata: expect.objectContaining({ reason: 'session' }),
      }),
    ]);

    setup({ liveness: 'unavailable' });
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-STOCKIST-002 変更の枠 admin:stockists:mutation を送り元と操作者の2本で数える', async () => {
    setup();

    await POST(makeRequest());

    expect(serviceClient.rpcCalls).toHaveLength(2);
    expect(serviceClient.rpcCalls[0].args._endpoint).toBe('admin:stockists:mutation');
    expect(serviceClient.rpcCalls[0].args._ip).toBe('203.0.113.9');
    expect(String(serviceClient.rpcCalls[1].args._endpoint)).toMatch(/^admin:stockists:mutation\|acct:/);
  });

  it('API-STOCKIST-002 変更の回数が 20 回ちょうどなら通し、21 回目は 429 で断って CSRF も入力も見ない', async () => {
    setup({ rpcImpl: () => ({ data: 20, error: null }) });
    expect((await POST(makeRequest())).status).toBe(201);

    setup({ rpcImpl: () => ({ data: 21, error: null }) });
    requireCsrfOrDeny.mockClear();
    const request = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(requireCsrfOrDeny).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
    expect(stockistsOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-STOCKIST-002 回数を数える DB が使えない時は 503 で断る', async () => {
    setup({ rpcImpl: () => ({ data: null, error: { message: 'rpc down' } }) });

    const res = await POST(makeRequest());

    expect(res.status).toBe(503);
    expect(stockistsOp()).toBeUndefined();
  });

  it('API-STOCKIST-002 CSRF の token が通らなければ 403 でそのまま返し、入力を読まず表にも監査にも触らない', async () => {
    setup();
    requireCsrfOrDeny.mockResolvedValue({
      status: 403,
      _body: { error: 'Forbidden', reason: 'CSRF validation failed' },
      headers: new Map(),
    });
    const request = makeRequest();

    const res = await POST(request);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
    expect(request.json).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-STOCKIST-002 送り元の枠・認可・操作者の枠・CSRF・入力の確かめ・表・監査の順に進める', async () => {
    setup();
    const order: string[] = [];
    verifyAccessToken.mockImplementation(async () => {
      order.push('authz');
      return { ok: true, claims: { sub: 'admin-1', session_id: 's', aal: 'aal2', app_metadata: {} } };
    });
    serviceClient.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      order.push(`rate:${String(args._endpoint).split('|')[0]}`);
      return { data: 1, error: null };
    });
    requireCsrfOrDeny.mockImplementation(async () => {
      order.push('csrf');
    });
    const request = makeRequest();
    request.json.mockImplementation(async () => {
      order.push('body');
      return VALID;
    });
    const fromImpl = serviceClient.from.getMockImplementation() as (table: string) => Record<string, unknown>;
    serviceClient.from.mockImplementation((table: string) => {
      if (table === 'stockists') order.push('db');
      return fromImpl(table);
    });

    await POST(request);

    expect(order).toEqual([
      'rate:admin:stockists:mutation',
      'authz',
      'rate:admin:stockists:mutation',
      'csrf',
      'body',
      'db',
    ]);
  });
});
