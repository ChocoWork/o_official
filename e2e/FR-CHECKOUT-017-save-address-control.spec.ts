import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";
import { stubCheckoutSessionApis, waitForPositionToSettle } from "./checkout-test-utils";

/** 保存先はログイン中のプロフィール／配送先なので、チェックはログイン時のみ出る。 */
async function openCheckout(page: Page, authenticated: boolean) {
  await stubCheckoutSessionApis(page);
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticated
        ? {
            authenticated: true,
            user: {
              id: "user-1",
              email: "hanako@example.com",
              role: "user",
              mfaVerified: true,
            },
          }
        : { authenticated: false, user: null },
    }),
  );
  await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.goto("/checkout");
  await expect(page.locator('input[name="building"]')).toBeVisible();
}

for (const width of [320, 375, 768, 1280]) {
  test(`save address alignment and hit area at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await openCheckout(page, true);
    const checkbox = page.getByRole("checkbox", {
      name: "この配送先を保存する",
    });
    const row = page.locator(".checkout-save-address");
    await checkbox.scrollIntoViewIfNeeded();
    const fieldRect = await page
      .locator('input[name="building"]')
      .boundingBox();
    const boxRect = await checkbox.boundingBox();
    const rowRect = await row.boundingBox();
    expect(Math.abs(boxRect!.x - fieldRect!.x)).toBeLessThanOrEqual(1);
    expect(rowRect!.height).toBeGreaterThanOrEqual(44);
    await expect(row).toHaveCSS("padding-left", "0px");
    await expect(checkbox).toHaveCSS("border-radius", "0px");
    const fontSize = parseFloat(
      await row.evaluate((el) => getComputedStyle(el).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(13);
    expect(fontSize).toBeLessThanOrEqual(15);
    expect(boxRect!.width).toBeGreaterThan(fontSize);
    await expect(checkbox).not.toBeChecked();
    await row.click({
      position: { x: rowRect!.width - 5, y: rowRect!.height / 2 },
    });
    await expect(checkbox).toBeChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });

  test(`save address is separated from the address fields at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await openCheckout(page, true);
    await page.locator(".checkout-save-address").scrollIntoViewIfNeeded();

    const gaps = await page.evaluate(() => {
      const bottomOf = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().bottom;
      const topOf = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().top;
      // 欄どうしの間隔（番地 → 建物名）とその次に来る保存チェックまでの間隔
      return {
        betweenFields:
          topOf('[data-ui-text-field]:has(input[name="building"])') -
          bottomOf('[data-ui-text-field]:has(input[name="address"])'),
        beforeSave:
          topOf(".checkout-save-address") -
          bottomOf('[data-ui-text-field]:has(input[name="building"])'),
      };
    });

    expect(gaps.betweenFields).toBeGreaterThan(0);
    expect(gaps.beforeSave).toBeGreaterThanOrEqual(gaps.betweenFields * 2);
  });

  test(`save address is hidden for guests at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await openCheckout(page, false);

    await expect(page.locator(".checkout-save-address")).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "この配送先を保存する" }),
    ).toHaveCount(0);
  });
}

/**
 * FREQ-366 保存済み住所が0件のログインユーザーでも配送先を保存する
 *
 * 保存は「確認へ進む」の中（決済の画面を作る前）で走る。カートは実 API で用意する（create-session が実際のカートを読むため）。
 * 用意できない環境では、FR-CHECKOUT-022 と同じくスキップする。
 * 保存先の API（プロフィール・住所帳）は横取りして、呼ばれたことと中身だけを見る。
 */
const SAVE_BEHAVIOR_VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
] as const;

type ProfileSaveCalls = { profile: number; addresses: number; addressesBody: unknown };

async function seedCartForCheckout(
  page: Page,
): Promise<{ ok: boolean; reason: string }> {
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

/** ログイン状態にして、プロフィールと住所帳（0件）への保存を横取りする。 */
async function interceptProfileSaves(page: Page): Promise<ProfileSaveCalls> {
  const calls: ProfileSaveCalls = { profile: 0, addresses: 0, addressesBody: null };

  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({
      status: 200,
      headers: { "set-cookie": "sb-csrf-token=e2e-csrf-token; Path=/; SameSite=Lax" },
      json: { ok: true },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "user-1", email: "hanako@example.com", role: "user", mfaVerified: true },
      },
    }),
  );
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "POST") {
      calls.profile += 1;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    // 会員だがプロフィールは未入力（メールアドレスはアカウントの値で埋まる）。
    await route.fulfill({ json: { email: "hanako@example.com" } });
  });
  await page.route("**/api/profile/addresses", async (route) => {
    if (route.request().method() === "PUT") {
      calls.addresses += 1;
      calls.addressesBody = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true } });
      return;
    }
    // 住所帳は0件（初めて買うログインユーザー）
    await route.fulfill({ json: { addresses: [] } });
  });
  await page.route("**/api/checkout/postal-code**", (route) =>
    route.fulfill({
      json: { address: { prefecture: "東京都", city: "渋谷区", address: "神宮前1-2-3" } },
    }),
  );

  return calls;
}

/**
 * 「確認へ進む」を押す。処理中は押せないので、押せるようになるまで待ってから押す。
 * 入力画面に決済フォームは無いので、決済フォームが伸びてボタンがずれることは無い。ただ、プロフィール・
 * 住所帳の読み込みや郵便番号からの住所の補完で画面が描き直されている最中に押すと、クリックが外れうる
 * ので、念のため位置が落ち着いてから押す。
 */
async function clickConfirm(page: Page): Promise<void> {
  const confirmButton = page.getByRole("button", { name: "確認へ進む" });
  await expect(confirmButton).toBeEnabled({ timeout: 30000 });
  await waitForPositionToSettle(confirmButton);
  await confirmButton.click();
}

test.describe("FR-CHECKOUT-017 保存済み住所が0件でも配送先を保存する", () => {
  for (const viewport of SAVE_BEHAVIOR_VIEWPORTS) {
    // FREQ-366-AC-01 / AC-02
    test(`${viewport.name}（${viewport.width}px）チェックを ON にして確認へ進むと、プロフィールと住所帳へ保存する`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const seeded = await seedCartForCheckout(page);
      test.skip(!seeded.ok, seeded.reason);

      const calls = await interceptProfileSaves(page);

      await page.goto("/checkout");

      await page.getByLabel("氏名").fill("山田花子");
      await page.getByLabel("フリガナ").fill("ヤマダハナコ");
      // ログイン中のメールアドレスはアカウントの値で読み取り専用。
      await expect(page.getByLabel("メールアドレス")).toHaveValue("hanako@example.com");
      await page.getByLabel("電話番号").fill("0312345678");
      await page.getByLabel("郵便番号").fill("1500001");
      await expect(page.getByRole("combobox", { name: "都道府県" })).toContainText("東京都");
      await expect(page.getByLabel("市区町村")).toHaveValue("渋谷区");

      // 入力が保持されていること（保持されないまま進むと、確定前の検証で止まる）
      await expect(page.getByLabel("氏名")).toHaveValue("山田花子");
      await expect(page.getByLabel("電話番号")).not.toHaveValue("");
      await expect(page.getByLabel("郵便番号")).not.toHaveValue("");

      // 住所帳が空なので保存済み配送先の選択肢は出ず、フォームとチェックだけが出る
      await expect(page.getByRole("combobox", { name: "保存済みの配送先" })).toHaveCount(0);
      const saveCheckbox = page.getByRole("checkbox", { name: "この配送先を保存する" });
      await saveCheckbox.check();
      await expect(saveCheckbox).toBeChecked();

      await clickConfirm(page);

      await expect.poll(() => calls.addresses, { timeout: 15000 }).toBeGreaterThan(0);
      expect(calls.profile).toBeGreaterThan(0);
      expect(
        (calls.addressesBody as { addresses?: Record<string, unknown>[] })?.addresses?.[0],
      ).toMatchObject({
        postalCode: "1500001",
        prefecture: "東京都",
        city: "渋谷区",
        address: "神宮前1-2-3",
        isDefault: true,
      });
    });
  }
});
