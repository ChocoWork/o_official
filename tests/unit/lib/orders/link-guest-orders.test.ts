const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockIlike = jest.fn(() => ({ is: mockIs }));
const mockUpdate = jest.fn(() => ({ ilike: mockIlike }));
const mockFrom = jest.fn((table: string): any => {
  void table;
  return { update: mockUpdate };
});

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

  test('メールに含まれる _ と % をワイルドカードとして扱わない', async () => {
    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'john_doe%test@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    // _ と % がエスケープされ、別アドレスに一致しないこと
    expect(mockIlike).toHaveBeenCalledWith(
      'shipping_email',
      'john\\_doe\\%test@example.com',
    );
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

  test('紐付いたとき profiles が空なら住所と氏名をコピーする', async () => {
    const profileSelect = jest.fn().mockResolvedValue({
      data: { addresses: null, address: null, display_name: null },
      error: null,
    });
    const profileUpsert = jest.fn().mockResolvedValue({ error: null });
    const orderSelect = jest.fn().mockResolvedValue({
      data: [
        {
          id: 'order-1',
          shipping_full_name: '山田 花子',
          shipping_postal_code: '150-0001',
          shipping_prefecture: '東京都',
          shipping_city: '渋谷区',
          shipping_address: '神宮前1-2-3',
          shipping_building: 'レジデンス101',
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
      error: null,
    });

    mockSelect.mockImplementation(() => orderSelect());
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: profileSelect }) }),
          upsert: profileUpsert,
        };
      }
      return { update: mockUpdate };
    });

    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(profileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        addresses: [
          expect.objectContaining({
            postalCode: '150-0001',
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
            building: 'レジデンス101',
            isDefault: true,
          }),
        ],
      }),
      expect.anything(),
    );
  });

  test('profiles に既に住所があればコピーしない', async () => {
    const profileSelect = jest.fn().mockResolvedValue({
      data: { addresses: [{ postalCode: '100-0001' }], address: null, display_name: '既存' },
      error: null,
    });
    const profileUpsert = jest.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: profileSelect }) }),
          upsert: profileUpsert,
        };
      }
      return { update: mockUpdate };
    });

    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(profileUpsert).not.toHaveBeenCalled();
  });
});
