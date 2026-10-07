import { expect, test, type Page } from "@playwright/test";
import { seedCart } from "./checkout-flow-helpers";

/**
 * FR-CHECKOUT-031 プロモーションコードの見出しを入力欄に結びつける
 * 対応 FREQ: FREQ-373（AC-01 / AC-02）
 *
 * 見出し（label）が入力欄に結びついていないと、スクリーンリーダーでは欄の名前として
 * 見出しが読まれず、見出しを押しても入力欄にカーソルが移らない（WCAG 1.3.1 / 4.1.2、W3C H44）。
 * プレースホルダ「コードを入力」は入力を始めると消えるので、見出しの代わりにならない。
 *
 * プロモーションコード欄は入力画面に常にある。「適用」はサーバーが Stripe に問い合わせて確かめる（グループ F）。
 * カートは共通の seedCart で実 API を使って用意する。商品が無い環境だけスキップし、HTTP の失敗はテストを失敗にする。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;


/** checkout を開き、プロモーションコード欄が出るまで待つ。 */
async function openCheckout(page: Page): Promise<void> {
  await page.goto("/checkout");
  await expect(page.getByPlaceholder("コードを入力")).toBeVisible({ timeout: 30000 });
}

test.describe("FR-CHECKOUT-031 プロモーションコードの見出しと入力欄", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.ok ? "" : seeded.reason);
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-373-AC-01
    test(`${viewport.name}（${viewport.width}px）入力欄の名前が「プロモーションコード」になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      const input = page.getByRole("textbox", { name: "プロモーションコード", exact: true });
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute("placeholder", "コードを入力");

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-373-AC-02
    test(`${viewport.name}（${viewport.width}px）見出し「プロモーションコード」を押すと入力欄にカーソルが移る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      await page.getByText("プロモーションコード", { exact: true }).click();

      await expect(page.getByPlaceholder("コードを入力")).toBeFocused();
    });
  }
});
