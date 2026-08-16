import { expect, test } from "@playwright/test";

// FREQ-271: ホーム ITEM セクション / ITEM 一覧のカードで、画像が複数あるときに
// スワイプ（mobile / tablet）で切り替えられ、画像下のセグメント線が現在位置を示す。
// カード操作でリンク遷移はしない。
// desktop の下線・ホバー挙動は FREQ-272（FR-HOME-015）で検証する。

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

test.describe("FR-HOME-014 ITEMカードの複数画像カルーセル", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: FREQ-271-AC-01 / AC-04 インジケータで切り替わり、リンク遷移しない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");

      const indicator = page
        .locator('#items [data-testid="item-card-carousel-indicator"]')
        .first();

      // 複数画像の商品が公開されていない環境ではカルーセル自体が存在しない
      if ((await indicator.count()) === 0) {
        test.skip();
        return;
      }

      const segments = indicator.getByRole("tab");
      const slides = page
        .locator('#items [data-testid="item-card"]')
        .filter({ has: page.getByTestId("item-card-carousel-indicator") })
        .first()
        .locator('[data-testid="item-card-carousel-slide"]');

      // 線の数が画像枚数と一致する
      await expect(indicator).toBeVisible();
      await expect(segments).toHaveCount(await slides.count());
      await expect(segments.nth(0)).toHaveAttribute("data-active", "true");

      await segments.nth(1).click();
      await expect(segments.nth(1)).toHaveAttribute("data-active", "true");

      // FREQ-271-AC-04: 画像切り替え操作ではカードのリンク遷移が起きない
      await expect(page).toHaveURL(/\/$/);
    });
  }
});
