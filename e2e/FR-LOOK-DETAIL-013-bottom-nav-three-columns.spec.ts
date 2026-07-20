import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-181: PREV/NEXT 部分を「PREV LOOK / LOOK LIST / NEXT LOOK」の
// 3カラムフッターナビ（ラベル上・アイコン下、縦の区切り線）にする。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-013 3カラムフッターナビ', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 3ラベルと区切り線を表示しテーマ名を表示しない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const nav = page.locator('[data-testid="look-detail-bottom-nav"]');
      await nav.scrollIntoViewIfNeeded();

      // AC-01: 3ラベルが表示され、LOOK LIST は /look へのリンク
      await expect(nav.getByText('PREV LOOK')).toBeVisible();
      await expect(nav.getByText('LOOK LIST')).toBeVisible();
      await expect(nav.getByText('NEXT LOOK')).toBeVisible();
      await expect(
        nav.getByRole('link', { name: 'Look list' }),
      ).toHaveAttribute('href', '/look');

      // AC-02: カラム境界2箇所に 1px の縦区切り線
      // （Tailwind v4 の divide-x は前側要素の右ボーダーとして付与される）
      const columns = nav.locator(':scope > *');
      await expect(columns).toHaveCount(3);
      for (const boundary of [
        [0, 1],
        [1, 2],
      ] as const) {
        const [leftCol, rightCol] = boundary;
        const rightOfLeft = await columns
          .nth(leftCol)
          .evaluate((el) => getComputedStyle(el).borderRightWidth);
        const leftOfRight = await columns
          .nth(rightCol)
          .evaluate((el) => getComputedStyle(el).borderLeftWidth);
        expect([rightOfLeft, leftOfRight]).toContain('1px');
      }

      // AC-03: ナビ内にテーマ名（h1 のテキスト）が表示されない
      const theme = (
        await page.getByRole('heading', { level: 1 }).innerText()
      ).trim();
      const navText = await nav.innerText();
      expect(navText).not.toContain(theme);
    });
  }
});
