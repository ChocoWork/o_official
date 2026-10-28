/**
 * 商品の色見本を一覧し、新しい色を保存する管理者向けの窓口（src/app/api/admin/item-color-presets/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-141
 * @design DD-ADMIN-011
 * @remarks item_color_presets は認可の後に service role で読み書きするため、先に商品の権限（一覧は閲覧、保存は管理）で確かめる。同じ名前と色の値の組は何度保存しても1行にし、既にあればその行を 200 で返して、画面が重なりの誤りを扱わずに済むようにする。既にあるかの確認が失敗した時は、重なりを作らないよう保存へ進まず 500 にする。保存は削除と合わせて管理者単位で10分に60回までに絞る。新しく作れた時だけ（201）、誰がどこから作ったかを監査に残す。色の名前と値は入れず、行の id だけを残す（既にある行を返す 200 は何も作っていないので残さない）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { getAuditRequestContext } from '@/lib/request-ip';

const colorPresetSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const COLOR_PRESET_WRITE_RATE_LIMIT = { endpoint: 'admin:color-presets:write', limit: 60, windowSeconds: 600 } as const;

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.items.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('item_color_presets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch item color presets:', error);
      return NextResponse.json({ error: 'Failed to fetch color presets' }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/item-color-presets error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const limited = await enforceRateLimit({ request, ...COLOR_PRESET_WRITE_RATE_LIMIT, subject: authz.userId });
    if (limited) {
      return limited;
    }

    const body = await request.json().catch(() => null);
    const parsed = colorPresetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createServiceRoleClient();

    const { data: existing, error: lookupError } = await supabase
      .from('item_color_presets')
      .select('id, name, hex, created_at')
      .eq('name', parsed.data.name)
      .eq('hex', parsed.data.hex)
      .maybeSingle();

    if (lookupError) {
      console.error('Failed to look up item color preset:', { code: lookupError.code });
      return NextResponse.json({ error: 'Failed to save color preset' }, { status: 500 });
    }

    if (existing) {
      return NextResponse.json({ data: existing }, { status: 200 });
    }

    const { data, error } = await supabase
      .from('item_color_presets')
      .insert([
        {
          name: parsed.data.name,
          hex: parsed.data.hex,
        },
      ])
      .select('*')
      .single();

    if (error) {
      console.error('Failed to create item color preset:', error);
      return NextResponse.json({ error: 'Failed to save color preset' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.item_color_preset.create',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'item_color_preset',
      resource_id: String(data.id),
      outcome: 'success',
      ...getAuditRequestContext(request),
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/item-color-presets error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
