/** @jest-environment node */
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  type InFlightShape, postAutoEntry, postPayableCredit, postRefundSuccess, seedArrival, seedAutoOrder, seedRefundInFlight, seedZeroClose,
  setCreatedOn,
} from './helpers/accounting-pending-auto-fixtures';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { accountingS27Section } from './helpers/accounting-returns-fixtures';
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
