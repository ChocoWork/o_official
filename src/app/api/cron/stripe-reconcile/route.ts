// 毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net から POST で呼ばれる（設計書 2026-10-05 グループ B の 4-1）
import { NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { logAudit } from '@/lib/audit';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import {
  reconcileStripeOrders,
  reconcileStripePayouts,
  type ReconcileDatabase,
  type ReconcilePayoutStripe,
  type ReconcileStripe,
  type StripeReconciliationError,
} from '@/lib/stripe/reconcile-orders';
import { syncOrderRefunds, type OrderRefundDatabase, type RefundListClient } from '@/lib/stripe/order-refund-sync';
import { syncPaymentIntentAccounting, syncPayoutAccounting } from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { getStripeServerClient } from '@/lib/stripe/server';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
import { createServiceRoleClient } from '@/lib/supabase/server';

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

/** 最後の成功・失敗を記録する（照合の遅れの点検が読む。設計書 4-6）。記録の失敗で応答を変えない。 */
async function recordRun(store: OpsStore | null, succeeded: boolean, errorCode: string | null): Promise<void> {
  if (!store) return;
  try {
    await recordHeartbeat(store, 'stripe_reconcile', succeeded, errorCode);
  } catch (error) {
    console.error('[stripe-reconcile] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
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
      },
    });
    await recordRun(store, true, null);
    return NextResponse.json({ data });
  } catch (error) {
    const cause = webhookFailureCause(error);
    console.error('[stripe-reconcile] Reconciliation failed', cause);
    await recordRun(store, false, cause);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 502 });
  }
}
