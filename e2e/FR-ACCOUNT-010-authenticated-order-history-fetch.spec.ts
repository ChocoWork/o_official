import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-010 authenticated order history fetch', () => {
	test('認証付きで注文履歴を取得し、購入履歴タブに一覧表示する', async ({ page }) => {
		await mockOtpAuthentication(page);

		let ordersAuthorizationHeader: string | null = null;

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
			ordersAuthorizationHeader = route.request().headers().authorization ?? null;

			if (!ordersAuthorizationHeader?.startsWith('Bearer test-access-token')) {
				await route.fulfill({
					status: 401,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Unauthorized' }),
				});
				return;
			}

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
							items: [{ id: 'line-1', name: 'Silk Blouse', quantity: 1, amount: '¥12,000' }],
							detailHref: '/account/orders/order-1',
						},
					],
				}),
			});
		});

		await loginAndOpenAccount(page);
		await page.getByRole('button', { name: '購入履歴' }).click();

		await expect.poll(() => ordersAuthorizationHeader).toContain('Bearer test-access-token');
		await expect(page.getByText('ORD-0001')).toBeVisible();
		await expect(page.getByText('注文履歴を読み込めませんでした')).toHaveCount(0);
	});
});