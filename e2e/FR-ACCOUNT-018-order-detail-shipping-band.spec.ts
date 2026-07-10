import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-83: 配送先情報・支払方法をヘッダー直下の全幅横長バンドへ移動
// AC-01: 配送先情報と支払方法がご注文商品より上に表示されること
// AC-02: sm 以上で配送先情報と支払方法が横並びであること
// AC-03: 配送先情報に住所のみ表示（氏名・メール・電話は非表示）

const orderDetail = {
	id: 'order-1',
	orderNumber: 'ORD-0001',
	orderDate: '2026/04/01 09:00',
	status: 'paid',
	subtotalAmount: '¥12,000',
	shippingAmount: '¥500',
	discountAmount: '¥0',
	totalAmount: '¥12,500',
	paymentMethod: 'クレジットカード',
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
			color: 'Black',
			size: 'M',
			quantity: 1,
			amount: '¥12,000',
			stockStatus: 'in_stock',
		},
	],
};

async function openOrderDetail(page: Page) {
	await mockOtpAuthentication(page);
	await page.route('**/api/orders/order-1', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(orderDetail),
		});
	});
	await page.goto('/account/orders/order-1');
	await expect(page.getByText('ORD-0001')).toBeVisible();
}

function sectionBox(page: Page, heading: string) {
	return page
		.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })
		.first()
		.boundingBox();
}

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-018 order detail shipping band (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('配送先情報と支払方法がヘッダー直下にあり、配送先は住所のみ表示される', async ({ page }) => {
			await openOrderDetail(page);

			const shippingBox = await sectionBox(page, '配送先情報');
			const paymentMethodBox = await sectionBox(page, '支払方法');
			const itemsBox = await sectionBox(page, 'ご注文商品');
			expect(shippingBox).not.toBeNull();
			expect(paymentMethodBox).not.toBeNull();
			expect(itemsBox).not.toBeNull();

			// AC-01: ご注文商品より上に表示
			expect(shippingBox!.y + shippingBox!.height).toBeLessThanOrEqual(itemsBox!.y);
			expect(paymentMethodBox!.y + paymentMethodBox!.height).toBeLessThanOrEqual(itemsBox!.y);

			if (viewport.width >= 640) {
				// AC-02: sm 以上は横並び（支払方法が配送先情報の右）
				expect(paymentMethodBox!.x).toBeGreaterThanOrEqual(shippingBox!.x + shippingBox!.width);
			} else {
				// sm 未満は縦積み
				expect(paymentMethodBox!.y).toBeGreaterThanOrEqual(shippingBox!.y + shippingBox!.height);
			}

			// AC-03: 住所のみ表示（氏名・メール・電話は非表示）
			await expect(page.getByText('〒1500001 東京都 渋谷区 神宮前1-2-3')).toBeVisible();
			await expect(page.getByText('山田 花子')).toHaveCount(0);
			await expect(page.getByText('user@example.com')).toHaveCount(0);
			await expect(page.getByText('090-1111-2222')).toHaveCount(0);
		});
	});
}
