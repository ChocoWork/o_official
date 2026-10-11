import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailFulfillmentMaterial,
  type OrderEmailMaterial,
  type OrderEmailRefundMaterial,
} from '@/lib/orders/email/order-email-compose';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1b2c3d4-1111-2222-8333-444455556666';
const REFUND_ID = 'e1b2c3d4-1111-2222-8333-444455556666';
const SPLIT_SHIPMENT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';
const REMAINING_ITEMS_NOTICE = '残りの商品は、準備ができ次第お送りします。';
const SHIPPED = { kind: 'shipped', variant: null, paymentExpiredSent: false } as const;
const REFUND_STANDARD = { kind: 'refund', variant: 'standard', paymentExpiredSent: false } as const;
const REFUND_AFTER_CANCEL = { kind: 'refund', variant: 'after_cancel', paymentExpiredSent: false } as const;
const CANCELED_PAID = { kind: 'canceled', variant: 'paid', paymentExpiredSent: false } as const;

// 返金のお知らせの決まった文。グループ E-2 計画の Global Constraints「メールの文言」と一字も違えない
const NOT_SHIPPING_NOTICE = '返金した商品はお送りしません。';
const STILL_SHIPPING_NOTICE = 'ほかの商品はこれまでどおりお送りします。';
const AFTER_CANCEL_NOTICE = 'このご注文はお支払いの前に取り消し済みのため、お支払いいただいた金額を全額返金いたします。';
const CARD_TIMING = 'ご返金は、カード会社によって5〜10営業日ほどで反映されます。';
const PAYPAY_TIMING = 'ご返金は、PayPay 残高にすぐ反映されます。';
const UNKNOWN_TIMING = 'ご返金が反映されるまでの日数は、お支払いの方法によって異なります。';
const konbiniTiming = (date: string) =>
  `Stripe（決済代行会社）から、返金先の口座を入力していただくためのメールが届きます。${date}までにご入力ください。期限を過ぎると返金できなくなります。`;

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
      paid_amount: null,
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
    refund: null,
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

/** 返金のお知らせの材料。既定は、カードで払った注文の額だけの返金（商品の行なし・送料なし・まだ送る商品なし） */
function refundMaterial(overrides: Partial<OrderEmailRefundMaterial> = {}): OrderEmailRefundMaterial {
  return {
    amount: 3000,
    shippingAmount: 0,
    paymentMethodType: 'card',
    customerActionExpiresAt: null,
    cancelReason: null,
    lines: [],
    stillShipping: false,
    ...overrides,
  };
}

type RefundLine = OrderEmailRefundMaterial['lines'][number];
const COAT_BEFORE: RefundLine = { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true };
const STOLE_AFTER: RefundLine = { item_name: 'ストール', color: null, size: null, quantity: 2, before_shipment: false };

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

describe('composeOrderEmail（返金のお知らせ）', () => {
  it('件名と本文は決めた行の順に書く（返金額と送料・商品・発送前の文・まだ送る商品の文・戻る時期・問い合わせ）', () => {
    const email = composeOrderEmail(
      {
        ...material({ status: 'paid' }),
        refund: refundMaterial({ amount: 12500, shippingAmount: 500, lines: [COAT_BEFORE, STOLE_AFTER], stillShipping: true }),
      },
      REFUND_STANDARD,
    );

    expect(email).toEqual({
      subject: '【Le Fil des Heures】ご返金のお知らせ（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返金の手続きをいたしました。',
        '',
        '返金額: ￥12,500（うち送料 ￥500）',
        '返金した商品:',
        '・コート（BLACK / M） × 1',
        '・ストール × 2',
        NOT_SHIPPING_NOTICE,
        STILL_SHIPPING_NOTICE,
        '',
        CARD_TIMING,
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
  });

  it('額だけの返金は返金額の1行だけで、商品の行も、発送前の文も、まだ送る商品の文も、①の文も書かない', () => {
    const email = composeOrderEmail({ ...material(), refund: refundMaterial() }, REFUND_STANDARD);

    expect(email?.text).toContain(
      ['ご注文（ORD-A1B2C3D4）の返金の手続きをいたしました。', '', '返金額: ￥3,000', '', CARD_TIMING].join('\n'),
    );
    expect(email?.text).not.toContain('返金した商品');
    expect(email?.text).not.toContain('（うち送料');
    expect(email?.text).not.toContain(STILL_SHIPPING_NOTICE);
    expect(email?.text).not.toContain(AFTER_CANCEL_NOTICE);
  });

  it.each([
    [3000, 0, '返金額: ￥3,000'],
    [3000, 500, '返金額: ￥3,000（うち送料 ￥500）'],
    [1234567, 1234, '返金額: ￥1,234,567（うち送料 ￥1,234）'],
  ])('返金額 %i・送料 %i の行は「%s」と書く（送料が0なら括弧は書かない。3桁ごとに区切る）', (amount, shippingAmount, expected) => {
    const email = composeOrderEmail({ ...material(), refund: refundMaterial({ amount, shippingAmount }) }, REFUND_STANDARD);

    expect(email?.text).toContain(`\n${expected}\n`);
  });

  it('商品の行は「・品名（色 / サイズ） × 数」。色かサイズの片方だけならその1つだけ、どちらも無ければ括弧を付けない。値段は書かない', () => {
    const email = composeOrderEmail(
      {
        ...material(),
        refund: refundMaterial({
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: false },
            { item_name: 'パンツ', color: null, size: 'L', quantity: 2, before_shipment: false },
            { item_name: 'ブーツ', color: 'BROWN', size: null, quantity: 3, before_shipment: false },
            { item_name: 'ストール', color: null, size: null, quantity: 10, before_shipment: false },
          ],
        }),
      },
      REFUND_STANDARD,
    );

    expect(email?.text).toContain(
      ['返金した商品:', '・コート（BLACK / M） × 1', '・パンツ（L） × 2', '・ブーツ（BROWN） × 3', '・ストール × 10'].join('\n'),
    );
    // 商品の行は名前と数だけ。後ろに値段を付けない
    const itemLines = (email?.text ?? '').split('\n').filter((line) => line.startsWith('・'));
    expect(itemLines).toEqual(['・コート（BLACK / M） × 1', '・パンツ（L） × 2', '・ブーツ（BROWN） × 3', '・ストール × 10']);
  });

  it.each<[string, RefundLine[], boolean]>([
    ['発送前の行がある', [COAT_BEFORE], true],
    ['発送前と発送後の行がある', [COAT_BEFORE, STOLE_AFTER], true],
    ['発送後の行だけ', [STOLE_AFTER], false],
    ['商品の行が無い（額だけ）', [], false],
  ])('「返金した商品はお送りしません。」は、商品の行に発送前の行がある時だけ書く: %s', (_label, lines, shown) => {
    const email = composeOrderEmail({ ...material(), refund: refundMaterial({ lines }) }, REFUND_STANDARD);

    expect(email?.text.includes(NOT_SHIPPING_NOTICE)).toBe(shown);
  });

  it.each([
    [true, true],
    [false, false],
  ])('「ほかの商品はこれまでどおりお送りします。」は、stillShipping=%s なら 書く=%s', (stillShipping, shown) => {
    const email = composeOrderEmail(
      { ...material(), refund: refundMaterial({ lines: [COAT_BEFORE], stillShipping }) },
      REFUND_STANDARD,
    );

    expect(email?.text.includes(STILL_SHIPPING_NOTICE)).toBe(shown);
  });

  it('まだ送る商品の文は、発送前の文とは別の条件で書く（発送後の行だけの返金でも、額だけの返金でも、まだ送る商品があれば書く）', () => {
    const afterShipmentOnly = composeOrderEmail(
      { ...material(), refund: refundMaterial({ lines: [STOLE_AFTER], stillShipping: true }) },
      REFUND_STANDARD,
    );
    const amountOnly = composeOrderEmail({ ...material(), refund: refundMaterial({ stillShipping: true }) }, REFUND_STANDARD);

    for (const email of [afterShipmentOnly, amountOnly]) {
      expect(email?.text).toContain(STILL_SHIPPING_NOTICE);
      expect(email?.text).not.toContain(NOT_SHIPPING_NOTICE);
    }
  });

  it('①の文は after_cancel の返金のお知らせだけに、返金額の行の次へ書く', () => {
    const source = { ...material({ status: 'cancelled' }), refund: refundMaterial({ amount: 12000 }) };

    const standard = composeOrderEmail(source, REFUND_STANDARD);
    const afterCancel = composeOrderEmail(source, REFUND_AFTER_CANCEL);

    expect(standard?.text).not.toContain(AFTER_CANCEL_NOTICE);
    expect(afterCancel?.text).toContain(['返金額: ￥12,000', AFTER_CANCEL_NOTICE, '', CARD_TIMING].join('\n'));
    // ①の返金は商品の行を持たず、取り消した注文はもう何も送らない
    expect(afterCancel?.text).not.toContain('返金した商品');
    expect(afterCancel?.text).not.toContain(STILL_SHIPPING_NOTICE);
  });

  it('発送前の文・まだ送る商品の文・①の文は、この順で続けて書く', () => {
    const email = composeOrderEmail(
      { ...material(), refund: refundMaterial({ lines: [COAT_BEFORE], stillShipping: true }) },
      REFUND_AFTER_CANCEL,
    );

    expect(email?.text).toContain(
      ['・コート（BLACK / M） × 1', NOT_SHIPPING_NOTICE, STILL_SHIPPING_NOTICE, AFTER_CANCEL_NOTICE, '', CARD_TIMING].join('\n'),
    );
  });

  it('Stripe の画面から全額を返金された一部発送の注文は、未発送だった商品を並べて「お送りしません」と書く。まだ送る商品の文も①の文も書かない（Review Focus 4）', () => {
    const email = composeOrderEmail(
      {
        ...material({ status: 'cancelled' }),
        refund: refundMaterial({
          amount: 14500,
          shippingAmount: 500,
          lines: [
            { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true },
            { item_name: 'ブーツ', color: 'BROWN', size: '25', quantity: 1, before_shipment: true },
          ],
        }),
      },
      REFUND_STANDARD,
    );

    expect(email?.text).toContain(
      [
        '返金額: ￥14,500（うち送料 ￥500）',
        '返金した商品:',
        '・コート（BLACK / M） × 1',
        '・ブーツ（BROWN / 25） × 1',
        NOT_SHIPPING_NOTICE,
        '',
        CARD_TIMING,
      ].join('\n'),
    );
    expect(email?.text).not.toContain(STILL_SHIPPING_NOTICE);
    expect(email?.text).not.toContain(AFTER_CANCEL_NOTICE);
  });

  it('金額は注文の内容・合計と同じ書き方（全角の ￥ と桁区切り）で書き、1通の中に半角の ¥ が混ざらない（返金のお知らせも、支払い済みのキャンセルのお知らせも）', () => {
    const refund = refundMaterial({ amount: 12500, shippingAmount: 500, lines: [COAT_BEFORE] });

    const refundMail = composeOrderEmail({ ...material(), refund }, REFUND_STANDARD);
    const canceledMail = composeOrderEmail({ ...material({ status: 'cancelled' }), refund }, CANCELED_PAID);

    expect(refundMail?.text).toContain('返金額: ￥12,500（うち送料 ￥500）');
    expect(canceledMail?.text).toContain('お支払いいただいた ￥12,500（全額）を返金いたします。');
    // 注文の内容・合計の金額（￥10,000）と同じ全角にそろい、半角の ¥（コード 0xA5）は本文のどこにも出ない
    const halfWidthYen = String.fromCharCode(0xa5);
    expect(canceledMail?.text).toContain('合計: ￥10,000');
    expect(refundMail?.text).not.toContain(halfWidthYen);
    expect(canceledMail?.text).not.toContain(halfWidthYen);
  });

  it.each([
    ['返金のお知らせ', REFUND_STANDARD],
    ['支払い済みのキャンセルのお知らせ', CANCELED_PAID],
  ] as const)('%s は、返金の材料が無ければ作らない', (_label, request) => {
    expect(composeOrderEmail({ ...material({ status: 'cancelled' }), refund: null }, request)).toBeNull();
  });

  it('件名には氏名も商品名も入れない（返金のお知らせも、支払い済みのキャンセルのお知らせも）', () => {
    const source = {
      ...material({ status: 'cancelled', shipping_full_name: '山田\r\nBcc: x@example.com' }),
      refund: refundMaterial({ lines: [COAT_BEFORE] }),
    };

    for (const request of [REFUND_STANDARD, CANCELED_PAID]) {
      const email = composeOrderEmail(source, request);
      expect(email?.subject).not.toContain('山田');
      expect(email?.subject).not.toContain('コート');
      expect(email?.subject).not.toMatch(/[\r\n]/);
    }
  });
});

describe('お金が戻る時期の文（返金のお知らせと、支払い済みのキャンセルのお知らせで同じ）', () => {
  it.each([
    ['カード', 'card', null, CARD_TIMING],
    ['Link', 'link', null, CARD_TIMING],
    ['カード（期限が入っていても使わない）', 'card', '2026-11-24T15:30:00.000Z', CARD_TIMING],
    ['PayPay', 'paypay', null, PAYPAY_TIMING],
    ['コンビニ払い（その日のうちなら間に合う最後の日を書く）', 'konbini', '2026-11-24T15:30:00.000Z', konbiniTiming('2026年11月24日')],
    ['コンビニ払い（期限が空）', 'konbini', null, UNKNOWN_TIMING],
    ['コンビニ払い（期限が読めない）', 'konbini', 'あした', UNKNOWN_TIMING],
    ['支払い方法が空', null, null, UNKNOWN_TIMING],
    ['知らない支払い方法', 'customer_balance', null, UNKNOWN_TIMING],
  ])('%s', (_label, paymentMethodType, customerActionExpiresAt, expected) => {
    const refund = refundMaterial({ paymentMethodType, customerActionExpiresAt });

    const refundMail = composeOrderEmail({ ...material(), refund }, REFUND_STANDARD);
    const canceledMail = composeOrderEmail({ ...material({ status: 'cancelled' }), refund }, CANCELED_PAID);

    expect(refundMail?.text).toContain(`\n\n${expected}\n\n`);
    expect(canceledMail?.text).toContain(`\n\n${expected}\n\n`);
  });

  it.each([
    ['日本時間の11月25日0時30分は前日まで', '2026-11-24T15:30:00.000Z', '2026年11月24日'],
    ['日本時間の11月25日23時59分59秒は当日まで', '2026-11-25T14:59:59.000Z', '2026年11月25日'],
    ['日本時間の11月26日0時は前日まで', '2026-11-25T15:00:00.000Z', '2026年11月25日'],
    ['月と日に0を付けない', '2026-01-05T00:00:00.000Z', '2026年1月4日'],
    ['年をまたぐ（日本時間の1月1日0時）', '2026-12-31T15:00:00.000Z', '2026年12月31日'],
    ['年をまたぐ手前（日本時間の12月31日23時59分）', '2026-12-31T14:59:59.000Z', '2026年12月31日'],
  ])('コンビニ払いの期限の日付: %s', (_label, customerActionExpiresAt, date) => {
    const refund = refundMaterial({ paymentMethodType: 'konbini', customerActionExpiresAt });

    expect(composeOrderEmail({ ...material(), refund }, REFUND_STANDARD)?.text).toContain(konbiniTiming(date));
    expect(composeOrderEmail({ ...material({ status: 'cancelled' }), refund }, CANCELED_PAID)?.text).toContain(konbiniTiming(date));
  });
});

describe('composeOrderEmail（支払い済みのキャンセルのお知らせ）', () => {
  it('理由の文・全額の返金・戻る時期・注文の内容の順に書く。件名は未入金の取消と同じで、「お支払いは発生していません。」は書かない', () => {
    const email = composeOrderEmail(
      {
        ...material({ status: 'cancelled', paid_amount: 10000 }),
        refund: refundMaterial({ amount: 10000, cancelReason: 'stock_unavailable' }),
      },
      CANCELED_PAID,
    );

    expect(email).toEqual({
      subject: '【Le Fil des Heures】ご注文取消のお知らせ（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        '商品をご用意できなくなったため、ご注文を取り消しました。',
        'お支払いいただいた ￥10,000（全額）を返金いたします。',
        '',
        CARD_TIMING,
        '',
        '注文番号: ORD-A1B2C3D4',
        '',
        'ご注文内容:',
        '・コート（BLACK / M） x1　￥10,000',
        '',
        '合計: ￥10,000',
        '',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。',
        '',
        'Le Fil des Heures',
      ].join('\n'),
    });
    expect(email?.text).not.toContain('お支払いは発生していません。');
  });

  it.each([
    ['受取額と同じ額を全額返す（注文の合計とは異なる）', 12500, 12500, 'お支払いいただいた ￥12,500（全額）を返金いたします。'],
    ['前に返金があり、残りの額を返す', 12500, 3000, 'お支払いいただいた金額のうち、残りの ￥3,000 を返金いたします。'],
    ['受取額が空なら注文の合計を全額返す', null, 10000, 'お支払いいただいた ￥10,000（全額）を返金いたします。'],
  ] as const)('返金額の案内: %s', (_label, paidAmount, amount, expected) => {
    const email = composeOrderEmail(
      { ...material({ status: 'cancelled', paid_amount: paidAmount }), refund: refundMaterial({ amount }) },
      CANCELED_PAID,
    );

    expect(email?.text).toContain(expected);
    if (paidAmount !== null && amount < paidAmount) {
      expect(email?.text).not.toContain('（全額）');
    } else {
      expect(email?.text).not.toContain('残りの');
    }
    expect(email?.text).not.toContain('¥');
  });

  it.each([
    ['在庫切れ', 'stock_unavailable', '商品をご用意できなくなったため、ご注文を取り消しました。'],
    ['お客様の依頼', 'customer_request', 'ご依頼により、ご注文を取り消しました。'],
    ['不正の疑い（理由は書かない）', 'suspected_fraud', 'ご注文を取り消しました。'],
    ['その他（理由は書かない）', 'other', 'ご注文を取り消しました。'],
    ['理由が空（記録の欠け。理由は書かない）', null, 'ご注文を取り消しました。'],
  ] as const)('理由の文: %s', (_label, cancelReason, lead) => {
    const email = composeOrderEmail(
      { ...material({ status: 'cancelled', paid_amount: 3000 }), refund: refundMaterial({ cancelReason }) },
      CANCELED_PAID,
    );

    expect(email?.text).toContain(
      ['山田 花子 様', '', lead, 'お支払いいただいた ￥3,000（全額）を返金いたします。'].join('\n'),
    );
    expect(email?.text).not.toContain('不正');
  });

  it('未入金の取消のお知らせは今のまま。お支払いは発生していないと書き、返金の文は書かない', () => {
    const email = composeOrderEmail(
      { ...material({ status: 'cancelled' }), refund: refundMaterial() },
      { kind: 'canceled', variant: 'pending', paymentExpiredSent: false },
    );

    expect(email?.text).toContain(
      ['お支払い待ちのご注文を取り消しました。', 'お支払いは発生していません。', '', '注文番号: ORD-A1B2C3D4'].join('\n'),
    );
    expect(email?.text).not.toContain('返金');
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
  const REFUND_ROW = {
    amount: 12500,
    shipping_amount: 500,
    payment_method_type: 'konbini',
    customer_action_expires_at: '2026-11-24T15:30:00.000Z',
    cancel_reason: 'stock_unavailable',
  };
  const COAT = { item_name: 'コート', color: 'BLACK', size: 'M', created_at: '2026-10-10T01:00:00.000Z' };
  const STOLE = { item_name: 'ストール', color: null, size: null, created_at: '2026-10-10T01:00:01.000Z' };

  /** 返金の商品の行（DB の答えの形） */
  function refundLineRow(
    orderItemId: string,
    quantity: number,
    beforeShipment: boolean,
    item: { item_name: string; color: string | null; size: string | null; created_at: string },
  ) {
    return { order_item_id: orderItemId, quantity, before_shipment: beforeShipment, order_items: item };
  }

  /**
   * list_order_line_fulfillment の答えの1行。未発送の数だけを変える。数の関係は Global Constraints のとおり（未発送 = 注文の数 − 発送した数 − 発送前に返金した数）。
   * 受注生産の作っている途中の品にして、発送準備中は0にする。実装が発送準備中でなく未発送を見ていること（作っている途中の品も「まだ送る」に数えること）を確かめるため
   */
  function countRow(unshipped: number, index = 0) {
    return {
      order_id: ORDER_ID, order_item_id: `item-${index}`, variant_id: 1, fulfillment_type: 'backorder', quantity: 2,
      shipped: 0, completed: 0, refunded_before_shipment: 2 - unshipped, refunded_after_shipment: 0,
      in_production: unshipped, ready_unshipped: 0, unshipped,
    };
  }

  type FilterChain = {
    eq: (column: string, value: unknown) => FilterChain;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  };

  function store(results: {
    order: unknown; orderError?: unknown; items?: unknown; itemsError?: unknown;
    fulfillment?: unknown; fulfillmentError?: unknown; lines?: unknown; linesError?: unknown;
    refund?: unknown; refundError?: unknown; refundLines?: unknown; refundLinesError?: unknown;
    unshipped?: unknown; unshippedError?: unknown;
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
    const refundFilters: Array<[string, unknown]> = [];
    const refundChain: FilterChain = {
      eq: (column, value) => {
        refundFilters.push([column, value]);
        return refundChain;
      },
      maybeSingle: async () => ({ data: results.refund ?? null, error: results.refundError ?? null }),
    };
    const refundSelect = jest.fn(() => refundChain);
    const refundLineFilters: Array<[string, unknown]> = [];
    const refundLineSelect = jest.fn(() => ({
      eq: async (column: string, value: unknown) => {
        refundLineFilters.push([column, value]);
        return { data: results.refundLines ?? null, error: results.refundLinesError ?? null };
      },
    }));
    const rpc = jest.fn(async () => ({ data: results.unshipped ?? [], error: results.unshippedError ?? null }));
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
      if (table === 'order_refunds') {
        return { select: refundSelect };
      }
      if (table === 'order_refund_lines') {
        return { select: refundLineSelect };
      }
      return { select: itemSelect };
    });
    return {
      client: { from, rpc } as never, from, rpc, orderSelect, itemSelect, fulfillmentSelect, fulfillmentFilters, lineSelect, lineFilters,
      refundSelect, refundFilters, refundLineSelect, refundLineFilters,
    };
  }

  it('注文と明細を読む。注文の状態・受取額は読むが、配送業者・伝票番号は注文の行から読まない', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({ order, items });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID)).resolves.toEqual({ order, items, fulfillment: null, refund: null });
    const columns = (db.orderSelect.mock.calls[0] as unknown as [string])[0].split(',').map((column) => column.trim());
    expect(columns).toEqual([
      'id', 'status', 'shipping_email', 'shipping_full_name', 'subtotal_amount', 'shipping_amount', 'discount_amount',
      'total_amount', 'paid_amount', 'currency', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address',
      'shipping_building', 'shipping_phone', 'review_reason',
    ]);
    expect(db.itemSelect).toHaveBeenCalledWith('item_name, color, size, quantity, line_total, fulfillment_type');
    // 発送の番号も返金の番号も無い種類は、発送・返金の表も DB の数え方も読まない
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillments');
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillment_lines');
    expect(db.from).not.toHaveBeenCalledWith('order_refunds');
    expect(db.from).not.toHaveBeenCalledWith('order_refund_lines');
    expect(db.rpc).not.toHaveBeenCalled();
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
      refund: null,
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

  it('返金の番号があれば、その返金の額・送料・支払い方法・期限・取消の理由・商品を読み、まだ送る商品があるかを数える（注文の番号でも絞る）', async () => {
    const order = material().order;
    const items = material().items;
    const db = store({
      order,
      items,
      refund: REFUND_ROW,
      // 商品の登録順と逆の並びで返す
      refundLines: [refundLineRow('item-stole', 2, false, STOLE), refundLineRow('item-coat', 1, true, COAT)],
      unshipped: [countRow(1)],
    });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID)).resolves.toEqual({
      order,
      items,
      fulfillment: null,
      refund: {
        amount: 12500,
        shippingAmount: 500,
        paymentMethodType: 'konbini',
        customerActionExpiresAt: '2026-11-24T15:30:00.000Z',
        cancelReason: 'stock_unavailable',
        lines: [
          { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true },
          { item_name: 'ストール', color: null, size: null, quantity: 2, before_shipment: false },
        ],
        stillShipping: true,
      },
    });
    expect(db.refundSelect).toHaveBeenCalledWith('amount, shipping_amount, payment_method_type, customer_action_expires_at, cancel_reason');
    expect(db.refundFilters).toEqual([['id', REFUND_ID], ['order_id', ORDER_ID]]);
    expect(db.refundLineSelect).toHaveBeenCalledWith('order_item_id, quantity, before_shipment, order_items(item_name, color, size, created_at)');
    expect(db.refundLineFilters).toEqual([['refund_id', REFUND_ID]]);
    expect(db.rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
    // 返金の番号だけを渡した時は、発送の表を読まない
    expect(db.from).not.toHaveBeenCalledWith('order_fulfillments');
  });

  it('同じ商品の発送前と発送後の行は1行にまとめる（数は足し、発送前の印は1つでもあれば付く）', async () => {
    const db = store({
      order: material().order,
      items: material().items,
      refund: REFUND_ROW,
      refundLines: [refundLineRow('item-coat', 2, false, COAT), refundLineRow('item-coat', 1, true, COAT)],
      unshipped: [],
    });

    const loaded = await loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID);

    expect(loaded?.refund?.lines).toEqual([{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 3, before_shipment: true }]);
  });

  it('商品の行は、商品の登録順（作った時刻、同じなら番号）に並べる', async () => {
    const item = (name: string, second: number) => ({
      item_name: name, color: null, size: null, created_at: `2026-10-10T01:00:0${second}.000Z`,
    });
    const db = store({
      order: material().order,
      items: material().items,
      refund: REFUND_ROW,
      // 作った時刻は「一番目」が先。「二番目の上」と「二番目の下」は同じ時刻なので、番号（item-a が item-b より先）で決まる
      refundLines: [
        refundLineRow('item-b', 1, true, item('二番目の下', 1)),
        refundLineRow('item-z', 1, true, item('一番目', 0)),
        refundLineRow('item-a', 1, true, item('二番目の上', 1)),
      ],
      unshipped: [],
    });

    const loaded = await loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID);

    expect(loaded?.refund?.lines.map((line) => line.item_name)).toEqual(['一番目', '二番目の上', '二番目の下']);
  });

  it.each<[string, OrderEmailMaterial['order']['status'], number[], boolean, number]>([
    ['決済完了で、これから送る商品がある', 'paid', [1, 0], true, 1],
    ['決済完了で、これから送る商品が残っていない', 'paid', [0, 0], false, 1],
    ['キャンセルの注文は、商品が未発送に数えられていても数えない（DB の数え方を呼ばない）', 'cancelled', [2], false, 0],
    ['発送済みの注文は数えない（DB の数え方を呼ばない）', 'shipped', [1], false, 0],
  ])('まだ送る商品の判定: %s', async (_label, status, unshippedCounts, expected, rpcCalls) => {
    const base = material({ status });
    const db = store({
      order: base.order,
      items: base.items,
      refund: REFUND_ROW,
      refundLines: [],
      unshipped: unshippedCounts.map((count, index) => countRow(count, index)),
    });

    const loaded = await loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID);

    expect(loaded?.refund?.stillShipping).toBe(expected);
    expect(db.rpc).toHaveBeenCalledTimes(rpcCalls);
  });

  it('返金の商品の行が0件（額だけの返金）でも、空の値は null のまま材料を作る', async () => {
    const db = store({
      order: material().order,
      items: material().items,
      refund: { ...REFUND_ROW, shipping_amount: 0, payment_method_type: null, customer_action_expires_at: null, cancel_reason: null },
      refundLines: [],
      unshipped: [],
    });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID)).resolves.toMatchObject({
      refund: {
        amount: 12500, shippingAmount: 0, paymentMethodType: null, customerActionExpiresAt: null, cancelReason: null,
        lines: [], stillShipping: false,
      },
    });
  });

  it('返金の記録が無ければ null（別の注文の返金の番号を渡して絞り込みで見つからない場合も同じ）。商品の行も DB の数え方も読まない', async () => {
    const db = store({ order: material().order, items: material().items });

    await expect(loadOrderEmailMaterial(db.client, ORDER_ID, null, REFUND_ID)).resolves.toBeNull();
    expect(db.refundLineSelect).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('返金の記録・返金の商品の行・DB の数え方を読めなければ OrderEmailMaterialError を投げる', async () => {
    const order = material().order;
    const items = material().items;
    const down = { message: 'down' };

    await expect(
      loadOrderEmailMaterial(store({ order, items, refundError: down }).client, ORDER_ID, null, REFUND_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_refunds' });
    await expect(
      loadOrderEmailMaterial(store({ order, items, refund: REFUND_ROW, refundLinesError: down }).client, ORDER_ID, null, REFUND_ID),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'order_refund_lines' });
    await expect(
      loadOrderEmailMaterial(
        store({ order, items, refund: REFUND_ROW, refundLines: [], unshippedError: down }).client,
        ORDER_ID,
        null,
        REFUND_ID,
      ),
    ).rejects.toMatchObject({ name: 'OrderEmailMaterialError', table: 'list_order_line_fulfillment' });
  });
});
