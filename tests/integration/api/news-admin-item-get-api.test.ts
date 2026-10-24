export {};

// 窓口・認可（admin-rbac）・監査（audit）・画像の署名（news-images）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える
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
const { GET } = require('@/app/api/admin/news/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type Sign = { bucket: string; path: string; expiresIn: number };

function createFakeClient(tables: Record<string, Result>, signResult: Result | Error = { data: { signedUrl: 'https://signed.example/a.jpg' }, error: null }) {
  const ops: TableOp[] = [];
  const signs: Sign[] = [];
  return {
    ops,
    signs,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => {
        op.calls.push(['single', []]);
        return Promise.resolve(result());
      };
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signs.push({ bucket, path, expiresIn });
          if (signResult instanceof Error) throw signResult;
          return signResult;
        }),
      })),
    },
  };
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest() {
  return new Request('http://localhost/api/admin/news/7', { method: 'GET', headers: { 'user-agent': 'jest-agent' } });
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(options: { row?: Result; signResult?: Result | Error; codes?: string[]; aal?: string } = {}) {
  userClient = createFakeClient({ news_articles: options.row ?? { data: null, error: null } });
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(options.codes ?? ['admin.news.read']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.signResult,
  );
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue({ ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } } });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function newsCalls() {
  return userClient.ops.filter((o) => o.table === 'news_articles').flatMap((o) => o.calls);
}

function auditOps() {
  return serviceClient.ops.filter((o) => o.table === 'audit_logs');
}

describe('GET /api/admin/news/[id]（管理の記事1件の読み）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-NEWS-004 admin.news.read が無ければ 403 で断り、表を読まない', async () => {
    setup({ codes: ['admin.news.manage'], row: { data: { id: 7 }, error: null } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.read' });
    expect(createClient).not.toHaveBeenCalled();
    expect(newsCalls()).toHaveLength(0);
  });

  test('API-NEWS-004 token が検証で断られたら 401 で断り、表を読まない', async () => {
    setup({ row: { data: { id: 7 }, error: null } });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(createClient).not.toHaveBeenCalled();
  });

  test('API-NEWS-004 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1', row: { data: { id: 7 }, error: null } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', reason: 'MFA required', permission: 'admin.news.read' });
    expect(createClient).not.toHaveBeenCalled();
  });

  test('API-NEWS-004 利用者の JWT の client で id の行を読み、保存の道を1時間の署名つき URL にして 200 {data} を返す', async () => {
    const row = { id: 7, title: 'Draft', status: 'private', image_url: 'news/2026-10-24/a.jpg' };
    setup({ row: { data: row, error: null } });
    const request = makeRequest();

    const res = await GET(request, ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ...row, image_url: 'https://signed.example/a.jpg' } });
    expect(createClient).toHaveBeenCalledWith(request);
    expect(newsCalls()).toEqual([
      ['select', ['*']],
      ['eq', ['id', '7']],
      ['single', []],
    ]);
    expect(serviceClient.signs).toEqual([{ bucket: 'news-images', path: 'news/2026-10-24/a.jpg', expiresIn: 3600 }]);
    expect(serviceClient.ops.some((o) => o.table === 'news_articles')).toBe(false);
    expect(auditOps()).toHaveLength(0);
  });

  test('API-NEWS-004 公開にしていた頃の public の URL も置き場の中の道を取り出して署名する', async () => {
    const row = { id: 7, image_url: 'https://x.supabase.co/storage/v1/object/public/news-images/news/old%20name.png' };
    setup({ row: { data: row, error: null } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(serviceClient.signs[0].path).toBe('news/old name.png');
    expect((await res.json()).data.image_url).toBe('https://signed.example/a.jpg');
  });

  test('API-NEWS-004 署名が失敗した時は元の値のまま返す', async () => {
    const row = { id: 7, image_url: 'news/2026-10-24/a.jpg' };
    setup({ row: { data: row, error: null }, signResult: { data: null, error: { message: 'not found' } } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data.image_url).toBe('news/2026-10-24/a.jpg');
  });

  test('API-NEWS-004 画像の無い行は署名せず image_url を null で返す', async () => {
    setup({ row: { data: { id: 7, image_url: null }, error: null } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 7, image_url: null });
    expect(serviceClient.signs).toHaveLength(0);
  });

  test('API-NEWS-004 行が無い時は 404 Article not found を返し署名しない', async () => {
    setup({ row: { data: null, error: null } });

    const res = await GET(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(serviceClient.signs).toHaveLength(0);
  });

  test('API-NEWS-004 DB の失敗も無い時と同じ 404 Article not found を返す', async () => {
    setup({ row: { data: null, error: { code: '22P02', message: 'invalid input syntax' } } });

    const res = await GET(makeRequest(), ctx('abc'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(serviceClient.signs).toHaveLength(0);
  });

  test('API-NEWS-004 データがあっても error があれば 404 を返す', async () => {
    setup({ row: { data: { id: 7, image_url: 'news/a.jpg' }, error: { message: 'boom' } } });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(404);
    expect(serviceClient.signs).toHaveLength(0);
  });

  test('API-NEWS-004 署名で例外が起きれば 500 Internal server error を返す', async () => {
    setup({ row: { data: { id: 7, image_url: 'news/a.jpg' }, error: null }, signResult: new Error('storage down') });

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-NEWS-004 token の検証で例外が起きれば 500 を返し、表を読まない', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('jwks down'));

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(createClient).not.toHaveBeenCalled();
  });
});
