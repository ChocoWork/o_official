export {};

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => {
  const actual = jest.requireActual('@/lib/audit');
  return { ...actual, __esModule: true, logAudit: jest.fn(), default: jest.fn() };
});
jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn() }));
// 認可（admin-rbac）は本物を通し、token の検証と session の確認（authenticate）だけを差し替える
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const actualAudit = jest.requireActual('@/lib/audit');
const sendMail: jest.Mock = require('@/lib/mail').default;
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_EMAIL = 'owner@example.com';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const IP_HEADER = '203.0.113.7, 10.0.0.1';
const UA = 'Mozilla/5.0 (audit-test)';

const createUserRoute = () => require('@/app/api/admin/create-user/route');
const revokeRoute = () => require('@/app/api/admin/revoke-user-sessions/route');
const mfaResetRoute = () => require('@/app/api/admin/users/mfa/reset/route');
const contactRoute = () => require('@/app/api/admin/contact/route');
const contactItemRoute = () => require('@/app/api/admin/contact/[id]/route');
const contactReplyRoute = () => require('@/app/api/admin/contact/[id]/reply/route');
const templatesRoute = () => require('@/app/api/admin/contact/templates/route');
const templateItemRoute = () => require('@/app/api/admin/contact/templates/[id]/route');
const presetsRoute = () => require('@/app/api/admin/item-color-presets/route');
const presetItemRoute = () => require('@/app/api/admin/item-color-presets/[id]/route');
const auditLogsRoute = () => require('@/app/api/admin/audit-logs/route');

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': IP_HEADER, 'user-agent': UA, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const ALL_ADMIN_CODES = [
  'admin.users.read',
  'admin.users.manage',
  'admin.items.read',
  'admin.items.manage',
  'admin.contact.read',
  'admin.contact.manage',
  'admin.audit.read',
];

// 認可が引く権限の組。allowAdmin は全部、denyAdmin は空（どの権限も無い）にする
let aclCodes: string[] = ALL_ADMIN_CODES;

function aclChain() {
  const rows = [{ roles: { role_permissions: aclCodes.map((code) => ({ permissions: { code } })) } }];
  return chainResult({ data: rows, error: null });
}

/** 認可の権限の照会（user_roles）だけを差し替え、ほかの表と rpc・Auth は渡された client のまま。 */
function setService(service: { from: (table: string) => unknown } & Record<string, unknown>) {
  createServiceRoleClient.mockResolvedValue({
    ...service,
    from: (table: string) => (table === 'user_roles' ? aclChain() : service.from(table)),
  });
}

/** 認可の権限の照会までは通し、その後の client の用意で投げる。 */
function failServiceAfterAuthorization(error: Error) {
  createServiceRoleClient.mockResolvedValueOnce({ from: () => aclChain() });
  createServiceRoleClient.mockRejectedValue(error);
}

function allowAdmin() {
  aclCodes = ALL_ADMIN_CODES;
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: ACTOR_ID, email: ACTOR_EMAIL, session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function denyAdmin() {
  aclCodes = [];
}

/** どのメソッドを呼んでも同じ結果を返す、チェーンできる client。 */
function chainResult(result: Record<string, unknown>) {
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve(result);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

function serviceWith(result: Record<string, unknown>, auth: Record<string, unknown> = {}) {
  const chain = chainResult(result);
  return {
    from: jest.fn(() => chain),
    rpc: jest.fn(() => chain),
    auth: { admin: auth },
  };
}

/** 呼び出しの引数に、書いてはいけない鍵が無いこと。 */
function auditArg(callIndex = 0): Record<string, unknown> {
  return logAudit.mock.calls[callIndex][0];
}

describe('ARC-ADMIN-003 監査ログの書き込み', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.MAIL_FROM_ADDRESS;
    delete process.env.ALERT_AUDIT_URL;
    delete process.env.ALERT_AUDIT_SECRET;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    allowAdmin();
    setService(serviceWith({}));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('利用者の作成', () => {
    it('ARC-ADMIN-003 形の誤りは failure で、操作した人の id とメールを入れ、IP とブラウザは入れない', async () => {
      setService(serviceWith({}));

      const res = await createUserRoute().POST(req('POST', 'http://localhost/api/admin/create-user', { email: 'bad' }));

      expect(res.status).toBe(400);
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(auditArg()).toEqual({
        action: 'admin_create_user',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        resource: 'users',
        outcome: 'failure',
        detail: 'Invalid request body',
      });
      expect(auditArg()).not.toHaveProperty('ip');
      expect(auditArg()).not.toHaveProperty('user_agent');
    });

    it.each(['User already registered', 'duplicate key value'])(
      'ARC-ADMIN-003 重なり（%s）は conflict で、Supabase の誤りの文を detail にそのまま残す',
      async (message) => {
        setService(
          serviceWith({}, { createUser: jest.fn().mockResolvedValue({ data: null, error: { message } }) }),
        );

        const res = await createUserRoute().POST(
          req('POST', 'http://localhost/api/admin/create-user', { email: 'a@example.com', password: 'password123' }),
        );

        expect(res.status).toBe(409);
        expect(auditArg()).toMatchObject({ outcome: 'conflict', detail: message, actor_email: ACTOR_EMAIL });
        expect(auditArg()).not.toHaveProperty('ip');
      },
    );

    it('ARC-ADMIN-003 重なり以外の誤りは error で、誤りの文を detail に残す', async () => {
      setService(
        serviceWith({}, { createUser: jest.fn().mockResolvedValue({ data: null, error: { message: 'smtp down' } }) }),
      );

      const res = await createUserRoute().POST(
        req('POST', 'http://localhost/api/admin/create-user', { email: 'a@example.com', password: 'password123' }),
      );

      expect(res.status).toBe(500);
      expect(auditArg()).toMatchObject({ outcome: 'error', detail: 'smtp down' });
      expect(logAudit).toHaveBeenCalledTimes(1);
    });

    it('ARC-ADMIN-003 成功は success で、作った利用者の id を resource_id に入れる', async () => {
      setService(
        serviceWith(
          {},
          { createUser: jest.fn().mockResolvedValue({ data: { user: { id: TARGET_ID, email: 'a@example.com' } }, error: null }) },
        ),
      );

      const res = await createUserRoute().POST(
        req('POST', 'http://localhost/api/admin/create-user', { email: 'a@example.com', password: 'password123' }),
      );

      expect(res.status).toBe(201);
      expect(auditArg()).toEqual({
        action: 'admin_create_user',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        resource: 'users',
        resource_id: TARGET_ID,
        outcome: 'success',
      });
    });

    it('ARC-ADMIN-003 認可に失敗したときは何も書かない', async () => {
      denyAdmin();

      await createUserRoute().POST(req('POST', 'http://localhost/api/admin/create-user', {}));

      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  describe('強制失効', () => {
    const url = 'http://localhost/api/admin/revoke-user-sessions';

    it('ARC-ADMIN-003 認可の失敗は unauthorized で、操作した人は空・IP は x-forwarded-for の左端・ブラウザを入れる', async () => {
      denyAdmin();

      const res = await revokeRoute().POST(req('POST', url, { user_id: TARGET_ID }));

      expect(res.status).toBe(403);
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(auditArg()).toEqual({
        action: 'admin_revoke_user_sessions',
        actor_id: null,
        actor_email: null,
        resource: 'sessions',
        outcome: 'unauthorized',
        detail: 'Unauthorized access to revoke user sessions',
        ip: '203.0.113.7',
        user_agent: UA,
      });
    });

    it('ARC-ADMIN-003 認可の失敗でも、見出しが無ければ IP とブラウザは null で書く', async () => {
      denyAdmin();
      const bare = new Request(url, { method: 'POST', body: '{}' });

      await revokeRoute().POST(bare);

      expect(auditArg()).toMatchObject({ outcome: 'unauthorized', ip: null, user_agent: null });
    });

    it('ARC-ADMIN-003 形の誤りは failure で、メール・IP・ブラウザを入れる', async () => {
      const res = await revokeRoute().POST(req('POST', url, { user_id: '' }));

      expect(res.status).toBe(400);
      expect(auditArg()).toEqual({
        action: 'admin_revoke_user_sessions',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        resource: 'sessions',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: '203.0.113.7',
        user_agent: UA,
      });
    });

    it('ARC-ADMIN-003 Auth の session を消す関数が誤りなら error で、IP とブラウザは入れない', async () => {
      const service = serviceWith({ error: null });
      service.rpc = jest.fn(() => chainResult({ data: null, error: { message: 'rpc failed' } }));
      setService(service);

      const res = await revokeRoute().POST(req('POST', url, { user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(auditArg()).toEqual({
        action: 'admin_revoke_user_sessions',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        resource: 'sessions',
        resource_id: TARGET_ID,
        outcome: 'error',
        detail: 'auth_session_revocation_failed',
      });
    });

    it('ARC-ADMIN-003 DB が例外を投げたら error で例外の文を detail に残し、IP とブラウザは入れない', async () => {
      failServiceAfterAuthorization(new Error('connection lost'));

      const res = await revokeRoute().POST(req('POST', url, { user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(auditArg()).toMatchObject({
        outcome: 'error',
        resource_id: TARGET_ID,
        detail: 'Error: connection lost',
      });
      expect(auditArg()).not.toHaveProperty('ip');
      expect(auditArg()).not.toHaveProperty('user_agent');
    });

    it.each([
      [3, 3],
      [null, 0],
    ])('ARC-ADMIN-003 成功は success で消した Auth の session の数（%s）を metadata に入れる（%s）', async (deleted, expected) => {
      const service = serviceWith({ error: null });
      service.rpc = jest.fn(() => chainResult({ data: deleted, error: null }));
      setService(service);

      const res = await revokeRoute().POST(req('POST', url, { user_id: TARGET_ID }));

      expect(res.status).toBe(200);
      expect(auditArg()).toEqual({
        action: 'admin_revoke_user_sessions',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        resource: 'sessions',
        resource_id: TARGET_ID,
        outcome: 'success',
        metadata: { auth_sessions_deleted: expected },
      });
    });
  });

  describe('2要素のリセット', () => {
    const url = 'http://localhost/api/admin/users/mfa/reset';
    const validBody = { userId: TARGET_ID, reason: 'lost the device twice', confirm: 'RESET_MFA' };

    function mfaService(options: {
      target?: unknown;
      getError?: unknown;
      factors?: unknown;
      listError?: unknown;
      deleteResults?: Array<{ error: unknown }>;
    }) {
      const deleteFactor = jest.fn();
      for (const result of options.deleteResults ?? []) deleteFactor.mockResolvedValueOnce(result);
      deleteFactor.mockResolvedValue({ error: null });
      const service = serviceWith(
        {},
        {
          getUserById: jest
            .fn()
            .mockResolvedValue({ data: { user: options.target ?? null }, error: options.getError ?? null }),
          mfa: {
            listFactors: jest
              .fn()
              .mockResolvedValue({ data: { factors: options.factors ?? [] }, error: options.listError ?? null }),
            deleteFactor,
          },
        },
      );
      setService(service);
      return service;
    }

    const base = { action: 'admin.users.mfa.reset', actor_id: ACTOR_ID, actor_email: ACTOR_EMAIL, resource: 'users' };
    const net = { ip: '203.0.113.7', user_agent: UA };

    it('ARC-ADMIN-003 認可に失敗したときは何も書かない', async () => {
      denyAdmin();

      await mfaResetRoute().POST(req('POST', url, validBody));

      expect(logAudit).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-003 形の誤りは failure で、求められた id を残し、理由の文は入れない', async () => {
      const res = await mfaResetRoute().POST(
        req('POST', url, { userId: 'not-a-uuid', reason: 'short', confirm: 'RESET_MFA' }),
      );

      expect(res.status).toBe(400);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: 'not-a-uuid',
        outcome: 'failure',
        detail: 'Invalid request body',
        metadata: { requested_user_id: 'not-a-uuid' },
      });
    });

    it('ARC-ADMIN-003 本文が JSON でなければ failure で、resource_id と requested_user_id は null になる', async () => {
      const broken = new Request(url, {
        method: 'POST',
        headers: { 'x-forwarded-for': IP_HEADER, 'user-agent': UA },
        body: '{broken',
      });

      const res = await mfaResetRoute().POST(broken);

      expect(res.status).toBe(400);
      expect(auditArg()).toMatchObject({
        outcome: 'failure',
        resource_id: null,
        metadata: { requested_user_id: null },
        ...net,
      });
    });

    it('ARC-ADMIN-003 自分自身は failure で、理由の文も metadata も入れない', async () => {
      const res = await mfaResetRoute().POST(req('POST', url, { ...validBody, userId: ACTOR_ID }));

      expect(res.status).toBe(400);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: ACTOR_ID,
        outcome: 'failure',
        detail: 'Self-reset is not allowed',
      });
      expect(createServiceRoleClient).toHaveBeenCalledTimes(1); // 認可の権限の照会だけ
    });

    it.each([
      ['引いた時の誤り', { getError: { message: 'x' }, target: null }],
      ['利用者が居ない', { target: null }],
    ])('ARC-ADMIN-003 対象なし（%s）は failure で、理由の文だけを metadata に入れる', async (_label, options) => {
      mfaService(options);

      const res = await mfaResetRoute().POST(req('POST', url, validBody));

      expect(res.status).toBe(404);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: TARGET_ID,
        outcome: 'failure',
        detail: 'Target user not found',
        metadata: { reason: 'lost the device twice' },
      });
    });

    it.each([
      ['一般の利用者', { role: 'user' }, 'user'],
      ['役割の印が無い', undefined, 'user'],
      ['壊れた役割', { role: 'owner' }, 'user'],
    ])('ARC-ADMIN-003 特権でない（%s）は failure で、理由の文と対象の役割を入れる', async (_label, appMetadata, role) => {
      mfaService({ target: { id: TARGET_ID, email: 'user@example.com', app_metadata: appMetadata } });

      const res = await mfaResetRoute().POST(req('POST', url, validBody));

      expect(res.status).toBe(400);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: TARGET_ID,
        outcome: 'failure',
        detail: 'Target user is not privileged',
        metadata: { reason: 'lost the device twice', target_role: role },
      });
      expect(auditArg().metadata).not.toHaveProperty('target_email');
    });

    it('ARC-ADMIN-003 対象の 2要素の一覧が誤りなら error で、誤りの文を metadata に入れる', async () => {
      mfaService({
        target: { id: TARGET_ID, email: 'staff@example.com', app_metadata: { role: 'admin' } },
        listError: { message: 'auth backend down' },
      });

      const res = await mfaResetRoute().POST(req('POST', url, validBody));

      expect(res.status).toBe(500);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: TARGET_ID,
        outcome: 'error',
        detail: 'Failed to list target MFA factors',
        metadata: { reason: 'lost the device twice', error_message: 'auth backend down' },
      });
    });

    it('ARC-ADMIN-003 消せなかった登録があれば error で、全部の数と消せなかった印を入れる', async () => {
      mfaService({
        target: { id: TARGET_ID, email: 'staff@example.com', app_metadata: { role: 'supporter' } },
        factors: [{ id: 'f1' }, { id: 'f2' }],
        deleteResults: [{ error: null }, { error: { message: 'locked' } }],
      });

      const res = await mfaResetRoute().POST(req('POST', url, validBody));

      expect(res.status).toBe(500);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: TARGET_ID,
        outcome: 'error',
        detail: 'Failed to delete one or more factors',
        metadata: {
          reason: 'lost the device twice',
          total_factors: 2,
          delete_errors: [{ factorId: 'f2', message: 'locked' }],
        },
      });
    });

    it('ARC-ADMIN-003 成功は success で、対象の役割とメール・消した数を入れる', async () => {
      const service = mfaService({
        target: { id: TARGET_ID, email: 'staff@example.com', app_metadata: { role: 'admin' } },
        factors: [{ id: 'f1' }, { id: 'f2' }],
      });

      const res = await mfaResetRoute().POST(req('POST', url, validBody));

      expect(res.status).toBe(200);
      expect(service.auth.admin.mfa).toBeDefined();
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(auditArg()).toEqual({
        ...base,
        ...net,
        resource_id: TARGET_ID,
        outcome: 'success',
        detail: 'Admin reset user MFA factors',
        metadata: {
          reason: 'lost the device twice',
          target_role: 'admin',
          target_email: 'staff@example.com',
          deleted_factor_count: 2,
        },
      });
    });

    it('ARC-ADMIN-003 成功で対象にメールが無ければ target_email は null になる', async () => {
      mfaService({ target: { id: TARGET_ID, email: undefined, app_metadata: { role: 'admin' } }, factors: [] });

      await mfaResetRoute().POST(req('POST', url, validBody));

      expect(auditArg()).toMatchObject({
        outcome: 'success',
        metadata: { target_email: null, deleted_factor_count: 0 },
      });
    });
  });

  describe('問い合わせの状態の変更・返信・テンプレート', () => {
    const baseUrl = 'http://localhost/api/admin/contact';

    function expectBrowserOnly(call: Record<string, unknown>) {
      expect(call.user_agent).toBe(UA);
      expect(call).not.toHaveProperty('actor_email');
      expect(call).not.toHaveProperty('ip');
    }

    it('ARC-ADMIN-003 状態の変更の成功は、変えた状態を detail に入れ、ブラウザだけを入れる', async () => {
      setService(serviceWith({ error: null }));

      const res = await contactItemRoute().PATCH(req('PATCH', `${baseUrl}/c1`, { status: 'closed' }), ctx('c1'));

      expect(res.status).toBe(200);
      expect(auditArg()).toEqual({
        action: 'admin.contact.status_update',
        actor_id: ACTOR_ID,
        resource: 'contact',
        resource_id: 'c1',
        outcome: 'success',
        detail: 'status=closed',
        user_agent: UA,
      });
      expectBrowserOnly(auditArg());
    });

    it('ARC-ADMIN-003 状態の変更が形の誤り・DB の誤り・認可の失敗なら何も書かない', async () => {
      setService(serviceWith({ error: { message: 'db' } }));

      const invalid = await contactItemRoute().PATCH(req('PATCH', `${baseUrl}/c1`, { status: 'weird' }), ctx('c1'));
      const dbError = await contactItemRoute().PATCH(req('PATCH', `${baseUrl}/c1`, { status: 'closed' }), ctx('c1'));
      denyAdmin();
      const denied = await contactItemRoute().PATCH(req('PATCH', `${baseUrl}/c1`, { status: 'closed' }), ctx('c1'));

      expect([invalid.status, dbError.status, denied.status]).toEqual([400, 500, 403]);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-003 返信の成功は reply_sent で、ブラウザだけを入れる', async () => {
      process.env.MAIL_FROM_ADDRESS = 'shop@example.com';
      sendMail.mockResolvedValue(undefined);
      setService(
        serviceWith({ data: { id: 'c1', email: 'buyer@example.com', subject: 'Size' }, error: null }),
      );

      const res = await contactReplyRoute().POST(
        req('POST', `${baseUrl}/c1/reply`, { body: 'お返事です' }),
        ctx('c1'),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ success: true, mailSent: true });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(auditArg()).toEqual({
        action: 'admin.contact.reply',
        actor_id: ACTOR_ID,
        resource: 'contact',
        resource_id: 'c1',
        outcome: 'success',
        detail: 'reply_sent',
        user_agent: UA,
      });
      expectBrowserOnly(auditArg());
    });

    it('ARC-ADMIN-003 メールが送れなくても保存は残り、監査は error と reply_saved_mail_failed で書く', async () => {
      process.env.MAIL_FROM_ADDRESS = 'shop@example.com';
      sendMail.mockRejectedValue(new Error('smtp down'));
      setService(
        serviceWith({ data: { id: 'c1', email: 'buyer@example.com', subject: 'Re: Size' }, error: null }),
      );

      const res = await contactReplyRoute().POST(
        req('POST', `${baseUrl}/c1/reply`, { body: 'お返事です' }),
        ctx('c1'),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ success: true, mailSent: false });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: Size' }));
      expect(auditArg()).toMatchObject({
        action: 'admin.contact.reply',
        outcome: 'error',
        detail: 'reply_saved_mail_failed',
        user_agent: UA,
      });
      expect(auditArg()).not.toHaveProperty('actor_email');
    });

    it('ARC-ADMIN-003 送り手の設定が無ければメールを送らず、成功として書く', async () => {
      setService(
        serviceWith({ data: { id: 'c1', email: 'buyer@example.com', subject: 'Size' }, error: null }),
      );

      const res = await contactReplyRoute().POST(
        req('POST', `${baseUrl}/c1/reply`, { body: 'お返事です' }),
        ctx('c1'),
      );

      expect(res.status).toBe(201);
      expect(sendMail).not.toHaveBeenCalled();
      expect(auditArg()).toMatchObject({ outcome: 'success', detail: 'reply_sent' });
    });

    it('ARC-ADMIN-003 返信が形の誤り・問い合わせなし・保存の誤りなら何も書かない', async () => {
      setService(serviceWith({ data: null, error: { message: 'none' } }));

      const invalid = await contactReplyRoute().POST(req('POST', `${baseUrl}/c1/reply`, { body: '   ' }), ctx('c1'));
      const missing = await contactReplyRoute().POST(req('POST', `${baseUrl}/c1/reply`, { body: 'ok' }), ctx('c1'));

      expect([invalid.status, missing.status]).toEqual([400, 404]);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-003 テンプレートの作成は作った id を resource_id に入れ、ブラウザだけを入れる', async () => {
      setService(serviceWith({ data: { id: 't9' }, error: null }));

      const res = await templatesRoute().POST(
        req('POST', `${baseUrl}/templates`, { title: '配送の遅れ', body: 'お待たせしています' }),
      );

      expect(res.status).toBe(201);
      expect(auditArg()).toEqual({
        action: 'admin.contact.template.create',
        actor_id: ACTOR_ID,
        resource: 'contact_reply_template',
        resource_id: 't9',
        outcome: 'success',
        detail: 'created',
        user_agent: UA,
      });
      expectBrowserOnly(auditArg());
    });

    it('ARC-ADMIN-003 テンプレートの更新と削除は、それぞれ updated と deleted で書く', async () => {
      setService(serviceWith({ error: null }));

      const updated = await templateItemRoute().PUT(
        req('PUT', `${baseUrl}/templates/t1`, { title: '配送の遅れ', body: 'お待たせしています' }),
        ctx('t1'),
      );
      const deleted = await templateItemRoute().DELETE(req('DELETE', `${baseUrl}/templates/t1`), ctx('t1'));

      expect([updated.status, deleted.status]).toEqual([200, 200]);
      expect(logAudit).toHaveBeenCalledTimes(2);
      expect(auditArg(0)).toEqual({
        action: 'admin.contact.template.update',
        actor_id: ACTOR_ID,
        resource: 'contact_reply_template',
        resource_id: 't1',
        outcome: 'success',
        detail: 'updated',
        user_agent: UA,
      });
      expect(auditArg(1)).toEqual({
        action: 'admin.contact.template.delete',
        actor_id: ACTOR_ID,
        resource: 'contact_reply_template',
        resource_id: 't1',
        outcome: 'success',
        detail: 'deleted',
        user_agent: UA,
      });
    });

    it('ARC-ADMIN-003 テンプレートが形の誤り・DB の誤りなら何も書かない', async () => {
      setService(serviceWith({ data: null, error: { message: 'db' } }));

      const results = [
        await templatesRoute().POST(req('POST', `${baseUrl}/templates`, { title: '' })),
        await templatesRoute().POST(req('POST', `${baseUrl}/templates`, { title: 't', body: 'b' })),
        await templateItemRoute().PUT(req('PUT', `${baseUrl}/templates/t1`, { title: '' }), ctx('t1')),
        await templateItemRoute().PUT(req('PUT', `${baseUrl}/templates/t1`, { title: 't', body: 'b' }), ctx('t1')),
        await templateItemRoute().DELETE(req('DELETE', `${baseUrl}/templates/t1`), ctx('t1')),
      ];

      expect(results.map((r) => r.status)).toEqual([400, 500, 400, 500, 500]);
      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  describe('書かない窓口', () => {
    it('ARC-ADMIN-003 問い合わせの読み・テンプレートの一覧・色見本・監査ログの読み出しは監査に書かない', async () => {
      setService(serviceWith({ data: [], error: null, count: 0 }));
      const color = { name: 'Ecru', hex: '#f0ead6' };

      const results = [
        await contactRoute().GET(req('GET', 'http://localhost/api/admin/contact')),
        await contactItemRoute().GET(req('GET', 'http://localhost/api/admin/contact/c1'), ctx('c1')),
        await templatesRoute().GET(req('GET', 'http://localhost/api/admin/contact/templates')),
        await presetsRoute().GET(req('GET', 'http://localhost/api/admin/item-color-presets')),
        await presetsRoute().POST(req('POST', 'http://localhost/api/admin/item-color-presets', color)),
        await presetItemRoute().DELETE(req('DELETE', 'http://localhost/api/admin/item-color-presets/p1'), ctx('p1')),
        await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs')),
      ];

      expect(results.length).toBe(7);
      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  describe('共有の部品 logAudit', () => {
    function insertClient(result: { error: unknown } = { error: null }) {
      const insert = jest.fn().mockResolvedValue(result);
      const from = jest.fn(() => ({ insert }));
      setService({ from });
      return { insert, from };
    }

    it('ARC-ADMIN-003 audit_logs に 1 行を入れ、metadata が無ければ null、created_at が無ければ今の時刻を入れる', async () => {
      const { insert, from } = insertClient();

      await actualAudit.logAudit({ action: 'a', actor_id: ACTOR_ID, outcome: 'success', resource: 'users' });

      expect(from).toHaveBeenCalledWith('audit_logs');
      const rows = insert.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'a',
        actor_id: ACTOR_ID,
        resource: 'users',
        outcome: 'success',
        metadata: null,
      });
      expect(Number.isNaN(Date.parse(rows[0].created_at))).toBe(false);
    });

    it('ARC-ADMIN-003 created_at を渡せばその値を入れる', async () => {
      const { insert } = insertClient();

      await actualAudit.logAudit({ action: 'a', outcome: 'success', created_at: '2026-01-02T03:04:05.000Z' });

      expect(insert.mock.calls[0][0][0].created_at).toBe('2026-01-02T03:04:05.000Z');
    });

    it.each(['password', 'new_password', 'pass', 'pwd', 'access_token', 'client_secret', 'ssn', 'card_last', 'cvv', 'credit_card', 'pan', 'phone_number'])(
      'ARC-ADMIN-003 metadata の鍵 %s の値は [REDACTED] に伏せる',
      async (key) => {
        const { insert } = insertClient();

        await actualAudit.logAudit({ action: 'a', outcome: 'success', metadata: { [key]: 'plain', keep: 'visible' } });

        expect(insert.mock.calls[0][0][0].metadata).toEqual({ [key]: '[REDACTED]', keep: 'visible' });
      },
    );

    it('ARC-ADMIN-003 理由の文・対象のメールの鍵は伏せない', async () => {
      const { insert } = insertClient();
      const metadata = { reason: 'lost the device twice', target_email: 'staff@example.com', target_role: 'admin' };

      await actualAudit.logAudit({ action: 'a', outcome: 'success', metadata });

      expect(insert.mock.calls[0][0][0].metadata).toEqual(metadata);
    });

    it('ARC-ADMIN-003 detail の JWT・32 字以上の長い文字列・password= の形を伏せる', async () => {
      const { insert } = insertClient();
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
      const longToken = 'A'.repeat(40);

      await actualAudit.logAudit({
        action: 'a',
        outcome: 'error',
        detail: `jwt ${jwt} token ${longToken} password=hunter2 pwd: abc`,
      });

      const detail = insert.mock.calls[0][0][0].detail as string;
      expect(detail).toContain('[REDACTED_JWT]');
      expect(detail).toContain('[REDACTED_TOKEN]');
      expect(detail).toContain('password=[REDACTED]');
      expect(detail).toContain('pwd=[REDACTED]');
      expect(detail).not.toContain('hunter2');
      expect(detail).not.toContain(longToken);
      expect(detail).not.toContain(jwt);
    });

    it('ARC-ADMIN-003 短い誤りの文は detail にそのまま残す', async () => {
      const { insert } = insertClient();

      await actualAudit.logAudit({ action: 'a', outcome: 'conflict', detail: 'User already registered' });

      expect(insert.mock.calls[0][0][0].detail).toBe('User already registered');
    });

    it('ARC-ADMIN-003 伏せる時に呼び出し側の event は書き換えない', async () => {
      insertClient();
      const event = { action: 'a', outcome: 'success', metadata: { password: 'plain' }, detail: 'password=x' };

      await actualAudit.logAudit(event);

      expect(event).toEqual({ action: 'a', outcome: 'success', metadata: { password: 'plain' }, detail: 'password=x' });
    });

    it('ARC-ADMIN-003 insert が誤りを返しても例外にせず、event の中身を出さずに警告する', async () => {
      insertClient({ error: { message: 'row-level security' } });

      await expect(
        actualAudit.logAudit({ action: 'a', outcome: 'success', actor_email: 'secret@example.com' }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith('Failed to write audit log');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('secret@example.com');
    });

    it('ARC-ADMIN-003 client が作れなくても例外にせず警告する', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no env'));

      await expect(actualAudit.logAudit({ action: 'a', outcome: 'success' })).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith('Failed to write audit log');
    });

    describe('警報の送り先', () => {
      const originalFetch = (global as { fetch?: unknown }).fetch;
      let fetchMock: jest.Mock;

      beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue({ ok: true });
        (global as { fetch?: unknown }).fetch = fetchMock;
      });

      afterEach(() => {
        (global as { fetch?: unknown }).fetch = originalFetch;
      });

      it('ARC-ADMIN-003 送り先の設定が無ければ呼ばない', async () => {
        insertClient();

        await actualAudit.logAudit({ action: 'a', outcome: 'success' });

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('ARC-ADMIN-003 送り先があれば伏せた後の記録を POST し、秘密があれば x-alert-secret を付ける', async () => {
        process.env.ALERT_AUDIT_URL = 'https://alerts.example.com/audit';
        process.env.ALERT_AUDIT_SECRET = 's3cret';
        insertClient();

        await actualAudit.logAudit({ action: 'a', outcome: 'failure', metadata: { token: 'raw' } });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://alerts.example.com/audit');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'x-alert-secret': 's3cret' });
        expect(JSON.parse(init.body).record.metadata).toEqual({ token: '[REDACTED]' });
      });

      it('ARC-ADMIN-003 秘密が無ければ x-alert-secret を付けない', async () => {
        process.env.ALERT_AUDIT_URL = 'https://alerts.example.com/audit';
        insertClient();

        await actualAudit.logAudit({ action: 'a', outcome: 'success' });

        expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
      });

      it('ARC-ADMIN-003 送り先が落ちても例外にせず、記録は先に入っている', async () => {
        process.env.ALERT_AUDIT_URL = 'https://alerts.example.com/audit';
        fetchMock.mockRejectedValue(new Error('unreachable'));
        const { insert } = insertClient();

        await expect(actualAudit.logAudit({ action: 'a', outcome: 'success' })).resolves.toBeUndefined();

        expect(insert).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('Failed to call audit alert webhook');
      });
    });

    it('ARC-ADMIN-003 default の export も同じ部品を指す', () => {
      expect(actualAudit.default).toBe(actualAudit.logAudit);
    });
  });

  describe('窓口から共有の部品を通した行', () => {
    function auditInsertClient(extra: Record<string, unknown> = {}) {
      const insert = jest.fn().mockResolvedValue({ error: null });
      const chain = chainResult({ error: null, data: null });
      const from = jest.fn((table: string) => (table === 'audit_logs' ? { insert } : chain));
      setService({ from, rpc: jest.fn(() => chain), auth: { admin: extra } });
      return { insert };
    }

    it('ARC-ADMIN-003 強制失効の認可の失敗は、操作した人が空の行と IP・ブラウザ付きで audit_logs に入る', async () => {
      logAudit.mockImplementation(actualAudit.logAudit);
      denyAdmin();
      const { insert } = auditInsertClient();

      await revokeRoute().POST(req('POST', 'http://localhost/api/admin/revoke-user-sessions', { user_id: TARGET_ID }));

      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert.mock.calls[0][0][0]).toMatchObject({
        action: 'admin_revoke_user_sessions',
        actor_id: null,
        actor_email: null,
        outcome: 'unauthorized',
        ip: '203.0.113.7',
        user_agent: UA,
      });
    });

    it('ARC-ADMIN-003 2要素のリセットの成功は、メール・IP・ブラウザ・理由の文付きで audit_logs に入る', async () => {
      logAudit.mockImplementation(actualAudit.logAudit);
      const { insert } = auditInsertClient({
        getUserById: jest.fn().mockResolvedValue({
          data: { user: { id: TARGET_ID, email: 'staff@example.com', app_metadata: { role: 'admin' } } },
          error: null,
        }),
        mfa: {
          listFactors: jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }] }, error: null }),
          deleteFactor: jest.fn().mockResolvedValue({ error: null }),
        },
      });

      const res = await mfaResetRoute().POST(
        req('POST', 'http://localhost/api/admin/users/mfa/reset', {
          userId: TARGET_ID,
          reason: 'lost the device twice',
          confirm: 'RESET_MFA',
        }),
      );

      expect(res.status).toBe(200);
      const rows = insert.mock.calls.map((call: any[]) => call[0][0]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'admin.users.mfa.reset',
        actor_id: ACTOR_ID,
        actor_email: ACTOR_EMAIL,
        outcome: 'success',
        ip: '203.0.113.7',
        user_agent: UA,
        metadata: {
          reason: 'lost the device twice',
          target_email: 'staff@example.com',
          deleted_factor_count: 1,
        },
      });
    });
  });
});

describe('ARC-ADMIN-003 監査ログの読み出し', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    allowAdmin();
    setService(serviceWith({}));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function readClient(result: { data: unknown; error: unknown }) {
    const limit = jest.fn().mockResolvedValue(result);
    const order = jest.fn(() => ({ limit }));
    const select: jest.Mock = jest.fn((..._args: unknown[]) => ({ order }));
    const from = jest.fn(() => ({ select }));
    setService({ from });
    return { from, select, order, limit };
  }

  it('ARC-ADMIN-003 列を名指しした 8 列だけを、新しい順に 100 件読んで返す', async () => {
    const rows = [{ id: '1', action: 'admin_create_user' }];
    const { from, select, order, limit } = readClient({ data: rows, error: null });

    const res = await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: rows });
    expect(from).toHaveBeenCalledWith('audit_logs');
    expect(select).toHaveBeenCalledWith('id,created_at,action,actor_id,resource,resource_id,outcome,detail');
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it.each(['actor_email', 'ip', 'user_agent', 'metadata', '*'])(
    'ARC-ADMIN-003 選ぶ列に %s を含めない',
    async (column) => {
      const { select } = readClient({ data: [], error: null });

      await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

      const columns = String(select.mock.calls[0][0]).split(',');
      expect(columns).not.toContain(column);
    },
  );

  it('ARC-ADMIN-003 admin.audit.read を持たない人には読まず、認可の応答を返す', async () => {
    aclCodes = ['admin.users.read', 'admin.contact.read'];
    const { from } = readClient({ data: [{ id: '1' }], error: null });

    const res = await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.audit.read' });
    expect(from).not.toHaveBeenCalled();
  });

  it('ARC-ADMIN-003 admin.audit.read だけを持つ人は読める', async () => {
    aclCodes = ['admin.audit.read'];
    readClient({ data: [{ id: '1' }], error: null });

    const res = await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(200);
  });

  it('ARC-ADMIN-003 読めなければ 500 を返し、誤りの文を出さない', async () => {
    readClient({ data: null, error: { message: 'relation audit_logs is locked' } });

    const res = await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch audit logs' });
  });

  it('ARC-ADMIN-003 読む途中の例外は 500 Internal server error になる', async () => {
    failServiceAfterAuthorization(new Error('no env'));

    const res = await auditLogsRoute().GET(req('GET', 'http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
