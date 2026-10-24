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

jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn() }));

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
const sendMail = require('@/lib/mail').default;
const { parseReplyAddress } = require('@/lib/contact/reply-address');
const { POST } = require('@/app/api/admin/contact/[id]/reply/route');

const INQUIRY_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const params = (id = INQUIRY_ID) => ({ params: Promise.resolve({ id }) });

const post = (body: unknown, raw = false) =>
  new Request(`http://localhost/api/admin/contact/${INQUIRY_ID}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'jest-agent' },
    body: raw ? (body as string) : JSON.stringify(body),
  });

const INQUIRY = { id: INQUIRY_ID, email: 'taro@example.com', subject: 'Question' };

function setupDb(
  options: {
    inquiry?: Result;
    insertError?: unknown;
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
      contact_inquiries: { single: options.inquiry ?? { data: INQUIRY, error: null }, default: { data: null, error: null } },
      contact_messages: { default: { data: null, error: options.insertError ?? null } },
    },
  });
}

const ENV_KEYS = ['MAIL_FROM_ADDRESS', 'CONTACT_INBOUND_DOMAIN', 'CONTACT_REPLY_SECRET'] as const;

describe('API-ADMIN-008 POST /api/admin/contact/[id]/reply', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MAIL_FROM_ADDRESS = 'shop@example.com';
    process.env.CONTACT_INBOUND_DOMAIN = 'in.example.com';
    process.env.CONTACT_REPLY_SECRET = 'reply-secret-for-test';
    sendMail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('API-ADMIN-008 admin.contact.manage が無く別の権限だけでは 403 で断り、問い合わせの表に触れない', async () => {
    setupDb({ codes: ['admin.contact.read', 'admin.orders.manage'] });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.contact.manage' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-008 aal2 でない session は 403 MFA required で断り、問い合わせの表に触れない', async () => {
    setupDb({ aal: 'aal1' });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.contact.manage' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-008 token が無効なら 401 で断り、問い合わせの表に触れない', async () => {
    setupDb({ verified: { ok: false, reason: 'invalid' } });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(touchedContactTables()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-008 session が失効していれば 401、確認できなければ 503 と Retry-After で断る', async () => {
    setupDb({ liveness: 'revoked' });
    const revoked = await POST(post({ body: 'hi' }), params());
    setupDb({ liveness: 'unavailable' });
    const unavailable = await POST(post({ body: 'hi' }), params());

    expect(revoked.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('30');
    expect(touchedContactTables()).toHaveLength(0);
  });

  it('API-ADMIN-008 認可の途中で例外が出たら 500 Internal server error にし、問い合わせの表に触れない', async () => {
    setupDb();
    verifyAccessToken.mockRejectedValue(new Error('boom'));

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(touchedContactTables()).toHaveLength(0);
  });

  it.each([
    ['空の本文', { body: '' }],
    ['空白だけの本文', { body: '   ' }],
    ['本文が無い', {}],
    ['5001字の本文', { body: 'a'.repeat(5001) }],
  ])('API-ADMIN-008 %s は 400 を返し、保存もメールもしない', async (_label, payload) => {
    setupDb();

    const res = await POST(post(payload), params());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid request');
    expect(body.details).toBeDefined();
    expect(touchedContactTables()).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('API-ADMIN-008 壊れた JSON も形の誤りとして 400 を返す', async () => {
    setupDb();

    const res = await POST(post('{oops', true), params());

    expect(res.status).toBe(400);
  });

  it('API-ADMIN-008 5000字の本文は受ける', async () => {
    setupDb();

    const res = await POST(post({ body: 'a'.repeat(5000) }), params());

    expect(res.status).toBe(201);
  });

  it('API-ADMIN-008 問い合わせが無い時は 404 を返し、保存もメールも監査もしない', async () => {
    setupDb({ inquiry: { data: null, error: { message: 'no rows' } } });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Inquiry not found' });
    expect(opsOf('contact_messages')).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-008 誤りが無くても行が空なら 404 を返す', async () => {
    setupDb({ inquiry: { data: null, error: null } });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(404);
  });

  it('API-ADMIN-008 返信を店の役・web・操作した人で保存し、answered と時刻に更新する', async () => {
    setupDb();

    const res = await POST(post({ body: '  ありがとうございます  ' }), params());

    expect(res.status).toBe(201);
    expect(callsOf('contact_messages', 'insert')).toEqual([
      [
        'insert',
        [[{ inquiry_id: INQUIRY_ID, sender_role: 'admin', author_id: 'admin-1', body: 'ありがとうございます', channel: 'web' }]],
      ],
    ]);
    const [[, [patch]]] = callsOf('contact_inquiries', 'update') as Array<[string, [Record<string, string>]]>;
    expect(patch.status).toBe('answered');
    expect(patch.last_message_at).toBe(patch.updated_at);
    expect(new Date(patch.last_message_at).toISOString()).toBe(patch.last_message_at);
    expect(callsOf('contact_inquiries', 'eq')).toContainEqual(['eq', ['id', INQUIRY_ID]]);
  });

  it('API-ADMIN-008 保存の誤りは 500 Failed to save reply で、メールも更新も監査もしない', async () => {
    setupDb({ insertError: { message: 'db down' } });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save reply' });
    expect(callsOf('contact_inquiries', 'update')).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it('API-ADMIN-008 保存の後に、件名へ Re: を付け、本文の後に店の名前、Reply-To に検証できる印付きの宛先を入れて送り、監査に残す', async () => {
    setupDb();
    const order: string[] = [];
    sendMail.mockImplementation(async () => {
      order.push(callsOf('contact_messages', 'insert').length === 1 ? 'mail-after-save' : 'mail-before-save');
    });

    const res = await POST(post({ body: '返信です' }), params());

    expect(order).toEqual(['mail-after-save']);
    const mail = sendMail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: 'taro@example.com', subject: 'Re: Question', text: '返信です\n\n---\nLe Fil des Heures' });
    expect(mail.replyTo).toMatch(/^reply\+.+@in\.example\.com$/);
    expect(parseReplyAddress(mail.replyTo)).toEqual({ inquiryId: INQUIRY_ID, valid: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, mailSent: true });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.contact.reply',
      actor_id: 'admin-1',
      resource: 'contact',
      resource_id: INQUIRY_ID,
      outcome: 'success',
      detail: 'reply_sent',
      user_agent: 'jest-agent',
    });
  });

  it('API-ADMIN-008 件名が Re: で始まる時は重ねて付けない', async () => {
    setupDb({ inquiry: { data: { ...INQUIRY, subject: 'Re: Question' }, error: null } });

    await POST(post({ body: 'hi' }), params());

    expect(sendMail.mock.calls[0][0].subject).toBe('Re: Question');
  });

  it('API-ADMIN-008 返信の宛先の設定が無い時は Reply-To を付けずに送る', async () => {
    delete process.env.CONTACT_INBOUND_DOMAIN;
    setupDb();

    const res = await POST(post({ body: 'hi' }), params());

    expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
    expect((await res.json()).mailSent).toBe(true);
  });

  it('API-ADMIN-008 メールが失敗しても保存は残し、mailSent を偽にして監査に error を残す', async () => {
    setupDb();
    sendMail.mockRejectedValue(new Error('smtp down'));

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, mailSent: false });
    expect(callsOf('contact_messages', 'insert')).toHaveLength(1);
    expect(callsOf('contact_inquiries', 'update')).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ outcome: 'error', detail: 'reply_saved_mail_failed' });
  });

  it('API-ADMIN-008 送り手の住所の設定が無い時はメールを送らず、mailSent は真で監査は reply_sent', async () => {
    delete process.env.MAIL_FROM_ADDRESS;
    setupDb();

    const res = await POST(post({ body: 'hi' }), params());

    expect(sendMail).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, mailSent: true });
    expect(auditRows()[0]).toMatchObject({ outcome: 'success', detail: 'reply_sent' });
  });

  it('API-ADMIN-008 監査の行にメールと IP を入れない', async () => {
    setupDb();

    await POST(post({ body: 'hi' }), params());

    const [entry] = auditRows();
    expect(JSON.stringify(entry)).not.toContain('taro@example.com');
    expect(entry.ip).toBeUndefined();
  });

  it('API-ADMIN-008 認可の後に表のための client を作れず例外が出たら 500 Internal server error を返す', async () => {
    setupDb();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await POST(post({ body: 'hi' }), params());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
