import { test, expect } from '@playwright/test';

// FREQ-90: タブを下線デザイン化・外周のグレーカード枠を撤去・タブ内切替リンクを撤去すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-020 tab underline & no switch links (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('AC-01: タブが下線を持ち、タブ群を囲む角丸カード枠が無い', async ({ page }) => {
      // タブに可視の下線（border-bottom-width > 0）があること
      const loginTab = page.getByRole('tab', { name: 'ログイン' });
      const underline = await loginTab.evaluate(
        (el) => parseFloat(getComputedStyle(el).borderBottomWidth),
      );
      expect(underline).toBeGreaterThan(0);

      // tablist の親（外周コンテナ）に可視の囲み枠・角丸が無いこと
      // （Tailwind preflight は border-style:solid を全要素に付けるため width/radius で判定する）
      const wrapper = page.getByRole('tablist').locator('xpath=..');
      const outer = await wrapper.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          top: parseFloat(s.borderTopWidth),
          right: parseFloat(s.borderRightWidth),
          bottom: parseFloat(s.borderBottomWidth),
          left: parseFloat(s.borderLeftWidth),
          radius: parseFloat(s.borderTopLeftRadius),
        };
      });
      expect(outer.top).toBe(0);
      expect(outer.right).toBe(0);
      expect(outer.bottom).toBe(0);
      expect(outer.left).toBe(0);
      expect(outer.radius).toBe(0);
    });

    test('AC-04: タブの左右端が入力欄の左右端に整列している', async ({ page }) => {
      // 整列: タブの下線と入力欄の下線が同じ列（左右端）に揃うこと
      const edges = await page.evaluate(() => {
        const r = (el: Element) => el.getBoundingClientRect();
        const loginTab = document.querySelector('#auth-tab-login')!;
        const registerTab = document.querySelector('#auth-tab-register')!;
        const emailControl = document
          .querySelector('#email')!
          .closest('.text-field__control')!;
        return {
          leftDiff: r(loginTab).left - r(emailControl).left,
          rightDiff: r(registerTab).right - r(emailControl).right,
        };
      });
      expect(Math.abs(edges.leftDiff)).toBeLessThan(1);
      expect(Math.abs(edges.rightDiff)).toBeLessThan(1);
    });

    test('AC-02: ログインタブに「会員登録はこちら」ボタンが無い', async ({ page }) => {
      await expect(
        page.getByRole('button', { name: '会員登録はこちら' }),
      ).toHaveCount(0);
    });

    test('AC-03: 会員登録タブに「既にアカウントをお持ちの方はこちら」ボタンが無い', async ({ page }) => {
      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(
        page.getByRole('button', { name: '既にアカウントをお持ちの方はこちら' }),
      ).toHaveCount(0);
    });
  });
}
