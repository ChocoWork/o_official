import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-415: 毎時の見回りが支払いから作った注文に要確認「支払いから作った注文」を付け、
// ORDER タブの要対応・要確認の欄に出す。お客様へ確認したら「確認済みにする」で欄から消す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const LABEL = '支払いから作った注文：お客様へ確認してください';

const REVIEW = {
  orderId: 'd1b2c3d4-1111-2222-8333-444455556666',
  orderNumber: 'ORD-D1B2C3D4',
  orderStatus: 'paid',
  reviewReason: 'recovered_from_payment',
  reviewReasonLabel: LABEL,
  reviewMarkedAt: '2026-10-05T01:00:00.000Z',
};

type AttentionState = { reviews: unknown[] };

async function mockAdminApis(page: Page, state: AttentionState): Promise<void> {
  await mockAdminBackgroundApis(page);
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
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }),
  );
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          exceptions: [],
          reviews: state.reviews,
          counts: { exceptions: 0, reviews: state.reviews.length },
        },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    }),
  );
  await page.route(`**/api/admin/orders/${REVIEW.orderId}/review`, (route) => {
    state.reviews = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-064 recovered order review (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('支払いから作った注文が、お客様へ確認する文言で要確認の欄に出る', async ({ page }) => {
      // FREQ-415-AC-01
      await mockAdminApis(page, { reviews: [REVIEW] });
      await openOrders(page);

      await expect(page.getByRole('heading', { name: '要対応 0件・要確認 1件' })).toBeVisible();
      await expect(page.getByText(`${LABEL}（ORD-D1B2C3D4）`)).toBeVisible();
    });

    test('「確認済みにする」を押すと欄から消える', async ({ page }) => {
      // FREQ-415-AC-02
      await mockAdminApis(page, { reviews: [REVIEW] });
      await openOrders(page);

      await page.getByRole('button', { name: '確認済みにする' }).click();

      await expect(page.getByText(`${LABEL}（ORD-D1B2C3D4）`)).toHaveCount(0);
    });
  });
}
