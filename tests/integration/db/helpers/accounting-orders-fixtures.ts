import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { seedGroupG3Slip } from './group-g3-fixtures';
import { seedHOrderUnits } from './group-h-fixtures';

// 会計の計画2（前受金・出荷の日の売上・Stripe）の DB 試験の道具。計画2の各 Task が必要な物をここへ足す。

const directory = path.join(process.cwd(), 'supabase/migrations');
const s6Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_posting_tables.sql'));
/** 計画2 S6（計上の土台の表と道具）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S6_SQL = s6Files.length === 1 ? fs.readFileSync(path.join(directory, s6Files[0]), 'utf8') : '';
export const ACCOUNTING_S6_FILES = s6Files;

/** S6 の `-- ACC_S6_<name>_BEGIN` と `-- ACC_S6_<name>_END` の間。 */
export function accountingS6Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S6_SQL.split(`-- ACC_S6_${name}_BEGIN\n`)[1]?.split(`-- ACC_S6_${name}_END`)[0] ?? '';
}

/**
 * 手を入れる前の今の状態を S6 の比べる元として控える（適用の時は空の状態）。そのあとで末尾 assert を流す。
 * 比べるのは、足したはずの無い発送の事実・新しい4表の行数・G の書き手の一覧。
 */
export async function pinAccountingS6Baseline(client: PgClient): Promise<void> {
	await client.query(`create temp table accounting_s6_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_s6_baseline(payload) select jsonb_build_object(
      'missing_slip_facts',
        (select count(*) from public.shipment_slips s where s.stage in ('confirmed', 'cancelled')
          and not exists (select 1 from public.accounting_g_slip_facts f where f.slip_id = s.id and f.kind = 'confirm'))
        + (select count(*) from public.shipment_slips s where s.stage = 'cancelled'
          and not exists (select 1 from public.accounting_g_slip_facts f where f.slip_id = s.id and f.kind = 'cancel')),
      'pending_events', (select count(*) from public.accounting_pending_events),
      'shipment_units', (select count(*) from public.accounting_shipment_units),
      'unit_refund_allocations', (select count(*) from public.accounting_unit_refund_allocations),
      'g_slip_facts', (select count(*) from public.accounting_g_slip_facts),
      'allowlist_md5', (select md5(coalesce(string_agg(w.proc::oid::text, ',' order by w.proc::oid), ''))
        from unnest(private.group_g_writer_allowlist()) as w(proc)))`);
}

/**
 * ROLLBACK の試験の中で、postgres として accounting_settings.cutover_on を前の日へ動かす（Ruling P2-M1）。
 * 設定の守り（accounting_settings_guard_update）は cutover_on の書き換えを断るので、同じ取引の中で外し、書き、
 * ENABLE ALWAYS に戻す。3つとも ROLLBACK で戻る。表を ACCESS EXCLUSIVE で ROLLBACK まで握るので、使う suite は
 * --runInBand で流し、コミットする試験と E2E では使わない。本番にこの道は無い。
 */
export async function setCutoverForTest(client: PgClient, date: string): Promise<void> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ACCOUNTING_CUTOVER_DATE_INVALID');
	const inTransaction = (await client.query(
		'select pg_catalog.statement_timestamp() <> pg_catalog.transaction_timestamp() as in_transaction')).rows[0].in_transaction as boolean;
	if (!inTransaction) throw new Error('ACCOUNTING_CUTOVER_TRANSACTION_REQUIRED');
	await client.query('alter table public.accounting_settings disable trigger accounting_settings_guard_update');
	await client.query('update public.accounting_settings set cutover_on = $1::date where id = 1', [date]);
	// The update queues the deferred end-day check of the settings; ALTER TABLE refuses while an event is pending.
	await client.query('set constraints accounting_settings_sole_end immediate');
	await client.query('set constraints accounting_settings_sole_end deferred');
	await client.query('alter table public.accounting_settings enable always trigger accounting_settings_guard_update');
}

/**
 * 着の支払額だけを持つ注文（割引の割り当ては無い）。lines の1要素が1つの品で、配列の長さが数量・要素が1着ごとの支払額。
 * 呼び出す取引は G の共通の鍵（190521,1）を先に取っておく。
 */
export async function seedUnitOrder(client: PgClient, lines: ReadonlyArray<readonly number[]>): Promise<{ orderId: string; orderItemIds: string[] }> {
	return seedHOrderUnits(client, {
		legacy: false,
		lines: lines.map((units) => ({
			itemPrice: Math.max(...units),
			quantity: units.length,
			discounts: [],
			unitAmounts: units,
		})),
	});
}

/**
 * 確定した発送票を G の表へ直接入れ、確定の事実（番号）を記録する。G の関数を通らない道なので、同じ取引の中で
 * G の鍵を取ってから事実の関数を呼ぶ（呼び出す取引が鍵を持っていること）。
 */
export async function seedFactSlip(client: PgClient, input: { orderItemId: string; quantity: number; actorId?: string }): Promise<string> {
	const slipId = await seedGroupG3Slip(client, { stage: 'confirmed', actorId: input.actorId });
	await client.query('insert into public.shipment_slip_lines(slip_id, order_item_id, quantity) values($1, $2, $3)',
		[slipId, input.orderItemId, input.quantity]);
	await recordSlipFact(client, slipId, 'confirm');
	return slipId;
}

/** 発送の事実を1つ記録して、取った番号を返す（鍵を持つ取引の中で）。 */
export async function recordSlipFact(client: PgClient, slipId: string, kind: 'confirm' | 'cancel'): Promise<number> {
	const row = (await client.query('select private.accounting_record_slip_fact($1::uuid, $2::text) as seq', [slipId, kind])).rows[0];
	return Number(row.seq);
}

/** 今の出荷済みの着（unit_index の若い順に並べた `unit:slip` の組）。asOf を渡さなければ今。 */
export async function shippedUnits(client: PgClient, orderItemId: string, asOf: number | null = null): Promise<Array<{ unit: number; slipId: string }>> {
	const result = await client.query(
		'select unit_index, slip_id from private.accounting_shipped_units($1::uuid, $2::bigint) order by unit_index', [orderItemId, asOf]);
	return result.rows.map((row) => ({ unit: Number(row.unit_index), slipId: row.slip_id as string }));
}

/** 確定した発送票を G の表へ入れるだけで、事実は記録しない（事実を入れる順を試験が決める時）。 */
export async function seedBareSlip(client: PgClient, input: { orderItemId: string; quantity: number }): Promise<string> {
	const slipId = await seedGroupG3Slip(client, { stage: 'confirmed' });
	await client.query('insert into public.shipment_slip_lines(slip_id, order_item_id, quantity) values($1, $2, $3)',
		[slipId, input.orderItemId, input.quantity]);
	return slipId;
}

/** 発送票の事実の番号（無ければ null）。 */
export async function slipFactSeq(client: PgClient, slipId: string, kind: 'confirm' | 'cancel'): Promise<number | null> {
	const row = (await client.query('select fact_seq from public.accounting_g_slip_facts where slip_id = $1 and kind = $2', [slipId, kind])).rows[0];
	return row ? Number(row.fact_seq) : null;
}

/**
 * 支払いの仕訳（計画2 Task 2）の試験の注文。lines の1要素が1つの品（price 円を quantity 着）。unitAmounts を渡すと
 * 1着ごとの支払額をその値にする（合計が注文の合計と違う例を作る）。legacy は1着ごとの支払額の行が無い旧い注文。
 * paymentIntentId を渡すと結び付ける（無ければ新しい番号）。呼び出す取引は G の共通の鍵（190521,1）を先に取っておく。
 */
export async function seedPaidOrder(client: PgClient, input: {
	lines: ReadonlyArray<{ price: number; quantity: number; unitAmounts?: readonly number[] }>;
	paymentIntentId?: string | null; paidAt?: string | null; shippingAmount?: number; status?: 'paid' | 'pending' | 'payment_in_progress';
	legacy?: boolean;
}): Promise<{ orderId: string; orderItemIds: string[]; paymentIntentId: string | null; total: number }> {
	const seeded = await seedHOrderUnits(client, {
		legacy: input.legacy ?? false,
		lines: input.lines.map((line) => ({
			itemPrice: line.price,
			quantity: line.quantity,
			discounts: [],
			unitAmounts: line.unitAmounts ?? Array.from({ length: line.quantity }, () => line.price),
		})),
		paidAt: input.paidAt,
		shippingAmount: input.shippingAmount,
		status: input.status ?? 'paid',
	});
	const paymentIntentId = input.paymentIntentId === undefined ? `pi_${randomUUID().replaceAll('-', '')}` : input.paymentIntentId;
	if (paymentIntentId !== null) {
		await client.query('update public.orders set payment_intent_id = $2 where id = $1', [seeded.orderId, paymentIntentId]);
	}
	const total = input.lines.reduce((sum, line) => sum + line.price * line.quantity, 0) + (input.shippingAmount ?? 0);
	return { orderId: seeded.orderId, orderItemIds: seeded.orderItemIds, paymentIntentId, total };
}

/**
 * Stripe の残高の取引（支払い）の行を直接入れる。orderId を渡すと取引の側にも注文を結ぶ。fee は手数料（net = amount - fee）。
 * type / reportingCategory の初期値は charge。syncedAt は Stripe の行を保存した時刻（無ければ now()）。
 */
export async function seedStripeCharge(client: PgClient, input: {
	paymentIntentId: string | null; amount: number; createdAt: string; orderId?: string | null; fee?: number;
	type?: string; reportingCategory?: string; id?: string; syncedAt?: string;
}): Promise<string> {
	const id = input.id ?? `txn_${randomUUID().replaceAll('-', '')}`;
	const fee = input.fee ?? 0;
	await client.query(
		`insert into public.stripe_balance_transactions
			(id, source_id, payment_intent_id, order_id, type, reporting_category, amount, fee, net, currency, status,
			 available_on, stripe_created_at, fee_details, raw_payload, synced_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'jpy', 'available', $10::timestamptz, $10::timestamptz, '[]'::jsonb, '{}'::jsonb,
			coalesce($11::timestamptz, now()))`,
		[id, `ch_${randomUUID().replaceAll('-', '')}`, input.paymentIntentId, input.orderId ?? null, input.type ?? 'charge',
			input.reportingCategory ?? 'charge', input.amount, fee, input.amount - fee, input.createdAt, input.syncedAt ?? null]);
	return id;
}

/** 計画2 S7（支払いの仕訳）の移行の本文。無ければ空で、原文の確かめが目に見えて落ちる。 */
const s7Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_payment_posting.sql'));
export const ACCOUNTING_S7_SQL = s7Files.length === 1 ? fs.readFileSync(path.join(directory, s7Files[0]), 'utf8') : '';
export const ACCOUNTING_S7_FILES = s7Files;

/** S7 の `-- ACC_S7_<name>_BEGIN` と `-- ACC_S7_<name>_END` の間。 */
export function accountingS7Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S7_SQL.split(`-- ACC_S7_${name}_BEGIN\n`)[1]?.split(`-- ACC_S7_${name}_END`)[0] ?? '';
}

/**
 * 手を入れる前の今の状態を S7 の比べる元として控える（適用の時は仕訳も計上待ちも0件）。そのあとで末尾 assert を流す。
 * 比べるのは、仕訳の見出し・行・計上待ちの行・会計の期間の行数。
 */
export async function pinAccountingS7Baseline(client: PgClient): Promise<void> {
	await client.query(`create temp table accounting_s7_baseline(payload jsonb) on commit drop;
		insert into pg_temp.accounting_s7_baseline(payload) select jsonb_build_object(
			'entries', (select count(*) from public.accounting_journal_entries),
			'lines', (select count(*) from public.accounting_journal_lines),
			'pending_events', (select count(*) from public.accounting_pending_events),
			'periods', (select count(*) from public.accounting_periods))`);
}
