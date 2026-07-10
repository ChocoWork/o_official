import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-84: 配送ステータスバーのモバイル崩れ改善
// AC-01: 375px / 390px でステップラベルが折り返されず1行で表示されること
// AC-02: sm 未満でラベルが丸数字の下に表示されること
// AC-03: sm 以上でラベルが丸数字の右（同じ行）に表示されること
// AC-04: 375px で横スクロールが発生しないこと

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

async function stepBoxes(page: Page, label: string) {
	const progress = page.getByRole('list', { name: '配送ステータス' });
	const step = progress.locator('li').filter({ hasText: label });
	const circleBox = await step.locator('span[aria-hidden="true"]').boundingBox();
	const labelBox = await step.getByText(label).boundingBox();
	return { circleBox, labelBox };
}

for (const viewport of [
	{ name: 'iPhone SE', width: 375, height: 667 },
	{ name: 'mobile', width: 390, height: 844 },
]) {
	test.describe(`FR-ACCOUNT-019 order detail stepper (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('sm 未満はラベルが丸数字の下に1行で表示され、横スクロールが発生しない', async ({ page }) => {
			await openOrderDetail(page);

			for (const label of ['支払い完了', '受注', '発送', '配達']) {
				const { circleBox, labelBox } = await stepBoxes(page, label);
				expect(circleBox).not.toBeNull();
				expect(labelBox).not.toBeNull();

				// AC-01: 1行表示（2行になると高さが2倍近くになる）
				expect(labelBox!.height).toBeLessThan(25);

				// AC-02: ラベルは丸数字の下
				expect(labelBox!.y).toBeGreaterThanOrEqual(circleBox!.y + circleBox!.height);
			}

			// AC-04: 横スクロールなし
			const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
		});
	});
}

for (const viewport of [
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
]) {
	test.describe(`FR-ACCOUNT-019 order detail stepper (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('sm 以上はラベルが丸数字の右に同じ行で表示される', async ({ page }) => {
			await openOrderDetail(page);

			for (const label of ['支払い完了', '受注', '発送', '配達']) {
				const { circleBox, labelBox } = await stepBoxes(page, label);
				expect(circleBox).not.toBeNull();
				expect(labelBox).not.toBeNull();

				// AC-03: ラベルは丸数字の右かつ縦位置が重なる（同じ行）
				expect(labelBox!.x).toBeGreaterThanOrEqual(circleBox!.x + circleBox!.width);
				expect(labelBox!.y).toBeLessThan(circleBox!.y + circleBox!.height);
			}
		});
	});
}
