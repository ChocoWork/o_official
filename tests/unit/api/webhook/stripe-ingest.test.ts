import { NextRequest } from 'next/server';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_ingest';

const mockAfterCallbacks: Array<() => unknown> = [];
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    after: (callback: () => unknown) => {
      mockAfterCallbacks.push(callback);
    },
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

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockRunWebhookWorker = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/stripe/webhook-worker', () => ({
  runWebhookWorker: (...args: unknown[]) => mockRunWebhookWorker(...args),
}));

const mockRecordSignatureFailure = jest.fn().mockResolvedValue(undefined);
const mockRecordModeMismatch = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/ops/webhook-receiver-signals', () => ({
  recordSignatureFailure: (...args: unknown[]) => mockRecordSignatureFailure(...args),
  recordModeMismatch: (...args: unknown[]) => mockRecordModeMismatch(...args),
}));

async function runAfterCallbacks(): Promise<void> {
  for (const callback of mockAfterCallbacks.splice(0)) await callback();
}

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
    mockAfterCallbacks.length = 0;
    jest.clearAllMocks();
    mockEnqueueRpc.mockResolvedValue({ data: true, error: null });
  });

  it('署名検証後に永続化し、返金同期を待たずに2xxを返す', async () => {
    const event = {
      id: 'evt_fast_ack',
      type: 'refund.failed',
      livemode: false,
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
    const event = { id: 'evt_store_failed', type: 'payment_intent.succeeded', livemode: false, data: { object: {} } };
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
    expect(mockLogAudit).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRecordSignatureFailure).toHaveBeenCalledTimes(1);
  });
  it('一致する重複イベントは再処理せずduplicateを返す', async () => {
    const event = { id: 'evt_duplicate', type: 'refund.updated', livemode: false, data: { object: { id: 're_2' } } };
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
    await runAfterCallbacks();
    expect(mockRecordSignatureFailure).toHaveBeenCalledTimes(1);
  });

  it('Webhook secret未設定なら内部設定を公開せず500にする', async () => {
    const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const response = await POST(request({ id: 'evt_missing_config' }));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(mockEnqueueRpc).not.toHaveBeenCalled();
      expect(mockAfterCallbacks).toHaveLength(0);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
    }
  });

  it('STRIPE_SECRET_KEY未設定なら署名不正と数えず500にする', async () => {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const event = { id: 'evt_missing_key', type: 'checkout.session.completed', livemode: false, data: { object: {} } };
      mockConstructEvent.mockReturnValue(event);
      const response = await POST(request(event));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(mockAfterCallbacks).toHaveLength(0);
      expect(mockConstructEvent).not.toHaveBeenCalled();
      expect(mockRecordSignatureFailure).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_SECRET_KEY = savedKey;
    }
  });

  it('13種以外の知らせは保存せずに200を返す', async () => {
    const event = { id: 'evt_other', type: 'customer.created', livemode: false, data: { object: { id: 'cus_1' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, ignored: true });
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
    expect(mockAfterCallbacks).toHaveLength(0);
    await runAfterCallbacks();
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
    expect(mockRecordSignatureFailure).not.toHaveBeenCalled();
    expect(mockRecordModeMismatch).not.toHaveBeenCalled();
  });

  it('モードの違う知らせは保存せず、200を返して数える', async () => {
    const event = { id: 'evt_live', type: 'checkout.session.completed', livemode: true, data: { object: { id: 'cs_1' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, ignored: true });
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRecordModeMismatch).toHaveBeenCalledWith(expect.anything(), true, false);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
  });

  it('鍵の頭が不明なら保存せず、鍵のモードをnullとして数える', async () => {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'pk_test_unknown';
    try {
      const event = { id: 'evt_unknown_key', type: 'checkout.session.completed', livemode: false, data: { object: {} } };
      mockConstructEvent.mockReturnValue(event);
      const response = await POST(request(event));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, ignored: true });
      expect(mockEnqueueRpc).not.toHaveBeenCalled();
      await runAfterCallbacks();
      expect(mockRecordModeMismatch).toHaveBeenCalledWith(expect.anything(), false, null);
    } finally {
      process.env.STRIPE_SECRET_KEY = savedKey;
    }
  });

  it('保存したら、返事の後にその場で worker を1回動かす', async () => {
    const event = { id: 'evt_after', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_2' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRunWebhookWorker).toHaveBeenCalledWith({ requestUrl: 'http://localhost/api/webhook/stripe' });
  });

  it('その場のworkerが例外になっても吸収し、エラーの種類だけを記録する', async () => {
    const event = { id: 'evt_worker_failed', type: 'checkout.session.completed', livemode: false, data: { object: {} } };
    mockConstructEvent.mockReturnValue(event);
    mockRunWebhookWorker.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await POST(request(event));
      expect(response.status).toBe(200);
      await expect(runAfterCallbacks()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('[webhook] Inline worker run failed', 'Error');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
