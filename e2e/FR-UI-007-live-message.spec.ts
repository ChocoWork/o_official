import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";

/**
 * FR-UI-007 画面の途中で出る案内を、割り込ませすぎずに確実に読み上げる
 * 対応 FREQ: FREQ-376（AC-01 / AC-02。AC-03 はカートの Toast を開く手順を持つ e2e/FR-CART-021 で確かめる）
 *
 * - 欄ごとの誤りは確定時に一度に何件も出るので、割り込む role="alert" にすると一斉に読み上げられる。
 *   割り込まない polite（順番待ち）にし、先頭の誤りの欄へのフォーカス移動（FREQ-354）で知らせる
 * - 操作の結果として出る単発の案内は role="alert" のまま。ただし入れ物を最初から置き、中身だけを
 *   入れ替える（案内ごと後から差し込むと読み上げられないことがある。MDN、Chakra UI #3240）
 */

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

/** FR-CHECKOUT-021 と同じく、決済フォームは用意せずに配送先フォームの検証だけを動かす。 */
async function mockCheckoutApis(page: Page): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.route("**/api/checkout/create-session", (route) =>
    route.fulfill({ status: 429, json: { error: "Too many requests" } }),
  );
}

function contactForm(page: Page) {
  return page.locator('form:has(textarea[name="message"])');
}

/** FR-CONTACT-013 と同じ手順で、送れる内容を入力して送信する。 */
async function fillAndSubmitContactForm(page: Page): Promise<void> {
  const form = contactForm(page);
  await form.locator('input[name="name"]').fill("テスト太郎");
  await form.locator('input[name="email"]').fill("tester@example.com");
  await form.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name: "その他" }).click();
  await form.locator('input[name="subject"]').fill("案内の読み上げテスト");
  await form.locator('textarea[name="message"]').fill("送信失敗の案内を確認します。");
  await form.getByRole("button", { name: "SEND MESSAGE" }).click();
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-UI-007 案内の読み上げ (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-376-AC-01
    test("checkout を空のまま確定しても、欄ごとの誤りは割り込まず、先頭の誤りの欄へ移る", async ({ page }) => {
      await mockCheckoutApis(page);
      await page.goto("/checkout");

      await page.getByRole("button", { name: "確認へ進む" }).click();

      // 欄ごとの誤りは出ている（順番待ちの読み上げ領域の中）
      await expect(page.locator("#fullName-error")).toHaveText(/\S/);
      await expect(page.locator("#fullName-error")).toHaveAttribute("aria-live", "polite");
      await expect(page.locator("#prefecture-error")).toHaveText(/\S/);
      await expect(page.locator("#prefecture-error")).toHaveAttribute("aria-live", "polite");
      // 割り込む読み上げ領域（role="alert"）には、欄の誤りが1件も入らない
      await expect(
        page.getByRole("alert").filter({ hasText: /入力してください|選択してください/ }),
      ).toHaveCount(0);
      // 先頭の誤りの欄へフォーカスが移る（FREQ-354-AC-03）
      await expect(page.getByRole("textbox", { name: "氏名", exact: true })).toBeFocused();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-376-AC-02
    test("お問い合わせの送信失敗の案内は、入れ物が最初からあり、同じ入れ物に文言が入る", async ({ page }) => {
      await page.route("**/api/contact", async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        await route.fulfill({ status: 500, json: { success: false } });
      });
      await page.goto("/contact");

      // フォームの中の割り込む読み上げ領域は、送信失敗の案内の入れ物だけ。送信前は空で置かれている
      const alert = contactForm(page).getByRole("alert");
      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText("");

      await fillAndSubmitContactForm(page);

      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText(/送信に失敗しました/);
      await expect(alert).toBeVisible();
    });
  });
}
