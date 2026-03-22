import { createClient } from '@/lib/supabase/server';
import type { Item } from '@/app/types/item';

export async function getPublishedItems(limit?: number): Promise<Item[]> {
  const supabase = await createClient();

  let query = supabase
    .from('items')
    .select('id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at')
    .eq('status', 'published')
    .order('created_at', { ascending: false });

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch published items:', error);
    return [];
  }

  if (!data) {
    return [];
  }

  return data as Item[];
}
