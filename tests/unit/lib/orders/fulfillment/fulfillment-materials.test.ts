import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import { FulfillmentStoreError } from '@/lib/orders/fulfillment/fulfillment-store';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const STOCK_ITEM = 'f1b2c3d4-1111-4222-8333-444455556661';
const BACKORDER_ITEM = 'f1b2c3d4-1111-4222-8333-444455556662';
const FULFILLMENT_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const FULFILLMENT_2 = 'd1b2c3d4-1111-4222-8333-444455556662';

type QueryResult = { data: unknown; error: { message?: string; code?: string } | null };

/** from(...).select(...).eq(...) の鎖を作る入れ物。最後に待つ（await する）と結果を返す */
function query(result: QueryResult) {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    order: jest.fn(),
    maybeSingle: jest.fn(async () => result),
    then: (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of [builder.select, builder.eq, builder.is, builder.order]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

const ORDER_ROW = {
  id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子', shipping_postal_code: '1500001',
  shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-2-3', shipping_phone: '09012345678',
};
const ITEM_ROWS = [
  { id: STOCK_ITEM, item_name: 'シルクブラウス', color: '白', size: 'M' },
  { id: BACKORDER_ITEM, item_name: 'リネンパンツ', color: null, size: null },
];
const COUNT_ROWS = [
  {
    order_id: ORDER_ID, order_item_id: STOCK_ITEM, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 0, completed: 2,
    in_production: 0, ready_unshipped: 2, unshipped: 2,
  },
  {
    order_id: ORDER_ID, order_item_id: BACKORDER_ITEM, variant_id: 12, fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0,
    in_production: 1, ready_unshipped: 0, unshipped: 1,
  },
];
const FULFILLMENT_ROWS = [
  {
    fulfillment_id: FULFILLMENT_2, number: 2, shipping_carrier: 'sagawa', tracking_number: '9999-0000', notify_customer: false,
    completes_order: false, shipped_at: '2026-10-11T02:00:00+00:00', created_by_email: 'admin@example.com',
    cancelled_at: '2026-10-11T03:00:00+00:00', cancelled_by_email: 'admin@example.com', legacy: false,
    lines: [{ order_item_id: STOCK_ITEM, quantity: 1 }],
  },
  {
    fulfillment_id: FULFILLMENT_1, number: 1, shipping_carrier: 'yamato', tracking_number: '1234-5678', notify_customer: true,
    completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
    cancelled_by_email: null, legacy: false, lines: [{ order_item_id: STOCK_ITEM, quantity: 1 }],
  },
];

function stubClient(options: {
  order?: QueryResult;
  items?: QueryResult;
  exceptions?: QueryResult;
  rpc?: Record<string, QueryResult>;
} = {}) {
  const tables = {
    orders: query(options.order ?? { data: ORDER_ROW, error: null }),
    order_items: query(options.items ?? { data: ITEM_ROWS, error: null }),
    payment_exceptions: query(options.exceptions ?? { data: [], error: null }),
  };
  const rpcAnswers: Record<string, QueryResult> = {
    list_order_line_fulfillment: { data: COUNT_ROWS, error: null },
    list_order_fulfillments: { data: FULFILLMENT_ROWS, error: null },
    ...options.rpc,
  };
  const from = jest.fn((table: string) => tables[table as keyof typeof tables]);
  const rpc = jest.fn(async (name: string) => rpcAnswers[name] ?? { data: [], error: null });
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, tables };
}

describe('loadFulfillmentMaterials', () => {
  it('注文・商品ごとの数・発送の一覧をまとめて返す。商品の並びは登録順', async () => {
    const { client, rpc, tables } = stubClient();

    await expect(loadFulfillmentMaterials(client, ORDER_ID)).resolves.toEqual({
      order: {
        id: ORDER_ID,
        orderNumber: 'ORD-A1B2C3D4',
        status: 'paid',
        progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
      },
      blockedReason: null,
      lines: [
        {
          orderItemId: STOCK_ITEM, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock', quantity: 2,
          shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
        },
        {
          orderItemId: BACKORDER_ITEM, name: 'リネンパンツ', color: null, size: null, fulfillmentType: 'backorder', quantity: 1,
          shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
        },
      ],
      fulfillments: [
        {
          id: FULFILLMENT_2, number: 2, carrier: 'sagawa', trackingNumber: '9999-0000', shippedAt: '2026-10-11T02:00:00+00:00',
          notifyCustomer: false, completesOrder: false, cancelledAt: '2026-10-11T03:00:00+00:00',
          lines: [{ orderItemId: STOCK_ITEM, quantity: 1 }],
        },
        {
          id: FULFILLMENT_1, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', shippedAt: '2026-10-10T02:00:00+00:00',
          notifyCustomer: true, completesOrder: false, cancelledAt: null, lines: [{ orderItemId: STOCK_ITEM, quantity: 1 }],
        },
      ],
    });

    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    expect(rpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
    expect(tables.order_items.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
    expect(tables.order_items.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
  });

  it('操作した人のメールは材料に入れない（発送の画面に要らない）', async () => {
    const { client } = stubClient();

    const materials = await loadFulfillmentMaterials(client, ORDER_ID);

    expect(JSON.stringify(materials)).not.toContain('admin@example.com');
  });

  it('在庫の品だけを先に送った後は、一部発送済みの言葉と、残りの数を返す', async () => {
    const shipped = {
      ...COUNT_ROWS[0], shipped: 2, ready_unshipped: 0, unshipped: 0,
    };
    const { client } = stubClient({ rpc: { list_order_line_fulfillment: { data: [shipped, COUNT_ROWS[1]], error: null } } });

    const materials = await loadFulfillmentMaterials(client, ORDER_ID);

    expect(materials?.order.progress).toEqual({ key: 'in_production', label: '受注生産中', partiallyShipped: true });
    expect(materials?.lines[0]).toMatchObject({ shipped: 2, readyUnshipped: 0, unshipped: 0 });
  });

  it('大文字の番号で開いても、DB が返した注文の番号（小文字）で読み直し、商品が並ぶ', async () => {
    // 偽物の DB は、実際と同じに、小文字の id の注文と小文字の order_id の数を返す
    const { client, rpc, tables } = stubClient();

    const materials = await loadFulfillmentMaterials(client, ORDER_ID.toUpperCase());

    expect(materials?.order.id).toBe(ORDER_ID);
    expect(materials?.lines.map((line) => line.orderItemId)).toEqual([STOCK_ITEM, BACKORDER_ITEM]);
    expect(materials?.fulfillments).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    expect(rpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
    expect(tables.order_items.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
    expect(tables.payment_exceptions.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
  });

  it('注文が無ければ null。ほかの読み取りはしない', async () => {
    const { client, from, rpc } = stubClient({ order: { data: null, error: null } });

    await expect(loadFulfillmentMaterials(client, ORDER_ID)).resolves.toBeNull();

    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  describe('発送できない理由 blockedReason', () => {
    it.each(['pending', 'shipped', 'cancelled', 'failed', 'payment_in_progress', 'abandoned'])(
      '注文が %s なら not_shippable（配送先が足りなくても、この理由が先）',
      async (status) => {
        const { client } = stubClient({ order: { data: { ...ORDER_ROW, status, shipping_phone: null }, error: null } });

        const materials = await loadFulfillmentMaterials(client, ORDER_ID);

        expect(materials?.blockedReason).toBe('not_shippable');
      },
    );

    it.each([
      ['電話番号が空', { shipping_phone: null }],
      ['郵便番号が空白だけ', { shipping_postal_code: '   ' }],
      ['宛名が空', { shipping_full_name: '' }],
      ['メールが無い', { shipping_email: null }],
    ])('配送先が足りなければ address_incomplete（%s）。支払額の要対応より先', async (_name, overrides) => {
      const { client } = stubClient({
        order: { data: { ...ORDER_ROW, ...overrides }, error: null },
        exceptions: { data: [{ order_id: ORDER_ID }], error: null },
      });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBe('address_incomplete');
    });

    it('支払額の違いの要対応が残っていれば payment_review_required。読む条件は管理画面の一覧と同じ', async () => {
      const { client, tables } = stubClient({ exceptions: { data: [{ order_id: ORDER_ID }], error: null } });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBe('payment_review_required');
      expect(tables.payment_exceptions.select).toHaveBeenCalledWith('order_id');
      expect(tables.payment_exceptions.eq).toHaveBeenCalledWith('order_id', ORDER_ID);
      expect(tables.payment_exceptions.eq).toHaveBeenCalledWith('reason', 'paid_amount_mismatch');
      expect(tables.payment_exceptions.is).toHaveBeenCalledWith('resolved_at', null);
    });

    it('建物名が無くても発送できる（必須項目ではない）', async () => {
      const { client } = stubClient({ order: { data: { ...ORDER_ROW, shipping_building: null }, error: null } });

      const materials = await loadFulfillmentMaterials(client, ORDER_ID);

      expect(materials?.blockedReason).toBeNull();
    });
  });

  describe('DB の読み取りが失敗した時', () => {
    it.each([
      ['注文', { order: { data: null, error: { message: 'down', code: '08006' } } }],
      ['商品', { items: { data: null, error: { message: 'down', code: '08006' } } }],
      ['支払額の要対応', { exceptions: { data: null, error: { message: 'down', code: '08006' } } }],
      ['商品ごとの数', { rpc: { list_order_line_fulfillment: { data: null, error: { message: 'down', code: '08006' } } } }],
      ['発送の一覧', { rpc: { list_order_fulfillments: { data: null, error: { message: 'down', code: '08006' } } } }],
    ])('%s の読み取りが失敗したら FulfillmentStoreError を投げる', async (_name, options) => {
      const { client } = stubClient(options);

      await expect(loadFulfillmentMaterials(client, ORDER_ID)).rejects.toBeInstanceOf(FulfillmentStoreError);
    });
  });
});
