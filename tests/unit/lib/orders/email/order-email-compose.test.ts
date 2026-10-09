import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

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
      shipping_carrier: null,
      tracking_number: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'backorder' }],
  };
}

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

  it('発送は配送業者と追跡のリンクを出す。業者か伝票番号が無ければ作らない', () => {
    const email = composeOrderEmail(material({ status: 'shipped', shipping_carrier: 'yamato', tracking_number: '1234-5678' }), {
      kind: 'shipped', variant: null, paymentExpiredSent: false,
    });
    expect(email?.subject).toBe('【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）');
    expect(email?.text).toContain('配送業者: ヤマト運輸');
    expect(email?.text).toContain('追跡番号: 1234-5678');
    expect(email?.text).toContain('number=1234-5678');

    expect(composeOrderEmail(material({ status: 'shipped' }), { kind: 'shipped', variant: null, paymentExpiredSent: false })).toBeNull();
    expect(composeOrderEmail(material({ status: 'shipped', shipping_carrier: 'unknown', tracking_number: '1' }), {
      kind: 'shipped', variant: null, paymentExpiredSent: false,
    })).toBeNull();
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
  function store(results: { order: unknown; orderError?: unknown; items?: unknown; itemsError?: unknown }) {
    const orderSelect = jest.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: results.order, error: results.orderError ?? null }) }) }));
    const itemSelect = jest.fn(() => ({ eq: async () => ({ data: results.items ?? null, error: results.itemsError ?? null }) }));
    const from = jest.fn((table: string) => {
      if (table === 'orders') {
        return { select: orderSelect };
      }
      return { select: itemSelect };
    });
    return { client: { from } as never, orderSelect, itemSelect };
  }

  it('注文と明細を読む。注文の状態・配送業者・伝票番号も読む', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID)).resolves.toEqual({ order, items });
    const columns = (db.orderSelect.mock.calls[0] as unknown as [string])[0].split(',').map((column) => column.trim());
    expect(columns).toEqual([
      'id', 'status', 'shipping_email', 'shipping_full_name', 'subtotal_amount', 'shipping_amount', 'discount_amount',
      'total_amount', 'currency', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address',
      'shipping_building', 'shipping_phone', 'review_reason', 'shipping_carrier', 'tracking_number',
    ]);
    expect(db.itemSelect).toHaveBeenCalledWith('item_name, color, size, quantity, line_total, fulfillment_type');
  });

  it('注文が無い・明細が0件なら null', async () => {
    await expect(loadOrderEmailMaterial(store({ order: null }).client, ORDER_ID)).resolves.toBeNull();
    await expect(loadOrderEmailMaterial(store({ order: material().order, items: [] }).client, ORDER_ID)).resolves.toBeNull();
  });

  it('読めなければ OrderEmailMaterialError を投げる', async () => {
    await expect(loadOrderEmailMaterial(store({ order: null, orderError: { message: 'down' } }).client, ORDER_ID)).rejects.toBeInstanceOf(OrderEmailMaterialError);
    await expect(
      loadOrderEmailMaterial(store({ order: material().order, itemsError: { message: 'down' } }).client, ORDER_ID),
    ).rejects.toBeInstanceOf(OrderEmailMaterialError);
  });
});
