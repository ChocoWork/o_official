import { expect, test } from "@playwright/test";
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from "./shop-test-utils";

// 規約の3ビューポート（390 / 768 / 1280）に、折り返しの境界幅を足す。
for (const width of [320, 390, 767, 768, 1280]) {
  // FREQ-392-AC-01 / FREQ-392-AC-02
  test(`description and specifications share one mobile divider at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await mockCartApis(page, []);
    await mockItemDetailApis(
      page,
      sampleItemDetail({
        description: "Item description.",
        material: "Linen 100%",
      }),
      [],
    );
    await page.goto("/item/101");
    const description = page.getByTestId("item-detail-description");
    const specs = page.getByTestId("item-spec-list");
    await expect(specs).toBeVisible();
    const bounds = await description.boundingBox();
    const list = await specs.boundingBox();
    await expect(specs.locator("dt").first()).toHaveCSS(
      "border-top-width",
      "1px",
    );
    if (width < 768) {
      expect(
        Math.abs(list!.y - (bounds!.y + bounds!.height)),
      ).toBeLessThanOrEqual(1);
      await expect(description).toHaveCSS("border-bottom-width", "0px");
      await expect(specs).toHaveCSS("margin-top", "0px");
    } else {
      await expect(description).toHaveCSS("border-bottom-width", "1px");
      expect(
        parseFloat(await specs.evaluate((e) => getComputedStyle(e).marginTop)),
      ).toBeGreaterThan(0);
    }

    // 横スクロールが出ないこと（規約: .claude/CLAUDE.md）
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(false);
  });
}
