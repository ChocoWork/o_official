import { test, expect, Page } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-99: お客様情報タブのラベル色を #767676 に統一し視認性・WCAG AA を満たす
const VIEWPORTS = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 900 },
];

const LABELS = ['氏名', 'フリガナ', 'メールアドレス', '電話番号'];

async function mockProfile(page: Page) {
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
					postalCode: '',
					prefecture: '',
					city: '',
					address: '',
					building: '',
				},
			}),
		});
	});
	await page.route('**/api/profile/addresses', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ addresses: [] }),
		});
	});
}

// sRGB → 相対輝度 → コントラスト比（WCAG 2.x）
function contrastOnWhite(rgb: string): number {
	const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
	return (1.0 + 0.05) / (L + 0.05);
}

for (const vp of VIEWPORTS) {
	test.describe(`FR-ACCOUNT-029 profile label contrast @ ${vp.name}`, () => {
		test('ラベルが #767676・コントラスト4.5:1以上、フォーカス時は黒', async ({ page }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await mockOtpAuthentication(page);
			await mockProfile(page);

			await loginAndOpenAccount(page);
			await page.goto('/account?tab=profile');

			// AC-01 / AC-02: 4ラベルすべて #767676 かつコントラスト 4.5:1 以上
			for (const label of LABELS) {
				const el = page.locator('.account-profile-view .text-field__leading-text', {
					hasText: label,
				});
				await expect(el).toBeVisible();
				await expect(el).toHaveCSS('color', 'rgb(118, 118, 118)');
				const color = await el.evaluate((n) => getComputedStyle(n).color);
				expect(contrastOnWhite(color)).toBeGreaterThanOrEqual(4.5);
			}

			// AC-03: 編集フォームでフォーカス中の編集可能フィールドのラベルは黒
			await page.getByRole('button', { name: '編集' }).click();
			const nameLabel = page.locator(
				'.account-profile-edit .text-field__leading-text',
				{ hasText: '氏名' },
			);
			await nameLabel
				.locator('xpath=ancestor::*[contains(@class,"text-field__control")]//input')
				.focus();
			await expect(nameLabel).toHaveCSS('color', 'rgb(0, 0, 0)');
		});
	});
}
