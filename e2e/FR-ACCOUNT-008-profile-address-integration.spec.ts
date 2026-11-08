import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// ファイル名は旧番号を維持する。住所入力の分離は現行要件のタブ構成と配送先入力を検証する。
test.describe('FR-ACCOUNT-001 / FR-ACCOUNT-004 shipping tab separation', () => {
	test('配送情報を独立タブに表示し、プロフィールタブから住所入力を分離する', async ({ page }) => {
		await mockOtpAuthentication(page);

		await page.route('**/api/profile', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					email: 'user@example.com',
						fullName: '',
						kanaName: '',
						phone: '',
					address: {
							postalCode: '',
							prefecture: '',
							city: '',
							address: '',
							building: '',
					},
				}),
			});
		});

		await page.route('**/api/orders', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: [] }),
			});
		});

		await loginAndOpenAccount(page);

		await expect(page.getByRole('tab', { name: 'お客様情報' })).toBeVisible();
		await expect(page.getByRole('tab', { name: '配送情報' })).toBeVisible();
		await expect(page.getByRole('tab', { name: '購入履歴' })).toBeVisible();
		await expect(page.getByLabel('郵便番号')).toHaveCount(0);

		await page.getByRole('tab', { name: '配送情報' }).click();
		await expect(page).toHaveURL(/tab=shipping/);
		await page.getByRole('button', { name: '+ 住所を追加', exact: true }).click();
		await expect(page.getByLabel('郵便番号')).toBeVisible();
		await expect(page.getByRole('combobox', { name: '都道府県' })).toBeVisible();
		await expect(page.getByLabel('市区町村')).toBeVisible();
		await expect(page.getByLabel('番地')).toBeVisible();
		await expect(page.getByLabel('建物名・部屋番号')).toBeVisible();

		await page.getByRole('tab', { name: 'お客様情報' }).click();
		await expect(page).toHaveURL(/tab=profile/);
		await expect(page.getByLabel('メールアドレス')).toHaveValue('user@example.com');
		await expect(page.getByLabel('郵便番号')).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: '都道府県' })).toHaveCount(0);
		await expect(page.getByLabel('市区町村')).toHaveCount(0);
		await expect(page.getByLabel('番地')).toHaveCount(0);
	});
});
