import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';
import { randomUUID } from 'node:crypto';
import { seedDispute } from './accounting-orders-fixtures';
import { cancelPlanFor, hBegin, hReceive, hRefundFixture, hResult, hReturn } from './group-h-refund-fixtures';
import { createUbReturn, ubReceive, type ReceiveInput, type ReceiveUnit } from './unit-binding-receive';

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
