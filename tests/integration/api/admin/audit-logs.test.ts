export {};

// 本物の認可（admin-rbac）を通し、外側の境界（トークンの検証・セッションの生存確認・service role の DB）だけを差し替える。
// 窓口 → 認可 → audit_logs の読み出しの鎖を一緒に確かめる。
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { GET } = require('@/app/api/admin/audit-logs/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

let aclCodes: string[];
let tables: string[];
let select: jest.Mock;
let insert: jest.Mock;
let order: jest.Mock;
let limit: jest.Mock;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

function installServiceClient() {
  createServiceRoleClient.mockResolvedValue({
    from: (table: string) => {
      tables.push(table);
      if (table === 'user_roles') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          or: async () => ({
            data: [{ roles: { role_permissions: aclCodes.map((code) => ({ permissions: { code } })) } }],
            error: null,
          }),
        };
        return chain;
      }
      if (table === 'audit_logs') {
        return { select, insert };
      }
      throw new Error(`unexpected table ${table}`);
    },
  });
}

function signIn(claims: Record<string, unknown> = {}) {
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: ACTOR_ID, email: 'admin@example.com', aal: 'aal2', session_id: 's1', app_metadata: { role: 'admin' }, ...claims },
  });
}

function makeRequest() {
  return new Request('http://localhost/api/admin/audit-logs', { method: 'GET' });
}

beforeEach(() => {
  jest.resetAllMocks();
  tables = [];
  aclCodes = ['admin.audit.read'];
  limit = jest.fn().mockResolvedValue({ data: [], error: null });
  order = jest.fn().mockReturnValue({ limit });
  select = jest.fn().mockReturnValue({ order });
  insert = jest.fn().mockResolvedValue({ error: null });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  installServiceClient();
  checkAuthSessionLiveness.mockResolvedValue('active');
  signIn();
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('GET /api/admin/audit-logs', () => {
  describe('認可', () => {
    test('API-ADMIN-003 トークンが通らなければ 401 を返し、監査ログを読まない', async () => {
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

      const res = await GET(makeRequest());

      expect(res.status).toBe(401);
      expect(res._body).toEqual({ error: 'Unauthorized' });
      expect(select).not.toHaveBeenCalled();
    });

    test('API-ADMIN-003 セッションが失効していれば 401、確認できなければ 503 を返し、どちらも読まない', async () => {
      checkAuthSessionLiveness.mockResolvedValue('revoked');
      const revoked = await GET(makeRequest());

      checkAuthSessionLiveness.mockResolvedValue('unavailable');
      const unavailable = await GET(makeRequest());

      expect(revoked.status).toBe(401);
      expect(unavailable.status).toBe(503);
      expect(select).not.toHaveBeenCalled();
    });

    test('API-ADMIN-003 admin.audit.read を持たない人は 403 を返し、監査ログを読まない', async () => {
      aclCodes = ['admin.users.read', 'admin.users.manage', 'admin.orders.read'];

      const res = await GET(makeRequest());

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ error: 'Forbidden', permission: 'admin.audit.read' }));
      expect(select).not.toHaveBeenCalled();
    });

    test('API-ADMIN-003 トークンの役割が admin でも ACL に権限が無ければ 403（権限は ACL で決まる）', async () => {
      aclCodes = [];

      const res = await GET(makeRequest());

      expect(res.status).toBe(403);
      expect(select).not.toHaveBeenCalled();
    });

    test('API-ADMIN-003 トークンの役割が user でも ACL に admin.audit.read があれば読める', async () => {
      signIn({ app_metadata: { role: 'user' } });

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(select).toHaveBeenCalledTimes(1);
    });

    test('API-ADMIN-003 権限があっても aal2 でなければ 403（MFA required）を返し、読まない', async () => {
      signIn({ aal: 'aal1' });

      const res = await GET(makeRequest());

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ reason: 'MFA required', permission: 'admin.audit.read' }));
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('読み出し', () => {
    test('API-ADMIN-003 権限があれば 200 で { data } に監査ログの行をそのまま返す', async () => {
      const rows = [
        { id: '2', created_at: '2026-10-24T01:00:00Z', action: 'admin_create_user', actor_id: ACTOR_ID, resource: 'users', resource_id: 'u1', outcome: 'success', detail: null },
        { id: '1', created_at: '2026-10-23T01:00:00Z', action: 'login', actor_id: null, resource: 'auth', resource_id: null, outcome: 'failure', detail: 'bad password' },
      ];
      limit.mockResolvedValue({ data: rows, error: null });

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ data: rows });
    });

    test('API-ADMIN-003 選ぶ列は id・作った時刻・操作・操作した人の id・対象・対象の id・結果・詳しい文の 8 列だけ', async () => {
      await GET(makeRequest());

      expect(select).toHaveBeenCalledTimes(1);
      const columns = String(select.mock.calls[0][0]).split(',');
      expect(columns).toEqual(['id', 'created_at', 'action', 'actor_id', 'resource', 'resource_id', 'outcome', 'detail']);
      for (const unsafe of ['actor_email', 'ip', 'user_agent', 'metadata', '*']) {
        expect(columns).not.toContain(unsafe);
      }
    });

    test('API-ADMIN-003 作った時刻の新しい順に 100 件までを読む', async () => {
      await GET(makeRequest());

      expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(limit).toHaveBeenCalledWith(100);
    });

    test('API-ADMIN-003 ページ送りの入力を受けず、問い合わせの文字列を渡しても読み方は変わらない', async () => {
      await GET(new Request('http://localhost/api/admin/audit-logs?limit=5&page=2&actor=x', { method: 'GET' }));

      expect(limit).toHaveBeenCalledWith(100);
      expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    });

    test('API-ADMIN-003 触る表は audit_logs と認可の ACL の表だけで、読めた時に読んだ人の記録を1行だけ書く（ログの中身・IP は入れない）', async () => {
      limit.mockResolvedValue({ data: [{ id: '1', action: 'secret-action' }], error: null });

      await GET(makeRequest());

      expect([...new Set(tables)].sort()).toEqual(['audit_logs', 'user_roles']);
      expect(select).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
      const [row] = insert.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(row).toMatchObject({
        action: 'admin.audit_logs.read',
        actor_id: ACTOR_ID,
        actor_email: 'admin@example.com',
        resource: 'audit_logs',
        outcome: 'success',
      });
      expect(row.ip).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('secret-action');
    });

    test('API-ADMIN-003 監査の書き込みが失敗しても読み出しは 200 のまま返す', async () => {
      insert.mockRejectedValue(new Error('audit down'));

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ data: [] });
    });

    test('API-ADMIN-003 読みが誤りの時と認可で断った時は、読んだ記録を書かない', async () => {
      limit.mockResolvedValue({ data: null, error: { message: 'db down' } });
      await GET(makeRequest());
      aclCodes = [];
      await GET(makeRequest());

      expect(insert).not.toHaveBeenCalled();
    });

    test('API-ADMIN-003 行が 0 件なら空の配列を返す', async () => {
      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ data: [] });
    });

    test('API-ADMIN-003 DB が誤りを返せば 500 を返し、DB の誤りの文は返さない', async () => {
      limit.mockResolvedValue({ data: null, error: { message: 'relation "audit_logs" does not exist' } });

      const res = await GET(makeRequest());

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to fetch audit logs' });
      expect(JSON.stringify(res._body)).not.toContain('relation');
    });

    test('API-ADMIN-003 読み出しが例外を投げれば 500 を返す', async () => {
      limit.mockRejectedValue(new Error('connection reset'));

      const res = await GET(makeRequest());

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
    });

    test('API-ADMIN-003 認可の後で service role を作れなければ 500 を返す', async () => {
      installServiceClient();
      const base = await createServiceRoleClient();
      let n = 0;
      // 1 回目は認可の ACL の照会、2 回目が窓口自身の分
      createServiceRoleClient.mockImplementation(async () => {
        n += 1;
        if (n === 2) throw new Error('no client');
        return base;
      });

      const res = await GET(makeRequest());

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(select).not.toHaveBeenCalled();
    });
  });
});
