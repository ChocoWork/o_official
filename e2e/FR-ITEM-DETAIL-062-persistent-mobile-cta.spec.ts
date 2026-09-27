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
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: "{}",
      });
    } else await route.fallback();
  });
  await page.goto("/item/101");
  const fixed = page.getByTestId("item-actions-fixed");
  await fixed.getByRole("button", { name: "ADD TO CART" }).click();
  // 案内の入れ物は常に置かれる（FREQ-376）ので、文言が入ったことまで確かめる
  await expect(fixed.getByRole("alert")).toHaveText(/\S/);
  await expect(
    fixed.getByRole("button", { name: "ADD TO CART" }),
  ).toBeEnabled();
});
