jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        body,
      }),
    },
  };
});

const mockStore = { rpc: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue(mockStore),
}));

const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockFail = jest.fn();
jest.mock('@/lib/stripe/webhook-events', () => ({
  claimWebhookEvent: (...args: unknown[]) => mockClaim(...args),
  completeWebhookEvent: (...args: unknown[]) => mockComplete(...args),
  failWebhookEvent: (...args: unknown[]) => mockFail(...args),
  webhookErrorCategory: (error: unknown) => error instanceof Error ? error.name : 'UnknownError',
}));

const mockProcess = jest.fn();
jest.mock('@/lib/stripe/webhook-processor', () => ({
  processStripeWebhookEvent: (...args: unknown[]) => mockProcess(...args),
}));

import { POST } from '@/app/api/cron/process-stripe-webhooks/route';

const event = {
  id: 'evt_worker_1',
  type: 'checkout.session.expired',
  data: { object: { id: 'cs_worker_1' } },
};
const claim = {
  eventId: event.id,
  eventType: event.type,
  rawPayload: event,
  claimToken: 'a31ef5a3-2987-4b66-a44f-af52a3a58943',
};

function request(authorization = 'Bearer cron-secret'): Request {
  return new Request('http://localhost/api/cron/process-stripe-webhooks', {
    method: 'POST',
    headers: { authorization },
  });
}

describe('POST /api/cron/process-stripe-webhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    mockClaim.mockResolvedValue(claim);
    mockProcess.mockResolvedValue(undefined);
    mockComplete.mockResolvedValue(undefined);
    mockFail.mockResolvedValue(undefined);
  });

  it('認証されない呼出しと未設定secretを拒否し、DBを触らない', async () => {
    expect((await POST(request('Bearer cron-secreX'))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(request())).status).toBe(401);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('キューが空なら何も処理しない', async () => {
    mockClaim.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processed: 0 });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('claimしたイベントの業務処理後に同じtokenで完了させる', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processed: 1 });
    expect(mockProcess).toHaveBeenCalledWith(event, expect.anything());
    expect(mockComplete).toHaveBeenCalledWith(mockStore, event.id, claim.claimToken);
    expect(mockComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockProcess.mock.invocationCallOrder[0],
    );
    expect(mockFail).not.toHaveBeenCalled();
  });

  it('業務処理失敗を永続化して次回再試行させる', async () => {
    mockProcess.mockRejectedValue(new Error('transient database failure'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith(
      mockStore, event.id, claim.claimToken, expect.any(Error),
    );
  });

  it('壊れた保存payloadを業務処理へ渡さず失敗として記録する', async () => {
    mockClaim.mockResolvedValue({ ...claim, rawPayload: { ...event, id: 'evt_mismatch' } });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalled();
  });

  it('claimのDB障害は成功扱いにしない', async () => {
    mockClaim.mockRejectedValue(new Error('database unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(mockProcess).not.toHaveBeenCalled();
  });
});