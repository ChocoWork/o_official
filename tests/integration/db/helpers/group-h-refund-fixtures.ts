import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInTransaction } from './group-g1-fixtures';
import { acceptHCheckout, hDiscount, seedHCheckout, seedHDiscount, seedHMember } from './group-h-fixtures';
import { seedFactSlip } from './accounting-orders-fixtures';
import { createCatalogFixture, shipFixtureOrder } from './order-fixtures';
import type { PgClient } from './local-db';
import { restoreH4AllowlistSql } from './group-g-allowlist';
import { ubReceive } from './unit-binding-receive';

/** Real H3 -> H4 acceptance and payment; each payment has its own intent. */
export async function hRefundFixture(db: PgClient, shipped: boolean | number = false, quantity = 2, unitDiscount = 3000, buyerUserId?: string) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  const actor = await seedHMember(db);
  const code = `H5-${randomUUID().toUpperCase()}`;
  const catalog = await createCatalogFixture(db, { stock: quantity });
  const discountId = await seedHDiscount(db, hDiscount({ code, kind: 'repeat', value: { type: 'amount', value: unitDiscount },
    targetMode: 'include', itemIds: [catalog.itemId], minimum: { type: 'amount', value: 40000 },
    repeatInOrder: true, allowGuests: true }));
  const f = await seedHCheckout(db, { discountId, code, userId: buyerUserId, lines: [{ catalog, quantity }] });
  const accepted = await acceptHCheckout(db, f);
  if (!accepted.order_id || accepted.rejection) throw new Error('H5_ACCEPTANCE_FAILED');
  const orderId = accepted.order_id;
  // place_order_from_checkout_draft leaves the order in payment_in_progress; pay it from that state.
  const paid = (await db.query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')",
    [orderId, f.paymentIntentId, f.result.totalAmount])).rows[0];
  if (!paid?.updated) throw new Error('H5_PAYMENT_FAILED');
  const itemId = (await db.query('select id from public.order_items where order_id=$1', [orderId])).rows[0].id as string;
  const fulfillment = shipped ? await shipFixtureOrder(db, { orderId, actorId: actor,
    trackingNumber: 'H5-TEST', lines: [{ order_item_id: itemId, quantity: typeof shipped === 'number' ? shipped : quantity }] }) : null;
  // 会計の発送の事実（出荷済みの着の印）。1着ごとの値段の計画（FREQ-642）は、出荷済みの枠からだけ発送後の返品を選ぶ
  if (shipped) await seedFactSlip(db, { orderItemId: itemId, quantity: typeof shipped === 'number' ? shipped : quantity });
  return { orderId, itemId, actor, discountId, catalog, f, fulfillment };
}
export type HRefundFixture = Awaited<ReturnType<typeof hRefundFixture>>;
export async function hBegin(db: PgClient, f: HRefundFixture, amount: number, before = false, key = randomUUID(), quantity = 1) {
  return (await db.query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5)`,
    [f.orderId, key, JSON.stringify([{ order_item_id: f.itemId, before_shipment: before, quantity }]), amount, f.actor])).rows[0] as { refund_id: string; amount: number; replayed: boolean };
}
export async function hResult(db: PgClient, id: string, status: 'pending' | 'succeeded' | 'failed') {
  return (await db.query("select * from public.record_order_refund_result($1,$2,$3,null,$4,null,'card',null,null)",
    [id, `re_${id.replaceAll('-', '')}`, status, status === 'failed' ? 'lost_or_stolen_card' : null])).rows[0];
}
export async function hReturn(db: PgClient, f: HRefundFixture, quantity = 1, exchange = false) {
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222' where id=1`);
  const r = (await db.query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,'customer_ships','customer',null,null,0,0,0,0,null,false)`,
    [f.orderId, f.actor, randomUUID(), JSON.stringify([{ fulfillment_id: f.fulfillment?.fulfillment_id, order_item_id: f.itemId, quantity,
      reason: 'unknown', reason_note: null, resolution: exchange ? 'exchange' : 'refund',
      exchange_variant_id: exchange ? f.catalog.variantId : null, exchange_method: exchange ? 'make' : null }])])).rows[0];
  const lineId = (await db.query('select id from public.order_return_lines where return_id=$1', [r.return_id])).rows[0].id as string;
  return { returnId: r.return_id as string, lineId };
}
export async function hReceive(db: PgClient, f: HRefundFixture, r: Awaited<ReturnType<typeof hReturn>>, quantity = 1, choice = 'consult') {
  // 注文の時の写しのある注文（H の受け付けで作った注文）は、本物の計画を付けて受け取る（FREQ-642）
  return ubReceive(db, { returnId: r.returnId, actorId: f.actor, choice,
    units: [{ return_line_id: r.lineId, disposition: 'not_restocked', quantity }] });
}
export const hClaims = async (db: PgClient, item: string) => (await db.query(`select paid_amount,refund_id,refund_before_shipment,return_line_id
  from public.order_line_unit_amounts where order_item_id=$1 order by paid_amount,unit_index`, [item])).rows;

/** These eleven bodies change in RR; the historical H5 assertion keeps its original MD5s. */
export const H5_RETURN_FUNCTION_NAMES = Object.freeze([
  'admin_receive_return', 'return_detail_json', 'group_h_return_unit_dispositions',
  'group_h_release_return_units', 'group_h_release_completed_return_claims',
  'group_h_return_refund_slices', 'group_h_receiving_amount', 'group_h_return_amounts',
  'group_h_claim_refund_units', 'record_group_g_refund_result', 'group_h_return_refund_amount',
]);

/** Migration B (unit binding) adds unit-list overloads of two of these names; the H5 and RR assertions know only the original ones. */
const H5_ORIGINAL_ONLY = "pg_get_function_identity_arguments(p.oid) !~ 'integer\\[\\]'";
const UNIT_LIST_OVERLOADS = Object.freeze([
  'private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid)', 'private.group_h_release_return_units(uuid,integer[])',
]);

const RECEIVE_ARGS_14 = 'uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text';
const RECEIVE_ARGS_15 = `${RECEIVE_ARGS_14},jsonb`;

/**
 * 移行 RR・RD の末尾の確かめを今の DB で再生するための、取引の中だけの立て直し（巻き戻しで戻る）。移行 C（FREQ-642）が置き換えた
 * 2本を RD の時点に戻す: 14の引数の admin_receive_return（RD の本文）と、その公開の入口（G1 の本文）、RR の record_group_g_refund_result、
 * H4 の書き手の一覧の関数。ほかの RR・RD の本文は移行 C が触れていないので、そのまま。
 */
export async function installReceiveEra(client: PgClient): Promise<void> {
  const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
  const pick = (source: string, pattern: RegExp, label: string) => {
    const text = source.match(pattern)?.[0];
    if (!text) throw new Error(`RECEIVE_ERA_DEFINITION_MISSING:${label}`);
    return text;
  };
  await client.query(`drop function if exists public.admin_receive_return(${RECEIVE_ARGS_15}); drop function if exists private.admin_receive_return(${RECEIVE_ARGS_15})`);
  await client.query(pick(read('20261108063711_return_receive_unit_dedup.sql'), /^CREATE OR REPLACE FUNCTION private\.admin_receive_return\([\s\S]*?^\$\$;/m, 'rd_receive'));
  await client.query(pick(read('20261106005536_return_receive_per_item.sql'), /^CREATE OR REPLACE FUNCTION private\.record_group_g_refund_result\([\s\S]*?^\$\$;/m, 'rr_result'));
  await client.query(pick(read('20261023211425_group_g1_allocation.sql'), /^CREATE OR REPLACE FUNCTION public\.admin_receive_return\([\s\S]*?^\$\$;/m, 'g1_public'));
  for (const schema of ['private', 'public']) await client.query(`alter function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) owner to postgres;
    revoke all on function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) from public, anon, authenticated, service_role;
    grant execute on function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) to service_role`);
  await client.query(restoreH4AllowlistSql({ stub: false }));
}

/**
 * Restore only function definitions, never the H5 triggers, grants or final assertion.
 * The unit binding migration C (FREQ-642) replaced the 14 argument admin_receive_return by a 15 argument one. Inside the savepoint the
 * 15 argument pair is dropped and the H5 era pair is put back: the private body from the H5 text, the public wrapper from the G1 text,
 * both with the grants of that time, and the writer list names the 14 argument signature (rolled back with the savepoint).
 */
export async function withH5ReturnBaseline(client: PgClient, work: () => Promise<void>): Promise<void> {
  if (!(await isInTransaction(client))) throw new Error('H5_RETURN_TRANSACTION_REQUIRED');
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261029130400_group_h_discounts_refunds.sql'), 'utf8');
  const metadata = async () => (await client.query(`select p.oid,p.oid::regprocedure::text signature,p.proacl,
    p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.prorettype,p.proretset,p.pronargdefaults,p.proargnames,
    p.proargtypes::text,p.proallargtypes,p.proargmodes,p.prolang,p.proisstrict,p.proparallel,
    pg_get_expr(p.proargdefaults,0) defaults
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname=any($1::text[]) and ${H5_ORIGINAL_ONLY} order by p.oid`, [H5_RETURN_FUNCTION_NAMES])).rows;
  const before = await metadata();
  const sansReceive = (rows: Awaited<ReturnType<typeof metadata>>) => rows.filter((row) => !row.signature.includes('admin_receive_return'));
  const g1 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261023211425_group_g1_allocation.sql'), 'utf8');
  const bodyHashes = async () => (await client.query(`select p.oid,md5(replace(p.prosrc,E'\\r','')) hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname=any($1::text[]) and ${H5_ORIGINAL_ONLY} order by p.oid`, [H5_RETURN_FUNCTION_NAMES])).rows;
  const currentBodies = await bodyHashes();
  expect(before).toHaveLength(11);
  expect(before.filter((row) => row.signature.includes('admin_receive_return'))).toHaveLength(1);
  await client.query('savepoint h5_return_baseline');
  try {
    await client.query(`drop function if exists public.admin_receive_return(${RECEIVE_ARGS_15}); drop function if exists private.admin_receive_return(${RECEIVE_ARGS_15})`);
    for (const name of H5_RETURN_FUNCTION_NAMES) {
      const definition = sql.match(new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;`, 'm'))?.[0];
      if (!definition) throw new Error(`H5_RETURN_DEFINITION_MISSING:${name}`);
      await client.query(definition.replace(/^CREATE(?: OR REPLACE)? FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
    }
    const publicWrapper = g1.match(/^CREATE OR REPLACE FUNCTION public\.admin_receive_return\([\s\S]*?^\$\$;/m)?.[0];
    if (!publicWrapper) throw new Error('H5_RETURN_PUBLIC_WRAPPER_MISSING');
    await client.query(publicWrapper);
    for (const schema of ['private', 'public']) await client.query(`alter function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) owner to postgres;
      revoke all on function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) from public, anon, authenticated, service_role;
      grant execute on function ${schema}.admin_receive_return(${RECEIVE_ARGS_14}) to service_role`);
    await client.query(restoreH4AllowlistSql({ stub: false }));
    expect(sansReceive(await metadata())).toEqual(sansReceive(before));
    const bodies = (await client.query(`select p.proname,md5(replace(p.prosrc,E'\\r','')) hash
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname=any($1::text[]) and ${H5_ORIGINAL_ONLY} order by p.proname`, [H5_RETURN_FUNCTION_NAMES])).rows;
    for (const body of bodies) {
      const hash = sql.match(new RegExp(`'private\\.${body.proname}\\([^']*\\)'[^\\n]*'([a-f0-9]{32})'`))?.[1];
      expect(hash).toMatch(/^[a-f0-9]{32}$/);
      expect(body.hash).toBe(hash);
    }
    // The older assertions count functions by name, so they run without the overloads (the savepoint puts them back).
    for (const signature of UNIT_LIST_OVERLOADS) await client.query(`drop function if exists ${signature}`);
    await work();
  } finally {
    await client.query('rollback to savepoint h5_return_baseline');
    await client.query('release savepoint h5_return_baseline');
  }
  expect(await metadata()).toEqual(before);
  expect(await bodyHashes()).toEqual(currentBodies);
}
