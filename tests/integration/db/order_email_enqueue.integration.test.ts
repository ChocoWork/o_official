/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithStockLine, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 注文の状態を変える DB の関数が、同じ取引で「注文のメール」の行を書く（グループ D 設計書 3-1・7-3）。
 * 行は注文ごとに確かめるので、ほかの試験の行とは混ざらない。
 */
jest.setTimeout(30000);

async function createActor(db: PgClient): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`order-email-enqueue-${uniqueSuffix()}@example.com`],
  );
  return res.rows[0].id as string;
}

async function createOrder(db: PgClient, status: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const { orderId } = await insertOrderWithStockLine(db, {
    status, itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
  });
  return orderId;
}

async function emailsOf(db: PgClient, orderId: string): Promise<Array<{ kind: string; variant: string | null; origin: string; status: string }>> {
  const res = await db.query(
    'select kind, variant, origin, status from private.order_email_outbox where order_id = $1 order by seq',
    [orderId],
  );
  return res.rows;
}

function markPaid(
  db: PgClient,
  orderId: string,
  expected: string,
  options: { amount?: number; notify?: boolean | null; variant?: string | null } = {},
) {
  return db.query(
    `select updated, amount_matches
     from public.mark_order_paid($1::uuid, $2::public.order_status, $3::text, $4::integer, 'jpy', $5::boolean, $6::text, null)`,
    [orderId, expected, `pi_${uniqueSuffix()}`, options.amount ?? PRICE, options.notify === undefined ? true : options.notify,
      options.variant === undefined ? 'order_confirmed' : options.variant],
  );
}

/** 発送できる入金済みの注文（在庫の品1つ） */
async function createShippableOrder(db: PgClient): Promise<{ orderId: string; orderItemId: string }> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  return insertOrderWithStockLine(db, {
    status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
  });
}

/** 全部の商品を1回で送る（グループ E-1 の発送の関数） */
function shipAll(
  db: PgClient,
  order: { orderId: string; orderItemId: string },
  actor: string,
  carrier: string,
  tracking: string,
  notify: boolean,
) {
  return db.query(
    'select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), $3, $4, $5, $6::jsonb)',
    [order.orderId, actor, carrier, tracking, notify, JSON.stringify([{ order_item_id: order.orderItemId, quantity: 1 }])],
  );
}

describeLocalDb('integration: 状態を変える関数が注文のメールの行を書く', (db) => {
  test('入金済みにすると、注文確認の行を書く。2回目は状態が変わらないので書かない', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    expect((await markPaid(db(), orderId, 'payment_in_progress')).rows[0]).toEqual({ updated: true, amount_matches: true });
    expect((await markPaid(db(), orderId, 'payment_in_progress')).rows[0].updated).toBe(false);

    expect(await emailsOf(db(), orderId)).toEqual([{ kind: 'paid', variant: 'order_confirmed', origin: 'auto', status: 'pending' }]);
  });

  test('取引を取り消すと、状態の変更と一緒に行も残らない', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    await db().query('begin');
    await markPaid(db(), orderId, 'payment_in_progress');
    await db().query('rollback');

    expect(await emailsOf(db(), orderId)).toEqual([]);
  });

  test('金額が違う・お客様に送らない（全額返金済み）ときは書かない', async () => {
    const mismatch = await createOrder(db(), 'payment_in_progress');
    const refunded = await createOrder(db(), 'payment_in_progress');

    await markPaid(db(), mismatch, 'payment_in_progress', { amount: PRICE - 1 });
    await markPaid(db(), refunded, 'payment_in_progress', { notify: false });

    expect(await emailsOf(db(), mismatch)).toEqual([]);
    expect(await emailsOf(db(), refunded)).toEqual([]);
  });

  test('「送るか」と書き分けは省けない。知らない書き分けは断る', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');
    await expect(markPaid(db(), orderId, 'payment_in_progress', { notify: null })).rejects.toMatchObject({ code: '22023' });
    await expect(markPaid(db(), orderId, 'payment_in_progress', { variant: null })).rejects.toMatchObject({ code: '22023' });
    await expect(markPaid(db(), orderId, 'payment_in_progress', { variant: 'refund' })).rejects.toMatchObject({ code: '22023' });
    await expect(
      db().query("select * from public.mark_order_paid($1::uuid, 'payment_in_progress', 'pi_x', 5000, 'jpy', 'evt_x')", [orderId]),
    ).rejects.toMatchObject({ code: '42883' });
  });

  test('期限切れの後の入金は、その書き分けで書く', async () => {
    const orderId = await createOrder(db(), 'failed');

    await markPaid(db(), orderId, 'failed', { variant: 'payment_received_after_expiry' });

    expect(await emailsOf(db(), orderId)).toEqual([
      { kind: 'paid', variant: 'payment_received_after_expiry', origin: 'auto', status: 'pending' },
    ]);
  });

  test('入金待ちにすると入金待ちの行を書く', async () => {
    const orderId = await createOrder(db(), 'payment_in_progress');

    await db().query('select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, null)', [orderId, `pi_${uniqueSuffix()}`]);

    expect(await emailsOf(db(), orderId)).toEqual([{ kind: 'awaiting_payment', variant: null, origin: 'auto', status: 'pending' }]);
  });

  test('期限切れで失敗にすると期限切れの行を書く。放棄では書かない', async () => {
    const expired = await createOrder(db(), 'pending');
    const abandoned = await createOrder(db(), 'payment_in_progress');

    await db().query("select released from public.release_stock_for_unpaid_order($1, 'pending', 'failed', 'stripe_voucher_expired')", [expired]);
    await db().query("select released from public.release_stock_for_unpaid_order($1, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')", [abandoned]);

    expect(await emailsOf(db(), expired)).toEqual([{ kind: 'payment_expired', variant: null, origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), abandoned)).toEqual([]);
  });

  test.each([
    ['payment_in_progress', true, [{ kind: 'canceled', variant: 'payment_in_progress', origin: 'auto', status: 'pending' }]],
    ['pending', true, [{ kind: 'canceled', variant: 'pending', origin: 'auto', status: 'pending' }]],
    ['pending', false, []],
  ])('%s の注文の取消は、知らせる(%s)時だけ前の状態の書き分けで書く', async (from, notify, expected) => {
    const actor = await createActor(db());
    const orderId = await createOrder(db(), from);

    await db().query(
      `select released from public.release_stock_for_unpaid_order($1, $2::public.order_status, 'cancelled', 'admin_cancel', $3, null, 'customer_request', null, $4)`,
      [orderId, from, actor, notify],
    );

    expect(await emailsOf(db(), orderId)).toEqual(expected);
  });

  test('要対応の「注文を取り消して解決」も、知らせる時だけ取消の行を書く', async () => {
    const actor = await createActor(db());
    const notified = await createOrder(db(), 'pending');
    const silent = await createOrder(db(), 'pending');

    for (const [orderId, notify] of [[notified, true], [silent, false]] as const) {
      const exception = await db().query(
        `select exception_id from public.record_payment_exception(
           _payment_ref => $1, _reason => 'state_conflict', _detail => null, _checkout_session_id => null,
           _payment_intent_id => null, _draft_id => null, _order_id => $2)`,
        [`cs_enqueue_${uniqueSuffix()}`, orderId],
      );
      await db().query(
        `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, 'お客様の依頼', true, 'customer_request', $3)`,
        [exception.rows[0].exception_id, actor, notify],
      );
    }

    expect(await emailsOf(db(), notified)).toEqual([{ kind: 'canceled', variant: 'pending', origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), silent)).toEqual([]);
  });

  test('発送は「発送のメールを送る」の時だけ、その発送の行を書き、履歴に配送業者と伝票番号が出る', async () => {
    const actor = await createActor(db());
    const notified = await createShippableOrder(db());
    const silent = await createShippableOrder(db());

    const shipped = await shipAll(db(), notified, actor, 'yamato', 'TRK-1', true);
    await shipAll(db(), silent, actor, 'sagawa', 'TRK-2', false);

    expect(shipped.rows).toEqual([expect.objectContaining({ completes_order: true, order_status: 'shipped', replayed: false })]);
    expect(await emailsOf(db(), notified.orderId)).toEqual([{ kind: 'shipped', variant: null, origin: 'auto', status: 'pending' }]);
    expect(await emailsOf(db(), silent.orderId)).toEqual([]);
    const linked = await db().query(
      "select fulfillment_id from private.order_email_outbox where order_id = $1 and kind = 'shipped'",
      [notified.orderId],
    );
    expect(linked.rows).toEqual([{ fulfillment_id: shipped.rows[0].fulfillment_id }]);
    const history = await db().query(
      'select to_status, shipping_carrier, tracking_number from public.list_order_status_history($1)',
      [notified.orderId],
    );
    expect(history.rows).toEqual([{ to_status: 'shipped', shipping_carrier: 'yamato', tracking_number: 'TRK-1' }]);
  });

  test('発送の関数は「送るか」を省くと断る', async () => {
    const actor = await createActor(db());
    const { orderId, orderItemId } = await createShippableOrder(db());
    const lines = JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }]);

    await expect(
      db().query(
        "select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRK-3', null, $3::jsonb)",
        [orderId, actor, lines],
      ),
    ).rejects.toMatchObject({ code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });
    await expect(
      db().query(
        "select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRK-3', $3::jsonb)",
        [orderId, actor, lines],
      ),
    ).rejects.toMatchObject({ code: '42883' });
  });

  test('古い送信権の表と関数は無い', async () => {
    const res = await db().query(
      `select to_regclass('private.order_emails') as claims,
              to_regprocedure('public.claim_order_email(uuid,text)') as claim,
              to_regprocedure('public.release_order_email(uuid,text)') as release,
              to_regprocedure('private.suppress_legacy_unpaid_order_emails()') as suppress,
              to_regprocedure('public.mark_order_paid(uuid,public.order_status,text,integer,text,text)') as old_mark_paid,
              to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text)') as old_ship,
              to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text,boolean)') as ship_paid`,
    );
    expect(res.rows[0]).toEqual({
      claims: null, claim: null, release: null, suppress: null, old_mark_paid: null, old_ship: null, ship_paid: null,
    });
  });

  test('作り直した関数は anon・authenticated が呼べず、service_role だけが呼べる', async () => {
    const signatures = [
      'public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
      'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
      'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    ];
    for (const signature of signatures) {
      const res = await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
        [signature],
      );
      expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
    }
  });
});
