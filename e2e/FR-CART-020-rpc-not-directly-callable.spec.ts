import { expect, test } from '@playwright/test';

// FREQ-322: カート・お気に入りの SECURITY DEFINER 関数を PostgREST の RPC 面から外す
//
// 持ち主の判定（cart・wishlist の Cookie の印の照合、会員の確かめ）はアプリの窓口が行い、
// DB の関数は渡されたカートの番号・会員の ID をそのまま信じる。anon に EXECUTE が開いていると、
// アプリのレート制限・監査ログ・Origin 検査を素通りして、他人のカートの変更や
// ゲストの分の会員への合わせ込みを直接叩けてしまう。ここでは「anon から呼べないこと」を見る。

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const RPCS = [
  { name: 'cart_add_lines', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _lines: [{ variant_id: 1, quantity: 1 }] } },
  { name: 'cart_change_line', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _line_id: '00000000-0000-0000-0000-000000000000', _quantity: 1 } },
  { name: 'merge_guest_into_member', body: { _user_id: '00000000-0000-0000-0000-000000000000', _cart_token_hash: null, _wishlist_token_hash: null } },
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

      // 入力不正の 400 を権限拒否と誤認しないため、権限不足・関数非公開の code か状態に絞る。
      const body = await response.json().catch(() => null) as { code?: string } | null;
      expect(['42501', 'PGRST202'].includes(body?.code ?? '') || [401, 403, 404].includes(response.status())).toBe(true);
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

    // 空カートは EmptyPage（見出しではなくラベル）を描く。ページが例外で落ちず、
    // 継続導線まで出ることを確認する。数量変更・削除の操作自体は FR-CART-001-008 が担当する。
    await expect(page.getByText('YOUR CART IS EMPTY')).toBeVisible();
    await expect(page.getByRole('link', { name: 'CONTINUE SHOPPING' })).toBeVisible();
  });
}
