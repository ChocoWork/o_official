jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: { set: jest.fn() },
    }),
  },
}));

const mockAuthorize = jest.fn();
const mockCsrf = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
const mockSelectPayout = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => mockSelectPayout() }),
      }),
      update: (values: Record<string, unknown>) => {
        mockUpdate(values);
        return {
          eq: () => ({
            eq: () => ({
              eq: () => ({ is: () => ({ select: () => mockUpdateResult() }) }),
            }),
          }),
        };
      },
    }),
  }),
}));

let mockUpdateResult: () => Promise<{ data: unknown[]; error: null }>;

import { POST } from '@/app/api/admin/accounting/stripe-payouts/[id]/confirm/route';

const PAID_MATCHED = {
  id: 'po_1',
  amount: 9_640,
  status: 'paid',
  reconciliation_status: 'matched',
  bank_arrival_date: null,
  bank_confirmed_at: null,
  bank_confirmed_by: null,
};

function request(bankArrivalDate = '2026-08-16'): Request {
  return new Request('http://localhost/api/admin/accounting/stripe-payouts/po_1/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankArrivalDate }),
  });
}

const params = { params: Promise.resolve({ id: 'po_1' }) };

describe('POST /api/admin/accounting/stripe-payouts/:id/confirm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'admin@example.com' });
    mockCsrf.mockResolvedValue(undefined);
    mockSelectPayout.mockResolvedValue({ data: PAID_MATCHED, error: null });
    mockUpdateResult = async () => ({
      data: [{ ...PAID_MATCHED, bank_arrival_date: '2026-08-16', bank_confirmed_at: '2026-08-16T00:00:00.000Z', bank_confirmed_by: 'admin-1' }],
      error: null,
    });
  });

  it.each([
    ['permission denied', () => mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, json: async () => ({}) } }), 403],
    ['CSRF denied', () => mockCsrf.mockResolvedValue(new Response(null, { status: 403 })), 403],
    ['payout not paid', () => mockSelectPayout.mockResolvedValue({ data: { ...PAID_MATCHED, status: 'pending' }, error: null }), 409],
    ['payout mismatch', () => mockSelectPayout.mockResolvedValue({ data: { ...PAID_MATCHED, reconciliation_status: 'mismatch' }, error: null }), 409],
    ['payout missing', () => mockSelectPayout.mockResolvedValue({ data: null, error: null }), 404],
  ])('%s', async (_name, setup, expectedStatus) => {
    setup();

    const response = await POST(request(), params);

    expect(response.status).toBe(expectedStatus);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a malformed bank arrival date', async () => {
    const response = await POST(request('2026/08/16'), params);

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('records the confirmation for a paid and matched payout', async () => {
    const response = await POST(request(), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      bank_arrival_date: '2026-08-16',
      bank_confirmed_by: 'admin-1',
    }));
    expect(body.data).toMatchObject({
      payoutId: 'po_1',
      bankArrivalDate: '2026-08-16',
      bankConfirmedBy: 'admin-1',
    });
  });

  it('returns the existing confirmation without rewriting it', async () => {
    mockSelectPayout.mockResolvedValue({
      data: {
        ...PAID_MATCHED,
        bank_arrival_date: '2026-08-16',
        bank_confirmed_at: '2026-08-16T00:00:00.000Z',
        bank_confirmed_by: 'admin-1',
      },
      error: null,
    });

    const response = await POST(request('2026-08-16'), params);

    expect(response.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a different arrival date for an already confirmed payout', async () => {
    mockSelectPayout.mockResolvedValue({
      data: {
        ...PAID_MATCHED,
        bank_arrival_date: '2026-08-16',
        bank_confirmed_at: '2026-08-16T00:00:00.000Z',
        bank_confirmed_by: 'admin-1',
      },
      error: null,
    });

    const response = await POST(request('2026-08-17'), params);

    expect(response.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('re-reads the payout when a concurrent update wins the race', async () => {
    mockUpdateResult = async () => ({ data: [], error: null });
    mockSelectPayout
      .mockResolvedValueOnce({ data: PAID_MATCHED, error: null })
      .mockResolvedValueOnce({
        data: {
          ...PAID_MATCHED,
          bank_arrival_date: '2026-08-16',
          bank_confirmed_at: '2026-08-16T00:00:00.000Z',
          bank_confirmed_by: 'admin-2',
        },
        error: null,
      });

    const response = await POST(request('2026-08-16'), params);

    expect(response.status).toBe(200);
    expect(mockSelectPayout).toHaveBeenCalledTimes(2);
  });
});
