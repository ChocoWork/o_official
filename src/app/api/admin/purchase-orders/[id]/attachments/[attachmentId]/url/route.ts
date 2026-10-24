import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createPurchaseOrderDocumentUrl } from '@/lib/purchase-orders/purchase-order-documents';
import { PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_DOCUMENT_TEXT } from '@/lib/purchase-orders/purchase-order-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * 取引書類の原本を見る・保存するための短い署名つきリンク（G-2 / FREQ-530）。60秒だけ使える。
 * ?download=1 なら原ファイル名つきのダウンロード用、無ければ表示用。権限は admin.purchase_orders.read で、窓口と DB の関数の両方で確かめる
 * （実行者は認可結果の userId だけから渡す）。回数制限 admin.purchase_orders.attachment.view の120回/600秒を IP と actor の2回かける。
 * リンクは応答にだけ載せ、監査にもログにも出さない（読むだけで監査は無い）。置き場に無ければ404。DB・置き場の生の誤りは本文にもログにも出さない。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.purchase_orders.read', request);
  if (!authz.ok) return noStore(authz.response);

  const rate = { endpoint: 'admin.purchase_orders.attachment.view', limit: 120, windowSeconds: 600 };
  const ipLimited = await enforceRateLimit({ request, ...rate });
  if (ipLimited) return noStore(ipLimited);
  const actorLimited = await enforceRateLimit({ request, ...rate, subject: authz.userId });
  if (actorLimited) return noStore(actorLimited);

  const { id, attachmentId } = await context.params;
  const download = new URL(request.url).searchParams.get('download');
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(attachmentId).success
    || (download !== null && download !== '1')) {
    return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
  }

  try {
    const client = await createServiceRoleClient();
    const result = await createPurchaseOrderDocumentUrl(client, authz.userId, {
      purchaseOrderId: id,
      attachmentId,
      download: download === '1',
    });
    return noStore(NextResponse.json(result));
  } catch (error) {
    if (error instanceof PurchaseOrderError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('[admin.purchase_orders] document url failed');
    return noStore(NextResponse.json({ error: PURCHASE_ORDER_DOCUMENT_TEXT.openFailed }, { status: 500 }));
  }
}
