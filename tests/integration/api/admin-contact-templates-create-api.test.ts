export {};

// 窓口・認可（admin-rbac）・監査（audit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 返信テンプレートの窓口は service role の client 1つで表を書くので、差し替える client もその1つだけ
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
const { POST } = require('@/app/api/admin/contact/templates/route');

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

function makeRequest(body: unknown, opts: { brokenJson?: boolean } = {}) {
  return {
    json: opts.brokenJson ? () => Promise.reject(new SyntaxError('bad json')) : async () => body,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        return key === 'user-agent' ? 'jest-agent' : key === 'x-real-ip' ? '198.51.100.7' : null;
      },
    },
  } as unknown as Request;
}

const VALID = { title: '発送のご案内', body: '本日発送しました。' };

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    insertResult?: Result;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient({
    contact_reply_templates: options.insertResult ?? { data: { id: 'new-1' }, error: null },
    user_roles: { data: aclRows(options.codes ?? ['admin.contact.manage']), error: null },
    audit_logs: options.auditResult ?? { data: null, error: null },
  });
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: {
        sub: 'admin-1',
        email: 'admin@example.com',
        session_id: 'sess-1',
        aal: options.aal ?? 'aal2',
        app_metadata: { role: 'admin' },
      },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function templatesOp() {
  return serviceClient.ops.find((o) => o.table === 'contact_reply_templates');
}

function insertedRow() {
  const rows = templatesOp()?.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>;
  return rows[0];
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('POST /api/admin/contact/templates（管理の返信テンプレートの作成）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(null);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-010 題と本文だけで作り、201 と新しい id を返す', async () => {
    setup();

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: 'new-1' });
  });

  it('API-ADMIN-010 分類が無ければ null、並び順が無ければ 0 で contact_reply_templates に1行を入れる', async () => {
    setup();

    await POST(makeRequest(VALID));

    expect(insertedRow()).toEqual({ title: VALID.title, category: null, body: VALID.body, sort_order: 0 });
    const calls = templatesOp()?.calls ?? [];
    expect(calls.map(([m]) => m)).toEqual(['insert', 'select']);
    expect(calls[1]).toEqual(['select', ['id']]);
  });

  it('API-ADMIN-010 題と本文の前後の空白を除いて入れる', async () => {
    setup();

    await POST(makeRequest({ title: '  題  ', body: '\n 本文 \n' }));

    expect(insertedRow()).toMatchObject({ title: '題', body: '本文' });
  });

  it('API-ADMIN-010 分類と並び順が渡されたらその値で入れる', async () => {
    setup();

    const res = await POST(makeRequest({ ...VALID, category: 'order', sortOrder: 7 }));

    expect(res.status).toBe(201);
    expect(insertedRow()).toMatchObject({ category: 'order', sort_order: 7 });
  });

  it.each(['product', 'order', 'other', 'general'])('API-ADMIN-010 分類 %s を受ける', async (category) => {
    setup();

    const res = await POST(makeRequest({ ...VALID, category }));

    expect(res.status).toBe(201);
    expect(insertedRow().category).toBe(category);
  });

  it('API-ADMIN-010 分類が明示的に null なら null で入れる', async () => {
    setup();

    const res = await POST(makeRequest({ ...VALID, category: null }));

    expect(res.status).toBe(201);
    expect(insertedRow().category).toBeNull();
  });

  it('API-ADMIN-010 題が 120 字・本文が 5000 字・並び順が 0 と 9999 の境目を受ける', async () => {
    setup();
    const edge = { title: 'あ'.repeat(120), body: 'い'.repeat(5000) };

    const low = await POST(makeRequest({ ...edge, sortOrder: 0 }));
    const high = await POST(makeRequest({ ...edge, sortOrder: 9999 }));

    expect(low.status).toBe(201);
    expect(high.status).toBe(201);
  });

  it.each([
    ['本文が JSON でない', () => makeRequest(undefined, { brokenJson: true })],
    ['本文が null', () => makeRequest(null)],
    ['題が無い', () => makeRequest({ body: VALID.body })],
    ['題が空白だけ', () => makeRequest({ ...VALID, title: '   ' })],
    ['題が 121 字', () => makeRequest({ ...VALID, title: 'あ'.repeat(121) })],
    ['本文が無い', () => makeRequest({ title: VALID.title })],
    ['本文が空白だけ', () => makeRequest({ ...VALID, body: '  ' })],
    ['本文が 5001 字', () => makeRequest({ ...VALID, body: 'あ'.repeat(5001) })],
    ['分類が表の CHECK に無い値', () => makeRequest({ ...VALID, category: 'bogus' })],
    ['並び順が 10000', () => makeRequest({ ...VALID, sortOrder: 10000 })],
    ['並び順が負', () => makeRequest({ ...VALID, sortOrder: -1 })],
    ['並び順が整数でない', () => makeRequest({ ...VALID, sortOrder: 1.5 })],
    ['並び順が文字', () => makeRequest({ ...VALID, sortOrder: '3' })],
  ])('API-ADMIN-010 %s なら 400 を details 付きで返し、表にも監査にも書かない', async (_label, build) => {
    setup();

    const res = await POST(build());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid request');
    expect(body.details).toBeDefined();
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-010 作った事を admin.contact.template.create で監査に残し、メールと IP は入れない', async () => {
    setup();

    await POST(makeRequest(VALID));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.template.create',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'contact_reply_template',
      resource_id: 'new-1',
      outcome: 'success',
      detail: 'created',
      ip: '198.51.100.7',
      user_agent: 'jest-agent',
    });
  });

  it('API-ADMIN-010 表は service role の client で書き、利用者の JWT の client は使わない', async () => {
    setup();

    await POST(makeRequest(VALID));

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-ADMIN-010 監査の書き込みが失敗しても作成の応答は 201 のまま', async () => {
    setup({ auditResult: { data: null, error: { message: 'audit down' } } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(201);
    expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
  });

  it('API-ADMIN-010 admin.contact.read だけでは 403 で、表にも監査にも書かない', async () => {
    setup({ codes: ['admin.contact.read'] });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-010 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-010 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(401);
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-010 session が失効していれば 401、確認できない時は 503 で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await POST(makeRequest(VALID));

    setup({ liveness: 'unavailable' });
    const unavailable = await POST(makeRequest(VALID));

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-010 認可が先で、権限の無い人には入力の形の誤りも見せず 403 を返す', async () => {
    setup({ codes: [] });

    const res = await POST(makeRequest({ title: '' }));

    expect(res.status).toBe(403);
  });

  it('API-ADMIN-010 表の書き込みが誤りを返したら 500 Failed to create template を返し、監査に残さない', async () => {
    setup({ insertResult: { data: null, error: { code: '23514', message: 'check violation' } } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create template' });
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-010 誤りが無くても行が返らなければ 500 Failed to create template を返し、監査に残さない', async () => {
    setup({ insertResult: { data: null, error: null } });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create template' });
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-010 認可の後の client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await POST(makeRequest(VALID));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
