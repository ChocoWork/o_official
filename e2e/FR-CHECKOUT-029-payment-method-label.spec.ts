import { expect, test, type Frame, type Page } from "@playwright/test";
import { waitForPositionToSettle } from "./checkout-test-utils";

/**
 * FR-CHECKOUT-029 確認画面の支払方法を、注文詳細と同じ名前で表示する
 * 対応 FREQ: FREQ-371（AC-01）
 *
 * 決済フォームで選んだ手段を丸めずに持ち、注文詳細（/api/orders/[id]）と同じ変換で表示する。
 * 確認画面は決済の確定後にしか出ないので、Stripe テストモードの実セッションで
 * テスト用カード（4242…）の決済を確定する。カードは FR-CHECKOUT-022 と同じく実 API で用意し、
 * 用意できない環境ではスキップする。「注文する」は押さない（注文と在庫は変えない）。
 *
 * Link・銀行振込など、テストモードで確認画面まで進められない手段の表示は
 * 単体テスト（tests/unit/features/checkout/payment-method-label.test.ts）で確かめる。
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

async function stubPostalCode(page: Page): Promise<void> {
  await page.route("**/api/checkout/postal-code**", (route) =>
    route.fulfill({
      json: { address: { prefecture: "東京都", city: "渋谷区", address: "神宮前1-2-3" } },
    }),
  );
}

async function fillShippingForm(page: Page): Promise<void> {
  await page.getByLabel("氏名").fill("山田花子");
  await page.getByLabel("フリガナ").fill("ヤマダハナコ");
  await page.getByLabel("メールアドレス").fill("e2e-payment-label@example.com");
  await page.getByLabel("電話番号").fill("0312345678");
  await page.getByLabel("郵便番号").fill("1500001");
  await expect(page.getByRole("combobox", { name: "都道府県" })).toContainText("東京都");
  await expect(page.getByLabel("市区町村")).toHaveValue("渋谷区");
  await expect(page.getByLabel("番地")).toHaveValue("神宮前1-2-3");
}

/** 支払方法セクションに描画される Stripe の決済フォーム（FR-CHECKOUT-025 と同じ拾い方）。 */
async function paymentElementFrame(page: Page): Promise<Frame> {
  const isPaymentElement = (frame: Frame) => /elements-inner-payment/.test(frame.url());
  await expect.poll(() => page.frames().some(isPaymentElement), { timeout: 30000 }).toBe(true);
  return page.frames().find(isPaymentElement)!;
}

async function fillTestCard(frame: Frame): Promise<void> {
  await frame.getByRole("textbox", { name: "カード番号" }).fill("4242424242424242");
  await frame.getByRole("textbox", { name: "有効期限" }).fill("12 / 34");
  await frame.getByRole("textbox", { name: "セキュリティコード" }).fill("123");
}

test.describe("FR-CHECKOUT-029 確認画面の支払方法の表示", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.reason);
    await stubPostalCode(page);
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-371-AC-01
    test(`${viewport.name}（${viewport.width}px）カードで決済を確定すると、確認画面に注文詳細と同じ「クレジットカード」が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await page.goto("/checkout");

      const frame = await paymentElementFrame(page);
      await fillShippingForm(page);
      await fillTestCard(frame);

      const confirmButton = page.getByRole("button", { name: "確認へ進む" });
      await expect(confirmButton).toBeEnabled({ timeout: 30000 });
      // 決済フォームの展開と Link の自動入力が済むまで待つ（ずれの最中はクリックが外れる）
      await waitForPositionToSettle(confirmButton);

      // Link の保存欄（任意）に電話番号が入ったまま確定すると、Link のアカウントが作られる
      // （Link の規約表示: 電話番号の提供でアカウント作成に同意）。空であることを確かめてから押す。
      const linkPhone = frame.getByRole("textbox", { name: "携帯電話番号" });
      if ((await linkPhone.count()) > 0) {
        await expect(linkPhone).toHaveValue("");
      }
      await confirmButton.click();

      // 決済の確定後に確認画面へ進む
      await expect(page.getByRole("button", { name: "注文する" })).toBeVisible({ timeout: 60000 });
      const paymentSection = page
        .locator("section.checkout-section")
        .filter({ has: page.getByRole("heading", { name: "支払方法", exact: true }) });
      await expect(paymentSection.locator(".checkout-card")).toHaveText("クレジットカード");
      await expect(page.getByText("カード決済")).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
