import { test, expect } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-79: 購入履歴タブの注文カードヘッダー右側の「注文詳細」ボタン
// AC-01: 各注文カードに「注文詳細」ボタンが表示されること
// AC-02: リンク先が /account/orders/{注文ID} であること

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-014 order detail button (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('購入履歴の注文カードに「注文詳細」ボタンが表示され、注文詳細ページへのリンクを持つ', async ({ page }) => {
			await mockOtpAuthentication(page);

			await page.route('**/api/orders', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						data: [
							{
								id: 'order-1',
								orderNumber: 'ORD-0001',
								orderDate: '2026/07/05',
								status: '決済完了',
								totalAmount: '¥59,600',
								itemCount: 2,
								shippingFullName: '山田 花子',
								shippingEmail: 'user@example.com',
								shippingPhone: '090-1111-2222',
								shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
								items: [
									{
										id: 'line-1',
										itemId: 10,
										name: 'Short Sleeveless Vest',
										imageUrl: null,
										color: 'BLACK',
										size: 'FREE',
										quantity: 1,
										amount: '¥24,800',
										stockStatus: 'in_stock',
									},
								],
								detailHref: '/account/orders/order-1',
							},
						],
					}),
				});
			});

			await page.goto('/account?tab=orders');

			await expect(page.getByText('ORD-0001')).toBeVisible();

			// AC-01 / AC-02
			const detailLink = page.getByRole('link', { name: '注文詳細' });
			await expect(detailLink).toBeVisible();
			await expect(detailLink).toHaveAttribute('href', '/account/orders/order-1');
		});
	});
}
