import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { syncPaymentIntentAccounting } from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

type AccountingStripeClient = Parameters<typeof syncPaymentIntentAccounting>[0]['stripe'];

const requestSchema = z.object({
  cursor: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(100),
});

type OrderRow = { id: string; payment_intent_id: string };

export type StripeBackfillResponse = {
  data: {
    processed: number;
    synced: number;
    failed: number;
    nextCursor: string | null;
    errors: Array<{ orderId: string; reason: string }>;
  };
};

export async function POST(request: Request) {
  const authz = await authorizeAdminPermission('admin.finance.manage', request);
  if (!authz.ok) return authz.response;

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) return csrfResult;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: '入力内容を確認してください。', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServiceRoleClient();
    const database = createStripeAccountingDatabase(supabase);
    const stripe = getStripeServerClient() as unknown as AccountingStripeClient;

    let query = supabase
      .from('orders')
      .select('id, payment_intent_id')
      .not('payment_intent_id', 'is', null);
    if (parsed.data.cursor) {
      query = query.gt('id', parsed.data.cursor);
    }
    const { data, error } = await query.order('id', { ascending: true }).limit(parsed.data.limit);
    if (error) throw error;

    const orders = (data ?? []) as OrderRow[];
    const errors: Array<{ orderId: string; reason: string }> = [];
    let synced = 0;

    for (const order of orders) {
      try {
        await syncPaymentIntentAccounting({
          stripe,
          database,
          paymentIntentId: order.payment_intent_id,
        });
        synced += 1;
      } catch (syncError) {
        errors.push({
          orderId: order.id,
          reason: syncError instanceof Error ? syncError.message : 'unknown error',
        });
      }
    }

    const nextCursor =
      orders.length === parsed.data.limit ? orders[orders.length - 1]!.id : null;

    await logAudit({
      action: 'admin.finance.stripeBackfill',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stripe-accounting',
      outcome: errors.length > 0 ? 'failure' : 'success',
      detail: `Backfilled ${synced} of ${orders.length} orders`,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata: { processed: orders.length, synced, failed: errors.length },
    });

    return NextResponse.json({
      data: { processed: orders.length, synced, failed: errors.length, nextCursor, errors },
    });
  } catch (error) {
    console.error('POST /api/admin/accounting/stripe-backfill error:', error);
    return NextResponse.json({ error: 'Stripe会計バックフィルに失敗しました。' }, { status: 500 });
  }
}
