import { expect, test, type Page } from '@playwright/test';
import { waitForPositionToSettle } from './checkout-test-utils';

/**
 * FR-CHECKOUT-027 確定直前の配送先同期
 * 対応 FREQ: FREQ-365（AC-05 / AC-06）
 *
 * 配送先は、画面のデバウンス同期・確定直前の同期・別タブの create-session から書き換わる。
 * 画面が「同期済み」と記憶しているだけで確定直前の同期を省くと、別タブの上書きや遅れて
 * 届いた同期でサーバ側が別の住所になっていても気づけない。確定直前は必ず書き込む。
 *
 * 決済フォームは実 Stripe のセッションが要るため、FR-CHECKOUT-022 と同じくカートを
 * 実 API で用意する（用意できない環境ではスキップする）。配送先の書き込み API だけは
 * 横取りして、呼び出し回数と拒否時の挙動を見る。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

async function seedCart(page: Page): Promise<{ ok: boolean; reason: string }> {
  await page.goto('/');
  return page.evaluate(async () => {
    const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
    if (!itemsResponse.ok) {
      return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
    }
    const body = (await itemsResponse.json()) as { items?: { id?: number; price?: number }[] };
    const item = (body.items ?? []).find((i) => typeof i?.id === 'number' && (i?.price ?? 0) >= 50);
    if (!item?.id) {
      return { ok: false, reason: 'No published item priced at 50 JPY or above' };
    }
    const cartResponse = await fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: item.id, quantity: 1 }),
    });
    return cartResponse.ok
      ? { ok: true, reason: '' }
      : { ok: false, reason: `cart seeding failed ${cartResponse.status}` };
  });
}

async function stubPostalCode(page: Page): Promise<void> {
  await page.route('**/api/checkout/postal-code**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address: { prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3' },
      }),
    });
  });
}

type ShippingSyncState = { calls: number; respondWith: 'ok' | 'stale' };

/** 配送先の書き込み API を横取りして、呼び出し回数を数える。 */
async function interceptShippingSync(page: Page): Promise<ShippingSyncState> {
  const state: ShippingSyncState = { calls: 0, respondWith: 'ok' };
  let revision = 1;

  await page.route('**/api/checkout/update-shipping', async (route) => {
    state.calls += 1;

    if (state.respondWith === 'stale') {
      // 別タブや遅れて届いた同期が先に版を進めた状態。
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'stale_shipping_revision', revision: 9 }),
      });
      return;
    }

    revision += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, revision }),
    });
  });

  return state;
}

async function fillShippingForm(page: Page): Promise<void> {
  await page.getByLabel('氏名').fill('山田太郎');
  await page.getByLabel('フリガナ').fill('ヤマダタロウ');
  await page.getByLabel('メールアドレス').fill('e2e-shipping-sync@example.com');
  await page.getByLabel('電話番号').fill('0312345678');
  await page.getByLabel('郵便番号').fill('1500001');

  // 郵便番号から都道府県・市区町村・番地が埋まる
  await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
  await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
  await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
}

test.describe('FR-CHECKOUT-027 確定直前の配送先同期', () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-365-AC-05
    test(`${viewport.name}（${viewport.width}px）住所を変えずに確認へ進んでも、確定直前に配送先を書き込む`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.reason);

      await stubPostalCode(page);
      const sync = await interceptShippingSync(page);

      await page.goto('/checkout');
      await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });
      await fillShippingForm(page);

      // 入力が止まると同期が走る（デバウンス）
      await expect.poll(() => sync.calls, { timeout: 15000 }).toBeGreaterThan(0);
      const callsBeforeConfirm = sync.calls;

      // ここで住所は変えない。画面の記憶では「同期済み」でも、確定直前は必ず書き込む。
      const confirmButton = page.getByRole('button', { name: '確認へ進む' });
      await waitForPositionToSettle(confirmButton);
      await confirmButton.click();

      await expect.poll(() => sync.calls, { timeout: 15000 }).toBeGreaterThan(callsBeforeConfirm);
    });

    // FREQ-365-AC-06
    test(`${viewport.name}（${viewport.width}px）配送先の書き込みが拒否されたら案内を出し、注文確認へ進まない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.reason);

      await stubPostalCode(page);
      const sync = await interceptShippingSync(page);

      await page.goto('/checkout');
      await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });
      await fillShippingForm(page);
      await expect.poll(() => sync.calls, { timeout: 15000 }).toBeGreaterThan(0);

      // 別タブが先に配送先を書き換えた状態にする
      sync.respondWith = 'stale';
      const confirmButton = page.getByRole('button', { name: '確認へ進む' });
      await waitForPositionToSettle(confirmButton);
      await confirmButton.click();

      await expect(page.getByText('配送先の反映に失敗しました')).toBeVisible();
      // 注文確認（STEP 2）へは進まない
      await expect(page.getByRole('button', { name: '注文する' })).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
