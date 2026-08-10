const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import { sendOrderConfirmationEmail } from '@/lib/orders/order-confirmation-email';

const BASE_PARAMS = {
  orderId: 'a1b2c3d4-1111-2222-3333-444455556666',
  email: 'hanako@example.com',
  fullName: '山田 花子',
  items: [
    { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 },
  ],
  subtotalAmount: 28000,
  shippingAmount: 800,
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

describe('sendOrderConfirmationEmail', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('本文にお届け先が含まれる', async () => {
    await sendOrderConfirmationEmail(BASE_PARAMS);

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
      ...BASE_PARAMS,
      shipping: { ...BASE_PARAMS.shipping, building: null },
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
    expect(body).not.toContain('レジデンス101');
  });

  test('メールアドレスが無いときは送らない', async () => {
    await sendOrderConfirmationEmail({ ...BASE_PARAMS, email: null });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('MAIL_FROM_ADDRESS が無いときは送らない', async () => {
    env.MAIL_FROM_ADDRESS = '';
    await sendOrderConfirmationEmail(BASE_PARAMS);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
