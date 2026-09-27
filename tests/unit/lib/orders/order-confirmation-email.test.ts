const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import {
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
