import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const ALLOWED = 'https://shop.example.com';
const EVIL = 'https://evil.example';
const ORIGIN_ENV_KEYS = [
  'APP_ALLOWED_ORIGINS',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_BASE_URL',
  'BASE_URL',
  'NEXT_PUBLIC_VERCEL_URL',
] as const;

function makeRequest(path: string, method: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${ALLOWED}${path}`, { method, headers });
}

async function loadProxy() {
  const mod = await import('@/proxy');
  return mod.proxy;
}

function expectSecurityHeaders(res: Response) {
  const csp = res.headers.get('Content-Security-Policy');
  expect(csp).toMatch(/script-src [^;]*'nonce-[0-9a-f]{24}'/);
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
}

describe('STOCKIST の頁と窓口にかかる共有の proxy', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  describe('許可のオリジンが設定されている時', () => {
    beforeEach(() => {
      process.env.APP_ALLOWED_ORIGINS = ALLOWED;
      jest.resetModules();
    });

    it.each([
      ['POST', '/api/admin/stockists'],
      ['PUT', '/api/admin/stockists/1'],
      ['PATCH', '/api/admin/stockists/1'],
      ['DELETE', '/api/admin/stockists/1'],
    ])('ARC-STOCKIST-004 %s %s を別のオリジンから送ると 403 Forbidden origin を返す', async (method, path) => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest(path, method, { origin: EVIL }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden origin' });
      // 注文の状況の窓口だけに足す見出しは STOCKIST の拒否には付かない
      expect(res.headers.get('Cache-Control')).toBeNull();
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'ARC-STOCKIST-004 %s で Origin も Referer も無い時は 403 を返す',
      async (method) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest('/api/admin/stockists/1', method));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden origin' });
      },
    );

    it('ARC-STOCKIST-004 Referer が壊れた URL の時は送り元が無いとみなして 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/stockists', 'POST', { referer: 'not a url' }));

      expect(res.status).toBe(403);
    });

    it('ARC-STOCKIST-004 Origin が無い時は Referer の送り元で照合し、別のオリジンなら 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/stockists', 'POST', { referer: `${EVIL}/admin/stockist` }));

      expect(res.status).toBe(403);
    });

    it('ARC-STOCKIST-004 許可のオリジンからの書き換えは通し、守りの見出しを付ける', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/stockists/1', 'PATCH', { origin: ALLOWED }));

      expect(res.status).not.toBe(403);
      expectSecurityHeaders(res);
    });

    it('ARC-STOCKIST-004 Origin が無くても Referer が許可のオリジンなら通す', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/api/admin/stockists', 'POST', { referer: `${ALLOWED}/admin/stockist/create` }));

      expect(res.status).not.toBe(403);
    });

    it('ARC-STOCKIST-004 X-Forwarded-Host を細工しても許可の一覧に無いオリジンは 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('/api/admin/stockists', 'POST', {
          origin: EVIL,
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        }),
      );

      expect(res.status).toBe(403);
    });

    it.each(['/api/admin/stockists', '/api/admin/stockists/1'])(
      'ARC-STOCKIST-004 GET %s は送り元が無くても検査せず、守りの見出しを付ける',
      async (path) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest(path, 'GET'));

        expect(res.status).not.toBe(403);
        expectSecurityHeaders(res);
      },
    );

    it.each(['/stockist', '/admin/stockist', '/admin/stockist/create', '/admin/stockist/edit/1'])(
      'ARC-STOCKIST-004 頁 %s にも守りの見出しを付ける',
      async (path) => {
        const proxy = await loadProxy();

        const res = proxy(makeRequest(path, 'GET'));

        expect(res.status).not.toBe(403);
        expectSecurityHeaders(res);
      },
    );

    it('ARC-STOCKIST-004 /admin の頁への POST は別のオリジンでも proxy では止めない', async () => {
      const proxy = await loadProxy();

      const res = proxy(makeRequest('/admin/stockist/create', 'POST', { origin: EVIL }));

      expect(res.status).not.toBe(403);
      expectSecurityHeaders(res);
    });

    it('ARC-STOCKIST-004 応答ごとに違う nonce を CSP に入れる', async () => {
      const proxy = await loadProxy();

      const first = proxy(makeRequest('/stockist', 'GET')).headers.get('Content-Security-Policy');
      const second = proxy(makeRequest('/stockist', 'GET')).headers.get('Content-Security-Policy');

      expect(first).not.toBe(second);
    });
  });

  describe('許可のオリジンが設定されていない時', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      for (const key of ORIGIN_ENV_KEYS) {
        delete process.env[key];
      }
      jest.resetModules();
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('ARC-STOCKIST-004 要求の見出しから作った比べる元と同じオリジンなら通す', async () => {
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('/api/admin/stockists', 'POST', {
          origin: 'https://admin.example',
          'x-forwarded-host': 'admin.example',
          'x-forwarded-proto': 'https',
        }),
      );

      expect(res.status).not.toBe(403);
    });

    it('ARC-STOCKIST-004 要求の見出しから作った比べる元と違うオリジンは 403 を返す', async () => {
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('/api/admin/stockists/1', 'DELETE', {
          origin: EVIL,
          'x-forwarded-host': 'admin.example',
          'x-forwarded-proto': 'https',
        }),
      );

      expect(res.status).toBe(403);
    });

    it('ARC-STOCKIST-004 設定が無いことの警告はプロセスにつき1回だけ出す', async () => {
      const proxy = await loadProxy();

      proxy(makeRequest('/api/admin/stockists', 'POST', { origin: ALLOWED }));
      proxy(makeRequest('/api/admin/stockists/1', 'PUT', { origin: ALLOWED }));

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
