import { test, expect } from '@playwright/test';

// FREQ-319: パスワード再設定の 500 を解消し、OWASP Forgot Password Cheat Sheet に沿わせる
//
// 注: 本番ビルドでは TURNSTILE_SECRET_KEY 未設定時に verifyTurnstile が fail-closed で
// 403 を返す。そのため request エンドポイントの深い検証（未登録宛にメールを送らないこと等）は
// Turnstile をモックできる tests/integration/api/auth/password-reset.test.ts が担当し、
// ここでは「500 で落ちない」「応答が区別できない」までを見る。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const PROBE_TOKEN = 'freq319-probe-token';

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-002 password reset hardening (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-319-AC-04: 無効・期限切れのリンクは理由が画面に出ること
    // （従来は無言で入力フォームに戻していた）
    test('an expired link shows a reason instead of silently returning to the form', async ({ page }) => {
      await page.goto('/auth/password-reset?error=link_expired');

      // 案内の入れ物は常に置かれ（FREQ-376）、Next の __next-route-announcer__ も role="alert" を持つので、
      // 理由の文言が入った案内を指す
      const alert = page.locator('p[role="alert"]', { hasText: '有効期限' });
      await expect(alert).toBeVisible();
    });

    // FREQ-332-AC-01: 確認画面を挟まず、到達時に自動で 1 回だけ POST すること
    // （消費は confirm へ移したので、この POST に副作用は無い）
    test('the verify page posts once automatically instead of showing a button', async ({ page }) => {
      let posts = 0;
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/api/auth/password-reset/link')) {
          posts += 1;
        }
      });

      await page.goto(`/auth/password-reset/verify?token=${PROBE_TOKEN}`);

      // 無効なトークンなので理由付きで入力フォームへ戻る
      const alert = page.locator('p[role="alert"]', { hasText: '有効期限' });
      await expect(alert).toBeVisible();
      await expect(page.getByRole('button', { name: 'パスワードを再設定する' })).toHaveCount(0);
      expect(posts).toBe(1);
    });

    // 入力フォーム自体が従来どおり表示されること（回帰）
    test('the request form is still reachable', async ({ page }) => {
      await page.goto('/auth/password-reset');

      await expect(page.getByRole('heading', { name: /パスワード再設定/ })).toBeVisible();
      await expect(page.getByRole('button', { name: '再設定メールを送信' })).toBeVisible();
    });
  });
}

test.describe('FR-PWRESET-002 password reset hardening (API contract)', () => {
  // FREQ-319-AC-03: GET だけではトークンが消費されないこと（メールスキャナ対策）
  test('opening the link with GET forwards to the verify page without consuming', async ({ request }) => {
    const response = await request.get(
      `/api/auth/password-reset/link?token=${PROBE_TOKEN}`,
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(303);
    const location = response.headers()['location'];
    expect(location).toContain('/auth/password-reset/verify');
    expect(location).toContain(`token=${PROBE_TOKEN}`);
  });

  // FREQ-319-AC-04: token 無しは理由付きで戻されること
  test('a link without a token redirects with a reason', async ({ request }) => {
    const response = await request.get('/api/auth/password-reset/link', { maxRedirects: 0 });

    expect(response.status()).toBe(303);
    expect(response.headers()['location']).toContain('error=link_invalid');
  });

  // FREQ-319-AC-01: 500 で落ちないこと（従来はここで Internal server error になっていた）
  // FREQ-319-AC-02: 未登録と登録済みで応答が区別できないこと
  test('the request endpoint no longer fails, and hides whether the account exists', async ({ request }) => {
    const unknown = await request.post('/api/auth/password-reset/request', {
      data: { email: 'no-such-user-freq319@example.com' },
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    });
    const known = await request.post('/api/auth/password-reset/request', {
      data: { email: 'test+1@example.com' },
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    });

    expect(unknown.status()).not.toBe(500);
    expect(known.status()).not.toBe(500);
    expect(unknown.status()).toBe(known.status());
    expect(await unknown.text()).toBe(await known.text());
  });

  // FREQ-319-AC-05: 旧 token+email 直 POST の経路を廃止したこと
  test('confirm rejects the removed legacy token payload', async ({ request }) => {
    const response = await request.post('/api/auth/password-reset/confirm', {
      data: {
        token: PROBE_TOKEN,
        email: 'test+1@example.com',
        new_password: 'NewPassword123!',
      },
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    });

    // 再設定 Cookie が無ければ 400。200 が返ったら legacy 経路が生きている。
    expect(response.status()).toBe(400);
  });
});
