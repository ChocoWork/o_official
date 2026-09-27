import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";
import { stubCheckoutSessionApis } from "./checkout-test-utils";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

async function openCheckout(page: Page) {
  await page.context().addCookies([
    {
      name: "sb-csrf-token",
      value: "test-csrf-token",
      url: "http://localhost:3000",
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);
  await stubCheckoutSessionApis(page);
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.goto("/checkout");
  await expect(page.locator(".checkout-total")).toBeVisible();
}

/** 小計の金額・合計ラベル・合計金額の算出スタイルをまとめて読む。 */
function readStyles(page: Page) {
  return page.evaluate(() => {
    const pick = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`not found: ${selector}`);
      }
      const style = getComputedStyle(element);
      return {
        fontSize: parseFloat(style.fontSize),
        fontFamily: style.fontFamily,
      };
    };
    return {
      title: pick(".checkout-summary-title"),
      subtotal: pick(".checkout-row span:last-child"),
      totalLabel: pick(".checkout-total-label"),
      total: pick(".checkout-total"),
    };
  });
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）合計は小計より1段階大きい`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    const styles = await readStyles(page);
    expect(styles.totalLabel.fontSize).toBeCloseTo(styles.total.fontSize, 1);
    expect(styles.total.fontSize).toBeGreaterThan(styles.subtotal.fontSize);
  });

  test(`${viewport.name}（${viewport.width}px）合計金額の書体は小計と同じ`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    const styles = await readStyles(page);
    expect(styles.total.fontFamily).toBe(styles.subtotal.fontFamily);
  });

  test(`${viewport.name}（${viewport.width}px）ORDER SUMMARY 見出しは合計より1段階大きい`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    const styles = await readStyles(page);
    expect(styles.title.fontSize).toBeGreaterThan(styles.total.fontSize);
  });
}
