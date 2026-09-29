jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
    },
  };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn().mockResolvedValue({ ok: true, claims: { sub: 'user-1' } }),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_client: unknown, url: string | null) => url),
}));

const mockNot = jest.fn();

function orderQuery() {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.not = (...args: unknown[]) => {
    mockNot(...args);
    return query;
  };
  query.order = async () => ({ data: [], error: null });
  query.maybeSingle = async () => ({ data: null, error: null });
  return query;
}

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => orderQuery() })),
  createServiceRoleClient: jest.fn(async () => ({ from: () => orderQuery() })),
}));

import { NextRequest } from 'next/server';
import { GET as listOrders } from '@/app/api/orders/route';
import { GET as getOrder } from '@/app/api/orders/[id]/route';

describe('お客様の注文履歴（設計書 5-5）', () => {
  beforeEach(() => {
    mockNot.mockClear();
  });

  it('注文履歴は支払い手続き中と放棄の注文を返さない', async () => {
    await listOrders(new NextRequest('http://localhost/api/orders'));

    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
  });

  it('注文詳細も支払い手続き中と放棄の注文を返さない（404 になる）', async () => {
    const response = (await getOrder(
      new NextRequest('http://localhost/api/orders/order-1'),
      { params: Promise.resolve({ id: 'order-1' }) },
    )) as unknown as { status: number };

    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
    expect(response.status).toBe(404);
  });
});
