import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";
import { stubCheckoutSessionApis } from "./checkout-test-utils";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

const REQUIRED_LABELS = [
  "氏名",
  "フリガナ",
  "メールアドレス",
  "電話番号",
  "郵便番号",
  "都道府県",
  "市区町村",
  "番地",
];

const OPTIONAL_LABELS = ["建物名・部屋番号（任意）"];

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

/** ラベル文字列を含むフォーム項目のラベル要素。TextField と SingleSelect の両方に対応する。 */
function labelOf(page: Page, text: string): Locator {
  return page
    .locator(".text-field__label, .single-select__label")
    .filter({ hasText: text })
    .first();
}

async function isInViewport(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  if (!box) {
    return false;
  }
  const height = await locator
    .page()
    .evaluate(() => document.documentElement.clientHeight);
  return box.y >= 0 && box.y + box.height <= height;
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）必須欄のラベルに必須マーカーが出る`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    for (const label of REQUIRED_LABELS) {
      await expect(
        labelOf(page, label).locator(
          ".text-field__required, .single-select__required",
        ),
        `${label} に必須マーカーが必要`,
      ).toHaveText("*");
    }
  });

  test(`${viewport.name}（${viewport.width}px）任意欄のラベルに必須マーカーは出ない`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    for (const label of OPTIONAL_LABELS) {
      await expect(
        labelOf(page, label).locator(
          ".text-field__required, .single-select__required",
        ),
        `${label} に必須マーカーは不要`,
      ).toHaveCount(0);
    }
  });

  test(`${viewport.name}（${viewport.width}px）全欄が空なら氏名欄へ移動する`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    await page.getByRole("button", { name: "確認へ進む" }).click();

    const fullName = page.locator('input[name="fullName"]');
    await expect(fullName).toBeFocused();
    await expect
      .poll(() => isInViewport(fullName))
      .toBe(true);
  });

  test(`${viewport.name}（${viewport.width}px）お客様情報だけ埋めたら郵便番号欄へ移動する`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckout(page);

    await page.locator('input[name="fullName"]').fill("山田太郎");
    await page.locator('input[name="kanaName"]').fill("ヤマダタロウ");
    await page.locator('input[name="email"]').fill("customer@example.com");
    await page.locator('input[name="phone"]').fill("09012345678");

    await page.getByRole("button", { name: "確認へ進む" }).click();

    const postalCode = page.locator('input[name="postalCode"]');
    await expect(postalCode).toBeFocused();
    await expect
      .poll(() => isInViewport(postalCode))
      .toBe(true);
  });
}
