/**
 * FR-ADMIN-107 確認の画面の注文番号の見出し・「戻る」・スマホの「×」
 * 対応 FREQ: FREQ-510（AC-01〜AC-05）／波1 Task 5（J-10・J-12）
 *
 * 返金と支払い済みのキャンセルの画面は、見出しに注文番号（ORD-XXXXXXXX）を入れ、何もせずに閉じるボタンを「戻る」にそろえる。
 * 画面いっぱいに開く 768px 未満では、見出しの行の右に「×」（読み上げは「閉じる」）が出て、押すと閉じる。768px 以上では出ない。
 * 窓口は FR-ADMIN-074・075 と同じく差し替えて確かめる（実装計画 P16）。
 */
import { expect, test, type Page } from '@playwright/test';
import { dialogHeaderClose } from './admin-test-utils';
import { adminOrder, fulfillJson, mockAdminSession, mockOrderList, openOrderTab, viewports } from './order-fulfillment-test-utils';
import {
  acceptedRefund,
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openPaidCancelDialog,
  openRefundDialog,
  paidCancelDialogTitle,
  quantityInput,
  refundDialogTitle,
  refundMaterialsOf,
} from './refund-test-utils';

const ORDER_ID = 'a7b2c3d4-1107-4000-8000-000000000107';
const BLOUSE = 'b7b2c3d4-1107-4000-8000-000000000001';
const BLOUSE_LABEL = 'シルクブラウス（ホワイト / M）';
const CUSTOMER_NAME = '山田 花子';

/** 支払い済みで1つも発送していない注文。返金もキャンセルもできる */
const ROW = adminOrder({
  id: ORDER_ID,
  customerName: CUSTOMER_NAME,
  canShip: false,
  canRefund: true,
  canCancel: true,
  cancelKind: 'paid',
  paymentStatusKey: 'paid',
  refundedAmountLabel: '-',
});

async function mockApis(page: Page) {
  const state = newRefundRouteState(
    refundMaterialsOf({
      orderId: ORDER_ID,
      shippingAmount: 800,
      lines: [materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000 })],
    }),
  );
  await mockAdminSession(page);
  await mockOrderList(page, () => [ROW]);
  await mockRefundRoutes(page, ORDER_ID, state);
  return { state };
}

for (const viewport of viewports) {
  const mobile = viewport.width < 768;

  test.describe(`FR-ADMIN-107 dialog order number and close (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('返金の画面の見出しに注文番号が表示され、お客様の名前は表示されない。何もせずに閉じるボタンは「戻る」', async ({ page }) => {
      // FREQ-510-AC-01, FREQ-510-AC-03
      const { state } = await mockApis(page);
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      await expect(dialog.getByRole('heading', { name: refundDialogTitle(ORDER_ID), exact: true })).toBeVisible();
      await expect(dialog.getByRole('heading', { name: new RegExp(CUSTOMER_NAME) })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '戻る', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(0);

      await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.refundPosts).toHaveLength(0);
    });

    test('支払い済みのキャンセルの画面の見出しに注文番号が表示される', async ({ page }) => {
      // FREQ-510-AC-02
      await mockApis(page);
      await openOrderTab(page);
      const dialog = await openPaidCancelDialog(page, ORDER_ID);

      await expect(dialog.getByRole('heading', { name: paidCancelDialogTitle(ORDER_ID), exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '戻る', exact: true })).toBeVisible();
    });

    if (mobile) {
      test('390px では返金の画面が画面いっぱいに開き、右上の「×」が表示され、押すと何も送らずに閉じる。最初のフォーカスは × ではない', async ({ page }) => {
        // FREQ-510-AC-04
        const { state } = await mockApis(page);
        await openOrderTab(page);
        const dialog = await openRefundDialog(page, ORDER_ID);
        const close = dialog.getByRole('button', { name: '閉じる', exact: true });

        await expect(close).toBeVisible();
        await expect(close).toHaveAttribute('type', 'button');
        await expect(close).not.toBeFocused();
        const dialogBox = await dialog.boundingBox();
        const closeBox = await close.boundingBox();
        if (!dialogBox || !closeBox) throw new Error('画面と × の位置を取れなかった');
        // 画面いっぱい
        expect(dialogBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(dialogBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
        // 右上（見出しの行の右端）
        expect(closeBox.x + closeBox.width).toBeGreaterThan(viewport.width - 64);
        expect(closeBox.y).toBeLessThan(80);

        await close.click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.refundPosts).toHaveLength(0);
      });

      test('390px の支払い済みのキャンセルの画面も、右上の「×」で閉じる', async ({ page }) => {
        // FREQ-510-AC-04
        const { state } = await mockApis(page);
        await openOrderTab(page);
        const dialog = await openPaidCancelDialog(page, ORDER_ID);

        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.statusPosts).toHaveLength(0);
      });

      test('390px で返金を送っている間は、「×」を押しても閉じない', async ({ page }) => {
        // FREQ-510-AC-04（送っている間の閉じ止めを × が迂回しない）
        const { state } = await mockApis(page);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        state.answerRefund = async (route, body) => {
          await gate;
          await fulfillJson(route, acceptedRefund({ amount: body.amount }));
        };
        await openOrderTab(page);
        const dialog = await openRefundDialog(page, ORDER_ID);
        await quantityInput(dialog, '発送前の商品', BLOUSE_LABEL).fill('1');
        // 未発送の商品を全部返すので、送料 800 も全部返す（FR-ADMIN-074 の unshipped と同じ）。返金額は ￥12,800
        await dialog.getByRole('button', { name: `${formatYen(12_800)} を返金する`, exact: true }).click();
        await expect.poll(() => state.refundPosts.length).toBe(1);

        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(dialog).toBeVisible();

        release();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      });
    } else {
      test(`${viewport.width}px では返金の画面とキャンセルの画面に「×」が表示されない`, async ({ page }) => {
        // FREQ-510-AC-05
        await mockApis(page);
        await openOrderTab(page);
        const refund = await openRefundDialog(page, ORDER_ID);
        await expect(refund.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(0);
        await expect(dialogHeaderClose(refund)).toBeHidden();
        const box = await refund.boundingBox();
        if (!box) throw new Error('返金の画面の位置を取れなかった');
        expect(box.width).toBeLessThan(viewport.width);
        await refund.getByRole('button', { name: '戻る', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);

        const cancel = await openPaidCancelDialog(page, ORDER_ID);
        await expect(cancel.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(0);
        await expect(dialogHeaderClose(cancel)).toBeHidden();
      });
    }
  });
}
