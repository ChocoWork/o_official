export {};

// 窓口・認可（admin-rbac）・署名（news-images）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える
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
const { GET } = require('@/app/api/admin/news/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result | (() => Result)>, sign?: (path: string, expiresIn: number) => Result) {
  const ops: TableOp[] = [];
  const signCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  const resolve = (table: string): Result => {
    const r = tables[table];
    if (typeof r === 'function') return r();
    return r ?? { data: null, error: null };
  };
  const client = {
    ops,
    signCalls,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(resolve(table));
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(table)).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signCalls.push({ bucket, path, expiresIn });
          return sign ? sign(path, expiresIn) : { data: { signedUrl: `https://signed.example/${path}?e=${expiresIn}` }, error: null };
        }),
      })),
    },
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
  { id: 2, title: 'Newer', status: 'private', published_date: '2026-10-20', image_url: 'news/2026-10-20/b.jpg' },
  { id: 1, title: 'Older', status: 'published', published_date: '2026-10-01', image_url: null },
];

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(options: {
  newsResult?: Result;
  codes?: string[];
  aal?: string;
  verified?: unknown;
  liveness?: string;
} = {}) {
  userClient = createFakeClient({ news_articles: options.newsResult ?? { data: ROWS, error: null } });
  serviceClient = createFakeClient({
    user_roles: { data: aclRows(options.codes ?? ['admin.news.read']), error: null },
    audit_logs: { data: null, error: null },
  });
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? { ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } } },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

describe('GET /api/admin/news（管理の記事の一覧）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-NEWS-002 非公開を含む全部の列を公開日の新しい順に取り、200 で data を返す', async () => {
    setup();
    const request = makeRequest();

    const res = await GET(request);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([2, 1]);
    expect(body.data[0].status).toBe('private');
    const newsOp = userClient.ops.find((o) => o.table === 'news_articles');
    expect(newsOp?.calls).toEqual([
      ['select', ['*']],
      ['order', ['published_date', { ascending: false }]],
    ]);
    // status で絞らない（非公開も返す）・件数の上限も付けない
    expect(newsOp?.calls.some(([m]) => m === 'eq' || m === 'limit')).toBe(false);
  });

  it('API-NEWS-002 表は利用者の JWT の client で読み、service role では読まない', async () => {
    setup();
    const request = makeRequest();

    await GET(request);

    expect(createClient).toHaveBeenCalledWith(request);
    expect(serviceClient.ops.some((o) => o.table === 'news_articles')).toBe(false);
  });

  it('API-NEWS-002 image_url を期限 3600 秒の署名つき URL に置き換え、null の画像は null のまま返す', async () => {
    setup();

    const body = await (await GET(makeRequest())).json();

    expect(body.data[0].image_url).toBe('https://signed.example/news/2026-10-20/b.jpg?e=3600');
    expect(body.data[1].image_url).toBeNull();
    expect(serviceClient.signCalls).toEqual([{ bucket: 'news-images', path: 'news/2026-10-20/b.jpg', expiresIn: 3600 }]);
  });

  it('API-NEWS-002 表が null を返した時は空の一覧を 200 で返す', async () => {
    setup({ newsResult: { data: null, error: null } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('API-NEWS-002 一覧の読みは監査に残さない', async () => {
    setup();

    await GET(makeRequest());

    expect(serviceClient.ops.some((o) => o.table === 'audit_logs')).toBe(false);
  });

  it('API-NEWS-002 admin.news.read の権限を確かめ、manage だけでは 403 で表を読まない', async () => {
    setup({ codes: ['admin.news.manage'] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({ error: 'Forbidden', permission: 'admin.news.read' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-NEWS-002 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.news.read' });
    expect(userClient.ops).toHaveLength(0);
  });

  it('API-NEWS-002 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-NEWS-002 session が失効していれば 401 で断る', async () => {
    setup({ liveness: 'revoked' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-NEWS-002 session の確認ができない時は 503 と Retry-After で断る', async () => {
    setup({ liveness: 'unavailable' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
  });

  it('API-NEWS-002 表の読みが失敗したら 500 Failed to fetch news articles を返し、署名しない', async () => {
    setup({ newsResult: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch news articles' });
    expect(serviceClient.signCalls).toHaveLength(0);
  });

  it('API-NEWS-002 途中で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createClient.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
