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
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）フリガナのラベルに必須マーカーが出る`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    await expect(
      page
        .locator(".text-field__label")
        .filter({ hasText: "フリガナ" })
        .first()
        .locator(".text-field__required"),
    ).toHaveText("*");
    await expect(page.locator('input[name="kanaName"]')).toHaveAttribute(
      "required",
      "",
    );
  });

  test(`${viewport.name}（${viewport.width}px）氏名だけ埋めるとフリガナ欄でエラーになる`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    await page.locator('input[name="fullName"]').fill("山田太郎");
    await page.getByRole("button", { name: "確認へ進む" }).click();

    await expect(page.locator('input[name="kanaName"]')).toBeFocused();
    await expect(
      page.getByText("フリガナを入力してください"),
    ).toBeVisible();
  });
}
