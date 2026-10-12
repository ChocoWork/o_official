import {
  composeOrderEmail,
  type OrderEmailExchangeItem,
  type OrderEmailFulfillmentMaterial,
  type OrderEmailMaterial,
  type OrderEmailRefundMaterial,
  type OrderEmailReturnItem,
  type OrderEmailReturnMaterial,
  type OrderEmailReturnReceipt,
} from '@/lib/orders/email/order-email-compose';
import { ORDER_EMAIL_KINDS } from '@/lib/orders/email/order-email-types';

/**
 * 返品のメール（グループ E-3 設計書 9 章）の件名と本文を、決めた行の順に一字ずつ比べる。
 * 文言は計画 C-6 から写した字のままにする（試験の期待値は、実装の定数を使わずに文で書く）。
 * 金額は注文の内容・合計と同じ書き方（全角の ￥ と桁区切り。計画の `¥{n}` はこの書き方で出す）
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CONTACT = 'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。';
const SHOP = 'Le Fil des Heures';

const RETURN_ACCEPTED = { kind: 'return_accepted', variant: null, paymentExpiredSent: false } as const;
const RETURN_RECEIVED = { kind: 'return_received', variant: null, paymentExpiredSent: false } as const;
const RETURN_SENT_BACK = { kind: 'return_sent_back', variant: null, paymentExpiredSent: false } as const;
const RETURN_SHOP = { kind: 'return_refund_pending_shop', variant: null, paymentExpiredSent: false } as const;
const REFUND_RETURN = { kind: 'refund', variant: 'return', paymentExpiredSent: false } as const;
const REFUND_STANDARD = { kind: 'refund', variant: 'standard', paymentExpiredSent: false } as const;
const SHIPPED = { kind: 'shipped', variant: null, paymentExpiredSent: false } as const;

const COAT: OrderEmailReturnItem = { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 };
const DRESS_S: OrderEmailReturnItem = { item_name: 'ワンピース', color: 'NAVY', size: 'S', quantity: 1 };
const BLOUSE_S2: OrderEmailReturnItem = { item_name: 'ブラウス', color: 'WHITE', size: 'S', quantity: 2 };
const STOLE3: OrderEmailReturnItem = { item_name: 'ストール', color: null, size: null, quantity: 3 };
const DRESS_M_STOCK: OrderEmailExchangeItem = { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, method: 'stock', leadDays: null };
const BLOUSE_L_MAKE: OrderEmailExchangeItem = { item_name: 'ブラウス', color: 'WHITE', size: 'L', quantity: 2, method: 'make', leadDays: 14 };

const ADDRESS = { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' };
const ADDRESS_LINES = ['返送先:', 'Le Fil des Heures 返品係', '〒150-0001 東京都渋谷区神宮前1-2-3', '03-1234-5678'];

function material(overrides: Partial<OrderEmailMaterial> = {}): OrderEmailMaterial {
  return {
    order: {
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
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'stock' }],
    fulfillment: null,
    refund: null,
    orderReturn: null,
    ...overrides,
  };
}

function returnMaterial(overrides: Partial<OrderEmailReturnMaterial> = {}): OrderEmailReturnMaterial {
  return {
    number: 1,
    returnMethod: 'customer_ships',
    returnShippingPayer: 'shop',
    returnShippingFee: 0,
    restockingFeePercent: 0,
    exchangeFee: 0,
    exchangeShippingFee: 0,
    feeWaitingAmount: 0,
    returnAddress: ADDRESS,
    items: [COAT],
    exchangePlan: [],
    hasRefundLines: true,
    receipt: null,
    ...overrides,
  };
}

function receiptMaterial(overrides: Partial<OrderEmailReturnReceipt> = {}): OrderEmailReturnReceipt {
  return {
    refundChoice: 'none',
    received: [COAT],
    sentBack: [],
    sentBackMessage: null,
    sentBackCarrier: null,
    sentBackTrackingNumber: null,
    exchanges: [],
    pendingRefund: null,
    refundWaived: false,
    refundNotAccepted: false,
    ...overrides,
  };
}

function withReturn(orderReturn: OrderEmailReturnMaterial | null): OrderEmailMaterial {
  return material({ orderReturn });
}

function withReceipt(overrides: Partial<OrderEmailReturnReceipt> = {}, returnOverrides: Partial<OrderEmailReturnMaterial> = {}): OrderEmailMaterial {
  return withReturn(returnMaterial({ items: [], receipt: receiptMaterial(overrides), ...returnOverrides }));
}

function refundMaterial(overrides: Partial<OrderEmailRefundMaterial> = {}): OrderEmailRefundMaterial {
  return {
    status: 'succeeded',
    amount: 9800,
    shippingAmount: 0,
    paymentMethodType: 'card',
    customerActionExpiresAt: null,
    cancelReason: null,
    lines: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: false }],
    stillShipping: false,
    ...overrides,
  };
}

function shipment(overrides: Partial<OrderEmailFulfillmentMaterial> = {}): OrderEmailFulfillmentMaterial {
  return {
    number: 2,
    carrier: 'yamato',
    trackingNumber: '1234-5678',
    completesOrder: true,
    cancelled: false,
    lines: [{ item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, exchange: true }],
    ...overrides,
  };
}

const CARD_TIMING = 'ご返金は、カード会社によって5〜10営業日ほどで反映されます。';

describe('composeOrderEmail（返品の受付のお知らせ）', () => {
  it('お店の負担・カードの返金・手数料なしの返品は、決めた行の順に書く', () => {
    const email = composeOrderEmail(withReturn(returnMaterial()), RETURN_ACCEPTED);

    expect(email).toEqual({
      subject: '【Le Fil des Heures】返品の受付のお知らせ（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品を承りました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'ご返送いただく商品:',
        '・コート（BLACK / M） × 1',
        '',
        '下記の返送先へお送りください。',
        '返送料は当店が負担いたします。着払いでお送りください。',
        ...ADDRESS_LINES,
        '',
        '商品が届きましたら、確かめてご連絡いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('交換（在庫から・作って送る）と手数料3つがある返品は、返送のしかたの後に手数料の行を書く。作って送る行の末尾には注記を付ける', () => {
    const email = composeOrderEmail(
      withReturn(
        returnMaterial({
          returnMethod: 'shop_label',
          returnShippingPayer: 'customer',
          returnShippingFee: 800,
          restockingFeePercent: 10,
          exchangeFee: 500,
          exchangeShippingFee: 600,
          items: [COAT, DRESS_S, BLOUSE_S2],
          exchangePlan: [DRESS_M_STOCK, BLOUSE_L_MAKE],
        }),
      ),
      RETURN_ACCEPTED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品を承りました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'ご返送いただく商品:',
        '・コート（BLACK / M） × 1',
        '・ワンピース（NAVY / S） × 1',
        '・ブラウス（WHITE / S） × 2',
        '',
        '交換でお届けする商品:',
        '・ワンピース（NAVY / M） × 1',
        '・ブラウス（WHITE / L） × 2（お作りしてお送りします）',
        '',
        '下記の返送先へお送りください。',
        '当店がご用意する送り状でお送りください。返送料 ￥800 をご返金額から差し引きます。',
        ...ADDRESS_LINES,
        '',
        '返品の手数料: ご返金の商品の額の 10%',
        '交換の手数料: ￥500',
        '交換の送料: ￥600',
        '手数料はご返金から差し引きます。差し引けない分は、別にご案内いたします。',
        '',
        '商品が届きましたら、確かめてご連絡いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('返送不要の返品は、返送先を書かず（返送先が空でも作れる）、返送は不要と書く', () => {
    const email = composeOrderEmail(
      withReturn(returnMaterial({ returnMethod: 'not_required', returnAddress: null })),
      RETURN_ACCEPTED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品を承りました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'ご返送いただく商品:',
        '・コート（BLACK / M） × 1',
        '',
        '品物のご返送は不要です。',
        '',
        '商品が届きましたら、確かめてご連絡いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('お客様の負担でお店の送り状を使い、返送料が0円なら差し引きの文を書かない', () => {
    const email = composeOrderEmail(withReturn(returnMaterial({
      returnMethod: 'shop_label', returnShippingPayer: 'customer', returnShippingFee: 0,
    })), RETURN_ACCEPTED);

    expect(email).not.toBeNull();
    expect(email?.text.split('\n')).toContain('当店がご用意する送り状でお送りください。');
    expect(email?.text).not.toContain('返送料 ￥0');
    expect(email?.text).not.toContain('をご返金額から差し引きます。');
  });

  it.each([
    ['お店の負担（お客様が送る）', 'customer_ships', 'shop', '返送料は当店が負担いたします。着払いでお送りください。'],
    ['お客様の負担（お客様が送る）', 'customer_ships', 'customer', '恐れ入りますが、返送料はお客様のご負担でお送りください。'],
    [
      'お客様の負担（お店の送り状）',
      'shop_label',
      'customer',
      '当店がご用意する送り状でお送りください。返送料 ￥1,200 をご返金額から差し引きます。',
    ],
    // お店の負担を先に見る（返送料を差し引く文は、お客様の負担の時だけ）
    ['お店の負担（お店の送り状）', 'shop_label', 'shop', '返送料は当店が負担いたします。着払いでお送りください。'],
  ] as const)('返送料の文は返送のしかたと負担で変わる: %s', (_label, returnMethod, returnShippingPayer, sentence) => {
    const email = composeOrderEmail(
      withReturn(returnMaterial({ returnMethod, returnShippingPayer, returnShippingFee: 1200 })),
      RETURN_ACCEPTED,
    );

    expect(email?.text).toContain(['下記の返送先へお送りください。', sentence, '返送先:'].join('\n'));
    // 返送料の文は1つだけ（ほかの負担の文は書かない）
    expect(email?.text.split('\n').filter((line) => line.includes('返送料'))).toEqual([sentence]);
  });

  it.each([
    ['返品の手数料だけ', { restockingFeePercent: 5 }, ['返品の手数料: ご返金の商品の額の 5%']],
    ['交換の手数料だけ', { exchangeFee: 300 }, ['交換の手数料: ￥300']],
    ['交換の送料だけ', { exchangeShippingFee: 1500 }, ['交換の送料: ￥1,500']],
  ] as const)('手数料の行は使う物だけ書き、最後に差し引きの文を足す: %s', (_label, fees, feeLines) => {
    const email = composeOrderEmail(
      withReturn(
        returnMaterial({
          items: [COAT, DRESS_S],
          exchangePlan: [DRESS_M_STOCK],
          ...fees,
        }),
      ),
      RETURN_ACCEPTED,
    );

    expect(email?.text).toContain(
      [
        ...ADDRESS_LINES,
        '',
        ...feeLines,
        '手数料はご返金から差し引きます。差し引けない分は、別にご案内いたします。',
        '',
        '商品が届きましたら、確かめてご連絡いたします。',
      ].join('\n'),
    );
  });

  it('手数料が無ければ手数料の段落ごと書かない。この返品に当たらない手数料（返金の品が無いのに返品の手数料、交換の品が無いのに交換の手数料と送料）も書かない', () => {
    const noFees = composeOrderEmail(withReturn(returnMaterial()), RETURN_ACCEPTED);
    const inapplicable = composeOrderEmail(
      withReturn(
        returnMaterial({
          // 交換だけの返品に、返品の手数料の割合。返金の品が無いので書かない
          items: [DRESS_S],
          exchangePlan: [DRESS_M_STOCK],
          hasRefundLines: false,
          restockingFeePercent: 10,
        }),
      ),
      RETURN_ACCEPTED,
    );
    const noExchange = composeOrderEmail(
      withReturn(returnMaterial({ exchangeFee: 500, exchangeShippingFee: 600 })),
      RETURN_ACCEPTED,
    );

    for (const email of [noFees, inapplicable, noExchange]) {
      expect(email?.text).not.toContain('手数料');
      expect(email?.text).toContain(['03-1234-5678', '', '商品が届きましたら、確かめてご連絡いたします。'].join('\n'));
    }
  });

  it('同じ文を二重に書かない: 交換でお届けする商品の節は交換の品がある時だけ。作って送る注記は作って送る行だけ', () => {
    const noExchange = composeOrderEmail(withReturn(returnMaterial()), RETURN_ACCEPTED);
    const stockOnly = composeOrderEmail(
      withReturn(returnMaterial({ items: [DRESS_S], exchangePlan: [DRESS_M_STOCK], hasRefundLines: false })),
      RETURN_ACCEPTED,
    );

    expect(noExchange?.text).not.toContain('交換でお届けする商品');
    expect(stockOnly?.text).toContain(['交換でお届けする商品:', '・ワンピース（NAVY / M） × 1', ''].join('\n'));
    expect(stockOnly?.text).not.toContain('お作りしてお送りします');
  });

  it('返送先が要るのに返送先が設定に無い・返品の品が無い・返品の材料が無ければ作らない', () => {
    expect(composeOrderEmail(withReturn(returnMaterial({ returnAddress: null })), RETURN_ACCEPTED)).toBeNull();
    expect(composeOrderEmail(withReturn(returnMaterial({ items: [] })), RETURN_ACCEPTED)).toBeNull();
    expect(composeOrderEmail(withReturn(null), RETURN_ACCEPTED)).toBeNull();
  });

  it('件名には氏名も商品名も入れず、半角の ¥ は本文のどこにも出ない（金額は全角の ￥）', () => {
    const email = composeOrderEmail(
      {
        ...withReturn(
          returnMaterial({
            returnMethod: 'shop_label',
            returnShippingPayer: 'customer',
            returnShippingFee: 800,
            exchangeFee: 500,
            items: [DRESS_S],
            exchangePlan: [DRESS_M_STOCK],
          }),
        ),
        order: { ...material().order, shipping_full_name: '山田\r\nBcc: x@example.com' },
      },
      RETURN_ACCEPTED,
    );

    expect(email?.subject).toBe('【Le Fil des Heures】返品の受付のお知らせ（ORD-A1B2C3D4）');
    expect(email?.subject).not.toContain('山田');
    expect(email?.subject).not.toContain('ワンピース');
    expect(email?.text).not.toContain(String.fromCharCode(0xa5));
    expect(email?.text).toContain('￥800');
    expect(email?.text).toContain('￥500');
  });
});

describe('composeOrderEmail（返品の受け取りのお知らせ）', () => {
  it('交換の品（在庫から）だけを足す受け取りは、受け取った品・交換の品の順に書く', () => {
    const email = composeOrderEmail(
      withReceipt({ received: [DRESS_S], exchanges: [DRESS_M_STOCK] }),
      RETURN_RECEIVED,
    );

    expect(email).toEqual({
      subject: '【Le Fil des Heures】返品をお受け取りしました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・ワンピース（NAVY / S） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('作って送る交換の品は、その行の次の行に作ってお送りする旨を書く。お届けの目安は商品に日数がある時だけ書く', () => {
    const email = composeOrderEmail(
      withReceipt({
        received: [DRESS_S, BLOUSE_S2],
        exchanges: [DRESS_M_STOCK, BLOUSE_L_MAKE, { ...BLOUSE_L_MAKE, color: 'BLACK', quantity: 1, leadDays: null }],
      }),
      RETURN_RECEIVED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・ワンピース（NAVY / S） × 1',
        '・ブラウス（WHITE / S） × 2',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '・ブラウス（WHITE / L） × 2',
        'お作りしてお送りします。お届けの目安は 14日ほどです。',
        '・ブラウス（BLACK / L） × 1',
        'お作りしてお送りします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('お届けの目安の日数が0の商品は、目安を書かない（作ってお送りする旨だけ）', () => {
    const email = composeOrderEmail(
      withReceipt({ exchanges: [{ ...BLOUSE_L_MAKE, leadDays: 0 }] }),
      RETURN_RECEIVED,
    );

    expect(email?.text).toContain(['・ブラウス（WHITE / L） × 2', 'お作りしてお送りします。', ''].join('\n'));
    expect(email?.text).not.toContain('お届けの目安');
  });

  it('額を相談する受け取りは、受け取った品の次の段落に「改めてご連絡」と書く。今返金する・返金の品が無い受け取りには書かない', () => {
    const consult = composeOrderEmail(withReceipt({ refundChoice: 'consult' }), RETURN_RECEIVED);

    expect(consult?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・コート（BLACK / M） × 1',
        '',
        'ご返金の額は、確かめてから改めてご連絡いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
    // 今返金で Stripe に受け付けられた受け取り（既定の refundNotAccepted: false）にも書かない（本計画 P25）
    for (const refundChoice of ['now', 'none', null] as const) {
      expect(composeOrderEmail(withReceipt({ refundChoice }), RETURN_RECEIVED)?.text).not.toContain('ご返金の額は');
    }
  });

  it('今返金で返金が0円になった受け取り（本計画 P24）は、交換の品の次、お支払い待ちの前に、0円の一文を書く', () => {
    const email = composeOrderEmail(
      withReceipt(
        { refundChoice: 'now', received: [COAT, DRESS_S], exchanges: [DRESS_M_STOCK], refundWaived: true },
        { feeWaitingAmount: 300 },
      ),
      RETURN_RECEIVED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・コート（BLACK / M） × 1',
        '・ワンピース（NAVY / S） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        '今回のご返品では、ご返金の額が0円のため、ご返金はございません。',
        '',
        '交換の品は、手数料 ￥300 のお支払いを確かめてからお送りします。お支払いの方法は、別にご案内いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
    // 0円でない受け取り（今返金・相談・返金の品なし）には書かない
    for (const refundChoice of ['now', 'consult', 'none'] as const) {
      expect(composeOrderEmail(withReceipt({ refundChoice }), RETURN_RECEIVED)?.text).not.toContain('ご返金はございません');
    }
  });

  it('今返金が Stripe に受け付けられなかった受け取り（本計画 P25）は、相談の時と同じ一文を、交換の品の次・お返しの前に1回だけ書く', () => {
    const email = composeOrderEmail(
      withReceipt({
        refundChoice: 'now',
        received: [COAT],
        exchanges: [DRESS_M_STOCK],
        sentBack: [STOLE3],
        sentBackMessage: 'お返しします。',
        refundNotAccepted: true,
      }),
      RETURN_RECEIVED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・コート（BLACK / M） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        'ご返金の額は、確かめてから改めてご連絡いたします。',
        '',
        'お返しする商品:',
        '・ストール × 3',
        '',
        '当店より:',
        'お返しします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
    expect(email?.text.split('ご返金の額は、確かめてから改めてご連絡いたします。')).toHaveLength(2);
  });

  it('手数料のお支払い待ちで交換の品が止まっている間だけ、交換の品の次の段落にお支払いの案内を書く', () => {
    const waiting = composeOrderEmail(
      withReceipt({ received: [DRESS_S], exchanges: [DRESS_M_STOCK] }, { feeWaitingAmount: 1100 }),
      RETURN_RECEIVED,
    );

    expect(waiting?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・ワンピース（NAVY / S） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        '交換の品は、手数料 ￥1,100 のお支払いを確かめてからお送りします。お支払いの方法は、別にご案内いたします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
    // 止まっていない（受け取り済み・支払いを待たずに送る）／交換の品が無い受け取りには書かない
    const notWaiting = composeOrderEmail(
      withReceipt({ received: [DRESS_S], exchanges: [DRESS_M_STOCK] }, { feeWaitingAmount: 0 }),
      RETURN_RECEIVED,
    );
    const noExchange = composeOrderEmail(withReceipt({}, { feeWaitingAmount: 1100 }), RETURN_RECEIVED);
    expect(notWaiting?.text).not.toContain('お支払い');
    expect(noExchange?.text).not.toContain('お支払い');
  });

  it('お返しを含む受け取りは、お返しの節（お返しする商品・お店のメッセージ・伝票番号）を最後の段落に書く', () => {
    const email = composeOrderEmail(
      withReceipt({
        received: [COAT],
        sentBack: [STOLE3],
        sentBackMessage: '着用の跡があり、返品をお受けできませんでした。ご確認ください。',
        sentBackCarrier: 'yamato',
        sentBackTrackingNumber: '1234-5678-9012',
      }),
      RETURN_RECEIVED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・コート（BLACK / M） × 1',
        '',
        'お返しする商品:',
        '・ストール × 3',
        '',
        '当店より:',
        '着用の跡があり、返品をお受けできませんでした。ご確認ください。',
        '',
        '送り返しの伝票番号: ヤマト運輸 1234-5678-9012',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('段落の順は、受け取った品・交換の品・額の相談・お支払い待ち・お返し', () => {
    const email = composeOrderEmail(
      withReceipt(
        {
          refundChoice: 'consult',
          received: [COAT, DRESS_S],
          exchanges: [DRESS_M_STOCK],
          sentBack: [STOLE3],
          sentBackMessage: 'お返しします。',
        },
        { feeWaitingAmount: 500 },
      ),
      RETURN_RECEIVED,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        'お受け取りした商品:',
        '・コート（BLACK / M） × 1',
        '・ワンピース（NAVY / S） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        'ご返金の額は、確かめてから改めてご連絡いたします。',
        '',
        '交換の品は、手数料 ￥500 のお支払いを確かめてからお送りします。お支払いの方法は、別にご案内いたします。',
        '',
        'お返しする商品:',
        '・ストール × 3',
        '',
        '当店より:',
        'お返しします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('受け取りの材料が無い・受け取った品が無い・お返しの品があるのにメッセージが無ければ作らない', () => {
    expect(composeOrderEmail(withReturn(null), RETURN_RECEIVED)).toBeNull();
    expect(composeOrderEmail(withReturn(returnMaterial({ receipt: null })), RETURN_RECEIVED)).toBeNull();
    expect(composeOrderEmail(withReceipt({ received: [] }), RETURN_RECEIVED)).toBeNull();
    expect(composeOrderEmail(withReceipt({ sentBack: [STOLE3], sentBackMessage: null }), RETURN_RECEIVED)).toBeNull();
    expect(composeOrderEmail(withReceipt({ sentBack: [STOLE3], sentBackMessage: '' }), RETURN_RECEIVED)).toBeNull();
  });

  it('件名には氏名も商品名も入れず、半角の ¥ は本文のどこにも出ない', () => {
    const email = composeOrderEmail(
      {
        ...withReceipt({ exchanges: [DRESS_M_STOCK] }, { feeWaitingAmount: 800 }),
        order: { ...material().order, shipping_full_name: '山田\r\nBcc: x@example.com' },
      },
      RETURN_RECEIVED,
    );

    expect(email?.subject).toBe('【Le Fil des Heures】返品をお受け取りしました（ORD-A1B2C3D4）');
    expect(email?.subject).not.toMatch(/[\r\n]/);
    expect(email?.text).not.toContain(String.fromCharCode(0xa5));
    expect(email?.text).toContain('手数料 ￥800 の');
  });
});

describe('composeOrderEmail（品物のお返しのお知らせ）', () => {
  it('お返しする商品・お店のメッセージ・送り返しの伝票番号を、決めた行の順に書く', () => {
    const email = composeOrderEmail(
      withReceipt({
        received: [],
        sentBack: [COAT, STOLE3],
        sentBackMessage: '使用の跡があり、返品をお受けできませんでした。',
        sentBackCarrier: 'sagawa',
        sentBackTrackingNumber: '4321-8765',
      }),
      RETURN_SENT_BACK,
    );

    expect(email).toEqual({
      subject: '【Le Fil des Heures】品物をお返しします（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご返品いただいた商品を確かめましたが、返品・交換をお受けできませんでした（返品番号 ORD-A1B2C3D4-R1）。品物はお返しいたします。',
        '',
        'お返しする商品:',
        '・コート（BLACK / M） × 1',
        '・ストール × 3',
        '',
        '当店より:',
        '使用の跡があり、返品をお受けできませんでした。',
        '',
        '送り返しの伝票番号: 佐川急便 4321-8765',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it.each([
    ['日本郵便', 'japanpost', '日本郵便 99887766'],
    ['その他', 'other', 'その他 99887766'],
    ['配送業者を入れていない', null, '99887766'],
  ] as const)('伝票番号の行は配送業者の名前を前に付ける（%s）', (_label, sentBackCarrier, expected) => {
    const email = composeOrderEmail(
      withReceipt({ received: [], sentBack: [COAT], sentBackMessage: 'お返しします。', sentBackCarrier, sentBackTrackingNumber: '99887766' }),
      RETURN_SENT_BACK,
    );

    expect(email?.text).toContain(`\n送り返しの伝票番号: ${expected}\n`);
  });

  it('伝票番号を入れていなければ、伝票番号の行も、その前の空行も書かない', () => {
    const email = composeOrderEmail(
      withReceipt({ received: [], sentBack: [COAT], sentBackMessage: 'お返しします。', sentBackCarrier: 'yamato' }),
      RETURN_SENT_BACK,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご返品いただいた商品を確かめましたが、返品・交換をお受けできませんでした（返品番号 ORD-A1B2C3D4-R1）。品物はお返しいたします。',
        '',
        'お返しする商品:',
        '・コート（BLACK / M） × 1',
        '',
        '当店より:',
        'お返しします。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
    expect(email?.text).not.toContain('伝票番号');
  });

  it('お店のメッセージは書かれたまま入れる（改行・空行・前後の空白・記号もそのまま。メールは文字だけ）', () => {
    const message = '1行目です。\n\n  3行目（字下げ）\n<b>太字</b> ＆ "引用"  ';
    const email = composeOrderEmail(
      withReceipt({ received: [], sentBack: [COAT], sentBackMessage: message }),
      RETURN_SENT_BACK,
    );

    expect(email?.text).toContain(['当店より:', message, '', CONTACT].join('\n'));
  });

  it('お返しの品が無い・メッセージが無い・受け取りの材料が無ければ作らない', () => {
    expect(composeOrderEmail(withReceipt({ received: [COAT], sentBack: [] }), RETURN_SENT_BACK)).toBeNull();
    expect(composeOrderEmail(withReceipt({ sentBack: [COAT], sentBackMessage: null }), RETURN_SENT_BACK)).toBeNull();
    expect(composeOrderEmail(withReturn(returnMaterial({ receipt: null })), RETURN_SENT_BACK)).toBeNull();
    expect(composeOrderEmail(withReturn(null), RETURN_SENT_BACK)).toBeNull();
  });

  it('件名には氏名も商品名も入れない', () => {
    const email = composeOrderEmail(
      {
        ...withReceipt({ received: [], sentBack: [COAT], sentBackMessage: 'お返しします。' }),
        order: { ...material().order, shipping_full_name: '山田\r\nBcc: x@example.com' },
      },
      RETURN_SENT_BACK,
    );

    expect(email?.subject).not.toContain('山田');
    expect(email?.subject).not.toContain('コート');
    expect(email?.subject).not.toMatch(/[\r\n]/);
  });
});

describe('composeOrderEmail（返金のお知らせの返品の書き分け）', () => {
  it('受け取りと一緒の返金は、手続きの文の次の行に受け取りの文を書き、商品の行の後に交換の品の節とお返しの節を足す', () => {
    const email = composeOrderEmail(
      {
        ...withReceipt({
          exchanges: [DRESS_M_STOCK, BLOUSE_L_MAKE],
          sentBack: [STOLE3],
          sentBackMessage: '状態を確かめた結果、お返しいたします。',
          sentBackCarrier: 'yamato',
          sentBackTrackingNumber: '1234-5678',
        }),
        refund: refundMaterial(),
      },
      REFUND_RETURN,
    );

    expect(email).toEqual({
      subject: '【Le Fil des Heures】ご返金のお知らせ（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返金の手続きをいたしました。',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        '返金額: ￥9,800',
        '返金した商品:',
        '・コート（BLACK / M） × 1',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '・ブラウス（WHITE / L） × 2',
        'お作りしてお送りします。お届けの目安は 14日ほどです。',
        '',
        'お返しする商品:',
        '・ストール × 3',
        '',
        '当店より:',
        '状態を確かめた結果、お返しいたします。',
        '',
        '送り返しの伝票番号: ヤマト運輸 1234-5678',
        '',
        CARD_TIMING,
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('交換もお返しも無い受け取りと一緒の返金は、2行目だけが足される', () => {
    const email = composeOrderEmail({ ...withReceipt(), refund: refundMaterial({ amount: 3000, shippingAmount: 500 }) }, REFUND_RETURN);

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返金の手続きをいたしました。',
        'ご返品いただいた商品をお受け取りしました（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        '返金額: ￥3,000（うち送料 ￥500）',
        '返金した商品:',
        '・コート（BLACK / M） × 1',
        '',
        CARD_TIMING,
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('額を決めて後で返した返金は、2行目に「ご返金です」と書き、交換の品の節もお返しの節も足さない', () => {
    const email = composeOrderEmail(
      { ...withReturn(returnMaterial({ items: [], receipt: null })), refund: refundMaterial({ amount: 4500 }) },
      REFUND_RETURN,
    );

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返金の手続きをいたしました。',
        'ご返品いただいた商品のご返金です（返品番号 ORD-A1B2C3D4-R1）。',
        '',
        '返金額: ￥4,500',
        '返金した商品:',
        '・コート（BLACK / M） × 1',
        '',
        CARD_TIMING,
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('返品番号は返品の番号（R の後の数）で書く', () => {
    const email = composeOrderEmail(
      { ...withReturn(returnMaterial({ number: 12, items: [], receipt: null })), refund: refundMaterial() },
      REFUND_RETURN,
    );

    expect(email?.text).toContain('（返品番号 ORD-A1B2C3D4-R12）');
  });

  it('返品の返金には「返金した商品はお送りしません。」を書かない。これから送る商品があれば、その文は書く（交換の品の節の前）', () => {
    const lines = [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true }];
    const returnRefund = composeOrderEmail(
      {
        ...withReceipt({ exchanges: [DRESS_M_STOCK] }),
        refund: refundMaterial({ lines, stillShipping: true }),
      },
      REFUND_RETURN,
    );
    const standard = composeOrderEmail({ ...material(), refund: refundMaterial({ lines }) }, REFUND_STANDARD);

    expect(returnRefund?.text).not.toContain('返金した商品はお送りしません。');
    expect(returnRefund?.text).toContain(
      [
        '・コート（BLACK / M） × 1',
        'ほかの商品はこれまでどおりお送りします。',
        '',
        '交換の品をお送りします:',
        '・ワンピース（NAVY / M） × 1',
        '',
        CARD_TIMING,
      ].join('\n'),
    );
    // 返品でない返金のお知らせは今のまま
    expect(standard?.text).toContain('返金した商品はお送りしません。');
    expect(standard?.text).not.toContain('ご返品いただいた');
  });

  it('返品の材料が無い・お返しのメッセージが無ければ作らない。返品でない返金のお知らせは返品の材料を読まない', () => {
    expect(composeOrderEmail({ ...material(), refund: refundMaterial() }, REFUND_RETURN)).toBeNull();
    expect(
      composeOrderEmail(
        { ...withReceipt({ sentBack: [STOLE3], sentBackMessage: null }), refund: refundMaterial() },
        REFUND_RETURN,
      ),
    ).toBeNull();
    expect(composeOrderEmail({ ...material(), refund: null, orderReturn: returnMaterial() }, REFUND_RETURN)).toBeNull();
    // 返品の材料が付いていても、書き分けが standard なら返品の文は書かない
    const standard = composeOrderEmail({ ...withReceipt(), refund: refundMaterial() }, REFUND_STANDARD);
    expect(standard?.text).not.toContain('ご返品いただいた');
  });

  it('金額は全角の ￥ だけで書き、半角の ¥ は本文のどこにも出ない', () => {
    const email = composeOrderEmail(
      { ...withReceipt({ exchanges: [DRESS_M_STOCK] }), refund: refundMaterial({ amount: 1234567, shippingAmount: 1234 }) },
      REFUND_RETURN,
    );

    expect(email?.text).toContain('返金額: ￥1,234,567（うち送料 ￥1,234）');
    expect(email?.text).not.toContain(String.fromCharCode(0xa5));
  });
});

describe('composeOrderEmail（店への知らせ（返金待ち））', () => {
  it('受け取った返金の品と計算どおりの額を、決めた行の順に書く。お客様の氏名・メール・住所は書かない', () => {
    const email = composeOrderEmail(
      withReceipt({
        received: [COAT, DRESS_S],
        pendingRefund: { items: [COAT, { ...DRESS_S, quantity: 2 }], amount: 31500 },
      }),
      RETURN_SHOP,
    );

    expect(email).toEqual({
      subject: '【要対応】返金待ちの返品があります（ORD-A1B2C3D4）',
      text: [
        '返品 ORD-A1B2C3D4-R1 の品を受け取りました（受け取った人: サポート）。',
        '',
        '受け取った返金の品:',
        '・コート（BLACK / M） × 1',
        '・ワンピース（NAVY / S） × 2',
        '計算どおりの額: ￥31,500',
        '',
        '管理画面の注文の一覧で「額を決めて返金する」を押して、返金してください。',
      ].join('\n'),
    });
    for (const secret of ['山田', 'hanako@example.com', '1500001', '渋谷区', '0311112222']) {
      expect(email?.text).not.toContain(secret);
      expect(email?.subject).not.toContain(secret);
    }
    expect(email?.text).not.toContain(String.fromCharCode(0xa5));
  });

  it('返品の番号は返品の番号（R の後の数）で書く', () => {
    const email = composeOrderEmail(
      withReceipt({ pendingRefund: { items: [COAT], amount: 5000 } }, { number: 3 }),
      RETURN_SHOP,
    );

    expect(email?.text.split('\n')[0]).toBe('返品 ORD-A1B2C3D4-R3 の品を受け取りました（受け取った人: サポート）。');
  });

  it('返金待ちの材料（品と額）が無い・返金待ちの品が空・受け取りの材料が無ければ作らない', () => {
    expect(composeOrderEmail(withReceipt({ pendingRefund: null }), RETURN_SHOP)).toBeNull();
    expect(composeOrderEmail(withReceipt({ pendingRefund: { items: [], amount: 0 } }), RETURN_SHOP)).toBeNull();
    expect(composeOrderEmail(withReturn(returnMaterial({ receipt: null })), RETURN_SHOP)).toBeNull();
    expect(composeOrderEmail(withReturn(null), RETURN_SHOP)).toBeNull();
  });
});

describe('composeOrderEmail（発送のお知らせの交換の一文）', () => {
  it('交換の品の行がある発送は、冒頭の次の行に交換の一文を書き、交換の品の行の末尾に（交換の品）を付ける', () => {
    const email = composeOrderEmail({ ...material(), fulfillment: shipment() }, SHIPPED);

    expect(email).toEqual({
      subject: '【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文の商品を発送いたしました。',
        'ご返品いただいた品の、交換の品をお送りしました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        '発送した商品:',
        '・ワンピース（NAVY / M） x1（交換の品）',
        '',
        '配送業者: ヤマト運輸',
        '追跡番号: 1234-5678',
        '追跡はこちら: https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678',
        '',
        '※ 追跡情報は反映までに数時間かかる場合があります。',
        '',
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('ふつうの品と交換の品を一緒に送る発送は、一文を1回だけ書き、（交換の品）は交換の品の行にだけ付ける', () => {
    const email = composeOrderEmail(
      {
        ...material(),
        fulfillment: shipment({
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 2, exchange: false },
            { item_name: 'ワンピース', color: 'NAVY', size: 'M', quantity: 1, exchange: true },
          ],
        }),
      },
      SHIPPED,
    );

    expect(email?.text).toContain(
      [
        'ご注文の商品を発送いたしました。',
        'ご返品いただいた品の、交換の品をお送りしました。',
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        '発送した商品:',
        '・コート（BLACK / M） x2',
        '・ワンピース（NAVY / M） x1（交換の品）',
        '',
      ].join('\n'),
    );
    expect(email?.text.split('ご返品いただいた品の、交換の品をお送りしました。')).toHaveLength(2);
  });

  it('交換の品の行が無い発送（印が無い・false）には、一文も印も書かない（今までの本文のまま）', () => {
    const email = composeOrderEmail(
      {
        ...material(),
        fulfillment: shipment({
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 },
            { item_name: 'ストール', color: null, size: null, quantity: 1, exchange: false },
          ],
        }),
      },
      SHIPPED,
    );

    expect(email?.text).not.toContain('交換の品');
    expect(email?.text).toContain(
      ['ご注文の商品を発送いたしました。', '', '注文番号: ORD-A1B2C3D4', '', '発送した商品:', '・コート（BLACK / M） x1', '・ストール x1', ''].join('\n'),
    );
  });
});

describe('composeOrderEmail（返品のメールの種類）', () => {
  it('返品の材料が付いていなければ、返品のメール4種類は作らない（例外も投げない）', () => {
    const kinds = ORDER_EMAIL_KINDS.filter((kind) => kind.startsWith('return_'));

    expect(kinds).toEqual(['return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop']);
    for (const kind of kinds) {
      expect(composeOrderEmail(material(), { kind, variant: null, paymentExpiredSent: false })).toBeNull();
    }
  });
});
