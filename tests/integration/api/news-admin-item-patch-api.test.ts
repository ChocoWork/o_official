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
const { PATCH } = require('@/app/api/admin/news/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>) {
  const ops: TableOp[] = [];
  return {
    ops,
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

function makeRequest(body: string, userAgent: string | null = 'jest-agent') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userAgent) headers['user-agent'] = userAgent;
  return new Request('http://localhost/api/admin/news/7', { method: 'PATCH', headers, body });
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(options: { updateResult?: Result; codes?: string[] } = {}) {
  // 更新は .select('id') で変えた行を返す。既定は 1 行（0 行は 404 になる: SEC-NEWS-016）
  // 書き込みは認可の後に service role の client 1 つで行う（ADR-0026）。利用者の JWT の client は作られないので、userClient は空のまま。
  userClient = createFakeClient({});
  serviceClient = createFakeClient({
    news_articles: options.updateResult ?? { data: [{ id: '7' }], error: null },
    user_roles: { data: aclRows(options.codes ?? ['admin.news.read', 'admin.news.manage']), error: null },
    audit_logs: { data: null, error: null },
  });
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue({ ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } } });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function newsOps() {
  return serviceClient.ops.filter((o) => o.table === 'news_articles');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('PATCH /api/admin/news/[id]（公開の切り替え）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-NEWS-006 admin.news.manage が無ければ 403 で断り、表も監査も触らない', async () => {
    setup({ codes: ['admin.news.read'] });

    const res = await PATCH(makeRequest(JSON.stringify({ status: 'published' })), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.manage' });
    expect(createClient).not.toHaveBeenCalled();
    expect(newsOps()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-NEWS-006 session が失効していれば 401 で断り、表を変えない', async () => {
    setup();
    checkAuthSessionLiveness.mockResolvedValue('revoked');

    const res = await PATCH(makeRequest(JSON.stringify({ status: 'published' })), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(createClient).not.toHaveBeenCalled();
    expect(newsOps()).toHaveLength(0);
  });

  test.each(['published', 'private'])(
    'API-NEWS-006 status=%s なら状態の列だけを更新し、200 と成功の監査を残す',
    async (status) => {
      setup();
      const request = makeRequest(JSON.stringify({ status, title: 'ignored' }));

      const res = await PATCH(request, ctx('7'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(createClient).not.toHaveBeenCalled();
      expect(userClient.ops).toHaveLength(0);
      expect(newsOps()).toHaveLength(1);
      expect(newsOps()[0].calls).toEqual([
        ['update', [{ status }]],
        ['eq', ['id', '7']],
        ['select', ['id']],
      ]);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'admin.news.status_update',
        actor_id: 'admin-1',
        resource: 'news_article',
        resource_id: '7',
        outcome: 'success',
        detail: 'News article status updated',
        user_agent: 'jest-agent',
        metadata: { articleId: '7', status },
      });
    }
  );

  test.each([
    ['draft の値', { status: 'draft' }],
    ['status の欠け', {}],
    ['数の status', { status: 1 }],
  ])('API-NEWS-006 %s は 400 Invalid request を返し表を変えない', async (_label, body) => {
    setup();

    const res = await PATCH(makeRequest(JSON.stringify(body)), ctx());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details.fieldErrors.status).toBeDefined();
    expect(createClient).not.toHaveBeenCalled();
    expect(newsOps()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-NEWS-006 表の更新の失敗は 500 と失敗の監査を残す', async () => {
    setup({ updateResult: { data: null, error: { message: 'rls denied' } } });

    const res = await PATCH(makeRequest(JSON.stringify({ status: 'published' }), null), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update status' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.status_update.failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article status update failed',
      user_agent: null,
      metadata: { articleId: '7', status: 'published' },
    });
  });

  test('API-NEWS-006 変えた行が0件なら 404 と status_update.not_found の失敗の監査を残し、成功の監査は残さない（SEC-NEWS-016）', async () => {
    setup({ updateResult: { data: [], error: null } });

    const res = await PATCH(makeRequest(JSON.stringify({ status: 'published' })), ctx('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.status_update.not_found',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article not found',
      metadata: { articleId: '7' },
    });
  });

  test('API-NEWS-006 id が数字でなければ表に触らず 404 にする（22P02 を 500 にしない）', async () => {
    setup();

    const res = await PATCH(makeRequest(JSON.stringify({ status: 'published' })), ctx('abc'));

    expect(res.status).toBe(404);
    expect(newsOps()).toHaveLength(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'admin.news.status_update.not_found', outcome: 'failure', resource_id: null });
  });

  test('API-NEWS-006 JSON の解析の失敗は 500 Internal server error を返し表を変えない', async () => {
    setup();

    const res = await PATCH(makeRequest('{not json'), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(createClient).not.toHaveBeenCalled();
    expect(newsOps()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });
});
