import { expect, test, type Locator } from '@playwright/test';

// FREQ-151: mobile / tablet のカード下情報パネルの関連 ITEM リンクは、
// ホバーでメニューと同じ左→右の下線アニメーション（黒）が出て、
// クリックで /item/{id} へ遷移する。

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

// Tailwind v4 の scale-x は `scale` プロパティを使うため、
// transform 行列と scale の両方から水平スケールを読む
const getScaleX = (underline: Locator) =>
  underline.evaluate((el) => {
    const cs = getComputedStyle(el);
    if (cs.scale && cs.scale !== 'none') {
      return Number.parseFloat(cs.scale.split(' ')[0]);
    }
    if (cs.transform === 'none') {
      return 1;
    }
    return new DOMMatrixReadOnly(cs.transform).a;
  });

test.describe('FR-LOOK-ALL-034 情報パネル関連 ITEM の下線アニメーションとリンク', () => {
  for (const target of PAGES) {
    for (const vp of VIEWPORTS) {
      test(`${vp.name} ${target.label} で関連 ITEM ホバーで下線が出てクリックで /item/{id} へ遷移する`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(target.path);
        await expect(page.locator(target.scope)).toBeVisible();

        const itemLink = page
          .locator(`${target.scope} a.look-related-item-text`)
          .first();
        await expect(
          itemLink,
          `${target.label} に関連アイテム付きカードが見つかりませんでした`,
        ).toBeAttached();
        await itemLink.scrollIntoViewIfNeeded();

        const underline = itemLink.locator('.underline-animation-left2right');

        // AC-02: 非ホバー時は scale-x 0（非表示）
        expect(await getScaleX(underline)).toBe(0);

        // AC-01: ホバーで左起点（origin-left・黒）の下線が scale-x 1 になる
        await itemLink.hover();
        await expect.poll(() => getScaleX(underline)).toBe(1);
        await expect(underline).toHaveCSS('background-color', 'rgb(0, 0, 0)');
        const origin = await underline.evaluate(
          (el) => getComputedStyle(el).transformOrigin,
        );
        expect(origin.startsWith('0px')).toBe(true);

        // AC-03: クリックで /item/{id} へ遷移する
        await itemLink.click();
        await expect(page).toHaveURL(/\/item\/\d+/);
      });
    }
  }

  // AC-04: desktop では情報パネルの関連 ITEM リンクは表示されない
  test('desktop では情報パネルの関連 ITEM リンクが表示されない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();
    await expect(
      page.locator('main a.look-related-item-text').first(),
    ).toBeHidden();
  });
});
