import { test, expect } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';

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

		test('進捗バーが支払い完了から始まる4ステップになり、ステータス行と合計行が表示されない', async ({ page }) => {
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

			// AC-01: 4ステップ表示・先頭は支払い完了
			const progress = page.getByRole('list', { name: '配送ステータス' });
			await expect(progress).toBeVisible();
			await expect(progress.getByText('支払い完了')).toBeVisible();
			await expect(progress.getByText('受注')).toBeVisible();
			await expect(progress.getByText('発送')).toBeVisible();
			await expect(progress.getByText('配達')).toBeVisible();
			await expect(progress.locator('li').first()).toContainText('支払い完了');

			// AC-02: paid は 支払い完了・受注 が完了表示（text-black）、発送・配達 が未完了表示（text-[#999]）
			await expect(progress.getByText('支払い完了')).toHaveClass(/text-black/);
			await expect(progress.getByText('受注')).toHaveClass(/text-black/);
			await expect(progress.getByText('発送')).toHaveClass(/text-\[#999\]/);
			await expect(progress.getByText('配達')).toHaveClass(/text-\[#999\]/);

			// AC-03: ステータス行なし
			await expect(page.getByText('ステータス', { exact: true })).toHaveCount(0);

			// AC-04: 合計（税込・送料込）行なし
			await expect(page.getByText('合計（税込・送料込）')).toHaveCount(0);
		});
	});
}
