/**
 * FR-ADMIN-106 / FREQ-507（波1 Task 2・J-04）
 * FR-ADMIN-078 と同じ管理セッション・注文一覧・要対応の窓口差し替えで、手動解決のメモ必須を確かめる。
 * UI と送信本文を対象にする。実 API・RPC の保証は単体・DB 結合が持つ。
 */
import { expect, test, type Page } from '@playwright/test';
import type { AttentionException } from '@/lib/orders/order-payment-types';
import { adminOrder, fulfillJson, mockOrderList, openOrderTab, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import {
  materialLineOf,
  mockAdminSessionAs,
  mockRefundRoutes,
  newRefundRouteState,
  refundMaterialsOf,
} from './refund-test-utils';

const ORDER_ID = 'a6b2c3d4-1111-2222-8333-444455556666';
const EXCEPTION_ID = 'f6b2c3d4-1111-2222-8333-444455556666';
const NOTE_HELP = '返金の失敗を解決するときは、確かめた内容をメモに入力してください。';

function refundFailure(isReturn: boolean): AttentionException {
  return {
    id: EXCEPTION_ID,
    reason: 'refund_failed',
    reasonLabel: '返金の失敗',
    detail: 'expired',
    orderId: ORDER_ID,
    orderNumber: orderNumberOf(ORDER_ID),
    orderStatus: 'paid',
    paymentRef: 're_e2eNoteRequired1',
    firstDetectedAt: '2026-10-23T01:00:00.000Z',
    lastDetectedAt: '2026-10-23T01:00:00.000Z',
    detectionCount: 1,
    canCancelOrder: false,
    canRetryRefund: true,
    refundFailure: {
      amount: 5000,
      failureReasonLabel: '口座の入力の期限が過ぎました',
      shortages: [],
      ...(isReturn ? { returnId: 'e6b2c3d4-1111-2222-8333-444455556666' } : {}),
    },
  };
}

async function mockApis(page: Page, exception: AttentionException) {
  const state: { exceptions: AttentionException[]; resolveBodies: unknown[]; reads: number } = {
    exceptions: [exception], resolveBodies: [], reads: 0,
  };
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [
    adminOrder({ id: ORDER_ID, canShip: false, canRefund: true, paymentStatusKey: 'paid', refundedAmountLabel: '-', cancelKind: null }),
  ]);
  await mockRefundRoutes(page, ORDER_ID, newRefundRouteState(refundMaterialsOf({
    orderId: ORDER_ID,
    lines: [materialLineOf({ orderItemId: 'c6b2c3d4-0000-4000-8000-000000000001', itemPrice: 5000 })],
  })));
  await page.route('**/api/admin/order-attention', (route) => {
    state.reads += 1;
    return fulfillJson(route, {
      data: {
        exceptions: state.exceptions,
        reviews: [],
        counts: { exceptions: state.exceptions.length, reviews: 0 },
      },
    });
  });
  await page.route(`**/api/admin/payment-exceptions/${EXCEPTION_ID}/resolve`, async (route) => {
    state.resolveBodies.push(route.request().postDataJSON());
    state.exceptions = [];
    await fulfillJson(route, { success: true, orderCancelled: false });
  });
  return state;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-106 refund failure note (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    for (const isReturn of [false, true]) {
      test(`${isReturn ? '返品返金' : '通常返金'}の失敗は空・空白で解決できず、メモを入れると解決できる`, async ({ page }) => {
        // FREQ-507-AC-01・AC-02
        const state = await mockApis(page, refundFailure(isReturn));
        await openOrderTab(page);
        await page.getByRole('button', { name: '解決済みにする', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '解決済みにする', exact: true });
        const note = dialog.getByRole('textbox', { name: 'メモ（必須・店内のみ）', exact: true });
        const submit = dialog.getByRole('button', { name: '解決する', exact: true });

        await expect(note).toHaveAttribute('required', '');
        await expect(note).toHaveAttribute('maxlength', '500');
        await expect(dialog.getByText(NOTE_HELP, { exact: true })).toBeVisible();
        await expect(submit).toBeDisabled();
        await note.fill('  　');
        await expect(submit).toBeDisabled();
        expect(state.resolveBodies).toEqual([]);
        await note.fill('確');
        await expect(submit).toBeEnabled();
        await note.fill('  銀行振込で返金した  ');
        const readsBefore = state.reads;
        await submit.click();

        await expect(dialog).toHaveCount(0);
        await expect.poll(() => state.resolveBodies).toEqual([{ note: '銀行振込で返金した' }]);
        await expect.poll(() => state.reads).toBeGreaterThan(readsBefore);
        await expect(page.getByRole('button', { name: '解決済みにする', exact: true })).toHaveCount(0);
      });
    }

    test('返金の失敗以外の要対応はメモ任意のままで、空でも解決できる', async ({ page }) => {
      // FREQ-507-AC-03
      const state = await mockApis(page, {
        ...refundFailure(false), reason: 'unexpected_state', reasonLabel: '想定外の支払い状態',
        canRetryRefund: false, refundFailure: null,
      });
      await openOrderTab(page);
      await page.getByRole('button', { name: '解決済みにする', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '解決済みにする', exact: true });
      await expect(dialog.getByRole('textbox', { name: 'メモ（任意・店内のみ）', exact: true })).not.toHaveAttribute('required', '');
      await expect(dialog.getByText(NOTE_HELP, { exact: true })).toHaveCount(0);
      const submit = dialog.getByRole('button', { name: '解決する', exact: true });
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(dialog).toHaveCount(0);
      await expect.poll(() => state.resolveBodies).toEqual([{}]);
    });
  });
}
