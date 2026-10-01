import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-412: 注文一覧に支払い手続き中・放棄・要確認の印・発送止めの理由を出し、要確認のみ・状態で絞り込める。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const BASE = {
  customerEmail: 'buyer@example.com',
  orderDate: '2026-09-27',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
};

const ORDERS = [
  { ...BASE, id: 'order-progress', customerName: '手続き 花子', status: '支払い手続き中', canCancel: true },
  { ...BASE, id: 'order-review', customerName: '確認 太郎', status: '決済完了', canShip: true, needsReview: true },
  {
    ...BASE,
    id: 'order-blocked',
    customerName: '金額 次郎',
    status: '決済完了',
    canShip: false,
    shipBlockedReason: '支払額の確認が必要です（要対応）',
  },
];

async function mockAdminApis(page: Page, requestedUrls: string[]): Promise<void> {
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
  await page.route('**/api/admin/orders?**', (route) => {
    requestedUrls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
  await expect(page.getByRole('row', { name: /order-progress/ })).toBeVisible();
}

function lastRequestedUrl(urls: string[]): string {
  return urls[urls.length - 1] ?? '';
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-061 order list review states (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('要確認の注文に「要確認」の印が表示される', async ({ page }) => {
      // FREQ-412-AC-01
      await mockAdminApis(page, []);
      await openOrders(page);

      await expect(page.getByRole('row', { name: /order-review/ }).getByText('要確認', { exact: true })).toBeVisible();
      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('要確認', { exact: true })).toHaveCount(0);
    });

    test('「要確認のみ」を選ぶと review=only で一覧を読み直す', async ({ page }) => {
      // FREQ-412-AC-02
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);

      await page.getByRole('button', { name: '要確認のみ' }).click();

      await expect.poll(() => requestedUrls.some((url) => url.includes('review=only'))).toBe(true);
    });

    test('既定の一覧は状態を送らず（放棄はサーバーが除く）、「放棄」を選ぶと status=abandoned を送る', async ({ page }) => {
      // FREQ-412-AC-03
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);

      expect(requestedUrls[0]).not.toContain('status=');
      await page.getByRole('button', { name: '放棄', exact: true }).click();

      await expect.poll(() => requestedUrls.some((url) => url.includes('status=abandoned'))).toBe(true);
    });

    test('「放棄」のあとに別の状態を選ぶと、「放棄」の選択が外れ、その状態で絞り込む', async ({ page }) => {
      // FREQ-412-AC-05
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);
      const abandoned = page.getByRole('button', { name: '放棄', exact: true });
      const pending = page.getByRole('button', { name: '未決済', exact: true });

      await abandoned.click();
      await expect(abandoned).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastRequestedUrl(requestedUrls)).toContain('status=abandoned');

      await pending.click();

      // 放棄は status を送らないと読めない。他の状態と一緒に選んだままだと status を送れず、放棄の行は出ないのに「放棄」だけ選ばれて見える
      await expect(abandoned).toHaveAttribute('aria-pressed', 'false');
      await expect(pending).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastRequestedUrl(requestedUrls)).toContain('status=pending');
    });

    test('「放棄」を選ぶと、選んでいた他の状態が外れる（放棄以外の状態は、これまでどおり重ねて選べる）', async ({ page }) => {
      // FREQ-412-AC-05
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);
      const pending = page.getByRole('button', { name: '未決済', exact: true });
      const paid = page.getByRole('button', { name: '決済完了', exact: true });
      const abandoned = page.getByRole('button', { name: '放棄', exact: true });

      await pending.click();
      await paid.click();
      // 放棄以外は重ねて選べる（2つ以上なら status は送らず、画面側で絞る）
      await expect(pending).toHaveAttribute('aria-pressed', 'true');
      await expect(paid).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastRequestedUrl(requestedUrls)).not.toContain('status=');

      await abandoned.click();

      await expect(abandoned).toHaveAttribute('aria-pressed', 'true');
      await expect(pending).toHaveAttribute('aria-pressed', 'false');
      await expect(paid).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => lastRequestedUrl(requestedUrls)).toContain('status=abandoned');
    });

    test('支払い手続き中の注文が状態名つきで表示される', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);

      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('支払い手続き中', { exact: true })).toBeVisible();
    });

    test('支払額の違いの要対応が開いている注文は「発送済みにする」を押せず、理由が表示される', async ({ page }) => {
      // FREQ-412-AC-04
      await mockAdminApis(page, []);
      await openOrders(page);

      const blocked = page.getByRole('row', { name: /order-blocked/ });
      await expect(blocked.getByText('支払額の確認が必要です（要対応）')).toBeVisible();
      await expect(blocked.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(page.getByRole('row', { name: /order-review/ }).getByRole('button', { name: '発送済みにする' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
