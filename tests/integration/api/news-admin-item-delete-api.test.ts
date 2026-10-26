export {};

// 窓口・認可（admin-rbac）・監査（audit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える
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
const { DELETE } = require('@/app/api/admin/news/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>, removeResult: Result = { data: null, error: null }) {
  const ops: TableOp[] = [];
  const removes: Array<{ bucket: string; paths: unknown }> = [];
  return {
    ops,
    removes,
    storage: {
      from: jest.fn((bucket: string) => ({
        remove: jest.fn(async (paths: unknown) => {
          removes.push({ bucket, paths });
          return removeResult;
        }),
      })),
    },
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
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
  };
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest(userAgent: string | null = 'jest-agent') {
  const headers: Record<string, string> = {};
  if (userAgent) headers['user-agent'] = userAgent;
  return new Request('http://localhost/api/admin/news/7', { method: 'DELETE', headers });
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

const OLD_IMAGE = 'news/2026-01-01/old.png';

function setup(options: { deleteResult?: Result; removeResult?: Result; codes?: string[] } = {}) {
  // 削除は .select('id, image_url') で消した行を返す。既定は 1 行（0 行は 404 になる: SEC-NEWS-016）
  userClient = createFakeClient({
    news_articles: options.deleteResult ?? { data: [{ id: '7', image_url: OLD_IMAGE }], error: null },
  });
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(options.codes ?? ['admin.news.read', 'admin.news.manage']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.removeResult,
  );
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue({ ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } } });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function newsOps() {
  return userClient.ops.filter((o) => o.table === 'news_articles');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('DELETE /api/admin/news/[id]（記事の削除）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-NEWS-007 admin.news.manage が無ければ 403 で断り、行を消さず監査もしない', async () => {
    setup({ codes: ['admin.news.read'] });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.manage' });
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  test('API-NEWS-007 session の生存を確かめられない時は 503 で断り、行を消さない', async () => {
    setup();
    checkAuthSessionLiveness.mockResolvedValue('unavailable');

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(createClient).not.toHaveBeenCalled();
  });

  test('API-NEWS-007 利用者の JWT の client で id の行を消し、200 と成功の監査を残す（SEC-NEWS-018 の画像の後始末の結果も残す）', async () => {
    setup();
    const request = makeRequest();

    const res = await DELETE(request, ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(createClient).toHaveBeenCalledWith(request);
    expect(newsOps()).toHaveLength(1);
    expect(newsOps()[0].calls).toEqual([
      ['delete', []],
      ['eq', ['id', '7']],
      ['select', ['id, image_url']],
    ]);
    expect(serviceClient.ops.some((o) => o.table === 'news_articles')).toBe(false);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.delete',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'success',
      detail: 'News article deleted',
      user_agent: 'jest-agent',
      metadata: { articleId: '7', imageCleanup: 'ok' },
    });
  });

  test('API-NEWS-007 行を消した後に、その行の image_url を service role の client で news-images から消す。利用者の JWT の client は置き場を触らない（SEC-NEWS-018）', async () => {
    setup();

    await DELETE(makeRequest(), ctx('7'));

    expect(serviceClient.removes).toEqual([{ bucket: 'news-images', paths: [OLD_IMAGE] }]);
    expect(userClient.removes).toHaveLength(0);
  });

  test('API-NEWS-007 古い公開 URL の形の image_url も置き場の道筋に直して消す', async () => {
    setup({
      deleteResult: {
        data: [{ id: '7', image_url: 'https://x.supabase.co/storage/v1/object/public/news-images/news/old.png' }],
        error: null,
      },
    });

    await DELETE(makeRequest(), ctx('7'));

    expect(serviceClient.removes).toEqual([{ bucket: 'news-images', paths: ['news/old.png'] }]);
  });

  test('API-NEWS-007 置き場の remove が失敗しても 200 success のままで、監査に imageCleanup:failed だけを残す', async () => {
    setup({ removeResult: { data: null, error: { name: 'StorageApiError', message: 'secret detail' } } });

    const res = await DELETE(makeRequest(), ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.news.delete',
      outcome: 'success',
      metadata: { articleId: '7', imageCleanup: 'failed' },
    });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  test('API-NEWS-007 image_url が見本・外の URL・null の行を消した時は、置き場から何も消さない', async () => {
    for (const imageUrl of ['e2e/news-1.png', 'https://evil.example/news/a.png', null]) {
      setup({ deleteResult: { data: [{ id: '7', image_url: imageUrl }], error: null } });

      const res = await DELETE(makeRequest(), ctx('7'));

      expect(res.status).toBe(200);
      expect(serviceClient.removes).toHaveLength(0);
    }
  });

  test('API-NEWS-007 表の削除の失敗と0行の時は、置き場から何も消さない', async () => {
    setup({ deleteResult: { data: null, error: { message: 'rls denied' } } });
    await DELETE(makeRequest(), ctx('7'));
    expect(serviceClient.removes).toHaveLength(0);

    setup({ deleteResult: { data: [], error: null } });
    await DELETE(makeRequest(), ctx('7'));
    expect(serviceClient.removes).toHaveLength(0);
  });

  test('API-NEWS-007 表の削除の失敗は 500 と失敗の監査を残す', async () => {
    setup({ deleteResult: { data: null, error: { message: 'rls denied' } } });

    const res = await DELETE(makeRequest(null), ctx('8'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete article' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.delete.failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '8',
      outcome: 'failure',
      detail: 'News article delete failed',
      user_agent: null,
      metadata: { articleId: '8' },
    });
  });

  test('API-NEWS-007 消した行が0件なら 404 と delete.not_found の失敗の監査を残し、成功の監査は残さない（SEC-NEWS-016）', async () => {
    setup({ deleteResult: { data: [], error: null } });

    const res = await DELETE(makeRequest(), ctx('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.delete.not_found',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article not found',
      metadata: { articleId: '7' },
    });
  });

  test('API-NEWS-007 id が数字でなければ表に触らず 404 にする（22P02 を 500 にしない）', async () => {
    setup();

    const res = await DELETE(makeRequest(), ctx('abc'));

    expect(res.status).toBe(404);
    expect(newsOps()).toHaveLength(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'admin.news.delete.not_found', outcome: 'failure', resource_id: null });
  });

  test('API-NEWS-007 client の作成で例外が起きれば 500 Internal server error を返し、監査しない', async () => {
    setup();
    createClient.mockRejectedValue(new Error('no cookies'));

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(auditRows()).toHaveLength(0);
  });
});
