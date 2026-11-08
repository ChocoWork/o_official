jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockNot = jest.fn();
const mockRpcAnswer = (name: string): unknown => {
  switch (name) {
    case 'list_accounting_periods':
      return [];
    case 'get_accounting_settings':
      return { business_start_date: null, cutover_on: '2026-02-01', current_business_type: 'soleProprietor', sole_business_ended_on: null, version: '1', sole_end_changes: [] };
    case 'list_order_intake_events':
      return { events: [], next_after_date: null, next_after_key: null };
    case 'get_order_backlog':
      return { backlog_total: 0, order_count: 0 };
    case 'get_intake_breakdown':
      return { subtotal_before_discount: 0, discount: 0, shipping: 0, payment: 0, pre_shipment_cancel: 0, dispute_unshipped: 0, dispute_unshipped_restored: 0, intake: 0, order_count: 0, breakdown_ok: true };
    case 'get_intake_reconciliation':
      return { returns: 0 };
    default:
      throw new Error(`unexpected rpc ${name}`);
  }
};
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
  // 受注高の読み口（会計の読み取り）は空の答えを返す
  createServiceRoleClient: jest.fn(async () => ({
    rpc: async (name: string) => ({ data: mockRpcAnswer(name), error: null }),
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
