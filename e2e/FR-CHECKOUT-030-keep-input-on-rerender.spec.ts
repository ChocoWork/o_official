import { expect, test, type Frame, type Locator, type Page } from "@playwright/test";
import { selectPaymentMethod } from "./checkout-test-utils";

/**
 * FR-CHECKOUT-030 ほかの操作で、入力中のプロモーションコード・案内・フォーカスが消えない
 * 対応 FREQ: FREQ-372（AC-01〜AC-04）
 *
 * 画面の関数の中で部品を定義すると、画面が再描画されるたびに別の部品として作り直され、
 * 部品の中の入力・表示中の案内・フォーカスが失われる（React 公式: 部品の定義を入れ子にしない）。
 * 再描画は、ほかの欄への入力・支払方法の切り替え・配送先の同期の完了などで起きる。
 *
 * プロモーションコード欄は決済セッションの準備ができてから出るので、実 Stripe のセッションが要る。
 * カートは FR-CHECKOUT-022 と同じく実 API で用意し、用意できない環境ではスキップする。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

const PROMO_CODE = "E2E-PROMO-KEEP";

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

function promoInput(page: Page): Locator {
  return page.getByPlaceholder("コードを入力");
}

/** 支払方法セクションに描画される Stripe の決済フォーム（FR-CHECKOUT-025 と同じ拾い方）。 */
async function paymentElementFrame(page: Page): Promise<Frame> {
  const isPaymentElement = (frame: Frame) => /elements-inner-payment/.test(frame.url());
  await expect.poll(() => page.frames().some(isPaymentElement), { timeout: 30000 }).toBe(true);
  return page.frames().find(isPaymentElement)!;
}

/** checkout を開き、プロモーションコード欄が出る（決済セッションの準備ができる）まで待つ。 */
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

/**
 * 配送先の同期（デバウンス後の update-shipping）の応答を、こちらが解放するまで保留する。
 * 同期が終わると画面が再描画されるので、その瞬間をテストから決められるようにする。
 */
async function holdShippingSync(
  page: Page,
): Promise<{ requested: Promise<void>; release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });

  await page.route("**/api/checkout/update-shipping", async (route) => {
    markRequested();
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });

  return { requested, release };
}

/** 画面の更新が描画に反映されるまで（2フレーム）待つ。 */
async function waitForNextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.describe("FR-CHECKOUT-030 ほかの操作で入力中の内容が消えない", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: "ja-JP" });

  test.beforeEach(async ({ page }) => {
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.reason);
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

    // FREQ-372-AC-03
    test(`${viewport.name}（${viewport.width}px）コードを入力した後に支払方法を PayPay に切り替えても、コードが消えない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckout(page);
      const frame = await paymentElementFrame(page);

      await promoInput(page).fill(PROMO_CODE);
      await selectPaymentMethod(page, frame, "PayPay");

      await expect(promoInput(page)).toHaveValue(PROMO_CODE);
    });

    // FREQ-372-AC-04
    test(`${viewport.name}（${viewport.width}px）「確認へ進む」にフォーカスがある間に配送先の同期が終わっても、フォーカスが外れない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const sync = await holdShippingSync(page);
      await openCheckout(page);

      // 入力を終えるとデバウンス後に同期が走る（応答は保留中）
      await fillShippingForm(page);
      await sync.requested;

      const confirmButton = page.getByRole("button", { name: "確認へ進む" });
      await expect(confirmButton).toBeEnabled({ timeout: 30000 });
      await confirmButton.focus();
      await expect(confirmButton).toBeFocused();

      // 同期を完了させる。完了で画面が再描画されても、フォーカスは同じボタンに残る
      const synced = page.waitForResponse("**/api/checkout/update-shipping");
      sync.release();
      await synced;
      await waitForNextPaint(page);

      await expect(confirmButton).toBeFocused();
    });
  }
});
