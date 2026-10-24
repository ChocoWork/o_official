export {};

// 管理の書き換えの道（認可 → 送り元と操作者の回数 → service role で DB → 監査）を、
// 窓口・admin-rbac・回数の制限（admin-rate-limit と ratelimit）・audit を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・token の検証・応答の型）だけ
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
const listRoute = require('@/app/api/admin/looks/route');
const itemRoute = require('@/app/api/admin/looks/[id]/route');

type Result = { data: unknown; error: unknown };
type Method = 'select' | 'insert' | 'update' | 'delete';
type TableSpec = Partial<Record<Method, Result>>;
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type RpcCall = { name: string; args: Record<string, unknown> };

const WRITE_METHODS = ['insert', 'update', 'delete'];
const NONE: Result = { data: null, error: null };

function createFakeClient(
  tables: Record<string, TableSpec>,
  options: { rpcImpl?: (call: RpcCall) => Result; throwTables?: string[] } = {},
) {
  const ops: TableOp[] = [];
  const uploads: string[] = [];
  const rpcCalls: RpcCall[] = [];
  const order: string[] = [];
  const client = {
    ops,
    uploads,
    rpcCalls,
    order,
    rpc: jest.fn(async (name: string, args: Record<string, unknown>) => {
      const call = { name, args };
      rpcCalls.push(call);
      order.push(`rpc:${args._endpoint}`);
      return options.rpcImpl ? options.rpcImpl(call) : { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = (): Result => {
        const written = op.calls.map(([m]) => m).find((m) => WRITE_METHODS.includes(m)) as Method | undefined;
        order.push(`${table}.${written ?? 'select'}`);
        if (options.throwTables?.includes(table)) throw new Error(`${table} exploded`);
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
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(async (path: string) => {
          uploads.push(path);
          return { data: {}, error: null };
        }),
        createSignedUrl: jest.fn(async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}` }, error: null })),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeImage(): File {
  const file = new File(['img'], 'a.jpg', { type: 'image/jpeg' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new Uint8Array([1]).buffer });
  return file;
}

const formFields: Record<string, unknown> = {
  seasonYear: '2026',
  seasonType: 'SS',
  theme: 'Quiet morning',
  themeDescription: 'Soft light',
  status: 'published',
  linkedItemIds: JSON.stringify([3, 5]),
};

function makeRequest(options: { form?: Record<string, unknown>; images?: unknown[]; json?: unknown; origin?: string } = {}) {
  const form = options.form ?? {};
  const images = options.images ?? [];
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return 'jest-agent';
        if (key === 'x-forwarded-for') return '203.0.113.9';
        if (key === 'origin') return options.origin ?? null;
        return null;
      },
    },
    formData: jest.fn(async () => ({
      get: (key: string) => (key in form ? form[key] : null),
      getAll: (key: string) => (key === 'images' ? images : []),
    })),
    json: jest.fn(async () => options.json),
  } as unknown as Request & { formData: jest.Mock; json: jest.Mock };
}

const params = () => ({ params: Promise.resolve({ id: '7' }) });

type Handler = {
  name: string;
  call: (request: Request) => Promise<{ status: number; headers: Map<string, string>; json: () => Promise<unknown> }>;
  request: () => Request & { formData: jest.Mock; json: jest.Mock };
  kind: string;
  limit: number;
  successStatus: number;
  successAction: string;
  failureAction: string;
  failureStatus: number;
  failureBody: unknown;
  failureDetail: string;
  unexpectedDetail: string;
  crashTable: string;
  resourceId: string;
};

const HANDLERS: Handler[] = [
  {
    name: 'POST /api/admin/looks',
    call: (request) => listRoute.POST(request),
    request: () => makeRequest({ form: formFields, images: [makeImage()] }),
    kind: 'create',
    limit: 10,
    successStatus: 201,
    successAction: 'admin.look.create',
    failureAction: 'admin.look.create',
    failureStatus: 500,
    failureBody: { error: 'Failed to save look' },
    failureDetail: 'Failed to insert look',
    unexpectedDetail: 'Unexpected create error',
    crashTable: 'items',
    resourceId: '11',
  },
  {
    name: 'PUT /api/admin/looks/[id]',
    call: (request) => itemRoute.PUT(request, params()),
    request: () => makeRequest({ form: formFields }),
    kind: 'update',
    limit: 15,
    successStatus: 200,
    successAction: 'admin.look.update',
    failureAction: 'admin.look.update',
    failureStatus: 500,
    failureBody: { error: 'Failed to update look' },
    failureDetail: 'Failed to update look',
    unexpectedDetail: 'Unexpected update error',
    crashTable: 'looks',
    resourceId: '7',
  },
  {
    name: 'PATCH /api/admin/looks/[id]',
    call: (request) => itemRoute.PATCH(request, params()),
    request: () => makeRequest({ json: { status: 'private' } }),
    kind: 'status',
    limit: 30,
    successStatus: 200,
    successAction: 'admin.look.status_update',
    failureAction: 'admin.look.status_update',
    failureStatus: 500,
    failureBody: { error: 'Failed to update status' },
    failureDetail: 'Failed to update look status',
    unexpectedDetail: 'Unexpected status update error',
    crashTable: 'looks',
    resourceId: '7',
  },
  {
    name: 'DELETE /api/admin/looks/[id]',
    call: (request) => itemRoute.DELETE(request, params()),
    request: () => makeRequest(),
    kind: 'delete',
    limit: 30,
    successStatus: 200,
    successAction: 'admin.look.delete',
    failureAction: 'admin.look.delete',
    failureStatus: 500,
    failureBody: { error: 'Failed to delete look' },
    failureDetail: 'Failed to delete look',
    unexpectedDetail: 'Unexpected delete error',
    crashTable: 'looks',
    resourceId: '7',
  },
];

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    lookWriteError?: unknown;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    rpcImpl?: (call: RpcCall) => Result;
    throwTables?: string[];
    lookRows?: Result;
  } = {},
) {
  const writeResult: Result = options.lookWriteError ? { data: null, error: options.lookWriteError } : NONE;
  serviceClient = createFakeClient(
    {
      user_roles: { select: { data: aclRows(options.codes ?? ['admin.looks.read', 'admin.looks.manage']), error: null } },
      audit_logs: { insert: options.auditResult ?? NONE },
      items: { select: { data: [{ id: 3 }, { id: 5 }], error: null } },
      looks: {
        select: options.lookRows ?? { data: { id: 7, status: 'private', image_urls: ['looks/old/a.jpg'] }, error: null },
        insert: options.lookWriteError ? writeResult : { data: { id: 11 }, error: null },
        update: writeResult,
        delete: writeResult,
      },
      look_items: { insert: NONE, delete: NONE },
    },
    { rpcImpl: options.rpcImpl, throwTables: options.throwTables },
  );
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', email: 'admin@example.com', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

function tablesTouched() {
  return serviceClient.ops.map((o) => o.table).filter((t) => t !== 'user_roles');
}

function counterCalls() {
  return serviceClient.rpcCalls.filter((c) => !String(c.args._endpoint).includes('upload-bytes'));
}

describe('管理の書き換えの道（ARC-LOOK-002）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(HANDLERS)('$name', (handler) => {
    it('ARC-LOOK-002 DB の書き換えは service role の client で行い、利用者の JWT の client は使わない', async () => {
      setup();

      const res = await handler.call(handler.request());

      expect(res.status).toBe(handler.successStatus);
      expect(createServiceRoleClient).toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(tablesTouched()).toContain('looks');
    });

    it('ARC-LOOK-002 権限を確かめた後に、送り元と操作者の2段で回数を数えてから DB を触る', async () => {
      setup();

      await handler.call(handler.request());

      const counters = counterCalls();
      expect(counters).toHaveLength(2);
      expect(counters[0].args).toMatchObject({ _ip: '203.0.113.9', _endpoint: `admin:looks:${handler.kind}` });
      expect(String(counters[1].args._endpoint)).toMatch(new RegExp(`^admin:looks:${handler.kind}\\|acct:[0-9a-f]{128}$`));
      expect(counters[1].args._ip).toBeNull();
      expect(JSON.stringify(counters)).not.toContain('admin-1');
      const order = serviceClient.order;
      const isCounter = (s: string) => s.startsWith('rpc:') && !s.includes('upload-bytes');
      const lastCounter = order.map(isCounter).lastIndexOf(true);
      const firstLookWrite = order.findIndex((s) => s.startsWith('looks.') || s.startsWith('items.'));
      expect(order.indexOf('user_roles.select')).toBeLessThan(order.findIndex(isCounter));
      expect(lastCounter).toBeLessThan(firstLookWrite);
    });

    it('ARC-LOOK-002 送り元の段が上限ちょうどなら通し、1回超えたら 429 で断って本文・DB・監査に触らない', async () => {
      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? handler.limit : 1, error: null }) });
      expect((await handler.call(handler.request())).status).toBe(handler.successStatus);

      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? handler.limit + 1 : 1, error: null }) });
      const request = handler.request();
      const res = await handler.call(request);

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many requests' });
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(request.formData).not.toHaveBeenCalled();
      expect(request.json).not.toHaveBeenCalled();
      expect(tablesTouched()).toEqual([]);
      expect(serviceClient.rpcCalls).toHaveLength(1);
    });

    it('ARC-LOOK-002 操作者の段が上限を超えたら、送り元を変えても 429 で断る', async () => {
      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? 1 : handler.limit + 1, error: null }) });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(429);
      expect(tablesTouched()).toEqual([]);
      expect(auditRows()).toHaveLength(0);
    });

    it('ARC-LOOK-002 数え場所が使えない時は通さず 503 で断る', async () => {
      setup({ rpcImpl: () => ({ data: null, error: { message: 'rpc down' } }) });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
      expect(tablesTouched()).toEqual([]);
    });

    it('ARC-LOOK-002 成功を監査に残し、resource・利用者・user agent を記録して IP は残さない', async () => {
      setup();

      await handler.call(handler.request());

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction,
        actor_id: 'admin-1',
        actor_email: 'admin@example.com',
        resource: 'look',
        resource_id: handler.resourceId,
        outcome: 'success',
        user_agent: 'jest-agent',
      });
      expect(rows[0].ip).toBeUndefined();
      expect(JSON.stringify(rows[0])).not.toContain('203.0.113.9');
    });

    it('ARC-LOOK-002 DB の書き換えが失敗したら 500 を返し、失敗を監査に残す', async () => {
      setup({ lookWriteError: { code: '42501', message: 'denied' } });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(handler.failureStatus);
      expect(await res.json()).toEqual(handler.failureBody);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.failureAction,
        outcome: 'failure',
        detail: handler.failureDetail,
        actor_id: 'admin-1',
        resource: 'look',
      });
    });

    it('ARC-LOOK-002 認可の後に想定外の例外が出たら 500 を返し、操作者を付けて失敗を監査に残す', async () => {
      setup({ throwTables: [handler.crashTable] });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(auditRows()[0]).toMatchObject({
        action: handler.failureAction,
        outcome: 'failure',
        detail: handler.unexpectedDetail,
        actor_id: 'admin-1',
      });
    });

    it('ARC-LOOK-002 監査の書き込みが失敗しても操作は止めず、警告だけ出す', async () => {
      setup({ auditResult: { data: null, error: { message: 'audit down' } } });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(handler.successStatus);
      expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
    });

    it('ARC-LOOK-002 admin.looks.manage を求め、read だけの利用者は 403 で断って回数も DB も監査も触らない', async () => {
      setup({ codes: ['admin.looks.read'] });
      const request = handler.request();

      const res = await handler.call(request);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.manage' });
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(tablesTouched()).toEqual([]);
      expect(request.formData).not.toHaveBeenCalled();
    });

    it('ARC-LOOK-002 aal2 でない session は 403 MFA required で断り、回数も数えない', async () => {
      setup({ aal: 'aal1' });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'MFA required' });
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(tablesTouched()).toEqual([]);
    });

    it('ARC-LOOK-002 token が無ければ 401 で断る', async () => {
      setup({ verified: { ok: false, reason: 'missing' } });

      const res = await handler.call(handler.request());

      expect(res.status).toBe(401);
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(tablesTouched()).toEqual([]);
    });

    it('ARC-LOOK-002 session が失効していれば 401、生存を確かめられなければ 503 で断る', async () => {
      setup({ liveness: 'revoked' });
      expect((await handler.call(handler.request())).status).toBe(401);

      setup({ liveness: 'unavailable' });
      expect((await handler.call(handler.request())).status).toBe(503);
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(tablesTouched()).toEqual([]);
    });

    it('ARC-LOOK-002 Origin は窓口で確かめず、見出しが何であっても権限と回数の確かめだけで進める（proxy に任せる）', async () => {
      setup();
      const request = makeRequest({
        form: formFields,
        images: [makeImage()],
        json: { status: 'private' },
        origin: 'https://evil.example',
      });

      const res = await handler.call(request);

      expect(res.status).toBe(handler.successStatus);
    });
  });

  it('ARC-LOOK-002 変更の種類ごとに回数の数え場所を分ける（作成・更新・状態の変更・削除）', async () => {
    const endpoints: string[] = [];
    for (const handler of HANDLERS) {
      setup();
      await handler.call(handler.request());
      endpoints.push(String(counterCalls()[0].args._endpoint));
    }

    expect(endpoints).toEqual(['admin:looks:create', 'admin:looks:update', 'admin:looks:status', 'admin:looks:delete']);
  });

  it('ARC-LOOK-002 作成だけ画像を上げ、置き場への書き込みも service role の client で行う', async () => {
    setup();

    await listRoute.POST(makeRequest({ form: formFields, images: [makeImage()] }));

    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.storage.from).toHaveBeenCalledWith('look-images');
  });

  it('ARC-LOOK-002 更新で画像を付けた時は、画像の量も数えて置き場へ上げる', async () => {
    setup();

    const res = await itemRoute.PUT(makeRequest({ form: formFields, images: [makeImage()] }), params());

    expect(res.status).toBe(200);
    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.rpcCalls.some((c) => String(c.args._endpoint).startsWith('admin:looks:update:upload-bytes'))).toBe(true);
  });

  it('ARC-LOOK-002 一覧と1件の GET は admin.looks.read で読み、回数を数えず監査にも残さない', async () => {
    setup({ codes: ['admin.looks.read'], lookRows: { data: [], error: null } });
    const listRes = await listRoute.GET(makeRequest());
    expect(listRes.status).toBe(200);
    expect(serviceClient.rpcCalls).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);

    setup({ codes: ['admin.looks.read'], lookRows: { data: { id: 7, image_urls: [] }, error: null } });
    const itemRes = await itemRoute.GET(makeRequest(), params());
    expect(itemRes.status).toBe(200);
    expect(serviceClient.rpcCalls).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('ARC-LOOK-002 manage だけで read を持たない利用者は GET を 403 で断られる（権限は操作ごとに分かれる）', async () => {
    setup({ codes: ['admin.looks.manage'] });
    const listRes = await listRoute.GET(makeRequest());
    expect(listRes.status).toBe(403);
    expect(await listRes.json()).toMatchObject({ permission: 'admin.looks.read' });

    setup({ codes: ['admin.looks.manage'] });
    const itemRes = await itemRoute.GET(makeRequest(), params());
    expect(itemRes.status).toBe(403);
    expect(tablesTouched()).toEqual([]);
  });
});
