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

const mockRunWebhookWorker = jest.fn();
jest.mock('@/lib/stripe/webhook-worker', () => ({
  runWebhookWorker: (...args: unknown[]) => mockRunWebhookWorker(...args),
}));

import { POST } from '@/app/api/cron/process-stripe-webhooks/route';

const CHECKS = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };
// Task 8 で32文字以上を求めるので、はじめから32文字以上にしておく
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization = `Bearer ${CRON_SECRET}`): Request {
  return new Request('http://localhost/api/cron/process-stripe-webhooks', {
    method: 'POST',
    headers: { authorization },
  });
}

describe('POST /api/cron/process-stripe-webhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    mockRunWebhookWorker.mockResolvedValue({ processed: 2, failed: 1, stoppedBy: 'empty', checks: CHECKS });
  });

  it('認証されない呼出しと未設定secretを拒否し、worker を動かさない', async () => {
    expect((await POST(request(`Bearer ${CRON_SECRET.slice(0, -1)}X`))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(request())).status).toBe(401);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が32文字未満なら、ヘッダーが一致していても断る', async () => {
    process.env.CRON_SECRET = 'short-secret';
    expect((await POST(request('Bearer short-secret'))).status).toBe(401);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
  });

  it('worker を1回動かし、件数と止まった理由を返す', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processed: 2, failed: 1, stoppedBy: 'empty' });
    expect(mockRunWebhookWorker).toHaveBeenCalledWith({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });
  });

  it('取り出しの DB 障害は成功扱いにしない（502）', async () => {
    mockRunWebhookWorker.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'claim_error', checks: CHECKS });
    const response = await POST(request());
    expect(response.status).toBe(502);
  });
});
