import { expect, test, type Page } from '@playwright/test';

/**
 * 支払方法セクションに描画される Stripe の iframe。
 * Stripe は不可視の制御用 iframe も同じ名前で挿す（先頭が必ず表示用とは限らない）ので、
 * 支払方法セクション配下に限定して拾う。
 */
function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

test.describe('FR-CHECKOUT-001 Stripe CheckoutProvider と PaymentElement', () => {
  test.beforeEach(async ({ page }) => {
    // /checkout の決済セッション生成はサーバー側の carts テーブルを session_id
    // クッキーで直接参照するため、/api/cart をモックしても効果がない。
    // page.request は page とクッキーを共有するので、実際に /api/cart へ POST
    // して本物のカート行を作ってから検証する。
    await page.goto('/');

    // ページ内 fetch で投げる。page.request は Origin ヘッダを付けないため
    // /api/cart のオリジン検証に 403 で弾かれる。
    const seeded = await page.evaluate(async () => {
      const itemsResponse = await fetch("/api/items?pageSize=20&sort=newest");
      if (!itemsResponse.ok) {
        return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
      }

      const itemsBody = (await itemsResponse.json()) as {
        items?: { id?: number; price?: number }[];
      };
      // Stripe は JPY で 50 円未満を受け付けない（テスト用の極小価格商品を掴むと
      // create-session が Stripe 側エラーで 500 になる）。50 円以上の商品を選ぶ。
      const seedItem = (itemsBody?.items ?? []).find(
        (item) => typeof item?.id === 'number' && (item?.price ?? 0) >= 50,
      );
      if (!seedItem?.id) {
        return { ok: false, reason: 'No published item priced at 50 JPY or above to seed a real cart' };
      }

      const cartResponse = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: seedItem.id, quantity: 1 }),
      });
      if (!cartResponse.ok) {
        return { ok: false, reason: `/api/cart seeding failed with ${cartResponse.status}` };
      }

      return { ok: true, reason: '' };
    });

    if (!seeded.ok) {
      test.skip(true, seeded.reason);
    }
  });

  test('チェックアウトページは Stripe CheckoutProvider + PaymentElement を表示する', async ({ page }) => {
    await page.goto('/checkout');
    // 1画面化により、遷移操作なしで支払方法が描画される
    await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });
  });

  // FREQ-354-AC-04: セッション生成は1回だけ。
  // FR-CHECKOUT-021 では create-session を常に 429 に固定していたため
  // このテストが失敗し得なかった（実クライアントシークレットを一度も見ない）。
  // 実カートを流し込んで本物のセッションを作らせるこのファイルで数える。
  test('決済セッション生成は1回だけ実行される', async ({ page }) => {
    let createSessionCalls = 0;
    await page.route('**/api/checkout/create-session', async (route) => {
      createSessionCalls += 1;
      await route.continue();
    });

    await page.goto('/checkout');
    await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });

    expect(createSessionCalls).toBe(1);
  });
});
