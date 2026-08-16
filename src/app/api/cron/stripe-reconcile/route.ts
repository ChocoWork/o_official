import { NextResponse } from 'next/server';
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

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const database = await createServiceRoleClient();
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
    return NextResponse.json({ data });
  } catch (error) {
    console.error('[stripe-reconcile] Reconciliation failed:', error);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 502 });
  }
}
