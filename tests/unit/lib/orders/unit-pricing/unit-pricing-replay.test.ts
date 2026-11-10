/** @jest-environment node */

// 結果が分からず同じ requestKey で送り直した時（FREQ-642 Review Focus）。着の状態がもう動いていて計画が作れなくても、
// 計画なしで DB を呼び、送り直しなら DB が前の結果を答える。計画の計算（planUnitEvent）と入口の流れは本物を通す
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  listOrderReturns: jest.fn(),
  loadReturnCreateMaterials: jest.fn(),
}));
jest.mock('@/lib/orders/refund/refund-materials', () => ({ loadRefundMaterials: jest.fn() }));
jest.mock('@/lib/orders/email/order-email-schedule', () => ({ scheduleOrderEmailDelivery: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));

import type Stripe from 'stripe';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import { submitAdminRefund, type RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import { listOrderReturns } from '@/lib/orders/returns/return-store';
import { receiveReturnAndRefund, refundReturnAndRequestStripe } from '@/lib/orders/returns/return-service';
import type { UnitPricingMaterials } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { returnDetail } from '../returns/order-return-detail-fixture';
import { buildOrder, JACKET, materialsOf, repeat, repeatDefinition } from './fixtures';

const mockList = listOrderReturns as jest.MockedFunction<typeof listOrderReturns>;
const mockRefundMaterials = loadRefundMaterials as jest.MockedFunction<typeof loadRefundMaterials>;

const RETURN_ID = 'ret-1';
const RELEASE_ID = 'rel-1';

type Answer = { data: unknown; error: { message: string } | null };

/** 名前ごとの答えの列を返す rpc と、orders の表だけの from */
function depsWith(materials: UnitPricingMaterials, answers: Record<string, Answer[]>) {
  const rpc = jest.fn(async (name: string) => {
    if (name === 'order_unit_pricing_materials') return { data: materials, error: null };
    const queue = answers[name];
    return (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? { data: [], error: null };
  });
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data: { order_id: 'order-r', payment_intent_id: 'pi_1', shipping_email: 'a@example.com' }, error: null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const schedule = jest.fn();
  const deps = {
    store: { rpc, from: jest.fn(() => query) },
    stripe: {} as unknown as Stripe,
    now: () => new Date('2026-11-20T00:00:00Z'),
    notifyShopOfRefundFailure: jest.fn(),
    scheduleOrderEmailDelivery: schedule,
  } as unknown as RefundServiceDeps;
  return { deps, rpc };
}

/** 返す着がもう返された注文（送り直しの時の材料） */
function returnedOrder(side: 'returned_customer' | 'returned_shop', shipped = true): UnitPricingMaterials {
  const m = materialsOf(buildOrder({
    orderId: 'order-r', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 2 }],
    definitions: [repeatDefinition()], shipped,
  }));
  return { ...m, target: { ...m.target, slots: m.target.slots.map(s => ({ ...s, state: side, currentPrice: 0 })) } };
}

const pendingRef = (id: string) => ({
  data: [{ refund_id: id, order_id: 'order-r', source: 'unit_hold_release', status: 'pending', amount: 3000, payment_intent_id: 'pi_1', created_at: '2026-11-19T23:50:00Z' }],
  error: null,
});

const RECEIVE_INPUT = {
  returnId: RETURN_ID, actorId: 'actor', actorCanRefund: true, requestKey: 'k',
  units: [{ returnLineId: 'l1', disposition: 'restocked' as const, quantity: 1 }], exchangeOverrides: [],
  refundChoice: 'consult' as const, refundAmount: null, refundShippingAmount: 0, note: null, notifyCustomer: false,
  sentBackMessage: null, sentBackCarrier: null, sentBackTrackingNumber: null,
};
const LINE = {
  id: 'l1', fulfillmentId: 'f1', fulfillmentNumber: 1, orderItemId: 'oi-1', quantity: 1, reason: 'size_too_small', resolution: 'refund',
  exchange: null, refundAmountsByCount: [5000], receiveRefundAmountsByCount: null, progress: {},
} as never;

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [LINE] })]);
  mockRefundMaterials.mockResolvedValue({
    order: { refundableAmount: 37000 }, lines: [{ orderItemId: 'oi-1', unshipped: 1, shipped: 1, availableUnitAmounts: [20000] }], awaitingRefund: null,
  } as never);
});

describe('FREQ-642-AC-17: 同じ requestKey の送り直しは、着がもう動いていても DB が前の結果を答える', () => {
  const REPLAYED_ROW = {
    receipt_id: 'rc', return_status: 'open', refund_id: null, refund_amount: null, refund_status: null,
    exchange_order_item_ids: [], fee_due_amount: 0, shop_notice_enqueued: false, replayed: true, release_refund_ids: [RELEASE_ID],
  };

  test.each(['returned_customer', 'returned_shop'] as const)('受け取り（枠が %s）: 計画は作れないが、計画なしで入口を呼び、前の結果と戻しの返金の依頼を返す', async (state) => {
    const { deps, rpc } = depsWith(returnedOrder(state), {
      admin_receive_return: [{ data: [REPLAYED_ROW], error: null }],
      get_order_refund: [pendingRef(RELEASE_ID)],
    });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({ kind: 'received', receiptId: 'rc', replayed: true });

    expect(rpc).toHaveBeenCalledWith('admin_receive_return', expect.objectContaining({ _pricing: null }));
    expect(rpc).toHaveBeenCalledWith('get_order_refund', { _refund_id: RELEASE_ID });
  });

  test('戻しの返金は、主の処理の途中で投げても頼む（頼まないと返事待ちのまま残る）', async () => {
    const { deps, rpc } = depsWith(repeat(), {
      admin_receive_return: [{ data: [{ ...REPLAYED_ROW, replayed: false, shop_notice_enqueued: true }], error: null }],
      get_order_refund: [pendingRef(RELEASE_ID)],
    });
    (deps.scheduleOrderEmailDelivery as jest.Mock).mockImplementation(() => { throw new Error('boom'); });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).rejects.toThrow('boom');

    expect(rpc).toHaveBeenCalledWith('get_order_refund', { _refund_id: RELEASE_ID });
  });

  test('戻しの返金が見つからない・確かめられない時は、記録を残す（ログ）。主の答えは変えない', async () => {
    const { deps } = depsWith(repeat(), {
      admin_receive_return: [{ data: [REPLAYED_ROW], error: null }],
      get_order_refund: [{ data: [], error: null }],
    });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({ kind: 'received' });
    expect(console.error).toHaveBeenCalledWith('[refund] the release refund was not found', RELEASE_ID);
  });

  test('受け取り: 送り直しでなければ DB が UNIT_PRICING_REQUIRED で断り、計画の断りと同じ UNIT_PRICING_INVALID の409に戻る', async () => {
    const { deps } = depsWith(returnedOrder('returned_customer'), {
      admin_receive_return: [{ data: null, error: { message: 'UNIT_PRICING_REQUIRED' } }],
    });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({ kind: 'refused', code: 'UNIT_PRICING_INVALID' });
  });

  test('受け取り: 計画を作れて DB が REQUIRED で断った時（計画の誤りでない）は、そのまま UNIT_PRICING_REQUIRED', async () => {
    const { deps } = depsWith(repeat(), { admin_receive_return: [{ data: null, error: { message: 'UNIT_PRICING_REQUIRED' } }] });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({ kind: 'refused', code: 'UNIT_PRICING_REQUIRED' });
  });

  /** 計画の計算が snapshot_invalid（E の食い違い）で断る材料 */
  const brokenOrder = (): UnitPricingMaterials => {
    const m = repeat();
    return { ...m, target: { ...m.target, entitlementPrevious: 999 } };
  };

  test('受け取り: 着が動いたのでない計画の誤り（snapshot_invalid）は、計画なしで DB を呼ばずに断る', async () => {
    const { deps, rpc } = depsWith(brokenOrder(), { admin_receive_return: [{ data: [REPLAYED_ROW], error: null }] });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({ kind: 'refused', code: 'UNIT_PRICING_INVALID' });
    expect(rpc).not.toHaveBeenCalledWith('admin_receive_return', expect.anything());
  });

  test('発送前の返金: snapshot_invalid も DB を呼ばずに断る', async () => {
    const m = brokenOrder();
    const { deps, rpc } = depsWith({ ...m, target: { ...m.target, slots: m.target.slots.map(s => ({ ...s, shipped: false })) } }, {
      begin_order_refund: [{ data: [{ refund_id: 'rf', amount: 5000, status: 'pending', replayed: true }], error: null }],
    });
    mockRefundMaterials.mockResolvedValue({
      order: { refundableAmount: 37000 }, lines: [{ orderItemId: 'oi-1', unshipped: 2, shipped: 0, availableUnitAmounts: [17000, 20000] }], awaitingRefund: null,
    } as never);

    await expect(submitAdminRefund(deps, ADMIN)).resolves.toEqual({ kind: 'refused', code: 'unit_pricing_invalid' });
    expect(rpc).not.toHaveBeenCalledWith('begin_order_refund', expect.anything());
  });

  test('相談の返金: 計画の誤りは断り、admin_refund_return を呼ばない（呼ぶと戻す返金が黙って落ちる）', async () => {
    const { deps, rpc } = depsWith(brokenOrder(), { admin_refund_return: [{ data: [{ refund_id: null, amount: 0, status: 'waived', replayed: false }], error: null }] });
    const input = { returnId: RETURN_ID, actorId: 'actor', requestKey: 'k', amount: null, shippingAmount: 0, note: null, notifyCustomer: false };

    await expect(refundReturnAndRequestStripe(deps, input)).resolves.toEqual({ kind: 'refused', code: 'UNIT_PRICING_INVALID' });
    expect(rpc).not.toHaveBeenCalledWith('admin_refund_return', expect.anything());
  });

  const REFUND_REQUEST = {
    requestKey: 'k', lines: [{ orderItemId: 'oi-1', quantity: 1, beforeShipment: true }], restock: true, shippingAmount: 0, amount: 5000,
    note: null, stripeReason: 'requested_by_customer' as const, notifyCustomer: false,
  };
  const ADMIN = { orderId: 'order-r', actorId: 'actor', request: REFUND_REQUEST };

  test.each(['returned_customer', 'returned_shop'] as const)('発送前の返金（枠が %s）: 計画なしで入口を呼び、送り直しの結果と戻しの返金の依頼を返す', async (state) => {
    const { deps, rpc } = depsWith(returnedOrder(state, false), {
      begin_order_refund: [{ data: [{ refund_id: 'rf', amount: 5000, status: 'pending', replayed: true, release_refund_ids: [RELEASE_ID] }], error: null }],
      get_order_refund: [
        { data: [{ refund_id: 'rf', order_id: 'order-r', source: 'admin', status: 'pending', amount: 5000, payment_intent_id: 'pi_1', created_at: '2026-11-19T23:50:00Z' }], error: null },
        pendingRef(RELEASE_ID),
      ],
    });

    await expect(submitAdminRefund(deps, ADMIN)).resolves.toMatchObject({ kind: 'accepted', refundId: 'rf', replayed: true });

    expect(rpc).toHaveBeenCalledWith('begin_order_refund', expect.objectContaining({ _pricing: null }));
    expect(rpc).toHaveBeenCalledWith('get_order_refund', { _refund_id: RELEASE_ID });
  });

  test('発送前の返金: 送り直しでなければ UNIT_PRICING_REQUIRED を unit_pricing_invalid の断りに戻す', async () => {
    const { deps } = depsWith(returnedOrder('returned_customer', false), {
      begin_order_refund: [{ data: null, error: { message: 'UNIT_PRICING_REQUIRED' } }],
    });

    await expect(submitAdminRefund(deps, ADMIN)).resolves.toEqual({ kind: 'refused', code: 'unit_pricing_invalid' });
  });
});
