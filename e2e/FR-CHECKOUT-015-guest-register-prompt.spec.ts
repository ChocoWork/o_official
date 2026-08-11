import { test, expect, Page } from '@playwright/test';

// FREQ-266: 未ログインの注文完了画面から、メールを引き継いで会員登録へ導く。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function mockAuth(page: Page, authenticated: boolean): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        authenticated
          ? { authenticated: true, user: { id: 'user-1', email: 'hanako@example.com', role: 'user' } }
          : { authenticated: false },
      ),
    }),
  );
}

async function gotoCompletedCheckout(page: Page): Promise<void> {
  await page.route('**/api/cart', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );
  await page.route('**/api/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'hanako@example.com' }),
    }),
  );
  await page.route('**/api/checkout/complete', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ orderId: 'ORDER-TEST-015' }),
    }),
  );

  await page.goto('/checkout?session_id=cs_test_guest_register_prompt');
  await expect(
    page.getByRole('heading', { name: 'Thank you for your order' }),
  ).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-015 guest register prompt (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未ログインの完了画面に会員登録カードが表示される', async ({ page }) => {
      // FREQ-266-AC-01
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      const card = page.getByRole('region', { name: '会員登録のご案内' });
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: '会員登録へ進む' })).toBeVisible();
    });

    test('ログイン済みの完了画面にはカードが表示されない', async ({ page }) => {
      // FREQ-266-AC-02
      await mockAuth(page, true);
      await gotoCompletedCheckout(page);

      await expect(page.getByRole('region', { name: '会員登録のご案内' })).toHaveCount(0);
    });

    test('カードから /login の会員登録タブへメールを引き継いで遷移する', async ({ page }) => {
      // FREQ-266-AC-03
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      await page.getByRole('link', { name: '会員登録へ進む' }).click();
      await expect(page).toHaveURL(/\/login\?tab=register&email=hanako%40example\.com/);
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Email')).toHaveValue('hanako@example.com');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
