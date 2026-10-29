/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import { seedGroupG4MixedOrder } from './helpers/group-g4-fixtures';
import { hReceive, hRefundFixture, hResult, hReturn } from './helpers/group-h-refund-fixtures';
import { randomUUID } from 'node:crypto';

describeLocalDb('H5 G-4 status amounts (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  test('FREQ-551-AC-04: G-4の返品済み17000円と残った20000円の和は37000円で他行へ返金が混ざらない', async () => {
    const f = await hRefundFixture(db(), true); const r = await hReturn(db(), f); await hReceive(db(), f, r);
    const refund = (await db().query('select * from public.admin_refund_return($1,$2,$3,16000,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0];
    await hResult(db(), refund.refund_id, 'succeeded');
    const rows = (await db().query('select * from private.group_g_order_item_rows($1)', [[f.orderId]])).rows;
    expect(rows.find(v => v.status === 'returned')).toMatchObject({ quantity: 1, line_amount: 17000, refund_amount: 17000 });
    expect(rows.filter(v => v.status !== 'returned').reduce((n, v) => n + v.line_amount, 0)).toBe(20000);
    expect(rows.reduce((n, v) => n + v.line_amount, 0)).toBe(37000);
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1', [refund.refund_id])).rows[0].adjustment_amount).toBe(-1000);
    const other = await hRefundFixture(db(), true);
    const both = (await db().query('select * from private.group_g_order_item_rows($1)', [[f.orderId, other.orderId]])).rows;
    expect(both.filter(v => v.order_id === other.orderId).every(v => v.refund_amount === 0)).toBe(true);
  });
  test('FREQ-551-AC-04: 旧３点100円は33/33/34の区間floorを保つ', async () => {
    const old = await seedGroupG4MixedOrder(db(), { email: `h5-${randomUUID()}@example.invalid`, quantity: 3, itemPrice: 34, discountAmount: 2, shipped: 1, ready: 1 });
    const rows = (await db().query('select * from private.group_g_order_item_rows($1) order by first_unit', [[old.orderId]])).rows;
    expect(rows.map(r => r.line_amount)).toEqual([33, 33, 34]);
    expect(rows.reduce((sum, r) => sum + r.line_amount, 0)).toBe(100);
  });
});
