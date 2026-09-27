import { NextRequest } from 'next/server';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

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

const mockConstructEvent = jest.fn();
const mockEnqueueRpc = jest.fn();
const mockSyncOrderRefunds = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({
    rpc: (...args: unknown[]) => mockEnqueueRpc(...args),
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      upsert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    }),
  }),
}));

jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    webhooks: { constructEvent: mockConstructEvent },
  }),
}));

jest.mock('@/lib/stripe/order-refund-sync', () => ({
  syncOrderRefunds: (...args: unknown[]) => mockSyncOrderRefunds(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/webhook/stripe/route';

function request(event: unknown): NextRequest {
  return new NextRequest('http://localhost/api/webhook/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 'signed' },
    body: JSON.stringify(event),
  });
}

describe('Stripe webhook durable ingress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueueRpc.mockResolvedValue({ data: true, error: null });
  });

  it('署名検証後に永続化し、返金同期を待たずに2xxを返す', async () => {
    const event = {
      id: 'evt_fast_ack',
      type: 'refund.failed',
      data: { object: { id: 're_1', payment_intent: 'pi_1' } },
    };
    mockConstructEvent.mockReturnValue(event);
    mockSyncOrderRefunds.mockRejectedValue(new Error('slow business processing failed'));

    const response = await POST(request(event));

    expect(response.status).toBe(200);
    expect(mockEnqueueRpc).toHaveBeenCalledWith(
      'enqueue_stripe_webhook_event',
      expect.objectContaining({
        _event_id: 'evt_fast_ack',
        _event_type: 'refund.failed',
      }),
    );
    expect(mockSyncOrderRefunds).not.toHaveBeenCalled();
  });

  it('永続化できなければ2xxを返さない', async () => {
    const event = { id: 'evt_store_failed', type: 'payment_intent.succeeded', data: { object: {} } };
    mockConstructEvent.mockReturnValue(event);
    mockEnqueueRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });

    const response = await POST(request(event));

    expect(response.status).toBe(500);
  });

  it('署名が無効ならキューへ保存しない', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad signature'); });

    const response = await POST(request({ id: 'evt_invalid' }));

    expect(response.status).toBe(400);
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
  });
  it('一致する重複イベントは再処理せずduplicateを返す', async () => {
    const event = { id: 'evt_duplicate', type: 'refund.updated', data: { object: { id: 're_2' } } };
    mockConstructEvent.mockReturnValue(event);
    mockEnqueueRpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: true });
    expect(mockSyncOrderRefunds).not.toHaveBeenCalled();
  });

  it('署名ヘッダー欠落ならStripeとDBを呼ばない', async () => {
    const response = await POST(new NextRequest('http://localhost/api/webhook/stripe', {
      method: 'POST',
      body: '{}',
    }));
    expect(response.status).toBe(400);
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
  });

  it('Webhook secret未設定なら内部設定を公開せず500にする', async () => {
    const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const response = await POST(request({ id: 'evt_missing_config' }));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(mockEnqueueRpc).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
    }
  });});