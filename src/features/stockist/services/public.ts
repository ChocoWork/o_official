import { createClient } from '@/lib/supabase/server';
import { PublicStockist, StockistRecord } from '@/features/stockist/types';

export const STOCKIST_MAP_EMBED_URL =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3241.2479707857677!2d139.71433831525895!3d35.66572098019819!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188b835e2c0d0f%3A0x3c6c8e8e8e8e8e8e!2z5p2x5Lqs6YO95riv5Yy65Y2X6Z2S5bGx!5e0!3m2!1sja!2sjp!4v1234567890123!5m2!1sja!2sjp';

function toPublicStockists(rows: StockistRecord[]): PublicStockist[] {
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    address: row.address,
    phone: row.phone,
    time: row.time,
    holiday: row.holiday,
  }));
}

export async function getPublicStockists(options?: {
  limit?: number;
}): Promise<PublicStockist[]> {
  const supabase = await createClient();

  let query = supabase
    .from('stockists')
    .select('id, type, name, address, phone, time, holiday, status')
    .eq('status', 'published')
    .order('id', { ascending: true });

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    query = query.limit(Math.floor(options.limit));
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch public stockists:', error);
    return [];
  }

  return toPublicStockists((data ?? []) as StockistRecord[]);
}

export async function getHomePublicStockists(): Promise<PublicStockist[]> {
  return getPublicStockists({ limit: 4 });
}