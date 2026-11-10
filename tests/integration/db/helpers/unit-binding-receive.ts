import { randomUUID } from 'node:crypto';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import type {
  ReturnSide, SlotKey, UnitPricingMaterials, UnitPricingPlan, UnitReturnInput,
} from '@/lib/orders/unit-pricing/unit-pricing-types';
import type { PgClient } from './local-db';

/**
 * 受け取りの値段の計画（FREQ-642）を、サーバー（Task 7）と同じ決まりで本物の planUnitEvent から作る DB 試験の道具。
 * 返品の行の解決（交換・返金・上書き）から返す枠の依頼を作り、交換に出す枠は DB の結びの選び方
 * （FREQ-641 の return_line_id がその行の枠を先に、次に注文の行・unit_index の順）で excludedSlots に入れる。
 */
export type ReceiveUnit = { return_line_id: string; disposition: string; quantity: number; refund_choice?: 'now' | 'consult' | null };
export type ReceiveInput = {
  returnId: string; actorId: string; units: ReceiveUnit[]; choice: string;
  can?: boolean; key?: string; amount?: number | null; shipping?: number; notify?: boolean;
  overrides?: { return_line_id: string; action: string }[];
  /** 返品の行ごとの割引の扱いを理由の初めの値から変える（行の id → 扱い） */
  sides?: Record<string, ReturnSide>;
  sentBackMessage?: string | null;
};

const SHOP_REASONS = new Set(['defective', 'wrong_item']);

export async function materialsOf(db: PgClient, orderId: string): Promise<UnitPricingMaterials | null> {
  return (await db.query('select private.order_unit_pricing_materials($1) as j', [orderId])).rows[0].j as UnitPricingMaterials | null;
}

/** 写しの無い注文は null（計画を作らない）。 */
export async function buildReceivePricing(db: PgClient, input: ReceiveInput): Promise<UnitPricingPlan | null> {
  const header = (await db.query('select order_id, restocking_fee_percent from public.order_returns where id=$1', [input.returnId])).rows[0];
  const materials = await materialsOf(db, header.order_id as string);
  if (!materials) return null;
  const lines = (await db.query('select id, order_item_id, resolution, reason from public.order_return_lines where return_id=$1', [input.returnId])).rows;
  const byId = new Map(lines.map(l => [l.id as string, l]));
  const overrides = new Map((input.overrides ?? []).map(o => [o.return_line_id, o.action]));
  const returns = new Map<string, UnitReturnInput>();
  const exchanges: { lineId: string; holder: string; quantity: number }[] = [];
  for (const u of input.units) {
    const line = byId.get(u.return_line_id);
    if (!line || u.disposition === 'sent_back') continue;
    const asRefund = line.resolution === 'refund' || overrides.get(line.id) === 'refund';
    if (!asRefund) { exchanges.push({ lineId: line.id, holder: line.order_item_id, quantity: u.quantity }); continue; }
    const part = u.refund_choice ?? (input.choice === 'now' || input.choice === 'consult' ? input.choice : null);
    if (!part) continue;
    const side: ReturnSide = input.sides?.[line.id] ?? (overrides.get(line.id) === 'refund' || SHOP_REASONS.has(line.reason) ? 'shop' : 'customer');
    const key = `${line.id}:${part}`;
    const existing = returns.get(key);
    if (existing) { existing.quantity += u.quantity; continue; }
    returns.set(key, { returnLineId: line.id, holderOrderItemId: line.order_item_id, quantity: u.quantity, side, part,
      feePercent: side === 'customer' ? Number(header.restocking_fee_percent) : 0 });
  }
  // 交換に出す枠: DB の結びの選び方と同じ（取り押さえ済みの枠を先に、次に安い枠、次に注文の行・unit_index）
  const taken = new Set<SlotKey>();
  const excludedSlots: SlotKey[] = [];
  for (const ex of [...exchanges].sort((a, b) => (a.lineId < b.lineId ? -1 : 1))) {
    const pool = materials.target.slots.filter(s => s.state === 'kept' && s.holderOrderItemId === ex.holder && !taken.has(`${s.orderItemId}:${s.unitIndex}`))
      .sort((a, b) => Number(b.claimedReturnLineId === ex.lineId) - Number(a.claimedReturnLineId === ex.lineId)
        || a.currentPrice - b.currentPrice || (a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0) || a.unitIndex - b.unitIndex);
    for (const s of pool.slice(0, ex.quantity)) { const key: SlotKey = `${s.orderItemId}:${s.unitIndex}`; taken.add(key); excludedSlots.push(key); }
  }
  // 交換に出した枠（持ち主が交換の品の着）の FREQ-641 の取り押さえは、その交換の返品の行の物。計画は他の返品の行の取り押さえがある枠を
  // 選ばないので、交換の品の返品を計画する時は、交換に出した枠の取り押さえを無いものとして渡す（DB が返金を結ぶ時に外す）
  const forPlan: UnitPricingMaterials = { ...materials, target: { ...materials.target, slots: materials.target.slots.map(s =>
    (s.holderOrderItemId !== s.orderItemId || s.holderUnitIndex !== s.unitIndex ? { ...s, claimedReturnLineId: null } : s)) } };
  return planUnitEvent(forPlan, { kind: 'return_receive', returns: [...returns.values()], excludedSlots });
}

/** public.admin_receive_return を15の引数で呼ぶ。pricing を省くと本物の計画を作って渡す。null を渡すと NULL のまま。 */
export async function ubReceive(db: PgClient, input: ReceiveInput, pricing?: unknown) {
  const plan = pricing === undefined ? await buildReceivePricing(db, input) : pricing;
  // 移行 C より前の入口（15の引数が無い）を、H5 の確かめの再生（withH5ReturnBaseline）が取引の中に立てている時は、14の引数で呼ぶ
  const has15 = (await db.query(`select to_regprocedure('public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)') is not null as ok`)).rows[0].ok as boolean;
  if (!has15) {
    return (await db.query(`select * from public.admin_receive_return($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,null,$10,$11,null,null)`,
      [input.returnId, input.actorId, input.can ?? true, input.key ?? randomUUID(), JSON.stringify(input.units),
        JSON.stringify(input.overrides ?? []), input.choice, input.amount ?? null, input.shipping ?? 0, input.notify ?? false,
        input.sentBackMessage ?? null])).rows[0];
  }
  return (await db.query(`select * from public.admin_receive_return($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,null,$10,$11,null,null,$12::jsonb)`,
    [input.returnId, input.actorId, input.can ?? true, input.key ?? randomUUID(), JSON.stringify(input.units),
      JSON.stringify(input.overrides ?? []), input.choice, input.amount ?? null, input.shipping ?? 0, input.notify ?? false,
      input.sentBackMessage ?? null, plan === null ? null : JSON.stringify(plan)])).rows[0];
}

/** 返品を1件作って承認する（行ごとに数量・交換か返金か・理由）。FREQ-641 の取り押さえは承認が付ける。 */
export async function createUbReturn(db: PgClient, f: { orderId: string; itemId: string; actor: string; fulfillment: { fulfillment_id?: string } | null; catalog: { variantId: number } },
  groups: { quantity: number; exchange?: boolean; reason?: string; itemId?: string }[], o: { percent?: number; fixed?: number; itemId?: string } = {}) {
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222',restocking_fee_enabled=true,exchange_fees_enabled=true where id=1`);
  const number = Number((await db.query('select coalesce(max(number),0)+1 as n from public.order_returns where order_id=$1', [f.orderId])).rows[0].n);
  const returnId = (await db.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,$2,'customer_request','requested',$3,'ub-fixture',now(),$4,'customer_ships','customer',false) returning id`,
  [f.orderId, number, randomUUID(), f.actor])).rows[0].id as string;
  const lineIds = groups.map(() => randomUUID()).sort();
  for (const [i, g] of groups.entries()) {
    await db.query(`insert into public.order_return_lines
      (id,return_id,fulfillment_id,order_item_id,quantity,reason,requested_resolution,requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,$9)`,
    [lineIds[i], returnId, f.fulfillment?.fulfillment_id, g.itemId ?? f.itemId, g.quantity, g.reason ?? 'unknown',
      g.exchange ? 'exchange' : 'refund', g.exchange ? f.catalog.variantId : null, g.exchange ? 'make' : null]);
  }
  const approval = groups.map((g, i) => ({ return_line_id: lineIds[i], resolution: g.exchange ? 'exchange' : 'refund',
    exchange_variant_id: g.exchange ? f.catalog.variantId : null, exchange_method: g.exchange ? 'make' : null }));
  await db.query(`select * from public.admin_approve_return($1,$2,$3::jsonb,$4,'customer',null,null,$5,$6,0,0,null,false)`,
    [returnId, f.actor, JSON.stringify(approval), o.fixed ? 'shop_label' : 'customer_ships', o.fixed ?? 0, o.percent ?? 0]);
  return { returnId, lineIds };
}
