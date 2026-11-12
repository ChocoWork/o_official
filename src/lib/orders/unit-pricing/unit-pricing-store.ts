import type { SupabaseClient } from '@supabase/supabase-js';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { UnitPricingMaterials } from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 値段の計画の材料を DB から読む（FREQ-642。設計書 7章）。サーバーだけで使う（画面から読まない）。
 * 単体試験が直接読むので、サーバー専用の印（server-only）は付けない（return-store.ts と同じ。印を付けると、
 * これを読む返品・返金の流れの試験が全部、印の差し替えを要る）。
 * DB の関数 order_unit_pricing_materials の jsonb は、計画の型（unit-pricing-types.ts）と同じ camelCase なので、直さずに渡す
 * （持ち主が入れ替わった枠などは DB が直してから返す。ここで足し引きしない）。
 */
export type UnitPricingClient = Pick<SupabaseClient, 'rpc' | 'from'>;

/** 注文の材料。注文の時の写しが無い注文（この変更より前の注文）は null（計画を作らず、今の計算のまま） */
export async function loadUnitPricingMaterials(
  client: UnitPricingClient,
  orderId: string,
): Promise<UnitPricingMaterials | null> {
  const { data, error } = await client.rpc('order_unit_pricing_materials', { _order_id: orderId });
  if (error) {
    throw new RefundStoreError('order_unit_pricing_materials', error);
  }
  const root = Array.isArray(data) ? data[0] : data;
  if (!root || typeof root !== 'object') {
    return null;
  }
  const materials = root as UnitPricingMaterials;
  if (typeof materials.version !== 'string' || !materials.target || !Array.isArray(materials.related)) {
    throw new RefundStoreError('order_unit_pricing_materials', null);
  }
  return materials;
}

/** 返品の注文の番号。返品が無ければ null */
export async function loadReturnOrderId(client: UnitPricingClient, returnId: string): Promise<string | null> {
  const { data, error } = await client
    .from('order_returns')
    .select('order_id')
    .eq('id', returnId)
    .maybeSingle<{ order_id: string }>();
  if (error) {
    throw new RefundStoreError('load_return_order', error);
  }
  return data?.order_id ?? null;
}

type ReceiveEventRow = { id: string; now_refund: number; consult_refund: number };
type Part = 'now' | 'consult';
type EventRefundRow = { event_id: string; refund_id: string; part: Part };
type RefundRow = { id: string; status: string; shipping_amount?: number | null; created_at?: string };

/** 2つの返金のうち新しい方（作った時刻、同じなら番号の大きい方） */
const latestOf = (a: RefundRow, b: RefundRow): RefundRow => {
  const at = (a.created_at ?? '').localeCompare(b.created_at ?? '');
  return at !== 0 ? (at > 0 ? a : b) : (a.id > b.id ? a : b);
};

/** 返品の「額を決めて返金する」の見込み。amount は標準の額（商品）、retryShipping は送料の欄の初めの値（返せる送料で切る前） */
export type ReturnRefundOutstanding = { amount: number; retryShipping: number };

/**
 * 返品の「額を決めて返金する」で返す標準の額と、送料の欄の初めの値（見込みの表示用）。DB の
 * private.order_unit_return_refund_parts と同じ数え方（FREQ-642-AC-37）で、返品の受け取りの出来事ごとに
 * - 相談の分: 相談の返金（失敗以外）が付いていなければ consult_refund を足す。店長がその返金の額を下げても、残りとして出さない
 *   （DB は相談の返金を二度は受けない。設計 2-1）
 * - 今すぐの分: 今すぐの返金が失敗していて、失敗以外の今すぐの返金が付いていなければ now_refund を足す。手続き中・エラーの返金は
 *   生きているので二度は数えない。受け取りで0円で終えた今すぐの分（返金が無い）は数えない
 * - どちらも、返金しないで終えた分（order_unit_event_waives に記録がある分）は数えない
 * 全部返したら 0。取り消せる出来事は発送前の取り消しだけなので、返品の受け取りの出来事に取り消しは無い。
 * retryShipping は、足した今すぐの分ごとに、結ばれた失敗した返金のうち一番新しい物（作った時刻、同じなら番号の大きい方）を選び、
 * 選んだ返金の送料（shipping_amount）を足した額（同じ返金は1回）。相談の分だけに結ばれた失敗した返金の送料は使わない（0で始まる）。
 * 画面が返せる送料で切る。
 * DB の読み手と同じ額になることは、DB の試験（unit-binding-refund-retry）がこの関数を DB に向けて毎回確かめる。
 * @impl FREQ-642-AC-37
 * @design DD-ADMIN-022
 */
export async function loadReturnRefundOutstanding(client: UnitPricingClient, returnId: string): Promise<ReturnRefundOutstanding> {
  const events = await client
    .from('order_unit_events')
    .select('id, now_refund, consult_refund')
    .eq('return_id', returnId)
    .eq('kind', 'return_receive');
  if (events.error) {
    throw new RefundStoreError('load_unit_events', events.error);
  }
  const open = (events.data ?? []) as ReceiveEventRow[];
  if (open.length === 0) {
    return { amount: 0, retryShipping: 0 };
  }
  const eventIds = open.map((row) => row.id);
  const links = await client
    .from('order_unit_event_refunds')
    .select('event_id, refund_id, part')
    .in('event_id', eventIds)
    .in('part', ['now', 'consult']);
  if (links.error) {
    throw new RefundStoreError('load_unit_event_refunds', links.error);
  }
  const waives = await client.from('order_unit_event_waives').select('event_id, part').in('event_id', eventIds);
  if (waives.error) {
    throw new RefundStoreError('load_unit_event_waives', waives.error);
  }
  const waived = new Set(((waives.data ?? []) as Array<{ event_id: string; part: Part }>).map((row) => `${row.event_id}:${row.part}`));
  const linkRows = (links.data ?? []) as EventRefundRow[];
  const refundIds = [...new Set(linkRows.map((row) => row.refund_id))];
  const refundsById = new Map<string, RefundRow>();
  if (refundIds.length > 0) {
    const refunds = await client.from('order_refunds').select('id, status, shipping_amount, created_at').in('id', refundIds);
    if (refunds.error) {
      throw new RefundStoreError('load_order_refunds', refunds.error);
    }
    for (const refund of (refunds.data ?? []) as RefundRow[]) refundsById.set(refund.id, refund);
  }
  const linked = (eventId: string, part: Part, failed: boolean) => linkRows.filter((row) => {
    const refund = refundsById.get(row.refund_id);
    return row.event_id === eventId && row.part === part && refund !== undefined && (refund.status === 'failed') === failed;
  });
  let amount = 0;
  const retryRefunds = new Set<string>();
  for (const row of open) {
    if (row.consult_refund > 0 && !waived.has(`${row.id}:consult`) && linked(row.id, 'consult', false).length === 0) {
      amount += row.consult_refund;
    }
    const failedNow = linked(row.id, 'now', true);
    if (failedNow.length > 0 && !waived.has(`${row.id}:now`) && linked(row.id, 'now', false).length === 0) {
      amount += row.now_refund;
      // 出来事ごとに一番新しい失敗した返金だけ（店長の最後の決め。前に失敗した返金の送料を重ねて足さない）
      retryRefunds.add(failedNow.map((link) => refundsById.get(link.refund_id)!).reduce(latestOf).id);
    }
  }
  const retryShipping = [...retryRefunds].reduce((sum, id) => sum + (refundsById.get(id)?.shipping_amount ?? 0), 0);
  return { amount, retryShipping };
}
