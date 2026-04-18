import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-009 authenticated profile fetch', () => {
	test('認証付きでプロフィールを取得し、ログイン中メールアドレスを表示する', async ({ page }) => {
		await mockOtpAuthentication(page);

		let profileAuthorizationHeader: string | null = null;

		await page.route('**/api/profile', async (route) => {
			profileAuthorizationHeader = route.request().headers().authorization ?? null;

			if (!profileAuthorizationHeader?.startsWith('Bearer test-access-token')) {
				await route.fulfill({
					status: 401,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Unauthorized' }),
				});
				return;
			}

			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					email: 'user@example.com',
					fullName: '山田 花子',
					kanaName: 'ヤマダ ハナコ',
					phone: '090-1111-2222',
					address: {
						postalCode: '1500001',
						prefecture: '東京都',
						city: '渋谷区',
						address: '神宮前1-2-3',
						building: '青山ハイツ 101',
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

		await expect.poll(() => profileAuthorizationHeader).toContain('Bearer test-access-token');
		await expect(page.getByText('メールアドレス')).toBeVisible();
		await expect(page.getByText('user@example.com')).toBeVisible();
		await expect(page.getByText('プロフィールを読み込めませんでした')).toHaveCount(0);
	});
});