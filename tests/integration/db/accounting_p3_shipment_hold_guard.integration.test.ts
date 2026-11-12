/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder } from './helpers/group-g3-fixtures';
import { seedDispute, seedDisputeReversal } from './helpers/accounting-orders-fixtures';
import { seedDisputeHold } from './helpers/accounting-returns-fixtures';

// Accounting plan 3 Task 5 (S19, FREQ-580-AC-02 / AC-03): the shipment slip confirm refuses an order under a dispute hold
// (ACCOUNTING_DISPUTE_HOLD / 55000) after the replay branch and before anything is written. ROLLBACK form (run with --runInBand).
jest.setTimeout(120000);
type Confirmed = { id: string; version: number; replayed: boolean; fulfillments: { orderId: string; fulfillmentId: string }[] };

describeLocalDb('S19 shipment slip confirm hold guard: controller only', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let today: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']); today = await flow.today();
  });
  afterEach(async () => { await db().query('rollback'); });
  const ready = () => seedGroupG3ReadyOrder(db(), {});
  const draft = async (lines: { orderItemId: string; quantity: number }[]) => (await db().query(
    'select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r', [JSON.stringify(lines), actor, randomUUID()],
  )).rows[0].r as { id: string; version: number };
  const confirm = async (id: string, key = randomUUID()): Promise<Confirmed> => (await db().query(
    'select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,true,$5,$6) as r', [id, 'yamato', 'ab-123', today, actor, key])).rows[0].r;
  const tables = ['public.orders', 'public.stock_movements', 'public.order_item_allocations', 'public.order_item_allocation_events',
    'public.order_item_state_events', 'public.order_fulfillments', 'public.order_fulfillment_lines', 'public.order_fulfillment_events',
    'public.shipment_slips', 'public.shipment_slip_lines', 'public.shipment_slip_fulfillments', 'public.shipment_slip_versions',
    'public.shipment_date_history', 'private.group_g_operations', 'private.order_email_outbox'];
  const snapshot = async () => Promise.all(tables.map(async (table) => (await db().query(
    `select md5(coalesce(string_agg(v, ',' order by v),'')) as digest from (select to_jsonb(t)::text as v from ${table} t) x`,
  )).rows[0].digest as string));
  const stageOf = async (id: string) => (await db().query('select stage from public.shipment_slips where id=$1', [id])).rows[0].stage as string;
  const holdRefusal = (orderCount: number) => ({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: `order_count=${orderCount}` });

  test('FREQ-580-AC-02: 判断待ちの注文を含む発送票の確定は ACCOUNTING_DISPUTE_HOLD（55000）で断り、発送票は下書きのままで、発送の行も在庫の動きも増えない', async () => {
    const a = await ready();
    const slip = await draft([{ orderItemId: a.orderItemId, quantity: 2 }]);
    await seedDisputeHold(db(), a.orderId);
    const before = await snapshot();
    expect(await flow.rejected(() => confirm(slip.id))).toEqual(holdRefusal(1));
    expect(await snapshot()).toEqual(before);
    expect(await stageOf(slip.id)).toBe('draft');
    expect((await db().query('select count(*)::int n from public.order_fulfillments where order_id=$1', [a.orderId])).rows[0].n).toBe(0);
  });

  test('FREQ-580-AC-02: 複数の注文を束ねた発送票は、1つでも判断待ちなら全体を断る', async () => {
    const a = await ready(); const b = await ready();
    const slip = await draft([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 1 })));
    await seedDisputeHold(db(), b.orderId);
    const before = await snapshot();
    expect(await flow.rejected(() => confirm(slip.id))).toEqual(holdRefusal(1));
    expect(await snapshot()).toEqual(before);
    expect(await stageOf(slip.id)).toBe('draft');
  });

  test('FREQ-580-AC-03: 判断待ちが確定または取り下げになると、同じ発送票を確定できる', async () => {
    const a = await ready(); const b = await ready();
    const slip = await draft([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 1 })));
    const openA = await seedDisputeHold(db(), a.orderId);
    const openB = await seedDisputeHold(db(), b.orderId);
    expect(await flow.rejected(() => confirm(slip.id))).toEqual(holdRefusal(2));
    // a は取り下げ（引かれた額が戻る）、b は確定（負け）で、判断待ちから外れる。1つでも残る間は断る
    await seedDisputeReversal(db(), { disputeId: openA, amount: 5000, createdAt: '2026-11-02T00:00:00Z' });
    expect(await flow.rejected(() => confirm(slip.id))).toEqual(holdRefusal(1));
    await db().query("update public.stripe_disputes set status='lost' where id=$1", [openB]);
    const result = await confirm(slip.id);
    expect(result).toMatchObject({ id: slip.id, version: 2, replayed: false });
    expect(await stageOf(slip.id)).toBe('confirmed');
  });

  test('FREQ-580-AC-03: 判断待ちの無い発送票の確定は今までどおりで、再送は前の結果を返す（replayed）', async () => {
    const a = await ready();
    const slip = await draft([{ orderItemId: a.orderItemId, quantity: 2 }]);
    const key = randomUUID();
    const first = await confirm(slip.id, key);
    expect(first).toMatchObject({ id: slip.id, version: 2, replayed: false });
    expect(await confirm(slip.id, key)).toEqual({ ...first, replayed: true });
  });

  test('FREQ-580-AC-03: 確定済みの発送票の再送は、その注文が後から判断待ちになっても前の結果を返す（replayed。再送の枝は止めの前）', async () => {
    const a = await ready();
    const slip = await draft([{ orderItemId: a.orderItemId, quantity: 2 }]);
    const key = randomUUID();
    const first = await confirm(slip.id, key);
    await seedDisputeHold(db(), a.orderId);
    const before = await snapshot();
    expect(await confirm(slip.id, key)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });

  test('FREQ-580-AC-02: 事前の問い合わせ（warning系）の注文は止めない', async () => {
    const a = await ready();
    const slip = await draft([{ orderItemId: a.orderItemId, quantity: 2 }]);
    await seedDispute(db(), { orderId: a.orderId, amount: 5000, withdrawnAt: null, status: 'warning_needs_response' });
    expect(await confirm(slip.id)).toMatchObject({ id: slip.id, replayed: false });
  });
});
