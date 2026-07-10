import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-88: 購入履歴タブの年別タイムライン表示
// AC-01: 購入履歴タブに注文年（例: 2026）の見出しが表示されること
// AC-02: 各注文行に注文番号・合計金額・ステータス・注文日が表示されること
// AC-03: 注文行のリンク先が /account/orders/{注文ID} であること
// AC-04: 購入履歴タブに「再度購入」ボタンおよび商品名の明細行が表示されないこと

const orders = {
	data: [
		{
			id: 'order-1',
			orderNumber: 'LFH-260512-00123',
			orderDate: '2026/05/12',
			status: '決済完了',
			totalAmount: '¥64,900',
			itemCount: 1,
			shippingFullName: '山田 花子',
			shippingEmail: 'user@example.com',
			shippingPhone: '090-1111-2222',
			shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
			items: [
				{
					id: 'line-1',
					itemId: 10,
					name: 'Silk Blouse',
					imageUrl: null,
					color: 'BLACK',
					size: 'FREE',
					quantity: 1,
					amount: '¥64,900',
					stockStatus: 'in_stock',
				},
			],
			detailHref: '/account/orders/order-1',
		},
		{
			id: 'order-2',
			orderNumber: 'LFH-251205-00081',
			orderDate: '2025/12/05',
			status: 'キャンセル',
			totalAmount: '¥31,900',
			itemCount: 1,
			shippingFullName: '山田 花子',
			shippingEmail: 'user@example.com',
			shippingPhone: '090-1111-2222',
			shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
			items: [
				{
					id: 'line-2',
					itemId: 11,
					name: 'Wool Coat',
					imageUrl: null,
					color: 'ECRU',
					size: 'FREE',
					quantity: 1,
					amount: '¥31,900',
					stockStatus: 'in_stock',
				},
			],
			detailHref: '/account/orders/order-2',
		},
	],
};

async function openOrdersTab(page: Page) {
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
				address: {},
			}),
		});
	});
	await page.route('**/api/orders', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(orders),
		});
	});
	await page.goto('/account?tab=orders');
	await expect(page.getByText('LFH-260512-00123')).toBeVisible();
}

for (const viewport of [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
]) {
	test.describe(`FR-ACCOUNT-023 order history timeline (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('年見出しと注文行（番号・金額・ステータス・注文日）が表示される', async ({ page }) => {
			await openOrdersTab(page);

			// AC-01: 注文年の見出しが年ごとに表示される
			await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();
			await expect(page.getByRole('heading', { name: '2025' })).toBeVisible();

			// AC-02: 注文行に注文番号・合計金額・ステータス・注文日が表示される
			const row = page.getByRole('link', { name: /LFH-260512-00123/ });
			await expect(row).toBeVisible();
			await expect(row.getByText('¥64,900')).toBeVisible();
			await expect(row.getByText('決済完了')).toBeVisible();
			await expect(row.getByText('2026.05.12')).toBeVisible();

			// AC-03: 行全体が注文詳細へのリンク
			await expect(row).toHaveAttribute('href', '/account/orders/order-1');
			await expect(
				page.getByRole('link', { name: /LFH-251205-00081/ }),
			).toHaveAttribute('href', '/account/orders/order-2');

			// AC-04: 商品明細（再度購入ボタン・商品名）は表示されない
			await expect(page.getByRole('button', { name: '再度購入' })).toHaveCount(0);
			await expect(page.getByText('Silk Blouse')).toHaveCount(0);
		});
	});
}
