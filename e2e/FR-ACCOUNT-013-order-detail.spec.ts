import { test, expect } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

// FREQ-78: 注文詳細ページ（/account/orders/[id]）の表示項目
// AC-01: 注文番号・注文日時（時刻含む）が表示されること
// AC-02: 配送ステータス（進捗バー・日本語ラベル）が表示されること
// AC-03: 注文商品が購入履歴タブと同じ表示（商品名/カラー・サイズ/数量/金額/再購入ボタン）であること
// AC-04: 小計・送料・クーポン値引き・支払金額の4項目が表示されること
// AC-05: 配送先が表示されること
// AC-06: 支払方法が表示されること

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 800 },
];

const orderDetail = {
	id: 'order-1',
	orderNumber: 'ORD-0001',
	orderDate: '2026/04/01 09:00',
	status: 'paid',
	subtotalAmount: '¥12,000',
	shippingAmount: '¥500',
	discountAmount: '-¥1,000',
	totalAmount: '¥11,500',
	paymentMethod: 'クレジットカード',
	shippingFullName: '山田 花子',
	shippingEmail: 'user@example.com',
	shippingPhone: '090-1111-2222',
	shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3 青山ハイツ 101',
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

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-013 order detail (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('注文詳細ページに注文日時・注文番号・配送ステータス・商品・支払金額内訳・配送先・支払方法を表示する', async ({ page }) => {
			await mockOtpAuthentication(page);

			await page.route('**/api/orders/order-1', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(orderDetail),
				});
			});

			await page.goto('/account/orders/order-1');

			// AC-01: 注文番号・注文日時（時刻含む）
			await expect(page.getByText('ORD-0001')).toBeVisible();
			await expect(page.getByText('注文日時')).toBeVisible();
			await expect(page.getByText('2026/04/01 09:00')).toBeVisible();

			// AC-02: 配送ステータス（進捗バー・日本語ラベル）
			await expect(page.getByText('支払い完了')).toBeVisible();
			const progress = page.getByRole('list', { name: '配送ステータス' });
			await expect(progress).toBeVisible();
			await expect(progress.getByText('受注')).toBeVisible();
			await expect(progress.getByText('発送')).toBeVisible();
			await expect(progress.getByText('配達')).toBeVisible();

			// AC-03: 商品（購入履歴タブと同じ表示）
			await expect(page.getByText('Silk Blouse')).toBeVisible();
			await expect(page.getByText('Black / M')).toBeVisible();
			await expect(page.getByText('数量: 1')).toBeVisible();
			await expect(page.getByRole('button', { name: '再度購入' })).toBeVisible();

			// AC-04: 支払金額内訳（小計・送料・クーポン値引き・支払金額）
			await expect(page.getByText('小計', { exact: true })).toBeVisible();
			// ¥12,000 は商品金額と小計の2箇所に表示される
			await expect(page.getByText('¥12,000').first()).toBeVisible();
			await expect(page.getByText('送料', { exact: true })).toBeVisible();
			await expect(page.getByText('¥500', { exact: true })).toBeVisible();
			await expect(page.getByText('クーポン値引き')).toBeVisible();
			await expect(page.getByText('-¥1,000')).toBeVisible();
			await expect(page.getByRole('heading', { name: '支払金額' })).toBeVisible();
			await expect(page.getByText('¥11,500').first()).toBeVisible();

			// AC-05: 配送先（FREQ-83 以降は住所のみ表示）
			await expect(page.getByText('〒1500001 東京都 渋谷区 神宮前1-2-3 青山ハイツ 101')).toBeVisible();

			// AC-06: 支払方法
			await expect(page.getByRole('heading', { name: '支払方法' })).toBeVisible();
			await expect(page.getByText('クレジットカード', { exact: true })).toBeVisible();
		});
	});
}
