import { idOf, iso, requiredApi, saveBalanceTransaction, type StripeObject } from './accounting-sync';
import type {
  StripeAccountingDatabase,
  StripeDisputeEventInput,
  StripeDisputeInput,
} from './accounting-types';

/**
 * カード会社からの支払いの取り消し（Stripe の dispute）の取り込み（FREQ-567。会計の計画2 Task 5）。
 * 知らせ（charge.dispute.*）と毎晩の再照合が、同じ道を通る。知らせの中身は合図にだけ使い、Stripe から取り直した今の状態を保存する。
 * 仕訳は作らない（仕訳は Task 6 の係が表を読んで作る）。
 */

type RetrieveApi = { retrieve(id: string): Promise<StripeObject> };
type ListResult = AsyncIterable<StripeObject> | Iterable<StripeObject>;
export type StripeDisputeClient = {
  disputes?: RetrieveApi;
  balanceTransactions?: RetrieveApi;
  events?: { list(params: { type: string; created: { gte: number }; limit: number }): ListResult };
};

/** 毎晩の再照合が履歴に残す知らせの種類（履歴の stripe_event_id は `reconcile:<dispute の番号>:<状態>`） */
export const DISPUTE_RECONCILE_EVENT_TYPE = 'reconcile';

/** Stripe の出来事の一覧を探す件数の上限（100件ずつ最大5ページ） */
const MAX_EVENT_SCAN = 500;

/**
 * dispute が決着（lost）した時の Stripe 側の出来事の時刻を、出来事の一覧（Stripe が残す30日の中）から探す。
 * charge.dispute.closed のうち、その dispute で、中身の状態が lost の物。500件（100件ずつ5ページ）で見つからなければ null。
 */
async function findLostEventCreated(
  stripe: StripeDisputeClient,
  disputeId: string,
  disputeCreated: number,
): Promise<string | null> {
  if (!stripe.events) return null;
  let scanned = 0;
  for await (const event of stripe.events.list({ type: 'charge.dispute.closed', created: { gte: disputeCreated }, limit: 100 })) {
    scanned += 1;
    const object = (event.data as { object?: StripeObject } | undefined)?.object;
    if (object?.id === disputeId && object?.status === 'lost') return iso(event.created);
    if (scanned >= MAX_EVENT_SCAN) break;
  }
  return null;
}

export async function syncDisputeAccounting(input: {
  stripe: StripeDisputeClient;
  database: StripeAccountingDatabase;
  disputeId: string;
  /** 知らせの番号。毎晩の再照合は null（履歴の番号は `reconcile:<dispute>:<状態>` にする） */
  eventId: string | null;
  /** 知らせの種類。毎晩の再照合は DISPUTE_RECONCILE_EVENT_TYPE */
  eventType: string;
  /** 知らせの created（Stripe の時刻。エポック秒） */
  eventCreated: number | null;
  /** 知らせの中身（event.data.object）の状態。lost の知らせだけが stripe_event_created_at を残す */
  eventObjectStatus: string | null;
  now?: () => Date;
}): Promise<{ disposition: 'inserted' | 'unchanged' }> {
  const { stripe, database } = input;
  if (!database.recordDispute) throw new Error('Stripe accounting database cannot record disputes');

  // ① 知らせの中身でなく、Stripe の今の状態を正とする。取り直せなければ何も保存せず投げる（知らせの再試行に任せる）。
  const dispute = await requiredApi(stripe.disputes, 'Dispute').retrieve(input.disputeId);
  // 取り直した時刻。DB は、これより新しく取り直した状態を古い取り直しで上書きしない
  // （2つの worker が同じ dispute を同時に処理しても、最後に取り直した状態が表に残る）
  const retrievedAt = (input.now ?? (() => new Date()))().toISOString();
  const id = String(dispute.id);
  const status = String(dispute.status);
  const createdAt = iso(dispute.created);
  if (!createdAt) throw new Error('Stripe Dispute has no created timestamp');
  const paymentIntentId = idOf(dispute.payment_intent);

  // ② 注文に結び付け、引かれた分・戻った分の残高の取引を保存する。結び付く注文が無くても保存する。
  let orderId: string | null = null;
  if (paymentIntentId) {
    if (!database.findOrderByPaymentIntent) throw new Error('Stripe accounting database cannot resolve orders');
    orderId = (await database.findOrderByPaymentIntent(paymentIntentId))?.id ?? null;
  }
  const balanceTransactionIds: string[] = [];
  for (const item of Array.isArray(dispute.balance_transactions) ? dispute.balance_transactions : []) {
    const transaction = typeof item === 'string'
      ? await requiredApi(stripe.balanceTransactions, 'BalanceTransaction').retrieve(item)
      : (item as StripeObject);
    balanceTransactionIds.push(String(transaction.id));
    // 入金の同期が付けた payout_id は消さない
    const existing = await database.findById('stripe_balance_transactions', String(transaction.id));
    await saveBalanceTransaction({
      database,
      transaction,
      paymentIntentId,
      orderId,
      payoutId: typeof existing?.payout_id === 'string' ? existing.payout_id : null,
      syncedAt: retrievedAt,
    });
  }

  // ③ dispute と履歴を保存する。
  const evidenceDetails = (dispute.evidence_details ?? {}) as StripeObject;
  const disputeInput: StripeDisputeInput = {
    id,
    paymentIntentId,
    chargeId: idOf(dispute.charge),
    orderId,
    amount: Number(dispute.amount),
    currency: String(dispute.currency).toLowerCase(),
    reason: String(dispute.reason),
    status,
    isChargeRefundable: typeof dispute.is_charge_refundable === 'boolean' ? dispute.is_charge_refundable : null,
    evidenceDueBy: iso(evidenceDetails.due_by),
    evidenceDetails,
    stripeCreatedAt: createdAt,
    syncedAt: retrievedAt,
  };

  let event: StripeDisputeEventInput | null;
  if (input.eventType === DISPUTE_RECONCILE_EVENT_TYPE) {
    // 表にある最新の状態と同じなら履歴を足さない（知らせの行がある状態も同じ）。可変の欄の更新だけは通す。
    const knownStatus = database.findDisputeStatus ? await database.findDisputeStatus(id) : null;
    const reconcileEvent = (stripeEventId: string, stripeEventCreatedAt: string | null): StripeDisputeEventInput => ({
      stripeEventId,
      eventType: input.eventType,
      status,
      occurredAt: retrievedAt,
      stripeEventCreatedAt,
      balanceTransactionIds,
      rawPayload: dispute,
    });
    if (knownStatus !== status) {
      event = reconcileEvent(
        `reconcile:${id}:${status}`,
        status === 'lost' ? await findLostEventCreated(stripe, id, Number(dispute.created)) : null,
      );
    } else if (status === 'lost' && database.hasLostEventTime && !(await database.hasLostEventTime(id))) {
      // 表はすでに lost だが、lost の履歴に Stripe 側の時刻が無い（遅れて処理した知らせで lost になり、closed の知らせが届かなかった時など）。
      // Stripe が出来事を残す30日の間は、出来事の一覧から拾って時刻つきの行を足す。見つからなければ行は足さない。
      const lostCreated = await findLostEventCreated(stripe, id, Number(dispute.created));
      event = lostCreated ? reconcileEvent(`reconcile:${id}:lost:event_time`, lostCreated) : null;
    } else {
      event = null;
    }
  } else {
    if (!input.eventId) throw new Error('A dispute notification needs its event id');
    event = {
      stripeEventId: input.eventId,
      eventType: input.eventType,
      status,
      occurredAt: retrievedAt,
      // 知らせの中身の状態が lost の時だけ。遅れて処理した前の知らせは、取り直した状態が lost でも NULL
      stripeEventCreatedAt: input.eventObjectStatus === 'lost' ? iso(input.eventCreated) : null,
      balanceTransactionIds,
      rawPayload: dispute,
    };
  }

  const stored = await database.recordDispute(disputeInput, event);
  return { disposition: stored.eventInserted ? 'inserted' : 'unchanged' };
}
