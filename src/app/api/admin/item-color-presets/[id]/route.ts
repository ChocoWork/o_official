import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = await createServiceRoleClient();

    const { error } = await supabase
      .from('item_color_presets')
      .delete()
      .eq('id', params.id);

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
