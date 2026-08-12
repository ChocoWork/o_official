import { test, expect, Page } from '@playwright/test';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDERS = [
  {
    id: 'order-paid',
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-08-01',
    itemCount: '1点',
    items: [{ name: 'シルクブラウス', quantity: 1 }],
    totalAmount: '¥28,800',
    status: '決済完了',
  },
  {
    id: 'order-pending',
    customerName: '佐藤 太郎',
    customerEmail: 'taro@example.com',
    orderDate: '2026-08-02',
    itemCount: '1点',
    items: [{ name: 'タックスカート', quantity: 1 }],
    totalAmount: '¥32,000',
    status: '未決済',
  },
  {
    id: 'order-shipped',
    customerName: '鈴木 次郎',
    customerEmail: 'jiro@example.com',
    orderDate: '2026-08-03',
    itemCount: '1点',
    items: [{ name: 'コート', quantity: 1 }],
    totalAmount: '¥58,000',
    status: '発送済み',
  },
];

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );

  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { orders: ORDERS, totalCount: ORDERS.length, totalPages: 1 },
      }),
    }),
  );

  await page.route('**/api/admin/orders/*/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'shipped' }),
    }),
  );
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('決済完了の注文にだけ発送ボタンが出る', async ({ page }) => {
      // FREQ-267-AC-01 / AC-02
      await openOrders(page);

      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
    });

    test('配送業者と追跡番号を入力して発送できる', async ({ page }) => {
      // FREQ-267-AC-03
      await openOrders(page);

      await page.getByRole('button', { name: '発送済みにする' }).click();
      await expect(page.getByLabel('配送業者')).toBeVisible();
      await page.getByLabel('配送業者').selectOption('yamato');
      await page.getByLabel('追跡番号').fill('1234-5678-9012');
      await page.getByRole('button', { name: '発送する' }).click();

      // exact を付けないとボタン文言「発送済みにする」も部分一致で拾ってしまう。
      await expect(page.getByText('発送済み', { exact: true })).toHaveCount(2);
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
