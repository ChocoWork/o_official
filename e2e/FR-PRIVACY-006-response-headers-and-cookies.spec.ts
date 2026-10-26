import { expect, test } from '@playwright/test';
import { createTestMember, loginAsMember } from './member-session-helpers';

// 確認コードとログインの Cookie を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

function scriptSrc(csp: string | undefined): string {
  const directive = (csp ?? '').split(';').map((part) => part.trim()).find((part) => /^script-src(\s|$)/.test(part));
  return directive ?? '';
}

for (const viewport of viewports) {
  test.describe(`FR-PRIVACY-006 応答の見出しと Cookie (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('SEC-PRIVACY-007-AC-01: /privacy の Cache-Control に private または no-store が含まれ、public・s-maxage が含まれない', async ({ request }) => {
      const response = await request.get('/privacy');
      expect(response.status()).toBe(200);

      const cacheControl = response.headers()['cache-control'] ?? '';
      expect(cacheControl).toMatch(/\b(private|no-store)\b/i);
      expect(cacheControl).not.toMatch(/\bpublic\b/i);
      expect(cacheControl).not.toMatch(/s-maxage/i);
    });

    test("SEC-PRIVACY-013-AC-01: /privacy の応答に frame-ancestors 'none'・X-Frame-Options DENY・HSTS・nosniff が付く", async ({ request }) => {
      const response = await request.get('/privacy');
      expect(response.status()).toBe(200);

      const headers = response.headers();
      expect(headers['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['strict-transport-security'] ?? '').not.toBe('');
      expect(headers['x-content-type-options']).toBe('nosniff');
    });

    test("SEC-PRIVACY-014-AC-01: /privacy の CSP の script-src に 'nonce- が含まれ、'unsafe-inline' だけで許す形ではない", async ({ request }) => {
      const response = await request.get('/privacy');
      expect(response.status()).toBe(200);

      const directive = scriptSrc(response.headers()['content-security-policy']);
      expect(directive).not.toBe('');
      expect(directive).toContain("'nonce-");
      // nonce が有る時にブラウザが無視する 'unsafe-inline' が残るのは許すが、nonce 抜きの 'unsafe-inline' 単独は許さない。
      expect(directive).not.toMatch(/^script-src(\s+'self')?\s+'unsafe-inline'\s*$/);
    });

    test('SEC-PRIVACY-014-AC-02: /privacy の CSP の script-src に js.stripe.com・cdn.jsdelivr.net が含まれない', async ({ request }) => {
      test.fail(true, 'SEC-PRIVACY-014 今のコードは一部満たさない（docs/02_Requirements/areas/privacy.md）');
      const response = await request.get('/privacy');
      expect(response.status()).toBe(200);

      const directive = scriptSrc(response.headers()['content-security-policy']);
      expect(directive).not.toBe('');
      expect(directive).not.toContain('js.stripe.com');
      expect(directive).not.toContain('cdn.jsdelivr.net');
    });

    test('SEC-PRIVACY-015-AC-01: Cookie の無い新しい context で /privacy を開いても session_id が発行されない', async ({ browser }) => {
      test.fail(true, 'SEC-PRIVACY-015 今のコードは満たさない（docs/02_Requirements/areas/privacy.md）');
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        expect(await context.cookies()).toEqual([]);

        const page = await context.newPage();
        const response = await page.goto('/privacy');
        expect(response?.status()).toBe(200);
        // 頁の描画が済んでから Cookie を確かめる
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        const setCookies = (await response!.headersArray())
          .filter((header) => header.name.toLowerCase() === 'set-cookie')
          .map((header) => header.value.split('=')[0].trim());
        expect(setCookies).not.toContain('session_id');

        await expect
          .poll(async () => (await context.cookies()).map((cookie) => cookie.name), { timeout: 3000 })
          .not.toContain('session_id');
      } finally {
        await context.close();
      }
    });

    test('SEC-PRIVACY-016-AC-01: 会員が /privacy を開いた時の /api/auth/me の応答本文に会員のメールが含まれない', async ({ page }) => {
      const member = await createTestMember(`privacy-me-${viewport.name}`);
      // 試験ごとに別の送り元にし、全部の E2E が共有する回数の制限の枠を使い切らない。
      const octet = viewports.indexOf(viewport) + 1;
      await loginAsMember(page, member, `10.${octet}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

      await page.goto('/privacy');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const me = await page.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const body = await me.text();
      // 応答が空や未ログインの形だと「メールが無い」ことが空振りになるので、会員の応答であることも確かめる。
      expect(body).toContain(member.userId);
      expect(body.toLowerCase()).not.toContain(member.email.toLowerCase());
      expect(body.toLowerCase()).not.toContain(encodeURIComponent(member.email).toLowerCase());
    });
  });
}
