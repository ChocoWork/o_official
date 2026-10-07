import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedCart } from "./checkout-flow-helpers";

/**
 * FR-CHECKOUT-030 ほかの操作で、入力中のプロモーションコード・案内が消えない
 * 対応 FREQ: FREQ-372（AC-01・AC-02）
 *
 * 画面の関数の中で部品を定義すると、画面が再描画されるたびに別の部品として作り直され、
 * 部品の中の入力・表示中の案内・フォーカスが失われる（React 公式: 部品の定義を入れ子にしない）。
 * 再描画は、ほかの欄への入力などで起きる。
 *
 * AC-03・04 は、入力画面に決済フォームと配送先の同期が無くなったので消した（グループ F）。
 *
 * プロモーションコード欄は入力画面に常にある。「適用」はサーバーが Stripe に問い合わせて確かめる。
 * カートは共通の seedCart で実 API を使って用意する。商品が無い環境だけスキップし、HTTP の失敗はテストを失敗にする。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

const PROMO_CODE = "E2E-PROMO-KEEP";


async function stubPostalCode(page: Page): Promise<void> {
  await page.route("**/api/checkout/postal-code**", (route) =>
    route.fulfill({
      json: { address: { prefecture: "東京都", city: "渋谷区", address: "神宮前1-2-3" } },
    }),
  );
}

function promoInput(page: Page): Locator {
  return page.getByPlaceholder("コードを入力");
}

/** checkout を開き、プロモーションコード欄が出るまで待つ。 */
async function openCheckout(page: Page): Promise<void> {
  await page.goto("/checkout");
  await expect(promoInput(page)).toBeVisible({ timeout: 30000 });
}

async function fillShippingForm(page: Page): Promise<void> {
  await page.getByLabel("氏名").fill("山田花子");
  await page.getByLabel("フリガナ").fill("ヤマダハナコ");
  await page.getByLabel("メールアドレス").fill("e2e-keep-input@example.com");
  await page.getByLabel("電話番号").fill("0312345678");
  await page.getByLabel("郵便番号").fill("1500001");
  await expect(page.getByLabel("市区町村")).toHaveValue("渋谷区");
}

test.describe("FR-CHECKOUT-030 ほかの操作で入力中の内容が消えない", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.ok ? "" : seeded.reason);
    await stubPostalCode(page);
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-372-AC-01
    test(`${viewport.name}（${viewport.width}px）コードを入力した後に氏名や郵便番号を入力しても、コードが消えない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      await promoInput(page).fill(PROMO_CODE);
      await fillShippingForm(page);

      await expect(promoInput(page)).toHaveValue(PROMO_CODE);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-372-AC-02
    test(`${viewport.name}（${viewport.width}px）コードを適用できなかった案内が、ほかの欄に入力しても消えない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      await promoInput(page).fill(PROMO_CODE);
      await page.getByRole("button", { name: "適用", exact: true }).click();

      // Stripe に存在しないコードなので、適用できなかった理由が出る
      const promoSection = page.locator(".checkout-section").filter({ has: promoInput(page) });
      const message = promoSection.locator("p.text-red-600");
      await expect(message).toBeVisible({ timeout: 15000 });
      const messageText = (await message.textContent())?.trim() ?? "";
      expect(messageText).not.toBe("");

      await page.getByLabel("氏名").fill("山田花子");

      await expect(promoSection.getByText(messageText)).toBeVisible();
    });
  }
});
