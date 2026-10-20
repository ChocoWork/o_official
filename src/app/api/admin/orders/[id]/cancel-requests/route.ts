import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { INVALID_REQUEST_BODY, REFUND_ERROR_MESSAGES, refundErrorBody } from '@/lib/orders/refund/refund-messages';
import { loadCancelRequestOrderContext } from '@/lib/orders/returns/cancel-request-reads';
import { listOrderCancelRequests } from '@/lib/orders/returns/cancel-request-store';
import { respondToReturnReadError } from '@/lib/orders/returns/return-route-support';
import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 注文のキャンセルの申し込みの一覧（グループ E-3 段2、設計書 5-4・8-1）。キャンセルの申し込みの画面を開いた時に読む。
 * 申し込みごとの品・数・今の未発送の数・ご連絡事項・お断り／解決済み／解決の中身に、注文の状態と発送した数・未発送の数の合計を添える
 * （画面が「品を外す」の方法 mode を決める。P11）。返品の権限の人（店長とサポート）だけが読める。
 * 読むだけなので CSRF・回数の制限・監査は通さない。ご連絡事項を含むので、キャッシュさせない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.return', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const client = await createServiceRoleClient();
    const [cancelRequests, context] = await Promise.all([
      listOrderCancelRequests(client, parsedId.data),
      loadCancelRequestOrderContext(client, parsedId.data),
    ]);
    if (!context) {
      return NextResponse.json(refundErrorBody('order_not_found'), { status: REFUND_ERROR_MESSAGES.order_not_found.status });
    }
    return NextResponse.json(
      {
        data: {
          cancelRequests,
          orderStatus: context.orderStatus,
          shippedUnits: context.shippedUnits,
          unshippedUnits: context.unshippedUnits,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return respondToReturnReadError(error, {
      tag: '[admin.orders.cancel-request.list] Failed to load cancel requests',
      failureKind: 'cancelRequests',
    });
  }
}
