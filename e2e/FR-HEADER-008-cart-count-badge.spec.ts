import { expect, test, type Page } from '@playwright/test';

/**
 * FREQ-309 ヘッダーのカート点数バッジ。
 * 共通 UI コンポーネント StatusBadge（variant="count" / size="md"）を使う。
 */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const badgeOf = (page: Page) =>
  page.locator('header [data-ui-badge-variant="count"]');
const cartIconOf = (page: Page) =>
  page.locator('header .ri-shopping-bag-line');

test.describe('FR-HEADER-008 header cart count badge', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）でカート点数がバッジで示される`, async ({
      page,
    }) => {
      let quantity = 3;
      await page.route('**/api/cart', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(quantity > 0 ? [{ quantity }] : []),
        }),
      );

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // AC-01: 点数のバッジが1つだけ出る
      const badge = badgeOf(page);
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveText('3');

      // AC-02: 1桁は正円
      const single = await badge.boundingBox();
      expect(single).not.toBeNull();
      if (single) {
        expect(Math.abs(single.width - single.height)).toBeLessThanOrEqual(1);
      }

      // AC-04: 右上の角にまたがり、白のリングで分離する
      const icon = await cartIconOf(page).boundingBox();
      expect(icon).not.toBeNull();
      if (icon && single) {
        expect(Math.abs(single.x + single.width / 2 - (icon.x + icon.width))).toBeLessThanOrEqual(2);
        expect(Math.abs(single.y + single.height / 2 - icon.y)).toBeLessThanOrEqual(2);
      }
      const shadow = await badge.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(shadow).toContain('rgb(255, 255, 255)');

      // AC-02: 2桁も正円
      quantity = 12;
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(badge).toHaveText('12');
      const double = await badge.boundingBox();
      expect(double).not.toBeNull();
      if (double) {
        expect(Math.abs(double.width - double.height)).toBeLessThanOrEqual(1);
      }

      // AC-03: 99 を超えたら 99+
      quantity = 128;
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(badge).toHaveText('99+');

      // AC-05: 空のカートではバッジを出さない
      quantity = 0;
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(badge).toHaveCount(0);
    });
  }
});
