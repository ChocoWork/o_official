import { createClient } from '@/lib/supabase/server';
import type { Item } from '@/types/item';

const ITEM_SELECT_COLUMNS =
  'id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at';

export type ItemSort = 'newest' | 'price_asc' | 'price_desc' | 'popular';

export type PublishedItemsQuery = {
  category?: string;
  size?: string;
  priceMin?: number;
  priceMax?: number;
  sort?: ItemSort;
  page?: number;
  pageSize?: number;
};

export type PublishedItemsPage = {
  items: Item[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

export async function getPublishedItems(limit?: number): Promise<Item[]> {
  const supabase = await createClient();

  let query = supabase
    .from('items')
    .select(ITEM_SELECT_COLUMNS)
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

export async function getPublishedItemsPage(queryInput: PublishedItemsQuery = {}): Promise<PublishedItemsPage> {
  const supabase = await createClient();

  const page = Number.isFinite(queryInput.page) && (queryInput.page ?? 0) > 0 ? Math.floor(queryInput.page as number) : 1;
  const pageSize =
    Number.isFinite(queryInput.pageSize) && (queryInput.pageSize ?? 0) > 0
      ? Math.min(60, Math.floor(queryInput.pageSize as number))
      : 12;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('items')
    .select(ITEM_SELECT_COLUMNS, { count: 'planned' })
    .eq('status', 'published');

  if (queryInput.category && queryInput.category.toUpperCase() !== 'ALL') {
    query = query.eq('category', queryInput.category.toUpperCase());
  }

  if (queryInput.size) {
    query = query.contains('sizes', [queryInput.size]);
  }

  if (typeof queryInput.priceMin === 'number') {
    query = query.gte('price', queryInput.priceMin);
  }

  if (typeof queryInput.priceMax === 'number') {
    query = query.lte('price', queryInput.priceMax);
  }

  switch (queryInput.sort) {
    case 'price_asc':
      query = query.order('price', { ascending: true }).order('created_at', { ascending: false });
      break;
    case 'price_desc':
      query = query.order('price', { ascending: false }).order('created_at', { ascending: false });
      break;
    case 'popular':
      query = query.order('created_at', { ascending: false });
      break;
    case 'newest':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  query = query.range(from, to);

  const { data, error, count } = await query;

  if (error) {
    console.error('Failed to fetch paged published items:', error);
    return {
      items: [],
      page,
      pageSize,
      total: 0,
      hasMore: false,
    };
  }

  const items = (data ?? []) as Item[];
  const total = typeof count === 'number' ? count : items.length;

  return {
    items,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
  };
}
