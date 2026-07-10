import { test, expect, Page } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-98: 配送情報タブのタイポグラフィ・余白・コンポーネントサイズ調整
// カードデザイン（FREQ-93）の配置はそのまま、
// 郵便番号=淡色キャプション / MAIN・MAINにする=同幅同サイズ / 住所追加=可読サイズ＋24px以上のタップ領域
const VIEWPORTS = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 768, height: 1024 },
	{ name: 'desktop', width: 1280, height: 900 },
];

async function mockTwoAddresses(page: Page) {
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
					{
						id: 'a2',
						postalCode: '5300001',
						prefecture: '大阪府',
						city: '大阪市北区',
						address: '梅田4-5-6',
						building: '',
						isDefault: false,
					},
				],
			}),
		});
	});
}

for (const vp of VIEWPORTS) {
	test.describe(`FR-ACCOUNT-028 shipping typography @ ${vp.name}`, () => {
		test('郵便番号キャプション・MAIN系の同寸・住所追加のタップ領域が調整されている', async ({
			page,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await mockOtpAuthentication(page);
			await mockTwoAddresses(page);

			await loginAndOpenAccount(page);
			await page.goto('/account?tab=shipping');
			await expect(page.locator('.account-address-row')).toHaveCount(2);

			// AC-01: 郵便番号は住所より小さい淡色（#767676）キャプション
			const postal = page.locator('.account-address-postal').first();
			const address = page
				.locator('.account-address-value > span:not(.account-address-postal)')
				.first();
			const postalFs = await postal.evaluate(
				(el) => parseFloat(getComputedStyle(el).fontSize),
			);
			const addressFs = await address.evaluate(
				(el) => parseFloat(getComputedStyle(el).fontSize),
			);
			expect(postalFs).toBeLessThan(addressFs);
			await expect(postal).toHaveCSS('color', 'rgb(118, 118, 118)');

			// AC-02: MAIN バッジと「MAINにする」ボタンは同幅・同 font-size（整列・反復）
			const badge = page.locator('.account-address-badge');
			const mainBtn = page.locator('.account-address-main-btn');
			await expect(badge).toBeVisible();
			await expect(mainBtn).toBeVisible();
			const badgeBox = await badge.boundingBox();
			const mainBtnBox = await mainBtn.boundingBox();
			expect(badgeBox).not.toBeNull();
			expect(mainBtnBox).not.toBeNull();
			expect(Math.abs((badgeBox?.width ?? 0) - (mainBtnBox?.width ?? 0))).toBeLessThan(1);
			const badgeFs = await badge.evaluate(
				(el) => parseFloat(getComputedStyle(el).fontSize),
			);
			const mainBtnFs = await mainBtn.evaluate(
				(el) => parseFloat(getComputedStyle(el).fontSize),
			);
			expect(Math.abs(badgeFs - mainBtnFs)).toBeLessThan(0.5);

			// AC-03: 「+ 住所を追加」はタップ領域 24px 以上・font-size 12px 以上
			const addBtn = page.getByRole('button', { name: /住所を追加/ });
			await expect(addBtn).toBeVisible();
			const addBox = await addBtn.boundingBox();
			expect(addBox?.height ?? 0).toBeGreaterThanOrEqual(24);
			const addFs = await addBtn.evaluate(
				(el) => parseFloat(getComputedStyle(el).fontSize),
			);
			expect(addFs).toBeGreaterThanOrEqual(12);
		});
	});
}
