const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import { sendShopPaymentAlert, sendUnplacedPaymentNotice } from '@/lib/orders/order-lifecycle-emails';

/** 注文にならなかった支払いの案内と店への要対応メールを確かめ、個人情報を店へ送らない */
const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue(undefined);
  env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  env.SHOP_ALERT_EMAIL = 'shop@example.com';
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
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete env.SHOP_ALERT_EMAIL;

    expect(await sendShopPaymentAlert(ALERT)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[shop-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    warn.mockRestore();
  });
});
