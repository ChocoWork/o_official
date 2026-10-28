import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// session_id の Cookie は、決済の流れ（/cart・/checkout・/api/checkout）だけで配る。既定は配らない。
// 読み手は決済の流れだけ（checkout-route-guard・create-session・complete・supabase/server.ts の x-session-id）。
// ログインの成功で回す register.ts の発行は proxy の外の別の仕組みなので、ここでは対象にしない。

const ORIGIN = 'https://shop.example.com';
const SESSION_COOKIE = 'session_id';
const THIRTY_DAYS = 60 * 60 * 24 * 30;
const env = () => process.env as Record<string, string | undefined>;

describe('proxy の session_id の発行', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    env().APP_ALLOWED_ORIGINS = ORIGIN;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  async function loadProxy() {
    const mod = await import('@/proxy');
    return mod.proxy;
  }

  function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
    return new NextRequest(`${ORIGIN}${path}`, { method, headers });
  }

  const ISSUING: Array<[string, string]> = [
    ['GET', '/cart'],
    ['GET', '/cart/'],
    ['GET', '/checkout'],
    ['GET', '/checkout?session_id=cs_x'],
    ['POST', '/api/checkout/create-session'],
    ['POST', '/api/checkout/complete'],
  ];

  test.each(ISSUING)('DD-PRIVACY-004 %s %s は Cookie の無い要求に session_id を発行する', async (method, path) => {
    const proxy = await loadProxy();

    const res = proxy(request(path, { origin: ORIGIN }, method));

    expect(res.status).not.toBe(403);
    const cookie = res.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toMatch(/^[0-9a-f]{32}$/);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: THIRTY_DAYS });
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=${cookie?.value}`);
  });

  const NOT_ISSUING = [
    '/',
    '/about',
    '/privacy',
    '/terms',
    '/news',
    '/look/1',
    '/look/1/og',
    '/item/1',
    '/api/auth/login',
    '/api/search',
    '/cartx',
    '/checkoutx',
    '/api/checkoutx',
    '/apicheckout',
  ];

  test.each(NOT_ISSUING)('DD-PRIVACY-004 %s は session_id を発行しない（守りの見出しは付く）', async (path) => {
    const proxy = await loadProxy();

    const res = proxy(request(path));

    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  test.each(['/cart', '/checkout', '/', '/about', '/api/checkout/complete'])(
    'DD-PRIVACY-004 session_id が既にある要求は %s でも Set-Cookie を付けない',
    async (path) => {
      const proxy = await loadProxy();

      const res = proxy(request(path, { cookie: `${SESSION_COOKIE}=existing-session-id` }));

      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
      expect(res.headers.get('set-cookie')).toBeNull();
    },
  );

  test('DD-PRIVACY-004 ほかの Cookie だけがある /cart の要求には session_id を発行する', async () => {
    const proxy = await loadProxy();

    const res = proxy(request('/cart', { cookie: 'cart=abc; wishlist=def' }));

    expect(res.cookies.get(SESSION_COOKIE)?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  test('DD-PRIVACY-004 発行する id は要求ごとに違う', async () => {
    const proxy = await loadProxy();

    const first = proxy(request('/cart')).cookies.get(SESSION_COOKIE)?.value;
    const second = proxy(request('/cart')).cookies.get(SESSION_COOKIE)?.value;

    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  test('DD-PRIVACY-004 本番では Cookie に Secure を付け、本番以外では付けない', async () => {
    env().NODE_ENV = 'production';
    const production = (await loadProxy())(request('/cart'));
    expect(production.cookies.get(SESSION_COOKIE)?.secure).toBe(true);

    jest.resetModules();
    env().NODE_ENV = 'test';
    const nonProduction = (await loadProxy())(request('/cart'));
    expect(nonProduction.cookies.get(SESSION_COOKIE)?.secure).toBeFalsy();
  });
});
