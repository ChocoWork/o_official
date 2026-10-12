/** @jest-environment node */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines, variantStock, uniqueSuffix, revisionsOf } from './helpers/order-fixtures';
jest.setTimeout(30000);
type Row = Record<string, any>;
type Fx = { orderId:string; itemId:string; variantId:number; returnId:string; lineId:string; actor:string };
async function fails(db:PgClient,work:()=>Promise<unknown>,message:string) {
  await db.query('savepoint expected_error');
  try { await expect(work()).rejects.toMatchObject({message}); }
  finally { await db.query('rollback to savepoint expected_error'); }
}
async function fixture(db:PgClient,o:{quantity?:number;returnQuantity?:number;exchange?:boolean;method?:string;stock?:number;fee?:number;shippingFee?:number;percent?:number;discount?:number;paymentIntent?:string|null;paid?:number|null}={}):Promise<Fx> {
  // 空の返送先では返品作成が止まるため、試験用の住所を取引の中だけ設定する。
  await db.query(`update public.shop_return_settings set return_address_name='試験店舗',return_address_postal_code='1500001',
    return_address_line='東京都渋谷区神宮前1-1-1',return_address_phone='0311112222',
    restocking_fee_enabled=true,exchange_fees_enabled=true,inspection_enabled=true where id=1`);
  const q=o.quantity??1;
  const actor=(await db.query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
    values(gen_random_uuid(),$1,'{}',now(),now()) returning id`,[`returns-${uniqueSuffix()}@example.com`])).rows[0].id;
  const cat=await createCatalogFixture(db,{stock:q+(o.stock??1)});
  const order=await insertOrderWithLines(db,{status:'paid',lines:[{itemId:cat.itemId,variantId:cat.variantId,quantity:q,fulfillmentType:'stock'}],
    discountAmount:o.discount??0,paidAmount:o.paid===undefined?PRICE*q-(o.discount??0):o.paid,paymentIntentId:o.paymentIntent===undefined?`pi_fx_${uniqueSuffix()}`:o.paymentIntent});
  const ship=(await db.query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-1',false,$4::jsonb)`,
    [order.orderId,actor,randomUUID(),JSON.stringify([{order_item_id:order.orderItemIds[0],quantity:q}])])).rows[0];
  const ret=(await db.query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,$5,'customer',null,null,$6,$7,$8,0,null,false)`,
    [order.orderId,actor,randomUUID(),JSON.stringify([{fulfillment_id:ship.fulfillment_id,order_item_id:order.orderItemIds[0],quantity:o.returnQuantity??q,reason:'unknown',reason_note:null,
    resolution:o.exchange?'exchange':'refund',exchange_variant_id:o.exchange?cat.variantId:null,exchange_method:o.exchange?(o.method??'stock'):null}]),
    o.shippingFee?'shop_label':'customer_ships',o.shippingFee??0,o.percent??0,o.fee??0])).rows[0];
  const line=(await db.query('select id from public.order_return_lines where return_id=$1',[ret.return_id])).rows[0];
  return {orderId:order.orderId,itemId:order.orderItemIds[0],variantId:cat.variantId,returnId:ret.return_id,lineId:line.id,actor};
}
async function receive(db:PgClient,f:Fx,o:Row={}):Promise<Row> {
  return (await db.query(`select * from public.admin_receive_return($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,0,null,$9,$10,null,null)`,
    [f.returnId,f.actor,o.can??true,o.key??randomUUID(),JSON.stringify(o.units??[{return_line_id:f.lineId,disposition:o.disposition??'restocked',quantity:o.quantity??1}]),
    JSON.stringify(o.overrides??[]),o.choice??'consult',o.amount??null,o.notify??true,o.message??null])).rows[0];
}
async function refund(db:PgClient,f:Fx,amount:number|null=null,key=randomUUID()):Promise<Row> {
  return (await db.query('select * from public.admin_refund_return($1,$2,$3,$4,0,null,true)',[f.returnId,f.actor,key,amount])).rows[0];
}
async function ordinaryRefund(db:PgClient,f:Fx):Promise<Row> {
  return (await db.query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5)`,
    [f.orderId,randomUUID(),JSON.stringify([{order_item_id:f.itemId,before_shipment:false,quantity:1}]),PRICE,f.actor])).rows[0];
}
async function result(db:PgClient,id:string,status:string) {
  return (await db.query(`select * from public.record_order_refund_result($1,$2,$3,null,$4,null,'card',null,null)`,
    [id,`re_${id.replace(/-/g,'')}`,status,status==='failed'?'lost_or_stolen_card':null])).rows[0];
}
async function progress(db:PgClient,f:Fx) {return (await db.query('select * from private.order_return_line_progress($1)',[f.returnId])).rows[0];}
// 同じ商品の2点を、同じ色・サイズへの交換（在庫から）の2行に分けた返品。在庫は受け取りの前に stock 点。
// lineId・secondLineId は list_order_returns の lines の並び（DB が在庫を割り当てる順・画面が数える順）の1つ目と2つ目
async function twoExchangeLines(db:PgClient,stock:number,discount=0):Promise<Fx&{secondLineId:string}> {
  await db.query(`update public.shop_return_settings set return_address_name='試験店舗',return_address_postal_code='1500001',
    return_address_line='東京都渋谷区神宮前1-1-1',return_address_phone='0311112222' where id=1`);
  const actor=(await db.query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
    values(gen_random_uuid(),$1,'{}',now(),now()) returning id`,[`returns-two-${uniqueSuffix()}@example.com`])).rows[0].id as string;
  const cat=await createCatalogFixture(db,{stock:2+stock});
  const order=await insertOrderWithLines(db,{status:'paid',discountAmount:discount,paidAmount:PRICE*2-discount,paymentIntentId:`pi_fx_${uniqueSuffix()}`,
    lines:[{itemId:cat.itemId,variantId:cat.variantId,quantity:2,fulfillmentType:'stock'}]});
  const ship=(await db.query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-T',false,$4::jsonb)`,
    [order.orderId,actor,randomUUID(),JSON.stringify([{order_item_id:order.orderItemIds[0],quantity:2}])])).rows[0];
  const line={fulfillment_id:ship.fulfillment_id,order_item_id:order.orderItemIds[0],quantity:1,reason:'unknown',reason_note:null,
    resolution:'exchange',exchange_variant_id:cat.variantId,exchange_method:'stock'};
  const ret=(await db.query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,'customer_ships','customer',null,null,0,0,0,0,null,false)`,
    [order.orderId,actor,randomUUID(),JSON.stringify([line,line])])).rows[0];
  const ids=(await db.query('select public.list_order_returns($1) as returns',[order.orderId])).rows[0].returns[0].lines.map((l:Row)=>l.id as string);
  return {orderId:order.orderId,itemId:order.orderItemIds[0],variantId:cat.variantId,returnId:ret.return_id,lineId:ids[0],secondLineId:ids[1],actor};
}

async function markError(db:PgClient,id:string,raise=false):Promise<Row> {
  return (await db.query('select * from public.mark_order_refund_error($1,$2,$3)',[id,raise?'not_found_in_stripe':'stripe_rejected',raise])).rows[0];
}
async function returnFees(db:PgClient,f:Fx):Promise<Row> {
  return (await db.query('select fee_pending_deduction,fee_due_amount from public.order_returns where id=$1',[f.returnId])).rows[0];
}
async function deductionOf(db:PgClient,id:string):Promise<number> {
  return (await db.query('select return_fee_deduction from public.order_refunds where id=$1',[id])).rows[0].return_fee_deduction;
}

describeLocalDb('返品の受け取りと返金（移行 C）',getDb=>{
  const db=()=>getDb();
  beforeEach(async()=>{
    await db().query('begin');await db().query('delete from private.order_email_outbox');
    await db().query('update public.shop_return_settings set restocking_fee_enabled=true,exchange_fees_enabled=true,inspection_enabled=true');
    await db().query(`update public.shop_return_reason_settings set out_of_stock_exchange='decline' where reason='unknown'`);
  });
  afterEach(async()=>{await db().query('rollback');});
  test.each(['restocked','not_restocked','pending_inspection','sent_back'])('状態 %s の数と台帳を残す',async disposition=>{
    const f=await fixture(db());const r=await receive(db(),f,{disposition,choice:disposition==='sent_back'?'none':'consult',message:disposition==='sent_back'?'付属品をご確認ください。':null});
    expect((await db().query('select disposition,quantity from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows).toEqual([{disposition,quantity:1}]);
    expect(await variantStock(db(),f.variantId)).toBe(disposition==='restocked'?2:1);
    expect((await progress(db(),f)).refund_waiting).toBe(disposition==='sent_back'?0:1);
    expect(r.refund_id).toBeNull();
  });
  test('一部を検品待ちで受け取り、検品を終えて残りを受け取り、返金すると閉じる',async()=>{
    const f=await fixture(db(),{quantity:2});await receive(db(),f,{disposition:'pending_inspection'});
    expect(await progress(db(),f)).toMatchObject({unprocessed:1,pending_inspection:1});
    await db().query('select * from public.admin_inspect_return($1,$2,$3,$4::jsonb)',[f.returnId,f.actor,randomUUID(),JSON.stringify([{return_line_id:f.lineId,restocked:1,not_restocked:0}])]);
    await receive(db(),f,{disposition:'not_restocked'});const r=await refund(db(),f);await result(db(),r.refund_id,'succeeded');
    expect((await db().query('select status from public.order_returns where id=$1',[f.returnId])).rows[0].status).toBe('closed');
  });
  test.each([['stock',1,'stock'],['make',0,'backorder'],['stock',0,'backorder']])('交換 %s 在庫%s は %s の行を作り、発送後に shipped へ進む',async(method,stock,expected)=>{
    await db().query(`update public.shop_return_reason_settings set out_of_stock_exchange='make' where reason='unknown'`);
    const f=await fixture(db(),{exchange:true,method:String(method),stock:Number(stock)});
    const r=await receive(db(),f,{choice:'none',disposition:'not_restocked'});
    const line=(await db().query('select * from public.order_items where id=$1',[r.exchange_order_item_ids[0]])).rows[0];
    expect(line).toMatchObject({fulfillment_type:expected,item_price:0,line_total:0,line_kind:'exchange',exchange_return_line_id:f.lineId,exchange_paid_amount:PRICE});
    const actual=(await db().query('select resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows;
    expect(actual).toEqual([{resolution:'exchange',exchange_method:expected==='stock'?'stock':'make'}]);
    expect((await db().query('select exchange_method from public.order_return_lines where id=$1',[f.lineId])).rows[0].exchange_method).toBe(method);
    expect(await variantStock(db(),f.variantId)).toBe(0);
    expect((await db().query('select status,shipped_at,shipping_carrier,tracking_number from public.orders where id=$1',[f.orderId])).rows[0]).toEqual({status:'paid',shipped_at:null,shipping_carrier:null,tracking_number:null});
    expect(await revisionsOf(db(),f.orderId)).toContainEqual(expect.objectContaining({reason:'return_exchange_added',changedBy:f.actor}));
    if(expected==='backorder') await db().query('select * from public.admin_record_completion($1,$2,$3,$4::jsonb)',[f.orderId,f.actor,randomUUID(),JSON.stringify([{order_item_id:line.id,quantity:1}])]);
    await db().query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-2',false,$4::jsonb)`,[f.orderId,f.actor,randomUUID(),JSON.stringify([{order_item_id:line.id,quantity:1}])]);
    expect((await db().query('select status from public.orders where id=$1',[f.orderId])).rows[0].status).toBe('shipped');
  });
  test.each(['make','refund'])('在庫不足 decline は店長の %s だけ受ける',async action=>{
    const f=await fixture(db(),{exchange:true,stock:0});
    await fails(db(),()=>receive(db(),f,{choice:'none',disposition:'not_restocked'}),'RETURN_EXCHANGE_OUT_OF_STOCK');
    await fails(db(),()=>receive(db(),f,{can:false,overrides:[{return_line_id:f.lineId,action}]}),'RETURN_FORBIDDEN');
    const r=await receive(db(),f,{choice:action==='refund'?'consult':'none',disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action}]});
    expect(r.exchange_order_item_ids).toHaveLength(action==='make'?1:0);
    expect((await db().query('select resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows)
      .toEqual([{resolution:action==='refund'?'refund':'exchange',exchange_method:action==='make'?'make':null}]);
    expect((await db().query('select resolution,exchange_method from public.order_return_lines where id=$1',[f.lineId])).rows[0])
      .toEqual({resolution:'exchange',exchange_method:'stock'});
    expect((await progress(db(),f)).refund_waiting).toBe(action==='refund'?1:0);
  });
  test('通信切断の再送は元の返金番号を返し、在庫とメールも一度だけ（Review Focus 1）',async()=>{
    const f=await fixture(db());const key=randomUUID();const a=await receive(db(),f,{key,choice:'now'});
    expect(await receive(db(),f,{key,choice:'now'})).toMatchObject({receipt_id:a.receipt_id,refund_id:a.refund_id,replayed:true});
    await fails(db(),()=>receive(db(),f,{key,choice:'consult'}),'RETURN_REQUEST_MISMATCH');
    await result(db(),a.refund_id,'succeeded');expect((await receive(db(),f,{key,choice:'now'})).refund_status).toBe('succeeded');
    expect(await variantStock(db(),f.variantId)).toBe(2);
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1',[f.returnId])).rows[0].n).toBe(1);
    expect((await db().query('select kind,variant,return_id,return_receipt_id from private.order_email_outbox where order_id=$1',[f.orderId])).rows).toEqual([{kind:'refund',variant:'return',return_id:f.returnId,return_receipt_id:a.receipt_id}]);
  });
  test('交換の再送も同じ交換の行を返し、確保を増やさない',async()=>{
    const f=await fixture(db(),{exchange:true});const key=randomUUID();const a=await receive(db(),f,{key,choice:'none',disposition:'not_restocked'});
    expect((await receive(db(),f,{key,choice:'none',disposition:'not_restocked'})).exchange_order_item_ids).toEqual(a.exchange_order_item_ids);
    expect(await variantStock(db(),f.variantId)).toBe(0);
  });
  test('サポートは店への知らせを一度だけ作り、店長が額を直して返す（Review Focus 5）',async()=>{
    const f=await fixture(db());const key=randomUUID();
    await fails(db(),()=>receive(db(),f,{can:false,choice:'now'}),'RETURN_FORBIDDEN');
    await fails(db(),()=>receive(db(),f,{can:false,amount:1}),'RETURN_FORBIDDEN');
    expect((await receive(db(),f,{can:false,key})).shop_notice_enqueued).toBe(true);
    expect((await receive(db(),f,{can:false,key})).replayed).toBe(true);
    expect((await db().query(`select count(*)::int n from private.order_email_outbox where kind='return_refund_pending_shop' and return_id=$1`,[f.returnId])).rows[0].n).toBe(1);
    const r=await refund(db(),f,4000);await result(db(),r.refund_id,'succeeded');
    expect((await db().query('select kind,variant from private.order_email_outbox where refund_id=$1',[r.refund_id])).rows).toEqual([{kind:'refund',variant:'return'}]);
  });
  test('相談の手数料と額の上限を守り、返金の再送で二度引かない',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});await receive(db(),f);
    expect((await db().query('select fee_pending_deduction from public.order_returns where id=$1',[f.returnId])).rows[0].fee_pending_deduction).toBe(1100);
    await fails(db(),()=>refund(db(),f,5001),'RETURN_REFUND_AMOUNT_INVALID');
    const key=randomUUID();const r=await refund(db(),f,3800,key);expect(r.amount).toBe(3800);
    expect((await refund(db(),f,3800,key)).replayed).toBe(true);
    await fails(db(),()=>refund(db(),f,3799,key),'RETURN_REQUEST_MISMATCH');
    expect((await db().query('select fee_pending_deduction,fee_due_amount from public.order_returns where id=$1',[f.returnId])).rows[0]).toEqual({fee_pending_deduction:0,fee_due_amount:0});
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1',[r.refund_id])).rows[0].adjustment_amount).toBe(-1200);
  });
  test('今返金は返送料を最初だけ引き、部分受け取りの返品手数料は毎回計算する',async()=>{
    const f=await fixture(db(),{quantity:2,shippingFee:600,percent:10});const a=await receive(db(),f,{choice:'now'});
    expect(a.refund_amount).toBe(3900);await result(db(),a.refund_id,'succeeded');
    expect((await receive(db(),f,{choice:'now'})).refund_amount).toBe(4500);
  });
  test('返金なしの交換の手数料は支払い待ちで発送を止め、支払い記録後に送れる',async()=>{
    const f=await fixture(db(),{exchange:true,fee:600,shippingFee:400});const r=await receive(db(),f,{choice:'none',disposition:'not_restocked'});
    expect(r.fee_due_amount).toBe(1000);const lines=JSON.stringify([{order_item_id:r.exchange_order_item_ids[0],quantity:1}]);
    await fails(db(),()=>db().query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-3',false,$4::jsonb)`,[f.orderId,f.actor,randomUUID(),lines]),'FULFILLMENT_EXCHANGE_ON_HOLD');
    await db().query('select * from public.admin_record_return_fee_payment($1,$2,null,false)',[f.returnId,f.actor]);
    await db().query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-3',false,$4::jsonb)`,[f.orderId,f.actor,randomUUID(),lines]);
  });
  test('手数料をいただかないで終えた後、次の受け取りで新しい手数料が付くと免除と受領の印を外してお支払い待ちに戻る',async()=>{
    const f=await fixture(db(),{quantity:2,exchange:true,stock:0,shippingFee:6000,fee:600});
    // 最初の1点を返金に変え、商品5000円を超える返送料の1000円だけを免除する。残り1点はまだ受け取らない。
    const first=await receive(db(),f,{choice:'now',disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'refund'}]});
    expect(first).toMatchObject({return_status:'open',refund_id:null,refund_status:'waived',fee_due_amount:1000});
    await db().query('select * from public.admin_record_return_fee_payment($1,$2,null,_waive => true)',[f.returnId,f.actor]);
    const waived=(await db().query('select status,fee_due_amount,fee_settled_amount,fee_waived,fee_received_at,fee_received_by from public.order_returns where id=$1',[f.returnId])).rows[0];
    expect(waived).toMatchObject({status:'open',fee_due_amount:0,fee_settled_amount:1000,fee_waived:true,fee_received_by:f.actor});
    expect(waived.fee_received_at).toBeInstanceOf(Date);
    // 次の1点は作って送る交換にし、新たに付く600円は受領も免除もしていない状態に戻す。
    const second=await receive(db(),f,{choice:'none',disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'make'}]});
    expect(second).toMatchObject({return_status:'open',fee_due_amount:600});
    expect((await db().query('select status,fee_due_amount,fee_settled_amount,fee_waived,fee_received_at,fee_received_by,fee_received_note from public.order_returns where id=$1',[f.returnId])).rows[0])
      .toEqual({status:'open',fee_due_amount:600,fee_settled_amount:1000,fee_waived:false,fee_received_at:null,fee_received_by:null,fee_received_note:null});
    expect((await db().query('select * from private.return_display_state($1)',[f.returnId])).rows[0])
      .toEqual({display_status:'in_progress',marks:['awaiting_fee'],unprocessed:0,refund_waiting:0});
  });
  test('返金失敗で rw が戻るが closed を巻き戻さず、受け取りの在庫を動かさない',async()=>{
    const f=await fixture(db());const r=await receive(db(),f,{choice:'now'});expect(r.return_status).toBe('closed');
    await result(db(),r.refund_id,'pending');await result(db(),r.refund_id,'failed');expect((await progress(db(),f)).refund_waiting).toBe(1);
    expect((await db().query('select status from public.order_returns where id=$1',[f.returnId])).rows[0].status).toBe('closed');
    expect((await db().query('select private.refresh_order_return_status($1) status',[f.returnId])).rows[0].status).toBe('closed');
    expect((await db().query('select display_status,next_action,refund_waiting_returns from public.list_order_return_summaries($1::uuid[])',[[f.orderId]])).rows[0])
      .toEqual({display_status:'refund_waiting',next_action:'refund',refund_waiting_returns:1});
    expect(await variantStock(db(),f.variantId)).toBe(2);expect((await refund(db(),f)).status).toBe('awaiting_response');
  });
  test('届かない品を普通の返金で返した後、開き直して受け取っても二重に返さない（Review Focus 3）',async()=>{
    const f=await fixture(db());await db().query('select * from public.admin_close_return_missing($1,$2,$3)',[f.returnId,f.actor,randomUUID()]);
    const r=(await db().query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5)`,
      [f.orderId,randomUUID(),JSON.stringify([{order_item_id:f.itemId,before_shipment:false,quantity:1}]),PRICE,f.actor])).rows[0];
    await result(db(),r.refund_id,'succeeded');await db().query('select * from public.admin_reopen_return($1,$2,$3)',[f.returnId,f.actor,randomUUID()]);
    expect((await receive(db(),f,{choice:'now'})).refund_id).toBeNull();expect((await progress(db(),f)).refund_waiting).toBe(0);
  });
  test.each([{choice:'now',can:true},{choice:'consult',can:false}])('2点のうち届かない1点を普通の返金で覆った後は、開き直して %j で受け取っても返金と相談の手数料と店への知らせを増やさない（I-1 A）',async options=>{
    const f=await fixture(db(),{quantity:2,returnQuantity:1,shippingFee:600,percent:10});
    await db().query('select * from public.admin_close_return_missing($1,$2,$3)',[f.returnId,f.actor,randomUUID()]);
    const ordinary=await ordinaryRefund(db(),f);await result(db(),ordinary.refund_id,'succeeded');
    await db().query('select * from public.admin_reopen_return($1,$2,$3)',[f.returnId,f.actor,randomUUID()]);
    const key=randomUUID();const received=await receive(db(),f,{...options,key});
    expect(received).toMatchObject({return_status:'closed',refund_id:null,refund_amount:null,refund_status:null,shop_notice_enqueued:false,fee_due_amount:0});
    expect(await receive(db(),f,{...options,key})).toMatchObject({receipt_id:received.receipt_id,refund_id:null,refund_amount:null,refund_status:null,replayed:true});
    expect((await progress(db(),f)).refund_waiting).toBe(0);
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:0,fee_due_amount:0});
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(1);
    expect((await db().query("select count(*)::int n from private.order_email_outbox where return_id=$1 and kind='return_refund_pending_shop'",[f.returnId])).rows[0].n).toBe(0);
  });
  test('1点目を返金しないで終え、普通の返金で1点を覆った後は2点目を今返金で受け取っても返金を作らない（I-1 B）',async()=>{
    const f=await fixture(db(),{quantity:2,percent:100});
    expect(await receive(db(),f,{choice:'now'})).toMatchObject({refund_id:null,refund_status:'waived'});
    const ordinary=await ordinaryRefund(db(),f);await result(db(),ordinary.refund_id,'succeeded');
    const received=await receive(db(),f,{choice:'now'});
    expect(received).toMatchObject({return_status:'closed',refund_id:null,refund_amount:null,refund_status:null});
    expect(await progress(db(),f)).toMatchObject({unprocessed:0,refund_waiting:0,refund_waived:1});
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(1);
    expect((await db().query("select count(*)::int n from public.order_return_receipt_lines where receipt_id=$1 and disposition='refund_waived'",[received.receipt_id])).rows[0].n).toBe(0);
  });
  test('決着後に額を決めて返金で引けない新しい手数料が付くと、決着済みを含めず免除と受領を戻す（M-2・I-2）',async()=>{
    const f=await fixture(db(),{quantity:3,shippingFee:6000,percent:100});
    expect(await receive(db(),f,{choice:'now'})).toMatchObject({refund_status:'waived',fee_due_amount:6000});
    await db().query('select * from public.admin_record_return_fee_payment($1,$2,null,true)',[f.returnId,f.actor]);
    await receive(db(),f,{choice:'consult',quantity:2});
    // 相談の2点の手数料10000円のうち、普通の返金が1点を覆うので、残る商品5000円から引けない分だけが新しい未収額になる。
    const ordinary=await ordinaryRefund(db(),f);await result(db(),ordinary.refund_id,'succeeded');
    const key=randomUUID();expect(await refund(db(),f,null,key)).toMatchObject({refund_id:null,amount:0,status:'waived'});
    expect((await refund(db(),f,null,key)).replayed).toBe(true);
    expect((await db().query('select status,fee_due_amount,fee_settled_amount,fee_pending_deduction,fee_waived,fee_received_at,fee_received_by,fee_received_note from public.order_returns where id=$1',[f.returnId])).rows[0])
      .toEqual({status:'open',fee_due_amount:5000,fee_settled_amount:6000,fee_pending_deduction:0,fee_waived:false,fee_received_at:null,fee_received_by:null,fee_received_note:null});
    expect((await db().query('select * from private.return_display_state($1)',[f.returnId])).rows[0])
      .toEqual({display_status:'in_progress',marks:['awaiting_fee'],unprocessed:0,refund_waiting:0});
    await db().query('select * from public.admin_record_return_fee_payment($1,$2,null,false)',[f.returnId,f.actor]);
    expect((await db().query('select status,fee_due_amount,fee_settled_amount from public.order_returns where id=$1',[f.returnId])).rows[0])
      .toEqual({status:'closed',fee_due_amount:0,fee_settled_amount:11000});
  });
  test('お返しと相談の返金待ちの品がある返品は、普通の返金で覆った時に自動で完了し、結果とエラーの後も数を確かめ直す（M-3）',async()=>{
    const f=await fixture(db(),{quantity:2});
    await receive(db(),f,{choice:'consult',message:'ご確認ください。',units:[
      {return_line_id:f.lineId,disposition:'sent_back',quantity:1},{return_line_id:f.lineId,disposition:'not_restocked',quantity:1},
    ]});
    expect((await progress(db(),f)).refund_waiting).toBe(1);
    const ordinary=await ordinaryRefund(db(),f);
    expect((await db().query('select status from public.order_returns where id=$1',[f.returnId])).rows[0].status).toBe('closed');
    // 以前の処理で受付中のまま残った返品も、結果を書く入口が完了を確かめ直す。
    await db().query("update public.order_returns set status='open',closed_at=null where id=$1",[f.returnId]);
    await result(db(),ordinary.refund_id,'succeeded');
    expect((await db().query('select status from public.order_returns where id=$1',[f.returnId])).rows[0].status).toBe('closed');
    // 行のない額だけの返金をエラーにしても、成功した普通の返金の覆いは残る。エラーの入口も以前の受付中を完了にする。
    const adjustment=(await db().query(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1,null,'requested_by_customer',null,false,$3)`,
      [f.orderId,randomUUID(),f.actor])).rows[0];
    await db().query("update public.order_returns set status='open',closed_at=null where id=$1",[f.returnId]);
    await markError(db(),adjustment.refund_id);
    expect((await progress(db(),f)).refund_waiting).toBe(0);
    expect((await db().query('select status from public.order_returns where id=$1',[f.returnId])).rows[0].status).toBe('closed');
  });
  test('1回の受け取りで交換予定2点のうち1点だけ返金へ上書きし、返品行は分割も更新もしない',async()=>{
    const f=await fixture(db(),{quantity:2,exchange:true,stock:0});
    const before=(await db().query('select to_jsonb(l) value from public.order_return_lines l where id=$1',[f.lineId])).rows[0].value;
    const r=await receive(db(),f,{choice:'consult',disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'refund'}]});
    expect((await db().query('select to_jsonb(l) value from public.order_return_lines l where return_id=$1',[f.returnId])).rows).toEqual([{value:before}]);
    const units=(await db().query('select id,return_line_id,quantity,resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows;
    expect(units).toEqual([{id:expect.any(String),return_line_id:f.lineId,quantity:1,resolution:'refund',exchange_method:null}]);
    expect(await progress(db(),f)).toMatchObject({unprocessed:1,exchanged:0,refund_waiting:1});
    expect((await refund(db(),f)).amount).toBe(5000);
  });
  test.each([100,120])('返品手数料%s%%相当で受け取りの返金が0円なら同じ受け取りに refund_waived を追記する（P20）',async ratio=>{
    // 100%は返品手数料、120%相当は商品の額を超える定額の返送料で再現する。
    const f=await fixture(db(),ratio===100?{percent:100,paymentIntent:null}:{shippingFee:6000,paymentIntent:null});
    const key=randomUUID();
    await fails(db(),()=>receive(db(),f,{can:false,choice:'now',key}),'RETURN_FORBIDDEN');
    const r=await receive(db(),f,{choice:'now',key});
    expect(r).toMatchObject({refund_id:null,refund_amount:0,refund_status:'waived',fee_due_amount:ratio===100?0:1000});
    expect((await receive(db(),f,{choice:'now',key}))).toMatchObject({receipt_id:r.receipt_id,refund_id:null,refund_amount:0,refund_status:'waived',replayed:true});
    expect(await progress(db(),f)).toMatchObject({processed:1,unprocessed:0,refund_waived:1,refund_waiting:0});
    expect((await db().query('select disposition,quantity,resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1 order by disposition',[r.receipt_id])).rows)
      .toEqual([{disposition:'refund_waived',quantity:1,resolution:null,exchange_method:null},{disposition:'restocked',quantity:1,resolution:'refund',exchange_method:null}]);
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect((await db().query('select kind from private.order_email_outbox where order_id=$1',[f.orderId])).rows).toEqual([{kind:'return_received'}]);
    expect(await variantStock(db(),f.variantId)).toBe(2);
    await fails(db(),()=>receive(db(),f,{choice:'consult',key}),'RETURN_REQUEST_MISMATCH');
  });
  test('額を決めて0円で終える時は waive_refund を作り、返金とメールを作らず再送は同じ結果になる（P20）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10,paymentIntent:null});
    await receive(db(),f,{notify:false});const key=randomUUID();
    expect(await refund(db(),f,0,key)).toEqual({refund_id:null,amount:0,status:'waived',replayed:false});
    expect(await refund(db(),f,0,key)).toEqual({refund_id:null,amount:0,status:'waived',replayed:true});
    await fails(db(),()=>refund(db(),f,1,key),'RETURN_REQUEST_MISMATCH');
    const receipt=(await db().query('select id,kind,refund_choice,refund_id,actor_can_refund from public.order_return_receipts where request_key=$1',[key])).rows[0];
    expect(receipt).toMatchObject({kind:'waive_refund',refund_choice:null,refund_id:null,actor_can_refund:true});
    expect((await db().query('select disposition,quantity,resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[receipt.id])).rows)
      .toEqual([{disposition:'refund_waived',quantity:1,resolution:null,exchange_method:null}]);
    expect(await progress(db(),f)).toMatchObject({refund_waived:1,refund_waiting:0});
    expect((await db().query('select status,fee_pending_deduction,fee_due_amount from public.order_returns where id=$1',[f.returnId])).rows[0])
      .toEqual({status:'closed',fee_pending_deduction:0,fee_due_amount:0});
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int n from private.order_email_outbox where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect(await variantStock(db(),f.variantId)).toBe(2);
  });
  test('相談の手数料が商品を超え、計算どおりが0円でも単独の返金を作らず超過だけ支払い待ちにする',async()=>{
    const f=await fixture(db(),{shippingFee:6000});await receive(db(),f,{notify:false});
    expect(await refund(db(),f)).toMatchObject({refund_id:null,amount:0,status:'waived'});
    expect((await db().query('select fee_pending_deduction,fee_due_amount from public.order_returns where id=$1',[f.returnId])).rows[0])
      .toEqual({fee_pending_deduction:0,fee_due_amount:1000});
    expect((await progress(db(),f)).refund_waiting).toBe(0);
  });
  test.each([{paymentIntent:null},{paymentIntent:'cs_fixture'},{paid:null}])('非0円の今返金は Stripe で返せない注文%jの受け取りを残さない',async options=>{
    const f=await fixture(db(),options);
    await fails(db(),()=>receive(db(),f,{choice:'now'}),'ORDER_NOT_REFUNDABLE');
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1',[f.returnId])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect((await db().query("select count(*)::int n from public.stock_movements where return_id=$1",[f.returnId])).rows[0].n).toBe(0);
    expect(await variantStock(db(),f.variantId)).toBe(1);
    expect((await receive(db(),f,{choice:'consult'})).refund_id).toBeNull();
  });
  test('今返金の額の上限と AWAITING_REFUND_EXISTS は受け取り全体を戻す',async()=>{
    const f=await fixture(db(),{quantity:2});
    await fails(db(),()=>receive(db(),f,{choice:'now',amount:10001}),'RETURN_REFUND_AMOUNT_INVALID');
    await receive(db(),f,{choice:'now'});
    await fails(db(),()=>receive(db(),f,{choice:'now'}),'AWAITING_REFUND_EXISTS');
    expect((await progress(db(),f)).unprocessed).toBe(1);
    expect(await variantStock(db(),f.variantId)).toBe(2);
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1',[f.returnId])).rows[0].n).toBe(1);
  });
  test('お返しだけの受け取りに返送料を付けず、交換の手数料は最初の交換だけ付ける',async()=>{
    const sent=await fixture(db(),{shippingFee:600});
    expect((await receive(db(),sent,{choice:'none',disposition:'sent_back',message:'ご確認ください。'})).fee_due_amount).toBe(0);
    const f=await fixture(db(),{quantity:2,exchange:true,method:'make',stock:0,fee:300,shippingFee:400});
    expect((await receive(db(),f,{choice:'none',disposition:'not_restocked'})).fee_due_amount).toBe(700);
    expect((await receive(db(),f,{choice:'none',disposition:'not_restocked'})).fee_due_amount).toBe(700);
  });
  test('返金の品が無ければ単独の返金は RETURN_NOTHING_TO_REFUND',async()=>{
    const f=await fixture(db());await fails(db(),()=>refund(db(),f),'RETURN_NOTHING_TO_REFUND');
  });
  test('お返しの文と数と空の配列と検品設定を守り、エラーの受け取りを残さない',async()=>{
    const f=await fixture(db());await fails(db(),()=>receive(db(),f,{disposition:'sent_back',choice:'none'}),'RETURN_SENT_BACK_MESSAGE_REQUIRED');
    await fails(db(),()=>receive(db(),f,{disposition:'sent_back',choice:'none',message:'ご確認ください。',notify:false}),'RETURN_ARGUMENT_INVALID');
    await fails(db(),()=>receive(db(),f,{quantity:2}),'RETURN_RECEIPT_EXCEEDS');await fails(db(),()=>receive(db(),f,{units:[]}),'RETURN_ARGUMENT_INVALID');
    await db().query('update public.shop_return_settings set inspection_enabled=false');
    await fails(db(),()=>receive(db(),f,{disposition:'pending_inspection'}),'RETURN_ARGUMENT_INVALID');
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=$1',[f.returnId])).rows[0].n).toBe(0);
  });
  test('額を決めて返金と今返金は、計算どおりを超えても返せる額（E-2 の値）までは直せて、差を adjustment_amount に残す（仕様書 6-3・P8）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});await receive(db(),f);
    // 計算どおりは 5000 − 1100 = 3900。返せる額は 5000
    const r=await refund(db(),f,4500);
    expect(r).toMatchObject({amount:4500,status:'awaiting_response'});
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1',[r.refund_id])).rows[0].adjustment_amount).toBe(-500);
    const g=await fixture(db(),{quantity:2});
    await fails(db(),()=>receive(db(),g,{choice:'now',amount:10001}),'RETURN_REFUND_AMOUNT_INVALID');
    const a=await receive(db(),g,{choice:'now',amount:6000});
    expect(a).toMatchObject({refund_amount:6000,refund_status:'awaiting_response'});
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1',[a.refund_id])).rows[0].adjustment_amount).toBe(1000);
  });

  test('理由の設定が make の在庫不足の行は、店長だけが返金に変えられ、make の上書きと在庫が足りる行の上書きは受けない（C-1・仕様書 6-5）',async()=>{
    await db().query(`update public.shop_return_reason_settings set out_of_stock_exchange='make' where reason='unknown'`);
    const f=await fixture(db(),{exchange:true,stock:0});
    await fails(db(),()=>receive(db(),f,{disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'make'}]}),'RETURN_ARGUMENT_INVALID');
    await fails(db(),()=>receive(db(),f,{can:false,disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'refund'}]}),'RETURN_FORBIDDEN');
    const r=await receive(db(),f,{choice:'now',disposition:'not_restocked',overrides:[{return_line_id:f.lineId,action:'refund'}]});
    expect(r).toMatchObject({refund_amount:PRICE,refund_status:'awaiting_response',exchange_order_item_ids:[]});
    expect((await db().query('select resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows)
      .toEqual([{resolution:'refund',exchange_method:null}]);
    expect((await db().query('select resolution,exchange_method from public.order_return_lines where id=$1',[f.lineId])).rows[0])
      .toEqual({resolution:'exchange',exchange_method:'stock'});
    const enough=await fixture(db(),{exchange:true,stock:1});
    await fails(db(),()=>receive(db(),enough,{disposition:'not_restocked',overrides:[{return_line_id:enough.lineId,action:'refund'}]}),'RETURN_ARGUMENT_INVALID');
  });
  test('同じ色・サイズへの交換が2行ある時は、行の並び（list_order_returns の lines の順）で在庫を前から割り当て、足りない後ろの行だけが在庫不足になる',async()=>{
    const f=await twoExchangeLines(db(),1);
    const units=[{return_line_id:f.lineId,disposition:'not_restocked',quantity:1},{return_line_id:f.secondLineId,disposition:'not_restocked',quantity:1}];
    await fails(db(),()=>receive(db(),f,{choice:'none',units}),'RETURN_EXCHANGE_OUT_OF_STOCK');
    // 前の行は在庫が足りるので、上書きは受けない
    await fails(db(),()=>receive(db(),f,{choice:'none',units,overrides:[{return_line_id:f.lineId,action:'make'}]}),'RETURN_ARGUMENT_INVALID');
    const r=await receive(db(),f,{choice:'none',units,overrides:[{return_line_id:f.secondLineId,action:'make'}]});
    const rows=(await db().query('select return_line_id,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[r.receipt_id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([{return_line_id:f.lineId,exchange_method:'stock'},{return_line_id:f.secondLineId,exchange_method:'make'}]));
    expect(await variantStock(db(),f.variantId)).toBe(0);
  });
  test('同じ色・サイズの2行で後ろの行を返金に変えると、前の行は在庫から送り後ろの行は返金の品になる。make の理由なら上書きなしで後ろの行を作って送る',async()=>{
    const f=await twoExchangeLines(db(),1);
    const units=[{return_line_id:f.lineId,disposition:'not_restocked',quantity:1},{return_line_id:f.secondLineId,disposition:'not_restocked',quantity:1}];
    const r=await receive(db(),f,{choice:'consult',units,overrides:[{return_line_id:f.secondLineId,action:'refund'}]});
    expect((await db().query('select return_line_id,resolution,exchange_method from public.order_return_receipt_lines where receipt_id=$1 order by resolution',[r.receipt_id])).rows)
      .toEqual([{return_line_id:f.lineId,resolution:'exchange',exchange_method:'stock'},{return_line_id:f.secondLineId,resolution:'refund',exchange_method:null}]);
    expect(r.exchange_order_item_ids).toHaveLength(1);
    expect((await db().query('select sum(refund_waiting)::int n from private.order_return_line_progress($1)',[f.returnId])).rows[0].n).toBe(1);
    await db().query(`update public.shop_return_reason_settings set out_of_stock_exchange='make' where reason='unknown'`);
    const g=await twoExchangeLines(db(),1);
    const units2=[{return_line_id:g.lineId,disposition:'not_restocked',quantity:1},{return_line_id:g.secondLineId,disposition:'not_restocked',quantity:1}];
    const s=await receive(db(),g,{choice:'none',units:units2});
    expect((await db().query('select return_line_id,exchange_method from public.order_return_receipt_lines where receipt_id=$1',[s.receipt_id])).rows)
      .toEqual(expect.arrayContaining([{return_line_id:g.lineId,exchange_method:'stock'},{return_line_id:g.secondLineId,exchange_method:'make'}]));
  });

  test('今返金のエラー・返し直しの失敗と2回続いても、その返金で引いた手数料を fee_pending_deduction に戻し、計算どおりで引き直す（P26）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});
    const a=await receive(db(),f,{choice:'now'});
    expect(a.refund_amount).toBe(3900);expect(await deductionOf(db(),a.refund_id)).toBe(1100);
    await markError(db(),a.refund_id);
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:1100,fee_due_amount:0});
    const first=await refund(db(),f);
    expect(first).toMatchObject({amount:3900,status:'awaiting_response'});expect(await deductionOf(db(),first.refund_id)).toBe(1100);
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:0,fee_due_amount:0});
    await result(db(),first.refund_id,'pending');await result(db(),first.refund_id,'failed');
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:1100,fee_due_amount:0});
    const second=await refund(db(),f);
    expect(second).toMatchObject({amount:3900,status:'awaiting_response'});
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:0,fee_due_amount:0});
  });
  test('エラーにした今返金が後で Stripe に見つかったら、戻した手数料を引き直し、返金待ちも無くなる（P26）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});
    const a=await receive(db(),f,{choice:'now'});
    await markError(db(),a.refund_id);
    expect((await returnFees(db(),f)).fee_pending_deduction).toBe(1100);
    await result(db(),a.refund_id,'succeeded');
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:0,fee_due_amount:0});
    expect((await progress(db(),f)).refund_waiting).toBe(0);
  });
  test('相談の受け取りの手数料を引いた額を決めて返金が失敗すると、引いた手数料が戻り、返し直しの計算どおりで引く（P26）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});await receive(db(),f);
    const r=await refund(db(),f,3800);expect(await deductionOf(db(),r.refund_id)).toBe(1100);
    await result(db(),r.refund_id,'failed');
    expect(await returnFees(db(),f)).toEqual({fee_pending_deduction:1100,fee_due_amount:0});
    expect((await refund(db(),f)).amount).toBe(3900);
    expect((await returnFees(db(),f)).fee_due_amount).toBe(0);
  });

  test.each([false,true])('今返金の断り・見回り（要対応 %s）は、知らせる受け取りの return_received を1通だけ予定する（P25）',async raise=>{
    const f=await fixture(db());const a=await receive(db(),f,{choice:'now'});
    expect((await db().query('select count(*)::int n from private.order_email_outbox where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect((await markError(db(),a.refund_id,raise)).outcome).toBe('errored');
    expect((await markError(db(),a.refund_id)).outcome).toBe('not_awaiting');
    expect((await db().query('select kind,return_id,return_receipt_id,refund_id from private.order_email_outbox where order_id=$1',[f.orderId])).rows)
      .toEqual([{kind:'return_received',return_id:f.returnId,return_receipt_id:a.receipt_id,refund_id:null}]);
    const mail=(await db().query('select * from public.claim_order_email(60)')).rows[0];
    await fails(db(),()=>db().query("select public.skip_order_email($1,$2,'superseded')",[mail.email_id,mail.lease_token]),'SUPERSEDE_NOT_ALLOWED');
    // 見回りの道（要対応を作る）も同じ関数。「お客様に知らせる」を外した受け取りは予定しない
    const quiet=await fixture(db());const b=await receive(db(),quiet,{choice:'now',notify:false});
    expect((await markError(db(),b.refund_id,true)).exception_id).not.toBeNull();
    expect((await db().query('select count(*)::int n from private.order_email_outbox where order_id=$1',[quiet.orderId])).rows[0].n).toBe(0);
  });
  test('作ったその場で失敗した今返金（受け付けられていない）も予定し、メールの予定を書いたと答える',async()=>{
    const f=await fixture(db());const a=await receive(db(),f,{choice:'now'});
    expect((await result(db(),a.refund_id,'failed')).email_enqueued).toBe(true);
    expect((await db().query('select kind,return_receipt_id from private.order_email_outbox where order_id=$1',[f.orderId])).rows)
      .toEqual([{kind:'return_received',return_receipt_id:a.receipt_id}]);
  });
  test('受け付けられた後の失敗と、額を決めて返金のエラーでは return_received を足さない（P25）',async()=>{
    const f=await fixture(db());const a=await receive(db(),f,{choice:'now'});
    await result(db(),a.refund_id,'succeeded');await result(db(),a.refund_id,'failed');
    expect((await db().query('select kind,variant from private.order_email_outbox where order_id=$1 order by seq',[f.orderId])).rows)
      .toEqual([{kind:'refund',variant:'return'}]);
    const g=await fixture(db());await receive(db(),g,{notify:false});const r=await refund(db(),g);
    await markError(db(),r.refund_id);
    expect((await db().query('select count(*)::int n from private.order_email_outbox where order_id=$1',[g.orderId])).rows[0].n).toBe(0);
  });

  test('お返しだけの受け取りは「最初の受け取り」を使わず、次の返金の品の受け取りで返送料を引く',async()=>{
    const f=await fixture(db(),{quantity:2,shippingFee:600});
    await receive(db(),f,{choice:'none',disposition:'sent_back',message:'ご確認ください。'});
    expect((await receive(db(),f,{choice:'now'})).refund_amount).toBe(4400);
  });

  test('交換の品の行の番号は RFC 9562 の形（版4・変種8）で、窓口の z.string().uuid() を通る',async()=>{
    const f=await fixture(db(),{exchange:true});const r=await receive(db(),f,{choice:'none',disposition:'not_restocked'});
    expect(r.exchange_order_item_ids).toHaveLength(1);
    expect(r.exchange_order_item_ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(z.string().uuid().safeParse(r.exchange_order_item_ids[0]).success).toBe(true);
  });
  test('同じ注文の別返品の行は、受け取りも交換の選び直しも断り、記録・在庫・メールを変えない（07-7）',async()=>{
    const f=await fixture(db(),{quantity:2,returnQuantity:1,exchange:true,stock:0});
    const ship=(await db().query('select fulfillment_id from public.order_return_lines where id=$1',[f.lineId])).rows[0].fulfillment_id;
    const ret=(await db().query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,
      'customer_ships','customer',null,null,0,0,0,0,null,false)`,
      [f.orderId,f.actor,randomUUID(),JSON.stringify([{fulfillment_id:ship,order_item_id:f.itemId,quantity:1,
        reason:'unknown',reason_note:null,resolution:'exchange',exchange_variant_id:f.variantId,exchange_method:'stock'}])])).rows[0];
    const other=(await db().query('select id from public.order_return_lines where return_id=$1',[ret.return_id])).rows[0].id;
    expect(ret.return_id).not.toBe(f.returnId);
    await fails(db(),()=>receive(db(),f,{units:[{return_line_id:other,disposition:'restocked',quantity:1}]}),'RETURN_ARGUMENT_INVALID');
    await fails(db(),()=>receive(db(),f,{choice:'none',disposition:'not_restocked',overrides:[{return_line_id:other,action:'make'}]}),'RETURN_ARGUMENT_INVALID');
    expect((await db().query('select count(*)::int n from public.order_return_receipts where return_id=any($1::uuid[])',[[f.returnId,ret.return_id]])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int n from public.stock_movements where return_id=any($1::uuid[])',[[f.returnId,ret.return_id]])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int n from private.order_email_outbox where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
    expect(await variantStock(db(),f.variantId)).toBe(0);
  });
  test('店への返金待ちの知らせは、その返品の返金待ちが0になった時だけ superseded にできる（06-5）',async()=>{
    const f=await fixture(db());await receive(db(),f,{can:false,notify:false});
    const mail=(await db().query('select * from public.claim_order_email(60)')).rows[0];
    expect(mail.kind).toBe('return_refund_pending_shop');
    await fails(db(),()=>db().query("select public.skip_order_email($1,$2,'superseded')",[mail.email_id,mail.lease_token]),'SUPERSEDE_NOT_ALLOWED');
    const other=await fixture(db());await receive(db(),other,{notify:false});
    expect((await progress(db(),other)).refund_waiting).toBe(1);
    await refund(db(),f);expect((await progress(db(),f)).refund_waiting).toBe(0);
    expect((await db().query("select public.skip_order_email($1,$2,'superseded') skipped",[mail.email_id,mail.lease_token])).rows[0].skipped).toBe(true);
    expect((await db().query('select status,last_error_code from private.order_email_outbox where id=$1',[mail.email_id])).rows[0])
      .toEqual({status:'skipped',last_error_code:'superseded'});
  });
  test.each(['return_accepted','return_received','return_sent_back'])('ほかの返品のメール %s は返金待ちが0でも superseded にできない（06-5）',async kind=>{
    const f=await fixture(db());const r=await receive(db(),f,{notify:false});
    await refund(db(),f);expect((await progress(db(),f)).refund_waiting).toBe(0);
    await db().query('select private.enqueue_return_email($1,$2,$3,$4)',[f.orderId,kind,f.returnId,kind==='return_accepted'?null:r.receipt_id]);
    const mail=(await db().query('select * from public.claim_order_email(60)')).rows[0];
    expect(mail.kind).toBe(kind);
    await fails(db(),()=>db().query("select public.skip_order_email($1,$2,'superseded')",[mail.email_id,mail.lease_token]),'SUPERSEDE_NOT_ALLOWED');
  });
  test('この受け取りで同じ色・サイズを在庫に戻す数は、交換の在庫不足の判定に入れない（03-2）',async()=>{
    const f=await fixture(db(),{exchange:true,stock:0});
    await fails(db(),()=>receive(db(),f,{choice:'none',disposition:'restocked'}),'RETURN_EXCHANGE_OUT_OF_STOCK');
    const r=await receive(db(),f,{choice:'none',disposition:'restocked',overrides:[{return_line_id:f.lineId,action:'make'}]});
    expect((await db().query('select fulfillment_type from public.order_items where id=$1',[r.exchange_order_item_ids[0]])).rows[0].fulfillment_type).toBe('backorder');
    expect(await variantStock(db(),f.variantId)).toBe(1);
  });
  test('同じ商品の返金を2行に分けて受け取っても数を合算して1回計算し、Task 2 の商品ごとの見込みと同じ額になる（03-7・04-1・02-2）',async()=>{
    const f=await twoExchangeLines(db(),0,1);
    // 2点・割引1円。2行それぞれの1点の値を足すと9998円になるが、商品ごとに2点で出すと9999円。
    const detail=(await db().query('select public.list_order_returns($1) returns',[f.orderId])).rows[0].returns[0];
    expect(detail.lines.map((l:Row)=>l.refund_amounts_by_count)).toEqual([[4999,9999],[4999,9999]]);
    const units=[{return_line_id:f.lineId,disposition:'not_restocked',quantity:1},{return_line_id:f.secondLineId,disposition:'not_restocked',quantity:1}];
    const r=await receive(db(),f,{choice:'now',units,overrides:[{return_line_id:f.lineId,action:'refund'},{return_line_id:f.secondLineId,action:'refund'}]});
    expect(r.refund_amount).toBe(9999);
    expect((await db().query('select quantity,amount from public.order_refund_lines where refund_id=$1',[r.refund_id])).rows).toEqual([{quantity:2,amount:9999}]);
  });
  test('エラーの後の保留・成功と結果の再送では手数料を一度だけ引き直し、返し直し済みでも0未満にしない（P26）',async()=>{
    const f=await fixture(db(),{shippingFee:600,percent:10});const a=await receive(db(),f,{choice:'now'});
    await markError(db(),a.refund_id);await markError(db(),a.refund_id);
    expect((await returnFees(db(),f)).fee_pending_deduction).toBe(1100);
    await result(db(),a.refund_id,'pending');await result(db(),a.refund_id,'pending');await result(db(),a.refund_id,'succeeded');
    expect((await returnFees(db(),f)).fee_pending_deduction).toBe(0);
    await result(db(),a.refund_id,'failed');await result(db(),a.refund_id,'failed');
    expect((await returnFees(db(),f)).fee_pending_deduction).toBe(1100);
    const g=await fixture(db(),{shippingFee:600,percent:10});const b=await receive(db(),g,{choice:'now'});
    await markError(db(),b.refund_id);await refund(db(),g);
    await result(db(),b.refund_id,'pending');
    expect((await returnFees(db(),g)).fee_pending_deduction).toBe(0);
  });
  test.each(['return','admin'])('return_fee_deduction を省いた %s の直接 INSERT は既定の0になり、既存の試験の入力をそのまま通す（P26）',async source=>{
    const f=await fixture(db());
    const row=(await db().query(`insert into public.order_refunds
      (order_id,source,return_id,request_key,request_fingerprint,status,amount,notify_customer)
      values($1,$2,$3,gen_random_uuid(),'fixture','awaiting_response',1,false)
      returning id,return_fee_deduction`,[f.orderId,source,source==='return'?f.returnId:null])).rows[0];
    expect(row.return_fee_deduction).toBe(0);
    await markError(db(),row.id);
    expect((await returnFees(db(),f)).fee_pending_deduction).toBe(0);
  });
  test('return_fee_deduction の列は非負CHECKとNOT NULLで守り、source と結ぶCHECKは作らない（P26）',async()=>{
    const f=await fixture(db());
    const sql=`insert into public.order_refunds
      (order_id,source,return_id,request_key,request_fingerprint,status,amount,notify_customer,return_fee_deduction)
      values($1,'return',$2,gen_random_uuid(),'fixture','awaiting_response',1,false,$3)`;
    for(const [value,expected] of [
      [-1,{code:'23514',constraint:'order_refunds_return_fee_deduction_check'}],
      [null,{code:'23502',column:'return_fee_deduction'}],
    ] as const) {
      await db().query('savepoint fee_column_error');
      try {await expect(db().query(sql,[f.orderId,f.returnId,value])).rejects.toMatchObject(expected);}
      finally {await db().query('rollback to savepoint fee_column_error');}
    }
    expect((await db().query(`select count(*)::int n from pg_catalog.pg_constraint
      where conrelid='public.order_refunds'::regclass and conname='order_refunds_return_fee_check'`)).rows[0].n).toBe(0);
  });
  test('core は返品の手数料のNULL・負を断り、ほかの道の手数料はNULLだけ受ける（P26）',async()=>{
    const f=await fixture(db());
    for(const [source,fee] of [['return',null],['return',-1],['admin',-1],['admin',0],['admin',1]] as const) {
      await fails(db(),()=>db().query(`select * from private.begin_order_refund_core(
        $1,$2,$3,'[]'::jsonb,false,0,1,null,null,null,false,$4,null,$5,$6)`,
        [f.orderId,source,randomUUID(),f.actor,source==='return'?f.returnId:null,fee]),'REFUND_ARGUMENT_INVALID');
    }
    // 返品の0以上の値は既存の今返金・額を決めて返金の試験、ほかの道のNULL→記録0はStep 1bで確かめる。
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
  });
  test('private の内部関数は元のE-2と同じSECURITY INVOKERで、直接の実行権限を増やさない（03-8）',async()=>{
    const names=['order_line_discounts','return_units_amount','begin_order_refund_core','enqueue_order_email',
      'apply_order_refund_state','apply_return_refund_outcome','return_exchange_item_id'];
    const rows=(await db().query(`select p.proname,p.prosecdef from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname=any($1::text[]) order by p.proname`,[names])).rows;
    expect(rows.map((r:Row)=>r.proname)).toEqual([...names].sort());
    expect(rows.every((r:Row)=>r.prosecdef===false)).toBe(true);
    for(const signature of ['private.apply_return_refund_outcome(uuid,text)','private.return_exchange_item_id(uuid,uuid,text)']) {
      for(const role of ['anon','authenticated','service_role']) {
        expect((await db().query("select has_function_privilege($1,$2,'execute') allowed",[role,signature])).rows[0].allowed).toBe(false);
      }
    }
  });
});
describeLocalDb('最後の1点の購入と受け取りの競合（Review Focus 2）',getDb=>{
  test.each(['make','decline'])('購入が先に1点を確保した時 %s の設定を守る',async policy=>{
    const setup=getDb();
    // この試験は確定した行を使う。変える設定を先に読み、最後に戻す（同じ実行で後に動く試験が、設定の最初の値を見るため）
    const saved=(await setup.query(`select return_address_name,return_address_postal_code,return_address_line,return_address_phone,
      restocking_fee_enabled,exchange_fees_enabled,inspection_enabled from public.shop_return_settings where id=1`)).rows[0];
    const savedPolicy=(await setup.query(`select out_of_stock_exchange from public.shop_return_reason_settings where reason='unknown'`)).rows[0].out_of_stock_exchange;
    const purchase=await connectLocalDb();const receipt=await connectLocalDb();
    try {
      await setup.query('begin');const f=await fixture(setup,{exchange:true,stock:1});
      await setup.query(`update public.shop_return_reason_settings set out_of_stock_exchange=$1 where reason='unknown'`,[policy]);await setup.query('commit');
      await purchase.query('begin');await receipt.query('begin');
      await purchase.query('select id from public.item_variants where id=$1 for update',[f.variantId]);
      await purchase.query(`insert into public.stock_movements(variant_id,delta,reason,note) values($1,-1,'purchase','別注文の確保')`,[f.variantId]);
      const pid=(await receipt.query('select pg_backend_pid() pid')).rows[0].pid;
      const waiting=receive(receipt,f,{choice:'none',disposition:'not_restocked'}).then(value=>({value,error:null}),error=>({value:null,error}));
      // 受け取りが色・サイズの鍵を待つまで待つ（最大5秒。E-2 の waitUntilBlocked と同じ間隔）
      let blocked=false;
      for(let i=0;i<50;i++) {
        if((await setup.query('select cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      expect(blocked).toBe(true);await purchase.query('commit');const outcome=await waiting;
      if(policy==='make') {
        expect(outcome.error).toBeNull();expect((await receipt.query('select fulfillment_type from public.order_items where id=$1',[outcome.value!.exchange_order_item_ids[0]])).rows[0].fulfillment_type).toBe('backorder');await receipt.query('commit');
      } else {
        expect(outcome.error).toMatchObject({message:'RETURN_EXCHANGE_OUT_OF_STOCK'});await receipt.query('rollback');
        expect((await setup.query('select count(*)::int n from public.order_return_receipts where return_id=$1',[f.returnId])).rows[0].n).toBe(0);
      }
      expect(await variantStock(setup,f.variantId)).toBe(0);
    } finally {
      // 途中で落ちた取引を閉じてから、確定した設定を元に戻す
      await setup.query('rollback');await purchase.query('rollback');await receipt.query('rollback');await purchase.end();await receipt.end();
      await setup.query(`update public.shop_return_settings set return_address_name=$1,return_address_postal_code=$2,return_address_line=$3,
        return_address_phone=$4,restocking_fee_enabled=$5,exchange_fees_enabled=$6,inspection_enabled=$7 where id=1`,
        [saved.return_address_name,saved.return_address_postal_code,saved.return_address_line,saved.return_address_phone,
         saved.restocking_fee_enabled,saved.exchange_fees_enabled,saved.inspection_enabled]);
      await setup.query(`update public.shop_return_reason_settings set out_of_stock_exchange=$1 where reason='unknown'`,[savedPolicy]);
    }
  });
});

describeLocalDb('Task 4 の見込みの例 R1〜R4 と同じ入力で、受け取りが同じ額を記録する（値 A）',getDb=>{
  const db=()=>getDb();
  beforeEach(async()=>{
    await db().query('begin');await db().query('delete from private.order_email_outbox');
    await db().query(`update public.shop_return_settings set return_address_name='試験店舗',return_address_postal_code='1500001',
      return_address_line='東京都渋谷区神宮前1-1-1',return_address_phone='0311112222' where id=1`);
  });
  afterEach(async()=>{await db().query('rollback');});
  // 値 A（E-2・Task 4 と同じ）: X 3000円×2・Y 1000円×3、割引 1000・送料 500、受け取った額 8500。割り振った割引は X 667・Y 333
  async function valueA(db:PgClient,o:{item:'X'|'Y';quantity:number;resolution:'refund'|'exchange';method:'customer_ships'|'shop_label';
      returnShippingFee:number;percent:number;exchangeFee:number;exchangeShippingFee:number}):Promise<Fx> {
    const actor=(await db.query(`insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
      values(gen_random_uuid(),$1,'{}',now(),now()) returning id`,[`returns-a-${uniqueSuffix()}@example.com`])).rows[0].id as string;
    const x=await createCatalogFixture(db,{stock:3});const y=await createCatalogFixture(db,{stock:4});
    const order=await insertOrderWithLines(db,{status:'paid',shippingAmount:500,discountAmount:1000,paidAmount:8500,paymentIntentId:`pi_fx_${uniqueSuffix()}`,
      lines:[{itemId:x.itemId,variantId:x.variantId,quantity:2,fulfillmentType:'stock',itemPrice:3000,createdAt:'2026-10-12T00:00:00Z'},
             {itemId:y.itemId,variantId:y.variantId,quantity:3,fulfillmentType:'stock',itemPrice:1000,createdAt:'2026-10-12T00:00:01Z'}]});
    const [xItem,yItem]=order.orderItemIds;
    const ship=(await db.query(`select * from public.admin_create_fulfillment($1,$2,$3,'yamato','TEST-A',false,$4::jsonb)`,
      [order.orderId,actor,randomUUID(),JSON.stringify([{order_item_id:xItem,quantity:2},{order_item_id:yItem,quantity:3}])])).rows[0];
    const target=o.item==='X'?{itemId:xItem,variantId:x.variantId}:{itemId:yItem,variantId:y.variantId};
    const ret=(await db.query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,$5,'customer',null,null,$6,$7,$8,$9,null,false)`,
      [order.orderId,actor,randomUUID(),JSON.stringify([{fulfillment_id:ship.fulfillment_id,order_item_id:target.itemId,quantity:o.quantity,reason:'unknown',
        reason_note:null,resolution:o.resolution,exchange_variant_id:o.resolution==='exchange'?target.variantId:null,
        exchange_method:o.resolution==='exchange'?'stock':null}]),
       o.method,o.returnShippingFee,o.percent,o.exchangeFee,o.exchangeShippingFee])).rows[0];
    const line=(await db.query('select id from public.order_return_lines where return_id=$1',[ret.return_id])).rows[0].id as string;
    return {orderId:order.orderId,itemId:target.itemId,variantId:target.variantId,returnId:ret.return_id,lineId:line,actor};
  }
  // 画面の見込みの元（Task 2 の list_order_returns の refund_amounts_by_count）
  const amountsOf=async(f:Fx)=>(await db().query('select public.list_order_returns($1) as returns',[f.orderId])).rows[0].returns[0].lines[0].refund_amounts_by_count;
  const refundRowOf=async(id:string)=>(await db().query('select amount,adjustment_amount from public.order_refunds where id=$1',[id])).rows[0];
  test('R1 手数料なし: X を1点 → 2666',async()=>{
    const f=await valueA(db(),{item:'X',quantity:1,resolution:'refund',method:'customer_ships',returnShippingFee:0,percent:0,exchangeFee:0,exchangeShippingFee:0});
    expect(await amountsOf(f)).toEqual([2666]);
    const r=await receive(db(),f,{choice:'now'});
    expect(r).toMatchObject({refund_amount:2666,refund_status:'awaiting_response',fee_due_amount:0});
    expect(await refundRowOf(r.refund_id)).toEqual({amount:2666,adjustment_amount:0});
  });
  test('R2 返送料 800（最初の受け取り）と返品の手数料 10%: X を2点 → 5333 − (800 + 533) = 4000',async()=>{
    const f=await valueA(db(),{item:'X',quantity:2,resolution:'refund',method:'shop_label',returnShippingFee:800,percent:10,exchangeFee:0,exchangeShippingFee:0});
    expect(await amountsOf(f)).toEqual([2666,5333]);
    const r=await receive(db(),f,{choice:'now',quantity:2});
    expect(r).toMatchObject({refund_amount:4000,fee_due_amount:0});
    expect(await refundRowOf(r.refund_id)).toEqual({amount:4000,adjustment_amount:-1333});
  });
  test('R3 交換だけ（返送料 800・交換の手数料 500・交換の送料 300）→ 返金なし、お支払い待ち 1600',async()=>{
    const f=await valueA(db(),{item:'X',quantity:1,resolution:'exchange',method:'shop_label',returnShippingFee:800,percent:0,exchangeFee:500,exchangeShippingFee:300});
    const r=await receive(db(),f,{choice:'none',disposition:'not_restocked'});
    expect(r).toMatchObject({refund_id:null,refund_amount:null,refund_status:null,fee_due_amount:1600});
    expect((await db().query('select exchange_paid_amount from public.order_items where id=$1',[r.exchange_order_item_ids[0]])).rows[0].exchange_paid_amount).toBe(2666);
  });
  test('R4 手数料が商品の額を超える: Y を1点（889）、返送料 800 と 20%（177）→ 返金なし（waived）、お支払い待ち 88',async()=>{
    const f=await valueA(db(),{item:'Y',quantity:1,resolution:'refund',method:'shop_label',returnShippingFee:800,percent:20,exchangeFee:0,exchangeShippingFee:0});
    expect(await amountsOf(f)).toEqual([889]);
    const r=await receive(db(),f,{choice:'now'});
    expect(r).toMatchObject({refund_id:null,refund_amount:0,refund_status:'waived',fee_due_amount:88});
    expect((await db().query('select count(*)::int n from public.order_refunds where order_id=$1',[f.orderId])).rows[0].n).toBe(0);
  });
});
