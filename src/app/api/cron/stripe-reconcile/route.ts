// 毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net から POST で呼ばれる（設計書 2026-10-05 グループ B の 4-1）
import { NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { logAudit } from '@/lib/audit';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { reconcileFindingsMail, sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import {
  reconcileStripeOrders,
  reconcileStripePayouts,
  type ReconcileDatabase,
  type ReconcilePayoutStripe,
  type ReconcileStripe,
  type StripeReconciliationError,
  type UnmatchedRecentPayment,
} from '@/lib/stripe/reconcile-orders';
import { syncOrderRefunds, type OrderRefundDatabase, type RefundListClient } from '@/lib/stripe/order-refund-sync';
import { syncPaymentIntentAccounting, syncPayoutAccounting } from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { getStripeServerClient } from '@/lib/stripe/server';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
import { createServiceRoleClient } from '@/lib/supabase/server';

// Stripe の全履歴を読むので300秒まで動かす。pg_net は60秒で待つのをやめ、長い実行は応答が timed_out になるが実行は続く（成功か失敗かは ops_job_heartbeats が正）
export const maxDuration = 300;

type AccountingStripeClient = Parameters<typeof syncPayoutAccounting>[0]['stripe'];

export type StripeReconcileResponse = {
  matchedOrders: number;
  unmatchedPayments: number;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  syncedPayouts: number;
  payoutMismatches: number;
  errors: StripeReconciliationError[];
};

/** 監査の1行に載せる失敗の数（行が大きくならないように） */
const MAX_AUDITED_ERRORS = 20;

/** 監査の1行に載せる、注文の無い直近の支払いの ID の数 */
const MAX_AUDITED_PAYMENT_IDS = 20;

/** 最後の成功・失敗を記録する（照合の遅れの点検が読む。設計書 4-6）。記録の失敗で応答を変えない。 */
async function recordRun(store: OpsStore | null, succeeded: boolean, errorCode: string | null): Promise<void> {
  if (!store) return;
  try {
    await recordHeartbeat(store, 'stripe_reconcile', succeeded, errorCode);
  } catch (error) {
    console.error('[stripe-reconcile] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }
}

/**
 * 見つかったことを、1回の実行につき1通だけ店へ知らせる（毎日1回なので、時間ごとの権利は取らない）。
 * 送れなくても、応答と成功の記録は変えない。
 */
async function notifyFindings(unmatched: UnmatchedRecentPayment[], errors: StripeReconciliationError[]): Promise<void> {
  if (unmatched.length === 0 && errors.length === 0) return;
  try {
    await sendOpsAlertMail(reconcileFindingsMail({ unmatched, errors }));
  } catch (error) {
    console.error('[stripe-reconcile] Failed to send the findings mail', webhookFailureCause(error));
  }
}

export async function POST(request: Request) {
  if (!authorizeCronRequest(request, 'stripe-reconcile').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let store: OpsStore | null = null;
  try {
    const database = await createServiceRoleClient();
    store = database as unknown as OpsStore;
    const stripe = getStripeServerClient();
    const accountingDatabase = createStripeAccountingDatabase(database);
    const accountingStripe = stripe as unknown as AccountingStripeClient;

    const orderReport = await reconcileStripeOrders({
      database: database as unknown as ReconcileDatabase,
      stripe: stripe as unknown as ReconcileStripe,
      syncRefunds: (paymentIntentId) => syncOrderRefunds({
        database: database as unknown as OrderRefundDatabase,
        stripe: stripe as unknown as RefundListClient,
        paymentIntentId,
      }),
      syncAccounting: (paymentIntentId) => syncPaymentIntentAccounting({
        stripe: accountingStripe,
        database: accountingDatabase,
        paymentIntentId,
      }),
    });

    const payoutReport = await reconcileStripePayouts({
      stripe: stripe as unknown as ReconcilePayoutStripe,
      syncPayout: (payoutId) => syncPayoutAccounting({
        stripe: accountingStripe,
        database: accountingDatabase,
        payoutId,
      }),
    });

    const data: StripeReconcileResponse = {
      matchedOrders: orderReport.checkedPayments - orderReport.unmatchedActivePayments.length,
      unmatchedPayments: orderReport.unmatchedActivePayments.length,
      syncedBalanceTransactions: orderReport.syncedBalanceTransactions,
      syncedRefunds: orderReport.syncedRefunds,
      syncedPayouts: payoutReport.syncedPayouts,
      payoutMismatches: payoutReport.payoutMismatches,
      errors: [...orderReport.errors, ...payoutReport.errors],
    };

    // 1件ずつの失敗は止めずに数え、支払いの ID と原因の記号を監査に残す（設計書 4-5）
    await logAudit({
      action: 'stripe.reconcile',
      resource: 'stripe',
      outcome: data.errors.length > 0 ? 'error' : 'success',
      detail: 'Stripe reconciliation',
      metadata: {
        matchedOrders: data.matchedOrders,
        unmatchedPayments: data.unmatchedPayments,
        syncedBalanceTransactions: data.syncedBalanceTransactions,
        syncedRefunds: data.syncedRefunds,
        syncedPayouts: data.syncedPayouts,
        payoutMismatches: data.payoutMismatches,
        failed: data.errors.length,
        errors: data.errors.slice(0, MAX_AUDITED_ERRORS),
        unmatchedRecentPaymentIds: orderReport.unmatchedRecentPayments
          .slice(0, MAX_AUDITED_PAYMENT_IDS)
          .map((payment) => payment.id),
      },
    });
    await recordRun(store, true, null);
    await notifyFindings(orderReport.unmatchedRecentPayments, data.errors);
    return NextResponse.json({ data });
  } catch (error) {
    const cause = webhookFailureCause(error);
    console.error('[stripe-reconcile] Reconciliation failed', cause);
    await recordRun(store, false, cause);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 502 });
  }
}
