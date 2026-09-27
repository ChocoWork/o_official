import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getItemAvailability } from '@/lib/items/availability';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { signItemImageFields } from '@/lib/storage/item-images';

const itemIdSchema = z.coerce.number().int().positive();
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

// GET: 個別商品取得（公開済みのみ）
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const rateLimited = await enforceRateLimit({
      request,
      endpoint: 'items:detail',
      limit: 120,
      windowSeconds: 60,
    });

    if (rateLimited) {
      rateLimited.headers.set('Cache-Control', 'no-store');
      return rateLimited;
    }

    const { id: rawId } = await params;
    const parsedId = itemIdSchema.safeParse(rawId);

    if (!parsedId.success) {
      return NextResponse.json(
        { error: 'Invalid item id' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const id = parsedId.data;
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('items')
      .select('id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, material, origin, care, product_note')
      .eq('id', id)
      .eq('status', 'published')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Item not found' },
          { status: 404, headers: NO_STORE_HEADERS }
        );
      }
      console.error('Supabase Error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch item' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: 'Item not found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    const signedData = await signItemImageFields(await createServiceRoleClient(), data);
    // 在庫の単位は色 × サイズ（FREQ-400 / FREQ-401）。
    const publicItem = signedData;
    const availability = await getItemAvailability(id);

    return NextResponse.json(
      {
        ...publicItem,
        madeToOrder: availability.madeToOrder,
        variantAvailability: availability.combinations,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
