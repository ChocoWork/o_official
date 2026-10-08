import { expect, test, type Page } from '@playwright/test';
import { fillShippingForm, placeOrderWithTestCard, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';

// 別タブの確認コードとログインの Cookie を通信記録へ残さないため。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

/** ログインでゲストの配送先が会員の欄に置き換わるため、FR-CHECKOUT-046 と同じ会員の入力を行う。 */
async function fillMemberShippingForm(page: Page, member: TestMember): Promise<void> {
  await expect(page.getByLabel('メールアドレス')).toHaveValue(member.email, { timeout: 30_000 });
  await page.getByLabel('氏名').fill('山田花子');
  await page.getByLabel('フリガナ').fill('ヤマダハナコ');
  await page.getByLabel('電話番号').fill('0312345678');
  await page.getByLabel('郵便番号').fill('1500001');
  await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
  await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
  await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
}

test.describe('FR-CHECKOUT-047 決済の途中のログインで合わせたカートを使う', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of viewports) {
    test(`FREQ-428-AC-05: ログインで注文を断った後、引き継いだ商品で確認へ進める (${viewport.name})`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      const detail = await page.request.get(`/api/items/${seeded.itemId}`);
      expect(detail.status()).toBe(200);
      const { name: itemName } = await detail.json() as { name: string };
      await stubPostalCode(page);
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-cart-merged-${viewport.name}-${Date.now()}@example.com`);
      await proceedToFinal(page);

      // FR-CHECKOUT-046 と同じく、ゲストの最終確認画面を開いたまま別タブでログインする。
      const member = await createTestMember(`checkout-merge-${viewport.name}`);
      const other = await context.newPage();
      try {
        await other.goto('/');
        await loginAsMember(other, member);
      } finally {
        await other.close();
      }
      const placeOrderResponse = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/checkout/place-order',
        { timeout: 120_000 },
      );
      await placeOrderWithTestCard(page);
      const denied = await placeOrderResponse;
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toMatchObject({ error: 'forbidden' });
      await expect(page.getByTestId('checkout-session-error')).toContainText('ログインの状態が変わりました。', { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeHidden();
      await fillMemberShippingForm(page, member);
      await proceedToFinal(page);
      await expect(page.locator('.checkout-summary').getByText(itemName, { exact: true })).toBeVisible();
    });
  }
});
