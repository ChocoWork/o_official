/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  type InFlightShape, postAutoEntry, postConfirmed, postPayableCredit, postRefundSuccess, postSales, postWithdrawal, seedAnotherReturn, seedArrival,
  seedAutoOrder, seedLost, seedRefundInFlight, seedWithdrawn, seedZeroClose, setCreatedOn,
} from './helpers/accounting-pending-auto-fixtures';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import { accountingS27Section, failRefund, succeedRefund } from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画 S27 Task 1: 前の確かめ・途中の返金の関数・R の式の関数・返金の待ち（入れない決定は済み）。ROLLBACK の形（--runInBand）。
// 円は例ごとに決めた値で固定する（返品の計上係・取り消しの計上係の本体は Task 2 以降）。
jest.setTimeout(240000);

describeLocalDb('FREQ-643: S27 pending auto posting (Task 1)', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  /** 断られた時の { code, message, detail }（取引は savepoint で戻す）。断られなければ null。 */
  async function failure(run: () => Promise<unknown>) {
    await q('savepoint s27_failure');
    try { await run(); return null; } catch (e) {
      const { code, message, detail } = e as { code: string; message: string; detail?: string };
      return { code, message, detail };
    } finally { await q('rollback to savepoint s27_failure'); await q('release savepoint s27_failure'); }
  }

  const waitOf = async (refundId: string, step = 'success') => (await q('select private.accounting_refund_wait($1, $2) as w', [refundId, step])).rows[0].w as string | null;
  const inFlight = async (orderId: string, factId: string | null) => (await q(
    'select refund_id, excluded, post_shipment_amount from private.accounting_order_refunds_in_flight($1, $2) order by refund_id', [orderId, factId])).rows as
    Array<{ refund_id: string; excluded: boolean; post_shipment_amount: number }>;
  const payableOf = async (orderId: string, through: string | null) => Number((await q(
    'select private.accounting_order_return_payable($1, $2::date) as p', [orderId, through])).rows[0].p);
  /** 計上待ちの行を作って閉じる（resolved_entry_id が NULL なら入れない決定の閉じ方）。 */
  const park = (kind: string, table: string, sourceId: string, orderId: string, reason: string, detail: Record<string, unknown> = {}) => q(
    'select private.accounting_park_event($1, $2, $3, $4::uuid, $5, $6::jsonb)', [kind, table, sourceId, orderId, reason, JSON.stringify(detail)]);
  const unpark = (kind: string, table: string, sourceId: string, entryId: string | null) => q(
    'select private.accounting_unpark_event($1, $2, $3, $4::uuid)', [kind, table, sourceId, entryId]);
  const closeNoRevenue = async (orderId: string, factId: string, entryId: string | null = null) => {
    await park('return_amount_decided', 'accounting_return_facts', factId, orderId, 'no_revenue');
    await unpark('return_amount_decided', 'accounting_return_facts', factId, entryId);
  };

  // ---- AC-12: the precheck ------------------------------------------------------------------------------------------------
  describe('precheck', () => {
    const runPrecheck = () => q(accountingS27Section('PRECHECK'));
    const rowOf = async (reason: string, closed: 'open' | 'linked' | 'no_entry') => {
      const o = await seedAutoOrder(db(), [10000]);
      const sourceId = `pre-${reason}-${closed}-${o.orderId}`;
      await park('return_amount_decided', 'accounting_return_facts', sourceId, o.orderId, 'order_not_postable', { reason });
      if (closed === 'linked') {
        const admin = await insertAccountingAdmin(db());
        const entry = await postPayableCredit(db(), o.orderId, 100, '2026-11-05');
        await q(`update public.accounting_pending_events set resolved_at = now(), resolved_by = $2, resolved_entry_id = $3, resolution_note = 'fixture'
          where source_id = $1`, [sourceId, admin, entry]);
      } else if (closed === 'no_entry') {
        await unpark('return_amount_decided', 'accounting_return_facts', sourceId, null);
      }
    };

    test.each(['dispute_lost', 'return_closed_after_lost'])(
      'FREQ-643-AC-12: 閉じた %s の行（resolved_by と resolved_entry_id あり）が1件でもあれば S27 の前の確かめが ACCOUNTING_MIGRATION_ASSERTION_FAILED で止まる', async (reason) => {
        await rowOf(reason, 'linked');
        expect(await failure(runPrecheck)).toEqual({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail: 'acc_s27_precheck' });
      });

    test.each(['dispute_lost', 'return_closed_after_lost'])(
      'FREQ-643-AC-12: %s の開いた行だけなら前の確かめは通り、仕訳なしで閉じた行（resolved_entry_id なし）も止めない', async (reason) => {
        await rowOf(reason, 'open');
        expect(await failure(runPrecheck)).toBeNull();
        await rowOf(reason, 'no_entry');
        expect(await failure(runPrecheck)).toBeNull();
      });

    test('FREQ-643-AC-12: ほかの理由の閉じた行（結んで閉じた order_not_postable の別の reason）は前の確かめを止めない', async () => {
      await rowOf('units_missing', 'linked');
      expect(await failure(runPrecheck)).toBeNull();
    });
  });

  // ---- AC-06: the refund wait counts a decision closed with no entry as done ------------------------------------------------
  describe('refund wait', () => {
    /** 5,000円の決定（返金 R1。payable_delta = 5,000）が1つあり、決定の無い返金 R2 を待たせる注文。 */
    async function waiting() {
      const o = await seedAutoOrder(db(), [10000]);
      const r1 = await seedRefundInFlight(db(), o, 5000, ['requested'], { decided: 5000, covers: 0 });
      const r2 = await seedRefundInFlight(db(), o, 5000, ['requested']);
      return { o, d1: r1.decisionFactId as string, r2: r2.refundId };
    }

    test('FREQ-643-AC-06: 入れない決定（payable_delta ≠ 0 を no_revenue で閉じ、resolved_entry_id が NULL）は return_prior で済んだと数えられ、同じ返品の後の返金の待ちが NULL になる', async () => {
      const w = await waiting();
      expect(await waitOf(w.r2)).toBe('return_prior');
      await closeNoRevenue(w.o.orderId, w.d1);
      expect(await waitOf(w.r2)).toBeNull();
    });

    test('FREQ-643-AC-06: 開いた行・resolved_entry_id が NULL でない行・no_revenue でない閉じた行は、済みと数えない（待ちは return_prior のまま）', async () => {
      const w = await waiting();
      await park('return_amount_decided', 'accounting_return_facts', w.d1, w.o.orderId, 'no_revenue');
      expect(await waitOf(w.r2)).toBe('return_prior');
      await unpark('return_amount_decided', 'accounting_return_facts', w.d1, await postPayableCredit(db(), w.o.orderId, 100, '2026-11-05'));
      expect(await waitOf(w.r2)).toBe('return_prior');
      const other = await waiting();
      await park('return_amount_decided', 'accounting_return_facts', other.d1, other.o.orderId, 'before_cutover');
      await unpark('return_amount_decided', 'accounting_return_facts', other.d1, null);
      expect(await waitOf(other.r2)).toBe('return_prior');
    });

    test('FREQ-643-AC-06: 決定が2つあれば両方を閉じるまで待つ。別の決定の行や別の種類の行は数えない', async () => {
      const o = await seedAutoOrder(db(), [10000]);
      const a = await seedRefundInFlight(db(), o, 3000, ['requested'], { decided: 3000, covers: 0 });
      const b = await seedRefundInFlight(db(), o, 2000, ['requested'], { decided: 2000, covers: 0 });
      const r = await seedRefundInFlight(db(), o, 1000, ['requested']);
      await closeNoRevenue(o.orderId, a.decisionFactId as string);
      expect(await waitOf(r.refundId)).toBe('return_prior');
      await park('return_arrived', 'accounting_return_facts', b.decisionFactId as string, o.orderId, 'no_revenue');
      await unpark('return_arrived', 'accounting_return_facts', b.decisionFactId as string, null);
      expect(await waitOf(r.refundId)).toBe('return_prior');
      await closeNoRevenue(o.orderId, b.decisionFactId as string);
      expect(await waitOf(r.refundId)).toBeNull();
    });

    test('FREQ-643-AC-06: 今ある no_revenue（payable_delta = 0 の決定）は元から待ちの対象外で、行が無くても待たない', async () => {
      const o = await seedAutoOrder(db(), [10000]);
      await seedRefundInFlight(db(), o, 3000, ['requested'], { decided: 3000, covers: 3000 });
      const r = await seedRefundInFlight(db(), o, 1000, ['requested']);
      expect(await waitOf(r.refundId)).toBeNull();
    });

    test('FREQ-643-AC-06: 届いた日の仕訳待ちは今までどおり待つ（入れない決定の閉じ方では解けない）', async () => {
      const o = await seedAutoOrder(db(), [10000]);
      await seedArrival(db(), o, 10000, 0);
      const r = await seedRefundInFlight(db(), o, 1000, ['requested']);
      expect(await waitOf(r.refundId)).toBe('return_prior');
    });
  });

  // ---- AC-12: attributes and ACL of the two helpers -------------------------------------------------------------------------
  test('FREQ-643-AC-12: 関数2つ（途中の返金・R の式）は SECURITY DEFINER・search_path=\'\'・STABLE・所有者 postgres で、anon・authenticated・service_role・PUBLIC に EXECUTE が無い', async () => {
    const rows = (await q(`select p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proowner::regrole::text as owner, p.proretset,
        (select count(*) from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee <> p.proowner) as others,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_catalog.pg_proc p where p.oid in (to_regprocedure('private.accounting_order_refunds_in_flight(uuid,uuid)'),
        to_regprocedure('private.accounting_order_return_payable(uuid,date)')) order by p.proname`)).rows;
    expect(rows.map((r) => r.proname)).toEqual(['accounting_order_refunds_in_flight', 'accounting_order_return_payable']);
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: true, provolatile: 's', owner: 'postgres', anon: false, auth: false, service: false });
      expect(Number(r.others)).toBe(0);
      expect(r.proconfig).toEqual(['search_path=""']);
    }
    expect(rows[0].proretset).toBe(true);
    expect(rows[1].proretset).toBe(false);
  });

  test('FREQ-643-AC-12: 作り直した accounting_refund_wait は STABLE・SECURITY DEFINER・search_path=\'\'・所有者 postgres のまま、置き換えは1つ', async () => {
    const r = (await q(`select p.prosecdef, p.provolatile, p.proconfig, p.proowner::regrole::text as owner, p.prosrc,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_catalog.pg_proc p where p.oid = to_regprocedure('private.accounting_refund_wait(uuid,text)')`)).rows[0];
    expect(r).toMatchObject({ prosecdef: true, provolatile: 's', owner: 'postgres', anon: false, auth: false, service: false });
    expect(r.proconfig).toEqual(['search_path=""']);
    expect((r.prosrc as string).match(/-- ACC_P3_REPLACE_BEGIN 34d9183df09973c30c4b44a410b9d25b/g)).toHaveLength(1);
  });

  // ---- AC-03: the in-flight refunds ---------------------------------------------------------------------------------------
  describe('in-flight refunds', () => {
    const shapes: Array<[string, InFlightShape[]]> = [
      ['requested', ['requested']], ['accepted', ['requested', 'accepted']], ['error', ['requested', 'error']],
      ['成功したが仕訳なし', ['requested', 'succeeded']], ['failed（失敗の仕訳なし）', ['requested', 'failed']],
      ['owed（失敗の仕訳なし）', ['requested', 'owed']], ['canceled（取りやめ・owed なし）', ['requested', 'canceled']],
      ['abandoned（取りやめの仕訳なし）', ['requested', 'canceled', 'abandoned']],
    ];

    test.each(shapes)('FREQ-643-AC-03: 途中の返金の形 %s は、作った日が負けた日（11-09）より後でも返り、金額は post_shipment_amount の円', async (_name, states) => {
      const o = await seedAutoOrder(db(), [10000]);
      const r = await seedRefundInFlight(db(), o, 6500, states);
      await setCreatedOn(db(), r.refundId, '2026-12-01');
      expect(await inFlight(o.orderId, null)).toEqual([{ refund_id: r.refundId, excluded: false, post_shipment_amount: 6500 }]);
    });

    test('FREQ-643-AC-03: 仕訳が入った・閉じた行がある・before_cutover の行がある返金と、別の注文の返金は返さない', async () => {
      const o = await seedAutoOrder(db(), [10000]);
      const other = await seedAutoOrder(db(), [10000]);
      await seedRefundInFlight(db(), other, 4000, ['requested']);
      // 成功した返金: 成功の仕訳あり / 閉じた行あり / before_cutover の行あり
      const done = await seedRefundInFlight(db(), o, 1000, ['requested', 'succeeded']);
      await postRefundSuccess(db(), o.orderId, done.refundId, 1000, '2026-11-06');
      const closed = await seedRefundInFlight(db(), o, 1100, ['requested', 'succeeded']);
      await park('return_refund', 'order_refunds', closed.refundId, o.orderId, 'no_revenue');
      await unpark('return_refund', 'order_refunds', closed.refundId, null);
      const cutover = await seedRefundInFlight(db(), o, 1200, ['requested', 'succeeded']);
      await park('return_refund', 'order_refunds', cutover.refundId, o.orderId, 'before_cutover');
      // 失敗した返金: 失敗の仕訳あり / 閉じた行あり
      const failed = await seedRefundInFlight(db(), o, 1300, ['requested', 'failed']);
      await postAutoEntry(db(), { date: '2026-11-07', kind: 'refund_failed', parts: [failed.refundId, '1'], sourceTable: 'order_refunds', sourceId: failed.refundId,
        lines: [{ account: '1160', debit: 1300, orderId: o.orderId }, { account: '2130', credit: 1300, sub: 'refund_owed_post', orderId: o.orderId }] });
      const failedClosed = await seedRefundInFlight(db(), o, 1400, ['requested', 'failed']);
      await park('refund_failed', 'order_refunds', failedClosed.refundId, o.orderId, 'no_revenue');
      await unpark('refund_failed', 'order_refunds', failedClosed.refundId, null);
      // 取りやめた返金: 取りやめの仕訳あり / 閉じた行あり。取り消した返金（canceled の後に abandoned か owed）は形 (4) に当たらない
      const abandoned = await seedRefundInFlight(db(), o, 1500, ['requested', 'canceled', 'abandoned']);
      await postAutoEntry(db(), { date: '2026-11-08', kind: 'refund_abandoned', parts: [abandoned.refundId, '1'], sourceTable: 'order_refunds', sourceId: abandoned.refundId,
        lines: [{ account: '1160', debit: 1500, orderId: o.orderId }, { account: '2130', credit: 1500, sub: 'refund_owed_post', orderId: o.orderId }] });
      const abandonedClosed = await seedRefundInFlight(db(), o, 1600, ['requested', 'canceled', 'abandoned']);
      await park('refund_abandoned', 'order_refunds', abandonedClosed.refundId, o.orderId, 'no_revenue');
      await unpark('refund_abandoned', 'order_refunds', abandonedClosed.refundId, null);
      const canceledOwed = await seedRefundInFlight(db(), o, 1700, ['requested', 'canceled', 'owed']);
      await park('refund_failed', 'order_refunds', canceledOwed.refundId, o.orderId, 'no_revenue');
      await unpark('refund_failed', 'order_refunds', canceledOwed.refundId, null);
      expect(await inFlight(o.orderId, null)).toEqual([]);
    });

    // 外す3条件（設計 3-3）。返品 1 件: 届いた日の仕訳（済み）→ 0円の終わり X（11-10）→ 同じ日の 0円の終わり Z → 返金 R の決定。
    async function setup(o: { arrivalPosted?: boolean; earlier?: boolean; states?: InFlightShape[] } = {}) {
      const order = await seedAutoOrder(db(), [10000, 10000]);
      const arrival = await seedArrival(db(), order, 10000, 0);
      if (o.arrivalPosted !== false) {
        await postAutoEntry(db(), { date: '2026-11-05', kind: 'return_arrived', parts: [arrival.receiptId], lines: [
          { account: '4020', debit: 10000, orderId: order.orderId }, { account: '2130', credit: 10000, sub: 'return_refund', orderId: order.orderId }] });
      }
      const earlier = o.earlier ? await seedZeroClose(db(), order, 500, 0, '2026-11-08') : null;
      const x = await seedZeroClose(db(), order, 10000, 0, '2026-11-10');
      const z = await seedZeroClose(db(), order, 2000, 0, '2026-11-10');
      const r = await seedRefundInFlight(db(), order, 7000, o.states ?? ['requested'], { decided: 7000, covers: 0, on: '2026-11-12' });
      return { order, x: x.factId, z: z.factId, earlier: earlier?.factId ?? null, refundId: r.refundId, dR: r.decisionFactId as string };
    }

    test.each([['requested', ['requested']], ['accepted', ['requested', 'accepted']], ['error', ['requested', 'error']], ['成功したが未計上', ['requested', 'succeeded']]] as Array<[string, InFlightShape[]]>)(
      'FREQ-643-AC-03: 3条件がそろう返金（形 %s）は excluded = true。X の後の同じ日の決定 Z があっても外れる', async (_name, states) => {
        const s = await setup({ states });
        expect(await waitOf(s.refundId)).toBe('return_prior');
        expect(await inFlight(s.order.orderId, s.x)).toEqual([{ refund_id: s.refundId, excluded: true, post_shipment_amount: 7000 }]);
      });

    test('FREQ-643-AC-03: _decision_fact_id = NULL なら全部 excluded = false', async () => {
      const s = await setup();
      expect(await inFlight(s.order.orderId, null)).toEqual([{ refund_id: s.refundId, excluded: false, post_shipment_amount: 7000 }]);
    });

    test('FREQ-643-AC-03: 条件1を欠く（accounting_refund_wait が NULL の普通の返金）は excluded = false で、途中のまま返る', async () => {
      const s = await setup();
      const plain = await seedAutoOrder(db(), [10000]);
      await seedZeroClose(db(), plain, 0, 0, '2026-11-10');
      const r = await seedRefundInFlight(db(), plain, 3000, ['requested']);
      expect(await waitOf(r.refundId)).toBeNull();
      expect(await inFlight(plain.orderId, s.x)).toEqual([{ refund_id: r.refundId, excluded: false, post_shipment_amount: 3000 }]);
    });

    test('FREQ-643-AC-03: 条件2を欠く（X より前の決定が仕訳なしで残る・X 以後でも seq が前の決定を評価する・届いた日の仕訳が無い）は excluded = false。前の決定を入れない決定で閉じると true に戻る', async () => {
      const s = await setup({ earlier: true });
      expect(await inFlight(s.order.orderId, s.x)).toEqual([{ refund_id: s.refundId, excluded: false, post_shipment_amount: 7000 }]);
      await closeNoRevenue(s.order.orderId, s.earlier as string);
      expect(await inFlight(s.order.orderId, s.x)).toEqual([{ refund_id: s.refundId, excluded: true, post_shipment_amount: 7000 }]);
      // Z（同じ日・seq が後）を X として評価すると、同じ日で seq の前の X が残るので外れない
      expect(await inFlight(s.order.orderId, s.z)).toEqual([{ refund_id: s.refundId, excluded: false, post_shipment_amount: 7000 }]);
      const noArrival = await setup({ arrivalPosted: false });
      expect(await inFlight(noArrival.order.orderId, noArrival.x)).toEqual([{ refund_id: noArrival.refundId, excluded: false, post_shipment_amount: 7000 }]);
    });

    test.each([['failed（失敗の仕訳なし）', ['requested', 'failed']], ['canceled', ['requested', 'canceled']], ['abandoned', ['requested', 'canceled', 'abandoned']]] as Array<[string, InFlightShape[]]>)(
      'FREQ-643-AC-03: 条件3を欠く（形 %s）は成功の仕訳が無く条件1・2が成り立っても excluded = false で、途中のまま返る', async (_name, states) => {
        const s = await setup({ states });
        expect(await waitOf(s.refundId)).toBe('return_prior');
        expect(await inFlight(s.order.orderId, s.x)).toEqual([{ refund_id: s.refundId, excluded: false, post_shipment_amount: 7000 }]);
      });
  });

  // ---- AC-03: the R function ----------------------------------------------------------------------------------------------
  describe('return payable', () => {
    /** 2130 return_refund: 11-05 に貸 10,000、返金 R（作った日 11-06）の成功が仕訳の日 11-12 に借 4,000、別の補助科目 777、別の注文 9,999。 */
    async function payableState() {
      const o = await seedAutoOrder(db(), [10000]);
      const other = await seedAutoOrder(db(), [10000]);
      await postPayableCredit(db(), o.orderId, 10000, '2026-11-05');
      await postPayableCredit(db(), other.orderId, 9999, '2026-11-05');
      await postAutoEntry(db(), { date: '2026-11-05', kind: 'manual_entry', parts: ['sub', 'owed'], lines: [
        { account: '4020', debit: 777, orderId: o.orderId }, { account: '2130', credit: 777, sub: 'refund_owed_post', orderId: o.orderId }] });
      const refund = await seedRefundInFlight(db(), o, 4000, ['requested', 'succeeded']);
      await setCreatedOn(db(), refund.refundId, '2026-11-06');
      const success = await postRefundSuccess(db(), o.orderId, refund.refundId, 4000, '2026-11-12');
      return { o, other, refund, success };
    }

    test('FREQ-643-AC-03: 返金の成功は作った日で数える（仕訳の日でなく）。_through NULL は全部。別の注文・別の補助科目は数えない', async () => {
      const s = await payableState();
      expect(await payableOf(s.o.orderId, '2026-11-04')).toBe(0);
      expect(await payableOf(s.o.orderId, '2026-11-05')).toBe(10000);
      expect(await payableOf(s.o.orderId, '2026-11-06')).toBe(6000);
      expect(await payableOf(s.o.orderId, '2026-11-11')).toBe(6000);
      expect(await payableOf(s.o.orderId, '2026-11-12')).toBe(6000);
      expect(await payableOf(s.o.orderId, null)).toBe(6000);
      expect(await payableOf(s.other.orderId, null)).toBe(9999);
    });

    test('FREQ-643-AC-03: 成功の取り消し（reversal）は仕訳の日で数える', async () => {
      const s = await payableState();
      await q('select private.accounting_reverse_journal_core(null, $1::uuid, $2::text, $3::date)', [s.success, 'fixture', '2026-11-20']);
      expect(await payableOf(s.o.orderId, '2026-11-19')).toBe(6000);
      expect(await payableOf(s.o.orderId, '2026-11-20')).toBe(10000);
      expect(await payableOf(s.o.orderId, null)).toBe(10000);
    });

    test('FREQ-643-AC-03: 負の値はそのまま返す（0 で切らない）', async () => {
      const o = await seedAutoOrder(db(), [10000]);
      await postPayableCredit(db(), o.orderId, 3000, '2026-11-05');
      const refund = await seedRefundInFlight(db(), o, 5000, ['requested', 'succeeded']);
      await setCreatedOn(db(), refund.refundId, '2026-11-06');
      await postRefundSuccess(db(), o.orderId, refund.refundId, 5000, '2026-11-06');
      expect(await payableOf(o.orderId, null)).toBe(-2000);
      expect(await payableOf(o.orderId, '2026-11-06')).toBe(-2000);
      expect(await payableOf(o.orderId, '2026-11-05')).toBe(3000);
    });

    test('FREQ-643-AC-03: S22 の C の式と同じ（LEAST(GREATEST(R, 0), S) が accounting_dispute_offset_amounts の pay に等しい）', async () => {
      const s = await payableState();
      await q('select private.accounting_reverse_journal_core(null, $1::uuid, $2::text, $3::date)', [s.success, 'fixture', '2026-11-20']);
      const neg = await seedAutoOrder(db(), [10000]);
      await postPayableCredit(db(), neg.orderId, 3000, '2026-11-05');
      const refund = await seedRefundInFlight(db(), neg, 5000, ['requested', 'succeeded']);
      await setCreatedOn(db(), refund.refundId, '2026-11-06');
      await postRefundSuccess(db(), neg.orderId, refund.refundId, 5000, '2026-11-06');
      const seen = new Set<number>();
      for (const orderId of [s.o.orderId, s.other.orderId, neg.orderId]) {
        for (const lostOn of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-11', '2026-11-12', '2026-11-19', '2026-11-20']) {
          for (const amount of [1, 3000, 6000, 10000, 20000]) {
            const r = (await q(`select least(greatest(private.accounting_order_return_payable($1, $2::date), 0), $3::bigint) as mine,
              (select pay from private.accounting_dispute_offset_amounts($1, $2::date, $3::bigint)) as theirs`, [orderId, lostOn, amount])).rows[0];
            expect([orderId, lostOn, amount, Number(r.mine)]).toEqual([orderId, lostOn, amount, Number(r.theirs)]);
            seen.add(Number(r.mine));
          }
        }
      }
      // 円の幅: 0 から 10,000 まで、途中の値（6,000・3,000 など）も出る
      expect([...seen].sort((a, b) => a - b)).toEqual(expect.arrayContaining([0, 1, 3000, 6000, 10000]));
    });
  });
});

// 計画 S27 Task 2: 返品の計上係の dispute_lost（0円の終わり）。事実と C・W・L の仕訳を直に入れ、返品の計上係（本物）を流して円を固定する。
describeLocalDb('FREQ-643: S27 return poster dispute_lost (Task 2)', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const DAY = { d1: '2026-11-01', d2: '2026-11-02', d3: '2026-11-03', d5: '2026-11-05', d6: '2026-11-06', d8: '2026-11-08', d9: '2026-11-09', d10: '2026-11-10' };
  const at = (day: string) => `${day}T03:00:00Z`;
  const runReturn = async () => (await q('select private.accounting_post_return_events(50) as r')).rows[0].r as Record<string, number>;
  const runRefund = async () => (await q('select private.accounting_post_refund_events(50) as r')).rows[0].r as Record<string, number>;
  const payableOf = async (orderId: string, through: string | null) => Number((await q(
    'select private.accounting_order_return_payable($1, $2::date) as p', [orderId, through])).rows[0].p);

  /** 注文の account（補助科目 sub があれば sub も）の 借方 − 貸方。 */
  const bal = async (orderId: string, account: string, sub?: string) => Number((await q(
    `select coalesce(sum(l.debit - l.credit), 0) as b from public.accounting_journal_lines l
     where l.order_id = $1 and l.account_code = $2 and ($3::text is null or l.sub_account = $3)`, [orderId, account, sub ?? null])).rows[0].b);
  /** 取り消しの 1470 dispute_pending の 借方 − 貸方（印の頭 dispute_event:<dp>: で数える）。 */
  const pendingBal = async (disputeId: string) => Number((await q(
    `select coalesce(sum(l.debit - l.credit), 0) as b from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
     where l.account_code = '1470' and l.sub_account = 'dispute_pending' and starts_with(e.dedupe_key, 'dispute_event:' || $1 || ':')`, [disputeId])).rows[0].b);
  /** 注文の円の残り（2130・4020・4050・1470 review・売上の純額 4010 − 4020 + 4050）。 */
  const snap = async (orderId: string) => ({
    payable: 0 - (await bal(orderId, '2130', 'return_refund')),
    d4020: await bal(orderId, '4020'),
    c4050: 0 - (await bal(orderId, '4050')),
    review: await bal(orderId, '1470', 'dispute_refund_overlap_review'),
    net: 0 - ((await bal(orderId, '4010')) + (await bal(orderId, '4020')) + (await bal(orderId, '4050'))),
  });
  const entryOf = async (factId: string) => (await q(
    `select e.id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.description, e.source_table, e.source_id, e.source_recorded_at, e.recorded_by
     from public.accounting_journal_entries e where e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[$1::text])`, [factId])).rows[0] as
    { id: string; entry_date: string; description: string; source_table: string; source_id: string; source_recorded_at: Date; recorded_by: string | null } | undefined;
  const linesOf = async (entryId: string) => (await q(
    'select account_code, debit, credit, sub_account, order_id, memo from public.accounting_journal_lines where entry_id = $1 order by line_no', [entryId])).rows as
    Array<{ account_code: string; debit: number; credit: number; sub_account: string | null; order_id: string | null; memo: string | null }>;
  const shapeOf = (lines: Array<{ account_code: string; debit: number; credit: number; sub_account: string | null }>) =>
    lines.map((l) => [l.account_code, Number(l.debit), Number(l.credit), l.sub_account]);
  const decisionRow = async (factId: string) => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, order_id from public.accounting_pending_events
     where event_kind = 'return_amount_decided' and source_table = 'accounting_return_facts' and source_id = $1`, [factId])).rows[0] as
    { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null; order_id: string | null } | undefined;
  const entryCount = async () => Number((await q('select count(*) as n from public.accounting_journal_entries')).rows[0].n);
  const openRows = async (orderId: string) => Number((await q(
    'select count(*) as n from public.accounting_pending_events where order_id = $1 and resolved_at is null', [orderId])).rows[0].n);
  const park = (factId: string, orderId: string, reason: string, detail: Record<string, unknown> = {}) => q(
    "select private.accounting_park_event('return_amount_decided', 'accounting_return_facts', $1, $2::uuid, $3, $4::jsonb)", [factId, orderId, reason, JSON.stringify(detail)]);
  /** 個人の事業のまま法人に切り替え、法人の期間が無い日を作る（期間が無い日の試験）。 */
  const toCorporation = async () => {
    const admin = await insertAccountingAdmin(db());
    const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
  };
  const toSole = async () => {
    const admin = await insertAccountingAdmin(db());
    const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'soleProprietor', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
  };
  async function failure(run: () => Promise<unknown>) {
    await q('savepoint s27_t2_failure');
    try { await run(); return null; } catch (e) { return (e as { message: string }).message; } finally {
      await q('rollback to savepoint s27_t2_failure'); await q('release savepoint s27_t2_failure');
    }
  }

  /**
   * 注文（prices）の返品1つ（返品の到着 goods・fee を day1 に入れて計上係で仕訳にする）と、s 円の取り消し（day3 に引かれ day5 に負け）と、
   * その確定 C（pay・review・rest）。売上 sold 円。
   */
  async function lostOrder(input: { prices?: number[]; goods: number; fee?: number; s: number; pay: number; review?: number; rest?: number; sold?: number }) {
    const prices = input.prices ?? [10000];
    const o = await seedAutoOrder(db(), prices);
    await seedArrival(db(), o, input.goods, input.fee ?? 0, DAY.d1);
    await runReturn();
    await postSales(db(), o.orderId, input.sold ?? prices.reduce((a, b) => a + b, 0), DAY.d1);
    const w = await seedWithdrawn(db(), o.orderId, input.s, at(DAY.d3));
    await seedLost(db(), w.disputeId, at(DAY.d5));
    await postWithdrawal(db(), w.disputeId, w.txnId, input.s, DAY.d3);
    await postConfirmed(db(), o.orderId, w.disputeId, DAY.d5, { pay: input.pay, review: input.review, rest: input.rest });
    return { o, dp: w.disputeId };
  }

  // ---- AC-01 / AC-02: the exact yen of the spec 3-8 examples ---------------------------------------------------------------------
  describe('0 yen close of a lost dispute', () => {
    test('FREQ-643-AC-01: (b) 一部だけ引かれた（G=10,000・S=4,000）の0円の終わりは w=6,000 で入る（借 2130 6,000／貸 4020 6,000、全行に注文、印・日・source）。2回流しても1本', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      expect(await snap(s.o.orderId)).toEqual({ payable: 6000, d4020: 10000, c4050: 0, review: 0, net: 0 });
      expect(await pendingBal(s.dp)).toBe(0);
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      expect(await runReturn()).toMatchObject({ posted: 1, parked_new: 0 });
      const entry = await entryOf(d.factId);
      expect(entry).toMatchObject({ entry_date: DAY.d8, source_table: 'accounting_return_facts', source_id: d.factId, recorded_by: null });
      const lines = await linesOf(entry!.id);
      expect(shapeOf(lines)).toEqual([['2130', 6000, 0, 'return_refund'], ['4020', 0, 6000, null]]);
      expect(lines.every((l) => l.order_id === s.o.orderId)).toBe(true);
      expect((await q('select dedupe_key from public.accounting_journal_entries where id = $1', [entry!.id])).rows[0].dedupe_key).toBe(`return_amount_decided:${d.factId}`);
      expect(await snap(s.o.orderId)).toEqual({ payable: 0, d4020: 4000, c4050: 0, review: 0, net: 6000 });
      expect(await decisionRow(d.factId)).toBeUndefined();
      const before = await entryCount();
      expect(await runReturn()).toMatchObject({ posted: 0 });
      expect(await entryCount()).toBe(before);
    });

    test('FREQ-643-AC-01: (b) の仕訳は、C が無い注文の同じ決定（普通の0円の終わり）と、見出し・記録の時刻・source・memo・入れた人が同じ', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const lost = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      const plain = await seedAutoOrder(db(), [10000]);
      await seedArrival(db(), plain, 10000, 0, DAY.d1);
      const plainClose = await seedZeroClose(db(), plain, 6000, 0, DAY.d8);
      await runReturn();
      const a = (await entryOf(lost.factId))!;
      const b = (await entryOf(plainClose.factId))!;
      expect(a.description).toBe(b.description);
      expect(a.source_table).toBe(b.source_table);
      expect(a.entry_date).toBe(b.entry_date);
      expect(a.recorded_by).toBeNull();
      expect(b.recorded_by).toBeNull();
      for (const [e, f] of [[a, lost.factId], [b, plainClose.factId]] as const) {
        const created = (await q('select created_at from public.accounting_return_facts where id = $1', [f])).rows[0].created_at as Date;
        expect(e.source_recorded_at.getTime()).toBe(created.getTime());
        expect(e.source_id).toBe(f);
      }
      expect((await linesOf(a.id)).map((l) => [l.account_code, l.memo])).toEqual((await linesOf(b.id)).map((l) => [l.account_code, l.memo]));
    });

    test('FREQ-643-AC-01: (c2) 手数料あり（G=10,000・F=1,000・S=4,000）は 借 2130 5,000・借 4050 1,000／貸 4020 6,000。入れた後 4050 の純額は0、売上の純額は 6,000', async () => {
      const s = await lostOrder({ goods: 10000, fee: 1000, s: 4000, pay: 4000 });
      expect(await snap(s.o.orderId)).toEqual({ payable: 5000, d4020: 10000, c4050: 1000, review: 0, net: 1000 });
      const d = await seedZeroClose(db(), s.o, 9000, 1000, DAY.d8);
      await runReturn();
      const lines = await linesOf((await entryOf(d.factId))!.id);
      expect(shapeOf(lines)).toEqual([['2130', 5000, 0, 'return_refund'], ['4050', 1000, 0, null], ['4020', 0, 6000, null]]);
      expect(await snap(s.o.orderId)).toEqual({ payable: 0, d4020: 4000, c4050: 0, review: 0, net: 6000 });
    });

    test('FREQ-643-AC-02: (a) 返品が引かれた額と同じ（G=10,000・S=10,000）なら入れず no_revenue で閉じる（detail {}・resolved_entry_id NULL）。入れていれば 2130 は −10,000 だった', async () => {
      const s = await lostOrder({ goods: 10000, s: 10000, pay: 10000 });
      expect(await snap(s.o.orderId)).toEqual({ payable: 0, d4020: 10000, c4050: 0, review: 0, net: 0 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      expect(await runReturn()).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await entryOf(d.factId)).toBeUndefined();
      const row = (await decisionRow(d.factId))!;
      expect(row).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null, order_id: s.o.orderId });
      expect(row.resolved_at).not.toBeNull();
      expect(await snap(s.o.orderId)).toEqual({ payable: 0, d4020: 10000, c4050: 0, review: 0, net: 0 });
      // 入れていれば 2130 が −10,000 になる（P(D) = 0 のまま w = c = 10,000 で入れた場合）
      expect(await payableOf(s.o.orderId, DAY.d8)).toBe(0);
      const before = await entryCount();
      await runReturn();
      expect(await entryCount()).toBe(before);
    });

    test('FREQ-643-AC-02: (c1) 手数料あり・全額引かれた（G=10,000・F=1,000・S=10,000）は入れず、4050 は貸 1,000・費用 7530 は借 1,000・売上の純額 1,000', async () => {
      const s = await lostOrder({ goods: 10000, fee: 1000, s: 10000, pay: 9000, rest: 1000 });
      const d = await seedZeroClose(db(), s.o, 9000, 1000, DAY.d8);
      await runReturn();
      expect(await entryOf(d.factId)).toBeUndefined();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(await snap(s.o.orderId)).toEqual({ payable: 0, d4020: 10000, c4050: 1000, review: 0, net: 1000 });
      expect(Number((await q(`select coalesce(sum(l.debit - l.credit), 0) as b from public.accounting_journal_lines l
        join public.accounting_journal_entries e on e.id = l.entry_id where l.account_code = '7530' and e.event_kind = 'dispute_event' and e.source_id = $1`, [s.dp])).rows[0].b)).toBe(1000);
    });

    test('FREQ-643-AC-02: (g) 決定の日より後の取り下げ L の戻りがあっても、P を日で切るので入れず、2130 = 10,000 が残る', async () => {
      const s = await lostOrder({ goods: 10000, s: 10000, pay: 10000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      // day10: 取り下げ L（C に費用の行が無いので戻り先は 2130）
      await postAutoEntry(db(), { date: DAY.d10, kind: 'dispute_event', parts: [s.dp, 'reversal', 'txn_late'], sourceTable: 'stripe_disputes', sourceId: s.dp,
        lines: [{ account: '1160', debit: 10000 }, { account: '2130', credit: 10000, sub: 'return_refund', orderId: s.o.orderId }] });
      expect(await snap(s.o.orderId)).toMatchObject({ payable: 10000 });
      await runReturn();
      expect(await entryOf(d.factId)).toBeUndefined();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(await snap(s.o.orderId)).toMatchObject({ payable: 10000, d4020: 10000 });
      expect(await payableOf(s.o.orderId, DAY.d8)).toBe(0);
    });

    test('FREQ-643-AC-02: P(D) が負（2130 がすでにマイナス）でも入れない（no_revenue で閉じ、2130 は変わらない）', async () => {
      const s = await lostOrder({ goods: 10000, s: 10000, pay: 10000 });
      await postAutoEntry(db(), { date: DAY.d6, kind: 'return_arrived', parts: [randomUUID()], lines: [
        { account: '2130', debit: 5000, sub: 'return_refund', orderId: s.o.orderId }, { account: '4020', credit: 5000, orderId: s.o.orderId }] });
      expect(await payableOf(s.o.orderId, DAY.d8)).toBe(-5000);
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await runReturn();
      expect(await entryOf(d.factId)).toBeUndefined();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(await payableOf(s.o.orderId, null)).toBe(-5000);
    });

    test('FREQ-643-AC-02: (h) 2つの返品は両方決まるまで待ち（dispute_return_refund_pending・why return）、両方決まると両方 P_eff=0 で入れず 2130 = 0 のまま', async () => {
      const a = await seedAutoOrder(db(), [10000, 10000]);
      const b = await seedAnotherReturn(db(), a, 2);
      await seedArrival(db(), a, 10000, 0, DAY.d1);
      await seedArrival(db(), b, 10000, 0, DAY.d2);
      await runReturn();
      const w = await seedWithdrawn(db(), a.orderId, 20000, at(DAY.d3));
      await seedLost(db(), w.disputeId, at(DAY.d5));
      await postConfirmed(db(), a.orderId, w.disputeId, DAY.d5, { pay: 20000 });
      expect((await snap(a.orderId)).payable).toBe(0);
      const closeA = await seedZeroClose(db(), a, 10000, 0, DAY.d8);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
      expect((await snap(a.orderId)).payable).toBe(0);
      const closeB = await seedZeroClose(db(), b, 10000, 0, DAY.d9);
      await runReturn();
      await runReturn();
      for (const f of [closeA.factId, closeB.factId]) {
        expect(await entryOf(f)).toBeUndefined();
        expect(await decisionRow(f)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      }
      expect((await snap(a.orderId)).payable).toBe(0);
      expect(await openRows(a.orderId)).toBe(0);
    });

    test('FREQ-643-AC-02: (e) の後（C と直しで 2130 = 0）に返品 B を0円で終えても入れない', async () => {
      const a = await seedAutoOrder(db(), [5000, 15000]);
      const b = await seedAnotherReturn(db(), a, 2);
      await seedArrival(db(), a, 5000, 0, DAY.d1);
      await seedArrival(db(), b, 15000, 0, DAY.d1);
      await runReturn();
      await postSales(db(), a.orderId, 20000, DAY.d1);
      const w = await seedWithdrawn(db(), a.orderId, 20000, at(DAY.d3));
      await seedLost(db(), w.disputeId, at(DAY.d5));
      await postWithdrawal(db(), w.disputeId, w.txnId, 20000, DAY.d3);
      // day8: 返品 A だけを0円で終える（C がまだ無いのでふつうに入る）
      const closeA = await seedZeroClose(db(), a, 5000, 0, DAY.d8);
      await runReturn();
      expect(shapeOf(await linesOf((await entryOf(closeA.factId))!.id))).toEqual([['2130', 5000, 0, 'return_refund'], ['4020', 0, 5000, null]]);
      // day9: C（日 day5）と、0円の終わりの戻しすぎの直し（日 day8）
      await postConfirmed(db(), a.orderId, w.disputeId, DAY.d5, { pay: 20000 });
      await postAutoEntry(db(), { date: DAY.d8, kind: 'dispute_event', parts: ['closefix', w.disputeId, '1'], sourceTable: 'stripe_disputes', sourceId: w.disputeId,
        lines: [{ account: '4020', debit: 5000, orderId: a.orderId }, { account: '2130', credit: 5000, sub: 'return_refund', orderId: a.orderId }] });
      expect(await snap(a.orderId)).toEqual({ payable: 0, d4020: 20000, c4050: 0, review: 0, net: 0 });
      const closeB = await seedZeroClose(db(), b, 15000, 0, DAY.d10);
      await runReturn();
      expect(await entryOf(closeB.factId)).toBeUndefined();
      expect(await decisionRow(closeB.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(await snap(a.orderId)).toEqual({ payable: 0, d4020: 20000, c4050: 0, review: 0, net: 0 });
    });
  });

  // ---- AC-03: the waits of spec 3-3 ----------------------------------------------------------------------------------------------
  describe('waits', () => {
    const ev = (refundId: string, state: string) => q('select private.accounting_record_refund_event($1, $2, null, null, null, null)', [refundId, state]);
    const evAbandoned = (refundId: string, actor: string) => q("select private.accounting_record_refund_event($1, 'abandoned', null, $2::uuid, 'fixture', $3::uuid)", [refundId, actor, randomUUID()]);
    const refundEntry = (kind: 'refund_failed' | 'refund_abandoned', refundId: string, date: string) => postAutoEntry(db(), {
      date, kind, parts: [refundId, 'x1'], sourceTable: 'order_refunds', sourceId: refundId,
      lines: [{ account: '1160', debit: 3000 }, { account: '1010', credit: 3000 }] });

    /** G=10,000・S=4,000 の C（2130 = 6,000）。0円の終わり X（c=10,000・day8）と、別の返品 B の返金 R（3,000円・day9 に作る）が途中。 */
    async function inFlightOrder(states: InFlightShape[]) {
      const s = await lostOrder({ prices: [10000, 3000], goods: 10000, s: 4000, pay: 4000 });
      const b = await seedAnotherReturn(db(), s.o, 2);
      const r = await seedRefundInFlight(db(), b, 3000, states);
      await setCreatedOn(db(), r.refundId, DAY.d9);
      const x = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      return { ...s, b, x, refundId: r.refundId };
    }

    const shapes: Array<{ name: string; states: InFlightShape[]; resolve: (c: Awaited<ReturnType<typeof inFlightOrder>>) => Promise<void>; w: number }> = [
      { name: 'requested（形1）', states: ['requested'], w: 6000,
        resolve: async (c) => { await ev(c.refundId, 'failed'); await refundEntry('refund_failed', c.refundId, DAY.d10); } },
      { name: 'error（形1。再試行で成功）', states: ['requested', 'error'], w: 3000,
        resolve: async (c) => { await ev(c.refundId, 'succeeded'); await postRefundSuccess(db(), c.o.orderId, c.refundId, 3000, DAY.d10); } },
      { name: 'succeeded で成功の仕訳なし（形2）', states: ['requested', 'succeeded'], w: 3000,
        resolve: async (c) => { await postRefundSuccess(db(), c.o.orderId, c.refundId, 3000, DAY.d10); } },
      { name: 'failed で失敗の仕訳なし（形3）', states: ['requested', 'failed'], w: 6000,
        resolve: async (c) => { await refundEntry('refund_failed', c.refundId, DAY.d10); } },
      { name: 'canceled（形4）', states: ['requested', 'canceled'], w: 6000,
        resolve: async (c) => { await evAbandoned(c.refundId, c.o.actor); await refundEntry('refund_abandoned', c.refundId, DAY.d10); } },
      { name: 'abandoned で取りやめの仕訳なし（形5）', states: ['requested', 'canceled', 'abandoned'], w: 6000,
        resolve: async (c) => { await refundEntry('refund_abandoned', c.refundId, DAY.d10); } },
    ];

    test.each(shapes)('FREQ-643-AC-03: 途中の返金 $name があると dispute_refund_overlap（why refund）で待ち、2130 は変わらず、解けた後の次の流しで入る', async (shape) => {
      const c = await inFlightOrder(shape.states);
      expect(await snap(c.o.orderId)).toMatchObject({ payable: 6000 });
      await runReturn();
      expect(await decisionRow(c.x.factId)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolved_at: null });
      expect(await entryOf(c.x.factId)).toBeUndefined();
      expect((await snap(c.o.orderId)).payable).toBe(6000);
      await runReturn();
      expect((await snap(c.o.orderId)).payable).toBe(6000);
      await shape.resolve(c);
      await runReturn();
      const entry = await entryOf(c.x.factId);
      expect(entry).toBeDefined();
      expect(shapeOf(await linesOf(entry!.id))).toEqual([['2130', shape.w, 0, 'return_refund'], ['4020', 0, shape.w, null]]);
      expect((await decisionRow(c.x.factId))).toMatchObject({ reason: 'dispute_refund_overlap', resolved_entry_id: entry!.id });
      // 成功した返金（3,000円）の分も引いて、2130 は負にならず 0 になる
      expect((await snap(c.o.orderId)).payable).toBe(0);
      expect(await payableOf(c.o.orderId, null)).toBeGreaterThanOrEqual(0);
    });

    test('FREQ-643-AC-03: ほかの返品が未決（v_left > 0）なら dispute_return_refund_pending（why return）で待ち、2130 は変わらず、決まった後の流しで入る', async () => {
      const s = await lostOrder({ prices: [10000, 4000], goods: 10000, s: 4000, pay: 4000 });
      const b = await seedAnotherReturn(db(), s.o, 2);
      await seedArrival(db(), b, 4000, 0, DAY.d2);
      await runReturn();
      expect((await snap(s.o.orderId)).payable).toBe(10000);
      const closeA = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
      expect((await snap(s.o.orderId)).payable).toBe(10000);
      await seedZeroClose(db(), b, 4000, 0, DAY.d9);
      await runReturn();
      expect(shapeOf(await linesOf((await entryOf(closeA.factId))!.id))).toEqual([['2130', 10000, 0, 'return_refund'], ['4020', 0, 10000, null]]);
      expect((await snap(s.o.orderId)).payable).toBe(0);
    });

    test('FREQ-643-AC-03: (h) 組2 返金が D の後に成功する。成功の仕訳が入る前は dispute_refund_overlap で待ち（何も待っていない普通の途中の返金は外れない）、入った後は P_eff=0 で入れず 2130 = 0', async () => {
      const a = await seedAutoOrder(db(), [10000, 10000]);
      const b = await seedAnotherReturn(db(), a, 2);
      await seedArrival(db(), a, 10000, 0, DAY.d1);
      await seedArrival(db(), b, 10000, 0, DAY.d6);
      await runReturn();
      const w = await seedWithdrawn(db(), a.orderId, 10000, at(DAY.d3));
      await seedLost(db(), w.disputeId, at(DAY.d5));
      await postConfirmed(db(), a.orderId, w.disputeId, DAY.d5, { pay: 10000 });
      expect((await snap(a.orderId)).payable).toBe(10000);
      const closeA = await seedZeroClose(db(), a, 10000, 0, DAY.d8);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' } });
      // 返品 B を day9 に返金ありで決める（返金を作った日 day9）
      const r = await seedRefundInFlight(db(), b, 10000, ['requested'], { decided: 10000, covers: 10000, on: DAY.d9 });
      await setCreatedOn(db(), r.refundId, DAY.d9);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolved_at: null });
      expect(await entryOf(closeA.factId)).toBeUndefined();
      expect((await snap(a.orderId)).payable).toBe(10000);
      // day10 に成功。成功の仕訳（借 2130 10,000／貸 1160 10,000）が入る
      await q("select private.accounting_record_refund_event($1, 'succeeded', null, null, null, null)", [r.refundId]);
      await postRefundSuccess(db(), a.orderId, r.refundId, 10000, DAY.d10);
      expect(await payableOf(a.orderId, DAY.d8)).toBe(10000);
      expect(await payableOf(a.orderId, null)).toBe(0);
      await runReturn();
      expect(await entryOf(closeA.factId)).toBeUndefined();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect((await snap(a.orderId)).payable).toBe(0);
    });
  });

  // ---- AC-05: the thing with the earlier day goes first ----------------------------------------------------------------------------
  describe('order of days', () => {
    test('FREQ-643-AC-05: (h) 組1 に day10 の L を足した円。新しい決定（lane 0）が古い待ち（lane 1）より先に取り出されても日の早い物が先に入り、終わりの 2130 = 10,000（逆の順に入れると 2130 = 0 で L の借りが消える）', async () => {
      const a = await seedAutoOrder(db(), [10000, 10000]);
      const b = await seedAnotherReturn(db(), a, 2);
      await seedArrival(db(), a, 10000, 0, DAY.d1);
      await seedArrival(db(), b, 10000, 0, DAY.d6);
      await runReturn();
      const w = await seedWithdrawn(db(), a.orderId, 10000, at(DAY.d3));
      await seedLost(db(), w.disputeId, at(DAY.d5));
      await postConfirmed(db(), a.orderId, w.disputeId, DAY.d5, { pay: 10000 });
      expect((await snap(a.orderId)).payable).toBe(10000);
      // day8: B の決定。A が未決（v_left = 10,000）なので待つ
      const closeB = await seedZeroClose(db(), b, 10000, 0, DAY.d8);
      await runReturn();
      expect(await decisionRow(closeB.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
      // day9: A の決定（lane 0）が B の行（lane 1）より先に評価される。A は B を待ち、B が入る
      const closeA = await seedZeroClose(db(), a, 10000, 0, DAY.d9);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
      const entryB = (await entryOf(closeB.factId))!;
      expect(entryB.entry_date).toBe(DAY.d8);
      expect(shapeOf(await linesOf(entryB.id))).toEqual([['2130', 10000, 0, 'return_refund'], ['4020', 0, 10000, null]]);
      expect((await snap(a.orderId)).payable).toBe(0);
      // 次の流しで A（P(day9) = 0）は入れず、閉じる
      await runReturn();
      expect(await entryOf(closeA.factId)).toBeUndefined();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect((await snap(a.orderId)).payable).toBe(0);
      // day10: 取り下げ L（10,000円）。2130 は L の借りで 10,000
      await postAutoEntry(db(), { date: DAY.d10, kind: 'dispute_event', parts: [w.disputeId, 'reversal', 'txn_late'], sourceTable: 'stripe_disputes', sourceId: w.disputeId,
        lines: [{ account: '1160', debit: 10000 }, { account: '2130', credit: 10000, sub: 'return_refund', orderId: a.orderId }] });
      expect((await snap(a.orderId)).payable).toBe(10000);
    });

    test('FREQ-643-AC-05: 逆の順（A を先に day9、B を後に day8 で入れる）の比べ。両方入ると 2130 は L の後に 0 で、L の借りが消える（日の早い物が先の待ちが止める形）', async () => {
      const a = await seedAutoOrder(db(), [10000, 10000]);
      const orderId = a.orderId;
      await postPayableCredit(db(), orderId, 10000, DAY.d1);
      await postPayableCredit(db(), orderId, 10000, DAY.d6);
      const dp = (await seedWithdrawn(db(), orderId, 10000, at(DAY.d3))).disputeId;
      await seedLost(db(), dp, at(DAY.d5));
      await postConfirmed(db(), orderId, dp, DAY.d5, { pay: 10000 });
      for (const day of [DAY.d9, DAY.d8]) {
        await postAutoEntry(db(), { date: day, kind: 'return_amount_decided', parts: [randomUUID()], lines: [
          { account: '2130', debit: 10000, sub: 'return_refund', orderId }, { account: '4020', credit: 10000, orderId }] });
      }
      await postAutoEntry(db(), { date: DAY.d10, kind: 'dispute_event', parts: [dp, 'reversal', 'txn_late'], sourceTable: 'stripe_disputes', sourceId: dp,
        lines: [{ account: '1160', debit: 10000 }, { account: '2130', credit: 10000, sub: 'return_refund', orderId }] });
      expect((await snap(orderId)).payable).toBe(0);
    });

    /** 注文 [10000, 10000]・返品 A・B の到着 day1・C（S=4,000）・A の決定 day8（返品 B も決めて v_left は0）。 */
    async function twoDecisions(holdArrival = false) {
      const s = await lostOrder({ prices: [10000, 10000], goods: 10000, s: 4000, pay: 4000 });
      const a = await seedAnotherReturn(db(), s.o, 2);
      await seedArrival(db(), a, 10000, 0, holdArrival ? '2027-02-01' : DAY.d1);
      if (holdArrival) await toCorporation();
      await runReturn();
      return { ...s, a };
    }

    test('FREQ-643-AC-05: 別の理由で止まった決定（返品の到着の仕訳が入らず refund_prior_unposted）も日の鍵に入る。同じ日で作成の早い決定が先に入っていなければ、後の決定は待つ', async () => {
      const s = await twoDecisions(true);
      // 返品 A の到着は2027年・法人の期間が無く入らない。A の決定（K より日が早い day6）は refund_prior_unposted で止まる
      const closeA = await seedZeroClose(db(), s.a, 10000, 0, DAY.d6);
      const closeK = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await runReturn();
      expect(await decisionRow(closeA.factId)).toMatchObject({ reason: 'refund_prior_unposted', resolved_at: null });
      expect(await decisionRow(closeK.factId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
      expect(await entryOf(closeK.factId)).toBeUndefined();
      expect((await snap(s.o.orderId)).payable).toBe(6000);
    });

    test('FREQ-643-AC-05: 同じ日の2つは作成の順（created_at, return_id, seq）で、先の決定が入れば後の決定も同じ流しで入る', async () => {
      const s = await twoDecisions();
      const first = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      const second = await seedZeroClose(db(), s.a, 10000, 0, DAY.d8);
      await runReturn();
      // 同じ流しで作った2つは作成の時刻が同じなので、どちらが先かは返品の番号で決まる。合わせて 16,000 円（10,000 と 6,000）になる
      const amounts: number[] = [];
      for (const f of [first.factId, second.factId]) {
        const lines = shapeOf(await linesOf((await entryOf(f))!.id));
        expect(lines).toEqual([['2130', lines[0][1], 0, 'return_refund'], ['4020', 0, lines[0][1], null]]);
        amounts.push(lines[0][1] as number);
      }
      expect(amounts.sort()).toEqual([10000, 6000].sort());
      expect((await snap(s.o.orderId)).payable).toBe(0);
    });

    test('FREQ-643-AC-05: before_cutover の開いた行は鍵に入らず、後の決定を待たせない', async () => {
      const s = await twoDecisions();
      await setCutoverForTest(db(), DAY.d6);
      const early = await seedZeroClose(db(), s.a, 10000, 0, DAY.d3);
      const late = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      // 同じ流しで作った2つは作成の時刻が同じで、取り出しの順は返品の番号で決まる。late が先に当たっても2回目の流しで入る
      await runReturn();
      await runReturn();
      expect(await decisionRow(early.factId)).toMatchObject({ reason: 'before_cutover', resolved_at: null });
      expect(await entryOf(late.factId)).toBeDefined();
      expect((await snap(s.o.orderId)).payable).toBe(6000);
    });
  });

  // ---- AC-06: a decision closed with no entry, and the refund of the same return (j) -----------------------------------------
  describe('(j) the decision that books nothing and the refund after it', () => {
    /** 注文 20,000。返品 K: X（day1・10,000）→ W（S=10,000）・C（pay 10,000）→ W1（day8・c=10,000）→ Y（day9・10,000）→ 返金 R（10,000・day9 に作る・決定 payable_delta 0）。 */
    async function jOrder(opts: { holdY?: boolean; extraDecision?: boolean; s?: number; pay?: number; refund?: number } = {}) {
      const o = await seedAutoOrder(db(), [10000, 10000]);
      await seedArrival(db(), o, 10000, 0, DAY.d1);
      await runReturn();
      await postSales(db(), o.orderId, 20000, DAY.d1);
      const w = await seedWithdrawn(db(), o.orderId, opts.s ?? 10000, at(DAY.d3));
      await seedLost(db(), w.disputeId, at(DAY.d5));
      const wEntry = await postWithdrawal(db(), w.disputeId, w.txnId, opts.s ?? 10000, DAY.d3);
      await postConfirmed(db(), o.orderId, w.disputeId, DAY.d5, { pay: opts.pay ?? 10000 });
      const w1 = await seedZeroClose(db(), o, opts.extraDecision ? 5000 : 10000, 0, DAY.d8);
      const w2 = opts.extraDecision ? await seedZeroClose(db(), o, 5000, 0, DAY.d8) : null;
      await seedArrival(db(), o, 10000, 0, opts.holdY ? '2027-02-01' : DAY.d9);
      const r = await seedRefundInFlight(db(), o, opts.refund ?? 10000, ['requested'], { decided: opts.refund ?? 10000, covers: opts.refund ?? 10000, on: DAY.d9 });
      await setCreatedOn(db(), r.refundId, DAY.d9);
      if (opts.holdY) await toCorporation();
      return { o, dp: w.disputeId, wEntry, w1: w1.factId, w2: w2?.factId ?? null, refundId: r.refundId, rDecision: r.decisionFactId as string };
    }
    const refundEntryOf = async (refundId: string) => (await q(
      "select id, to_char(entry_date, 'YYYY-MM-DD') as entry_date from public.accounting_journal_entries where event_kind = 'return_refund' and source_table = 'order_refunds' and source_id = $1", [refundId])).rows[0] as
      { id: string; entry_date: string } | undefined;

    test('FREQ-643-AC-06: (j) W1 を評価する時 R は途中の数から外れ、W1 が no_revenue で閉じ、返金の計上係が R の成功を入れる（2130 = 0、1160 の貸は W と R で 10,000 ずつ）', async () => {
      const j = await jOrder();
      await runReturn();
      expect(await entryOf(j.w1)).toBeUndefined();
      expect(await decisionRow(j.w1)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect((await q('select private.accounting_refund_wait($1, $2) as w', [j.refundId, 'success'])).rows[0].w).toBeNull();
      expect(await openRows(j.o.orderId)).toBe(0);
      expect((await snap(j.o.orderId)).payable).toBe(10000);
      // 返金が Stripe で成功する（day10）。返金の計上係は前の決定 W1 を済みと数えて成功を入れる
      await succeedRefund(db(), j.refundId, { at: at(DAY.d10) });
      expect(await runRefund()).toMatchObject({ posted: 1 });
      const success = (await refundEntryOf(j.refundId))!;
      expect(success.entry_date).toBe(DAY.d10);
      const lines = await linesOf(success.id);
      expect(shapeOf(lines)).toEqual([['2130', 10000, 0, 'return_refund'], ['1160', 0, 10000, null]]);
      expect(lines.every((l) => l.order_id === j.o.orderId)).toBe(true);
      expect(shapeOf(await linesOf(j.wEntry))).toEqual([['1470', 10000, 0, 'dispute_pending'], ['1160', 0, 10000, null]]);
      expect(await snap(j.o.orderId)).toEqual({ payable: 0, d4020: 20000, c4050: 0, review: 0, net: 0 });
    });

    test('FREQ-643-AC-06: 外した返金の分は P(今)′ で2130 から引く。返金 R（12,000円）が Y の到着（10,000円）より大きくても、W1 は w=4,000 だけ入れ、R の成功の後も 2130 は負にならず 0', async () => {
      // G=10,000・S=4,000・C pay=4,000 なので P(day8) = 6,000。P(今) = 6,000 + 10,000（Y）= 16,000、外す R の 12,000 を引くと P(今)′ = 4,000
      const j = await jOrder({ s: 4000, pay: 4000, refund: 12000 });
      await runReturn();
      expect(shapeOf(await linesOf((await entryOf(j.w1))!.id))).toEqual([['2130', 4000, 0, 'return_refund'], ['4020', 0, 4000, null]]);
      expect((await snap(j.o.orderId)).payable).toBe(12000);
      await succeedRefund(db(), j.refundId, { at: at(DAY.d10) });
      expect(await runRefund()).toMatchObject({ posted: 1 });
      expect(shapeOf(await linesOf((await refundEntryOf(j.refundId))!.id))).toEqual([['2130', 12000, 0, 'return_refund'], ['1160', 0, 12000, null]]);
      expect((await snap(j.o.orderId)).payable).toBe(0);
      expect(await payableOf(j.o.orderId, null)).toBeGreaterThanOrEqual(0);
    });

    test('FREQ-643-AC-06: (j) 返金が後で失敗すると 2130 = 10,000 が残る（Y の返金待ちとして正しい）。W1 の判断は変わらない', async () => {
      const j = await jOrder();
      await runReturn();
      await failRefund(db(), j.refundId, { pulled: false });
      await runRefund();
      await runReturn();
      expect(await refundEntryOf(j.refundId)).toBeUndefined();
      expect(await decisionRow(j.w1)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect((await snap(j.o.orderId)).payable).toBe(10000);
    });

    test('FREQ-643-AC-06: 外れない条件。届いたもの Y の仕訳が止まっている間は R が外れず W1 は dispute_refund_overlap で待ち、到着が入れば W1 が閉じて R の成功が入る', async () => {
      const j = await jOrder({ holdY: true });
      await runReturn();
      expect(await decisionRow(j.w1)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolved_at: null });
      expect((await q('select excluded from private.accounting_order_refunds_in_flight($1, $2)', [j.o.orderId, j.w1])).rows).toEqual([{ excluded: false }]);
      expect((await snap(j.o.orderId)).payable).toBe(0);
      await toSole();
      await runReturn();
      await runReturn();
      expect(await decisionRow(j.w1)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(await openRows(j.o.orderId)).toBe(0);
    });

    test('FREQ-643-AC-06: 外れない条件。成功の仕訳が入っている返金は途中でなく、W1 は待たずに no_revenue で閉じる', async () => {
      const j = await jOrder();
      await q("select private.accounting_record_refund_event($1, 'succeeded', null, null, null, null)", [j.refundId]);
      await postRefundSuccess(db(), j.o.orderId, j.refundId, 10000, DAY.d10);
      expect((await q('select refund_id from private.accounting_order_refunds_in_flight($1, $2)', [j.o.orderId, j.w1])).rows).toEqual([]);
      await runReturn();
      expect(await decisionRow(j.w1)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
    });

    test('FREQ-643-AC-06: 0円の終わりが2つ（W1・W2）の同じ返品の後の返金 R は、W1 の評価でも W2 の評価でも外れ、W1・W2 の順に閉じて R の成功が入る', async () => {
      const j = await jOrder({ extraDecision: true });
      await runReturn();
      for (const f of [j.w1, j.w2!]) {
        expect(await decisionRow(f)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      }
      await succeedRefund(db(), j.refundId, { at: at(DAY.d10) });
      expect(await runRefund()).toMatchObject({ posted: 1 });
      expect(await refundEntryOf(j.refundId)).toBeDefined();
      expect((await snap(j.o.orderId)).payable).toBe(0);
    });

    test('FREQ-643-AC-06: 別の返品 M の返金 R が、鍵の遅い決定（day9）だけを待つ場合も外れる（W1 は待たずに閉じる）', async () => {
      const s = await lostOrder({ prices: [10000, 5000], goods: 10000, s: 15000, pay: 15000 });
      const m = await seedAnotherReturn(db(), s.o, 2);
      await seedArrival(db(), m, 5000, 0, DAY.d1);
      await runReturn();
      const w1 = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      const dm = await seedZeroClose(db(), m, 2000, 0, DAY.d9);
      const r = await seedRefundInFlight(db(), m, 3000, ['requested'], { decided: 3000, covers: 3000, on: DAY.d9 });
      await setCreatedOn(db(), r.refundId, DAY.d9);
      expect((await q('select excluded from private.accounting_order_refunds_in_flight($1, $2)', [s.o.orderId, w1.factId])).rows).toEqual([{ excluded: true }]);
      await runReturn();
      expect(await decisionRow(w1.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect(dm.factId).toBeDefined();
    });
  });

  // ---- AC-08 and the guards ---------------------------------------------------------------------------------------------------------
  describe('guards', () => {
    test('FREQ-643-AC-08: 期間が無い日（法人に切り替えた後の、法人の期間が無い決定の日 2027-03-01）は period_missing で止まり、detail.entry_date が決定の日になり、何も書かれない', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, '2027-03-01');
      await toCorporation();
      const before = await entryCount();
      await runReturn();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2027-03-01' }, resolved_at: null });
      expect(await entryCount()).toBe(before);
      expect((await snap(s.o.orderId)).payable).toBe(6000);
    });

    test('FREQ-643-AC-08: 切り替えの日より前の決定は before_cutover で止まり、何も書かれない', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      await setCutoverForTest(db(), DAY.d9);
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      const before = await entryCount();
      await runReturn();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'before_cutover', resolved_at: null });
      expect(await entryCount()).toBe(before);
    });

    test('FREQ-643-AC-08: 入れた後の 2130 が負になる細工（waive の w と w+f を2倍）は ACCOUNTING_POSTING_BALANCE_NEGATIVE（23514）で巻き戻り、error_code が残り、何も書かれない', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      const before = await entryCount();
      const def = (await q("select pg_get_functiondef('private.accounting_return_lines(text,uuid,bigint,bigint)'::regprocedure) as d")).rows[0].d as string;
      const tampered = def.replace(/WHEN 'waive' THEN[\s\S]*?ELSE NULL END;/, (m) => m.replace(/_goods/g, '(_goods * 2)').replace(/_fee/g, '(_fee * 2)'));
      expect(tampered).not.toBe(def);
      await q('savepoint s27_tamper');
      try {
        await q(tampered);
        await runReturn();
        const row = (await decisionRow(d.factId))!;
        expect(row).toMatchObject({ reason: 'posting_error', detail: { error_code: 'ACCOUNTING_POSTING_BALANCE_NEGATIVE', error_sqlstate: '23514' }, resolved_at: null });
        expect('ACCOUNTING_POSTING_BALANCE_NEGATIVE').toMatch(/^(ACCOUNTING|GROUP_G|GROUP_H)_[A-Z0-9_]{1,80}$/);
        expect(await entryOf(d.factId)).toBeUndefined();
        expect(await entryCount()).toBe(before);
        expect((await snap(s.o.orderId)).payable).toBe(6000);
      } finally {
        await q('rollback to savepoint s27_tamper');
        await q('release savepoint s27_tamper');
      }
    });

    test('FREQ-643-AC-08: 理由の CHECK は20個のまま', async () => {
      const def = (await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'accounting_pending_events_reason_check'")).rows[0].d as string;
      expect(new Set(def.match(/'[a-z_]+'::text/g)).size).toBe(20);
    });

    test('FREQ-643-AC-01: refund_id ありの決定は C が入っていても今までどおり（payable_delta の額で）入る', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const b = await seedAnotherReturn(db(), s.o, 2);
      await seedArrival(db(), b, 5000, 0, DAY.d2);
      await runReturn();
      const r = await seedRefundInFlight(db(), b, 5000, ['requested'], { decided: 5000, covers: 0, on: DAY.d8 });
      await runReturn();
      const entry = (await entryOf(r.decisionFactId as string))!;
      expect(shapeOf(await linesOf(entry.id))).toEqual([['4020', 5000, 0, null], ['2130', 0, 5000, 'return_refund']]);
    });

    test('FREQ-643-AC-01: 負けた日より前の決定（D < 負けた日）は C が入っていても今までどおり c の全額で入る', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d3);
      await runReturn();
      expect(shapeOf(await linesOf((await entryOf(d.factId))!.id))).toEqual([['2130', 10000, 0, 'return_refund'], ['4020', 0, 10000, null]]);
    });
  });

  // ---- Review Focus 5: open rows made before S27 ------------------------------------------------------------------------------------
  describe('open dispute_lost rows made before S27', () => {
    const old = async (orderId: string, factId: string) => park(factId, orderId, 'order_not_postable', { reason: 'dispute_lost' });

    test('FREQ-643-AC-01: S27 の前に作った開いた dispute_lost の行は、最初の流しで入る', async () => {
      const s = await lostOrder({ goods: 10000, s: 4000, pay: 4000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await old(s.o.orderId, d.factId);
      await runReturn();
      const entry = (await entryOf(d.factId))!;
      expect(shapeOf(await linesOf(entry.id))).toEqual([['2130', 6000, 0, 'return_refund'], ['4020', 0, 6000, null]]);
      expect(await decisionRow(d.factId)).toMatchObject({ resolved_entry_id: entry.id });
      expect(await openRows(s.o.orderId)).toBe(0);
    });

    test('FREQ-643-AC-03: S27 の前に作った開いた dispute_lost の行は、前提に当たれば待ちの理由に変わる', async () => {
      const s = await lostOrder({ prices: [10000, 3000], goods: 10000, s: 4000, pay: 4000 });
      const b = await seedAnotherReturn(db(), s.o, 2);
      const r = await seedRefundInFlight(db(), b, 3000, ['requested']);
      await setCreatedOn(db(), r.refundId, DAY.d9);
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await old(s.o.orderId, d.factId);
      await runReturn();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolved_at: null });
    });

    test('FREQ-643-AC-02: S27 の前に作った開いた dispute_lost の行は、入れる物が無ければ no_revenue で閉じる', async () => {
      const s = await lostOrder({ goods: 10000, s: 10000, pay: 10000 });
      const d = await seedZeroClose(db(), s.o, 10000, 0, DAY.d8);
      await old(s.o.orderId, d.factId);
      await runReturn();
      expect(await decisionRow(d.factId)).toMatchObject({ reason: 'no_revenue', detail: {}, resolved_entry_id: null });
      expect((await decisionRow(d.factId))!.resolved_at).not.toBeNull();
    });
  });
});
