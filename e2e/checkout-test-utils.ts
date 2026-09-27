import { expect, type Frame, type Locator, type Page } from '@playwright/test';

/**
 * 決済セッション生成と認証更新への「実サーバ呼び出し」を止める。
 *
 * 1画面化により /checkout はカートに商品があると読み込み時点で
 * create-session を打つ。Stripe を本当に叩く必要があるのは
 * FR-CHECKOUT-022 だけで、それ以外の checkout 系テストが実エンドポイントを
 * 叩くと次の2つの並列実行フレークを生む。
 *
 * 1. レート上限の食い潰し。create-session の IP 上限は本番で 10秒10回・10分60回
 *    （E2E サーバーでは scripts/e2e-server.mjs の倍率で引き上げる。FREQ-362）。
 *    checkout 系を通すだけで 1 分あたり十数回呼ばれ、スイートを連続実行すると
 *    上限に達し、実際に Stripe を見に行く FR-CHECKOUT-022 が 429 で落ちる。
 *
 * 2. モックしたログイン状態の破壊。create-session は clientFetch 経由の POST で、
 *    CSRF Cookie が無いと送信前に /api/auth/refresh を呼ぶ。実サーバは
 *    本物のセッションが無いので 401 を返し、clientFetch は「セッション切れ」を
 *    通知する。LoginContext はこれを受けて isLoggedIn を false に落とすため、
 *    /api/auth/me をモックしていてもログイン限定の UI が消える。
 *    refresh 側が 429（レート制限）を返した実行では通知が出ないので、
 *    「同じテストが実行ごとに通ったり落ちたりする」形で現れる。
 *
 * 決済フォーム自体を検証しないテストからは、この2つを固定値で塞ぐ。
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
}

/**
 * 要素の位置が落ち着くまで待つ。実 Stripe の決済フォームがある画面で「確認へ進む」を押す前に使う。
 *
 * Stripe の決済フォーム（iframe）は表示された後も、中身の読み込みと Link の保存欄の展開・
 * 自動入力で数百ミリ秒かけて伸び、その下のボタンが 300px 前後ずれる。ずれている最中に押すと
 * クリックが決済フォームに当たり、ボタンは押されない（FR-CHECKOUT-017 で実際に起きた）。
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
 * 選べないまま通っていた）。支払方法セクションを画面内に入れ、位置が落ち着いてから押し、
 * 項目が開いた（aria-expanded="true"）ことを確かめる。
 */
export async function selectPaymentMethod(page: Page, frame: Frame, name: string): Promise<void> {
  await page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const option = frame.getByRole('button', { name, exact: true });
  await waitForPositionToSettle(option);
  await option.click();
  await expect(option).toHaveAttribute('aria-expanded', 'true');
}
