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
const { GET } = require('@/app/api/admin/contact/[id]/route');

const INQUIRY_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const params = (id = INQUIRY_ID) => ({ params: Promise.resolve({ id }) });
const get = () => new Request(`http://localhost/api/admin/contact/${INQUIRY_ID}`, { method: 'GET' });

const inquiryRow = {
  id: INQUIRY_ID,
  name: 'Taro',
  email: 'taro@example.com',
  subject: 'Question',
  message: 'Hello',
  status: 'open',
  order_id: null,
  user_id: 'user-9',
  submitted_ip: '203.0.113.5',
  user_agent: 'jest-agent',
};

function setupDb(
  options: {
    inquiry?: Result;
    messages?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
  } = {},
) {
  setup({
    codes: options.codes,
    aal: options.aal,
    verified: options.verified,
    liveness: options.liveness,
    tables: {
      contact_inquiries: { single: options.inquiry ?? { data: inquiryRow, error: null } },
      contact_messages: { default: options.messages ?? { data: [], error: null } },
    },
  });
}

describe('API-ADMIN-006 GET /api/admin/contact/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-006 admin.contact.read が無く別の権限だけでは 403 で断り、問い合わせの表に触れない', async () => {
    setupDb({ codes: ['admin.contact.manage', 'admin.orders.read'] });

    const res = await GET(get(), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.read' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-006 aal2 でない session は 403 MFA required で断り、問い合わせの表に触れない', async () => {
    setupDb({ aal: 'aal1' });

    const res = await GET(get(), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.read' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-006 token が無効なら 401 で断り、問い合わせの表に触れない', async () => {
    setupDb({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(get(), params());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-006 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setupDb({ liveness: 'revoked' });
    const revoked = await GET(get(), params());
    setupDb({ liveness: 'unavailable' });
    const unavailable = await GET(get(), params());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-006 認可の途中で例外が出たら 500 Internal server error にし、問い合わせの表に触れない', async () => {
    setupDb();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await GET(get(), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-006 注文に結んでいない問い合わせは orderNumber が null で、やり取りを古い順に返す', async () => {
    const messages = [
      { id: 'm1', sender_role: 'customer' },
      { id: 'm2', sender_role: 'admin' },
    ];
    setupDb({ codes: ['admin.contact.read'], messages: { data: messages, error: null } });

    const res = await GET(get(), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ...inquiryRow, orderNumber: null, messages } });
    expect(callsOf('contact_inquiries', 'eq')).toEqual([['eq', ['id', INQUIRY_ID]]]);
    expect(callsOf('contact_messages', 'eq')).toEqual([['eq', ['inquiry_id', INQUIRY_ID]]]);
    expect(callsOf('contact_messages', 'order')).toEqual([['order', ['created_at', { ascending: true }]]]);
  });

  it('API-ADMIN-006 管理者向けの詳細には IP と端末の情報の列まで引く', async () => {
    setupDb();

    await GET(get(), params());

    const [[, [columns]]] = callsOf('contact_inquiries', 'select') as Array<[string, [string]]>;
    expect(columns).toContain('submitted_ip');
    expect(columns).toContain('user_agent');
  });

  it('API-ADMIN-006 注文に結んだ問い合わせは注文番号を付ける', async () => {
    setupDb({ inquiry: { data: { ...inquiryRow, order_id: 'abcdef12-0000-0000-0000-000000000000' }, error: null } });

    const res = await GET(get(), params());

    expect(res.status).toBe(200);
    expect((await res.json()).data.orderNumber).toBe('ORD-ABCDEF12');
  });

  it('API-ADMIN-006 やり取りの data が null でも空の配列で返す', async () => {
    setupDb({ messages: { data: null, error: null } });

    const res = await GET(get(), params());

    expect((await res.json()).data.messages).toEqual([]);
  });

  it('API-ADMIN-006 問い合わせが引けない時は 404 を返し、やり取りを読まない', async () => {
    setupDb({ inquiry: { data: null, error: { message: 'no rows' } } });

    const res = await GET(get(), params());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Inquiry not found' });
    expect(opsOf('contact_messages')).toHaveLength(0);
  });

  it('API-ADMIN-006 誤りが無くても行が空なら 404 を返す', async () => {
    setupDb({ inquiry: { data: null, error: null } });

    const res = await GET(get(), params());

    expect(res.status).toBe(404);
  });

  it('API-ADMIN-006 やり取りの読みの誤りは 500 Failed to fetch messages を返す', async () => {
    setupDb({ messages: { data: null, error: { message: 'db down' } } });

    const res = await GET(get(), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch messages' });
  });

  it('API-ADMIN-006 認可の後に表のための client を作れず例外が出たら 500 Internal server error を返す', async () => {
    setupDb();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await GET(get(), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('API-ADMIN-006 閲覧は監査に残さず、利用者の JWT の client も使わない', async () => {
    setupDb();

    await GET(get(), params());

    expect(auditRows()).toHaveLength(0);
    expect(createClient).not.toHaveBeenCalled();
  });
});
