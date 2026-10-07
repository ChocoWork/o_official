const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import {
  formatItemLines,
  sendOrderConfirmationEmail,
  sendOrderConfirmationEmailForOrderId,
} from '@/lib/orders/order-confirmation-email';

const BASE = {
  orderId: 'a1b2c3d4-1111-2222-3333-444455556666',
  email: 'hanako@example.com',
  fullName: '山田 花子',
  items: [
    { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 },
  ],
  subtotalAmount: 28000,
  shippingAmount: 800,
  discountAmount: 0,
  totalAmount: 28800,
  currency: 'jpy',
  shipping: {
    fullName: '山田 花子',
    postalCode: '150-0001',
    prefecture: '東京都',
    city: '渋谷区',
    address: '神宮前1-2-3',
    building: 'レジデンス101',
    phone: '090-1234-5678',
  },
};

type RpcCall = { fn: string; args: Record<string, unknown> };

/** claim_order_email / release_order_email を持つ最小の入れ物 */
function makeStore(overrides: { claim?: boolean | "error"; release?: boolean } = {}) {
  const calls: RpcCall[] = [];
  return {
    calls,
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "claim_order_email") {
        if (overrides.claim === "error") return { data: null, error: { message: "claim failed" } };
        return { data: overrides.claim ?? true, error: null };
      }
      return { data: overrides.release ?? true, error: null };
    },
  };
}

let store = makeStore();
const baseParams = () => ({ ...BASE, store });

describe("sendOrderConfirmationEmail", () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    store = makeStore();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('本文にお届け先が含まれる', async () => {
    await sendOrderConfirmationEmail(baseParams());

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('お届け先');
    expect(body).toContain('〒150-0001');
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
    expect(body).toContain('レジデンス101');
    expect(body).toContain('090-1234-5678');
  });

  test('建物名が無いときは建物の行を出さない', async () => {
    await sendOrderConfirmationEmail({
      ...baseParams(),
      shipping: { ...baseParams().shipping, building: null },
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
    expect(body).not.toContain('レジデンス101');
  });

  test('メールアドレスが無いときは送らない', async () => {
    await sendOrderConfirmationEmail({ ...baseParams(), email: null });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('MAIL_FROM_ADDRESS が無いときは送らない', async () => {
    env.MAIL_FROM_ADDRESS = '';
    await sendOrderConfirmationEmail(baseParams());
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('未入金のときは件名を「お支払い待ち」にする', async () => {
    await sendOrderConfirmationEmail({ ...baseParams(), paymentState: 'awaiting_payment' });

    const sent = mockSendMail.mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).toContain('お支払い待ち');
    expect(sent.text).toContain('ご入金の確認後');
  });

  test('入金済みのときは従来の件名のまま', async () => {
    await sendOrderConfirmationEmail({ ...baseParams(), paymentState: 'paid' });

    const sent = mockSendMail.mock.calls[0][0] as { subject: string };
    expect(sent.subject).not.toContain('お支払い待ち');
  });

  test('paymentState 未指定は入金済み扱い', async () => {
    await sendOrderConfirmationEmail(baseParams());

    const sent = mockSendMail.mock.calls[0][0] as { subject: string };
    expect(sent.subject).not.toContain('お支払い待ち');
  });

  test('失敗の後の入金（⑤）は、取り消しの案内の後に入金を確認したことを書く', async () => {
    await sendOrderConfirmationEmail({ ...baseParams(), paidVariant: 'payment_received_after_expiry' });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('その後にお支払いを確認しました');
    expect(body).toContain('ご注文は有効です');
    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: BASE.orderId, _kind: 'paid' } });
  });
});

/**
 * 送信権（FREQ-386）。complete と webhook の両方が同じ注文を受け取るため、
 * 送る直前に (注文, 種類) の権利を取り、取れた経路だけが送る。
 */
describe('sendOrderConfirmationEmail の送信権', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('まだ誰も送っていなければ、権利を取ってから送る', async () => {
    const store = makeStore({ claim: true });

    const sent = await sendOrderConfirmationEmail({ ...BASE, store, paymentState: 'awaiting_payment' });

    expect(sent).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(store.calls[0]).toEqual({
      fn: 'claim_order_email',
      args: { _order_id: BASE.orderId, _kind: 'awaiting_payment' },
    });
  });

  test('既にほかの経路が送っていれば送らない', async () => {
    const store = makeStore({ claim: false });

    const sent = await sendOrderConfirmationEmail({ ...BASE, store });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('送信に失敗したら権利を戻す（あとの経路が送れるようにする）', async () => {
    const store = makeStore({ claim: true });
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));

    const sent = await sendOrderConfirmationEmail({ ...BASE, store });

    expect(sent).toBe(false);
    expect(store.calls.map((call) => call.fn)).toEqual(['claim_order_email', 'release_order_email']);
  });

  test('宛先が無ければ権利も取らない', async () => {
    const store = makeStore();

    const sent = await sendOrderConfirmationEmail({ ...BASE, email: null, store });

    expect(sent).toBe(false);
    expect(store.calls).toEqual([]);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('権利の確認自体が失敗したときは、届かないより重複を選んで送る', async () => {
    const store = makeStore({ claim: 'error' });

    const sent = await sendOrderConfirmationEmail({ ...BASE, store });

    expect(sent).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

/**
 * 注文 ID から注文行と明細を引いてメールを送る共通処理（優先度低の指摘「同じ組み立てが3か所」）。
 *
 * webhook（注文作成時・async_payment_succeeded）と掃除ジョブ（取りこぼしの救済）が
 * まったく同じ列の並びと同じ組み立てを持っていた。片方だけ直すと、客に届く内容が経路で食い違う。
 */
describe('sendOrderConfirmationEmailForOrderId', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  const ORDER_ROW = {
    id: BASE.orderId,
    shipping_email: 'hanako@example.com',
    shipping_full_name: '山田 花子',
    subtotal_amount: 28000,
    shipping_amount: 800,
    discount_amount: 0,
    total_amount: 28800,
    currency: 'jpy',
    shipping_postal_code: '150-0001',
    shipping_prefecture: '東京都',
    shipping_city: '渋谷区',
    shipping_address: '神宮前1-2-3',
    shipping_building: 'レジデンス101',
    shipping_phone: '090-1234-5678',
  };

  const ORDER_ITEMS = [
    { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 },
  ];

  function makeQueryStore(options: {
    orderRow?: Record<string, unknown> | null;
    orderError?: { message: string } | null;
    items?: Record<string, unknown>[] | null;
    itemsError?: { message: string } | null;
  } = {}) {
    const {
      orderRow = ORDER_ROW,
      orderError = null,
      items = ORDER_ITEMS,
      itemsError = null,
    } = options;

    return {
      ...makeStore(),
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: orderRow, error: orderError }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: async () => ({ data: items, error: itemsError }),
          }),
        };
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('注文行と明細を引いて送る', async () => {
    const sent = await sendOrderConfirmationEmailForOrderId({
      // 型の都合だけの as。実体は supabase クライアントが入る
      store: makeQueryStore() as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    expect(sent).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('シルクブラウス');
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
  });

  test('注文行が引けなければ送らない', async () => {
    const sent = await sendOrderConfirmationEmailForOrderId({
      store: makeQueryStore({ orderRow: null }) as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('明細が引けなければ、空のまま送らない', async () => {
    const sent = await sendOrderConfirmationEmailForOrderId({
      store: makeQueryStore({ itemsError: { message: 'boom' } }) as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // 取得が成功して0件の場合も「引けなかった」と同じ扱いにする。商品の行が1つも無いメールは、
  // 客には注文が消えたように見える。送らなければ送信権は取られないので、後の経路が送れる。
  test('明細が0件なら送らない', async () => {
    const sent = await sendOrderConfirmationEmailForOrderId({
      store: makeQueryStore({ items: [] }) as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('入金待ちの種類でも送れる', async () => {
    await sendOrderConfirmationEmailForOrderId({
      store: makeQueryStore() as never,
      orderId: BASE.orderId,
      paymentState: 'awaiting_payment',
      logLabel: '[test]',
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const subject = mockSendMail.mock.calls[0][0].subject as string;
    expect(subject).toContain('ご注文');
  });

  // 注文行の値引額をそのまま本文へ出す（FREQ-396）。注文詳細画面と同じ値・同じ書き方にする。
  test('注文行の値引額を本文に出す', async () => {
    await sendOrderConfirmationEmailForOrderId({
      store: makeQueryStore({
        orderRow: { ...ORDER_ROW, discount_amount: 3000, total_amount: 25800 },
      }) as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('割引: -￥3,000');
    expect(body).toContain('合計: ￥25,800');
  });
});

describe('明細ごとのお届けの目安（グループ F 設計書 5-3）', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    store = makeStore();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('目安を出す指定のときだけ、明細の次の行に在庫あり・受注生産の目安を添える', () => {
    const items = [
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
      { item_name: 'ウールパンツ', color: null, size: 'L', quantity: 2, line_total: 36000, fulfillment_type: 'backorder' },
      { item_name: '目安の無い明細', quantity: 1, line_total: 1000, fulfillment_type: null },
    ];

    expect(formatItemLines(items, 'jpy', { withFulfillment: true })).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000\n　在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送',
      '・ウールパンツ（L） x2　￥36,000\n　受注生産・発送まで数週間〜2か月以上（目安）',
      '・目安の無い明細 x1　￥1,000',
    ]);
    expect(formatItemLines(items, 'jpy')).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000',
      '・ウールパンツ（L） x2　￥36,000',
      '・目安の無い明細 x1　￥1,000',
    ]);
  });

  test('確定メールの本文に、明細ごとの目安が出る', async () => {
    await sendOrderConfirmationEmail({
      ...baseParams(),
      items: [
        { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
      ],
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送');
  });

  test('注文 ID から送るときは、明細の目安も読む', async () => {
    const selects: string[] = [];
    const queryStore = {
      ...makeStore(),
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: BASE.orderId,
                    shipping_email: 'hanako@example.com',
                    shipping_full_name: '山田 花子',
                    subtotal_amount: 28000,
                    shipping_amount: 800,
                    discount_amount: 0,
                    total_amount: 28800,
                    currency: 'jpy',
                    shipping_postal_code: '150-0001',
                    shipping_prefecture: '東京都',
                    shipping_city: '渋谷区',
                    shipping_address: '神宮前1-2-3',
                    shipping_building: null,
                    shipping_phone: '090-1234-5678',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: (columns: string) => {
            selects.push(columns);
            return {
              eq: async () => ({
                data: [
                  { item_name: 'ウールパンツ', color: null, size: 'L', quantity: 1, line_total: 18000, fulfillment_type: 'backorder' },
                ],
                error: null,
              }),
            };
          },
        };
      },
    };

    await sendOrderConfirmationEmailForOrderId({
      store: queryStore as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      logLabel: '[test]',
    });

    expect(selects).toEqual(['item_name, color, size, quantity, line_total, fulfillment_type']);
    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('受注生産・発送まで数週間〜2か月以上（目安）');
  });

  test('期限切れの後の入金で在庫を確保し直せなかった注文には、どの明細にも目安を出さない', async () => {
    const params = {
      ...baseParams(),
      paidVariant: 'payment_received_after_expiry' as const,
      reviewReason: 'stock_not_reserved',
      items: [
        { item_name: 'シルクブラウス', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
        { item_name: 'ウールパンツ', quantity: 1, line_total: 18000, fulfillment_type: 'backorder' },
      ],
    };

    await sendOrderConfirmationEmail(params);

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('その後にお支払いを確認しました。');
    expect(body).toContain('・シルクブラウス x1');
    expect(body).toContain('・ウールパンツ x1');
    expect(body).not.toContain('在庫あり・');
    expect(body).not.toContain('受注生産・');
  });

  test('コンビニのお支払い待ちの確定メールにも、明細ごとの目安が出る', async () => {
    await sendOrderConfirmationEmail({
      ...baseParams(),
      paymentState: 'awaiting_payment',
      items: [
        { item_name: 'シルクブラウス', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
        { item_name: 'ウールパンツ', quantity: 1, line_total: 18000, fulfillment_type: 'backorder' },
      ],
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('まだお支払いは完了していません。');
    expect(body).toContain('在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送');
    expect(body).toContain('受注生産・発送まで数週間〜2か月以上（目安）');
  });

  test('注文 ID から送るときは review_reason を読み、在庫を確保し直せなかった注文の目安を出さない', async () => {
    const selects: Record<string, string> = {};
    const queryStore = {
      ...makeStore(),
      from(table: string) {
        return {
          select: (columns: string) => {
            selects[table] = columns;
            return {
              eq: () => table === 'orders'
                ? {
                    maybeSingle: async () => ({
                      data: {
                        id: BASE.orderId,
                        shipping_email: BASE.email,
                        shipping_full_name: BASE.fullName,
                        subtotal_amount: BASE.subtotalAmount,
                        shipping_amount: BASE.shippingAmount,
                        discount_amount: BASE.discountAmount,
                        total_amount: BASE.totalAmount,
                        currency: BASE.currency,
                        shipping_postal_code: BASE.shipping.postalCode,
                        shipping_prefecture: BASE.shipping.prefecture,
                        shipping_city: BASE.shipping.city,
                        shipping_address: BASE.shipping.address,
                        shipping_building: BASE.shipping.building,
                        shipping_phone: BASE.shipping.phone,
                        review_reason: 'stock_not_reserved',
                      },
                      error: null,
                    }),
                  }
                : Promise.resolve({
                    data: [
                      { item_name: 'シルクブラウス', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
                      { item_name: 'ウールパンツ', quantity: 1, line_total: 18000, fulfillment_type: 'backorder' },
                    ],
                    error: null,
                  }),
            };
          },
        };
      },
    };

    const sent = await sendOrderConfirmationEmailForOrderId({
      store: queryStore as never,
      orderId: BASE.orderId,
      paymentState: 'paid',
      paidVariant: 'payment_received_after_expiry',
      logLabel: '[test]',
    });

    expect(sent).toBe(true);
    expect(selects.orders.split(', ')).toContain('review_reason');
    expect(selects.order_items).toBe('item_name, color, size, quantity, line_total, fulfillment_type');
    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('・シルクブラウス x1');
    expect(body).toContain('・ウールパンツ x1');
    expect(body).not.toContain('在庫あり・');
    expect(body).not.toContain('受注生産・');
  });
});
