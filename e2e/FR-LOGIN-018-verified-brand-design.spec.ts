import { test, expect } from '@playwright/test';

// FREQ-73: 認証確認ページ（/auth/verified）をブランド世界観に沿って刷新すること
// 未認証でアクセスすると unauthenticated 状態（安定）になるため、その状態で検証する。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-018 verified brand design (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/verified');
      // 認証解決後、未認証ゲートの導線が出るのを待つ
      await expect(
        page.locator('#main-content').getByRole('link', { name: 'ログインページへ' }),
      ).toBeVisible();
    });

    test('heading "Le Fil des Heures" uses the brand Didot serif font', async ({ page }) => {
      const heading = page.locator('#main-content').getByRole('heading', { name: 'Le Fil des Heures' });
      await expect(heading).toBeVisible();

      // FREQ-73-AC-01: Didot 系セリフ
      const fontFamily = await heading.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
      expect(fontFamily).toContain('didot');
    });

    test('shows the thread hairline motif below the heading', async ({ page }) => {
      // FREQ-73-AC-04: 糸モチーフの細いヘアライン（幅1pxの縦線）
      const hairline = page.locator('#main-content span[aria-hidden="true"]').first();
      await expect(hairline).toBeVisible();
      const width = await hairline.evaluate((el) => el.getBoundingClientRect().width);
      expect(width).toBeLessThanOrEqual(2);
    });

    test('login link points to /login', async ({ page }) => {
      // FREQ-73-AC-02
      await expect(
        page.locator('#main-content').getByRole('link', { name: 'ログインページへ' }),
      ).toHaveAttribute('href', '/login');
    });

    test('gate is vertically centered and footer is not visible', async ({ page }) => {
      const vh = viewport.height;

      // FREQ-73-AC-03: Footer が見えない（レイアウト確定を待ってポーリング）
      await expect
        .poll(async () => {
          const box = await page.locator('footer').boundingBox();
          return box ? box.y : 0;
        })
        .toBeGreaterThanOrEqual(vh - 1);

      const heading = await page
        .locator('#main-content')
        .getByRole('heading', { name: 'Le Fil des Heures' })
        .boundingBox();
      expect(heading!.y).toBeGreaterThan(vh * 0.15);
      expect(heading!.y).toBeLessThan(vh * 0.7);
    });

    test('heading is larger than the body message (contrast)', async ({ page }) => {
      // FREQ-73-AC-05
      const fontPx = (loc: import('@playwright/test').Locator) =>
        loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      const headingSize = await fontPx(
        page.locator('#main-content').getByRole('heading', { name: 'Le Fil des Heures' }),
      );
      const messageSize = await fontPx(
        page.locator('#main-content').getByText('ログインが必要です。', { exact: false }),
      );
      expect(headingSize).toBeGreaterThan(messageSize);
    });
  });
}
