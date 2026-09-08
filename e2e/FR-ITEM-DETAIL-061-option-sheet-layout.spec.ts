import { expect, test } from "@playwright/test";
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from "./shop-test-utils";

for (const viewport of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 500 },
]) {
  test(`option sheet matches the fixed CTA at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const item = sampleItemDetail({
      name: "Option Sheet Layout Product",
      price: 12345,
      colors: [
        { hex: "#000000", name: "Black" },
        { hex: "#ffffff", name: "White" },
      ],
      sizes: ["S", "M"],
    });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);
    await page.goto("/item/101");
    const fixed = page
      .getByTestId("item-actions-fixed")
      .getByRole("button", { name: "SELECT OPTIONS" });
    await expect(fixed).toBeVisible();
    const before = await fixed.boundingBox();
    expect(before).not.toBeNull();
    await fixed.click();
    const sheet = page.getByTestId("item-option-sheet");
    await expect(sheet).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "close", exact: true }),
    ).toBeHidden();
    await expect(sheet.getByText(item.name, { exact: true })).toHaveCount(0);
    await expect(sheet.getByText("¥12,345", { exact: true })).toHaveCount(0);
    const cart = sheet.getByRole("button", { name: "ADD TO CART" });
    await expect(cart).toBeDisabled();
    const after = await cart.boundingBox();
    expect(after).not.toBeNull();
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(after![dimension] - before![dimension]),
        dimension,
      ).toBeLessThanOrEqual(1);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await sheet.getByRole("button", { name: "Black", exact: true }).click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(viewport.width / 2, 40);
    await expect(sheet).toBeHidden();
    await expect(fixed).toBeFocused();
  });
}

test("size borders show idle, hover and selected states in both option selectors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const item = sampleItemDetail({
    colors: [
      { hex: "#000000", name: "Black" },
      { hex: "#ffffff", name: "White" },
    ],
    sizes: ["S", "M"],
  });
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto("/item/101");
  await page
    .getByTestId("item-actions-fixed")
    .getByRole("button", { name: "SELECT OPTIONS" })
    .click();
  for (const id of ["item-sheet-size-select", "item-size-select"]) {
    const size = page
      .getByTestId(id)
      .getByRole("button", { name: "S", exact: true });
    await size.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(size).toHaveCSS("border-top-color", "rgb(241, 240, 237)");
    await size.hover();
    await expect(size).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0.3)");
    await size.click();
    await expect(size).toHaveAttribute("aria-pressed", "true");
    await expect(size).toHaveCSS("border-top-color", "rgb(0, 0, 0)");
    await page.mouse.move(0, 0);
    await expect(size).toHaveCSS("border-top-color", "rgb(0, 0, 0)");
    await page
      .getByTestId(id)
      .getByRole("button", { name: "M", exact: true })
      .click();
    await expect(size).toHaveCSS("border-top-color", "rgb(241, 240, 237)");
    if (id === "item-sheet-size-select") {
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
});
