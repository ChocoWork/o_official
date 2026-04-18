import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-005 order history', () => {
  test('過去の注文を一覧表示し、注文詳細へ遷移できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'user@example.com',
          fullName: '山田 花子',
          kanaName: 'ヤマダ ハナコ',
          phone: '090-1111-2222',
          address: {
            postalCode: '1500001',
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
            building: '青山ハイツ 101',
          },
        }),
      });
    });

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'order-1',
              orderNumber: 'ORD-0001',
              orderDate: '2026-04-01',
              status: '決済完了',
              totalAmount: '¥12,000',
              itemCount: 1,
              items: [
                { id: 'line-1', name: 'Silk Blouse', quantity: 1, color: 'Black', size: 'M', amount: '¥12,000' },
              ],
              detailHref: '/account/orders/order-1',
            },
          ],
        }),
      });
    });

    await page.route('**/api/orders/order-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'order-1',
          orderNumber: 'ORD-0001',
          orderDate: '2026-04-01',
          status: '決済完了',
          totalAmount: '¥12,000',
          shippingAddress: '東京都渋谷区神宮前1-2-3 青山ハイツ 101',
          items: [
            { id: 'line-1', name: 'Silk Blouse', quantity: 1, color: 'Black', size: 'M', amount: '¥12,000' },
          ],
        }),
      });
    });

    await loginAndOpenAccount(page);
    await page.getByRole('button', { name: '購入履歴' }).click();

    await expect(page.getByText('ORD-0001')).toBeVisible();
    await expect(page.getByText('決済完了')).toBeVisible();
    await expect(page.getByRole('link', { name: '注文詳細を見る' })).toHaveAttribute('href', '/account/orders/order-1');

    await page.getByRole('link', { name: '注文詳細を見る' }).click();
    await expect(page).toHaveURL(/\/account\/orders\/order-1/);
    await expect(page.getByRole('heading', { name: '注文詳細' })).toBeVisible();
    await expect(page.getByText('東京都渋谷区神宮前1-2-3 青山ハイツ 101')).toBeVisible();
  });
});