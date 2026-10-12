/** @jest-environment node */
export {};
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';

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

  /** 発送の関数は商品の行が要るので、注文に在庫の品を1つ足す（色・サイズの無い商品には、トリガーがバリアントを1つ作る） */
  async function insertOrderItem(orderId: string): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'state transition', 1000, 'TOPS', '/images/test.jpg', 'published')
       returning id`,
      [`state-transition-${suffix}`],
    );
    const variant = await client.query('select id from public.item_variants where item_id = $1 limit 1', [item.rows[0].id]);
    const line = await client.query(
      `insert into public.order_items
         (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
       values ($1, $2, $3, 'state transition', 1000, 1, 1000, 'stock')
       returning id`,
      [orderId, item.rows[0].id, variant.rows[0].id],
    );
    return line.rows[0].id as string;
  }

  /** 返金の記録は関数だけが書く（service_role は読むだけ）ので、service_role に切り替える前に、返事待ちの記録を直に入れる */
  async function insertRefundRecord(
    orderId: string,
    amount: number,
    actorId: string,
    source: 'admin' | 'auto_cancelled_order_payment' = 'admin',
  ): Promise<string> {
    const refund = await client.query(
      `insert into public.order_refunds
         (order_id, source, request_key, request_fingerprint, status, amount, notify_customer, actor_id)
       values ($1, $2, $3, $4, 'awaiting_response', $5, false, $6)
       returning id`,
      [orderId, source, source === 'admin' ? crypto.randomUUID() : null, source === 'admin' ? 'fixture' : null, amount, actorId],
    );
    return refund.rows[0].id as string;
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
                'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
                'EXECUTE'
              ) as can_ship,
              has_function_privilege(
                'authenticated',
                'public.record_order_refund_result(uuid,text,text,text,text,timestamp with time zone,text,text,text)',
                'EXECUTE'
              ) as can_record_refund,
              has_function_privilege(
                'service_role',
                'public.admin_cancel_failed_order(uuid,uuid,text,text)',
                'EXECUTE'
              ) as service_can_cancel,
              has_function_privilege(
                'service_role',
                'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
                'EXECUTE'
              ) as service_can_ship,
              has_function_privilege(
                'service_role',
                'public.record_order_refund_result(uuid,text,text,text,text,timestamp with time zone,text,text,text)',
                'EXECUTE'
              ) as service_can_record_refund`,
    );

    expect(privileges.rows[0]).toEqual({
      can_update: false,
      can_cancel: false,
      can_ship: false,
      can_record_refund: false,
      service_can_cancel: true,
      service_can_ship: true,
      service_can_record_refund: true,
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

  test('shipping and refund result RPCs execute with service-role-only transitions', async () => {
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
      const shippingItemId = await insertOrderItem(shippingOrderId);
      const refundOrderId = await insertOrder({ status: 'paid' });
      const legacyCancelledId = await insertOrder({ status: 'cancelled' });
      const firstRefundId = await insertRefundRecord(refundOrderId, 800, actorId);
      const secondRefundId = await insertRefundRecord(refundOrderId, 200, actorId);
      const unpaidRefundId = await insertRefundRecord(legacyCancelledId, 100, actorId, 'auto_cancelled_order_payment');
      const recordRefundResult = (refundId: string, status: string) => client.query(
        `select * from public.record_order_refund_result($1::uuid, $2::text, $3::text, null, null, null, 'card', null, null)`,
        [refundId, `re_${refundId.replace(/-/g, '')}`, status],
      );

      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_create_fulfillment(
           $1::uuid, $2::uuid, gen_random_uuid(), 'yamato'::text, 'TRACK-123'::text, false, $3::jsonb
         )`,
        [shippingOrderId, actorId, JSON.stringify([{ order_item_id: shippingItemId, quantity: 1 }])],
      );
      await recordRefundResult(firstRefundId, 'succeeded');
      const fullyRefunded = await recordRefundResult(secondRefundId, 'succeeded');
      const restored = await recordRefundResult(firstRefundId, 'failed');
      const unpaidRefunded = await recordRefundResult(unpaidRefundId, 'succeeded');
      await client.query('reset role');

      expect(shipped.rows).toEqual([
        expect.objectContaining({ completes_order: true, order_status: 'shipped', replayed: false }),
      ]);
      expect(fullyRefunded.rows).toEqual([
        expect.objectContaining({ order_status: 'cancelled', refunded_amount: 1000 }),
      ]);
      expect(restored.rows).toEqual([
        expect.objectContaining({ order_status: 'paid', refunded_amount: 200 }),
      ]);
      expect(unpaidRefunded.rows).toEqual([
        expect.objectContaining({ order_status: 'cancelled', refunded_amount: 100 }),
      ]);

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
      const orderItemId = await insertOrderItem(orderId);
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`shipping-hold-${Date.now()}@example.com`],
      );

      // 発送の関数は断る（前の関数は0行を返していた）。断りで取引が止まらないよう、退避点の中で呼ぶ
      await client.query('savepoint before_rpc_ship');
      await client.query('set local role service_role');
      await expect(
        client.query(
          `select * from public.admin_create_fulfillment(
            $1::uuid, $2::uuid, gen_random_uuid(), 'yamato'::text, 'TRACK-123'::text, false, $3::jsonb
          )`,
          [orderId, actor.rows[0].id, JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }])],
        ),
      ).rejects.toMatchObject({ code: '22023', message: 'SHIPPING_ADDRESS_INCOMPLETE' });
      await client.query('rollback to savepoint before_rpc_ship');

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

  test('発送の取消だけが、発送済みから決済完了へ戻せる（グループ E-1 設計書 7-3）', async () => {
    await client.query('begin');
    try {
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`fulfillment-cancel-${Date.now()}@example.com`],
      );
      const actorId = actor.rows[0].id as string;
      const orderId = await insertOrder({ status: 'paid' });
      const orderItemId = await insertOrderItem(orderId);
      const lines = JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }]);

      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRACK-9', false, $3::jsonb)`,
        [orderId, actorId, lines],
      );
      const cancelled = await client.query(
        'select * from public.admin_cancel_fulfillment($1::uuid, $2::uuid, $3::uuid)',
        [orderId, shipped.rows[0].fulfillment_id, actorId],
      );
      await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRACK-10', false, $3::jsonb)`,
        [orderId, actorId, lines],
      );
      await client.query('reset role');

      expect(shipped.rows).toEqual([expect.objectContaining({ completes_order: true, order_status: 'shipped' })]);
      expect(cancelled.rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);

      // ほかの理由で発送済みから決済完了へ戻すことはできない
      await client.query('savepoint direct_unship');
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      await expect(
        client.query(
          `update public.orders
           set status = 'paid'::public.order_status, shipped_at = null, shipping_carrier = null, tracking_number = null
           where id = $1`,
          [orderId],
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_TRANSITION_NOT_ALLOWED') });
      await client.query('rollback to savepoint direct_unship');
    } finally {
      await client.query('rollback');
    }
  });

  test('残りを返金して発送済みになった注文は、その返金の失敗で発送済みから支払い済みへ戻せる（グループ E-2 設計書 4-7・11-4）', async () => {
    await client.query('begin');
    try {
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`refund-reopen-${Date.now()}@example.com`],
      );
      const actorId = actor.rows[0].id as string;
      const orderId = await insertOrder({ status: 'paid' });
      const shippedItemId = await insertOrderItem(orderId);
      const refundedItemId = await insertOrderItem(orderId);

      await client.query('set local role service_role');
      await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), 'yamato', 'TRACK-11', false, $3::jsonb)`,
        [orderId, actorId, JSON.stringify([{ order_item_id: shippedItemId, quantity: 1 }])],
      );
      await client.query('reset role');
      // 発送の後に、残りの1点を返す返事待ちの記録を所有者のまま直に入れる（先に入れると、返事待ちの品は送れないので発送が注文を完了にする）
      const refundId = await insertRefundRecord(orderId, 500, actorId);
      await client.query(
        `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
         values ($1, $2, 1, true, 'cancel', 500)`,
        [refundId, refundedItemId],
      );
      const recordResult = (status: string) => client.query(
        `select order_status::text as order_status
         from public.record_order_refund_result($1::uuid, $2::text, $3::text, null, null, null, 'card', null, null)`,
        [refundId, `re_${refundId.replace(/-/g, '')}`, status],
      );

      await client.query('set local role service_role');
      const completed = await recordResult('pending');
      const reopened = await recordResult('failed');
      await client.query('reset role');

      expect(completed.rows).toEqual([{ order_status: 'shipped' }]);
      expect(reopened.rows).toEqual([{ order_status: 'paid' }]);
    } finally {
      await client.query('rollback');
    }
  });

  test('保留の守りを適用した DB でも返品の受け取りで交換品を足して shipped から paid へ戻せる', async () => {
    await client.query('begin');
    try {
      const actor = await client.query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
        [`return-exchange-${crypto.randomUUID()}@example.com`],
      );
      const actorId = actor.rows[0].id as string;
      const catalog = await createCatalogFixture(client, { stock: 1 });
      const order = await insertOrderWithLines(client, {
        status: 'paid', paidAmount: 5000, paymentIntentId: `pi_${crypto.randomUUID().replace(/-/g, '')}`,
        lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const orderItemId = order.orderItemIds[0];
      // 返送先は注文作成後に不変な配送先と別の設定。試験の取引だけ設定し、最後に戻す。
      await client.query(
        `update public.shop_return_settings
         set return_address_name = '試験店舗', return_address_postal_code = '1500001',
             return_address_line = '東京都渋谷区神宮前1-1-1', return_address_phone = '0311112222'
         where id = 1`,
      );
      await client.query('set local role service_role');
      const shipped = await client.query(
        `select * from public.admin_create_fulfillment($1::uuid, $2::uuid, $3::uuid, 'yamato', 'RETURN-1', false, $4::jsonb)`,
        [order.orderId, actorId, crypto.randomUUID(), JSON.stringify([{ order_item_id: orderItemId, quantity: 1 }])],
      );
      expect(shipped.rows[0]).toMatchObject({ order_status: 'shipped', completes_order: true });
      const created = await client.query(
        `select * from public.admin_create_return($1::uuid, $2::uuid, $3::uuid, $4::jsonb,
          'customer_ships', 'customer', null, null, 0, 0, 0, 0, null, false)`,
        [order.orderId, actorId, crypto.randomUUID(), JSON.stringify([{
          fulfillment_id: shipped.rows[0].fulfillment_id, order_item_id: orderItemId, quantity: 1,
          reason: 'unknown', reason_note: null, resolution: 'exchange',
          exchange_variant_id: catalog.variantId, exchange_method: 'make',
        }])],
      );
      const returnId = created.rows[0].return_id as string;
      await client.query('reset role');
      const returnLineId = (await client.query('select id from public.order_return_lines where return_id = $1', [returnId])).rows[0].id as string;
      const key = crypto.randomUUID();
      const params = [returnId, actorId, key, JSON.stringify([{ return_line_id: returnLineId, disposition: 'not_restocked', quantity: 1 }])];
      const receiveSql = `select * from public.admin_receive_return($1::uuid, $2::uuid, true, $3::uuid, $4::jsonb,
        '[]'::jsonb, 'none', null, 0, null, false, null, null, null)`;
      await client.query('set local role service_role');
      const received = (await client.query(receiveSql, params)).rows[0];
      const replay = (await client.query(receiveSql, params)).rows[0];
      await client.query('reset role');

      expect(received).toMatchObject({ refund_id: null, replayed: false });
      expect(received.exchange_order_item_ids).toHaveLength(1);
      expect(replay).toMatchObject({ receipt_id: received.receipt_id, exchange_order_item_ids: received.exchange_order_item_ids, replayed: true });
      expect((await client.query(
        'select status::text status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1',
        [order.orderId],
      )).rows).toEqual([{ status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null }]);
      expect((await client.query(
        `select id, fulfillment_type, line_kind from public.order_items where id = $1`,
        [received.exchange_order_item_ids[0]],
      )).rows).toEqual([{ id: received.exchange_order_item_ids[0], fulfillment_type: 'backorder', line_kind: 'exchange' }]);
      expect((await client.query(
        `select before_data ->> 'status' as from_status, after_data ->> 'status' as to_status, reason, changed_by
         from public.order_revisions where order_id = $1 and reason = 'return_exchange_added' order by id`,
        [order.orderId],
      )).rows).toEqual([{ from_status: 'shipped', to_status: 'paid', reason: 'return_exchange_added', changed_by: actorId }]);
      expect((await client.query('select count(*)::int n from public.order_return_receipts where return_id = $1', [returnId])).rows[0].n).toBe(1);
    } finally {
      // 失敗で取引が止まった場合も、ローカルの試験データと role の変更をまとめて戻す。
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

