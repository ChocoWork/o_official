import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-344: LOOK 詳細ページで横スクロールを発生させない。
// モバイルの画像カルーセルが main の左右パディング（px-4=16px）を -mx-5（20px）で
// 打ち消しており、左右それぞれ 4px はみ出していた。横スクロールバーが viewport 下端に
// 出るため、固定ボトムナビの下部も 15px ぶん欠けていた。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-018 横スクロールを発生させない', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 横方向にはみ出す要素がない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      // AC-01: ドキュメントが横にスクロールしない
      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);

      // AC-02: viewport の右端をはみ出す要素が無い（はみ出し元を特定できるよう列挙する）。
      // 左側へのはみ出しは md 以上の画像列で意図的に行っており、スクロールを生まないので見ない。
      const overflowing = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            return r.right > limit + 0.5;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            const cls =
              typeof el.className === 'string' ? el.className : '(svg)';
            return `${el.tagName}.${cls.slice(0, 60)} [${r.left.toFixed(1)}, ${r.right.toFixed(1)}]`;
          })
          // フォーカス時のみ表示されるスキップリンクは常時 viewport 外に置くため除外
          .filter((desc) => !desc.includes('sr-only'));
      });
      expect(overflowing).toEqual([]);
    });
  }

  test('mobile 固定ナビの下端が viewport 下端と一致する', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFirstLookDetail(page);

    // AC-03: 横スクロールバーに下部を削られず、ナビ下端が可視領域の下端に接する
    const metrics = await page.evaluate(() => {
      const nav = document.querySelector(
        '[data-testid="look-detail-fixed-nav"] [data-ui-bottom-nav]',
      )!;
      return {
        navBottom: nav.getBoundingClientRect().bottom,
        clientHeight: document.documentElement.clientHeight,
      };
    });
    expect(metrics.navBottom).toBeCloseTo(metrics.clientHeight, 0);
  });
});
