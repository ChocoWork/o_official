import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { ORDER_EMAIL_KINDS } from '@/lib/orders/email/order-email-types';
import {
  OrderEmailResendError,
  requestOrderEmailResend,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';

const bodySchema = z.object({ kind: z.enum(ORDER_EMAIL_KINDS) });

const RATE_LIMIT = { endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 } as const;

const MESSAGES = {
  already_queued: '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。',
  not_allowed: '今の注文の状態では、このメールは再送できません。',
  order_not_found: '注文が見つかりません。',
  failed: '再送を受け付けられませんでした。',
} as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * お客様へのメールの再送（グループ D 設計書 5-3）。手で足した印の新しい行を作り、今の注文の情報で作り直して送る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）の順に確かめる。監査にお客様の個人情報は入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { kind } = parsedBody.data;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown>) =>
    logAudit({
      action: 'admin.orders.email.resend',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: parsedId.data,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    const emailId = await requestOrderEmailResend(store, { orderId: parsedId.data, kind, actorId: authz.userId });
    await audit('success', 'Order email resend requested', { kind, email_id: emailId });
    scheduleOrderEmailDelivery();
    return NextResponse.json({ success: true, emailId });
  } catch (error) {
    if (error instanceof OrderEmailResendError) {
      if (error.reason === 'order_not_found') {
        await audit('failure', 'Order not found', { kind });
        return NextResponse.json({ error: MESSAGES.order_not_found }, { status: 404 });
      }
      await audit('conflict', error.reason === 'already_queued' ? 'Resend already queued' : 'Resend not allowed', { kind });
      return NextResponse.json({ error: MESSAGES[error.reason] }, { status: 409 });
    }
    console.error('[admin.orders.email.resend] Failed to request resend', error instanceof Error ? error.name : 'UnknownError');
    await audit('error', 'Failed to request resend', { kind });
    return NextResponse.json({ error: MESSAGES.failed }, { status: 500 });
  }
}
