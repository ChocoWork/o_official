const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import {
  sendOrderCanceledEmail,
  sendPaymentExpiredEmail,
  sendShopPaymentAlert,
  sendUnplacedPaymentNotice,
} from '@/lib/orders/order-lifecycle-emails';
import type { OrderEmailSourceStore } from '@/lib/orders/order-confirmation-email';

/**
 * 期限切れ・取消・受付を通らない支払いの案内と、店への要対応メール（設計書 5-3・5-4）。
 * お客様へのメールは1件1回（送信権）。店へのメールに個人情報を入れない。
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const ORDER_ROW = {
  id: ORDER_ID,
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
};

const ITEMS = [{ item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 }];

function makeStore(options: { claim?: boolean } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const store = {
    calls,
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return { data: fn === 'claim_order_email' ? options.claim ?? true : true, error: null };
    },
    from(table: string) {
      return {
        select: () => ({
          eq: () =>
            table === 'orders'
              ? { maybeSingle: async () => ({ data: ORDER_ROW, error: null }) }
              : Promise.resolve({ data: ITEMS, error: null }),
        }),
      };
    },
  };
  return store as typeof store & OrderEmailSourceStore;
}

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue(undefined);
  env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  env.SHOP_ALERT_EMAIL = 'shop@example.com';
});

describe('期限切れのお知らせ', () => {
  it('送信権 payment_expired を取って1通送る。件名と本文は固定の文面', async () => {
    const store = makeStore();

    const sent = await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(true);
    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: ORDER_ID, _kind: 'payment_expired' } });
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe('hanako@example.com');
    expect(mail.subject).toBe('【Le Fil des Heures】お支払い期限切れのお知らせ（ORD-A1B2C3D4）');
    expect(mail.text).toContain('お支払い期限が過ぎたため、ご注文を取り消しました。');
    expect(mail.text).toContain('・シルクブラウス（WHITE / M） x1');
  });

  it('送信権を取れなければ送らない（二重送信しない）', async () => {
    const sent = await sendPaymentExpiredEmail({ store: makeStore({ claim: false }), orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('送れなければ送信権を戻す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
    const store = makeStore();

    const sent = await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(false);
    expect(store.calls).toContainEqual({ fn: 'release_order_email', args: { _order_id: ORDER_ID, _kind: 'payment_expired' } });
  });

  it('送信元が未設定なら送信権も取らない', async () => {
    delete env.MAIL_FROM_ADDRESS;
    const store = makeStore();

    expect(await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' })).toBe(false);
    expect(store.calls).toEqual([]);
  });
});

describe('取消のお知らせ', () => {
  it.each([
    ['payment_in_progress', 'お手続き中のご注文を取り消しました。'],
    ['pending', 'お支払い待ちのご注文を取り消しました。'],
  ] as const)('%s の注文は「%s」と書く', async (previousStatus, lead) => {
    const store = makeStore();

    await sendOrderCanceledEmail({ store, orderId: ORDER_ID, previousStatus, logLabel: '[test]' });

    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: ORDER_ID, _kind: 'canceled' } });
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【Le Fil des Heures】ご注文取消のお知らせ（ORD-A1B2C3D4）');
    expect(mail.text).toContain(lead);
    expect(mail.text).toContain('お支払いは発生していません。');
  });
});

describe('受付を通らない支払いの案内', () => {
  it('入金済みなら再度の支払いは不要と書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: '山田 花子', state: 'paid' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【Le Fil des Heures】ご注文の確認についてのお知らせ');
    expect(mail.text).toContain('お支払いは受け付けました。');
    expect(mail.text).toContain('再度のお支払いは不要です。');
  });

  it('入金待ちなら支払いを控えるよう書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: null, state: 'awaiting_payment' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.text).toContain('お客様');
    expect(mail.text).toContain('お支払いはお控えください。');
  });
});

describe('店への要対応メール', () => {
  const ALERT = {
    reason: 'paid_amount_mismatch' as const,
    detail: null,
    orderId: ORDER_ID,
    paymentRef: 'cs_test_123',
    detectedAt: new Date('2026-09-27T01:00:00.000Z'),
  };

  it('理由・注文番号・Stripe の支払い ID・次にやることを書き、個人情報は入れない', async () => {
    const sent = await sendShopPaymentAlert(ALERT);

    expect(sent).toBe(true);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe('shop@example.com');
    expect(mail.subject).toBe('【要対応】支払額の違い');
    expect(mail.text).toContain('注文番号: ORD-A1B2C3D4');
    expect(mail.text).toContain('Stripe の支払い: cs_test_123');
    expect(mail.text).toContain('次にやること:');
    expect(mail.text).not.toContain('hanako@example.com');
    expect(mail.text).not.toContain('山田');
  });

  it('SHOP_ALERT_EMAIL が未設定なら送らない（見回りが後で送り直す）', async () => {
    delete env.SHOP_ALERT_EMAIL;

    expect(await sendShopPaymentAlert(ALERT)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
