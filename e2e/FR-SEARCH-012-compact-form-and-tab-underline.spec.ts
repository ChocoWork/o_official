import { expect, test } from '@playwright/test';

// FREQ-192: 検索フォームと予測候補の縦幅を詰め、種別フィルタの下線を
// ヘッダーナビと同じ underline-animation-left2right に統一する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-012 フォーム圧縮とタブ下線', () => {
  test('AC-01 フォームと候補行の高さが詰まっている', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/search');

    const input = page.locator('input[type="search"]');
    await input.click();
    await input.pressSequentially('co', { delay: 60 });
    await page.waitForSelector('#search-suggestion-list');
    await expect(page.locator('[role="option"]').first()).toBeVisible();

    const formBox = await page.locator('form').first().boundingBox();
    expect(formBox!.height).toBeGreaterThanOrEqual(36);
    expect(formBox!.height).toBeLessThan(44);

    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    for (let index = 0; index < optionCount; index += 1) {
      const box = await options.nth(index).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.height).toBeLessThan(44);
    }
  });

  for (const vp of VIEWPORTS) {
    test(`AC-02/AC-03 ${vp.name} タブの下線がヘッダーナビと同じ挙動`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();

      const activeTab = page.getByRole('tab', { name: 'ALL' });
      const idleTab = page.getByRole('tab', { name: 'LOOK' });

      // AC-02: 下線は共通クラスで 1px・黒・0.3s
      const activeUnderline = activeTab.locator('.underline-animation-left2right');
      await expect(activeUnderline).toHaveCount(1);

      const style = await activeUnderline.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: cs.height,
          backgroundColor: cs.backgroundColor,
          transitionDuration: cs.transitionDuration,
        };
      });
      expect(style.height).toBe('1px');
      expect(style.backgroundColor).toBe('rgb(0, 0, 0)');
      expect(style.transitionDuration).toBe('0.3s');

      // AC-03: 選択中は伸び切り、非選択は 0、ホバーで伸びる
      const scaleOf = async (tab: typeof activeTab) =>
        await tab
          .locator('.underline-animation-left2right')
          .evaluate((el) => getComputedStyle(el).scale);

      // Tailwind v4 は scale-x-* を個別プロパティ scale で出力する
      // （伸び切り時は "1"、未表示時は "0 1"）
      expect(await scaleOf(activeTab)).toBe('1');
      expect(await scaleOf(idleTab)).toBe('0 1');

      await idleTab.hover();
      await expect
        .poll(async () => await scaleOf(idleTab))
        .toBe('1');
    });

    // FREQ-193: letter-spacing は最後の文字の右にも字間を作るため、
    // 幅 100% のままだと下線が右へはみ出す。
    test(`FREQ-193 ${vp.name} 下線が文字の真下に揃う`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();

      const alignment = await page.evaluate(() =>
        [...document.querySelectorAll('[role="tab"]')].map((tab) => {
          const underline = tab.querySelector('.underline-animation-left2right')!;
          const labelSpan = underline.parentElement!;
          const textNode = [...labelSpan.childNodes].find(
            (node) => node.nodeType === 3 && node.textContent!.trim().length > 0,
          )!;
          const text = textNode.textContent!;
          const letterSpacing = parseFloat(
            getComputedStyle(labelSpan).letterSpacing,
          );

          // 最後の文字の矩形には末尾の字間が含まれるので差し引いてグリフ右端を得る
          const lastChar = document.createRange();
          lastChar.setStart(textNode, text.length - 1);
          lastChar.setEnd(textNode, text.length);
          const glyphRight =
            lastChar.getBoundingClientRect().right - letterSpacing;

          const firstChar = document.createRange();
          firstChar.setStart(textNode, 0);
          firstChar.setEnd(textNode, 1);
          const glyphLeft = firstChar.getBoundingClientRect().left;

          // 非選択タブは scale-x-0 で潰れるため実寸は offsetWidth で測る
          const underlineLeft = underline.getBoundingClientRect().left;
          const underlineWidth = (underline as HTMLElement).offsetWidth;

          return {
            label: text,
            rightGap: underlineLeft + underlineWidth - glyphRight,
            leftGap: glyphLeft - underlineLeft,
          };
        }),
      );

      expect(alignment.length).toBe(4);
      for (const tab of alignment) {
        expect(Math.abs(tab.rightGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(tab.leftGap)).toBeLessThanOrEqual(1);
      }
    });
  }
});
