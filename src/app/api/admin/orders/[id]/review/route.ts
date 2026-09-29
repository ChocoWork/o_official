import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

/** 要確認を確認済みにする(設計書 5-2)。手動の操作でだけ付く */
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
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase.rpc('mark_order_reviewed', {
      _order_id: parsedId.data,
      _actor_id: authz.userId,
    });

    if (error) {
      console.error('[admin.orders.review] Failed to mark reviewed:', error);
      return NextResponse.json({ error: 'Failed to mark reviewed' }, { status: 500 });
    }

    const reviewed = data === true;
    await logAudit({
      action: 'admin.orders.review',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: parsedId.data,
      outcome: reviewed ? 'success' : 'conflict',
      detail: reviewed ? 'Order marked as reviewed' : 'No open review for the order',
    });

    if (!reviewed) {
      return NextResponse.json(
        { error: '確認済みにできる要確認がありません。一覧を更新してください。' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/admin/orders/:id/review error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
