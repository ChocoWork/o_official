import { test, expect, Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-82: 注文詳細「ご注文商品」の窮屈さ解消
// （FREQ-87 によりモバイルは「商品情報列内・コンテンツ幅」に変更）
// AC-01: サムネイルと商品名の間に 8px 以上の間隔があること
// AC-02: mobile では再購入ボタンが商品情報（金額）より下にコンテンツ幅で表示されること
// AC-03: tablet/desktop では再購入ボタンが商品情報の右側（同じ行）に表示されること

const PNG_1PX_BLACK =
	'iVBORw0KGgoAAAABAAAAAQCAYAAAAf8/9hAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const orderDetail = {
	id: 'order-1',
	orderNumber: 'ORD-0001',
	orderDate: '2026/04/01 09:00',
	status: 'paid',
	subtotalAmount: '¥24,800',
	shippingAmount: '¥500',
	discountAmount: '¥0',
	totalAmount: '¥25,300',
	paymentMethod: 'クレジットカード',
	shippingFullName: '山田 花子',
	shippingEmail: 'user@example.com',
	shippingPhone: '090-1111-2222',
	shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
	items: [
		{
			id: 'line-1',
			itemId: 10,
			name: 'Short Sleeveless Vest',
			imageUrl: '/img/test-item.jpg',
			color: 'BLACK',
			size: 'FREE',
			quantity: 1,
			amount: '¥24,800',
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
	await page.route('**/_next/image**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'image/png',
			body: Buffer.from(PNG_1PX_BLACK, 'base64'),
		});
	});
	await page.route('**/img/test-item.jpg', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'image/png',
			body: Buffer.from(PNG_1PX_BLACK, 'base64'),
		});
	});
	await page.goto('/account/orders/order-1');
	await expect(page.getByText('ORD-0001')).toBeVisible();
}

test.describe('FR-ACCOUNT-017 order detail item spacing (mobile)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('mobile では画像とテキストに間隔があり、再購入ボタンが商品情報列内にコンテンツ幅で表示される', async ({ page }) => {
		await openOrderDetail(page);

		const imageBox = await page.getByRole('img', { name: 'Short Sleeveless Vest' }).boundingBox();
		const nameBox = await page.getByText('Short Sleeveless Vest', { exact: true }).boundingBox();
		const amountBox = await page.getByText('¥24,800', { exact: true }).first().boundingBox();
		const buttonBox = await page.getByRole('button', { name: '再度購入' }).boundingBox();
		expect(imageBox).not.toBeNull();
		expect(nameBox).not.toBeNull();
		expect(amountBox).not.toBeNull();
		expect(buttonBox).not.toBeNull();

		// AC-01: サムネイル右端と商品名左端の間隔 >= 8px
		expect(nameBox!.x - (imageBox!.x + imageBox!.width)).toBeGreaterThanOrEqual(8);

		// AC-02: ボタンは商品情報（金額）より下、商品名と同じ左軸、かつコンテンツ幅
		expect(buttonBox!.y).toBeGreaterThanOrEqual(amountBox!.y + amountBox!.height);
		expect(Math.abs(buttonBox!.x - nameBox!.x)).toBeLessThanOrEqual(2);
		expect(buttonBox!.width).toBeLessThan(200);
	});
});

for (const viewport of [
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
]) {
	test.describe(`FR-ACCOUNT-017 order detail item spacing (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('sm 以上では画像とテキストに間隔があり、再購入ボタンが商品情報の右側に表示される', async ({ page }) => {
			await openOrderDetail(page);

			const imageBox = await page.getByRole('img', { name: 'Short Sleeveless Vest' }).boundingBox();
			const nameBox = await page.getByText('Short Sleeveless Vest', { exact: true }).boundingBox();
			const buttonBox = await page.getByRole('button', { name: '再度購入' }).boundingBox();
			expect(imageBox).not.toBeNull();
			expect(nameBox).not.toBeNull();
			expect(buttonBox).not.toBeNull();

			// AC-01: サムネイル右端と商品名左端の間隔 >= 8px
			expect(nameBox!.x - (imageBox!.x + imageBox!.width)).toBeGreaterThanOrEqual(8);

			// AC-03: ボタンは商品名の右側かつ同じ行（縦位置が重なる）
			expect(buttonBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
			expect(buttonBox!.y).toBeLessThan(imageBox!.y + imageBox!.height);
		});
	});
}
