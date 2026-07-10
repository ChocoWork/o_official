import { expect, test } from '@playwright/test';

// FREQ-74: 注文完了画面のブランド適合（ミニマル・モード）UI
// 完了画面は決済セッション完了後のみ表示されるため、未到達時はスキップする
// （FR-CHECKOUT-006 と同方針）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-CHECKOUT-013 注文完了画面のブランド適合UI', () => {
  for (const viewport of viewports) {
    test(`${viewport.name}: オーバーライン・見出し・ヘアライン・アイコンカードが表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/checkout');
      await page.waitForLoadState('networkidle').catch(() => undefined);

      const heading = page.getByRole('heading', {
        name: 'ご注文ありがとうございます',
      });
      const completedVisible = await heading.isVisible().catch(() => false);

      if (!completedVisible) {
        test.skip(
          true,
          '完了画面は決済セッション完了後のみ表示されるためスキップ',
        );
        return;
      }

      // FREQ-74-AC-01: 英語オーバーラインが見出しより上に表示される
      const overline = page.getByText('THANK YOU FOR YOUR ORDER');
      await expect(overline).toBeVisible();
      const overlineBox = await overline.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(overlineBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      expect(overlineBox!.y).toBeLessThan(headingBox!.y);

      // FREQ-74-AC-02: 糸モチーフのヘアライン（幅約1pxの縦線）
      const hairline = page.locator('main span.w-px');
      expect(await hairline.count()).toBeGreaterThan(0);

      // FREQ-74-AC-03: 案内3カードの丸型アイコン
      await expect(page.locator('.ri-mail-line')).toBeVisible();
      await expect(page.locator('.ri-truck-line')).toBeVisible();
      await expect(page.locator('.ri-customer-service-line')).toBeVisible();

      // FREQ-74-AC-04: モバイルで注文番号/注文日が縦積みかつ横スクロールなし
      if (viewport.name === 'mobile') {
        const orderNoLabel = page.getByText('注文番号');
        const orderDateLabel = page.getByText('注文日', { exact: true });
        const noBox = await orderNoLabel.boundingBox();
        const dateBox = await orderDateLabel.boundingBox();
        expect(noBox).not.toBeNull();
        expect(dateBox).not.toBeNull();
        // 縦積み: 注文日ラベルが注文番号ラベルより下に位置する
        expect(dateBox!.y).toBeGreaterThan(noBox!.y);

        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
      }
    });
  }
});
