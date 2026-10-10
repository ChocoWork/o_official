import { test, expect } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { withReadyProgress } from './order-detail-fixtures';

// FREQ-80: 注文詳細ページの進捗バーに「支払い完了」ステップを追加し、
// ヘッダーの「ステータス」行と「合計（税込・送料込）」行を削除する
// AC-01: 進捗バーに 支払い完了/受注/発送/配達 の4ステップが表示され、先頭が「支払い完了」であること
// AC-02: paid の注文で 支払い完了・受注 が完了表示、発送・配達 が未完了表示であること
// AC-03: ヘッダーに「ステータス」ラベル行が表示されないこと
// AC-04: ヘッダーに「合計（税込・送料込）」が表示されないこと

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

for (const viewport of viewports) {
	test.describe(`FR-ACCOUNT-015 order detail progress steps (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('進捗バーがお支払いから始まる4ステップになり、ステータス行と合計行が表示されない', async ({ page }) => {
			await mockOtpAuthentication(page);

			await page.route('**/api/orders/order-1', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(withReadyProgress(orderDetail)),
				});
			});

			await page.goto('/account/orders/order-1');

			await expect(page.getByText('ORD-0001')).toBeVisible();

			// AC-01: 4ステップ表示・先頭はお支払い（2026-10-10 FREQ-444 で、段の名前を お支払い・発送準備中・配送中・配達済み に置き換え）
			const progress = page.getByRole('list', { name: '配送ステータス' });
			await expect(progress).toBeVisible();
			await expect(progress.getByText('お支払い', { exact: true })).toBeVisible();
			await expect(progress.getByText('発送準備中', { exact: true })).toBeVisible();
			await expect(progress.getByText('配送中', { exact: true })).toBeVisible();
			await expect(progress.getByText('配達済み', { exact: true })).toBeVisible();
			await expect(progress.locator('li').first()).toContainText('お支払い');

			// AC-02: 入金済みの在庫の品は お支払い・発送準備中 が済み・今の段（text-black）、配送中・配達済み がこれからの段（text-[#999]）
			await expect(progress.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
			await expect(progress.getByText('発送準備中', { exact: true })).toHaveClass(/text-black/);
			await expect(progress.getByText('配送中', { exact: true })).toHaveClass(/text-\[#999\]/);
			await expect(progress.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);

			// AC-03: ステータス行なし
			await expect(page.getByText('ステータス', { exact: true })).toHaveCount(0);

			// AC-04: 合計（税込・送料込）行なし
			await expect(page.getByText('合計（税込・送料込）')).toHaveCount(0);
		});
	});
}
