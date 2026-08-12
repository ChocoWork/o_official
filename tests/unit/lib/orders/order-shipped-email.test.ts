const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';

const BASE = {
  orderId: 'a1b2c3d4-1111-2222-3333-444455556666',
  email: 'hanako@example.com',
  fullName: '山田 花子',
  carrier: 'yamato' as const,
  trackingNumber: '1234-5678-9012',
};

describe('sendOrderShippedEmail', () => {
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  test('配送業者・追跡番号・追跡URLを本文に含める', async () => {
    await sendOrderShippedEmail(BASE);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('hanako@example.com');
    expect(call.subject).toContain('ORD-A1B2C3D4');
    expect(call.text).toContain('ヤマト運輸');
    expect(call.text).toContain('1234-5678-9012');
    expect(call.text).toContain('toi.kuronekoyamato.co.jp');
  });

  test('メールアドレスが無いときは送らない', async () => {
    await sendOrderShippedEmail({ ...BASE, email: null });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('送信に失敗しても例外を投げず監査ログに残す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));

    await expect(sendOrderShippedEmail(BASE)).resolves.toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.shipped.mail', outcome: 'error' }),
    );
  });
});
