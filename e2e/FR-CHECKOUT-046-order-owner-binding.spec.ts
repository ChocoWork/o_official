/**
 * FR-CHECKOUT-046 ログイン客の注文の持ち主（グループ C）
 * 対応 FREQ: FREQ-426（AC-01）・FREQ-427（AC-01・AC-02）。FREQ-426-AC-02 は DB 結合テスト（checkout_order_owner_binding）で確かめる。
 * FREQ-427 の2つは、サーバーが断る経路が違う。AC-01 はログインでカートの印が新しくなるので 403（決済の画面がこのカートのものでない）、
 * AC-02 はカートの印が残ったままログインの Cookie だけが無くなるので、買い手を比べて 409 login_changed（設計書 4-3）。
 * 会員は手元の Supabase に試験ごとに作る（e2e/member-session-helpers.ts）。手元以外では動かない。
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { toOrderNumber } from '../src/lib/orders/order-number';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';

const LOGIN_CHANGED = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';
const LOGIN_COOKIE_NAMES = ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token'];
const CART_COOKIE_NAME = 'session_id';

/** 会員の入力画面。メールアドレスはアカウントのもので読み取り専用なので、ほかの欄だけを埋める */
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

function localDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('注文を読めるのは手元の Supabase だけ');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function orderIdsOwnedBy(userId: string): Promise<string[]> {
  const { data, error } = await localDb().from('orders').select('id').eq('user_id', userId);
  if (error) throw new Error('手元の注文を読めない');
  return (data ?? []).map((order: { id: string }) => order.id);
}

async function orderIdsShippedTo(email: string): Promise<string[]> {
  const { data, error } = await localDb().from('orders').select('id').eq('shipping_email', email);
  if (error) throw new Error('手元の注文を読めない');
  return (data ?? []).map((order: { id: string }) => order.id);
}

/** このカート（session_id の Cookie の値）の注文。注文はカートの印を持つので、持ち主やメールが違っても拾える */
async function orderIdsOfCart(cartSessionId: string): Promise<string[]> {
  const { data, error } = await localDb().from('orders').select('id').eq('session_id', cartSessionId);
  if (error) throw new Error('手元の注文を読めない');
  return (data ?? []).map((order: { id: string }) => order.id);
}

/**
 * 「注文する」の通信。押す前に待ち受けて、サーバーがどの経路（何番）で断ったかを確かめる。
 * 待ち受けはカード番号の入力の前から始まるので、入力の待ちを含めても切れないよう、待ち時間を長くとる
 */
function waitForPlaceOrderResponse(page: Page) {
  return page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/checkout/place-order',
    { timeout: 120_000 },
  );
}

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

test.describe('FR-CHECKOUT-046 ログイン客の注文の持ち主', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    // FREQ-426-AC-01
    test(`${viewport.name}（${viewport.width}px）会員の注文は、完了の処理がログインなしでも注文履歴に出る`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const member = await createTestMember(`owner-${viewport.name}`);
      await loginAsMember(page, member);
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);

      // 別のブラウザに戻った形にするため、完了の要求だけ、ログインの Cookie を外して送る（カートの Cookie は残す）。
      // route.continue の headers では Cookie を書き換えられない（Playwright は Cookie などの見出しの上書きを捨てる）。
      // そこで route.fetch に Cookie の見出しを自分で組んで渡す（見出しがあれば、Playwright は Cookie の保管庫を引かない）。
      const completeCalls: Array<{
        status: number;
        sentCookieNames: string[];
        strippedCookieNames: string[];
        ownedOrderCountBefore: number;
      }> = [];
      await page.route('**/api/checkout/complete', async (route) => {
        const request = route.request();
        // 完了の要求を送る前に、持ち主がもう書かれているかを読む（書くのは「注文する」の受け付けで、完了ではない）。
        // 読めない時は投げて、テストを失敗にする（0件と取り違えると、持ち主が書かれていない理由を誤って読む）
        const ownedOrderCountBefore = (await orderIdsOwnedBy(member.userId)).length;
        const cookies = await context.cookies(request.url());
        const sent = cookies.filter((cookie) => !LOGIN_COOKIE_NAMES.includes(cookie.name));
        const response = await route.fetch({
          headers: {
            'content-type': 'application/json',
            origin: new URL(request.url()).origin,
            cookie: sent.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
          },
          timeout: 90_000,
        });
        completeCalls.push({
          status: response.status(),
          sentCookieNames: sent.map((cookie) => cookie.name),
          strippedCookieNames: cookies.filter((cookie) => LOGIN_COOKIE_NAMES.includes(cookie.name)).map((cookie) => cookie.name),
          ownedOrderCountBefore,
        });
        await route.fulfill({ response });
      });

      await page.goto('/checkout');
      await fillMemberShippingForm(page, member);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });
      const orderNumber = (await page.getByText(/^ORD-[0-9A-F]{8}$/).textContent()) ?? '';
      expect(orderNumber).toMatch(/^ORD-[0-9A-F]{8}$/);

      // 完了の要求は、ログインの Cookie が無く、カートの Cookie だけで通った（外した Cookie は、実際にブラウザにあったもの）。
      // その時点で持ち主は書かれていた（注文を作った「注文する」の受け付けが書いた）
      expect(completeCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of completeCalls) {
        expect(call.status).toBe(200);
        expect(call.ownedOrderCountBefore).toBe(1);
        expect(call.sentCookieNames).toContain(CART_COOKIE_NAME);
        for (const name of LOGIN_COOKIE_NAMES) {
          expect(call.sentCookieNames).not.toContain(name);
          expect(call.strippedCookieNames).toContain(name);
        }
      }

      // 注文履歴（会員のログインで読む）にその注文が出る。持ち主は「注文する」の受け付けで書かれている
      const orders = await page.request.get('/api/orders');
      expect(orders.status()).toBe(200);
      const body = (await orders.json()) as { data?: Array<{ orderNumber: string }> };
      expect((body.data ?? []).map((order) => order.orderNumber)).toContain(orderNumber);
      const owned = await orderIdsOwnedBy(member.userId);
      expect(owned.map((id) => toOrderNumber(id))).toEqual([orderNumber]);
    });

    // FREQ-427-AC-01
    test(`${viewport.name}（${viewport.width}px）ゲストで確認へ進んだ後にログインすると、注文するが断られ注文が作られない`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      const guestEmail = `e2e-login-changed-${viewport.name}-${Date.now()}@example.com`;
      await page.goto('/checkout');
      await fillShippingForm(page, guestEmail);
      await proceedToFinal(page);

      // 同じブラウザの別のタブでログインする（「確認へ進む」の時のゲストと、「注文する」の時の会員が食い違う）
      const member = await createTestMember(`changed-${viewport.name}`);
      const other = await context.newPage();
      await other.goto('/');
      await loginAsMember(other, member);
      await other.close();

      // ログインはカートの印（session_id の Cookie）を新しい値に替える（セッション固定への守り）。
      // だから、このタブの決済の画面は今のカートのものでなくなり、サーバーは買い手を比べる前に 403 forbidden で断る（設計書 4-3）。
      // 画面はこの 403 を、買い手の比べで断られた時（FREQ-427-AC-02 の 409 login_changed）と同じ案内・入力画面への戻しにする
      const placeOrderResponse = waitForPlaceOrderResponse(page);
      await placeOrderWithTestCard(page);
      const response = await placeOrderResponse;
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'forbidden' });

      await expect(page.getByTestId('checkout-session-error')).toHaveText(LOGIN_CHANGED, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeHidden();
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeVisible();

      // 注文は作られていない（その会員の注文も、ゲストが入力したメールアドレスの注文も無い）
      expect(await orderIdsOwnedBy(member.userId)).toHaveLength(0);
      expect(await orderIdsShippedTo(guestEmail)).toHaveLength(0);
    });

    // FREQ-427-AC-02
    test(`${viewport.name}（${viewport.width}px）会員で確認へ進んだ後にログインの印が無くなると、注文するが断られ注文が作られない`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const member = await createTestMember(`expired-${viewport.name}`);
      await loginAsMember(page, member);
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      await page.goto('/checkout');
      await fillMemberShippingForm(page, member);
      await proceedToFinal(page);

      // ログインの失効・別の端末からのログアウトの形にする。ログインの Cookie だけを外し、カートの印（session_id）は残す。
      // 印が残るので、サーバーは決済の画面がこのカートのものと認め、買い手を比べて（会員だった下書きに、今はゲスト）断る
      const cookiesBefore = await context.cookies();
      const cartSessionId = cookiesBefore.find((cookie) => cookie.name === CART_COOKIE_NAME)?.value;
      if (!cartSessionId) throw new Error('カートの印（session_id）がブラウザに無い');
      for (const name of LOGIN_COOKIE_NAMES) {
        // 外す対象が最初から無い、という空振りを防ぐ
        expect(cookiesBefore.map((cookie) => cookie.name)).toContain(name);
        await context.clearCookies({ name });
      }
      const cookiesAfter = (await context.cookies()).map((cookie) => cookie.name);
      for (const name of LOGIN_COOKIE_NAMES) {
        expect(cookiesAfter).not.toContain(name);
      }
      expect(cookiesAfter).toContain(CART_COOKIE_NAME);

      const placeOrderResponse = waitForPlaceOrderResponse(page);
      await placeOrderWithTestCard(page);
      const response = await placeOrderResponse;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'login_changed' });

      await expect(page.getByTestId('checkout-session-error')).toHaveText(LOGIN_CHANGED, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeHidden();
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeVisible();

      // 注文は作られていない（その会員の注文も、このカートの注文も無い）
      expect(await orderIdsOwnedBy(member.userId)).toHaveLength(0);
      expect(await orderIdsOfCart(cartSessionId)).toHaveLength(0);
    });
  }
});
