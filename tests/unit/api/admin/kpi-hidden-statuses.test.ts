jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockNot = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    from: (table: string) => ({
      select: () => {
        if (table !== 'orders') {
          return Promise.resolve({ data: [], error: null });
        }
        return {
          not: (...args: unknown[]) => {
            mockNot(...args);
            return { order: async () => ({ data: [], error: null }) };
          },
        };
      },
    }),
  })),
}));

import { GET } from '@/app/api/admin/kpi/route';

describe('GET /api/admin/kpi', () => {
  it('支払い手続き中と放棄の注文を数えない（受付の前の注文で CVR を下げない）', async () => {
    const response = (await GET(new Request('http://localhost/api/admin/kpi'))) as unknown as { status: number };

    expect(response.status).toBe(200);
    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
  });
});
