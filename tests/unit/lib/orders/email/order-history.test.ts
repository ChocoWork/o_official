import { buildOrderHistory, type OrderEmailHistoryRow } from '@/lib/orders/email/order-history';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const NOT_PAUSED = { paused: false, reason: null, pausedAt: null, nextProbeAt: null };

function email(overrides: Partial<OrderEmailHistoryRow> = {}): OrderEmailHistoryRow {
  return {
    id: 'email-1', kind: 'paid', origin: 'auto', requestedByEmail: null, status: 'sent', attempts: 1, lastErrorCode: null,
    deliveryStatus: null, deliveryEventAt: null, createdAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:05.000Z',
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, ...overrides,
  };
}

describe('buildOrderHistory', () => {
  it('受付・状態の変化・メールを新しい順に並べ、宛先と注文番号を出す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'shipped', shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_ship_paid_order',
          actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
        },
        {
          changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
      emailRows: [email({ deliveryStatus: 'delivered', deliveryEventAt: '2026-10-09T01:01:00.000Z' })],
      sendState: NOT_PAUSED,
    });

    expect(history.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '発送済み', recipient: 'hanako@example.com' });
    expect(history.sendPaused).toBeNull();
    expect(history.entries.map((entry) => entry.type)).toEqual(['status', 'email', 'status', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-10T02:00:00.000Z', fromLabel: '決済完了', toLabel: '発送済み',
      actorEmail: 'admin@example.com', detail: '配送業者: ヤマト運輸 / 伝票番号: 1234-5678',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'email', kindLabel: '注文確認', stateLabel: '配達済み', warning: false, manual: false, canViewContent: true, resendable: true,
    });
  });

  it('取消は理由を出す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'cancelled', shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'pending', toStatus: 'cancelled', changeReason: 'admin_cancel',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: 'customer_request',
      }],
      emailRows: [],
      sendState: NOT_PAUSED,
    });

    expect(history.entries[0]).toMatchObject({ fromLabel: '未決済', toLabel: 'キャンセル', detail: '理由: お客様の依頼' });
  });

  it('返金の同期で変わった状態は、全額返金・返金の取り消しと説明する', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'paid', shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [
        {
          changedAt: '2026-10-11T02:00:00.000Z', fromStatus: 'cancelled', toStatus: 'paid', changeReason: 'stripe_refund_projection',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'cancelled', changeReason: 'stripe_refund_projection',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
      emailRows: [],
      sendState: NOT_PAUSED,
    });

    expect(history.entries[0]).toMatchObject({
      type: 'status', fromLabel: 'キャンセル', toLabel: '決済完了', actorEmail: null, detail: '返金の取り消し',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'status', fromLabel: '決済完了', toLabel: 'キャンセル', actorEmail: null, detail: '理由: 全額返金',
    });
  });

  it('再送できるのは、送信済み・送れなかった行で、今の注文の状態で意味のある種類だけ。同じ種類の手の再送が送信待ちなら押せない', () => {
    const order = { id: ORDER_ID, status: 'paid' as const, shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' };

    const rows = (extra: OrderEmailHistoryRow[]) =>
      buildOrderHistory({ order, statusRows: [], emailRows: extra, sendState: NOT_PAUSED }).entries.filter((entry) => entry.type === 'email');

    expect(rows([email({ status: 'dead', lastErrorCode: 'invalid_message', hasBody: false })])[0]).toMatchObject({
      resendable: true, stateLabel: '送れなかった', warning: true, errorLabel: '宛先の形が不正', canViewContent: false,
    });
    expect(rows([email({ kind: 'awaiting_payment', status: 'sent' })])[0]).toMatchObject({ resendable: false });
    expect(rows([email({ status: 'skipped', lastErrorCode: 'superseded' })])[0]).toMatchObject({
      resendable: false, stateLabel: '取りやめ', errorLabel: '注文の状態が変わったため',
    });
    const withOpenManual = rows([
      email({ id: 'email-2', origin: 'manual', requestedByEmail: 'admin@example.com', status: 'pending', sentAt: null, hasBody: false }),
      email(),
    ]);
    expect(withOpenManual.map((entry) => entry.resendable)).toEqual([false, false]);
    expect(withOpenManual[0]).toMatchObject({ manual: true, requestedByEmail: 'admin@example.com', stateLabel: '送信待ち' });
  });

  it('送信を止めていれば、その原因の名前を返す', () => {
    const history = buildOrderHistory({
      order: { id: ORDER_ID, status: 'paid', shippingEmail: null, createdAt: '2026-10-08T23:00:00.000Z' },
      statusRows: [],
      emailRows: [],
      sendState: { paused: true, reason: 'quota_daily' },
    });

    expect(history.sendPaused).toEqual({ reasonLabel: '1日の送信の上限' });
    expect(history.order.recipient).toBeNull();
  });
});
