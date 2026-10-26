import { minimalJpeg } from '../../fixtures/images';

// 管理の書き換えの道（認可 → 利用者の JWT の client → 監査）を、窓口・admin-rbac・audit を本物のまま通して確かめる。
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
const listRoute = require('@/app/api/admin/news/route');
const itemRoute = require('@/app/api/admin/news/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>) {
  const ops: TableOp[] = [];
  const uploads: string[] = [];
  const client = {
    ops,
    uploads,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.maybeSingle = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(async (path: string) => {
          uploads.push(path);
          return { data: {}, error: null };
        }),
        remove: jest.fn(async () => ({ data: null, error: null })),
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
  const file = new File([new Uint8Array(minimalJpeg())], 'a.jpg', { type: 'image/jpeg' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new Uint8Array(minimalJpeg()).buffer });
  return file;
}

const formFields = {
  title: 'Title',
  category: 'EVENT',
  date: '2026-10-24',
  content: 'Summary',
  detailedContent: 'Body',
  status: 'published',
};

function makeRequest(options: { form?: Record<string, unknown>; json?: unknown } = {}) {
  const form = options.form ?? {};
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return 'jest-agent';
        if (key === 'x-forwarded-for') return '203.0.113.9';
        return null;
      },
    },
    formData: jest.fn(async () => ({ get: (key: string) => (key in form ? form[key] : null) })),
    json: jest.fn(async () => options.json),
  } as unknown as Request;
}

const params = () => ({ params: Promise.resolve({ id: '7' }) });

type Handler = {
  name: string;
  call: () => Promise<{ status: number; json: () => Promise<unknown> }>;
  successAction: string;
  failureAction: string;
  failureStatusBody: unknown;
  writeMethod: string;
  resourceId: string;
};

const HANDLERS: Handler[] = [
  {
    name: 'POST /api/admin/news',
    call: () => listRoute.POST(makeRequest({ form: { ...formFields, image: makeImage() } })),
    successAction: 'admin.news.create',
    failureAction: 'admin.news.create.db_insert_failed',
    failureStatusBody: { error: 'Failed to save news article' },
    writeMethod: 'insert',
    resourceId: '7',
  },
  {
    name: 'PUT /api/admin/news/[id]',
    call: () => itemRoute.PUT(makeRequest({ form: { ...formFields } }), params()),
    successAction: 'admin.news.update',
    failureAction: 'admin.news.update.failed',
    failureStatusBody: { error: 'Failed to update news article' },
    writeMethod: 'update',
    resourceId: '7',
  },
  {
    name: 'PATCH /api/admin/news/[id]',
    call: () => itemRoute.PATCH(makeRequest({ json: { status: 'private' } }), params()),
    successAction: 'admin.news.status_update',
    failureAction: 'admin.news.status_update.failed',
    failureStatusBody: { error: 'Failed to update status' },
    writeMethod: 'update',
    resourceId: '7',
  },
  {
    name: 'DELETE /api/admin/news/[id]',
    call: () => itemRoute.DELETE(makeRequest(), params()),
    successAction: 'admin.news.delete',
    failureAction: 'admin.news.delete.failed',
    failureStatusBody: { error: 'Failed to delete article' },
    writeMethod: 'delete',
    resourceId: '7',
  },
];

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(options: {
  newsResult?: Result;
  auditResult?: Result;
  codes?: string[];
  aal?: string;
  verified?: unknown;
  liveness?: string;
} = {}) {
  // 書き込みは認可の後に service role の client で行う（ADR-0026）。userClient の表は GET の読みだけが触る。
  const newsResult = options.newsResult ?? { data: { id: 7 }, error: null };
  userClient = createFakeClient({ news_articles: newsResult });
  serviceClient = createFakeClient({
    user_roles: { data: aclRows(options.codes ?? ['admin.news.read', 'admin.news.manage']), error: null },
    audit_logs: options.auditResult ?? { data: null, error: null },
    news_articles: newsResult,
  });
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? { ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } } },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

function serviceWriteCalls() {
  return serviceClient.ops.filter((o) => o.table === 'news_articles').flatMap((o) => o.calls.map(([m]) => m));
}

describe('管理の書き換えの道（ARC-NEWS-002）', () => {
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
    it('ARC-NEWS-002 表の書き換えは認可の後に service role の client で行い、利用者の JWT の client は作らない', async () => {
      setup();

      const res = await handler.call();

      expect(res.status).toBe(handler.name.startsWith('POST') ? 201 : 200);
      expect(createClient).not.toHaveBeenCalled();
      expect(userClient.ops).toHaveLength(0);
      expect(serviceWriteCalls()).toContain(handler.writeMethod);
    });

    it('ARC-NEWS-002 成功を監査に残し、resource・利用者・user agent を記録して IP は残さない', async () => {
      setup();

      await handler.call();

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction,
        actor_id: 'admin-1',
        resource: 'news_article',
        resource_id: handler.resourceId,
        outcome: 'success',
        user_agent: 'jest-agent',
      });
      expect(rows[0].ip).toBeUndefined();
      expect(JSON.stringify(rows[0])).not.toContain('203.0.113.9');
    });

    it('ARC-NEWS-002 表の書き換えが失敗したら 500 を返し、失敗を監査に残す', async () => {
      setup({ newsResult: { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } });

      const res = await handler.call();

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(handler.failureStatusBody);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: handler.failureAction, outcome: 'failure', actor_id: 'admin-1' });
    });

    it('ARC-NEWS-002 監査の書き込みが失敗しても操作は止めず、警告だけ出す', async () => {
      setup({ auditResult: { data: null, error: { message: 'audit down' } } });

      const res = await handler.call();

      expect(res.status).toBe(handler.name.startsWith('POST') ? 201 : 200);
      expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
    });

    it('ARC-NEWS-002 admin.news.manage を求め、read だけの利用者は 403 で断って表も監査も触らない', async () => {
      setup({ codes: ['admin.news.read'] });

      const res = await handler.call();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.manage' });
      expect(createClient).not.toHaveBeenCalled();
      expect(serviceWriteCalls()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('ARC-NEWS-002 aal2 でない session は 403 MFA required で断る', async () => {
      setup({ aal: 'aal1' });

      const res = await handler.call();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'MFA required' });
      expect(createClient).not.toHaveBeenCalled();
      expect(serviceWriteCalls()).toHaveLength(0);
    });

    it('ARC-NEWS-002 token が無ければ 401 で断る', async () => {
      setup({ verified: { ok: false, reason: 'missing' } });

      const res = await handler.call();

      expect(res.status).toBe(401);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('ARC-NEWS-002 session の生存を確かめられない時は 503 で断る', async () => {
      setup({ liveness: 'unavailable' });

      const res = await handler.call();

      expect(res.status).toBe(503);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('ARC-NEWS-002 session が失効していれば 401 で断る', async () => {
      setup({ liveness: 'revoked' });

      const res = await handler.call();

      expect(res.status).toBe(401);
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  it('ARC-NEWS-002 PUT・PATCH・DELETE は対象の行が0件なら 404 にし、成功でなく not_found の失敗を監査に残す（SEC-NEWS-016）', async () => {
    for (const handler of HANDLERS.slice(1)) {
      setup({ newsResult: { data: [], error: null } });

      const res = await handler.call();

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Article not found' });
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: handler.successAction + '.not_found',
        outcome: 'failure',
        resource_id: '7',
      });
    }
  });

  it('ARC-NEWS-002 PUT・PATCH・DELETE は変えた行が1行あれば 200 と成功の監査を残す（変更の結果は .select(id) で見る）', async () => {
    for (const handler of HANDLERS.slice(1)) {
      setup({ newsResult: { data: [{ id: 7 }], error: null } });

      const res = await handler.call();

      expect(res.status).toBe(200);
      expect(auditRows()[0]).toMatchObject({ action: handler.successAction, outcome: 'success' });
      expect(
        serviceClient.ops
          .filter((o) => o.table === 'news_articles')
          .some((o) => o.calls.some(([m, args]) => m === 'select' && (args[0] === 'id' || args[0] === 'id, image_url'))),
      ).toBe(true);
    }
  });

  it('ARC-NEWS-002 画像の書き込みだけは service role で置き場へ上げる', async () => {
    setup();

    await listRoute.POST(makeRequest({ form: { ...formFields, image: makeImage() } }));

    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.storage.from).toHaveBeenCalledWith('news-images');
    expect(userClient.storage.from).not.toHaveBeenCalled();
  });

  it('ARC-NEWS-002 記事の削除の後の画像の後始末は service role の置き場で行い、利用者の JWT の client は置き場を触らない（SEC-NEWS-018）', async () => {
    setup({ newsResult: { data: [{ id: 7, image_url: 'news/2026-10-24/a.jpg' }], error: null } });

    const res = await itemRoute.DELETE(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(serviceClient.storage.from).toHaveBeenCalledWith('news-images');
    expect(userClient.storage.from).not.toHaveBeenCalled();
  });

  it('ARC-NEWS-002 一覧と1件の GET は admin.news.read で読み、監査に残さない', async () => {
    setup({ codes: ['admin.news.read'], newsResult: { data: [], error: null } });
    const listRes = await listRoute.GET(makeRequest());
    expect(listRes.status).toBe(200);
    expect(auditRows()).toHaveLength(0);

    setup({ codes: ['admin.news.read'], newsResult: { data: { id: 7, image_url: null }, error: null } });
    const itemRes = await itemRoute.GET(makeRequest(), params());
    expect(itemRes.status).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });
});
