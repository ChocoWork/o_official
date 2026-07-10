import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-81: 注文詳細ページのレスポンシブ最適化（lg 以上で 61.8% : 38.2% の2カラム）
// AC-01: desktop でご注文商品と支払金額が横並びであること
// AC-02: mobile / tablet では縦積みであること
// AC-03: 横スクロールが発生しないこと

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

test.describe('FR-ACCOUNT-016 order detail responsive (desktop)', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('desktop ではご注文商品と支払金額（決済サマリー）が2カラムで横並びになる', async ({ page }) => {
		await openOrderDetail(page);

		const itemsBox = await sectionBox(page, 'ご注文商品');
		const paymentBox = await sectionBox(page, '支払金額');
		expect(itemsBox).not.toBeNull();
		expect(paymentBox).not.toBeNull();

		// AC-01: 支払金額の左端がご注文商品の右端以上（横並び）
		expect(paymentBox!.x).toBeGreaterThanOrEqual(itemsBox!.x + itemsBox!.width);
		// 主従比: ご注文商品カラムの方が広い
		expect(itemsBox!.width).toBeGreaterThan(paymentBox!.width);

		// AC-03: 横スクロールなし
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(1280);
	});
});

for (const viewport of [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
]) {
	test.describe(`FR-ACCOUNT-016 order detail responsive (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('lg 未満ではご注文商品の下に支払金額が縦積みで表示される', async ({ page }) => {
			await openOrderDetail(page);

			const itemsBox = await sectionBox(page, 'ご注文商品');
			const paymentBox = await sectionBox(page, '支払金額');
			expect(itemsBox).not.toBeNull();
			expect(paymentBox).not.toBeNull();

			// AC-02: 縦積み（支払金額がご注文商品の下）
			expect(paymentBox!.y).toBeGreaterThanOrEqual(itemsBox!.y + itemsBox!.height);

			// AC-03: 横スクロールなし
			const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
		});
	});
}
