import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-85: 「この注文について問い合わせる」ボタンの位置と幅の改善
// AC-01: ボタンが支払金額セクションの直下に表示されること
// AC-02: ボタンの幅が支払金額カードと同幅であること
// AC-03: desktop でボタンが右カラム（支払金額と同じ列）に表示されること
// AC-04: desktop でページコンテナが設計幅（1152px）まで拡がること

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

function paymentSectionBox(page: Page) {
	return page
		.locator('section', { has: page.getByRole('heading', { name: '支払金額', exact: true }) })
		.first()
		.boundingBox();
}

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-020 order detail contact button (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('問い合わせボタンが支払金額直下にサマリーと同幅で表示される', async ({ page }) => {
			await openOrderDetail(page);

			const paymentBox = await paymentSectionBox(page);
			const buttonBox = await page
				.getByRole('link', { name: 'この注文について問い合わせる' })
				.boundingBox();
			expect(paymentBox).not.toBeNull();
			expect(buttonBox).not.toBeNull();

			// AC-01: 支払金額セクションの直下
			expect(buttonBox!.y).toBeGreaterThanOrEqual(paymentBox!.y + paymentBox!.height);

			// AC-02: 支払金額カードと同幅（±2px）
			expect(Math.abs(buttonBox!.width - paymentBox!.width)).toBeLessThanOrEqual(2);
			expect(Math.abs(buttonBox!.x - paymentBox!.x)).toBeLessThanOrEqual(2);

			if (viewport.width >= 1024) {
				// AC-03: 右カラム（画面中央より右）に配置
				expect(buttonBox!.x).toBeGreaterThan(viewport.width / 2);

				// AC-04: コンテナが設計幅（max-w-6xl = 1152px）まで拡がる
				const containerWidth = await page.evaluate(() => {
					const el = document.querySelector('.account-page');
					return el ? el.getBoundingClientRect().width : 0;
				});
				expect(containerWidth).toBeGreaterThanOrEqual(1100);
			}
		});
	});
}
