/** @jest-environment node */
export {};

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

jest.setTimeout(30000);

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 保留中の第2段階（supabase/pending/harden_order_state_transitions.sql）の確かめ。
 *
 * 注意: beforeAll でこの保留中の SQL をローカル DB に流し、終わっても元へ戻さない。
 * tests/integration/db 全体を流すとき、このファイルより後に動く同じ実行内のテストは、
 * orders・order_items への anon・authenticated の作成・更新・削除の剥奪と、トリガーの検査
 * （変更理由の無い状態の変更・設計書 4-1 の表に無い遷移を拒否する）を受けた DB で動く。
 * 流し終えたら npx supabase db reset でローカル DB を作り直す。
 */
describe('integration: order state transition hardening', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨てのDB以外では実行しない', () => {
      throw new Error('localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/pending/harden_order_state_transitions.sql'),
      'utf8',
    ));
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  async function insertOrder({
    status,
    refundedAmount = 0,
    shippedAt = null,
    shippingComplete = true,
  }: {
    status: 'payment_in_progress' | 'pending' | 'paid' | 'failed' | 'abandoned' | 'cancelled' | 'shipped';
    refundedAmount?: number;
    shippedAt?: string | null;
    shippingComplete?: boolean;
  }) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const result = await client.query(
      `insert into public.orders
         (session_id, payment_intent_id, status, subtotal_amount, shipping_amount,
          total_amount, currency, refunded_amount, refunded_at, shipped_at,
          shipping_email, shipping_full_name, shipping_postal_code,
          shipping_prefecture, shipping_city, shipping_address, shipping_phone)
       values ($1, $2, $3::public.order_status, 1000, 0, 1000, 'jpy', $4,
               case when $4 > 0 then now() else null end, $5,
               'buyer@example.com', '山田太郎', '1000001',
               '東京都', '千代田区', case when $6 then '丸の内1-1' else null end,
               '0312345678')
       returning id`,
      [`state-transition-${suffix}`, `pi_state_transition_${suffix}`, status, refundedAmount, shippedAt, shippingComplete],
    );
    return result.rows[0].id as string;
  }

  test('authenticated cannot update orders or execute transition RPCs', async () => {
    const privileges = await client.query(
      `select has_table_privilege('authenticated', 'public.orders', 'UPDATE') as can_update,
              has_function_privilege(
                'authenticated',
                'public.admin_cancel_failed_order(uuid,uuid,text,text)',
                'EXECUTE'
              ) as can_cancel,
              has_function_privilege(
                'authenticated',
                'public.admin_ship_paid_order(uuid,uuid,text,text)',
                'EXECUTE'
              ) as can_ship,
              has_function_privilege(
                'authenticated',
                'public.apply_order_refund_projection(uuid,order_status,integer,timestamp with time zone,integer,timestamp with time zone,timestamp with time zone,uuid)',
                'EXECUTE'
              ) as can_project_refund,
              has_function_privilege(
                'service_role',
                'public.admin_cancel_failed_order(uuid,uuid,text,text)',
                'EXECUTE'
              ) as service_can_cancel,
              has_function_privilege(
                'service_role',
                'public.admin_ship_paid_order(uuid,uuid,text,text)',
                'EXECUTE'
              ) as service_can_ship,
              has_function_privilege(
                'service_role',
                'public.apply_order_refund_projection(uuid,order_status,integer,timestamp with time zone,integer,timestamp with time zone,timestamp with time zone,uuid)',
                'EXECUTE'
              ) as service_can_project_refund`,
    );

    expect(privileges.rows[0]).toEqual({
      can_update: false,
      can_cancel: false,
      can_ship: false,
      can_project_refund: false,
      service_can_cancel: true,
      service_can_ship: true,
      service_can_project_refund: true,
    });

    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await expect(
        client.query('update public.orders set status = status where false'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
    }
  });

  test('service role RPC records the authenticated server actor', async () => {
    await client.query('begin');
    try {
      const user = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`state-transition-${Date.now()}@example.com`],
      );
      const actorId = user.rows[0].id as string;
      const orderId = await insertOrder({ status: 'failed' });

      await client.query('set local role service_role');
      const cancelled = await client.query(
        "select * from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'customer_request', null)",
        [orderId, actorId],
      );
      await client.query('reset role');

      expect(cancelled.rows).toEqual([
        expect.objectContaining({ id: orderId, status: 'cancelled' }),
      ]);
      const revision = await client.query(
        `select changed_by, reason
         from public.order_revisions
         where order_id = $1
         order by id desc
         limit 1`,
        [orderId],
      );
      expect(revision.rows[0]).toEqual({
        changed_by: actorId,
        reason: 'admin_cancel_failed_order',
      });
    } finally {
      await client.query('rollback');
    }
  });

  test('shipping and refund projection RPCs execute with service-role-only transitions', async () => {
    await client.query('begin');
    try {
      const user = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`state-rpcs-${Date.now()}@example.com`],
      );
      const actorId = user.rows[0].id as string;
      const shippingOrderId = await insertOrder({ status: 'paid' });
      const refundOrderId = await insertOrder({ status: 'paid' });
      const legacyCancelledId = await insertOrder({ status: 'cancelled' });
      const firstProjectionAt = '2026-09-22T00:00:00.000Z';
      const secondProjectionAt = '2026-09-22T00:01:00.000Z';

      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_ship_paid_order(
           $1::uuid, $2::uuid, 'yamato'::text, 'TRACK-123'::text
         )`,
        [shippingOrderId, actorId],
      );
      const fullyRefunded = await client.query(
        `select * from public.apply_order_refund_projection(
           $1::uuid,
           'paid'::public.order_status,
           0,
           null::timestamptz,
           1000,
           now(),
           $3::timestamptz,
           $2::uuid
         )`,
        [refundOrderId, actorId, firstProjectionAt],
      );
      const restored = await client.query(
        `select * from public.apply_order_refund_projection(
           $1::uuid,
           'cancelled'::public.order_status,
           1000,
           $3::timestamptz,
           200,
           now(),
           $4::timestamptz,
           $2::uuid
         )`,
        [refundOrderId, actorId, firstProjectionAt, secondProjectionAt],
      );
      const legacyProjection = await client.query(
        `select * from public.apply_order_refund_projection(
           $1::uuid,
           'cancelled'::public.order_status,
           0,
           null::timestamptz,
           100,
           now(),
           $3::timestamptz,
           $2::uuid
         )`,
        [legacyCancelledId, actorId, firstProjectionAt],
      );
      await client.query('reset role');

      expect(shipped.rows).toEqual([
        expect.objectContaining({ id: shippingOrderId }),
      ]);
      expect(fullyRefunded.rows).toEqual([
        { id: refundOrderId, status: 'cancelled', refunded_amount: 1000 },
      ]);
      expect(restored.rows).toEqual([
        { id: refundOrderId, status: 'paid', refunded_amount: 200 },
      ]);
      expect(legacyProjection.rows).toEqual([]);

      const persisted = await client.query(
        `select id, status::text as status, shipping_carrier, tracking_number
         from public.orders
         where id = any($1::uuid[])
         order by id`,
        [[shippingOrderId, refundOrderId, legacyCancelledId]],
      );
      expect(persisted.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: shippingOrderId,
          status: 'shipped',
          shipping_carrier: 'yamato',
          tracking_number: 'TRACK-123',
        }),
        expect.objectContaining({
          id: refundOrderId,
          status: 'paid',
        }),
        expect.objectContaining({
          id: legacyCancelledId,
          status: 'cancelled',
        }),
      ]));
    } finally {
      await client.query('rollback');
    }
  });
  test('配送先欠落の paid 注文は RPC と直接 UPDATE の両方で出荷できない', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const orderId = await insertOrder({ status: 'paid', shippingComplete: false });
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`shipping-hold-${Date.now()}@example.com`],
      );

      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_ship_paid_order(
          $1::uuid, $2::uuid, 'yamato'::text, 'TRACK-123'::text
        )`,
        [orderId, actor.rows[0].id],
      );
      expect(shipped.rows).toEqual([]);
      await client.query('reset role');

      await client.query('savepoint before_direct_ship');
      await expect(
        client.query(
          `update public.orders
           set status = 'shipped'::public.order_status, shipped_at = now()
           where id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_SHIPPING_ADDRESS_INCOMPLETE') });
      await client.query('rollback to savepoint before_direct_ship');
    } finally {
      await client.query('rollback');
    }
  });
  test('failed cancellation loses atomically when payment wins the row race', async () => {
    const actor = await client.query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
       returning id`,
      [`state-race-${Date.now()}@example.com`],
    );
    const orderId = await insertOrder({ status: 'failed' });
    const racer = new Client({ connectionString: DATABASE_URL });
    await racer.connect();

    try {
      await client.query('begin');
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      await client.query(
        `update public.orders set status = 'paid'::public.order_status where id = $1`,
        [orderId],
      );

      const cancelPromise = racer.query(
        "select * from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'customer_request', null)",
        [orderId, actor.rows[0].id],
      );
      await client.query('commit');
      const cancelled = await cancelPromise;

      expect(cancelled.rows).toEqual([]);
      const current = await racer.query('select status::text as status from public.orders where id = $1', [orderId]);
      expect(current.rows[0].status).toBe('paid');
    } finally {
      await client.query('rollback').catch(() => undefined);
      await racer.end();
    }
  });

  test('trigger rejects unpaid cancellation and allows cancellation with a full refund', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const orderId = await insertOrder({ status: 'paid' });
      await client.query('savepoint before_invalid_cancel');
      await expect(
        client.query(
          `update public.orders set status = 'cancelled'::public.order_status where id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('PAID_ORDER_REQUIRES_FULL_REFUND_BEFORE_CANCELLATION'),
      });
      await client.query('rollback to savepoint before_invalid_cancel');

      const valid = await client.query(
        `update public.orders
         set status = 'cancelled'::public.order_status,
             refunded_amount = total_amount,
             refunded_at = now()
         where id = $1
         returning status::text as status, refunded_amount`,
        [orderId],
      );
      expect(valid.rows[0]).toEqual({ status: 'cancelled', refunded_amount: 1000 });
    } finally {
      await client.query('rollback');
    }
  });

  test('failed full refund must restore paid or shipped, while unpaid cancellations remain unchanged', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const paidRestoreId = await insertOrder({ status: 'cancelled', refundedAmount: 1000 });
      await client.query('savepoint before_invalid_restore');
      await expect(
        client.query(
          `update public.orders set refunded_amount = 200, status = 'cancelled'::public.order_status
           where id = $1`,
          [paidRestoreId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('rollback to savepoint before_invalid_restore');

      const paidRestored = await client.query(
        `update public.orders set refunded_amount = 200, status = 'paid'::public.order_status
         where id = $1 returning status::text as status`,
        [paidRestoreId],
      );
      expect(paidRestored.rows[0].status).toBe('paid');

      const shippedRestoreId = await insertOrder({
        status: 'cancelled',
        refundedAmount: 1000,
        shippedAt: new Date().toISOString(),
      });
      const shippedRestored = await client.query(
        `update public.orders set refunded_amount = 200, status = 'shipped'::public.order_status
         where id = $1 returning status::text as status`,
        [shippedRestoreId],
      );
      expect(shippedRestored.rows[0].status).toBe('shipped');

      const unpaidCancelledId = await insertOrder({ status: 'cancelled' });
      const unchanged = await client.query(
        `update public.orders set payment_status_updated_at = now()
         where id = $1 returning status::text as status`,
        [unpaidCancelledId],
      );
      expect(unchanged.rows[0].status).toBe('cancelled');
    } finally {
      await client.query('rollback');
    }
  });

  test('RPC を通らない状態の変更（変更理由なし）は拒否する', async () => {
    await client.query('begin');
    try {
      const orderId = await insertOrder({ status: 'pending' });
      await expect(
        client.query(`update public.orders set status = 'failed'::public.order_status where id = $1`, [orderId]),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_CHANGE_REQUIRES_REASON') });
    } finally {
      await client.query('rollback');
    }
  });

  test('設計書 4-1 の表に無い遷移は拒否する', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const orderId = await insertOrder({ status: 'abandoned' });
      await expect(
        client.query(`update public.orders set status = 'paid'::public.order_status where id = $1`, [orderId]),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_TRANSITION_NOT_ALLOWED') });
    } finally {
      await client.query('rollback');
    }
  });

  test('authenticated は注文と明細を直接作れず、消せない', async () => {
    const privileges = await client.query(
      `select has_table_privilege('authenticated', 'public.orders', 'INSERT') as orders_insert,
              has_table_privilege('authenticated', 'public.orders', 'DELETE') as orders_delete,
              has_table_privilege('authenticated', 'public.order_items', 'INSERT') as items_insert,
              has_table_privilege('authenticated', 'public.order_items', 'UPDATE') as items_update,
              has_table_privilege('authenticated', 'public.order_items', 'DELETE') as items_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      orders_insert: false,
      orders_delete: false,
      items_insert: false,
      items_update: false,
      items_delete: false,
    });
  });
});

