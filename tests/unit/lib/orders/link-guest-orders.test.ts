const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockIlike = jest.fn(() => ({ is: mockIs }));
const mockUpdate = jest.fn(() => ({ ilike: mockIlike }));
const mockFrom = jest.fn(() => ({ update: mockUpdate }));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

describe('linkGuestOrdersByEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockResolvedValue({ data: [{ id: 'order-1' }], error: null });
  });

  test('メール未確認では UPDATE を呼ばず 0 を返す', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: null,
    });

    expect(linked).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('メール確認済みなら user_id が NULL の注文だけを更新する', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: '  Hanako@Example.com ',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(1);
    expect(mockFrom).toHaveBeenCalledWith('orders');
    expect(mockUpdate).toHaveBeenCalledWith({ user_id: 'user-1' });
    // メールは lower(trim()) に正規化し、大文字小文字を無視して比較する。
    // ilike はワイルドカードを含まなければ大文字小文字を無視した等値比較になる。
    expect(mockIlike).toHaveBeenCalledWith('shipping_email', 'hanako@example.com');
    // 他人が所有済みの注文は奪わない
    expect(mockIs).toHaveBeenCalledWith('user_id', null);
  });

  test('0件でも成功として 0 を返し、監査ログを残さない', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('Supabase がエラーを返しても例外を投げず 0 を返す', async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'orders.link_guest_orders', outcome: 'error' }),
    );
  });
});
