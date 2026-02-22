import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { Item } from '@/app/types/item';

// GET: 個別商品取得（公開済みのみ）
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('items')
      .select('id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at')
      .eq('id', params.id)
      .eq('status', 'published')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Item not found' },
          { status: 404 }
        );
      }
      console.error('Supabase Error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch item' },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: 'Item not found' },
        { status: 404 }
      );
    }

    const item: Item = data;
    return NextResponse.json(item);
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
