import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';
import { randomUUID } from 'node:crypto';
import { addDisputeHistory, seedConfirmedSlip, seedDispute, seedDisputeReversal, seedFactSlip, seedStripeCharge, seedStripeFee, seedUnitOrder } from './accounting-orders-fixtures';
import { insertAccountingAdmin } from './accounting-fixtures';
import { cancelPlanFor, hBegin, hReceive, hRefundFixture, hResult, hReturn } from './group-h-refund-fixtures';
import { createUbReturn, ubReceive, type ReceiveInput, type ReceiveUnit } from './unit-binding-receive';
import { addItemVariant, createCatalogFixture, shipFixtureOrder } from './order-fixtures';
import { attachGroupG3SlipShipment, seedGroupG3Slip } from './group-g3-fixtures';
import { acceptHCheckout, hDiscount, seedHCheckout, seedHDiscount, seedHMember } from './group-h-fixtures';

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

const s16Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_return_fee_lock.sql'));
/** 計画3 S16（返送料・交換の手数料・交換の送料を0に止める）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S16_SQL = s16Files.length === 1 ? fs.readFileSync(path.join(directory, s16Files[0]), 'utf8') : '';
export const ACCOUNTING_S16_FILES = s16Files;

/** S16 の `-- ACC_S16_<name>_BEGIN` と `-- ACC_S16_<name>_END` の間。 */
export function accountingS16Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S16_SQL.split(`-- ACC_S16_${name}_BEGIN\n`)[1]?.split(`-- ACC_S16_${name}_END`)[0] ?? '';
}

const s17Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_refund_writers.sql'));
/** 計画3 S17（返金の関数に事実を残す）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S17_SQL = s17Files.length === 1 ? fs.readFileSync(path.join(directory, s17Files[0]), 'utf8') : '';
export const ACCOUNTING_S17_FILES = s17Files;

/** S17 の `-- ACC_S17_<name>_BEGIN` と `-- ACC_S17_<name>_END` の間。 */
export function accountingS17Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S17_SQL.split(`-- ACC_S17_${name}_BEGIN\n`)[1]?.split(`-- ACC_S17_${name}_END`)[0] ?? '';
}

/** S17 が作り直した関数のうち、前の移行の末尾の確かめを再生する試験が戻す物と、その前の定義を持つ移行。 */
const PRE_S17_SOURCES = {
	core: ['_unit_binding_refund_retry.sql', 'begin_order_refund_core'],
	shippedSlots: ['_unit_binding_schema.sql', 'order_unit_shipped_slots'],
	groupGResult: ['_unit_binding_receive.sql', 'record_group_g_refund_result'],
	// 計画3 S18 が作り直した（X4 の本文に決定の事実の囲みを足した）。前の移行の確かめを再生する時は X4 の本文に戻す
	refundReturn: ['_unit_binding_refund_retry.sql', 'admin_refund_return'],
} as const;

/**
 * 前の移行の末尾の確かめを再生する時に、S17 が作り直した関数を S17 の前の本文に戻す（呼ぶ側の savepoint の中で。巻き戻しで S17 の本文に戻る）。
 * 名前・引数・属性・ACL は変わらない（CREATE OR REPLACE）。
 */
export async function restorePreS17Bodies(client: PgClient, keys: Array<keyof typeof PRE_S17_SOURCES>): Promise<void> {
	for (const key of keys) {
		const [suffix, name] = PRE_S17_SOURCES[key];
		const file = fs.readdirSync(directory).find((entry) => entry.endsWith(suffix));
		if (!file) throw new Error(`PRE_S17_SOURCE_MISSING:${key}`);
		const source = fs.readFileSync(path.join(directory, file), 'utf8');
		const definition = source.match(new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;`, 'm'))?.[0];
		if (!definition) throw new Error(`PRE_S17_DEFINITION_MISSING:${key}`);
		await client.query(definition.replace(/^CREATE(?: OR REPLACE)? FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
	}
}

/** S17 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS17Baseline(client: PgClient): Promise<void> {
	const pin = accountingS17Section('BODY').split('\nCREATE OR REPLACE FUNCTION')[0];
	await client.query('drop table if exists pg_temp.accounting_s17_baseline');
	await client.query(pin);
}

/**
 * 定額の手数料（返送料・交換の手数料・交換の送料）の働きそのものを題にする試験だけが使う（裁定 P3-D5・P3-D8）。
 * 呼ぶ取引の中で savepoint を置き、S16 の CHECK（acc_p3_fee_lock_*）を外して work を流し、終わりに savepoint まで戻す
 * （外した制約も work の行も残らない）。期待は work の中で確かめる。
 */
export async function withoutReturnFeeLock(client: PgClient, work: () => Promise<void>): Promise<void> {
	await client.query('savepoint acc_p3_fee_lock_off');
	try {
		await client.query(`alter table public.shop_return_settings drop constraint acc_p3_fee_lock_settings;
      alter table public.order_returns drop constraint acc_p3_fee_lock_returns`);
		await work();
	} finally {
		await client.query('rollback to savepoint acc_p3_fee_lock_off');
		await client.query('release savepoint acc_p3_fee_lock_off');
	}
}

/**
 * 別の接続やコミットした材料で定額の手数料の働きを確かめる試験だけが使う（裁定 P3-D5 の「同じ働きの形」）。savepoint では
 * 他の接続から外した制約が見えないので、S16 の CHECK をコミットして外す。足し直しは restoreReturnFeeLock で必ず行う。
 */
export async function dropReturnFeeLockCommitted(client: PgClient): Promise<void> {
	await client.query(`alter table public.shop_return_settings drop constraint if exists acc_p3_fee_lock_settings;
    alter table public.order_returns drop constraint if exists acc_p3_fee_lock_returns`);
}

/** S16 の本文をそのまま流し、外した2つの制約を同じ定義で足し直す（返品の行は NOT VALID なので、コミットした手数料の行は残せる）。 */
export async function restoreReturnFeeLock(client: PgClient): Promise<void> {
	await client.query(accountingS16Section('BODY'));
}

/**
 * S16 の2つの制約のどちらかが無ければ、両方を外して足し直す。コミットして外す試験の後片付けの最後の守り
 * （外した後に接続や試験が落ちても、次の試験・E2E に外れたままの DB を残さない）。
 */
export async function restoreReturnFeeLockIfMissing(client: PgClient): Promise<void> {
	const present = Number((await client.query(`select count(*)::int as n from pg_catalog.pg_constraint
    where conname in ('acc_p3_fee_lock_settings', 'acc_p3_fee_lock_returns')`)).rows[0].n);
	if (present === 2) return;
	await dropReturnFeeLockCommitted(client);
	await restoreReturnFeeLock(client);
}

/** dropReturnFeeLockCommitted → work → restoreReturnFeeLock（work が失敗しても足し直す）。 */
export async function withoutReturnFeeLockCommitted(client: PgClient, work: () => Promise<void>): Promise<void> {
	await dropReturnFeeLockCommitted(client);
	try {
		await work();
	} finally {
		await restoreReturnFeeLock(client);
	}
}

// ---- Task 3（S17。返金の書き手）の道具 ----

/** 返金の流れの土台: H の受け付けと支払いで作った 20,000円と17,000円の2着の注文（写しあり）。shipped が数なら、その数だけ発送する。 */
export async function seedRefundFlow(client: PgClient, shipped: boolean | number = false, quantity = 2) {
	return hRefundFixture(client, shipped, quantity);
}

/** 交換の印の作業の関数（begin_order_refund に値段の計画を付ける）で、発送前の取り消しの出来事と返金を作る。 */
export async function seedPreShipmentCancel(client: PgClient, f: { orderId: string; actor: string }, input: {
	itemId: string; quantity: number; amount?: number | null; source?: 'admin' | 'order_cancel'; key?: string;
}): Promise<{ refundId: string; eventId: string; amount: number }> {
	const plan = await cancelPlanFor(client, f.orderId, input.itemId, input.quantity);
	if (!plan) throw new Error('SEED_PRE_SHIPMENT_CANCEL_NO_SNAPSHOT');
	const source = input.source ?? 'admin';
	const lines = source === 'admin' ? [{ order_item_id: input.itemId, before_shipment: true, quantity: input.quantity }] : [];
	const row = (await client.query(`select * from public.begin_order_refund($1,$2,$3,$4::jsonb,false,$5,$6,null,'requested_by_customer',$7,false,$8,null,$9::jsonb)`,
		[f.orderId, source, input.key ?? randomUUID(), JSON.stringify(lines), source === 'admin' ? 0 : null,
			input.amount === undefined ? (source === 'admin' ? plan.standardRefund : null) : input.amount,
			source === 'order_cancel' ? 'customer_request' : null, f.actor, JSON.stringify(plan)])).rows[0] as { refund_id: string; amount: number };
	const eventId = (await client.query('select event_id from public.order_unit_event_refunds where refund_id = $1', [row.refund_id])).rows[0].event_id as string;
	return { refundId: row.refund_id, eventId, amount: row.amount };
}

/** Stripe の返金と残高の取引を直接入れる（failure なら失敗の戻りの取引も）。 */
export async function seedStripeRefundTxn(client: PgClient, input: {
	orderId: string; stripeRefundId: string; amount: number; status?: string; failure?: boolean; paymentIntentId?: string;
}): Promise<{ txnId: string; failureTxnId: string | null }> {
	const txnId = `txn_${randomUUID().replaceAll('-', '')}`;
	const failureTxnId = input.failure ? `txn_${randomUUID().replaceAll('-', '')}` : null;
	const pi = input.paymentIntentId ?? `pi_${randomUUID().replaceAll('-', '')}`;
	for (const [id, amount, category] of [[txnId, -input.amount, 'refund'], ...(failureTxnId ? [[failureTxnId, input.amount, 'refund_failure']] : [])] as Array<[string, number, string]>) {
		await client.query(`insert into public.stripe_balance_transactions (id, source_id, payment_intent_id, order_id, type, reporting_category, amount,
			fee, net, currency, status, stripe_created_at, raw_payload) values ($1,$2,$3,$4,$5,$5,$6,0,$6,'jpy','available',now(),'{}'::jsonb)`,
			[id, input.stripeRefundId, pi, input.orderId, category, amount]);
	}
	await client.query(`insert into public.stripe_refunds (id, payment_intent_id, order_id, amount, currency, status, balance_transaction_id,
		failure_balance_transaction_id, stripe_created_at, raw_payload) values ($1,$2,$3,$4,'jpy',$5,$6,$7,now(),'{}'::jsonb)`,
		[input.stripeRefundId, pi, input.orderId, input.amount, input.status ?? (input.failure ? 'failed' : 'succeeded'), txnId, failureTxnId]);
	return { txnId, failureTxnId };
}

/** 注文に判断待ちの支払いの取り消し（needs_response、引かれた残高の取引あり）を置く。 */
export async function seedDisputeHold(client: PgClient, orderId: string, amount = 5000): Promise<string> {
	return (await seedDispute(client, { orderId, amount, withdrawnAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' })).disputeId;
}

// ---- Task 4（S18。返品の受け取り・返金の決定の事実と届いた日）の道具 ----

const s18Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_return_writers.sql'));
/** 計画3 S18（返品の書き手）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S18_SQL = s18Files.length === 1 ? fs.readFileSync(path.join(directory, s18Files[0]), 'utf8') : '';
export const ACCOUNTING_S18_FILES = s18Files;

/** S18 の `-- ACC_S18_<name>_BEGIN` と `-- ACC_S18_<name>_END` の間。 */
export function accountingS18Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S18_SQL.split(`-- ACC_S18_${name}_BEGIN\n`)[1]?.split(`-- ACC_S18_${name}_END`)[0] ?? '';
}

const RECEIVE_ARGS_16 = 'uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean';

/**
 * 前の移行（交換の印の作業の移行 D など）の末尾の確かめを再生する時に、S18 が作り直した受け取りの関数と G の書き手の一覧を
 * S18 の前の形に戻す（呼ぶ側の savepoint の中で。巻き戻しで S18 の形に戻る）: 17の引数の受け取りの組を DROP し、移行 D の16の引数の本体と
 * 移行 C の公開の入口を同じ ACL で立て、移行 D の書き手の一覧の本文を戻す（一覧は16の引数の署名を名指すので、受け取りを先に立てる）。
 */
export async function restorePreS18Receive(client: PgClient, options: { dropNew?: boolean } = {}): Promise<void> {
	const read = (suffix: string) => {
		const file = fs.readdirSync(directory).find((entry) => entry.endsWith(suffix));
		if (!file) throw new Error(`PRE_S18_SOURCE_MISSING:${suffix}`);
		return fs.readFileSync(path.join(directory, file), 'utf8');
	};
	const pick = (source: string, pattern: RegExp, label: string) => {
		const text = source.match(pattern)?.[0];
		if (!text) throw new Error(`PRE_S18_DEFINITION_MISSING:${label}`);
		return text;
	};
	const d = read('_unit_binding_refunds.sql');
	// dropNew が偽なら17の引数の組を残す（S18 の末尾の確かめを再生する時。S18 の前の状態に16の引数の組を並べて控えを取る）
	if (options.dropNew ?? true) await client.query(`drop function if exists public.admin_receive_return(${RECEIVE_ARGS_16},date);
    drop function if exists private.admin_receive_return(${RECEIVE_ARGS_16},date)`);
	await client.query(pick(d, /^CREATE OR REPLACE FUNCTION private\.admin_receive_return\([\s\S]*?^\$\$;/m, 'receive'));
	// 17の引数の組を残す時、C の public の本文（SQL）は作る時の検査で private の16と17（既定あり）の呼び分けが付かず落ちるので、検査を切って作る
	const prior = (await client.query("select current_setting('check_function_bodies') v")).rows[0].v as string;
	await client.query("select set_config('check_function_bodies', 'off', true)");
	await client.query(pick(read('_unit_binding_receive.sql'), /^CREATE OR REPLACE FUNCTION public\.admin_receive_return\([\s\S]*?^\$\$;/m, 'receive_public'));
	await client.query("select set_config('check_function_bodies', $1, true)", [prior]);
	for (const schema of ['private', 'public']) await client.query(`alter function ${schema}.admin_receive_return(${RECEIVE_ARGS_16}) owner to postgres;
    revoke all on function ${schema}.admin_receive_return(${RECEIVE_ARGS_16}) from public, anon, authenticated, service_role;
    grant execute on function ${schema}.admin_receive_return(${RECEIVE_ARGS_16}) to service_role`);
	await client.query(pick(d, /^CREATE OR REPLACE FUNCTION private\.group_g_writer_allowlist\(\)[\s\S]*?^\$\$;/m, 'allowlist'));
}

/** S18 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS18Baseline(client: PgClient): Promise<void> {
	const pin = accountingS18Section('BODY').split('\n-- 1. Tools')[0];
	await client.query('drop table if exists pg_temp.accounting_s18_baseline');
	await client.query(pin);
}

// ---- Task 5（S19。発送票の確定を判断待ちの注文で止める）の道具 ----

const s19Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_shipment_hold_guard.sql'));
/** 計画3 S19（発送票の確定の止め）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S19_SQL = s19Files.length === 1 ? fs.readFileSync(path.join(directory, s19Files[0]), 'utf8') : '';
export const ACCOUNTING_S19_FILES = s19Files;

/** S19 の `-- ACC_S19_<name>_BEGIN` と `-- ACC_S19_<name>_END` の間。 */
export function accountingS19Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S19_SQL.split(`-- ACC_S19_${name}_BEGIN\n`)[1]?.split(`-- ACC_S19_${name}_END`)[0] ?? '';
}

/** S19 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS19Baseline(client: PgClient): Promise<void> {
	const pin = accountingS19Section('BODY').split('\n-- 1. The confirm function')[0];
	await client.query('drop table if exists pg_temp.accounting_s19_baseline');
	await client.query(pin);
}

/** 写しの無い注文にする（道具で作った注文の order_discount_snapshots の行を消す。P3-C7・P3-D3 の試験と同じ形）。 */
export async function dropDiscountSnapshot(client: PgClient, orderId: string): Promise<void> {
	// 守りは ENABLE ALWAYS（移行 A の確かめが見る）なので、外した1本を ALWAYS で戻す（コミットする並行の試験でも形が残らない）
	await client.query('alter table public.order_discount_snapshots disable trigger ub_order_discount_snapshots_immutable');
	await client.query('delete from public.order_discount_snapshots where order_id=$1', [orderId]);
	await client.query('alter table public.order_discount_snapshots enable always trigger ub_order_discount_snapshots_immutable');
}

/**
 * 返品の流れの土台: H の受け付けと支払いで作った2着（既定は 20,000円と18,750円）の注文を出荷し、返品を申し込み、承認する（割合の手数料。既定 10%）。
 * snapshot を false にすると写しの無い注文で作る。groups は返品の行（既定は1着の返金）。
 */
export async function seedReturnFlow(client: PgClient, o: {
	quantity?: number; unitDiscount?: number; percent?: number; snapshot?: boolean;
	groups?: { quantity: number; exchange?: boolean; reason?: string }[];
} = {}) {
	const f = await hRefundFixture(client, true, o.quantity ?? 2, o.unitDiscount ?? 1250);
	if (o.snapshot === false) await dropDiscountSnapshot(client, f.orderId);
	const ret = await createUbReturn(client, f, o.groups ?? [{ quantity: 1 }], { percent: o.percent ?? 10 });
	return { f, returnId: ret.returnId, lineIds: ret.lineIds };
}
export type ReturnFlow = Awaited<ReturnType<typeof seedReturnFlow>>;

export type ReceiveResult = {
	receipt_id: string; return_status: string; refund_id: string | null; refund_amount: number | null; refund_status: string | null;
	fee_due_amount: number; replayed: boolean; release_refund_ids: string[];
};

/** 返品の流れの受け取り（public.admin_receive_return の17の引数。写しのある注文は本物の値段の計画を付ける）。 */
export async function receiveReturn(client: PgClient, flow: ReturnFlow, input: Partial<ReceiveInput> & { units: ReceiveUnit[]; choice: string },
	pricing?: unknown): Promise<ReceiveResult> {
	return ubReceive(client, { returnId: flow.returnId, actorId: flow.f.actor, ...input }, pricing) as Promise<ReceiveResult>;
}

export type ReturnFact = {
	seq: number; kind: 'arrival' | 'decision'; receipt_id: string | null; refund_id: string | null; goods_amount: number; fee_amount: number;
	covers_amount: number | null; decided_amount: number | null; payable_delta: number | null; decided_on: string | null;
};

/** 返品の事実（seq の順）。 */
export async function returnFacts(client: PgClient, returnId: string): Promise<ReturnFact[]> {
	return (await client.query(`select seq, kind, receipt_id, refund_id, goods_amount, fee_amount, covers_amount, decided_amount,
    payable_delta, decided_on::text as decided_on from public.accounting_return_facts where return_id=$1 order by seq`, [returnId])).rows as ReturnFact[];
}

/**
 * 返品の未払金（2130 return_refund）の残り: 届いた日の G − F の和 ＋ 決定の差の和 − 成功しなかった返金を除く返金の決定額の和
 * （計上係〔Task 7〕の前に、事実だけから決定の関数と同じ式で読む。0未満もそのまま返す）。
 */
export async function returnPayable(client: PgClient, returnId: string): Promise<number> {
	return Number((await client.query(`select
      coalesce((select sum(goods_amount - fee_amount) from public.accounting_return_facts where return_id=$1 and kind='arrival'),0)
      + coalesce((select sum(payable_delta) from public.accounting_return_facts where return_id=$1 and kind='decision'),0)
      - coalesce((select sum(f.decided_amount) from public.accounting_return_facts f join public.order_refunds r on r.id=f.refund_id
          where f.return_id=$1 and f.kind='decision' and not (r.status='failed' or (r.status='canceled' and exists (
            select 1 from public.accounting_refund_events x where x.refund_id=r.id and x.state='abandoned')))),0) as n`, [returnId])).rows[0].n);
}

// ---- Task 6（S20。返金の仕訳・振込・結び）の道具 ----

const s20Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_refund_posting.sql'));
/** 計画3 S20（返金の仕訳）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S20_SQL = s20Files.length === 1 ? fs.readFileSync(path.join(directory, s20Files[0]), 'utf8') : '';
export const ACCOUNTING_S20_FILES = s20Files;

/** S20 の `-- ACC_S20_<name>_BEGIN` と `-- ACC_S20_<name>_END` の間。 */
export function accountingS20Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S20_SQL.split(`-- ACC_S20_${name}_BEGIN\n`)[1]?.split(`-- ACC_S20_${name}_END`)[0] ?? '';
}

/** S20 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS20Baseline(client: PgClient): Promise<void> {
	const pin = accountingS20Section('BODY').split('\n-- 1. The settle rows')[0];
	await client.query('drop table if exists pg_temp.accounting_s20_baseline');
	await client.query(pin);
	// The settle table is new in S20, so the migration's pin has no count of it; after it is applied, the rows already there are the base.
	await client.query("update pg_temp.accounting_s20_baseline set payload = jsonb_set(payload, '{counts,settlements}', to_jsonb((select count(*) from public.accounting_refund_settlements)))");
}

export type RefundRun = { posted: number; parked_new: number; reparked: number; resolved: number; reversed: number };

/** 返金の係を直接1回流す（入口 accounting_run_posting を通さない）。 */
export async function postRefundEvents(client: PgClient, limit = 50): Promise<RefundRun> {
	return (await client.query('select private.accounting_post_refund_events($1::integer) as r', [limit])).rows[0].r as RefundRun;
}

/** record_order_refund_result が付ける Stripe の返金の番号。 */
export const stripeRefundIdOf = (refundId: string) => `re_${refundId.replaceAll('-', '')}`;

/** 返金の結果を記録する（G の関数。canceled は Stripe が取り消した失敗）。 */
export async function recordRefundResult(client: PgClient, refundId: string, status: 'pending' | 'succeeded' | 'failed' | 'canceled') {
	const failure = status === 'failed' ? 'lost_or_stolen_card' : status === 'canceled' ? 'unknown' : null;
	return (await client.query("select * from public.record_order_refund_result($1,$2,$3,null,$4,null,'card',null,null)",
		[refundId, stripeRefundIdOf(refundId), status, failure])).rows[0];
}

/** Stripe の返金の行と、引かれた残高の取引（返金の額の負）を入れる。at は取引の時刻（無ければ今）。 */
export async function saveRefundTxn(client: PgClient, refundId: string, input: { at?: string; amount?: number } = {}): Promise<string> {
	const refund = (await client.query(`select r.order_id, r.amount,
		coalesce(o.payment_intent_id, 'pi_' || replace(r.order_id::text, '-', '')) as pi
		from public.order_refunds r join public.orders o on o.id = r.order_id where r.id=$1`, [refundId])).rows[0];
	const txnId = `txn_${randomUUID().replaceAll('-', '')}`;
	const amount = input.amount ?? (refund.amount as number);
	await client.query(`insert into public.stripe_balance_transactions (id, source_id, payment_intent_id, order_id, type, reporting_category, amount,
		fee, net, currency, status, stripe_created_at, raw_payload) values ($1,$2,null,$3,'refund','refund',$4,0,$4,'jpy','available',
		coalesce($5::timestamptz, now()),'{}'::jsonb)`, [txnId, stripeRefundIdOf(refundId), refund.order_id, -amount, input.at ?? null]);
	await client.query(`insert into public.stripe_refunds (id, payment_intent_id, order_id, amount, currency, status, balance_transaction_id,
		stripe_created_at, succeeded_at, raw_payload) values ($1,$6,$2,$3,'jpy','succeeded',$4,coalesce($5::timestamptz, now()),
		coalesce($5::timestamptz, now()),'{}'::jsonb)
		on conflict (id) do update set balance_transaction_id = excluded.balance_transaction_id`,
	[stripeRefundIdOf(refundId), refund.order_id, refund.amount, txnId, input.at ?? null, refund.pi]);
	return txnId;
}

/** 引かれた返金の失敗の戻りの残高の取引（返金の額の正）を入れ、Stripe の返金の行に結ぶ。 */
export async function saveFailureTxn(client: PgClient, refundId: string, input: { at?: string; amount?: number } = {}): Promise<string> {
	const refund = (await client.query('select order_id, amount from public.order_refunds where id=$1', [refundId])).rows[0];
	const txnId = `txn_${randomUUID().replaceAll('-', '')}`;
	await client.query(`insert into public.stripe_balance_transactions (id, source_id, payment_intent_id, order_id, type, reporting_category, amount,
		fee, net, currency, status, stripe_created_at, raw_payload) values ($1,$2,null,$3,'refund_failure','refund_failure',$4,0,$4,'jpy','available',
		coalesce($5::timestamptz, now()),'{}'::jsonb)`, [txnId, stripeRefundIdOf(refundId), refund.order_id, input.amount ?? refund.amount, input.at ?? null]);
	await client.query("update public.stripe_refunds set failure_balance_transaction_id=$2, status='failed' where id=$1", [stripeRefundIdOf(refundId), txnId]);
	return txnId;
}

/** 返金を成功にする（Stripe の行と残高の取引、そして結果の記録）。 */
export async function succeedRefund(client: PgClient, refundId: string, input: { at?: string } = {}): Promise<string> {
	const txnId = await saveRefundTxn(client, refundId, input);
	await recordRefundResult(client, refundId, 'succeeded');
	return txnId;
}

/** 返金を失敗にする。pulled なら、先に引かれた（成功の取引がある）返金の戻りの取引も入れる。 */
export async function failRefund(client: PgClient, refundId: string, input: { pulled?: boolean; at?: string } = {}): Promise<string | null> {
	const txnId = input.pulled ? await saveFailureTxn(client, refundId, { at: input.at }) : null;
	await recordRefundResult(client, refundId, 'failed');
	return txnId;
}

/** Stripe が返金を取り消した（状態 canceled）。pulled なら戻りの取引も入れる。 */
export async function cancelRefund(client: PgClient, refundId: string, input: { pulled?: boolean; at?: string } = {}): Promise<string | null> {
	const txnId = input.pulled ? await saveFailureTxn(client, refundId, { at: input.at }) : null;
	await recordRefundResult(client, refundId, 'canceled');
	return txnId;
}

/** 取り消された返金の区分を選ぶ（admin_decide_refund_cancellation。人は会計の管理者）。 */
export async function decideRefund(client: PgClient, refundId: string, kind: 'abandoned' | 'owed', actor?: string) {
	const admin = actor ?? await insertAccountingAdmin(client);
	return (await client.query('select public.admin_decide_refund_cancellation($1,$2,$3,$4,$5) as r',
		[admin, refundId, kind, kind === 'abandoned' ? 'shop gave up' : 'shop still owes', randomUUID()])).rows[0].r;
}

/**
 * 注文の支払いの仕訳を入れる（注文の payment_intent_id と合計で Stripe の支払いの取引を入れ、支払いの係を流す）。
 * at は取引の時刻（初期値は 2026-11-01 の日本の昼）。
 */
export async function postOrderPayment(client: PgClient, orderId: string, at = '2026-11-01T03:00:00Z'): Promise<void> {
	const order = (await client.query('select payment_intent_id, total_amount from public.orders where id=$1', [orderId])).rows[0];
	await seedStripeCharge(client, { paymentIntentId: order.payment_intent_id, amount: order.total_amount, createdAt: at, orderId });
	await client.query('select private.accounting_post_payment_events(200)');
	const posted = (await client.query('select 1 from public.accounting_journal_entries where dedupe_key=$1',
		[`payment_confirmed:${order.payment_intent_id}`])).rows.length;
	if (posted !== 1) throw new Error('POST_ORDER_PAYMENT_NOT_POSTED');
}

/**
 * 返品の届いた日と額の決定の仕訳を入れる。Task 6 の時点では返品の係が無かったので計画1の core で直接入れていたが、Task 7 の後は
 * 本物の返品の係（private.accounting_post_return_events）を流す（final-review-b2 の小1。Task 6 の返品の返金の試験は、受け取りと
 * 返品の係で入れた届いた日・決定の仕訳の上で流れる）。その返品の届いた日・額の決定の仕訳のうち、この呼び出しで入った本数を返す。
 */
export async function seedReturnArrivalEntries(client: PgClient, returnId: string): Promise<number> {
	const count = async () => Number((await client.query(`select count(*) n from public.accounting_journal_entries e
		where (e.event_kind = 'return_arrived' and e.source_table = 'order_return_receipts'
			and e.source_id in (select f.receipt_id::text from public.accounting_return_facts f where f.return_id=$1))
		or (e.event_kind = 'return_amount_decided' and e.source_table = 'accounting_return_facts'
			and e.source_id in (select f.id::text from public.accounting_return_facts f where f.return_id=$1))`, [returnId])).rows[0].n);
	const before = await count();
	await postReturnEvents(client, 200);
	return (await count()) - before;
}

// ---- Task 7（S21。返品の届いた日・額の決定・届いた日の直しの仕訳）の道具 ----

const s21Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_return_posting.sql'));
/** 計画3 S21（返品の仕訳）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S21_SQL = s21Files.length === 1 ? fs.readFileSync(path.join(directory, s21Files[0]), 'utf8') : '';
export const ACCOUNTING_S21_FILES = s21Files;

/** S21 の `-- ACC_S21_<name>_BEGIN` と `-- ACC_S21_<name>_END` の間。 */
export function accountingS21Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S21_SQL.split(`-- ACC_S21_${name}_BEGIN\n`)[1]?.split(`-- ACC_S21_${name}_END`)[0] ?? '';
}

/** S21 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS21Baseline(client: PgClient): Promise<void> {
	const pin = accountingS21Section('BODY').split('\n-- 1. The lines of every return entry')[0];
	await client.query('drop table if exists pg_temp.accounting_s21_baseline');
	await client.query(pin);
}

/** S20 の計上係の入口（S21 が作り直す前の本文）を、呼ぶ取引の中で戻す（S20 の末尾の確かめを今の DB で流し直す時）。 */
export async function restoreS20RunPosting(client: PgClient): Promise<void> {
	const body = [...ACCOUNTING_S20_SQL.matchAll(/^CREATE OR REPLACE FUNCTION private\.accounting_run_posting\([\s\S]*?^\$\$;/gm)].at(-1)?.[0];
	if (!body) throw new Error('ACC_S20_RUN_POSTING_MISSING');
	await client.query(body);
}

/** S22 が detail の一覧を作り直したので、S15 の末尾の確かめを再生する前に S15 の本文へ戻す（呼ぶ取引の中だけ）。 */
export async function restoreS15DetailValid(client: PgClient): Promise<void> {
	const body = ACCOUNTING_S15_SQL.match(/^CREATE OR REPLACE FUNCTION private\.accounting_pending_detail_valid\([\s\S]*?^\$\$;/m)?.[0];
	if (!body) throw new Error('ACC_S15_DETAIL_VALID_MISSING');
	await client.query(body);
}

export type ReturnRun = { posted: number; parked_new: number; reparked: number; resolved: number; reversed: number; redated: number };

/** 返品の係を直接1回流す（入口 accounting_run_posting を通さない）。 */
export async function postReturnEvents(client: PgClient, limit = 50): Promise<ReturnRun> {
	return (await client.query('select private.accounting_post_return_events($1::integer) as r', [limit])).rows[0].r as ReturnRun;
}

/**
 * 受け取りの届いた日を直す（public.admin_correct_return_arrival_date。人は会計の管理者、版は今の最新の直しの版）。
 * 直しの行（id・版・前後の日）を返す。
 */
export async function correctArrival(client: PgClient, receiptId: string, newOn: string,
	o: { actor?: string; reason?: string; key?: string } = {}) {
	const actor = o.actor ?? await insertAccountingAdmin(client);
	const version = Number((await client.query('select coalesce(max(version),0) v from public.order_return_arrival_corrections where receipt_id=$1',
		[receiptId])).rows[0].v);
	return (await client.query('select public.admin_correct_return_arrival_date($1,$2,$3::date,$4,$5,$6) as r',
		[actor, receiptId, newOn, o.reason ?? '配送の記録を見直した', version, o.key ?? randomUUID()])).rows[0].r as {
		receipt_id: string; version: number; previous_on: string; new_on: string; correction_id: string; replayed: boolean };
}

/** 注文の勘定の残高（貸方 − 借方。sub を渡すと補助を絞る）。資産（1160・1040）は符号を逆にして読む。 */
export async function orderBalance(client: PgClient, orderId: string, account: string, sub: string | null = null): Promise<number> {
	return Number((await client.query('select private.accounting_order_account_balance($1,$2,$3) as n', [orderId, account, sub])).rows[0].n);
}

/**
 * 着の行と枠（order_unit_slots）を持ち、支払いの仕訳まで入った注文（lines の1要素が1つの品の着の支払額）。値段の計画を
 * 通さない出来事を fixture で入れる試験の土台（計画3 Task 3 の割り当ての試験と同じ作り）。
 */
export async function seedSlotPaidOrder(client: PgClient, lines: number[][]): Promise<{ orderId: string; orderItemIds: string[] }> {
	const o = await seedUnitOrder(client, lines);
	await client.query(`insert into public.order_unit_slots(order_item_id, unit_index, order_id, item_id, state, current_price, holder_order_item_id, holder_unit_index)
		select u.order_item_id, u.unit_index, oi.order_id, oi.item_id, 'kept', u.paid_amount, u.order_item_id, u.unit_index
		from public.order_line_unit_amounts u join public.order_items oi on oi.id=u.order_item_id where oi.order_id=$1`, [o.orderId]);
	await client.query('update public.orders set payment_intent_id=coalesce(payment_intent_id,$2) where id=$1',
		[o.orderId, `pi_s20_${randomUUID().replaceAll('-', '')}`]);
	await postOrderPayment(client, o.orderId);
	return o;
}

export type CancelLine = { item: string; unit: number; kind: 'returned' | 'kept'; allocation?: number; correction?: number; shipped?: boolean };

/** 発送前の取り消しの出来事を fixture で直接入れる（交換の設計の関数では作れない値の組を試す時。計画3 Task 3 の試験と同じ形）。 */
export async function seedCancelEvent(client: PgClient, orderId: string, lines: CancelLine[], standard = 0): Promise<string> {
	const eventId = (await client.query(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
		entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
		values($1,'pre_shipment_cancel',0,0,0,0,0,0,0,$2,$2,0) returning id`, [orderId, standard])).rows[0].id as string;
	for (const l of lines) {
		await client.query(`insert into public.order_unit_event_lines(event_id, line_kind, order_item_id, unit_index, slot_order_id, holder_order_item_id, holder_unit_index,
			state_before, state_after, price_before, price_after, allocation, correction, part, shipped)
			values($1,$2,$3,$4,$5,$3,$4,'kept',$6,0,0,$7,$8,$9,$10)`,
		[eventId, l.kind, l.item, l.unit, orderId, l.kind === 'returned' ? 'returned_shop' : 'kept', l.allocation ?? 0, l.correction ?? 0,
			l.kind === 'returned' ? 'now' : null, l.shipped ?? false]);
		if (l.kind === 'returned') {
			await client.query("update public.order_unit_slots set state='returned_shop', last_event_id=$3 where order_item_id=$1 and unit_index=$2",
				[l.item, l.unit, eventId]);
		}
	}
	return eventId;
}

/** fixture の出来事に返金を1本結び、コアと同じ順（状態の行 → 事実 → 出来事の割り当て）で書く。eventId が null なら出来事の無い返金。 */
export async function seedCancelRefund(client: PgClient, orderId: string, eventId: string | null, amount: number,
	lines: Array<{ item: string; before: boolean; amount: number }> = []): Promise<string> {
	const linesAmount = lines.reduce((s, l) => s + l.amount, 0);
	const refundId = (await client.query(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount,
		adjustment_amount, notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,0,$3,false) returning id`,
	[orderId, amount, amount - linesAmount])).rows[0].id as string;
	for (const l of lines) {
		await client.query(`insert into public.order_refund_lines(refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
			values($1,$2,1,$3,'no_restock',$4)`, [refundId, l.item, l.before, l.amount]);
	}
	if (eventId) await client.query("insert into public.order_unit_event_refunds(event_id, refund_id, part) values($1,$2,'now')", [eventId, refundId]);
	await client.query("select private.accounting_record_refund_event($1,'requested')", [refundId]);
	await client.query('select private.accounting_record_refund_facts($1)', [refundId]);
	if (eventId) await client.query('select private.accounting_record_event_allocations($1)', [eventId]);
	else await client.query('select private.accounting_write_refund_allocations($1)', [refundId]);
	return refundId;
}

/**
 * 確定した発送票（G の出荷と事実つき）で着を送り、出荷の係を1回流す。actorId を渡すと H の受け付けの注文として G の出荷の
 * 道具（shipFixtureOrder）で送り、その出荷を発送票に結ぶ（G3 の道具）。
 */
export async function shipAndPost(client: PgClient, orderId: string, orderItemId: string, quantity = 1, actorId?: string): Promise<unknown> {
	if (actorId) await shipUnits(client, orderId, orderItemId, quantity, actorId);
	else await seedConfirmedSlip(client, { orders: [{ orderId, lines: [{ orderItemId, quantity }] }] });
	return postShipments(client);
}

/** H の受け付けの注文の着を G の出荷の道具で送り、確定した発送票に結んで出荷の事実を残す（出荷の係は流さない）。 */
export async function shipUnits(client: PgClient, orderId: string, orderItemId: string, quantity: number, actorId: string) {
	const shipped = await shipFixtureOrder(client, { orderId, actorId, trackingNumber: `S20-${randomUUID().slice(0, 8)}`,
		lines: [{ order_item_id: orderItemId, quantity }] });
	const slipId = await seedGroupG3Slip(client, { stage: 'confirmed', actorId });
	await attachGroupG3SlipShipment(client, { slipId, orderId, orderItemId, fulfillmentId: shipped.fulfillment_id, quantity, actorId });
	await client.query('select private.accounting_record_slip_fact($1::uuid, $2::text)', [slipId, 'confirm']);
	return { fulfillmentId: shipped.fulfillment_id, slipId };
}

/** 出荷の係を1回流す。 */
export async function postShipments(client: PgClient): Promise<unknown> {
	return (await client.query('select private.accounting_post_shipment_events(200) as r')).rows[0].r;
}

/** 銀行振込の記録（admin_record_refund_bank_transfer）。 */
export async function bankTransfer(client: PgClient, input: { actor: string; orderId: string; origin: 'pre_shipment' | 'post_shipment' | 'return';
	amount: number; on: string; txn: string; note?: string | null; key?: string }) {
	return (await client.query('select public.admin_record_refund_bank_transfer($1,$2,$3,$4,$5::date,$6,$7,$8) as r',
		[input.actor, input.orderId, input.origin, input.amount, input.on, input.txn, input.note ?? null, input.key ?? randomUUID()])).rows[0].r as {
		entry_id: string; created: boolean };
}

/** やり直しの返金で借りを結ぶ（admin_settle_owed_by_refund）。 */
export async function settleOwed(client: PgClient, actor: string, owedRefundId: string, payingRefundId: string, key = randomUUID()) {
	return (await client.query('select public.admin_settle_owed_by_refund($1,$2,$3,$4) as r', [actor, owedRefundId, payingRefundId, key])).rows[0].r;
}

/** 注文の仕訳の行（入った順）。 */
export async function orderLines(client: PgClient, orderId: string) {
	return (await client.query(`select e.id as entry_id, e.event_kind, e.dedupe_key, e.entry_date::text as entry_date, e.source_table, e.source_id,
		e.reverses_entry_id, l.account_code, l.debit::int as debit, l.credit::int as credit, l.sub_account, l.order_id, l.memo
		from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id=e.id
		where l.order_id=$1 order by e.entry_no, l.line_no`, [orderId])).rows;
}

/** 返金の計上待ち（source_id の物）。 */
export async function refundPending(client: PgClient, sourceId: string) {
	return (await client.query(`select event_kind, source_table, reason, detail, resolved_at, resolved_entry_id from public.accounting_pending_events
		where source_id=$1 order by first_detected_at`, [sourceId])).rows;
}

// ---- Task 6 の補い（規則5の表。値段の違う2着の写しのある注文）の道具 ----

/**
 * H の受け付けと支払いで作る、同じ品の2つの色違い（1着ずつ、2行）の写しのある注文。同じ品の2着目に付く繰り返しの割引 delta が
 * 片方の行に付く（最低額 price × 2）。cheap は割引の付いた行（u0。支払額 p0 = price - delta）、dear はもう片方（u1。p1 = price）。
 * 1行に2着だと割引は番号の大きい着に付き、出荷済みの着は番号の若い着から決まる（裁定 P3-6）ので、安い着だけを先に送れない。
 * 行を分けると、送る着と取り消す着を行で名指せる。
 */
export async function seedPairFlow(client: PgClient, price: number, delta: number) {
	await client.query('select pg_advisory_xact_lock(190521,1)');
	const actor = await seedHMember(client);
	const code = `S20-${randomUUID().toUpperCase()}`;
	const first = await createCatalogFixture(client, { stock: 1 });
	const { variantId } = await addItemVariant(client, { itemId: first.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 1 });
	const catalogs = [first, { ...first, variantId, colorName: 'WHITE', sizeLabel: 'L' }];
	const discountId = await seedHDiscount(client, hDiscount({ code, kind: 'repeat', value: { type: 'amount', value: delta },
		targetMode: 'include', itemIds: [first.itemId], minimum: { type: 'amount', value: price * 2 }, repeatInOrder: true, allowGuests: true }));
	const f = await seedHCheckout(client, { discountId, code, unitPrice: price, lines: catalogs.map((catalog) => ({ catalog, quantity: 1 })) });
	const accepted = await acceptHCheckout(client, f);
	if (!accepted.order_id || accepted.rejection) throw new Error('S20_PAIR_ACCEPTANCE_FAILED');
	const orderId = accepted.order_id;
	const paid = (await client.query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')",
		[orderId, f.paymentIntentId, f.result.totalAmount])).rows[0];
	if (!paid?.updated) throw new Error('S20_PAIR_PAYMENT_FAILED');
	const units = (await client.query(`select u.order_item_id, u.unit_index, u.paid_amount from public.order_line_unit_amounts u where u.order_id=$1
		order by u.paid_amount, u.order_item_id`, [orderId])).rows as Array<{ order_item_id: string; unit_index: number; paid_amount: number }>;
	if (units.length !== 2 || units[0].paid_amount !== price - delta || units[1].paid_amount !== price) throw new Error(`S20_PAIR_AMOUNTS ${JSON.stringify(units)}`);
	return { orderId, actor, cheap: units[0].order_item_id, dear: units[1].order_item_id, p0: price - delta, p1: price };
}

/** 返品の申し込みの時刻を at（timestamptz の字）にする（申し込みの時刻は変えられない列なので、試験の取引の中だけ利用者のトリガーを外す）。 */
export async function setRequestedAt(client: PgClient, returnId: string, at: string): Promise<void> {
	await client.query('alter table public.order_returns disable trigger user');
	await client.query('update public.order_returns set requested_at = $2::timestamptz where id=$1', [returnId, at]);
	await client.query('alter table public.order_returns enable trigger user');
}

// ---- Task 8（S22。カード会社の取り消しの確定の相殺）の道具 ----

const s22Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_dispute_offset.sql'));
/** 計画3 S22（取り消しの確定の相殺）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S22_SQL = s22Files.length === 1 ? fs.readFileSync(path.join(directory, s22Files[0]), 'utf8') : '';
export const ACCOUNTING_S22_FILES = s22Files;

/** S22 の `-- ACC_S22_<name>_BEGIN` と `-- ACC_S22_<name>_END` の間。 */
export function accountingS22Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S22_SQL.split(`-- ACC_S22_${name}_BEGIN\n`)[1]?.split(`-- ACC_S22_${name}_END`)[0] ?? '';
}

/** S22 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS22Baseline(client: PgClient): Promise<void> {
	const pin = accountingS22Section('BODY').split('\n-- 1. The wait of C')[0];
	await client.query('drop table if exists pg_temp.accounting_s22_baseline');
	await client.query(pin);
}

/**
 * 取り消しの試験の日（2026年11月。今日より前の日だけを使う。返品の届いた日と振込の日は今日より後にできないため）。
 * 支払い 11-01、発送の事実 11-02、引かれた時 11-03、返品の申し込み 11-04、届いた日 11-05、返金の成功 11-06、遅い失敗と振込 11-07、
 * 確定（lost）11-09、確定の後の届いた日 11-10、遅れた取り下げ 2027-01-15。
 */
export const DISPUTE_DAYS = {
	payment: '2026-11-01T03:00:00Z', slipFact: '2026-11-02T01:00:00Z', withdrawn: '2026-11-03T03:00:00Z', requested: '2026-11-04T03:00:00Z',
	arrival: '2026-11-05', refund: '2026-11-06T03:00:00Z', failure: '2026-11-07T03:00:00Z', bank: '2026-11-07',
	lost: '2026-11-09T03:00:00Z', lostOn: '2026-11-09', afterLost: '2026-11-10', late: '2027-01-15T03:00:00Z',
} as const;

/** 返金を作った時刻を at にする（作った時刻は書き手が変えない列なので、試験の取引の中だけ利用者のトリガーを止める）。 */
export async function setRefundCreatedAt(client: PgClient, refundId: string, at: string = DISPUTE_DAYS.withdrawn): Promise<void> {
	const mode = (await client.query("select tgenabled from pg_catalog.pg_trigger where tgrelid = 'public.order_refunds'::regclass and tgname = 'order_refunds_guard'"))
		.rows[0].tgenabled as string;
	await client.query('alter table public.order_refunds disable trigger order_refunds_guard');
	await client.query('update public.order_refunds set created_at = $2::timestamptz where id = $1', [refundId, at]);
	await client.query(`alter table public.order_refunds enable ${mode === 'A' ? 'always ' : ''}trigger order_refunds_guard`);
}

/**
 * 注文の発送の事実の時刻を at に戻す（道具の発送は今の時刻で事実を残すので、過去の引かれた時が出荷済みとして数えるように）。
 * 事実の表の守り（ENABLE ALWAYS）を取引の中だけ外し、同じ ALWAYS で戻す。コミットする試験では使わない。
 */
export async function backdateSlipFacts(client: PgClient, orderId: string, at: string = DISPUTE_DAYS.slipFact): Promise<void> {
	await client.query('alter table public.accounting_g_slip_facts disable trigger accounting_g_slip_facts_no_update_delete');
	await client.query(`update public.accounting_g_slip_facts f set locked_at = $2::timestamptz
		where exists (select 1 from public.shipment_slip_lines sl join public.order_items oi on oi.id = sl.order_item_id
			where sl.slip_id = f.slip_id and oi.order_id = $1)`, [orderId, at]);
	await client.query('alter table public.accounting_g_slip_facts enable always trigger accounting_g_slip_facts_no_update_delete');
}

/**
 * 取り消しの流れの土台: 返品の流れ（seedReturnFlow。2着とも出荷済み、割合の手数料 既定 10%）の注文の支払いと出荷の仕訳を入れ、
 * 返品の申し込みを 11-04 にし、取り消し（needs_response、引かれた取引はまだ無い）を作る。原因の科目の設定（fraudulent → 7530）は
 * setting が偽でなければ入れる。返す道具: withdraw（引かれた時の取引）、lose（lost の知らせ）、reverse（取り下げの戻りの取引）。
 */
export async function seedDisputeFlow(client: PgClient, o: { amount?: number; percent?: number; snapshot?: boolean; setting?: boolean } = {}) {
	// The units go out through the G shipping tool and a confirmed slip bound to that shipment, so the shipment entry posts.
	const f = await hRefundFixture(client, false, 2, 1250);
	if (o.snapshot === false) await dropDiscountSnapshot(client, f.orderId);
	const shipped = await shipUnits(client, f.orderId, f.itemId, 2, f.actor);
	const fx = { ...f, fulfillment: { fulfillment_id: shipped.fulfillmentId } } as unknown as ReturnFlow['f'];
	const ret = await createUbReturn(client, fx, [{ quantity: 1 }], { percent: o.percent ?? 10 });
	const flow: ReturnFlow = { f: fx, returnId: ret.returnId, lineIds: ret.lineIds };
	const orderId = flow.f.orderId;
	await postOrderPayment(client, orderId, DISPUTE_DAYS.payment);
	await backdateSlipFacts(client, orderId);
	await postShipments(client);
	await setRequestedAt(client, flow.returnId, DISPUTE_DAYS.requested);
	const pi = (await client.query('select payment_intent_id from public.orders where id=$1', [orderId])).rows[0].payment_intent_id as string;
	const admin = await insertAccountingAdmin(client);
	if (o.setting !== false && (await client.query("select 1 from public.accounting_dispute_account_settings where reason='fraudulent'")).rows.length === 0) {
		await client.query("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [admin, randomUUID()]);
	}
	const amount = o.amount ?? 30000;
	const { disputeId } = await seedDispute(client, { orderId, paymentIntentId: pi, amount, withdrawnAt: null, createdAt: DISPUTE_DAYS.withdrawn });
	const withdraw = (at: string = DISPUTE_DAYS.withdrawn) => seedStripeFee(client, { createdAt: at, type: 'adjustment', reportingCategory: 'dispute',
		amount: -amount, sourceId: disputeId });
	const lose = (at: string = DISPUTE_DAYS.lost) => addDisputeHistory(client, { disputeId, status: 'lost',
		occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(), stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
	const reverse = (value: number = amount, at: string = DISPUTE_DAYS.late) => seedDisputeReversal(client, { disputeId, amount: value, createdAt: at });
	return { flow, orderId, disputeId, admin, amount, withdraw, lose, reverse };
}
export type DisputeFlow = Awaited<ReturnType<typeof seedDisputeFlow>>;

/**
 * 値段の違う2着（10,000円の dear と 8,000円の cheap。同じ品の色違い2行、H の受け付けの写しのある注文）を送り、2つの返品の行
 * （lineIds[0] が dear、lineIds[1] が cheap）で返品を承認する（割合の手数料。既定 10%）。snapshot を false にすると写しの無い注文。
 */
export async function seedTwoPriceReturnFlow(client: PgClient, o: { snapshot?: boolean; percent?: number } = {}) {
	const p = await seedPairFlow(client, 10000, 2000);
	if (o.snapshot === false) await dropDiscountSnapshot(client, p.orderId);
	const shipped = await shipFixtureOrder(client, { orderId: p.orderId, actorId: p.actor, trackingNumber: `S21-${randomUUID().slice(0, 8)}`,
		lines: [{ order_item_id: p.dear, quantity: 1 }, { order_item_id: p.cheap, quantity: 1 }] });
	for (const id of [p.dear, p.cheap]) await seedFactSlip(client, { orderItemId: id, quantity: 1 });
	const ret = await createUbReturn(client, { orderId: p.orderId, itemId: p.dear, actor: p.actor, fulfillment: shipped, catalog: { variantId: 0 } },
		[{ quantity: 1, itemId: p.dear }, { quantity: 1, itemId: p.cheap }], { percent: o.percent ?? 10 });
	// createUbReturn sorts its random line ids, so read which line is which.
	const byItem = new Map((await client.query('select id, order_item_id from public.order_return_lines where return_id=$1', [ret.returnId])).rows
		.map((r: { id: string; order_item_id: string }) => [r.order_item_id, r.id]));
	const lineIds = [byItem.get(p.dear) as string, byItem.get(p.cheap) as string];
	return { orderId: p.orderId, actor: p.actor, returnId: ret.returnId, lineIds, dear: p.dear, cheap: p.cheap };
}

// ---- Task 9（S23。受注高・照合の読み口と消費税用の返金の一覧）の道具 ----

const s23Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_intake_tax_reads.sql'));
/** 計画3 S23（受注高・照合の読み口の作り直しと消費税用の返金の一覧）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S23_SQL = s23Files.length === 1 ? fs.readFileSync(path.join(directory, s23Files[0]), 'utf8') : '';
export const ACCOUNTING_S23_FILES = s23Files;

/** S23 の `-- ACC_S23_<name>_BEGIN` と `-- ACC_S23_<name>_END` の間。 */
export function accountingS23Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S23_SQL.split(`-- ACC_S23_${name}_BEGIN\n`)[1]?.split(`-- ACC_S23_${name}_END`)[0] ?? '';
}

/** S23 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS23Baseline(client: PgClient): Promise<void> {
	const pin = accountingS23Section('BODY').split('\n-- 1. The intake events')[0];
	await client.query('drop table if exists pg_temp.accounting_s23_baseline');
	await client.query(pin);
}

// ---- Task 11a（S24。手で入れた仕訳と結んで計上待ちを閉じる）の道具 ----

const s24Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_pending_manual_close.sql'));
/** 計画3 S24（計上待ちを手で入れた仕訳と結ぶ道）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S24_SQL = s24Files.length === 1 ? fs.readFileSync(path.join(directory, s24Files[0]), 'utf8') : '';
export const ACCOUNTING_S24_FILES = s24Files;

/** S24 の `-- ACC_S24_<name>_BEGIN` と `-- ACC_S24_<name>_END` の間。 */
export function accountingS24Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S24_SQL.split(`-- ACC_S24_${name}_BEGIN\n`)[1]?.split(`-- ACC_S24_${name}_END`)[0] ?? '';
}

/** S24 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS24Baseline(client: PgClient): Promise<void> {
	const pin = accountingS24Section('BODY').split('\n-- 1. The link of a pending row')[0];
	await client.query('drop table if exists pg_temp.accounting_s24_baseline');
	await client.query(pin);
}

/** S24 が Stripe の照合と取り消しの待ちを作り直したので、S23・S22 の末尾の確かめを再生する前に S23 の本文へ戻す（呼ぶ取引の中だけ）。 */
export async function restoreS23StripeReconciliation(client: PgClient): Promise<void> {
	const body = ACCOUNTING_S23_SQL.match(/^CREATE OR REPLACE FUNCTION private\.get_stripe_balance_reconciliation\([\s\S]*?^\$\$;/m)?.[0];
	if (!body) throw new Error('ACC_S23_STRIPE_RECONCILIATION_MISSING');
	await client.query(body);
}

// ---- Task 11c（S25。借りの一覧に出来事と返品の借りを足し、結びの候補を出す）の道具 ----

const s25Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_refund_debt_reads.sql'));
/** 計画3 S25（借りの一覧の読みと結びの候補の読み）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S25_SQL = s25Files.length === 1 ? fs.readFileSync(path.join(directory, s25Files[0]), 'utf8') : '';
export const ACCOUNTING_S25_FILES = s25Files;

/** S25 の `-- ACC_S25_<name>_BEGIN` と `-- ACC_S25_<name>_END` の間。 */
export function accountingS25Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S25_SQL.split(`-- ACC_S25_${name}_BEGIN\n`)[1]?.split(`-- ACC_S25_${name}_END`)[0] ?? '';
}

/** S25 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS25Baseline(client: PgClient): Promise<void> {
	const pin = accountingS25Section('BODY').split('\n-- 1. The debt read')[0];
	await client.query('drop table if exists pg_temp.accounting_s25_baseline');
	await client.query(pin);
}

// ---- 最終レビューの直し（S26。返送不要の返品・普通の返品の借りの結びの断り・返品の返金待ちの負）の道具 ----

const s26Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_final_fixes.sql'));
/** 計画3 S26（最終レビューの直し）の移行の本文（無ければ空で、原文の確かめが目に見えて落ちる）。 */
export const ACCOUNTING_S26_SQL = s26Files.length === 1 ? fs.readFileSync(path.join(directory, s26Files[0]), 'utf8') : '';
export const ACCOUNTING_S26_FILES = s26Files;

/** S26 の `-- ACC_S26_<name>_BEGIN` と `-- ACC_S26_<name>_END` の間。 */
export function accountingS26Section(name: 'BODY' | 'FINAL_ASSERT'): string {
	return ACCOUNTING_S26_SQL.split(`-- ACC_S26_${name}_BEGIN\n`)[1]?.split(`-- ACC_S26_${name}_END`)[0] ?? '';
}

/** S26 の比べる元の控え（本文の最初の CREATE TEMP TABLE と INSERT）を、呼ぶ取引の中で作り直す。 */
export async function pinAccountingS26Baseline(client: PgClient): Promise<void> {
	const pin = accountingS26Section('BODY').split('\n-- 1. A return that sends nothing back')[0];
	await client.query('drop table if exists pg_temp.accounting_s26_baseline');
	await client.query(pin);
}

/**
 * 返品を「品を送り返さない返品」（return_method not_required）にする。承認の後は返送の方法を変えられないので、守りの1本を
 * この取引の中だけ外して直す（取引は呼び出し側が巻き戻す。dropDiscountSnapshot と同じ形）。
 */
export async function setReturnNotRequired(client: PgClient, returnId: string): Promise<void> {
	await client.query('alter table public.order_returns disable trigger order_returns_guard');
	await client.query("update public.order_returns set return_method = 'not_required' where id = $1", [returnId]);
	await client.query('alter table public.order_returns enable trigger order_returns_guard');
}
