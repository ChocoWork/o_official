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
const { GET } = require('@/app/api/admin/contact/route');

type InquiryRow = Record<string, unknown>;

/** contact_inquiries を行ごと持つ作り物。select の列・eq・or(ilike)・order・range を本当に当てて返す */
function inquiriesTable(seed: InquiryRow[], override?: { data: unknown; count: unknown; error: unknown }) {
  return () => {
    let rows = [...seed];
    let columns: string[] = [];
    const b: Record<string, unknown> = {};
    b.select = (cols: string) => {
      columns = cols.split(',').map((c) => c.trim());
      return b;
    };
    b.eq = (col: string, value: unknown) => {
      rows = rows.filter((r) => r[col] === value);
      return b;
    };
    b.or = (expr: string) => {
      const clauses = expr.split(',').map((c) => {
        const [col, , pattern] = c.split('.');
        return { col, needle: pattern.replace(/^%|%$/g, '').toLowerCase() };
      });
      rows = rows.filter((r) => clauses.some(({ col, needle }) => String(r[col]).toLowerCase().includes(needle)));
      return b;
    };
    b.order = (col: string, { ascending }: { ascending: boolean }) => {
      rows = [...rows].sort((a, c) => (String(a[col]) < String(c[col]) ? -1 : 1) * (ascending ? 1 : -1));
      return b;
    };
    b.range = async (from: number, to: number) => {
      if (override) return override;
      const page = rows.slice(from, to + 1).map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
      return { data: page, count: rows.length, error: null };
    };
    return b;
  };
}

function seedRows(count: number): InquiryRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `inq-${String(i + 1).padStart(3, '0')}`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    last_message_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
    name: `客${i + 1}`,
    email: `guest${i + 1}@example.com`,
    inquiry_type: 'other',
    subject: `件名${i + 1}`,
    status: 'open',
    order_id: null,
    user_id: null,
    submitted_ip: '203.0.113.5',
    user_agent: 'jest-agent',
  }));
}

function get(qs = '') {
  return new Request(`http://localhost/api/admin/contact${qs}`, { method: 'GET' });
}

async function listIds(qs: string, seed: InquiryRow[]) {
  setup({ custom: { contact_inquiries: inquiriesTable(seed) } });
  const res = await GET(get(qs));
  const body = await res.json();
  return { res, body, ids: (body.data as InquiryRow[]).map((r) => r.id) };
}

describe('API-ADMIN-005 GET /api/admin/contact', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-ADMIN-005 admin.contact.read が無く別の権限だけでは 403 で断り、問い合わせの表に触れない', async () => {
    setup({ codes: ['admin.contact.manage', 'admin.orders.read'] });

    const res = await GET(get());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.read' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-005 aal2 でない session は 403 MFA required で断り、問い合わせの表に触れない', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(get());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.read' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-005 token が無効なら 401 で断り、問い合わせの表に触れない', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(get());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-005 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setup({ liveness: 'revoked' });
    const revoked = await GET(get());
    setup({ liveness: 'unavailable' });
    const unavailable = await GET(get());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-005 認可の途中で例外が出たら 500 Internal server error にし、問い合わせの表に触れない', async () => {
    setup();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-005 admin.contact.read だけの権限で読め、既定は1ページ目・20件を最後のやり取りの新しい順に返す', async () => {
    const seed = seedRows(45);
    setup({ codes: ['admin.contact.read'], custom: { contact_inquiries: inquiriesTable(seed) } });

    const res = await GET(get());
    const body = await res.json();

    const expected = [...seed]
      .sort((a, b) => (String(a.last_message_at) < String(b.last_message_at) ? 1 : -1))
      .slice(0, 20)
      .map((r) => r.id);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ page: 1, pageSize: 20, totalPages: 3, totalCount: 45 });
    expect(body.data.map((r: InquiryRow) => r.id)).toEqual(expected);
  });

  it('API-ADMIN-005 一覧に IP や端末の情報は載せず、開いた記録は状態・種別・ページ・検索語の長さだけで残す', async () => {
    const { body } = await listIds('?status=open&q=guest1', seedRows(3));

    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row).not.toHaveProperty('submitted_ip');
      expect(row).not.toHaveProperty('user_agent');
      expect(row).toHaveProperty('last_message_at');
    }
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.contact.list',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'contact',
      outcome: 'success',
      metadata: { status: 'open', type: null, page: 1, q_length: 6 },
    });
    expect(rows[0].ip).toBeUndefined();
    const logged = JSON.stringify(rows[0]);
    expect(logged).not.toContain('guest1');
    expect(logged).not.toContain('客1');
  });

  it('API-ADMIN-005 読みが誤りの時は一覧を開いた記録を書かず、監査の書き込みが失敗しても一覧は 200 のまま', async () => {
    setup({ custom: { contact_inquiries: inquiriesTable([], { data: null, count: null, error: { message: 'db down' } }) } });
    const failed = await GET(get());
    expect(failed.status).toBe(500);
    expect(auditRows()).toHaveLength(0);

    setup({ custom: { contact_inquiries: inquiriesTable(seedRows(2)) } });
    const base = serviceClient.from.getMockImplementation() as (table: string) => unknown;
    serviceClient.from.mockImplementation((table: string) =>
      table === 'audit_logs' ? { insert: () => Promise.reject(new Error('audit down')) } : base(table),
    );
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
  });

  it('API-ADMIN-005 page と pageSize に応じた範囲の行と総ページを返す', async () => {
    const { body, ids } = await listIds('?page=3&pageSize=10', seedRows(100));

    expect(ids).toHaveLength(10);
    expect(body).toMatchObject({ page: 3, pageSize: 10, totalPages: 10, totalCount: 100 });
  });

  it.each([
    ['page=0', 1, 20],
    ['page=-4', 1, 20],
    ['page=abc', 1, 20],
    ['pageSize=0', 1, 20],
    ['pageSize=abc', 1, 20],
    ['pageSize=500', 1, 100],
    ['pageSize=-5', 1, 1],
  ])('API-ADMIN-005 入力 %s は page=%i・pageSize=%i に丸める', async (qs, page, pageSize) => {
    const { body } = await listIds(`?${qs}`, seedRows(150));

    expect(body.page).toBe(page);
    expect(body.pageSize).toBe(pageSize);
    expect(body.data).toHaveLength(pageSize);
  });

  it('API-ADMIN-005 決まった状態と種別だけで行を絞り、決まった値の外は絞らない', async () => {
    const seed = seedRows(4);
    seed[0].status = 'pending';
    seed[0].inquiry_type = 'order';
    seed[1].status = 'pending';
    seed[2].inquiry_type = 'order';

    const both = await listIds('?status=pending&type=order', seed);
    const outside = await listIds('?status=deleted&type=spam', seed);

    expect(both.ids).toEqual(['inq-001']);
    expect(both.body.totalCount).toBe(1);
    expect(outside.body.totalCount).toBe(4);
  });

  it('API-ADMIN-005 検索語は名前・メール・件名の部分一致で、区切りの字は空白にして前後を除く', async () => {
    const seed = seedRows(3);
    seed[0].name = 'Taro Yamada';
    seed[1].email = 'hanako+taro@example.com';
    seed[2].subject = '[TARO] 注文について';

    const plain = await listIds('?q=taro', seed);
    const wrapped = await listIds(`?q=${encodeURIComponent(' ,(taro), ')}`, seed);
    const separated = await listIds(`?q=${encodeURIComponent('Taro,Yamada')}`, seed);

    expect(plain.ids.sort()).toEqual(['inq-001', 'inq-002', 'inq-003']);
    expect(wrapped.ids.sort()).toEqual(['inq-001', 'inq-002', 'inq-003']);
    expect(separated.ids).toEqual(['inq-001']);
  });

  it('API-ADMIN-005 検索語は100字で切り、区切りの字だけの検索語は絞らない', async () => {
    const seed = seedRows(2);
    seed[0].subject = 'x'.repeat(100);

    const long = await listIds(`?q=${'x'.repeat(150)}`, seed);
    const onlySeparators = await listIds(`?q=${encodeURIComponent(' ,() ')}`, seed);

    expect(long.ids).toEqual(['inq-001']);
    expect(onlySeparators.body.totalCount).toBe(2);
  });

  it('API-ADMIN-005 行も件数も null で返っても、空の一覧と総ページ 1 で返す', async () => {
    setup({ custom: { contact_inquiries: inquiriesTable([], { data: null, count: null, error: null }) } });

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], page: 1, pageSize: 20, totalPages: 1, totalCount: 0 });
  });

  it('API-ADMIN-005 DB の誤りは 500 Failed to fetch inquiries を返し、中身を漏らさない', async () => {
    setup({ custom: { contact_inquiries: inquiriesTable([], { data: null, count: null, error: { message: 'db down' } }) } });

    const res = await GET(get());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to fetch inquiries' });
  });

  it('API-ADMIN-005 認可の後に表のための client を作れず例外が出たら 500 Internal server error にする', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('API-ADMIN-005 表は service role の client で読み、利用者の JWT の client は使わない', async () => {
    await listIds('', seedRows(1));

    expect(createClient).not.toHaveBeenCalled();
  });
});
