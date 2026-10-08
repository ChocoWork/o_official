import { expect, test } from "@playwright/test";
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from "./shop-test-utils";

for (const width of [320, 375, 767, 768, 1280]) {
  test(`purchase controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 667 });
    await mockCartApis(page, []);
    await mockItemDetailApis(
      page,
      sampleItemDetail({
        colors: [
          { hex: "#000", name: "Black" },
          { hex: "#fff", name: "White" },
        ],
        sizes: ["S", "M"],
      }),
      [],
    );
    await page.goto("/item/101");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const fixed = page.getByTestId("item-actions-fixed");
    const options = page.getByTestId("item-spec-table");
    const inline = page.getByTestId("item-actions-main");
    if (width >= 768) {
      await expect(fixed).toBeHidden();
      await expect(options).toBeVisible();
      await expect(inline).toBeVisible();
      return;
    }
    await expect(options).toBeHidden();
    await expect(inline).toBeHidden();
    for (const fraction of [0, 0.5, 1]) {
      await page.evaluate(
        (f) => window.scrollTo(0, document.documentElement.scrollHeight * f),
        fraction,
      );
      await expect(fixed).toBeVisible();
      const rect = await fixed.boundingBox();
      expect(rect!.y + rect!.height).toBeCloseTo(667, 0);
    }
    await fixed.getByRole("button", { name: "SELECT OPTIONS" }).click();
    const sheet = page.getByTestId("item-option-sheet");
    await sheet.getByRole("button", { name: "White", exact: true }).click();
    await sheet.getByRole("button", { name: "M", exact: true }).click();
    await page.keyboard.press("Escape");
    await fixed.getByRole("button", { name: "ADD TO CART" }).click();
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "M", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });
}

test("mobile direct-add failures remain visible beside the fixed CTA", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockCartApis(page, []);
  await mockItemDetailApis(
    page,
    sampleItemDetail({
      colors: [{ hex: "#000", name: "Black" }],
      sizes: ["S"],
    }),
    [],
  );
  // mockCartApis のあとに登録して、追加の窓口だけを失敗させる。断りの形は窓口と同じ（Shopify の Ajax Cart API の形）
  await page.route("**/api/cart/add", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        status: 500,
        message: "Cart Error",
        description: "カートへの追加に失敗しました",
      }),
    });
  });
  await page.goto("/item/101");
  const fixed = page.getByTestId("item-actions-fixed");
  await fixed.getByRole("button", { name: "ADD TO CART" }).click();
  // 案内の入れ物は常に置かれる（FREQ-376）ので、文言が入ったことまで確かめる。
  // 窓口が返した description が出ていることで、バリアントが見つからない断りではなく、追加の失敗を通ったと分かる
  await expect(fixed.getByRole("alert")).toHaveText("カートへの追加に失敗しました");
  await expect(
    fixed.getByRole("button", { name: "ADD TO CART" }),
  ).toBeEnabled();
});
