import { test, expect, Page } from '@playwright/test';
import { adminOrderDetail, detailSection, mockAdminSession, mockOrderDetail, openOrderDetail, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { materialLineOf, mockRefundRoutes, newRefundRouteState, openDetailRefundDialog, refundMaterialsOf } from './refund-test-utils';

// FREQ-413: 取消の画面で理由を選び（必須）、メモとお知らせの有無を決めて取り消せる。払込票が有効な間は取り消せない。
const ORDER_ID = 'a6300001-1111-4222-8333-444455556666';
const VOUCHER_ID = 'a6300002-1111-4222-8333-444455556666';
const UNKNOWN_ID = 'a6300003-1111-4222-8333-444455556666';
const FAILED_ID = 'a6300004-1111-4222-8333-444455556666';

async function mockAdminApis(page: Page, cancelBodies: unknown[], holdStatusResponse?: Promise<void>): Promise<void> {
  await mockAdminSession(page);
  let cancelled = false;
  await mockOrderDetail(page, (id) => adminOrderDetail({
    id, status: id === FAILED_ID ? '決済失敗' : id === ORDER_ID ? (cancelled ? 'キャンセル' : '支払い手続き中') : '未決済',
    orderStatus: id === FAILED_ID ? 'failed' : cancelled ? 'cancelled' : 'pending',
    canCancel: id === ORDER_ID || id === FAILED_ID, cancelKind: id === ORDER_ID || id === FAILED_ID ? 'unpaid' : null,
    canRefund: id === ORDER_ID,
    cancelBlockedUntil: id === VOUCHER_ID ? '2026-09-30T14:59:59.000Z' : null,
  }));
  await mockRefundRoutes(page, ORDER_ID, newRefundRouteState(refundMaterialsOf({ orderId: ORDER_ID, lines: [materialLineOf({ orderItemId: 'b6300001-1111-4222-8333-444455556666' })] })));
  await page.route('**/api/admin/orders/*/status', async (route) => {
    cancelBodies.push(route.request().postDataJSON());
    await holdStatusResponse;
    cancelled = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, status: 'cancelled' }) });
  });
}

async function openOrders(page: Page, orderId = ORDER_ID) {
  await openOrderDetail(page, orderId);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-063 order cancel dialog (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('取消の理由を選ばないと取り消せない', async ({ page }) => {
      // FREQ-413-AC-01
      await mockAdminApis(page, []);
      await openOrders(page);

      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      // 見出しには注文番号が付く（J-12。ORD- と ID の先頭8文字の大文字）
      await expect(page.getByRole('dialog', { name: `注文を取り消す（注文 ${orderNumberOf(ORDER_ID)}）`, exact: true })).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: '取消の理由', exact: true }).getByRole('option')).toHaveText([
        '選んでください', 'お客様の都合', '支払いの拒否', '不正', '在庫切れ', 'お店の誤り', 'その他',
      ]);
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeEnabled();
    });

    test('お知らせは既定でオンで表示され、外すと notifyCustomer=false を送る', async ({ page }) => {
      // FREQ-413-AC-02
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      const notify = dialog.getByRole('checkbox', { name: 'お客様に取消のお知らせを送る' });
      await expect(notify).toBeChecked();

      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      await notify.uncheck();
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect(detailSection(page, '注文情報').getByText('キャンセル', { exact: true })).toBeVisible();
      expect(cancelBodies).toEqual([{ status: 'cancelled', reason: 'customer_request', notifyCustomer: false }]);
    });

    test('「その他」はメモを入れるまで取り消せない', async ({ page }) => {
      // FREQ-413-AC-03
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('other');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByRole('textbox', { name: /メモ/ }).fill('電話で依頼');
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect.poll(() => cancelBodies).toEqual([
        { status: 'cancelled', reason: 'other', note: '電話で依頼', notifyCustomer: true },
      ]);
    });

    test('払込票が有効な注文は「キャンセル」を押せず、払込期限が表示される', async ({ page }) => {
      // FREQ-413-AC-04
      await mockAdminApis(page, []);
      await openOrders(page, VOUCHER_ID);

      const voucher = detailSection(page, '支払いと返金');
      await expect(voucher.getByRole('button', { name: 'キャンセル' })).toHaveCount(0);
      await expect(
        voucher.getByText(/払込票の期限切れが確定するまで取り消せません（払込期限 2026\/09\/30 23:59）/),
      ).toBeVisible();
    });

    test('Stripe の状態を確かめられない入金待ちの注文は「キャンセル」を押せず、確かめられない旨が表示される', async ({
      page,
    }) => {
      // FREQ-413-AC-06
      await mockAdminApis(page, []);
      await openOrders(page, UNKNOWN_ID);

      const unknown = detailSection(page, '支払いと返金');
      await expect(unknown.getByRole('button', { name: 'キャンセル' })).toHaveCount(0);
      await expect(unknown.getByText('支払いの状態を確かめられないため、今は取り消せません')).toBeVisible();
    });

    test('送信中に取消の画面を閉じて返金の画面を開き直しても、先の送信が終わった時に開いている返金の画面を閉じない', async ({
      page,
    }) => {
      // FREQ-413-AC-07
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies, hold);
      await openOrders(page);

      // 1件目を送る（応答は止めておく）
      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await dialog.getByRole('combobox', { name: '取消の理由', exact: true }).selectOption('customer_request');
      await dialog.getByRole('button', { name: '取り消す' }).click();
      await expect.poll(() => cancelBodies.length).toBe(1);

      // 送信中に取消を閉じ、同じ注文の返金を開く。
      await dialog.getByRole('button', { name: '戻る' }).click();
      await expect(dialog).toHaveCount(0);
      const refund = await openDetailRefundDialog(page, ORDER_ID);
      await expect(refund.getByRole('button', { name: 'すべて選ぶ', exact: true })).toBeEnabled();
      release();
      await expect(detailSection(page, '注文情報').getByText('キャンセル', { exact: true })).toBeVisible();
      await expect(refund).toBeVisible();
      await expect(refund.getByRole('button', { name: 'すべて選ぶ', exact: true })).toBeEnabled();
    });

    test('失敗の注文の取消では、お知らせの選択肢を出さない', async ({ page }) => {
      // FREQ-413-AC-05
      await mockAdminApis(page, []);
      await openOrders(page, FAILED_ID);

      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });

      // 画面が開いていることを先に確かめる（開いていなければ「チェックボックスが無い」は常に成り立つ）
      await expect(dialog.getByRole('combobox', { name: '取消の理由', exact: true })).toBeVisible();
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);
      await detailSection(page, '支払いと返金').getByRole('button', { name: 'キャンセル' }).click();
      await expect(page.getByRole('dialog', { name: '注文を取り消す' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
