import type { SupabaseClient } from '@supabase/supabase-js';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const ITEM_X = 'f1b2c3d4-1111-4222-8333-444455556661';
const ITEM_Y = 'f1b2c3d4-1111-4222-8333-444455556662';
const REFUND_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const PAYMENT_INTENT_ID = 'pi_3Abc123';

type QueryResult = { data: unknown; error: { message?: string; code?: string } | null };

/** from(...).select(...).eq(...) の鎖を作る入れ物。最後に待つ（await する）か maybeSingle() を呼ぶと結果を返す */
function query(result: QueryResult) {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(async () => result),
    then: (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of [builder.select, builder.eq, builder.order, builder.limit]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

// 値 A（割り振りの試験と同じ）: X は在庫の品 3000 円 × 2、Y は受注生産の品 1000 円 × 3。割引 1000 円を 667 円と 333 円に割る
const LINE_X = {
  order_item_id: ITEM_X, fulfillment_type: 'stock', item_price: 3000, quantity: 2, line_total: 6000, shipped: 0, unshipped: 2,
  refunded_before_shipment: 0, refunded_after_shipment: 0, shipped_refundable: 0, restockable: 2, line_discount: 667, refunded_units: 0,
};
const LINE_Y = {
  order_item_id: ITEM_Y, fulfillment_type: 'backorder', item_price: 1000, quantity: 3, line_total: 3000, shipped: 0, unshipped: 3,
  refunded_before_shipment: 0, refunded_after_shipment: 0, shipped_refundable: 0, restockable: 0, line_discount: 333, refunded_units: 0,
};
const MATERIAL_ROW = {
  order_id: ORDER_ID, order_status: 'paid', total_amount: 8500, shipping_amount: 500, discount_amount: 1000, paid_amount: 8500,
  succeeded_amount: 0, open_amount: 0, refundable_amount: 8500, refunded_shipping: 0, refundable_shipping: 500,
  shipped_total: 0, unshipped_total: 5, awaiting_refund_id: null, awaiting_refund_amount: null, awaiting_refund_created_at: null,
  lines: [LINE_X, LINE_Y],
};
const ITEM_ROWS = [
  { id: ITEM_X, item_name: 'シルクブラウス', color: '白', size: 'M' },
  { id: ITEM_Y, item_name: 'リネンパンツ', color: null, size: null },
];

function stubClient(options: { rpc?: QueryResult; order?: QueryResult; items?: QueryResult; draft?: QueryResult } = {}) {
  const tables = {
    orders: query(options.order ?? { data: { payment_intent_id: PAYMENT_INTENT_ID }, error: null }),
    order_items: query(options.items ?? { data: ITEM_ROWS, error: null }),
    checkout_drafts: query(options.draft ?? { data: { payment_method: 'stripe_card' }, error: null }),
  };
  const from = jest.fn((table: string) => tables[table as keyof typeof tables]);
  const rpc = jest.fn(async () => options.rpc ?? { data: [MATERIAL_ROW], error: null });
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, tables };
}

describe('loadRefundMaterials', () => {
  it('DB の材料・商品の名前・支払い方法をまとめて返す', async () => {
    const { client, rpc, tables } = stubClient();

    await expect(loadRefundMaterials(client, ORDER_ID)).resolves.toEqual({
      order: {
        id: ORDER_ID,
        orderNumber: 'ORD-A1B2C3D4',
        status: 'paid',
        paymentMethod: 'card',
        totalAmount: 8500,
        shippingAmount: 500,
        discountAmount: 1000,
        paidAmount: 8500,
        succeededAmount: 0,
        openAmount: 0,
        refundableAmount: 8500,
        refundedShipping: 0,
        refundableShipping: 500,
        shippedTotal: 0,
        unshippedTotal: 5,
      },
      lines: [
        {
          orderItemId: ITEM_X, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock', itemPrice: 3000, quantity: 2,
          lineTotal: 6000, shipped: 0, unshipped: 2, refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0,
          restockable: 2, lineDiscount: 667, refundedUnits: 0,
        },
        {
          orderItemId: ITEM_Y, name: 'リネンパンツ', color: null, size: null, fulfillmentType: 'backorder', itemPrice: 1000, quantity: 3,
          lineTotal: 3000, shipped: 0, unshipped: 3, refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0,
          restockable: 0, lineDiscount: 333, refundedUnits: 0,
        },
      ],
      awaitingRefund: null,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('load_order_refund_materials', { _order_id: ORDER_ID });
    expect(tables.order_items.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
  });

  it('お客様の宛先・氏名・メールは読まない。注文から読むのは支払いの番号の1列だけ', async () => {
    const { client, tables } = stubClient();

    await loadRefundMaterials(client, ORDER_ID);

    expect(tables.orders.select).toHaveBeenCalledTimes(1);
    expect(tables.orders.select).toHaveBeenCalledWith('payment_intent_id');
    expect(tables.orders.eq).toHaveBeenCalledWith('id', ORDER_ID);
  });

  it('商品の並びは、DB の lines の並びではなく、注文の商品の登録順（created_at、同じ時刻は id）', async () => {
    const { client, tables } = stubClient({ rpc: { data: [{ ...MATERIAL_ROW, lines: [LINE_Y, LINE_X] }], error: null } });

    const materials = await loadRefundMaterials(client, ORDER_ID);

    expect(materials?.lines.map((line) => line.orderItemId)).toEqual([ITEM_X, ITEM_Y]);
    expect(tables.order_items.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
    expect(tables.order_items.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
  });

  it('大文字の番号を渡すと、DB の関数へはそのまま渡し、以降の読み取りは DB が返した小文字の番号で引く', async () => {
    const upper = ORDER_ID.toUpperCase();
    const { client, rpc, tables } = stubClient();

    const materials = await loadRefundMaterials(client, upper);

    expect(rpc).toHaveBeenCalledWith('load_order_refund_materials', { _order_id: upper });
    expect(tables.orders.eq).toHaveBeenCalledWith('id', ORDER_ID);
    expect(tables.order_items.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
    expect(materials?.order.id).toBe(ORDER_ID);
    expect(materials?.order.orderNumber).toBe('ORD-A1B2C3D4');
  });

  it('返金した数・在庫に戻せる数・割り振った割引を、そのまま写す', async () => {
    // X は 1 個を発送前に返金し、もう 1 個を発送した。そのうち 1 個はもう発送後に返金した
    const shipped = {
      ...LINE_X, quantity: 3, shipped: 1, unshipped: 1, refunded_before_shipment: 1, refunded_after_shipment: 1,
      shipped_refundable: 0, restockable: 1, refunded_units: 2,
    };
    const { client } = stubClient({ rpc: { data: [{ ...MATERIAL_ROW, lines: [shipped, LINE_Y] }], error: null } });

    const materials = await loadRefundMaterials(client, ORDER_ID);

    expect(materials?.lines[0]).toMatchObject({
      quantity: 3, shipped: 1, unshipped: 1, refundedBeforeShipment: 1, refundedAfterShipment: 1, shippedRefundable: 0,
      restockable: 1, lineDiscount: 667, refundedUnits: 2,
    });
  });

  it('返事待ちの返金があれば、その番号・額・始めた時刻を返す。成功・保留の額は材料の金額に入っている', async () => {
    const row = {
      ...MATERIAL_ROW, succeeded_amount: 1000, open_amount: 2666, refundable_amount: 4834,
      awaiting_refund_id: REFUND_ID, awaiting_refund_amount: 2666, awaiting_refund_created_at: '2026-10-11T02:00:00+00:00',
    };
    const { client } = stubClient({ rpc: { data: [row], error: null } });

    const materials = await loadRefundMaterials(client, ORDER_ID);

    expect(materials?.awaitingRefund).toEqual({ id: REFUND_ID, amount: 2666, createdAt: '2026-10-11T02:00:00+00:00' });
    expect(materials?.order).toMatchObject({ succeededAmount: 1000, openAmount: 2666, refundableAmount: 4834 });
  });

  it('受け取った額が空の注文（未入金）は、受け取った額も返せる額も 0 にする', async () => {
    const row = { ...MATERIAL_ROW, order_status: 'pending', paid_amount: null, refundable_amount: null };
    const { client } = stubClient({ rpc: { data: [row], error: null } });

    const materials = await loadRefundMaterials(client, ORDER_ID);

    expect(materials?.order).toMatchObject({ status: 'pending', paidAmount: 0, refundableAmount: 0 });
  });

  describe('支払い方法（checkout_drafts.payment_method。お客様の注文の窓口と同じ読み方）', () => {
    it.each([
      ['stripe_card', 'card'],
      ['link', 'link'],
      ['stripe_paypay', 'paypay'],
      ['stripe_konbini', 'konbini'],
      ['customer_balance', 'unknown'],
      ['alipay', 'unknown'],
      ['', 'unknown'],
    ] as const)('%s は %s', async (paymentMethod, expected) => {
      const { client, tables } = stubClient({ draft: { data: { payment_method: paymentMethod }, error: null } });

      const materials = await loadRefundMaterials(client, ORDER_ID);

      expect(materials?.order.paymentMethod).toBe(expected);
      expect(tables.checkout_drafts.select).toHaveBeenCalledWith('payment_method');
      expect(tables.checkout_drafts.eq).toHaveBeenCalledWith('payment_intent_id', PAYMENT_INTENT_ID);
      expect(tables.checkout_drafts.limit).toHaveBeenCalledWith(1);
    });

    it('下書きの行が無ければ unknown', async () => {
      const { client } = stubClient({ draft: { data: null, error: null } });

      const materials = await loadRefundMaterials(client, ORDER_ID);

      expect(materials?.order.paymentMethod).toBe('unknown');
    });

    it('注文に支払いの番号が無ければ、下書きを読まずに unknown', async () => {
      const { client, from } = stubClient({ order: { data: { payment_intent_id: null }, error: null } });

      const materials = await loadRefundMaterials(client, ORDER_ID);

      expect(materials?.order.paymentMethod).toBe('unknown');
      expect(from).not.toHaveBeenCalledWith('checkout_drafts');
    });
  });

  it('注文が無ければ null。ほかの読み取りはしない', async () => {
    const { client, from } = stubClient({ rpc: { data: [], error: null } });

    await expect(loadRefundMaterials(client, ORDER_ID)).resolves.toBeNull();

    expect(from).not.toHaveBeenCalled();
  });

  describe('DB の読み取りが失敗した時', () => {
    const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };
    const FAILURES: Array<[name: string, options: Parameters<typeof stubClient>[0], operation: string]> = [
      ['材料の関数', { rpc: { data: null, error: dbError } }, 'load_order_refund_materials'],
      ['注文', { order: { data: null, error: dbError } }, 'load_order'],
      ['商品', { items: { data: null, error: dbError } }, 'load_order_items'],
      ['支払い方法の下書き', { draft: { data: null, error: dbError } }, 'load_checkout_draft'],
    ];

    it.each(FAILURES)('%s の読み取りが失敗したら RefundStoreError。DB の文は cause にだけ残す', async (_name, options, operation) => {
      const { client } = stubClient(options);

      const error = (await loadRefundMaterials(client, ORDER_ID).catch((caught: unknown) => caught)) as RefundStoreError;

      expect(error).toBeInstanceOf(RefundStoreError);
      expect(error.operation).toBe(operation);
      expect(error.code).toBe('08006');
      expect(error.message).toBe(`refund store failed: ${operation}`);
      expect(error.cause).toEqual(dbError);
    });
  });
});
