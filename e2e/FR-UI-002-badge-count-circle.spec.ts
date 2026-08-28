import { expect, test } from '@playwright/test';

/**
 * FREQ-308 StatusBadge（カウント／ドット）の寸法。
 * 直径 = font × √φ、数字 = 直径 ÷ φ、ドット = 直径 ÷ φ²。
 */
const PHI = 1.618;

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-UI-002 Badge count geometry', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）でカウントバッジが黄金比の円になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/ui');
      await page.waitForLoadState('networkidle');

      const badgeSection = page
        .locator('h2')
        .filter({ hasText: /^Badge$/ })
        .locator('xpath=..');
      const counts = badgeSection.locator('[data-ui-badge-variant="count"]');
      await expect(counts).toHaveCount(3);

      const single = counts.nth(0);
      const double = counts.nth(1);
      const overflow = counts.nth(2);

      // AC-01: 1桁も2桁も正円
      for (const badge of [single, double]) {
        const box = await badge.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
        }
      }
      await expect(single).toHaveText('3');
      await expect(double).toHaveText('12');

      // AC-02: 数字の font-size ÷ 直径 = 1/φ
      const circle = await double.boundingBox();
      const fontSize = await double.evaluate(
        (el) => Number.parseFloat(getComputedStyle(el).fontSize),
      );
      expect(circle).not.toBeNull();
      if (circle) {
        expect(fontSize / circle.height).toBeCloseTo(1 / PHI, 2);
      }

      // AC-03: 上限超過は 99+ の pill
      await expect(overflow).toHaveText('99+');
      const overflowBox = await overflow.boundingBox();
      expect(overflowBox).not.toBeNull();
      if (overflowBox) {
        expect(overflowBox.width).toBeGreaterThan(overflowBox.height);
      }

      // AC-04: 地色（白）のリング
      const dot = badgeSection.locator('[data-ui-badge-variant="dot"]').first();
      for (const badge of [double, dot]) {
        const shadow = await badge.evaluate((el) => getComputedStyle(el).boxShadow);
        expect(shadow).toContain('rgb(255, 255, 255)');
      }

      // AC-05: ドットの直径 = カウントの直径 ÷ φ²
      const dotBox = await dot.boundingBox();
      expect(dotBox).not.toBeNull();
      if (dotBox && circle) {
        expect(dotBox.width / circle.height).toBeCloseTo(1 / (PHI * PHI), 2);
      }
    });
  }
});
