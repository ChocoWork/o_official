import { expect, test, type Page } from "@playwright/test";

/**
 * FR-CHECKOUT-028 決済フォームの準備ができるまで「確認へ進む」を押せない
 * 対応 FREQ: FREQ-367（AC-01 / AC-02）
 *
 * 決済フォームの初期化が終わる前に押せてしまうと、「初期化が完了していません」という案内が
 * 出るだけで先に進めない。押せる状態＝決済に進める状態にする。
 *
 * 決済セッションの応答を保留して「準備中」の状態を作り、入力を済ませてから解放する。
 * こうすると、初期化の途中で押してしまう状況を確実に再現できる。
 * 実 Stripe のセッションが要るため、カートは実 API で用意する（用意できない環境ではスキップ）。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

/** 準備中は表示が変わるので、どちらの文言でも掴めるようにする。 */
const CONFIRM_BUTTON = /確認へ進む|決済フォームを準備中/;

const NOT_READY_MESSAGE = "決済フォームの初期化が完了していません";

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

/** 決済セッションの応答を、こちらが解放するまで保留する。 */
async function holdCheckoutSession(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/checkout/create-session", async (route) => {
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });

  return release;
}

async function stubPostalCode(page: Page): Promise<void> {
  await page.route("**/api/checkout/postal-code**", (route) =>
    route.fulfill({
      json: { address: { prefecture: "東京都", city: "渋谷区", address: "神宮前1-2-3" } },
    }),
  );
}

async function fillShippingForm(page: Page): Promise<void> {
  await page.getByLabel("氏名").fill("山田太郎");
  await page.getByLabel("フリガナ").fill("ヤマダタロウ");
  await page.getByLabel("メールアドレス").fill("e2e-confirm-ready@example.com");
  await page.getByLabel("電話番号").fill("0312345678");
  await page.getByLabel("郵便番号").fill("1500001");
  await expect(page.getByRole("combobox", { name: "都道府県" })).toContainText("東京都");
  await expect(page.getByLabel("市区町村")).toHaveValue("渋谷区");
}

test.describe("FR-CHECKOUT-028 決済フォームの準備ができるまで確認へ進めない", () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-367-AC-01 / AC-02
    test(`${viewport.name}（${viewport.width}px）準備中は押せず、押せるようになったら決済に進める`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.reason);

      await stubPostalCode(page);
      const releaseCheckoutSession = await holdCheckoutSession(page);

      await page.goto("/checkout");

      const confirmButton = page.getByRole("button", { name: CONFIRM_BUTTON });

      // 決済セッションの取得中は押せない
      await expect(confirmButton).toBeDisabled();

      // 入力を済ませてから応答を解放する（初期化の途中で押す状況を作る）
      await fillShippingForm(page);
      releaseCheckoutSession();

      // 押せるようになった瞬間に押す
      await expect(confirmButton).toBeEnabled({ timeout: 30000 });
      await confirmButton.click();

      // 押せたのに「初期化が完了していません」で止まることがない
      await expect(page.getByText(NOT_READY_MESSAGE)).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
