import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";
import { stubCheckoutSessionApis } from "./checkout-test-utils";

async function openCheckout(page: Page, authenticated = false) {
  await page
    .context()
    .addCookies([
      {
        name: "sb-csrf-token",
        value: "test-csrf-token",
        url: "http://localhost:3000",
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);
  await stubCheckoutSessionApis(page);
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated,
        user: authenticated ? { role: "user", mfaVerified: true } : null,
      },
    }),
  );
  await page.route("**/api/profile", (route) =>
    route.fulfill({
      json: authenticated
        ? {
            fullName: "Test Customer",
            email: "customer@example.com",
            phone: "",
          }
        : {},
    }),
  );
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.goto("/checkout");
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
}

for (const width of [375, 768, 1280]) {
  for (const [name, value] of [
    ["fullName", "Test Customer"],
    ["kanaName", "Yamada Taro"],
    ["email", "customer@example.com"],
    ["phone", "09012345678"],
  ]) {
    test(`${width}px ${name} preserves focus and input DOM while typing`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 852 });
      await openCheckout(page);
      const field = page.locator(`input[name="${name}"]`);
      const original = await field.elementHandle();
      await field.pressSequentially(value, { delay: 35 });
      expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
      await expect(field).toBeFocused();
      if (name === "phone")
        expect((await field.inputValue()).replace(/\D/g, "")).toBe(value);
      else await expect(field).toHaveValue(value);
    });
  }
}

test("incomplete signed-in customer stays editable while entering phone", async ({
  page,
}) => {
  await openCheckout(page, true);
  await expect(page.locator('input[name="email"]')).toHaveValue(
    "customer@example.com",
  );
  const phone = page.locator('input[name="phone"]');
  await phone.pressSequentially("09012345678", { delay: 35 });
  await expect(phone).toBeFocused();
  expect((await phone.inputValue()).replace(/\D/g, "")).toBe("09012345678");
});

for (const [name, text] of [
  ["fullName", "山田太郎"],
  ["kanaName", "ヤマダタロウ"],
]) {
  test(`${name} preserves the input throughout IME composition`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 852 });
    await openCheckout(page);
    const field = page.locator(`input[name="${name}"]`);
    await field.focus();
    const original = await field.elementHandle();
    const cdp = await context.newCDPSession(page);
    for (const value of [text.slice(0, 1), text.slice(0, 2), text]) {
      await cdp.send("Input.imeSetComposition", {
        text: value,
        selectionStart: value.length,
        selectionEnd: value.length,
      });
      await expect(field).toBeFocused();
      expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
    }
    await cdp.send("Input.insertText", { text });
    await expect(field).toHaveValue(text);
    await page.keyboard.insertText("子");
    await expect(field).toHaveValue(text + "子");
    await expect(field).toBeFocused();
  });
}

test("signed-in customer saves explicitly and can cancel a later edit", async ({
  page,
}) => {
  await openCheckout(page, true);
  const phone = page.locator('input[name="phone"]');
  await expect(page.locator('input[name="email"]')).toHaveValue(
    "customer@example.com",
  );
  await phone.pressSequentially("09012345678", { delay: 20 });
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(phone).toBeHidden();
  await page
    .getByRole("button", { name: "変更する", exact: true })
    .first()
    .click();
  await expect(phone).toHaveValue("090-1234-5678");
  await phone.fill("08011112222");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(phone).toBeHidden();
  await page
    .getByRole("button", { name: "変更する", exact: true })
    .first()
    .click();
  await expect(phone).toHaveValue("090-1234-5678");
});
