/** @jest-environment node */
import { randomUUID } from 'crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE, createCatalogFixture, createShippedOrderFixture, insertOrderWithLines,
  insertReturnRecord, insertReturnReceipt, uniqueSuffix,
} from './helpers/order-fixtures';

jest.setTimeout(30000);
type Row = Record<string, any>;
type Fx = { orderId: string; itemId: string; variantId: number; returnId: string; lineId: string; actor: string };
async function fails(db: PgClient, work: () => Promise<unknown>, message: string) {
  await db.query('savepoint expected_error');
  try { await expect(work()).rejects.toMatchObject({ message }); }
  finally { await db.query('rollback to savepoint expected_error'); }
}
async function fixture(db: PgClient, o: Row = {}): Promise<Fx> {
  await db.query(`update public.shop_return_settings set return_address_name='試験店舗',
    return_address_postal_code='1500001',return_address_line='東京都渋谷区神宮前1-1-1',
    return_address_phone='0311112222',no_return_needed_enabled=false,
    restocking_fee_enabled=true,exchange_fees_enabled=true,inspection_enabled=true where id=1`);
  const actor = (await db.query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
    values(gen_random_uuid(),$1,'{}',now(),now()) returning id`, [`review-${uniqueSuffix()}@example.com`])).rows[0].id;
  const s = await createShippedOrderFixture(db, { lines: [{ quantity: 2, extraStock: 2 }] });
  if (o.shop) {
    const r = await insertReturnRecord(db, { orderId: s.orderId,
      returnMethod: o.method ?? 'customer_ships', lines: [{ fulfillmentId: s.fulfillments[0].id,
        orderItemId: s.orderItemIds[0], quantity: 1 }] });
    return { orderId: s.orderId, itemId: s.orderItemIds[0], variantId: s.variantIds[0],
      returnId: r.returnId, lineId: r.lineIds[0], actor };
  }
  // 申し込みの不変列は INSERT 時に揃える。承認時にご希望を上書きできないことも確かめる。
  const r = (await db.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,
     return_method,return_shipping_payer,notify_customer,closed_at,cancelled_at,declined_at,decline_reason,decline_message)
    values($1,1,'customer_request',$2,gen_random_uuid(),'fixture',now(),$3,
     'customer_ships','customer',false,
     case when $2='closed' then now()-$4::interval end,
     case when $2='cancelled' then now()-$4::interval end,
     case when $2='declined' then now()-$4::interval end,
     case when $2='declined' then 'other' end,case when $2='declined' then '受付できません。' end)
    returning id`, [s.orderId, o.status ?? 'requested', actor, o.age ?? '91 days'])).rows[0];
  const l = (await db.query(`insert into public.order_return_lines
    (return_id,fulfillment_id,order_item_id,quantity,reason,customer_note,
     requested_resolution,requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
    values($1,$2,$3,1,'defective','縫い目をご確認ください。','exchange',$4,'exchange',$4,'stock') returning id`,
    [r.id, s.fulfillments[0].id, s.orderItemIds[0], s.variantIds[0]])).rows[0];
  return { orderId: s.orderId, itemId: s.orderItemIds[0], variantId: s.variantIds[0], returnId: r.id, lineId: l.id, actor };
}
function approvalLines(f: Fx, o: Row = {}) {
  return [{ return_line_id: f.lineId, resolution: 'refund', exchange_variant_id: null, exchange_method: null, ...o }];
}
async function approve(db: PgClient, f: Fx, o: Row = {}) {
  return (await db.query(`select * from public.admin_approve_return($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [f.returnId, f.actor, JSON.stringify(o.lines ?? approvalLines(f)), o.method ?? 'customer_ships',
      o.payer ?? 'customer', o.carrier ?? null, o.tracking ?? null,
      o.shipping === undefined ? 0 : o.shipping, o.percent === undefined ? 0 : o.percent,
      o.fee === undefined ? 0 : o.fee, o.exchangeShipping === undefined ? 0 : o.exchangeShipping,
      o.note ?? ' 内部のメモ ', o.notify ?? false])).rows[0];
}
async function receive(db: PgClient, f: Fx, o: Row = {}) {
  return (await db.query(`select * from public.admin_receive_return($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,null,false,null,null,null)`,
    [f.returnId, f.actor, o.can ?? false, o.key ?? randomUUID(),
      JSON.stringify([{ return_line_id: f.lineId, disposition: 'restocked', quantity: 1 }]),
      JSON.stringify(o.overrides ?? []), o.choice ?? 'now', o.amount ?? null, o.shipping ?? 0])).rows[0];
}
async function emailCount(db: PgClient, f: Fx, kind: string) {
  return (await db.query(`select count(*)::int n from private.order_email_outbox where return_id=$1 and kind=$2`,
    [f.returnId, kind])).rows[0].n;
}
async function upload(db: PgClient, orderId: string, actor: string, age = '2 days', attached = false) {
  const id = randomUUID();
  const path = `requests/${orderId}/${id}`;
  await db.query(`insert into public.order_return_photo_uploads(id,order_id,customer_id,storage_path,created_at,attached_at)
    values($1,$2,$3,$4,now()-$5::interval,case when $6 then now() end)`, [id, orderId, actor, path, age, attached]);
  return { id, path };
}
async function photo(db: PgClient, f: Fx, age = '0 seconds') {
  const u = await upload(db, f.orderId, f.actor, '100 days', true);
  const p = (await db.query(`insert into public.order_return_photos(return_line_id,upload_id,storage_path,content_type,size_bytes,created_at)
    values($1,$2,$3,'image/jpeg',100,now()-$4::interval) returning id`, [f.lineId, u.id, u.path, age])).rows[0];
  return { id: p.id as string, uploadId: u.id, path: u.path };
}
async function cancelFixture(db: PgClient, age = '0 days') {
  const c = await createCatalogFixture(db, { stock: 2 });
  const o = await insertOrderWithLines(db, { status: 'paid', paidAmount: 2 * PRICE,
    paymentIntentId: `pi_review_${uniqueSuffix()}`,
    lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock' }] });
  const actor = randomUUID();
  const r = (await db.query(`insert into public.order_cancel_requests
    (order_id,status,request_key,request_fingerprint,customer_note,requested_at,requested_by)
    values($1,'requested',gen_random_uuid(),'fixture','ご連絡です。',now()-$2::interval,$3) returning id`,
    [o.orderId, age, actor])).rows[0];
  await db.query(`insert into public.order_cancel_request_lines(cancel_request_id,order_item_id,quantity) values($1,$2,1)`,
    [r.id, o.orderItemIds[0]]);
  return { id: r.id as string, orderId: o.orderId, itemId: o.orderItemIds[0], actor };
}
async function resolutionRefund(db: PgClient, orderId: string, status: string, age = '0 days') {
  return (await db.query(`insert into public.order_refunds
    (order_id,source,request_key,request_fingerprint,status,amount,notify_customer,created_at)
    values($1,'admin',gen_random_uuid(),'fixture',$2,1,false,now()-$3::interval) returning id`,
    [orderId, status, age])).rows[0].id as string;
}
const sorted = (x: Row) => Object.keys(x).sort();

describeLocalDb('お店の申し込みの確認（移行 F）', getDb => {
  const db = () => getDb();
  beforeEach(async () => { await db().query('begin'); await db().query('delete from private.order_email_outbox'); });
  afterEach(async () => { await db().query('rollback'); });

  test.each([false, true])('承認で3列と承認の記録を変え、ご希望を保持する。通知 %s', async notify => {
    const f = await fixture(db());
    const r = await approve(db(), f, { notify, method: 'shop_label', shipping: 600, percent: 10, fee: 100,
      exchangeShipping: 200, carrier: 'yamato', tracking: 'TEST-1' });
    expect(r).toEqual({ return_id: f.returnId, status: 'open' });
    const parent = (await db().query('select * from public.order_returns where id=$1', [f.returnId])).rows[0];
    expect(parent).toMatchObject({ approved_by: f.actor, return_method: 'shop_label', return_shipping_payer: 'customer',
      return_shipping_fee: 600, restocking_fee_percent: 10, exchange_fee: 100, exchange_shipping_fee: 200,
      return_carrier: 'yamato', return_tracking_number: 'TEST-1', shop_note: '内部のメモ', notify_customer: notify });
    expect(parent.approved_at).not.toBeNull();
    expect((await db().query('select * from public.order_return_lines where id=$1', [f.lineId])).rows[0])
      .toMatchObject({ resolution: 'refund', exchange_variant_id: null, exchange_method: null,
        requested_resolution: 'exchange', requested_exchange_variant_id: String(f.variantId), quantity: 1,
        customer_note: '縫い目をご確認ください。' });
    expect(await emailCount(db(), f, 'return_accepted')).toBe(notify ? 1 : 0);
    await fails(db(), () => approve(db(), f, { notify }), 'RETURN_STATE_CONFLICT');
    expect(await emailCount(db(), f, 'return_accepted')).toBe(notify ? 1 : 0);
  });
  test.each(['customer_ships', 'shop_label'])('店負担の %s は返送料を0にする', async method => {
    const f = await fixture(db()); await approve(db(), f, { method, payer: 'shop', shipping: 600 });
    expect((await db().query('select return_shipping_fee from public.order_returns where id=$1', [f.returnId])).rows[0])
      .toEqual({ return_shipping_fee: 0 });
  });
  test('返送先が空なら返送不要でも承認を断る', async () => {
    const f = await fixture(db());
    await db().query(`update public.shop_return_settings set return_address_name=null,return_address_postal_code=null,
      return_address_line=null,return_address_phone=null,no_return_needed_enabled=true where id=1`);
    await fails(db(), () => approve(db(), f, { method: 'not_required' }), 'RETURN_ADDRESS_REQUIRED');
  });
  test('返送不要は設定を有効にした時だけ承認できる', async () => {
    const f = await fixture(db());
    await fails(db(), () => approve(db(), f, { method: 'not_required' }), 'RETURN_ARGUMENT_INVALID');
    await db().query('update public.shop_return_settings set no_return_needed_enabled=true where id=1');
    expect((await approve(db(), f, { method: 'not_required' })).status).toBe('open');
  });
  test.each(['empty', 'duplicate', 'foreign', 'missing', 'bad_uuid', 'bad_resolution', 'refund_exchange', 'exchange_missing', 'bad_method'])
    ('承認の行の形 %s を断り、全部の行を1回ずつ求める', async mode => {
      const f = await fixture(db());
      const base = approvalLines(f)[0];
      let lines: Row[] = [base];
      if (mode === 'empty') lines = [];
      if (mode === 'duplicate') lines = [base, base];
      if (mode === 'foreign') lines = [{ ...base, return_line_id: randomUUID() }];
      if (mode === 'bad_uuid') lines = [{ ...base, return_line_id: 'invalid' }];
      if (mode === 'bad_resolution') lines = [{ ...base, resolution: 'none' }];
      if (mode === 'refund_exchange') lines = [{ ...base, exchange_variant_id: f.variantId }];
      if (mode === 'exchange_missing') lines = [{ ...base, resolution: 'exchange' }];
      if (mode === 'bad_method') lines = [{ ...base, resolution: 'exchange', exchange_variant_id: f.variantId, exchange_method: 'other' }];
      if (mode === 'missing') {
        await db().query(`insert into public.order_return_lines(return_id,fulfillment_id,order_item_id,quantity,reason,resolution)
          select return_id,fulfillment_id,order_item_id,1,'defective','refund' from public.order_return_lines where id=$1`, [f.lineId]);
      }
      await fails(db(), () => approve(db(), f, { lines }), 'RETURN_ARGUMENT_INVALID');
      expect((await db().query('select status from public.order_returns where id=$1', [f.returnId])).rows[0].status).toBe('requested');
    });
  test.each(['shipping', 'fee', 'exchangeShipping', 'percent'])('手数料 %s の必須と上下限を守る', async key => {
    const f = await fixture(db()); const max = key === 'percent' ? 100 : 1000000;
    for (const value of [null, -1, max + 1]) await fails(db(), () => approve(db(), f, { [key]: value }), 'RETURN_FEE_INVALID');
    await approve(db(), f, { [key]: max });
  });
  test.each(['foreign', 'inactive', 'missing'])('交換の色・サイズ %s は断る', async mode => {
    const f = await fixture(db()); let id = f.variantId;
    if (mode === 'foreign') id = (await createCatalogFixture(db(), { stock: 1 })).variantId;
    if (mode === 'inactive') await db().query('update public.item_variants set is_active=false where id=$1', [id]);
    if (mode === 'missing') id = -1;
    await fails(db(), () => approve(db(), f, { lines: approvalLines(f, {
      resolution: 'exchange', exchange_variant_id: id, exchange_method: 'stock',
    }) }), 'RETURN_EXCHANGE_VARIANT_INVALID');
  });
  test.each(['stock', 'make'])('交換を %s で承認する。承認では在庫を動かさない', async method => {
    const f = await fixture(db());
    const before = (await db().query('select stock_quantity from public.item_variants where id=$1', [f.variantId])).rows[0];
    await approve(db(), f, { lines: approvalLines(f, { resolution: 'exchange', exchange_variant_id: f.variantId, exchange_method: method }) });
    const l = (await db().query('select exchange_method,exchange_variant_id from public.order_return_lines where id=$1', [f.lineId])).rows[0];
    expect(l).toEqual({ exchange_method: method, exchange_variant_id: String(f.variantId) });
    expect((await db().query('select stock_quantity from public.item_variants where id=$1', [f.variantId])).rows[0]).toEqual(before);
  });
  test.each(['window_passed', 'final_sale', 'other'])('お断り %s は通知の設定によらず1通の予定を作る', async reason => {
    const f = await fixture(db());
    const r = (await db().query('select * from public.admin_decline_return($1,$2,$3,$4)',
      [f.returnId, f.actor, reason, '  受付できません。  '])).rows[0];
    expect(r).toEqual({ return_id: f.returnId, status: 'declined' });
    expect((await db().query('select decline_reason,decline_message,declined_by,declined_at from public.order_returns where id=$1', [f.returnId])).rows[0])
      .toMatchObject({ decline_reason: reason, decline_message: '受付できません。', declined_by: f.actor });
    expect(await emailCount(db(), f, 'return_declined')).toBe(1);
    await fails(db(), () => db().query('select * from public.admin_decline_return($1,$2,$3,$4)',
      [f.returnId, f.actor, reason, '再送']), 'RETURN_STATE_CONFLICT');
  });
  test.each(['', '   ', 'x'.repeat(1001), null])('お断りの空または長すぎるメッセージを断る %s', async message => {
    const f = await fixture(db());
    await fails(db(), () => db().query('select * from public.admin_decline_return($1,$2,$3,$4)',
      [f.returnId, f.actor, 'other', message]), 'RETURN_DECLINE_MESSAGE_REQUIRED');
  });
  test('不明な理由を断り、1000字のお断りを受ける', async () => {
    const f = await fixture(db());
    await fails(db(), () => db().query('select * from public.admin_decline_return($1,$2,$3,$4)',
      [f.returnId, f.actor, 'invalid', '文']), 'RETURN_ARGUMENT_INVALID');
    await db().query('select * from public.admin_decline_return($1,$2,$3,$4)', [f.returnId, f.actor, 'other', '文'.repeat(1000)]);
  });
  test('中身と材料は既存のキーと段2のキーを過不足なく返す', async () => {
    const f = await fixture(db()); const p = await photo(db(), f);
    await db().query('update public.items set return_ineligible=true where id=(select item_id from public.order_items where id=$1)', [f.itemId]);
    const d = (await db().query('select private.return_detail_json($1) d', [f.returnId])).rows[0].d;
    expect(sorted(d)).toEqual(['id','number','status','source','display_status','marks','return_method','return_shipping_payer',
      'return_carrier','return_tracking_number','fees','first_receipt_done','first_exchange_receipt_done','shop_note','notify_customer',
      'created_at','created_by_email','closed_at','cancelled_at','lines','refunds','receipts','exchange_items',
      'requested_at','approved_at','approved_by_email','declined_at','decline_reason','decline_message'].sort());
    expect(sorted(d.lines[0])).toEqual(['id','fulfillment_id','fulfillment_number','order_item_id','item_name','color','size','quantity',
      'reason','reason_note','resolution','exchange','progress','refund_amounts_by_count','refund_waiting_amount',
      'customer_note','requested_resolution','requested_exchange','photos','return_ineligible'].sort());
    expect(d.lines[0]).toMatchObject({ requested_resolution: 'exchange', customer_note: '縫い目をご確認ください。',
      return_ineligible: true, photos: [{ id: p.id, purged: false }] });
    expect(sorted(d.lines[0].requested_exchange)).toEqual(['color','size','variant_id']);
    expect(d.lines[0].requested_exchange.variant_id).toBe(f.variantId);
    const m = (await db().query('select public.get_order_return_materials($1) d', [f.orderId])).rows[0].d;
    expect(sorted(m)).toEqual(['exchange_options','order','settings','shipments']);
    expect(sorted(m.shipments[0].lines[0])).toEqual(['order_item_id','item_id','variant_id','item_name','color','size','line_kind','quantity','returnable','return_ineligible'].sort());
    expect(m.shipments[0].lines[0].return_ineligible).toBe(true);
    await approve(db(), f);
    const approved = (await db().query('select private.return_detail_json($1) d', [f.returnId])).rows[0].d;
    expect(approved.approved_by_email).toMatch(/^review-.*@example\.com$/);
    expect(approved.approved_at).not.toBeNull();
  });
  test('写真の一覧は行と写真の作成順で、消した物も返す', async () => {
    const f = await fixture(db()); const p = await photo(db(), f, '2 seconds');
    const q = await photo(db(), f, '1 second');
    await db().query('update public.order_return_photos set purged_at=now() where id=$1', [q.id]);
    const rows = (await db().query('select * from public.list_return_photos($1)', [f.returnId])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map(x => x.photo_id)).toEqual([p.id, q.id]);
    expect(rows.find(x => x.photo_id === p.id)).toEqual({ photo_id: p.id, return_line_id: f.lineId, storage_path: p.path, purged: false });
    expect(rows.find(x => x.photo_id === q.id).purged).toBe(true);
    expect((await db().query('select * from public.list_return_photos($1)', [randomUUID()])).rows).toEqual([]);
  });
  test('写真は写真の時刻より返品の行の作成順を優先する', async () => {
    const f = await fixture(db());
    const second = (await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution,created_at)
      select return_id,fulfillment_id,order_item_id,1,'defective','refund',now()+interval '1 second'
      from public.order_return_lines where id=$1 returning id`, [f.lineId])).rows[0];
    const p = await photo(db(), f, '-10 seconds');
    const q = await photo(db(), { ...f, lineId: second.id }, '10 seconds');
    const rows = (await db().query('select * from public.list_return_photos($1)', [f.returnId])).rows;
    expect(rows.map(x => x.photo_id)).toEqual([p.id, q.id]);
  });
  test('複数の行を一度に承認し、1行でも無効な交換ならどの行も変えない', async () => {
    const f = await fixture(db());
    const second = (await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution)
      select return_id,fulfillment_id,order_item_id,1,'defective','refund'
      from public.order_return_lines where id=$1 returning id`, [f.lineId])).rows[0];
    const foreign = await createCatalogFixture(db(), { stock: 1 });
    const lines = [...approvalLines(f), { return_line_id: second.id, resolution: 'exchange',
      exchange_variant_id: foreign.variantId, exchange_method: 'stock' }];
    await fails(db(), () => approve(db(), f, { lines }), 'RETURN_EXCHANGE_VARIANT_INVALID');
    expect((await db().query('select resolution from public.order_return_lines where id=$1', [f.lineId])).rows[0].resolution).toBe('exchange');
    lines[1].exchange_variant_id = f.variantId;
    expect((await approve(db(), f, { lines })).status).toBe('open');
    expect((await db().query('select resolution from public.order_return_lines where id=$1', [f.lineId])).rows[0].resolution).toBe('refund');
    expect((await db().query('select resolution from public.order_return_lines where id=$1', [second.id])).rows[0].resolution).toBe('exchange');
  });
  test('お店の返品の段2の任意のキーは null と空配列で返す', async () => {
    const f = await fixture(db(), { shop: true });
    const d = (await db().query('select private.return_detail_json($1) d', [f.returnId])).rows[0].d;
    expect(d).toMatchObject({ requested_at: null, approved_by_email: null, declined_at: null,
      decline_reason: null, decline_message: null });
    expect(d.lines[0]).toMatchObject({ customer_note: null, requested_resolution: null,
      requested_exchange: null, photos: [], return_ineligible: false });
  });
  test('サポートの今返金は計算どおりに返金を作り、店への知らせを作らず再送できる', async () => {
    const f = await fixture(db()); await approve(db(), f); const key = randomUUID();
    const r = await receive(db(), f, { key });
    expect(r).toMatchObject({ refund_amount: PRICE, refund_status: 'awaiting_response', shop_notice_enqueued: false, replayed: false });
    expect(r.refund_id).not.toBeNull();
    expect((await db().query('select source,return_id,amount from public.order_refunds where id=$1', [r.refund_id])).rows[0])
      .toEqual({ source: 'return', return_id: f.returnId, amount: PRICE });
    expect(await emailCount(db(), f, 'return_refund_pending_shop')).toBe(0);
    expect(await receive(db(), f, { key })).toMatchObject({ receipt_id: r.receipt_id, refund_id: r.refund_id, replayed: true });
  });
  test('サポートの0円は waived で店への知らせを作らない', async () => {
    const f = await fixture(db()); await approve(db(), f, { percent: 100 });
    const r = await receive(db(), f);
    expect(r).toMatchObject({ refund_id: null, refund_amount: 0, refund_status: 'waived', shop_notice_enqueued: false });
    expect(await emailCount(db(), f, 'return_refund_pending_shop')).toBe(0);
  });
  test.each(['shop', 'not_required'])('サポートの今返金は %s の返品を断る', async kind => {
    const f = await fixture(db(), { shop: kind === 'shop' });
    if (kind === 'not_required') {
      await db().query('update public.shop_return_settings set no_return_needed_enabled=true where id=1');
      await approve(db(), f, { method: 'not_required' });
    }
    await fails(db(), () => receive(db(), f), 'RETURN_FORBIDDEN');
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1', [f.returnId])).rows[0].n).toBe(0);
  });
  test.each(['amount', 'shipping', 'overrides'])('サポートの %s の指定は申し込みの返品でも断る', async field => {
    const f = await fixture(db()); await approve(db(), f);
    const o = field === 'overrides' ? { overrides: [{ return_line_id: f.lineId, action: 'refund' }] } : { [field]: 1 };
    await fails(db(), () => receive(db(), f, o), 'RETURN_FORBIDDEN');
  });
  test('確かめ中の返金で今返金を断ると受け取り・在庫・予定も戻り、相談なら1通（Review Focus 5）', async () => {
    const f = await fixture(db()); await approve(db(), f);
    await resolutionRefund(db(), f.orderId, 'awaiting_response');
    const stock = (await db().query('select stock_quantity from public.item_variants where id=$1', [f.variantId])).rows[0];
    const before = (await db().query(`select (select count(*) from public.order_refunds where order_id=$1)::int refunds,
      (select count(*) from public.stock_movements where order_id=$1)::int movements`, [f.orderId])).rows[0];
    await fails(db(), () => receive(db(), f), 'AWAITING_REFUND_EXISTS');
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1', [f.returnId])).rows[0].n).toBe(0);
    expect((await db().query('select stock_quantity from public.item_variants where id=$1', [f.variantId])).rows[0]).toEqual(stock);
    expect((await db().query(`select (select count(*) from public.order_refunds where order_id=$1)::int refunds,
      (select count(*) from public.stock_movements where order_id=$1)::int movements`, [f.orderId])).rows[0]).toEqual(before);
    expect(await emailCount(db(), f, 'return_refund_pending_shop')).toBe(0);
    const r = await receive(db(), f, { choice: 'consult' });
    expect(r).toMatchObject({ refund_id: null, shop_notice_enqueued: true });
    expect(await emailCount(db(), f, 'return_refund_pending_shop')).toBe(1);
  });
  test('店長の今返金はお店の返品でも額を変更できる', async () => {
    const f = await fixture(db(), { shop: true });
    expect(await receive(db(), f, { can: true, amount: 4000 })).toMatchObject({ refund_amount: 4000, shop_notice_enqueued: false });
  });
  test('サポートの相談はお店の返品でも通知する', async () => {
    const f = await fixture(db(), { shop: true });
    expect(await receive(db(), f, { choice: 'consult' })).toMatchObject({ shop_notice_enqueued: true });
  });
  test('キャンセルの一覧は全キーと今の未発送数を返す', async () => {
    const f = await cancelFixture(db());
    const a = (await db().query('select public.list_order_cancel_requests($1) d', [f.orderId])).rows[0].d;
    expect(a).toHaveLength(1);
    expect(sorted(a[0])).toEqual(['id','status','requested_at','customer_note','lines','decline_reason','decline_message','declined_at',
      'declined_by_email','resolved_at','resolved_by_email','resolved_refund_id','resolved_by_cancel_at','closed_at','closed_by_email'].sort());
    expect(sorted(a[0].lines[0])).toEqual(['order_item_id','item_name','color','size','quantity','unshipped'].sort());
    expect(a[0].lines[0]).toMatchObject({ order_item_id: f.itemId, quantity: 1, unshipped: 2 });
    expect((await db().query('select public.list_order_cancel_requests($1) d', [randomUUID()])).rows[0].d).toEqual([]);
    await db().query('select * from public.admin_close_cancel_request($1,$2)', [f.id, f.actor]);
    const newer = (await db().query(`insert into public.order_cancel_requests
      (order_id,status,request_key,request_fingerprint,requested_at,requested_by)
      values($1,'requested',gen_random_uuid(),'fixture',now()+interval '1 second',$2) returning id`, [f.orderId, f.actor])).rows[0];
    const b = (await db().query('select public.list_order_cancel_requests($1) d', [f.orderId])).rows[0].d;
    expect(b.map((x: Row) => x.id)).toEqual([newer.id, f.id]);
  });
  test.each(['decline', 'close'])('キャンセルの %s は状態と予定を守る', async op => {
    const f = await cancelFixture(db());
    const run = () => op === 'decline'
      ? db().query('select * from public.admin_decline_cancel_request($1,$2,$3,$4)', [f.id, f.actor, 'other', '  受付できません。  '])
      : db().query('select * from public.admin_close_cancel_request($1,$2)', [f.id, f.actor]);
    expect((await run()).rows[0]).toEqual({ cancel_request_id: f.id, status: op === 'decline' ? 'declined' : 'closed' });
    const r = (await db().query('select * from public.order_cancel_requests where id=$1', [f.id])).rows[0];
    expect(r[op === 'decline' ? 'declined_at' : 'closed_at']).not.toBeNull();
    expect(r[op === 'decline' ? 'declined_by' : 'closed_by']).toBe(f.actor);
    if (op === 'decline') expect(r.decline_message).toBe('受付できません。');
    expect((await db().query('select count(*)::int n from private.order_email_outbox where cancel_request_id=$1', [f.id])).rows[0].n)
      .toBe(op === 'decline' ? 1 : 0);
    await fails(db(), run, 'CANCEL_REQUEST_STATE_CONFLICT');
  });
  test.each(['', ' ', '文'.repeat(1001), null])('キャンセルのお断りもメッセージ必須 %s', async message => {
    const f = await cancelFixture(db());
    await fails(db(), () => db().query('select * from public.admin_decline_cancel_request($1,$2,$3,$4)',
      [f.id, f.actor, 'other', message]), 'RETURN_DECLINE_MESSAGE_REQUIRED');
  });
  test('キャンセルのお断りの理由を検査し、1000字のメッセージを受ける', async () => {
    const f = await cancelFixture(db());
    await fails(db(), () => db().query('select * from public.admin_decline_cancel_request($1,$2,$3,$4)',
      [f.id, f.actor, 'invalid', '文']), 'RETURN_ARGUMENT_INVALID');
    expect((await db().query('select * from public.admin_decline_cancel_request($1,$2,$3,$4)',
      [f.id, f.actor, 'final_sale', '文'.repeat(1000)])).rows[0].status).toBe('declined');
    await fails(db(), () => db().query('select * from public.admin_close_cancel_request($1,$2)',
      [f.id, f.actor]), 'CANCEL_REQUEST_STATE_CONFLICT');
    await fails(db(), () => db().query('select * from public.admin_resolve_cancel_request($1,$2,null,true)',
      [f.id, f.actor]), 'CANCEL_REQUEST_STATE_CONFLICT');
  });
  test.each(['awaiting_response', 'pending', 'succeeded'])('同じ注文の申し込み以降の %s の返金で解決する', async status => {
    const f = await cancelFixture(db(), '1 day'); const id = await resolutionRefund(db(), f.orderId, status);
    const r = (await db().query('select * from public.admin_resolve_cancel_request($1,$2,$3,false)', [f.id, f.actor, id])).rows[0];
    expect(r).toEqual({ cancel_request_id: f.id, status: 'resolved' });
    expect((await db().query('select resolved_refund_id,resolved_by_cancel_at from public.order_cancel_requests where id=$1', [f.id])).rows[0])
      .toEqual({ resolved_refund_id: id, resolved_by_cancel_at: null });
    expect((await db().query('select count(*)::int n from private.order_email_outbox where cancel_request_id=$1', [f.id])).rows[0].n).toBe(0);
    await fails(db(), () => db().query('select * from public.admin_resolve_cancel_request($1,$2,$3,false)', [f.id, f.actor, id]), 'CANCEL_REQUEST_STATE_CONFLICT');
  });
  test.each(['failed', 'old', 'foreign', 'both', 'neither', 'missing', 'not_cancelled'])('解決の根拠 %s を断る', async mode => {
    const f = await cancelFixture(db());
    let id: string | null = null; let cancelled = false;
    if (mode === 'failed') id = await resolutionRefund(db(), f.orderId, 'failed');
    if (mode === 'old') id = await resolutionRefund(db(), f.orderId, 'pending', '1 day');
    if (mode === 'foreign') id = await resolutionRefund(db(), (await cancelFixture(db())).orderId, 'pending');
    if (mode === 'both') { id = await resolutionRefund(db(), f.orderId, 'pending'); cancelled = true; }
    if (mode === 'missing') id = randomUUID();
    if (mode === 'not_cancelled') cancelled = true;
    await fails(db(), () => db().query('select * from public.admin_resolve_cancel_request($1,$2,$3,$4)',
      [f.id, f.actor, id, cancelled]), 'CANCEL_REQUEST_RESOLUTION_INVALID');
    expect((await db().query('select status from public.order_cancel_requests where id=$1', [f.id])).rows[0].status).toBe('requested');
  });
  test('取り消した注文なら返金の番号なしで解決する', async () => {
    const c = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'cancelled', lines: [{ itemId: c.itemId, variantId: c.variantId,
      quantity: 1, fulfillmentType: 'stock' }] });
    const actor = randomUUID();
    const f = (await db().query(`insert into public.order_cancel_requests(order_id,status,request_key,request_fingerprint,requested_by)
      values($1,'requested',gen_random_uuid(),'fixture',$2) returning id`, [o.orderId, actor])).rows[0];
    expect((await db().query('select * from public.admin_resolve_cancel_request($1,$2,null,true)', [f.id, actor])).rows[0].status).toBe('resolved');
    const r = (await db().query('select resolved_refund_id,resolved_by_cancel_at from public.order_cancel_requests where id=$1', [f.id])).rows[0];
    expect(r.resolved_refund_id).toBeNull(); expect(r.resolved_by_cancel_at).not.toBeNull();
  });
  test.each(['decline', 'close', 'resolve'])('無いキャンセルの申し込みの %s は NOT_FOUND', async op => {
    const id = randomUUID(); const actor = randomUUID();
    await fails(db(), () => op === 'decline'
      ? db().query('select * from public.admin_decline_cancel_request($1,$2,$3,$4)', [id, actor, 'other', '文'])
      : op === 'close' ? db().query('select * from public.admin_close_cancel_request($1,$2)', [id, actor])
      : db().query('select * from public.admin_resolve_cancel_request($1,$2,$3,false)', [id, actor, randomUUID()]), 'CANCEL_REQUEST_NOT_FOUND');
  });
  test('1日を過ぎた未使用の送り先だけを古い順に選び、件数を1〜500に丸める', async () => {
    const f = await fixture(db());
    const old = await upload(db(), f.orderId, f.actor, '3 days');
    const next = await upload(db(), f.orderId, f.actor, '2 days');
    const boundary = await upload(db(), f.orderId, f.actor, '1 day');
    const young = await upload(db(), f.orderId, f.actor, '23 hours');
    const used = await upload(db(), f.orderId, f.actor, '4 days', true);
    const purged = await upload(db(), f.orderId, f.actor, '5 days');
    await db().query('update public.order_return_photo_uploads set purged_at=now() where id=$1', [purged.id]);
    // 全フォルダの試験が残した行も含まれるため、対象の順序はこの取引で作った番号だけで比べる。
    const a = (await db().query('select * from public.list_return_photo_purge_targets(null)')).rows;
    const own = new Set([old.id, next.id, boundary.id, young.id, used.id, purged.id]);
    expect(a.filter(x => own.has(x.target_id)).map(x => x.target_id)).toEqual([old.id, next.id]);
    for (const limit of [0, -1, 1]) expect((await db().query('select * from public.list_return_photo_purge_targets($1)', [limit])).rows).toHaveLength(1);
    for (const age of ['6 days', '7 days']) {
      await db().query(`insert into public.order_return_photo_uploads(order_id,customer_id,storage_path,created_at)
        select $1::uuid,$2::uuid,'requests/'||$1::text||'/'||gen_random_uuid()::text,now()-$3::interval
        from generate_series(1,300)`, [f.orderId, f.actor, age]);
    }
    expect((await db().query('select * from public.list_return_photo_purge_targets(1000)')).rows).toHaveLength(500);
    expect((await db().query('select * from public.list_return_photo_purge_targets(null)')).rows).toHaveLength(500);
  });
  test.each(['closed', 'cancelled', 'declined'])('写真は %s の終了から90日を超えた時だけ対象', async status => {
    const old = await fixture(db(), { status, age: '90 days 1 second' }); const p = await photo(db(), old);
    const edge = await fixture(db(), { status, age: '90 days' }); const q = await photo(db(), edge);
    const recent = await fixture(db(), { status, age: '89 days' }); const r = await photo(db(), recent);
    const ids = (await db().query('select * from public.list_return_photo_purge_targets(500)')).rows.map(x => x.target_id);
    expect(ids).toContain(p.id); expect(ids).not.toContain(q.id); expect(ids).not.toContain(r.id);
  });
  test('開き直した返品と申し込み中は写真を消す対象にしない', async () => {
    const f = await fixture(db(), { status: 'closed' }); const p = await photo(db(), f);
    await insertReturnReceipt(db(), { returnId: f.returnId, kind: 'close_missing',
      lines: [{ returnLineId: f.lineId, disposition: 'missing', quantity: 1 }] });
    await db().query('select * from public.admin_reopen_return($1,$2,$3)', [f.returnId, f.actor, randomUUID()]);
    const g = await fixture(db()); const q = await photo(db(), g);
    const ids = (await db().query('select * from public.list_return_photo_purge_targets(500)')).rows.map(x => x.target_id);
    expect(ids).not.toContain(p.id); expect(ids).not.toContain(q.id);
  });
  test.each(['upload', 'photo'])('消した %s の印は1回だけ付き、写真なら送り先にも付く', async kind => {
    const f = await fixture(db(), { status: 'closed' }); const p = await photo(db(), f);
    const u = await upload(db(), f.orderId, f.actor); const id = kind === 'upload' ? u.id : p.id;
    const run = () => db().query('select public.mark_return_photo_targets_purged($1,$2::uuid[]) n', [kind, [id, id, randomUUID()]]);
    expect((await run()).rows[0].n).toBe(1); expect((await run()).rows[0].n).toBe(0);
    expect((await db().query('select * from public.list_return_photo_purge_targets(500)')).rows.map(x => x.target_id)).not.toContain(id);
    const uid = kind === 'upload' ? u.id : p.uploadId;
    expect((await db().query('select purged_at from public.order_return_photo_uploads where id=$1', [uid])).rows[0].purged_at).not.toBeNull();
    if (kind === 'photo') expect((await db().query('select purged_at from public.order_return_photos where id=$1', [p.id])).rows[0].purged_at).not.toBeNull();
    expect((await db().query('select public.mark_return_photo_targets_purged($1,$2::uuid[]) n', [kind, []])).rows[0].n).toBe(0);
  });
  test('印を付ける種類を検査する', async () => {
    await fails(db(), () => db().query('select public.mark_return_photo_targets_purged($1,$2::uuid[])', ['invalid', []]), 'RETURN_ARGUMENT_INVALID');
  });
  test('公開関数は service_role だけが実行できる。キャンセルの鍵の補助（private）は SECURITY DEFINER でなく、だれも直接呼べない', async () => {
    const names = ['admin_approve_return','admin_decline_return','list_return_photos','admin_receive_return',
      'list_order_cancel_requests','admin_decline_cancel_request','admin_close_cancel_request','admin_resolve_cancel_request',
      'list_return_photo_purge_targets','mark_return_photo_targets_purged','get_order_return_materials'];
    const rows = (await db().query(`select p.oid,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[])`, [names])).rows;
    expect(rows).toHaveLength(names.length);
    for (const p of rows) {
      expect(p.prosecdef).toBe(true); expect(p.proconfig.join(' ')).toContain('search_path=');
      for (const role of ['anon','authenticated','service_role']) {
        expect((await db().query(`select has_function_privilege($1,$2::oid,'EXECUTE') allowed`, [role, p.oid])).rows[0].allowed)
          .toBe(role === 'service_role');
      }
    }
    // private の補助は SECURITY DEFINER を付けず（C-1）、呼ぶのは上の公開関数（持ち主の権限）だけ。
    const lock = (await db().query(`select p.oid,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname='lock_order_cancel_request'`)).rows;
    expect(lock).toHaveLength(1); expect(lock[0].prosecdef).toBe(false);
    for (const role of ['anon','authenticated','service_role']) {
      expect((await db().query(`select has_function_privilege($1,$2::oid,'EXECUTE') allowed`, [role, lock[0].oid])).rows[0].allowed)
        .toBe(false);
    }
  });
});
