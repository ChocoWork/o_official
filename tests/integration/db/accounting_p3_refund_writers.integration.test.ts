/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import { seedDisputeHold, seedPreShipmentCancel, seedRefundFlow, seedStripeRefundTxn } from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { connectLocalDb, describeLocalDb } from './helpers/local-db';
import { shipFixtureOrder } from './helpers/order-fixtures';
import { createUbReturn, materialsOf, ubReceive } from './helpers/unit-binding-receive';

// 計画3 Task 3（S17）: 返金を始める・結果を記録する関数が残す事実・履歴、判断待ちの止め、取り消しの区分。
jest.setTimeout(90000);

type Failure = { code?: string; message?: string; detail?: string };

describeLocalDb('FREQ-576-AC-01: S17 refund writers', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint s17_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint s17_expected'); await q('release savepoint s17_expected'); }
  }
  const states = async (refundId: string) => (await q(
    'select state, stripe_status from public.accounting_refund_events where refund_id=$1 order by seq', [refundId])).rows;
  const facts = async (refundId: string) => (await q('select * from public.accounting_refund_facts where refund_id=$1', [refundId])).rows;
  const counts = async () => (await q(`select (select count(*) from public.accounting_refund_events)::int ev,
    (select count(*) from public.accounting_refund_facts)::int fa, (select count(*) from public.accounting_unit_refund_allocations)::int al,
    (select count(*) from public.accounting_unit_price_adjusts)::int pa, (select count(*) from public.order_refunds)::int rf`)).rows[0];
  const stripeResult = async (refundId: string, status: string) => (await q(
    "select * from public.record_order_refund_result($1,$2,$3,null,$4,null,'card',null,null)",
    [refundId, `re_${refundId.replaceAll('-', '')}`, status, status === 'failed' || status === 'canceled' ? 'unknown' : null])).rows[0];
  const markError = async (refundId: string) => q("select * from private.mark_order_refund_error($1,'timeout',false)", [refundId]);
  const decide = async (actor: string, refundId: string, kind: string, reason = '店の判断', key = randomUUID()) => (await q(
    'select public.admin_decide_refund_cancellation($1,$2,$3,$4,$5) as r', [actor, refundId, kind, reason, key])).rows[0].r as {
    refund_id: string; state: string; event_id: string | null; replayed: boolean };

  describe('facts and the state history', () => {
    test('FREQ-576-AC-02: 返金を始めると返金の事実が1回だけ入り、同じ要求の再送では増えない', async () => {
      const f = await seedRefundFlow(db(), true);
      const key = randomUUID();
      const first = await hBegin(db(), f, 1000, false, key);
      const again = await hBegin(db(), f, 1000, false, key);
      expect(again).toMatchObject({ refund_id: first.refund_id, replayed: true });
      expect(await facts(first.refund_id)).toHaveLength(1);
      expect((await facts(first.refund_id))[0]).toMatchObject({ source: 'admin', event_kind: 'none', event_id: null,
        pre_shipment_amount: 0, post_shipment_amount: 1000, shipping_amount: 0, fee_amount: 0 });
      expect(await states(first.refund_id)).toEqual([{ state: 'requested', stripe_status: null }]);
    });

    test('FREQ-576-AC-01: 受け付け・成功・失敗・取り消し・エラーのたびに履歴が1行ずつ増え、同じ状態の2回目は増えない', async () => {
      const f = await seedRefundFlow(db(), true);
      const a = (await hBegin(db(), f, 1000)).refund_id;
      await stripeResult(a, 'pending');
      await stripeResult(a, 'succeeded');
      await stripeResult(a, 'succeeded');
      expect((await states(a)).map((s) => s.state)).toEqual(['requested', 'accepted', 'succeeded']);
      await stripeResult(a, 'failed');
      expect((await states(a)).map((s) => s.state)).toEqual(['requested', 'accepted', 'succeeded', 'failed']);
      const b = (await hBegin(db(), f, 500)).refund_id;
      await stripeResult(b, 'canceled');
      expect((await states(b)).find((s) => s.state === 'canceled')).toEqual({ state: 'canceled', stripe_status: 'canceled' });
      expect((await states(b)).map((s) => s.state)).toContain('canceled');
      expect((await states(b)).map((s) => s.state)).not.toContain('failed');
      const c = (await hBegin(db(), f, 300)).refund_id;
      await markError(c);
      await markError(c);
      expect((await states(c)).map((s) => s.state)).toEqual(['requested', 'error']);
      await stripeResult(c, 'pending');
      expect((await states(c)).map((s) => s.state).filter((s) => s === 'error')).toHaveLength(1);
    });

    test('FREQ-576-AC-01: 履歴・直しの差・値段の直しの行はG の鍵の中で取った番号を持ち、鍵の無い書き込みはGROUP_H_LOCK_REQUIRED', async () => {
      const f = await seedRefundFlow(db(), true);
      const a = (await hBegin(db(), f, 1000)).refund_id;
      const row = (await q("select fact_seq::text seq from public.accounting_refund_events where refund_id=$1 and state='requested'", [a])).rows[0];
      expect(Number(row.seq)).toBeGreaterThan(0);
      // 鍵を持たない別の接続は書けない（番号を取る前に断る）
      const other = await connectLocalDb();
      try {
        await other.query('begin');
        for (const call of [
          ['select private.accounting_record_refund_event($1::uuid, \'accepted\')', [a]],
          ['select private.accounting_record_event_allocations($1::uuid)', [randomUUID()]],
          ['select private.accounting_write_refund_allocations($1::uuid)', [a]],
          ['select private.accounting_release_allocations($1, 1)', [a]],
        ] as Array<[string, unknown[]]>) {
          await other.query('savepoint s');
          await expect(other.query(call[0], call[1])).rejects.toMatchObject({ code: '55000', message: 'GROUP_H_LOCK_REQUIRED' });
          await other.query('rollback to savepoint s');
        }
      } finally {
        await other.query('rollback');
        await other.end();
      }
    });

    test('FREQ-576-AC-05: 返金を始める途中で失敗すると、事実も履歴も割り当ても残らない', async () => {
      const f = await seedRefundFlow(db(), false);
      const before = await counts();
      const plan = planUnitEvent((await materialsOf(db(), f.orderId))!, { kind: 'pre_shipment_cancel', cancels: [{ orderItemId: f.itemId, quantity: 1 }] });
      // 計画と数の食い違う行は、返金の行を入れた後の確かめで落ちる
      expect(await failure(() => q(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5,null,$6::jsonb)`,
        [f.orderId, randomUUID(), JSON.stringify([{ order_item_id: f.itemId, before_shipment: true, quantity: 2 }]), plan.standardRefund, f.actor, JSON.stringify(plan)])))
        .toMatchObject({ code: '22023' });
      await seedDisputeHold(db(), f.orderId);
      expect(await failure(() => seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 })))
        .toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD' });
      expect(await counts()).toEqual(before);
    });

    test('FREQ-577-AC-07: 同じ返金の結果を同時に記録しても履歴は1行ずつ', async () => {
      const f = await seedRefundFlow(db(), true);
      const a = (await hBegin(db(), f, 1000)).refund_id;
      await Promise.all([stripeResult(a, 'succeeded'), stripeResult(a, 'succeeded')].map((p) => p.catch(() => null)));
      const rows = await states(a);
      expect(new Set(rows.map((r) => r.state)).size).toBe(rows.length);
      expect(rows.filter((r) => r.state === 'succeeded')).toHaveLength(1);
    });
  });

  describe('dispute holds (FREQ-580)', () => {
    test('FREQ-580-AC-01: 判断待ちの注文に管理者の返金を始めるとACCOUNTING_DISPUTE_HOLD（55000）で断り、返金の行も履歴も事実も割り当ても残らない', async () => {
      const f = await seedRefundFlow(db(), true);
      await seedDisputeHold(db(), f.orderId);
      const before = await counts();
      const e = await failure(() => hBegin(db(), f, 1000));
      expect(e).toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: 'order_count=1' });
      expect(await counts()).toEqual(before);
    });

    test('FREQ-580-AC-01: 注文の取り消しの返金と返品の返金も同じ拒否になる', async () => {
      const f = await seedRefundFlow(db(), false);
      await seedDisputeHold(db(), f.orderId);
      expect(await failure(() => seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 2, source: 'order_cancel' })))
        .toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD' });
      const g = await seedRefundFlow(db(), true);
      const ret = await createUbReturn(db(), g, [{ quantity: 1 }]);
      await seedDisputeHold(db(), g.orderId);
      expect(await failure(() => ubReceive(db(), { returnId: ret.returnId, actorId: g.actor, choice: 'now',
        units: [{ return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1 }] })))
        .toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD' });
    });

    test('FREQ-580-AC-01: 自動の返金（支払いの異常）とStripeの画面の返金の記録は断らない', async () => {
      const f = await seedRefundFlow(db(), true);
      await seedDisputeHold(db(), f.orderId);
      const external = (await q(`select * from public.record_external_order_refund($1,$2,1000,'succeeded',null,null,null,'card',null,null,'requested_by_customer',now())`,
        [f.orderId, `re_${randomUUID().replaceAll('-', '')}`])).rows[0];
      expect(external.refund_id).toBeTruthy();
      expect((await states(external.refund_id)).map((s) => s.state)).toContain('succeeded');
      expect((await states(external.refund_id))[0].state).toBe('requested');
      // 自動の元: 取り消した注文の支払いの返金（core を直接）
      await q("update public.orders set status='cancelled' where id=$1", [f.orderId]);
      const auto = await failure(() => q(`select * from private.begin_order_refund_core($1,'auto_cancelled_order_payment',$2,'[]'::jsonb,false,0,null,null,null,null,false,null,null,null,null,null)`,
        [f.orderId, randomUUID()]));
      expect(auto.message).not.toBe('ACCOUNTING_DISPUTE_HOLD');
    });

    test('FREQ-580-AC-03: 判断待ちが確定または取り下げになると返金を始められる', async () => {
      for (const status of ['lost', 'won']) {
        const f = await seedRefundFlow(db(), true);
        const disputeId = await seedDisputeHold(db(), f.orderId);
        expect(await failure(() => hBegin(db(), f, 1000))).toMatchObject({ message: 'ACCOUNTING_DISPUTE_HOLD' });
        await q('update public.stripe_disputes set status=$2 where id=$1', [disputeId, status]);
        expect((await hBegin(db(), f, 1000)).refund_id).toBeTruthy();
      }
    });

    test('FREQ-580-AC-05: 判断待ちの前に始まった保留の返金がStripeで失敗した時、失敗が記録され、同じ返金を二重に作らない（失敗の返金に戻りの取引の番号が結び付く）', async () => {
      const f = await seedRefundFlow(db(), true);
      const a = (await hBegin(db(), f, 1000)).refund_id;
      await stripeResult(a, 'pending');
      await seedDisputeHold(db(), f.orderId);
      const refunds = Number((await q('select count(*) n from public.order_refunds where order_id=$1', [f.orderId])).rows[0].n);
      await stripeResult(a, 'failed');
      const txn = await seedStripeRefundTxn(db(), { orderId: f.orderId, stripeRefundId: `re_${a.replaceAll('-', '')}`, amount: 1000, failure: true });
      expect((await states(a)).map((s) => s.state)).toEqual(['requested', 'accepted', 'failed']);
      expect(Number((await q('select count(*) n from public.order_refunds where order_id=$1', [f.orderId])).rows[0].n)).toBe(refunds);
      expect((await q('select failure_balance_transaction_id from public.stripe_refunds where id=$1', [`re_${a.replaceAll('-', '')}`])).rows[0]
        .failure_balance_transaction_id).toBe(txn.failureTxnId);
    });

    test('FREQ-580-AC-01: 事前の問い合わせ（warning系）は止めない', async () => {
      const f = await seedRefundFlow(db(), true);
      const disputeId = await seedDisputeHold(db(), f.orderId);
      await q("update public.stripe_disputes set status='warning_needs_response' where id=$1", [disputeId]);
      expect((await hBegin(db(), f, 1000)).refund_id).toBeTruthy();
    });

    test('FREQ-580-AC-01: 判断待ちの道具は計画2の get_order_dispute_holds と同じ答えを返す', async () => {
      const f = await seedRefundFlow(db(), true);
      const g = await seedRefundFlow(db(), true);
      await seedDisputeHold(db(), f.orderId);
      const ids = [f.orderId, g.orderId];
      const tool = (await q('select order_id, dispute_id from private.accounting_dispute_holds($1::uuid[]) order by 1,2', [ids])).rows;
      const plan2 = (await q('select order_id, dispute_id from private.get_order_dispute_holds($1::uuid[]) order by 1,2', [ids])).rows;
      expect(tool).toEqual(plan2);
      expect(tool).toHaveLength(1);
    });
  });

  describe('the cancel category (FREQ-579)', () => {
    async function canceledRefund() {
      const f = await seedRefundFlow(db(), true);
      const refundId = (await hBegin(db(), f, 1000)).refund_id;
      await stripeResult(refundId, 'canceled');
      return { f, refundId };
    }

    test('FREQ-579-AC-03: 取り消しの区分は取り消された返金だけに選べ、2回目は前の結果、違う内容はCANCEL_DECIDED、同じ要求番号で違う内容はREQUEST_KEY_CONFLICT', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), true);
      const live = (await hBegin(db(), f, 1000)).refund_id;
      expect(await failure(() => decide(admin, live, 'owed'))).toMatchObject({ code: '55000', message: 'ACCOUNTING_REFUND_NOT_CANCELED' });
      await stripeResult(live, 'failed');
      expect(await failure(() => decide(admin, live, 'owed'))).toMatchObject({ code: '55000', message: 'ACCOUNTING_REFUND_NOT_CANCELED' });
      const { refundId } = await canceledRefund();
      const key = randomUUID();
      const first = await decide(admin, refundId, 'owed', '返すつもり', key);
      expect(first).toMatchObject({ refund_id: refundId, state: 'owed', event_id: null, replayed: false });
      expect(await decide(admin, refundId, 'owed', '返すつもり', key)).toMatchObject({ state: 'owed', replayed: true });
      expect(await failure(() => decide(admin, refundId, 'abandoned', '返すつもり'))).toMatchObject({ code: '55000', message: 'ACCOUNTING_REFUND_CANCEL_DECIDED' });
      expect(await failure(() => decide(admin, refundId, 'abandoned', '返すつもり', key))).toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
      expect(await failure(() => decide(admin, refundId, 'other'))).toMatchObject({ code: '22023' });
      expect(await failure(() => decide(admin, refundId, 'owed', 'x'.repeat(501)))).toMatchObject({ code: '22023' });
      const row = (await q("select reason, actor_id, request_key, request_hash from public.accounting_refund_events where refund_id=$1 and state='owed'", [refundId])).rows[0];
      expect(row).toMatchObject({ reason: '返すつもり', actor_id: admin, request_key: key });
      expect(row.request_hash).toMatch(/^[0-9a-f]{64}$|^[0-9a-f]{32}$/);
    });

    test('FREQ-579-AC-03: 取り消しの区分は権限のある人だけが選べる', async () => {
      const { f, refundId } = await canceledRefund();
      expect(await failure(() => decide(f.actor, refundId, 'owed'))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
      expect(await failure(() => decide(randomUUID(), refundId, 'owed'))).toMatchObject({ code: '42501' });
      const acl = (await q(`select has_function_privilege('service_role','public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)','EXECUTE') s,
        has_function_privilege('authenticated','public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)','EXECUTE') a,
        has_function_privilege('anon','public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)','EXECUTE') n`)).rows[0];
      expect(acl).toEqual({ s: true, a: false, n: false });
    });

    test('FREQ-579-AC-07: 発送前の取り消しの返金を店がやめると、交換の印の作業がその着を手元にあるに戻し、割り当てが戻り、s は0', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const allocated = (await q('select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations where refund_key=$1', [c.eventId])).rows[0].n;
      expect(allocated).toBeGreaterThan(0);
      await stripeResult(c.refundId, 'canceled');
      // 2回目の G の鍵（同じ取引）は待たず断らない
      const r = await decide(admin, c.refundId, 'abandoned', '店が返金をやめた');
      expect(r).toMatchObject({ state: 'abandoned', replayed: false });
      expect(r.event_id).toBeTruthy();
      expect((await q('select kind, reverts_event_id from public.order_unit_events where id=$1', [r.event_id])).rows[0])
        .toEqual({ kind: 'cancel_reverted', reverts_event_id: c.eventId });
      expect((await q('select state from public.order_unit_slots where order_id=$1 order by unit_index', [f.orderId])).rows.map((s) => s.state))
        .toEqual(['kept', 'kept']);
      const net = (await q(`select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations
        where refund_key=$1 or refund_key like $2`, [c.eventId, `release:${c.eventId}:%`])).rows[0].n;
      expect(net).toBe(0);
      const adj = (await q(`select coalesce(sum(amount),0)::int n from public.accounting_unit_price_adjusts
        where adjust_key=$1 or adjust_key like $2`, [c.eventId, `release:${c.eventId}:%`])).rows[0].n;
      expect(adj).toBe(0);
      expect((await q("select release_shortfall, carried_adjust from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [c.refundId])).rows[0])
        .toEqual({ release_shortfall: 0, carried_adjust: null });
    });

    test('FREQ-577-AC-06: 取り消しの区分で「やめた」を選ぶと、出来事の割り当て・値段の直し・差の行が release の負の行で戻り、着がまた送れる。「返すつもり」では戻らない', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), 1);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const sums = async () => (await q(`select
        (select coalesce(sum(amount),0) from public.accounting_unit_refund_allocations where refund_key=$1 or refund_key like $2)::int al,
        (select coalesce(sum(amount),0) from public.accounting_unit_price_adjusts where adjust_key=$1 or adjust_key like $2)::int pa,
        (select coalesce(sum(amount),0) from public.accounting_refund_transfer_adjusts where event_id=$3)::int ta`,
      [c.eventId, `release:${c.eventId}:%`, c.eventId])).rows[0];
      const written = await sums();
      expect(written.al).toBeGreaterThan(0);
      await stripeResult(c.refundId, 'canceled');
      await q('savepoint owed');
      await decide(admin, c.refundId, 'owed', '返すつもり');
      expect(await sums()).toEqual(written);
      await q('rollback to savepoint owed');
      await decide(admin, c.refundId, 'abandoned', 'やめた');
      expect(await sums()).toEqual({ al: 0, pa: 0, ta: 0 });
      expect((await q("select count(*)::int n from private.accounting_shipped_units($1,null)", [f.itemId])).rows[0].n).toBe(1);
    });

    test('FREQ-579-AC-07: 発送前の取り消しの出来事に結ばれた Stripe に届いていない error の返金で「やめた」を選ぶと UNIT_CANCEL_REVERT_REFUSED（ubrr_status）で断られ、状態の行も割り当ての戻しも残らない', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      await markError(c.refundId);
      const before = await counts();
      expect(await failure(() => decide(admin, c.refundId, 'abandoned', 'やめた')))
        .toMatchObject({ code: '22023', message: 'UNIT_CANCEL_REVERT_REFUSED', detail: 'ubrr_status' });
      expect(await failure(() => decide(admin, c.refundId, 'owed', '返す'))).toMatchObject({ message: 'ACCOUNTING_REFUND_NOT_CANCELED' });
      expect(await counts()).toEqual(before);
    });

    test('FREQ-579-AC-07: 守りの枝: 同じ出来事の1回目の返金が引かれる前に失敗して借りが残り、やり直しの返金を Stripe が取り消して店がやめると、そのやり直しの返金だけがやめになり、着も割り当ても戻らず、借りと前受金の残りは変わらない', async () => {
      // 裁定 B4: 公開の関数ではこの場面に届かない（発送前の取り消しの出来事の返金は begin_order_refund が出来事ごとに1本だけ作る）ので、
      // 2本目の返金の結び order_unit_event_refunds の行（part='now'）を fixture で直接入れて作る。
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), 1);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      await stripeResult(c.refundId, 'failed');
      const retry = (await q(`insert into public.order_refunds(order_id,source,request_key,request_fingerprint,status,amount,notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,false) returning id`,
        [f.orderId, c.amount])).rows[0].id as string;
      await q("insert into public.order_unit_event_refunds(event_id,refund_id,part) values($1,$2,'now')", [c.eventId, retry]);
      await q("select private.accounting_record_refund_event($1,'requested')", [retry]);
      await stripeResult(retry, 'canceled');
      const allocBefore = (await q('select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations where refund_key=$1 or refund_key like $2',
        [c.eventId, `release:${c.eventId}:%`])).rows[0].n;
      const r = await decide(admin, retry, 'abandoned', 'やめた');
      expect(r).toMatchObject({ state: 'abandoned', event_id: null });
      expect((await q("select release_shortfall, carried_adjust from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [retry])).rows[0])
        .toEqual({ release_shortfall: 0, carried_adjust: 0 });
      expect((await q('select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations where refund_key=$1 or refund_key like $2',
        [c.eventId, `release:${c.eventId}:%`])).rows[0].n).toBe(allocBefore);
      expect((await q("select count(*)::int n from public.order_unit_events where reverts_event_id=$1", [c.eventId])).rows[0].n).toBe(0);
    });

    test('FREQ-577-AC-06: 出来事を取りやめずに最初の返金だけをやめると、その返金の d が区分の行の carried_adjust に残り、やり直しの返金の d は0', async () => {
      // 裁定 B4 と同じく、2本目の返金の結びは fixture で直接入れる。
      // 出荷済みの残る着の直し（d）は、公開の関数では1つの品の H の受け付けの注文から作れない（繰り返しの割引は最初の着に付かず、
      // 出荷済みの着の割引が取り消しで戻る組を作れない）ので、出来事の差の行を fixture で直接1行入れる（G の鍵の中で取った番号）。
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), 1);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      await q(`insert into public.accounting_refund_transfer_adjusts(event_id, adjust_key, order_item_id, unit_index, amount, fact_seq, locked_at)
        select $1::uuid, $1::text, $2::uuid, 0, 300, t.fact_seq, t.locked_at from private.accounting_take_g_fact_seq() as t`, [c.eventId, f.itemId]);
      const d = (await q('select coalesce(sum(amount),0)::int n from public.accounting_refund_transfer_adjusts where event_id=$1', [c.eventId])).rows[0].n;
      await stripeResult(c.refundId, 'canceled');
      const retry = (await q(`insert into public.order_refunds(order_id,source,request_key,request_fingerprint,status,amount,notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,false) returning id`,
        [f.orderId, c.amount])).rows[0].id as string;
      await q("insert into public.order_unit_event_refunds(event_id,refund_id,part) values($1,$2,'now')", [c.eventId, retry]);
      await q("select private.accounting_record_refund_event($1,'requested')", [retry]);
      await stripeResult(retry, 'succeeded');
      await decide(admin, c.refundId, 'abandoned', 'やめた');
      expect((await q("select carried_adjust, release_shortfall from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [c.refundId])).rows[0])
        .toEqual({ carried_adjust: d, release_shortfall: 0 });
      // やり直しの返金が後で取り消されてやめても d は0（最初の返金ではない）。ここでは最初の返金が abandoned なので、もうお金の出た返金は無い。
      expect(d).not.toBe(0);
    });

    test('FREQ-577-AC-06: 品を指定しない返金の割り当てが当たった後に出荷された着は戻せず、戻せなかった額 s が区分の行に残る', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), 1);
      const refundId = (await q(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1000,null,'requested_by_customer',null,false,$3,null,null)`,
        [f.orderId, randomUUID(), f.actor])).rows[0].refund_id as string;
      const allocs = (await q('select order_item_id, unit_index, amount from public.accounting_unit_refund_allocations where refund_key=$1', [refundId])).rows;
      expect(allocs.length).toBeGreaterThan(0);
      const p = allocs.reduce((s, a) => s + a.amount, 0);
      await seedFactSlip(db(), { orderItemId: f.itemId, quantity: 1 });
      await stripeResult(refundId, 'canceled');
      await decide(admin, refundId, 'abandoned', 'やめた');
      expect((await q("select release_shortfall from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [refundId])).rows[0].release_shortfall).toBe(p);
    });

    test('FREQ-579-AC-07: 出来事の後・やめる前に出荷された残る着に値段の直しがあると、戻せない額 s が区分の行に残る', async () => {
      const admin = await insertAccountingAdmin(db());
      const f = await seedRefundFlow(db(), false);
      const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
      const kept = (await q(`select order_item_id, unit_index, sum(amount)::int amount from public.accounting_unit_price_adjusts
        where event_id=$1 and (order_item_id, unit_index) not in (select order_item_id, unit_index from public.order_unit_event_lines where event_id=$1 and line_kind='returned')
        group by 1,2`, [c.eventId])).rows;
      await seedFactSlip(db(), { orderItemId: f.itemId, quantity: 1 });
      await stripeResult(c.refundId, 'canceled');
      await decide(admin, c.refundId, 'abandoned', 'やめた');
      const s = (await q("select release_shortfall from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [c.refundId])).rows[0].release_shortfall;
      expect(s + kept.reduce((sum, k) => sum + k.amount, 0)).toBe(0);
    });
  });

  describe('existing behaviour of the rebuilt functions', () => {
    test('FREQ-576-AC-06: 作り直した関数の既存の試験が、意図して変えた所以外は無改造で通る', async () => {
      // 既存の suite（group_h_*・order_refund_*・unit-binding-*・accounting_p2_*）を Step 4 で流す。ここでは本文が S17 の物であることだけ確かめる。
      const bodies = (await q(`select p.proname, p.prosrc like '%ACC_P3_%' marked from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.proname in ('begin_order_refund_core','record_group_g_refund_result','mark_order_refund_error',
        'record_external_order_refund','accounting_unit_values','accounting_shipment_plan','accounting_shipped_units',
        'accounting_check_unit_allocation_sum','accounting_g_fact_seq_at','order_unit_shipped_slots') order by 1`)).rows;
      expect(bodies).toHaveLength(10);
      expect(bodies.every((b) => b.marked)).toBe(true);
    });

    test('FREQ-563-AC-02: Stripeの管理画面の返金の記録は、出荷を始めた品でも送っていない着を番号で確保する', async () => {
      const f = await seedRefundFlow(db(), false);
      await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor, trackingNumber: 'S17-EXT', lines: [{ order_item_id: f.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: f.itemId, quantity: 1 });
      const shipped = (await q('select unit_index from private.accounting_shipped_units($1,null)', [f.itemId])).rows.map((r) => r.unit_index);
      const paid = Number((await q('select paid_amount from public.orders where id=$1', [f.orderId])).rows[0].paid_amount);
      const ext = (await q(`select * from public.record_external_order_refund($1,$2,$3,'succeeded',null,null,null,'card',null,null,'requested_by_customer',now())`,
        [f.orderId, `re_${randomUUID().replaceAll('-', '')}`, paid])).rows[0];
      const claimed = (await q('select unit_index, paid_amount from public.order_line_unit_amounts where refund_id=$1', [ext.refund_id])).rows;
      expect(claimed).toHaveLength(1);
      expect(shipped).not.toContain(claimed[0].unit_index);
      expect((await q('select amount from public.order_refund_lines where refund_id=$1', [ext.refund_id])).rows[0].amount).toBe(claimed[0].paid_amount);
      expect((await q('select unit_index from private.accounting_shipped_units($1,null)', [f.itemId])).rows.map((r) => r.unit_index)).toEqual(shipped);
    });
  });
});
