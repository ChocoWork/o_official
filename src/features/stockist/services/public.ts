import { createPublicClient } from '@/lib/supabase/server';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { PublicStockist, StockistRecord } from '@/features/stockist/types';

export const STOCKIST_MAP_EMBED_URL =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3241.2479707857677!2d139.71433831525895!3d35.66572098019819!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188b835e2c0d0f%3A0x3c6c8e8e8e8e8e8e!2z5p2x5Lqs6YO95riv5Yy65Y2X6Z2S5bGx!5e0!3m2!1sja!2sjp!4v1234567890123!5m2!1sja!2sjp';

/** 公開の取り出しの件数の上限。件数の指定が無い・不正でもこの数で止める。 */
export const PUBLIC_STOCKIST_FETCH_LIMIT = 200;

function toPublicStockists(rows: StockistRecord[]): PublicStockist[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    time: row.time,
    holiday: row.holiday,
  }));
}

/**
 * 公開の店を id の順に取り、画面に渡す 6 つの列に詰め直して返す。
 *
 * @impl IMPL-STOCKIST-103
 * @design DD-STOCKIST-003
 * @remarks 公開の印は DB の RLS と取り出しの条件の 2 段で絞り、片方が崩れても非公開の店を外へ出さない。状態などの内部の列を画面へ渡さないため、返す前に詰め直す。並びの要件が無いので、取るたびに並びが変わらないよう id の順にする。DB が一時的に落ちても頁全体を誤りにしないよう、誤りは空の配列にし、記録は名前と符号だけにする（SEC-STOCKIST-014）。
 * 公開の頁は利用者の Cookie を引き継がない client で取り、件数は指定が無い・不正な時も上限の 200 で止める（SEC-STOCKIST-002・018）。
 */
export async function getPublicStockists(options?: {
  limit?: number;
}): Promise<PublicStockist[]> {
  const supabase = await createPublicClient();

  const requested = options?.limit;
  const limit =
    typeof requested === 'number' && Number.isFinite(requested) && Math.floor(requested) >= 1
      ? Math.min(Math.floor(requested), PUBLIC_STOCKIST_FETCH_LIMIT)
      : PUBLIC_STOCKIST_FETCH_LIMIT;

  const query = supabase
    .from('stockists')
    .select('id, name, address, phone, time, holiday, status')
    .eq('status', 'published')
    .order('id', { ascending: true })
    .limit(limit);

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch public stockists:', describeErrorForLog(error));
    return [];
  }

  return toPublicStockists((data ?? []) as StockistRecord[]);
}

/**
 * ホームの取扱店の節に出す分として、公開の店を 6 件まで返す。
 *
 * @impl IMPL-STOCKIST-104
 * @design DD-STOCKIST-004
 * @remarks ホームの格子は 6 件までしか使わないので、取り出しの側で件数を絞る。
 */
export async function getHomePublicStockists(): Promise<PublicStockist[]> {
  return getPublicStockists({ limit: 6 });
}