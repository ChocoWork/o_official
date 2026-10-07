import { expect, test } from '@playwright/test';
import { stubCheckoutSessionApis } from './checkout-test-utils';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FR-CHECKOUT-024 checkout のエラー境界
 * 準備の完了と入力の両立（FREQ-358 AC-01〜04）は、入力画面に決済フォームを置かなくなったので消した（グループ F）。
 * 残るのはエラー境界（FREQ-358-AC-05）。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

/** Next.js 16.3 が未捕捉のクライアント例外で出す、既定の全画面エラーの見出し。 */
const CRASH_HEADING = /This page couldn.t load/;

test.describe('FR-CHECKOUT-024 checkout のエラー境界', () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-05
    test(`${viewport.name}（${viewport.width}px）描画中の予期しない例外でカート保持と復帰導線を示す`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await stubCheckoutSessionApis(page);
      await mockCartApis(page, [sampleCartItem()]);
      // 描画時の例外を注入する。保存済み住所に null が混ざると、配送先プルダウンの
      // 選択肢を組み立てる箇所（addressOptions）で TypeError になる。
      // 住所一覧が null に強くなってこの注入が効かなくなったら、別の描画時例外に差し替えること。
      await page.route('**/api/profile/addresses', (route) =>
        route.fulfill({ json: { addresses: [null] } }),
      );

      await page.goto('/checkout');

      await expect(
        page.getByRole('heading', { name: '決済画面を表示できませんでした' }),
      ).toBeVisible();
      await expect(page.getByText('カートの商品はそのまま保持されています。')).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度表示する' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'カートに戻る' })).toHaveAttribute(
        'href',
        '/cart',
      );
      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
