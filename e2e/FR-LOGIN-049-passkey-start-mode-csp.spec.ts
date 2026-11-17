/**
 * FR-LOGIN-049 パスキーのログインの始め (b)（ブラウザから GoTrue を直に呼ぶ）が CSP に止められないこと
 * 対応: FR-AUTH-017-AC-01・02
 *
 * 手元のアプリ（本番ビルド）の /login を開く試験。CSP は変えないので、connect-src に自分の Supabase の origin と Turnstile が
 * 既に入っていること（ワイルドカードは無い）と、ページの中から手元の GoTrue へ fetch が届くことを固定する。
 */
import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function supabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / ANON_KEY を確かめる');
  return { url: url.replace(/\/+$/, ''), anonKey };
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-017-AC-01 /login の CSP の connect-src に自分の Supabase の origin と Turnstile があり、*.supabase.co が無い (${viewport.name})`, async ({ request }) => {
      const { url } = supabaseConfig();
      const response = await request.get('/login');
      const csp = response.headers()['content-security-policy'] ?? '';
      const connect = csp.split('; ').find((part) => part.startsWith('connect-src ')) ?? '';
      const values = connect.split(' ').slice(1);
      expect(values).toContain(new URL(url).origin);
      expect(values).toContain('https://challenges.cloudflare.com');
      expect(csp).not.toContain('*.supabase.co');
    });

    test(`FR-AUTH-017-AC-02 /login のページの中から手元の GoTrue のパスキーの選択肢へ fetch しても CSP に止められない (${viewport.name})`, async ({ page }) => {
      const { url, anonKey } = supabaseConfig();
      await page.goto('/login');
      const result = await page.evaluate(
        async ({ endpoint, key }) => {
          const violations: string[] = [];
          document.addEventListener('securitypolicyviolation', (event) => {
            violations.push(`${event.violatedDirective}:${event.blockedURI}`);
          });
          let status: number | null = null;
          let error: string | null = null;
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { apikey: key, 'Content-Type': 'application/json' },
              body: JSON.stringify({ gotrue_meta_security: { captcha_token: 'dummy-token' } }),
            });
            status = response.status;
          } catch (caught) {
            error = String(caught);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { violations, status, error };
        },
        { endpoint: `${url}/auth/v1/passkeys/authentication/options`, key: anonKey },
      );
      expect(result.violations).toEqual([]);
      expect(result.error, 'CSP に止められた時は TypeError になる').toBeNull();
      expect(typeof result.status).toBe('number');
    });
  });
}
