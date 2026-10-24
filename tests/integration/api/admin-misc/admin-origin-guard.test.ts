import { NextRequest } from 'next/server';

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
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));

// 前の describe が jest.resetModules() を呼ぶので、モックは使う直前に取り直す（let に入れる）
let createServiceRoleClient: jest.Mock;
let authorizeAdminPermission: jest.Mock;
let requireCsrfOrDeny: jest.Mock;
let enforceRateLimit: jest.Mock;

const ALLOWED = 'https://shop.example.com';
const EVIL = 'https://evil.example';
const ORIGIN_ENV_KEYS = [
  'APP_ALLOWED_ORIGINS',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_BASE_URL',
  'BASE_URL',
  'NEXT_PUBLIC_VERCEL_URL',
] as const;

const TARGET_ID = '22222222-2222-4222-8222-222222222222';

/** 範囲の書き込みの窓口。proxy の照合の対象になる全部。 */
const WRITE_ROUTES: Array<{
  label: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  load: () => Record<string, (...args: any[]) => Promise<Response>>;
  body?: unknown;
  params?: { id: string };
}> = [
  {
    label: '利用者の作成',
    method: 'POST',
    path: '/api/admin/create-user',
    load: () => require('@/app/api/admin/create-user/route'),
    body: { email: 'new@example.com', password: 'password123' },
  },
  {
    label: '強制失効',
    method: 'POST',
    path: '/api/admin/revoke-user-sessions',
    load: () => require('@/app/api/admin/revoke-user-sessions/route'),
    body: { user_id: TARGET_ID },
  },
  {
    label: '2要素のリセット',
    method: 'POST',
    path: '/api/admin/users/mfa/reset',
    load: () => require('@/app/api/admin/users/mfa/reset/route'),
    body: { userId: TARGET_ID, reason: 'lost the device twice', confirm: 'RESET_MFA' },
  },
  {
    label: '問い合わせの状態の変更',
    method: 'PATCH',
    path: '/api/admin/contact/c1',
    load: () => require('@/app/api/admin/contact/[id]/route'),
    body: { status: 'closed' },
    params: { id: 'c1' },
  },
  {
    label: '問い合わせへの返信',
    method: 'POST',
    path: '/api/admin/contact/c1/reply',
    load: () => require('@/app/api/admin/contact/[id]/reply/route'),
    body: { body: 'ご連絡ありがとうございます' },
    params: { id: 'c1' },
  },
  {
    label: 'テンプレートの作成',
    method: 'POST',
    path: '/api/admin/contact/templates',
    load: () => require('@/app/api/admin/contact/templates/route'),
    body: { title: '配送の遅れ', body: 'お待たせしています' },
  },
  {
    label: 'テンプレートの更新',
    method: 'PUT',
    path: '/api/admin/contact/templates/t1',
    load: () => require('@/app/api/admin/contact/templates/[id]/route'),
    body: { title: '配送の遅れ', body: 'お待たせしています' },
    params: { id: 't1' },
  },
  {
    label: 'テンプレートの削除',
    method: 'DELETE',
    path: '/api/admin/contact/templates/t1',
    load: () => require('@/app/api/admin/contact/templates/[id]/route'),
    params: { id: 't1' },
  },
  {
    label: '色見本の保存',
    method: 'POST',
    path: '/api/admin/item-color-presets',
    load: () => require('@/app/api/admin/item-color-presets/route'),
    body: { name: 'Ecru', hex: '#f0ead6' },
  },
  {
    label: '色見本の削除',
    method: 'DELETE',
    path: '/api/admin/item-color-presets/p1',
    load: () => require('@/app/api/admin/item-color-presets/[id]/route'),
    params: { id: 'p1' },
  },
];

const CASES = WRITE_ROUTES.map((route) => [route.label, route.method, route.path, route] as const);

function makeRequest(path: string, method: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${ALLOWED}${path}`, { method, headers });
}

async function loadProxy() {
  const mod = await import('@/proxy');
  return mod.proxy;
}

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

describe('ARC-ADMIN-002 書き込みの窓口の Origin の照合', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  describe('許可のオリジンが設定されている時', () => {
    beforeEach(() => {
      for (const key of ORIGIN_ENV_KEYS) delete process.env[key];
      process.env.APP_ALLOWED_ORIGINS = ALLOWED;
      jest.resetModules();
    });

    it.each(CASES)(
      'ARC-ADMIN-002 %s（%s %s）を別のオリジンから送ると 403 Forbidden origin を返す',
      async (_label, method, path) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest(path, method, { origin: EVIL }));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden origin' });
        // 注文の状況の窓口だけに足す見出しは管理のそのほかの拒否には付かない
        expect(res.headers.get('Cache-Control')).toBeNull();
        expect(res.headers.get('Referrer-Policy')).toBeNull();
      },
    );

    it.each(CASES)(
      'ARC-ADMIN-002 %s（%s %s）を許可のオリジンから送ると通し、安全の見出しを足す',
      async (_label, method, path) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest(path, method, { origin: ALLOWED }));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Security-Policy')).toMatch(/script-src [^;]*'nonce-[0-9a-f]{24}'/);
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      },
    );

    it.each(CASES)(
      'ARC-ADMIN-002 %s（%s %s）は Origin も Referer も無ければ 403 を返す',
      async (_label, method, path) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest(path, method));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden origin' });
      },
    );

    it('ARC-ADMIN-002 Origin が無ければ Referer の origin で照合し、許可のオリジンなら通す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { referer: `${ALLOWED}/admin/create-user?x=1` }));

      expect(res.status).toBe(200);
    });

    it('ARC-ADMIN-002 Origin が無く Referer が別のオリジンなら 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { referer: `${EVIL}/page` }));

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 Origin が無く Referer が URL として読めなければ 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { referer: 'not a url' }));

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 Origin があれば Referer を見ず、Origin が別のオリジンなら 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('/api/admin/contact/c1/reply', 'POST', { origin: EVIL, referer: `${ALLOWED}/admin` }),
      );

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 Origin が URL として読めなければ 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/revoke-user-sessions', 'POST', { origin: 'null' }));

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 許可のオリジンと別のポート・別のスキームは通さない', async () => {
      const proxy = await loadProxy();

      for (const origin of ['https://shop.example.com:8443', 'http://shop.example.com']) {
        const res = proxy(makeRequest('/api/admin/item-color-presets', 'POST', { origin }));

        expect(res.status).toBe(403);
      }
    });

    it.each([
      ['/api/admin/audit-logs'],
      ['/api/admin/contact'],
      ['/api/admin/contact/c1'],
      ['/api/admin/contact/templates'],
      ['/api/admin/item-color-presets'],
    ])('ARC-ADMIN-002 読みの GET %s は Origin の照合にかけない', async (path) => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest(path, 'GET', { origin: EVIL }));

      expect(res.status).toBe(200);
    });

    it('ARC-ADMIN-002 /api の外の POST は照合にかけない', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/admin/create-user', 'POST', { origin: EVIL }));

      expect(res.status).toBe(200);
    });

    it('ARC-ADMIN-002 照合から外すのは外部の配達の知らせなどの窓口だけで、管理の窓口は外さない', async () => {
      const proxy = await loadProxy();

      const exempt = proxy(makeRequest('/api/contact/inbound', 'POST', { origin: EVIL }));
      const lookalike = proxy(makeRequest('/api/admin/contact/inbound', 'POST', { origin: EVIL }));

      expect(exempt.status).toBe(200);
      expect(lookalike.status).toBe(403);
    });
  });

  describe('許可のオリジンが設定されていない時', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      for (const key of ORIGIN_ENV_KEYS) delete process.env[key];
      jest.resetModules();
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('ARC-ADMIN-002 要求の Host から比べる元を作り、同じオリジンなら通す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { origin: ALLOWED, host: 'shop.example.com' }));

      expect(res.status).toBe(200);
    });

    it('ARC-ADMIN-002 x-forwarded-host と x-forwarded-proto があればそれから比べる元を作る', async () => {
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('/api/admin/create-user', 'POST', {
          origin: 'https://forwarded.example',
          'x-forwarded-host': 'forwarded.example',
          'x-forwarded-proto': 'https',
        }),
      );

      expect(res.status).toBe(200);
    });

    it('ARC-ADMIN-002 要求の Host と違うオリジンなら 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { origin: EVIL, host: 'shop.example.com' }));

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 Origin も Referer も無ければ設定が無くても 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { host: 'shop.example.com' }));

      expect(res.status).toBe(403);
    });

    it('ARC-ADMIN-002 警告はプロセスにつき 1 度だけ出す', async () => {
      const proxy = await loadProxy();

      proxy(makeRequest('/api/admin/create-user', 'POST', { origin: ALLOWED, host: 'shop.example.com' }));
      proxy(makeRequest('/api/admin/revoke-user-sessions', 'POST', { origin: EVIL, host: 'shop.example.com' }));
      proxy(makeRequest('/api/admin/contact/c1', 'PATCH', { origin: ALLOWED, host: 'shop.example.com' }));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('[proxy]');
    });

    it('ARC-ADMIN-002 比べる元が URL として読めなければ 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/create-user', 'POST', { origin: 'null', host: 'shop.example.com' }));

      expect(res.status).toBe(403);
    });
  });
});

describe('ARC-ADMIN-002 窓口は CSRF の印と回数を見ない', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    createServiceRoleClient = require('@/lib/supabase/server').createServiceRoleClient;
    authorizeAdminPermission = require('@/lib/auth/admin-rbac').authorizeAdminPermission;
    requireCsrfOrDeny = require('@/lib/csrfMiddleware').requireCsrfOrDeny;
    enforceRateLimit = require('@/features/auth/middleware/rateLimit').enforceRateLimit;
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    authorizeAdminPermission.mockResolvedValue({
      ok: true,
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin',
      actorEmail: 'owner@example.com',
    });
    createServiceRoleClient.mockResolvedValue(stubServiceClient());
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it.each(CASES)(
    'ARC-ADMIN-002 %s（%s %s）は x-csrf-token が無くても拒まず、CSRF の確かめと回数の制限を呼ばない',
    async (_label, method, path, route) => {
      const request = new Request(`${ALLOWED}${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: ALLOWED },
        ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
      });
      const handler = route.load()[method];

      const res = await (route.params ? handler(request, { params: Promise.resolve(route.params) }) : handler(request));

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(429);
      expect(authorizeAdminPermission).toHaveBeenCalledTimes(1);
      expect(requireCsrfOrDeny).not.toHaveBeenCalled();
      expect(enforceRateLimit).not.toHaveBeenCalled();
    },
  );

  it('ARC-ADMIN-002 同じ要求を何度送っても回数で断られない', async () => {
    const route = WRITE_ROUTES[0];
    const handler = route.load()[route.method];

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await handler(
        new Request(`${ALLOWED}${route.path}`, {
          method: route.method,
          headers: { 'content-type': 'application/json', origin: ALLOWED },
          body: JSON.stringify(route.body),
        }),
      );
      statuses.push(res.status);
    }

    expect(statuses).not.toContain(429);
    expect(authorizeAdminPermission).toHaveBeenCalledTimes(25);
  });
});
