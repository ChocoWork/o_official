import { test, expect } from '@playwright/test';

// FREQ-69: /login の main を画面全体の高さにし、中心にフォームを配置。初期表示で Footer を見せないこと
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-016 auth full-height centered (${viewport.name})`, () => {
    test('main fills the viewport, form is centered and footer is not visible initially', async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');

      const vh = viewport.height;
      const main = await page.locator('#main-content').boundingBox();
      const footer = await page.locator('footer').boundingBox();
      const header = await page.locator('header').boundingBox();
      const card = await page.locator('#auth-panel').locator('xpath=..').boundingBox();
      expect(main).not.toBeNull();
      expect(footer).not.toBeNull();
      expect(card).not.toBeNull();

      // FREQ-69-AC-02: main の下端がビューポート下端に到達（main が画面下まで占める）
      expect(main!.y + main!.height).toBeGreaterThanOrEqual(vh - 1);

      // FREQ-69-AC-01: Footer の上端がビューポート下端以上（見えない）
      expect(footer!.y).toBeGreaterThanOrEqual(vh - 1);

      // FREQ-69-AC-03: フォームが縦方向にほぼ中央（ずれ 15% 以内）かつヘッダに重ならない
      const cardCenter = card!.y + card!.height / 2;
      expect(Math.abs(cardCenter - vh / 2)).toBeLessThanOrEqual(vh * 0.15);
      expect(card!.y).toBeGreaterThanOrEqual((header?.height ?? 0) - 1);
    });
  });
}
