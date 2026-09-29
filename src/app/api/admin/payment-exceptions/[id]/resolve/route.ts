import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { sendOrderCanceledEmail } from '@/lib/orders/order-lifecycle-emails';
import { ADMIN_NOTE_MAX_LENGTH, CANCEL_REASONS } from '@/lib/orders/order-payment-types';

const resolveSchema = z.object({
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
  cancelOrder: z.boolean().default(false),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  notifyCustomer: z.boolean().default(true),
});

type ResolveRow = {
  resolved: boolean;
  order_id: string | null;
  cancelled_from: 'payment_in_progress' | 'pending' | null;
};

/**
 * 要対応を解決済みにする(設計書 5-2)。未入金の注文が付いていれば、取り消して解決もできる(メモ必須)。
 * 取り消した場合は確保した分だけ在庫を戻し、注文履歴に実行者と理由を残す(RPC の中)。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  const parsedBody = resolveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { note, cancelOrder, cancelReason, notifyCustomer } = parsedBody.data;
  if (cancelOrder && (!note || !cancelReason)) {
    return NextResponse.json(
      { error: '注文を取り消して解決するときは、取消の理由とメモを入力してください。' },
      { status: 400 },
    );
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase.rpc('resolve_payment_exception', {
      _exception_id: parsedId.data,
      _actor_id: authz.userId,
      _note: note || null,
      _cancel_order: cancelOrder,
      _cancel_reason: cancelOrder ? cancelReason : null,
      _notify_customer: cancelOrder ? notifyCustomer : null,
    });

    if (error) {
      if (error.message?.includes('ORDER_NOT_CANCELLABLE')) {
        return NextResponse.json({ error: '未入金の注文だけ取り消せます。' }, { status: 409 });
      }
      console.error('[admin.payment-exceptions.resolve] Failed to resolve:', error);
      return NextResponse.json({ error: 'Failed to resolve' }, { status: 500 });
    }

    const row = (Array.isArray(data) ? data[0] : data) as ResolveRow | null;
    if (!row?.resolved) {
      await logAudit({
        action: 'admin.payment_exceptions.resolve',
        actor_id: authz.userId,
        resource: 'payment_exceptions',
        resource_id: parsedId.data,
        outcome: 'conflict',
        detail: 'Payment exception was already resolved or changed',
      });
      return NextResponse.json(
        { error: '既に解決済みか、状態が変わりました。一覧を更新してください。' },
        { status: 409 },
      );
    }

    if (row.cancelled_from && row.order_id && notifyCustomer) {
      await sendOrderCanceledEmail({
        store: supabase,
        orderId: row.order_id,
        previousStatus: row.cancelled_from,
        logLabel: '[admin]',
      });
    }

    await logAudit({
      action: 'admin.payment_exceptions.resolve',
      actor_id: authz.userId,
      resource: 'payment_exceptions',
      resource_id: parsedId.data,
      outcome: 'success',
      detail: row.cancelled_from ? 'Payment exception resolved with order cancellation' : 'Payment exception resolved',
      metadata: {
        order_id: row.order_id,
        cancel_order: Boolean(row.cancelled_from),
        cancel_reason: row.cancelled_from ? cancelReason : null,
      },
    });

    return NextResponse.json({ success: true, orderCancelled: Boolean(row.cancelled_from) });
  } catch (error) {
    console.error('POST /api/admin/payment-exceptions/:id/resolve error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
