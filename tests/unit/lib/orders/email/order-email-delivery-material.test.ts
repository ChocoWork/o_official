import { loadDeliveryEmailMaterial } from '@/lib/orders/email/order-email-delivery-material';
import { OrderEmailMaterialError } from '@/lib/orders/email/order-email-compose';
import type { ClaimedOrderEmail } from '@/lib/orders/email/order-email-store';
import type { DeliveryEmailKind } from '@/lib/orders/email/order-email-types';

const ORDER = {
  id: 'order-1', status: 'shipped', shipping_email: 'customer@example.com', shipping_full_name: null,
  subtotal_amount: 10000, shipping_amount: 0, discount_amount: 0, total_amount: 10000, currency: 'jpy',
};
const FULFILLMENT = {
  id: 'fulfillment-1', order_id: ORDER.id, number: 1, shipping_carrier: 'yamato', tracking_number: 'CURRENT-1234',
  completes_order: false, cancelled_at: null, tracking_version: 3, delivery_status: 'confirmed', delivered_at: null,
};
const CHANGE = {
  id: 'change-1', fulfillment_id: FULFILLMENT.id, tracking_version: 2,
  from_carrier: 'yamato', from_tracking_number: 'OLD-1234', to_carrier: 'sagawa', to_tracking_number: 'CORRECTED-1234',
};
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  orders: [ORDER],
  order_items: [{ order_id: ORDER.id, line_kind: 'order', item_name: 'コート', color: 'BLACK', size: 'M', quantity: 3, line_total: 10000 }],
  order_fulfillments: [FULFILLMENT],
  order_fulfillment_lines: [{ fulfillment_id: FULFILLMENT.id, quantity: 1,
    order_items: { item_name: 'コート', color: 'BLACK', size: 'M', line_kind: 'order' } }],
  order_fulfillment_tracking_changes: [CHANGE],
  shop_return_settings: [{ id: 1, window_days: 7 }],
};

// eqを実際に適用し、別注文/別発送/別版の行を返さないDBの境界を模す。
function store(overrides: Partial<typeof TABLES> = {}, failTable?: string) {
  const tables = { ...TABLES, ...overrides };
  const queries: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }> = [];
  const from = jest.fn((table: string) => ({
    select: (columns: string) => {
      const query = { table, columns, filters: [] as Array<[string, unknown]> };
      queries.push(query);
      const result = (single: boolean) => {
        const rows = (tables[table] ?? []).filter((row) => query.filters.every(([key, value]) => row[key] === value));
        return { data: single ? rows[0] ?? null : rows, error: failTable === table ? { code: '08006', message: '秘密の宛先/本文' } : null };
      };
      const chain = {
        eq: (column: string, value: unknown) => { query.filters.push([column, value]); return chain; },
        maybeSingle: async () => result(true),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result(false)).then(resolve),
      };
      return chain;
    },
  }));
  return { client: { from, rpc: jest.fn() } as never, queries, from };
}

function claim(kind: DeliveryEmailKind, overrides: Partial<ClaimedOrderEmail> = {}): ClaimedOrderEmail {
  return { id: 'email-1', orderId: ORDER.id, kind, variant: null, origin: 'auto', attempts: 1, leaseToken: 'lease-1',
    subject: null, bodyText: null, paymentExpiredSent: false, fulfillmentId: FULFILLMENT.id, refundId: null,
    returnId: null, returnReceiptId: null, cancelRequestId: null, trackingVersion: 3,
    trackingChangeId: kind === 'shipping_update' ? CHANGE.id : null, ...overrides };
}

describe('配送メールの材料を読む', () => {
  it.each(['out_for_delivery', 'delivered'] as const)('%sは注文と発送の所属・現在の版を読み、部分発送の数だけ返す', async (kind) => {
    const h = store({ order_fulfillments: [{ ...FULFILLMENT, delivery_status: 'delivered', delivered_at: '2026-10-20T15:01:00Z' }] });
    const source = await loadDeliveryEmailMaterial(h.client, claim(kind));
    expect(source?.delivery).toEqual({ fulfillmentId: FULFILLMENT.id, trackingVersion: 3, currentTrackingVersion: 3,
      cancelled: false, deliveryStatus: 'delivered', deliveredAt: '2026-10-20T15:01:00Z',
      windowDays: kind === 'delivered' ? 7 : null, carrier: 'yamato', trackingNumber: 'CURRENT-1234' });
    expect(source?.fulfillment?.lines).toEqual([{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, exchange: false }]);
    for (const query of h.queries.filter((q) => q.table === 'order_fulfillments')) {
      expect(query.filters).toEqual(expect.arrayContaining([['id', FULFILLMENT.id], ['order_id', ORDER.id]]));
    }
    expect(h.queries.find((q) => q.table === 'orders')?.filters).toContainEqual(['id', ORDER.id]);
  });

  it.each(['out_for_delivery', 'delivered'] as const)('%sは旧版を現在の版へすり替えずskip用の材料を返す', async (kind) => {
    const h = store();
    const source = await loadDeliveryEmailMaterial(h.client, claim(kind, { trackingVersion: 2 }));
    expect(source?.delivery).toMatchObject({ trackingVersion: 2, currentTrackingVersion: 3 });
  });

  it('発送の更新は現在の値ではなく、該当changeの新しい値を読む。旧版も使える', async () => {
    const h = store();
    const source = await loadDeliveryEmailMaterial(h.client, claim('shipping_update', { trackingVersion: 2 }));
    expect(source?.delivery).toMatchObject({ trackingVersion: 2, currentTrackingVersion: 3, carrier: 'sagawa', trackingNumber: 'CORRECTED-1234' });
    expect(h.queries.find((q) => q.table === 'order_fulfillment_tracking_changes')?.filters).toEqual(
      expect.arrayContaining([['id', CHANGE.id], ['fulfillment_id', FULFILLMENT.id], ['tracking_version', 2]]),
    );
    // 追跡の詳細・出来事・場所・providerの文は読まない。
    expect(h.queries.map((q) => q.columns).join(',')).not.toMatch(/provider|location|description|\*/);
  });

  it.each([1, 7, 365, null])('配達済みは設定のwindow_days=%sをそのまま読む', async (window_days) => {
    const h = store({ shop_return_settings: [{ id: 1, window_days }] });
    expect((await loadDeliveryEmailMaterial(h.client, claim('delivered')))?.delivery?.windowDays).toBe(window_days);
  });

  it.each([
    { fulfillmentId: null }, { trackingVersion: null }, { trackingVersion: undefined },
    { trackingVersion: 0 }, { trackingVersion: -1 }, { trackingVersion: 1.5 },
  ])('必須の発送/版が無ければ材料不足 (%j)', async (overrides) => {
    const h = store();
    await expect(loadDeliveryEmailMaterial(h.client, claim('out_for_delivery', overrides))).resolves.toBeNull();
    expect(h.from).not.toHaveBeenCalled();
  });

  it.each([
    { trackingChangeId: null }, { trackingChangeId: 'other-change' }, { trackingVersion: 3 },
  ])('changeの番号か版が合わなければ材料不足 (%j)', async (overrides) => {
    const h = store();
    await expect(loadDeliveryEmailMaterial(h.client, claim('shipping_update', { trackingVersion: 2, ...overrides }))).resolves.toBeNull();
  });

  it('別発送のchangeを同じ注文へ混ぜない', async () => {
    const h = store({ order_fulfillment_tracking_changes: [{ ...CHANGE, fulfillment_id: 'other-fulfillment' }] });
    await expect(loadDeliveryEmailMaterial(h.client, claim('shipping_update', { trackingVersion: 2 }))).resolves.toBeNull();
  });

  it('別注文の発送/changeを宛先の注文へ混ぜない', async () => {
    const h = store({ order_fulfillments: [{ ...FULFILLMENT, order_id: 'other-order' }] });
    await expect(loadDeliveryEmailMaterial(h.client, claim('shipping_update', { trackingVersion: 2 }))).resolves.toBeNull();
  });

  it.each(['orders', 'order_items', 'order_fulfillments', 'order_fulfillment_lines', 'shop_return_settings'])('%sが欠けたら材料不足', async (table) => {
    const h = store({ [table]: [] });
    await expect(loadDeliveryEmailMaterial(h.client, claim('delivered'))).resolves.toBeNull();
  });

  it.each(['orders', 'order_items', 'order_fulfillments', 'order_fulfillment_lines', 'shop_return_settings', 'order_fulfillment_tracking_changes'])('%sのDB失敗は材料不足と区別し、文を例外に含めない', async (table) => {
    const h = store({}, table);
    const row = claim(table === 'order_fulfillment_tracking_changes' ? 'shipping_update' : 'delivered',
      table === 'order_fulfillment_tracking_changes' ? { trackingVersion: 2 } : {});
    await expect(loadDeliveryEmailMaterial(h.client, row)).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(loadDeliveryEmailMaterial(h.client, row)).rejects.toMatchObject({ table });
    await expect(loadDeliveryEmailMaterial(h.client, row)).rejects.not.toThrow('秘密');
  });

  it('取消した発送もworkerのskip判定用に読む', async () => {
    const h = store({ order_fulfillments: [{ ...FULFILLMENT, cancelled_at: '2026-10-21T00:00:00Z' }] });
    expect((await loadDeliveryEmailMaterial(h.client, claim('out_for_delivery')))?.delivery?.cancelled).toBe(true);
  });
});
