import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { INVALID_REQUEST_BODY } from '@/lib/orders/refund/refund-messages';
import { respondToReturnReadError } from '@/lib/orders/returns/return-route-support';
import { loadReturnCreateMaterials } from '@/lib/orders/returns/return-store';

/**
 * 返品を作る画面を開いた時に読む材料（グループ E-3 設計書 5-3）。発送ごとの品と返品できる数・期限・
 * 交換で選べる色・サイズと在庫・設定（返送先の有無・手数料・理由ごとの返送料の負担）。
 * 返品を作る操作と同じ権限の人だけが読める。読むだけなので CSRF と回数の制限は通さない。
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
    const store = await createServiceRoleClient();
    const materials = await loadReturnCreateMaterials(store, parsedId.data);
    return NextResponse.json({ data: materials }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return respondToReturnReadError(error, {
      tag: '[admin.orders.return.materials] Failed to load materials',
      failureKind: 'materials',
    });
  }
}
