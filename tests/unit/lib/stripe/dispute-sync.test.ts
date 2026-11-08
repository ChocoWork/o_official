import { syncDisputeAccounting } from '@/lib/stripe/dispute-sync';
import type {
  StripeAccountingDatabase,
  StripeDisputeEventInput,
  StripeDisputeInput,
} from '@/lib/stripe/accounting-types';

type Obj = Record<string, unknown>;

const CREATED = 1781049600; // 2026-06-10T00:00:00Z
const EVENT_CREATED = 1782000000;

function balanceTransaction(id: string, amount: number, category: 'dispute' | 'dispute_reversal'): Obj {
  return {
    id, object: 'balance_transaction', source: 'dp_1', type: 'adjustment', reporting_category: category,
    amount, fee: category === 'dispute' ? 1500 : 0, net: amount - (category === 'dispute' ? 1500 : 0), currency: 'jpy',
    status: 'available', available_on: CREATED + 86400, created: CREATED + 60, fee_details: [],
  };
}

function disputeObject(overrides: Obj = {}): Obj {
  return {
    id: 'dp_1', object: 'dispute', amount: 5000, currency: 'jpy', reason: 'fraudulent', status: 'needs_response',
    is_charge_refundable: false, charge: 'ch_1', payment_intent: 'pi_1', created: CREATED,
    evidence_details: { due_by: CREATED + 7 * 86400, has_evidence: false, past_due: false, submission_count: 0 },
    evidence: { customer_name: 'dummy', product_description: 'dummy' },
    balance_transactions: [balanceTransaction('txn_w', -5000, 'dispute')],
    ...overrides,
  };
}

function makeDatabase(options: { order?: { id: string; currency: string } | null; knownStatus?: string | null; lostTimeKnown?: boolean } = {}) {
  const balanceRows = new Map<string, Obj>();
  const recorded: Array<{ dispute: StripeDisputeInput; event: StripeDisputeEventInput | null }> = [];
  const events = new Set<string>();
  let status: string | null = options.knownStatus ?? null;
  const database: StripeAccountingDatabase = {
    findOrderByPaymentIntent: jest.fn(async () => (options.order === undefined ? { id: 'order-1', currency: 'jpy' } : options.order)),
    findById: jest.fn(async (_table, id) => balanceRows.get(id) ?? null),
    insert: jest.fn(async (_table, values) => { balanceRows.set(String(values.id), values); return values; }),
    updateById: jest.fn(async (_table, id, values) => {
      const next = { ...(balanceRows.get(id) ?? {}), ...values };
      balanceRows.set(id, next);
      return next;
    }),
    findDisputeStatus: jest.fn(async () => status),
    hasLostEventTime: jest.fn(async () => options.lostTimeKnown ?? false),
    recordDispute: jest.fn(async (dispute, event) => {
      recorded.push({ dispute, event });
      status = dispute.status;
      const inserted = event !== null && !events.has(event.stripeEventId);
      if (event) events.add(event.stripeEventId);
      return { disputeId: dispute.id, eventInserted: inserted };
    }),
  };
  return { database, balanceRows, recorded };
}

function makeStripe(dispute: Obj | (() => Promise<Obj>), eventPages: Obj[][] = []) {
  const retrieve = jest.fn(async () => (typeof dispute === 'function' ? dispute() : dispute));
  const eventList = jest.fn(() => (async function* () { for (const page of eventPages) for (const event of page) yield event; })());
  return {
    stripe: {
      disputes: { retrieve },
      balanceTransactions: { retrieve: jest.fn(async (id: string) => balanceTransaction(id, 0, 'dispute_reversal')) },
      events: { list: eventList },
    },
    retrieve,
    eventList,
  };
}

const WEBHOOK_TYPES = [
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
  'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated',
] as const;

const webhookInput = (type: string, overrides: Obj = {}) => ({
  disputeId: 'dp_1', eventId: `evt_${type}`, eventType: type, eventCreated: EVENT_CREATED, eventObjectStatus: 'needs_response' as string | null,
  ...overrides,
});

describe('syncDisputeAccounting（charge.dispute の知らせ）', () => {
  it.each(WEBHOOK_TYPES)('FREQ-567-AC-01: charge.dispute の5種を処理するとdisputeの表と履歴と残高の取引が保存され、注文が結び付く（%s）', async (type) => {
    const { database, balanceRows, recorded } = makeDatabase();
    const { stripe, retrieve } = makeStripe(disputeObject({
      balance_transactions: [balanceTransaction('txn_w', -5000, 'dispute'), balanceTransaction('txn_r', 5000, 'dispute_reversal')],
    }));

    const result = await syncDisputeAccounting({ stripe, database, ...webhookInput(type) });

    expect(result).toEqual({ disposition: 'inserted' });
    // 知らせの中身でなく、Stripe の今の状態を取り直す
    expect(retrieve).toHaveBeenCalledWith('dp_1');
    expect(database.findOrderByPaymentIntent).toHaveBeenCalledWith('pi_1');
    expect([...balanceRows.keys()].sort()).toEqual(['txn_r', 'txn_w']);
    expect(balanceRows.get('txn_w')).toMatchObject({
      payment_intent_id: 'pi_1', order_id: 'order-1', source_id: 'dp_1', reporting_category: 'dispute', amount: -5000, fee: 1500, net: -6500, payout_id: null,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].dispute).toEqual({
      id: 'dp_1', paymentIntentId: 'pi_1', chargeId: 'ch_1', orderId: 'order-1', amount: 5000, currency: 'jpy', reason: 'fraudulent',
      status: 'needs_response', isChargeRefundable: false, evidenceDueBy: new Date((CREATED + 7 * 86400) * 1000).toISOString(),
      evidenceDetails: { due_by: CREATED + 7 * 86400, has_evidence: false, past_due: false, submission_count: 0 },
      stripeCreatedAt: new Date(CREATED * 1000).toISOString(),
      syncedAt: expect.any(String),
    });
    expect(recorded[0].event).toMatchObject({
      stripeEventId: `evt_${type}`, eventType: type, status: 'needs_response', balanceTransactionIds: ['txn_w', 'txn_r'],
      stripeEventCreatedAt: null,
    });
    // 原因・期限・資料の写しは、その時点の dispute のまま履歴に残る
    expect(recorded[0].event?.rawPayload).toMatchObject({ id: 'dp_1', reason: 'fraudulent', evidence: { customer_name: 'dummy' } });
    expect(typeof recorded[0].event?.occurredAt).toBe('string');
  });

  it('FREQ-567-AC-02: 取り直した時刻を、dispute にも履歴にも残高の取引にも同じ値で渡す（DB が古い取り直しの上書きを断つ）', async () => {
    const { database, balanceRows, recorded } = makeDatabase();
    const { stripe } = makeStripe(disputeObject());
    const now = () => new Date('2026-06-10T00:20:00.000Z');

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created'), now });

    expect(recorded[0].dispute.syncedAt).toBe('2026-06-10T00:20:00.000Z');
    expect(recorded[0].event?.occurredAt).toBe('2026-06-10T00:20:00.000Z');
    expect(balanceRows.get('txn_w')?.synced_at).toBe('2026-06-10T00:20:00.000Z');
  });

  it('FREQ-567-AC-01: 支払いに結び付く注文が無い取り消しも保存し order_id はNULL', async () => {
    const { database, balanceRows, recorded } = makeDatabase({ order: null });
    const { stripe } = makeStripe(disputeObject());

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') });

    expect(recorded[0].dispute.orderId).toBeNull();
    expect(balanceRows.get('txn_w')).toMatchObject({ order_id: null, payment_intent_id: 'pi_1' });
  });

  it('FREQ-567-AC-01: 支払いの番号が無い取り消しは注文を探さず、order_id も payment_intent_id もNULLで保存する', async () => {
    const { database, recorded } = makeDatabase();
    const { stripe } = makeStripe(disputeObject({ payment_intent: null }));

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') });

    expect(database.findOrderByPaymentIntent).not.toHaveBeenCalled();
    expect(recorded[0].dispute).toMatchObject({ orderId: null, paymentIntentId: null, chargeId: 'ch_1' });
  });

  it('FREQ-567-AC-01: 残高の取引が文字列の番号なら取り直して保存する。入金に入った印（payout_id）は消さない', async () => {
    const { database, balanceRows } = makeDatabase();
    balanceRows.set('txn_w', { id: 'txn_w', payout_id: 'po_1', source_id: 'dp_1', amount: -5000, fee: 1500, net: -6500, currency: 'jpy' });
    const { stripe } = makeStripe(disputeObject({ balance_transactions: [balanceTransaction('txn_w', -5000, 'dispute'), 'txn_str'] }));

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.updated') });

    expect(stripe.balanceTransactions.retrieve).toHaveBeenCalledWith('txn_str');
    expect(balanceRows.get('txn_w')?.payout_id).toBe('po_1');
    expect(balanceRows.has('txn_str')).toBe(true);
  });

  it('FREQ-567-AC-03: 中身の状態がlostでない知らせは、取り直した状態がlostでもstripe_event_created_atがNULL', async () => {
    const { database, recorded } = makeDatabase();
    const { stripe } = makeStripe(disputeObject({ status: 'lost' }));

    // 遅れて処理した前の charge.dispute.updated（知らせの中身の状態は under_review）
    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.updated', { eventObjectStatus: 'under_review' }) });
    expect(recorded[0].event).toMatchObject({ status: 'lost', stripeEventCreatedAt: null });

    // 中身の状態が分からない知らせも同じ
    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.funds_withdrawn', { eventObjectStatus: null }) });
    expect(recorded[1].event?.stripeEventCreatedAt).toBeNull();
  });

  it('FREQ-567-AC-03: 中身の状態がlostの知らせは、Stripe の知らせの時刻を stripe_event_created_at に残す', async () => {
    const { database, recorded } = makeDatabase();
    const { stripe } = makeStripe(disputeObject({ status: 'lost' }));

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.closed', { eventObjectStatus: 'lost' }) });

    expect(recorded[0].event).toMatchObject({ status: 'lost', stripeEventCreatedAt: new Date(EVENT_CREATED * 1000).toISOString() });
  });

  it('FREQ-567-AC-02: 同じ知らせの2回目は履歴の行を増やさない（unchanged）', async () => {
    const { database } = makeDatabase();
    const { stripe } = makeStripe(disputeObject());

    expect(await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') })).toEqual({ disposition: 'inserted' });
    expect(await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') })).toEqual({ disposition: 'unchanged' });
  });

  it('FREQ-567-AC-02: 知らせが前後して届いても、Stripe から取り直した最後の状態が表に残る', async () => {
    const { database, recorded } = makeDatabase();
    // Stripe の今の状態は won。closed の知らせが created の知らせより先に処理される
    const { stripe } = makeStripe(disputeObject({ status: 'won' }));

    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.closed', { eventObjectStatus: 'won' }) });
    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created', { eventObjectStatus: 'needs_response' }) });

    expect(recorded.map((entry) => entry.dispute.status)).toEqual(['won', 'won']);
    expect(recorded.map((entry) => entry.event?.status)).toEqual(['won', 'won']);
    expect(await database.findDisputeStatus!('dp_1')).toBe('won');
  });

  it('FREQ-567-AC-02: 取り直しが失敗したら例外を投げて何も保存しない', async () => {
    const { database, balanceRows, recorded } = makeDatabase();
    const { stripe } = makeStripe(async () => { throw new Error('stripe_down'); });

    await expect(syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') })).rejects.toThrow('stripe_down');
    expect(recorded).toHaveLength(0);
    expect(balanceRows.size).toBe(0);
    expect(database.recordDispute).not.toHaveBeenCalled();
  });

  it('FREQ-567-AC-02: 保存が失敗したら握りつぶさず投げる（知らせの再試行に任せる）', async () => {
    const { database } = makeDatabase();
    (database.recordDispute as jest.Mock).mockRejectedValueOnce(new Error('rpc_failed'));
    const { stripe } = makeStripe(disputeObject());

    await expect(syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.created') })).rejects.toThrow('rpc_failed');
  });
});

describe('syncDisputeAccounting（毎晩の再照合）', () => {
  const reconcileInput = { disputeId: 'dp_1', eventId: null, eventType: 'reconcile', eventCreated: null, eventObjectStatus: null };

  it('FREQ-567-AC-04: 表に無い dispute は reconcile:<番号>:<状態> の履歴で保存する', async () => {
    const { database, recorded } = makeDatabase({ knownStatus: null });
    const { stripe, eventList } = makeStripe(disputeObject());

    expect(await syncDisputeAccounting({ stripe, database, ...reconcileInput })).toEqual({ disposition: 'inserted' });

    expect(recorded[0].event).toMatchObject({
      stripeEventId: 'reconcile:dp_1:needs_response', eventType: 'reconcile', status: 'needs_response', stripeEventCreatedAt: null,
    });
    expect(eventList).not.toHaveBeenCalled();
  });

  it('FREQ-567-AC-04: 状態が同じ夜は履歴を足さない。可変の欄の更新だけは通す', async () => {
    const { database, recorded } = makeDatabase({ knownStatus: 'needs_response' });
    const { stripe } = makeStripe(disputeObject());

    expect(await syncDisputeAccounting({ stripe, database, ...reconcileInput })).toEqual({ disposition: 'unchanged' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].event).toBeNull();
    expect(recorded[0].dispute.status).toBe('needs_response');
  });

  it('FREQ-567-AC-02: 知らせの行がある状態は、再照合が履歴を足さない', async () => {
    const { database, recorded } = makeDatabase();
    const { stripe } = makeStripe(disputeObject({ status: 'under_review' }));

    // 知らせで under_review が入る
    await syncDisputeAccounting({ stripe, database, ...webhookInput('charge.dispute.updated', { eventObjectStatus: 'under_review' }) });
    // 同じ夜の再照合
    const result = await syncDisputeAccounting({ stripe, database, ...reconcileInput });

    expect(result).toEqual({ disposition: 'unchanged' });
    expect(recorded.map((entry) => entry.event?.stripeEventId ?? null)).toEqual(['evt_charge.dispute.updated', null]);
  });

  it('FREQ-567-AC-04: 状態が変わっていた夜は、新しい状態の履歴を1行足す', async () => {
    const { database, recorded } = makeDatabase({ knownStatus: 'needs_response' });
    const { stripe } = makeStripe(disputeObject({ status: 'under_review' }));

    expect(await syncDisputeAccounting({ stripe, database, ...reconcileInput })).toEqual({ disposition: 'inserted' });
    expect(recorded[0].event?.stripeEventId).toBe('reconcile:dp_1:under_review');
  });

  describe('FREQ-567-AC-03: 知らせの行はStripeの知らせの時刻を、再照合のlostの行はStripeの出来事の一覧の時刻をstripe_event_created_atに残し、見つからなければNULL', () => {
    const closedEvent = (id: string, status: string, created: number): Obj => ({ id: `evt_${id}_${status}_${created}`, type: 'charge.dispute.closed', created, data: { object: { id, status } } });

    it('出来事の一覧は charge.dispute.closed を、dispute の作成から、100件ずつで読み、中身の状態が lost のその dispute の出来事の時刻を使う', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'under_review' });
      const { stripe, eventList } = makeStripe(disputeObject({ status: 'lost' }), [[
        closedEvent('dp_other', 'lost', 1700000001),
        closedEvent('dp_1', 'won', 1700000002),
        closedEvent('dp_1', 'lost', 1782100000),
      ]]);

      await syncDisputeAccounting({ stripe, database, ...reconcileInput });

      expect(eventList).toHaveBeenCalledWith({ type: 'charge.dispute.closed', created: { gte: CREATED }, limit: 100 });
      expect(recorded[0].event).toMatchObject({
        stripeEventId: 'reconcile:dp_1:lost', status: 'lost', stripeEventCreatedAt: new Date(1782100000 * 1000).toISOString(),
      });
    });

    it('一覧に無ければNULL', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'under_review' });
      const { stripe } = makeStripe(disputeObject({ status: 'lost' }), [[closedEvent('dp_other', 'lost', 1782100000)]]);

      await syncDisputeAccounting({ stripe, database, ...reconcileInput });

      expect(recorded[0].event?.stripeEventCreatedAt).toBeNull();
    });

    it('5ページ（500件）で見つからなければNULL。6ページ目より後は読まない', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'under_review' });
      const filler = Array.from({ length: 599 }, (_, index) => closedEvent('dp_other', 'lost', 1700000000 + index));
      const { stripe } = makeStripe(disputeObject({ status: 'lost' }), [[...filler, closedEvent('dp_1', 'lost', 1782100000)]]);
      let read = 0;
      stripe.events.list.mockImplementation(() => (async function* () {
        for (const event of [...filler, closedEvent('dp_1', 'lost', 1782100000)]) { read += 1; yield event; }
      })());

      await syncDisputeAccounting({ stripe, database, ...reconcileInput });

      expect(recorded[0].event?.stripeEventCreatedAt).toBeNull();
      expect(read).toBeLessThanOrEqual(501);
    });

    it('lost でない状態の再照合の行は一覧を読まず、時刻はNULL', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'needs_response' });
      const { stripe, eventList } = makeStripe(disputeObject({ status: 'won' }));

      await syncDisputeAccounting({ stripe, database, ...reconcileInput });

      expect(eventList).not.toHaveBeenCalled();
      expect(recorded[0].event?.stripeEventCreatedAt).toBeNull();
    });

    it('表が lost で、lost の履歴に Stripe 側の時刻が無い夜は、出来事の一覧から拾って時刻つきの行を足す', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'lost', lostTimeKnown: false });
      const { stripe, eventList } = makeStripe(disputeObject({ status: 'lost' }), [[closedEvent('dp_1', 'lost', 1782100000)]]);

      expect(await syncDisputeAccounting({ stripe, database, ...reconcileInput })).toEqual({ disposition: 'inserted' });

      expect(eventList).toHaveBeenCalledTimes(1);
      expect(recorded[0].event).toMatchObject({
        stripeEventId: 'reconcile:dp_1:lost:event_time', status: 'lost', stripeEventCreatedAt: new Date(1782100000 * 1000).toISOString(),
      });
    });

    it('表が lost で時刻が見つからない夜は行を足さない（可変の欄の更新だけ）。時刻がすでにある夜は一覧も読まない', async () => {
      const missing = makeDatabase({ knownStatus: 'lost', lostTimeKnown: false });
      const first = makeStripe(disputeObject({ status: 'lost' }), []);
      await syncDisputeAccounting({ stripe: first.stripe, database: missing.database, ...reconcileInput });
      expect(first.eventList).toHaveBeenCalledTimes(1);
      expect(missing.recorded[0].event).toBeNull();

      const known = makeDatabase({ knownStatus: 'lost', lostTimeKnown: true });
      const second = makeStripe(disputeObject({ status: 'lost' }), [[closedEvent('dp_1', 'lost', 1782100000)]]);
      await syncDisputeAccounting({ stripe: second.stripe, database: known.database, ...reconcileInput });
      expect(second.eventList).not.toHaveBeenCalled();
      expect(known.recorded[0].event).toBeNull();
    });

    it('履歴を足さない夜（状態が同じ lost で時刻もある）は一覧も読まない', async () => {
      const { database } = makeDatabase({ knownStatus: 'lost', lostTimeKnown: true });
      const { stripe, eventList } = makeStripe(disputeObject({ status: 'lost' }));

      await syncDisputeAccounting({ stripe, database, ...reconcileInput });

      expect(eventList).not.toHaveBeenCalled();
    });

    it('一覧を読めなければ投げる（保存せず、次の夜にやり直す）', async () => {
      const { database, recorded } = makeDatabase({ knownStatus: 'under_review' });
      const { stripe, eventList } = makeStripe(disputeObject({ status: 'lost' }));
      eventList.mockImplementation(() => { throw new Error('events_down'); });

      await expect(syncDisputeAccounting({ stripe, database, ...reconcileInput })).rejects.toThrow('events_down');
      expect(recorded).toHaveLength(0);
    });
  });
});
