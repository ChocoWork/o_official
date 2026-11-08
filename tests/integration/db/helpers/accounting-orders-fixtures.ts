import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { seedGroupG3Slip } from './group-g3-fixtures';
import { withGroupG1FixtureTransaction } from './group-g1-fixtures';
import { insertAccountingAdmin } from './accounting-fixtures';
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

/** 計画2 S8（出荷の仕訳）の移行の本文。無ければ空で、原文の確かめが目に見えて落ちる。 */
const s8Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_shipment_posting.sql'));
export const ACCOUNTING_S8_SQL = s8Files.length === 1 ? fs.readFileSync(path.join(directory, s8Files[0]), 'utf8') : '';
export const ACCOUNTING_S8_FILES = s8Files;

/** S8 の `-- ACC_S8_<name>_BEGIN` と `-- ACC_S8_<name>_END` の間。BASELINE は本文（BODY）の中の比べる元の控えの文。 */
export function accountingS8Section(name: 'BODY' | 'BASELINE' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S8_SQL.split(`-- ACC_S8_${name}_BEGIN\n`)[1]?.split(`-- ACC_S8_${name}_END`)[0] ?? '';
}

/**
 * 手を入れる前の今の状態を S8 の比べる元として控える（適用の時と同じ文を流す）。そのあとで末尾 assert を流す。
 * 比べるのは、仕訳の見出し・行・計上待ち・着の記録・会計の期間の行数と、G の表・トリガー・関数の定義の指紋。
 */
export async function pinAccountingS8Baseline(client: PgClient): Promise<void> {
	await client.query(accountingS8Section('BASELINE'));
}

export type SeedSlipOrder = {
	orderId: string;
	lines: ReadonlyArray<{ orderItemId: string; quantity: number }>;
	/** 発送ごとの出荷日（無ければ発送票の出荷日）。食い違いの試験だけが使う。 */
	fulfillmentDate?: string;
};

/**
 * 確定した発送票を G の表へ直接入れる（G の関数は今日より後・支払いの日より前の出荷日を断るので通らない）。
 * 発送票1枚・注文ごとに発送1つ（旧い発送の印 legacy=true で、在庫の消費の遅延検査の対象外）・品の行・発送票の明細・
 * 出荷日の履歴（initial）・版の行を入れ、同じ取引の中で G の鍵を取って確定の事実（番号）も記録する。
 * shipmentDate の初期値は今日（日本時間）。confirmedAt は発送票を確定した時刻（初期値は今）。
 * 呼び出す取引は G の共通の鍵（190521,1）を先に取っておく（取引の外なら、この関数が取引を開いて閉じる）。
 */
export async function seedConfirmedSlip(client: PgClient, input: {
	orders: ReadonlyArray<SeedSlipOrder>; shipmentDate?: string; confirmedAt?: string; recordFact?: boolean;
}): Promise<{ slipId: string; number: string; version: number; fulfillmentIds: string[]; factSeq: number | null }> {
	return withGroupG1FixtureTransaction(client, async () => {
		const slipId = randomUUID();
		const actor = randomUUID();
		const operationId = randomUUID();
		const shipmentDate = input.shipmentDate
			?? ((await client.query("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string);
		await client.query(`insert into private.group_g_operations
			(id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
			values ($1,'shipment_slip_confirm',$2,repeat('a',64),'shipment_slip',$3,$4,'{}')`, [operationId, randomUUID(), slipId, actor]);
		const number = (await client.query(`insert into public.shipment_slips
			(id,number,stage,customer_kind,customer_email,ship_to_full_name,ship_to_postal_code,ship_to_prefecture,ship_to_city,
			 ship_to_address,ship_to_phone,draft_lines,notify_customer,shipment_date,confirm_request_key,confirm_operation_id,
			 confirmed_at,confirmed_by,created_by)
			values ($1, 'SL-29991231-' || lpad((coalesce((select max(right(number,4)::integer) from public.shipment_slips
				where number like 'SL-29991231-%'),0)+1)::text,4,'0'), 'confirmed','guest','fixture@example.invalid','Fixture',
				'0000000','Fixture','Fixture','Fixture','0000000000','[]'::jsonb,false,$2::date,$3,$4,coalesce($5::timestamptz, now()),$6,$6)
			returning number`, [slipId, shipmentDate, randomUUID(), operationId, input.confirmedAt ?? null, actor])).rows[0].number as string;
		const fulfillmentIds: string[] = [];
		const slipLines = new Map<string, number>();
		for (const order of input.orders) {
			const fulfillmentId = (await client.query(`insert into public.order_fulfillments
				(order_id,number,request_key,notify_customer,completes_order,shipped_at,created_by,legacy,shipment_date,delivery_status,delivery_status_at)
				values ($1,(select coalesce(max(number),0)+1 from public.order_fulfillments where order_id=$1),$2,false,false,now(),$3,true,
					$4::date,'confirmed',now()) returning id`,
				[order.orderId, randomUUID(), actor, order.fulfillmentDate ?? shipmentDate])).rows[0].id as string;
			fulfillmentIds.push(fulfillmentId);
			for (const line of order.lines) {
				await client.query('insert into public.order_fulfillment_lines(fulfillment_id, order_item_id, quantity) values($1,$2,$3)',
					[fulfillmentId, line.orderItemId, line.quantity]);
				slipLines.set(line.orderItemId, (slipLines.get(line.orderItemId) ?? 0) + line.quantity);
			}
			await client.query('insert into public.shipment_slip_fulfillments(slip_id, order_id, fulfillment_id) values($1,$2,$3)',
				[slipId, order.orderId, fulfillmentId]);
		}
		for (const [orderItemId, quantity] of slipLines) {
			await client.query('insert into public.shipment_slip_lines(slip_id, order_item_id, quantity) values($1,$2,$3)',
				[slipId, orderItemId, quantity]);
		}
		await client.query(`insert into public.shipment_slip_versions(slip_id,version,kind,tracking_version,shipment_date,actor_id,operation_id)
			values($1,1,'confirm',1,$2::date,$3,$4)`, [slipId, shipmentDate, actor, operationId]);
		await client.query(`insert into public.shipment_date_history(slip_id,version,kind,previous_date,new_date,actor_id,operation_id)
			values($1,1,'initial',$2::date,$2::date,$3,$4)`, [slipId, shipmentDate, actor, operationId]);
		const factSeq = input.recordFact === false ? null : await recordSlipFact(client, slipId, 'confirm');
		return { slipId, number, version: 1, fulfillmentIds, factSeq };
	});
}

/** G の関数を呼ぶ人（owner の役割は発送の権限を全部持つ）。 */
async function shippingActor(client: PgClient, actorId?: string): Promise<string> {
	return actorId ?? insertAccountingAdmin(client);
}

/** 確定した発送票を G の取り消しの関数で取り消す（取引の中。G の鍵は関数が取る）。 */
export async function cancelSlip(client: PgClient, slipId: string, input: { actorId?: string } = {}): Promise<void> {
	const actor = await shippingActor(client, input.actorId);
	const version = (await client.query('select version from public.shipment_slips where id = $1', [slipId])).rows[0].version as number;
	await client.query('select public.admin_cancel_shipment_slip($1::uuid, $2::integer, $3::uuid, $4::uuid)',
		[slipId, version, actor, randomUUID()]);
}

/**
 * 出荷日を G の直しの関数で直し、できた履歴の行の番号を返す。G は今日より後・支払いの日より前の日を断るので、
 * 日は注文の支払いの日以後・今日以前にする。
 */
export async function correctShipmentDate(client: PgClient, slipId: string, date: string,
	input: { reason?: string; actorId?: string } = {}): Promise<string> {
	const actor = await shippingActor(client, input.actorId);
	const version = (await client.query('select version from public.shipment_slips where id = $1', [slipId])).rows[0].version as number;
	await client.query('select public.admin_correct_shipment_date($1::uuid, $2::integer, $3::date, $4::text, $5::uuid, $6::uuid)',
		[slipId, version, date, input.reason ?? 'record fix', actor, randomUUID()]);
	return (await client.query(
		"select id from public.shipment_date_history where slip_id = $1 and kind = 'correction' order by version desc limit 1", [slipId])).rows[0].id as string;
}

/**
 * 支払いの仕訳まで入れた注文（計画2 Task 3 の出荷の試験の土台）。注文と Stripe の支払いを入れ、支払いの係を1回流して
 * payment_confirmed の仕訳を作る。支払いの日の初期値は 2026-06-10（日本時間の昼）で、注文の paid_at も同じ日。
 * 呼び出す取引は G の共通の鍵（190521,1）を先に取っておく。lines の1要素が1つの品。
 */
export async function seedPostedPayment(client: PgClient, input: {
	lines: ReadonlyArray<{ price: number; quantity: number; unitAmounts?: readonly number[] }>;
	createdAt?: string; fee?: number;
}): Promise<{ orderId: string; orderItemIds: string[]; paymentIntentId: string; total: number; txId: string; paymentEntryId: string }> {
	const createdAt = input.createdAt ?? '2026-06-10T03:00:00Z';
	const order = await seedPaidOrder(client, { lines: input.lines, paidAt: createdAt });
	const txId = await seedStripeCharge(client, { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt, fee: input.fee ?? 0 });
	const run = (await client.query('select private.accounting_post_payment_events(50) as r')).rows[0].r as { posted: number };
	if (run.posted < 1) throw new Error('SEED_PAYMENT_NOT_POSTED');
	const entry = (await client.query('select id from public.accounting_journal_entries where dedupe_key = $1',
		['payment_confirmed:' + order.paymentIntentId])).rows[0];
	return { orderId: order.orderId, orderItemIds: order.orderItemIds, paymentIntentId: order.paymentIntentId as string,
		total: order.total, txId, paymentEntryId: entry.id as string };
}

/**
 * ROLLBACK の試験の始めに、すでに DB にある確定済みの発送票（ほかの suite がコミットした物）を「解決済みの計上待ち」にして
 * 出荷の係の候補から外す。外さないと、全件の実行で係が見知らぬ発送票を拾い、試験の件数が合わない。取引ごと ROLLBACK で戻る。
 */
export async function setAsideExistingSlips(client: PgClient): Promise<void> {
	await client.query(`insert into public.accounting_pending_events (event_kind, source_table, source_id, reason, resolved_at)
		select 'shipment_confirmed', 'shipment_slips', s.id::text, 'no_revenue', now() from public.shipment_slips s
		where s.stage = 'confirmed' on conflict do nothing`);
}

/**
 * Stripe の残高の取引を直接入れる（手数料・税額調整・入金・入金の失敗・補充・知らない種類の試験）。支払いは seedStripeCharge。
 * amount と fee から net = amount - fee を入れる。feeDetails は Stripe の fee_details（[{amount,type,...}]）、rawPayload は
 * 元の記録（入金の失敗の取引の retried_payout_id など）、sourceId は取引の元（入金の取引・失敗の取引では入金の番号 po_…）。
 */
export async function seedStripeFee(client: PgClient, input: {
	createdAt: string; type: string; reportingCategory: string; amount: number; fee?: number; id?: string; sourceId?: string;
	feeDetails?: ReadonlyArray<Record<string, unknown>>; rawPayload?: Record<string, unknown>; paymentIntentId?: string | null;
	payoutId?: string | null; syncedAt?: string;
}): Promise<string> {
	const id = input.id ?? `txn_${randomUUID().replaceAll('-', '')}`;
	const fee = input.fee ?? 0;
	await client.query(
		`insert into public.stripe_balance_transactions
			(id, source_id, payment_intent_id, payout_id, type, reporting_category, amount, fee, net, currency, status,
			 available_on, stripe_created_at, fee_details, raw_payload, synced_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'jpy', 'available', $10::timestamptz, $10::timestamptz, $11::jsonb, $12::jsonb,
			coalesce($13::timestamptz, now()))`,
		[id, input.sourceId ?? `src_${randomUUID().replaceAll('-', '')}`, input.paymentIntentId ?? null, input.payoutId ?? null,
			input.type, input.reportingCategory, input.amount, fee, input.amount - fee, input.createdAt,
			JSON.stringify(input.feeDetails ?? []), JSON.stringify(input.rawPayload ?? {}), input.syncedAt ?? null]);
	return id;
}

/**
 * Stripe の入金（stripe_payouts）を直接入れる。paidAt は入金の取引の時刻（NULL なら入金の仕訳の日が決まらない）。
 * bankArrivalDate を渡すと、銀行の着金を確かめた印（着金日・確かめた時刻・確かめた人）を付ける（人は insertAccountingAdmin）。
 */
export async function seedStripePayout(client: PgClient, input: {
	amount: number; id?: string; status?: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled'; paidAt?: string | null;
	reconciliationStatus?: 'pending' | 'matched' | 'mismatch'; bankArrivalDate?: string | null; bankConfirmedAt?: string;
	createdAt?: string; syncedAt?: string;
}): Promise<string> {
	const id = input.id ?? `po_${randomUUID().replaceAll('-', '')}`;
	const confirmedBy = input.bankArrivalDate ? await insertAccountingAdmin(client) : null;
	await client.query(
		`insert into public.stripe_payouts
			(id, amount, currency, status, automatic, arrival_date, stripe_created_at, paid_at, reconciliation_status, reconciled_net,
			 bank_arrival_date, bank_confirmed_at, bank_confirmed_by, raw_payload, synced_at)
		 values ($1, $2, 'jpy', $3, true, null, $4::timestamptz, $5::timestamptz, $6, $2, $7::date, $8::timestamptz, $9::uuid, '{}'::jsonb,
			coalesce($10::timestamptz, now()))`,
		[id, input.amount, input.status ?? 'paid', input.createdAt ?? input.paidAt ?? '2026-06-01T00:00:00Z', input.paidAt ?? null,
			input.reconciliationStatus ?? 'matched', input.bankArrivalDate ?? null,
			input.bankArrivalDate ? (input.bankConfirmedAt ?? input.bankArrivalDate + 'T03:00:00Z') : null, confirmedBy, input.syncedAt ?? null]);
	return id;
}

/** 期間を課税にする（admin_update_accounting_period_filing。taxableFrom は期間の中の日）。 */
export async function makePeriodTaxable(client: PgClient, periodId: string, taxableFrom: string): Promise<void> {
	const actor = await insertAccountingAdmin(client);
	const version = (await client.query('select version from public.accounting_periods where id = $1', [periodId])).rows[0].version as string;
	await client.query(
		`select public.admin_update_accounting_period_filing($1::uuid, $2::uuid, 0::smallint, 0::smallint, 'taxable', $3::date, $4::bigint, gen_random_uuid())`,
		[actor, periodId, taxableFrom, version]);
}

/** 計画2 S9（Stripe の手数料・入金・照合）の移行の本文。無ければ空で、原文の確かめが目に見えて落ちる。 */
const s9Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_stripe_posting.sql'));
export const ACCOUNTING_S9_SQL = s9Files.length === 1 ? fs.readFileSync(path.join(directory, s9Files[0]), 'utf8') : '';
export const ACCOUNTING_S9_FILES = s9Files;

/** S9 の `-- ACC_S9_<name>_BEGIN` と `-- ACC_S9_<name>_END` の間。CATEGORY_MAP は本文（BODY）の中の種類の対応の関数。 */
export function accountingS9Section(name: 'BODY' | 'FINAL_ASSERT' | 'CATEGORY_MAP'): string {
	return ACCOUNTING_S9_SQL.split(`-- ACC_S9_${name}_BEGIN\n`)[1]?.split(`-- ACC_S9_${name}_END`)[0] ?? '';
}

/**
 * 手を入れる前の今の状態を S9 の比べる元として控える（適用の時は仕訳も計上待ちも請求書の記録も0件）。そのあとで末尾 assert を流す。
 * 比べるのは、仕訳の見出し・行・計上待ちの行・会計の期間・請求書の記録の行数。
 */
export async function pinAccountingS9Baseline(client: PgClient): Promise<void> {
	await client.query(`create temp table accounting_s9_baseline(payload jsonb) on commit drop;
		insert into pg_temp.accounting_s9_baseline(payload) select jsonb_build_object(
			'entries', (select count(*) from public.accounting_journal_entries),
			'lines', (select count(*) from public.accounting_journal_lines),
			'pending_events', (select count(*) from public.accounting_pending_events),
			'periods', (select count(*) from public.accounting_periods),
			'invoice_records', (select count(*) from public.accounting_stripe_invoice_records))`);
}

/** 計画2 S10（カード会社からの支払いの取り消しの受け取り）の移行の本文。無ければ空で、原文の確かめが目に見えて落ちる。 */
const s10Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_dispute_intake.sql'));
export const ACCOUNTING_S10_SQL = s10Files.length === 1 ? fs.readFileSync(path.join(directory, s10Files[0]), 'utf8') : '';
export const ACCOUNTING_S10_FILES = s10Files;

/** S10 の `-- ACC_S10_<name>_BEGIN` と `-- ACC_S10_<name>_END` の間。 */
export function accountingS10Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S10_SQL.split(`-- ACC_S10_${name}_BEGIN\n`)[1]?.split(`-- ACC_S10_${name}_END`)[0] ?? '';
}

/**
 * 手を入れる前の今の状態を S10 の比べる元として控える（適用の時は仕訳も計上待ちも dispute の表も0件）。そのあとで末尾 assert を流す。
 * 比べるのは、仕訳の見出し・行・計上待ちの行・会計の期間・dispute と履歴の行数。
 */
export async function pinAccountingS10Baseline(client: PgClient): Promise<void> {
	await client.query(`create temp table accounting_s10_baseline(payload jsonb) on commit drop;
		insert into pg_temp.accounting_s10_baseline(payload) select jsonb_build_object(
			'entries', (select count(*) from public.accounting_journal_entries),
			'lines', (select count(*) from public.accounting_journal_lines),
			'pending_events', (select count(*) from public.accounting_pending_events),
			'periods', (select count(*) from public.accounting_periods),
			'disputes', (select count(*) from public.stripe_disputes),
			'dispute_events', (select count(*) from public.stripe_dispute_events))`);
}

/** Stripe の dispute の写し（record_stripe_dispute の _dispute と _event の形）。 */
export function disputeFixture(overrides: { dispute?: Record<string, unknown>; event?: Record<string, unknown> | null } = {}) {
	const id = `dp_${randomUUID().replaceAll('-', '')}`;
	const dispute = {
		id, payment_intent_id: `pi_${randomUUID().replaceAll('-', '')}`, charge_id: `ch_${randomUUID().replaceAll('-', '')}`,
		order_id: null, amount: 5000, currency: 'jpy', reason: 'fraudulent', status: 'needs_response', is_charge_refundable: false,
		evidence_due_by: '2026-07-01T00:00:00Z', evidence_details: { has_evidence: false, past_due: false, submission_count: 0 },
		stripe_created_at: '2026-06-10T00:00:00Z', ...overrides.dispute,
	};
	const event = overrides.event === null ? null : {
		stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`, event_type: 'charge.dispute.created', status: dispute.status,
		occurred_at: '2026-06-10T00:05:00Z', stripe_event_created_at: null, balance_transaction_ids: [`txn_${randomUUID().replaceAll('-', '')}`],
		raw_payload: { id, reason: dispute.reason, evidence_details: dispute.evidence_details, evidence: { customer_name: 'fixture' } },
		...overrides.event,
	};
	return { dispute, event };
}
