import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// FREQ-326: 状態変更 API の Origin 検査を「既知の」許可オリジンと突き合わせる
//
// 以前は期待値を x-forwarded-host / x-forwarded-proto から組み立てていた。
// 攻撃者が指定できる値を自分で信頼する形で、OWASP CSRF Cheat Sheet が求める
// 「既知のターゲットオリジンとの照合」になっていなかった。

const ALLOWED = 'https://shop.example.com';
// 試験用の作り物のトークン（43文字）
const STATUS_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';

function makeRequest(
  url: string,
  headers: Record<string, string>,
  method = 'POST',
): NextRequest {
  return new NextRequest(url, { method, headers });
}

describe('proxy の Origin 検査', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  async function loadProxy() {
    const mod = await import('@/proxy');
    return mod.proxy;
  }

  describe('許可オリジンが設定されているとき', () => {
    beforeEach(() => {
      process.env.APP_ALLOWED_ORIGINS = ALLOWED;
      jest.resetModules();
    });

    test('許可オリジンからの POST は通す', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/cart/change`, { origin: ALLOWED }));

      expect(res.status).not.toBe(403);
    });

    // ここが本題。X-Forwarded-Host を細工しても期待値は動かない。
    test('X-Forwarded-Host を細工しても、許可リストに無いオリジンは 403', async () => {
      const proxy = await loadProxy();
      const res = proxy(
        makeRequest(`${ALLOWED}/api/cart/change`, {
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        }),
      );

      expect(res.status).toBe(403);
    });

    test('Origin が無い場合は Referer を見る', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/cart/change`, { referer: `${ALLOWED}/cart` }));

      expect(res.status).not.toBe(403);
    });

    test('Origin も Referer も無い状態変更リクエストは 403', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/cart/change`, {}));

      expect(res.status).toBe(403);
    });

    // 検査対象は POST/PUT/PATCH/DELETE のみ。OAuth コールバック等の GET を壊さない。
    test('GET は検査しない', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/cart/change`, {}, 'GET'));

      expect(res.status).not.toBe(403);
    });

    // Stripe webhook は Origin を持たない正当な外部 POST。対象外であること。
    test('/api/webhook は対象外', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/webhook/stripe`, {}));

      expect(res.status).not.toBe(403);
    });

    // FREQ-327: 検査は許可リストではなく除外リストで回す。列挙漏れで新しいルートが
    // 黙って無防備になるのを防ぐ（/api/contact 配下が実際に漏れていた）。
    test.each([
      '/api/contact',
      '/api/contact/threads/abc/reply',
      '/api/profile',
      '/api/checkout/place-order',
      '/api/orders',
    ])('列挙していない %s も検査対象', async (path) => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}${path}`, { origin: 'https://evil.example' }));

      expect(res.status).toBe(403);
    });

    // 署名や Bearer で発信元を検証している経路だけが除外。
    test.each(['/api/webhook/stripe', '/api/webhook/resend-delivery', '/api/contact/inbound', '/api/cron/meta-kpi-sync'])(
      '%s は除外',
      async (path) => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(`${ALLOWED}${path}`, {}));

        expect(res.status).not.toBe(403);
      },
    );

    // API 以外（ページの Server Action 等）は対象外のまま。
    test('/api 配下でないパスは検査しない', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/checkout`, {}));

      expect(res.status).not.toBe(403);
    });

    // 前方一致はセグメント境界で判定する。素の startsWith だと除外が誤爆して
    // 検査をすり抜ける経路ができる。
    test('/api/webhookfoo は除外に当たらず検査される', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/api/webhookfoo`, { origin: 'https://evil.example' }));

      expect(res.status).toBe(403);
    });

    test('/apidocs は /api 配下ではないので検査しない', async () => {
      const proxy = await loadProxy();
      const res = proxy(makeRequest(`${ALLOWED}/apidocs`, { origin: 'https://evil.example' }));

      expect(res.status).not.toBe(403);
    });

    // グループ E-5（注文の状況の窓口）。検査の順・許可リスト・除外は他の API と同じで、
    // 拒否の応答（Handler より前に返る）にだけ no-store と no-referrer を足す。
    describe('注文の状況の窓口 /api/order-status の Origin 検査', () => {
      const VERIFY_URL = `${ALLOWED}/api/order-status/${STATUS_TOKEN}/verify`;

      test('許可オリジンからの POST は通す', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(VERIFY_URL, { origin: ALLOWED }));

        expect(res.status).not.toBe(403);
      });

      test('別のオリジンは 403。本文は前のままで、no-store と no-referrer が付く', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(VERIFY_URL, { origin: 'https://evil.example' }));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden origin' });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      });

      test('X-Forwarded-Host を細工しても、許可リストに無いオリジンは 403（ヘッダーも付く）', async () => {
        const proxy = await loadProxy();
        const res = proxy(
          makeRequest(VERIFY_URL, {
            origin: 'https://evil.example',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'https',
          }),
        );

        expect(res.status).toBe(403);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      });

      test('Origin も Referer も無い POST は 403 で、同じヘッダーが付く', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(VERIFY_URL, {}));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden origin' });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      });

      test('Origin が無くても Referer が許可オリジンなら通す', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(VERIFY_URL, { referer: `${ALLOWED}/order-status/${STATUS_TOKEN}` }));

        expect(res.status).not.toBe(403);
      });

      test('Referer が別のオリジンなら 403 で、同じヘッダーが付く', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(VERIFY_URL, { referer: 'https://evil.example/page' }));

        expect(res.status).toBe(403);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      });

      test('GET は検査しない（private の読み出し）', async () => {
        const proxy = await loadProxy();
        const res = proxy(
          makeRequest(`${ALLOWED}/api/order-status/${STATUS_TOKEN}/private`, { origin: 'https://evil.example' }, 'GET'),
        );

        expect(res.status).not.toBe(403);
      });

      test('/api/order-status そのものも窓口の配下として扱う', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(`${ALLOWED}/api/order-status`, { origin: 'https://evil.example' }));

        expect(res.status).toBe(403);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      });

      test('他の API の 403 は前と同じ（no-store も no-referrer も足さない）', async () => {
        const proxy = await loadProxy();
        for (const path of ['/api/cart/change', '/api/orders', '/api/contact/threads/abc/reply']) {
          const res = proxy(makeRequest(`${ALLOWED}${path}`, { origin: 'https://evil.example' }));

          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: 'Forbidden origin' });
          expect(res.headers.get('Cache-Control')).toBeNull();
          expect(res.headers.get('Referrer-Policy')).toBeNull();
        }
      });

      // 前方一致はセグメント境界。似た名前の API に、窓口の拒否ヘッダーを足さない。
      test('/api/order-statusfoo は窓口の配下ではなく、検査は他の API と同じ（ヘッダーは足さない）', async () => {
        const proxy = await loadProxy();
        const res = proxy(makeRequest(`${ALLOWED}/api/order-statusfoo/x`, { origin: 'https://evil.example' }));

        expect(res.status).toBe(403);
        expect(res.headers.get('Cache-Control')).toBeNull();
        expect(res.headers.get('Referrer-Policy')).toBeNull();
      });
    });
  });

  describe('許可オリジンが未設定のとき', () => {
    beforeEach(() => {
      delete process.env.APP_ALLOWED_ORIGINS;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.BASE_URL;
      delete process.env.NEXT_PUBLIC_VERCEL_URL;
      jest.resetModules();
    });

    // 設定漏れだけで全 API が 403 になると機能停止するため、リクエスト由来の値へ退避する。
    test('リクエスト由来のオリジンと一致すれば通す', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('http://localhost:3000/api/cart/change', {
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
        }),
      );

      expect(res.status).not.toBe(403);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    test('退避時でも別オリジンは 403', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const proxy = await loadProxy();

      const res = proxy(
        makeRequest('http://localhost:3000/api/cart/change', {
          origin: 'https://evil.example',
          host: 'localhost:3000',
        }),
      );

      expect(res.status).toBe(403);
      warn.mockRestore();
    });

    // 注文の状況の窓口（グループ E-5）も、退避の検査は他の API と同じ。拒否にだけ no-store と no-referrer が付く。
    test('退避時の注文の状況の窓口: 一致すれば通し、別オリジンは 403 でヘッダーが付く', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const proxy = await loadProxy();
      const url = `http://localhost:3000/api/order-status/${STATUS_TOKEN}/verify`;

      const allowed = proxy(makeRequest(url, { origin: 'http://localhost:3000', host: 'localhost:3000' }));
      expect(allowed.status).not.toBe(403);

      const denied = proxy(makeRequest(url, { origin: 'https://evil.example', host: 'localhost:3000' }));
      expect(denied.status).toBe(403);
      expect(denied.headers.get('Cache-Control')).toBe('no-store');
      expect(denied.headers.get('Referrer-Policy')).toBe('no-referrer');
      warn.mockRestore();
    });
  });
});
