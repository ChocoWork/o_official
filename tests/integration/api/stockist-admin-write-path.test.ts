export {};

// 管理の書き換えの道（認可 → 送り元と操作者の回数 → CSRF の token → 利用者の JWT の client で DB → 監査）を、
// 窓口・admin-rbac・守りの部品（admin-security と ratelimit）・audit を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・token の検証・CSRF の token の照合・応答の型）だけ
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
const listRoute = require('@/app/api/admin/stockists/route');
const itemRoute = require('@/app/api/admin/stockists/[id]/route');

type Result = { data: unknown; error: unknown };
type Method = 'select' | 'insert' | 'update' | 'delete';
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

const WRITE_METHODS = ['insert', 'update', 'delete'];
const NONE: Result = { data: null, error: null };

function createFakeClient(tables: Record<string, Partial<Record<Method, Result>>>, order?: string[]) {
  const ops: TableOp[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  return {
    ops,
    rpcCalls,
    rpc: jest.fn(async (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      order?.push('rate');
      return { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = (): Result => {
        const written = op.calls.map(([m]) => m).find((m) => WRITE_METHODS.includes(m)) as Method | undefined;
        order?.push(`${table}.${written ?? 'select'}`);
        return tables[table]?.[written ?? 'select'] ?? NONE;
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve().then(result);
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve().then(result).then(onF, onR);
      return builder;
    }),
  };
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

const VALID = {
  name: 'A Shop',
  address: 'Tokyo',
  phone: '03-0000-0000',
  time: '11:00-19:00',
  holiday: 'Mon',
  status: 'published',
};

function makeRequest(json?: unknown) {
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return 'jest-agent';
        if (key === 'x-real-ip') return '203.0.113.9';
        return null;
      },
    },
    json: jest.fn(async () => json),
  } as unknown as Request;
}

const params = (id = '7') => ({ params: Promise.resolve({ id }) });

type Handler = {
  name: string;
  call: (id?: string) => Promise<{ status: number; headers: Map<string, string>; json: () => Promise<unknown> }>;
  writeMethod: Method;
  successStatus: number;
  successAction: string;
  failureBody: unknown;
  failureDetail: string;
  resourceId: string;
};

const MUTATIONS: Handler[] = [
  {
    name: 'POST /api/admin/stockists',
    call: () => listRoute.POST(makeRequest(VALID)),
    writeMethod: 'insert',
    successStatus: 201,
    successAction: 'admin.stockists.create',
    failureBody: { error: 'Failed to save stockist' },
    failureDetail: 'DB insert failed',
    resourceId: '11',
  },
  {
    name: 'PUT /api/admin/stockists/[id]',
    call: (id) => itemRoute.PUT(makeRequest(VALID), params(id)),
    writeMethod: 'update',
    successStatus: 200,
    successAction: 'admin.stockists.update',
    failureBody: { error: 'Failed to update stockist' },
    failureDetail: 'DB update failed',
    resourceId: '7',
  },
  {
    name: 'PATCH /api/admin/stockists/[id]',
    call: (id) => itemRoute.PATCH(makeRequest({ status: 'private' }), params(id)),
    writeMethod: 'update',
    successStatus: 200,
    successAction: 'admin.stockists.patch',
    failureBody: { error: 'Failed to update status' },
    failureDetail: 'DB update failed',
    resourceId: '7',
  },
  {
    name: 'DELETE /api/admin/stockists/[id]',
    call: (id) => itemRoute.DELETE(makeRequest(), params(id)),
    writeMethod: 'delete',
    successStatus: 200,
    successAction: 'admin.stockists.delete',
    failureBody: { error: 'Failed to delete stockist' },
    failureDetail: 'DB delete failed',
    resourceId: '7',
  },
];

const READS = [
  { name: 'GET /api/admin/stockists', call: () => listRoute.GET(makeRequest()), rows: [{ id: 1 }, { id: 2 }] },
  { name: 'GET /api/admin/stockists/[id]', call: () => itemRoute.GET(makeRequest(), params()), rows: { id: 7 } },
];

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;
let order: string[];

function setup(
  options: {
    stockistsResult?: Result;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    readRows?: unknown;
  } = {},
) {
  order = [];
  // 作成は .select('id').single() の 1 行、更新は .select('id') の行の配列、削除は .select('id, name, address, status') の消した行の配列
  const ok: Result = options.stockistsResult ?? { data: { id: 11 }, error: null };
  const updated: Result = options.stockistsResult ?? { data: [{ id: 7 }], error: null };
  const deleted: Result = options.stockistsResult ?? {
    data: [{ id: 7, name: 'A Shop', address: 'Tokyo', status: 'published' }],
    error: null,
  };
  userClient = createFakeClient({ stockists: { select: { data: options.readRows ?? ok.data, error: ok.error }, insert: ok, update: updated, delete: deleted } }, order);
  serviceClient = createFakeClient(
    {
      user_roles: { select: { data: aclRows(options.codes ?? ['admin.stockists.read', 'admin.stockists.manage']), error: null } },
      audit_logs: { insert: options.auditResult ?? NONE },
      // 書き込みは認可の後に service role の client で行う（ADR-0267）
      stockists: { select: { data: options.readRows ?? ok.data, error: ok.error }, insert: ok, update: updated, delete: deleted },
    },
    order,
  );
  createClient.mockImplementation(async () => {
    order.push('client');
    return userClient;
  });
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockImplementation(async () => {
    order.push('authz');
    return (
      options.verified ?? {
        ok: true,
        claims: { sub: 'admin-1', email: 'admin@example.com', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
      }
    );
  });
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
  requireCsrfOrDeny.mockImplementation(async () => {
    order.push('csrf');
  });
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

function userCalls() {
  return userClient.ops.filter((o) => o.table === 'stockists').flatMap((o) => o.calls.map(([m]) => m));
}

function serviceCalls() {
  return serviceClient.ops.filter((o) => o.table === 'stockists').flatMap((o) => o.calls.map(([m]) => m));
}

describe('管理の書き換えの道（ARC-STOCKIST-002）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(MUTATIONS)('$name', (handler) => {
    it('ARC-STOCKIST-002 表の書き換えは認可の後に service role の client で行い、要求の JWT の client は作らない', async () => {
      setup();

      const res = await handler.call();

      expect(res.status).toBe(handler.successStatus);
      expect(createClient).not.toHaveBeenCalled();
      expect(userCalls()).toEqual([]);
      expect(serviceCalls()).toContain(handler.writeMethod);
    });

    it('ARC-STOCKIST-002 送り元の枠・認可・操作者の枠・CSRF の token・表の書き換え・監査の順に進める', async () => {
      setup();

      await handler.call();

      expect(order).toEqual([
        'rate',
        'authz',
        'user_roles.select',
        'rate',
        'csrf',
        `stockists.${handler.writeMethod}`,
        'audit_logs.insert',
      ]);
    });

    it('ARC-STOCKIST-002 成功を監査に残し、resource・操作者・送り元・user agent を記録する', async () => {
      setup();

      await handler.call();

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction,
        actor_id: 'admin-1',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        outcome: 'success',
        ip: '203.0.113.9',
        user_agent: 'jest-agent',
      });
      expect(rows[0].resource_id).toBe(handler.resourceId);
    });

    it('ARC-STOCKIST-002 表の書き換えが失敗したら 500 を返し、error として監査に残す', async () => {
      setup({ stockistsResult: { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } });

      const res = await handler.call();

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(handler.failureBody);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction,
        outcome: 'error',
        detail: handler.failureDetail,
        actor_id: 'admin-1',
      });
    });

    it('ARC-STOCKIST-002 監査の書き込みが失敗しても操作は止めず、警告だけ出す', async () => {
      setup({ auditResult: { data: null, error: { message: 'audit down' } } });

      const res = await handler.call();

      expect(res.status).toBe(handler.successStatus);
      expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
    });

    it('ARC-STOCKIST-002 admin.stockists.manage を求め、read だけの利用者は 403 で断って表を触らず、失敗の監査を 1 行残す', async () => {
      setup({ codes: ['admin.stockists.read'] });

      const res = await handler.call();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.stockists.manage' });
      expect(requireCsrfOrDeny).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(serviceCalls()).toEqual([]);
      // detail は共有の監査が JWT 風の文字列（a.b.c）を伏せるので、権限の符号は metadata で確かめる
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: handler.successAction,
          actor_id: 'admin-1',
          resource: 'stockists',
          outcome: 'failure',
          detail: expect.stringMatching(/^Forbidden: .+ \(permission\)$/),
          metadata: expect.objectContaining({ permission: 'admin.stockists.manage', reason: 'permission' }),
          ip: '203.0.113.9',
          user_agent: 'jest-agent',
        }),
      ]);
    });

    it('ARC-STOCKIST-002 aal2 でない session は 403 MFA required で断り、理由 mfa の失敗の監査を 1 行残す', async () => {
      setup({ aal: 'aal1' });

      const res = await handler.call();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'MFA required' });
      expect(createClient).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([
        expect.objectContaining({ actor_id: 'admin-1', outcome: 'failure', metadata: expect.objectContaining({ reason: 'mfa' }) }),
      ]);
    });

    it('ARC-STOCKIST-002 token が無ければ 401、session が失効していても 401、確認できなければ 503 で断る', async () => {
      setup({ verified: { ok: false, reason: 'missing' } });
      expect((await handler.call()).status).toBe(401);
      // token の無い 401 は操作者が分からないので監査に残さず、操作者の枠にも数えない（送り元の枠 1 回だけ）
      expect(auditRows()).toHaveLength(0);
      expect(serviceClient.rpcCalls).toHaveLength(1);

      setup({ liveness: 'revoked' });
      expect((await handler.call()).status).toBe(401);
      // 失効した session の 401 は操作者（token の sub）が分かるので 1 行残す
      expect(auditRows()).toEqual([
        expect.objectContaining({ actor_id: 'admin-1', outcome: 'failure', metadata: expect.objectContaining({ reason: 'session' }) }),
      ]);

      // 失効の確認ができない 503 は拒否ではないので残さない
      setup({ liveness: 'unavailable' });
      expect((await handler.call()).status).toBe(503);
      expect(auditRows()).toHaveLength(0);

      expect(createClient).not.toHaveBeenCalled();
    });

    it('ARC-STOCKIST-002 権限を 1 つも持たない利用者の 403 も、操作者が分かるので失敗の監査を 1 行残す', async () => {
      setup({ codes: [] });

      await handler.call();

      expect(auditRows()).toEqual([expect.objectContaining({ actor_id: 'admin-1', outcome: 'failure' })]);
    });
  });

  describe.each(MUTATIONS.slice(1))('$name の id の確かめ', (handler) => {
    it.each(['abc', '0', '-3', '1.5', '', '1e30', '9007199254740993'])('ARC-STOCKIST-002 id が正の整数でない（%p）時は認可より前に 400 で断る', async (id) => {
      setup();

      const res = await handler.call(id);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid stockist id' });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(auditRows()).toHaveLength(0);
      // 送り元の枠は最初に数える。操作者の枠は認可の後なので数えない
      expect(serviceClient.rpcCalls).toHaveLength(1);
    });
  });

  it.each(READS)('ARC-STOCKIST-002 $name は admin.stockists.read で要求の JWT の client から読み、監査に残さない', async (read) => {
    setup({ codes: ['admin.stockists.read'], readRows: read.rows });

    const res = await read.call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: read.rows });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(requireCsrfOrDeny).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
    expect(serviceClient.ops.some((o) => o.table === 'stockists')).toBe(false);
  });

  it.each(READS)('ARC-STOCKIST-002 $name は manage だけの利用者を 403 で断る', async (read) => {
    setup({ codes: ['admin.stockists.manage'] });

    const res = await read.call();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'admin.stockists.read' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('ARC-STOCKIST-002 1件の GET は行が無ければ 404 Stockist not found を返す', async () => {
    setup({ codes: ['admin.stockists.read'], stockistsResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } } });

    const res = await itemRoute.GET(makeRequest(), params('404'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Stockist not found' });
  });

  // SEC-STOCKIST-013。0 件（無い、または RLS が隠した）は成功にせず、404 と failure の監査にする
  it.each([
    ['空の配列', []],
    ['null', null],
  ])('ARC-STOCKIST-002 対象の行が0件（%s）の PUT・PATCH・DELETE は 404 を返し、監査に success を残さず failure を残す', async (_label, data) => {
    for (const handler of MUTATIONS.slice(1)) {
      setup({ stockistsResult: { data, error: null } });

      const res = await handler.call();

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Stockist not found' });
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction,
        outcome: 'failure',
        detail: 'Stockist not found',
        resource_id: '7',
      });
    }
  });

  it('ARC-STOCKIST-002 入力の誤りは書き換えず、failure として監査に残す', async () => {
    setup();

    const res = await itemRoute.PATCH(makeRequest({ status: 'draft' }), params());

    expect(res.status).toBe(400);
    expect(userCalls()).toEqual([]);
    expect(serviceCalls()).toEqual([]);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.stockists.patch',
      outcome: 'failure',
      detail: 'Validation failed',
      resource_id: '7',
    });
  });

  it('ARC-STOCKIST-002 表の書き換えの client を作れず例外が出たら 500 Internal server error を返す', async () => {
    setup();
    // CSRF の確かめを過ぎた後（書き換えの client の作成）だけ失敗させる
    createServiceRoleClient.mockImplementation(async () => {
      if (order.includes('csrf')) throw new Error('boom');
      return serviceClient;
    });

    const res = await listRoute.POST(makeRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
