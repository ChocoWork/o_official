jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockEqStatus = jest.fn(() => ({ is: mockIs }));
const mockEqId = jest.fn(() => ({ eq: mockEqStatus }));
const mockUpdate = jest.fn(() => ({ eq: mockEqId }));
const mockFrom = jest.fn(() => ({ update: mockUpdate }));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1' }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockSendOrderShippedEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-shipped-email', () => ({
  sendOrderShippedEmail: (...args: unknown[]) => mockSendOrderShippedEmail(...args),
}));

import { POST } from '@/app/api/admin/orders/[id]/status/route';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function makeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };

describe('POST /api/admin/orders/[id]/status - shipped', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('paid の注文を発送済みにできる', async () => {
    mockSelect.mockResolvedValue({
      data: [{ id: ORDER_ID, shipping_email: 'hanako@example.com' }],
      error: null,
    });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(200);
    // status='paid' かつ shipped_at IS NULL の行だけを更新する
    expect(mockEqStatus).toHaveBeenCalledWith('status', 'paid');
    expect(mockIs).toHaveBeenCalledWith('shipped_at', null);
    expect(mockSendOrderShippedEmail).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、メールを送らない', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(409);
    expect(mockSendOrderShippedEmail).not.toHaveBeenCalled();
  });

  test('未知の配送業者は 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('追跡番号に記号が混ざると 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
