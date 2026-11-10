/** @jest-environment node */

// 値段の計画をサーバーで作る部分（FREQ-642。設計書 7章）。DB の関数は rpc の差し替え、返品の中身・返金の材料は読み出しの差し替えで与え、
// 計画の計算（planUnitEvent）と材料の読み出し（unit-pricing-store.ts）は本物を通す
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  listOrderReturns: jest.fn(),
  loadReturnCreateMaterials: jest.fn(),
}));
jest.mock('@/lib/orders/refund/refund-materials', () => ({ loadRefundMaterials: jest.fn() }));

import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import { RefundOperationError } from '@/lib/orders/refund/refund-store';
import type { RefundMaterials } from '@/lib/orders/refund/refund-types';
import {
  ReturnStoreError, listOrderReturns, loadReturnCreateMaterials, receiveReturn,
} from '@/lib/orders/returns/return-store';
import type { OrderReturnLineDetail, ReceiveReturnRequest, ReturnCreateMaterials } from '@/lib/orders/returns/return-types';
import {
  estimateCustomerReturn, estimateReturnReceive, planOrderCancel, planOrderRefund, planReturnReceive, planReturnRefund,
  withFreshPricing, type PricingClient,
} from '@/lib/orders/unit-pricing/unit-pricing-service';
import type { UnitPricingMaterials } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { returnDetail } from '../returns/order-return-detail-fixture';
import { buildOrder, JACKET, materialsOf, pairSet, repeat, repeatDefinition, twoOrders } from './fixtures';

const mockList = listOrderReturns as jest.MockedFunction<typeof listOrderReturns>;
const mockCreateMaterials = loadReturnCreateMaterials as jest.MockedFunction<typeof loadReturnCreateMaterials>;
const mockRefundMaterials = loadRefundMaterials as jest.MockedFunction<typeof loadRefundMaterials>;

const RETURN_ID = 'ret-1';
const ORDER_ID = 'order-r';

type RpcAnswer = { data: unknown; error: { message: string } | null };

/** rpc と from('order_returns') だけを持つ入れ物。材料の関数の答えと、入口の答えの列を決める */
function clientWith(options: { materials: UnitPricingMaterials | null; entry?: RpcAnswer[]; orderId?: string }) {
  const entry = [...(options.entry ?? [])];
  const rpc = jest.fn(async (name: string) => {
    if (name === 'order_unit_pricing_materials') return { data: options.materials, error: null };
    return entry.shift() ?? { data: [], error: null };
  });
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data: { order_id: options.orderId ?? ORDER_ID }, error: null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const from = jest.fn(() => query);
  return { client: { rpc, from } as unknown as PricingClient, rpc, from };
}

function line(overrides: Partial<OrderReturnLineDetail> = {}): OrderReturnLineDetail {
  return {
    id: 'l1', fulfillmentId: 'f1', fulfillmentNumber: 1, orderItemId: 'oi-1', itemName: 'ジャケット', color: null, size: null,
    quantity: 1, reason: 'size_too_small', reasonNote: null, resolution: 'refund', exchange: null,
    progress: {
      restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0, processed: 0, unprocessed: 1,
      exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    },
    refundAmountsByCount: [5000, 11000], receiveRefundAmountsByCount: null, refundWaitingAmount: 0,
    customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
    ...overrides,
  };
}

function refundMaterialsOf(refundableAmount: number, lines: RefundMaterials['lines'] = []): RefundMaterials {
  return {
    order: {
      id: ORDER_ID, orderNumber: 'A', status: 'shipped', paymentMethod: 'card', totalAmount: 37000, shippingAmount: 0, discountAmount: 0,
      paidAmount: 37000, succeededAmount: 37000, openAmount: 0, refundableAmount, refundedShipping: 0, refundableShipping: 0,
      shippedTotal: 2, unshippedTotal: 0,
    },
    lines, awaitingRefund: null,
  };
}

const BODY: Pick<ReceiveReturnRequest, 'units' | 'exchangeOverrides' | 'refundChoice' | 'refundShippingAmount'> = {
  units: [{ returnLineId: 'l1', disposition: 'restocked', quantity: 1 }],
  exchangeOverrides: [],
  refundChoice: 'now',
  refundShippingAmount: 0,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line()] })]);
  mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000));
});

describe('DD-ADMIN-022: 受け取りの値段の計画と見込み', () => {
  test('DD-ADMIN-022: 受け取りの見込みは計画の今すぐの額から返送料を引いた額', async () => {
    const { client } = clientWith({ materials: repeat() });

    const plain = await planReturnReceive(client, RETURN_ID, BODY);
    expect(plain.plan?.kind).toBe('return_receive');
    expect(plain.estimate).toMatchObject({ legacy: false, standardRefund: 17000, nowRefund: 17000, refundAmount: 17000 });

    // お店の送り状の返送料 800円は最初の受け取りだけ、E の外で引く。上限は今すぐの額（送料の返金を足す）と注文の返せる額の小さい方
    mockList.mockResolvedValue([returnDetail({
      id: RETURN_ID, returnMethod: 'shop_label', fees: { returnShippingFee: 800 }, lines: [line()],
    })]);
    const withFee = await planReturnReceive(client, RETURN_ID, { ...BODY, refundShippingAmount: 300 });
    expect(withFee.estimate).toMatchObject({ fixedFees: 800, refundAmount: 17000 - 800 + 300, refundCap: 17000 + 300 });
  });

  test('DD-ADMIN-022: 受け取りの窓口は本文の額で計画を変えず、店長の額は今の欄だけ', async () => {
    const { client } = clientWith({ materials: repeat() });
    const body = { ...BODY, refundAmount: 1, refundShippingAmount: 0 } as typeof BODY & { refundAmount: number };

    const { plan, estimate } = await planReturnReceive(client, RETURN_ID, body);

    expect(plan?.standardRefund).toBe(17000);
    expect(estimate.refundAmount).toBe(17000);
  });

  test('DD-ADMIN-022: 返金の品が無い受け取り（交換だけ）の見込みは 0円', async () => {
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line({ resolution: 'exchange' })] })]);
    const { client } = clientWith({ materials: repeat() });

    const { plan, estimate } = await planReturnReceive(client, RETURN_ID, { ...BODY, refundChoice: 'none' });

    expect(plan?.lines.filter(l => l.lineKind === 'returned')).toEqual([]);
    expect(estimate).toMatchObject({ legacy: false, standardRefund: 0, nowRefund: 0, refundAmount: 0, refundCap: 0 });
  });

  test('FREQ-642-AC-20: 写しの無い注文は今の見込みと同じ値で legacy（計画は作らない）', async () => {
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, fees: { restockingFeePercent: 10 }, lines: [line()] })]);
    const { client } = clientWith({ materials: null });

    const { plan, estimate } = await planReturnReceive(client, RETURN_ID, BODY);

    expect(plan).toBeNull();
    // 今の計算 computePerItemReturnRefundPreview: 商品の額 5,000円、手数料 10% は 500円
    expect(estimate).toEqual({
      legacy: true, standardRefund: 5000, nowRefund: 5000, consultRefund: 0, feeAmount: 500, fixedFees: 0, refundAmount: 4500, refundCap: 5000,
    });
  });

  test('FREQ-642-AC-26: 交換の頼みを店が返金に変えた行は shop の扱いで、リピートの例 17,000円', async () => {
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line({ resolution: 'exchange', reason: 'size_too_small' })] })]);
    const { client } = clientWith({ materials: repeat() });

    const { plan } = await planReturnReceive(client, RETURN_ID, { ...BODY, exchangeOverrides: [{ returnLineId: 'l1', action: 'refund' }] });

    expect(plan?.treatments).toEqual([{ returnLineId: 'l1', treatment: 'shop' }]);
    expect(plan?.standardRefund).toBe(17000);
  });

  test.each([
    ['defective', 'shop'], ['wrong_item', 'shop'], ['size_too_small', 'customer'], ['not_as_described', 'customer'], ['unwanted', 'customer'],
  ] as const)('FREQ-642-AC-26: 理由 %s の返金の行の初めの割引の扱いは %s', async (reason, side) => {
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line({ reason })] })]);
    const { client } = clientWith({ materials: repeat() });

    const { plan } = await planReturnReceive(client, RETURN_ID, BODY);

    expect(plan?.treatments).toEqual([{ returnLineId: 'l1', treatment: side }]);
  });

  test('FREQ-642-AC-25: 店長が直した割引の扱いが計画に入り、見込みが変わる（例13: 不良 17,000円 / ご都合 15,500円）', async () => {
    const { client } = clientWith({ materials: pairSet() });
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line({ orderItemId: 'oi-j', reason: 'defective' })] })]);

    const asShop = await planReturnReceive(client, RETURN_ID, BODY);
    const asCustomer = await planReturnReceive(client, RETURN_ID, { ...BODY, treatments: [{ returnLineId: 'l1', treatment: 'customer' }] });

    expect(asShop.plan?.treatments).toEqual([{ returnLineId: 'l1', treatment: 'shop' }]);
    expect(asCustomer.plan?.treatments).toEqual([{ returnLineId: 'l1', treatment: 'customer' }]);
    expect(asShop.estimate.standardRefund).toBe(17000);
    expect(asCustomer.estimate.standardRefund).toBe(15500);
  });

  test('FREQ-642-AC-25: 割引の扱いを理由からの初めの値から変えられるのは返金の権限を持つ人だけ', async () => {
    const { client } = clientWith({ materials: repeat() });

    await expect(planReturnReceive(client, RETURN_ID, { ...BODY, treatments: [{ returnLineId: 'l1', treatment: 'shop' }] }, { canRefund: false }))
      .rejects.toMatchObject({ name: 'ReturnStoreError', code: 'RETURN_FORBIDDEN' });
    // 初めの値と同じ扱いを送るだけなら、持たない人も通る
    await expect(planReturnReceive(client, RETURN_ID, { ...BODY, treatments: [{ returnLineId: 'l1', treatment: 'customer' }] }, { canRefund: false }))
      .resolves.toMatchObject({ plan: { treatments: [{ returnLineId: 'l1', treatment: 'customer' }] } });
  });

  test('DD-ADMIN-022: 交換に結ぶ枠（いちばん安い着）は返金の枠の選びから除く（DB の交換の結びの順）', async () => {
    const lx = line({ id: 'lx', resolution: 'exchange', fulfillmentNumber: 1 });
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [lx, line({ id: 'l1', fulfillmentNumber: 2 })] })]);
    const { client } = clientWith({ materials: repeat() });

    const { plan } = await planReturnReceive(client, RETURN_ID, {
      ...BODY,
      units: [{ returnLineId: 'lx', disposition: 'restocked', quantity: 1 }, { returnLineId: 'l1', disposition: 'restocked', quantity: 1 }],
    });

    // 交換の1着が安い着（unit 1。17,000円）に結ばれるので、返す着は残りの unit 0 になる
    const returned = plan?.lines.filter(l => l.lineKind === 'returned') ?? [];
    expect(returned.map(l => l.unitIndex)).toEqual([0]);
  });

  test('DD-ADMIN-022: 交換に結ぶ枠は、返品の行に結び付いた枠（claimedReturnLineId）が先。安い枠より優先する', async () => {
    const m = repeat();
    const bound = { ...m, target: { ...m.target, slots: m.target.slots.map(s => (s.unitIndex === 0 ? { ...s, claimedReturnLineId: 'lx' } : s)) } };
    const lx = line({ id: 'lx', resolution: 'exchange', fulfillmentNumber: 1 });
    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [lx, line({ id: 'l1', fulfillmentNumber: 2 })] })]);
    const { client } = clientWith({ materials: bound });

    const { plan } = await planReturnReceive(client, RETURN_ID, {
      ...BODY,
      units: [{ returnLineId: 'lx', disposition: 'restocked', quantity: 1 }, { returnLineId: 'l1', disposition: 'restocked', quantity: 1 }],
    });

    // 交換は結び付いた unit 0（20,000円）を取り、返す着は残りの unit 1
    expect((plan?.lines.filter(l => l.lineKind === 'returned') ?? []).map(l => l.unitIndex)).toEqual([1]);
  });

  test('DD-ADMIN-022: 最初の交換の受け取りは、交換の手数料と送料も固定の費用に入る（E の外）', async () => {
    const lx = line({ id: 'lx', resolution: 'exchange', fulfillmentNumber: 1 });
    mockList.mockResolvedValue([returnDetail({
      id: RETURN_ID, fees: { exchangeFee: 500, exchangeShippingFee: 300 }, lines: [lx, line({ id: 'l1', fulfillmentNumber: 2 })],
    })]);
    const { client } = clientWith({ materials: repeat() });
    const body = {
      ...BODY,
      units: [{ returnLineId: 'lx', disposition: 'restocked' as const, quantity: 1 }, { returnLineId: 'l1', disposition: 'restocked' as const, quantity: 1 }],
    };

    const first = await planReturnReceive(client, RETURN_ID, body);
    expect(first.estimate).toMatchObject({ fixedFees: 800, refundAmount: 17000 - 800 });

    mockList.mockResolvedValue([returnDetail({
      id: RETURN_ID, firstExchangeReceiptDone: true, fees: { exchangeFee: 500, exchangeShippingFee: 300 }, lines: [lx, line({ id: 'l1', fulfillmentNumber: 2 })],
    })]);
    expect((await planReturnReceive(client, RETURN_ID, body)).estimate.fixedFees).toBe(0);
  });

  describe('DD-ADMIN-022: お支払い待ち(feeDue)・相談に回る手数料(feePending)・固定の費用の内訳は DB の admin_receive_return と同じ', () => {
    const shopLabel = (returnShippingFee: number, extra: Record<string, unknown> = {}) => returnDetail({
      id: RETURN_ID, returnMethod: 'shop_label', fees: { returnShippingFee, exchangeFee: 500, exchangeShippingFee: 300 },
      lines: [line({ quantity: 2, progress: { ...line().progress, unprocessed: 2 } }), line({ id: 'lx', resolution: 'exchange', fulfillmentNumber: 2 })],
      ...extra,
    });

    test('今すぐだけ: 固定の費用が今すぐの額に収まれば待ちは 0、超えた分が feeDue（内訳は返送料）', async () => {
      const { client } = clientWith({ materials: repeat() });
      mockList.mockResolvedValue([shopLabel(800)]);
      const fits = await planReturnReceive(client, RETURN_ID, BODY);
      expect(fits.estimate).toMatchObject({ fixedFees: 800, fixedFeeParts: { returnShipping: 800, exchangeFee: 0, exchangeShipping: 0 }, feeDue: 0, feePending: 0 });

      mockList.mockResolvedValue([shopLabel(20000)]);
      const over = await planReturnReceive(client, RETURN_ID, BODY);
      expect(over.estimate).toMatchObject({ fixedFees: 20000, feeDue: 20000 - 17000, feePending: 0, refundAmount: 0 });
    });

    test('今すぐと相談が両方: 引ききれない分は feePending（feeDue は 0）', async () => {
      const { client } = clientWith({ materials: repeat() });
      mockList.mockResolvedValue([shopLabel(20000)]);
      const mixed = await planReturnReceive(client, RETURN_ID, {
        ...BODY,
        units: [{ returnLineId: 'l1', disposition: 'restocked', quantity: 1, refundChoice: 'now' }, { returnLineId: 'l1', disposition: 'restocked', quantity: 1, refundChoice: 'consult' }],
        refundChoice: 'mixed',
      });
      expect(mixed.estimate).toMatchObject({ fixedFees: 20000, feeDue: 0 });
      expect(mixed.estimate.feePending).toBe(20000 - (mixed.estimate.nowRefund ?? 0));
    });

    test('相談だけ: 固定の費用の全部が feePending（feeDue は 0）', async () => {
      const { client } = clientWith({ materials: repeat() });
      mockList.mockResolvedValue([shopLabel(800)]);
      const consult = await planReturnReceive(client, RETURN_ID, {
        ...BODY, units: [{ returnLineId: 'l1', disposition: 'restocked', quantity: 1, refundChoice: 'consult' }], refundChoice: 'consult',
      });
      expect(consult.estimate).toMatchObject({ fixedFees: 800, feeDue: 0, feePending: 800, refundAmount: 0 });
    });

    test('交換だけ: 固定の費用の全部が feeDue（返送料・交換の手数料・交換の送料の内訳）', async () => {
      const { client } = clientWith({ materials: repeat() });
      mockList.mockResolvedValue([shopLabel(800)]);
      const exchangeOnly = await planReturnReceive(client, RETURN_ID, {
        ...BODY, units: [{ returnLineId: 'lx', disposition: 'restocked', quantity: 1 }], refundChoice: 'none',
      });
      expect(exchangeOnly.estimate).toMatchObject({
        fixedFees: 1600, fixedFeeParts: { returnShipping: 800, exchangeFee: 500, exchangeShipping: 300 }, feeDue: 1600, feePending: 0,
      });
    });
  });

  test('DD-ADMIN-022: 返品が無い・計画の計算が断った時は、画面を開き直してもらう断り', async () => {
    const missing = clientWith({ materials: repeat() });
    mockList.mockResolvedValue([]);
    await expect(planReturnReceive(missing.client, RETURN_ID, BODY)).rejects.toMatchObject({ code: 'RETURN_NOT_FOUND' });

    mockList.mockResolvedValue([returnDetail({ id: RETURN_ID, lines: [line({ quantity: 3 })] })]);
    const { client } = clientWith({ materials: repeat() });
    await expect(planReturnReceive(client, RETURN_ID, { ...BODY, units: [{ returnLineId: 'l1', disposition: 'restocked', quantity: 3 }] }))
      .rejects.toMatchObject({ name: 'ReturnStoreError', code: 'UNIT_PRICING_INVALID' });
  });

  test('DD-ADMIN-022: 相談の残り（consultOutstanding）は相談の返金が付いた出来事を数えない', async () => {
    const { client } = clientWith({ materials: repeat() });
    const tables: Record<string, unknown[]> = {
      order_unit_events: [{ id: 'e1', consult_refund: 5000 }],
      order_unit_event_refunds: [{ event_id: 'e1', refund_id: 'r1' }],
      order_refunds: [{ id: 'r1', status: 'succeeded' }],
    };
    (client.from as jest.Mock).mockImplementation((table: string) => {
      const chain = {
        select: () => chain, eq: () => chain, gt: () => chain, in: () => chain,
        maybeSingle: async () => ({ data: { order_id: ORDER_ID }, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data: tables[table] ?? [], error: null }),
      };
      return chain;
    });

    const covered = await estimateReturnReceive(client, RETURN_ID, BODY);
    expect(covered.consultOutstanding).toBe(0);

    tables.order_refunds = [{ id: 'r1', status: 'failed' }];
    const failed = await estimateReturnReceive(client, RETURN_ID, BODY);
    expect(failed.consultOutstanding).toBe(5000);
  });
});

describe('DD-ADMIN-022: 版の食い違い（UNIT_PRICING_STALE）の作り直し', () => {
  const RECEIVE_INPUT = {
    returnId: RETURN_ID, actorId: 'actor', actorCanRefund: true, requestKey: 'k', units: BODY.units, exchangeOverrides: [],
    refundChoice: 'now' as const, refundAmount: null, refundShippingAmount: 0, note: null, notifyCustomer: false,
    sentBackMessage: null, sentBackCarrier: null, sentBackTrackingNumber: null,
  };
  const stale: RpcAnswer = { data: null, error: { message: 'UNIT_PRICING_STALE' } };
  const ok: RpcAnswer = { data: [{ receipt_id: 'rc', return_status: 'open', fee_due_amount: 0 }], error: null };

  const attempt = (client: PricingClient) => withFreshPricing(async () => {
    const { plan } = await planReturnReceive(client, RETURN_ID, BODY);
    return receiveReturn(client, { ...RECEIVE_INPUT, pricing: plan });
  });
  const names = (rpc: jest.Mock) => rpc.mock.calls.map(call => call[0]);

  test('DD-ADMIN-022: STALE の時だけ材料を読み直して1回作り直す', async () => {
    const { client, rpc } = clientWith({ materials: repeat(), entry: [stale, ok] });

    await expect(attempt(client)).resolves.toMatchObject({ receiptId: 'rc' });
    // 材料・入口・材料・入口
    expect(names(rpc)).toEqual([
      'order_unit_pricing_materials', 'admin_receive_return', 'order_unit_pricing_materials', 'admin_receive_return',
    ]);

    const twice = clientWith({ materials: repeat(), entry: [stale, stale, ok] });
    await expect(attempt(twice.client)).rejects.toMatchObject({ code: 'UNIT_PRICING_STALE' });
    expect(names(twice.rpc)).toHaveLength(4);
  });

  test('DD-ADMIN-022: STALE 以外の断りは作り直さない', async () => {
    const conflict: RpcAnswer = { data: null, error: { message: 'RETURN_STATE_CONFLICT' } };
    const { client, rpc } = clientWith({ materials: repeat(), entry: [conflict, ok] });

    await expect(attempt(client)).rejects.toMatchObject({ code: 'RETURN_STATE_CONFLICT' });
    expect(names(rpc)).toEqual(['order_unit_pricing_materials', 'admin_receive_return']);
  });

  test('DD-ADMIN-022: 断りを答えで返す入口（kind refused）の STALE も1回だけ作り直す', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ kind: 'refused', code: 'UNIT_PRICING_STALE' })
      .mockResolvedValueOnce({ kind: 'received' });
    await expect(withFreshPricing(run)).resolves.toEqual({ kind: 'received' });
    expect(run).toHaveBeenCalledTimes(2);

    const again = jest.fn().mockResolvedValue({ kind: 'refused', code: 'unit_pricing_stale' });
    await expect(withFreshPricing(again)).resolves.toEqual({ kind: 'refused', code: 'unit_pricing_stale' });
    expect(again).toHaveBeenCalledTimes(2);

    const other = jest.fn().mockResolvedValue({ kind: 'refused', code: 'RETURN_FORBIDDEN' });
    await withFreshPricing(other);
    expect(other).toHaveBeenCalledTimes(1);
    expect(new RefundOperationError('unit_pricing_stale')).toMatchObject({ code: 'unit_pricing_stale' });
  });
});

describe('DD-ADMIN-023: 注文の返金・取り消し・相談の返金の計画', () => {
  const shippedMaterials = (): RefundMaterials['lines'] => [{
    orderItemId: 'oi-1', name: 'ジャケット', color: null, size: null, fulfillmentType: 'stock', itemPrice: 20000, quantity: 2, lineTotal: 40000,
    shipped: 0, unshipped: 2, refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2, lineDiscount: 3000,
    refundedUnits: 0, availableUnitAmounts: [17000, 20000],
  }];
  const unshippedOrder = (): UnitPricingMaterials => materialsOf(buildOrder({
    orderId: ORDER_ID, lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 2 }],
    definitions: [repeatDefinition()], shipped: false,
  }));

  test('FREQ-642-AC-27: 発送前の品を選ぶ返金は計画を作り、標準の額は E の増えた分（例9 は 17,000円）', async () => {
    mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000, shippedMaterials()));
    const { client } = clientWith({ materials: unshippedOrder() });

    const { plan, estimate } = await planOrderRefund(client, ORDER_ID, {
      lines: [{ orderItemId: 'oi-1', quantity: 1, beforeShipment: true }], shippingAmount: 0,
    });

    expect(plan?.kind).toBe('pre_shipment_cancel');
    expect(plan?.standardRefund).toBe(17000);
    expect(estimate).toEqual({ legacy: false, suggestedAmount: 17000, itemsAmount: 17000, refundCap: 37000, changesUnits: true });
  });

  test('DD-ADMIN-023: 注文の取り消しは、まだ発送していない品を全部、発送前として取り消す計画', async () => {
    mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000, shippedMaterials()));
    const { client } = clientWith({ materials: unshippedOrder() });

    const { plan } = await planOrderCancel(client, ORDER_ID);

    expect(plan?.kind).toBe('pre_shipment_cancel');
    expect(plan?.lines.filter(l => l.lineKind === 'returned')).toHaveLength(2);
    expect(plan?.standardRefund).toBe(37000);
  });

  test('FREQ-642-AC-28: 発送後の品を返品なしで選ぶ返金は計画を作らず、着の状態は変わらない', async () => {
    mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000, shippedMaterials().map(l => ({ ...l, shipped: 2, unshipped: 0, shippedRefundable: 2 }))));
    const { client } = clientWith({ materials: repeat() });

    const { plan, estimate } = await planOrderRefund(client, ORDER_ID, {
      lines: [{ orderItemId: 'oi-1', quantity: 1, beforeShipment: false }], shippingAmount: 0,
    });

    expect(plan).toBeNull();
    expect(estimate).toMatchObject({ legacy: false, changesUnits: false, refundCap: 37000 });
  });

  test('FREQ-642-AC-20: 写しの無い注文の返金は計画なしの legacy', async () => {
    mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000, shippedMaterials()));
    const { client } = clientWith({ materials: null });

    const { plan, estimate } = await planOrderRefund(client, ORDER_ID, {
      lines: [{ orderItemId: 'oi-1', quantity: 1, beforeShipment: true }], shippingAmount: 500,
    });

    expect(plan).toBeNull();
    expect(estimate).toEqual({ legacy: true, suggestedAmount: 17500, itemsAmount: 17000, refundCap: 37000, changesUnits: false });
  });

  test('DD-ADMIN-023: 注文が無ければ order_not_found', async () => {
    mockRefundMaterials.mockResolvedValue(null);
    const { client } = clientWith({ materials: null });
    await expect(planOrderRefund(client, ORDER_ID, { lines: [], shippingAmount: 0 }))
      .rejects.toMatchObject({ name: 'RefundOperationError', code: 'order_not_found' });
  });

  test('DD-ADMIN-023: 相談の返金は、前の注文へ戻す分が無ければ計画を渡さない（null）', async () => {
    const { client } = clientWith({ materials: repeat() });
    await expect(planReturnRefund(client, RETURN_ID)).resolves.toBeNull();
    await expect(planReturnRefund(clientWith({ materials: null }).client, RETURN_ID)).resolves.toBeNull();
  });

  test('DD-ADMIN-023: 前の注文に留めた割引の分が残ったままの相談の返金は、前の注文へ戻す計画（版つき）を渡す', async () => {
    // 例10-2: 1回目の注文の着を返して 3,000円を留め、2回目の注文の着も返った。留めた 3,000円は 1回目の注文へ戻る
    const { first, second } = twoOrders();
    const heldFirst = {
      ...first,
      slots: first.slots.map(s => ({
        ...s, state: 'returned_customer' as const, currentPrice: 0, allocatedAmount: 20000, returnedCustomerAt: '2026-11-05T00:00:00Z',
        returnedFeePercent: 0, returnedEventSeq: 1, returnedReturnLineId: null,
      })),
      entitlementPrevious: 17000, entitlementMax: 17000,
      holds: [{ heldOrderId: first.orderId, laterOrderId: second.orderId, itemId: JACKET, amount: 3000, seq: 1 }],
    };
    const returnedSecond = {
      ...second,
      slots: second.slots.map(s => ({ ...s, state: 'returned_customer' as const, currentPrice: 0, allocatedAmount: s.paidAmount })),
      entitlementPrevious: 17000, entitlementMax: 17000,
    };
    const { client } = clientWith({ materials: materialsOf(returnedSecond, [heldFirst]), orderId: second.orderId });

    const pricing = await planReturnRefund(client, RETURN_ID);

    expect(pricing).toMatchObject({ orderId: second.orderId, version: 'v1' });
    expect(pricing?.releases).toHaveLength(1);
    expect(pricing?.releases[0]).toMatchObject({ kind: 'hold_release', orderId: first.orderId, version: 'v1', standardRefund: 3000 });
  });
});

describe('FREQ-642-AC-21: お客様の申し込みの返金の見込み', () => {
  const settings = (over: Partial<ReturnCreateMaterials['settings']> = {}): ReturnCreateMaterials => ({
    order: { id: ORDER_ID, status: 'shipped', hasAwaitingRefund: false }, shipments: [], exchangeOptions: [],
    settings: {
      returnAddressSet: true, noReturnNeededEnabled: false, customerPaidMethod: 'customer_ships', shopLabelFee: 700,
      restockingFeeEnabled: false, restockingFeePercent: 0, exchangeFeesEnabled: false, exchangeFee: 0, exchangeShippingFee: 0,
      reasonShippingPayers: {
        defective: 'shop', wrong_item: 'shop', size_too_small: 'customer', size_too_large: 'customer', color: 'customer', style: 'customer',
        not_as_described: 'customer', unwanted: 'customer', other: 'customer', unknown: 'customer',
      },
      reasonOutOfStockExchange: {
        defective: 'make', wrong_item: 'make', size_too_small: 'decline', size_too_large: 'decline', color: 'decline', style: 'decline',
        not_as_described: 'decline', unwanted: 'decline', other: 'decline', unknown: 'decline',
      },
      ...over,
    },
  });
  const lines = (resolution: 'refund' | 'exchange') => [
    { orderItemId: 'oi-1', quantity: 1, reason: 'size_too_small' as const, requestedResolution: resolution },
  ];

  test('FREQ-642-AC-21: お客様の見込みは交換だけならお金が動かない', async () => {
    const { client } = clientWith({ materials: repeat() });
    await expect(estimateCustomerReturn(client, ORDER_ID, lines('exchange'))).resolves.toEqual({ refundAmount: 0, moneyMoves: false });
  });

  test('FREQ-642-AC-21: 返金の行がある見込みは、受け取りの返金の額と同じ（リピートの例 17,000円）', async () => {
    mockCreateMaterials.mockResolvedValue(settings());
    const { client } = clientWith({ materials: repeat() });

    await expect(estimateCustomerReturn(client, ORDER_ID, lines('refund'))).resolves.toEqual({ refundAmount: 17000, moneyMoves: true });
  });

  test('FREQ-642-AC-21: お客様の負担の返送料（お店の送り状）を引く。手数料の設定が使われていれば率も E の中で引く', async () => {
    mockCreateMaterials.mockResolvedValue(settings({ customerPaidMethod: 'shop_label' }));
    const { client } = clientWith({ materials: repeat() });
    await expect(estimateCustomerReturn(client, ORDER_ID, lines('refund'))).resolves.toEqual({ refundAmount: 17000 - 700, moneyMoves: true });

    mockCreateMaterials.mockResolvedValue(settings({ restockingFeeEnabled: true, restockingFeePercent: 10 }));
    await expect(estimateCustomerReturn(client, ORDER_ID, lines('refund'))).resolves.toMatchObject({ refundAmount: 17000 - 1700 });
  });

  test('FREQ-642-AC-20: 写しの無い注文の見込みは今の計算（先頭から安い着の額）', async () => {
    mockCreateMaterials.mockResolvedValue(settings());
    mockRefundMaterials.mockResolvedValue(refundMaterialsOf(37000, [{
      orderItemId: 'oi-1', name: 'ジャケット', color: null, size: null, fulfillmentType: 'stock', itemPrice: 20000, quantity: 2, lineTotal: 40000,
      shipped: 2, unshipped: 0, refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 2, restockable: 2, lineDiscount: 3000,
      refundedUnits: 0, availableUnitAmounts: [17000, 20000],
    }]));
    const { client } = clientWith({ materials: null });

    await expect(estimateCustomerReturn(client, ORDER_ID, lines('refund'))).resolves.toEqual({ refundAmount: 17000, moneyMoves: true });
  });

  test('FREQ-642-AC-21: 注文が無ければ order_not_found', async () => {
    mockCreateMaterials.mockResolvedValue(settings());
    mockRefundMaterials.mockResolvedValue(null);
    const { client } = clientWith({ materials: repeat() });
    await expect(estimateCustomerReturn(client, ORDER_ID, lines('refund'))).rejects.toBeInstanceOf(ReturnStoreError);
  });
});
