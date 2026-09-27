import { expect, test, type Page } from '@playwright/test';
import { stubCheckoutSessionApis } from './checkout-test-utils';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

/** Next.js 16.3 が未捕捉のクライアント例外で出す、既定の全画面エラーの見出し。 */
const CRASH_HEADING = /This page couldn.t load/;

/** 支払方法セクションに描画される Stripe の iframe（FR-CHECKOUT-022 と同じ拾い方）。 */
function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

/**
 * 決済セッションの生成リクエストを、テスト側の入力が済むまで止めておく。
 * 返り値を呼ぶと実サーバーへ流し、本物の clientSecret が返る。
 */
async function holdCreateSession(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/checkout/create-session', async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

function waitForCreateSessionResponse(page: Page) {
  return page.waitForResponse((response) =>
    response.url().includes('/api/checkout/create-session'),
  );
}

async function mockSignedInWithoutSavedAddress(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: 'user-1',
          email: 'hanako@example.com',
          role: 'user',
          mfaVerified: true,
        },
      },
    }),
  );
  // 電話番号が未登録なので、お客様情報は読み取り表示にならず入力フォームのまま出る。
  await page.route('**/api/profile', (route) =>
    route.fulfill({
      json: {
        fullName: '山田花子',
        kanaName: 'ヤマダハナコ',
        email: 'hanako@example.com',
        phone: '',
      },
    }),
  );
  await page.route('**/api/profile/addresses', (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  // 実サーバーの refresh は本物のセッションが無いと 401 を返し、LoginContext が
  // ログアウト扱いに落ちてチェックボックスが消える（checkout-test-utils.ts を参照）。
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'set-cookie': 'sb-csrf-token=e2e-csrf-token; Path=/; SameSite=Lax' },
      body: JSON.stringify({ ok: true }),
    }),
  );
}

test.describe('FR-CHECKOUT-024 決済フォームの準備が完了しても入力を続けられる', () => {
  test.describe.configure({ timeout: 90_000 });

  // 決済フォームは本物の clientSecret でしか初期化できない（偽の値では CheckoutProvider が
  // 画面ごと壊れる。FR-CHECKOUT-021 の判断）。create-session は session_id クッキーに
  // 紐づく carts テーブルを直接読むので /api/cart のモックでは足りない。
  // FR-CHECKOUT-022 と同じく実カートを作り、Stripe テストモードのセッションを使う。
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const seeded = await page.evaluate(async () => {
      const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
      if (!itemsResponse.ok) {
        return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
      }
      const body = (await itemsResponse.json()) as {
        items?: { id?: number; price?: number }[];
      };
      const item = (body.items ?? []).find(
        (candidate) => typeof candidate?.id === 'number' && (candidate?.price ?? 0) >= 50,
      );
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
    if (!seeded.ok) {
      test.skip(true, seeded.reason);
    }
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-01
    test(`${viewport.name}（${viewport.width}px）メールアドレス欄で入力中に決済フォームが準備できても入力を続けられる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const release = await holdCreateSession(page);
      await page.goto('/checkout');

      const email = page.locator('input[name="email"]');
      await email.fill('buyer@example.com');
      const original = await email.elementHandle();

      const sessionResponse = waitForCreateSessionResponse(page);
      release();
      expect((await sessionResponse).ok()).toBe(true);

      await expect(paymentIframe(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(email).toHaveValue('buyer@example.com');
      await expect(email).toBeFocused();
    });
  }

  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-02
    test(`${viewport.name}（${viewport.width}px）ログイン中に配送先保存のチェック操作中に決済フォームが準備できても状態が残る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await mockSignedInWithoutSavedAddress(page);
      const release = await holdCreateSession(page);
      await page.goto('/checkout');

      const saveAddress = page.getByRole('checkbox', { name: 'この配送先を保存する' });
      await saveAddress.check();
      await saveAddress.focus();
      const original = await saveAddress.elementHandle();

      const sessionResponse = waitForCreateSessionResponse(page);
      release();
      expect((await sessionResponse).ok()).toBe(true);

      await expect(paymentIframe(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(saveAddress).toBeChecked();
      await expect(saveAddress).toBeFocused();
    });
  }

  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-03
    test(`${viewport.name}（${viewport.width}px）氏名欄の日本語変換中に決済フォームが準備できても変換を確定できる`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      const release = await holdCreateSession(page);
      await page.goto('/checkout');

      const fullName = page.locator('input[name="fullName"]');
      await fullName.focus();
      const original = await fullName.elementHandle();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', {
        text: 'やまだ',
        selectionStart: 3,
        selectionEnd: 3,
      });

      const sessionResponse = waitForCreateSessionResponse(page);
      release();
      expect((await sessionResponse).ok()).toBe(true);
      await expect(paymentIframe(page)).toBeVisible({ timeout: 30_000 });

      await cdp.send('Input.imeSetComposition', {
        text: '山田',
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send('Input.insertText', { text: '山田' });

      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(fullName).toHaveValue('山田');
      await expect(fullName).toBeFocused();
    });
  }

  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-04
    test(`${viewport.name}（${viewport.width}px）決済フォームの準備に失敗して再試行で成功しても入力内容が残る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      let createSessionCalls = 0;
      await page.route('**/api/checkout/create-session', async (route) => {
        createSessionCalls += 1;
        if (createSessionCalls === 1) {
          await route.fulfill({
            status: 503,
            json: {
              error: 'checkout_session_failed',
              message: '決済サービスに接続できませんでした。時間をおいて再度お試しください。',
              correlationId: 'e2e-retry-correlation-id',
              retryable: true,
            },
          });
          return;
        }
        await route.continue();
      });
      await page.goto('/checkout');

      const retryButton = page.getByRole('button', { name: '再試行する' });
      await expect(retryButton).toBeVisible();
      const fullName = page.locator('input[name="fullName"]');
      const email = page.locator('input[name="email"]');
      await fullName.fill('山田太郎');
      await email.fill('buyer@example.com');
      const originalFullName = await fullName.elementHandle();
      const originalEmail = await email.elementHandle();

      await retryButton.click();

      await expect(paymentIframe(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);
      expect(createSessionCalls).toBe(2);
      expect(await originalFullName!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await originalEmail!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(fullName).toHaveValue('山田太郎');
      await expect(email).toHaveValue('buyer@example.com');
    });
  }
});

test.describe('FR-CHECKOUT-024 checkout のエラー境界', () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-358-AC-05
    test(`${viewport.name}（${viewport.width}px）描画中の予期しない例外でカート保持と復帰導線を示す`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await stubCheckoutSessionApis(page);
      await mockCartApis(page, [sampleCartItem()]);
      // 描画時の例外を注入する。保存済み住所に null が混ざると、配送先プルダウンの
      // 選択肢を組み立てる箇所（addressOptions）で TypeError になる。
      // 住所一覧が null に強くなってこの注入が効かなくなったら、別の描画時例外に差し替えること。
      await page.route('**/api/profile/addresses', (route) =>
        route.fulfill({ json: { addresses: [null] } }),
      );

      await page.goto('/checkout');

      await expect(
        page.getByRole('heading', { name: '決済画面を表示できませんでした' }),
      ).toBeVisible();
      await expect(page.getByText('カートの商品はそのまま保持されています。')).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度表示する' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'カートに戻る' })).toHaveAttribute(
        'href',
        '/cart',
      );
      await expect(page.getByRole('heading', { name: CRASH_HEADING })).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
