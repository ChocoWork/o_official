import { expect, test, type Locator } from "@playwright/test";

// FREQ-272: desktop（lg 以上）の ITEM カード。
// - 下線インジケータは画像3枚以上かつホバー中だけ表示する
// - ホバーすると2枚目の画像を表示し、離れると1枚目へ戻る
// - 送りボタンのアイコンは 15x15 のシェブロン

test.use({ viewport: { width: 1280, height: 900 } });

/** ホームの ITEM セクションから、指定枚数以上の画像を持つカードを探す */
async function findCard(
  page: import("@playwright/test").Page,
  minSlides: number,
): Promise<Locator | null> {
  const cards = page
    .locator('#items [data-testid="item-card"]')
    .filter({ has: page.getByTestId("item-card-carousel-indicator") });

  for (let i = 0; i < (await cards.count()); i += 1) {
    const card = cards.nth(i);
    const slides = await card
      .locator('[data-testid="item-card-carousel-slide"]')
      .count();
    if (slides >= minSlides) {
      return card;
    }
  }
  return null;
}

test.describe("FR-HOME-015 desktop の ITEMカードのホバー挙動", () => {
  test("FREQ-272-AC-01: 画像3枚以上のカードは、ホバー中だけ下線が表示される", async ({
    page,
  }) => {
    await page.goto("/");

    const card = await findCard(page, 3);
    if (!card) {
      test.skip();
      return;
    }

    const indicator = card.getByTestId("item-card-carousel-indicator");
    await expect(indicator).toBeHidden();

    await card.hover();
    await expect(indicator).toBeVisible();
  });

  test("FREQ-272-AC-02: 画像2枚のカードはホバーしても下線が表示されない", async ({
    page,
  }) => {
    await page.goto("/");

    const cards = page
      .locator('#items [data-testid="item-card"]')
      .filter({ has: page.getByTestId("item-card-carousel-indicator") });

    let twoImageCard: Locator | null = null;
    for (let i = 0; i < (await cards.count()); i += 1) {
      const card = cards.nth(i);
      const slides = await card
        .locator('[data-testid="item-card-carousel-slide"]')
        .count();
      if (slides === 2) {
        twoImageCard = card;
        break;
      }
    }

    if (!twoImageCard) {
      test.skip();
      return;
    }

    await twoImageCard.hover();
    await expect(
      twoImageCard.getByTestId("item-card-carousel-indicator"),
    ).toBeHidden();
  });

  test("FREQ-272-AC-03: ホバーすると2枚目が表示され、離れると1枚目へ戻る", async ({
    page,
  }) => {
    await page.goto("/");

    const card = await findCard(page, 3);
    if (!card) {
      test.skip();
      return;
    }

    const segments = card
      .getByTestId("item-card-carousel-indicator")
      .getByRole("tab");
    await expect(segments.nth(0)).toHaveAttribute("data-active", "true");

    await card.hover();
    await expect(segments.nth(1)).toHaveAttribute("data-active", "true");

    // カードの外へマウスを移動すると1枚目へ戻る
    await page.mouse.move(0, 0);
    await expect(segments.nth(0)).toHaveAttribute("data-active", "true");
  });

  test("FREQ-272-AC-04: 送りボタンのアイコンは 15x15 のシェブロン", async ({
    page,
  }) => {
    await page.goto("/");

    const card = await findCard(page, 3);
    if (!card) {
      test.skip();
      return;
    }

    await card.hover();

    const icon = card.getByTestId("item-card-carousel-next").locator("svg");
    await expect(icon).toHaveAttribute("viewBox", "0 0 15 15");

    const box = await icon.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(15, 0);
    expect(box!.height).toBeCloseTo(15, 0);
  });
});
