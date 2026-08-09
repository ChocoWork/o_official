import { NextResponse } from 'next/server';
import { reconcileStripeOrders, type ReconcileDatabase, type ReconcileStripe } from '@/lib/stripe/reconcile-orders';
import { syncOrderRefunds, type OrderRefundDatabase, type RefundListClient } from '@/lib/stripe/order-refund-sync';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const database = await createServiceRoleClient();
    const stripe = getStripeServerClient();
    const report = await reconcileStripeOrders({
      database: database as unknown as ReconcileDatabase,
      stripe: stripe as unknown as ReconcileStripe,
      syncRefunds: (paymentIntentId) => syncOrderRefunds({
        database: database as unknown as OrderRefundDatabase,
        stripe: stripe as unknown as RefundListClient,
        paymentIntentId,
      }),
    });
    return NextResponse.json({ data: report });
  } catch (error) {
    console.error('[stripe-reconcile] Reconciliation failed:', error);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 502 });
  }
}
