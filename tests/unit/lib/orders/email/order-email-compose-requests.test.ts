import {
  composeOrderEmail,
  type OrderEmailMaterial,
  type OrderEmailRequestMaterial,
  type OrderEmailReturnRequestLine,
} from '@/lib/orders/email/order-email-compose';
import {
  CANCEL_REQUEST_EMAIL_KINDS,
  isReturnRequestEmailKind,
  REQUEST_EMAIL_KINDS,
  RETURN_REQUEST_EMAIL_KINDS,
  type RequestEmailKind,
} from '@/lib/orders/email/order-email-types';

/**
 * 申し込みのメール6種類（グループ E-3 段2 計画 C-6）の件名と本文を、決めた行の順に一字ずつ比べる。
 * 文言は計画 C-6 から写した字のままにする（試験の期待値は、実装の定数を使わずに文で書く）。
 * お客様の詳しい内容・ご連絡事項と写真は、材料に無い（読まない）ので、本文にも出ない
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CONTACT = 'お問い合わせの際は、注文番号（ORD-A1B2C3D4）をお問い合わせフォームにご入力ください。';
const SHOP = 'Le Fil des Heures';
// 状況のリンク（グループ E-5 計画 C-6）。URL の中のトークンは試験用の作り物
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const STATUS_LINE = `ご注文の状況はこちら: ${STATUS_URL}`;

const COAT_REFUND: OrderEmailReturnRequestLine = {
  item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1,
  reason: 'defective', requestedResolution: 'refund', requestedExchange: null, photoCount: 2,
};
const DRESS_EXCHANGE: OrderEmailReturnRequestLine = {
  item_name: 'ワンピース', color: 'NAVY', size: 'S', quantity: 2,
  reason: 'size_too_small', requestedResolution: 'exchange', requestedExchange: { color: 'NAVY', size: 'M' }, photoCount: 0,
};

type ReturnRequest = Extract<OrderEmailRequestMaterial, { kind: 'return' }>;
type CancelRequest = Extract<OrderEmailRequestMaterial, { kind: 'cancel' }>;

function returnRequest(overrides: Partial<ReturnRequest> = {}): ReturnRequest {
  return { kind: 'return', number: 2, declineMessage: null, lines: [COAT_REFUND, DRESS_EXCHANGE], ...overrides };
}

function cancelRequest(overrides: Partial<CancelRequest> = {}): CancelRequest {
  return {
    kind: 'cancel',
    declineMessage: null,
    lines: [
      { item_name: 'コート', color: 'BLACK', size: 'M', quantity: 1 },
      { item_name: 'ストール', color: null, size: null, quantity: 2 },
    ],
    ...overrides,
  };
}

function material(
  request: OrderEmailRequestMaterial | null,
  orderOverrides: Partial<OrderEmailMaterial['order']> = {},
): OrderEmailMaterial {
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
      cancel_reason: null,
      ...orderOverrides,
    },
    items: [],
    fulfillment: null,
    refund: null,
    orderReturn: null,
    request,
    orderStatusUrl: STATUS_URL,
  };
}

function compose(
  kind: RequestEmailKind,
  request: OrderEmailRequestMaterial | null,
  orderOverrides: Partial<OrderEmailMaterial['order']> = {},
) {
  return composeOrderEmail(material(request, orderOverrides), { kind, variant: null, paymentExpiredSent: false });
}

describe('composeOrderEmail（返品のお申し込みの受付）', () => {
  it('返金と交換の行を、理由とご希望を添えて、決めた行の順に書く。写真の数は書かない', () => {
    const email = compose('return_requested', returnRequest());

    expect(email).toEqual({
      subject: '【Le Fil des Heures】返品のお申し込みを受け付けました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品のお申し込みを受け付けました（返品番号 ORD-A1B2C3D4-R2）。',
        '',
        'お申し込みの商品:',
        '・コート（BLACK / M） × 1（理由: 破損・不良／ご希望: 返金）',
        '・ワンピース（NAVY / S） × 2（理由: サイズが小さい／ご希望: 交換 NAVY / M）',
        '',
        '内容を確かめて、ご連絡いたします。',
        '',
        STATUS_LINE,
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
    expect(email?.text).not.toContain('写真');
  });

  it.each([
    ['色とサイズ', { color: 'NAVY', size: 'M' }, 'ご希望: 交換 NAVY / M'],
    ['色だけ', { color: 'NAVY', size: null }, 'ご希望: 交換 NAVY'],
    ['サイズだけ', { color: null, size: 'M' }, 'ご希望: 交換 M'],
    ['どちらも無い', { color: null, size: null }, 'ご希望: 交換'],
  ] as const)('交換のご希望の色・サイズの書き方: %s', (_name, requestedExchange, wish) => {
    const line: OrderEmailReturnRequestLine = { ...DRESS_EXCHANGE, requestedExchange };

    const email = compose('return_requested', returnRequest({ lines: [line] }));

    expect(email?.text).toContain(`・ワンピース（NAVY / S） × 2（理由: サイズが小さい／${wish}）`);
  });

  it('宛名が無い注文は「お客様」と書く', () => {
    const email = compose('return_requested', returnRequest(), { shipping_full_name: null });

    expect(email?.text.split('\n')[0]).toBe('お客様');
  });

  it.each([
    ['申し込みの材料が無い', null],
    ['返品の行が無い', returnRequest({ lines: [] })],
    ['キャンセルの申し込みの材料', cancelRequest()],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('return_requested', request)).toBeNull();
  });
});

describe('composeOrderEmail（返品のお申し込みについて）', () => {
  const DECLINED = '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。';

  it('お断りのメッセージを、書かれたまま「当店より:」の下に書く', () => {
    const email = compose('return_declined', returnRequest({ declineMessage: DECLINED, lines: [] }));

    expect(email).toEqual({
      subject: '【Le Fil des Heures】返品のお申し込みについて（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品のお申し込み（返品番号 ORD-A1B2C3D4-R2）は、お受けすることができませんでした。',
        '',
        '当店より:',
        DECLINED,
        '',
        STATUS_LINE,
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('メッセージの改行・空行・末尾の空白は、そのまま書く', () => {
    const message = `${DECLINED}\n\nまたのご利用をお待ちしております。 `;

    const email = compose('return_declined', returnRequest({ declineMessage: message, lines: [] }));

    expect(email?.text).toBe(
      [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）の返品のお申し込み（返品番号 ORD-A1B2C3D4-R2）は、お受けすることができませんでした。',
        '',
        '当店より:',
        DECLINED,
        '',
        'またのご利用をお待ちしております。 ',
        '',
        STATUS_LINE,
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    );
  });

  it('品の行は書かない（材料に行があっても使わない）', () => {
    const email = compose('return_declined', returnRequest({ declineMessage: DECLINED }));

    expect(email?.text).not.toContain('コート');
    expect(email?.text).not.toContain('お申し込みの商品:');
  });

  it.each([
    ['メッセージが無い', returnRequest({ declineMessage: null })],
    ['メッセージが空', returnRequest({ declineMessage: '' })],
    ['申し込みの材料が無い', null],
    ['キャンセルの申し込みの材料', cancelRequest({ declineMessage: DECLINED })],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('return_declined', request)).toBeNull();
  });
});

describe('composeOrderEmail（店への知らせ（返品の申し込み））', () => {
  it('理由・ご希望・写真の数を添えて、決めた行の順に書く。宛名・問い合わせの案内・店の名前は付けない', () => {
    const email = compose('return_request_shop', returnRequest());

    expect(email).toEqual({
      subject: '【要対応】返品の申し込みが届きました（ORD-A1B2C3D4）',
      text: [
        'お客様から返品の申し込みが届きました（返品番号 ORD-A1B2C3D4-R2）。',
        '',
        '申し込みの商品:',
        '・コート（BLACK / M） × 1（理由: 破損・不良／ご希望: 返金／写真 2枚）',
        '・ワンピース（NAVY / S） × 2（理由: サイズが小さい／ご希望: 交換 NAVY / M／写真 0枚）',
        '',
        '管理画面の注文の一覧で「申し込みを確かめる」を押して、承認するかお断りしてください。',
      ].join('\n'),
    });
  });

  it('お客様の氏名・メール・住所と、詳しい内容・ご連絡事項は書かない', () => {
    const email = compose('return_request_shop', returnRequest());

    for (const text of ['山田', 'hanako@example.com', '1500001', '神宮前', '詳しい内容', CONTACT, SHOP, 'ご注文の状況はこちら', 'order-status']) {
      expect(email?.text).not.toContain(text);
    }
  });

  it('交換のご希望は色・サイズつきで書く。写真が3枚なら「写真 3枚」', () => {
    const line: OrderEmailReturnRequestLine = { ...DRESS_EXCHANGE, quantity: 1, photoCount: 3 };

    const email = compose('return_request_shop', returnRequest({ lines: [line] }));

    expect(email?.text).toContain('・ワンピース（NAVY / S） × 1（理由: サイズが小さい／ご希望: 交換 NAVY / M／写真 3枚）');
  });

  it.each([
    ['返品の行が無い', returnRequest({ lines: [] })],
    ['申し込みの材料が無い', null],
    ['キャンセルの申し込みの材料', cancelRequest()],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('return_request_shop', request)).toBeNull();
  });
});

describe('composeOrderEmail（キャンセルのお申し込みの受付）', () => {
  it('申し込みの品を、決めた行の順に書く', () => {
    const email = compose('cancel_request_received', cancelRequest());

    expect(email).toEqual({
      subject: '【Le Fil des Heures】キャンセルのお申し込みを受け付けました（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）のキャンセルのお申し込みを受け付けました。',
        '',
        'お申し込みの商品:',
        '・コート（BLACK / M） × 1',
        '・ストール × 2',
        '',
        '内容を確かめて、ご連絡いたします。',
        '',
        STATUS_LINE,
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it.each([
    ['品の行が無い', cancelRequest({ lines: [] })],
    ['申し込みの材料が無い', null],
    ['返品の申し込みの材料', returnRequest()],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('cancel_request_received', request)).toBeNull();
  });
});

describe('composeOrderEmail（キャンセルのお申し込みについて）', () => {
  const DECLINED = 'すでに発送の準備が終わっているため、キャンセルはお受けできませんでした。';

  it('お断りのメッセージを、書かれたまま「当店より:」の下に書く', () => {
    const email = compose('cancel_request_declined', cancelRequest({ declineMessage: DECLINED, lines: [] }));

    expect(email).toEqual({
      subject: '【Le Fil des Heures】キャンセルのお申し込みについて（ORD-A1B2C3D4）',
      text: [
        '山田 花子 様',
        '',
        'ご注文（ORD-A1B2C3D4）のキャンセルのお申し込みは、お受けすることができませんでした。',
        '',
        '当店より:',
        DECLINED,
        '',
        STATUS_LINE,
        CONTACT,
        '',
        SHOP,
      ].join('\n'),
    });
  });

  it('メッセージの改行・空行は、そのまま書く', () => {
    const email = compose('cancel_request_declined', cancelRequest({ declineMessage: `${DECLINED}\n\nご不明な点はお問い合わせください。`, lines: [] }));

    expect(email?.text).toContain(['当店より:', DECLINED, '', 'ご不明な点はお問い合わせください。', '', STATUS_LINE, CONTACT].join('\n'));
  });

  it.each([
    ['メッセージが無い', cancelRequest({ declineMessage: null })],
    ['メッセージが空', cancelRequest({ declineMessage: '' })],
    ['申し込みの材料が無い', null],
    ['返品の申し込みの材料', returnRequest({ declineMessage: DECLINED })],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('cancel_request_declined', request)).toBeNull();
  });
});

describe('composeOrderEmail（店への知らせ（キャンセルの申し込み））', () => {
  it('申し込みの品を、決めた行の順に書く。宛名・問い合わせの案内・店の名前は付けない', () => {
    const email = compose('cancel_request_shop', cancelRequest());

    expect(email).toEqual({
      subject: '【要対応】キャンセルの申し込みが届きました（ORD-A1B2C3D4）',
      text: [
        'お客様からキャンセルの申し込みが届きました。',
        '',
        '申し込みの商品:',
        '・コート（BLACK / M） × 1',
        '・ストール × 2',
        '',
        '管理画面の注文の一覧で「キャンセルの申し込み」を押して、品を外すかお断りしてください。',
      ].join('\n'),
    });
  });

  it('お客様の氏名・メール・住所は書かない', () => {
    const email = compose('cancel_request_shop', cancelRequest());

    for (const text of ['山田', 'hanako@example.com', '1500001', '神宮前', CONTACT, SHOP, 'ご注文の状況はこちら', 'order-status']) {
      expect(email?.text).not.toContain(text);
    }
  });

  it.each([
    ['品の行が無い', cancelRequest({ lines: [] })],
    ['申し込みの材料が無い', null],
    ['返品の申し込みの材料', returnRequest()],
  ])('材料が足りなければ作らない（例外も投げない）: %s', (_name, request) => {
    expect(compose('cancel_request_shop', request)).toBeNull();
  });
});

describe('composeOrderEmail（申し込みのメール6種類に共通の決まり）', () => {
  const requestFor = (kind: RequestEmailKind) =>
    isReturnRequestEmailKind(kind) ? returnRequest({ declineMessage: 'お断りのメッセージ' }) : cancelRequest({ declineMessage: 'お断りのメッセージ' });

  it('申し込みのメール6種類は、返品の3種類とキャンセルの3種類', () => {
    expect([...REQUEST_EMAIL_KINDS]).toEqual([...RETURN_REQUEST_EMAIL_KINDS, ...CANCEL_REQUEST_EMAIL_KINDS]);
    expect(REQUEST_EMAIL_KINDS).toHaveLength(6);
  });

  it.each(REQUEST_EMAIL_KINDS)('%s は、申し込みの材料が付いていなければ作らない（例外も投げない）', (kind) => {
    expect(compose(kind, null)).toBeNull();
  });

  it.each(REQUEST_EMAIL_KINDS)('%s の件名は、固定の文と注文番号だけで組み、メッセージ・商品名を入れない', (kind) => {
    const email = compose(kind, requestFor(kind));

    expect(email?.subject).toMatch(/^【(Le Fil des Heures|要対応)】[^（）]+（ORD-A1B2C3D4）$/);
    expect(email?.subject).not.toContain('お断りのメッセージ');
    expect(email?.subject).not.toContain('コート');
  });

  it('お客様あての4種類は問い合わせの案内と店の名前で終わり、店あての2種類は付けない', () => {
    for (const kind of REQUEST_EMAIL_KINDS) {
      const text = compose(kind, requestFor(kind))?.text ?? '';
      const shopMail = kind === 'return_request_shop' || kind === 'cancel_request_shop';

      expect(text.endsWith(`${CONTACT}\n\n${SHOP}`)).toBe(!shopMail);
    }
  });

  it('お客様あての4種類は、問い合わせの案内の直前に状況のリンクを1回だけ書き、店あての2種類は書かない', () => {
    for (const kind of REQUEST_EMAIL_KINDS) {
      const text = compose(kind, requestFor(kind))?.text ?? '';
      const shopMail = kind === 'return_request_shop' || kind === 'cancel_request_shop';

      expect(text.split('ご注文の状況はこちら').length - 1).toBe(shopMail ? 0 : 1);
      expect(text.includes(`${STATUS_LINE}\n${CONTACT}`)).toBe(!shopMail);
    }
  });

  it('お客様あての4種類は、状況のURLが無ければ作らない。店あての2種類はURLが無くても作る', () => {
    for (const kind of REQUEST_EMAIL_KINDS) {
      const shopMail = kind === 'return_request_shop' || kind === 'cancel_request_shop';
      const source = { ...material(requestFor(kind)), orderStatusUrl: null };

      const email = composeOrderEmail(source, { kind, variant: null, paymentExpiredSent: false });

      expect(email === null).toBe(!shopMail);
    }
  });

  it('材料の種類（返品の申し込み／キャンセルの申し込み）が、メールの種類と違えば作らない', () => {
    for (const kind of RETURN_REQUEST_EMAIL_KINDS) {
      expect(compose(kind, cancelRequest({ declineMessage: 'お断りのメッセージ' }))).toBeNull();
    }
    for (const kind of CANCEL_REQUEST_EMAIL_KINDS) {
      expect(compose(kind, returnRequest({ declineMessage: 'お断りのメッセージ' }))).toBeNull();
    }
  });
});
