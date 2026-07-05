import { test, expect } from '@playwright/test';

// FREQ-72: 未ログイン時のアカウントページUIをブランド世界観に沿って刷新すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-012 login gate brand design (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/account');
      // 認証解決後のゲート描画を待つ
      await expect(page.getByRole('heading', { name: 'ACCOUNT' })).toBeVisible();
    });

    test('heading "ACCOUNT" uses the brand Didot serif font, no generic user icon in content', async ({ page }) => {
      const heading = page.getByRole('heading', { name: 'ACCOUNT' });

      // FREQ-72-AC-01: Didot 系セリフ
      const fontFamily = await heading.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
      expect(fontFamily).toContain('didot');

      // FREQ-72-AC-02: コンテンツ領域に汎用ユーザーアイコンが無い（ヘッダーのナビアイコンは対象外）
      expect(await page.locator('#main-content i.ri-user-line').count()).toBe(0);
    });

    test('gate is vertically centered and footer is not visible', async ({ page }) => {
      const vh = viewport.height;

      // FREQ-72-AC-03: Footer が見えない（レイアウト確定を待ってポーリング）
      await expect
        .poll(async () => {
          const box = await page.locator('footer').boundingBox();
          return box ? box.y : 0;
        })
        .toBeGreaterThanOrEqual(vh - 1);

      const heading = await page.getByRole('heading', { name: 'ACCOUNT' }).boundingBox();
      expect(heading!.y).toBeGreaterThan(vh * 0.15);
      expect(heading!.y).toBeLessThan(vh * 0.7);
    });

    test('heading is the largest text in the gate (contrast)', async ({ page }) => {
      // FREQ-72-AC-05: 見出しが説明文・CTAより大きい
      const fontPx = (loc: import('@playwright/test').Locator) =>
        loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      const headingSize = await fontPx(page.getByRole('heading', { name: 'ACCOUNT' }));
      const messageSize = await fontPx(
        page.locator('#main-content').getByText('会員情報の確認には、ログインが必要です。'),
      );
      const ctaSize = await fontPx(
        page.locator('#main-content').getByRole('link', { name: 'ログイン' }),
      );
      expect(headingSize).toBeGreaterThan(messageSize);
      expect(headingSize).toBeGreaterThan(ctaSize);
    });

    test('login CTA links to /login', async ({ page }) => {
      // FREQ-72-AC-04（ヘッダーのナビリンクと区別するためコンテンツ領域に絞る）
      await expect(
        page.locator('#main-content').getByRole('link', { name: 'ログイン' }),
      ).toHaveAttribute('href', '/login');
    });
  });
}
