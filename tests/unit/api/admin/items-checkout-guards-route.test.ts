jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockUpdateEq = jest.fn();
const mockDeleteEq = jest.fn();
const mockClient = {
  from: () => ({
    update: () => ({ eq: mockUpdateEq }),
    delete: () => ({ eq: mockDeleteEq }),
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockClient),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockFetchBlockers = jest.fn();
const mockExpireForItem = jest.fn();
jest.mock('@/lib/items/item-checkout-guards', () => ({
  ...jest.requireActual('@/lib/items/item-checkout-guards'),
  fetchItemDeleteBlockers: (...args: unknown[]) => mockFetchBlockers(...args),
  expireOpenCheckoutsForItem: (...args: unknown[]) => mockExpireForItem(...args),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, item: unknown) => item),
}));

import { DELETE, PATCH } from '@/app/api/admin/items/[id]/route';

type RouteResponse = { status: number; body: Record<string, unknown> };
const CONTEXT = { params: Promise.resolve({ id: '7' }) };

function patch(status: 'private' | 'published') {
  return PATCH(
    new Request('http://localhost/api/admin/items/7', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    CONTEXT,
  ) as unknown as Promise<RouteResponse>;
}

function remove() {
  return DELETE(new Request('http://localhost/api/admin/items/7', { method: 'DELETE' }), CONTEXT) as unknown as Promise<RouteResponse>;
}

describe('管理画面の商品 API（①・R-44）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateEq.mockResolvedValue({ error: null });
    mockDeleteEq.mockResolvedValue({ error: null });
    mockExpireForItem.mockResolvedValue({ expired: 1, failed: 0 });
  });

  it('非公開にしたら、その商品を含む開いている決済を失効させる', async () => {
    expect((await patch('private')).status).toBe(200);
    expect(mockExpireForItem).toHaveBeenCalledWith({ client: mockClient, stripe: mockStripe, itemId: 7 });
  });

  it('公開にしたときは決済に触らない', async () => {
    await patch('published');

    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('注文・在庫の記録・決済中のある商品は削除せず、理由付きの 409 で非公開を促す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: true, hasStockMovements: true, hasOpenCheckouts: false }]]));

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'この商品は削除できません（注文がある・在庫の記録がある）。非公開にすると、お客様の画面から見えなくなります。',
      reasons: ['注文がある', '在庫の記録がある'],
    });
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it('理由の無い商品は削除する', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }]]));

    expect((await remove()).status).toBe(200);
    expect(mockDeleteEq).toHaveBeenCalledWith('id', 7);
  });

  it('確かめた後に記録が増えて外部キーで断られたら、汎用の500ではなく 409 を返す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }]]));
    mockDeleteEq.mockResolvedValue({ error: { code: '23503', message: 'foreign key violation' } });

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('非公開');
  });

  it('商品 ID の形が違えば 400', async () => {
    const res = (await DELETE(
      new Request('http://localhost/api/admin/items/abc', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'abc' }) },
    )) as unknown as RouteResponse;

    expect(res.status).toBe(400);
  });
});
