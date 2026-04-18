import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-008 shipping tab separation', () => {
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

		await expect(page.getByRole('button', { name: 'プロフィール' })).toBeVisible();
		await expect(page.getByRole('button', { name: '配送情報' })).toBeVisible();
		await expect(page.getByRole('button', { name: '購入履歴' })).toBeVisible();
		await expect(page.getByLabel('郵便番号')).toHaveCount(0);

		await page.getByRole('button', { name: '配送情報' }).click();
		await expect(page.getByLabel('郵便番号')).toBeVisible();
		await expect(page.getByLabel('都道府県')).toBeVisible();
		await expect(page.getByLabel('市区町村')).toBeVisible();
		await expect(page.getByLabel('番地')).toBeVisible();
	});
});
