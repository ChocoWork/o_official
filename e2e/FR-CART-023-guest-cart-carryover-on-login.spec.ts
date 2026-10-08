import { expect, test } from '@playwright/test';
import { seedCart } from './checkout-flow-helpers';
import { createTestMember, loginAsMember } from './member-session-helpers';

// 確認コードとログインの Cookie を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-CART-023 ゲストのカートをログインで引き継ぐ (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FREQ-428-AC-01・FREQ-431-AC-01・FREQ-431-AC-02・FREQ-432-AC-04: ログインで残り、ログアウトで消え、もう一度のログインで戻る', async ({ page, context }) => {
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;

      const cartCookie = (await context.cookies()).find((cookie) => cookie.name === 'cart');
      // 属性だけを比較し、失敗した時の差分にも Cookie の値を出さない。
      expect(cartCookie ? { httpOnly: cartCookie.httpOnly, sameSite: cartCookie.sameSite, path: cartCookie.path } : null)
        .toEqual({ httpOnly: true, sameSite: 'Lax', path: '/' });
      const lifetimeSeconds = (cartCookie?.expires ?? 0) - Date.now() / 1000;
      expect(lifetimeSeconds).toBeGreaterThan(14 * 24 * 60 * 60 - 120);
      expect(lifetimeSeconds).toBeLessThanOrEqual(14 * 24 * 60 * 60 + 5);

      await page.goto('/cart');
      // CartItemRow は商品名をリンクで出すため、既存の構造で行数と名前を拾う。
      const guestNames = page.locator(`a[href="/item/${seeded.itemId}"]`).filter({ hasText: /\S/ });
      await expect(page.getByRole('button', { name: 'カートから削除', exact: true })).toHaveCount(1);
      await expect(guestNames).toHaveCount(1);
      const itemName = (await guestNames.textContent())?.trim() ?? '';
      expect(itemName.length).toBeGreaterThan(0);
      // 画像のリンクも同じ名前を持つため、文字を持つ商品名のリンクに絞る。
      const itemNameLink = page.getByRole('link', { name: itemName, exact: true }).filter({ hasText: itemName });

      const member = await createTestMember(`cart-carry-${viewport.name}`);
      await loginAsMember(page, member);
      const firstLoginAt = Date.now();
      expect((await context.cookies()).some((cookie) => cookie.name === 'cart')).toBe(false);
      await page.goto('/cart');
      await expect(page.getByRole('button', { name: 'カートから削除', exact: true })).toHaveCount(1);
      await expect(itemNameLink).toBeVisible();

      const csrf = (await context.cookies()).find((cookie) => cookie.name === 'sb-csrf-token')?.value;
      if (!csrf) throw new Error('ログアウトに必要な CSRF の合言葉が無い');
      const logout = await page.request.post('/api/auth/logout', {
        headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf },
      }).catch(() => { throw new Error('ログアウトの要求に失敗した'); });
      expect(logout.status()).toBe(200);
      // ログインで既に消えた Cookie の有無ではなく、ログアウト自体の削除指示を確かめる。
      for (const cookieName of ['cart', 'wishlist']) {
        const deleted = logout.headersArray().some((header) => {
          if (header.name.toLowerCase() !== 'set-cookie') return false;
          const [cookie, ...attributes] = header.value.split(';').map((part) => part.trim());
          // Path が違う指示ではブラウザの Path=/ の Cookie は消えないので、Path=/ も求める
          return cookie === `${cookieName}=` && attributes.some((attribute) => /^path=\/$/i.test(attribute)) &&
            attributes.some((attribute) =>
              /^max-age=0$/i.test(attribute) ||
              (/^expires=/i.test(attribute) && Date.parse(attribute.slice('expires='.length)) <= Date.now()));
        });
        // 応答の Cookie の値を差分に出さず、名前ごとの削除指示の有無だけを比較する。
        expect(deleted, `${cookieName} の Cookie を消す指示があること`).toBe(true);
      }
      await page.goto('/cart');
      await expect(page.getByText('YOUR CART IS EMPTY', { exact: true })).toBeVisible();

      // 同じ会員への確認コードは、手元の Supabase の max_frequency（supabase/config.toml の [auth.email]、1秒）より
      // 短い間隔では送れない（"For security purposes, you can only request this after 0 seconds." で 500）。
      // 1回目のログインから間を空けてから、もう一度ログインする
      await page.waitForTimeout(Math.max(0, 1_500 - (Date.now() - firstLoginAt)));
      await loginAsMember(page, member);
      await page.goto('/cart');
      await expect(itemNameLink).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
