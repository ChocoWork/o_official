import { expect, test, type APIResponse } from '@playwright/test';

// /about の HTTP 応答だけを検証する（幅に依存しないのでビューポートの繰り返しは無い）。
// 各テストは Cookie の持ち越しを避けるため、必要に応じて新しい要求の文脈を作る。

const OG_IMAGE_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
];

function readOgImage(html: string): string {
  for (const pattern of OG_IMAGE_PATTERNS) {
    const match = html.match(pattern);
    if (match) return match[1].replace(/&amp;/g, '&');
  }
  throw new Error('og:image meta not found in /about HTML');
}

function setCookieLines(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
}

function expectNotSharedCacheable(response: APIResponse): void {
  const cacheControl = response.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/private|no-store/i);
  expect(cacheControl).not.toMatch(/public/i);
  expect(cacheControl).not.toMatch(/s-maxage/i);
}

const optimize = (src: string): string => `/_next/image?url=${encodeURIComponent(src)}&w=640&q=75`;

test.describe('FR-ABOUT-010 /about の HTTP 応答の守り', () => {
  test('SEC-ABOUT-001-AC-02 og:image の道筋を同じオリジンで要求すると 200 で画像が返る', async ({
    request,
    baseURL,
  }) => {
    const aboutResponse = await request.get('/about');
    expect(aboutResponse.status()).toBe(200);

    const ogImage = readOgImage(await aboutResponse.text());
    const imageUrl = new URL(ogImage, baseURL);
    const pageOrigin = new URL(aboutResponse.url()).origin;

    // 道筋（/about.png）を頁と同じオリジンで要求する。
    const image = await request.get(`${pageOrigin}${imageUrl.pathname}${imageUrl.search}`);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toMatch(/^image\//i);
  });

  test('SEC-ABOUT-002-AC-01 /about の応答に守りの見出しが付く', async ({ request }) => {
    const response = await request.get('/about');
    expect(response.status()).toBe(200);

    const headers = response.headers();
    const csp = headers['content-security-policy'];

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toContain('max-age=63072000');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('SEC-ABOUT-003-AC-01 /about の CSP に cdn.jsdelivr.net・readdy.ai・placehold.co が含まれない', async ({
    request,
  }) => {
    const response = await request.get('/about');
    expect(response.status()).toBe(200);

    const csp = response.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).not.toContain('readdy.ai');
    expect(csp).not.toContain('placehold.co');
  });

  // 対照: 同じ w・q で同じオリジンの /about.png は 200（w・q 由来の 400 ではないと示す）。
  // 実行の最初に画像の最適化（sharp）が初めて動く時は遅いので、時間の上限を延ばす。
  // 次の拒否のテストは今のコードで赤（test.fail）なので、対照が壊れても隠れないよう別のテストに分ける。
  test('SEC-ABOUT-003-AC-02 対照: 同じオリジンの /about.png を /_next/image に渡すと 200 で画像が返る', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const control = await request.get(optimize('/about.png'));
    expect(control.status()).toBe(200);
    expect(control.headers()['content-type']).toMatch(/^image\//i);
  });

  test('SEC-ABOUT-003-AC-02 /_next/image は placehold.co・readdy.ai の画像を取らず 4xx を返す', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    // remotePatterns は自分のプロジェクトの署名つきの道だけなので、外の 2 ホストへは取りに行かず、設定の段階で 4xx になる。
    const placehold = await request.get(optimize('https://placehold.co/600x400/png'));
    expect(placehold.status()).toBeGreaterThanOrEqual(400);
    expect(placehold.status()).toBeLessThan(500);
    expect(placehold.headers()['content-type'] ?? '').not.toMatch(/^image\//i);

    const readdy = await request.get(optimize('https://readdy.ai/api/search-image?query=about'));
    expect(readdy.status()).toBeGreaterThanOrEqual(400);
    expect(readdy.status()).toBeLessThan(500);
    expect(readdy.headers()['content-type'] ?? '').not.toMatch(/^image\//i);
  });

  // /about の応答は Cookie の有無に依らず共有のキャッシュに残らない（Set-Cookie が付くかは SEC-PRIVACY-015 が見る。session_id は決済の道だけで発行する）。
  test('SEC-ABOUT-004-AC-01 Cookie を持たない要求の /about は共有のキャッシュに残らない', async ({
    playwright,
    baseURL,
  }) => {
    const context = await playwright.request.newContext({ baseURL });
    try {
      const response = await context.get('/about');
      expect(response.status()).toBe(200);

      expectNotSharedCacheable(response);
    } finally {
      await context.dispose();
    }
  });

  test('SEC-ABOUT-004-AC-02 セッションの Cookie を持つ要求の /about は Set-Cookie が無くても共有のキャッシュに残らない', async ({
    playwright,
    baseURL,
  }) => {
    // /about は session_id を発行しないので、32 桁の 16 進の値を自分で付けて要求する。
    const sessionId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    // Cookie の入れ物を共有しない別の文脈から、セッションの Cookie を明示して要求する。
    const second = await playwright.request.newContext({ baseURL });
    try {
      const response = await second.get('/about', {
        headers: { Cookie: `session_id=${sessionId}` },
      });
      expect(response.status()).toBe(200);
      expect(setCookieLines(response)).toHaveLength(0);
      expectNotSharedCacheable(response);
    } finally {
      await second.dispose();
    }
  });

  test('SEC-ABOUT-005-AC-01 X-Forwarded-Host を偽っても og:image の URL のホストが変わらない', async ({
    request,
  }) => {
    const plain = await request.get('/about');
    expect(plain.status()).toBe(200);
    const plainHost = new URL(readOgImage(await plain.text())).host;

    const forged = await request.get('/about', {
      headers: { 'X-Forwarded-Host': 'evil.example' },
    });
    expect(forged.status()).toBe(200);
    const forgedHost = new URL(readOgImage(await forged.text())).host;

    expect(forgedHost).toBe(plainHost);
    expect(forgedHost).not.toContain('evil.example');
  });
});
