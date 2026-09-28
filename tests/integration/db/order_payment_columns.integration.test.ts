/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';

/**
 * 受付を先にする方式の列と制約（グループ A 設計書 4-2）。
 *
 * PaymentIntent は Session の支払いの確定時にできる（Stripe API 2022-08-01 以降）ので、受付の時点では空。
 * 空から値へ1回だけ書け、値が入った後は法定の不変条件トリガーが変更を拒む。
 */
function suffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function insertOrder(
  db: PgClient,
  options: { status: string; checkoutSessionId?: string | null; paymentIntentId?: string | null },
): Promise<string> {
  const res = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, currency)
     values ($1, $2, $3, $4::public.order_status, 1000, 0, 1000, 'jpy')
     returning id`,
    [`cols-${suffix()}`, options.checkoutSessionId ?? null, options.paymentIntentId ?? null, options.status],
  );
  return res.rows[0].id as string;
}

describeLocalDb('integration: 注文の列と制約', (db) => {
  test('PaymentIntent が空の支払い手続き中の注文を作れる', async () => {
    const orderId = await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: `cs_${suffix()}` });
    const res = await db().query('select payment_intent_id from public.orders where id = $1', [orderId]);
    expect(res.rows[0].payment_intent_id).toBeNull();
  });

  test('PaymentIntent は空から値へ1回だけ書け、その後は変えられない', async () => {
    const orderId = await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: `cs_${suffix()}` });

    await db().query('update public.orders set payment_intent_id = $2 where id = $1', [orderId, `pi_${suffix()}`]);

    await expect(
      db().query('update public.orders set payment_intent_id = $2 where id = $1', [orderId, `pi_${suffix()}`]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db().query('update public.orders set payment_intent_id = null where id = $1', [orderId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  test('Session ID は注文ごとに一意で、空は何件でもよい', async () => {
    const sessionId = `cs_${suffix()}`;
    await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: sessionId });
    await expect(
      insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: sessionId }),
    ).rejects.toMatchObject({ code: '23505' });

    await insertOrder(db(), { status: 'pending', paymentIntentId: `pi_${suffix()}` });
    await insertOrder(db(), { status: 'pending', paymentIntentId: `pi_${suffix()}` });
  });

  test('要確認と取消の理由は決まった値だけ入る', async () => {
    const orderId = await insertOrder(db(), { status: 'paid', paymentIntentId: `pi_${suffix()}` });

    await db().query(`update public.orders set review_reason = 'stock_not_reserved' where id = $1`, [orderId]);
    await expect(
      db().query(`update public.orders set review_reason = 'other' where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db().query(`update public.orders set cancel_reason = 'mistake' where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db().query(`update public.orders set cancel_note = repeat('あ', 501) where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('今までの法定の項目（金額など）は変えられないまま', async () => {
    const orderId = await insertOrder(db(), { status: 'paid', paymentIntentId: `pi_${suffix()}` });
    await expect(
      db().query('update public.orders set total_amount = 1 where id = $1', [orderId]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
