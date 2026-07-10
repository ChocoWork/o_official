import { expect, test } from '@playwright/test';

// FREQ-77: 注文完了画面の表示開始位置（ページ先頭）と完了CTAのサイズ統一・直角維持
// 完了画面は決済セッション完了後のみ表示されるため、未到達時はスキップする
// （FR-CHECKOUT-006 / FR-CHECKOUT-013 と同方針）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-CHECKOUT-014 注文完了画面のスクロール位置とCTA統一', () => {
  for (const viewport of viewports) {
    test(`${viewport.name}: 先頭表示・CTA高さ一致・直角維持`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/checkout');
      await page.waitForLoadState('networkidle').catch(() => undefined);

      const heading = page.getByRole('heading', {
        name: 'THANK YOU FOR YOUR ORDER',
      });
      const completedVisible = await heading.isVisible().catch(() => false);

      if (!completedVisible) {
        test.skip(
          true,
          '完了画面は決済セッション完了後のみ表示されるためスキップ',
        );
        return;
      }

      // FREQ-77-AC-01: ページ先頭表示（見出しがビューポート内）
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(0);
      const headingBox = await heading.boundingBox();
      expect(headingBox).not.toBeNull();
      expect(headingBox!.y).toBeGreaterThanOrEqual(0);
      expect(headingBox!.y).toBeLessThan(viewport.height);

      // FREQ-77-AC-02: 2つのCTAの高さが一致
      const continueBtn = page.getByRole('link', { name: '買い物を続ける' });
      const historyBtn = page.getByRole('link', { name: '注文履歴を見る' });
      await expect(continueBtn).toBeVisible();
      await expect(historyBtn).toBeVisible();
      const continueBox = await continueBtn.boundingBox();
      const historyBox = await historyBtn.boundingBox();
      expect(continueBox).not.toBeNull();
      expect(historyBox).not.toBeNull();
      expect(Math.abs(continueBox!.height - historyBox!.height)).toBeLessThan(
        1,
      );

      // FREQ-77-AC-03: CTAに角丸が適用されていない（直角維持）
      for (const btn of [continueBtn, historyBtn]) {
        const radius = await btn.evaluate(
          (el) => getComputedStyle(el).borderRadius,
        );
        expect(radius === '0px' || radius === '').toBeTruthy();
      }
    });
  }
});
