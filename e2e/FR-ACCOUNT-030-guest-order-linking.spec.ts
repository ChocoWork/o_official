import { test, expect, Page } from '@playwright/test';

// FREQ-265: メール確認済みの会員でログインすると、同じメールで行った
// ゲスト注文が購入履歴に現れる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

// src/app/account/page.tsx L59 の OrderSummary に合わせる。
const LINKED_ORDER = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  orderDate: '2026-08-01',
  status: 'paid',
  totalAmount: '¥28,800',
  itemCount: 1,
  shippingFullName: '山田 花子',
  shippingEmail: 'hanako@example.com',
  shippingPhone: '090-1234-5678',
  shippingAddress: '東京都渋谷区神宮前1-2-3',
  items: [{ itemName: 'シルクブラウス', quantity: 1 }],
  detailHref: '/account/orders/a1b2c3d4-1111-2222-3333-444455556666',
};

async function mockAccountApis(page: Page, orders: unknown[]): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'user-1', email: 'hanako@example.com', role: 'user', mfaVerified: true },
      }),
    }),
  );

  // GET /api/orders は { data: OrderSummary[] } を返す(配列を直接包む)。
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: orders }),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-030 guest order linking (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('紐付いたゲスト注文が購入履歴に表示される', async ({ page }) => {
      // FREQ-265-AC-01
      await mockAccountApis(page, [LINKED_ORDER]);
      await page.goto('/account?tab=orders');

      // 購入履歴の一覧行は注文番号・金額・状態・日付のみを表示し、商品名は
      // 詳細ページ（detailHref）側の責務。一覧に紐付いた注文が現れることを確認する。
      await expect(page.getByText('ORD-A1B2C3D4')).toBeVisible();
      await expect(page.getByText('¥28,800')).toBeVisible();
    });

    test('紐付いていない注文は購入履歴に表示されない', async ({ page }) => {
      // FREQ-265-AC-02
      await mockAccountApis(page, []);
      await page.goto('/account?tab=orders');

      await expect(page.getByText('ORD-A1B2C3D4')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAccountApis(page, [LINKED_ORDER]);
      await page.goto('/account?tab=orders');

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
