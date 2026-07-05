import { test, expect } from '@playwright/test';

// FREQ-70: パスワード再設定ページの見た目を /login と統一すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const radiusOf = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-001 visual consistency with login (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/password-reset');
    });

    test('has a rounded card and rounded submit button like login', async ({ page }) => {
      // FREQ-70-AC-01: 角丸カード枠＋角丸送信ボタン
      const card = page.locator('form').locator('xpath=..').locator('xpath=..');
      const submit = page.getByRole('button', { name: '再設定メールを送信' });
      expect(await radiusOf(card)).toBeGreaterThan(0);
      const btnRadius = await radiusOf(submit);
      expect(btnRadius).toBeGreaterThanOrEqual(4);
      expect(btnRadius).toBeLessThanOrEqual(12);
    });

    test('is centered full-height with footer not visible', async ({ page }) => {
      // FREQ-70-AC-02: Footer 非表示＋縦中央
      const vh = viewport.height;
      const footer = await page.locator('footer').boundingBox();
      const card = await page
        .locator('form')
        .locator('xpath=..')
        .locator('xpath=..')
        .boundingBox();
      expect(footer!.y).toBeGreaterThanOrEqual(vh - 1);
      const cardCenter = card!.y + card!.height / 2;
      expect(Math.abs(cardCenter - vh / 2)).toBeLessThanOrEqual(vh * 0.15);
    });

    test('heading uses the same font as login tabs and is the largest text (contrast)', async ({
      page,
    }) => {
      // FREQ-70-AC-04: 見出しは login タブと同じサンセリフ、かつ本文/入力より大きい
      const heading = page.getByRole('heading', { level: 1 });
      const headingFont = await heading.evaluate((el) => ({
        family: getComputedStyle(el).fontFamily,
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
      const inputSize = await page
        .locator('#email')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

      // login タブと同じ acumin-pro 系サンセリフ（Didot セリフでないこと）
      expect(headingFont.family.toLowerCase()).toContain('acumin-pro');
      expect(headingFont.family.toLowerCase()).not.toContain('didot');
      // 対比: 見出しが入力欄より大きい
      expect(headingFont.size).toBeGreaterThan(inputSize);
    });

    test('submit button is disabled until email is filled', async ({ page }) => {
      // FREQ-70-AC-03: 未入力時は無効、入力で有効
      const submit = page.getByRole('button', { name: '再設定メールを送信' });
      await expect(submit).toBeDisabled();
      await page.locator('#email').fill('test@example.com');
      await expect(submit).toBeEnabled();
    });
  });
}
