/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  insertOrderWithStockLine,
  movementsOf,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 入金済み・入金待ちにする RPC(設計書 4-1・4-5・⑤)。
 * 今の状態を条件にした更新で、先に動いていれば何もしない。在庫扱いで確保中が0の明細は確保し直し、
 * 足りなければ要確認にする。
 */
async function placeFromDraft(db: PgClient, options: { stock: number; quantity: number }) {
  const fx = await createCatalogFixture(db, { stock: options.stock });
  const draft = await createDraft(db, { itemId: fx.itemId, quantity: options.quantity });
  const res = await db.query(
    `select order_id from public.place_order_from_checkout_draft(
       $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
  return { fx, draft, orderId: res.rows[0].order_id as string };
}

function markPaid(
  db: PgClient,
  args: { orderId: string; expected: string; paymentIntentId: string; amount: number; currency?: string; event?: string },
) {
  return db.query(
    `select updated, amount_matches, needs_review
     from public.mark_order_paid($1::uuid, $2::public.order_status, $3::text, $4::integer, $5::text, $6::text)`,
    [args.orderId, args.expected, args.paymentIntentId, args.amount, args.currency ?? 'jpy', args.event ?? null],
  );
}

function markAwaiting(db: PgClient, args: { orderId: string; paymentIntentId: string; event?: string }) {
  return db.query(
    'select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, $3::text)',
    [args.orderId, args.paymentIntentId, args.event ?? null],
  );
}

async function cartExists(db: PgClient, cartId: string): Promise<boolean> {
  const res = await db.query('select 1 from public.carts where id = $1', [cartId]);
  return res.rowCount > 0;
}

describeLocalDb('integration: 入金済み・入金待ちにする', (db) => {
  test('支払い手続き中を入金済みにし、PaymentIntent を埋め、カートを空にし、履歴に起因イベントを残す', async () => {
    const { draft, orderId } = await placeFromDraft(db(), { stock: 2, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;

    const res = await markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_paid_1' });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'paid', payment_intent_id: pi, review_reason: null });
    expect(await cartExists(db(), draft.cartId)).toBe(false);
    const draftPi = await db().query('select payment_intent_id from public.checkout_drafts where id = $1', [draft.draftId]);
    expect(draftPi.rows[0].payment_intent_id).toBe(pi);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_payment_paid', sourceEventId: 'evt_paid_1', changedBy: null },
    ]);
  });

  test('期待する状態と違えば何もしない(先に動いていた)', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });

    const res = await markPaid(db(), { orderId, expected: 'pending', paymentIntentId: `pi_${uniqueSuffix()}`, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: false, amount_matches: null, needs_review: null });
    expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
  });

  test('支払額が注文と違っても入金済みにし、amount_matches=false を返す', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });

    const res = await markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: `pi_${uniqueSuffix()}`, amount: PRICE - 1 });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: false, needs_review: false });
    expect((await orderRow(db(), orderId)).status).toBe('paid');
  });

  test('失敗の後の入金(⑤)は在庫を確保し直す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const pi = `pi_${uniqueSuffix()}`;
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    await db().query(
      `select released from public.release_stock_for_unpaid_order(
         $1::uuid, 'payment_in_progress', 'failed', 'stripe_voucher_expired')`,
      [orderId],
    );
    expect(await variantStock(db(), fx.variantId)).toBe(2);

    const res = await markPaid(db(), { orderId, expected: 'failed', paymentIntentId: pi, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('確保し直す在庫が足りなければ確保せず、要確認にする', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const pi = (await orderRow(db(), orderId)).payment_intent_id as string;

    const res = await markPaid(db(), { orderId, expected: 'failed', paymentIntentId: pi, amount: PRICE * 2 });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: true });
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'paid', review_reason: 'stock_not_reserved' });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('注文の PaymentIntent と違う PaymentIntent では入金済みにしない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await expect(markPaid(db(), { orderId, expected: 'pending', paymentIntentId: 'pi_other', amount: PRICE }))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('PAYMENT_INTENT_MISMATCH') });
  });

  test('支払い手続き中を入金待ちにし、PaymentIntent を埋めてカートを空にする。2回目は updated=false', async () => {
    const { draft, orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;

    const first = await markAwaiting(db(), { orderId, paymentIntentId: pi, event: 'evt_awaiting_1' });
    const second = await markAwaiting(db(), { orderId, paymentIntentId: pi });

    expect(first.rows[0].updated).toBe(true);
    expect(second.rows[0].updated).toBe(false);
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'pending', payment_intent_id: pi });
    expect(await cartExists(db(), draft.cartId)).toBe(false);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_payment_awaiting', sourceEventId: 'evt_awaiting_1', changedBy: null },
    ]);
  });

  test('入金待ちから入金済みにする', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;
    await markAwaiting(db(), { orderId, paymentIntentId: pi });

    const res = await markPaid(db(), { orderId, expected: 'pending', paymentIntentId: pi, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
  });

  test('Webhook と見回りが別の接続から同時に入金済みにしても、状態の変化は1回、入金確認メールの送信権も1回だけ取れる(設計書 6 の並行)', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;
    const other = await connectLocalDb();
    try {
      const [webhook, sweep] = await Promise.all([
        markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_concurrent_webhook' }),
        markPaid(other, { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_concurrent_sweep' }),
      ]);

      // 後の方は行ロックを待ち、先に入金済みになった注文を見て何もしない
      expect([webhook.rows[0].updated, sweep.rows[0].updated].sort()).toEqual([false, true]);
      const winnerEvent = webhook.rows[0].updated ? 'evt_concurrent_webhook' : 'evt_concurrent_sweep';
      expect((await orderRow(db(), orderId)).status).toBe('paid');
      expect(await revisionsOf(db(), orderId)).toEqual([
        { reason: 'stripe_payment_paid', sourceEventId: winnerEvent, changedBy: null },
      ]);

      const claims = await Promise.all([
        db().query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, 'paid']),
        other.query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, 'paid']),
      ]);
      expect(claims.map((res) => res.rows[0].claimed).sort()).toEqual([false, true]);
    } finally {
      await other.end();
    }
  });

  test('anon・authenticated は実行できない', async () => {
    for (const signature of [
      'public.mark_order_paid(uuid,public.order_status,text,integer,text,text)',
      'public.mark_order_awaiting_payment(uuid,text,text)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(res.rows[0].allowed).toBe(false);
      }
    }
  });
});
