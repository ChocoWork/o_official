/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { acceptHCheckout, hDiscount, hFailure, seedHCheckout, seedHDiscount, seedHMember, seedHRedemption } from './helpers/group-h-fixtures';

describeLocalDb('H4 redemption lifecycle (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  const states = async (id: string | null) => (await db().query('select state,attention_kind,reconciliation_fallback from public.discount_redemptions where order_id=$1', [id])).rows;
  async function fixture() { const code = `H4-${randomUUID().toUpperCase()}`; const id = await seedHDiscount(db(), hDiscount({ code, allowGuests: true, usageLimit: 1 })); return { id, f: await seedHCheckout(db(), { discountId: id, code }) }; }
  async function paid(orderId: string | null, amount: number, pi: string) { await db().query("select * from public.mark_order_paid($1,'pending',$3,$2,'jpy',true,'payment_received')", [orderId, amount, pi]); }

  test('FREQ-549-AC-03: pendingは予約を保ち未入金放棄は取消しpaid後の返品は確定のまま', async () => {
    const { f } = await fixture(); const row = await acceptHCheckout(db(), f);
    await db().query('select * from public.mark_order_awaiting_payment($1,$2)', [row.order_id, f.paymentIntentId]);
    expect(await states(row.order_id)).toMatchObject([{ state: 'reserved', attention_kind: null }]);
    await paid(row.order_id, f.result.totalAmount, f.paymentIntentId);
    await db().query("select * from public.release_stock_for_unpaid_order($1,'pending','failed','stripe_voucher_expired')", [row.order_id]);
    expect(await states(row.order_id)).toMatchObject([{ state: 'confirmed' }]);
    // A separate unpaid reservation is cancelled, and an expire/paid reordering cannot restore an unpaid count.
    const other = await seedHCheckout(db()); const z = await acceptHCheckout(db(), other);
    await db().query("select * from public.release_stock_for_unpaid_order($1,'payment_in_progress','abandoned','stripe_checkout_expired')", [z.order_id]);
    expect(await states(z.order_id)).toEqual([]);
  });

  test('FREQ-549-AC-04: 受付を通らない入金待ちは割引条件が変わっても注文を作り予約する', async () => {
    const { id, f } = await fixture(); await seedHRedemption(db(), id, { state: 'confirmed' });
    await db().query('update public.discounts set stopped=true,ends_at=now() where id=$1', [id]);
    const row = await acceptHCheckout(db(), f, 'awaiting_payment');
    expect(row).toMatchObject({ order_status: 'payment_in_progress', rejection: null });
    // 照合は作った注文をそのまま入金待ちにする。pendingメールは１通だけで、order_not_creatableの要対応は作らない
    await db().query('select * from public.mark_order_awaiting_payment($1,$2)', [row.order_id, f.paymentIntentId]);
    expect((await db().query("select count(*)::int n from private.order_email_outbox where order_id=$1 and kind='awaiting_payment'", [row.order_id])).rows[0].n).toBe(1);
    expect((await db().query('select count(*)::int n from public.payment_exceptions where payment_ref=$1', [f.checkoutSessionId])).rows[0].n).toBe(0);
    expect(await states(row.order_id)).toMatchObject([{ state: 'reserved', attention_kind: null, reconciliation_fallback: true }]);
    await paid(row.order_id, f.result.totalAmount, f.paymentIntentId);
    expect(await states(row.order_id)).toMatchObject([{ state: 'confirmed', attention_kind: 'discount_limit_exceeded' }]);
    expect(await acceptHCheckout(db(), f, 'paid')).toMatchObject({ order_id: row.order_id, created: false });
    expect(await states(row.order_id)).toHaveLength(1);
  });

  test.each(['paid', 'awaiting_payment'] as const)('FREQ-549-AC-04: 照合の%sは現在の割引条件で拒否せず、未知の額と別の通貨は従来の拒否で返す', async state => {
    const { id, f } = await fixture(); await seedHRedemption(db(), id, { state: 'confirmed' });
    await db().query('update public.discounts set stopped=true,ends_at=now() where id=$1', [id]);
    await db().query('savepoint h4_wrong_amount');
    await db().query('set local role service_role');
    const call = (total: number, currency: string) => db().query(
      "select * from public.place_reconciled_order_from_checkout_draft($1,$2,$3,$4,$5,$6,now(),$8,$7)",
      [f.draftId, f.checkoutSessionId, f.sessionId, total, f.result.discountAmount, currency, state, f.paymentIntentId]);
    expect((await call(f.result.totalAmount + 1, 'jpy')).rows[0]).toMatchObject({ order_id: null, rejection: 'amount_mismatch' });
    expect((await call(f.result.totalAmount, 'usd')).rows[0]).toMatchObject({ order_id: null, rejection: 'currency_mismatch' });
    await db().query('rollback to savepoint h4_wrong_amount');
    expect(await acceptHCheckout(db(), f, state)).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
  });

  test('FREQ-549-AC-04: 予約なしと取消後の入金は超過でも確定し要対応だけを１件出す', async () => {
    const { id, f } = await fixture(); await db().query('update public.discounts set stopped=true where id=$1', [id]);
    const row = await acceptHCheckout(db(), f, 'paid');
    expect(row.order_status).toBe('payment_in_progress');
    await db().query("select * from public.mark_order_paid($1,'payment_in_progress',$3,$2,'jpy',true,'payment_received')", [row.order_id, f.result.totalAmount, f.paymentIntentId]);
    expect(await states(row.order_id)).toMatchObject([{ state: 'confirmed', attention_kind: 'discount_reconciliation_recovered' }]);
    const second = await fixture(); const placed = await acceptHCheckout(db(), second.f);
    await db().query("select * from public.release_stock_for_unpaid_order($1,'payment_in_progress','failed','stripe_voucher_expired')", [placed.order_id]);
    expect(await states(placed.order_id)).toMatchObject([{ state: 'cancelled', attention_kind: null }]);
    await seedHRedemption(db(), second.id, { state: 'confirmed' });
    await db().query("select * from public.mark_order_paid($1,'failed',$3,$2,'jpy',true,'payment_received_after_expiry')", [placed.order_id, second.f.result.totalAmount, second.f.paymentIntentId]);
    expect(await states(placed.order_id)).toMatchObject([{ state: 'confirmed', attention_kind: 'discount_limit_exceeded' }]);
  });

  test('FREQ-549-AC-03: 割引つきの注文の未入金放棄は予約を取り消して回数を数えず、入金後の期限切れの順違いでも確定のまま', async () => {
    const { id, f } = await fixture();
    const code = (await db().query('select code from public.discount_codes where discount_id=$1', [id])).rows[0].code as string;
    // 上限1の割引を、まだ誰も予約していない間に3つの draft へ固定する
    const blocked = await seedHCheckout(db(), { discountId: id, code });
    const paidFirst = await seedHCheckout(db(), { discountId: id, code });
    const abandon = (orderId: string | null) => db().query("select * from public.release_stock_for_unpaid_order($1,'payment_in_progress','abandoned','stripe_checkout_expired')", [orderId]);
    const row = await acceptHCheckout(db(), f);
    expect(await states(row.order_id)).toMatchObject([{ state: 'reserved', attention_kind: null }]);
    // 予約の間は次の受付が断られ、放棄で取り消すと数えなくなり次が通る
    expect(await acceptHCheckout(db(), blocked)).toMatchObject({ order_id: null, rejection: 'discount_usage_limit' });
    await abandon(row.order_id);
    expect(await states(row.order_id)).toMatchObject([{ state: 'cancelled', attention_kind: null }]);
    const next = await acceptHCheckout(db(), blocked);
    expect(next).toMatchObject({ created: true, rejection: null });
    await abandon(next.order_id);
    // 入金が先に来た注文は、遅れて来た期限切れで取り消されず確定のまま
    const second = await acceptHCheckout(db(), paidFirst);
    await db().query("select * from public.mark_order_paid($1,'payment_in_progress',$3,$2,'jpy',true,'payment_received')", [second.order_id, paidFirst.result.totalAmount, paidFirst.paymentIntentId]);
    await db().query("select * from public.release_stock_for_unpaid_order($1,'payment_in_progress','failed','stripe_voucher_expired')", [second.order_id]);
    expect(await states(second.order_id)).toMatchObject([{ state: 'confirmed' }]);
  });
  test('FREQ-549-AC-04: 照合の注文は持ち主を付けず、会員のredemptionは本人の鍵を保つ。削除済みの会員でも注文は作られる', async () => {
    const userId = await seedHMember(db()); const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code }));
    const f = await seedHCheckout(db(), { discountId: id, code, userId });
    const row = await acceptHCheckout(db(), f, 'paid');
    expect(row).toMatchObject({ created: true, rejection: null });
    expect((await db().query('select user_id from public.orders where id=$1', [row.order_id])).rows[0].user_id).toBeNull();
    expect((await db().query('select user_id,identity_key from public.discount_redemptions where order_id=$1', [row.order_id])).rows).toEqual([{ user_id: userId, identity_key: `member:${userId}` }]);
    // 確認の後に退会した会員。カートの紐付けを外してから auth のユーザーを消し、draft の buyer_user_id は残す（FK なしの列）
    const goneId = await seedHMember(db()); const code2 = `H4-${randomUUID().toUpperCase()}`;
    const id2 = await seedHDiscount(db(), hDiscount({ code: code2 }));
    const gone = await seedHCheckout(db(), { discountId: id2, code: code2, userId: goneId });
    await db().query("update public.carts set user_id=null,guest_token_hash=md5($2)||md5($2||'x') where user_id=$1", [goneId, 'h4-gone-' + randomUUID()]);
    await db().query('delete from auth.users where id=$1', [goneId]);
    const created = await acceptHCheckout(db(), gone, 'paid');
    expect(created).toMatchObject({ created: true, rejection: null });
    expect((await db().query('select user_id,identity_key from public.discount_redemptions where order_id=$1', [created.order_id])).rows).toEqual([{ user_id: null, identity_key: `member:${goneId}` }]);
  });

  test.each(['paid', 'awaiting_payment'] as const)('FREQ-549-AC-04: 照合の%sは初回・前回着数・割当の変更でも拒否せず注文を作る', async state => {
    const userId = await seedHMember(db()); const code = `H4-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ code, firstOrderOnly: true, audience: 'assigned', userIds: [userId] }));
    const f = await seedHCheckout(db(), { discountId: id, code, userId });
    await seedHRedemption(db(), id, { userId, state: 'confirmed' });
    await db().query('delete from public.discount_assignments where discount_id=$1', [id]);
    expect(await acceptHCheckout(db(), f, state)).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
  });

  test.each(['anon', 'authenticated'])('FREQ-549-AC-04: %sは照合入口を実行できずstateはpaidとawaitingだけ', async role => {
    const { f } = await fixture();
    expect(await hFailure(db(), async () => { await db().query(`set local role ${role}`); await db().query('select * from public.place_reconciled_order_from_checkout_draft($1,$2,$3,36000,4000,\'jpy\',now(),\'pi_h4test\',\'paid\')', [f.draftId, f.checkoutSessionId, f.sessionId]); })).toMatchObject({ code: '42501' });
    expect(await hFailure(db(), () => db().query('select * from public.place_reconciled_order_from_checkout_draft($1,$2,$3,36000,4000,\'jpy\',now(),\'pi_h4test\',\'unpaid\')', [f.draftId, f.checkoutSessionId, f.sessionId]))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
  });
});
