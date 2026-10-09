const mockStore = { rpc: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockStore),
}));
const mockDrain = jest.fn();
jest.mock('@/lib/stripe/webhook-drain', () => ({
  drainWebhookQueue: (...args: unknown[]) => mockDrain(...args),
}));
const mockProcess = jest.fn();
jest.mock('@/lib/stripe/webhook-processor', () => ({
  processStripeWebhookEvent: (...args: unknown[]) => mockProcess(...args),
}));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockRunOpsChecks = jest.fn();
jest.mock('@/lib/ops/ops-checks', () => ({
  runOpsChecks: (...args: unknown[]) => mockRunOpsChecks(...args),
}));
const mockSendOpsAlertMail = jest.fn();
jest.mock('@/lib/ops/ops-alert-mail', () => ({
  sendOpsAlertMail: (...args: unknown[]) => mockSendOpsAlertMail(...args),
}));
const mockRunOrderEmailWorker = jest.fn();
jest.mock('@/lib/orders/email/order-email-worker', () => ({
  ORDER_EMAIL_WORKER_BUDGET_MS: 10_000,
  runOrderEmailWorker: (...args: unknown[]) => mockRunOrderEmailWorker(...args),
}));
const mockRunOrderEmailOpsChecks = jest.fn();
jest.mock('@/lib/orders/email/order-email-ops', () => ({
  runOrderEmailOpsChecks: (...args: unknown[]) => mockRunOrderEmailOpsChecks(...args),
}));

import { runWebhookWorker, WORKER_TIME_BUDGET_MS } from '@/lib/stripe/webhook-worker';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const CHECKS = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };
const EMAILS = { sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' };
const EMAIL_CHECKS = { pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [] };

describe('runWebhookWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunOpsChecks.mockResolvedValue(CHECKS);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockRunOrderEmailWorker.mockResolvedValue(EMAILS);
    mockRunOrderEmailOpsChecks.mockResolvedValue(EMAIL_CHECKS);
  });

  it('Stripe の知らせに35秒、注文のメールに10秒を使い、成功を記録して両方を点検する', async () => {
    mockDrain.mockResolvedValue({ processed: 2, failed: 0, stoppedBy: 'empty' });

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });

    expect(WORKER_TIME_BUDGET_MS).toBe(35_000);
    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore, budgetMs: 35_000 }));
    expect(mockRunOrderEmailWorker).toHaveBeenCalledWith({ budgetMs: 10_000 });
    // Stripe の知らせが書いた注文のメールの行を、同じ起動の中で送るため、Stripe の知らせを先に処理する
    expect(mockDrain.mock.invocationCallOrder[0]).toBeLessThan(mockRunOrderEmailWorker.mock.invocationCallOrder[0]);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty', checks: CHECKS, emails: EMAILS, emailChecks: EMAIL_CHECKS });
  });

  it('注文のメールの worker が投げても、点検まで続ける', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockRunOrderEmailWorker.mockRejectedValueOnce(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });

      expect(result.emails).toBeNull();
      expect(mockRunOpsChecks).toHaveBeenCalled();
      expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled();
      // 例外の文（boom）は出さず、例外の名前だけを残す
      expect(error).toHaveBeenCalledWith('[stripe-webhook-worker] Order email worker failed', 'Error');
    } finally {
      error.mockRestore();
    }
  });

  it('点検に渡した send は sendOpsAlertMail でメールを送る', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockSendOpsAlertMail.mockResolvedValueOnce(true);
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    const { send } = mockRunOpsChecks.mock.calls[0][0] as { send: (mail: OpsAlertMail) => Promise<boolean> };
    const mail: OpsAlertMail = { kind: 'webhook_backlog', subject: 'キューの滞留', lines: ['queued: 1'] };

    await send(mail);

    expect(mockSendOpsAlertMail).toHaveBeenCalledWith(mail);
  });

  it('指定した時間の予算を drain へ渡す', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });

    await runWebhookWorker({ requestUrl: 'http://localhost/x', budgetMs: 1_000 });

    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: 1_000 }));
  });

  it('知らせの処理は、受け取り口の住所の空の要求で監査する', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });
    const { process } = mockDrain.mock.calls[0][0] as { process: (event: unknown) => Promise<void> };
    await process({ id: 'evt_1' });
    const auditRequest = mockProcess.mock.calls[0][1] as Request;
    expect(new URL(auditRequest.url).pathname).toBe('/api/webhook/stripe');
  });

  it('取り出しの DB の失敗は、失敗（db_unavailable）として記録する', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'claim_error' });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', false, 'db_unavailable');
  });

  it('記録に失敗しても点検は行う', async () => {
    mockDrain.mockResolvedValue({ processed: 1, failed: 0, stoppedBy: 'empty' });
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runWebhookWorker({ requestUrl: 'http://localhost/x' })).resolves.toMatchObject({ processed: 1 });
    expect(mockRunOpsChecks).toHaveBeenCalled();
  });
});
