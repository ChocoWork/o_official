/**
 * FR-CHECKOUT-046 ログイン客の注文の持ち主（グループ C）
 * 対応 FREQ: FREQ-426（AC-01・AC-03）・FREQ-427（AC-01・AC-02）。FREQ-426-AC-02 は DB 結合テスト（checkout_order_owner_binding）で確かめる。
 * FREQ-427 の2つは、サーバーが断る経路が違う。AC-01 はログインで決済の流れの印（session_id の Cookie）が新しくなるので 403（決済の画面がこの決済の流れのものでない）、
 * AC-02 は決済の流れの印が残ったままログインの Cookie だけが無くなるので、買い手を比べて 409 login_changed（設計書 4-3）。
 * カートの印は cart の Cookie で、session_id とは別物（この試験が使う session_id は決済の流れの印）。
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
const CHECKOUT_SESSION_COOKIE_NAME = 'session_id';

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

/** この決済の流れ（session_id の Cookie の値）の注文。注文は決済の流れの印を持つので、持ち主やメールが違っても拾える */
async function orderIdsOfCheckoutSession(checkoutSessionCookie: string): Promise<string[]> {
  const { data, error } = await localDb().from('orders').select('id').eq('session_id', checkoutSessionCookie);
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

      // 別のブラウザに戻った形にするため、完了の要求だけ、ログインの Cookie を外して送る（決済の流れの印などの Cookie は残す）。
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

      // 完了の要求は、ログインの Cookie が無く、決済の流れの印（session_id の Cookie）だけで通った（外した Cookie は、実際にブラウザにあったもの）。
      // その時点で持ち主は書かれていた（注文を作った「注文する」の受け付けが書いた）
      expect(completeCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of completeCalls) {
        expect(call.status).toBe(200);
        expect(call.ownedOrderCountBefore).toBe(1);
        expect(call.sentCookieNames).toContain(CHECKOUT_SESSION_COOKIE_NAME);
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

    // FREQ-426-AC-03
    test(`${viewport.name}（${viewport.width}px）会員のログインの印が期限切れでも、新しくして1回だけ送り直し、その会員の注文を受け付ける`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const member = await createTestMember(`refresh-owner-${viewport.name}`);
      await loginAsMember(page, member);
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      await page.goto('/checkout');
      await fillMemberShippingForm(page, member);
      await proceedToFinal(page);

      // アクセスの印だけを同じ属性で置き換える。更新・CSRF・決済の流れの印は残し、期限切れからの更新を通す。
      // Cookie の値は、比較が失敗しても差分に出さない。
      const cookiesBefore = await context.cookies();
      const accessCookie = cookiesBefore.find((cookie) => cookie.name === 'sb-access-token');
      if (!accessCookie) throw new Error('ログインのアクセスの印がブラウザに無い');
      const preservedNames = ['sb-refresh-token', 'sb-csrf-token', CHECKOUT_SESSION_COOKIE_NAME];
      for (const name of preservedNames) {
        expect(cookiesBefore.some((cookie) => cookie.name === name)).toBe(true);
      }
      await context.addCookies([{ ...accessCookie, value: 'invalid-access-token' }]);
      const cookiesAfter = await context.cookies();
      const replaced = cookiesAfter.find((cookie) => cookie.name === accessCookie.name
        && cookie.domain === accessCookie.domain && cookie.path === accessCookie.path);
      expect(replaced?.value === 'invalid-access-token').toBe(true);
      expect(replaced?.expires === accessCookie.expires
        && replaced?.httpOnly === accessCookie.httpOnly
        && replaced?.secure === accessCookie.secure
        && replaced?.sameSite === accessCookie.sameSite).toBe(true);
      for (const name of preservedNames) {
        const before = cookiesBefore.find((cookie) => cookie.name === name)!;
        const after = cookiesAfter.find((cookie) => cookie.name === name
          && cookie.domain === before.domain && cookie.path === before.path);
        expect(after?.value === before.value).toBe(true);
      }

      const statuses: number[] = [];
      const recordPlaceOrder = (response: import('@playwright/test').Response) => {
        if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/checkout/place-order') {
          statuses.push(response.status());
        }
      };
      page.on('response', recordPlaceOrder);
      try {
        // 2回とも、カード入力と「注文する」の前に待ち受ける。2回目は印の更新後の送り直し。
        // 2回目は状態を問わずに待つ（送り直しが 200 以外で返った時に、時間切れではなくその状態で落とすため）。
        let placeOrderResponses = 0;
        const firstPlaceOrder = waitForPlaceOrderResponse(page);
        const secondPlaceOrder = page.waitForResponse(
          (response) => response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/api/checkout/place-order'
            && ++placeOrderResponses === 2,
          { timeout: 120_000 },
        );
        await placeOrderWithTestCard(page);
        const first = await firstPlaceOrder;
        expect(first.status()).toBe(401);
        expect(await first.json()).toEqual({ error: 'auth_expired' });
        const second = await secondPlaceOrder;
        expect(second.status()).toBe(200);
        const accepted = (await second.json()) as { orderId: string };
        expect(accepted.orderId).toEqual(expect.any(String));

        await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });
        expect(statuses).toEqual([401, 200]);
        const owned = await orderIdsOwnedBy(member.userId);
        expect(owned).toEqual([accepted.orderId]);
        await expect(page.getByText(toOrderNumber(accepted.orderId), { exact: true })).toBeVisible();
      } finally {
        page.off('response', recordPlaceOrder);
      }
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

      // ログインは決済の流れの印（session_id の Cookie）を新しい値に替える（セッション固定への守り）。
      // だから、このタブの決済の画面は今の決済の流れのものでなくなり、サーバーは買い手を比べる前に 403 forbidden で断る（設計書 4-3）。
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

      // ログインの失効・別の端末からのログアウトの形にする。ログインの Cookie だけを外し、決済の流れの印（session_id）は残す。
      // 印が残るので、サーバーは決済の画面がこの決済の流れのものと認め、買い手を比べて（会員だった下書きに、今はゲスト）断る
      const cookiesBefore = await context.cookies();
      const checkoutSessionCookie = cookiesBefore.find((cookie) => cookie.name === CHECKOUT_SESSION_COOKIE_NAME)?.value;
      if (!checkoutSessionCookie) throw new Error('決済の流れの印（session_id）がブラウザに無い');
      for (const name of LOGIN_COOKIE_NAMES) {
        // 外す対象が最初から無い、という空振りを防ぐ
        expect(cookiesBefore.map((cookie) => cookie.name)).toContain(name);
        await context.clearCookies({ name });
      }
      const cookiesAfter = (await context.cookies()).map((cookie) => cookie.name);
      for (const name of LOGIN_COOKIE_NAMES) {
        expect(cookiesAfter).not.toContain(name);
      }
      expect(cookiesAfter).toContain(CHECKOUT_SESSION_COOKIE_NAME);

      const placeOrderResponse = waitForPlaceOrderResponse(page);
      await placeOrderWithTestCard(page);
      const response = await placeOrderResponse;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'login_changed' });

      await expect(page.getByTestId('checkout-session-error')).toHaveText(LOGIN_CHANGED, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeHidden();
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeVisible();

      // 注文は作られていない（その会員の注文も、この決済の流れの注文も無い）
      expect(await orderIdsOwnedBy(member.userId)).toHaveLength(0);
      expect(await orderIdsOfCheckoutSession(checkoutSessionCookie)).toHaveLength(0);
    });
  }
});
