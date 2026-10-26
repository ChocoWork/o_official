export {};

// 窓口・認可（admin-rbac）・監査（audit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 返信テンプレートの窓口は service role の client 1つで表を消すので、差し替える client もその1つだけ
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

// 回数の限度器は DB に触るので差し替える（呼ばれ方は窓口の単体試験で確かめる）
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { DELETE } = require('@/app/api/admin/contact/templates/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>) {
  const ops: TableOp[] = [];
  const client = {
    ops,
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
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest() {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-agent' : null) },
  } as unknown as Request;
}

const TPL_ID = '5b0f4c1e-7a2d-4e6f-8b3c-9d1e2f3a4b5c';
const TPL_ID_9 = '5b0f4c1e-7a2d-4e6f-8b3c-9d1e2f3a4b09';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function ctx(id = TPL_ID) {
  return { params: Promise.resolve({ id }) };
}

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    deleteResult?: Result;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient({
    contact_reply_templates: options.deleteResult ?? { data: [{ id: TPL_ID }], error: null },
    user_roles: { data: aclRows(options.codes ?? ['admin.contact.manage']), error: null },
    audit_logs: options.auditResult ?? { data: null, error: null },
  });
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function templatesOp() {
  return serviceClient.ops.find((o) => o.table === 'contact_reply_templates');
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('DELETE /api/admin/contact/templates/[id]（管理の返信テンプレートの削除）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(null);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-012 道の id の行だけを消し、200 で success を返す', async () => {
    setup();

    const res = await DELETE(makeRequest(), ctx(TPL_ID_9));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const calls = templatesOp()?.calls ?? [];
    expect(calls).toEqual([
      ['delete', []],
      ['eq', ['id', TPL_ID_9]],
      ['select', ['id']],
    ]);
  });

  it('API-ADMIN-012 消した事を admin.contact.template.delete で監査に残し、メールと IP は入れない', async () => {
    setup();

    await DELETE(makeRequest(), ctx(TPL_ID_9));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.template.delete',
      actor_id: 'admin-1',
      resource: 'contact_reply_template',
      resource_id: TPL_ID_9,
      outcome: 'success',
      detail: 'deleted',
      user_agent: 'jest-agent',
    });
    expect(rows[0].actor_email).toBeUndefined();
    expect(rows[0].ip).toBeUndefined();
  });

  it('API-ADMIN-012 存在しない id（0 行）は 404 Template not found を返し、失敗を監査に残して成功は残さない', async () => {
    setup({ deleteResult: { data: [], error: null } });

    const res = await DELETE(makeRequest(), ctx(MISSING_ID));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Template not found' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.template.delete',
      resource_id: MISSING_ID,
      outcome: 'failure',
      detail: 'template_not_found',
    });
  });

  it('API-ADMIN-012 id が UUID でない時は表に渡さず 404 を返し、何も書かない', async () => {
    setup();

    const res = await DELETE(makeRequest(), ctx('tpl-1'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Template not found' });
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-012 回数の枠を超えた要求は 429 で、表にも監査にも触れない（枠は管理者の ID で数える）', async () => {
    setup();
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    enforceRateLimit.mockResolvedValue(limited);

    const res = await DELETE(makeRequest(), ctx());

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'admin:contact:write', limit: 60, windowSeconds: 600, subject: 'admin-1' }),
    );
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-012 表は service role の client で消し、利用者の JWT の client は使わない', async () => {
    setup();

    await DELETE(makeRequest(), ctx());

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-ADMIN-012 監査の書き込みが失敗しても削除の応答は 200 のまま', async () => {
    setup({ auditResult: { data: null, error: { message: 'audit down' } } });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
  });

  it('API-ADMIN-012 admin.contact.read だけでは 403 で、表にも監査にも触れない', async () => {
    setup({ codes: ['admin.contact.read'] });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-012 ほかの領域の権限（looks）だけでは 403 で消さない', async () => {
    setup({ codes: ['admin.looks.manage'] });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-012 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-012 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-012 session が失効していれば 401、確認できない時は 503 で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await DELETE(makeRequest(), ctx());

    setup({ liveness: 'unavailable' });
    const unavailable = await DELETE(makeRequest(), ctx());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-012 表の削除が誤りを返したら 500 Failed to delete template を返し、監査に残さない', async () => {
    setup({ deleteResult: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete template' });
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-012 認可の後の client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await DELETE(makeRequest(), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('API-ADMIN-012 道の id の取り出しが失敗したら 500 Internal server error を返し、何も消さない', async () => {
    setup();

    const res = await DELETE(makeRequest(), { params: Promise.reject(new Error('bad params')) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(templatesOp()).toBeUndefined();
  });
});
