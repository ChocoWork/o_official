/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { postManualEntryFixture, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import { receiveReturn, recordRefundResult, seedReturnFlow } from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 9（S23）: 前受金の異常の一覧（list_deferred_revenue_anomalies）に返品の理由を2つ足す（FREQ-578-AC-09、final-fix-review-b2-3 の中1）。
// どちらも写しの無い注文で作る（道具で注文を作った後に order_discount_snapshots の行を消す。写しのある注文では X4 が断る。裁定 P3-D3）。
jest.setTimeout(240000);

type Anomaly = { order_id: string; order_number: string; balance: number; reason: string };

describeLocalDb('S23 deferred revenue anomalies: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const anomalies = async () => ((await q('select public.list_deferred_revenue_anomalies() as r')).rows[0].r as { anomalies: Anomaly[] }).anomalies;
  const reasonsOf = async (orderId: string) => (await anomalies()).filter((a) => a.order_id === orderId).map((a) => a.reason).sort();
  const refundReturn = async (returnId: string, actor: string, value: number | null) =>
    (await q('select * from public.admin_refund_return($1,$2,$3,$4,0,null,false)', [returnId, actor, randomUUID(), value])).rows[0] as {
      refund_id: string | null; amount: number; status: string };
  /** 写しの無い注文の返品を今すぐ返金で受け取り、その返金を error にする。 */
  async function erroredReturn() {
    const flow = await seedReturnFlow(db(), { snapshot: false });
    const r = await receiveReturn(db(), flow, { choice: 'now',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] });
    if (!r.refund_id) throw new Error('S23_RECEIPT_WITHOUT_REFUND');
    await q("select * from private.mark_order_refund_error($1,'timeout',false)", [r.refund_id]);
    return { flow, refundId: r.refund_id };
  }

  test('FREQ-578-AC-09: error の返金がある返品を admin_refund_return(0) で終え、その返金が後で failed になると、前受金の異常の一覧に理由 return_waived_with_failed_refund で出る', async () => {
    const { flow, refundId } = await erroredReturn();
    const closed = await refundReturn(flow.returnId, flow.f.actor, 0);
    expect(closed.refund_id).toBeNull();
    // While the refund may still succeed, the close is what the shop meant: no row yet.
    expect(await reasonsOf(flow.f.orderId)).toEqual([]);
    await recordRefundResult(db(), refundId, 'failed');
    expect(await reasonsOf(flow.f.orderId)).toEqual(['return_waived_with_failed_refund']);
  });

  test('FREQ-578-AC-09: error の返金がある返品で返金をやり直すと、前受金の異常の一覧に理由 return_refund_retried_during_error で出る', async () => {
    const { flow } = await erroredReturn();
    expect(await reasonsOf(flow.f.orderId)).toEqual([]);
    const retry = await refundReturn(flow.returnId, flow.f.actor, null);
    expect(retry.refund_id).not.toBeNull();
    expect(await reasonsOf(flow.f.orderId)).toEqual(['return_refund_retried_during_error']);
  });

  test('FREQ-578-AC-09: 返品の理由の行に名前・メール・住所の鍵が無く、前からある理由の行は計画2の試験のまま通る', async () => {
    const { flow } = await erroredReturn();
    await refundReturn(flow.returnId, flow.f.actor, null);
    // The same order also gets a plan-2 reason (a negative deferred revenue): one row per reason.
    await postManualEntryFixture(db(), { entryDate: '2026-11-05', kind: 'personal_discount', parts: [flow.f.orderId, 'fixture-anomaly-1'], lines: [
      { account: '2150', debit: 700, orderId: flow.f.orderId }, { account: '1160', credit: 700 }] });
    const rows = (await anomalies()).filter((a) => a.order_id === flow.f.orderId);
    expect(rows.map((a) => a.reason).sort()).toEqual(['negative_balance', 'return_refund_retried_during_error']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['balance', 'order_id', 'order_number', 'reason']);
      expect(row).toMatchObject({ order_number: `ORD-${flow.f.orderId.slice(0, 8).toUpperCase()}`, balance: -700 });
    }
  });

  test('FREQ-578-AC-09: 返品の返金待ち（2130 return_refund）が注文でマイナスになると（返金の二重払い。P3-T11k）、前受金の異常の一覧に理由 return_refund_negative_balance で出る。0以上の間は出ない', async () => {
    const flow = await seedReturnFlow(db(), { snapshot: false });
    const orderId = flow.f.orderId;
    const rr = (credit: number, debit: number) => ({ account: '2130', credit, debit, orderId, subAccount: 'return_refund' });
    // 返品の返金待ち 17,000円（届いた日の仕訳）。そのままでは異常ではない
    await postManualEntryFixture(db(), { entryDate: '2026-11-03', kind: 'return_arrived', parts: [randomUUID()], lines: [
      { account: '4020', debit: 17000, orderId }, rr(17000, 0)] });
    expect(await reasonsOf(orderId)).toEqual([]);
    // 振込で全額を返すと 0（異常ではない）。その後で Stripe の返金が成功して同じ額をもう一度返すと、残高が -3,000円になる
    await postManualEntryFixture(db(), { entryDate: '2026-11-04', kind: 'return_refund', parts: ['bank-fixture.return'], lines: [
      rr(0, 17000), { account: '1040', credit: 17000 }] });
    expect(await reasonsOf(orderId)).toEqual([]);
    await postManualEntryFixture(db(), { entryDate: '2026-11-05', kind: 'return_refund', parts: [randomUUID()], lines: [
      rr(0, 3000), { account: '1160', credit: 3000 }] });
    expect(await reasonsOf(orderId)).toEqual(['return_refund_negative_balance']);
    const row = (await anomalies()).find((a) => a.order_id === orderId);
    expect(Object.keys(row as object).sort()).toEqual(['balance', 'order_id', 'order_number', 'reason']);
    expect(row).toMatchObject({ order_number: `ORD-${orderId.slice(0, 8).toUpperCase()}` });
    // 残高が 0 に戻れば（-3,000円分の取り戻し）消える
    await postManualEntryFixture(db(), { entryDate: '2026-11-06', kind: 'return_refund', parts: [randomUUID()], lines: [
      rr(3000, 0), { account: '1160', debit: 3000 }] });
    expect(await reasonsOf(orderId)).toEqual([]);
  });

  test('FREQ-578-AC-09: list_deferred_revenue_anomalies の本文は囲みを除いて計画2の最新の定義と同じ', async () => {
    const s12 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261108210000_accounting_p2_intake_reads.sql'), 'utf8');
    const fn = s12.match(/^CREATE FUNCTION private\.list_deferred_revenue_anomalies\(\)[\s\S]*?^\$\$;\n/m)?.[0] ?? '';
    const original = fn.slice(fn.indexOf('AS $$') + 'AS $$'.length, fn.lastIndexOf('$$;'));
    expect(original).not.toBe('');
    const live = (await q("select prosrc from pg_proc where oid = 'private.list_deferred_revenue_anomalies()'::regprocedure")).rows[0].prosrc as string;
    const blocks = [...live.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("'return_refund_retried_during_error'");
    expect(blocks[0]).toContain("'return_waived_with_failed_refund'");
    expect(live.replace(blocks[0], '')).toBe(original);
  });
});
