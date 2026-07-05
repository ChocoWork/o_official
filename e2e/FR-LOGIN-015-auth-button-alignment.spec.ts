import { test, expect } from '@playwright/test';

// FREQ-68: 近接・整列の原則に従い、操作ボタン（Google／主要CTA）のサイズを揃えること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const metrics = async (locator: import('@playwright/test').Locator) => {
  const fontSize = await locator.evaluate((el) => getComputedStyle(el).fontSize);
  const box = await locator.boundingBox();
  return { fontSize, height: Math.round(box?.height ?? 0) };
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-015 auth button alignment (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('google button and primary CTA share the same size on both tabs', async ({ page }) => {
      // login tab
      const loginGoogle = await metrics(page.getByRole('button', { name: /Google/ }));
      const loginPrimary = await metrics(
        page.getByRole('button', { name: 'ログイン', exact: true }),
      );

      // FREQ-68-AC-01: 同一フォーム内で Google と主要CTA が一致
      expect(loginGoogle.fontSize).toBe(loginPrimary.fontSize);
      expect(Math.abs(loginGoogle.height - loginPrimary.height)).toBeLessThanOrEqual(1);

      // register tab
      await page.getByRole('tab', { name: '会員登録' }).click();
      const regGoogle = await metrics(page.getByRole('button', { name: /Google/ }));
      const regPrimary = await metrics(
        page.getByRole('button', { name: '登録して確認メールを受け取る' }),
      );
      expect(regGoogle.fontSize).toBe(regPrimary.fontSize);
      expect(Math.abs(regGoogle.height - regPrimary.height)).toBeLessThanOrEqual(1);

      // FREQ-68-AC-02: タブ間で対応するボタンが一致
      expect(loginGoogle.fontSize).toBe(regGoogle.fontSize);
      expect(Math.abs(loginGoogle.height - regGoogle.height)).toBeLessThanOrEqual(1);
      expect(loginPrimary.fontSize).toBe(regPrimary.fontSize);
      expect(Math.abs(loginPrimary.height - regPrimary.height)).toBeLessThanOrEqual(1);
    });
  });
}
