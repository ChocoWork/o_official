import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { insertAccountingAdmin, insertAccountingPeriod } from './accounting-fixtures';
import { addDisputeHistory, seedDispute } from './accounting-orders-fixtures';
import { seedSlotPaidOrder } from './accounting-returns-fixtures';

// 計画 S27（負けた取り消しと返品の0円の終わりの自動計上）の DB 試験の道具。事実と返金を直に入れて、円を自分で決める。
// 呼び出す取引が G の鍵（190521,1）を持っていること。

export type AutoOrder = { orderId: string; orderItemIds: string[]; returnId: string; actor: string };

/** 品の値段の並び（1品1着）の支払い済みの注文と、その注文の返品1件（申し込みだけ。受け取りと返金は下の部品で足す）。 */
export async function seedAutoOrder(client: PgClient, items: number[], paidAt?: string): Promise<AutoOrder> {
	const o = await seedSlotPaidOrder(client, items.map((price) => [price]), paidAt);
	const actor = await insertAccountingAdmin(client);
	const returnId = (await client.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,1,'customer_request','requested',$2,'auto-fixture',now(),$3,'customer_ships','customer',false) returning id`,
	[o.orderId, randomUUID(), actor])).rows[0].id as string;
	return { orderId: o.orderId, orderItemIds: o.orderItemIds, returnId, actor };
}

async function insertReceipt(client: PgClient, o: AutoOrder, kind: 'receive' | 'waive_refund', on: string): Promise<string> {
	return (await client.query(`insert into public.order_return_receipts (return_id, request_key, request_fingerprint, kind, refund_choice, notify_customer,
    actor_id, actor_can_refund, arrived_on) values ($1, $2, 'auto-fixture', $3, $6, false, $4, true, $5::date) returning id`,
	[o.returnId, randomUUID(), kind, o.actor, on, kind === 'receive' ? 'consult' : null])).rows[0].id as string;
}

async function nextSeq(client: PgClient, returnId: string): Promise<number> {
	return Number((await client.query('select coalesce(max(seq), 0) + 1 as n from public.accounting_return_facts where return_id = $1', [returnId])).rows[0].n);
}

/** 返品の届いた日の事実（goods 円・手数料 fee 円）。on は届いた日（既定 11-05）。 */
export async function seedArrival(client: PgClient, o: AutoOrder, goods: number, fee = 0, on = '2026-11-05'): Promise<{ receiptId: string; factId: string }> {
	const receiptId = await insertReceipt(client, o, 'receive', on);
	const factId = (await client.query(`insert into public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, goods_amount, fee_amount)
    values ($1, $2, $3, 'arrival', $4, $5, $6) returning id`, [o.returnId, o.orderId, await nextSeq(client, o.returnId), receiptId, goods, fee])).rows[0].id as string;
	return { receiptId, factId };
}

/**
 * 返品の0円の終わりの決定の事実（返金なし。引き受けた分 covers 円・手数料 fee 円。payable_delta = -covers）。on は決定の日（既定 11-10）。
 */
export async function seedZeroClose(client: PgClient, o: AutoOrder, covers: number, fee = 0, on = '2026-11-10'): Promise<{ receiptId: string; factId: string }> {
	const receiptId = await insertReceipt(client, o, 'waive_refund', on);
	const factId = (await client.query(`insert into public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, goods_amount, fee_amount,
    covers_amount, decided_amount, payable_delta, decided_on) values ($1, $2, $3, 'decision', $4, 0, $5, $6, 0, $7, $8::date) returning id`,
	[o.returnId, o.orderId, await nextSeq(client, o.returnId), receiptId, fee, covers, -covers, on])).rows[0].id as string;
	return { receiptId, factId };
}

export type InFlightShape = 'requested' | 'accepted' | 'error' | 'succeeded' | 'failed' | 'owed' | 'canceled' | 'abandoned';

/**
 * 返金1件（source = return。amount 円。品の返金 post = amount）と、その会計の状態の並び（states の順に1つずつ）、返金の事実。
 * decisionOf を渡すと、その決定（refund_id が無い決定の事実の代わりに、この返金を結ぶ決定）を payable_delta = delta で足す。
 * 作った日は createdOn（既定は今のまま）。
 */
export async function seedRefundInFlight(client: PgClient, o: AutoOrder, amount: number, states: InFlightShape[] = ['requested'],
	decision?: { decided: number; covers: number; on?: string; receiptId?: string }): Promise<{ refundId: string; decisionFactId: string | null }> {
	const refundId = (await client.query(`insert into public.order_refunds(order_id, source, return_id, request_key, request_fingerprint, status, amount,
    shipping_amount, adjustment_amount, notify_customer) values($1,'return',$2,gen_random_uuid(),'auto-fixture','awaiting_response',$3,0,$3,false) returning id`,
	[o.orderId, o.returnId, amount])).rows[0].id as string;
	for (const state of states) {
		const decided = state === 'abandoned' || state === 'owed';
		await client.query('select private.accounting_record_refund_event($1, $2, null, $3::uuid, $4, $5::uuid)',
			[refundId, state, decided ? o.actor : null, decided ? 'fixture' : null, decided ? randomUUID() : null]);
	}
	await client.query(`insert into public.accounting_refund_facts(refund_id, order_id, source, return_id, event_kind, pre_shipment_amount, post_shipment_amount,
    shipping_amount) values($1,$2,'return',$3,'none',0,$4,0)`, [refundId, o.orderId, o.returnId, amount]);
	let decisionFactId: string | null = null;
	if (decision) {
		decisionFactId = (await client.query(`insert into public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, refund_id, goods_amount,
      fee_amount, covers_amount, decided_amount, payable_delta, decided_on) values ($1, $2, $3, 'decision', $4, $5, 0, 0, $6, $7, $8, $9::date) returning id`,
		[o.returnId, o.orderId, await nextSeq(client, o.returnId), decision.receiptId ?? null, refundId, decision.covers, decision.decided,
			decision.decided - decision.covers, decision.on ?? '2026-11-06'])).rows[0].id as string;
	}
	return { refundId, decisionFactId };
}

/** 引かれた時の事実（取引）。取り消しの行と、その額の引かれた取引を入れる。 */
export async function seedWithdrawn(client: PgClient, orderId: string, amount: number, at = '2026-11-03T03:00:00Z'): Promise<{ disputeId: string; txnId: string | null }> {
	const pi = (await client.query('select payment_intent_id from public.orders where id = $1', [orderId])).rows[0].payment_intent_id as string;
	return seedDispute(client, { orderId, paymentIntentId: pi, amount, withdrawnAt: at, createdAt: at });
}

/** 取り消しが負けた（lost）。at は負けた日の時刻（既定 11-09）。 */
export async function seedLost(client: PgClient, disputeId: string, at = '2026-11-09T03:00:00Z'): Promise<void> {
	await addDisputeHistory(client, { disputeId, status: 'lost', occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(),
		stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
}

/** 返金を作った日を日本時間の日の昼にする（作った時刻は書き手が変えない列なので、取引の中だけ利用者のトリガーを止める）。 */
export async function setCreatedOn(client: PgClient, refundId: string, day: string): Promise<void> {
	const mode = (await client.query("select tgenabled from pg_catalog.pg_trigger where tgrelid = 'public.order_refunds'::regclass and tgname = 'order_refunds_guard'"))
		.rows[0].tgenabled as string;
	await client.query('alter table public.order_refunds disable trigger order_refunds_guard');
	await client.query('update public.order_refunds set created_at = ($2 || \'T03:00:00Z\')::timestamptz where id = $1', [refundId, day]);
	await client.query(`alter table public.order_refunds enable ${mode === 'A' ? 'always ' : ''}trigger order_refunds_guard`);
}

export type AutoLine = { account: string; debit?: number; credit?: number; sub?: string; orderId?: string };

/**
 * 仕訳を核から直に入れる（人の操作の許可なし）。date の日を含む期間が無ければ作る。lines の合計は貸借で合わせる。
 */
export async function postAutoEntry(client: PgClient, input: {
	date: string; kind: string; parts: string[]; lines: AutoLine[]; sourceTable?: string; sourceId?: string; reversesEntryId?: string;
}): Promise<string> {
	const existing = (await client.query('select id from public.accounting_periods where $1::date between starts_on and ends_on order by starts_on limit 1',
		[input.date])).rows[0];
	let periodId = existing?.id as string | undefined;
	if (!periodId) {
		const year = input.date.slice(0, 4);
		periodId = await insertAccountingPeriod(client, { businessType: 'soleProprietor', startsOn: `${year}-01-01`, endsOn: `${year}-12-31` });
	}
	const lines = JSON.stringify(input.lines.map((l) => ({ account_code: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0,
		sub_account: l.sub ?? null, counterparty: null, order_id: l.orderId ?? null, memo: null })));
	const result = (await client.query(`select private.accounting_post_journal_core(null, $1::uuid, $2::date, $3::text, $4::text[], 'auto fixture', $5::jsonb,
      $6::uuid, null, $7::text, $8::text) as r`, [periodId, input.date, input.kind, input.parts, lines, input.reversesEntryId ?? null,
		input.sourceTable ?? null, input.sourceId ?? null])).rows[0].r;
	return result.entry_id as string;
}

/** 2130 return_refund の貸方に amount 円を入れる（届いた日の仕訳の形。相手は 4020）。 */
export async function postPayableCredit(client: PgClient, orderId: string, amount: number, date: string, part: string = randomUUID()): Promise<string> {
	return postAutoEntry(client, { date, kind: 'return_arrived', parts: [part], lines: [
		{ account: '4020', debit: amount, orderId }, { account: '2130', credit: amount, sub: 'return_refund', orderId }] });
}

/** 返金の成功の仕訳（return_refund。2130 return_refund の借方 amount 円・相手は 1160）。date は仕訳の日。 */
export async function postRefundSuccess(client: PgClient, orderId: string, refundId: string, amount: number, date: string): Promise<string> {
	return postAutoEntry(client, { date, kind: 'return_refund', parts: [`txn_${refundId.replaceAll('-', '')}`], sourceTable: 'order_refunds', sourceId: refundId,
		lines: [{ account: '2130', debit: amount, sub: 'return_refund', orderId }, { account: '1160', credit: amount, orderId }] });
}

/** 同じ注文のもう1つの返品（申し込みだけ。number は注文の中の番号で、1は seedAutoOrder が使う）。返す物は returnId だけが違う AutoOrder。 */
export async function seedAnotherReturn(client: PgClient, o: AutoOrder, number: number): Promise<AutoOrder> {
	const returnId = (await client.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,$2,'customer_request','requested',$3,'auto-fixture',now(),$4,'customer_ships','customer',false) returning id`,
	[o.orderId, number, randomUUID(), o.actor])).rows[0].id as string;
	return { ...o, returnId };
}

/**
 * 売上 4010 に amount 円（相手は前受金 2150。注文つき）。売上の純額（4010 − 4020 + 4050）を円で読むための前提の仕訳。
 * 本物の出荷の仕訳と同じ種類 shipment_confirmed・同じ形（借 2150／貸 4010）で入れる。ほかの種類で入れると、売上の照合
 * （get_intake_reconciliation）の2段目が、4010 を数えて売上の種類を数えない差で狂う。
 */
export async function postSales(client: PgClient, orderId: string, amount: number, date: string): Promise<string> {
	return postAutoEntry(client, { date, kind: 'shipment_confirmed', parts: [randomUUID()], lines: [
		{ account: '2150', debit: amount, orderId }, { account: '4010', credit: amount, orderId }] });
}

/** 取り消しが引かれた時の仕訳（W。借 1470 dispute_pending S／貸 1160 S。1470 に注文は付かない）。 */
export async function postWithdrawal(client: PgClient, disputeId: string, txnId: string | null, amount: number, date: string): Promise<string> {
	return postAutoEntry(client, { date, kind: 'dispute_event', parts: [disputeId, 'withdrawn', txnId ?? 'none'], sourceTable: 'stripe_disputes', sourceId: disputeId,
		lines: [{ account: '1470', debit: amount, sub: 'dispute_pending' }, { account: '1160', credit: amount }] });
}

/**
 * 確定 C の仕訳（C の印 dispute_event:<dp>:confirmed:lost。日は負けた日）。pay は 2130 の相殺、review は 1470 dispute_refund_overlap_review、
 * rest は費用（7530）。貸方は 1470 dispute_pending の合計。
 */
export async function postConfirmed(client: PgClient, orderId: string, disputeId: string, date: string, parts: { pay: number; review?: number; rest?: number }): Promise<string> {
	const review = parts.review ?? 0;
	const rest = parts.rest ?? 0;
	const lines: AutoLine[] = [];
	if (rest > 0) lines.push({ account: '7530', debit: rest });
	if (parts.pay > 0) lines.push({ account: '2130', debit: parts.pay, sub: 'return_refund', orderId });
	if (review > 0) lines.push({ account: '1470', debit: review, sub: 'dispute_refund_overlap_review', orderId });
	lines.push({ account: '1470', credit: parts.pay + review + rest, sub: 'dispute_pending' });
	return postAutoEntry(client, { date, kind: 'dispute_event', parts: [disputeId, 'confirmed', 'lost'], sourceTable: 'stripe_disputes', sourceId: disputeId, lines });
}
