/**
 * 商品の色見本を1件削除する管理者向けの窓口（src/app/api/admin/item-color-presets/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-142
 * @design DD-ADMIN-012
 * @remarks 誤って保存した色や使わなくなった色を一覧から外して選び間違いを減らすため。消せるのは商品を管理できる人だけにし、認可の後に service role で消す。無い id を消そうとした時に成功と返すと、画面が消えたと誤解するので、消した行が0行なら404を返す。id の形が数字でない・桁が大きすぎる時は DB に渡さず404にする（型の誤りが500になるのを避ける）。保存と合わせて管理者単位で10分に60回までに絞る。
 */
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const COLOR_PRESET_WRITE_RATE_LIMIT = { endpoint: 'admin:color-presets:write', limit: 60, windowSeconds: 600 } as const;

/** bigint に収まる正の整数の形（18桁以下の数字だけ）。 */
const PRESET_ID_PATTERN = /^\d{1,18}$/;

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const limited = await enforceRateLimit({ request, ...COLOR_PRESET_WRITE_RATE_LIMIT, subject: authz.userId });
    if (limited) {
      return limited;
    }

    if (!PRESET_ID_PATTERN.test(id)) {
      return NextResponse.json({ error: 'Color preset not found' }, { status: 404 });
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('item_color_presets')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      console.error('Failed to delete item color preset:', error);
      return NextResponse.json({ error: 'Failed to delete color preset' }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Color preset not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/item-color-presets/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
