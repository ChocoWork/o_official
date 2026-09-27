import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

// CONTROLLER RULING: create-session を偽の clientSecret（例: "cs_test_secret"）で
// 成功応答させない。Stripe の CheckoutProvider は不正な clientSecret では
// 初期化に失敗し、画面全体を壊しうるため。
// また実エンドポイントに応答させる代替も、create-session はブラウザ向けにモックした
// /api/cart ではなく session_id クッキーに紐づく実際の carts テーブルを見るため、
// このテストの空カートでは常に「Cart is empty」(400) で失敗し、結局 clientSecret は
// 得られない（=確定ボタンは無効化されたまま）。したがってこのファイルでは
// create-session を失敗応答（429）に固定し、「決済フォーム未準備」の状態だけを検証する。
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
  test(`${viewport.name}（${viewport.width}px）3セクションが1画面に並ぶ`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page);
    await page.goto("/checkout");

    await expect(page.getByRole("heading", { name: "お客様情報" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "配送先" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "支払方法の選択" }),
    ).toBeVisible();
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
    await page.goto("/checkout");

    const fullName = page.locator('input[name="fullName"]');
    await fullName.fill("山田太郎");
    await expect(fullName).toHaveValue("山田太郎");
  });
}
