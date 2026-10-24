const mockRpc = jest.fn();
const mockFrom = jest.fn((table: string): any => {
  void table;
  return {};
});

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

const LINKED_ROW = {
  id: 'order-1',
  shipping_full_name: '山田 花子',
  shipping_postal_code: '150-0001',
  shipping_prefecture: '東京都',
  shipping_city: '渋谷区',
  shipping_address: '神宮前1-2-3',
  shipping_building: 'レジデンス101',
  created_at: '2026-08-01T00:00:00Z',
};

function mockProfiles(profile: unknown) {
  const profileSelect = jest.fn().mockResolvedValue({ data: profile, error: null });
  const profileUpsert = jest.fn().mockResolvedValue({ error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: profileSelect }) }),
        upsert: profileUpsert,
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { profileSelect, profileUpsert };
}

describe('linkGuestOrdersByEmail', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockImplementation((table: string): any => {
      void table;
      return {};
    });
    mockRpc.mockResolvedValue({ data: [], error: null });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('メール未確認では RPC を呼ばず 0 を返す', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: null,
    });

    expect(linked).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('空白だけのメールでは RPC を呼ばず 0 を返す', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: '   ',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('確認済みなら link_guest_orders を正規化したメールで1回だけ呼び、注文表を直接更新しない', async () => {
    mockProfiles({ addresses: [{ postalCode: '100-0001' }], address: null, display_name: '既存' });
    mockRpc.mockResolvedValue({ data: [LINKED_ROW], error: null });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: '  Hanako@Example.com ',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(1);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('link_guest_orders', {
      _user_id: 'user-1',
      _email: 'hanako@example.com',
    });
    expect(mockFrom).not.toHaveBeenCalledWith('orders');
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'orders.link_guest_orders',
      outcome: 'success',
      resource: 'orders',
      resource_id: 'user-1',
      metadata: { linked_count: 1 },
    });
  });

  test('_ と % と \\ はエスケープせず、そのままの文字として RPC へ渡す', async () => {
    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'John_Doe%te\\st@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(mockRpc).toHaveBeenCalledWith('link_guest_orders', {
      _user_id: 'user-1',
      _email: 'john_doe%te\\st@example.com',
    });
  });

  test('0件でも成功として 0 を返し、profiles にも監査にも触れない', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('RPC がエラーを返しても例外を投げず 0 を返し、固定の文だけを記録する', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'boom hanako@example.com 神宮前1-2-3', code: '42501' },
    });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'orders.link_guest_orders',
      outcome: 'error',
      resource: 'orders',
      resource_id: 'user-1',
      detail: 'GROUP_G_LINK_GUEST_ORDERS_FAILED',
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('GROUP_G_LINK_GUEST_ORDERS_FAILED');
  });

  test('RPC が例外を投げても 0 を返し、生のエラーを記録しない', async () => {
    mockRpc.mockRejectedValue(new Error('network hanako@example.com'));

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'GROUP_G_LINK_GUEST_ORDERS_FAILED' }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('hanako');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('hanako');
  });

  test('RPC の返り値が配列でなければ失敗として 0 を返す', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'order-1' }, error: null });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'GROUP_G_LINK_GUEST_ORDERS_FAILED' }),
    );
  });

  test('紐付いたとき profiles が空なら、RPC の8列のうち最新の注文の住所と氏名をコピーする', async () => {
    const { profileUpsert } = mockProfiles({ addresses: null, address: null, display_name: null });
    mockRpc.mockResolvedValue({
      data: [
        { ...LINKED_ROW, id: 'order-old', shipping_full_name: '古い 名前', shipping_city: '港区', created_at: '2026-07-01T00:00:00Z' },
        LINKED_ROW,
      ],
      error: null,
    });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(2);
    const addressItem = {
      id: 'order-1',
      postalCode: '150-0001',
      prefecture: '東京都',
      city: '渋谷区',
      address: '神宮前1-2-3',
      building: 'レジデンス101',
      isDefault: true,
    };
    expect(profileUpsert).toHaveBeenCalledWith(
      {
        user_id: 'user-1',
        addresses: [addressItem],
        address: addressItem,
        display_name: '山田 花子',
      },
      { onConflict: 'user_id' },
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', metadata: { linked_count: 2 } }),
    );
  });

  test('profiles に既に住所と表示名があればコピーしない', async () => {
    const { profileUpsert } = mockProfiles({
      addresses: [{ postalCode: '100-0001' }],
      address: null,
      display_name: '既存',
    });
    mockRpc.mockResolvedValue({ data: [LINKED_ROW], error: null });

    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(profileUpsert).not.toHaveBeenCalled();
  });
});
