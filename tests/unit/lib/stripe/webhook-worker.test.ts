const mockStore = { rpc: jest.fn() };
const mockSafeRunPosting = jest.fn();
jest.mock('@/lib/accounting/posting-runner', () => ({
  safeRunAccountingPosting: (...args: unknown[]) => mockSafeRunPosting(...args),
  WEBHOOK_POSTING_OPTIONS: { limit: 20, maxLoops: 1 },
}));
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
const mockRunOrderEmailDeliveryCheckIfDue = jest.fn();
jest.mock('@/lib/orders/email/order-email-delivery', () => ({
  runOrderEmailDeliveryCheckIfDue: (...args: unknown[]) => mockRunOrderEmailDeliveryCheckIfDue(...args),
}));

const mockPasskeyNotifications = jest.fn();
jest.mock('@/lib/auth/passkey-notification-worker', () => ({
  runPasskeyNotificationWorker: (...args: unknown[]) => mockPasskeyNotifications(...args),
}));

const mockPasskeyOpsChecks = jest.fn();
jest.mock('@/lib/auth/passkey-notification-ops', () => ({
  runPasskeyNotificationOpsChecks: (...args: unknown[]) => mockPasskeyOpsChecks(...args),
}));

import { runWebhookWorker, WORKER_TIME_BUDGET_MS } from '@/lib/stripe/webhook-worker';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';
import { ORDER_EMAIL_WORKER_BUDGET_MS } from '@/lib/orders/email/order-email-worker';

const mockTracking = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-worker', () => ({
  DELIVERY_TRACKING_BUDGET_MS: 8000,
  DELIVERY_TRACKING_MIN_BUDGET_MS: 3000,
  runDeliveryTrackingWorker: (...args: unknown[]) => mockTracking(...args),
}));
const TRACKING = { registered: 0, read: 0, stopped: 0, expired: 0, stoppedBy: 'empty' };

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
    mockRunOrderEmailDeliveryCheckIfDue.mockResolvedValue('not_due');
    mockTracking.mockReset().mockResolvedValue(TRACKING);
    mockSafeRunPosting.mockReset().mockResolvedValue(null);
    mockPasskeyOpsChecks.mockReset().mockResolvedValue({ deadNotified: 0, staleAlerted: false, failedChecks: [] });
  });

  it('FREQ-562-AC-05: 知らせを処理した起動は、終わりに1回だけ係を呼び（limit 20・繰り返さない）、注文のメールの前に待つ', async () => {
    mockDrain.mockResolvedValue({ processed: 5, failed: 1, stoppedBy: 'empty' });

    await runWebhookWorker({ requestUrl: 'http://localhost/x' });

    expect(mockSafeRunPosting).toHaveBeenCalledTimes(1);
    expect(mockSafeRunPosting).toHaveBeenCalledWith('webhook', { limit: 20, maxLoops: 1 });
    // 知らせ1件ごとには呼ばない: drain の process は会計の係を呼ばず、係の呼び出しは drain のあと
    expect(mockDrain.mock.invocationCallOrder[0]).toBeLessThan(mockSafeRunPosting.mock.invocationCallOrder[0]);
    expect(mockSafeRunPosting.mock.invocationCallOrder[0]).toBeLessThan(mockRunOrderEmailWorker.mock.invocationCallOrder[0]);
  });

  it('FREQ-562-AC-05: 知らせを1件も処理しなかった起動は係を呼ばない', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    mockDrain.mockResolvedValue({ processed: 0, failed: 2, stoppedBy: 'empty' });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockSafeRunPosting).not.toHaveBeenCalled();
  });

  it('FREQ-562-AC-05: 係が失敗（null）しても知らせは成功として数え、メールと点検へ進む', async () => {
    mockDrain.mockResolvedValue({ processed: 3, failed: 0, stoppedBy: 'empty' });
    mockSafeRunPosting.mockResolvedValue(null);

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });

    expect(result).toMatchObject({ processed: 3, failed: 0, stoppedBy: 'empty' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOrderEmailWorker).toHaveBeenCalled();
    expect(mockRunOpsChecks).toHaveBeenCalled();
  });

  it('Stripe の知らせに35秒、注文のメールに10秒を使い、成功を記録して両方を点検する', async () => {
    mockDrain.mockResolvedValue({ processed: 2, failed: 0, stoppedBy: 'empty' });

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });

    expect(WORKER_TIME_BUDGET_MS).toBe(35_000);
    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore, budgetMs: 35_000 }));
    expect(mockRunOrderEmailWorker).toHaveBeenCalledWith({ budgetMs: 10_000 });
    expect(mockRunOrderEmailDeliveryCheckIfDue).toHaveBeenCalledWith(mockStore);
    // Stripe の知らせが書いた注文のメールの行を、同じ起動の中で送るため、Stripe の知らせを先に処理する
    expect(mockDrain.mock.invocationCallOrder[0]).toBeLessThan(mockRunOrderEmailWorker.mock.invocationCallOrder[0]);
    // 配達の見回りは Resend の返事に左右されて長引きうるので、店への知らせの点検（2つ）より後に動かす
    expect(mockRunOpsChecks.mock.invocationCallOrder[0]).toBeLessThan(mockRunOrderEmailDeliveryCheckIfDue.mock.invocationCallOrder[0]);
    expect(mockRunOrderEmailOpsChecks.mock.invocationCallOrder[0]).toBeLessThan(mockRunOrderEmailDeliveryCheckIfDue.mock.invocationCallOrder[0]);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty', checks: CHECKS, emails: EMAILS, emailChecks: EMAIL_CHECKS, deliveryTracking: TRACKING });
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

  it('配達の見回りが投げても、2つの点検の結果を返す', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockRunOrderEmailDeliveryCheckIfDue.mockRejectedValueOnce(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });

      expect(result).toEqual({ processed: 0, failed: 0, stoppedBy: 'empty', checks: CHECKS, emails: EMAILS, emailChecks: EMAIL_CHECKS, deliveryTracking: TRACKING });
      // 例外の文（boom）は出さず、例外の名前だけを残す
      expect(error).toHaveBeenCalledWith('[stripe-webhook-worker] Delivery check failed', 'Error');
    } finally {
      error.mockRestore();
    }
  });

  it('グループ B と D の点検に渡した send は sendOpsAlertMail でメールを送る', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockSendOpsAlertMail.mockResolvedValue(true);
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    const { send } = mockRunOpsChecks.mock.calls[0][0] as { send: (mail: OpsAlertMail) => Promise<boolean> };
    const mail: OpsAlertMail = { kind: 'webhook_backlog', subject: 'キューの滞留', lines: ['queued: 1'] };

    await send(mail);

    expect(mockSendOpsAlertMail).toHaveBeenCalledWith(mail);
    const { send: sendOrderEmailAlert } = mockRunOrderEmailOpsChecks.mock.calls[0][0] as { send: (mail: OpsAlertMail) => Promise<boolean> };
    const orderEmailMail: OpsAlertMail = { kind: 'order_email_paused', subject: '注文のメールの一時停止', lines: ['送信の鍵の設定'] };
    await expect(sendOrderEmailAlert(orderEmailMail)).resolves.toBe(true);
    expect(mockSendOpsAlertMail).toHaveBeenNthCalledWith(2, orderEmailMail);
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

  it('心拍の記録に失敗しても worker の結果は変わらず、両方の点検を行い、ログは例外名だけ', async () => {
    mockDrain.mockResolvedValue({ processed: 1, failed: 0, stoppedBy: 'empty' });
    mockRecordHeartbeat.mockRejectedValueOnce(new Error('宛先・件名・本文を含む例外'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runWebhookWorker({ requestUrl: 'http://localhost/x' })).resolves.toEqual({
        processed: 1, failed: 0, stoppedBy: 'empty', checks: CHECKS, emails: EMAILS, emailChecks: EMAIL_CHECKS, deliveryTracking: TRACKING,
      });
      expect(mockRunOpsChecks).toHaveBeenCalled();
      expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled();
      expect(error.mock.calls).toEqual([['[stripe-webhook-worker] Failed to record heartbeat', 'Error']]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('毎分の配送の枠', () => {
  beforeEach(() => {
    jest.resetAllMocks(); jest.useFakeTimers(); jest.setSystemTime(0);
    jest.requireMock('@/lib/supabase/server').createServiceRoleClient.mockResolvedValue(mockStore);
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    mockRunOrderEmailWorker.mockResolvedValue(EMAILS); mockTracking.mockResolvedValue(TRACKING);
    mockRecordHeartbeat.mockResolvedValue(undefined); mockRunOpsChecks.mockResolvedValue(CHECKS);
    mockRunOrderEmailOpsChecks.mockResolvedValue(EMAIL_CHECKS);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  test('順番はStripe、メール、配送、点検、メールの配信の見回り', async () => {
    const calls: string[] = [];
    mockDrain.mockImplementation(async () => { calls.push('stripe'); return { stoppedBy: 'empty' }; });
    mockRunOrderEmailWorker.mockImplementation(async () => { calls.push('mail'); return EMAILS; });
    mockTracking.mockImplementation(async () => { calls.push('tracking'); return TRACKING; });
    mockRunOpsChecks.mockImplementation(async () => { calls.push('ops'); return CHECKS; });
    mockRunOrderEmailOpsChecks.mockImplementation(async () => { calls.push('mailOps'); return EMAIL_CHECKS; });
    mockRunOrderEmailDeliveryCheckIfDue.mockImplementation(async () => { calls.push('mailDelivery'); });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(calls).toEqual(['stripe', 'mail', 'tracking', 'ops', 'mailOps', 'mailDelivery']);
  });
  test('Stripe35秒とメール10秒は変えない', () => {
    expect(WORKER_TIME_BUDGET_MS).toBe(35000); expect(ORDER_EMAIL_WORKER_BUDGET_MS).toBe(10000);
  });
  test.each([[8000, 8000], [5000, 5000], [3000, 3000], [2999, 0]])('残り%smsの配送の枠は%sms', async (remaining, budget) => {
    mockRunOrderEmailWorker.mockImplementation(async () => { jest.setSystemTime(45000 - remaining); return EMAILS; });
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    if (budget) expect(mockTracking).toHaveBeenCalledWith({ budgetMs: budget });
    else { expect(mockTracking).not.toHaveBeenCalled(); expect(result.deliveryTracking).toBeNull(); }
  });
  test('予算で飛ばしてもdelivery_trackingの心拍を残す', async () => {
    mockRunOrderEmailWorker.mockImplementation(async () => { jest.setSystemTime(50000); return EMAILS; });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'delivery_tracking', true, null);
  });
  test('最初のDB接続に使った時間も数え、8秒を上限にする', async () => {
    const { createServiceRoleClient } = jest.requireMock('@/lib/supabase/server');
    createServiceRoleClient.mockImplementationOnce(async () => { jest.setSystemTime(40000); return mockStore; });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockTracking).toHaveBeenCalledWith({ budgetMs: 5000 });
  });
  test('HTTP timeoutやDB失敗でworkerが投げても次の点検へ進む', async () => {
    mockTracking.mockRejectedValue(new Error('raw本文 key signature number'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(result.deliveryTracking).toBeNull(); expect(mockRunOpsChecks).toHaveBeenCalled();
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled(); expect(mockRunOrderEmailDeliveryCheckIfDue).toHaveBeenCalled();
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'delivery_tracking', false, 'delivery_tracking_error');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/raw本文|signature|number/);
  });
  test('DD-AUTH-088 DD-AUTH-067 パスキーの知らせは、追跡の後・点検の前に、残りから決めた3秒以内の予算で呼ぶ', async () => {
    const PASSKEY = { claimed: 1, sent: 1, retried: 0, dead: 0, skipped: 0, stopped: 'idle' };
    mockPasskeyNotifications.mockResolvedValue(PASSKEY);
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
    expect(mockPasskeyNotifications).toHaveBeenCalledWith({ budgetMs: 3000, hardDeadlineMs: 45_000 });
    expect(result.passkeyNotifications).toEqual(PASSKEY);
    expect(mockTracking.mock.invocationCallOrder[0]).toBeLessThan(mockPasskeyNotifications.mock.invocationCallOrder[0]);
    expect(mockPasskeyNotifications.mock.invocationCallOrder[0]).toBeLessThan(mockRunOpsChecks.mock.invocationCallOrder[0]);
  });
  test('DD-AUTH-067 passkeyNotifications が偽（after() の道）では知らせの worker を呼ばない', async () => {
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockPasskeyNotifications).not.toHaveBeenCalled();
    expect(result.passkeyNotifications).toBeUndefined();
  });
  test('DD-AUTH-067 35秒と10秒を使い切った時は知らせの worker を呼ばない', async () => {
    mockRunOrderEmailWorker.mockImplementation(async () => { jest.setSystemTime(45000); return EMAILS; });
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
    expect(mockPasskeyNotifications).not.toHaveBeenCalled();
    expect(result.passkeyNotifications).toBeNull();
  });
  test.each([[44000, 1000], [43500, 1500], [45000, 0]])('DD-AUTH-067 経過%sms なら知らせの予算は%sms（1秒未満は呼ばない）', async (elapsed, budget) => {
    mockRunOrderEmailWorker.mockImplementation(async () => { jest.setSystemTime(elapsed); return EMAILS; });
    mockTracking.mockImplementation(async () => TRACKING);
    await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
    if (budget) expect(mockPasskeyNotifications).toHaveBeenCalledWith({ budgetMs: budget, hardDeadlineMs: 45_000 });
    else expect(mockPasskeyNotifications).not.toHaveBeenCalled();
  });
  test('DD-AUTH-067 知らせの worker が投げても、点検・見回りは動き、結果に null を返す。ログは例外名だけ', async () => {
    mockPasskeyNotifications.mockRejectedValue(new Error('a@example.com 本文'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
    expect(result.passkeyNotifications).toBeNull();
    expect(mockRunOpsChecks).toHaveBeenCalled();
    expect(mockRunOrderEmailOpsChecks).toHaveBeenCalled();
    expect(mockRunOrderEmailDeliveryCheckIfDue).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/a@example|本文/);
  });
  describe('DD-AUTH-089 パスキーの知らせの心拍と点検', () => {
    beforeEach(() => { mockPasskeyOpsChecks.mockReset().mockResolvedValue({ deadNotified: 0, staleAlerted: false, failedChecks: [] }); });
    const PK_HEARTBEAT = 'passkey_notification_worker';
    const pkCalls = () => mockRecordHeartbeat.mock.calls.filter((call) => call[1] === PK_HEARTBEAT);
    const withStopped = (stopped: string) => ({ claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0, stopped });

    test.each([['idle'], ['budget']])('DD-AUTH-089 worker が %s で終われば成功の心拍', async (stopped) => {
      mockPasskeyNotifications.mockResolvedValue(withStopped(stopped));
      await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(pkCalls()).toEqual([[mockStore, PK_HEARTBEAT, true, null]]);
    });
    test('DD-AUTH-089 claim_error は db_unavailable の失敗の心拍', async () => {
      mockPasskeyNotifications.mockResolvedValue(withStopped('claim_error'));
      await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(pkCalls()).toEqual([[mockStore, PK_HEARTBEAT, false, 'db_unavailable']]);
    });
    test('DD-AUTH-089 worker が投げたら worker_error の失敗の心拍', async () => {
      mockPasskeyNotifications.mockRejectedValue(new Error('x'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(pkCalls()).toEqual([[mockStore, PK_HEARTBEAT, false, 'worker_error']]);
    });
    test.each([['config'], ['disabled']])('DD-AUTH-089 %s の時は心拍を書かない', async (stopped) => {
      mockPasskeyNotifications.mockResolvedValue(withStopped(stopped));
      await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(pkCalls()).toEqual([]);
    });
    test('DD-AUTH-089 残りが1秒未満で worker を呼ばなかった時は成功の心拍', async () => {
      mockRunOrderEmailWorker.mockImplementation(async () => { jest.setSystemTime(45000); return EMAILS; });
      await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(mockPasskeyNotifications).not.toHaveBeenCalled();
      expect(pkCalls()).toEqual([[mockStore, PK_HEARTBEAT, true, null]]);
    });
    test('DD-AUTH-089 心拍の書き込みが投げても worker は結果を返し、点検も動く', async () => {
      mockPasskeyNotifications.mockResolvedValue(withStopped('idle'));
      mockRecordHeartbeat.mockImplementation(async (_store: unknown, job: string) => { if (job === PK_HEARTBEAT) throw new Error('a@example.com'); });
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(result.passkeyNotifications).toEqual(withStopped('idle'));
      expect(mockPasskeyOpsChecks).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/a@example/);
    });
    test('DD-AUTH-089 点検は注文のメールの点検の後に呼び、結果に passkeyChecks を足す', async () => {
      mockPasskeyNotifications.mockResolvedValue(withStopped('idle'));
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(mockPasskeyOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
      expect(mockRunOrderEmailOpsChecks.mock.invocationCallOrder[0]).toBeLessThan(mockPasskeyOpsChecks.mock.invocationCallOrder[0]);
      expect(result.passkeyChecks).toEqual({ deadNotified: 0, staleAlerted: false, failedChecks: [] });
    });
    test('DD-AUTH-089 点検が投げても worker は止まらず、見回りまで進む', async () => {
      mockPasskeyNotifications.mockResolvedValue(withStopped('idle'));
      mockPasskeyOpsChecks.mockRejectedValue(new Error('a@example.com'));
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x', passkeyNotifications: true });
      expect(result.passkeyChecks).toBeNull();
      expect(mockRunOrderEmailDeliveryCheckIfDue).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/a@example/);
    });
    test('DD-AUTH-089 passkeyNotifications が偽なら心拍も点検も無い', async () => {
      const result = await runWebhookWorker({ requestUrl: 'http://localhost/x' });
      expect(pkCalls()).toEqual([]);
      expect(mockPasskeyOpsChecks).not.toHaveBeenCalled();
      expect(result.passkeyChecks).toBeUndefined();
    });
  });
});
