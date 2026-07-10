import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-93: 配送情報タブの配送先カードのデザイン
// 上部右「MAIN」バッジ＋郵便番号と住所を1行結合＋「編集」「削除」
const VIEWPORTS = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 900 },
];

async function mockShippingProfile(page: import('@playwright/test').Page) {
	await page.route('**/api/profile', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				email: 'user@example.com',
				fullName: '山田 太郎',
				kanaName: 'ヤマダ タロウ',
				phone: '09012345678',
				address: {
					postalCode: '9813351',
					prefecture: '宮城県',
					city: '富谷市',
					address: '鷹乃杜202号',
					building: '',
				},
			}),
		});
	});

	await page.route('**/api/profile/addresses', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				addresses: [
					{
						id: 'a1',
						postalCode: '9813351',
						prefecture: '宮城県',
						city: '富谷市',
						address: '鷹乃杜202号',
						building: '',
						isDefault: true,
					},
				],
			}),
		});
	});
}

for (const vp of VIEWPORTS) {
	test.describe(`FR-ACCOUNT-024 shipping card design @ ${vp.name}`, () => {
		test('MAINバッジ・結合住所・編集/削除ボタンが表示される', async ({ page }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await mockOtpAuthentication(page);
			await mockShippingProfile(page);

			await loginAndOpenAccount(page);
			await page.goto('/account?tab=shipping');

			// AC-01: 上部右「MAIN」バッジ。左「メイン」ラベルは無し
			await expect(page.getByText('MAIN', { exact: true })).toBeVisible();
			await expect(page.getByText('メイン', { exact: true })).toHaveCount(0);

			// AC-02: 郵便番号・住所を表示、「郵便番号」「住所」の個別ラベルは無し
			await expect(page.getByText('981-3351', { exact: true })).toBeVisible();
			await expect(
				page.getByText('宮城県富谷市鷹乃杜202号', { exact: true }),
			).toBeVisible();
			await expect(page.getByText('郵便番号', { exact: true })).toHaveCount(0);
			await expect(page.getByText('住所', { exact: true })).toHaveCount(0);

			// AC-03: 「編集」「削除」ボタン
			await expect(page.getByRole('button', { name: '編集' })).toBeVisible();
			await expect(page.getByRole('button', { name: '削除' })).toBeVisible();
		});
	});
}
