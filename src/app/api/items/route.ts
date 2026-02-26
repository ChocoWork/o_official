import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { Item } from '@/app/types/item';

// GET: 商品一覧取得（公開済みのみ）
export async function GET() {
  try {
    const supabase = await createClient();
    
    // 公開済み商品のみを取得
    const { data, error } = await supabase
      .from('items')
      .select('id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at')
      .eq('status', 'published')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase Error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch items' },
        { status: 500 }
      );
    }

    // 型を明確に指定
    const items: Item[] = data;

    return NextResponse.json(items);
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}