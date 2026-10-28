import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// /api/auth 配下の応答には、route が自分で付けない窓口（login・otp/verify・refresh・mfa/*）でも
// proxy が Cache-Control: no-store を付ける。route が自前で付ける窓口は route の値が後から上書きする。

const ORIGIN = 'https://shop.example.com';
const env = () => process.env as Record<string, string | undefined>;

describe('proxy の /api/auth の no-store', () => {
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

  const AUTH_PATHS: Array<[string, string]> = [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/otp/verify'],
    ['POST', '/api/auth/refresh'],
    ['POST', '/api/auth/mfa/enroll-totp'],
    ['POST', '/api/auth/mfa/verify'],
    ['GET', '/api/auth/mfa/status'],
    ['GET', '/api/auth/me'],
  ];

  test.each(AUTH_PATHS)('DD-AUTH-037 %s %s の応答に Cache-Control: no-store が付く', async (method, path) => {
    const proxy = await loadProxy();

    const res = proxy(request(path, { origin: ORIGIN }, method));

    expect(res.status).not.toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('DD-AUTH-037 /api/auth への Origin が違う POST の 403 にも no-store が付く', async () => {
    const proxy = await loadProxy();

    const res = proxy(request('/api/auth/login', { origin: 'https://evil.example' }, 'POST'));

    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test.each(['/api/authx', '/api/authentication/x', '/api/search', '/api/news', '/news', '/', '/about'])(
    'DD-AUTH-037 %s には no-store を付けない',
    async (path) => {
      const proxy = await loadProxy();

      const res = proxy(request(path));

      expect(res.headers.get('Cache-Control')).toBeNull();
    },
  );

  test('DD-AUTH-037 Origin が違う /api/authx の POST の 403 には no-store を付けない', async () => {
    const proxy = await loadProxy();

    const res = proxy(request('/api/authx', { origin: 'https://evil.example' }, 'POST'));

    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  test('DD-AUTH-037 注文の状況の Origin 拒否は今までどおり no-store と Referrer-Policy: no-referrer', async () => {
    const proxy = await loadProxy();

    const res = proxy(request('/api/order-status/x', { origin: 'https://evil.example' }, 'POST'));

    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('DD-AUTH-037 /api/auth でも CSP と守りの見出しが付く', async () => {
    const proxy = await loadProxy();

    const res = proxy(request('/api/auth/me'));

    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
