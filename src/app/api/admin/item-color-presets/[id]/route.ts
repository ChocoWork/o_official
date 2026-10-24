/**
 * 商品の色見本を1件削除する管理者向けの窓口（src/app/api/admin/item-color-presets/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-142
 * @design DD-ADMIN-012
 * @remarks 誤って保存した色や使わなくなった色を一覧から外して選び間違いを減らすため。消せるのは商品を管理できる人だけにし、認可の後に service role で消す。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { error } = await supabase
      .from('item_color_presets')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Failed to delete item color preset:', error);
      return NextResponse.json({ error: 'Failed to delete color preset' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/item-color-presets/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
