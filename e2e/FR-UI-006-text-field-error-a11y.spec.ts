import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";

/**
 * FR-UI-006 入力欄の誤りの案内を、欄の名前に混ぜずに説明として結びつけ、確実に読み上げる
 * 対応 FREQ: FREQ-375（AC-01〜AC-04）
 *
 * TextField は部品全体を label で包み、その中に案内を出していたため、案内が入力欄の名前に
 * 混ざっていた（例: 「氏名 氏名を入力してください」）。また role="alert" の要素を案内ごと
 * 後から差し込んでいたので、読み上げられないことがあった（MDN alert role）。
 * 見出しは label の for で結びつけ、案内の入れ物は最初から置いて中身だけを入れ替える。
 *
 * checkout の配送先フォームと、お問い合わせフォームで確かめる。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
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

test.describe("FR-UI-006 入力欄の誤りの案内", () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-375-AC-01 / AC-02 / AC-03
    test(`${viewport.name}（${viewport.width}px）checkout: 案内は欄の名前に混ざらず説明になり、入れ物は最初からある`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await mockCheckoutApis(page);
      await page.goto("/checkout");

      // 案内が出る前から、読み上げ用の入れ物が空で置かれている。欄の誤りは一度に複数出うるので、
      // 割り込まない polite（FREQ-376）
      const alert = page.locator("#fullName-error");
      await expect(alert).toHaveAttribute("aria-live", "polite");
      await expect(alert).toHaveText("");

      // 空のまま確定しようとすると、欄ごとに案内が出る
      await page.getByRole("button", { name: "確認へ進む" }).click();
      await expect(alert).toHaveText(/\S/);
      const message = ((await alert.textContent()) ?? "").trim();

      // 欄の名前は見出しだけ。案内は名前ではなく説明として読まれる
      const input = page.getByRole("textbox", { name: "氏名", exact: true });
      await expect(input).toBeVisible();
      await expect(input).toHaveAccessibleDescription(message);
      await expect(input).toHaveAttribute("aria-invalid", "true");

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-375-AC-01 / AC-02 / AC-03
    test(`${viewport.name}（${viewport.width}px）お問い合わせ: 欄を離れたときの案内も名前に混ざらず説明になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await page.goto("/contact");

      const alert = page.locator("#name-error");
      await expect(alert).toHaveAttribute("aria-live", "polite");
      await expect(alert).toHaveText("");

      // お名前を空のまま次の欄へ移る
      await page.locator("#name").focus();
      await page.locator("#email").focus();
      await expect(alert).toHaveText(/\S/);
      const message = ((await alert.textContent()) ?? "").trim();

      const input = page.getByRole("textbox", { name: "NAME / お名前", exact: true });
      await expect(input).toBeVisible();
      await expect(input).toHaveAccessibleDescription(message);
      await expect(input).toHaveAttribute("aria-invalid", "true");
    });

    // FREQ-375-AC-04
    test(`${viewport.name}（${viewport.width}px）お問い合わせ: メッセージ欄の案内の入れ物も最初からある`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await page.goto("/contact");

      const alert = page.locator("#message-error");
      await expect(alert).toHaveAttribute("aria-live", "polite");
      await expect(alert).toHaveText("");

      // メッセージを空のまま欄を離れる
      await page.locator("#message").focus();
      await page.locator("#name").focus();
      await expect(alert).toHaveText(/\S/);
      const message = ((await alert.textContent()) ?? "").trim();

      await expect(page.locator("#message")).toHaveAccessibleDescription(
        new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });
  }
});
