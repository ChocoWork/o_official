import { expect, test } from '@playwright/test';

// FREQ-322: ゲストカートの SECURITY DEFINER 関数を PostgREST の RPC 面から外す
//
// 所有権の判定は「引数 _session_id と carts.session_id の一致」だけなので、
// anon に EXECUTE が開いているとアプリのレート制限・監査ログ・Origin 検査を
// 素通りして直接叩けてしまう。ここでは「anon から呼べないこと」を見る。

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const RPCS = [
  { name: 'delete_cart_item_secure', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _session_id: 'probe' } },
  { name: 'update_cart_item_quantity_secure', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _session_id: 'probe', _quantity: 1 } },
];

test.describe('FR-CART-020 guest cart RPC is not reachable from the browser role', () => {
  for (const rpc of RPCS) {
    // FREQ-322-AC-01
    test(`${rpc.name} rejects the publishable key`, async ({ request }) => {
      test.skip(!SUPABASE_URL || !ANON_KEY, 'Supabase の公開値が env に無い');

      const response = await request.post(`${SUPABASE_URL}/rest/v1/rpc/${rpc.name}`, {
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        data: rpc.body,
        failOnStatusCode: false,
      });

      // 権限が剥がれていれば PostgREST は 404（関数が見えない）か 403 を返す。
      // 200 が返るなら anon から実行できてしまっている。
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
    });
  }
});

// FREQ-322-AC-03: アプリ経由のカート操作は従来どおり動くこと（回帰）
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test(`the cart page still renders after moving the RPC behind service role (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/cart');

    // 空カートでも「カート」の見出しが出ることを確認する。
    // 数量変更・削除の操作自体は FR-CART-001-008 が担当する。
    await expect(page.getByRole('heading', { name: /CART|カート/i }).first()).toBeVisible();
  });
}
