import { expect, test } from "@playwright/test";
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from "./shop-test-utils";

// 規約の3ビューポート（390 / 768 / 1280）に、折り返しの境界幅を足す。
for (const width of [320, 390, 657, 767, 768, 1280]) {
  // FREQ-393-AC-01 / FREQ-393-AC-02
  test(`specifications join related items at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1216 });
    await mockCartApis(page, []);
    await mockItemDetailApis(
      page,
      sampleItemDetail({ description: "Description.", material: "Linen 100%" }),
      [
        {
          id: 202,
          name: "Related item",
          price: 1000,
          image_url: "/original.jpg",
          category: "TOPS",
        },
      ],
    );
    await page.goto("/item/101");
    const related = page.getByTestId("related-items");
    const specs = page.getByTestId("item-spec-list");
    await expect(related).toBeVisible();
    await expect(specs).toHaveCSS("border-bottom-width", "1px");
    if (width < 768) {
      const a = await specs.boundingBox();
      const b = await related.boundingBox();
      expect(Math.abs(b!.y - a!.y - a!.height)).toBeLessThanOrEqual(1);
      await expect(related).toHaveCSS("margin-top", "0px");
      await expect(related).toHaveCSS("border-top-width", "0px");
      await expect(page.getByTestId("item-detail-first-view")).toHaveCSS(
        "min-height",
        "0px",
      );
    } else {
      await expect(related).toHaveCSS("border-top-width", "1px");
      expect(
        parseFloat(
          await related.evaluate((e) => getComputedStyle(e).marginTop),
        ),
      ).toBeGreaterThan(0);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });
}
