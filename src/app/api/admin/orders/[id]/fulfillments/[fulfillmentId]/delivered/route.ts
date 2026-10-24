import { NextResponse } from 'next/server';
import {
  LEGACY_FULFILLMENT_DISABLED,
  legacyFulfillmentDisabledBody,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import { createDeliveryAudit, guardDeliveryAdminWrite } from '@/lib/orders/tracking/delivery-route-support';

/**
 * 手動の配達済み（停止前: グループ E-4）。G-1 で止めた（G-3 の新しい発送票へ移る）。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）の後、入力を読まずに 410（LEGACY_FULFILLMENT_DISABLED）を返す。
 * DB の関数は呼ばない。監査は既存の操作名の failure と固定の記号だけ。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; fulfillmentId: string }> }) {
  const guard = await guardDeliveryAdminWrite(request, 'delivered');
  if (!guard.ok) return guard.response;
  const routeParams = await params;
  await createDeliveryAudit(request, guard.actorId, 'delivered', routeParams.id)('failure', { code: LEGACY_FULFILLMENT_DISABLED });
  return NextResponse.json(legacyFulfillmentDisabledBody(LEGACY_FULFILLMENT_DISABLED), {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
