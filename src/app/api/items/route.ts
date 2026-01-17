import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { Item } from '@/app/types/item';

// GET: 商品一覧取得（認証不要）
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    
    // 商品テーブルからデータを取得（認証不要）
    const { data, error } = await supabase
      .from('items')
      .select('*')
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