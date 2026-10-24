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

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { PUT } = require('@/app/api/admin/contact/templates/[id]/route');

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
    headers: { get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-agent' : null) },
  } as unknown as Request;
}

function ctx(id = 'tpl-1') {
  return { params: Promise.resolve({ id }) };
}

const VALID = { title: '発送のご案内', body: '本日発送しました。' };

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    updateResult?: Result;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient({
    contact_reply_templates: options.updateResult ?? { data: null, error: null },
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

function updatedRow() {
  return templatesOp()?.calls.find(([m]) => m === 'update')?.[1][0] as Record<string, unknown>;
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

describe('PUT /api/admin/contact/templates/[id]（管理の返信テンプレートの更新）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-011 道の id の行を直し、200 で success を返す', async () => {
    setup();

    const res = await PUT(makeRequest(VALID), ctx('tpl-9'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const calls = templatesOp()?.calls ?? [];
    expect(calls.map(([m]) => m)).toEqual(['update', 'eq']);
    expect(calls[1]).toEqual(['eq', ['id', 'tpl-9']]);
  });

  it('API-ADMIN-011 題と本文の前後の空白を除き、直した時刻を ISO の形で入れる', async () => {
    setup();

    await PUT(makeRequest({ title: '  新しい題  ', body: '\n 新しい本文 \n' }), ctx());

    const row = updatedRow();
    expect(row).toMatchObject({ title: '新しい題', body: '新しい本文' });
    expect(new Date(row.updated_at as string).toISOString()).toBe(row.updated_at);
  });

  it('API-ADMIN-011 分類が無ければ null にして書く', async () => {
    setup();

    await PUT(makeRequest(VALID), ctx());

    expect(updatedRow().category).toBeNull();
  });

  it.each(['product', 'order', 'other', 'general'])('API-ADMIN-011 分類 %s を書く', async (category) => {
    setup();

    const res = await PUT(makeRequest({ ...VALID, category }), ctx());

    expect(res.status).toBe(200);
    expect(updatedRow().category).toBe(category);
  });

  it('API-ADMIN-011 並び順が渡されなければ sort_order の列を書き換えない', async () => {
    setup();

    await PUT(makeRequest(VALID), ctx());

    expect('sort_order' in updatedRow()).toBe(false);
  });

  it('API-ADMIN-011 並び順が渡されたらその値を書く（0 でも書く）', async () => {
    setup();

    await PUT(makeRequest({ ...VALID, sortOrder: 4 }), ctx());
    expect(updatedRow().sort_order).toBe(4);

    setup();
    await PUT(makeRequest({ ...VALID, sortOrder: 0 }), ctx());
    expect(updatedRow().sort_order).toBe(0);
  });

  it('API-ADMIN-011 題が 120 字・本文が 5000 字・並び順が 9999 の境目を受ける', async () => {
    setup();

    const res = await PUT(
      makeRequest({ title: 'あ'.repeat(120), body: 'い'.repeat(5000), sortOrder: 9999 }),
      ctx(),
    );

    expect(res.status).toBe(200);
  });

  it.each([
    ['本文が JSON でない', () => makeRequest(undefined, { brokenJson: true })],
    ['本文が null', () => makeRequest(null)],
    ['題が空白だけ', () => makeRequest({ ...VALID, title: '   ' })],
    ['題が 121 字', () => makeRequest({ ...VALID, title: 'あ'.repeat(121) })],
    ['本文が空白だけ', () => makeRequest({ ...VALID, body: '  ' })],
    ['本文が 5001 字', () => makeRequest({ ...VALID, body: 'あ'.repeat(5001) })],
    ['分類が表の CHECK に無い値', () => makeRequest({ ...VALID, category: 'bogus' })],
    ['並び順が 10000', () => makeRequest({ ...VALID, sortOrder: 10000 })],
    ['並び順が負', () => makeRequest({ ...VALID, sortOrder: -1 })],
    ['並び順が整数でない', () => makeRequest({ ...VALID, sortOrder: 1.5 })],
  ])('API-ADMIN-011 %s なら 400 を details 付きで返し、表にも監査にも書かない', async (_label, build) => {
    setup();

    const res = await PUT(build(), ctx());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid request');
    expect(body.details).toBeDefined();
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-011 直した事を admin.contact.template.update で監査に残し、メールと IP は入れない', async () => {
    setup();

    await PUT(makeRequest(VALID), ctx('tpl-9'));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.template.update',
      actor_id: 'admin-1',
      resource: 'contact_reply_template',
      resource_id: 'tpl-9',
      outcome: 'success',
      detail: 'updated',
      user_agent: 'jest-agent',
    });
    expect(rows[0].actor_email).toBeUndefined();
    expect(rows[0].ip).toBeUndefined();
  });

  it('API-ADMIN-011 存在しない id でも表が誤りを返さなければ 200 を返し、成功を監査に残す', async () => {
    setup({ updateResult: { data: [], error: null } });

    const res = await PUT(makeRequest(VALID), ctx('no-such-id'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()[0]).toMatchObject({ resource_id: 'no-such-id', outcome: 'success' });
  });

  it('API-ADMIN-011 表は service role の client で書き、利用者の JWT の client は使わない', async () => {
    setup();

    await PUT(makeRequest(VALID), ctx());

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-ADMIN-011 監査の書き込みが失敗しても更新の応答は 200 のまま', async () => {
    setup({ auditResult: { data: null, error: { message: 'audit down' } } });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
  });

  it('API-ADMIN-011 admin.contact.read だけでは 403 で、表にも監査にも書かない', async () => {
    setup({ codes: ['admin.contact.read'] });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-011 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.manage' });
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-011 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(401);
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-011 session が失効していれば 401、確認できない時は 503 で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await PUT(makeRequest(VALID), ctx());

    setup({ liveness: 'unavailable' });
    const unavailable = await PUT(makeRequest(VALID), ctx());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(templatesOp()).toBeUndefined();
  });

  it('API-ADMIN-011 認可が先で、権限の無い人には入力の形の誤りも見せず 403 を返す', async () => {
    setup({ codes: [] });

    const res = await PUT(makeRequest({ title: '' }), ctx());

    expect(res.status).toBe(403);
  });

  it('API-ADMIN-011 表の書き込みが誤りを返したら 500 Failed to update template を返し、監査に残さない', async () => {
    setup({ updateResult: { data: null, error: { code: '23514', message: 'check violation' } } });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update template' });
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-011 認可の後の client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await PUT(makeRequest(VALID), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('API-ADMIN-011 道の id の取り出しが失敗したら 500 Internal server error を返し、何も書かない', async () => {
    setup();

    const res = await PUT(makeRequest(VALID), { params: Promise.reject(new Error('bad params')) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(templatesOp()).toBeUndefined();
  });
});
