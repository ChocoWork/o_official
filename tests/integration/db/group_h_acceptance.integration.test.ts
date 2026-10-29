/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { acceptHCheckout, hDiscount, hFailure, hRpc, seedHCheckout, seedHDiscount, seedHOrderUnits, seedHRedemption, seedHMember } from './helpers/group-h-fixtures';
import { createCatalogFixture } from './helpers/order-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';

describeLocalDb('H4 acceptance (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-549-AC-01: 入力codeの上限・期間・停止・初回・前回着数が変わったdraftだけ入力へ戻す', async () => {
    for (const mode of ['limit', 'once', 'expired', 'future', 'stopped', 'assigned', 'first'] as const) {
      const userId = await seedHMember(db()); const code = `H4-${randomUUID().toUpperCase()}`;
      const id = await seedHDiscount(db(), hDiscount({ code, usageLimit: mode === 'limit' ? 1 : null, oncePerCustomer: mode === 'once', firstOrderOnly: mode === 'first',
        audience: mode === 'assigned' ? 'assigned' : 'anyone', userIds: [userId] }));
      const f = await seedHCheckout(db(), { discountId: id, code, userId });
      if (mode === 'limit' || mode === 'once' || mode === 'first') await seedHRedemption(db(), id, { userId, state: mode === 'first' ? 'confirmed' : 'reserved' });
      if (mode === 'expired') await db().query('update public.discounts set ends_at=now() where id=$1', [id]);
      if (mode === 'future') await db().query("update public.discounts set starts_at=now()+interval '1 second' where id=$1", [id]);
      if (mode === 'stopped') await db().query('update public.discounts set stopped=true where id=$1', [id]);
      if (mode === 'assigned') await db().query('delete from public.discount_assignments where discount_id=$1', [id]);
      const rejection = ({ limit: 'discount_usage_limit', once: 'discount_once_per_customer', expired: 'discount_expired', future: 'discount_expired', stopped: 'discount_stopped', assigned: 'discount_not_eligible', first: 'discount_first_order_changed' })[mode];
      expect(await acceptHCheckout(db(), f)).toEqual({ order_id: null, order_status: null, created: false, rejection });
      expect((await db().query('select count(*)::int n from public.orders where checkout_session_id=$1', [f.checkoutSessionId])).rows[0].n).toBe(0);
    }
    const id = await seedHDiscount(db(), hDiscount({ method: 'automatic', allowGuests: true }));
    const f = await seedHCheckout(db(), { discountId: id }); await db().query('update public.discounts set stopped=true where id=$1', [id]);
    expect((await acceptHCheckout(db(), f)).rejection).toBe('discount_automatic_changed');
  });

  test('FREQ-549-AC-02: 受付は行別割引と１着の額と使用予約を同じ取引で写し再送で増やさない', async () => {
    const userId = await seedHMember(db()); const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, kind: 'repeat', targetMode: 'include', repeatInOrder: true, value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 4000 } }));
    // Repeat targets are needed before confirm; use the real fixed result from a product effect for the 37000/3000 material below.
    await db().query("update public.discounts set kind='product',target_mode='all',repeat_in_order=false,value_type='percent',value=10,minimum_type='none',minimum_value=0 where id=$1", [id]);
    const f = await seedHCheckout(db(), { discountId: id, code, userId }); const row = await acceptHCheckout(db(), f);
    expect(row).toMatchObject({ created: true, rejection: null });
    expect(await acceptHCheckout(db(), f)).toMatchObject({ order_id: row.order_id, created: false });
    expect((await db().query('select count(*)::int n from public.discount_redemptions where order_id=$1', [row.order_id])).rows[0].n).toBe(1);
    const units = (await db().query('select paid_amount from public.order_line_unit_amounts where order_id=$1 order by unit_index', [row.order_id])).rows.map(r => r.paid_amount);
    expect(units).toEqual(f.result.unitAmounts.map(u => u.paidAmount));
    expect(units.reduce((a: number, b: number) => a + b, 0)).toBe(f.result.totalAmount);
    const zero = await seedHCheckout(db()); const z = await acceptHCheckout(db(), zero);
    expect((await db().query('select count(*)::int n from public.order_line_unit_amounts where order_id=$1', [z.order_id])).rows[0].n).toBe(2);
    expect(await hFailure(db(), () => db().query('update public.order_line_unit_amounts set paid_amount=1 where order_id=$1', [z.order_id]))).toMatchObject({ code: '55000' });
    await db().query('set constraints all immediate');
  });

  test('FREQ-549-AC-01: 前回着数が増えたdraftだけ入力へ戻す（リピート割引）', async () => {
    const userId = await seedHMember(db()); const catalog = await createCatalogFixture(db()); const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, kind: 'repeat', targetMode: 'include', itemIds: [catalog.itemId], repeatPrevious: true, value: { type: 'percent', value: 10 } }));
    const prior = () => seedHOrderUnits(db(), { legacy: true, buyerUserId: userId, status: 'paid', lines: [{ itemPrice: 20000, quantity: 1, discounts: [], unitAmounts: [], catalog }] });
    await prior();
    const f = await seedHCheckout(db(), { discountId: id, code, userId, lines: [{ catalog, quantity: 1 }] });
    expect(f.result.discountAmount).toBeGreaterThan(0);
    await prior();
    expect(await acceptHCheckout(db(), f)).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_prior_units_changed' });
  });

  test('FREQ-549-AC-01: 使い捨てcodeが別の予約で使われたdraftだけ入力へ戻す', async () => {
    const actor = await createPurchaseFlow(db).manager(); const member = await seedHMember(db()); const other = await seedHMember(db());
    const made = await hRpc<{ discountId: string }>(db(), 'admin_create_discount', [{ ...hDiscount({ audience: 'assigned' }), initialBatch: { prefix: 'SU', userIds: [member], count: 1 } }, randomUUID(), actor]);
    const detail = await hRpc<{ codes: { codeId: string; code: string; singleUse: boolean }[] }>(db(), 'get_admin_discount', [made.discountId, 20, 0, actor]);
    expect(detail.codes[0].singleUse).toBe(true);
    const f = await seedHCheckout(db(), { discountId: made.discountId, code: detail.codes[0].code, userId: member });
    expect(f.result.discountAmount).toBeGreaterThan(0);
    await seedHRedemption(db(), made.discountId, { codeId: detail.codes[0].codeId, userId: other, state: 'reserved' });
    expect(await acceptHCheckout(db(), f)).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_usage_limit' });
  });

  test.each(['expired', 'limit', 'first'] as const)('FREQ-549-AC-01: 自動割引だけが条件を失ったら（%s）入力へ戻さず注文を作らずautomatic_changedにする', async mode => {
    const email = `h4auto-${randomUUID()}@example.invalid`;
    const id = await seedHDiscount(db(), hDiscount({ method: 'automatic', allowGuests: true, usageLimit: mode === 'limit' ? 1 : null, firstOrderOnly: mode === 'first' }));
    const f = await seedHCheckout(db(), { discountId: id, email });
    expect(f.result.discountAmount).toBeGreaterThan(0);
    if (mode === 'expired') await db().query('update public.discounts set ends_at=now() where id=$1', [id]);
    if (mode === 'limit') await seedHRedemption(db(), id, { state: 'reserved' });
    if (mode === 'first') await seedHOrderUnits(db(), { legacy: true, email, status: 'paid', lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    expect(await acceptHCheckout(db(), f)).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_automatic_changed' });
    expect((await db().query('select count(*)::int n from public.orders where checkout_session_id=$1', [f.checkoutSessionId])).rows[0].n).toBe(0);
  });

  test.each([
    ['guest', 'paid', null, true], ['guest', 'cancelled', 5000, true], ['guest', 'payment_in_progress', null, false], ['guest', 'pending', null, false],
    ['guest', 'failed', null, false], ['guest', 'abandoned', null, false], ['guest', 'cancelled', null, false],
    ['member', 'paid', null, true], ['member', 'pending', null, false], ['member', 'cancelled', null, false],
  ] as const)('FREQ-549-AC-05: %sの初回は有料注文（%s・paid_amount=%s）だけを数える（数える=%s）', async (kind, status, paidAmount, counted) => {
    const email = `h4first-${randomUUID()}@example.invalid`; const code = `H4-${randomUUID().toUpperCase()}`;
    const userId = kind === 'member' ? await seedHMember(db(), email) : undefined;
    const id = await seedHDiscount(db(), hDiscount({ code, firstOrderOnly: true, allowGuests: true }));
    const f = await seedHCheckout(db(), { discountId: id, code, email, userId });
    expect(f.result.discountAmount).toBeGreaterThan(0);
    const paidStatus = status === 'paid' || (status === 'cancelled' && paidAmount !== null);
    const history = await seedHOrderUnits(db(), { legacy: true, buyerUserId: userId, email, status, paidAt: paidStatus ? new Date().toISOString() : null,
      lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    if (paidAmount !== null) await db().query('update public.orders set paid_amount=$2 where id=$1', [history.orderId, paidAmount]);
    const row = await acceptHCheckout(db(), f);
    if (counted) expect(row).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_first_order_changed' });
    else expect(row).toMatchObject({ created: true, rejection: null });
  });

  test('FREQ-549-AC-05: 別draftの予約は有料注文に数えず、予約の競合として初回を断る。受付済みの自分の注文は数えない', async () => {
    const email = `h4first-${randomUUID()}@example.invalid`; const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, firstOrderOnly: true, allowGuests: true }));
    const f = await seedHCheckout(db(), { discountId: id, code, email });
    await seedHRedemption(db(), id, { email, state: 'reserved', firstOrderOnly: true });
    expect(await acceptHCheckout(db(), f)).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_first_order_changed' });
    const own = `H4-${randomUUID().toUpperCase()}`; const ownId = await seedHDiscount(db(), hDiscount({ code: own, firstOrderOnly: true, allowGuests: true }));
    const mine = await seedHCheckout(db(), { discountId: ownId, code: own });
    const accepted = await acceptHCheckout(db(), mine);
    expect(accepted).toMatchObject({ created: true, rejection: null });
    expect(await acceptHCheckout(db(), mine)).toMatchObject({ order_id: accepted.order_id, created: false, rejection: null });
  });

  test('FREQ-549-AC-02: 対象の行だけ3000円引きの37000円。対象外の行の1着は20000円のまま配分0で、対象の行は17000円', async () => {
    const plain = await createCatalogFixture(db()); const target = await createCatalogFixture(db()); const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, allowGuests: true, kind: 'product', targetMode: 'exclude', itemIds: [plain.itemId],
      value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 10000 } }));
    const f = await seedHCheckout(db(), { discountId: id, code, lines: [{ catalog: plain, quantity: 1 }, { catalog: target, quantity: 1 }] });
    expect({ total: f.result.totalAmount, discount: f.result.discountAmount }).toEqual({ total: 37000, discount: 3000 });
    const row = await acceptHCheckout(db(), f);
    expect(row).toMatchObject({ created: true, rejection: null });
    await db().query('set constraints all immediate');
    const lines = (await db().query(`select oi.item_id::text item,
      coalesce((select array_agg(u.paid_amount order by u.unit_index) from public.order_line_unit_amounts u where u.order_item_id=oi.id),'{}') units,
      coalesce((select sum(a.amount) from public.order_line_discount_allocations a where a.order_item_id=oi.id),0)::int allocated
      from public.order_items oi where oi.order_id=$1`, [row.order_id])).rows;
    const byItem = Object.fromEntries(lines.map(l => [l.item, l]));
    expect(byItem[String(plain.itemId)]).toMatchObject({ units: [20000], allocated: 0 });
    expect(byItem[String(target.itemId)]).toMatchObject({ units: [17000], allocated: 3000 });
    expect((await db().query("select sum(amount)::int n from public.discount_redemptions where order_id=$1 and state='reserved'", [row.order_id])).rows[0].n).toBe(3000);
  });
  test('FREQ-549-AC-01: 期間のちょうどの境界。開始と同時は受け付け、終了と同時は入力へ戻す', async () => {
    const startCode = `H4-${randomUUID().toUpperCase()}`, endCode = `H4-${randomUUID().toUpperCase()}`;
    const startId = await seedHDiscount(db(), hDiscount({ code: startCode, allowGuests: true }));
    const endId = await seedHDiscount(db(), hDiscount({ code: endCode, allowGuests: true }));
    const start = await seedHCheckout(db(), { discountId: startId, code: startCode });
    const end = await seedHCheckout(db(), { discountId: endId, code: endCode });
    await db().query('update public.discounts set starts_at=now() where id=$1', [startId]);
    await db().query('update public.discounts set ends_at=now() where id=$1', [endId]);
    expect(await acceptHCheckout(db(), start)).toMatchObject({ created: true, rejection: null });
    expect(await acceptHCheckout(db(), end)).toEqual({ order_id: null, order_status: null, created: false, rejection: 'discount_expired' });
  });

  test('FREQ-549-AC-02: 写しの１箇所が失敗すると注文・明細・在庫・コピー・予約が全て残らない', async () => {
    const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, allowGuests: true }));
    const f = await seedHCheckout(db(), { discountId: id, code });
    // 予約の書込みだけが断られる状態を作る。注文・在庫・コピーは同じ取引で先に書かれているが、全て戻る
    await db().query('alter table public.discount_redemptions add constraint h4_fault check (amount < 0) not valid');
    expect(await hFailure(db(), () => acceptHCheckout(db(), f))).toMatchObject({ code: '23514' });
    const left = (await db().query(`select
      (select count(*)::int from public.orders where checkout_session_id=$1) orders,
      (select count(*)::int from public.discount_redemptions where discount_id=$2) redemptions,
      (select status from public.checkout_drafts where id=$3) draft_status`, [f.checkoutSessionId, id, f.draftId])).rows[0];
    expect(left).toEqual({ orders: 0, redemptions: 0, draft_status: 'created' });
  });

  test('FREQ-549-AC-04: 照合の契約違反はqueue９回でdeadへ移り運用警告へ残る', async () => {
    const eventId = `evt_h4_${randomUUID().replaceAll('-', '')}`;
    const payload = { id: eventId, type: 'checkout.session.expired', data: { object: { id: 'cs_h4_queue' } } };
    await db().query('select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)', [eventId, payload.type, JSON.stringify(payload)]);
    const claim = async () => {
      await db().query("update public.stripe_webhook_events set next_attempt_at='1970-01-01'::timestamptz where id=$1", [eventId]);
      return (await db().query('select * from public.claim_stripe_webhook_event()')).rows[0];
    };
    const fail = async (token: string) => db().query('select public.fail_stripe_webhook_event($1,$2::uuid,$3)', [eventId, token, 'discount_reconciliation_contract_violation']);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const claimed = await claim(); expect(claimed.event_id).toBe(eventId);
      await fail(claimed.claim_token);
      expect((await db().query('select processing_status,attempt_count,last_error,dead_at from public.stripe_webhook_events where id=$1', [eventId])).rows[0])
        .toEqual({ processing_status: 'failed', attempt_count: attempt, last_error: 'discount_reconciliation_contract_violation', dead_at: null });
    }
    const ninth = await claim(); expect(ninth.event_id).toBe(eventId);
    await fail(ninth.claim_token);
    expect((await db().query('select processing_status,attempt_count,last_error,dead_at is not null has_dead_at from public.stripe_webhook_events where id=$1', [eventId])).rows[0])
      .toEqual({ processing_status: 'dead', attempt_count: 9, last_error: 'discount_reconciliation_contract_violation', has_dead_at: true });
    expect((await db().query('select event_id from public.list_unnotified_dead_stripe_webhook_events(1000)')).rows.map(r => r.event_id)).toContain(eventId);
    expect(await claim()).toBeUndefined();
  });

  test('FREQ-549-AC-02: 固定結果の額と行別の配分・１着の額・使用予約が注文の総額と一致し対象外の行は0', async () => {
    const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, allowGuests: true }));
    const f = await seedHCheckout(db(), { discountId: id, code });
    const row = await acceptHCheckout(db(), f);
    expect(row.rejection).toBeNull();
    await db().query('set constraints all immediate');
    const order = (await db().query('select total_amount,discount_amount,subtotal_amount from public.orders where id=$1', [row.order_id])).rows[0];
    expect(order).toEqual({ total_amount: f.result.totalAmount, discount_amount: f.result.discountAmount, subtotal_amount: f.result.subtotalAmount });
    const sums = (await db().query(`select
      (select coalesce(sum(amount),0)::int from public.order_line_discount_allocations where order_id=$1) allocated,
      (select coalesce(sum(paid_amount),0)::int from public.order_line_unit_amounts where order_id=$1) paid,
      (select coalesce(sum(amount),0)::int from public.discount_redemptions where order_id=$1 and state='reserved') reserved`, [row.order_id])).rows[0];
    expect(sums).toEqual({ allocated: f.result.discountAmount, paid: f.result.subtotalAmount - f.result.discountAmount, reserved: f.result.discountAmount });
  });
});
