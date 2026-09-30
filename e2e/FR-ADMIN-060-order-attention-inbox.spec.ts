import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-411: 要対応・要確認を ORDER タブの一覧の上に出し、確認済み・解決済みにできる。件数をサイドナビと KPI 画面に出す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const EXCEPTION = {
  id: 'b1b2c3d4-1111-2222-8333-444455556666',
  reason: 'order_not_creatable',
  reasonLabel: '注文を作れない支払い',
  detail: 'item_unavailable',
  orderId: null,
  orderNumber: null,
  orderStatus: null,
  paymentRef: 'cs_test_attention',
  firstDetectedAt: '2026-09-27T01:00:00.000Z',
  lastDetectedAt: '2026-09-27T01:00:00.000Z',
  detectionCount: 1,
  canCancelOrder: false,
};

// 未入金の注文が付いた要対応。「注文を取り消して解決」を選べる（id は同じにして、同じ resolve のモックで受ける）
const CANCELLABLE_EXCEPTION = {
  ...EXCEPTION,
  reason: 'unexpected_state',
  reasonLabel: '想定外の支払い状態',
  detail: null,
  orderId: 'c1b2c3d4-1111-2222-8333-444455556666',
  orderNumber: 'ORD-C1B2C3D4',
  orderStatus: 'pending',
  canCancelOrder: true,
};

const REVIEW = {
  orderId: 'a1b2c3d4-1111-2222-8333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  orderStatus: 'paid',
  reviewReason: 'stock_not_reserved',
  reviewReasonLabel: '在庫を確保できなかった注文',
  reviewMarkedAt: '2026-09-27T01:00:00.000Z',
};

// 取消 API（resolve）が返す文言。払込票が有効な間は 409、Stripe が一時的に使えないときは 503
const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';

type AttentionState = {
  exceptions: unknown[];
  reviews: unknown[];
  resolveBody: unknown;
  /** 指定すると、resolve をこの応答で断る（要対応は残る） */
  resolveRefusal?: { status: number; body: unknown };
  /** 指定すると、resolve の応答をこれが解けるまで止める（送っている間の画面を確かめる） */
  resolveGate?: Promise<void>;
};

async function mockAdminApis(page: Page, state: AttentionState): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }),
  );
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          exceptions: state.exceptions,
          reviews: state.reviews,
          counts: { exceptions: state.exceptions.length, reviews: state.reviews.length },
        },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    }),
  );
  await page.route(`**/api/admin/orders/${REVIEW.orderId}/review`, (route) => {
    state.reviews = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route(`**/api/admin/payment-exceptions/${EXCEPTION.id}/resolve`, async (route) => {
    state.resolveBody = route.request().postDataJSON();
    await state.resolveGate;
    if (state.resolveRefusal) {
      return route.fulfill({
        status: state.resolveRefusal.status,
        contentType: 'application/json',
        body: JSON.stringify(state.resolveRefusal.body),
      });
    }
    state.exceptions = [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, orderCancelled: false }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

/** 「注文を取り消して解決」を、理由とメモを入れて送る */
async function cancelAndResolve(page: Page) {
  await page.getByRole('button', { name: '注文を取り消して解決' }).click();
  const dialog = page.getByRole('dialog', { name: '注文を取り消して解決' });
  await dialog.getByLabel('取消の理由').selectOption('customer_request');
  await dialog.getByRole('textbox', { name: /メモ/ }).fill('お客様から取消の依頼');
  await dialog.getByRole('button', { name: '取り消す' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-060 order attention inbox (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未処理の要対応・要確認が ORDER タブの一覧の上に件数付きで表示される', async ({ page }) => {
      // FREQ-411-AC-01
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);

      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 1件' })).toBeVisible();
      await expect(page.getByText('注文を作れない支払い')).toBeVisible();
      await expect(page.getByText('在庫を確保できなかった注文（ORD-A1B2C3D4）')).toBeVisible();
    });

    test('「確認済みにする」を押すと要確認が欄から消える', async ({ page }) => {
      // FREQ-411-AC-02
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);

      await page.getByRole('button', { name: '確認済みにする' }).click();

      await expect(page.getByText('在庫を確保できなかった注文（ORD-A1B2C3D4）')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 0件' })).toBeVisible();
    });

    test('「解決済みにする」はメモを付けて送り、欄から消える', async ({ page }) => {
      // FREQ-411-AC-02
      const state: AttentionState = { exceptions: [EXCEPTION], reviews: [], resolveBody: null };
      await mockAdminApis(page, state);
      await openOrders(page);

      await page.getByRole('button', { name: '解決済みにする' }).click();
      const dialog = page.getByRole('dialog', { name: '解決済みにする' });
      await dialog.getByRole('textbox', { name: /メモ/ }).fill('Stripe で返金済み');
      await dialog.getByRole('button', { name: '解決する' }).click();

      await expect(page.getByRole('heading', { name: /要対応/ })).toHaveCount(0);
      expect(state.resolveBody).toEqual({ note: 'Stripe で返金済み' });
    });

    test('未処理が0件のとき欄を出さない', async ({ page }) => {
      // FREQ-411-AC-03
      await mockAdminApis(page, { exceptions: [], reviews: [], resolveBody: null });
      // 要対応・要確認の応答と一覧の読み込みが済んでから確かめる（読み込み前は、欄が無いのは当たり前）
      const attentionLoaded = page.waitForResponse('**/api/admin/order-attention');
      await openOrders(page);
      await attentionLoaded;
      await expect(page.getByText('条件に一致する注文はありません')).toBeVisible();

      await expect(page.getByRole('heading', { name: /要対応/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /未処理/ })).toHaveCount(0);
    });

    test('サイドナビの ORDER と KPI 画面の上部に未処理の件数が出る', async ({ page }) => {
      // FREQ-411-AC-04
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await page.goto('/admin');

      await expect(page.getByText('要対応1件・要確認1件（ORDER で確認）')).toBeVisible();
      await expect(page.getByRole('button', { name: 'ORDER 未処理 2件' })).toBeVisible();
    });

    test('払込票が有効で取り消しが断られたら、理由を欄のすぐ下に出し、行を残して押し直せる', async ({ page }) => {
      // FREQ-411-AC-05
      let release!: () => void;
      const state: AttentionState = {
        exceptions: [CANCELLABLE_EXCEPTION],
        reviews: [],
        resolveBody: null,
        resolveRefusal: {
          status: 409,
          body: { error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil: '2026-09-30T14:59:59.000Z' },
        },
        resolveGate: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      await mockAdminApis(page, state);
      await openOrders(page);
      const row = page.getByText('想定外の支払い状態（ORD-C1B2C3D4）');
      await expect(row).toBeVisible();

      await cancelAndResolve(page);

      // 送っている間は、その行のボタンを押せない
      await expect(page.getByRole('button', { name: '注文を取り消して解決' })).toBeDisabled();
      await expect(page.getByRole('button', { name: '解決済みにする' })).toBeDisabled();
      release();

      // 断られた理由は、操作した欄のすぐ下に出る（一覧の上のエラー欄まで探させない）
      const alert = page.getByRole('alert').filter({ hasText: VOUCHER_VALID_MESSAGE });
      await expect(alert).toBeVisible();
      const inboxBox = await page.getByRole('region', { name: /要対応/ }).boundingBox();
      const alertBox = await alert.boundingBox();
      if (!inboxBox || !alertBox) {
        throw new Error('要対応の欄とエラーの位置を取れなかった');
      }
      const gap = alertBox.y - (inboxBox.y + inboxBox.height);
      expect(gap).toBeGreaterThanOrEqual(-1);
      expect(gap).toBeLessThan(48);

      // 行は残り、ボタンは押せるようになる
      await expect(row).toBeVisible();
      await expect(page.getByRole('button', { name: '注文を取り消して解決' })).toBeEnabled();
      await expect(page.getByRole('button', { name: '解決済みにする' })).toBeEnabled();
      expect(state.resolveBody).toEqual({
        note: 'お客様から取消の依頼',
        cancelOrder: true,
        cancelReason: 'customer_request',
        notifyCustomer: true,
      });
    });

    test('Stripe が一時的に使えず取り消しが断られたら、時間をおいて再試行するよう出し、行を残す', async ({ page }) => {
      // FREQ-411-AC-05
      await mockAdminApis(page, {
        exceptions: [CANCELLABLE_EXCEPTION],
        reviews: [],
        resolveBody: null,
        // 503 は Stripe 以外（基盤）からも返る。本文は使わず、こちらの案内を出す
        resolveRefusal: { status: 503, body: { error: 'Service Unavailable' } },
      });
      await openOrders(page);

      await cancelAndResolve(page);

      const alert = page.getByRole('alert').filter({ hasText: STRIPE_UNAVAILABLE_MESSAGE });
      await expect(alert).toBeVisible();
      // 一覧を更新しても直らないので、そう案内しない
      await expect(alert).not.toContainText('一覧を更新');
      await expect(page.getByText('想定外の支払い状態（ORD-C1B2C3D4）')).toBeVisible();
      await expect(page.getByRole('button', { name: '注文を取り消して解決' })).toBeEnabled();
      await expect(page.getByRole('button', { name: '解決済みにする' })).toBeEnabled();
    });

    test('要対応・要確認を読み込めなかったら、未処理なしに見せず、読み込めなかった旨を出す', async ({ page }) => {
      // FREQ-411-AC-06
      await mockAdminApis(page, { exceptions: [], reviews: [], resolveBody: null });
      // 後から登録した route が先に効く。読み込みだけを 500 にする
      await page.route('**/api/admin/order-attention', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Failed to fetch order attention' }),
        }),
      );
      await openOrders(page);

      await expect(page.getByRole('alert').filter({ hasText: '要対応・要確認を読み込めませんでした。' })).toBeVisible();
      await expect(page.getByRole('heading', { name: /要対応/ })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);
      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 1件' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
