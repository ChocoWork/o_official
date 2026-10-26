/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { createCatalogFixture, insertOrderWithLines, insertReturnRecord, insertReturnReceipt } from './helpers/order-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment } from './helpers/group-g1-fixtures';
import { seedGroupG3Slip, withRolePermissions } from './helpers/group-g3-fixtures';
import { seedGroupG4MixedOrder, seedGroupG4Refund, seedGroupG4Return, seedGroupG4Exchange, withGroupG4RefundReadMaterial } from './helpers/group-g4-fixtures';
import { ADMIN_ITEM_STATUS_LABELS } from '../../../src/lib/orders/item-state/item-state-types';

jest.setTimeout(60000);
type Row = { orderId: string; orderCreatedAt: string; customerName: string; customerEmail: string;
  orderItemId: string; itemName: string; color: string | null; size: string | null; isExchange: boolean;
  status: string; quantity: number; unitPrice: number; lineAmount: number; refundAmount: number;
  blockedReasons: string[]; needsAttention: boolean; statusRank?: number };
type List = { ordersCapped: boolean; ordersCap: number; totalRows: number; totalOrders: number; rows: Row[] };
const statuses = ['unpaid','payment_expired','in_production','ready','shipped','delivered','cancel_requested',
  'cancelled','return_requested','return_in_progress','refund_waiting','returned'];
const migrationDir = path.join(process.cwd(), 'supabase/migrations');
const migrationFiles = fs.readdirSync(migrationDir).filter((f) => f.endsWith('_group_g4_orders_reads.sql'));
if (migrationFiles.length !== 1) throw new Error('G4B_MIGRATION_MISSING');
const sql = fs.readFileSync(path.join(migrationDir, migrationFiles[0]), 'utf8');
const assertion = sql.split('-- G4B_FINAL_ASSERT_BEGIN')[1]?.split('-- G4B_FINAL_ASSERT_END')[0];
if (!assertion) throw new Error('G4B_FINAL_ASSERT_MISSING');
const signatures = [
  ['list_admin_order_item_rows', 'jsonb,integer,integer,uuid'], ['export_admin_order_item_rows','jsonb,uuid'],
  ['get_admin_order_detail','uuid,uuid'], ['list_admin_order_item_state_history','uuid,uuid'],
] as const;

describeLocalDb('G-4 reads: item rows, amounts, filters, export, detail and history', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string;
  let email: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']);
    email = `g4-${randomUUID()}@example.invalid`;
  });
  afterEach(async () => { await db().query('rollback'); });
  const mixed = (input: Omit<Parameters<typeof seedGroupG4MixedOrder>[1], 'email'> & { email?: string } = { quantity: 1 }) =>
    seedGroupG4MixedOrder(db(), { email, ...input });
  const list = async (filters: unknown = { email }, limit: number | null = 100, offset: number | null = 0, who: string | null = actor): Promise<List> =>
    (await db().query('select public.list_admin_order_item_rows($1::jsonb,$2,$3,$4) as r',
      [JSON.stringify(filters), limit, offset, who])).rows[0].r;
  const detail = async (id: string, who: string | null = actor) =>
    (await db().query('select public.get_admin_order_detail($1,$2) as r', [id, who])).rows[0].r;
  const exportRows = async (filters: unknown = { email }, who: string | null = actor): Promise<{ rowCount: number; orderCount: number; rows: Row[] }> =>
    (await db().query('select public.export_admin_order_item_rows($1::jsonb,$2) as r', [JSON.stringify(filters), who])).rows[0].r;
  const history = async (id: string, who: string | null = actor) =>
    (await db().query('select * from public.list_admin_order_item_state_history($1,$2)', [id, who])).rows;
  const internal = async (ids: string[]) => (await db().query('select * from private.group_g_order_item_rows($1)', [ids])).rows;
  const refund = (input: Parameters<typeof seedGroupG4Refund>[1]) => seedGroupG4Refund(db(), input);
  const sum = (rows: Row[], key: 'quantity' | 'lineAmount' | 'refundAmount') => rows.reduce((n, r) => n + r[key], 0);
  const invalid = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
  const tooLarge = { code: '22023', message: 'GROUP_G_EXPORT_TOO_LARGE' };
  const setCap = (key: 'list_cap_orders' | 'export_cap_rows', value: string) =>
    db().query('select pg_catalog.set_config($1,$2,true)', [`app.group_g_${key}`, value]);

  test('FREQ-536-AC-01: 共通欄と12列の材料は全行に付き、交換の印と購入時の写しを返す', async () => {
    const f = await mixed({ quantity: 4, shipped: 1, ready: 1, shipping: { fullName: ' Fixture ' } });
    const r = await seedGroupG4Return(db(), { orderId: f.orderId, orderItemId: f.orderItemId,
      fulfillmentId: f.shipments[0], quantity: 1, resolution: 'exchange', exchangeVariantId: f.variantId });
    const exchange = await seedGroupG4Exchange(db(), { orderId: f.orderId, sourceItemId: f.orderItemId, returnLineId: r.lineIds[0] });
    const result = await list();
    const snapshot = (await db().query('select item_name,color,size from public.order_items where id=$1', [f.orderItemId])).rows[0];
    for (const row of result.rows) {
      expect(row).toEqual({ orderId: f.orderId, orderCreatedAt: expect.any(String), customerName: 'Fixture', customerEmail: email,
        orderItemId: expect.any(String), itemName: snapshot.item_name, color: snapshot.color, size: snapshot.size,
        isExchange: row.orderItemId === exchange, status: expect.any(String), quantity: expect.any(Number),
        unitPrice: row.orderItemId === exchange ? 0 : 5000, lineAmount: expect.any(Number), refundAmount: 0,
        blockedReasons: expect.any(Array), needsAttention: false });
    }
    expect(result.rows.some((row) => row.orderItemId === exchange && row.isExchange)).toBe(true);
  });

  test('FREQ-536-AC-03: 安定した並び、1始まりの状態順位、頁をつないでも総数と順が一致する', async () => {
    const old = await mixed({ quantity: 4, shipped: 1, ready: 1, createdAt: '2026-10-01T00:00:00Z' });
    const a = await mixed({ quantity: 4, shipped: 1, ready: 1, createdAt: '2026-10-02T00:00:00Z', extraLines: 1 });
    const b = await mixed({ quantity: 4, shipped: 1, ready: 1, createdAt: '2026-10-02T00:00:00Z' });
    const all = await list();
    const expected = [...all.rows].sort((x, y) => y.orderCreatedAt.localeCompare(x.orderCreatedAt)
      || x.orderId.localeCompare(y.orderId) || x.orderItemId.localeCompare(y.orderItemId)
      || statuses.indexOf(x.status) - statuses.indexOf(y.status));
    expect(all.rows).toEqual(expected);
    expect(all.totalOrders).toBe(3);
    expect(all.rows.at(-1)?.orderId).toBe(old.orderId);
    const pages: Row[] = [];
    for (let offset = 0; offset < all.totalRows; offset += 2) {
      const page = await list({ email }, 2, offset);
      expect([page.totalRows,page.totalOrders]).toEqual([all.totalRows,3]);
      pages.push(...page.rows);
    }
    expect(pages).toEqual(all.rows);
    expect(Object.keys(ADMIN_ITEM_STATUS_LABELS)).toEqual(statuses);
    for (const row of await internal([a.orderId,b.orderId,old.orderId])) expect(row.status_rank).toBe(statuses.indexOf(row.status) + 1);
    expect((await list({ email }, 2, 100000)).rows).toEqual([]);
  });

  test('FREQ-520-AC-03: 受注生産中2・準備中1・発送済み1の排他的な数量、非表示2状態とNULL variant', async () => {
    const f = await mixed({ quantity: 4, shipped: 1, ready: 1 });
    expect((await list()).rows.map((r) => [r.status,r.quantity])).toEqual([['in_production',2],['ready',1],['shipped',1]]);
    expect(sum((await list()).rows,'quantity')).toBe(4);
    for (const status of ['payment_in_progress','abandoned']) {
      const hidden = await mixed({ quantity: 1, status });
      expect((await detail(hidden.orderId)).rows).toEqual([]);
    }
    expect((await list()).totalOrders).toBe(1);
    expect((await list()).rows.every((r) => r.orderId === f.orderId)).toBe(true);
    const missing = await mixed({ quantity: 1, variantMissing: true });
    expect((await detail(missing.orderId)).rows[0]).toMatchObject({ status: 'in_production',blockedReasons: ['variant_missing'] });
  });

  test.each([{ shipped: 1, ready: 1, parts: [33,33,34] }, { shipped: 1, ready: 0, parts: [33,67] }])
  ('FREQ-537-AC-01: ④ 正味100円を区間で割り、3区間33/33/34・2区間33/67で総和100 ($parts)', async ({ shipped,ready,parts }) => {
    // A legal integer unit price of 34 and an existing discount of 2 give the required net 100.
    const f = await mixed({ quantity: 3, itemPrice: 34, discountAmount: 2, shipped, ready });
    const rows = await internal([f.orderId]);
    expect([...rows].sort((a,b) => a.first_unit - b.first_unit).map((r) => r.line_amount)).toEqual(parts);
    expect(rows.reduce((n,r) => n + r.line_amount,0)).toBe(100);
  });

  test('FREQ-520-AC-03: 実材料の12状態すべてに共通定義順のstatus_rank 1〜12を返す', async () => {
    const ids: string[] = [];
    for (const status of statuses) {
      let orderId: string;
      if (status === 'unpaid' || status === 'payment_expired') {
        const c = await createCatalogFixture(db(),{ stock: 0 });
        const f = await insertOrderWithLines(db(),{ status: status === 'unpaid' ? 'pending' : 'failed',shippingEmail: email,
          lines: [{ itemId: c.itemId,variantId: c.variantId,quantity: 1,fulfillmentType: 'stock',reserved: false }] });
        orderId = f.orderId;
        if (status === 'payment_expired') await db().query(`insert into public.order_revisions
          (order_id,operation,before_data,after_data,changed_fields,reason)
          values($1,'status_update','{}','{"status":"failed"}',array['status'],'stripe_voucher_expired')`,[orderId]);
      } else {
        const shipping = ['shipped','delivered','return_requested','return_in_progress','refund_waiting','returned'].includes(status);
        const f = await mixed({ quantity: 1,ready: status === 'ready' ? 1 : 0,
          shipped: shipping && status !== 'delivered' ? 1 : 0,delivered: status === 'delivered' ? 1 : 0,
          cancelRequested: status === 'cancel_requested' ? 1 : 0 });
        orderId = f.orderId;
        if (status === 'cancelled') await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 100,beforeShipment: true });
        if (['return_requested','return_in_progress','refund_waiting','returned'].includes(status)) {
          const r = await insertReturnRecord(db(),{ orderId, status: status === 'return_requested' ? 'requested' : 'open',
            lines: [{ orderItemId: f.orderItemId,fulfillmentId: f.shipments[0],quantity: 1 }] });
          if (['refund_waiting','returned'].includes(status)) await insertReturnReceipt(db(),{ returnId: r.returnId,
            refundChoice: 'consult',lines: [{ returnLineId: r.lineIds[0],disposition: 'not_restocked',quantity: 1 }] });
          if (status === 'returned') await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 100,beforeShipment: false,returnId: r.returnId });
        }
      }
      ids.push(orderId);
      expect((await internal([orderId])).map((r) => [r.status,r.status_rank,r.quantity]))
        .toEqual([[status,statuses.indexOf(status)+1,1]]);
    }
    expect((await list()).totalOrders).toBe(12);
    expect((await internal(ids)).map((r) => r.status_rank).sort((a,b) => a-b)).toEqual(Array.from({ length: 12 },(_,i) => i+1));
  });

  test('FREQ-537-AC-01: 同じ状態の離れた区間も商品額・返金を区間で計算してから1行へ足す', async () => {
    const f = await mixed({ quantity: 3,ready: 3,itemPrice: 34,discountAmount: 2 });
    for (let i = 0; i < 3; i++) await seedGroupG1Shipment(db(),{ orderId: f.orderId,
      lines: [{ orderItemId: f.orderItemId,quantity: 1 }],shippedAt: `2026-10-2${i}T00:00:00Z`,
      ...(i === 1 ? { deliveredAt: '2026-10-24T00:00:00Z' } : {}) });
    await refund({ orderItemId: f.orderItemId,quantity: 2,amount: 101,beforeShipment: false });
    expect((await internal([f.orderId])).map((r) => [r.status,r.quantity,r.line_amount,r.refund_amount,r.first_unit,r.blocked_reasons]))
      .toEqual([['shipped',2,67,51,0,[]],['delivered',1,33,50,1,[]]]);
  });

  test('FREQ-537-AC-02: ⑤ 2明細の丸めた行別割引を既存関数から再利用する', async () => {
    const f = await mixed({ quantity: 3, itemPrice: 34, discountAmount: 3, extraLines: 1, ready: 1, shipped: 1 });
    const discounts = (await db().query('select * from private.order_line_discounts($1)', [f.orderId])).rows;
    expect(discounts.map((d) => d.line_discount).sort()).toEqual([1,2]);
    const d = await detail(f.orderId);
    for (const discount of discounts) expect(sum(d.rows.filter((r: Row) => r.orderItemId === discount.order_item_id),'lineAmount'))
      .toBe(102 - discount.line_discount);
    expect(sum(d.rows,'lineAmount')).toBe(d.amounts.productNet);
  });

  test('FREQ-537-AC-03: ⑥ 発送前・返品・発送後を混ぜずに配り、他明細と未成功の返金は付かない', async () => {
    const f = await mixed({ quantity: 3, delivered: 2, extraLines: 1 });
    const r = await seedGroupG4Return(db(), { orderId: f.orderId, orderItemId: f.orderItemId,
      fulfillmentId: f.shipments[0], quantity: 1 });
    await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 400,beforeShipment: true,shippingAmount: 25,adjustmentAmount: -40 });
    await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 900,beforeShipment: false,returnId: r.returnId });
    await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 250,beforeShipment: false });
    const otherItem = f.orderItemIds[1];
    await refund({ orderItemId: otherItem,quantity: 1,amount: 175,beforeShipment: true });
    await withGroupG4RefundReadMaterial(db(),f.orderItemIds,async () => {
      for (const status of ['awaiting_response','pending','error','failed'] as const) await refund({
        orderItemId: f.orderItemId,quantity: 1,amount: 10,beforeShipment: false,status });
      const d = await detail(f.orderId);
      expect(d.rows.filter((x: Row) => x.orderItemId === f.orderItemId).map((x: Row) => [x.status,x.refundAmount]))
        .toEqual([['delivered',250],['cancelled',400],['returned',900]]);
      expect(d.rows.filter((x: Row) => x.orderItemId === otherItem).map((x: Row) => [x.status,x.quantity,x.refundAmount]))
        .toEqual([['in_production',2,0],['cancelled',1,175]]);
      expect(sum(d.rows,'refundAmount')).toBe(1725);
      expect(d.amounts.refundNotAttached).toBe(-15);
      expect(d.amounts.refundProcessingAmount).toBe(20);
    });
  });

  test('FREQ-537-AC-03: ⑥b(i) 同じ配達済み1点への700円と300円の部分返金は全額1000円', async () => {
    const f = await mixed({ quantity: 1,delivered: 1,extraLines: 1 });
    await withGroupG4RefundReadMaterial(db(),f.orderItemIds,async () => {
      await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 700,beforeShipment: false,shippingAmount: 15,adjustmentAmount: -45 });
      await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 300,beforeShipment: false });
      await refund({ orderItemId: f.orderItemIds[1],quantity: 1,amount: 125,beforeShipment: true });
      const d = await detail(f.orderId);
      const rows = d.rows;
      expect(rows.find((r: Row) => r.orderItemId === f.orderItemId)).toMatchObject({ status: 'delivered',refundAmount: 1000 });
      expect(rows.filter((r: Row) => r.orderItemId === f.orderItemIds[1]).map((r: Row) => [r.status,r.refundAmount]))
        .toEqual([['cancelled',125]]);
      expect(sum(rows,'refundAmount')).toBe(1125);
      expect(d.amounts.refundNotAttached).toBe(-30);
    });
  });

  test('FREQ-537-AC-03: ⑥b(ii) 発送後の対象が0なら同じ明細の状態順へ全額、負の調整額も直接合算', async () => {
    const f = await mixed({ quantity: 3,ready: 2,extraLines: 1 });
    await withGroupG4RefundReadMaterial(db(),f.orderItemIds,async () => {
      await refund({ orderItemId: f.orderItemId,quantity: 2,amount: 101,beforeShipment: false,shippingAmount: 20,adjustmentAmount: -30 });
      await refund({ orderItemId: f.orderItemIds[1],quantity: 1,amount: 75,beforeShipment: true,shippingAmount: 5,adjustmentAmount: -20 });
      const d = await detail(f.orderId);
      expect(d.rows.filter((r: Row) => r.orderItemId === f.orderItemId).map((r: Row) => [r.status,r.refundAmount]))
        .toEqual([['in_production',50],['ready',51]]);
      expect(sum(d.rows.filter((r: Row) => r.orderItemId === f.orderItemId),'refundAmount')).toBe(101);
      expect(d.rows.filter((r: Row) => r.orderItemId === f.orderItemIds[1]).map((r: Row) => [r.status,r.quantity,r.refundAmount]))
        .toEqual([['in_production',2,0],['cancelled',1,75]]);
      expect(sum(d.rows,'refundAmount')).toBe(176);
      expect(d.amounts.refundNotAttached).toBe(-25);
      expect(d.amounts.refundedAmount).toBe(0); // The direct sum must not be reconstructed from this header.
    });
  });

  test('FREQ-537-AC-03: 発送後はdeliveredをshippedより先に使い、m=min(n,T)で端数を配る', async () => {
    const f = await mixed({ quantity: 3,delivered: 1,shipped: 2 });
    await refund({ orderItemId: f.orderItemId,quantity: 2,amount: 101,beforeShipment: false });
    expect((await detail(f.orderId)).rows.map((r: Row) => [r.status,r.refundAmount]))
      .toEqual([['shipped',51],['delivered',50]]);
  });

  test('FREQ-537-AC-04: ⑦ 元の返品の返金を交換品へ移さず、交換の単価と商品額は0', async () => {
    const f = await mixed({ quantity: 1,delivered: 1 });
    const r = await seedGroupG4Return(db(), { orderId: f.orderId, orderItemId: f.orderItemId,
      fulfillmentId: f.shipments[0],quantity: 1,resolution: 'exchange',exchangeVariantId: f.variantId });
    await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 500,beforeShipment: false,returnId: r.returnId });
    await db().query('savepoint defensive_exchange');
    try {
      // The production CHECK already requires price=0. Only this defensive read probe relaxes it, then rolls back.
      await db().query('alter table public.order_items drop constraint order_items_exchange_check');
      const exchange = await seedGroupG4Exchange(db(), { orderId: f.orderId,sourceItemId: f.orderItemId,
        returnLineId: r.lineIds[0],itemPrice: 5000 });
      expect((await detail(f.orderId)).rows.find((x: Row) => x.orderItemId === exchange))
        .toMatchObject({ isExchange: true,unitPrice: 0,lineAmount: 0,refundAmount: 0 });
    } finally { await db().query('rollback to savepoint defensive_exchange'); }
    expect((await db().query("select count(*) as n from pg_constraint where conrelid='public.order_items'::regclass and conname='order_items_exchange_check'")).rows[0].n).toBe('1');
  });

  test('FREQ-537-AC-04: ⑦b 交換品自身の返品返金がreturnedへ付き、対象0なら同じ交換明細へ戻る', async () => {
    const f = await mixed({ quantity: 1,delivered: 1 });
    const r = await seedGroupG4Return(db(), { orderId: f.orderId,orderItemId: f.orderItemId,
      fulfillmentId: f.shipments[0],quantity: 1,resolution: 'exchange',exchangeVariantId: f.variantId });
    const exchange = await seedGroupG4Exchange(db(), { orderId: f.orderId,sourceItemId: f.orderItemId,returnLineId: r.lineIds[0] });
    // With no delivered/shipped exchange range yet, its own successful after-shipment refund falls back.
    await withGroupG4RefundReadMaterial(db(),[...f.orderItemIds,exchange],async () => {
      await refund({ orderItemId: exchange,quantity: 1,amount: 100,beforeShipment: false });
      for (const status of ['pending','failed'] as const) await refund({ orderItemId: exchange,quantity: 1,amount: 10,beforeShipment: false,status });
      expect((await detail(f.orderId)).rows.find((x: Row) => x.orderItemId === exchange))
        .toMatchObject({ status: 'in_production',unitPrice: 0,lineAmount: 0,refundAmount: 100 });
    });
    // Roll back the impossible pre-shipment refund probe before exercising the real fulfillment guard.
    await seedGroupG1Allocation(db(), { orderItemId: exchange,quantity: 1,kind: 'paid' });
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId,
      lines: [{ orderItemId: exchange,quantity: 1 }],shippedAt: '2026-10-24T00:00:00Z' });
    const returned = await seedGroupG4Return(db(), { orderId: f.orderId,orderItemId: exchange,fulfillmentId: shipment,quantity: 1 });
    await withGroupG4RefundReadMaterial(db(),[...f.orderItemIds,exchange],async () => {
      await refund({ orderItemId: exchange,quantity: 1,amount: 100,beforeShipment: false });
      await refund({ orderItemId: exchange,quantity: 1,amount: 900,beforeShipment: false,returnId: returned.returnId });
      for (const status of ['pending','failed'] as const) await refund({ orderItemId: exchange,quantity: 1,amount: 10,beforeShipment: false,status });
      const d = await detail(f.orderId);
      expect(d.rows.find((x: Row) => x.orderItemId === exchange))
        .toMatchObject({ status: 'returned',unitPrice: 0,lineAmount: 0,refundAmount: 1000 });
      expect(sum(d.rows.filter((x: Row) => x.orderItemId === f.orderItemId),'refundAmount')).toBe(0);
      expect(sum(d.rows,'refundAmount')).toBe(1000);
    });
  });

  test('FREQ-537-AC-05: ⑧ 詳細の正味額・行返金・送料と調整額・処理中の額を突き合わせる', async () => {
    const f = await mixed({ quantity: 3,ready: 1,shipped: 1,discountAmount: 2,shippingAmount: 500,refundedAmount: 1270 });
    const sourceReturn = await seedGroupG4Return(db(),{ orderId: f.orderId,orderItemId: f.orderItemId,
      fulfillmentId: f.shipments[0],quantity: 1,resolution: 'exchange',exchangeVariantId: f.variantId });
    const exchange = await seedGroupG4Exchange(db(),{ orderId: f.orderId,sourceItemId: f.orderItemId,returnLineId: sourceReturn.lineIds[0] });
    await seedGroupG1Allocation(db(),{ orderItemId: exchange,quantity: 1,kind: 'paid' });
    const shipment = await seedGroupG1Shipment(db(),{ orderId: f.orderId,
      lines: [{ orderItemId: exchange,quantity: 1 }],shippedAt: '2026-10-24T00:00:00Z' });
    const exchangeReturn = await seedGroupG4Return(db(),{ orderId: f.orderId,orderItemId: exchange,fulfillmentId: shipment,quantity: 1 });
    await refund({ orderItemId: f.orderItemId,quantity: 1,amount: 1000,beforeShipment: false,shippingAmount: 100,adjustmentAmount: -30 });
    await refund({ orderItemId: exchange,quantity: 1,amount: 200,beforeShipment: false,returnId: exchangeReturn.returnId });
    const d = await detail(f.orderId);
    const successful = (await db().query(`select coalesce(sum(l.amount),0) as amount from public.order_refund_lines l
      join public.order_refunds r on r.id=l.refund_id where r.order_id=$1 and r.status='succeeded'`, [f.orderId])).rows[0].amount;
    expect(typeof successful).toBe('string');
    expect(successful).toBe('1200');
    expect(sum(d.rows,'lineAmount')).toBe(d.amounts.productNet);
    expect(sum(d.rows,'refundAmount')).toBe(Number(successful));
    expect(d.amounts).toMatchObject({ productNet: 14998,discount: 2,shipping: 500,total: 15498,
      paidAmount: 15498,refundedAmount: 1270,refundAttachedToRows: 1200,refundNotAttached: 70,refundProcessingAmount: 0 });
    const perItem = (await db().query(`select l.order_item_id,sum(l.amount) as amount from public.order_refund_lines l
      join public.order_refunds r on r.id=l.refund_id where r.order_id=$1 and r.status='succeeded'
      group by l.order_item_id`,[f.orderId])).rows;
    expect(perItem).toEqual(expect.arrayContaining([
      { order_item_id: f.orderItemId,amount: '1000' },{ order_item_id: exchange,amount: '200' },
    ]));
    expect(perItem).toHaveLength(2);
    for (const [id,expected] of [[f.orderItemId,1000],[exchange,200]] as const) {
      const rowSum = sum(d.rows.filter((r: Row) => r.orderItemId === id),'refundAmount');
      expect(rowSum).toBe(expected);
      expect(rowSum).toBe(Number(perItem.find((r) => r.order_item_id === id).amount));
    }
    expect(d.rows.find((r: Row) => r.orderItemId === exchange)).toMatchObject({ isExchange: true,unitPrice: 0,lineAmount: 0,refundAmount: 200 });
    expect(sum(d.rows,'refundAmount') + d.amounts.refundNotAttached).toBe(d.amounts.refundedAmount);
  });

  test('FREQ-536-AC-02: 日本時間の日付境界、注文番号のORD有無・大小・8桁・完全UUID', async () => {
    const a = await mixed({ quantity: 1,createdAt: '2026-10-20T14:59:59Z' });
    const b = await mixed({ quantity: 1,createdAt: '2026-10-20T15:00:00Z' });
    expect((await list({ email,dateFrom: '2026-10-20',dateTo: '2026-10-20' })).rows.map((r) => r.orderId)).toEqual([a.orderId]);
    expect((await list({ email,dateFrom: '2026-10-21',dateTo: '2026-10-21' })).rows.map((r) => r.orderId)).toEqual([b.orderId]);
    for (const orderNumber of [a.orderId,a.orderId.slice(0,8),`ORD-${a.orderId.slice(0,8).toUpperCase()}`,`ord-${a.orderId.slice(0,8)}`])
      expect((await list({ email,orderNumber })).rows.map((r) => r.orderId)).toEqual([a.orderId]);
  });

  test('FREQ-536-AC-02: pi検索は前方一致で_を文字どおり扱い、200字は通り201字と不正文字は拒否', async () => {
    const suffix = randomUUID().replaceAll('-','');
    const f = await mixed({ quantity: 1,paymentIntentId: `pi_${suffix}_tail` });
    await mixed({ quantity: 1,paymentIntentId: `piX${suffix}_tail` });
    expect((await list({ email,orderNumber: `PI_${suffix}_` })).rows.map((r) => r.orderId)).toEqual([f.orderId]);
    const long = await mixed({ quantity: 1,paymentIntentId: `pi_${'x'.repeat(197)}` });
    expect((await list({ email,orderNumber: `pi_${'x'.repeat(197)}` })).rows[0].orderId).toBe(long.orderId);
    for (const orderNumber of ['pi_','pi_abc%','pi_abc-','pi_abc\\',`pi_${'x'.repeat(198)}`])
      expect(await flow.rejected(() => list({ email,orderNumber }))).toEqual(invalid);
  });

  test.each([{ key: 'customer',mark: '%' },{ key: 'customer',mark: '_' },{ key: 'email',mark: '%' },{ key: 'email',mark: '_' }])
  ('FREQ-536-AC-02: $key の $mark は他の絞り込みなしでも文字どおり一致する', async ({ key,mark }) => {
    const tag = randomUUID().replaceAll('-','');
    const needle = `${tag}A${mark}B`;
    const control = `${tag}A${mark === '%' ? 'XYZ' : 'Z'}B`;
    const literalOrder = await mixed({ quantity: 1,email: key === 'email' ? `${needle}@example.invalid` : `${tag}-literal@example.invalid`,
      shipping: { fullName: key === 'customer' ? needle : `${tag} Literal` } });
    await mixed({ quantity: 1,email: key === 'email' ? `${control}@example.invalid` : `${tag}-control@example.invalid`,
      shipping: { fullName: key === 'customer' ? control : `${tag} Control` } });
    const filters = { [key]: needle };
    const result = await list(filters);
    expect(result.totalOrders).toBe(1);
    expect(result.rows.map((r) => r.orderId)).toEqual([literalOrder.orderId]);
    expect((await exportRows(filters)).rows.map((r) => r.orderId)).toEqual([literalOrder.orderId]);
  });

  test('FREQ-536-AC-02: 顧客とメールの%・_・バックスラッシュは文字どおり、商品色サイズ状態は行単位', async () => {
    const literal = `lit%_\\${randomUUID()}@example.invalid`;
    const f = await mixed({ email: literal,quantity: 3,ready: 1,shipped: 1,extraLines: 1,shipping: { fullName: 'A%_\\B' } });
    await mixed({ email: literal.replace('%_\\','XYZ'),quantity: 1,shipping: { fullName: 'AXYZB' } });
    expect((await list({ email: literal,customer: '%_\\' })).totalOrders).toBe(1);
    const result = await list({ email: literal,product: '照合',color: 'black',size: 'm',statuses: ['ready'] });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ orderId: f.orderId,orderItemId: f.orderItemId,status: 'ready',customerEmail: literal });
    expect((await list({ email: literal,product: '%' })).rows).toEqual([]);
    expect((await list({ email: literal,color: '_' })).rows).toEqual([]);
    expect((await list({ email: literal,size: '%' })).rows).toEqual([]);
    // A zero-priced additional purchased line preserves the order amount while giving each row filter a distinct snapshot.
    const special = (await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type)
      values($1,$2,$3,$4,0,$5,$6,1,0,'stock') returning id`,
    [f.orderId,f.itemId,f.variantId,'Needle%_\\','Ink_','L%'])).rows[0].id as string;
    for (const filter of [{ product: 'needle%_\\' },{ color: 'ink_' },{ size: 'l%' },
      { product: 'needle%_\\',color: 'ink_',size: 'l%' }]) {
      const rows = (await list({ email: literal,...filter })).rows;
      expect(rows.map((r) => r.orderItemId)).toEqual([special]);
      expect(rows[0]).toMatchObject({ orderId: f.orderId,customerEmail: literal,customerName: 'A%_\\B' });
    }
  });

  test.each([null,[],{ bogus: true },{ email: '' },{ email: 1 },{ email: 'x'.repeat(201) },
    { dateFrom: '2026-02-30' },{ dateTo: '2026-13-01' },{ dateFrom: '2026-2-01' },
    { dateFrom: '2026-10-02',dateTo: '2026-10-01' },{ statuses: ['unknown'] },{ statuses: [null] },
    { statuses: 'ready' },{ statuses: Array(13).fill('ready') },{ attention: 'true' },{ orderNumber: 'xyz' }])
  ('FREQ-536-AC-02: 不正な形・キー・長さ・暦日・状態を拒否する (%j)', async (filters) => {
    expect(await flow.rejected(() => list(filters))).toEqual(invalid);
    expect(await flow.rejected(() => exportRows(filters))).toEqual(invalid);
  });

  test.each([[null,0],[0,0],[101,0],[1,null],[1,-1]])
  ('FREQ-536-AC-03: limit/offset の範囲外とNULLを拒否する (%s,%s)', async (limit,offset) => {
    expect(await flow.rejected(() => list({ email },limit,offset))).toEqual(invalid);
  });

  test('FREQ-538-AC-02: CSV材料は頁外を含む1つのjsonbで、一覧を全頁つないだ値と並びに一致する', async () => {
    await mixed({ quantity: 4,ready: 1,shipped: 1 });
    await mixed({ quantity: 2,ready: 1,createdAt: '2026-10-01T00:00:00Z' });
    const result = await exportRows();
    const all = await list();
    const pages: Row[] = [];
    for (let offset = 0; offset < all.totalRows; offset += 2) pages.push(...(await list({ email },2,offset)).rows);
    expect(result).toEqual({ rowCount: all.totalRows,orderCount: all.totalOrders,rows: pages.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([key]) => !['blockedReasons','needsAttention'].includes(key)))) });
    expect(Object.keys(result).sort()).toEqual(['orderCount','rowCount','rows']);
    expect((await exportRows({ email,statuses: ['ready'] })).rows).toHaveLength(2);
  });

  test('FREQ-538-AC-05: 行数capと注文数capは全件を断り、候補がcap超なら投影を呼ばない', async () => {
    await mixed({ quantity: 4,ready: 1,shipped: 1 });
    await setCap('export_cap_rows','2');
    expect(await flow.rejected(() => exportRows())).toEqual(tooLarge);
    const own = `cap-${randomUUID()}@example.invalid`;
    for (let i = 0; i < 3; i++) await mixed({ email: own,quantity: 1 });
    await db().query('savepoint no_projection');
    try {
      // A body that raises proves the capped order path returns before any projection is invoked.
      const def = (await db().query("select pg_get_functiondef('private.group_g_order_item_rows(uuid[])'::regprocedure) as d")).rows[0].d as string;
      const header = def.slice(0,def.indexOf('AS $function$'));
      await db().query(`${header.replace('LANGUAGE sql','LANGUAGE plpgsql')} AS $function$ BEGIN RAISE EXCEPTION 'G4_PROJECTION_CALLED'; END $function$`);
      expect(await flow.rejected(() => exportRows({ email: own }))).toEqual(tooLarge);
    } finally { await db().query('rollback to savepoint no_projection'); }
  });

  test('FREQ-536-AC-03: 一覧は新しい2注文を旗で知らせ、同日ID境界・dateTo・0行・CSV独立を守る', async () => {
    const fixtures = [];
    for (const createdAt of ['2026-10-01','2026-10-02','2026-10-03','2026-10-03']) fixtures.push(await mixed({
      quantity: 2,ready: 1,createdAt: `${createdAt}T00:00:00Z` }));
    await setCap('list_cap_orders','2');
    const expectedIds = fixtures.slice(2).map((f) => f.orderId).sort();
    const capped = await list();
    expect(capped).toMatchObject({ ordersCapped: true,ordersCap: 2,totalOrders: 2,totalRows: 4 });
    expect([...new Set(capped.rows.map((r) => r.orderId))]).toEqual(expectedIds);
    expect(await list({ email,statuses: ['returned'] })).toEqual({ ordersCapped: true,ordersCap: 2,totalOrders: 0,totalRows: 0,rows: [] });
    expect(await list({ email,dateTo: '2026-10-02' })).toMatchObject({ ordersCapped: false,totalOrders: 2,totalRows: 4 });
    expect((await exportRows()).orderCount).toBe(4);
    expect((await exportRows()).rowCount).toBe(8);
    await setCap('list_cap_orders','1');
    expect([...new Set((await list()).rows.map((r) => r.orderId))]).toEqual(expectedIds.slice(0,1));
  });

  test.each(['100000','garbage','0','-1','','999999999999999999999999'])
  ('FREQ-536-AC-03: 上げる設定と不正な設定は既定capを変えない (%s)', async (value) => {
    await mixed({ quantity: 1 });
    await setCap('list_cap_orders',value);
    expect(await list()).toMatchObject({ ordersCap: 5000,ordersCapped: false,totalOrders: 1 });
    await setCap('export_cap_rows',value);
    expect((await exportRows()).rowCount).toBe(1);
    // Inspect the cap argument via a transaction-local stand-in; no 20,001-order fixture is necessary.
    await db().query(`create or replace function private.group_g_order_candidates(_filters jsonb,_cap integer)
      returns table(order_ids uuid[],matched_orders bigint,capped boolean)
      language plpgsql stable security definer set search_path='' as $standin$
      begin if _cap <> 20000 then raise exception 'G4_BAD_EXPORT_CAP'; end if;
      return query select array[]::uuid[],0::bigint,false; end $standin$`);
    expect(await exportRows()).toEqual({ rowCount: 0,orderCount: 0,rows: [] });
  });

  test('FREQ-540-AC-13: 全4入口は役割なし・無効・期限切れ・read欠落を拒否し、有効役割の和集合で通る', async () => {
    const f = await mixed({ quantity: 1 });
    const calls = (who: string | null) => [() => list({ email },100,0,who),() => exportRows({ email },who),
      () => detail(f.orderId,who),() => history(f.orderId,who)];
    for (const who of [null,randomUUID(),await flow.createActor([]),await flow.createActor(['supporter'],{ inactive: ['supporter'] }),
      await flow.createActor(['supporter'],{ expired: ['supporter'] })]) {
      for (const call of calls(who)) expect(await flow.rejected(call)).toEqual({ code: '42501',message: 'GROUP_G_FORBIDDEN' });
    }
    await withRolePermissions(db(),'supporter',[],['admin.orders.read'],async () => {
      for (const call of calls(actor)) expect(await flow.rejected(call)).toEqual({ code: '42501',message: 'GROUP_G_FORBIDDEN' });
    });
    for (const who of [actor,await flow.manager(),await flow.createActor(['admin','supporter'],{ expired: ['supporter'] })])
      for (const call of calls(who)) await call();
    for (const role of ['anon','authenticated']) for (const [name,args] of signatures) {
      expect((await db().query('select has_function_privilege($1,$2,\'EXECUTE\') as ok',[role,`public.${name}(${args})`])).rows[0].ok).toBe(false);
    }
  });

  test('FREQ-536-AC-02: attention=falseと未指定は絞り込まず、trueだけ要対応の注文を返す', async () => {
    const attended = await mixed({ quantity: 1 });
    const clean = await mixed({ quantity: 1 });
    await db().query("update public.orders set review_reason='stock_not_reserved',review_marked_at=now() where id=$1",[attended.orderId]);
    const all = await list({ email });
    expect(all.totalOrders).toBe(2);
    expect([...new Set(all.rows.map((r) => r.orderId))].sort()).toEqual([attended.orderId,clean.orderId].sort());
    expect(await list({ email,attention: false })).toEqual(all);
    expect(await exportRows({ email,attention: false })).toEqual(await exportRows({ email }));
    expect((await list({ email,attention: true })).rows.map((r) => r.orderId)).toEqual([attended.orderId]);
    expect((await exportRows({ email,attention: true })).rows.map((r) => r.orderId)).toEqual([attended.orderId]);
  });

  test('FREQ-539-AC-01: 詳細の権限旗、未解決の要対応3種、存在しない注文と非表示注文', async () => {
    const f = await mixed({ quantity: 2,shipped: 1 });
    const manager = await flow.manager();
    expect((await detail(f.orderId,manager)).permissions).toEqual({ read: true,manage: true,refund: true,return: true,allocate: true,shippingRead: true });
    expect((await detail(f.orderId)).permissions).toMatchObject({ read: true,refund: false,allocate: false });
    await withRolePermissions(db(),'supporter',['admin.orders.allocate'],[],async () => {
      expect((await detail(f.orderId)).permissions.allocate).toBe(true);
    });
    await withRolePermissions(db(),'supporter',[],['admin.shipping.read','admin.orders.manage'],async () => {
      expect((await detail(f.orderId)).permissions).toMatchObject({ shippingRead: false,manage: false });
    });
    await db().query("update public.orders set review_reason='stock_not_reserved',review_marked_at=now() where id=$1",[f.orderId]);
    expect((await list({ email,attention: true })).totalOrders).toBe(1); // Review alone.
    const exception = (await db().query(`insert into public.payment_exceptions(payment_ref,order_id,reason,detection_count)
      values($1,$2,'state_conflict',3) returning id`,[randomUUID(),f.orderId])).rows[0].id;
    await db().query(`insert into public.payment_exceptions(payment_ref,order_id,reason,resolved_at)
      values($1,$2,'unexpected_state',now())`,[randomUUID(),f.orderId]);
    await db().query('savepoint payment_attention_only');
    try {
      await db().query('update public.orders set reviewed_at=now() where id=$1',[f.orderId]);
      expect((await list({ email,attention: true })).totalOrders).toBe(1); // Open payment exception alone.
    } finally { await db().query('rollback to savepoint payment_attention_only'); }
    await db().query(`insert into public.order_fulfillment_attention(fulfillment_id,kind) values($1,'tracking_not_found')`,[f.shipments[0]]);
    await db().query(`insert into public.order_fulfillment_attention(fulfillment_id,kind,resolved_at,resolution)
      values($1,'tracking_stalled',now(),'auto')`,[f.shipments[0]]);
    const d = await detail(f.orderId);
    expect(d.attention.paymentExceptions).toEqual([{ id: exception,reason: 'state_conflict',detectionCount: 3,firstDetectedAt: expect.any(String) }]);
    expect(d.attention.review).toEqual({ reason: 'stock_not_reserved',markedAt: expect.any(String) });
    expect(d.attention.deliveries).toEqual([{ fulfillmentId: f.shipments[0],kind: 'tracking_not_found',openedAt: expect.any(String) }]);
    expect((await list({ email,attention: true })).rows.every((r) => r.needsAttention)).toBe(true);
    expect(await list({ email,attention: false })).toEqual(await list({ email }));
    await db().query('update public.payment_exceptions set resolved_at=now() where id=$1',[exception]);
    await db().query('update public.orders set reviewed_at=now() where id=$1',[f.orderId]);
    expect((await list({ email,attention: true })).totalOrders).toBe(1); // Delivery attention alone.
    await db().query("update public.order_fulfillment_attention set resolved_at=now(),resolution='auto' where fulfillment_id=$1 and resolved_at is null",[f.shipments[0]]);
    expect((await list({ email,attention: true })).rows).toEqual([]);
    expect((await detail(f.orderId)).attention).toEqual({ paymentExceptions: [],review: null,deliveries: [] });
    for (const read of [detail,history]) expect(await flow.rejected(() => read(randomUUID())))
      .toEqual({ code: 'P0002',message: 'GROUP_G_ORDER_NOT_FOUND' });
    const hidden = await mixed({ quantity: 1,status: 'payment_in_progress' });
    expect((await detail(hidden.orderId)).rows).toEqual([]);
  });

  test('FREQ-539-AC-04: G3確定とG2受取の本物の操作は履歴に番号つき参照が付く', async () => {
    actor = await flow.manager();
    const f = await mixed({ quantity: 2,ready: 1 });
    const slip = await seedGroupG3Slip(db(),{ actorId: actor,draftLines: [{ orderItemId: f.orderItemId,quantity: 1 }] });
    await db().query('select public.admin_confirm_shipment_slip($1,1,null,null,$2::date,false,$3,$4)',
      [slip,'2026-10-26',actor,randomUUID()]);
    const po = await flow.create(actor,[{ variantId: f.variantId,quantity: 1 }]);
    const lines = await flow.linesOf(po.id);
    const version = await flow.confirmQuantities(actor,po.id,lines,[1]);
    await flow.receive({ orderId: po.id,version,lines: [{ lineId: lines[0].id,quantity: 1 }],actor });
    const rows = await history(f.orderId);
    const slipNumber = (await db().query('select number from public.shipment_slips where id=$1',[slip])).rows[0].number;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref_kind: 'shipment_slip',ref_id: slip,ref_label: slipNumber,actor_id: actor }),
      expect.objectContaining({ ref_kind: 'purchase_order',ref_id: po.id,ref_label: po.number }),
    ]));
  });

  test('FREQ-539-AC-04: 履歴は注文に限定し日時DESCとid順、301行の歯止め、自動と入替の相手を返す', async () => {
    const f = await mixed({ quantity: 1 });
    const donor = await mixed({ quantity: 1,email: `donor-${randomUUID()}@example.invalid` });
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'allocation_swap',$2,repeat('a',64),'order_item',$3,$4::jsonb)`,
    [op,randomUUID(),f.orderItemId,JSON.stringify({ takerOrderId: f.orderId,donorOrderId: donor.orderId,reason: 'fixture reason' })]);
    const inserted = await db().query(`insert into public.order_item_state_events
      (order_item_id,unit_from,unit_to,from_status,to_status,operation_id,sequence,reason,actor_id,version,created_at)
      select $1,0,1,'in_production','ready',$2,g,'allocation_swap',null,g,now()+interval '1 hour'
      from generate_series(1,302) as g returning id,created_at`,[f.orderItemId,op]);
    await db().query(`insert into public.order_item_state_events
      (order_item_id,unit_from,unit_to,from_status,to_status,operation_id,sequence,reason,actor_id,version)
      values($1,0,1,'ready','in_production',$2,1,'allocation_swap',null,1)`,[donor.orderItemId,op]);
    const rows = await history(f.orderId);
    expect(rows).toHaveLength(301);
    expect(rows.map((r) => r.id)).toEqual(inserted.rows.map((r) => r.id as string).sort().slice(0,301));
    for (const r of rows) expect(r).toMatchObject({ order_item_id: f.orderItemId,actor_id: null,
      operation: 'allocation_swap',ref_kind: null,ref_id: null,ref_label: null,note: 'fixture reason',counterpart_order_id: donor.orderId });
    expect((await history(donor.orderId))[0].counterpart_order_id).toBe(f.orderId);
  });

  test('FREQ-540-AC-13: 入口4本のSQL委譲とSTABLE/DEFINER/ACL、内部3本のACLなし、末尾assert成功', async () => {
    for (const [name,args] of signatures) {
      for (const schema of ['public','private']) {
        const row = (await db().query(`select p.prosecdef,p.provolatile,l.lanname,
          has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p
          join pg_language l on l.oid=p.prolang where p.oid=$1::regprocedure`,[`${schema}.${name}(${args})`])).rows[0];
        expect(row).toMatchObject({ prosecdef: schema === 'private',provolatile: 's',service: true });
        if (schema === 'public') expect(row.lanname).toBe('sql');
      }
    }
    for (const sig of ['group_g_order_candidates(jsonb,integer)','group_g_order_attention_ids(uuid[])','group_g_order_item_rows(uuid[])'])
      for (const role of ['anon','authenticated','service_role']) expect((await db().query(
        "select has_function_privilege($1,$2,'EXECUTE') as ok",[role,`private.${sig}`])).rows[0].ok).toBe(false);
    await db().query(assertion);
  });
});
