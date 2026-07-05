import { test, expect } from '@playwright/test';

// FREQ-62: 認証ページ下部の区切り線と切替文言の間に十分な余白を設け、規約同意文を自然に折り返すこと
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const pages = [
  { path: '/login', switchText: 'アカウントをお持ちでない方は' },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-010 auth footer spacing (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    for (const target of pages) {
      test(`separator has breathing room above the switch text on ${target.path}`, async ({ page }) => {
        await page.goto(target.path);

        // FREQ-62-AC-01: 区切り線と切替文言の縦間隔が21px以上
        const separator = page.locator('#auth-panel hr');
        const switchText = page.getByText(target.switchText);
        await expect(separator).toBeVisible();
        await expect(switchText).toBeVisible();

        const separatorBox = await separator.boundingBox();
        const textBox = await switchText.boundingBox();
        expect(separatorBox).not.toBeNull();
        expect(textBox).not.toBeNull();
        const gap = textBox!.y - (separatorBox!.y + separatorBox!.height);
        expect(gap).toBeGreaterThanOrEqual(21);
      });

      test(`terms note wraps naturally without forced breaks on ${target.path}`, async ({ page }) => {
        await page.goto(target.path);

        // FREQ-62-AC-02: 規約同意文に強制改行（br要素）が含まれない
        const terms = page.locator('p', { hasText: '続行することで、' });
        await expect(terms).toBeVisible();
        await expect(terms.locator('br')).toHaveCount(0);
      });
    }
  });
}
