import { expect, test } from "@playwright/test";

// FREQ-273: ITEMカードの画像スクロール領域にスクロールバーを出さない。
// 画像2枚のカードには送りボタン（シェブロン）を表示しない。

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

test.describe("FR-HOME-016 ITEMカードのスクロールバー非表示", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: FREQ-273-AC-01 縦横ともスクロールバーが領域を占有しない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");

      const scroller = page
        .locator('#items [data-testid="item-card-carousel"]')
        .first();

      if ((await scroller.count()) === 0) {
        test.skip();
        return;
      }

      const size = await scroller.evaluate((el) => ({
        clientWidth: el.clientWidth,
        offsetWidth: (el as HTMLElement).offsetWidth,
        clientHeight: el.clientHeight,
        offsetHeight: (el as HTMLElement).offsetHeight,
      }));

      expect(size.offsetWidth - size.clientWidth).toBe(0);
      expect(size.offsetHeight - size.clientHeight).toBe(0);
    });
  }

  test("desktop: FREQ-273-AC-02 画像2枚のカードには送りボタンが出ない", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const cards = page
      .locator('#items [data-testid="item-card"]')
      .filter({ has: page.getByTestId("item-card-carousel") });

    let checked = 0;
    for (let i = 0; i < (await cards.count()); i += 1) {
      const card = cards.nth(i);
      const slides = await card
        .locator('[data-testid="item-card-carousel-slide"]')
        .count();
      if (slides !== 2) {
        continue;
      }

      await card.hover();
      await expect(card.getByTestId("item-card-carousel-next")).toHaveCount(0);
      await expect(card.getByTestId("item-card-carousel-prev")).toHaveCount(0);
      checked += 1;
    }

    if (checked === 0) {
      test.skip();
    }
  });
});
