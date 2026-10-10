import {
  buildOrderHistory,
  type BuildOrderHistoryInput,
  type OrderEmailHistoryRow,
  type OrderHistoryEntry,
  type OrderHistoryLine,
} from '@/lib/orders/email/order-history';
import type { OrderCompletionHistoryRow, OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';

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
    finishedAt: '2026-10-09T01:00:05.000Z', hasBody: true, bodyErased: false, fulfillmentId: null, fulfillmentNumber: null, ...overrides,
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

function input(overrides: Partial<BuildOrderHistoryInput> = {}): BuildOrderHistoryInput {
  return { order: ORDER, statusRows: [], emailRows: [], sendState: NOT_PAUSED, fulfillments: [], completions: [], lines: [], ...overrides };
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
