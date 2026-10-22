import { composeOrderEmail, type OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import type { OrderEmailDeliveryMaterial } from '@/lib/orders/email/order-email-delivery-material';
import type { DeliveryEmailKind } from '@/lib/orders/email/order-email-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
// 状況のリンク（グループ E-5 計画 C-6）。URL の中のトークンは試験用の作り物
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const STATUS_LINE = `ご注文の状況はこちら: ${STATUS_URL}`;

function material(overrides: Partial<OrderEmailDeliveryMaterial> = {}): OrderEmailMaterial {
  return {
    order: {
      id: ORDER_ID, status: 'shipped', shipping_email: 'customer@example.com', shipping_full_name: 'テスト 太郎',
      subtotal_amount: 98765, shipping_amount: 1234, discount_amount: 0, total_amount: 99999, currency: 'jpy',
      shipping_postal_code: '1234567', shipping_prefecture: '非表示県', shipping_city: '非表示市',
      shipping_address: '秘密の住所', shipping_building: '秘密の建物', shipping_phone: '0312345678', review_reason: null,
    },
    // 同じ品を3個注文して1個だけ発送した。価格・注文全体の数・別発送の商品は出さない。
    items: [
      { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 3, line_total: 98765 },
      { item_name: '別の発送の品', quantity: 1, line_total: 1234 },
    ],
    fulfillment: {
      number: 2, carrier: 'yamato', trackingNumber: 'OLD-NUMBER', completesOrder: false, cancelled: false,
      lines: [{ item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 }],
    },
    refund: null, orderReturn: null, request: null, orderStatusUrl: STATUS_URL,
    delivery: {
      fulfillmentId: 'fulfillment-1', trackingVersion: 2, currentTrackingVersion: 2, cancelled: false,
      deliveryStatus: 'out_for_delivery', deliveredAt: '2026-10-20T15:01:00.000Z', windowDays: 7,
      carrier: 'sagawa', trackingNumber: 'NEW-1234', ...overrides,
    },
  };
}

const compose = (kind: DeliveryEmailKind, source = material()) =>
  composeOrderEmail(source, { kind, variant: null, paymentExpiredSent: false });

// C-6全文の独立した期待（数量はcontrollerの決定どおり既存の x{数}）。実装側のformatter・定数・URL生成は使わない。
const OUT_FOR_DELIVERY = `テスト 太郎 様

ご注文の商品を配達中です。

注文番号: ORD-A1B2C3D4

配達中の商品:
・コート（BLACK / M） x1

配送業者: 佐川急便
追跡番号: NEW-1234
追跡はこちら: https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=NEW-1234

${STATUS_LINE}
お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。

Le Fil des Heures`;

const SHIPPING_UPDATE = `テスト 太郎 様

ご注文の発送の情報を更新しました。

注文番号: ORD-A1B2C3D4

発送した商品:
・コート（BLACK / M） x1

配送業者: 佐川急便
追跡番号: NEW-1234
追跡はこちら: https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=NEW-1234

先にお知らせした伝票番号は使えません

${STATUS_LINE}
お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。

Le Fil des Heures`;

const deliveredText = (days: number | null) => `テスト 太郎 様

ご注文の商品をお届けしました。

注文番号: ORD-A1B2C3D4
お届け日: 10月21日

お届けした商品:
・コート（BLACK / M） x1

${days === null ? '' : `商品に不具合がございましたら、到着から ${days} 日以内にご注文の画面またはお問い合わせからご連絡ください\n\n`}${STATUS_LINE}
お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。

Le Fil des Heures`;

describe('配送メールのC-6の件名と本文', () => {
  beforeEach(() => jest.replaceProperty(process, 'env', { NODE_ENV: 'test', NEXT_PUBLIC_SITE_URL: 'https://shop.example.com/' }));
  afterEach(() => jest.restoreAllMocks());

  it('配達中はC-6の全文と一致する', () => {
    expect(compose('out_for_delivery')).toEqual({
      subject: '【Le Fil des Heures】商品を配達中です（ORD-A1B2C3D4）', text: OUT_FOR_DELIVERY,
    });
  });

  it('発送の更新は直した時の新しい番号を使う', () => {
    expect(compose('shipping_update', material({ currentTrackingVersion: 3 }))).toEqual({
      subject: '【Le Fil des Heures】発送の情報を更新しました（ORD-A1B2C3D4）', text: SHIPPING_UPDATE,
    });
  });

  it.each([1, 7, 365, null])('届いた日の案内は設定の%s日、無制限なら一文無し', (windowDays) => {
    const result = compose('delivered', material({ deliveryStatus: 'delivered', windowDays }));
    expect(result).toEqual({
      subject: '【Le Fil des Heures】商品をお届けしました（ORD-A1B2C3D4）', text: deliveredText(windowDays),
    });
    if (windowDays === null) expect(result?.text).not.toContain('到着から');
  });

  it.each(['out_for_delivery', 'delivered', 'shipping_update'] as const)('%sに価格・宛先・住所・電話・providerの文・場所は入らない', (kind) => {
    const result = compose(kind, {
      ...material(),
      ...{ providerDescription: '運送会社の説明文', providerSubStatus: 'OutForDelivery_Other', location: '東京配送センター' },
    });
    expect(result).not.toBeNull();
    for (const forbidden of ['98765', '99999', '¥', '￥', 'customer@example.com', '秘密の住所', '非表示県', '非表示市', '1234567',
      '秘密の建物', '0312345678', '運送会社の説明文', 'OutForDelivery_Other', '東京配送センター', '17TRACK', '別の発送の品', ' x3', 'OLD-NUMBER']) {
      expect(result?.text).not.toContain(forbidden);
    }
    expect(result?.subject).not.toContain('テスト');
  });

  it.each([
    [null, null, '・コート x1'], ['BLACK', null, '・コート（BLACK） x1'],
    [null, 'M', '・コート（M） x1'],
  ])('色%s・サイズ%sが無い時は既存と同じ括弧の書き方', (color, size, expected) => {
    const source = material();
    source.fulfillment!.lines = [{ item_name: 'コート', color, size, quantity: 1 }];
    expect(compose('out_for_delivery', source)?.text).toBe(OUT_FOR_DELIVERY.replace('・コート（BLACK / M） x1', expected));
  });

  it.each([null, 'invalid-date'])('配達済みの必須日付%sが不正なら作らない', (deliveredAt) => {
    expect(compose('delivered', material({ deliveredAt }))).toBeNull();
  });

  it('deliveredの会員用リンクを消しほかの配達済みの文を保つ', () => {
    for (const windowDays of [7, null]) {
      const text = compose('delivered', material({ deliveryStatus: 'delivered', windowDays }))?.text ?? '';

      expect(text.includes('/account/orders/')).toBe(false);
      expect(text.includes('ご注文の確認はこちら:')).toBe(false);
      // 旧リンクとその後の空行だけが消え、配達済みの冒頭・お届け日・商品・返品の案内・問い合わせ文・店の名前は残る
      for (const kept of [
        'ご注文の商品をお届けしました。', '注文番号: ORD-A1B2C3D4', 'お届け日: 10月21日', 'お届けした商品:', '・コート（BLACK / M） x1',
        'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。', 'Le Fil des Heures',
      ]) {
        expect(text.split('\n')).toContain(kept);
      }
      expect(text.includes('到着から')).toBe(windowDays !== null);
      // 新しい末尾は「空行 → 状況のリンク → 問い合わせ文 → 空行 → 店の名前」。連続した空行は作らない
      expect(text.endsWith(`\n\n${STATUS_LINE}\nお問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。\n\nLe Fil des Heures`)).toBe(true);
      expect(text.includes('\n\n\n')).toBe(false);
    }
  });

  it.each(['out_for_delivery', 'delivered', 'shipping_update'] as const)(
    '%sは状況のURLが無い・使えない材料なら作らない（サイトの設定は読まず、材料のURLだけを使う）',
    (kind) => {
      const source = material({ deliveryStatus: kind === 'delivered' ? 'delivered' : 'out_for_delivery' });
      for (const orderStatusUrl of [undefined, null, '', 'not a url', 'ftp://shop.example.test/order-status/x', 'javascript:alert(1)']) {
        expect(compose(kind, { ...source, orderStatusUrl })).toBeNull();
      }
      // 以前は配達済みだけがサイトの住所から旧リンクを作っていた。今は設定が壊れていても材料のURLがあれば作れる
      for (const siteUrl of ['http://', 'https://[broken']) {
        process.env.NEXT_PUBLIC_SITE_URL = siteUrl;
        expect(compose(kind, source)?.text).toContain(STATUS_LINE);
      }
    },
  );

  it.each(['out_for_delivery', 'delivered', 'shipping_update'] as const)('%sは配送材料が無ければ作らない', (kind) => {
    const source = material();
    delete source.delivery;
    expect(compose(kind, source)).toBeNull();
  });
});
