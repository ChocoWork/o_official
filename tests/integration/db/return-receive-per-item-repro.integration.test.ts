/** @jest-environment node */
// I-1・N-1 の再現（2026-11-08 調べ）と直した後の挙動（移行 20261108063711_return_receive_unit_dedup）。
// 期待の試験は直す前の DB で落ちた（RED。2026-11-08 の調べ）。【直った後】の試験は、調べの時の【現状の記録】を直した後の挙動に書き換えた物。
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder } from './helpers/order-fixtures';
import { hDiscount, seedHDiscount, seedHMember } from './helpers/group-h-fixtures';
import { hResult } from './helpers/group-h-refund-fixtures';

jest.setTimeout(30000);
type Choice = 'now' | 'consult';
type Unit = { return_line_id: string; disposition: string; quantity: number; refund_choice?: Choice | null };
type Group = { quantity: number; extraItem?: boolean };
type Options = { amounts?: number[]; price?: number; quantity?: number; groups?: Group[]; percent?: number; exchange?: boolean };
type Fx = Awaited<ReturnType<typeof fixture>>;

/** return-receive-per-item.integration.test.ts の fixture と同じ作り方（返金の行だけ）。 */
async function fixture(db: PgClient, o: Options = {}) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222',restocking_fee_enabled=true,
    exchange_fees_enabled=true,inspection_enabled=true,no_return_needed_enabled=true where id=1`);
  const actor = await seedHMember(db);
  const amounts = o.amounts;
  const quantity = amounts?.length ?? o.quantity ?? 2;
  const price = o.price ?? (amounts ? Math.max(...amounts) : 999);
  const discount = amounts ? price * quantity - amounts.reduce((a, b) => a + b, 0) : 0;
  const catalog = await createCatalogFixture(db, { stock: quantity + 2 });
  const groups = o.groups ?? [{ quantity }];
  const extraCatalog = groups.some(g => g.extraItem) ? await createCatalogFixture(db, { stock: 2 }) : null;
  const order = await insertOrderWithLines(db, { status: 'paid', shippingAmount: 0, discountAmount: discount,
    paidAmount: price * quantity - discount + (extraCatalog ? 5000 : 0), paymentIntentId: `pi_rr_${randomUUID()}`,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, itemPrice: price, fulfillmentType: 'stock' },
      ...(extraCatalog ? [{ itemId: extraCatalog.itemId, variantId: extraCatalog.variantId, quantity: 1,
        itemPrice: 5000, fulfillmentType: 'stock' as const }] : [])] });
  const itemId = order.orderItemIds[0];
  if (amounts) {
    if (discount > 0) {
      const discountId = await seedHDiscount(db, hDiscount({ value: { type: 'amount', value: discount },
        minimum: { type: 'amount', value: price * quantity } }));
      await db.query(`insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount)
        values($1,$2,$3,$4)`, [order.orderId, itemId, discountId, discount]);
    }
    for (const [index, amount] of amounts.entries()) await db.query(`insert into public.order_line_unit_amounts
      (order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)`, [order.orderId, itemId, index, amount]);
  }
  const shipped = await shipFixtureOrder(db, { orderId: order.orderId, actorId: actor, trackingNumber: 'RR-REPRO',
    lines: order.orderItemIds.map((id, i) => ({ order_item_id: id, quantity: i === 0 ? quantity : 1 })) });
  const returnId = (await db.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,1,'customer_request','requested',$2,'rr-repro',now(),$3,'customer_ships','customer',false) returning id`,
  [order.orderId, randomUUID(), actor])).rows[0].id as string;
  const lineIds = groups.map(() => randomUUID()).sort();
  const resolution = o.exchange ? 'exchange' : 'refund';
  const variant = o.exchange ? catalog.variantId : null;
  const method = o.exchange ? 'make' : null;
  for (const [i, group] of groups.entries()) await db.query(`insert into public.order_return_lines
    (id,return_id,fulfillment_id,order_item_id,quantity,reason,requested_resolution,
     requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
    values($1,$2,$3,$4,$5,'unknown',$6,$7,$6,$7,$8)`,
  [lineIds[i], returnId, shipped.fulfillment_id, group.extraItem ? order.orderItemIds[1] : itemId, group.quantity,
    resolution, variant, method]);
  const approval = groups.map((_, i) => ({ return_line_id: lineIds[i], resolution, exchange_variant_id: variant, exchange_method: method }));
  expect((await db.query(`select * from public.admin_approve_return($1,$2,$3::jsonb,'customer_ships','customer',null,null,0,$4,0,0,null,false)`,
    [returnId, actor, JSON.stringify(approval), o.percent ?? 0])).rows).toEqual([{ return_id: returnId, status: 'open' }]);
  return { orderId: order.orderId, itemId, actor, returnId, lineIds };
}

const unit = (f: Fx, index: number, choice?: Choice, quantity = 1): Unit => ({
  return_line_id: f.lineIds[index], disposition: 'not_restocked', quantity, ...(choice ? { refund_choice: choice } : {}),
});
async function receive(db: PgClient, f: Fx, units: Unit[], choice: string, amount: number | null = null) {
  return (await db.query(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,$5,$6,0,null,false,null,null,null)`,
    [f.returnId, f.actor, randomUUID(), JSON.stringify(units), choice, amount])).rows[0];
}
const claims = async (db: PgClient, f: Fx) => (await db.query(`select unit_index,paid_amount,return_line_id,refund_id
  from public.order_line_unit_amounts where order_item_id=$1 order by paid_amount,unit_index`, [f.itemId])).rows;
async function failure(db: PgClient, work: () => Promise<unknown>) {
  await db.query('savepoint rr_repro_error');
  try { await work(); return null; }
  catch (caught) { const e = caught as { message?: string; code?: string; where?: string };
    return { code: e.code, message: e.message, where: e.where?.split('\n')[0] }; }
  finally { await db.query('rollback to savepoint rr_repro_error'); await db.query('release savepoint rr_repro_error'); }
}
const progress = async (db: PgClient, f: Fx) => (await db.query(`select return_line_id,unprocessed,refund_waiting,refund_covered
  from private.order_return_line_progress($1) order by return_line_id`, [f.returnId])).rows;
const nowElements = (f: Fx) => JSON.stringify(f.lineIds.map(id => ({ return_line_id: id, resolution: 'refund', quantity: 1, unit_offset: 0 })));

/**
 * I-1 の場面: 同じ注文の商品（17000・20000 の2着）に返品の行 A・B（各1点）。承認で A→17000・B→20000 に結び付く。
 * 「届かない」で終える → 結び付きが外れて空きになる → 普通の返金で2着を取る（awaiting_response）→ 開き直す（空きが無いので結び直さない）
 * → 普通の返金が error になり2着が空きへ戻る。A・B は未処理1点ずつで、自分の着は0、空きの着は2つ。
 */
async function sharedFreeScene(db: PgClient, percent = 0, exchange = false) {
  const f = await fixture(db, { amounts: [17000, 20000], groups: [{ quantity: 1 }, { quantity: 1 }], percent, exchange });
  await db.query('select * from public.admin_close_return_missing($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
  const ordinary = (await db.query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,37000,null,
    'requested_by_customer',null,false,$4)`, [f.orderId, randomUUID(), JSON.stringify([
    { order_item_id: f.itemId, before_shipment: false, quantity: 2 }]), f.actor])).rows[0];
  await db.query('select * from public.admin_reopen_return($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
  await db.query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [ordinary.refund_id]);
  expect((await claims(db, f)).map(x => [x.paid_amount, x.return_line_id, x.refund_id])).toEqual([[17000, null, null], [20000, null, null]]);
  expect((await progress(db, f)).map(x => [x.unprocessed, x.refund_waiting, x.refund_covered])).toEqual([[1, 0, 0], [1, 0, 0]]);
  return f;
}

/**
 * N-1 の場面: 行 A（別の注文の商品 5000円×1）を今すぐ1点、行 B（999円×2 の注文の商品）を相談2点で1回に受け取る。
 * B の注文の商品は「届かない」で終えた間に普通の返金で1点を返金済み（既存の M-1 の作り方）→ 返金待ちの増え方は1。
 */
async function coveredConsultScene(db: PgClient) {
  const f = await fixture(db, { quantity: 2, groups: [{ quantity: 1, extraItem: true }, { quantity: 2 }] });
  // lineIds は並べ替え済み。B（2点の行）を確かめてから使う
  const lines = (await db.query('select id,quantity from public.order_return_lines where return_id=$1', [f.returnId])).rows;
  const a = f.lineIds.findIndex(id => lines.find(l => l.id === id)!.quantity === 1);
  const b = 1 - a;
  await db.query('select * from public.admin_close_return_missing($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
  const previous = (await db.query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,999,null,
    'requested_by_customer',null,false,$4)`, [f.orderId, randomUUID(), JSON.stringify([
    { order_item_id: f.itemId, before_shipment: false, quantity: 1 }]), f.actor])).rows[0];
  await hResult(db, previous.refund_id, 'succeeded');
  await db.query('select * from public.admin_reopen_return($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
  return { f, a, b };
}

/**
 * order-history.ts の receiptRefundChoiceDetails と同じ数え方（受け取りの行の consult の合計。親が consult/mixed の時だけ）。
 * 受け取りの記録の consult_quantity が数なら、そこまでに抑える（NULL は移行より前の記録で、行の合計のまま）
 */
async function historyConsultCount(db: PgClient, receiptId: string) {
  const receipt = (await db.query('select refund_choice,consult_quantity from public.order_return_receipts where id=$1', [receiptId])).rows[0];
  const parent = receipt.refund_choice;
  const sum = (await db.query(`select coalesce(sum(quantity),0)::int n from public.order_return_receipt_lines where receipt_id=$1
    and resolution='refund' and disposition in ('restocked','not_restocked','pending_inspection')
    and coalesce(refund_choice,case when $2 in ('now','consult') then $2 end)='consult'`, [receiptId, parent])).rows[0].n;
  const counted = receipt.consult_quantity === null ? sum : Math.min(sum, receipt.consult_quantity);
  return parent === 'consult' || parent === 'mixed' ? counted : 0;
}

describeLocalDb('I-1・N-1 の再現（返品の受け取りの数え方）', db => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-641-AC-07: 【直った後】I-1 見込みは行ごとに別の空きの着を見せ、指定額は37000円まで通り37001円は上限超えで断る', async () => {
    const f = await sharedFreeScene(db());
    // 画面の見込みは、行の順（id の順）に空きの着を1列で使う。A は 17000、B は残りの 20000
    expect((await db().query('select * from private.return_receive_amounts($1) order by return_line_id', [f.returnId])).rows
      .map(x => x.receive_refund_amounts_by_count)).toEqual([[17000], [20000]]);
    const both = [unit(f, 0, 'now'), unit(f, 1, 'now')];
    expect(await failure(db(), () => receive(db(), f, both, 'now', 37001)))
      .toMatchObject({ code: '22023', message: 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED' });
    const r = await receive(db(), f, both, 'now', 37000);
    expect(r.refund_amount).toBe(37000);
    // 1行ずつでも A は 17000 で通る（前の逃げ道も残る）
    const g = await sharedFreeScene(db());
    expect((await receive(db(), g, [unit(g, 0, 'now')], 'now')).refund_amount).toBe(17000);
  });

  test('FREQ-641-AC-07: I-1 2行が空きの着を要る今すぐの上限は同じ着を2回数えない37000円', async () => {
    const f = await sharedFreeScene(db());
    expect((await db().query('select private.group_h_receiving_amount($1,$2,2,$3::jsonb) g', [f.returnId, f.itemId, nowElements(f)])).rows[0].g)
      .toBe(37000);
  });

  test('FREQ-641-AC-07: I-1 2行が空きの着を要る今すぐの受け取りは断られず37000円を2着で返す', async () => {
    const f = await sharedFreeScene(db());
    const thrown = await failure(db(), () => receive(db(), f, [unit(f, 0, 'now'), unit(f, 1, 'now')], 'now'));
    expect(thrown).toBeNull();
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 1, 'now')], 'now');
    expect(r.refund_amount).toBe(37000);
    const c = await claims(db(), f);
    expect(c.map(x => x.refund_id)).toEqual([r.refund_id, r.refund_id]);
    expect(new Set(c.map(x => x.return_line_id))).toEqual(new Set(f.lineIds));
  });

  test('FREQ-641-AC-07: I-1 2行を相談で受け取る時の手数料の控え（10%）は37000円の10%の3700円', async () => {
    const f = await sharedFreeScene(db(), 10);
    await receive(db(), f, [unit(f, 0, 'consult'), unit(f, 1, 'consult')], 'consult');
    expect((await db().query('select fee_pending_deduction from public.order_returns where id=$1', [f.returnId])).rows[0].fee_pending_deduction)
      .toBe(3700);
  });

  test('FREQ-641-AC-01: 【直った後】N-1 受け取りの記録の相談の点数は1点で、受け取りの行の相談は2点のまま残る', async () => {
    const { f, a, b } = await coveredConsultScene(db());
    const r = await receive(db(), f, [unit(f, a, 'now'), unit(f, b, 'consult', 2)], 'mixed');
    expect(r.refund_amount).toBe(5000);
    expect((await db().query('select refund_choice,consult_quantity from public.order_return_receipts where id=$1', [r.receipt_id])).rows[0])
      .toEqual({ refund_choice: 'mixed', consult_quantity: 1 });
    const p = await progress(db(), f);
    expect(p.find(x => x.return_line_id === f.lineIds[b])).toMatchObject({ unprocessed: 0, refund_waiting: 1, refund_covered: 1 });
    // 受け取りの行（品の状態の台帳）は渡された数のまま。抑えた数は受け取りの記録の列だけが持つ
    expect((await db().query(`select coalesce(sum(quantity),0)::int n from public.order_return_receipt_lines
      where receipt_id=$1 and refund_choice='consult'`, [r.receipt_id])).rows[0].n).toBe(2);
  });

  test('FREQ-641-AC-01: N-1 履歴の「相談 n点」はDBがこの受け取りで返金待ちにした点数（1点）と一致する', async () => {
    const { f, a, b } = await coveredConsultScene(db());
    const before = (await progress(db(), f)).reduce((n, x) => n + x.refund_waiting, 0);
    const r = await receive(db(), f, [unit(f, a, 'now'), unit(f, b, 'consult', 2)], 'mixed');
    const waitingAdded = (await progress(db(), f)).reduce((n, x) => n + x.refund_waiting, 0) - before;
    expect(waitingAdded).toBe(1);
    expect(await historyConsultCount(db(), r.receipt_id)).toBe(waitingAdded);
  });
  test('FREQ-641-AC-01: N-1 相談の点数は指紋に入れないので同じ本文の再送は一致して前の答えを返す', async () => {
    const { f, a, b } = await coveredConsultScene(db());
    const key = randomUUID();
    const send = async () => (await db().query(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'mixed',null,0,null,false,null,null,null)`,
      [f.returnId, f.actor, key, JSON.stringify([unit(f, a, 'now'), unit(f, b, 'consult', 2)])])).rows[0];
    const first = await send();
    const again = await send();
    expect(again).toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, replayed: true });
  });

  test('FREQ-641-AC-07: I-1 行Aを今すぐ・行Bを相談で受け取ると相談の控えはAが使った空きの着の次（20000円）で数える', async () => {
    const f = await sharedFreeScene(db(), 10);
    const r = await receive(db(), f, [unit(f, 0, 'now'), unit(f, 1, 'consult')], 'mixed');
    expect(r.refund_amount).toBe(17000 - 1700);
    expect((await db().query('select fee_pending_deduction from public.order_returns where id=$1', [f.returnId])).rows[0].fee_pending_deduction)
      .toBe(2000);
    expect((await claims(db(), f)).map(x => [x.paid_amount, x.return_line_id, x.refund_id])).toEqual([
      [17000, f.lineIds[0], r.refund_id], [20000, null, null]]);
  });

  test('FREQ-641-AC-07: I-1 2つの交換の行が空きの着を要る時の交換の品の値段は同じ着を2回数えない（17000円と20000円）', async () => {
    const f = await sharedFreeScene(db(), 0, true);
    const units = [0, 1].map(i => ({ return_line_id: f.lineIds[i], disposition: 'not_restocked', quantity: 1 }));
    await receive(db(), f, units, 'none');
    expect((await db().query(`select exchange_return_line_id line,exchange_paid_amount paid from public.order_items
      where exchange_return_line_id=any($1::uuid[]) order by exchange_return_line_id`, [f.lineIds])).rows)
      .toEqual([{ line: f.lineIds[0], paid: 17000 }, { line: f.lineIds[1], paid: 20000 }]);
  });
});
