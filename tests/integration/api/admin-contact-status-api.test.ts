export {};

// 窓口・認可（admin-rbac）と監査（audit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 問い合わせの窓口は service role の client 1つで表を読み書きするので、差し替える client もその1つだけ
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

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type TableResults = { default?: Result; single?: Result };

function createFakeClient(tables: Record<string, TableResults>, custom: Record<string, () => unknown> = {}) {
  const ops: TableOp[] = [];
  const client = {
    ops,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      if (custom[table]) {
        return custom[table]();
      }
      const result = (terminal?: 'single') =>
        (terminal ? tables[table]?.[terminal] : undefined) ?? tables[table]?.default ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order', 'limit', 'range']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result('single'));
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

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    tables?: Record<string, TableResults>;
    custom?: Record<string, () => unknown>;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  serviceClient = createFakeClient(
    {
      ...(options.tables ?? {}),
      user_roles: { default: { data: aclRows(options.codes ?? ['admin.contact.read', 'admin.contact.manage']), error: null } },
      audit_logs: { default: { data: null, error: null } },
    },
    options.custom,
  );
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

function opsOf(table: string) {
  return serviceClient.ops.filter((o) => o.table === table);
}

function callsOf(table: string, method: string) {
  return opsOf(table)
    .flatMap((o) => o.calls)
    .filter(([m]) => m === method);
}

function auditRows(): Array<Record<string, unknown>> {
  return callsOf('audit_logs', 'insert').flatMap(([, args]) => args[0] as Array<Record<string, unknown>>);
}

const CONTACT_TABLES = ['contact_inquiries', 'contact_messages'];

function touchedContactTables() {
  return serviceClient.ops.filter((o) => CONTACT_TABLES.includes(o.table));
}
const { PATCH } = require('@/app/api/admin/contact/[id]/route');

const INQUIRY_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const params = (id = INQUIRY_ID) => ({ params: Promise.resolve({ id }) });

const patch = (body: unknown, raw = false) =>
  new Request(`http://localhost/api/admin/contact/${INQUIRY_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'user-agent': 'jest-agent' },
    body: raw ? (body as string) : JSON.stringify(body),
  });

function setupDb(options: { updateError?: unknown; codes?: string[]; aal?: string; verified?: unknown; liveness?: string } = {}) {
  setup({
    codes: options.codes,
    aal: options.aal,
    verified: options.verified,
    liveness: options.liveness,
    tables: { contact_inquiries: { default: { data: null, error: options.updateError ?? null } } },
  });
}

describe('API-ADMIN-007 PATCH /api/admin/contact/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-007 admin.contact.manage が無く別の権限だけでは 403 で断り、問い合わせの表に触れない', async () => {
    setupDb({ codes: ['admin.contact.read', 'admin.orders.manage'] });

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.manage' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-007 aal2 でない session は 403 MFA required で断り、問い合わせの表に触れない', async () => {
    setupDb({ aal: 'aal1' });

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.manage' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-007 token が無効なら 401 で断り、問い合わせの表に触れない', async () => {
    setupDb({ verified: { ok: false, reason: 'invalid' } });

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-007 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setupDb({ liveness: 'revoked' });
    const revoked = await PATCH(patch({ status: 'closed' }), params());
    setupDb({ liveness: 'unavailable' });
    const unavailable = await PATCH(patch({ status: 'closed' }), params());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-007 認可の途中で例外が出たら 500 Internal server error にし、問い合わせの表に触れない', async () => {
    setupDb();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(touchedContactTables()).toHaveLength(0);
  });

  it.each(['open', 'pending', 'answered', 'closed'])(
    'API-ADMIN-007 状態 %s に直し、直した時刻を入れて 200 を返す',
    async (status) => {
      setupDb();

      const res = await PATCH(patch({ status }), params());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      const [[, [payload]]] = callsOf('contact_inquiries', 'update') as Array<[string, [Record<string, string>]]>;
      expect(payload.status).toBe(status);
      expect(new Date(payload.updated_at).toISOString()).toBe(payload.updated_at);
      expect(payload).not.toHaveProperty('last_message_at');
      expect(callsOf('contact_inquiries', 'eq')).toEqual([['eq', ['id', INQUIRY_ID]]]);
    },
  );

  it('API-ADMIN-007 成功を操作した人・新しい状態・端末つきで監査の表に残し、メールと IP は入れない', async () => {
    setupDb();

    await PATCH(patch({ status: 'pending' }), params());

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.status_update',
      actor_id: 'admin-1',
      resource: 'contact',
      resource_id: INQUIRY_ID,
      outcome: 'success',
      detail: 'status=pending',
      user_agent: 'jest-agent',
    });
    expect(rows[0].ip).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain('taro@example.com');
  });

  it('API-ADMIN-007 決まった4つの外の状態は 400 で details を付け、書き換えも監査もしない', async () => {
    setupDb();

    const res = await PATCH(patch({ status: 'deleted' }), params());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid request');
    expect(body.details).toBeDefined();
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-007 状態が無い本文は 400 を返す', async () => {
    setupDb();

    const res = await PATCH(patch({}), params());

    expect(res.status).toBe(400);
  });

  it('API-ADMIN-007 壊れた JSON も形の誤りとして 400 を返す', async () => {
    setupDb();

    const res = await PATCH(patch('{not json', true), params());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid request');
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-007 拒否された時は本文を読まず、状態を書き換えない', async () => {
    setupDb({ codes: ['admin.contact.read'] });
    const req = patch({ status: 'closed' });
    const readBody = jest.spyOn(req, 'json');

    await PATCH(req, params());

    expect(readBody).not.toHaveBeenCalled();
    expect(callsOf('contact_inquiries', 'update')).toHaveLength(0);
  });

  it('API-ADMIN-007 DB の誤りは 500 Failed to update status で、監査に成功を残さない', async () => {
    setupDb({ updateError: { message: 'db down' } });

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update status' });
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-007 認可の後に表のための client を作れず例外が出たら 500 Internal server error を返す', async () => {
    setupDb();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await PATCH(patch({ status: 'closed' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
