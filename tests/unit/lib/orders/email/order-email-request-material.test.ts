import { loadRequestEmailMaterial, OrderEmailMaterialError } from '@/lib/orders/email/order-email-compose';
import type { RequestEmailKind } from '@/lib/orders/email/order-email-types';

/**
 * 申し込みのメールの材料の読み込み（グループ E-3 段2 計画 C-6）。読む表・列・絞り込み・並び・形の変換を確かめる。
 * 本物の PostgREST でしか確かめられない所（列の名前・埋め込み）は、DB 結合テスト
 * order_email_request_material_postgrest.integration.test.ts が確かめる
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const CANCEL_REQUEST_ID = 'c1b2c3d4-1111-2222-8333-444455556666';

const ORDER_ROW = {
  id: ORDER_ID,
  status: 'paid',
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
  review_reason: null, cancel_reason: null,
};

const DECLINE_MESSAGE = '受付の期限を過ぎているため、お受けできませんでした。';
const RETURN_ROW = { number: 2, decline_message: null };

// 注文の商品（登録順: コート → ワンピース → ブラウス）。DB が返す順は登録順と限らない
const ITEM_ROWS = [
  { id: 'item-blouse', item_name: 'ブラウス', color: 'WHITE', size: 'S', created_at: '2026-10-10T01:00:02.000000+00:00' },
  { id: 'item-coat', item_name: 'コート', color: 'BLACK', size: 'M', created_at: '2026-10-10T01:00:00.000000+00:00' },
  { id: 'item-dress', item_name: 'ワンピース', color: 'NAVY', size: 'S', created_at: '2026-10-10T01:00:01.000000+00:00' },
];

// 返品の行（DB が返す順は番号の順と限らない）。ご希望は、申し込んだ時の値
const REQUEST_LINES = [
  { id: 'line-3', order_item_id: 'item-blouse', quantity: 2, reason: 'color', requested_resolution: 'exchange', requested_exchange_variant_id: 9003 },
  { id: 'line-1', order_item_id: 'item-coat', quantity: 1, reason: 'defective', requested_resolution: 'refund', requested_exchange_variant_id: null },
  { id: 'line-2', order_item_id: 'item-dress', quantity: 1, reason: 'size_too_small', requested_resolution: 'exchange', requested_exchange_variant_id: 9002 },
];

const VARIANTS = [
  { id: 9003, item_id: 103, item_colors: { name: 'WHITE' }, item_sizes: { label: 'L' } },
  { id: 9002, item_id: 102, item_colors: { name: 'NAVY' }, item_sizes: { label: 'M' } },
];

// 写真は line-1 に2枚、line-2 に1枚（line-3 には無い）。消した写真も1行として入っている
const PHOTO_ROWS = [{ return_line_id: 'line-1' }, { return_line_id: 'line-2' }, { return_line_id: 'line-1' }];

const CANCEL_ROW = { decline_message: null };
const CANCEL_LINES = [
  { order_item_id: 'item-blouse', quantity: 1 },
  { order_item_id: 'item-coat', quantity: 2 },
];

// 商品の登録順（コート → ワンピース → ブラウス）に並べた、返品の行の期待
const EXPECTED_RETURN_LINES = [
  { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, reason: 'defective', requestedResolution: 'refund', requestedExchange: null },
  {
    item_name: 'ワンピース', color: 'NAVY', size: 'S', quantity: 1, reason: 'size_too_small',
    requestedResolution: 'exchange', requestedExchange: { color: 'NAVY', size: 'M' },
  },
  {
    item_name: 'ブラウス', color: 'WHITE', size: 'S', quantity: 2, reason: 'color',
    requestedResolution: 'exchange', requestedExchange: { color: 'WHITE', size: 'L' },
  },
];

type Result = { data?: unknown; error?: unknown };
type TableEntry = Result | ((columns: string) => Result);
type Filter = ['eq' | 'in', string, unknown];

/**
 * 表ごとの答えを返す偽の client。問い合わせの列・絞り込みを控える。
 * 答えは `await` でも `.maybeSingle()` でも返る（本物の PostgREST の builder と同じ）
 */
function fakeStore(tables: Record<string, TableEntry>) {
  const queries: Array<{ table: string; columns: string; filters: Filter[] }> = [];
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
  const tablesRead = () => queries.map((query) => query.table);
  const queryOf = (table: string, index = 0) => queries.filter((query) => query.table === table)[index];
  return { client: { from } as never, queries, tablesRead, queryOf };
}

/** 注文（どの種類のメールも読む）に、申し込みの表を足した答えの一式 */
function defaultTables(overrides: Record<string, TableEntry> = {}): Record<string, TableEntry> {
  return {
    orders: { data: ORDER_ROW },
    order_returns: { data: RETURN_ROW },
    order_return_lines: { data: REQUEST_LINES },
    order_items: { data: ITEM_ROWS },
    item_variants: { data: VARIANTS },
    order_return_photos: { data: PHOTO_ROWS },
    order_cancel_requests: { data: CANCEL_ROW },
    order_cancel_request_lines: { data: CANCEL_LINES },
    ...overrides,
  };
}

function load(
  db: ReturnType<typeof fakeStore>,
  kind: RequestEmailKind,
  ids: { returnId?: string | null; cancelRequestId?: string | null } = {},
) {
  return loadRequestEmailMaterial(db.client, ORDER_ID, {
    kind,
    returnId: ids.returnId ?? null,
    cancelRequestId: ids.cancelRequestId ?? null,
  });
}

describe('loadRequestEmailMaterial（返品のお申し込みの受付）', () => {
  it('返品の番号で、返品・返品の行・元の品・交換のご希望の色とサイズを読み、商品の登録順に並べて返す。写真の数は読まない', async () => {
    const db = fakeStore(defaultTables());

    const material = await load(db, 'return_requested', { returnId: RETURN_ID });

    expect(material?.request).toEqual({
      kind: 'return',
      number: 2,
      declineMessage: null,
      lines: EXPECTED_RETURN_LINES.map((line) => ({ ...line, photoCount: 0 })),
    });
    // 注文の行（宛名・送り先のメール）と申し込みだけを持つ。明細・発送・返金・返品の材料は付けない
    expect(material).toMatchObject({ order: ORDER_ROW, items: [], fulfillment: null, refund: null, orderReturn: null });
    expect(db.tablesRead()).toEqual(['orders', 'order_returns', 'order_return_lines', 'order_items', 'item_variants']);
    expect(db.queryOf('orders').filters).toEqual([['eq', 'id', ORDER_ID]]);
    expect(db.queryOf('orders').columns.split(',').map((column) => column.trim())).toContain('cancel_reason');
    // 返品は注文の番号でも絞って読む
    expect(db.queryOf('order_returns')).toEqual({
      table: 'order_returns',
      columns: 'number, decline_message',
      filters: [['eq', 'id', RETURN_ID], ['eq', 'order_id', ORDER_ID]],
    });
    expect(db.queryOf('order_return_lines')).toEqual({
      table: 'order_return_lines',
      columns: 'id, order_item_id, quantity, reason, requested_resolution, requested_exchange_variant_id',
      filters: [['eq', 'return_id', RETURN_ID]],
    });
    // 元の品は、返品の行が指す商品だけを、この注文の中から読む（番号の順に並べた返品の行の順で、重ねずに）
    expect(db.queryOf('order_items')).toEqual({
      table: 'order_items',
      columns: 'id, item_name, color, size, created_at',
      filters: [['eq', 'order_id', ORDER_ID], ['in', 'id', ['item-coat', 'item-dress', 'item-blouse']]],
    });
    expect(db.queryOf('item_variants')).toEqual({
      table: 'item_variants',
      columns: 'id, item_id, item_colors(name), item_sizes(label)',
      filters: [['in', 'id', [9002, 9003]]],
    });
  });

  it('店への知らせの材料は、写真の数を返品の行ごとに数える（消した写真も1枚として数え、写真が無い行は 0）', async () => {
    const db = fakeStore(defaultTables());

    const material = await load(db, 'return_request_shop', { returnId: RETURN_ID });

    expect(material?.request).toEqual({
      kind: 'return',
      number: 2,
      declineMessage: null,
      lines: EXPECTED_RETURN_LINES.map((line, index) => ({ ...line, photoCount: [2, 1, 0][index] })),
    });
    expect(db.tablesRead()).toEqual([
      'orders', 'order_returns', 'order_return_lines', 'order_items', 'item_variants', 'order_return_photos',
    ]);
    expect(db.queryOf('order_return_photos')).toEqual({
      table: 'order_return_photos',
      columns: 'return_line_id',
      filters: [['in', 'return_line_id', ['line-1', 'line-2', 'line-3']]],
    });
  });

  it('お断りのお知らせの材料は、返品の番号とお断りのメッセージだけを読む（品・交換の色とサイズ・写真は読まない）', async () => {
    const db = fakeStore(defaultTables({ order_returns: { data: { number: 2, decline_message: DECLINE_MESSAGE } } }));

    const material = await load(db, 'return_declined', { returnId: RETURN_ID });

    expect(material?.request).toEqual({ kind: 'return', number: 2, declineMessage: DECLINE_MESSAGE, lines: [] });
    expect(db.tablesRead()).toEqual(['orders', 'order_returns']);
  });

  it('お客様の詳しい内容（customer_note）・ご連絡事項・写真の場所は、どの種類でも読まない', async () => {
    const stores = [
      ['return_requested', fakeStore(defaultTables()), { returnId: RETURN_ID }],
      ['return_declined', fakeStore(defaultTables()), { returnId: RETURN_ID }],
      ['return_request_shop', fakeStore(defaultTables()), { returnId: RETURN_ID }],
      ['cancel_request_received', fakeStore(defaultTables()), { cancelRequestId: CANCEL_REQUEST_ID }],
      ['cancel_request_declined', fakeStore(defaultTables()), { cancelRequestId: CANCEL_REQUEST_ID }],
      ['cancel_request_shop', fakeStore(defaultTables()), { cancelRequestId: CANCEL_REQUEST_ID }],
    ] as const;

    for (const [kind, db, ids] of stores) {
      await load(db, kind, ids);
      for (const query of db.queries) {
        expect(query.columns).not.toContain('customer_note');
        expect(query.columns).not.toContain('storage_path');
      }
    }
  });

  it('お断りのお知らせは、返品の行が無くても作れる材料になる', async () => {
    const db = fakeStore(defaultTables({ order_returns: { data: { number: 2, decline_message: DECLINE_MESSAGE } }, order_return_lines: { data: [] } }));

    const material = await load(db, 'return_declined', { returnId: RETURN_ID });

    expect(material?.request).toMatchObject({ kind: 'return', declineMessage: DECLINE_MESSAGE, lines: [] });
  });

  it('同じ商品の行は、まとめずに、返品の行の番号の順に並べる', async () => {
    const lines = [
      { id: 'line-b', order_item_id: 'item-coat', quantity: 2, reason: 'wrong_item', requested_resolution: 'refund', requested_exchange_variant_id: null },
      { id: 'line-a', order_item_id: 'item-coat', quantity: 1, reason: 'defective', requested_resolution: 'refund', requested_exchange_variant_id: null },
    ];
    const db = fakeStore(defaultTables({ order_return_lines: { data: lines } }));

    const material = await load(db, 'return_requested', { returnId: RETURN_ID });

    expect(material?.request).toMatchObject({
      lines: [
        { item_name: 'コート', quantity: 1, reason: 'defective' },
        { item_name: 'コート', quantity: 2, reason: 'wrong_item' },
      ],
    });
  });

  it('返品の番号が無い・注文が無い・返品が無い・返品の行が無い・返品の行の商品がこの注文に無い・ご希望が読めない・交換の色とサイズが読めなければ null（送れない）', async () => {
    const noId = await load(fakeStore(defaultTables()), 'return_requested', {});
    const noOrder = await load(fakeStore(defaultTables({ orders: { data: null } })), 'return_requested', { returnId: RETURN_ID });
    const noReturn = await load(fakeStore(defaultTables({ order_returns: { data: null } })), 'return_requested', { returnId: RETURN_ID });
    const noLines = await load(fakeStore(defaultTables({ order_return_lines: { data: [] } })), 'return_requested', { returnId: RETURN_ID });
    const foreignItem = await load(
      fakeStore(defaultTables({ order_items: { data: ITEM_ROWS.filter((item) => item.id !== 'item-coat') } })),
      'return_requested',
      { returnId: RETURN_ID },
    );
    const noWish = await load(
      fakeStore(defaultTables({ order_return_lines: { data: [{ ...REQUEST_LINES[1], requested_resolution: null }] } })),
      'return_requested',
      { returnId: RETURN_ID },
    );
    const noVariantId = await load(
      fakeStore(defaultTables({ order_return_lines: { data: [{ ...REQUEST_LINES[0], requested_exchange_variant_id: null }] } })),
      'return_requested',
      { returnId: RETURN_ID },
    );
    const noVariant = await load(fakeStore(defaultTables({ item_variants: { data: [VARIANTS[1]] } })), 'return_requested', { returnId: RETURN_ID });

    for (const material of [noId, noOrder, noReturn, noLines, foreignItem, noWish, noVariantId, noVariant]) {
      expect(material).toBeNull();
    }
  });

  it('お断りのお知らせも、返品が無ければ null', async () => {
    const material = await load(fakeStore(defaultTables({ order_returns: { data: null } })), 'return_declined', { returnId: RETURN_ID });

    expect(material).toBeNull();
  });
});

describe('loadRequestEmailMaterial（キャンセルのお申し込み）', () => {
  it('キャンセルの申し込みの番号で、申し込みの行・元の品を読み、商品の登録順に並べて返す', async () => {
    for (const kind of ['cancel_request_received', 'cancel_request_shop'] as const) {
      const db = fakeStore(defaultTables());

      const material = await load(db, kind, { cancelRequestId: CANCEL_REQUEST_ID });

      expect(material?.request).toEqual({
        kind: 'cancel',
        declineMessage: null,
        lines: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2 },
          { item_name: 'ブラウス', color: 'WHITE', size: 'S', quantity: 1 },
        ],
      });
      expect(material).toMatchObject({ order: ORDER_ROW, items: [], fulfillment: null, refund: null, orderReturn: null });
      expect(db.tablesRead()).toEqual(['orders', 'order_cancel_requests', 'order_cancel_request_lines', 'order_items']);
      // 申し込みは注文の番号でも絞って読む
      expect(db.queryOf('order_cancel_requests')).toEqual({
        table: 'order_cancel_requests',
        columns: 'decline_message',
        filters: [['eq', 'id', CANCEL_REQUEST_ID], ['eq', 'order_id', ORDER_ID]],
      });
      expect(db.queryOf('order_cancel_request_lines')).toEqual({
        table: 'order_cancel_request_lines',
        columns: 'order_item_id, quantity',
        filters: [['eq', 'cancel_request_id', CANCEL_REQUEST_ID]],
      });
      expect(db.queryOf('order_items').filters).toEqual([['eq', 'order_id', ORDER_ID], ['in', 'id', ['item-blouse', 'item-coat']]]);
    }
  });

  it('お断りのお知らせの材料は、お断りのメッセージだけを読む（品は読まない）', async () => {
    const db = fakeStore(defaultTables({ order_cancel_requests: { data: { decline_message: DECLINE_MESSAGE } } }));

    const material = await load(db, 'cancel_request_declined', { cancelRequestId: CANCEL_REQUEST_ID });

    expect(material?.request).toEqual({ kind: 'cancel', declineMessage: DECLINE_MESSAGE, lines: [] });
    expect(db.tablesRead()).toEqual(['orders', 'order_cancel_requests']);
  });

  it('キャンセルの申し込みの番号が無い・申し込みが無い・申し込みの行が無い・行の商品がこの注文に無ければ null（送れない）', async () => {
    const noId = await load(fakeStore(defaultTables()), 'cancel_request_received', {});
    const noRequest = await load(
      fakeStore(defaultTables({ order_cancel_requests: { data: null } })),
      'cancel_request_received',
      { cancelRequestId: CANCEL_REQUEST_ID },
    );
    const noLines = await load(
      fakeStore(defaultTables({ order_cancel_request_lines: { data: [] } })),
      'cancel_request_shop',
      { cancelRequestId: CANCEL_REQUEST_ID },
    );
    const foreignItem = await load(
      fakeStore(defaultTables({ order_items: { data: ITEM_ROWS.filter((item) => item.id !== 'item-coat') } })),
      'cancel_request_received',
      { cancelRequestId: CANCEL_REQUEST_ID },
    );
    const noDeclined = await load(
      fakeStore(defaultTables({ order_cancel_requests: { data: null } })),
      'cancel_request_declined',
      { cancelRequestId: CANCEL_REQUEST_ID },
    );

    for (const material of [noId, noRequest, noLines, foreignItem, noDeclined]) {
      expect(material).toBeNull();
    }
  });
});

describe('loadRequestEmailMaterial（読めない時）', () => {
  it('注文が無ければ null。どの申し込みも読まない', async () => {
    const db = fakeStore(defaultTables({ orders: { data: null } }));

    await expect(load(db, 'return_requested', { returnId: RETURN_ID })).resolves.toBeNull();
    expect(db.tablesRead()).toEqual(['orders']);
  });

  it.each([
    ['orders', 'return_requested'],
    ['order_returns', 'return_requested'],
    ['order_return_lines', 'return_requested'],
    ['order_items', 'return_requested'],
    ['item_variants', 'return_requested'],
    ['order_return_photos', 'return_request_shop'],
    ['order_cancel_requests', 'cancel_request_received'],
    ['order_cancel_request_lines', 'cancel_request_received'],
    ['order_items', 'cancel_request_shop'],
  ] as const)('%s の読み込みに失敗したら OrderEmailMaterialError を投げる（%s。worker は一時的な失敗としてやり直す）', async (table, kind) => {
    const db = fakeStore(defaultTables({ [table]: { error: { message: 'down' } } }));

    const failure = load(db, kind, { returnId: RETURN_ID, cancelRequestId: CANCEL_REQUEST_ID });

    await expect(failure).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(failure).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table });
  });
});
