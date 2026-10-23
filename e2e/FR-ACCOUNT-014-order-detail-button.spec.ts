import { test, expect } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { withReadyProgress } from './order-detail-fixtures';

// FREQ-88（FREQ-79 の「注文詳細」ボタンを置き換え）: 購入履歴の注文行は、行全体が注文詳細ページへのリンク
// AC-01: 注文番号を含む行がリンクで、リンク先が /account/orders/{注文ID} であること
// AC-02: 行を押すと、その注文の注文詳細ページへ移ること

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
];

function orderSummary(id: string, orderNumber: string, orderDate: string) {
	return {
		id,
		orderNumber,
		orderDate,
		status: '決済完了',
		totalAmount: '¥59,600',
		itemCount: 2,
		shippingFullName: '山田 花子',
		shippingEmail: 'user@example.com',
		shippingPhone: '090-1111-2222',
		shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
		items: [
			{
				id: `${id}-line-1`,
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
		detailHref: `/account/orders/${id}`,
	};
}

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-014 order row link (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('購入履歴の注文行全体が注文詳細ページへのリンクで、押すとその注文の詳細へ移る', async ({ page }) => {
			await mockOtpAuthentication(page);

			await page.route('**/api/orders', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						data: [
							orderSummary('order-1', 'ORD-0001', '2026/07/05'),
							orderSummary('order-2', 'ORD-0002', '2026/06/20'),
						],
					}),
				});
			});

			await page.route('**/api/orders/order-1', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(
						withReadyProgress({
							id: 'order-1',
							orderNumber: 'ORD-0001',
							orderDate: '2026-07-05',
							status: 'paid',
							totalAmount: '¥59,600',
							shippingAddress: '東京都渋谷区神宮前1-2-3 青山ハイツ 101',
							items: [
								{ id: 'line-1', name: 'Short Sleeveless Vest', quantity: 1, color: 'BLACK', size: 'FREE', amount: '¥24,800' },
							],
						}),
					),
				});
			});

			await page.goto('/account?tab=orders');

			// AC-01: 注文番号を含む行がリンクで、行ごとに自分の注文詳細を指す
			const orderRow = page.getByRole('link', { name: /ORD-0001/ });
			await expect(orderRow).toBeVisible();
			await expect(orderRow).toHaveAttribute('href', '/account/orders/order-1');
			await expect(page.getByRole('link', { name: /ORD-0002/ })).toHaveAttribute(
				'href',
				'/account/orders/order-2',
			);
			// FREQ-79 の独立した「注文詳細」ボタンは無い
			await expect(page.getByRole('link', { name: '注文詳細', exact: true })).toHaveCount(0);

			// AC-02: 行を押すとその注文の詳細へ移る
			await orderRow.click();
			await expect(page).toHaveURL(/\/account\/orders\/order-1$/);
			await expect(page.getByRole('heading', { name: '注文詳細' })).toBeVisible();
			await expect(page.getByText('東京都渋谷区神宮前1-2-3 青山ハイツ 101')).toBeVisible();
		});
	});
}
