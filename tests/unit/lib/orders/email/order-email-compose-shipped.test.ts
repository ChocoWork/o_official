import { composeOrderEmail, type OrderEmailMaterial, type OrderEmailFulfillmentMaterial } from '@/lib/orders/email/order-email-compose';
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const STATUS_LINE = `ご注文の状況はこちら: ${STATUS_URL}`;
const CONTACT = 'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。';
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
      paid_amount: null,
      currency: 'jpy',
      shipping_postal_code: '1500001',
      shipping_prefecture: '東京都',
      shipping_city: '渋谷区',
      shipping_address: '神宮前1-1-1',
      shipping_building: null,
      shipping_phone: '0311112222',
      review_reason: null, cancel_reason: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1, line_total: 10000, fulfillment_type: 'backorder' }],
    fulfillment: null,
    refund: null,
    orderReturn: null, request: null,
    orderStatusUrl: STATUS_URL,
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


const opening = ['山田 花子 様', '', 'ご注文の商品を発送いたしました。', '', '注文番号: ORD-A1B2C3D4', '', '発送した商品:', '・コート（BLACK / M） x1', ''];
const ending = ['', STATUS_LINE, CONTACT, '', 'Le Fil des Heures'];
test.each([true, false])('FREQ-533-AC-05: 番号ありは全品・一部発送とも変更前の件名と本文に1文字も違わず一致する（完了=%s）', (completesOrder) => {
  expect(composeOrderEmail({ ...material(), fulfillment: shipment({ completesOrder }) }, SHIPPED)).toEqual({
    subject: '【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）',
    text: [...opening, '配送業者: ヤマト運輸', '追跡番号: 1234-5678', '追跡はこちら: https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678', '', '※ 追跡情報は反映までに数時間かかる場合があります。', ...(completesOrder ? [] : ['残りの商品は、準備ができ次第お送りします。']), ...ending].join('\n'),
  });
});
test.each([true, false])('FREQ-533-AC-05: 番号なしの本文は完全一致し、その注文の発送商品と残りの案内だけを含む（完了=%s）', (completesOrder) => {
  const value = material();
  value.items.push({ item_name: '別注文の商品を含めない', color: null, size: null, quantity: 10, line_total: 100, fulfillment_type: 'stock' });
  expect(composeOrderEmail({ ...value, fulfillment: shipment({ carrier: null, trackingNumber: null, completesOrder }) }, SHIPPED)).toEqual({
    subject: '【Le Fil des Heures】商品を発送いたしました（ORD-A1B2C3D4）',
    text: [...opening, '伝票番号が決まりましたら、あらためてお知らせいたします。', ...(completesOrder ? [] : ['残りの商品は、準備ができ次第お送りします。']), ...ending].join('\n'),
  });
});
