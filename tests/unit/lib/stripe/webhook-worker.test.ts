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

import { runWebhookWorker, WORKER_TIME_BUDGET_MS } from '@/lib/stripe/webhook-worker';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const CHECKS = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };

describe('runWebhookWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunOpsChecks.mockResolvedValue(CHECKS);
    mockRecordHeartbeat.mockResolvedValue(undefined);
  });

  it('約45秒の予算で処理し、成功を記録して点検する', async () => {
    mockDrain.mockResolvedValue({ processed: 2, failed: 0, stoppedBy: 'empty' });

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });

    expect(WORKER_TIME_BUDGET_MS).toBe(45_000);
    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore, budgetMs: 45_000 }));
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty', checks: CHECKS });
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
