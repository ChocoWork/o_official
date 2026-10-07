jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockSendOpsAlertMail = jest.fn();
const mockReconcileFindingsMail = jest.fn();
jest.mock('@/lib/ops/ops-alert-mail', () => ({
  sendOpsAlertMail: (...args: unknown[]) => mockSendOpsAlertMail(...args),
  reconcileFindingsMail: (...args: unknown[]) => mockReconcileFindingsMail(...args),
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/stripe/reconcile-orders', () => ({
  reconcileStripeOrders: jest.fn(),
  reconcileStripePayouts: jest.fn(),
}));
jest.mock('@/lib/stripe/supabase-accounting-database', () => ({
  createStripeAccountingDatabase: jest.fn().mockReturnValue({}),
}));

import * as reconcileRoute from '@/app/api/cron/stripe-reconcile/route';
import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';
import { createServiceRoleClient } from '@/lib/supabase/server';

const mockDatabase = { name: 'service-role-client' };

const mockReconcileOrders = reconcileStripeOrders as jest.Mock;
const mockReconcilePayouts = reconcileStripePayouts as jest.Mock;
const { POST } = reconcileRoute;
// 定期処理の合言葉は32文字以上（設計書 2026-10-05 グループ B の 4-3）
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

const findingsMail = { kind: 'reconcile_findings', subject: 'findings', lines: ['findings'] };

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/stripe-reconcile', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

function orderReport(overrides: Record<string, unknown> = {}) {
  return {
    checkedPayments: 0,
    unmatchedActivePayments: [],
    unmatchedRecentPayments: [],
    refundMismatches: [],
    syncedBalanceTransactions: 0,
    syncedRefunds: 0,
    errors: [],
    ...overrides,
  };
}

function payoutReport(overrides: Record<string, unknown> = {}) {
  return { syncedPayouts: 0, payoutMismatches: 0, errors: [], ...overrides };
}

describe('POST /api/cron/stripe-reconcile', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (createServiceRoleClient as jest.Mock).mockResolvedValue(mockDatabase);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockSendOpsAlertMail.mockResolvedValue(true);
    mockReconcileFindingsMail.mockReturnValue(findingsMail);
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env.CRON_SECRET;
  });

  it('rejects requests without the cron bearer token', async () => {
    const response = await POST(new Request('http://localhost/api/cron/stripe-reconcile', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a CRON_SECRET shorter than 32 characters even when the header matches', async () => {
    process.env.CRON_SECRET = 'short-secret';
    const response = await POST(new Request('http://localhost/api/cron/stripe-reconcile', {
      method: 'POST',
      headers: { authorization: 'Bearer short-secret' },
    }));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is called with POST only (pg_net sends POST)', () => {
    expect('GET' in reconcileRoute).toBe(false);
  });

  it('does not create orders for unmatched Stripe payments', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 2,
      unmatchedActivePayments: ['pi_stripe_only'],
      // 7日より古い支払いなので、メールの対象には入らない
      unmatchedRecentPayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      errors: [],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });

    const response = await POST(authorizedRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      matchedOrders: 1,
      unmatchedPayments: 1,
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      syncedPayouts: 0,
      payoutMismatches: 0,
      errors: [],
    });
  });

  it('merges order and payout errors into one report', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 1,
      unmatchedActivePayments: [],
      unmatchedRecentPayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 0,
      syncedRefunds: 0,
      errors: [{ sourceId: 'pi_1', reason: 'stripe unavailable' }],
    });
    mockReconcilePayouts.mockResolvedValue({
      syncedPayouts: 1,
      payoutMismatches: 1,
      errors: [{ sourceId: 'po_1', reason: 'payout sync failed' }],
    });

    const body = await (await POST(authorizedRequest())).json();

    expect(body.data.errors).toEqual([
      { sourceId: 'pi_1', reason: 'stripe unavailable' },
      { sourceId: 'po_1', reason: 'payout sync failed' },
    ]);
    expect(body.data.payoutMismatches).toBe(1);
  });

  it('returns 502 when reconciliation itself throws', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockReconcileOrders.mockRejectedValue(new Error('database down'));
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    error.mockRestore();
  });

  it('records the run as succeeded and audits the counts with failure causes only', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 2,
      unmatchedActivePayments: [],
      unmatchedRecentPayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      errors: [{ sourceId: 'pi_1', reason: 'stripe_unavailable' }],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 1, payoutMismatches: 0, errors: [] });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'stripe_reconcile', true, null);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'stripe.reconcile',
      resource: 'stripe',
      outcome: 'error',
      metadata: expect.objectContaining({
        failed: 1,
        errors: [{ sourceId: 'pi_1', reason: 'stripe_unavailable' }],
      }),
    }));
  });

  it('records the run as failed with a cause code when reconciliation throws', async () => {
    mockReconcileOrders.mockRejectedValue(Object.assign(new Error('x'), { code: 'db_unavailable' }));
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'stripe_reconcile', false, 'db_unavailable');
    // ログには原因の記号だけを出す（例外そのものを渡さない）
    expect(error).toHaveBeenCalledWith('[stripe-reconcile] Reconciliation failed', 'db_unavailable');
    error.mockRestore();
  });

  it('still answers 200 when the heartbeat cannot be recorded', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 0,
      unmatchedActivePayments: [],
      unmatchedRecentPayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 0,
      syncedRefunds: 0,
      errors: [],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect((await POST(authorizedRequest())).status).toBe(200);
    error.mockRestore();
  });

  it('実行の上限は300秒（Stripe の履歴を全部たどるので、60秒では足りない）', () => {
    expect(reconcileRoute.maxDuration).toBe(300);
  });

  describe('見つかったことのメール（1回の実行につき1通）', () => {
    const unmatched = [
      { id: 'pi_1', amount: 89000, currency: 'jpy', created: 1_790_000_000 },
      { id: 'pi_2', amount: 1200, currency: 'jpy', created: 1_790_000_100 },
    ];
    const orderErrors = [{ sourceId: 'pi_9', reason: 'stripe_unavailable' }];
    const payoutErrors = [{ sourceId: 'po_1', reason: 'db_unavailable' }];

    it('直近7日の注文の無い支払いがあれば、1通送り、監査にその支払いの ID を残す', async () => {
      mockReconcileOrders.mockResolvedValue(orderReport({
        checkedPayments: 2,
        unmatchedActivePayments: ['pi_1', 'pi_2'],
        unmatchedRecentPayments: unmatched,
      }));
      mockReconcilePayouts.mockResolvedValue(payoutReport());

      const response = await POST(authorizedRequest());

      expect(response.status).toBe(200);
      expect(mockReconcileFindingsMail).toHaveBeenCalledWith({ unmatched, errors: [] });
      expect(mockSendOpsAlertMail).toHaveBeenCalledTimes(1);
      expect(mockSendOpsAlertMail).toHaveBeenCalledWith(findingsMail);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ unmatchedRecentPaymentIds: ['pi_1', 'pi_2'] }),
      }));
    });

    it('失敗だけのときも、支払いの失敗と入金の失敗をまとめて1通送る', async () => {
      mockReconcileOrders.mockResolvedValue(orderReport({ errors: orderErrors }));
      mockReconcilePayouts.mockResolvedValue(payoutReport({ errors: payoutErrors }));

      await POST(authorizedRequest());

      expect(mockReconcileFindingsMail).toHaveBeenCalledWith({ unmatched: [], errors: [...orderErrors, ...payoutErrors] });
      expect(mockSendOpsAlertMail).toHaveBeenCalledTimes(1);
    });

    it('支払いと失敗の両方があっても1通だけ送る', async () => {
      mockReconcileOrders.mockResolvedValue(orderReport({ unmatchedRecentPayments: unmatched, errors: orderErrors }));
      mockReconcilePayouts.mockResolvedValue(payoutReport({ errors: payoutErrors }));

      await POST(authorizedRequest());

      expect(mockSendOpsAlertMail).toHaveBeenCalledTimes(1);
      expect(mockReconcileFindingsMail).toHaveBeenCalledWith({ unmatched, errors: [...orderErrors, ...payoutErrors] });
    });

    it('直近7日の支払いも失敗も無ければ送らない（7日より古い注文の無い支払いだけのときも）', async () => {
      mockReconcileOrders.mockResolvedValue(orderReport({ checkedPayments: 1, unmatchedActivePayments: ['pi_old'] }));
      mockReconcilePayouts.mockResolvedValue(payoutReport());

      const response = await POST(authorizedRequest());

      expect(response.status).toBe(200);
      expect(mockReconcileFindingsMail).not.toHaveBeenCalled();
      expect(mockSendOpsAlertMail).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ unmatchedRecentPaymentIds: [] }),
      }));
    });

    it('監査の行と成功の記録のあとに送る', async () => {
      mockReconcileOrders.mockResolvedValue(orderReport({ unmatchedRecentPayments: unmatched }));
      mockReconcilePayouts.mockResolvedValue(payoutReport());

      await POST(authorizedRequest());

      const audit = mockLogAudit.mock.invocationCallOrder[0];
      const heartbeat = mockRecordHeartbeat.mock.invocationCallOrder[0];
      const mail = mockSendOpsAlertMail.mock.invocationCallOrder[0];
      expect(audit).toBeLessThan(heartbeat);
      expect(heartbeat).toBeLessThan(mail);
    });

    it.each([
      ['false を返しても', () => mockSendOpsAlertMail.mockResolvedValue(false)],
      ['例外になっても', () => mockSendOpsAlertMail.mockRejectedValue(new Error('smtp down'))],
    ])('メールの送信が%s、応答は200のままで、成功の記録は1回だけ', async (_name, arrange) => {
      arrange();
      mockReconcileOrders.mockResolvedValue(orderReport({ unmatchedRecentPayments: unmatched }));
      mockReconcilePayouts.mockResolvedValue(payoutReport());
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      const response = await POST(authorizedRequest());

      expect(mockSendOpsAlertMail).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(mockRecordHeartbeat).toHaveBeenCalledTimes(1);
      expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'stripe_reconcile', true, null);
      error.mockRestore();
    });

    it('監査に残す支払いの ID は20件まで（金額などは残さない）', async () => {
      const many = Array.from({ length: 25 }, (_, i) => ({ id: `pi_${i + 1}`, amount: 1000, currency: 'jpy', created: 1_790_000_000 }));
      mockReconcileOrders.mockResolvedValue(orderReport({ unmatchedRecentPayments: many }));
      mockReconcilePayouts.mockResolvedValue(payoutReport());

      await POST(authorizedRequest());

      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ unmatchedRecentPaymentIds: many.slice(0, 20).map((payment) => payment.id) }),
      }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('"amount"');
    });
  });
});
