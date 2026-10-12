import {
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailMaterial,
  type OrderEmailReturnMaterial,
} from '@/lib/orders/email/order-email-compose';

/**
 * 返品のメールの材料の読み込み（グループ E-3 設計書 9 章）。読む表・列・絞り込み・並び・形の変換を確かめる。
 * 本物の PostgREST でしか確かめられない所（列の名前・埋め込み・関数の呼び出し）は、DB 結合テスト
 * order_email_material_postgrest.integration.test.ts が確かめる
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const RECEIPT_ID = 'c1b2c3d4-1111-2222-8333-444455556666';
const REFUND_ID = 'e1b2c3d4-1111-2222-8333-444455556666';

const ORDER_ROW = {
  id: ORDER_ID,
  status: 'shipped',
  shipping_email: 'hanako@example.com',
  shipping_full_name: '山田 花子',
  subtotal_amount: 10000,
  shipping_amount: 0,
  discount_amount: 0,
  total_amount: 10000,
  paid_amount: null,
  currency: 'jpy',
  shipping_postal_code: '1500001',
  shipping_prefecture: '東京都',
  shipping_city: '渋谷区',
  shipping_address: '神宮前1-1-1',
  shipping_building: null,
  shipping_phone: '0311112222',
  review_reason: null,
};
const BASE_ITEMS = [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'stock' }];

const RETURN_ROW = {
  number: 2,
  return_method: 'shop_label',
  return_shipping_payer: 'customer',
  return_shipping_fee: 800,
  restocking_fee_percent: 10,
  exchange_fee: 500,
  exchange_shipping_fee: 600,
  fee_due_amount: 0,
  fee_pending_deduction: 0,
  fee_received_at: null,
  exchange_released_at: null,
};

// 注文の商品（登録順: コート → ワンピース → ブラウス → ストール）
const ITEM_ROWS = [
  { id: 'item-stole', item_name: 'ストール', color: null, size: null, created_at: '2026-10-10T01:00:03.000000+00:00' },
  { id: 'item-blouse', item_name: 'ブラウス', color: 'WHITE', size: 'S', created_at: '2026-10-10T01:00:02.000000+00:00' },
  { id: 'item-coat', item_name: 'コート', color: 'BLACK', size: 'M', created_at: '2026-10-10T01:00:00.000000+00:00' },
  { id: 'item-dress', item_name: 'ワンピース', color: 'NAVY', size: 'S', created_at: '2026-10-10T01:00:01.000000+00:00' },
];

// 返品の行（DB が返す順は番号の順と限らない）
const RETURN_LINES = [
  { id: 'line-3', order_item_id: 'item-blouse', quantity: 2, resolution: 'exchange', exchange_variant_id: 9003, exchange_method: 'make' },
  { id: 'line-1', order_item_id: 'item-coat', quantity: 1, resolution: 'refund', exchange_variant_id: null, exchange_method: null },
  { id: 'line-4', order_item_id: 'item-stole', quantity: 3, resolution: 'refund', exchange_variant_id: null, exchange_method: null },
  { id: 'line-2', order_item_id: 'item-dress', quantity: 1, resolution: 'exchange', exchange_variant_id: 9002, exchange_method: 'stock' },
];

const VARIANTS = [
  { id: 9003, item_id: 103, item_colors: { name: 'WHITE' }, item_sizes: { label: 'L' } },
  { id: 9002, item_id: 102, item_colors: { name: 'NAVY' }, item_sizes: { label: 'M' } },
];

const SETTINGS_ROW = {
  return_address_name: 'Le Fil des Heures 返品係',
  return_address_postal_code: '150-0001',
  return_address_line: '東京都渋谷区神宮前1-2-3',
  return_address_phone: '03-1234-5678',
};

const RECEIPT_ROW = {
  id: RECEIPT_ID,
  return_id: RETURN_ID,
  refund_choice: 'none',
  refund_id: null,
  actor_can_refund: true,
  sent_back_message: null,
  sent_back_carrier: null,
  sent_back_tracking_number: null,
};

/**
 * 受け取りの行。実際に決まった解決で数える:
 * - line-2（予定は在庫から）は、在庫が足りず作って送るに変わった
 * - line-3（予定は作って送る、2点）は、1点を検品待ちで作って送る、1点を店長が返金に変えた
 * - 返金しないことにした数（refund_waived）は、受け取った品の数に足さない
 */
const RECEIPT_LINES = [
  { return_line_id: 'line-1', disposition: 'restocked', quantity: 1, resolution: 'refund', exchange_method: null },
  { return_line_id: 'line-2', disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: 'make' },
  { return_line_id: 'line-3', disposition: 'pending_inspection', quantity: 1, resolution: 'exchange', exchange_method: 'make' },
  { return_line_id: 'line-3', disposition: 'not_restocked', quantity: 1, resolution: 'refund', exchange_method: null },
  { return_line_id: 'line-4', disposition: 'sent_back', quantity: 3, resolution: null, exchange_method: null },
  { return_line_id: 'line-1', disposition: 'refund_waived', quantity: 1, resolution: null, exchange_method: null },
];

const LEAD_DAYS_ROWS = [
  { id: 102, made_to_order_lead_days: 21 },
  { id: 103, made_to_order_lead_days: null },
];

type Result = { data?: unknown; error?: unknown };
type TableEntry = Result | ((columns: string) => Result);
type Filter = ['eq' | 'in', string, unknown];

/**
 * 表ごとの答えを返す偽の client。問い合わせの列・絞り込みを控える。
 * 答えは `await` でも `.maybeSingle()` でも返る（本物の PostgREST の builder と同じ）
 */
function fakeStore(tables: Record<string, TableEntry>, rpcResults: Record<string, Result> = {}) {
  const queries: Array<{ table: string; columns: string; filters: Filter[] }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const from = (table: string) => ({
    select: (columns: string) => {
      const query = { table, columns, filters: [] as Filter[] };
      queries.push(query);
      const entry = tables[table];
      const result = (typeof entry === 'function' ? entry(columns) : entry) ?? {};
      const answer = { data: result.data ?? null, error: result.error ?? null };
      const chain = {
        eq: (column: string, value: unknown) => {
          query.filters.push(['eq', column, value]);
          return chain;
        },
        in: (column: string, values: unknown) => {
          query.filters.push(['in', column, values]);
          return chain;
        },
        maybeSingle: async () => answer,
        then: (resolve: (value: typeof answer) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(answer).then(resolve, reject),
      };
      return chain;
    },
  });
  const rpc = async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    const result = rpcResults[name] ?? {};
    return { data: result.data ?? null, error: result.error ?? null };
  };
  const tablesRead = () => queries.map((query) => query.table);
  const queryOf = (table: string, index = 0) => queries.filter((query) => query.table === table)[index];
  return { client: { from, rpc } as never, queries, rpcCalls, tablesRead, queryOf };
}

/** 注文と明細（どの種類のメールも読む）に、返品の表を足した答えの一式 */
function returnTables(overrides: Record<string, TableEntry> = {}): Record<string, TableEntry> {
  return {
    orders: { data: ORDER_ROW },
    order_items: (columns) => ({ data: columns.startsWith('item_name') ? BASE_ITEMS : ITEM_ROWS }),
    order_returns: { data: RETURN_ROW },
    order_return_lines: { data: RETURN_LINES },
    order_return_receipts: { data: RECEIPT_ROW },
    order_return_receipt_lines: { data: RECEIPT_LINES },
    item_variants: { data: VARIANTS },
    items: { data: LEAD_DAYS_ROWS },
    shop_return_settings: { data: SETTINGS_ROW },
    ...overrides,
  };
}

async function load(
  db: ReturnType<typeof fakeStore>,
  ids: { refundId?: string | null; returnId?: string | null; returnReceiptId?: string | null },
): Promise<OrderEmailMaterial | null> {
  return loadOrderEmailMaterial(db.client, ORDER_ID, null, ids.refundId ?? null, ids.returnId ?? null, ids.returnReceiptId ?? null);
}

async function loadReturn(
  tables: Record<string, TableEntry>,
  ids: { refundId?: string | null; returnId?: string | null; returnReceiptId?: string | null },
  rpcResults: Record<string, Result> = {},
): Promise<{ orderReturn: OrderEmailReturnMaterial | null; db: ReturnType<typeof fakeStore> }> {
  const db = fakeStore(tables, rpcResults);
  const material = await load(db, ids);
  return { orderReturn: material?.orderReturn ?? null, db };
}

const COAT = { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 };
const DRESS = { item_name: 'ワンピース', color: 'NAVY', size: 'S', quantity: 1 };
const BLOUSE = { item_name: 'ブラウス', color: 'WHITE', size: 'S', quantity: 2 };
const STOLE = { item_name: 'ストール', color: null, size: null, quantity: 3 };

describe('loadOrderEmailMaterial（返品の受付のお知らせの材料）', () => {
  it('返品の番号があれば、返品・返品の行・元の品・交換の色とサイズ・返送先を読み、商品の登録順に並べて返す', async () => {
    const { orderReturn, db } = await loadReturn(returnTables(), { returnId: RETURN_ID });

    expect(orderReturn).toEqual({
      number: 2,
      returnMethod: 'shop_label',
      returnShippingPayer: 'customer',
      returnShippingFee: 800,
      restockingFeePercent: 10,
      exchangeFee: 500,
      exchangeShippingFee: 600,
      feeWaitingAmount: 0,
      returnAddress: { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      items: [COAT, DRESS, BLOUSE, STOLE],
      exchangePlan: [
        { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'stock', leadDays: null },
        { item_name: 'ブラウス', color: 'WHITE', size: 'L', quantity: 2, method: 'make', leadDays: null },
      ],
      hasRefundLines: true,
      receipt: null,
    });
    // 返品は注文の番号でも絞る
    expect(db.queryOf('order_returns')).toEqual({
      table: 'order_returns',
      columns:
        'number, return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee, fee_due_amount, fee_pending_deduction, fee_received_at, exchange_released_at',
      filters: [['eq', 'id', RETURN_ID], ['eq', 'order_id', ORDER_ID]],
    });
    expect(db.queryOf('order_return_lines')).toEqual({
      table: 'order_return_lines',
      columns: 'id, order_item_id, quantity, resolution, exchange_variant_id, exchange_method',
      filters: [['eq', 'return_id', RETURN_ID]],
    });
    // 元の品は、返品の行が指す商品だけを、この注文の中から読む（番号の順に並べた返品の行の順で、重ねずに）
    expect(db.queryOf('order_items', 1)).toEqual({
      table: 'order_items',
      columns: 'id, item_name, color, size, created_at',
      filters: [['eq', 'order_id', ORDER_ID], ['in', 'id', ['item-coat', 'item-dress', 'item-blouse', 'item-stole']]],
    });
    expect(db.queryOf('item_variants')).toEqual({
      table: 'item_variants',
      columns: 'id, item_id, item_colors(name), item_sizes(label)',
      filters: [['in', 'id', [9002, 9003]]],
    });
    expect(db.queryOf('shop_return_settings')).toEqual({
      table: 'shop_return_settings',
      columns: 'return_address_name, return_address_postal_code, return_address_line, return_address_phone',
      filters: [['eq', 'id', 1]],
    });
    // 受け取りの表・お届けの目安・返金待ちの関数は、受付のお知らせでは読まない
    expect(db.tablesRead()).not.toContain('order_return_receipts');
    expect(db.tablesRead()).not.toContain('order_return_receipt_lines');
    expect(db.tablesRead()).not.toContain('items');
    expect(db.rpcCalls).toEqual([]);
  });

  it('返送不要の返品は、返送先の設定を読まない', async () => {
    const { orderReturn, db } = await loadReturn(
      returnTables({ order_returns: { data: { ...RETURN_ROW, return_method: 'not_required' } } }),
      { returnId: RETURN_ID },
    );

    expect(orderReturn?.returnAddress).toBeNull();
    expect(orderReturn?.returnMethod).toBe('not_required');
    expect(db.tablesRead()).not.toContain('shop_return_settings');
  });

  it.each([
    ['設定の行が無い', { data: null }],
    ['4つとも空', { data: { return_address_name: null, return_address_postal_code: null, return_address_line: null, return_address_phone: null } }],
    ['電話番号が空', { data: { ...SETTINGS_ROW, return_address_phone: null } }],
    ['名前が空文字', { data: { ...SETTINGS_ROW, return_address_name: '' } }],
  ])('返送先の設定が揃っていなければ、返送先は null（書くかどうかは本文の側が決める）: %s', async (_label, settings) => {
    const { orderReturn } = await loadReturn(returnTables({ shop_return_settings: settings }), { returnId: RETURN_ID });

    expect(orderReturn?.returnAddress).toBeNull();
    expect(orderReturn?.items).toHaveLength(4);
  });

  it('交換の行が無い返品は、交換の色・サイズ（item_variants）を読まない。返金の行が無ければ hasRefundLines は false', async () => {
    const exchangeOnly = RETURN_LINES.filter((line) => line.resolution === 'exchange');
    const refundOnly = RETURN_LINES.filter((line) => line.resolution === 'refund');

    const noExchange = await loadReturn(returnTables({ order_return_lines: { data: refundOnly } }), { returnId: RETURN_ID });
    const noRefund = await loadReturn(returnTables({ order_return_lines: { data: exchangeOnly } }), { returnId: RETURN_ID });

    expect(noExchange.orderReturn).toMatchObject({ exchangePlan: [], hasRefundLines: true, items: [COAT, STOLE] });
    expect(noExchange.db.tablesRead()).not.toContain('item_variants');
    expect(noRefund.orderReturn).toMatchObject({ hasRefundLines: false, items: [DRESS, BLOUSE] });
  });

  it('同じ商品の行は数を足して1行にまとめ、同じ品名・色・サイズ・送り方の交換の品も1行にまとめる', async () => {
    const lines = [
      { id: 'line-a', order_item_id: 'item-dress', quantity: 1, resolution: 'exchange', exchange_variant_id: 9002, exchange_method: 'stock' },
      { id: 'line-b', order_item_id: 'item-dress', quantity: 2, resolution: 'exchange', exchange_variant_id: 9002, exchange_method: 'stock' },
      { id: 'line-c', order_item_id: 'item-dress', quantity: 1, resolution: 'exchange', exchange_variant_id: 9002, exchange_method: 'make' },
    ];

    const { orderReturn } = await loadReturn(returnTables({ order_return_lines: { data: lines } }), { returnId: RETURN_ID });

    expect(orderReturn?.items).toEqual([{ ...DRESS, quantity: 4 }]);
    expect(orderReturn?.exchangePlan).toEqual([
      { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 3, method: 'stock', leadDays: null },
      { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'make', leadDays: null },
    ]);
  });

  it.each([
    ['お支払い待ち（手数料の受け取りも、支払いを待たずに送るも無い）', 1100, null, null, 1100],
    ['手数料を受け取った', 1100, '2026-10-12T01:00:00.000000+00:00', null, 0],
    ['支払いを待たずに送れるようにした', 1100, null, '2026-10-12T01:00:00.000000+00:00', 0],
    ['お支払いの額が0', 0, null, null, 0],
  ] as const)('手数料のお支払い待ちの額: %s', async (_label, due, receivedAt, releasedAt, expected) => {
    const { orderReturn } = await loadReturn(
      returnTables({
        order_returns: { data: { ...RETURN_ROW, fee_due_amount: due, fee_received_at: receivedAt, exchange_released_at: releasedAt } },
      }),
      { returnId: RETURN_ID },
    );

    expect(orderReturn?.feeWaitingAmount).toBe(expected);
  });

  it('返品が無い・返品の行が無い・返品の行の商品がこの注文に無い・交換の色とサイズが読めなければ null（送れない）', async () => {
    const noReturn = await loadReturn(returnTables({ order_returns: { data: null } }), { returnId: RETURN_ID });
    const noLines = await loadReturn(returnTables({ order_return_lines: { data: [] } }), { returnId: RETURN_ID });
    const foreignItem = await loadReturn(
      returnTables({ order_items: (columns) => ({ data: columns.startsWith('item_name') ? BASE_ITEMS : ITEM_ROWS.filter((item) => item.id !== 'item-coat') }) }),
      { returnId: RETURN_ID },
    );
    const noVariant = await loadReturn(returnTables({ item_variants: { data: [VARIANTS[0]] } }), { returnId: RETURN_ID });
    const noMethod = await loadReturn(
      returnTables({ order_return_lines: { data: [{ ...RETURN_LINES[0], exchange_method: null }] } }),
      { returnId: RETURN_ID },
    );

    for (const material of [noReturn, noLines, foreignItem, noVariant, noMethod]) {
      expect(material.orderReturn).toBeNull();
    }
    // 材料全体も null（worker は送れなかった: source_missing にする）
    const whole = fakeStore(returnTables({ order_returns: { data: null } }));
    await expect(load(whole, { returnId: RETURN_ID })).resolves.toBeNull();
  });
});

describe('loadOrderEmailMaterial（受け取りの材料）', () => {
  it('受け取りの番号があれば、その受け取りの返品を読み、受け取った品・お返しの品・実際に決まった交換の品を返す', async () => {
    const { orderReturn, db } = await loadReturn(
      returnTables({
        order_return_receipts: {
          data: {
            ...RECEIPT_ROW,
            refund_choice: 'consult',
            sent_back_message: '使用の跡があり、お返しいたします。',
            sent_back_carrier: 'yamato',
            sent_back_tracking_number: '1234-5678',
          },
        },
      }),
      { returnId: RETURN_ID, returnReceiptId: RECEIPT_ID },
    );

    expect(orderReturn).toEqual({
      number: 2,
      returnMethod: 'shop_label',
      returnShippingPayer: 'customer',
      returnShippingFee: 800,
      restockingFeePercent: 10,
      exchangeFee: 500,
      exchangeShippingFee: 600,
      feeWaitingAmount: 0,
      // 受け取りの材料では、受付のお知らせの中身は読まない
      returnAddress: null,
      items: [],
      exchangePlan: [],
      hasRefundLines: false,
      receipt: {
        refundChoice: 'consult',
        // 検品待ち・戻す・戻さないはどれも受け取った品。返金しないことにした数（refund_waived）は足さない。ブラウスは2つの行を足して2点
        received: [COAT, DRESS, BLOUSE],
        sentBack: [STOLE],
        sentBackMessage: '使用の跡があり、お返しいたします。',
        sentBackCarrier: 'yamato',
        sentBackTrackingNumber: '1234-5678',
        // 予定ではなく実際の解決: ワンピースは在庫不足で作って送るに変わった。ブラウスは2点のうち1点を返金に変えたので1点
        exchanges: [
          { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'make', leadDays: 21 },
          { item_name: 'ブラウス', color: 'WHITE', size: 'L', quantity: 1, method: 'make', leadDays: null },
        ],
        pendingRefund: null,
        // RECEIPT_LINES に返金しないことにした数（refund_waived）の行がある（本計画 P24）。受け取りの記録に返金の番号は無い（本計画 P25）
        refundWaived: true,
        refundNotAccepted: false,
      },
    });
    expect(db.queryOf('order_return_receipts')).toEqual({
      table: 'order_return_receipts',
      columns: 'id, return_id, refund_choice, refund_id, actor_can_refund, sent_back_message, sent_back_carrier, sent_back_tracking_number',
      filters: [['eq', 'id', RECEIPT_ID]],
    });
    // 返品は受け取りが指す返品を、注文の番号でも絞って読む
    expect(db.queryOf('order_returns').filters).toEqual([['eq', 'id', RETURN_ID], ['eq', 'order_id', ORDER_ID]]);
    expect(db.queryOf('order_return_receipt_lines')).toEqual({
      table: 'order_return_receipt_lines',
      columns: 'return_line_id, disposition, quantity, resolution, exchange_method',
      filters: [['eq', 'receipt_id', RECEIPT_ID]],
    });
    // 交換の色・サイズは、実際に交換にした行の分だけ。お届けの目安は、作って送る品の商品だけ
    expect(db.queryOf('item_variants').filters).toEqual([['in', 'id', [9002, 9003]]]);
    expect(db.queryOf('items')).toEqual({
      table: 'items',
      columns: 'id, made_to_order_lead_days',
      filters: [['in', 'id', [102, 103]]],
    });
    expect(db.tablesRead()).not.toContain('shop_return_settings');
    expect(db.rpcCalls).toEqual([]);
  });

  it('受け取りの番号だけでも読める（返品の番号は受け取りの記録から分かる）。返品の番号と両方あれば受け取りを優先する', async () => {
    const onlyReceipt = await loadReturn(returnTables(), { returnReceiptId: RECEIPT_ID });
    const both = await loadReturn(returnTables(), { returnId: 'ignored-return-id', returnReceiptId: RECEIPT_ID });

    expect(onlyReceipt.orderReturn?.receipt?.received).toEqual([COAT, DRESS, BLOUSE]);
    expect(both.orderReturn).toEqual(onlyReceipt.orderReturn);
    expect(both.db.queryOf('order_returns').filters).toEqual([['eq', 'id', RETURN_ID], ['eq', 'order_id', ORDER_ID]]);
  });

  it('在庫から交換の品だけを受け取った時は、お届けの目安（items）を読まず、目安は null', async () => {
    const stockOnly = [
      { return_line_id: 'line-2', disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: 'stock' },
    ];

    const { orderReturn, db } = await loadReturn(
      returnTables({ order_return_receipt_lines: { data: stockOnly } }),
      { returnReceiptId: RECEIPT_ID },
    );

    expect(orderReturn?.receipt?.exchanges).toEqual([
      { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'stock', leadDays: null },
    ]);
    expect(db.tablesRead()).not.toContain('items');
  });

  it('交換の品が無い受け取りは、交換の色・サイズも目安も読まない。受け取った品が1行だけでも形は同じ', async () => {
    const refundOnly = [{ return_line_id: 'line-1', disposition: 'not_restocked', quantity: 1, resolution: 'refund', exchange_method: null }];

    const { orderReturn, db } = await loadReturn(
      returnTables({ order_return_receipt_lines: { data: refundOnly } }),
      { returnReceiptId: RECEIPT_ID },
    );

    expect(orderReturn?.receipt).toEqual({
      refundChoice: 'none', received: [COAT], sentBack: [], sentBackMessage: null, sentBackCarrier: null,
      sentBackTrackingNumber: null, exchanges: [], pendingRefund: null, refundWaived: false, refundNotAccepted: false,
    });
    expect(db.tablesRead()).not.toContain('item_variants');
    expect(db.tablesRead()).not.toContain('items');
  });

  it('同じ品名・色・サイズ・送り方の交換の品は数を足して1行にし、作って送るの目安は商品ごとに引く', async () => {
    const lines = [
      { return_line_id: 'line-2', disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: 'make' },
      { return_line_id: 'line-2', disposition: 'not_restocked', quantity: 2, resolution: 'exchange', exchange_method: 'make' },
      { return_line_id: 'line-3', disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: 'stock' },
    ];

    const { orderReturn } = await loadReturn(returnTables({ order_return_receipt_lines: { data: lines } }), { returnReceiptId: RECEIPT_ID });

    expect(orderReturn?.receipt?.exchanges).toEqual([
      { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 3, method: 'make', leadDays: 21 },
      { item_name: 'ブラウス', color: 'WHITE', size: 'L', quantity: 1, method: 'stock', leadDays: null },
    ]);
  });

  it('交換の品を C・B・A の順で読んでも、C と A をまとめた行は早い元商品 A の位置で B より先に出る', async () => {
    const originals = [
      { ...ITEM_ROWS.find((item) => item.id === 'item-coat')!, id: 'item-a' },
      { ...ITEM_ROWS.find((item) => item.id === 'item-dress')!, id: 'item-b' },
      { ...ITEM_ROWS.find((item) => item.id === 'item-blouse')!, id: 'item-c', item_name: 'コート' },
    ];
    const lines = originals.map((item, index) => ({
      id: `line-${index}`, order_item_id: item.id, quantity: 1, resolution: 'exchange',
      exchange_variant_id: index === 1 ? 9002 : 9003, exchange_method: 'stock',
    }));
    // 取得順が変わっても、まとめた交換の品の位置は最も早い元商品の登録順で決まる。
    const received = [lines[2], lines[1], lines[0]].map((line) => ({
      return_line_id: line.id, disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: 'stock',
    }));
    const { orderReturn } = await loadReturn(returnTables({
      order_items: (columns) => ({ data: columns.startsWith('item_name') ? BASE_ITEMS : originals }),
      order_return_lines: { data: lines }, order_return_receipt_lines: { data: received },
    }), { returnReceiptId: RECEIPT_ID });

    expect(orderReturn?.receipt?.exchanges).toEqual([
      { item_name: 'コート', color: 'WHITE', size: 'L', quantity: 2, method: 'stock', leadDays: null },
      { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'stock', leadDays: null },
    ]);
  });

  it.each([
    ['ヤマト運輸', 'yamato', 'yamato'],
    ['佐川急便', 'sagawa', 'sagawa'],
    ['日本郵便', 'japanpost', 'japanpost'],
    ['その他', 'other', 'other'],
    ['知らない業者', 'dhl', null],
    ['業者を入れていない', null, null],
  ])('送り返しの配送業者 %s は、知っている業者だけ通す', async (_label, carrier, expected) => {
    const { orderReturn } = await loadReturn(
      returnTables({ order_return_receipts: { data: { ...RECEIPT_ROW, sent_back_carrier: carrier } } }),
      { returnReceiptId: RECEIPT_ID },
    );

    expect(orderReturn?.receipt?.sentBackCarrier).toBe(expected);
  });

  it('返金できない人（サポート）の受け取りだけ、返金待ちの品と計算どおりの額（返品の fee_pending_deduction を引き、0未満にしない）を list_order_returns から読む', async () => {
    const detail = {
      id: RETURN_ID,
      lines: [
        { order_item_id: 'item-coat', item_name: 'コート', color: 'BLACK', size: 'M', resolution: 'refund', progress: { refund_waiting: 1 }, refund_waiting_amount: 5000 },
        { order_item_id: 'item-stole', item_name: 'ストール', color: null, size: null, resolution: 'refund', progress: { refund_waiting: 1 }, refund_waiting_amount: 1000 },
        { order_item_id: 'item-stole', item_name: 'ストール', color: null, size: null, resolution: 'refund', progress: { refund_waiting: 1 }, refund_waiting_amount: 1200 },
        // 予定は交換でも、受け取りで店長が返金に変えた分は、返金待ちの数に入る（数え方は DB が決める。予定の解決は見ない）
        { order_item_id: 'item-dress', item_name: 'ワンピース', color: 'NAVY', size: 'S', resolution: 'exchange', progress: { refund_waiting: 1 }, refund_waiting_amount: 3000 },
        // 返金済み・返金待ちが0の行は数えない（交換のままの行も、返金済みの行も）
        { order_item_id: 'item-dress', item_name: 'ワンピース', color: 'NAVY', size: 'S', resolution: 'exchange', progress: { refund_waiting: 0 }, refund_waiting_amount: 0 },
        { order_item_id: 'item-blouse', item_name: 'ブラウス', color: 'WHITE', size: 'S', resolution: 'refund', progress: { refund_waiting: 0 }, refund_waiting_amount: 0 },
      ],
    };

    const supporter = await loadReturn(
      returnTables({ order_return_receipts: { data: { ...RECEIPT_ROW, actor_can_refund: false } } }),
      { returnReceiptId: RECEIPT_ID },
      { list_order_returns: { data: [{ id: 'other-return', lines: [] }, detail] } },
    );
    const manager = await loadReturn(returnTables(), { returnReceiptId: RECEIPT_ID }, { list_order_returns: { data: [detail] } });
    const unknown = await loadReturn(
      returnTables({ order_return_receipts: { data: { ...RECEIPT_ROW, actor_can_refund: false } } }),
      { returnReceiptId: RECEIPT_ID },
      { list_order_returns: { data: [{ id: 'other-return', lines: [] }] } },
    );
    // 相談の受け取りで付いた手数料（fee_pending_deduction）は、額を決めて返金の計算どおりの額と同じく、商品の額から引く。0未満にはしない
    const supporterReceipt = { order_return_receipts: { data: { ...RECEIPT_ROW, actor_can_refund: false } } };
    const withFee = await loadReturn(
      returnTables({ ...supporterReceipt, order_returns: { data: { ...RETURN_ROW, fee_pending_deduction: 1500 } } }),
      { returnReceiptId: RECEIPT_ID },
      { list_order_returns: { data: [detail] } },
    );
    const feeOverGoods = await loadReturn(
      returnTables({ ...supporterReceipt, order_returns: { data: { ...RETURN_ROW, fee_pending_deduction: 20000 } } }),
      { returnReceiptId: RECEIPT_ID },
      { list_order_returns: { data: [detail] } },
    );

    expect(supporter.orderReturn?.receipt?.pendingRefund).toEqual({
      items: [COAT, { item_name: 'ストール', color: null, size: null, quantity: 2 }, DRESS],
      amount: 10200,
    });
    expect(supporter.db.rpcCalls).toEqual([{ name: 'list_order_returns', args: { _order_id: ORDER_ID } }]);
    expect(manager.orderReturn?.receipt?.pendingRefund).toBeNull();
    expect(manager.db.rpcCalls).toEqual([]);
    expect(unknown.orderReturn?.receipt?.pendingRefund).toBeNull();
    expect(withFee.orderReturn?.receipt?.pendingRefund?.amount).toBe(8700);
    expect(feeOverGoods.orderReturn?.receipt?.pendingRefund?.amount).toBe(0);
    expect(feeOverGoods.orderReturn?.receipt?.pendingRefund?.items).toHaveLength(3);
  });

  it('受け取りの行に返金しないことにした数（refund_waived）があれば refundWaived は true、無ければ false。その数は受け取った品に足さない（本計画 P24）', async () => {
    const withWaived = await loadReturn(returnTables(), { returnReceiptId: RECEIPT_ID });
    const withoutWaived = await loadReturn(
      returnTables({ order_return_receipt_lines: { data: RECEIPT_LINES.filter((line) => line.disposition !== 'refund_waived') } }),
      { returnReceiptId: RECEIPT_ID },
    );

    expect(withWaived.orderReturn?.receipt?.refundWaived).toBe(true);
    expect(withoutWaived.orderReturn?.receipt?.refundWaived).toBe(false);
    expect(withWaived.orderReturn?.receipt?.received).toEqual(withoutWaived.orderReturn?.receipt?.received);
  });

  it.each([
    ['error', true],
    ['failed', true],
    ['pending', false],
    ['succeeded', false],
    ['awaiting_response', false],
  ] as const)('受け取りの記録に返金の番号があれば、その返金の状態を注文の番号でも絞って読む。%s なら refundNotAccepted は %s（本計画 P25）', async (status, expected) => {
    const { orderReturn, db } = await loadReturn(
      returnTables({
        order_return_receipts: { data: { ...RECEIPT_ROW, refund_choice: 'now', refund_id: REFUND_ID } },
        order_refunds: { data: { status } },
      }),
      { returnId: RETURN_ID, returnReceiptId: RECEIPT_ID },
    );

    expect(orderReturn?.receipt?.refundNotAccepted).toBe(expected);
    expect(db.queryOf('order_refunds')).toEqual({
      table: 'order_refunds',
      columns: 'status',
      filters: [['eq', 'id', REFUND_ID], ['eq', 'order_id', ORDER_ID]],
    });
  });

  it('受け取りの記録に返金の番号が無ければ返金の表を読まない。返金の記録が無ければ null、読めなければ OrderEmailMaterialError（本計画 P25）', async () => {
    const receiptWithRefund = { order_return_receipts: { data: { ...RECEIPT_ROW, refund_choice: 'now', refund_id: REFUND_ID } } };
    const noRefund = await loadReturn(returnTables(), { returnReceiptId: RECEIPT_ID });
    const missing = await loadReturn(returnTables({ ...receiptWithRefund, order_refunds: { data: null } }), { returnReceiptId: RECEIPT_ID });

    expect(noRefund.orderReturn?.receipt?.refundNotAccepted).toBe(false);
    expect(noRefund.db.tablesRead()).not.toContain('order_refunds');
    expect(missing.orderReturn).toBeNull();
    await expect(
      load(fakeStore(returnTables({ ...receiptWithRefund, order_refunds: { error: { message: 'down' } } })), { returnReceiptId: RECEIPT_ID }),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_refunds' });
  });

  it('受け取りが無い・受け取りの行が別の返品の行を指す・交換にしたのに送り方か色・サイズが無ければ null（送れない）', async () => {
    const noReceipt = await loadReturn(returnTables({ order_return_receipts: { data: null } }), { returnReceiptId: RECEIPT_ID });
    const foreignLine = await loadReturn(
      returnTables({ order_return_receipt_lines: { data: [{ return_line_id: 'line-of-other-return', disposition: 'restocked', quantity: 1, resolution: 'refund', exchange_method: null }] } }),
      { returnReceiptId: RECEIPT_ID },
    );
    const noMethod = await loadReturn(
      returnTables({ order_return_receipt_lines: { data: [{ return_line_id: 'line-2', disposition: 'restocked', quantity: 1, resolution: 'exchange', exchange_method: null }] } }),
      { returnReceiptId: RECEIPT_ID },
    );
    const noVariant = await loadReturn(returnTables({ item_variants: { data: [] } }), { returnReceiptId: RECEIPT_ID });

    for (const material of [noReceipt, foreignLine, noMethod, noVariant]) {
      expect(material.orderReturn).toBeNull();
    }
  });
});

describe('loadOrderEmailMaterial（返品の返金のお知らせの材料）', () => {
  const REFUND_ROW = {
    status: 'succeeded', amount: 5000, shipping_amount: 0, payment_method_type: 'card', customer_action_expires_at: null, cancel_reason: null,
  };
  const REFUND_LINES = [
    { order_item_id: 'item-coat', quantity: 1, before_shipment: false, order_items: { item_name: 'コート', color: 'BLACK', size: 'M', created_at: '2026-10-10T01:00:00.000000+00:00' } },
  ];

  it('返金の番号と受け取りの番号があれば（受け取りと一緒の返金）、返金と受け取りの両方を読む', async () => {
    const db = fakeStore(returnTables({ order_refunds: { data: REFUND_ROW }, order_refund_lines: { data: REFUND_LINES } }));

    const material = await load(db, { refundId: REFUND_ID, returnId: RETURN_ID, returnReceiptId: RECEIPT_ID });

    expect(material?.refund).toMatchObject({ status: 'succeeded', amount: 5000, stillShipping: false });
    expect(material?.orderReturn?.receipt?.received).toEqual([COAT, DRESS, BLOUSE]);
    expect(material?.orderReturn?.receipt?.exchanges).toHaveLength(2);
    expect(db.queryOf('order_refunds').filters).toEqual([['eq', 'id', REFUND_ID], ['eq', 'order_id', ORDER_ID]]);
  });

  it('返金の番号と返品の番号だけで受け取りの番号が無ければ（額を決めて後で返した返金）、返品の番号と手数料の状態だけを読む', async () => {
    const db = fakeStore(returnTables({ order_refunds: { data: REFUND_ROW }, order_refund_lines: { data: REFUND_LINES } }));

    const material = await load(db, { refundId: REFUND_ID, returnId: RETURN_ID });

    expect(material?.orderReturn).toEqual({
      number: 2,
      returnMethod: 'shop_label',
      returnShippingPayer: 'customer',
      returnShippingFee: 800,
      restockingFeePercent: 10,
      exchangeFee: 500,
      exchangeShippingFee: 600,
      feeWaitingAmount: 0,
      returnAddress: null,
      items: [],
      exchangePlan: [],
      hasRefundLines: false,
      receipt: null,
    });
    expect(db.tablesRead()).toContain('order_returns');
    expect(db.tablesRead()).not.toContain('order_return_lines');
    expect(db.tablesRead()).not.toContain('order_return_receipts');
    expect(db.tablesRead()).not.toContain('order_return_receipt_lines');
    expect(db.tablesRead()).not.toContain('shop_return_settings');
  });

  it('返品の番号も受け取りの番号も無い返金は、返品の表を読まず、返品の材料は null', async () => {
    const db = fakeStore(returnTables({ order_refunds: { data: REFUND_ROW }, order_refund_lines: { data: REFUND_LINES } }));

    const material = await load(db, { refundId: REFUND_ID });

    expect(material?.orderReturn).toBeNull();
    expect(db.tablesRead().filter((table) => table.startsWith('order_return'))).toEqual([]);
  });
});

describe('loadOrderEmailMaterial（返品の番号が無い時と読めない時）', () => {
  it('返品の番号も受け取りの番号も無ければ、返品の表を読まず、返品の材料は null（今までの種類のメールの材料は変わらない）', async () => {
    const db = fakeStore(returnTables());

    const material = await load(db, {});

    expect(material).toEqual({ order: ORDER_ROW, items: BASE_ITEMS, fulfillment: null, refund: null, orderReturn: null });
    expect(db.tablesRead()).toEqual(['orders', 'order_items']);
  });

  it.each([
    ['order_returns', { returnId: RETURN_ID }],
    ['order_return_lines', { returnId: RETURN_ID }],
    ['order_items', { returnId: RETURN_ID }],
    ['item_variants', { returnId: RETURN_ID }],
    ['shop_return_settings', { returnId: RETURN_ID }],
    ['order_return_receipts', { returnReceiptId: RECEIPT_ID }],
    ['order_return_receipt_lines', { returnReceiptId: RECEIPT_ID }],
    ['items', { returnReceiptId: RECEIPT_ID }],
  ] as const)('%s を読めなければ OrderEmailMaterialError を投げる（worker は一時的な失敗としてやり直す）', async (table, ids) => {
    const failing = returnTables({
      // 注文の明細は2回読む。最初（全部の種類が読む）は成功させ、返品の品の読み込みを失敗させる
      ...(table === 'order_items'
        ? { order_items: (columns: string) => (columns.startsWith('item_name') ? { data: BASE_ITEMS } : { error: { message: 'down' } }) }
        : { [table]: { error: { message: 'down' } } }),
    });

    await expect(load(fakeStore(failing), ids)).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table });
    await expect(load(fakeStore(failing), ids)).rejects.toBeInstanceOf(OrderEmailMaterialError);
  });

  it('返金待ちの関数（list_order_returns）を読めなければ OrderEmailMaterialError を投げる', async () => {
    const db = fakeStore(
      returnTables({ order_return_receipts: { data: { ...RECEIPT_ROW, actor_can_refund: false } } }),
      { list_order_returns: { error: { message: 'down' } } },
    );

    await expect(load(db, { returnReceiptId: RECEIPT_ID })).rejects.toMatchObject({
      name: 'OrderEmailMaterialError',
      table: 'list_order_returns',
    });
  });
});
