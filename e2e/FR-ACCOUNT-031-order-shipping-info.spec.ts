import { test, expect, Page } from '@playwright/test';

// FREQ-267: 発送済みの注文詳細に配送業者・追跡番号・追跡リンクを出す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const SHIPPED_ORDER = {
  id: ORDER_ID,
  orderNumber: 'ORD-A1B2C3D4',
  orderDate: '2026/08/01 09:00',
  status: 'shipped',
  subtotalAmount: '¥28,000',
  shippingAmount: '¥800',
  discountAmount: '¥0',
  totalAmount: '¥28,800',
  paymentMethod: 'クレジットカード',
  shippingAddress: '〒100-0001 東京都 千代田区 千代田1-1 1F',
  items: [
    {
      id: 'item-1',
      itemId: 1,
      name: 'シルクブラウス',
      imageUrl: null,
      color: 'ホワイト',
      size: 'M',
      quantity: 1,
      amount: '¥28,000',
      stockStatus: 'in_stock',
    },
  ],
  shippedAt: '2026-08-05T00:00:00.000Z',
  shippingCarrier: 'yamato',
  trackingNumber: '1234-5678-9012',
};

const PAID_ORDER = {
  ...SHIPPED_ORDER,
  status: 'paid',
  shippedAt: null,
  shippingCarrier: null,
  trackingNumber: null,
};

async function mockOrderDetail(page: Page, order: unknown): Promise<void> {
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

  await page.route(`**/api/orders/${ORDER_ID}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(order),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-031 order shipping info (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送済みの注文に配送情報が出る', async ({ page }) => {
      // FREQ-267-AC-05
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const section = page.getByRole('region', { name: '配送情報' });
      await expect(section).toBeVisible();
      await expect(section.getByText('ヤマト運輸')).toBeVisible();
      await expect(section.getByText('1234-5678-9012')).toBeVisible();

      const link = section.getByRole('link', { name: '配送状況を確認する' });
      await expect(link).toHaveAttribute('href', /toi\.kuronekoyamato\.co\.jp/);
      await expect(link).toHaveAttribute('rel', /noopener/);
    });

    test('未発送の注文には配送情報が出ない', async ({ page }) => {
      // FREQ-267-AC-06
      await mockOrderDetail(page, PAID_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      await expect(page.getByRole('region', { name: '配送情報' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
