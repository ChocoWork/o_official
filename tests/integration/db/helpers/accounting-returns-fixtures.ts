import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';
import { hBegin, hReceive, hRefundFixture, hResult, hReturn } from './group-h-refund-fixtures';

// 会計の計画3（返品・返金）の DB 試験の道具。計画3の各 Task が必要な物をここへ足す。

const directory = path.join(process.cwd(), 'supabase/migrations');
const s15Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_return_refund_tables.sql'));
/** 計画3 S15（返金・返品の事実の表と届いた日の列）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S15_SQL = s15Files.length === 1 ? fs.readFileSync(path.join(directory, s15Files[0]), 'utf8') : '';
export const ACCOUNTING_S15_FILES = s15Files;

/** S15 の `-- ACC_S15_<name>_BEGIN` と `-- ACC_S15_<name>_END` の間。 */
export function accountingS15Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S15_SQL.split(`-- ACC_S15_${name}_BEGIN\n`)[1]?.split(`-- ACC_S15_${name}_END`)[0] ?? '';
}

/** S15 が作る7つの表。 */
export const S15_TABLES = [
	'order_return_arrival_corrections', 'accounting_return_options', 'accounting_refund_events', 'accounting_refund_facts',
	'accounting_refund_transfer_adjusts', 'accounting_unit_price_adjusts', 'accounting_return_facts',
] as const;
/** そのうち追記だけの6つ（設定の表は除く）。 */
export const S15_APPEND_ONLY = S15_TABLES.filter((name) => name !== 'accounting_return_options');

/**
 * 手を入れる前の今の状態を S15 の比べる元として控える（適用の時は受け取りの行も6つの表も0件）。そのあとで末尾 assert を流す。
 * 比べるのは、受け取りの行・計上待ちの行・追記だけの6つの表の行数。
 */
export async function pinAccountingS15Baseline(client: PgClient): Promise<void> {
	await client.query(`create temp table accounting_s15_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_s15_baseline(payload) select jsonb_build_object(
      'receipts', (select count(*) from public.order_return_receipts),
      'pending_events', (select count(*) from public.accounting_pending_events),
      'arrival_corrections', (select count(*) from public.order_return_arrival_corrections),
      'refund_events', (select count(*) from public.accounting_refund_events),
      'refund_facts', (select count(*) from public.accounting_refund_facts),
      'refund_transfer_adjusts', (select count(*) from public.accounting_refund_transfer_adjusts),
      'unit_price_adjusts', (select count(*) from public.accounting_unit_price_adjusts),
      'return_facts', (select count(*) from public.accounting_return_facts))`);
}

/** G の鍵（190521,1）の中で計画2の番号を1つ取る（呼び出す取引が鍵を持っていること）。 */
export async function takeFactSeq(client: PgClient): Promise<{ seq: string; at: string }> {
	const row = (await client.query('select fact_seq::text as seq, locked_at::text as at from private.accounting_take_g_fact_seq()')).rows[0];
	return { seq: row.seq as string, at: row.at as string };
}

/**
 * 計画3の表が指す元の行をそろえる: 出荷した3着の注文（H の受け付けと支払い）、1着の返品と、その受け取り（相談）、
 * 出荷後の返金2件（1件目は成功）、交換の印の作業の出来事。呼び出す取引で G の鍵を取る（hRefundFixture が取る）。
 */
export async function seedReturnRefundParents(client: PgClient) {
	const f = await hRefundFixture(client, true, 3);
	const r = await hReturn(client, f, 1);
	await hReceive(client, f, r, 1, 'consult');
	const receiptId = (await client.query(
		"select id from public.order_return_receipts where return_id = $1 and kind = 'receive' order by created_at limit 1", [r.returnId])).rows[0].id as string;
	const refundA = (await hBegin(client, f, 1000)).refund_id;
	// A second refund starts only after the first has its Stripe result.
	await hResult(client, refundA, 'succeeded');
	const refundB = (await hBegin(client, f, 500)).refund_id;
	const eventId = (await client.query('select id from public.order_unit_events where order_id = $1 order by seq limit 1', [f.orderId])).rows[0].id as string;
	return { orderId: f.orderId, itemId: f.itemId, returnId: r.returnId, receiptId, refundIds: [refundA, refundB], eventId };
}
export type ReturnRefundParents = Awaited<ReturnType<typeof seedReturnRefundParents>>;

/** 列の名前と値から1行を入れる（postgres のまま。計画3の書く道具が来るまでの形の確かめ用）。 */
export async function insertRow(client: PgClient, table: string, values: Record<string, unknown>): Promise<void> {
	const columns = Object.keys(values);
	await client.query(`insert into public.${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
		columns.map((column) => values[column]));
}
