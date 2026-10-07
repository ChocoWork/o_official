import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";
import { fillShippingForm, stubPostalCode } from "./checkout-flow-helpers";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

// create-session は失敗応答（429）に固定する。入力画面の形と、未入力・失敗のときの動きだけを見る
async function mockCheckoutApis(page: Page, createSessionStatus = 429): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.route("**/api/checkout/create-session", (route) =>
    route.fulfill({ status: createSessionStatus, json: { error: "Too many requests" } }),
  );
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）入力画面はお客様情報と配送先で、支払方法の選択は無い`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page);
    await page.goto("/checkout");

    await expect(page.getByRole("heading", { name: "お客様情報" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "配送先" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "支払方法の選択" }),
    ).toHaveCount(0);
    // 中間の遷移ボタンは廃止され、確定ボタンは「確認へ進む」1つだけになる
    await expect(
      page.getByRole("button", { name: "確認へ進む" }),
    ).toHaveCount(1);
  });

  // FREQ-354-AC-03: 全欄が空のまま確認へ進むを押すと氏名欄にフォーカスが移ること。
  // Finding A の修正により、決済セッション未成立（paymentReady=false）でも
  // 確認へ進むは有効なボタンとして描画され、クリック時にバリデーションが走る。
  test(`${viewport.name}（${viewport.width}px）未入力で確認へ進むを押すと氏名欄にフォーカスが移る`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page);
    await page.goto("/checkout");

    const confirmButton = page.getByRole("button", { name: "確認へ進む" });
    await expect(confirmButton).toBeVisible();
    await expect(confirmButton).toBeEnabled();

    await confirmButton.click();

    await expect(page.locator('input[name="fullName"]')).toBeFocused();
  });

  test(`${viewport.name}（${viewport.width}px）429 でも入力欄は操作できる`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page, 429);
    await stubPostalCode(page);
    await page.goto("/checkout");
    await fillShippingForm(page, "e2e-single-step@example.com");
    await page.getByRole("button", { name: "確認へ進む" }).click();
    await expect(page.getByTestId("checkout-session-error")).not.toHaveText("");

    const fullName = page.locator('input[name="fullName"]');
    await fullName.fill("山田太郎");
    await expect(fullName).toHaveValue("山田太郎");
  });
}
