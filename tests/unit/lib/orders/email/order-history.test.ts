import {
  buildOrderHistory,
  type BuildOrderHistoryInput,
  type OrderEmailHistoryRow,
  type OrderHistoryEntry,
  type OrderHistoryLine,
  type OrderHistoryReturnReceiptLine,
  type OrderHistoryReturnRecord,
} from '@/lib/orders/email/order-history';
import type { OrderCompletionHistoryRow, OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';
import type { OrderRefundLineRow, OrderRefundRow } from '@/lib/orders/refund/refund-store';
import { returnDetail } from '../returns/order-return-detail-fixture';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const NOT_PAUSED = { paused: false, reason: null, pausedAt: null, nextProbeAt: null };
const ORDER = { id: ORDER_ID, status: 'paid' as const, shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' };

const BLOUSE = '11111111-1111-4111-8111-111111111111'; // 在庫の品
const PANTS = '22222222-2222-4222-8222-222222222222'; // 受注生産の品（1つ仕上がった・まだ送っていない）
const DRESS = '33333333-3333-4333-8333-333333333333'; // 受注生産の品（3つ仕上がり、2つ送った）

const LINES: OrderHistoryLine[] = [
  { orderItemId: BLOUSE, name: 'シルクブラウス（白 / M）', shipped: 1, completed: 2 },
  { orderItemId: PANTS, name: 'リネンパンツ', shipped: 0, completed: 1 },
  { orderItemId: DRESS, name: 'ウールドレス（黒 / S）', shipped: 2, completed: 3 },
];

function email(overrides: Partial<OrderEmailHistoryRow> = {}): OrderEmailHistoryRow {
  return {
    id: 'email-1', kind: 'paid', origin: 'auto', requestedByEmail: null, status: 'sent', attempts: 1, lastErrorCode: null,
    deliveryStatus: null, deliveryEventAt: null, createdAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:05.000Z',
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, fulfillmentId: null, fulfillmentNumber: null,
    refundId: null, returnId: null, returnReceiptId: null, ...overrides,
  };
}

function fulfillment(overrides: Partial<OrderFulfillmentHistoryRow> = {}): OrderFulfillmentHistoryRow {
  return {
    fulfillmentId: 'f-1', number: 1, shippingCarrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true, completesOrder: false,
    shippedAt: '2026-10-10T02:00:00.000Z', createdByEmail: 'admin@example.com', cancelledAt: null, cancelledByEmail: null, legacy: false,
    lines: [{ orderItemId: BLOUSE, quantity: 1 }], ...overrides,
  };
}

function completion(overrides: Partial<OrderCompletionHistoryRow> = {}): OrderCompletionHistoryRow {
  return {
    completionId: 'c-1', orderItemId: PANTS, quantity: 1, createdAt: '2026-10-10T01:00:00.000Z', createdByEmail: 'admin@example.com',
    cancelledAt: null, cancelledByEmail: null, legacy: false, ...overrides,
  };
}

const REFUND_CREATED_AT = '2026-10-11T01:00:00.000Z'; // 返金の記録を作った（返事待ち）
const REFUND_ACCEPTED_AT = '2026-10-11T01:00:03.000Z'; // Stripe が受け付けた
const REFUND_SUCCEEDED_AT = '2026-10-11T01:05:00.000Z'; // 成功した
const REFUND_FAILED_AT = '2026-10-11T02:00:00.000Z'; // 失敗した・エラーにした

function refundLine(overrides: Partial<OrderRefundLineRow> = {}): OrderRefundLineRow {
  return {
    orderItemId: BLOUSE, quantity: 1, beforeShipment: true, restockType: 'cancel', amount: 4_500,
    releasedQuantity: 1, restockedQuantity: 1, rereservedQuantity: 0, rereserveShortage: 0, ...overrides,
  };
}

/** 管理画面から返金し、Stripe が保留で受け付けた後に成功した返金 */
function refund(overrides: Partial<OrderRefundRow> = {}): OrderRefundRow {
  return {
    refundId: 'r-1', source: 'admin', status: 'succeeded', stripeStatus: 'succeeded', pendingReason: null, failureReason: null,
    customerActionExpiresAt: null, paymentMethodType: 'card', amount: 5_000, shippingAmount: 500, adjustmentAmount: 0, note: null,
    stripeReason: null, cancelReason: null, notifyCustomer: true, actorEmail: 'admin@example.com', referenceNumber: null,
    referenceType: null, createdAt: REFUND_CREATED_AT, acceptedAt: REFUND_ACCEPTED_AT, succeededAt: REFUND_SUCCEEDED_AT,
    failedAt: null, erroredAt: null, lines: [refundLine()], ...overrides,
  };
}

function input(overrides: Partial<BuildOrderHistoryInput> = {}): BuildOrderHistoryInput {
  return {
    order: ORDER, statusRows: [], emailRows: [], sendState: NOT_PAUSED, fulfillments: [], completions: [], refunds: [], returns: [],
    returnReceiptLines: [], returnRecords: [], lines: [],
    ...overrides,
  };
}

function entriesOf<T extends OrderHistoryEntry['type']>(entries: OrderHistoryEntry[], type: T): Array<Extract<OrderHistoryEntry, { type: T }>> {
  return entries.filter((entry): entry is Extract<OrderHistoryEntry, { type: T }> => entry.type === type);
}

describe('buildOrderHistory', () => {
  it('受付・状態の変化・メールを新しい順に並べ、宛先と注文番号を出す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      statusRows: [
        {
          changedAt: '2026-10-10T02:00:00.000Z', fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_create_fulfillment',
          actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
        },
        {
          changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
          actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
        },
      ],
      emailRows: [email({ deliveryStatus: 'delivered', deliveryEventAt: '2026-10-09T01:01:00.000Z' })],
    }));

    expect(history.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '発送済み', recipient: 'hanako@example.com' });
    expect(history.sendPaused).toBeNull();
    expect(history.entries.map((entry) => entry.type)).toEqual(['status', 'email', 'status', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-10T02:00:00.000Z', fromLabel: '決済完了', toLabel: '発送済み',
      actorEmail: 'admin@example.com', detail: '配送業者: ヤマト運輸 / 伝票番号: 1234-5678',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'email', kindLabel: '注文確認', stateLabel: '配達済み', warning: false, manual: false, canViewContent: true, resendable: true,
      fulfillmentId: null, fulfillmentNumber: null,
    });
  });

  it('取消は理由を出す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'cancelled' },
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'pending', toStatus: 'cancelled', changeReason: 'admin_cancel',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: 'customer_request',
      }],
    }));

    expect(history.entries[0]).toMatchObject({ fromLabel: '未決済', toLabel: 'キャンセル', detail: '理由: お客様の依頼' });
  });

  it('返金の同期で変わった状態は、全額返金・返金の取り消しと説明する', () => {
    const history = buildOrderHistory(input({
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
    }));

    expect(history.entries[0]).toMatchObject({
      type: 'status', fromLabel: 'キャンセル', toLabel: '決済完了', actorEmail: null, detail: '返金の取り消し',
    });
    expect(history.entries[1]).toMatchObject({
      type: 'status', fromLabel: '決済完了', toLabel: 'キャンセル', actorEmail: null, detail: '理由: 全額返金',
    });
  });

  it('発送の取消で発送済みから決済完了に戻った状態の行は、説明を「発送の取消」にする', () => {
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: '2026-10-11T03:00:00.000Z', fromStatus: 'shipped', toStatus: 'paid', changeReason: 'admin_cancel_fulfillment',
        actorEmail: 'admin@example.com', shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
    }));

    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-11T03:00:00.000Z', fromLabel: '発送済み', toLabel: '決済完了',
      actorEmail: 'admin@example.com', detail: '発送の取消',
    });
  });

  it('再送できるのは、送信済み・送れなかった行で、今の注文の状態で意味のある種類だけ。同じ種類の手の再送が送信待ちなら押せない', () => {
    const rows = (extra: OrderEmailHistoryRow[]) =>
      entriesOf(buildOrderHistory(input({ emailRows: extra })).entries, 'email');

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

  it('返金の取り消しでキャンセルから発送済みに戻る時は、配送情報より返金の取り消しを優先する', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped', shippingEmail: null },
      statusRows: [{
        changedAt: '2026-10-11T02:00:00.000Z', fromStatus: 'cancelled', toStatus: 'shipped', changeReason: 'stripe_refund_projection',
        actorEmail: null, shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
      }],
    }));

    expect(history.entries[0]).toEqual({
      type: 'status', at: '2026-10-11T02:00:00.000Z', fromLabel: 'キャンセル', toLabel: '発送済み', actorEmail: null, detail: '返金の取り消し',
    });
  });

  it('送信を止めていれば、その原因の名前を返す', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, shippingEmail: null },
      sendState: { paused: true, reason: 'quota_daily' },
    }));

    expect(history.sendPaused).toEqual({ reasonLabel: '1日の送信の上限' });
    expect(history.order.recipient).toBeNull();
  });
});

describe('buildOrderHistory - 発送', () => {
  it('発送の行は、何回目・配送業者・伝票番号・商品と数・操作した人・メールの有無・全部送ったかを持つ', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({
        number: 2, completesOrder: true, lines: [{ orderItemId: BLOUSE, quantity: 1 }, { orderItemId: PANTS, quantity: 1 }],
      })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')).toEqual([{
      type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: 'f-1', number: 2, carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス（白 / M）', quantity: 1 }, { name: 'リネンパンツ', quantity: 1 }],
      actorEmail: 'admin@example.com', notifyCustomer: true, completesOrder: true, cancelled: false, cancellable: true, legacy: false,
    }]);
  });

  it('取り消した発送は、発送の行に取り消し済みの印を付けて取消の行を足す。もう取り消せない', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({ cancelledAt: '2026-10-11T03:00:00.000Z', cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['fulfillment_cancel', 'fulfillment', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'fulfillment_cancel', at: '2026-10-11T03:00:00.000Z', fulfillmentId: 'f-1', number: 1, actorEmail: 'owner@example.com',
    });
    expect(history.entries[1]).toMatchObject({ type: 'fulfillment', cancelled: true, cancellable: false });
  });

  it.each([
    ['payment_in_progress', false],
    ['pending', false],
    ['paid', true],
    ['failed', false],
    ['abandoned', false],
    ['cancelled', false],
    ['shipped', true],
  ] as const)('注文が %s の時、発送を取り消せるか=%s', (status, cancellable) => {
    const history = buildOrderHistory(input({ order: { ...ORDER, status }, fulfillments: [fulfillment()], lines: LINES }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({ cancellable });
  });

  it('前からの記録（legacy）は印を付ける。配送業者・伝票番号・操作した人が空でもよい', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      fulfillments: [fulfillment({ shippingCarrier: null, trackingNumber: null, createdByEmail: null, legacy: true })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({
      carrierLabel: null, trackingNumber: null, actorEmail: null, legacy: true,
    });
  });

  it('知らない配送業者は名前を出さない。商品の名前が分からなければ「商品」と出す', () => {
    const history = buildOrderHistory(input({
      fulfillments: [fulfillment({ shippingCarrier: 'dhl', lines: [{ orderItemId: 'unknown-item', quantity: 3 }] })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'fulfillment')[0]).toMatchObject({ carrierLabel: null, items: [{ name: '商品', quantity: 3 }] });
  });
});

describe('buildOrderHistory - 仕上がり', () => {
  it('仕上がりの行は、商品と数・操作した人を持ち、取り消せる', () => {
    const history = buildOrderHistory(input({ completions: [completion()], lines: LINES }));

    expect(entriesOf(history.entries, 'completion')).toEqual([{
      type: 'completion', at: '2026-10-10T01:00:00.000Z', completionId: 'c-1', items: [{ name: 'リネンパンツ', quantity: 1 }],
      actorEmail: 'admin@example.com', cancelled: false, cancellable: true, legacy: false,
    }]);
  });

  it('仕上がりを取り消せるのは、取り消しても仕上がった数が送った数を下回らない時だけ', () => {
    // ウールドレスは3つ仕上がり、2つ送った。2つの記録を取り消すと1つになって送った数を下回る。1つの記録なら2つ残る
    const history = buildOrderHistory(input({
      completions: [
        completion({ completionId: 'c-a', orderItemId: DRESS, quantity: 2 }),
        completion({ completionId: 'c-b', orderItemId: DRESS, quantity: 1 }),
        completion({ completionId: 'c-c', orderItemId: PANTS, quantity: 1 }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'completion').map((entry) => [entry.completionId, entry.cancellable])).toEqual([
      ['c-a', false],
      ['c-b', true],
      ['c-c', true],
    ]);
  });

  it.each([
    ['payment_in_progress', false],
    ['pending', false],
    ['paid', true],
    ['failed', false],
    ['abandoned', false],
    ['cancelled', false],
    ['shipped', false],
  ] as const)('注文が %s の時、仕上がりを取り消せるか=%s（決済完了の注文だけ）', (status, cancellable) => {
    const history = buildOrderHistory(input({ order: { ...ORDER, status }, completions: [completion()], lines: LINES }));

    expect(entriesOf(history.entries, 'completion')[0]).toMatchObject({ cancellable });
  });

  it('取り消した仕上がりは、取り消し済みの印を付けて取消の行を足す。もう取り消せない', () => {
    const history = buildOrderHistory(input({
      completions: [completion({ cancelledAt: '2026-10-11T04:00:00.000Z', cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['completion_cancel', 'completion', 'created']);
    expect(history.entries[0]).toEqual({
      type: 'completion_cancel', at: '2026-10-11T04:00:00.000Z', completionId: 'c-1', actorEmail: 'owner@example.com',
    });
    expect(history.entries[1]).toMatchObject({ type: 'completion', cancelled: true, cancellable: false });
  });

  it('商品の数が分からない仕上がり（前からの記録で商品が消えた等）は、取り消しの印を出さず、名前は「商品」', () => {
    const history = buildOrderHistory(input({ completions: [completion({ legacy: true, createdByEmail: null })], lines: [] }));

    expect(entriesOf(history.entries, 'completion')[0]).toMatchObject({
      items: [{ name: '商品', quantity: 1 }], cancellable: false, legacy: true, actorEmail: null,
    });
  });
});

describe('buildOrderHistory - 発送ごとのメール', () => {
  it('発送のメールの行は「発送（n回目）」と出し、どの発送かを返す。発送の番号が無い行は「発送」', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
        email({ id: 'e-0', kind: 'shipped', fulfillmentId: null, fulfillmentNumber: null }),
        email(),
      ],
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.kindLabel, entry.fulfillmentId, entry.fulfillmentNumber])).toEqual([
      ['発送（2回目）', 'f-2', 2],
      ['発送', null, null],
      ['注文確認', null, null],
    ]);
  });

  it('発送のメールを再送できるのは、その発送が取り消されていない時だけ。ほかの発送のメールには影響しない', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({ id: 'e-1', kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1 }),
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
      ],
      fulfillments: [
        fulfillment({ fulfillmentId: 'f-1', number: 1, cancelledAt: '2026-10-11T03:00:00.000Z', cancelledByEmail: 'owner@example.com' }),
        fulfillment({ fulfillmentId: 'f-2', number: 2 }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.emailId, entry.resendable])).toEqual([
      ['e-1', false],
      ['e-2', true],
    ]);
  });

  it('発送のメールは一部だけ送った間（決済完了）でも再送できる。手の再送が送信待ちなら、その発送だけ押せない', () => {
    const history = buildOrderHistory(input({
      emailRows: [
        email({
          id: 'manual-2', kind: 'shipped', origin: 'manual', requestedByEmail: 'admin@example.com', status: 'pending', sentAt: null,
          hasBody: false, fulfillmentId: 'f-2', fulfillmentNumber: 2,
        }),
        email({ id: 'e-2', kind: 'shipped', fulfillmentId: 'f-2', fulfillmentNumber: 2 }),
        email({ id: 'e-1', kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1 }),
      ],
      fulfillments: [fulfillment({ fulfillmentId: 'f-1', number: 1 }), fulfillment({ fulfillmentId: 'f-2', number: 2 })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'email').map((entry) => [entry.emailId, entry.resendable])).toEqual([
      ['manual-2', false],
      ['e-2', false],
      ['e-1', true],
    ]);
  });
});

describe('buildOrderHistory - 並び順', () => {
  it('同じ時刻の行は、結果が上になる順（メール → 状態 → 取消 → 発送・仕上がり → 受付）に置く', () => {
    const at = '2026-10-10T02:00:00.000Z';
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'shipped' },
      statusRows: [{
        changedAt: at, fromStatus: 'paid', toStatus: 'shipped', changeReason: 'admin_create_fulfillment',
        actorEmail: 'admin@example.com', shippingCarrier: 'yamato', trackingNumber: '1234-5678', cancelReason: null,
      }],
      emailRows: [email({ kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1, createdAt: at })],
      fulfillments: [fulfillment({ shippedAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      completions: [completion({ createdAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual([
      'email', 'status', 'fulfillment_cancel', 'completion_cancel', 'fulfillment', 'completion', 'created',
    ]);
  });

  it('発送・仕上がり・メール・状態を、時刻の新しい順に混ぜる', () => {
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: '2026-10-09T01:00:00.000Z', fromStatus: 'payment_in_progress', toStatus: 'paid', changeReason: 'stripe_payment_paid',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
      emailRows: [email({ kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1, createdAt: '2026-10-10T02:00:00.000Z' })],
      fulfillments: [fulfillment({ shippedAt: '2026-10-10T02:00:00.000Z' })],
      completions: [completion({ createdAt: '2026-10-09T05:00:00.000Z' })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['email', 'fulfillment', 'completion', 'status', 'created']);
  });
});

describe('buildOrderHistory - 返金', () => {
  it('返金の行は、どこから・額・送料・商品と数・在庫に戻した数・操作した人・メモ・Stripe に伝えた理由・照会番号・状態の移り変わりを持つ', () => {
    const history = buildOrderHistory(input({
      refunds: [refund({
        stripeReason: 'requested_by_customer',
        note: 'お客様の依頼で返金',
        referenceNumber: '24012345678901234567890',
        lines: [
          refundLine({ orderItemId: BLOUSE, quantity: 1, amount: 4_500, releasedQuantity: 1, restockedQuantity: 1 }),
          refundLine({
            orderItemId: DRESS, quantity: 2, beforeShipment: false, restockType: 'no_restock', amount: 0,
            releasedQuantity: 0, restockedQuantity: 0,
          }),
        ],
      })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'refund')).toEqual([{
      type: 'refund', at: REFUND_CREATED_AT, refundId: 'r-1', source: 'admin', sourceLabel: '管理画面', actorEmail: 'admin@example.com',
      amount: 5_000, shippingAmount: 500,
      items: [
        { name: 'シルクブラウス（白 / M）', quantity: 1, beforeShipment: true, restockedQuantity: 1 },
        { name: 'ウールドレス（黒 / S）', quantity: 2, beforeShipment: false, restockedQuantity: 0 },
      ],
      steps: [
        { status: 'awaiting_response', label: '返事待ち', at: REFUND_CREATED_AT },
        { status: 'pending', label: '保留', at: REFUND_ACCEPTED_AT },
        { status: 'succeeded', label: '成功', at: REFUND_SUCCEEDED_AT },
      ],
      failureReasonLabel: null, referenceNumber: '24012345678901234567890', customerActionExpiresAt: null,
      note: 'お客様の依頼で返金', stripeReasonLabel: 'お客様の希望', cancelReasonLabel: null,
    }]);
  });

  it.each([
    ['admin', '管理画面'],
    ['order_cancel', '注文のキャンセル'],
    ['stripe_dashboard', 'Stripe の画面'],
    ['auto_cancelled_order_payment', '自動の返金（取り消した注文への入金）'],
    ['auto_amount_mismatch', '自動の取消（支払額の違い）'],
    ['legacy', '前からの写し'],
  ] as const)('どこからの返金か: %s は「%s」', (source, sourceLabel) => {
    const history = buildOrderHistory(input({ refunds: [refund({ source })] }));

    expect(entriesOf(history.entries, 'refund')[0]).toMatchObject({ source, sourceLabel });
  });

  it('注文のキャンセルの返金の行には、取消の理由とメモと操作した人が出る', () => {
    const history = buildOrderHistory(input({
      refunds: [refund({ source: 'order_cancel', cancelReason: 'stock_unavailable', note: '在庫が合わない', actorEmail: 'owner@example.com' })],
    }));

    expect(entriesOf(history.entries, 'refund')[0]).toMatchObject({
      sourceLabel: '注文のキャンセル', cancelReasonLabel: '在庫切れ', note: '在庫が合わない', actorEmail: 'owner@example.com',
    });
  });

  it.each([
    ['requested_by_customer', 'お客様の希望'],
    ['duplicate', '重複した支払い'],
    ['fraudulent', '不正の疑い'],
  ] as const)('Stripe に伝えた理由 %s は「%s」と出す。伝えていなければ空', (stripeReason, label) => {
    const history = buildOrderHistory(input({ refunds: [refund({ stripeReason }), refund({ refundId: 'r-2' })] }));

    expect(entriesOf(history.entries, 'refund').map((entry) => [entry.refundId, entry.stripeReasonLabel])).toEqual([
      ['r-1', label],
      ['r-2', null],
    ]);
  });

  it('額だけの返金（Stripe の画面からの返金など、商品の行が無い）は、商品の欄が空で、操作した人も空', () => {
    const history = buildOrderHistory(input({ refunds: [refund({ source: 'stripe_dashboard', actorEmail: null, lines: [] })] }));

    expect(entriesOf(history.entries, 'refund')[0]).toMatchObject({ source: 'stripe_dashboard', actorEmail: null, items: [] });
  });

  it('名前の分からない商品は「商品」と出す', () => {
    const history = buildOrderHistory(input({
      refunds: [refund({ lines: [refundLine({ orderItemId: 'unknown-item', quantity: 3 })] })],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'refund')[0].items).toEqual([
      { name: '商品', quantity: 3, beforeShipment: true, restockedQuantity: 1 },
    ]);
  });
});

describe('buildOrderHistory - 返金の状態の移り変わり', () => {
  function stepsOf(overrides: Partial<OrderRefundRow>) {
    const history = buildOrderHistory(input({ refunds: [refund(overrides)] }));
    return entriesOf(history.entries, 'refund')[0].steps.map((step) => [step.label, step.at]);
  }

  it('返事待ち → 保留 → 成功', () => {
    expect(stepsOf({})).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['保留', REFUND_ACCEPTED_AT],
      ['成功', REFUND_SUCCEEDED_AT],
    ]);
  });

  it('受け付けてすぐ成功した返金は、保留を挟まない（受け付けた時刻と成功の時刻が同じ）', () => {
    expect(stepsOf({ acceptedAt: REFUND_SUCCEEDED_AT })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['成功', REFUND_SUCCEEDED_AT],
    ]);
  });

  it('保留のまま（コンビニ払いの口座の入力待ちなど）は、返事待ち → 保留で止まり、入力の期限を持つ', () => {
    const history = buildOrderHistory(input({
      refunds: [refund({
        status: 'pending', stripeStatus: 'requires_action', succeededAt: null, paymentMethodType: 'konbini',
        customerActionExpiresAt: '2026-11-25T14:59:59.000Z',
      })],
    }));
    const entry = entriesOf(history.entries, 'refund')[0];

    expect(entry.steps.map((step) => step.label)).toEqual(['返事待ち', '保留']);
    expect(entry.customerActionExpiresAt).toBe('2026-11-25T14:59:59.000Z');
  });

  it('返事待ちのまま（通信が切れて Stripe の返事が無い）は、返事待ちだけ', () => {
    expect(stepsOf({ status: 'awaiting_response', stripeStatus: null, acceptedAt: null, succeededAt: null })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
    ]);
  });

  it('保留の後に失敗した返金は、返事待ち → 保留 → 失敗', () => {
    expect(stepsOf({ status: 'failed', stripeStatus: 'failed', succeededAt: null, failedAt: REFUND_FAILED_AT })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['保留', REFUND_ACCEPTED_AT],
      ['失敗', REFUND_FAILED_AT],
    ]);
  });

  it('Stripe が作ったその場で失敗の返金を返した時は、保留を挟まず 返事待ち → 失敗（本計画 P21）', () => {
    expect(stepsOf({
      status: 'failed', stripeStatus: 'failed', acceptedAt: null, succeededAt: null, failedAt: REFUND_ACCEPTED_AT,
    })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['失敗', REFUND_ACCEPTED_AT],
    ]);
  });

  it('成功した後に銀行から戻された返金は、返事待ち → 成功 → 失敗', () => {
    expect(stepsOf({ status: 'failed', stripeStatus: 'failed', acceptedAt: REFUND_SUCCEEDED_AT, failedAt: REFUND_FAILED_AT })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['成功', REFUND_SUCCEEDED_AT],
      ['失敗', REFUND_FAILED_AT],
    ]);
  });

  it('エラーにした返金は、返事待ち → エラー', () => {
    expect(stepsOf({
      status: 'error', stripeStatus: null, acceptedAt: null, succeededAt: null, erroredAt: REFUND_FAILED_AT,
    })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['エラー', REFUND_FAILED_AT],
    ]);
  });

  it('エラーにした後で Stripe に見つかって成功した返金は、エラーの行を残す（本計画 P23）', () => {
    expect(stepsOf({ erroredAt: REFUND_ACCEPTED_AT, acceptedAt: REFUND_SUCCEEDED_AT })).toEqual([
      ['返事待ち', REFUND_CREATED_AT],
      ['エラー', REFUND_ACCEPTED_AT],
      ['成功', REFUND_SUCCEEDED_AT],
    ]);
  });

  it('同じ時刻の行は、状態の進む順に置く（前からの写しは、作った時刻と受け付けた時刻が同じ）', () => {
    expect(stepsOf({ createdAt: REFUND_SUCCEEDED_AT, acceptedAt: REFUND_SUCCEEDED_AT })).toEqual([
      ['返事待ち', REFUND_SUCCEEDED_AT],
      ['成功', REFUND_SUCCEEDED_AT],
    ]);
  });
});

describe('buildOrderHistory - 返金の失敗とエラーの理由', () => {
  function failureLabelOf(overrides: Partial<OrderRefundRow>) {
    return entriesOf(buildOrderHistory(input({ refunds: [refund(overrides)] })).entries, 'refund')[0].failureReasonLabel;
  }
  const failed = { status: 'failed', stripeStatus: 'failed', succeededAt: null, failedAt: REFUND_FAILED_AT } as const;

  it.each([
    ['declined', 'カード会社に断られました'],
    ['expired', '口座の入力の期限が過ぎました'],
    ['insufficient_funds', 'Stripe の残高が足りません'],
    ['charge_for_pending_refund_disputed', '異議申し立てがありました'],
    ['unknown', '不明な理由'],
    ['a_code_stripe_added_later', '不明な理由'],
    // Object が持つ名前（DB の記号の形 ^[a-z0-9_]{1,64}$ に合う）を、表の言葉として引かない
    ['constructor', '不明な理由'],
  ])('失敗の理由 %s は「%s」と出す', (failureReason, label) => {
    expect(failureLabelOf({ ...failed, failureReason })).toBe(label);
  });

  it('理由が書かれていない失敗は「不明な理由」', () => {
    expect(failureLabelOf({ ...failed, failureReason: null })).toBe('不明な理由');
  });

  it.each([
    ['stripe_rejected', 'Stripe が受け付けませんでした'],
    ['not_found_in_stripe', 'Stripe に届きませんでした'],
  ])('エラーの理由 %s は「%s」と出す', (failureReason, label) => {
    expect(failureLabelOf({
      status: 'error', stripeStatus: null, acceptedAt: null, succeededAt: null, erroredAt: REFUND_FAILED_AT, failureReason,
    })).toBe(label);
  });

  it('成功・保留・返事待ちの返金は、前に書かれた理由が残っていても理由を出さない', () => {
    for (const status of ['succeeded', 'pending', 'awaiting_response'] as const) {
      expect(failureLabelOf({ status, failureReason: 'declined' })).toBeNull();
    }
  });
});

describe('buildOrderHistory - 返金の失敗と確保し直し', () => {
  function failedRefund(lines: OrderRefundLineRow[], overrides: Partial<OrderRefundRow> = {}) {
    return refund({
      status: 'failed', stripeStatus: 'failed', failureReason: 'expired', succeededAt: null, failedAt: REFUND_FAILED_AT, lines, ...overrides,
    });
  }

  it('失敗で在庫を確保し直した返金は、確保し直しの行を足す。at は失敗した時刻で、確保し直した数と足りなかった数を持つ', () => {
    const history = buildOrderHistory(input({
      refunds: [failedRefund([
        refundLine({
          orderItemId: BLOUSE, quantity: 2, releasedQuantity: 2, restockedQuantity: 2, rereservedQuantity: 1, rereserveShortage: 1,
        }),
        refundLine({
          orderItemId: PANTS, quantity: 1, restockType: 'no_restock', releasedQuantity: 1, restockedQuantity: 0,
          rereservedQuantity: 1, rereserveShortage: 0,
        }),
        // 発送後の行は確保を外していないので、確保し直しも無い
        refundLine({
          orderItemId: DRESS, quantity: 1, beforeShipment: false, restockType: 'no_restock', releasedQuantity: 0, restockedQuantity: 0,
        }),
      ])],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['refund_rereserve', 'refund', 'created']);
    expect(entriesOf(history.entries, 'refund_rereserve')).toEqual([{
      type: 'refund_rereserve', at: REFUND_FAILED_AT, refundId: 'r-1',
      items: [
        { name: 'シルクブラウス（白 / M）', quantity: 1, shortage: 1 },
        { name: 'リネンパンツ', quantity: 1, shortage: 0 },
      ],
    }]);
  });

  it('確保し直しの行を足さない返金: 在庫を動かさなかった失敗・成功した返金・失敗した時刻が無い返金', () => {
    const notMoved = [refundLine({ releasedQuantity: 0, restockedQuantity: 0 })];
    const history = buildOrderHistory(input({
      refunds: [
        failedRefund(notMoved, { refundId: 'r-direct', acceptedAt: null }),
        refund({ refundId: 'r-ok' }),
        refund({ refundId: 'r-no-time', lines: [refundLine({ rereservedQuantity: 1 })] }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'refund_rereserve')).toEqual([]);
  });
});

describe('buildOrderHistory - 返金で変わった状態の説明', () => {
  it.each<[string, string, string, string, string, string | null, string | null]>([
    ['全額の返金でキャンセルになった', '理由: 全額返金', 'refund_projection', 'paid', 'cancelled', null, null],
    ['発送済みの注文が全額の返金でキャンセルになった', '理由: 全額返金', 'refund_projection', 'shipped', 'cancelled', 'yamato', null],
    ['前の版の返金の取り込み（stripe_refund_projection）でキャンセルになった', '理由: 全額返金', 'stripe_refund_projection', 'paid', 'cancelled', null, null],
    // 支払い済みのキャンセルは取消の理由が付くが、状態の行は返金として説明する。取消の理由は返金の行に出る
    ['取消の理由が付いた支払い済みのキャンセル', '理由: 全額返金', 'refund_projection', 'paid', 'cancelled', null, 'stock_unavailable'],
    ['返金の取り消しで支払い済みに戻った', '返金の取り消し', 'refund_projection', 'cancelled', 'paid', null, null],
    // 発送済みへ戻る行は配送業者も入るが、返金の取り消しを先に説明する
    ['返金の取り消しで発送済みに戻った', '返金の取り消し', 'refund_projection', 'cancelled', 'shipped', 'yamato', null],
    // 発送済みになる行も配送業者が入る（最後の発送の値）が、返金のためと説明する
    ['残りの商品を返金して発送済みになった', '残りの商品を返金したため発送済み', 'refund_completed_order', 'paid', 'shipped', 'yamato', null],
    ['返金の失敗で発送待ちに戻った', '返金の失敗で発送待ちに戻りました', 'refund_failed_reopened', 'shipped', 'paid', null, null],
  ])('%s 状態の行は「%s」と説明する', (_name, detail, changeReason, fromStatus, toStatus, shippingCarrier, cancelReason) => {
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: '2026-10-11T03:00:00.000Z', fromStatus, toStatus, changeReason, actorEmail: null,
        shippingCarrier, trackingNumber: shippingCarrier ? '1234-5678' : null, cancelReason,
      }],
    }));

    expect(entriesOf(history.entries, 'status')[0]).toMatchObject({ detail });
  });
});

describe('buildOrderHistory - 返金のお知らせと並び順', () => {
  it('返金のお知らせのメールの行は、種類の名前「返金のお知らせ」で出し、再送できない', () => {
    const history = buildOrderHistory(input({ order: { ...ORDER, status: 'shipped' }, emailRows: [email({ kind: 'refund' })] }));

    expect(entriesOf(history.entries, 'email')[0]).toMatchObject({ kindLabel: '返金のお知らせ', resendable: false });
  });

  // 返品のメール4種類（グループ E-3 計画 C-5・P7）。返品ごと・受け取りごとに1通で、お返しのメッセージは送った時の事実なので再送しない
  it.each([
    ['return_accepted', '返品の受付のお知らせ', { returnId: 'return-1' }],
    ['return_received', '返品の受け取りのお知らせ', { returnId: 'return-1', returnReceiptId: 'receipt-1' }],
    ['return_sent_back', '品物のお返しのお知らせ', { returnId: 'return-1', returnReceiptId: 'receipt-1' }],
    ['return_refund_pending_shop', '店への知らせ（返金待ち）', { returnId: 'return-1', returnReceiptId: 'receipt-1' }],
  ] as const)('%s のメールの行は、種類の名前「%s」で出し、どの注文の状態でも再送できない', (kind, kindLabel, ids) => {
    for (const status of ['paid', 'shipped', 'cancelled'] as const) {
      const history = buildOrderHistory(input({ order: { ...ORDER, status }, emailRows: [email({ kind, ...ids })] }));

      expect(entriesOf(history.entries, 'email')[0]).toMatchObject({
        kindLabel, resendable: false, stateLabel: '送信済み', canViewContent: true, fulfillmentId: null, fulfillmentNumber: null,
      });
    }
  });

  it('送れなかった返品のメールの行も、再送できない', () => {
    const history = buildOrderHistory(input({
      emailRows: [email({ kind: 'return_received', status: 'dead', lastErrorCode: 'source_missing', hasBody: false, returnReceiptId: 'receipt-1' })],
    }));

    expect(entriesOf(history.entries, 'email')[0]).toMatchObject({
      kindLabel: '返品の受け取りのお知らせ', stateLabel: '送れなかった', warning: true, errorLabel: '注文の情報が足りない', resendable: false,
    });
  });

  // 返品を取り消すと、DB がまだ送っていない受付のお知らせを取りやめにする（原因の記号 return_cancelled。グループ E-3 設計書 7-3）
  it('取り消した返品の、まだ送っていなかった受付のお知らせの行は、取りやめとして原因を「返品の取消」と出す', () => {
    const history = buildOrderHistory(input({
      emailRows: [email({ kind: 'return_accepted', status: 'skipped', lastErrorCode: 'return_cancelled', hasBody: false, sentAt: null, returnId: 'return-1' })],
    }));

    expect(entriesOf(history.entries, 'email')[0]).toMatchObject({
      kindLabel: '返品の受付のお知らせ', stateLabel: '取りやめ', errorLabel: '返品の取消', resendable: false, canViewContent: false,
    });
  });

  it('同じ時刻の行は、結果が上になる順（メール → 状態 → 取消 → 確保し直し → 発送・仕上がり・返金 → 受付）に置く', () => {
    const at = '2026-10-10T02:00:00.000Z';
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: at, fromStatus: 'shipped', toStatus: 'paid', changeReason: 'refund_failed_reopened',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
      emailRows: [email({ kind: 'shipped', fulfillmentId: 'f-1', fulfillmentNumber: 1, createdAt: at })],
      fulfillments: [fulfillment({ shippedAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      completions: [completion({ createdAt: at, cancelledAt: at, cancelledByEmail: 'owner@example.com' })],
      refunds: [refund({
        status: 'failed', stripeStatus: 'failed', createdAt: at, acceptedAt: at, succeededAt: null, failedAt: at,
        lines: [refundLine({ rereservedQuantity: 1 })],
      })],
      lines: LINES,
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual([
      'email', 'status', 'fulfillment_cancel', 'completion_cancel', 'refund_rereserve', 'fulfillment', 'completion', 'refund', 'created',
    ]);
  });

  it('返金・確保し直し・状態・メールを、時刻の新しい順に混ぜる', () => {
    const history = buildOrderHistory(input({
      order: { ...ORDER, status: 'cancelled' },
      statusRows: [{
        changedAt: REFUND_SUCCEEDED_AT, fromStatus: 'paid', toStatus: 'cancelled', changeReason: 'refund_projection',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: 'customer_request',
      }],
      emailRows: [email({ kind: 'canceled', createdAt: '2026-10-11T01:05:01.000Z' })],
      refunds: [refund({ source: 'order_cancel', cancelReason: 'customer_request' })],
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['email', 'status', 'refund', 'created']);
  });
});


// 返品の行（グループ E-3 設計書 8-1。文は共通の約束 C-5）。returnDetail の見本は、注文 ORDER_ID の1つ目の返品（番号 ORD-A1B2C3D4-R1）
const EXCHANGE_LINE = '44444444-4444-4444-8444-444444444444'; // 返品の交換で足した交換の品の行

function receiptLine(receiptId: string, disposition: string, quantity: number): OrderHistoryReturnReceiptLine {
  return { receiptId, disposition, quantity };
}

/** 窓口が order_returns から引いて渡す、取消などをした人のメールと手数料をいただかない印（returnDetail の見本の返品 ret-1 の分） */
function returnRecord(overrides: Partial<OrderHistoryReturnRecord> = {}): OrderHistoryReturnRecord {
  return {
    returnId: 'ret-1', cancelledByEmail: null, feeReceivedByEmail: null, exchangeReleasedByEmail: null, feeWaived: false, feeSettledAmount: 0, ...overrides,
  };
}

describe('buildOrderHistory - 返品', () => {
  it('お店が作った返品は「返品を作った」の行を、作った時刻・作った人つきで出す', () => {
    const history = buildOrderHistory(input({ returns: [returnDetail()] }));

    expect(entriesOf(history.entries, 'return')).toEqual([{
      type: 'return', kind: 'created', id: 'created:ret-1', at: '2026-10-12T01:00:00.000Z', returnId: 'ret-1',
      title: '返品を作った（ORD-A1B2C3D4-R1）', details: [], actorEmail: 'admin@example.com',
    }]);
  });

  it('お客様の申し込みの返品（段2）には「返品を作った」の行を出さない（段2で申し込み・承認の行を足す）', () => {
    const history = buildOrderHistory(input({ returns: [returnDetail({ source: 'customer_request', status: 'requested' })] }));

    expect(entriesOf(history.entries, 'return')).toEqual([]);
  });

  it('返品の受け取りは、品の状態ごとの数を 在庫に戻す → 戻さない → お返し → 検品待ち の順に細目で出す。0点の状態は出さず、別の受け取りの数は混ぜない', () => {
    const returns = [returnDetail({
      receipts: [
        { id: 'rc-2', kind: 'receive', refundChoice: 'none', createdAt: '2026-10-12T03:00:00.000Z', actorEmail: 'admin@example.com' },
        { id: 'rc-1', kind: 'receive', refundChoice: 'now', createdAt: '2026-10-12T02:00:00.000Z', actorEmail: 'support@example.com' },
      ],
    })];
    const returnReceiptLines = [
      receiptLine('rc-1', 'sent_back', 1), receiptLine('rc-1', 'restocked', 1), receiptLine('rc-1', 'restocked', 1),
      receiptLine('rc-1', 'pending_inspection', 1), receiptLine('rc-1', 'not_restocked', 2),
      receiptLine('rc-2', 'restocked', 1),
    ];

    const history = buildOrderHistory(input({ returns, returnReceiptLines }));
    const receives = entriesOf(history.entries, 'return').filter((entry) => entry.kind === 'receive');

    expect(receives).toEqual([
      {
        type: 'return', kind: 'receive', id: 'receipt:rc-2', at: '2026-10-12T03:00:00.000Z', returnId: 'ret-1',
        title: '返品の受け取り（ORD-A1B2C3D4-R1）', details: ['在庫に戻す 1点'], actorEmail: 'admin@example.com',
      },
      {
        type: 'return', kind: 'receive', id: 'receipt:rc-1', at: '2026-10-12T02:00:00.000Z', returnId: 'ret-1',
        title: '返品の受け取り（ORD-A1B2C3D4-R1）',
        details: ['在庫に戻す 2点', '戻さない 2点', 'お返し 1点', '検品待ち 1点'],
        actorEmail: 'support@example.com',
      },
    ]);
  });

  it('「届かない」として終えた行は届かない数の合計、検品を終えた行・開き直した行は返品の番号を出す', () => {
    const returns = [returnDetail({
      receipts: [
        { id: 'rc-3', kind: 'reopen', refundChoice: null, createdAt: '2026-10-12T05:00:00.000Z', actorEmail: 'admin@example.com' },
        { id: 'rc-2', kind: 'inspect', refundChoice: null, createdAt: '2026-10-12T04:00:00.000Z', actorEmail: 'support@example.com' },
        { id: 'rc-1', kind: 'close_missing', refundChoice: null, createdAt: '2026-10-12T03:00:00.000Z', actorEmail: 'admin@example.com' },
      ],
    })];
    const returnReceiptLines = [
      receiptLine('rc-1', 'missing', 2), receiptLine('rc-1', 'missing', 1), receiptLine('rc-3', 'missing_reopened', 3),
    ];

    const history = buildOrderHistory(input({ returns, returnReceiptLines }));

    expect(entriesOf(history.entries, 'return').map((entry) => [entry.kind, entry.title, entry.actorEmail])).toEqual([
      ['reopen', '返品を開き直した（ORD-A1B2C3D4-R1）', 'admin@example.com'],
      ['inspect', '検品を終えた（ORD-A1B2C3D4-R1）', 'support@example.com'],
      ['close_missing', '「届かない」として返品を終えた（ORD-A1B2C3D4-R1・3点）', 'admin@example.com'],
      ['created', '返品を作った（ORD-A1B2C3D4-R1）', 'admin@example.com'],
    ]);
  });

  // 返金額が0円になって返金の記録を作らなかった数は、受け取りの行 refund_waived で残る（本計画 P20）
  it('返金しないで終えた行: 受け取りの中で返金しなかった数は、受け取りの行と別に足して同じ時刻なら受け取りの上に置く。額を決めて返金で0にした受け取り（waive_refund）も出す', () => {
    const returns = [returnDetail({
      receipts: [
        { id: 'rc-2', kind: 'waive_refund', refundChoice: null, createdAt: '2026-10-12T04:00:00.000Z', actorEmail: 'admin@example.com' },
        { id: 'rc-1', kind: 'receive', refundChoice: 'now', createdAt: '2026-10-12T02:00:00.000Z', actorEmail: 'admin@example.com' },
      ],
    })];
    const returnReceiptLines = [
      receiptLine('rc-1', 'restocked', 2), receiptLine('rc-1', 'refund_waived', 2), receiptLine('rc-2', 'refund_waived', 1),
    ];

    const history = buildOrderHistory(input({ returns, returnReceiptLines }));

    expect(entriesOf(history.entries, 'return').map((entry) => [entry.kind, entry.id, entry.title, entry.details])).toEqual([
      ['refund_waived', 'waived:rc-2', '返金しないで終えた（ORD-A1B2C3D4-R1・1点）', []],
      ['refund_waived', 'waived:rc-1', '返金しないで終えた（ORD-A1B2C3D4-R1・2点）', []],
      ['receive', 'receipt:rc-1', '返品の受け取り（ORD-A1B2C3D4-R1）', ['在庫に戻す 2点']],
      ['created', 'created:ret-1', '返品を作った（ORD-A1B2C3D4-R1）', []],
    ]);
    expect(entriesOf(history.entries, 'return')[0]).toMatchObject({ actorEmail: 'admin@example.com', returnId: 'ret-1' });
  });

  it('返金しなかった数の無い受け取りには「返金しないで終えた」の行を足さない', () => {
    const returns = [returnDetail({
      receipts: [{ id: 'rc-1', kind: 'receive', refundChoice: 'now', createdAt: '2026-10-12T02:00:00.000Z', actorEmail: 'admin@example.com' }],
    })];

    const history = buildOrderHistory(input({ returns, returnReceiptLines: [receiptLine('rc-1', 'restocked', 1)] }));

    expect(entriesOf(history.entries, 'return').map((entry) => entry.kind)).toEqual(['receive', 'created']);
  });

  it('返品の取り消しの行は、取り消した時刻と、窓口が引いた取り消した人で出す。した人が分からなければ null', () => {
    const cancelled = returnDetail({ status: 'cancelled', cancelledAt: '2026-10-12T02:00:00.000Z' });
    const history = buildOrderHistory(input({
      returns: [cancelled],
      returnRecords: [returnRecord({ cancelledByEmail: 'support@example.com' })],
    }));

    expect(entriesOf(history.entries, 'return')[0]).toEqual({
      type: 'return', kind: 'cancel', id: 'cancel:ret-1', at: '2026-10-12T02:00:00.000Z', returnId: 'ret-1',
      title: '返品を取り消した（ORD-A1B2C3D4-R1）', details: [], actorEmail: 'support@example.com',
    });
    expect(entriesOf(buildOrderHistory(input({ returns: [cancelled] })).entries, 'return')[0]).toMatchObject({
      kind: 'cancel', actorEmail: null,
    });
  });

  it('手数料の受け取りの行は金額を全角の ￥ と桁区切りで、支払いを待たずに送れるようにした行は返品の番号を出す。どちらも窓口が引いたした人を出す', () => {
    const history = buildOrderHistory(input({
      returns: [returnDetail({
        fees: { feeDueAmount: 0, feeReceivedAt: '2026-10-12T06:00:00.000Z', exchangeReleasedAt: '2026-10-12T05:00:00.000Z' },
      })],
      returnRecords: [returnRecord({ feeReceivedByEmail: 'admin@example.com', feeSettledAmount: 1_500, exchangeReleasedByEmail: 'owner@example.com' })],
    }));
    const [fee, release] = entriesOf(history.entries, 'return');

    expect(fee).toEqual({
      type: 'return', kind: 'fee_received', id: 'fee:ret-1', at: '2026-10-12T06:00:00.000Z', returnId: 'ret-1',
      title: '手数料の受け取りを記録した（￥1,500）', details: [], actorEmail: 'admin@example.com',
    });
    // 金額の書き方は E-2 の formatYen と同じ（半角の ¥ ではなく、全角の ￥）
    expect(fee.title.charCodeAt(fee.title.indexOf('（') + 1)).toBe(0xffe5);
    expect(release).toEqual({
      type: 'return', kind: 'exchange_released', id: 'release:ret-1', at: '2026-10-12T05:00:00.000Z', returnId: 'ret-1',
      title: '支払いを待たずに送れるようにした（ORD-A1B2C3D4-R1）', details: [], actorEmail: 'owner@example.com',
    });
  });

  // 手数料をいただかないことにした返品（order_returns.fee_waived。本計画 P27）。受け取りの記録と同じ列 fee_received_at・fee_received_by が入り、
  // 額は決着で fee_settled_amount に移して fee_due_amount を0にする（Task 3 の I-2）。fee_waived は返品の一覧に無いので、窓口が order_returns から直に引いて渡す
  it('手数料をいただかないことにした返品（feeWaived）の行は「手数料をいただかないことにした（￥n）」と出す。額はいただくはずだった額、した人は記録した人。印が偽・記録が無い時は受け取りの言葉', () => {
    const returns = [returnDetail({ fees: { feeDueAmount: 0, feeReceivedAt: '2026-10-12T06:00:00.000Z' } })];

    const waived = buildOrderHistory(input({
      returns, returnRecords: [returnRecord({ feeReceivedByEmail: 'admin@example.com', feeSettledAmount: 1_500, feeWaived: true })],
    }));
    const received = buildOrderHistory(input({
      returns, returnRecords: [returnRecord({ feeReceivedByEmail: 'admin@example.com', feeSettledAmount: 1_500, feeWaived: false })],
    }));

    expect(entriesOf(waived.entries, 'return')[0]).toEqual({
      type: 'return', kind: 'fee_received', id: 'fee:ret-1', at: '2026-10-12T06:00:00.000Z', returnId: 'ret-1',
      title: '手数料をいただかないことにした（￥1,500）', details: [], actorEmail: 'admin@example.com',
    });
    expect(entriesOf(received.entries, 'return')[0]).toMatchObject({
      kind: 'fee_received', title: '手数料の受け取りを記録した（￥1,500）', actorEmail: 'admin@example.com',
    });
    // 窓口が返品の記録を引けなかった時は、いただかないことにした印が分からないので、受け取りの言葉のまま（した人は null）
    expect(entriesOf(buildOrderHistory(input({ returns })).entries, 'return')[0]).toMatchObject({
      kind: 'fee_received', title: '手数料の受け取りを記録した（￥0）', actorEmail: null,
    });
  });

  it('返品の交換で足した交換の品の行は「交換の品を足した」の行を、足した時刻と、同じ時刻の受け取りをした人で出す。返品の番号は持たない', () => {
    const addedAt = '2026-10-12T02:00:00.000Z';
    const exchangeLine: OrderHistoryLine = {
      orderItemId: EXCHANGE_LINE, name: 'シルクブラウス（黒 / L）', shipped: 0, completed: 2, exchange: { quantity: 2, createdAt: addedAt },
    };
    const history = buildOrderHistory(input({
      lines: [...LINES, exchangeLine],
      returns: [returnDetail({
        receipts: [{ id: 'rc-1', kind: 'receive', refundChoice: 'none', createdAt: addedAt, actorEmail: 'support@example.com' }],
        exchangeItems: [{
          orderItemId: EXCHANGE_LINE, itemName: 'シルクブラウス', color: '黒', size: 'L', quantity: 2, fulfillmentType: 'stock', shipped: 0,
        }],
      })],
    }));

    expect(entriesOf(history.entries, 'return').find((entry) => entry.kind === 'exchange_added')).toEqual({
      type: 'return', kind: 'exchange_added', id: `exchange:${EXCHANGE_LINE}`, at: addedAt, returnId: null,
      title: '交換の品を足した（シルクブラウス（黒 / L） × 2）', details: [], actorEmail: 'support@example.com',
    });
    // その品を持つ返品が一覧に無い時は、足した人は null
    expect(entriesOf(buildOrderHistory(input({ lines: [...LINES, exchangeLine] })).entries, 'return')[0]).toMatchObject({
      kind: 'exchange_added', actorEmail: null,
    });
  });

  it('返品の返金の行の「どこから」は 返品（番号）。返品の番号が引けない返金は 返品 だけ。ほかの道は今のまま', () => {
    const history = buildOrderHistory(input({
      returns: [returnDetail({ refunds: [{ id: 'r-ret', amount: 4_000, status: 'succeeded', createdAt: REFUND_CREATED_AT }] })],
      refunds: [
        refund({ refundId: 'r-ret', source: 'return', lines: [refundLine({ restockType: 'return', beforeShipment: false })] }),
        refund({ refundId: 'r-unknown', source: 'return', createdAt: '2026-10-11T00:00:00.000Z', lines: [] }),
        refund({ refundId: 'r-admin', createdAt: '2026-10-10T00:00:00.000Z' }),
      ],
      lines: LINES,
    }));

    expect(entriesOf(history.entries, 'refund').map((entry) => [entry.refundId, entry.source, entry.sourceLabel])).toEqual([
      ['r-ret', 'return', '返品（ORD-A1B2C3D4-R1）'],
      ['r-unknown', 'return', '返品'],
      ['r-admin', 'admin', '管理画面'],
    ]);
  });

  it('同じ時刻の行は、結果が上に来る順に置く: メール → 状態 → 交換の品を足した → 返金 → 返品の受け取り', () => {
    const at = '2026-10-12T02:00:00.000Z';
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: at, fromStatus: 'shipped', toStatus: 'paid', changeReason: 'return_exchange_added',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
      emailRows: [email({ kind: 'refund', refundId: 'r-ret', createdAt: at })],
      refunds: [refund({ refundId: 'r-ret', source: 'return', createdAt: at, acceptedAt: at, succeededAt: at, lines: [] })],
      returns: [returnDetail({
        receipts: [{ id: 'rc-1', kind: 'receive', refundChoice: 'now', createdAt: at, actorEmail: 'admin@example.com' }],
        refunds: [{ id: 'r-ret', amount: 5_000, status: 'succeeded', createdAt: at }],
      })],
      returnReceiptLines: [receiptLine('rc-1', 'restocked', 1)],
      lines: [
        ...LINES,
        { orderItemId: EXCHANGE_LINE, name: 'シルクブラウス（黒 / L）', shipped: 0, completed: 1, exchange: { quantity: 1, createdAt: at } },
      ],
    }));

    expect(history.entries.map((entry) => (entry.type === 'return' ? `return:${entry.kind}` : entry.type))).toEqual([
      'email', 'status', 'return:exchange_added', 'refund', 'return:receive', 'return:created', 'created',
    ]);
  });

  it('決着の後に新しい手数料が付いて受け取りの時刻が空なら、決着済み額が残っていても手数料の行を出さない', () => {
    const history = buildOrderHistory(input({
      returns: [returnDetail({ fees: { feeDueAmount: 800, feeReceivedAt: null } })],
      returnRecords: [returnRecord({ feeSettledAmount: 1_500 })],
    }));

    expect(entriesOf(history.entries, 'return').map((entry) => entry.kind)).toEqual(['created']);
  });

});
