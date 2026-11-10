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

type ConsultEventRow = { id: string; consult_refund: number };

/**
 * 返品の相談の分で、まだ返金していない額（見込みの表示用）。相談の返金（失敗以外）が付いた出来事は返したと数え、
 * 店長がその返金の額を下げても、残りとして出さない（DB は相談の返金を二度は受けない。設計 2-1）。全部返したら 0。
 * 取り消せる出来事は発送前の取り消しだけなので、返品の受け取りの出来事に取り消しは無い。
 */
export async function loadConsultOutstanding(client: UnitPricingClient, returnId: string): Promise<number> {
  const events = await client
    .from('order_unit_events')
    .select('id, consult_refund')
    .eq('return_id', returnId)
    .eq('kind', 'return_receive')
    .gt('consult_refund', 0);
  if (events.error) {
    throw new RefundStoreError('load_unit_events', events.error);
  }
  const open = (events.data ?? []) as ConsultEventRow[];
  if (open.length === 0) {
    return 0;
  }
  const links = await client
    .from('order_unit_event_refunds')
    .select('event_id, refund_id')
    .in('event_id', open.map((row) => row.id))
    .eq('part', 'consult');
  if (links.error) {
    throw new RefundStoreError('load_unit_event_refunds', links.error);
  }
  const linkRows = (links.data ?? []) as Array<{ event_id: string; refund_id: string }>;
  const refundIds = [...new Set(linkRows.map((row) => row.refund_id))];
  const live = new Set<string>();
  if (refundIds.length > 0) {
    const refunds = await client.from('order_refunds').select('id, status').in('id', refundIds);
    if (refunds.error) {
      throw new RefundStoreError('load_order_refunds', refunds.error);
    }
    for (const refund of (refunds.data ?? []) as Array<{ id: string; status: string }>) {
      if (refund.status !== 'failed') live.add(refund.id);
    }
  }
  const covered = new Set(linkRows.filter((row) => live.has(row.refund_id)).map((row) => row.event_id));
  return open.filter((row) => !covered.has(row.id)).reduce((sum, row) => sum + row.consult_refund, 0);
}
