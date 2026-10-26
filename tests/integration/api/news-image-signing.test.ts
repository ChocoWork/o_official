export {};

// 画像の書き込み（管理の POST・PUT）と配り（管理の GET・公開の取り出し）を、窓口・admin-rbac・news-images を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・token の検証・応答の型）だけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
  createPublicClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createClient, createServiceRoleClient, createPublicClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const listRoute = require('@/app/api/admin/news/route');
const itemRoute = require('@/app/api/admin/news/[id]/route');
const { getPublishedNews, getPublishedNewsDetailById } = require('@/features/news/services/public');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>, sign?: (path: string) => Result) {
  const ops: TableOp[] = [];
  const uploads: Array<{ bucket: string; path: string; options: Record<string, unknown> }> = [];
  const signCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  const client = {
    ops,
    uploads,
    signCalls,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, _body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, options });
          return { data: {}, error: null };
        }),
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signCalls.push({ bucket, path, expiresIn });
          return sign ? sign(path) : { data: { signedUrl: `https://signed.example/${path}?e=${expiresIn}` }, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeImage(): File {
  const file = new File(['img'], 'photo.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new Uint8Array([1]).buffer });
  return file;
}

const formFields = {
  title: 'Title',
  category: 'STORE',
  date: '2026-10-24',
  content: 'Summary',
  detailedContent: 'Body',
  status: 'private',
};

function makeRequest(form: Record<string, unknown> = {}) {
  return {
    headers: { get: () => null },
    formData: jest.fn(async () => ({ get: (key: string) => (key in form ? form[key] : null) })),
  } as unknown as Request;
}

const params = () => ({ params: Promise.resolve({ id: '7' }) });

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;
let publicClient: ReturnType<typeof createFakeClient>;

function setup(options: { newsResult?: Result; sign?: (path: string) => Result } = {}) {
  const newsResult = options.newsResult ?? { data: { id: 7 }, error: null };
  userClient = createFakeClient({ news_articles: newsResult });
  publicClient = createFakeClient({ news_articles: newsResult });
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(['admin.news.read', 'admin.news.manage']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.sign,
  );
  createClient.mockResolvedValue(userClient);
  createPublicClient.mockResolvedValue(publicClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue({ ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2' } });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function writePayload(method: 'insert' | 'update') {
  const op = userClient.ops.find((o) => o.table === 'news_articles');
  const args = op?.calls.find(([m]) => m === method)?.[1][0];
  return (Array.isArray(args) ? args[0] : args) as Record<string, unknown>;
}

async function listImageUrls(rows: Array<{ id: number; image_url: string | null }>) {
  setup({ newsResult: { data: rows, error: null } });
  const body = (await (await listRoute.GET(makeRequest())).json()) as { data: Array<{ image_url: string | null }> };
  return body.data.map((r) => r.image_url);
}

const BASE = 'https://proj.supabase.co/storage/v1/object';

describe('画像の非公開の置き場と署名つき URL（ARC-NEWS-003）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ARC-NEWS-003 作成は service role で置き場 news-images に上げ、表には署名前の道を入れる', async () => {
    setup();

    const res = await listRoute.POST(makeRequest({ ...formFields, image: makeImage() }));

    expect(res.status).toBe(201);
    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.uploads[0]).toMatchObject({ bucket: 'news-images', options: { upsert: false } });
    expect(userClient.storage.from).not.toHaveBeenCalled();
    const imageUrl = writePayload('insert').image_url as string;
    expect(imageUrl).toBe(serviceClient.uploads[0].path);
    expect(imageUrl.startsWith('news/')).toBe(true);
    expect(imageUrl).not.toMatch(/^https?:/);
    // 書く時には署名しない（読むたびに署名する）
    expect(serviceClient.signCalls).toHaveLength(0);
  });

  it('ARC-NEWS-003 更新で画像を付けた時は service role で上げ、表の image_url を署名前の道に替える', async () => {
    setup();

    const res = await itemRoute.PUT(makeRequest({ ...formFields, image: makeImage() }), params());

    expect(res.status).toBe(200);
    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.uploads[0].bucket).toBe('news-images');
    expect(writePayload('update').image_url).toBe(serviceClient.uploads[0].path);
  });

  it('ARC-NEWS-003 更新で画像を付けない時は上げず、表の image_url も変えない', async () => {
    setup();

    const res = await itemRoute.PUT(makeRequest({ ...formFields }), params());

    expect(res.status).toBe(200);
    expect(serviceClient.uploads).toHaveLength(0);
    expect(writePayload('update')).not.toHaveProperty('image_url');
  });

  it('ARC-NEWS-003 管理の一覧は保存の道を service role で期限 3600 秒の署名つき URL にして返す', async () => {
    const urls = await listImageUrls([{ id: 1, image_url: 'news/2026-10-24/a.png' }]);

    expect(urls).toEqual(['https://signed.example/news/2026-10-24/a.png?e=3600']);
    expect(serviceClient.signCalls).toEqual([{ bucket: 'news-images', path: 'news/2026-10-24/a.png', expiresIn: 3600 }]);
    expect(userClient.storage.from).not.toHaveBeenCalled();
  });

  it.each([
    ['旧 public の URL', `${BASE}/public/news-images/news/old/a.jpg`, 'news/old/a.jpg'],
    ['署名つき URL（token 付き）', `${BASE}/sign/news-images/news/old/b.jpg?token=abc`, 'news/old/b.jpg'],
    ['authenticated の URL', `${BASE}/authenticated/news-images/news/old/c.jpg`, 'news/old/c.jpg'],
    ['符号化した道の URL', `${BASE}/public/news-images/news/old/%E7%94%BB%E5%83%8F.jpg`, 'news/old/画像.jpg'],
    ['置き場の名前つきの道', 'news-images/news/old/d.jpg', 'news/old/d.jpg'],
    ['先頭に / のある道', '  /news/old/e.jpg ', 'news/old/e.jpg'],
  ])('ARC-NEWS-003 %s からも置き場の中の道を取り出して署名する', async (_label, raw, path) => {
    const urls = await listImageUrls([{ id: 1, image_url: raw }]);

    expect(serviceClient.signCalls).toEqual([{ bucket: 'news-images', path, expiresIn: 3600 }]);
    expect(urls).toEqual([`https://signed.example/${path}?e=3600`]);
  });

  it.each([
    ['ほかの置き場の URL', `${BASE}/public/other-bucket/a.jpg`],
    ['置き場の印の後が空の URL', `${BASE}/public/news-images/`],
    ['URL として読めない値', 'https://'],
  ])('ARC-NEWS-003 %s は道にできないので署名せず元の値を返す', async (_label, raw) => {
    const urls = await listImageUrls([{ id: 1, image_url: raw }]);

    expect(serviceClient.signCalls).toHaveLength(0);
    expect(urls).toEqual([raw]);
  });

  it('ARC-NEWS-003 画像の無い行は署名せず null のまま返す', async () => {
    const urls = await listImageUrls([
      { id: 1, image_url: null },
      { id: 2, image_url: '' },
    ]);

    expect(serviceClient.signCalls).toHaveLength(0);
    expect(urls).toEqual([null, null]);
  });

  it.each([
    ['署名が error を返す', { data: null, error: { message: 'not found' } }],
    ['署名が URL を返さない', { data: { signedUrl: '' }, error: null }],
  ])('ARC-NEWS-003 %s の時は元の値をそのまま返す', async (_label, signResult) => {
    setup({ newsResult: { data: [{ id: 1, image_url: 'news/x/a.png' }], error: null }, sign: () => signResult });

    const body = await (await listRoute.GET(makeRequest())).json();

    expect(serviceClient.signCalls).toHaveLength(1);
    expect(body.data[0].image_url).toBe('news/x/a.png');
  });

  it('ARC-NEWS-003 管理の1件の GET も画像を署名つき URL にして返す', async () => {
    setup({ newsResult: { data: { id: 7, image_url: 'news/2026-10-24/b.webp', title: 'T' }, error: null } });

    const res = await itemRoute.GET(makeRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: 7, title: 'T', image_url: 'https://signed.example/news/2026-10-24/b.webp?e=3600' });
  });

  it('ARC-NEWS-003 公開の一覧は anon の client だけで読み、画像を署名せず service role も使わない（SEC-NEWS-005）', async () => {
    setup({ newsResult: { data: [{ id: 1, title: 'A', content: 'c' }], error: null } });
    createServiceRoleClient.mockClear();

    const rows = await getPublishedNews();

    expect(rows).toEqual([{ id: 1, title: 'A', content: 'c' }]);
    expect(rows[0]).not.toHaveProperty('image_url');
    expect(publicClient.ops.some((o) => o.table === 'news_articles')).toBe(true);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(serviceClient.ops).toHaveLength(0);
    expect(serviceClient.signCalls).toHaveLength(0);
  });

  it('ARC-NEWS-003 公開の詳細も署名せず service role も使わず、記事が無ければ null', async () => {
    setup({ newsResult: { data: { id: 3, title: 'D', detailed_content: 'body' }, error: null } });
    createServiceRoleClient.mockClear();
    const found = await getPublishedNewsDetailById('3');
    expect(found).toEqual({ id: 3, title: 'D', detailed_content: 'body' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(serviceClient.ops).toHaveLength(0);
    expect(serviceClient.signCalls).toHaveLength(0);

    setup({ newsResult: { data: null, error: { code: 'PGRST116' } } });
    const missing = await getPublishedNewsDetailById('404');
    expect(missing).toBeNull();
    expect(serviceClient.signCalls).toHaveLength(0);
  });
});
