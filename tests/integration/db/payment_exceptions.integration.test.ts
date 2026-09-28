/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  insertOrderWithStockLine,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 要対応の記録と解決・要確認の確認（設計書 4-4・5-2）、メールの種類と移行前の注文（第7章）、
 * 支払額の違いの発送止め（4-1）。
 */
const ACTOR = '00000000-0000-4000-8000-000000000002';

async function record(
  db: PgClient,
  args: { ref: string; reason: string; detail?: string | null; orderId?: string | null },
) {
  const res = await db.query(
    `select exception_id, is_new, is_resolved
     from public.record_payment_exception($1::text, $2::text, $3::text, $1::text, null, null, $4::uuid)`,
    [args.ref, args.reason, args.detail ?? null, args.orderId ?? null],
  );
  return res.rows[0] as { exception_id: string; is_new: boolean; is_resolved: boolean };
}

async function exceptionRow(db: PgClient, id: string) {
  const res = await db.query(
    `select detection_count, resolved_at, resolved_by, resolution_note, shop_notified_at, customer_notified_at
     from public.payment_exceptions where id = $1`,
    [id],
  );
  return res.rows[0];
}

async function claim(db: PgClient, id: string, channel: string): Promise<boolean> {
  const res = await db.query('select public.claim_payment_exception_notification($1::uuid, $2::text) as claimed', [id, channel]);
  return res.rows[0].claimed;
}

async function claimEmail(db: PgClient, orderId: string, kind: string): Promise<boolean> {
  const res = await db.query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, kind]);
  return res.rows[0].claimed;
}

describeLocalDb('integration: 要対応・要確認', (db) => {
  test('同じ支払い・同じ理由は1行にまとめ、検知の回数を数える', async () => {
    const ref = `cs_${uniqueSuffix()}`;
    const first = await record(db(), { ref, reason: 'order_not_creatable', detail: 'item_unavailable' });
    const second = await record(db(), { ref, reason: 'order_not_creatable', detail: 'item_unavailable' });

    expect(first).toMatchObject({ is_new: true, is_resolved: false });
    expect(second).toEqual({ exception_id: first.exception_id, is_new: false, is_resolved: false });
    expect((await exceptionRow(db(), first.exception_id)).detection_count).toBe(2);
  });

  test('理由と補足コードは決まった形だけ入る', async () => {
    await expect(record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'other' })).rejects.toMatchObject({ code: '23514' });
    await expect(
      record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', detail: 'hanako@example.com' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('通知の送信権は1回だけ取れ、戻すともう一度取れる', async () => {
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict' });

    expect(await claim(db(), id, 'shop')).toBe(true);
    expect(await claim(db(), id, 'shop')).toBe(false);
    await db().query('select public.release_payment_exception_notification($1::uuid, $2::text)', [id, 'shop']);
    expect(await claim(db(), id, 'shop')).toBe(true);
    expect(await claim(db(), id, 'customer')).toBe(true);
  });

  test('解決すると実行者とメモが残り、同じ要対応をもう一度解決すると resolved=false', async () => {
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'unexpected_state' });

    const first = await db().query(
      'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
      [id, ACTOR, 'Stripe で確認済み'],
    );
    const second = await db().query(
      'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
      [id, ACTOR, null],
    );

    expect(first.rows[0].resolved).toBe(true);
    expect(second.rows[0].resolved).toBe(false);
    expect(await exceptionRow(db(), id)).toMatchObject({ resolved_by: ACTOR, resolution_note: 'Stripe で確認済み' });
  });

  test('解決済みの要対応は、再び検知しても開き直さない', async () => {
    const ref = `cs_${uniqueSuffix()}`;
    const { exception_id: id } = await record(db(), { ref, reason: 'stripe_object_missing' });
    await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid)', [id, ACTOR]);

    const again = await record(db(), { ref, reason: 'stripe_object_missing' });

    expect(again).toEqual({ exception_id: id, is_new: false, is_resolved: true });
  });

  // order_revisions.changed_by は auth.users への外部キーなので、実際に orders を更新する
  // (=order_revisions に書く) 5件だけをネストした describe にまとめ、架空の uuid ではなく
  // 実在の行を使う（tests/integration/db/release_stock_by_order.integration.test.ts と同じやり方）。
  // ネストした describe の afterAll は親（describeLocalDb）の afterAll より先に実行されるので、
  // ここに置けば後片付けが接続を閉じる前に必ず終わる。
  describe('要対応の解決・要確認・失敗注文の取消(実行者を使う)', () => {
    let ACTOR: string;

    beforeAll(async () => {
      const user = await db().query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`payment-exceptions-${uniqueSuffix()}@example.com`],
      );
      ACTOR = user.rows[0].id as string;
    });

    afterAll(async () => {
      await db().query('DELETE FROM auth.users WHERE id = $1', [ACTOR]);
    });

  test('「注文を取り消して解決」は未入金の注文を取消にし、確保した分だけ在庫を戻す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'unexpected_state', orderId });

    const res = await db().query(
      `select resolved, order_id, cancelled_from::text as cancelled_from
       from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text, true, 'other', true)`,
      [id, ACTOR, 'Stripe に支払いが無い'],
    );

    expect(res.rows[0]).toEqual({ resolved: true, order_id: orderId, cancelled_from: 'payment_in_progress' });
    expect(await orderRow(db(), orderId)).toMatchObject({
      status: 'cancelled', cancel_reason: 'other', cancel_note: 'Stripe に支払いが無い', cancel_notify_customer: true,
    });
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'resolve_payment_exception', sourceEventId: null, changedBy: ACTOR },
    ]);
  });

  test('「注文を取り消して解決」はメモが要り、入金済みの注文では使えない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const unpaid = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    const paid = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const noNote = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', orderId: unpaid.orderId });
    const paidException = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', orderId: paid.orderId });

    await expect(db().query(
      `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, null, true, 'other', true)`,
      [noNote.exception_id, ACTOR],
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('RESOLUTION_NOTE_REQUIRED') });
    await expect(db().query(
      `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, 'メモ', true, 'other', true)`,
      [paidException.exception_id, ACTOR],
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('ORDER_NOT_CANCELLABLE') });
  });

  test('要確認を確認済みにすると日時と実行者が残り、2回目は false', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    await db().query(
      `update public.orders set review_reason = 'stock_not_reserved', review_marked_at = now() where id = $1`,
      [orderId],
    );

    const first = await db().query('select public.mark_order_reviewed($1::uuid, $2::uuid) as reviewed', [orderId, ACTOR]);
    const second = await db().query('select public.mark_order_reviewed($1::uuid, $2::uuid) as reviewed', [orderId, ACTOR]);

    expect(first.rows[0].reviewed).toBe(true);
    expect(second.rows[0].reviewed).toBe(false);
    expect(await orderRow(db(), orderId)).toMatchObject({ reviewed_by: ACTOR });
  });

  test('支払額の違いの要対応が開いている注文は発送できず、解決すると発送できる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'paid_amount_mismatch', orderId });
    const ship = () => db().query(
      `select id from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678')`,
      [orderId, ACTOR],
    );

    expect((await ship()).rowCount).toBe(0);
    await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)', [id, ACTOR, '差額を返金']);
    expect((await ship()).rowCount).toBe(1);
  });

  test('失敗の注文の取消は理由とメモを残し、「その他」はメモが要る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await expect(db().query(
      `select id from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'other', null)`,
      [orderId, ACTOR],
    )).rejects.toMatchObject({ code: '22023' });

    const res = await db().query(
      `select status::text as status from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'customer_request', '電話で依頼')`,
      [orderId, ACTOR],
    );

    expect(res.rows[0].status).toBe('cancelled');
    expect(await orderRow(db(), orderId)).toMatchObject({
      cancel_reason: 'customer_request', cancel_note: '電話で依頼', cancel_notify_customer: false,
    });
  });
  });

  test('メールの送信権に期限切れと取消が加わる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    expect(await claimEmail(db(), orderId, 'payment_expired')).toBe(true);
    expect(await claimEmail(db(), orderId, 'canceled')).toBe(true);
    await expect(claimEmail(db(), orderId, 'refunded')).rejects.toMatchObject({ code: '23514' });
  });

  test('移行前の未入金の注文（Session ID なし）は、お客様向けメールを送信済みとして登録する', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const legacy = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      checkoutSessionId: null, paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const current = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await db().query('select private.suppress_legacy_unpaid_order_emails()');

    for (const kind of ['awaiting_payment', 'paid', 'payment_expired', 'canceled']) {
      expect(await claimEmail(db(), legacy.orderId, kind)).toBe(false);
    }
    expect(await claimEmail(db(), current.orderId, 'payment_expired')).toBe(true);
  });

  test('表は RLS が有効で、anon・authenticated は表も RPC も使えない', async () => {
    const rls = await db().query(
      `select relrowsecurity from pg_class where oid = 'public.payment_exceptions'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);

    for (const role of ['anon', 'authenticated']) {
      const table = await db().query(
        `select has_table_privilege($1, 'public.payment_exceptions', 'SELECT') as allowed`,
        [role],
      );
      expect(table.rows[0].allowed).toBe(false);

      for (const signature of [
        'public.record_payment_exception(text,text,text,text,text,uuid,uuid)',
        'public.claim_payment_exception_notification(uuid,text)',
        'public.release_payment_exception_notification(uuid,text)',
        'public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
        'public.mark_order_reviewed(uuid,uuid)',
        'public.admin_cancel_failed_order(uuid,uuid,text,text)',
      ]) {
        const fn = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(fn.rows[0].allowed).toBe(false);
      }
    }
  });
});
