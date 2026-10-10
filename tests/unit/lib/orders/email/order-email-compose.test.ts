import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailFulfillmentMaterial,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1b2c3d4-1111-2222-8333-444455556666';
const SPLIT_SHIPMENT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';
const REMAINING_ITEMS_NOTICE = '残りの商品は、準備ができ次第お送りします。';
const SHIPPED = { kind: 'shipped', variant: null, paymentExpiredSent: false } as const;

function material(overrides: Partial<OrderEmailMaterial['order']> = {}): OrderEmailMaterial {
  return {
    order: {
      id: ORDER_ID,
      status: 'paid',
      shipping_email: 'hanako@example.com',
      shipping_full_name: '山田 花子',
      subtotal_amount: 10000,
      shipping_amount: 0,
      discount_amount: 0,
      total_amount: 10000,
      currency: 'jpy',
      shipping_postal_code: '1500001',
      shipping_prefecture: '東京都',
      shipping_city: '渋谷区',
      shipping_address: '神宮前1-1-1',
      shipping_building: null,
      shipping_phone: '0311112222',
      review_reason: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'backorder' }],
    fulfillment: null,
  };
}

/** 発送のメールの材料。既定は、全部を送った発送（残りの案内なし） */
function shipment(overrides: Partial<OrderEmailFulfillmentMaterial> = {}): OrderEmailFulfillmentMaterial {
  return {
    number: 1,
    carrier: 'yamato',
    trackingNumber: '1234-5678',
    completesOrder: true,
    cancelled: false,
    lines: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 }],
    ...overrides,
  };
}

const STOCK_ONLY_ITEMS: OrderEmailMaterial['items'] = [
  { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'stock' },
];

const STOCK_AND_BACKORDER_ITEMS: OrderEmailMaterial['items'] = [
  { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 6000, fulfillment_type: 'stock' },
  { item_name: 'パンツ', color: 'NAVY', size: 'L', quantity: 1, line_total: 4000, fulfillment_type: 'backorder' },
];

describe('composeOrderEmail', () => {
  it('注文確認は今までと同じ件名と本文', () => {
    const email = composeOrderEmail(material(), { kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false });

    expect(email).toEqual({
      subject: '【Le Fil des Heures】ご注文ありがとうございます（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'この度はご注文いただき誠にありがとうございます。',
        'ご注文を承りました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        'ご注文内容:',
        '・コート（BLACK / M） x1　￥10,000',
        '　受注生産・発送まで数週間〜2か月以上（目安）',
        '',
        '小計: ￥10,000',
        '送料: 無料',
        '合計: ￥10,000',
        '',
        'お届け先:',
        '山田 花子 様',
        '〒1500001',
        '東京都渋谷区神宮前1-1-1',
        '0311112222',
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
  });

  it('割引があるときだけ割引の行を出す', () => {
    const email = composeOrderEmail(material({ discount_amount: 1000, total_amount: 9000 }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.text).toContain('割引: -￥1,000');
  });

  it('入金時に在庫を確保し直せなかった注文には、お届けの目安を出さない', () => {
    const email = composeOrderEmail(material({ review_reason: 'stock_not_reserved' }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.text).not.toContain('受注生産・発送まで');
  });

  it.each([
    ['入金済み', 'paid', 'order_confirmed', 'paid'],
    ['入金済み（入金を確認した）', 'paid', 'payment_received', 'paid'],
    ['入金済み（期限切れの後の入金）', 'paid', 'payment_received_after_expiry', 'paid'],
    ['入金待ち', 'awaiting_payment', null, 'pending'],
  ] as const)('在庫の品と受注生産の品が両方ある注文の確認（%s）には、先に在庫の品を送る案内を品の行の下に1行足す', (_label, kind, variant, status) => {
    const email = composeOrderEmail(
      { ...material({ status }), items: STOCK_AND_BACKORDER_ITEMS },
      { kind, variant, paymentExpiredSent: true },
    );

    // 品の行（お届けの目安の行を含む）の直下で、前後を空行で区切る
    expect(email?.text).toContain(
      ['　受注生産・発送まで数週間〜2か月以上（目安）', '', SPLIT_SHIPMENT_NOTICE, '', '小計: ￥10,000'].join('\n'),
    );
    expect(email?.text.split(SPLIT_SHIPMENT_NOTICE)).toHaveLength(2);
  });

  const noNoticeCases: Array<[string, OrderEmailMaterial]> = [
    ['在庫の品だけ', { ...material(), items: STOCK_ONLY_ITEMS }],
    ['受注生産の品だけ', material()],
    ['両方あっても在庫を確保し直せなかった', { ...material({ review_reason: 'stock_not_reserved' }), items: STOCK_AND_BACKORDER_ITEMS }],
  ];

  it.each(noNoticeCases)('%s の注文の確認には、先に在庫の品を送る案内を足さない', (_label, source) => {
    const email = composeOrderEmail(source, { kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false });
    expect(email?.text).not.toContain(SPLIT_SHIPMENT_NOTICE);
  });

  it('注文の確認でない種類のメールには、両方の品がある注文でも案内を足さない', () => {
    const both = { ...material({ status: 'failed' }), items: STOCK_AND_BACKORDER_ITEMS };

    expect(composeOrderEmail(both, { kind: 'payment_expired', variant: null, paymentExpiredSent: false })?.text)
      .not.toContain(SPLIT_SHIPMENT_NOTICE);
    expect(composeOrderEmail(both, { kind: 'canceled', variant: 'pending', paymentExpiredSent: false })?.text)
      .not.toContain(SPLIT_SHIPMENT_NOTICE);
    expect(composeOrderEmail({ ...both, fulfillment: shipment() }, SHIPPED)?.text).not.toContain(SPLIT_SHIPMENT_NOTICE);
  });

  it('期限切れの案内を送った後の入金だけ、期限切れの後の文面にする', () => {
    const sent = composeOrderEmail(material(), { kind: 'paid', variant: 'payment_received_after_expiry', paymentExpiredSent: true });
    const notSent = composeOrderEmail(material(), { kind: 'paid', variant: 'payment_received_after_expiry', paymentExpiredSent: false });

    expect(sent?.text).toContain('お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。');
    expect(notSent?.text).not.toContain('お支払い期限が過ぎたため');
    expect(notSent?.text).toContain('この度はご注文いただき誠にありがとうございます。');
  });

  it('入金待ちは件名と書き出しが変わる', () => {
    const email = composeOrderEmail(material({ status: 'pending' }), { kind: 'awaiting_payment', variant: null, paymentExpiredSent: false });
    expect(email?.subject).toBe('【お支払い待ち】ご注文を承りました（ORD-A1B2C3D4）');
    expect(email?.text).toContain('ご注文を承りました。まだお支払いは完了していません。');
  });

  it('支払い期限切れは今までと同じ件名と書き出し', () => {
    const email = composeOrderEmail(material({ status: 'failed' }), { kind: 'payment_expired', variant: null, paymentExpiredSent: false });
    expect(email?.subject).toBe('【Le Fil des Heures】お支払い期限切れのお知らせ（ORD-A1B2C3D4）');
    expect(email?.text).toContain('お支払い期限が過ぎたため、ご注文を取り消しました。');
    expect(email?.text).toContain('合計: ￥10,000');
  });

  it.each([
    ['payment_in_progress', 'お手続き中のご注文を取り消しました。'],
    ['pending', 'お支払い待ちのご注文を取り消しました。'],
  ] as const)('取消は前の状態 %s で書き出しが変わる', (variant, lead) => {
    const email = composeOrderEmail(material({ status: 'cancelled' }), { kind: 'canceled', variant, paymentExpiredSent: false });
    expect(email?.subject).toBe('【Le Fil des Heures】ご注文取消のお知らせ（ORD-A1B2C3D4）');
    expect(email?.text).toContain(lead);
  });

  it('全部を送った発送（前からの発送の写しも同じ）は、その発送の商品・配送業者・追跡のリンクを書き、値段と残りの案内は書かない', () => {
    const email = composeOrderEmail({ ...material({ status: 'shipped' }), fulfillment: shipment() }, SHIPPED);

    expect(email).toEqual({
      subject: '【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文の商品を発送いたしました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        '発送した商品:',
        '・コート（BLACK / M） x1',
        '',
        '配送業者: ヤマト運輸',
        '追跡番号: 1234-5678',
        '追跡はこちら: https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678',
        '',
        '※ 追跡情報は反映までに数時間かかる場合があります。',
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
  });

  it('未発送の品が残る発送だけ、残りの案内を※の行の次に書く。書く商品はその発送の商品だけ', () => {
    const email = composeOrderEmail(
      {
        ...material({ status: 'paid' }),
        items: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2, line_total: 20000, fulfillment_type: 'stock' },
          { item_name: 'ストール', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' },
          { item_name: 'ブーツ', color: 'BROWN', size: '25', quantity: 1, line_total: 30000, fulfillment_type: 'backorder' },
        ],
        fulfillment: shipment({
          number: 2,
          completesOrder: false,
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2 },
            { item_name: 'ストール', color: null, size: null, quantity: 1 },
          ],
        }),
      },
      SHIPPED,
    );

    expect(email?.text).toContain(
      ['発送した商品:', '・コート（BLACK / M） x2', '・ストール x1', '', '配送業者: ヤマト運輸'].join('\n'),
    );
    expect(email?.text).toContain(
      ['※ 追跡情報は反映までに数時間かかる場合があります。', REMAINING_ITEMS_NOTICE, '', 'お問い合わせの際は'].join('\n'),
    );
    // まだ送らない品の名前と、値段は書かない
    expect(email?.text).not.toContain('ブーツ');
    expect(email?.text).not.toContain('￥');
  });

  const unsendableShipments: Array<[string, OrderEmailMaterial['fulfillment']]> = [
    ['発送の材料が無い', null],
    ['配送業者が空', shipment({ carrier: null })],
    ['配送業者が知らない業者', shipment({ carrier: 'unknown' })],
    ['伝票番号が空', shipment({ trackingNumber: null })],
    ['伝票番号が空白だけ', shipment({ trackingNumber: '  ' })],
  ];

  it.each(unsendableShipments)('発送のメールは、%s なら作らない（前からの発送の記録で空のものも同じ）', (_label, fulfillment) => {
    expect(composeOrderEmail({ ...material({ status: 'shipped' }), fulfillment }, SHIPPED)).toBeNull();
  });

  it('件名には氏名も商品名も入れない', () => {
    const email = composeOrderEmail(material({ shipping_full_name: '山田\r\nBcc: x@example.com' }), {
      kind: 'paid', variant: 'order_confirmed', paymentExpiredSent: false,
    });
    expect(email?.subject).not.toContain('山田');
    expect(email?.subject).not.toContain('コート');
  });
});

describe('loadOrderEmailMaterial', () => {
  const FULFILLMENT_ROW = {
    number: 2, shipping_carrier: 'sagawa', tracking_number: '9876-5432', completes_order: false, cancelled_at: null,
  };
  const FULFILLMENT_LINE_ROWS = [
    { quantity: 2, order_items: { item_name: 'コート', color: 'BLACK', size: 'M' } },
    { quantity: 1, order_items: { item_name: 'ストール', color: null, size: null } },
  ];

  type FilterChain = {
    eq: (column: string, value: unknown) => FilterChain;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  };

  function store(results: {
    order: unknown; orderError?: unknown; items?: unknown; itemsError?: unknown;
    fulfillment?: unknown; fulfillmentError?: unknown; lines?: unknown; linesError?: unknown;
  }) {
    const orderSelect = jest.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: results.order, error: results.orderError ?? null }) }) }));
    const itemSelect = jest.fn(() => ({ eq: async () => ({ data: results.items ?? null, error: results.itemsError ?? null }) }));
    const fulfillmentFilters: Array<[string, unknown]> = [];
    const fulfillmentChain: FilterChain = {
      eq: (column, value) => {
        fulfillmentFilters.push([column, value]);
        return fulfillmentChain;
      },
      maybeSingle: async () => ({ data: results.fulfillment ?? null, error: results.fulfillmentError ?? null }),
    };
    const fulfillmentSelect = jest.fn(() => fulfillmentChain);
    const lineFilters: Array<[string, unknown]> = [];
    const lineSelect = jest.fn(() => ({
      eq: async (column: string, value: unknown) => {
        lineFilters.push([column, value]);
        return { data: results.lines ?? null, error: results.linesError ?? null };
      },
    }));
    const from = jest.fn((table: string) => {
      if (table === 'orders') {
        return { select: orderSelect };
      }
      if (table === 'order_fulfillments') {
        return { select: fulfillmentSelect };
      }
      if (table === 'order_fulfillment_lines') {
        return { select: lineSelect };
      }
      return { select: itemSelect };
    });
    return { client: { from } as never, from, orderSelect, itemSelect, fulfillmentSelect, fulfillmentFilters, lineSelect, lineFilters };
  }

  it('注文と明細を読む。注文の状態は読むが、配送業者・伝票番号は注文の行から読まない', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID)).resolves.toEqual({ order, items, fulfillment: null });
    const columns = (db.orderSelect.mock.calls[0] as unknown as [string])[0].split(',').map((column) => column.trim());
    expect(columns).toEqual([
      'id', 'status', 'shipping_email', 'shipping_full_name', 'subtotal_amount', 'shipping_amount', 'discount_amount',
      'total_amount', 'currency', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address',
      'shipping_building', 'shipping_phone', 'review_reason',
    ]);
    expect(db.itemSelect).toHaveBeenCalledWith('item_name, color, size, quantity, line_total, fulfillment_type');
    // 発送の番号が無い種類は、発送の表を読まない
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillments');
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillment_lines');
  });

  it('発送の番号があれば、その発送の配送業者・伝票番号・商品を読む（注文の番号でも絞る）', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items, fulfillment: FULFILLMENT_ROW, lines: FULFILLMENT_LINE_ROWS });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, FULFILLMENT_ID)).resolves.toEqual({
      order,
      items,
      fulfillment: {
        number: 2,
        carrier: 'sagawa',
        trackingNumber: '9876-5432',
        completesOrder: false,
        cancelled: false,
        lines: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2 },
          { item_name: 'ストール', color: null, size: null, quantity: 1 },
        ],
      },
    });
    expect(db.fulfillmentSelect).toHaveBeenCalledWith('number, shipping_carrier, tracking_number, completes_order, cancelled_at');
    expect(db.fulfillmentFilters).toEqual([['id', FULFILLMENT_ID], ['order_id', ORDER_ID]]);
    expect(db.lineSelect).toHaveBeenCalledWith('quantity, order_items(item_name, color, size)');
    expect(db.lineFilters).toEqual([['fulfillment_id', FULFILLMENT_ID]]);
  });

  it('取り消した発送も読み、取消済みの印を付けて返す（送るかどうかは worker が決める）', async () => {
    const db = store({
      order: material().order,
      items: material().items,
      fulfillment: { ...FULFILLMENT_ROW, cancelled_at: '2026-10-10T03:00:00.000Z' },
      lines: FULFILLMENT_LINE_ROWS,
    });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, FULFILLMENT_ID)).resolves.toMatchObject({
      fulfillment: { number: 2, cancelled: true },
    });
  });

  it('注文が無い・明細が0件なら null。発送の番号がある時は、発送が無い・発送の商品が0件でも null', async () => {
    const order = material().order;
    const items = material().items;

    await expect(loadOrderEmailMaterial(store({ order: null }).client, ORDER_ID)).resolves.toBeNull();
    await expect(loadOrderEmailMaterial(store({ order, items: [] }).client, ORDER_ID)).resolves.toBeNull();
    // 発送が無い（別の注文の発送の番号を渡して絞り込みで見つからない場合も同じ）
    await expect(loadOrderEmailMaterial(store({ order, items }).client, ORDER_ID, FULFILLMENT_ID)).resolves.toBeNull();
    // 発送はあるが、発送の商品が0件
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillment: FULFILLMENT_ROW, lines: [] }).client, ORDER_ID, FULFILLMENT_ID),
    ).resolves.toBeNull();
  });

  it('読めなければ OrderEmailMaterialError を投げる', async () => {
    const order = material().order;
    const items = material().items;

    await expect(loadOrderEmailMaterial(store({ order: null, orderError: { message: 'down' } }).client, ORDER_ID)).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order, itemsError: { message: 'down' } }).client, ORDER_ID),
    ).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillmentError: { message: 'down' } }).client, ORDER_ID, FULFILLMENT_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_fulfillments' });
    await expect(
      loadOrderEmailMaterial(store({ order, items, fulfillment: FULFILLMENT_ROW, linesError: { message: 'down' } }).client, ORDER_ID, FULFILLMENT_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_fulfillment_lines' });
  });
});
