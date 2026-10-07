import { expect, type Frame, type Locator, type Page } from '@playwright/test';

/**
 * 決済の画面の作成と入り直し、認証の更新への「実サーバ呼び出し」を止める。
 *
 * グループ F から、決済の画面（create-session）は「確認へ進む」で作り、/checkout を開くたびに入り直しの
 * 入口（resume）を呼ぶ。決済フォーム自体を検証しないテストからは、次の2つを避けるために固定値で塞ぐ。
 *
 * 1. 回数の制限の食い潰し。E2E はすべて 127.0.0.1 から来るので、実際の入口を叩き続けると上限に達し、
 *    実際に Stripe を見に行くテストが 429 で落ちる。
 * 2. モックしたログイン状態の破壊。POST は clientFetch 経由で、CSRF Cookie が無いと送信前に
 *    /api/auth/refresh を呼ぶ。実サーバは本物のセッションが無いので 401 を返し、LoginContext は
 *    isLoggedIn を false に落とす。
 */
export async function stubCheckoutSessionApis(page: Page): Promise<void> {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'set-cookie': 'sb-csrf-token=e2e-csrf-token; Path=/; SameSite=Lax' },
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'checkout_session_failed',
        message: '決済サービスが一時的に利用できません。少し時間をおいて再試行してください。',
        correlationId: 'e2e-stubbed-correlation-id',
        retryable: true,
      }),
    }),
  );

  // 入り直しを見ないテストでは「入力画面から」に固定する（決め事 D9）
  await page.route('**/api/checkout/resume', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'none' }),
    }),
  );
}

/**
 * 要素の位置が落ち着くまで待つ。「注文する」・支払い方法の選択と、FR-CHECKOUT-017 の入力画面の「確認へ進む」を押す前に使う。
 *
 * Stripe の決済フォーム（iframe）は表示された後も、中身の読み込みと Link の保存欄の展開・
 * 自動入力で数百ミリ秒かけて伸び、その下のボタンが 300px 前後ずれる。ずれている最中に押すと
 * クリックが決済フォームに当たり、ボタンは押されない。入力画面でも欄や案内の表示で位置が変わるため使う。
 * Playwright の押す前の安定判定は2フレームしか見ないので、1秒おきに2回続けて同じ位置に
 * なるまで待つ（ずれは数百ミリ秒の間にまとまって起きる。並列実行で遅れる分を見込んで1秒とする）。
 */
export async function waitForPositionToSettle(locator: Locator): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        const current = box ? `${Math.round(box.x)},${Math.round(box.y)}` : null;
        const settled = current !== null && current === previous;
        previous = current;
        return settled;
      },
      { intervals: [1000], timeout: 20000 },
    )
    .toBe(true);
}

/**
 * 決済フォーム（Stripe の iframe）で支払方法を選び、選ばれたことまで確かめる。
 *
 * 画面外にある決済フォームの項目は、押す前の安定判定が終わらないか、押しても選択が
 * 変わらないことがある（FR-CHECKOUT-025 の PayPay の検証は、mobile と desktop で PayPay を
 * 選べないまま通っていた）。最終確認画面のお支払い方法の欄を画面内に入れ、位置が落ち着いてから押し、
 * 項目が開いた（aria-expanded="true"）ことを確かめる。
 */
export async function selectPaymentMethod(page: Page, frame: Frame, name: string): Promise<void> {
  await page
    .locator('section.checkout-section')
    .filter({ hasText: 'お支払い方法' })
    .evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const option = frame.getByRole('button', { name, exact: true });
  await waitForPositionToSettle(option);
  // 決済の部品は Link の照会などで描き直しが続くことがあり、負荷の高いとき（E2E をまとめて流したとき）は
  // 押しても開かないことがある。開いたことを確かめるまで押し直す（開けないままなら時間切れで落ちる）。
  // 開いた後に押すと閉じる作りかもしれないので、開いていないときだけ押す
  await expect(async () => {
    if ((await option.getAttribute('aria-expanded')) !== 'true') {
      await option.click();
    }
    await expect(option).toHaveAttribute('aria-expanded', 'true', { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * 入り直しの入口を「支払いが済んでいる」にする。stubCheckoutSessionApis より後に登録するので、こちらが優先される。
 * /checkout?session_id=… を開いたときに、画面が完了の処理（/api/checkout/complete）へ進む。
 */
export async function stubResumePaymentDone(page: Page): Promise<void> {
  await page.route('**/api/checkout/resume', async (route) => {
    const body = route.request().postDataJSON() as { checkoutSessionId?: string } | null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        body?.checkoutSessionId
          ? { state: 'payment_done', checkoutSessionId: body.checkoutSessionId }
          : { state: 'none' },
      ),
    });
  });
}

/**
 * Stripe の画面（PayPay など）で支払った直後に戻った状態を作る（決め事 D10）。
 * ページの読み込み前に、支払いの試みの記録を sessionStorage に置く。
 *
 * 同じ page で何度も呼ぶと初期化スクリプトが積み重なる。複数の初期化スクリプトの実行順は
 * Playwright の文書で定義されていないので、実行順（後に足したものが勝つ）に頼らない。
 * 開く URL の session_id が checkoutSessionId と同じときだけ書き、ほかの回のスクリプトは何もしない。
 */
export async function rememberPaymentAttemptBeforeLoad(
  page: Page,
  checkoutSessionId: string,
  paymentType = 'paypay',
): Promise<void> {
  await page.addInitScript(
    ([id, type]) => {
      if (new URLSearchParams(location.search).get('session_id') !== id) {
        return;
      }
      window.sessionStorage.setItem('checkout:payment-attempt', JSON.stringify({ checkoutSessionId: id, paymentType: type }));
    },
    [checkoutSessionId, paymentType] as const,
  );
}
