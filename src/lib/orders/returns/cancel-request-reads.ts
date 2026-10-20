import type { SupabaseClient } from '@supabase/supabase-js';
import { listOrderLineFulfillment } from '@/lib/orders/fulfillment/fulfillment-store';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';

/**
 * キャンセルの申し込みの目印の読み出し（グループ E-3 段2、決め事 P11・T8-8）。管理画面の注文の一覧（各行の印・上の一行の数・絞り込み）と、
 * キャンセルの申し込みの画面の窓口（注文の状態・発送した数・未発送の数）が使う。サーバーだけで使う。
 * 表 order_cancel_requests は service_role が SELECT だけできる（Global Constraints）。この読み出しのための DB の関数は C-1 に無いので、表を直に読む。
 * 開いている申し込み（status = 'requested'）は注文に1つ（一意の索引）なので、申し込みの数は注文の数と同じ。
 * 読めなかった時は RefundStoreError（呼び出しの名前と DB の記号だけを見せ、DB の文は cause にだけ残す）。
 */

/** 絞り込み cancelRequest=open が返す注文の上限（返品の絞り込み return= と同じ500件） */
export const CANCEL_REQUEST_FILTER_LIMIT = 500;

type OrderIdRow = { order_id: string };

/** 開いている申し込みのある注文の番号。申し込みの新しい順に CANCEL_REQUEST_FILTER_LIMIT 件まで */
export async function listOrderIdsWithOpenCancelRequest(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from('order_cancel_requests')
    .select('order_id')
    .eq('status', 'requested')
    .order('requested_at', { ascending: false })
    .limit(CANCEL_REQUEST_FILTER_LIMIT);
  if (error) {
    throw new RefundStoreError('list_open_cancel_requests', error);
  }
  return ((data ?? []) as OrderIdRow[]).map((row) => row.order_id);
}

/** 渡した注文のうち、開いている申し込みのある物の番号。空なら DB を読まない */
export async function findOrderIdsWithOpenCancelRequest(
  client: SupabaseClient,
  orderIds: readonly string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) {
    return new Set();
  }
  const { data, error } = await client
    .from('order_cancel_requests')
    .select('order_id')
    .eq('status', 'requested')
    .in('order_id', [...orderIds]);
  if (error) {
    throw new RefundStoreError('find_open_cancel_requests', error);
  }
  return new Set(((data ?? []) as OrderIdRow[]).map((row) => row.order_id));
}

/** 開いている申し込みの数（= 開いている申し込みのある注文の数）。行は読まず、数だけを読む */
export async function countOrdersWithOpenCancelRequest(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from('order_cancel_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'requested');
  if (error) {
    throw new RefundStoreError('count_open_cancel_requests', error);
  }
  return count ?? 0;
}

/**
 * キャンセルの申し込みの画面が、品を外す方法（mode）を決めるのに使う材料: 注文の状態と、発送した数・未発送の数の合計。
 * 数は E-1 の商品ごとの数（listOrderLineFulfillment）の shipped・unshipped の和（交換の品の行も含む）。注文が無ければ null。
 * listOrderLineFulfillment は渡した番号を小文字にして DB に引くが、答えの鍵は渡した文字のまま（窓口の uuid の検証が通した大文字の番号も、
 * 渡した文字のままで引ける）。なので、ここでは番号を直さず、渡した orderId のままで引く
 */
export async function loadCancelRequestOrderContext(
  client: SupabaseClient,
  orderId: string,
): Promise<{ orderStatus: OrderStatus; shippedUnits: number; unshippedUnits: number } | null> {
  const [orderResult, lineCounts] = await Promise.all([
    client.from('orders').select('status').eq('id', orderId).maybeSingle<{ status: OrderStatus }>(),
    listOrderLineFulfillment(client, [orderId]),
  ]);
  if (orderResult.error) {
    throw new RefundStoreError('load_order', orderResult.error);
  }
  if (!orderResult.data) {
    return null;
  }
  const lines = lineCounts.get(orderId) ?? [];
  const shippedUnits = lines.reduce((total, line) => total + line.shipped, 0);
  const unshippedUnits = lines.reduce((total, line) => total + line.unshipped, 0);
  return { orderStatus: orderResult.data.status, shippedUnits, unshippedUnits };
}
