/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder, variantStock } from './helpers/order-fixtures';
import { hDiscount, seedHDiscount, seedHMember } from './helpers/group-h-fixtures';
import { hResult, withH5ReturnBaseline } from './helpers/group-h-refund-fixtures';

jest.setTimeout(30000);
type Choice = 'now' | 'consult';
type Unit = { return_line_id: string; disposition: string; quantity: number; refund_choice?: Choice | null };
type Group = { quantity: number; exchange?: boolean; exchangeMethod?: 'stock' | 'make'; extraItem?: boolean };
type Options = { amounts?: number[]; legacy?: boolean; price?: number; quantity?: number; discount?: number;
  groups?: Group[]; percent?: number; fixed?: number; shipping?: number; paid?: number;
  source?: 'shop' | 'customer_request'; method?: 'customer_ships' | 'not_required'; extraStock?: number };
type Fx = Awaited<ReturnType<typeof fixture>>;
type ReceiveOptions = { key?: string; can?: boolean; amount?: number | null; shipping?: number;
  overrides?: { return_line_id: string; action: string }[]; notify?: boolean };

/** Prices are inserted once; approval, not a claim UPDATE, binds sorted line IDs to cheap units. */
async function fixture(db: PgClient, o: Options = {}) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222',restocking_fee_enabled=true,
    exchange_fees_enabled=true,inspection_enabled=true,no_return_needed_enabled=true where id=1`);
  await db.query("update public.shop_return_reason_settings set out_of_stock_exchange='decline' where reason='unknown'");
  const actor = await seedHMember(db);
  const amounts = o.amounts;
  const quantity = amounts?.length ?? o.quantity ?? 2;
  const price = o.price ?? (amounts ? Math.max(...amounts) : 999);
  const discount = o.discount ?? (amounts ? price * quantity - amounts.reduce((a, b) => a + b, 0) : 0);
  const catalog = await createCatalogFixture(db, { stock: quantity + (o.extraStock ?? 2) });
  const groups = o.groups ?? [{ quantity }];
  const extraCatalog = groups.some(g => g.extraItem) ? await createCatalogFixture(db, { stock: 2 }) : null;
  const order = await insertOrderWithLines(db, { status: 'paid', shippingAmount: o.shipping ?? 0,
    discountAmount: discount, paidAmount: o.paid ?? price * quantity - discount + (o.shipping ?? 0) + (extraCatalog ? 5000 : 0),
    paymentIntentId: `pi_rr_${randomUUID()}`,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, itemPrice: price, fulfillmentType: 'stock' },
      ...(extraCatalog ? [{ itemId: extraCatalog.itemId, variantId: extraCatalog.variantId, quantity: 1,
        itemPrice: 5000, fulfillmentType: 'stock' as const }] : [])] });
  const itemId = order.orderItemIds[0];
  if (amounts && !o.legacy) {
    if (discount > 0) {
      // Fixed discounts require a positive amount minimum strictly above the discount.
      // Keep both the allocation and unit prices unchanged; the gross line amount supplies that minimum.
      const discountId = await seedHDiscount(db, hDiscount({ value: { type: 'amount', value: discount },
        minimum: { type: 'amount', value: price * quantity } }));
      await db.query(`insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount)
        values($1,$2,$3,$4)`, [order.orderId, itemId, discountId, discount]);
    }
    for (const [index, amount] of amounts.entries()) await db.query(`insert into public.order_line_unit_amounts
      (order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)`, [order.orderId, itemId, index, amount]);
  }
  const shipped = await shipFixtureOrder(db, { orderId: order.orderId, actorId: actor, trackingNumber: 'RR-FIXTURE',
    lines: order.orderItemIds.map((id, i) => ({ order_item_id: id, quantity: i === 0 ? quantity : 1 })) });
  const returnId = (await db.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,1,$2,'requested',$3,'rr-fixture',now(),$4,'customer_ships','customer',false) returning id`,
  [order.orderId, o.source ?? 'customer_request', randomUUID(), actor])).rows[0].id as string;
  const lineIds = groups.map(() => randomUUID()).sort();
  for (const [i, group] of groups.entries()) {
    const variant = group.extraItem ? extraCatalog!.variantId : catalog.variantId;
    await db.query(`insert into public.order_return_lines
      (id,return_id,fulfillment_id,order_item_id,quantity,reason,requested_resolution,
       requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,$4,$5,'unknown',$6,$7,$6,$7,$8)`,
    [lineIds[i], returnId, shipped.fulfillment_id, group.extraItem ? order.orderItemIds[1] : itemId,
      group.quantity, group.exchange ? 'exchange' : 'refund', group.exchange ? variant : null, group.exchange ? group.exchangeMethod ?? 'make' : null]);
  }
  const approval = groups.map((g, i) => ({ return_line_id: lineIds[i], resolution: g.exchange ? 'exchange' : 'refund',
    exchange_variant_id: g.exchange ? (g.extraItem ? extraCatalog!.variantId : catalog.variantId) : null,
    exchange_method: g.exchange ? g.exchangeMethod ?? 'make' : null }));
  expect((await db.query(`select * from public.admin_approve_return($1,$2,$3::jsonb,$4,'customer',null,null,$5,$6,0,0,null,false)`,
    [returnId, actor, JSON.stringify(approval), o.fixed ? 'shop_label' : o.method ?? 'customer_ships', o.fixed ?? 0, o.percent ?? 0])).rows)
    .toEqual([{ return_id: returnId, status: 'open' }]);
  return { orderId: order.orderId, itemId, actor, returnId, lineIds, catalog, groups };
}

const unit = (f: Fx, index: number, choice?: Choice, quantity = 1, disposition = 'not_restocked'): Unit => ({
  return_line_id: f.lineIds[index], disposition, quantity, ...(choice ? { refund_choice: choice } : {}),
});
async function receive(db: PgClient, f: Fx, units: Unit[], choice: string, o: ReceiveOptions = {}) {
  return (await db.query(`select * from public.admin_receive_return($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,null,$10,null,null,null)`,
    [f.returnId, f.actor, o.can ?? true, o.key ?? randomUUID(), JSON.stringify(units), JSON.stringify(o.overrides ?? []),
      choice, o.amount ?? null, o.shipping ?? 0, o.notify ?? false])).rows[0];
}
const consultRefund = async (db: PgClient, f: Fx) => (await db.query(
  'select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [f.returnId, f.actor, randomUUID()])).rows[0];
const detail = async (db: PgClient, f: Fx) => (await db.query('select private.return_detail_json($1) j', [f.returnId])).rows[0].j;
const fees = async (db: PgClient, f: Fx) => (await db.query(
  'select fee_pending_deduction,fee_due_amount,status from public.order_returns where id=$1', [f.returnId])).rows[0];
const claims = async (db: PgClient, f: Fx, refundId?: string) => (await db.query(`select unit_index,paid_amount,return_line_id,refund_id
  from public.order_line_unit_amounts where order_item_id=$1 and ($2::uuid is null or refund_id=$2) order by paid_amount,unit_index`,
  [f.itemId, refundId ?? null])).rows;
async function failure(db: PgClient, work: () => Promise<unknown>) {
  await db.query('savepoint rr_expected_error');
  try { await work(); return null; }
  catch (caught) {
    const e = caught as { message?: string; code?: string };
    return { code: e.code, message: /^(RETURN_[A-Z_]+|REFUND_[A-Z_]+|AWAITING_REFUND_EXISTS|GROUP_H_REFUND_UNIT_MISMATCH)$/.test(e.message ?? '')
      ? e.message : 'RR_UNEXPECTED_DB_ERROR' };
  } finally { await db.query('rollback to savepoint rr_expected_error'); await db.query('release savepoint rr_expected_error'); }
}
async function snapshot(db: PgClient, f: Fx) {
  // LEFT-correlated counts retain zero-claim lines and include already refunded units.
  return (await db.query(`select l.id,l.quantity,
    (select count(*)::int from public.order_line_unit_amounts u where u.return_line_id=l.id) "boundCount",
    (select count(*)::int from private.group_h_return_unit_dispositions(l.id)) "dispositionCount"
    from public.order_return_lines l where l.return_id=$1 order by l.created_at,l.id`, [f.returnId])).rows;
}
function expectSnapshots(snapshots: Awaited<ReturnType<typeof snapshot>>[], count: number) {
  for (const lines of snapshots) {
    expect(lines).toHaveLength(count);
    for (const l of lines) {
      expect(l.boundCount).toBeLessThanOrEqual(l.quantity);
      expect(l.dispositionCount).toBe(l.boundCount);
    }
  }
}
async function exceptionCounts(db: PgClient, f: Fx) {
  return (await db.query(`select count(*) filter(where detail='group_h_refund_unit_mismatch')::int mismatch,
    count(*) filter(where resolved_at is null)::int unresolved from public.payment_exceptions where order_id=$1`, [f.orderId])).rows[0];
}
async function recover(db: PgClient, f: Fx, id: string, snapshots: Awaited<ReturnType<typeof snapshot>>[]) {
  const original = await claims(db, f, id);
  await db.query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [id]);
  snapshots.push(await snapshot(db, f));
  const thrown = await failure(db, () => hResult(db, id, 'succeeded'));
  expect(thrown).toBeNull();
  await hResult(db, id, 'succeeded');
  snapshots.push(await snapshot(db, f));
  const recovered = await claims(db, f, id);
  expect(recovered.map(x => x.paid_amount)).toEqual(original.map(x => x.paid_amount));
  expect(recovered.map(x => x.unit_index)).toEqual(original.map(x => x.unit_index));
  expect(recovered.map(x => x.return_line_id)).toEqual(original.map(x => x.return_line_id));
  expect((await db.query('select status from public.order_refunds where id=$1', [id])).rows[0].status).toBe('succeeded');
  expect(await exceptionCounts(db, f)).toEqual({ mismatch: 0, unresolved: 0 });
  return recovered;
}
async function sideEffects(db: PgClient, f: Fx) {
  return (await db.query(`select
    (select count(*)::int from public.order_return_receipts where return_id=$1) receipts,
    (select count(*)::int from public.order_refunds where order_id=$2) refunds,
    (select count(*)::int from public.stock_movements where return_id=$1) stock,
    (select count(*)::int from private.order_email_outbox where order_id=$2) outbox,
    (select jsonb_agg(to_jsonb(u) order by u.order_item_id,u.unit_index) from public.order_line_unit_amounts u where order_id=$2) claims,
    (select jsonb_agg(to_jsonb(v) order by v.id) from public.item_variants v where id=$3) variants,
    (select count(*)::int from private.group_g_operations where cause_id=$1::text) operations,
    (select to_jsonb(r) from public.order_returns r where r.id=$1) return_row`, [f.returnId, f.orderId, f.catalog.variantId])).rows[0];
}
const total = async (db: PgClient, f: Fx) => (await db.query('select refunded_amount from public.orders where id=$1', [f.orderId])).rows[0].refunded_amount;

describeLocalDb('返品の受取明細ごとの選び（controllerがREDを実測）', db => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-641-AC-10: 同じ返品行と状態の2点をnowとconsultの2明細にする', async () => {
    const f = await fixture(db(), { percent: 10 });
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed');
    const receipts = (await db().query('select refund_choice from public.order_return_receipts where return_id=$1', [f.returnId])).rows;
    expect(receipts).toEqual([{ refund_choice: 'mixed' }]);
    expect((await db().query(`select refund_choice,quantity from public.order_return_receipt_lines where receipt_id=$1 order by refund_choice`, [r.receipt_id])).rows)
      .toEqual([{ refund_choice: 'consult', quantity: 1 }, { refund_choice: 'now', quantity: 1 }]);
    expect((await db().query('select amount,return_fee_deduction from public.order_refunds where order_id=$1', [f.orderId])).rows)
      .toEqual([{ amount: 900, return_fee_deduction: 99 }]);
    expect(await fees(db(), f)).toEqual({ fee_pending_deduction: 99, fee_due_amount: 0, status: 'open' });
  });

  test('FREQ-641-AC-09: 上限ちょうどは受け上限1円超過は取引を残さず断る', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000], percent: 10, shipping: 500, paid: 50000 });
    const units = [unit(f, 0, 'now', 1, 'restocked'), unit(f, 0, 'consult', 1, 'restocked')];
    const before = await sideEffects(db(), f);
    expect(await failure(db(), () => receive(db(), f, units, 'mixed', { amount: 17501, shipping: 500 })))
      .toEqual({ message: 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED', code: '22023' });
    expect(await sideEffects(db(), f)).toEqual(before);
    await db().query('savepoint calculated');
    expect((await receive(db(), f, units, 'mixed', { shipping: 500 })).refund_amount).toBe(15800);
    await db().query('rollback to savepoint calculated'); await db().query('release savepoint calculated');
    expect((await receive(db(), f, units, 'mixed', { amount: 17500, shipping: 500 })).refund_amount).toBe(17500);
    const lower = await fixture(db(), { amounts: [17000, 20000], shipping: 500, paid: 16000 });
    for (const amount of [17501, 16001]) expect(await failure(db(), () => receive(db(), lower,
      [unit(lower, 0, 'now'), unit(lower, 0, 'consult')], 'mixed', { amount, shipping: 500 })))
      .toEqual({ message: 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED', code: '22023' });
    expect(await failure(db(), () => receive(db(), lower, [unit(lower, 0, 'now'), unit(lower, 0, 'consult')],
      'mixed', { amount: 17501, shipping: 501 }))).toEqual({ message: 'REFUND_SHIPPING_EXCEEDS', code: '22023' });
  });

  test('FREQ-641-AC-09: 結果不明の同一キーは順序を変えても再送となり選びを変えると拒否する', async () => {
    const f = await fixture(db()); const key = randomUUID();
    const units = [unit(f, 0, 'now', 1, 'restocked'), unit(f, 0, 'consult', 1, 'restocked')];
    const first = await receive(db(), f, units, 'mixed', { key, notify: true });
    const before = await sideEffects(db(), f);
    expect(await receive(db(), f, [...units].reverse(), 'mixed', { key, notify: true }))
      .toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, replayed: true });
    expect(await failure(db(), () => receive(db(), f, [unit(f, 0, 'consult', 2, 'restocked')], 'consult', { key, notify: true })))
      .toEqual({ message: 'RETURN_REQUEST_MISMATCH', code: '22023' });
    expect(await sideEffects(db(), f)).toEqual(before);
    expect((await db().query(`select count(*)::int n from private.group_g_operations where operation='admin_receive_return' and cause_id=$1`, [f.returnId])).rows[0].n).toBe(1);
    expect(await variantStock(db(), f.catalog.variantId)).toBe(4);
    expect((await db().query('select count(*)::int n from public.stock_movements where return_id=$1', [f.returnId])).rows[0].n).toBe(1);
  });

  test('FREQ-641-AC-10: Hの同じ行では17000の着をnowへ20000の着をconsultへ残す', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000] });
    expect((await detail(db(), f)).lines[0].receive_refund_amounts_by_count).toEqual([17000, 37000]);
    const r = await receive(db(), f, [unit(f, 0, 'consult'), unit(f, 0, 'now')], 'mixed');
    expect((await claims(db(), f, r.refund_id)).map(x => x.paid_amount)).toEqual([17000]);
    expect((await claims(db(), f)).filter(x => !x.refund_id).map(x => x.paid_amount)).toEqual([20000]);
    expect((await detail(db(), f)).lines[0].refund_waiting_amount).toBe(20000);
  });

  test('FREQ-641-AC-07: 同じ注文商品の古い相談行に返金済みの印が付いても額と後の返金は合う', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000], groups: [{ quantity: 1 }, { quantity: 1 }] });
    const snaps = [];
    const r = await receive(db(), f, [unit(f, 0, 'consult'), unit(f, 1, 'now')], 'mixed');
    snaps.push(await snapshot(db(), f));
    expect(r.refund_amount).toBe(20000);
    expect((await db().query('select refund_covered,refund_waiting from private.order_return_line_progress($1) order by return_line_id', [f.returnId])).rows
      .map(x => [x.refund_covered, x.refund_waiting])).toEqual([[1, 0], [0, 1]]);
    expect((await detail(db(), f)).lines.reduce((sum: number, x: { refund_waiting_amount: number }) => sum + x.refund_waiting_amount, 0)).toBe(17000);
    expect(await failure(db(), () => consultRefund(db(), f))).toEqual({ message: 'AWAITING_REFUND_EXISTS', code: '22023' });
    await hResult(db(), r.refund_id, 'succeeded');
    const later = await consultRefund(db(), f); snaps.push(await snapshot(db(), f));
    expect(later.amount).toBe(17000);
    expect((await claims(db(), f, later.refund_id)).map(x => x.return_line_id)).toEqual([f.lineIds[0]]);
    expect((await recover(db(), f, later.refund_id, snaps)).map(x => x.paid_amount)).toEqual([17000]);
    expectSnapshots(snaps, 2); expect(await total(db(), f)).toBe(37000);
  });

  test('FREQ-641-AC-07: 3行の相談2点へ空きを割り当てても同じ着を重ねて数えない', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000, 23000, 26000],
      groups: [{ quantity: 1 }, { quantity: 1 }, { quantity: 2 }] });
    // Old syntax avoids mixed/schema rejection. The controller must distinguish an earlier H5 amount failure
    // here from the later consultation double-count assertion; the brief's prices remain fixed.
    await receive(db(), f, [unit(f, 0), unit(f, 1)], 'consult');
    for (let i = 0; i < 2; i++) {
      const r = await receive(db(), f, [unit(f, 2)], 'now');
      expect(r.refund_amount).toBe(i === 0 ? 23000 : 26000); await hResult(db(), r.refund_id, 'succeeded');
    }
    const snaps = [await snapshot(db(), f)];
    expect((await claims(db(), f)).filter(x => !x.return_line_id).map(x => x.paid_amount)).toEqual([17000, 20000]);
    let later: { refund_id: string; amount: number } | undefined;
    expect(await failure(db(), async () => { later = await consultRefund(db(), f); })).toBeNull();
    expect(later!.amount).toBe(37000);
    // The successful call must remain in this transaction; failure() rolls back its probe.
    const refund = await consultRefund(db(), f); snaps.push(await snapshot(db(), f));
    const c = await claims(db(), f, refund.refund_id);
    expect(c.map(x => x.paid_amount)).toEqual([17000, 20000]);
    expect(c.map(x => x.return_line_id)).toEqual([f.lineIds[0], f.lineIds[1]]);
    expect(new Set(c.map(x => `${f.itemId}:${x.unit_index}`)).size).toBe(2);
    await hResult(db(), refund.refund_id, 'succeeded');
    expect((await exceptionCounts(db(), f)).mismatch).toBe(0);
    expectSnapshots(snaps, 3); expect(await total(db(), f)).toBe(86000);
  });

  test.each([
    { spare: true, amounts: [12000, 17000, 20000, 24000], total: 49000, intervening: false },
    { spare: false, amounts: [15000, 17000, 20000], total: 52000, intervening: true },
  ])('FREQ-641-AC-07: 相談返金の取り直しは予備の空き=$spare・間の受け取り=$interveningでも元の17000と行容量を保つ', async o => {
    const f = await fixture(db(), { amounts: o.amounts,
      groups: [{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }, ...(o.intervening ? [{ quantity: 1, exchange: true, extraItem: true }] : [])] });
    // Approval's sorted IDs must bind P<A<B to 12000/15000,17000,20000.
    expect((await claims(db(), f)).slice(0, 3).map(x => x.return_line_id)).toEqual(f.lineIds.slice(0, 3));
    const p = await receive(db(), f, [unit(f, 0)], 'now'); await hResult(db(), p.refund_id, 'succeeded');
    await receive(db(), f, [unit(f, 1)], 'consult');
    const b = await receive(db(), f, [unit(f, 2)], 'now'); await hResult(db(), b.refund_id, 'succeeded');
    const snaps = [await snapshot(db(), f)];
    const later = await consultRefund(db(), f); snaps.push(await snapshot(db(), f));
    const original = await claims(db(), f, later.refund_id);
    expect(later.amount).toBe(17000); expect(original.map(x => x.paid_amount)).toEqual([17000]);
    expect(original.map(x => x.return_line_id)).toEqual([f.lineIds[1]]);
    await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [later.refund_id]);
    snaps.push(await snapshot(db(), f));
    if (o.intervening) {
      await receive(db(), f, [unit(f, 3)], 'none'); snaps.push(await snapshot(db(), f));
      expect((await claims(db(), f)).find(x => x.paid_amount === 17000)?.return_line_id).toBeNull();
    }
    expect(await failure(db(), () => hResult(db(), later.refund_id, 'succeeded'))).toBeNull();
    await hResult(db(), later.refund_id, 'succeeded'); snaps.push(await snapshot(db(), f));
    const recovered = await claims(db(), f, later.refund_id);
    expect(recovered.map(x => x.paid_amount)).toEqual([17000]);
    expect(recovered.map(x => x.unit_index)).toEqual(original.map(x => x.unit_index));
    expect(recovered.map(x => x.return_line_id)).toEqual([f.lineIds[1]]);
    expect((await db().query('select status from public.order_refunds where id=$1', [later.refund_id])).rows[0].status).toBe('succeeded');
    expect(await exceptionCounts(db(), f)).toEqual({ mismatch: 0, unresolved: 0 });
    expectSnapshots(snaps, o.intervening ? 4 : 3); expect(await total(db(), f)).toBe(o.total);
  });

  test('FREQ-641-AC-07: 同じ行のnow17000とconsult20000はerrorから成功へ戻っても同じ着を取る', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000] });
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed');
    const snaps = [await snapshot(db(), f)]; expect(r.refund_amount).toBe(17000);
    expect((await recover(db(), f, r.refund_id, snaps)).map(x => x.paid_amount)).toEqual([17000]);
    expect((await consultRefund(db(), f)).amount).toBe(20000); expectSnapshots(snaps, 1);
  });

  test.each(['pending', 'succeeded'] as const)('FREQ-641-AC-08: 旧本文でA相談・後にB今すぐの2回受け取りでも待ち額と再確保を保つ（%s）', async status => {
    const f = await fixture(db(), { amounts: [17000, 20000], groups: [{ quantity: 1 }, { quantity: 1 }] });
    await receive(db(), f, [unit(f, 0)], 'consult');
    const b = await receive(db(), f, [unit(f, 1)], 'now'); const snaps = [await snapshot(db(), f)];
    const waiting = async () => (await detail(db(), f)).lines.reduce((n: number, x: { refund_waiting_amount: number }) => n + x.refund_waiting_amount, 0);
    expect(b.refund_amount).toBe(20000); expect(await waiting()).toBe(17000);
    expect(await failure(db(), () => consultRefund(db(), f))).toEqual({ message: 'AWAITING_REFUND_EXISTS', code: '22023' });
    // Separate savepoint branch proves error recovery of the original B receipt.
    await db().query('savepoint rr_b_recovery');
    expect((await recover(db(), f, b.refund_id, snaps)).map(x => x.paid_amount)).toEqual([20000]);
    await db().query('rollback to savepoint rr_b_recovery'); await db().query('release savepoint rr_b_recovery');
    await hResult(db(), b.refund_id, status); expect(await waiting()).toBe(17000);
    if (status === 'pending') await hResult(db(), b.refund_id, 'succeeded');
    const later = await consultRefund(db(), f); snaps.push(await snapshot(db(), f));
    expect(later.amount).toBe(17000);
    expect((await claims(db(), f, later.refund_id)).map(x => x.return_line_id)).toEqual([f.lineIds[0]]);
    expect((await recover(db(), f, later.refund_id, snaps)).map(x => x.paid_amount)).toEqual([17000]);
    expectSnapshots(snaps, 2); expect(await total(db(), f)).toBe(37000);
  });

  test('FREQ-641-AC-10: Hの無い旧注文のG相は累計の差で端数をそろえる', async () => {
    const f = await fixture(db(), { legacy: true, price: 1000, quantity: 3, discount: 1, percent: 10 });
    expect((await db().query('select private.return_units_amount($1,1,0) a,private.return_units_amount($1,2,0) b', [f.itemId])).rows[0])
      .toEqual({ a: 1000, b: 1999 });
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed');
    expect(r.refund_amount).toBe(900);
    expect((await db().query('select return_fee_deduction from public.order_refunds where id=$1', [r.refund_id])).rows[0].return_fee_deduction).toBe(100);
    expect((await fees(db(), f)).fee_pending_deduction).toBe(99);
    await hResult(db(), r.refund_id, 'succeeded');
    const later = await consultRefund(db(), f); expect(later.amount).toBe(900);
    expect((await db().query('select return_fee_deduction from public.order_refunds where id=$1', [later.refund_id])).rows[0].return_fee_deduction).toBe(99);
  });

  test('FREQ-641-AC-07: 固定費用の不足と返金失敗の控除戻しを混ぜない', async () => {
    const f = await fixture(db(), { amounts: [100, 2000], fixed: 240, percent: 10 });
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed', { amount: 1 });
    expect(await fees(db(), f)).toMatchObject({ fee_pending_deduction: 350, fee_due_amount: 0 });
    expect((await db().query('select return_fee_deduction from public.order_refunds where id=$1', [r.refund_id])).rows[0].return_fee_deduction).toBe(100);
    for (let i = 0; i < 2; i++) {
      await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [r.refund_id]);
      expect((await fees(db(), f)).fee_pending_deduction).toBe(450);
    }
    await hResult(db(), r.refund_id, 'succeeded'); expect((await fees(db(), f)).fee_pending_deduction).toBe(350);
  });
  test.each([{ choice: 'now', pending: 0, due: 150 }, { choice: 'consult', pending: 250, due: 0 }])(
    'FREQ-641-AC-07: 相談なしと全相談の固定費用は$choiceの規則へ残す', async o => {
      const f = await fixture(db(), { amounts: [100], fixed: 240, percent: 10 });
      await receive(db(), f, [unit(f, 0)], o.choice);
      expect(await fees(db(), f)).toMatchObject({ fee_pending_deduction: o.pending, fee_due_amount: o.due });
    });

  test('FREQ-641-AC-07: 0円のnowはその1点だけを終えconsultの1点を待ちに残す', async () => {
    const f = await fixture(db(), { amounts: [0, 20000] });
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed', { notify: true });
    expect(r).toMatchObject({ refund_id: null, refund_amount: 0, refund_status: 'waived', return_status: 'open' });
    expect((await db().query('select refund_waived,refund_waiting from private.order_return_line_progress($1)', [f.returnId])).rows[0])
      .toMatchObject({ refund_waived: 1, refund_waiting: 1 });
    expect((await db().query("select refund_choice,quantity from public.order_return_receipt_lines where receipt_id=$1 and disposition='refund_waived'", [r.receipt_id])).rows)
      .toEqual([{ refund_choice: null, quantity: 1 }]);
    expect((await db().query('select kind from private.order_email_outbox where return_receipt_id=$1 order by kind', [r.receipt_id])).rows.map(x => x.kind))
      .toEqual(['return_received']);
    expect((await claims(db(), f)).filter(x => x.return_line_id).map(x => x.paid_amount)).toEqual([20000]);
    expect((await consultRefund(db(), f)).amount).toBe(20000);
  });

  test('FREQ-641-AC-09: P9は品ごとに選べP9外のnowと権限なしの指定額を拒否する', async () => {
    const f = await fixture(db()); const units = [unit(f, 0, 'now'), unit(f, 0, 'consult')]; const key = randomUUID();
    for (const o of [{ amount: 0 }, { shipping: 1 }, { overrides: [{ return_line_id: f.lineIds[0], action: 'refund' }] }])
      expect(await failure(db(), () => receive(db(), f, units, 'mixed', { ...o, can: false })))
        .toEqual({ message: 'RETURN_FORBIDDEN', code: '22023' });
    const r = await receive(db(), f, units, 'mixed', { can: false, key });
    expect((await db().query('select refund_choice,actor_can_refund from public.order_return_receipts where id=$1', [r.receipt_id])).rows[0])
      .toEqual({ refund_choice: 'mixed', actor_can_refund: false });
    await receive(db(), f, units, 'mixed', { can: false, key });
    expect((await db().query("select count(*)::int n from private.order_email_outbox where return_id=$1 and kind='return_refund_pending_shop'", [f.returnId])).rows[0].n).toBe(1);
    for (const o of [{ source: 'shop' as const }, { method: 'not_required' as const }]) {
      const nonP9 = await fixture(db(), o);
      expect(await failure(db(), () => receive(db(), nonP9, [unit(nonP9, 0, 'now')], 'now', { can: false })))
        .toEqual({ message: 'RETURN_FORBIDDEN', code: '22023' });
      const consultation = await receive(db(), nonP9, [unit(nonP9, 0, 'consult')], 'consult', { can: false });
      expect(consultation.shop_notice_enqueued).toBe(true);
    }
  });

  test.each(['now', 'consult', 'mixed', 'none'] as const)('FREQ-641-AC-09: 実効明細の親まとめ%sと非返金NULLを保存する', async choice => {
    const f = await fixture(db(), { groups: [{ quantity: 1 }, { quantity: 1, exchange: choice === 'none' }] });
    const units = choice === 'mixed' ? [unit(f, 0, 'now'), unit(f, 1, 'consult')]
      : choice === 'none' ? [unit(f, 1, 'now')] : [unit(f, 0, choice)];
    const r = await receive(db(), f, units, choice);
    expect((await db().query('select refund_choice from public.order_return_receipts where id=$1', [r.receipt_id])).rows[0].refund_choice).toBe(choice);
    expect((await db().query('select refund_choice from public.order_return_receipt_lines where receipt_id=$1', [r.receipt_id])).rows
      .map(x => x.refund_choice).sort()).toEqual(choice === 'mixed' ? ['consult', 'now'] : [choice === 'none' ? null : choice]);
  });
  test('FREQ-641-AC-09: mixedの欠けた選びと親の不一致と不正な群の指定額を拒否する', async () => {
    const f = await fixture(db());
    for (const [choice, units] of [
      ['mixed', [unit(f, 0)]], ['mixed', [{ ...unit(f, 0), refund_choice: null }]],
      ['consult', [unit(f, 0, 'now')]], ['none', [unit(f, 0, 'now')]],
      ['now', [unit(f, 0, 'consult')]], ['mixed', [unit(f, 0, 'now')]],
    ] as [string, Unit[]][]) expect(await failure(db(), () => receive(db(), f, units, choice)))
      .toEqual({ message: 'RETURN_ARGUMENT_INVALID', code: '22023' });
    expect(await failure(db(), () => receive(db(), f, [unit(f, 0, 'consult')], 'consult', { amount: 0 })))
      .toEqual({ message: 'RETURN_ARGUMENT_INVALID', code: '22023' });
    expect(await failure(db(), () => receive(db(), f, [unit(f, 0, 'now')], 'now', { amount: 0, shipping: 1 })))
      .toEqual({ message: 'RETURN_REFUND_AMOUNT_INVALID', code: '22023' });
  });

  test('FREQ-641-AC-09: 旧省略本文の再送は移行前の指紋と追記済みNULL明細を変えない', async () => {
    const f = await fixture(db()); const key = randomUUID(); let old: Record<string, unknown> | undefined;
    await withH5ReturnBaseline(db(), async () => {
      const r = await receive(db(), f, [unit(f, 0)], 'consult', { key });
      old = (await db().query('select * from public.order_return_receipts where id=$1', [r.receipt_id])).rows[0];
    });
    expect(old).toBeDefined();
    await db().query(`insert into public.order_return_receipts
      (id,return_id,request_key,request_fingerprint,kind,refund_choice,notify_customer,actor_id,actor_can_refund,created_at)
      values($1,$2,$3,$4,'receive','consult',false,$5,true,$6)`,
    [old!.id, f.returnId, key, old!.request_fingerprint, f.actor, old!.created_at]);
    await db().query(`insert into public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution)
      values($1,$2,'not_restocked',1,'refund')`, [old!.id, f.lineIds[0]]);
    const before = await sideEffects(db(), f);
    expect(await receive(db(), f, [unit(f, 0)], 'consult', { key })).toMatchObject({ receipt_id: old!.id, replayed: true });
    expect(await sideEffects(db(), f)).toEqual(before);
    expect((await db().query('select refund_choice from public.order_return_receipt_lines where receipt_id=$1', [old!.id])).rows)
      .toEqual([{ refund_choice: null }]);
  });

  test('FREQ-641-AC-09: 既存返金でnow対象が減った指定額のmixedはSTATE_CONFLICTで全体を戻す', async () => {
    const f = await fixture(db(), { groups: [{ quantity: 1 }, { quantity: 1 }] });
    // An open return reserves both shipped units. Missing closes that reservation, so the ordinary refund
    // is legal; reopening then makes its one unit cover the first line in this return (existing M-1 fixture).
    await db().query('select * from public.admin_close_return_missing($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
    expect((await db().query('select refundable_after_shipment from private.order_line_return_counts($1) where order_item_id=$2',
      [f.orderId, f.itemId])).rows[0].refundable_after_shipment).toBe(2);
    const previous = (await db().query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,999,null,
      'requested_by_customer',null,false,$4)`, [f.orderId, randomUUID(), JSON.stringify([
      { order_item_id: f.itemId, before_shipment: false, quantity: 1 }]), f.actor])).rows[0];
    await hResult(db(), previous.refund_id, 'succeeded');
    await db().query('select * from public.admin_reopen_return($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
    // now() is constant in this transaction; the existing core includes both ends of the missing/reopen window.
    const effective = [unit(f, 0, 'now'), unit(f, 1, 'consult')].map(u => ({ ...u, resolution: 'refund', exchange_method: null }));
    expect((await db().query(`select refund_covered,refund_waiting from private.order_return_line_states_core($1,$2::jsonb)
      where return_id=$3 order by return_line_id`, [f.orderId, JSON.stringify(effective), f.returnId])).rows)
      .toEqual([{ refund_covered: 1, refund_waiting: 0 }, { refund_covered: 0, refund_waiting: 1 }]);
    const before = await sideEffects(db(), f);
    expect(await failure(db(), () => receive(db(), f, [unit(f, 0, 'now'), unit(f, 1, 'consult')], 'mixed', { amount: 100 })))
      .toEqual({ message: 'RETURN_STATE_CONFLICT', code: '22023' });
    expect(await sideEffects(db(), f)).toEqual(before);
  });

  test('FREQ-641-AC-10: 交換を返金に変えた実効明細で選びを導出し旧注文の見込みはNULLへ戻す', async () => {
    const f = await fixture(db(), { groups: [{ quantity: 2, exchange: true, exchangeMethod: 'stock' }], extraStock: 0 });
    expect((await detail(db(), f)).lines[0].receive_refund_amounts_by_count).toBeNull();
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 0, 'consult')], 'mixed', {
      overrides: [{ return_line_id: f.lineIds[0], action: 'refund' }] });
    expect(r.exchange_order_item_ids).toEqual([]); expect(r.refund_amount).toBe(999);
    expect((await db().query('select resolution from public.order_return_lines where id=$1', [f.lineIds[0]])).rows[0].resolution).toBe('exchange');
    expect((await db().query(`select resolution,refund_choice from public.order_return_receipt_lines where receipt_id=$1 order by refund_choice`, [r.receipt_id])).rows)
      .toEqual([{ resolution: 'refund', refund_choice: 'consult' }, { resolution: 'refund', refund_choice: 'now' }]);
  });

  test('FREQ-641-AC-10: 部分受取の見込みは前回受取と他返品のactive claimを除き読取で着を変えない', async () => {
    const f = await fixture(db(), { amounts: [17000, 20000, 23000], groups: [{ quantity: 2 }] });
    const other = (await db().query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,
      'customer_ships','customer',null,null,0,0,0,0,null,false)`, [f.orderId, f.actor, randomUUID(), JSON.stringify([
      { fulfillment_id: (await db().query('select fulfillment_id from public.order_return_lines where id=$1', [f.lineIds[0]])).rows[0].fulfillment_id,
        order_item_id: f.itemId, quantity: 1, reason: 'unknown', reason_note: null, resolution: 'refund',
        exchange_variant_id: null, exchange_method: null }])])).rows[0];
    expect(other.return_id).toBeDefined();
    expect((await detail(db(), f)).lines[0].receive_refund_amounts_by_count).toEqual([17000, 37000]);
    await receive(db(), f, [unit(f, 0)], 'consult');
    const before = await claims(db(), f);
    const beforeEffects = await sideEffects(db(), f);
    expect((await detail(db(), f)).lines[0].receive_refund_amounts_by_count).toEqual([20000]);
    expect((await db().query('select * from private.return_receive_amounts($1)', [f.returnId])).rows)
      .toEqual([{ return_line_id: f.lineIds[0], receive_refund_amounts_by_count: [20000] }]);
    expect(await claims(db(), f)).toEqual(before);
    expect(await sideEffects(db(), f)).toEqual(beforeEffects);
  });
});
