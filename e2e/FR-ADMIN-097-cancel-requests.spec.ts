import type { Page } from '@playwright/test';
import {
  beginRefund, createFulfillment, recordRefundResult,
} from './order-email-test-utils';
import {
  acceptedRefund, materialLineOf, refundMaterialsOf, newRefundRouteState, mockRefundRoutes, quantityInput,
} from './refund-test-utils';
import { fulfillJson, orderNumberOf } from './order-fulfillment-test-utils';
import {
  test, expect, viewports, unshipped, cancelDb, cancelScene, openCancel, expectMails, noOverflow, type RR,
} from './return-request-test-utils';

test.use({ trace: 'off' });
async function refundScene(page: Page, rr: RR, failResolve = false) {
  await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
  const fx = await unshipped(rr);
  await createFulfillment(rr.db, fx.orderId, fx.actorId, {
    lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], trackingNumber: 'E2E-PARTIAL', notify: false,
  });
  const requestId = await cancelDb(rr, fx.orderId, fx.orderItemIds[0]);
  const state = await cancelScene(page, rr, fx);
  state.resolveFails = failResolve;
  const refund = newRefundRouteState(refundMaterialsOf({
    orderId: fx.orderId, lines: [materialLineOf({
      orderItemId: fx.orderItemIds[0], name: 'E2Eシャツ', quantity: 3, itemPrice: 5000, shipped: 1, unshipped: 2,
    })],
  }));
  refund.answerRefund = async (route, body) => {
    const saved = await beginRefund(rr.db, fx.orderId, { ...body, actorId: fx.actorId });
    await recordRefundResult(rr.db, saved.refundId);
    await fulfillJson(route, acceptedRefund({ amount: saved.amount, refundId: saved.refundId, status: 'succeeded' }));
  };
  await mockRefundRoutes(page, fx.orderId, refund);
  return { fx, requestId, state, refund };
}
for (const viewport of viewports) {
  test.describe('FR-ADMIN-097 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('一覧の一行で絞り、品を外すと申し込みの数で返金が開き、返金後に解決する', async ({ page, rr }) => {
      // FREQ-481-AC-04, FREQ-481-AC-05, FREQ-481-AC-06
      const { fx, requestId, state, refund } = await refundScene(page, rr);
      await page.getByTestId('return-attention').getByRole('button', { name: 'キャンセルの申し込み 1件', exact: true }).click();
      await expect.poll(() => state.urls.some((url) => new URL(url).searchParams.get('cancelRequest') === 'open')).toBe(true);
      const request = await openCancel(page, fx.orderId);
      await expect(request.getByTestId('cancel-request-item')).toHaveAttribute('data-request-id', requestId);
      await expect(request).toContainText('E2Eシャツ（ホワイト / M） × 1（未発送 2）');
      await request.getByRole('button', { name: '品を外す（返金・キャンセルの画面を開く）', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '返金', exact: true });
      await expect(quantityInput(dialog, '発送前の商品', 'E2Eシャツ（ホワイト / M）')).toHaveValue('1');
      await expect(quantityInput(dialog, '発送済みの商品', 'E2Eシャツ（ホワイト / M）')).toHaveValue('0');
      // 「品を外す」は行き先のための返金の材料の読み出しをしない。返金の画面が開いた後の自分の1回だけ（上で数が入るのを待った後）
      expect(refund.materialsReads).toBe(1);
      await dialog.getByRole('button', { name: '￥5,000 を返金する', exact: true }).click();
      await expect.poll(() => state.posts.filter((post) => post.action === 'resolve').length).toBe(1);
      const resolved = (await rr.db.query('select status,resolved_refund_id from public.order_cancel_requests where id=$1', [requestId])).rows[0];
      expect(resolved.status).toBe('resolved');
      expect(state.posts.find((post) => post.action === 'resolve')!.body).toEqual({ refundId: resolved.resolved_refund_id, orderCancelled: false });
      await expect(page.getByRole('status').filter({ hasText: 'キャンセルの申し込みを解決しました。' })).toBeVisible();
      await expect(page.getByTestId('return-attention').getByRole('button', { name: 'キャンセルの申し込み 1件', exact: true })).toHaveCount(0);
      await noOverflow(page);
    });

    test('キャンセルのお断りも1画面でメッセージを送り、DB とお客様へのメールに残る', async ({ page, request, rr }) => {
      // FREQ-481-AC-08, FREQ-484-AC-06
      test.setTimeout(180_000);
      await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
      const fx = await unshipped(rr);
      const id = await cancelDb(rr, fx.orderId, fx.orderItemIds[0]);
      const state = await cancelScene(page, rr, fx);
      await (await openCancel(page, fx.orderId)).getByRole('button', { name: 'お断りする', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'お断りする（' + orderNumberOf(fx.orderId) + '）', exact: true });
      await dialog.getByRole('combobox', { name: 'お断りの理由（お客様には見えません）', exact: true }).selectOption('other');
      await expect(dialog.getByRole('button', { name: 'お断りする', exact: true })).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'お客様へのメッセージ（必須・お客様に届きます）', exact: true }).fill('発送の準備が進んでいるため、お受けできません。');
      await expect(dialog.getByText('お客様にメッセージが届きます。取り消せません。', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'お断りする', exact: true }).click();
      await expect.poll(() => state.posts.length).toBe(1);
      expect((await rr.db.query('select status from public.order_cancel_requests where id=$1', [id])).rows[0].status).toBe('declined');
      await expectMails(request, rr.member.email, '【Le Fil des Heures】キャンセルのお申し込みについて（' + orderNumberOf(fx.orderId) + '）',
        ['当店より:\n発送の準備が進んでいるため、お受けできません。']);
    });

    test('解決済みにするは確かめて閉じ、注文とメールの予定を変えない', async ({ page, rr }) => {
      // FREQ-481-AC-08
      await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
      const fx = await unshipped(rr);
      const id = await cancelDb(rr, fx.orderId, fx.orderItemIds[0]);
      const before = Number((await rr.db.query('select count(*) from private.order_email_outbox where order_id=$1', [fx.orderId])).rows[0].count);
      const state = await cancelScene(page, rr, fx);
      await (await openCancel(page, fx.orderId)).getByRole('button', { name: '解決済みにする', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '解決済みにする（' + orderNumberOf(fx.orderId) + '）', exact: true });
      await expect(dialog).toContainText('注文を変えず、メールも送らずに閉じます。');
      expect(state.posts.length).toBe(0);
      await dialog.getByRole('button', { name: '解決済みにする', exact: true }).click();
      await expect.poll(() => state.posts.length).toBe(1);
      expect((await rr.db.query('select status from public.order_cancel_requests where id=$1', [id])).rows[0].status).toBe('closed');
      expect((await rr.db.query('select status::text from public.orders where id=$1', [fx.orderId])).rows[0].status).toBe('paid');
      expect(Number((await rr.db.query('select count(*) from private.order_email_outbox where order_id=$1', [fx.orderId])).rows[0].count)).toBe(before);
      await expect(page.getByRole('status').filter({ hasText: '解決済みにしました。' })).toBeVisible();
    });

    test('未入金・未発送全部・一部の申し込みで3つの画面を開き分ける', async ({ page, rr }) => {
      // FREQ-481-AC-05
      await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
      for (const [status, quantity, title] of [
        ['pending', 1, '注文を取り消す'], ['paid', 3, '注文をキャンセルする'], ['paid', 1, '返金'],
      ] as const) {
        const fx = await unshipped(rr, status);
        await cancelDb(rr, fx.orderId, fx.orderItemIds[0], quantity);
        await cancelScene(page, rr, fx);
        const refund = newRefundRouteState(refundMaterialsOf({
          orderId: fx.orderId, lines: [materialLineOf({ orderItemId: fx.orderItemIds[0], name: 'E2Eシャツ', quantity: 3, itemPrice: 5000 })],
        }));
        await mockRefundRoutes(page, fx.orderId, refund);
        await (await openCancel(page, fx.orderId)).getByRole('button', { name: '品を外す（返金・キャンセルの画面を開く）', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: title, exact: true });
        await expect(dialog).toBeVisible();
        // 行き先は申し込みの窓口の答え（shippedUnits・unshippedUnits）だけで決まり、「品を外す」は返金の材料を読まない。
        // 返金の画面と支払い済みのキャンセルの画面は、開いた後に自分で1回だけ読む。読み終えるのを待ってから数える
        // （待たずに数えると、行き先のための読み出しが1回あっても、画面の読み出しの前なので 1 のまま通ってしまう）
        if (title === '返金') {
          await expect(quantityInput(dialog, '発送前の商品', 'E2Eシャツ（ホワイト / M）')).toBeVisible();
        } else if (title === '注文をキャンセルする') {
          await expect(dialog.getByRole('list', { name: '返金の内訳', exact: true })).toBeVisible();
        }
        expect(refund.materialsReads).toBe(status === 'pending' ? 0 : 1);
      }
    });

    test('返金後の解決だけが失敗した時は注文の返金を保ち、案内に従って解決済みにできる', async ({ page, rr }) => {
      // FREQ-481-AC-07
      const { fx, requestId, state } = await refundScene(page, rr, true);
      await (await openCancel(page, fx.orderId)).getByRole('button', { name: '品を外す（返金・キャンセルの画面を開く）', exact: true }).click();
      await page.getByRole('dialog', { name: '返金', exact: true }).getByRole('button', { name: '￥5,000 を返金する', exact: true }).click();
      await expect(page.getByRole('alert').filter({
        hasText: '返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。',
      })).toBeVisible();
      expect((await rr.db.query('select status from public.order_cancel_requests where id=$1', [requestId])).rows[0].status).toBe('requested');
      expect(Number((await rr.db.query("select count(*) from public.order_refunds where order_id=$1 and status='succeeded'", [fx.orderId])).rows[0].count)).toBe(1);
      await (await openCancel(page, fx.orderId)).getByRole('button', { name: '解決済みにする', exact: true }).click();
      await page.getByRole('dialog', { name: /^解決済みにする（/ }).getByRole('button', { name: '解決済みにする', exact: true }).click();
      await expect.poll(() => state.current[0].status).toBe('closed');
    });
  });
}
