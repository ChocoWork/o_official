/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, decideRefund, orderBalance, orderLines, postRefundEvents, receiveReturn, recordRefundResult, saveFailureTxn,
  saveRefundTxn, seedCancelRefund, seedReturnArrivalEntries, seedReturnFlow, seedSlotPaidOrder, settleOwed,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 6（S20）: 返金の仕訳の額は届く順と係の流れる回数によらない（FREQ-579-AC-05・AC-06）。
// 表の「受注高から引く額（日）」は計画2の読み口（list_order_intake_events）で確かめる。引かれた後の失敗・借りの仕訳（refund_failed）を
// 受注高に足し戻すのは計画3 Task 9 の読み口の直しなので、2・3・6・16 の行はそこで確かめる（ここでは intake を書かない）。
jest.setTimeout(600000);

type Step = { id: string; after?: string[]; run: () => Promise<unknown> };
/** intake: 受注高の出来事（list_order_intake_events の支払い以外）の [日, 額]。undefined は計画3 Task 9 の読み口の直しを待つ行。 */
type Expect = { owedPre: number; d2150: number; d1160: number; d1040: number; entries: number; undecided?: number; intake?: Array<[string, number]> };

/** 依存（after）を守る並べ方をすべて返す。 */
function orders(steps: Step[]): Step[][] {
  const out: Step[][] = [];
  const walk = (done: Step[], left: Step[]) => {
    if (left.length === 0) { out.push(done); return; }
    for (const s of left) {
      if ((s.after ?? []).every((id) => done.some((d) => d.id === id))) walk([...done, s], left.filter((x) => x !== s));
    }
  };
  walk([], steps);
  return out;
}

describeLocalDb('FREQ-579-AC-06: S20 refund entries do not depend on the order of arrival', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const post = () => postRefundEvents(db());
  const entryIds = async (orderId: string) => new Set((await orderLines(db(), orderId)).filter((l) => l.event_kind !== 'payment_confirmed').map((l) => l.entry_id));
  async function snapshot(orderId: string) {
    return {
      owedPre: await orderBalance(db(), orderId, '2130', 'refund_owed_pre'),
      b2150: await orderBalance(db(), orderId, '2150'),
      b1160: -(await orderBalance(db(), orderId, '1160')),
      b1040: -(await orderBalance(db(), orderId, '1040')),
    };
  }
  /** steps のすべての並べ方を、途中で流す・最後にまとめて流すの両方で試し、最後の残高と仕訳の本数を確かめる。 */
  async function everyOrder(orderId: string, steps: Step[], expected: Expect, extra?: () => Promise<void>) {
    const base = await snapshot(orderId);
    const baseEntries = (await entryIds(orderId)).size;
    const all = orders(steps);
    expect(all.length).toBeGreaterThan(0);
    for (const order of all) {
      for (const mode of ['each', 'end'] as const) {
        await q('savepoint s20_order');
        for (const step of order) {
          try { await step.run(); } catch (e) { throw new Error(`${order.map((x) => x.id).join('>')} ${mode} at ${step.id}: ${(e as Error).message}`); }
          if (mode === 'each') await post();
        }
        for (let i = 0; i < 4; i += 1) await post();
        const now = await snapshot(orderId);
        const label = `${order.map((s) => s.id).join('>')} ${mode}`;
        expect([label, now.owedPre, now.b2150 - base.b2150, now.b1160 - base.b1160, now.b1040 - base.b1040, (await entryIds(orderId)).size - baseEntries])
          .toEqual([label, expected.owedPre, expected.d2150, expected.d1160, expected.d1040, expected.entries]);
        if (expected.intake !== undefined) {
          const events = ((await q('select public.list_order_intake_events($1::date, $2::date, 5000) as r', ['2026-01-01', '2026-12-31'])).rows[0].r as {
            events: Array<{ order_id: string; event_date: string; kind: string; amount: number }> }).events
            .filter((e) => e.order_id === orderId && e.kind !== 'payment');
          expect([label, events.map((e) => [e.event_date, e.kind === 'pre_shipment_cancel' ? e.amount : `${e.kind}:${e.amount}`])]).toEqual([label, expected.intake]);
        }
        if (expected.undecided !== undefined) {
          expect((await q("select count(*)::int n from public.accounting_pending_events where order_id=$1 and reason='refund_cancel_undecided' and resolved_at is null",
            [orderId])).rows[0].n).toBe(expected.undecided);
        }
        if (extra) await extra();
        await q('rollback to savepoint s20_order');
      }
    }
  }

  /** 注文 30,000円（シャツ 18,750円・パンツ 11,250円、支払いの仕訳あり）と、パンツの出荷前の返金 A（11,250円）。 */
  async function shirtPants() {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt, pants] = o.orderItemIds;
    const a = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: pants, before: true, amount: 11250 }]);
    return { orderId: o.orderId, shirt, pants, a };
  }
  const admin = async () => insertAccountingAdmin(db());
  /** 人の操作（振込・結び）は画面が仕訳の後に出すので、操作の前に係を流す。 */
  const bank = (actor: () => string, orderId: string, amount: number) => async () => {
    await post();
    await bankTransfer(db(), { actor: actor(), orderId, origin: 'pre_shipment', amount, on: '2026-11-12', txn: `AC06-${randomUUID().slice(0, 8)}` });
  };
  const settle = (actor: () => string, owed: () => string, paying: () => string) => async () => {
    await post();
    await settleOwed(db(), actor(), owed(), paying());
  };
  const success = (id: () => string, at = '2026-11-05T03:00:00Z') => [
    { id: 'txn', run: () => saveRefundTxn(db(), id(), { at }) },
    { id: 'succ', run: () => recordRefundResult(db(), id(), 'succeeded') },
  ];

  test('FREQ-579-AC-06: 届く順をすべて試して最後の残高と各仕訳の額が同じ', async () => {
    const actorId = await admin();
    const actor = () => actorId;
    const cases: Array<[string, () => Promise<{ orderId: string; steps: Step[]; expected: Expect }>]> = [
      ['1. 成功のみ', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: success(() => o.a), expected: { owedPre: 0, d2150: -11250, d1160: -11250, d1040: 0, entries: 1, intake: [['2026-11-05', -11250]] } };
      }],
      ['2. 引かれた後に失敗', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [...success(() => o.a),
          { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' }) },
          { id: 'fail', after: ['succ'], run: () => recordRefundResult(db(), o.a, 'failed') }],
        expected: { owedPre: 11250, d2150: -11250, d1160: 0, d1040: 0, entries: 2 } };
      }],
      ['3. 2 の後に振込で全額', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [...success(() => o.a),
          { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' }) },
          { id: 'fail', after: ['succ'], run: () => recordRefundResult(db(), o.a, 'failed') },
          { id: 'bank', after: ['fail', 'ftxn'], run: bank(actor, o.orderId, 11250) }],
        expected: { owedPre: 0, d2150: -11250, d1160: 0, d1040: -11250, entries: 3 } };
      }],
      ['4. 引かれる前に失敗', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [{ id: 'fail', run: () => recordRefundResult(db(), o.a, 'failed') }],
          expected: { owedPre: 11250, d2150: -11250, d1160: 0, d1040: 0, entries: 1, intake: [] } };
      }],
      ['5. 4 の後に再試行が成功し結ぶ', async () => {
        const o = await shirtPants();
        let retry = '';
        return { orderId: o.orderId, steps: [
          { id: 'fail', run: () => recordRefundResult(db(), o.a, 'failed') },
          { id: 'retry', after: ['fail'], run: async () => { retry = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.pants, before: true, amount: 11250 }]); } },
          { id: 'rtxn', after: ['retry'], run: () => saveRefundTxn(db(), retry, { at: '2026-11-08T03:00:00Z' }) },
          { id: 'rsucc', after: ['retry'], run: () => recordRefundResult(db(), retry, 'succeeded') },
          { id: 'settle', after: ['rtxn', 'rsucc'], run: settle(actor, () => o.a, () => retry) }],
        expected: { owedPre: 0, d2150: -11250, d1160: -11250, d1040: 0, entries: 3, intake: [['2026-11-08', -11250]] } };
      }],
      ['6. 引かれた後に Stripe が取り消し → 返すつもり', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [...success(() => o.a),
          { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' }) },
          { id: 'cancel', after: ['succ'], run: () => recordRefundResult(db(), o.a, 'canceled') },
          { id: 'owed', after: ['cancel'], run: () => decideRefund(db(), o.a, 'owed', actorId) }],
        expected: { owedPre: 11250, d2150: -11250, d1160: 0, d1040: 0, entries: 2 } };
      }],
      ['7. 引かれた後に Stripe が取り消し → やめた', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [...success(() => o.a),
          { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' }) },
          { id: 'cancel', after: ['succ'], run: () => recordRefundResult(db(), o.a, 'canceled') },
          { id: 'abandon', after: ['cancel'], run: () => decideRefund(db(), o.a, 'abandoned', actorId) }],
        expected: { owedPre: 0, d2150: 0, d1160: 0, d1040: 0, entries: 2, intake: [['2026-11-05', -11250], ['2026-11-07', 11250]] } };
      }],
      ['8. 引かれる前に Stripe が取り消し → やめた', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [
          { id: 'cancel', run: () => recordRefundResult(db(), o.a, 'canceled') },
          { id: 'abandon', after: ['cancel'], run: () => decideRefund(db(), o.a, 'abandoned', actorId) }],
        expected: { owedPre: 0, d2150: 0, d1160: 0, d1040: 0, entries: 0, intake: [] } };
      }],
      ['9. 取り消しのまま', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [{ id: 'cancel', run: () => recordRefundResult(db(), o.a, 'canceled') }],
          expected: { owedPre: 0, d2150: 0, d1160: 0, d1040: 0, entries: 0, undecided: 1, intake: [] } };
      }],
      ['10. 2つの返金', async () => {
        const o = await shirtPants();
        const b = await seedCancelRefund(db(), o.orderId, null, 18750, [{ item: o.shirt, before: true, amount: 18750 }]);
        return { orderId: o.orderId, steps: [...success(() => o.a), { id: 'bfail', run: () => recordRefundResult(db(), b, 'failed') }],
          expected: { owedPre: 18750, d2150: -30000, d1160: -11250, d1040: 0, entries: 2, intake: [['2026-11-05', -11250]] } };
      }],
      ['11. error の返金が後で成功', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [{ id: 'error', run: () => q("select * from private.mark_order_refund_error($1,'timeout',false)", [o.a]) },
          { id: 'txn', run: () => saveRefundTxn(db(), o.a, { at: '2026-11-05T03:00:00Z' }) },
          { id: 'succ', after: ['error'], run: () => recordRefundResult(db(), o.a, 'succeeded') }],
        expected: { owedPre: 0, d2150: -11250, d1160: -11250, d1040: 0, entries: 1, intake: [['2026-11-05', -11250]] } };
      }],
      ['12. error の返金が後で failed', async () => {
        const o = await shirtPants();
        return { orderId: o.orderId, steps: [{ id: 'error', run: () => q("select * from private.mark_order_refund_error($1,'timeout',false)", [o.a]) },
          { id: 'fail', after: ['error'], run: () => recordRefundResult(db(), o.a, 'failed') }],
        expected: { owedPre: 11250, d2150: -11250, d1160: 0, d1040: 0, entries: 1, intake: [] } };
      }],
      ...[false, true].map((pulled): [string, () => Promise<{ orderId: string; steps: Step[]; expected: Expect }>] => [
        pulled ? '14. 返品の返金が引かれた後に失敗 → やり直し' : '13. 返品の返金が引かれる前に失敗 → やり直し', async () => {
          const flow = await seedReturnFlow(db(), {});
          const r = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
          await seedReturnArrivalEntries(db(), flow.returnId);
          const a = r.refund_id as string;
          let retry = '';
          const first: Step[] = pulled ? [...success(() => a),
            { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), a, { at: '2026-11-07T03:00:00Z' }) },
            { id: 'fail', after: ['succ'], run: () => recordRefundResult(db(), a, 'failed') }]
            : [{ id: 'fail', run: () => recordRefundResult(db(), a, 'failed') }];
          return { orderId: flow.f.orderId, steps: [...first,
            { id: 'retry', after: ['fail'], run: async () => {
              retry = (await q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [flow.returnId, flow.f.actor, randomUUID()])).rows[0].refund_id;
            } },
            { id: 'rtxn', after: ['retry'], run: () => saveRefundTxn(db(), retry, { at: '2026-11-09T03:00:00Z' }) },
            { id: 'rsucc', after: ['retry'], run: () => recordRefundResult(db(), retry, 'succeeded') }],
          // The arrival entry was booked before the steps; the table counts it.
          expected: { owedPre: 0, d2150: 0, d1160: -16875, d1040: 0, entries: pulled ? 3 : 1, intake: [] } };
        }]),
      ...[false, true].map((pulled): [string, () => Promise<{ orderId: string; steps: Step[]; expected: Expect }>] => [
        pulled ? '16. 1品の注文で引かれた後に失敗 → やり直し → 結ぶ' : '15. 1品の注文で引かれる前に失敗 → やり直し → 結ぶ', async () => {
          const o = await seedSlotPaidOrder(db(), [[10000]]);
          const [item] = o.orderItemIds;
          const a = await seedCancelRefund(db(), o.orderId, null, 10000, [{ item, before: true, amount: 10000 }]);
          let retry = '';
          const first: Step[] = pulled ? [...success(() => a),
            { id: 'ftxn', after: ['txn'], run: () => saveFailureTxn(db(), a, { at: '2026-11-07T03:00:00Z' }) },
            { id: 'fail', after: ['succ'], run: () => recordRefundResult(db(), a, 'failed') }]
            : [{ id: 'fail', run: () => recordRefundResult(db(), a, 'failed') }];
          return { orderId: o.orderId, steps: [...first,
            { id: 'retry', after: ['fail'], run: async () => { retry = await seedCancelRefund(db(), o.orderId, null, 10000, [{ item, before: true, amount: 10000 }]); } },
            { id: 'rtxn', after: ['retry'], run: () => saveRefundTxn(db(), retry, { at: '2026-11-09T03:00:00Z' }) },
            { id: 'rsucc', after: ['retry'], run: () => recordRefundResult(db(), retry, 'succeeded') },
            { id: 'settle', after: ['rtxn', 'rsucc', ...(pulled ? ['ftxn'] : [])], run: settle(actor, () => a, () => retry) }],
          expected: { owedPre: 0, d2150: -10000, d1160: -10000, d1040: 0, entries: pulled ? 4 : 3, intake: pulled ? undefined : [['2026-11-09', -10000]] } };
        }]),
    ];
    for (const [name, build] of cases) {
      await q('savepoint s20_case');
      const c = await build();
      const extra = name.startsWith('13') || name.startsWith('14') ? async () => {
        expect([name, await orderBalance(db(), c.orderId, '2130', 'return_refund'), -(await orderBalance(db(), c.orderId, '4020'))]).toEqual([name, 0, 18750]);
      } : undefined;
      await everyOrder(c.orderId, c.steps, c.expected, extra);
      await q('rollback to savepoint s20_case');
    }
  });

  test('FREQ-579-AC-05: 同じ注文の2つの返金は、入る順が入れ替わっても各仕訳の額が同じ（他の返金の残高を読まない）', async () => {
    const o = await shirtPants();
    const b = await seedCancelRefund(db(), o.orderId, null, 18750, [{ item: o.shirt, before: true, amount: 18750 }]);
    const amounts = async () => (await orderLines(db(), o.orderId)).filter((l) => l.event_kind === 'pre_shipment_refund')
      .map((l) => [l.source_id, l.account_code, l.debit, l.credit]).sort();
    const results: unknown[] = [];
    for (const first of [o.a, b]) {
      await q('savepoint s20_swap');
      const second = first === o.a ? b : o.a;
      await saveRefundTxn(db(), first, { at: '2026-11-05T03:00:00Z' });
      await recordRefundResult(db(), first, 'succeeded');
      await post();
      await saveRefundTxn(db(), second, { at: '2026-11-06T03:00:00Z' });
      await recordRefundResult(db(), second, 'succeeded');
      await post();
      results.push(await amounts());
      await q('rollback to savepoint s20_swap');
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual([[o.a, '1160', 0, 11250], [o.a, '2150', 11250, 0], [b, '1160', 0, 18750], [b, '2150', 18750, 0]].sort());
  });

  test('FREQ-579-AC-05: 結びの操作は元の返金の借りのうち結んでいない額とやり直しの返金の額の小さい方だけを戻し、2回目は何も足さない', async () => {
    const actorId = await admin();
    const o = await shirtPants();
    await recordRefundResult(db(), o.a, 'failed');
    await post();
    // The retry pays less than the debt (a part of the pants), then a second retry pays the rest.
    const part = await seedCancelRefund(db(), o.orderId, null, 4000, [{ item: o.pants, before: true, amount: 4000 }]);
    await saveRefundTxn(db(), part, { at: '2026-11-08T03:00:00Z' });
    await recordRefundResult(db(), part, 'succeeded');
    await post();
    const key = randomUUID();
    const first = await settleOwed(db(), actorId, o.a, part, key);
    expect(first).toMatchObject({ pre_amount: 4000, post_amount: 0, replayed: false });
    expect(await orderBalance(db(), o.orderId, '2130', 'refund_owed_pre')).toBe(11250 - 4000);
    const count = async () => (await orderLines(db(), o.orderId)).length;
    const before = await count();
    expect(await settleOwed(db(), actorId, o.a, part, key)).toMatchObject({ settlement_id: first.settlement_id, pre_amount: 4000, replayed: true });
    expect(await settleOwed(db(), actorId, o.a, part)).toMatchObject({ settlement_id: first.settlement_id, replayed: true });
    expect(await count()).toBe(before);
    const rest = await seedCancelRefund(db(), o.orderId, null, 11250);
    await saveRefundTxn(db(), rest, { at: '2026-11-09T03:00:00Z' });
    await recordRefundResult(db(), rest, 'succeeded');
    await post();
    expect(await settleOwed(db(), actorId, o.a, rest)).toMatchObject({ pre_amount: 11250 - 4000, replayed: false });
    expect(await orderBalance(db(), o.orderId, '2130', 'refund_owed_pre')).toBe(0);
  });
});
