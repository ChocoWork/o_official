/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createDeliveryActor, insertDeliveryFixture, insertDeliveryRegistration } from './helpers/delivery-tracking-fixtures';
import {
  asOrderStatusRole, completeOrderStatusEmail, createOrderStatusEmail, createOrderStatusFixture,
  ensureOrderStatusLink, orderStatusClock, orderStatusSqlError, ORDER_STATUS_PRIVATE_SENTINEL,
  readOrderStatusLinkState, readOrderStatusPause, setOrderStatusLinkState, verifyOrderStatusPhone,
  waitForOrderStatusLock, withOrderStatusConnections,
} from './helpers/order-status-fixtures';

jest.setTimeout(30000);

// C-6 の対象を試験内で固定する。実装の定数を期待値として流用しない。
const CUSTOMER_KINDS = [
  'paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
  'return_accepted', 'return_received', 'return_sent_back', 'return_requested', 'return_declined',
  'cancel_request_received', 'cancel_request_declined', 'out_for_delivery', 'delivered', 'shipping_update',
] as const;
const SHOP_KINDS = ['return_refund_pending_shop', 'return_request_shop', 'cancel_request_shop'] as const;
const PUBLIC_FUNCTIONS = [
  ['public.ensure_order_status_link(uuid)', 'v'],
  ['public.get_order_status_link(text)', 's'],
  ['public.verify_order_status_phone(text,text)', 'v'],
  ['public.get_order_status_public_material(uuid)', 's'],
  ['public.complete_order_email(uuid,uuid,text)', 'v'],
] as const;
const PRIVATE_FUNCTIONS = [
  ['private.order_status_phone_last_four(text)', 'sql'],
  ['private.order_status_four_equal(text,text)', 'plpgsql'],
] as const;

async function publicMaterial(db: PgClient, orderId: string | null): Promise<any> {
  return (await db.query('select public.get_order_status_public_material($1) as material', [orderId])).rows[0].material;
}

/** ロック待ちの Promise に即座に拒否ハンドラーを付け、生の DB エラーを失敗表示へ出さない。 */
function pendingResult<T>(action: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  return action.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
}

describeLocalDb('integration: 注文状況のリンク・本人確認・公開材料（移行A）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test('電話の書き方をそろえ4桁を固定回数で比べる', async () => {
    const phones = ['+81 (90) 1234-5678', '090-1234-5678', '０９０ １２３４ ５６７８', '（０９０）１２３４－５６７８', null, '１２３'];
    const normalized: Array<string | null> = [];
    for (const phone of phones) {
      normalized.push((await db().query('select private.order_status_phone_last_four($1) as value', [phone])).rows[0].value);
    }
    expect(normalized).toEqual(['5678', '5678', '5678', '5678', null, null]);
    const compareResults: boolean[] = [];
    for (const provided of ['5678', '0678', '5608', '5670', '567']) {
      compareResults.push((await db().query('select private.order_status_four_equal($1,$2) as value', ['5678', provided])).rows[0].value);
    }
    expect(compareResults).toEqual([true, false, false, false, false]);
    for (const [actual, provided] of [[null, '5678'], ['abcd', '5678'], ['5678', null], ['5678', '５６７８']]) {
      expect((await db().query('select private.order_status_four_equal($1,$2) as value', [actual, provided])).rows[0].value).toBe(false);
    }
    const source = (await db().query(
      "select prosrc from pg_catalog.pg_proc where oid='private.order_status_four_equal(text,text)'::regprocedure",
    )).rows[0].prosrc as string;
    const withoutComments = source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const loop = withoutComments.match(/for\s+\w+\s+in\s+(?:1\s*\.\.\s*4|0\s*\.\.\s*3)\s+loop([\s\S]*?)end\s+loop/i);
    expect(loop !== null).toBe(true);
    expect(/\b(?:return|exit)\b/i.test(loop?.[1] ?? '')).toBe(false);
    expect(/ascii\s*\(/i.test(loop?.[1] ?? '')).toBe(true);
    expect(loop?.[1].includes('#')).toBe(true);
    expect(loop?.[1].includes('|')).toBe(true);

    expect(await orderStatusSqlError(db(), 'select public.ensure_order_status_link($1)', [null]))
      .toEqual({ code: '22023', symbol: 'ORDER_STATUS_ARGUMENT_INVALID' });
    expect(await orderStatusSqlError(db(), 'select public.ensure_order_status_link($1)', [randomUUID()]))
      .toEqual({ code: 'P0002', symbol: 'ORDER_NOT_FOUND' });
  });

  test('間違いだけ加算し20回目はmismatchで次はlocked', async () => {
    const order = await createOrderStatusFixture(db());
    const token = await ensureOrderStatusLink(db(), order.orderId);
    const clock = await orderStatusClock(db());
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.future, failedAttempts: 18 });
    const outcomes: string[] = [];
    const counts: number[] = [];
    for (const provided of ['5678', '0000', '0000', '5678']) {
      const [row] = await verifyOrderStatusPhone(db(), token, provided);
      outcomes.push(row.result);
      counts.push(row.failed_attempts);
    }
    expect(outcomes).toEqual(['ok', 'mismatch', 'mismatch', 'locked']);
    expect(counts).toEqual([18, 19, 20, 20]);
    expect((await readOrderStatusLinkState(db(), order.orderId)).failedAttempts).toBe(20);
    for (const provided of [null, '', '123', '12345', '５６７８', 'abcd']) {
      expect((await orderStatusSqlError(db(), 'select * from public.verify_order_status_phone($1,$2)', [token, provided])).code).toBe('22023');
    }
    expect((await readOrderStatusLinkState(db(), order.orderId)).failedAttempts).toBe(20);
    const actor = await createDeliveryActor(db());
    const owned = await createOrderStatusFixture(db(), { customerId: actor.id });
    const ownedToken = await ensureOrderStatusLink(db(), owned.orderId);
    const link = (await db().query('select * from public.get_order_status_link($1)', [ownedToken])).rows[0];
    expect(Object.keys(link).sort()).toEqual(['order_id', 'customer_id', 'verify_until', 'failed_attempts', 'phone_available'].sort());
    expect(link).toEqual({ order_id: owned.orderId, customer_id: actor.id, verify_until: null, failed_attempts: 0, phone_available: true });
  });

  test('期限NULLと過去と同時刻はexpired、短い電話はunavailable', async () => {
    const order = await createOrderStatusFixture(db());
    const token = await ensureOrderStatusLink(db(), order.orderId);
    const clock = await orderStatusClock(db());
    const results: string[] = [];
    for (const verifyUntil of [null, clock.past, clock.now]) {
      await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil, failedAttempts: 20 });
      const [row] = await verifyOrderStatusPhone(db(), token, '5678');
      results.push(row.result);
      expect(row.failed_attempts).toBe(20);
    }
    const short = await createOrderStatusFixture(db(), { phone: '１２３' });
    const shortToken = await ensureOrderStatusLink(db(), short.orderId);
    await setOrderStatusLinkState(db(), { orderId: short.orderId, verifyUntil: clock.future, failedAttempts: 20 });
    results.push((await verifyOrderStatusPhone(db(), shortToken, '0123'))[0].result);
    expect(results).toEqual(['expired', 'expired', 'expired', 'unavailable']);
    const missingPhone = await createOrderStatusFixture(db(), { phone: null });
    const missingToken = await ensureOrderStatusLink(db(), missingPhone.orderId);
    await setOrderStatusLinkState(db(), { orderId: missingPhone.orderId, verifyUntil: clock.future, failedAttempts: 20 });
    expect((await verifyOrderStatusPhone(db(), missingToken, '5678'))[0]).toMatchObject({ result: 'unavailable', failed_attempts: 20 });
    for (const unavailableToken of [shortToken, missingToken]) {
      expect((await db().query('select * from public.get_order_status_link($1)', [unavailableToken])).rows[0].phone_available).toBe(false);
    }
    await setOrderStatusLinkState(db(), { orderId: missingPhone.orderId, verifyUntil: clock.past, failedAttempts: 20 });
    expect((await verifyOrderStatusPhone(db(), missingToken, '5678'))[0]).toMatchObject({ result: 'expired', failed_attempts: 20 });
  });

  test('16種類だけが送信成功で期限を進める', async () => {
    expect(CUSTOMER_KINDS).toHaveLength(16);
    expect(SHOP_KINDS).toHaveLength(3);
    const customerAdvances: string[] = [];
    let shopAdvances = 0;
    let failedOrSkippedAdvances = 0;
    const clock = await orderStatusClock(db());
    for (const kind of [...CUSTOMER_KINDS, ...SHOP_KINDS]) {
      const order = await createOrderStatusFixture(db());
      await ensureOrderStatusLink(db(), order.orderId);
      await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: kind === 'paid' ? null : clock.future, failedAttempts: 11 });
      const email = await createOrderStatusEmail(db(), order.orderId, kind);
      expect(await completeOrderStatusEmail(db(), email)).toBe(true);
      const state = await readOrderStatusLinkState(db(), order.orderId);
      if ((CUSTOMER_KINDS as readonly string[]).includes(kind)) {
        if (state.verifyUntil !== null) customerAdvances.push(kind);
        expect(state.failedAttempts).toBe(0);
        const difference = (await db().query(
          `select l.verify_until=e.sent_at+interval '21 days' as exact,
             e.status='sent' and e.lease_token is null and e.lease_expires_at is null
               and e.finished_at=e.sent_at and e.provider_message_id=$2 as completed
           from private.order_status_links l join private.order_email_outbox e on e.order_id=l.order_id where e.id=$1`,
          [email.emailId, `order-status-fixture-message-${email.emailId}`],
        )).rows[0];
        expect(difference).toEqual({ exact: true, completed: true });
      } else {
        if (state.verifyUntil !== clock.future) shopAdvances += 1;
        expect(state.failedAttempts).toBe(11);
      }
    }
    for (const kind of CUSTOMER_KINDS) {
      for (const outcome of ['transient', 'permanent', 'config', 'skipped'] as const) {
        const order = await createOrderStatusFixture(db());
        await ensureOrderStatusLink(db(), order.orderId);
        await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.future, failedAttempts: 11 });
        const email = await createOrderStatusEmail(db(), order.orderId, kind);
        const result = outcome === 'skipped'
          ? await db().query('select public.skip_order_email($1,$2,$3) as result', [email.emailId, email.leaseToken, 'no_recipient'])
          : await db().query('select public.fail_order_email($1,$2,$3,$4,$5) as result',
            [email.emailId, email.leaseToken, outcome === 'config' ? 'config_provider' : 'fixture_failed', outcome, null]);
        expect(result.rows[0].result).toBe(outcome === 'skipped' ? true : outcome === 'permanent' ? 'dead' : 'retry_wait');
        const state = await readOrderStatusLinkState(db(), order.orderId);
        if (state.verifyUntil !== clock.future) failedOrSkippedAdvances += 1;
        expect(state.failedAttempts).toBe(11);
      }
    }
    expect(customerAdvances).toHaveLength(16);
    expect(shopAdvances).toBe(0);
    expect(failedOrSkippedAdvances).toBe(0);
  });

  test('同じ取引時刻の完了は失敗数を再び消さない', async () => {
    const order = await createOrderStatusFixture(db());
    await ensureOrderStatusLink(db(), order.orderId);
    const first = await createOrderStatusEmail(db(), order.orderId, 'paid');
    const second = await createOrderStatusEmail(db(), order.orderId, 'awaiting_payment');
    expect(await completeOrderStatusEmail(db(), first)).toBe(true);
    const firstState = await readOrderStatusLinkState(db(), order.orderId);
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: firstState.verifyUntil, failedAttempts: 3 });
    expect(await completeOrderStatusEmail(db(), second)).toBe(true);
    const failedAfterSecondComplete = (await readOrderStatusLinkState(db(), order.orderId)).failedAttempts;
    expect(failedAfterSecondComplete).toBe(3);
    expect((await db().query(
      `select a.sent_at=b.sent_at and l.verify_until=b.sent_at+interval '21 days' as same
       from private.order_email_outbox a join private.order_email_outbox b on b.id=$2
       join private.order_status_links l on l.order_id=a.order_id where a.id=$1`, [first.emailId, second.emailId],
    )).rows[0].same).toBe(true);
  });

  test('リンク無しの旧本文も種類で期限を更新する', async () => {
    const order = await createOrderStatusFixture(db());
    const token = await ensureOrderStatusLink(db(), order.orderId);
    const email = await createOrderStatusEmail(db(), order.orderId, 'paid', true);
    const clock = await orderStatusClock(db());
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.past, failedAttempts: 20 });
    expect(await completeOrderStatusEmail(db(), email)).toBe(true);
    const sentAtPlus21Days = (await db().query(
      "select (sent_at+interval '21 days')::text as deadline from private.order_email_outbox where id=$1", [email.emailId],
    )).rows[0].deadline as string;
    const withExistingLink = await readOrderStatusLinkState(db(), order.orderId);
    expect(withExistingLink.verifyUntil).toBe(sentAtPlus21Days);
    expect(withExistingLink.failedAttempts).toBe(0);
    expect((await ensureOrderStatusLink(db(), order.orderId)) === token).toBe(true);

    // 既存の未来の期限の方が後なら、その期限と失敗数を保つ。
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.farFuture, failedAttempts: 7 });
    const another = await createOrderStatusEmail(db(), order.orderId, 'awaiting_payment', true);
    await db().query("update private.order_email_outbox set origin='manual' where id=$1", [another.emailId]);
    expect(await completeOrderStatusEmail(db(), another)).toBe(true);
    expect(await readOrderStatusLinkState(db(), order.orderId)).toEqual({ verifyUntil: clock.farFuture, failedAttempts: 7 });
    const oldOrder = await createOrderStatusFixture(db());
    const oldEmail = await createOrderStatusEmail(db(), oldOrder.orderId, 'paid', true);
    expect(await completeOrderStatusEmail(db(), oldEmail)).toBe(true);
    const withoutLink = (await db().query(
      'select count(*)::integer as "linkCount" from private.order_status_links where order_id=$1', [oldOrder.orderId],
    )).rows[0];
    expect(withoutLink.linkCount).toBe(0);
    expect((await db().query(
      'select subject,body_text from private.order_email_outbox where id=$1', [oldEmail.emailId],
    )).rows[0]).toEqual({ subject: '旧件名', body_text: 'リンク無しの保存済み本文' });
  });

  test('leaseの不一致と重複完了は期限もpauseも変えない', async () => {
    const order = await createOrderStatusFixture(db());
    await ensureOrderStatusLink(db(), order.orderId);
    const sent = await createOrderStatusEmail(db(), order.orderId, 'paid');
    await db().query(
      `update private.order_email_send_pause set paused=true,reason='config_provider',paused_at=now(),next_probe_at=now()+interval '1 hour' where id`,
    );
    expect(await completeOrderStatusEmail(db(), sent)).toBe(true);
    expect(await readOrderStatusPause(db())).toMatchObject({ paused: false, reason: null, paused_at: null, next_probe_at: null });
    const sending = await createOrderStatusEmail(db(), order.orderId, 'awaiting_payment');
    const clock = await orderStatusClock(db());
    await setOrderStatusLinkState(db(), { orderId: order.orderId, verifyUntil: clock.past, failedAttempts: 5 });
    await db().query(
      `update private.order_email_send_pause set paused=true,reason='quota_daily',paused_at=now(),next_probe_at=now()+interval '1 hour' where id`,
    );
    const stateBefore = { link: await readOrderStatusLinkState(db(), order.orderId), pause: await readOrderStatusPause(db()) };
    const completed = [
      await completeOrderStatusEmail(db(), { ...sending, leaseToken: randomUUID() }),
      await completeOrderStatusEmail(db(), sent),
    ];
    const stateAfter = { link: await readOrderStatusLinkState(db(), order.orderId), pause: await readOrderStatusPause(db()) };
    expect(completed).toEqual([false, false]);
    expect(stateAfter).toEqual(stateBefore);
    expect((await db().query(
      "select status='sending' and lease_token=$2::uuid as unchanged from private.order_email_outbox where id=$1",
      [sending.emailId, sending.leaseToken],
    )).rows[0].unchanged).toBe(true);
  });

  test('公開材料のDBの答えに個人情報と番号のキーが無い', async () => {
    const order = await createOrderStatusFixture(db());
    const clock = await orderStatusClock(db());
    const shipment = await insertDeliveryFixture(db(), {
      orderId: order.orderId, shippedAt: clock.past, deliveredAt: clock.past, trackingNumber: ORDER_STATUS_PRIVATE_SENTINEL,
    });
    await db().query('insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,1)',
      [shipment.fulfillmentId, order.orderItemId]);
    await insertDeliveryRegistration(db(), shipment.fulfillmentId, { state: 'registered', everRegistered: true });
    await db().query(
      `insert into public.order_fulfillment_events
         (fulfillment_id,tracking_version,status,happened_at,source,provider_sub_status,recorded_at)
       values ($1,1,'in_transit',now()-interval '3 hours','tracking',$2,now()-interval '3 hours'),
              ($1,1,'delivered',now()-interval '2 hours','tracking',$2,now()-interval '2 hours'),
              ($1,2,'failure',now()-interval '1 hour','tracking',$2,now()-interval '1 hour')`,
      [shipment.fulfillmentId, ORDER_STATUS_PRIVATE_SENTINEL],
    );
    const cancelled = await insertDeliveryFixture(db(), { orderId: order.orderId, shippedAt: clock.past });
    await db().query('update public.order_fulfillments set cancelled_at=now() where id=$1', [cancelled.fulfillmentId]);
    await db().query(
      `insert into public.order_fulfillment_tracking_changes
         (fulfillment_id,from_carrier,to_carrier,from_tracking_number,to_tracking_number,
          tracking_version,notify_customer,request_key,request_fingerprint,changed_by)
       values ($1,'yamato','sagawa',$2,$2,2,true,pg_catalog.gen_random_uuid(),$2,pg_catalog.gen_random_uuid())`,
      [shipment.fulfillmentId, ORDER_STATUS_PRIVATE_SENTINEL],
    );
    await db().query(
      `insert into public.order_refunds
         (order_id,source,request_key,request_fingerprint,status,amount,notify_customer,note,payment_method_type,customer_action_expires_at)
       values ($1,'admin',pg_catalog.gen_random_uuid(),$2,'pending',100,false,$2,'card',now()+interval '1 day'),
              ($1,'admin',pg_catalog.gen_random_uuid(),$2,'awaiting_response',200,false,$2,'card',now()+interval '1 day')`,
      [order.orderId, ORDER_STATUS_PRIVATE_SENTINEL],
    );
    const material = await publicMaterial(db(), order.orderId);
    expect(Object.keys(material).sort()).toEqual(['order', 'line_rows', 'fulfillments', 'delivery_detail', 'delivery_summary', 'refund_rows'].sort());
    const keys = (value: Record<string, unknown>) => Object.keys(value).sort();
    expect(keys(material.order)).toEqual([
      'id', 'created_at', 'status', 'subtotal_amount', 'shipping_amount', 'discount_amount', 'total_amount', 'currency', 'order_items',
    ].sort());
    expect(material.order.order_items).toHaveLength(1);
    expect(keys(material.order.order_items[0])).toEqual([
      'id', 'item_id', 'variant_id', 'item_name', 'item_image_url', 'color', 'size', 'quantity', 'line_total', 'line_kind',
    ].sort());
    expect(material.line_rows).toHaveLength(1);
    expect(keys(material.line_rows[0])).toEqual([
      'order_id', 'order_item_id', 'variant_id', 'fulfillment_type', 'quantity', 'shipped', 'completed',
      'refunded_before_shipment', 'refunded_after_shipment', 'in_production', 'ready_unshipped', 'unshipped',
    ].sort());
    expect(material.line_rows).toEqual((await db().query(
      'select jsonb_agg(r order by r.order_item_id) as rows from public.list_order_line_fulfillment($1::uuid[]) r', [[order.orderId]],
    )).rows[0].rows);
    expect(material.fulfillments.map((row: { number: number }) => row.number)).toEqual([1, 2]);
    for (const row of material.fulfillments) {
      expect(keys(row)).toEqual(['fulfillment_id', 'number', 'shipping_carrier', 'shipped_at', 'cancelled_at', 'lines'].sort());
      for (const line of row.lines) expect(keys(line)).toEqual(['order_item_id', 'quantity']);
    }
    expect(keys(material.delivery_detail)).toEqual(['enabled', 'fulfillments']);
    expect(typeof material.delivery_detail.enabled).toBe('boolean');
    expect(material.delivery_detail.fulfillments).toHaveLength(2);
    for (const row of material.delivery_detail.fulfillments) {
      expect(keys(row)).toEqual([
        'fulfillment_id', 'cancelled_at', 'tracking_version', 'delivery_status', 'delivery_status_at', 'delivered_at', 'registration', 'events',
      ].sort());
      if (row.registration !== null) expect(keys(row.registration)).toEqual(['ever_registered', 'state']);
      for (const event of row.events) expect(keys(event)).toEqual(['tracking_version', 'status', 'happened_at', 'recorded_at'].sort());
    }
    const detail = material.delivery_detail.fulfillments.find((row: { fulfillment_id: string }) => row.fulfillment_id === shipment.fulfillmentId);
    expect(detail.registration).toEqual({ state: 'registered', ever_registered: true });
    expect(detail.events.map((event: { status: string }) => event.status)).toEqual(['delivered', 'in_transit']);
    expect(material.delivery_summary).toEqual({ active_count: 1, delivered_count: 1 });
    expect(material.refund_rows).toHaveLength(2);
    for (const row of material.refund_rows) expect(keys(row)).toEqual(['refund_id', 'created_at', 'amount', 'status'].sort());
    // 同じ取引で入れた2件は created_at が同じ。同時刻の並びは会員の窓口（created_at DESC, id DESC）と同じ id の降順になる。
    const refundIds: string[] = material.refund_rows.map((row: { refund_id: string }) => row.refund_id);
    expect(material.refund_rows[0].created_at).toBe(material.refund_rows[1].created_at);
    expect(refundIds).toEqual([...refundIds].sort().reverse());
    expect(refundIds).toEqual((await db().query(
      'select refund_id from public.list_order_refunds($1::uuid)', [order.orderId],
    )).rows.map((row: { refund_id: string }) => row.refund_id));

    const forbidden = new Set([
      'user_id', 'customer_id', 'shipping_full_name', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city',
      'shipping_address', 'shipping_building', 'shipping_phone', 'shipping_email', 'payment_method', 'payment_method_type',
      'payment_intent_id', 'tracking_number', 'tracking_url', 'from_tracking_number', 'to_tracking_number', 'tracking_changes',
      'return_address', 'returnAddress', 'trackingNumber', 'trackingUrl', 'actor_email', 'created_by', 'changed_by',
      'request_fingerprint', 'provider_sub_status', 'customer_action_expires_at', 'customer_action_deadline', 'note', 'token',
    ]);
    const forbiddenKeys: string[] = [];
    function visit(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) forbiddenKeys.push(key);
        visit(child);
      }
    }
    visit(material);
    const privateSentinelFound = [ORDER_STATUS_PRIVATE_SENTINEL, 'order-status-private@example.invalid', '+81 (90) 1234-5678', '9999999']
      .some((value) => JSON.stringify(material).includes(value));
    expect(forbiddenKeys).toEqual([]);
    expect(privateSentinelFound).toBe(false);

    // 不在、形違い、隠す2状態は link/verify が0行、公開材料はSQL NULL。
    for (const token of ['bad-token', 'Z'.repeat(43)]) {
      expect((await db().query('select * from public.get_order_status_link($1)', [token])).rows).toEqual([]);
      expect(await verifyOrderStatusPhone(db(), token, '5678')).toEqual([]);
    }
    for (const orderId of [null, randomUUID()]) expect(await publicMaterial(db(), orderId)).toBeNull();
    for (const status of ['payment_in_progress', 'abandoned'] as const) {
      const hidden = await createOrderStatusFixture(db(), { status });
      const hiddenToken = await ensureOrderStatusLink(db(), hidden.orderId);
      expect((await db().query('select * from public.get_order_status_link($1)', [hiddenToken])).rows).toEqual([]);
      expect(await verifyOrderStatusPhone(db(), hiddenToken, '5678')).toEqual([]);
      expect(await publicMaterial(db(), hidden.orderId)).toBeNull();
    }
    const visible = await createOrderStatusFixture(db(), { status: 'cancelled' });
    const visibleToken = await ensureOrderStatusLink(db(), visible.orderId);
    await setOrderStatusLinkState(db(), { orderId: visible.orderId, verifyUntil: clock.future, failedAttempts: 4 });
    expect((await db().query('select * from public.get_order_status_link($1)', [visibleToken])).rows).toHaveLength(1);
    expect((await verifyOrderStatusPhone(db(), visibleToken, '5678'))[0]).toMatchObject({ result: 'ok', failed_attempts: 4 });
    expect((await publicMaterial(db(), visible.orderId)).order.status).toBe('cancelled');

    // 取得後のキー削除で代用せず、内部の全情報RPCや注文全行のJSON化を呼んでいないことも確認する。
    const source = (await db().query(
      "select prosrc from pg_catalog.pg_proc where oid='public.get_order_status_public_material(uuid)'::regprocedure",
    )).rows[0].prosrc as string;
    expect(/\b(?:list_order_fulfillments|get_order_delivery_detail|list_order_refunds|get_customer_order_returns)\s*\(/i.test(source)).toBe(false);
    expect(/\b(?:to_jsonb|row_to_json)\s*\(\s*(?:o|orders)\s*\)/i.test(source)).toBe(false);
    expect(/\bprivate\.order_line_fulfillment\s*\(/i.test(source)).toBe(true);
  });

  test('RLSとRESTRICTIVE拒否、SELECTだけ、EXECUTEはservice_roleだけ', async () => {
    const order = await createOrderStatusFixture(db());
    const token = await ensureOrderStatusLink(db(), order.orderId);
    const policy = (await db().query(
      `select c.relrowsecurity as enabled,not p.polpermissive as restrictive,
         pg_catalog.pg_get_expr(p.polqual,p.polrelid) as using,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) as "withCheck",
         p.polcmd as command,
         array(select r.rolname::text from pg_catalog.pg_roles r where r.oid=any(p.polroles) order by r.rolname) as roles
       from pg_catalog.pg_class c join pg_catalog.pg_policy p on p.polrelid=c.oid
       where c.oid='private.order_status_links'::regclass and p.polname='order_status_links_deny_clients'`,
    )).rows[0];
    const rlsAndPolicy = { enabled: policy.enabled, restrictive: policy.restrictive, using: policy.using, withCheck: policy.withCheck };
    expect(rlsAndPolicy).toEqual({ enabled: true, restrictive: true, using: 'false', withCheck: 'false' });
    expect(policy.command).toBe('*');
    expect(policy.roles).toEqual(['anon', 'authenticated']);
    expect((await db().query(
      `select confdeltype from pg_catalog.pg_constraint
       where conrelid='private.order_status_links'::regclass and contype='f' and confrelid='public.orders'::regclass`,
    )).rows).toEqual([{ confdeltype: 'r' }]);
    expect((await db().query(
      `select conname,contype from pg_catalog.pg_constraint where conrelid='private.order_status_links'::regclass
       and conname in ('order_status_links_token_key','order_status_links_token_check','order_status_links_failed_attempts_check') order by conname`,
    )).rows).toEqual([
      { conname: 'order_status_links_failed_attempts_check', contype: 'c' },
      { conname: 'order_status_links_token_check', contype: 'c' },
      { conname: 'order_status_links_token_key', contype: 'u' },
    ]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect((await db().query(
          "select pg_catalog.has_table_privilege($1::text,'private.order_status_links',$2::text) as allowed", [role, privilege],
        )).rows).toEqual([{ allowed: role === 'service_role' && privilege === 'SELECT' }]);
      }
    }
    const deniedSqlStates: Array<string | undefined> = [];
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      await asOrderStatusRole(db(), role, async () => {
        if (role === 'service_role') {
          expect((await db().query('select order_id from private.order_status_links where order_id=$1', [order.orderId])).rows).toEqual([{ order_id: order.orderId }]);
          expect((await ensureOrderStatusLink(db(), order.orderId)) === token).toBe(true);
        } else {
          deniedSqlStates.push((await orderStatusSqlError(db(), 'select * from private.order_status_links')).code);
          for (const [sql, params] of [
            ['select public.ensure_order_status_link($1)', [order.orderId]],
            ['select * from public.get_order_status_link($1)', [token]],
            ['select * from public.verify_order_status_phone($1,$2)', [token, '5678']],
            ['select public.get_order_status_public_material($1)', [order.orderId]],
            ['select public.complete_order_email($1,$2,$3)', [randomUUID(), randomUUID(), null]],
          ] as Array<[string, unknown[]]>) deniedSqlStates.push((await orderStatusSqlError(db(), sql, params)).code);
        }
        for (const sql of [
          "insert into private.order_status_links (order_id,token) values ($1,repeat('A',43))",
          'update private.order_status_links set failed_attempts=1 where order_id=$1',
          'delete from private.order_status_links where order_id=$1',
        ]) deniedSqlStates.push((await orderStatusSqlError(db(), sql, [order.orderId])).code);
        deniedSqlStates.push((await orderStatusSqlError(db(), 'truncate private.order_status_links')).code);
        deniedSqlStates.push((await orderStatusSqlError(db(), "select private.order_status_phone_last_four('09012345678')")).code);
        deniedSqlStates.push((await orderStatusSqlError(db(), "select private.order_status_four_equal('5678','5678')")).code);
      });
    }
    expect(deniedSqlStates.length).toBeGreaterThan(0);
    expect(deniedSqlStates.every((code) => code === '42501')).toBe(true);
    for (const [signature, volatility] of PUBLIC_FUNCTIONS) {
      const info = (await db().query(
        `select p.prosecdef,p.provolatile,p.proconfig,l.lanname,pg_catalog.pg_get_userbyid(p.proowner) as owner,
           exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)))
             where grantee=0 and privilege_type='EXECUTE') as public_execute
         from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang where p.oid=$1::regprocedure`, [signature],
      )).rows[0];
      expect(info).toEqual({ prosecdef: true, provolatile: volatility, proconfig: expect.arrayContaining(['search_path=""']),
        lanname: 'plpgsql', owner: 'postgres', public_execute: false });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query("select pg_catalog.has_function_privilege($1::text,$2::text,'EXECUTE') as allowed", [role, signature])).rows)
          .toEqual([{ allowed: role === 'service_role' }]);
      }
    }
    for (const [signature, language] of PRIVATE_FUNCTIONS) {
      const info = (await db().query(
        `select p.prosecdef,p.provolatile,p.proconfig,l.lanname,pg_catalog.pg_get_userbyid(p.proowner) as owner,
           exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)))
             where grantee=0 and privilege_type='EXECUTE') as public_execute
         from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang where p.oid=$1::regprocedure`, [signature],
      )).rows[0];
      expect(info).toEqual({ prosecdef: false, provolatile: 'i', proconfig: expect.arrayContaining(['search_path=""']),
        lanname: language, owner: 'postgres', public_execute: false });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query("select pg_catalog.has_function_privilege($1::text,$2::text,'EXECUTE') as allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
      }
    }
    // 将来 permissive policy/GRANT が加わっても RESTRICTIVE が勝つことを、取引内だけの権限で確かめる。
    await db().query('grant usage on schema private to anon,authenticated');
    await db().query('grant select,insert,update,delete on private.order_status_links to anon,authenticated');
    await db().query('create policy order_status_test_allow on private.order_status_links as permissive for all to anon,authenticated using(true) with check(true)');
    const another = await createOrderStatusFixture(db());
    for (const role of ['anon', 'authenticated'] as const) {
      await asOrderStatusRole(db(), role, async () => {
        expect((await db().query('select * from private.order_status_links')).rows).toEqual([]);
        expect((await db().query('update private.order_status_links set failed_attempts=1')).rowCount).toBe(0);
        expect((await db().query('delete from private.order_status_links')).rowCount).toBe(0);
        expect((await orderStatusSqlError(db(), "insert into private.order_status_links (order_id,token) values ($1,repeat('B',43))", [another.orderId])).code).toBe('42501');
      });
    }
  });
});

describeLocalDb('integration: 注文状況のリンクと完了を2接続で競合させる', () => {
  test('32バイトから43文字のリンクを作り同時に呼んでも1注文1本', async () => {
    await withOrderStatusConnections(async (first, second, pids, orderIds) => {
      const order = await createOrderStatusFixture(first);
      orderIds.push(order.orderId);
      await first.query('begin');
      const original = await ensureOrderStatusLink(first, order.orderId);
      await second.query('begin');
      const pending = pendingResult(ensureOrderStatusLink(second, order.orderId));
      await waitForOrderStatusLock(first, pids[1], pids[0]);
      await first.query('commit');
      const concurrent = await pending;
      if (!concurrent.ok) throw new Error('ORDER_STATUS_CONCURRENT_ENSURE_FAILED');
      await second.query('commit');
      const tokens = [original, concurrent.value, await ensureOrderStatusLink(first, order.orderId)];
      expect(tokens.every((value) => /^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
      expect(new Set(tokens).size).toBe(1);
      const linkCount = (await first.query('select count(*)::integer as count from private.order_status_links where order_id=$1', [order.orderId])).rows[0].count as number;
      expect(linkCount).toBe(1);
      expect(await readOrderStatusLinkState(first, order.orderId)).toEqual({ verifyUntil: null, failedAttempts: 0 });
      expect((await first.query('select created_at is not null as present from private.order_status_links where order_id=$1', [order.orderId])).rows[0].present).toBe(true);
      const source = (await first.query("select prosrc from pg_catalog.pg_proc where oid='public.ensure_order_status_link(uuid)'::regprocedure")).rows[0].prosrc as string;
      expect(/extensions\.gen_random_bytes\s*\(\s*32\s*\)/i.test(source)).toBe(true);

      await first.query('begin');
      for (const invalid of ['', 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), '/'.repeat(43), '='.repeat(43), 'あ'.repeat(43)]) {
        expect((await orderStatusSqlError(first, 'update private.order_status_links set token=$2 where order_id=$1', [order.orderId, invalid])).code).toBe('23514');
      }
      for (const attempts of [-1, 21]) {
        expect((await orderStatusSqlError(first, 'update private.order_status_links set failed_attempts=$2 where order_id=$1', [order.orderId, attempts])).code).toBe('23514');
      }
      const duplicate = await createOrderStatusFixture(first);
      expect((await orderStatusSqlError(first, 'insert into private.order_status_links (order_id,token) values ($1,$2)', [duplicate.orderId, original])).code).toBe('23505');
      expect((await orderStatusSqlError(first, "insert into private.order_status_links (order_id,token) values ($1,repeat('C',43))", [randomUUID()])).code).toBe('23503');
      expect((await orderStatusSqlError(first, 'insert into private.order_status_links (order_id,token) values ($1,$2)', [order.orderId, 'D'.repeat(43)])).code).toBe('23505');
      await first.query('rollback');
    });
  });

  test('同時の間違いでも失敗数が20を超えない', async () => {
    await withOrderStatusConnections(async (first, second, pids, orderIds) => {
      const order = await createOrderStatusFixture(first);
      orderIds.push(order.orderId);
      const token = await ensureOrderStatusLink(first, order.orderId);
      const clock = await orderStatusClock(first);
      await setOrderStatusLinkState(first, { orderId: order.orderId, verifyUntil: clock.future, failedAttempts: 19 });
      await first.query('begin');
      const firstRows = await verifyOrderStatusPhone(first, token, '0000');
      await second.query('begin');
      const pending = pendingResult(verifyOrderStatusPhone(second, token, '0000'));
      await waitForOrderStatusLock(first, pids[1], pids[0]);
      await first.query('commit');
      const secondResult = await pending;
      if (!secondResult.ok) throw new Error('ORDER_STATUS_CONCURRENT_VERIFY_FAILED');
      const secondRows = secondResult.value;
      await second.query('commit');
      expect(firstRows).toHaveLength(1);
      expect(secondRows).toHaveLength(1);
      const outcomeCounts = { mismatch: 0, locked: 0 };
      for (const row of [...firstRows, ...secondRows]) {
        if (row.result === 'mismatch' || row.result === 'locked') outcomeCounts[row.result] += 1;
        expect(row.failed_attempts).toBe(20);
      }
      const finalFailedAttempts = (await readOrderStatusLinkState(first, order.orderId)).failedAttempts;
      expect(finalFailedAttempts).toBe(20);
      expect(outcomeCounts).toEqual({ mismatch: 1, locked: 1 });
    });
  });

  test('2接続の送信完了でも期限を戻さない', async () => {
    await withOrderStatusConnections(async (first, second, pids, orderIds) => {
      const order = await createOrderStatusFixture(first);
      orderIds.push(order.orderId);
      await ensureOrderStatusLink(first, order.orderId);
      const earlier = await createOrderStatusEmail(first, order.orderId, 'paid');
      const later = await createOrderStatusEmail(first, order.orderId, 'awaiting_payment');
      await setOrderStatusLinkState(first, { orderId: order.orderId, verifyUntil: null, failedAttempts: 17 });
      await first.query('begin');
      // 最初の取引時刻を確定する。もう一方は clock_timestamp() で後の時刻を確認するだけで待たない。
      const earlierNow = (await first.query('select now()::text as at')).rows[0].at as string;
      expect((await second.query('select clock_timestamp()>$1::timestamptz as later', [earlierNow])).rows[0].later).toBe(true);
      await second.query('begin');
      expect(await completeOrderStatusEmail(second, later)).toBe(true);
      const pending = pendingResult(completeOrderStatusEmail(first, earlier));
      await waitForOrderStatusLock(second, pids[0], pids[1]);
      // 期限は既に進んだ。古い完了で、その後の失敗を再び消してはならない。
      const laterState = await readOrderStatusLinkState(second, order.orderId);
      await setOrderStatusLinkState(second, { orderId: order.orderId, verifyUntil: laterState.verifyUntil, failedAttempts: 3 });
      await second.query('commit');
      const earlierResult = await pending;
      if (!earlierResult.ok) throw new Error('ORDER_STATUS_CONCURRENT_COMPLETE_FAILED');
      expect(earlierResult.value).toBe(true);
      await first.query('commit');
      const laterSentAtPlus21Days = (await first.query(
        "select (sent_at+interval '21 days')::text as deadline from private.order_email_outbox where id=$1", [later.emailId],
      )).rows[0].deadline as string;
      const { verifyUntil, failedAttempts } = await readOrderStatusLinkState(first, order.orderId);
      expect(verifyUntil).toBe(laterSentAtPlus21Days);
      expect(failedAttempts).toBe(3);
      expect((await first.query(
        `select a.sent_at<b.sent_at and l.verify_until=b.sent_at+interval '21 days' as monotonic
         from private.order_email_outbox a join private.order_email_outbox b on b.id=$2
         join private.order_status_links l on l.order_id=a.order_id where a.id=$1`, [earlier.emailId, later.emailId],
      )).rows[0].monotonic).toBe(true);
    });
  });
});
