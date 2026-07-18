import { test, expect } from '@playwright/test';

// FREQ-146: ホームの VIEW ALL ボタンは共通 Button UI（secondary）を使用し、
// 右矢印アイコンは表示しない。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const sectionIds = ['items', 'look', 'news'] as const;

test.describe('FR-HOME-012 view all buttons use common Button UI', () => {
  for (const viewport of viewports) {
    test(`${viewport.name}: VIEW ALL buttons use Button component without arrow icon`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (const sectionId of sectionIds) {
        const button = page.locator(
          `#${sectionId} [data-testid="home-section-view-all"]`,
        );

        // FREQ-146-AC-01: 共通 Button コンポーネント（secondary）で描画されていること
        await expect(button).toHaveAttribute('data-ui-button', 'true');
        await expect(button).toHaveAttribute(
          'data-ui-button-variant',
          'secondary',
        );

        // FREQ-146-AC-02: 右矢印アイコンが表示されないこと
        await expect(button.locator('.ri-arrow-right-line')).toHaveCount(0);
      }
    });
  }
});
