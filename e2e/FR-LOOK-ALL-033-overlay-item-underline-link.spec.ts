import { expect, test, type Locator } from '@playwright/test';

// FREQ-150: PC のオーバーレイ関連 ITEM 行は、ホバーでメニューと同じ
// 左→右の下線アニメーション（白）が出て、クリックで /item/{id} へ遷移する。

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
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

test.describe('FR-LOOK-ALL-033 オーバーレイ関連 ITEM の下線アニメーションとリンク', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} で関連 ITEM ホバー時に左起点の下線が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const card = page
        .locator(
          `${target.scope} a[href^="/look/"]:has([data-testid="look-card-overlay-items"])`,
        )
        .first();
      await expect(
        card,
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).toBeAttached();

      const itemRow = card
        .locator('[data-testid="look-card-overlay-item"]')
        .first();
      const underline = itemRow.locator('.underline-animation-left2right');

      // カード中央（画像上・行の外）をホバー: 関連アイテムは出るが下線は出ない
      await card.hover();
      await expect(
        card.locator('[data-testid="look-card-overlay-items"]'),
      ).toHaveCSS('opacity', '1');

      // AC-02: 行非ホバー時は scale-x 0（非表示）
      expect(await getScaleX(underline)).toBe(0);

      // AC-01: 行ホバーで左起点の下線が scale-x 1 になる
      await itemRow.hover();
      await expect.poll(() => getScaleX(underline)).toBe(1);
      await expect(underline).toHaveCSS(
        'background-color',
        'rgb(255, 255, 255)',
      );
      const origin = await underline.evaluate(
        (el) => getComputedStyle(el).transformOrigin,
      );
      expect(origin.startsWith('0px')).toBe(true);
    });

    test(`desktop ${target.label} で関連 ITEM クリックで /item/{id} へ遷移する`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const card = page
        .locator(
          `${target.scope} a[href^="/look/"]:has([data-testid="look-card-overlay-items"])`,
        )
        .first();
      await expect(
        card,
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).toBeAttached();

      await card.hover();
      const itemRow = card
        .locator('[data-testid="look-card-overlay-item"]')
        .first();
      await expect(itemRow).toBeVisible();

      // AC-03: /look 詳細ではなく /item/{id} へ遷移する
      await itemRow.click();
      await expect(page).toHaveURL(/\/item\/\d+/);
    });
  }

  // AC-04: mobile / tablet はオーバーレイ自体が非表示のため行も表示されない
  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} ではオーバーレイの関連 ITEM 行が表示されない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      await expect(
        page.locator('[data-testid="look-card-overlay-item"]').first(),
      ).toBeHidden();
    });
  }
});
