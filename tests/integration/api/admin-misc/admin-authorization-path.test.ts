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
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));
jest.mock('@/lib/auth/admin-rbac', () => {
  const actual = jest.requireActual('@/lib/auth/admin-rbac');
  return { ...actual, authorizeAdminPermission: jest.fn() };
});
// 回数の制限と、認可失敗の監査の上限の数え方は DB に触るので差し替える（呼ばれ方は窓口ごとの単体・結合試験で確かめる）。
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
// 漏洩したパスワードの照合は外部の API を呼ぶので差し替える（利用者の作成だけが使う）
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'pwned-message',
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { checkPwnedPassword } = require('@/lib/pwned-password');
const rbac = require('@/lib/auth/admin-rbac');
const authorize: jest.Mock = rbac.authorizeAdminPermission;
const actualRbac = jest.requireActual('@/lib/auth/admin-rbac');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
// 問い合わせとテンプレートの id は UUID の形でないと 404 で止まり、service role まで進まないので UUID にする
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';
const JSON_HEADERS = { 'content-type': 'application/json' };

type RouteCase = {
  label: string;
  load: () => Record<string, (...args: any[]) => Promise<Response>>;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  permission: string;
  body?: unknown;
  params?: { id: string };
};

const ROUTES: RouteCase[] = [
  {
    label: '利用者の作成',
    load: () => require('@/app/api/admin/create-user/route'),
    method: 'POST',
    url: 'http://localhost/api/admin/create-user',
    permission: 'admin.users.manage',
    body: { email: 'new@example.com', password: 'password-1234-ok' },
  },
  {
    label: '強制失効',
    load: () => require('@/app/api/admin/revoke-user-sessions/route'),
    method: 'POST',
    url: 'http://localhost/api/admin/revoke-user-sessions',
    permission: 'admin.users.manage',
    body: { user_id: TARGET_ID },
  },
  {
    label: '2要素のリセット',
    load: () => require('@/app/api/admin/users/mfa/reset/route'),
    method: 'POST',
    url: 'http://localhost/api/admin/users/mfa/reset',
    permission: 'admin.users.manage',
    body: { userId: TARGET_ID, reason: 'lost the device twice', confirm: 'RESET_MFA' },
  },
  {
    label: '監査ログの読み出し',
    load: () => require('@/app/api/admin/audit-logs/route'),
    method: 'GET',
    url: 'http://localhost/api/admin/audit-logs',
    permission: 'admin.audit.read',
  },
  {
    label: '問い合わせの一覧',
    load: () => require('@/app/api/admin/contact/route'),
    method: 'GET',
    url: 'http://localhost/api/admin/contact',
    permission: 'admin.contact.read',
  },
  {
    label: '問い合わせ1件の取得',
    load: () => require('@/app/api/admin/contact/[id]/route'),
    method: 'GET',
    url: `http://localhost/api/admin/contact/${CONTACT_ID}`,
    permission: 'admin.contact.read',
    params: { id: CONTACT_ID },
  },
  {
    label: '問い合わせの状態の変更',
    load: () => require('@/app/api/admin/contact/[id]/route'),
    method: 'PATCH',
    url: `http://localhost/api/admin/contact/${CONTACT_ID}`,
    permission: 'admin.contact.manage',
    body: { status: 'closed' },
    params: { id: CONTACT_ID },
  },
  {
    label: '問い合わせへの返信',
    load: () => require('@/app/api/admin/contact/[id]/reply/route'),
    method: 'POST',
    url: `http://localhost/api/admin/contact/${CONTACT_ID}/reply`,
    permission: 'admin.contact.manage',
    body: { body: 'ご連絡ありがとうございます' },
    params: { id: CONTACT_ID },
  },
  {
    label: 'テンプレートの一覧',
    load: () => require('@/app/api/admin/contact/templates/route'),
    method: 'GET',
    url: 'http://localhost/api/admin/contact/templates',
    permission: 'admin.contact.read',
  },
  {
    label: 'テンプレートの作成',
    load: () => require('@/app/api/admin/contact/templates/route'),
    method: 'POST',
    url: 'http://localhost/api/admin/contact/templates',
    permission: 'admin.contact.manage',
    body: { title: '配送の遅れ', body: 'お待たせしています' },
  },
  {
    label: 'テンプレートの更新',
    load: () => require('@/app/api/admin/contact/templates/[id]/route'),
    method: 'PUT',
    url: `http://localhost/api/admin/contact/templates/${TEMPLATE_ID}`,
    permission: 'admin.contact.manage',
    body: { title: '配送の遅れ', body: 'お待たせしています' },
    params: { id: TEMPLATE_ID },
  },
  {
    label: 'テンプレートの削除',
    load: () => require('@/app/api/admin/contact/templates/[id]/route'),
    method: 'DELETE',
    url: `http://localhost/api/admin/contact/templates/${TEMPLATE_ID}`,
    permission: 'admin.contact.manage',
    params: { id: TEMPLATE_ID },
  },
  {
    label: '色見本の一覧',
    load: () => require('@/app/api/admin/item-color-presets/route'),
    method: 'GET',
    url: 'http://localhost/api/admin/item-color-presets',
    permission: 'admin.items.read',
  },
  {
    label: '色見本の保存',
    load: () => require('@/app/api/admin/item-color-presets/route'),
    method: 'POST',
    url: 'http://localhost/api/admin/item-color-presets',
    permission: 'admin.items.manage',
    body: { name: 'Ecru', hex: '#f0ead6' },
  },
  {
    label: '色見本の削除',
    load: () => require('@/app/api/admin/item-color-presets/[id]/route'),
    method: 'DELETE',
    url: 'http://localhost/api/admin/item-color-presets/1',
    permission: 'admin.items.manage',
    params: { id: '1' },
  },
];

function invoke(route: RouteCase) {
  const request = new Request(route.url, {
    method: route.method,
    headers: JSON_HEADERS,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
  const handler = route.load()[route.method];
  const args = route.params ? [request, { params: Promise.resolve(route.params) }] : [request];
  return { request, result: handler(...args) };
}

/** どのメソッドを呼んでも結果を返せる、中身の無い service role の client。 */
function stubServiceClient() {
  const result = { data: null, error: { message: 'stub' }, count: 0 };
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
  return {
    from: jest.fn(() => chain),
    rpc: jest.fn(() => chain),
    auth: {
      admin: {
        createUser: jest.fn(async () => ({ data: null, error: { message: 'stub' } })),
        getUserById: jest.fn(async () => ({ data: { user: null }, error: { message: 'stub' } })),
        mfa: { listFactors: jest.fn(), deleteFactor: jest.fn() },
      },
    },
  };
}

function aclClient(rows: unknown, error: unknown = null) {
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve({ data: rows, error });
        }
        return () => chain;
      },
    },
  );
  const client = stubServiceClient();
  client.from = jest.fn(() => chain);
  return client;
}

function aclRows(...codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER_ID,
    session_id: 'sess-1',
    aal: 'aal2',
    email: 'owner@example.com',
    app_metadata: { role: 'admin' },
    ...overrides,
  };
}

describe('ARC-ADMIN-001 管理のそのほかの窓口の認可の道', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    checkPwnedPassword.mockResolvedValue({ status: 'ok' });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('窓口の頭', () => {
    it.each(ROUTES.map((route) => [route.label, route] as const))(
      'ARC-ADMIN-001 %s は断られたら認可の応答をそのまま返し、service role を作らない',
      async (_label, route) => {
        const denied = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
        authorize.mockResolvedValue({ ok: false, response: denied });
        createServiceRoleClient.mockResolvedValue(stubServiceClient());

        const { result } = invoke(route);

        await expect(result).resolves.toBe(denied);
        expect(createServiceRoleClient).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTES.map((route) => [route.label, route.permission, route] as const))(
      'ARC-ADMIN-001 %s は権限の印 %s と要求を認可に渡す',
      async (_label, permission, route) => {
        authorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });

        const { request, result } = invoke(route);
        await result;

        expect(authorize).toHaveBeenCalledTimes(1);
        expect(authorize).toHaveBeenCalledWith(permission, request);
      },
    );

    it.each(ROUTES.map((route) => [route.label, route] as const))(
      'ARC-ADMIN-001 %s は通った後にだけ service role を作る',
      async (_label, route) => {
        authorize.mockResolvedValue({
          ok: true,
          userId: USER_ID,
          role: 'admin',
          actorEmail: 'owner@example.com',
        });
        createServiceRoleClient.mockResolvedValue(stubServiceClient());

        const { result } = invoke(route);
        await result;

        expect(createServiceRoleClient).toHaveBeenCalled();
        expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
          createServiceRoleClient.mock.invocationCallOrder[0],
        );
      },
    );

    it('ARC-ADMIN-001 認可が例外を投げたら 500 Internal server error を返し、service role を作らない', async () => {
      authorize.mockRejectedValue(new Error('boom'));

      const route = ROUTES[0];
      const { result } = invoke(route);
      const res = await result;

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-001 強制失効は本文の JSON が壊れていると 400 Invalid request になる', async () => {
      authorize.mockResolvedValue({
        ok: true,
        userId: USER_ID,
        role: 'admin',
        actorEmail: 'owner@example.com',
      });
      createServiceRoleClient.mockResolvedValue(stubServiceClient());
      const route = ROUTES[1];
      const request = new Request(route.url, { method: route.method, headers: JSON_HEADERS, body: '{broken' });

      const res = await route.load()[route.method](request);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid request' });
    });

    it.each([
      ['利用者の作成', ROUTES[0]],
      ['色見本の保存', ROUTES[13]],
    ] as const)(
      'ARC-ADMIN-001 %s は本文の JSON が壊れていると 500 でなく 400 Invalid request になる',
      async (_label, route) => {
        authorize.mockResolvedValue({
          ok: true,
          userId: USER_ID,
          role: 'admin',
          actorEmail: 'owner@example.com',
        });
        const request = new Request(route.url, { method: route.method, headers: JSON_HEADERS, body: '{broken' });

        const res = await route.load()[route.method](request);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: 'Invalid request' }));
      },
    );
  });

  describe('共有の認可 authorizeAdminPermission', () => {
    function useActualAuthorize() {
      authorize.mockImplementation(actualRbac.authorizeAdminPermission);
    }

    it('ARC-ADMIN-001 token が確かめられなければ 401 を返し、session も ACL も引かない', async () => {
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage', new Request('http://localhost/x'));

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
      expect(checkAuthSessionLiveness).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-001 session が失効していたら権限があっても 401 を返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('revoked');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.users.manage')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('ARC-ADMIN-001 session の生存を確かめられなければ 503 と Retry-After を返す（401 にしない）', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('unavailable');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.users.manage')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(503);
      expect(result.response.headers.get('Retry-After')).toBe('30');
      expect(await result.response.json()).toEqual({ error: 'Service temporarily unavailable' });
    });

    it('ARC-ADMIN-001 session の生存確認と ACL の照会は並べて引く', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');
      const client = aclClient(aclRows('admin.audit.read'));
      createServiceRoleClient.mockResolvedValue(client);

      await actualRbac.authorizeAdminPermission('admin.audit.read');

      expect(checkAuthSessionLiveness).toHaveBeenCalledWith('sess-1');
      expect(client.from).toHaveBeenCalledWith('user_roles');
    });

    it('ARC-ADMIN-001 権限が無ければ 403 に権限の印と token の役割を添える', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ app_metadata: { role: 'supporter' } }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.contact.read')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({
        error: 'Forbidden',
        permission: 'admin.users.manage',
        role: 'supporter',
      });
    });

    it('ARC-ADMIN-001 役割の印が app_metadata に無い・壊れていれば役割は user として 403 を返す', async () => {
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows()));

      for (const appMetadata of [undefined, { role: 'owner' }]) {
        verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ app_metadata: appMetadata }) });

        const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

        expect(result.response.status).toBe(403);
        expect((await result.response.json()).role).toBe('user');
      }
    });

    it('ARC-ADMIN-001 権限があっても aal2 でなければ 403 と理由 MFA required を返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ aal: 'aal1' }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.users.manage')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({
        error: 'Forbidden',
        reason: 'MFA required',
        permission: 'admin.users.manage',
        role: 'admin',
      });
    });

    it('ARC-ADMIN-001 権限があって aal2 なら利用者の id・役割・メールを返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.users.manage')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result).toEqual({
        ok: true,
        userId: USER_ID,
        role: 'admin',
        actorEmail: 'owner@example.com',
        permissions: new Set(['admin.users.manage']),
      });
    });

    it('ARC-ADMIN-001 token にメールが無ければ操作した人のメールは null になる', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ email: undefined }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(aclRows('admin.users.manage')));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(true);
      expect(result.actorEmail).toBeNull();
    });

    it('ARC-ADMIN-001 ACL の照会が誤りを返したら権限なしとして 403 を返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockResolvedValue(aclClient(null, { message: 'db down' }));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.response.status).toBe(403);
    });

    it('ARC-ADMIN-001 ACL の照会が空・形が壊れた行なら権限なしとして 403 を返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');

      const shapes: unknown[] = [
        null,
        [{ roles: null }],
        [{ roles: 'x' }],
        [{ roles: { role_permissions: 'x' } }],
        [{ roles: { role_permissions: [{ permissions: null }] } }],
        [{ roles: { role_permissions: [{ permissions: { code: 42 } }] } }],
      ];
      for (const rows of shapes) {
        createServiceRoleClient.mockResolvedValue(aclClient(rows));

        const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

        expect(result.response.status).toBe(403);
      }
    });

    it('ARC-ADMIN-001 ACL の照会が例外を投げても権限なしとして 403 を返す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');
      createServiceRoleClient.mockRejectedValue(new Error('no client'));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.response.status).toBe(403);
    });

    it('ARC-ADMIN-001 認可の途中で例外が出たら内部の文を出さず 500 を返す', async () => {
      verifyAccessToken.mockRejectedValue(new Error('jwks secret detail'));

      const result = await actualRbac.authorizeAdminPermission('admin.users.manage');

      expect(result.ok).toBe(false);
      expect(result.response.status).toBe(500);
      expect(await result.response.json()).toEqual({ error: 'Internal server error' });
    });

    it('ARC-ADMIN-001 窓口は 401 のとき利用者の作成に進まず、service role の管理の機能を呼ばない', async () => {
      useActualAuthorize();
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });
      const client = stubServiceClient();
      createServiceRoleClient.mockResolvedValue(client);

      const { result } = invoke(ROUTES[0]);
      const res = await result;

      expect(res.status).toBe(401);
      expect(client.auth.admin.createUser).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-001 窓口は権限の無い店員の要求を 403 で止め、Auth の管理の機能を呼ばない', async () => {
      useActualAuthorize();
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ app_metadata: { role: 'supporter' } }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      const client = aclClient(aclRows('admin.contact.read'));
      createServiceRoleClient.mockResolvedValue(client);

      const { result } = invoke(ROUTES[0]);
      const res = await result;

      expect(res.status).toBe(403);
      expect(client.auth.admin.createUser).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-001 窓口は aal1 の店長の要求を 403 MFA required で止める', async () => {
      useActualAuthorize();
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ aal: 'aal1' }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      const client = aclClient(aclRows('admin.users.manage'));
      createServiceRoleClient.mockResolvedValue(client);

      const { result } = invoke(ROUTES[1]);
      const res = await result;

      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe('MFA required');
      expect(client.rpc).not.toHaveBeenCalled();
    });

    it('ARC-ADMIN-001 窓口は通った店長の要求で service role の管理の機能を呼ぶ', async () => {
      useActualAuthorize();
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims() });
      checkAuthSessionLiveness.mockResolvedValue('active');
      const client = aclClient(aclRows('admin.users.manage'));
      client.auth.admin.createUser.mockResolvedValue({
        data: { user: { id: TARGET_ID, email: 'new@example.com' } },
        error: null,
      } as never);
      createServiceRoleClient.mockResolvedValue(client);

      const { result } = invoke(ROUTES[0]);
      const res = await result;

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: TARGET_ID, email: 'new@example.com' });
      expect(client.auth.admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@example.com' }),
      );
    });

    it('ARC-ADMIN-001 窓口の権限は固定で、色見本の読みだけの店員は保存を 403 で止められる', async () => {
      useActualAuthorize();
      verifyAccessToken.mockResolvedValue({ ok: true, claims: claims({ app_metadata: { role: 'supporter' } }) });
      checkAuthSessionLiveness.mockResolvedValue('active');
      const client = aclClient(aclRows('admin.items.read'));
      createServiceRoleClient.mockResolvedValue(client);

      const read = await invoke(ROUTES[12]).result;
      const write = await invoke(ROUTES[13]).result;

      expect(write.status).toBe(403);
      expect((await write.json()).permission).toBe('admin.items.manage');
      expect(read.status).not.toBe(403);
    });
  });
});
