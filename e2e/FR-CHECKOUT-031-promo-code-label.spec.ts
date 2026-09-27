import { expect, test, type Page } from "@playwright/test";

/**
 * FR-CHECKOUT-031 プロモーションコードの見出しを入力欄に結びつける
 * 対応 FREQ: FREQ-373（AC-01 / AC-02）
 *
 * 見出し（label）が入力欄に結びついていないと、スクリーンリーダーでは欄の名前として
 * 見出しが読まれず、見出しを押しても入力欄にカーソルが移らない（WCAG 1.3.1 / 4.1.2、W3C H44）。
 * プレースホルダ「コードを入力」は入力を始めると消えるので、見出しの代わりにならない。
 *
 * プロモーションコード欄は決済セッションの準備ができてから出るので、実 Stripe のセッションが要る。
 * カートは FR-CHECKOUT-022 と同じく実 API で用意し、用意できない環境ではスキップする。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

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

/** checkout を開き、プロモーションコード欄が出る（決済セッションの準備ができる）まで待つ。 */
async function openCheckout(page: Page): Promise<void> {
  await page.goto("/checkout");
  await expect(page.getByPlaceholder("コードを入力")).toBeVisible({ timeout: 30000 });
}

test.describe("FR-CHECKOUT-031 プロモーションコードの見出しと入力欄", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.reason);
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
