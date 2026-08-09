import { NextRequest } from 'next/server';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

// ── NextResponse モック ─────────────────────────────────────────
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 })),
    },
  };
});

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockConstructEvent = jest.fn();
let webhookEventState: { processing_status: string; attempt_count: number } | null = null;
const mockWebhookEventUpsert = jest.fn();
const mockWebhookEventUpdate = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from '@/app/api/webhook/stripe/route';

function makeRequest(payload: unknown, signature = 'stripe-signature'): NextRequest {
  const req = new NextRequest('http://localhost/api/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(payload),
  });
  return req;
}

describe('POST /api/webhook/stripe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webhookEventState = null;
    mockWebhookEventUpsert.mockResolvedValue({ error: null });
    mockWebhookEventUpdate.mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'stripe_webhook_events') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockImplementation(() => Promise.resolve({ data: webhookEventState, error: null })),
            }),
          }),
          upsert: mockWebhookEventUpsert,
          update: mockWebhookEventUpdate,
        };
      }

      if (table === 'orders') {
        const updateBuilder = {
          or: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
        };

        return {
          update: jest.fn().mockReturnValue(updateBuilder),
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }

      if (table === 'checkout_drafts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  subtotal_amount: 5000,
                  shipping_amount: 0,
                  total_amount: 5500,
                  currency: 'jpy',
                  items_snapshot: [
                    { quantity: 1, line_total: 3000 },
                    { quantity: 1, line_total: 2000 },
                  ],
                },
                error: null,
              }),
            }),
          }),
        };
      }

      return {};
    });
  });

  it('checkout.session.expired を受け取ると pending 注文を failed に変更する', async () => {
    const event = {
      id: 'evt_expired',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_expired',
          payment_intent: 'pi_expired',
        },
      },
    };

    mockConstructEvent.mockReturnValue(event);

    const req = makeRequest(event);
    const res = await POST(req);

    expect((res as { status: number }).status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it('checkout.session.completed で注文作成 webhook が処理される', async () => {
    const session = {
      id: 'cs_complete',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-123' },
      payment_intent: 'pi_complete',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = {
      id: 'evt_completed',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-1', order_status: 'paid' }], error: null });

    const req = makeRequest(event);
    const res = await POST(req);

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('finalize_order_from_checkout_draft', expect.objectContaining({
      _draft_id: 'draft-123',
      _payment_intent_id: 'pi_complete',
      _checkout_session_id: 'cs_complete',
      _expected_total_amount: 5500,
    }));
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it('失敗済みイベントは再処理してcompletedへ更新する', async () => {
    webhookEventState = { processing_status: 'failed', attempt_count: 1 };
    const event = {
      id: 'evt_retry',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_retry', payment_intent: 'pi_retry' } },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await POST(makeRequest(event));

    expect((response as { status: number }).status).toBe(200);
    expect(mockWebhookEventUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ processing_status: 'processing', attempt_count: 2 }),
      { onConflict: 'id' },
    );
    expect(mockWebhookEventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      processing_status: 'completed',
    }));
  });

  it('完了済みイベントだけを重複として省略する', async () => {
    webhookEventState = { processing_status: 'completed', attempt_count: 1 };
    const event = {
      id: 'evt_duplicate',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_duplicate', payment_intent: 'pi_duplicate' } },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await POST(makeRequest(event));

    expect((response as { body: { duplicate?: boolean } }).body.duplicate).toBe(true);
    expect(mockWebhookEventUpsert).not.toHaveBeenCalled();
  });
});
