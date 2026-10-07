import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * FR-CHECKOUT-032 プロモーションコードを適用できなかった案内を読み上げ、入力欄に結びつける
 * 対応 FREQ: FREQ-374（AC-01 / AC-02）
 *
 * 案内が入力欄に結びついていないと、欄に戻っても理由が読まれない（WCAG 3.3.1、W3C ARIA21）。
 * 案内が出ても読み上げられないと、画面を見ていない利用者は失敗に気づけない（WCAG 4.1.3）。
 * role="alert" の要素を案内ごと後から差し込むと読み上げられないことがある（MDN）ので、
 * 案内の入れ物は最初から置き、中身だけを入れ替える。
 *
 * プロモーションコード欄は入力画面に常にある。「適用」はサーバーが Stripe に問い合わせて確かめる（グループ F）。
 * カートは FR-CHECKOUT-022 と同じく実 API で用意し、用意できない環境ではスキップする。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

/** Stripe に存在しないコード。適用すると、サーバーの文言（このコードは使えません）が返る。 */
const UNKNOWN_CODE = "E2E-PROMO-UNKNOWN";

async function seedCart(page: Page): Promise<{ ok: boolean; reason: string }> {
  await page.goto("/");
  return page.evaluate(async () => {
    const itemsResponse = await fetch("/api/items?pageSize=20&sort=newest");
    if (!itemsResponse.ok) {
      return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
    }
    const body = (await itemsResponse.json()) as { items?: { id?: number; price?: number }[] };
    const item = (body.items ?? []).find((i) => typeof i?.id === "number" && (i?.price ?? 0) >= 50);
    if (!item?.id) {
      return { ok: false, reason: "No published item priced at 50 JPY or above" };
    }
    const cartResponse = await fetch("/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: item.id, quantity: 1 }),
    });
    return cartResponse.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `cart seeding failed ${cartResponse.status}` };
  });
}

function promoInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "プロモーションコード", exact: true });
}

/** プロモーションコード欄（見出し・入力欄・適用ボタン・案内）のまとまり。 */
function promoSection(page: Page): Locator {
  return page.locator(".checkout-section").filter({ has: promoInput(page) });
}

/**
 * プロモーションコード欄の案内の入れ物（欄のまとまりの直下の role="alert"）。
 * 案内は入力欄と適用ボタンの下に全幅で出すので、TextField の中の入れ物（空のまま）ではなくこちらを使う。
 */
function promoAlert(page: Page): Locator {
  return promoSection(page).locator(':scope > [role="alert"]');
}

/** checkout を開き、プロモーションコード欄が出るまで待つ。 */
async function openCheckout(page: Page): Promise<void> {
  await page.goto("/checkout");
  await expect(promoInput(page)).toBeVisible({ timeout: 30000 });
}

async function applyUnknownCode(page: Page): Promise<void> {
  await promoInput(page).fill(UNKNOWN_CODE);
  await page.getByRole("button", { name: "適用", exact: true }).click();
}

test.describe("FR-CHECKOUT-032 プロモーションコードを適用できなかった案内", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.reason);
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-374-AC-01
    test(`${viewport.name}（${viewport.width}px）案内の入れ物は最初からあり、適用できなかったら中身が入って表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      // 案内が出る前から、読み上げ用の入れ物（role="alert"）が空で置かれている
      const alert = promoAlert(page);
      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText("");

      await applyUnknownCode(page);

      // 同じ入れ物に案内が入り、画面にも表示される
      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText(/\S/, { timeout: 15000 });
      await expect(alert).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-374-AC-02
    test(`${viewport.name}（${viewport.width}px）適用できなかった案内が入力欄に結びつき、入力欄が誤りの状態になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);

      // 誤りが無いうちは、誤りの状態にも説明にもしない
      await expect(promoInput(page)).not.toHaveAttribute("aria-invalid", "true");
      await expect(promoInput(page)).toHaveAccessibleDescription("");

      await applyUnknownCode(page);

      const alert = promoAlert(page);
      await expect(alert).toHaveText(/\S/, { timeout: 15000 });
      const message = ((await alert.textContent()) ?? "").trim();

      await expect(promoInput(page)).toHaveAttribute("aria-invalid", "true");
      await expect(promoInput(page)).toHaveAccessibleDescription(message);
    });
  }
});
