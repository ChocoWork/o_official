/** @jest-environment node */
/**
 * 発送と仕上がりの窓口（fulfillment-store.ts・fulfillment-materials.ts）と、在庫の画面が読む2つの DB の関数を、
 * 実際の PostgREST（ローカル Supabase の API）に通す（グループ E-1）。
 *
 * 画面の E2E は窓口を差し替え、窓口の単体試験は Supabase のクライアントを差し替え、DB の結合試験は pg で関数を直に呼ぶ。
 * どれも PostgREST を通らないので、名前つき引数の違い（uuid[]・bigint[]・jsonb の渡し方）・同じ名前の関数の選び方・
 * 移行の NOTIFY pgrst による読み直しの誤りは、本番で店主が初めて押した時まで分からない。
 * ここでは service_role の本物の supabase-js の client で、窓口が呼ぶ関数を1回ずつ通し、答えの形と DB の行を確かめる。
 *
 * G-1 Task 14: 旧の発送・発送取消（admin_create_fulfillment・admin_cancel_fulfillment）は LEGACY_FULFILLMENT_DISABLED、
 * 手動の仕上がり（admin_record_completion・admin_cancel_completion）は MANUAL_COMPLETION_DISABLED で、PostgREST を通しても
 * code 55000 で断る。窓口（store・材料）は PostgREST を呼ぶ前に LegacyFulfillmentDisabledError を投げる。
 * 読み出し（商品ごとの数・発送の一覧・仕上がりの一覧・在庫）は、G-1 の割当を消費する合成の発送（shipFixtureOrder）を材料に確かめる。
 *
 * 後片付けはしない。試験の注文は削除禁止のトリガーで、発送の行は追記だけのトリガーで消せないので、ほかの DB 結合テストと
 * 同じく使い捨てのローカル DB でだけ動かす（DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。
 * 注文は毎回新しく作り、決まった番号の行は使わない。残った行は次の npx supabase db reset で消える。
 *
 * 実行方法（ローカル Supabase を起動しておく）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/fulfillment_postgrest --runInBand
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import {
  cancelCompletion,
  cancelFulfillment,
  createFulfillment,
  listOrderCompletions,
  listOrderFulfillments,
  listOrderLineFulfillment,
  recordCompletion,
  toFulfillmentErrorCode,
  type OrderLineFulfillmentRow,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { LegacyFulfillmentDisabledError } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import { describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder, uniqueSuffix } from './helpers/order-fixtures';

jest.setTimeout(30000);

// 発送の材料（fulfillment-materials）が進み具合のために配送の集計（server 専用の delivery-store）を読むため、試験の場では server-only の印を空にする
jest.mock('server-only', () => ({}), { virtual: true });

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const TRACKING_NUMBER = '1234-5678-9012';

type Actor = { id: string; email: string };
type FulfillmentInput = Parameters<typeof createFulfillment>[1];

async function createActor(db: PgClient): Promise<Actor> {
  const email = `fulfillment-postgrest-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 在庫の品（2つ。台帳に確保済み）と受注生産の品（3つ）の決済完了の注文。毎回新しく作る */
async function createMixedOrder(db: PgClient) {
  const stock = await createCatalogFixture(db, { stock: 5 });
  const made = await createCatalogFixture(db, { stock: 0 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status: 'paid',
    lines: [
      { itemId: stock.itemId, variantId: stock.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: made.itemId, variantId: made.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1], stock, made };
}
type MixedOrder = Awaited<ReturnType<typeof createMixedOrder>>;

/** 商品の行の番号 → 数。DB は商品の行を番号順に返すだけで、並びに意味は無い */
function countsByItem(rows: OrderLineFulfillmentRow[] | undefined): Record<string, OrderLineFulfillmentRow> {
  return Object.fromEntries((rows ?? []).map((row) => [row.orderItemId, row]));
}

/** 呼ばれた PostgREST の操作を数える client（止めた窓口が1回も呼ばないことを見る） */
function countingClient(client: SupabaseClient) {
  const calls: string[] = [];
  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'rpc' || property === 'from') {
        return (...args: unknown[]) => {
          calls.push(`${String(property)}:${String(args[0])}`);
          return (target[property] as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { client: proxy as SupabaseClient, calls };
}

async function storedCounts(db: PgClient, orderId: string) {
  return (await db.query(
    `select (select count(*)::int from public.order_fulfillments where order_id = $1) as fulfillments,
            (select count(*)::int from public.order_item_completions where order_id = $1) as completions,
            (select count(*)::int from private.order_email_outbox where order_id = $1) as emails`,
    [orderId],
  )).rows[0];
}

describeLocalDb('integration: 発送・仕上がり・在庫の関数を実際の PostgREST に通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('消せない試験注文が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;
  let actor: Actor;

  beforeAll(async () => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    actor = await createActor(db());
  });

  /** 在庫の品を全部送る入力（受注生産の品は含めない） */
  function shipStockInput(order: MixedOrder, requestKey: string = crypto.randomUUID()): FulfillmentInput {
    return {
      orderId: order.orderId,
      actorId: actor.id,
      requestKey,
      carrier: 'yamato',
      trackingNumber: TRACKING_NUMBER,
      notifyCustomer: true,
      lines: [{ orderItemId: order.stockItemId, quantity: 2 }],
    };
  }

  /** 在庫の品を全部送った合成の発送（G-1 の割当を消費する。通知あり） */
  function shipStock(order: MixedOrder) {
    return shipFixtureOrder(db(), {
      orderId: order.orderId, actorId: actor.id, trackingNumber: TRACKING_NUMBER, notifyCustomer: true,
      lines: [{ order_item_id: order.stockItemId, quantity: 2 }],
    });
  }

  test('仕上がりの記録: PostgREST でも MANUAL_COMPLETION_DISABLED（55000）で断り、窓口は呼ぶ前に止まる。行も一覧も増えない', async () => {
    const order = await createMixedOrder(db());
    const input = { orderId: order.orderId, actorId: actor.id, requestKey: crypto.randomUUID(), lines: [{ orderItemId: order.madeItemId, quantity: 2 }] };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await client.rpc('admin_record_completion', {
        _order_id: input.orderId, _actor_id: input.actorId, _request_key: input.requestKey,
        _lines: [{ order_item_id: order.madeItemId, quantity: 2 }],
      });
      expect(raw.data).toBeNull();
      expect(raw.error).toMatchObject({ message: 'MANUAL_COMPLETION_DISABLED', code: '55000' });
    }
    const counting = countingClient(client);
    await expect(recordCompletion(counting.client, input)).rejects.toBeInstanceOf(LegacyFulfillmentDisabledError);
    expect(counting.calls).toEqual([]);

    expect(await listOrderCompletions(client, order.orderId)).toEqual([]);
    expect(await storedCounts(db(), order.orderId)).toEqual({ fulfillments: 0, completions: 0, emails: 0 });
  });

  test('仕上がりの取消: PostgREST でも MANUAL_COMPLETION_DISABLED（55000）で断り、受注生産中の数は変わらない', async () => {
    const order = await createMixedOrder(db());
    const target = { orderId: order.orderId, completionId: crypto.randomUUID(), actorId: actor.id };

    const raw = await client.rpc('admin_cancel_completion', {
      _order_id: target.orderId, _completion_id: target.completionId, _actor_id: target.actorId,
    });
    expect(raw.error).toMatchObject({ message: 'MANUAL_COMPLETION_DISABLED', code: '55000' });
    const counting = countingClient(client);
    await expect(cancelCompletion(counting.client, target)).rejects.toMatchObject({ code: 'MANUAL_COMPLETION_DISABLED', sqlstate: '55000' });
    expect(counting.calls).toEqual([]);

    const counts = countsByItem((await listOrderLineFulfillment(client, [order.orderId])).get(order.orderId));
    expect(counts[order.madeItemId]).toMatchObject({ completed: 0, inProduction: 3 });
  });

  test('発送: PostgREST でも同じ requestKey の送り直しでも LEGACY_FULFILLMENT_DISABLED（55000）で断り、発送もメールも書かない', async () => {
    const order = await createMixedOrder(db());
    const input = shipStockInput(order);
    const args = {
      _order_id: input.orderId, _actor_id: input.actorId, _request_key: input.requestKey, _shipping_carrier: input.carrier,
      _tracking_number: input.trackingNumber, _notify_customer: input.notifyCustomer,
      _lines: [{ order_item_id: order.stockItemId, quantity: 2 }],
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await client.rpc('admin_create_fulfillment', args);
      expect(raw.data).toBeNull();
      expect(raw.error).toMatchObject({ message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' });
    }
    const counting = countingClient(client);
    await expect(createFulfillment(counting.client, input)).rejects.toMatchObject({
      name: 'LegacyFulfillmentDisabledError', code: 'LEGACY_FULFILLMENT_DISABLED', sqlstate: '55000',
    });
    expect(counting.calls).toEqual([]);

    expect(await storedCounts(db(), order.orderId)).toEqual({ fulfillments: 0, completions: 0, emails: 0 });
    const counts = countsByItem((await listOrderLineFulfillment(client, [order.orderId])).get(order.orderId));
    expect(counts[order.stockItemId]).toMatchObject({ shipped: 0, readyUnshipped: 2, unshipped: 2 });
  });

  test('商品ごとの数: uuid[] で複数の注文を引き、合成の発送の後の数が合う。大文字の番号を渡しても、渡した文字のキーで引ける', async () => {
    const first = await createMixedOrder(db());
    const second = await createMixedOrder(db());
    const unknownOrderId = crypto.randomUUID();
    await shipStock(first);

    const upperFirstId = first.orderId.toUpperCase();
    const counts = await listOrderLineFulfillment(client, [upperFirstId, second.orderId, unknownOrderId]);

    // 渡した注文の番号は、渡した文字のまま全部キーに入る（商品の行が無い注文は空の配列）
    expect([...counts.keys()]).toEqual([upperFirstId, second.orderId, unknownOrderId]);
    expect(counts.get(unknownOrderId)).toEqual([]);
    const firstRows = countsByItem(counts.get(upperFirstId));
    expect(Object.keys(firstRows)).toHaveLength(2);
    expect(firstRows[first.stockItemId]).toEqual({
      orderId: first.orderId,
      orderItemId: first.stockItemId,
      variantId: first.stock.variantId,
      fulfillmentType: 'stock',
      quantity: 2,
      shipped: 2,
      completed: 2,
      refundedBeforeShipment: 0,
      refundedAfterShipment: 0,
      inProduction: 0,
      readyUnshipped: 0,
      unshipped: 0,
    });
    // 受注生産の品は入荷で割り当てるまで受注生産中（手動の仕上がりは G-1 で終了）
    expect(firstRows[first.madeItemId]).toEqual({
      orderId: first.orderId,
      orderItemId: first.madeItemId,
      variantId: first.made.variantId,
      fulfillmentType: 'backorder',
      quantity: 3,
      shipped: 0,
      completed: 0,
      refundedBeforeShipment: 0,
      refundedAfterShipment: 0,
      inProduction: 3,
      readyUnshipped: 0,
      unshipped: 3,
    });
    const secondRows = countsByItem(counts.get(second.orderId));
    expect(secondRows[second.stockItemId]).toMatchObject({ shipped: 0, completed: 2, readyUnshipped: 2, unshipped: 2 });
    expect(secondRows[second.madeItemId]).toMatchObject({ shipped: 0, completed: 0, inProduction: 3, unshipped: 3 });
  });

  test('発送の一覧: 合成の発送の行と商品が出る（実行した人のメールも）', async () => {
    const order = await createMixedOrder(db());
    const created = await shipStock(order);

    expect(await listOrderFulfillments(client, order.orderId)).toEqual([
      {
        fulfillmentId: created.fulfillment_id,
        number: 1,
        shippingCarrier: 'yamato',
        trackingNumber: TRACKING_NUMBER,
        notifyCustomer: true,
        completesOrder: false,
        shippedAt: expect.any(String),
        createdByEmail: actor.email,
        cancelledAt: null,
        cancelledByEmail: null,
        legacy: false,
        lines: [{ orderItemId: order.stockItemId, quantity: 2 }],
      },
    ]);
  });

  test('発送の取消: PostgREST でも LEGACY_FULFILLMENT_DISABLED（55000）で断り、発送・数・送る前の発送のメールはそのまま', async () => {
    const order = await createMixedOrder(db());
    const created = await shipStock(order);
    const target = { orderId: order.orderId, fulfillmentId: created.fulfillment_id, actorId: actor.id };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await client.rpc('admin_cancel_fulfillment', {
        _order_id: target.orderId, _fulfillment_id: target.fulfillmentId, _actor_id: target.actorId,
      });
      expect(raw.error).toMatchObject({ message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' });
    }
    const counting = countingClient(client);
    await expect(cancelFulfillment(counting.client, target)).rejects.toBeInstanceOf(LegacyFulfillmentDisabledError);
    expect(counting.calls).toEqual([]);

    expect(await listOrderFulfillments(client, order.orderId)).toEqual([
      expect.objectContaining({ fulfillmentId: created.fulfillment_id, cancelledAt: null, cancelledByEmail: null }),
    ]);
    const counts = countsByItem((await listOrderLineFulfillment(client, [order.orderId])).get(order.orderId));
    expect(counts[order.stockItemId]).toMatchObject({ shipped: 2, readyUnshipped: 0, unshipped: 0 });
    const mails = await db().query(
      "select status, last_error_code from private.order_email_outbox where fulfillment_id = $1 and kind = 'shipped'",
      [created.fulfillment_id],
    );
    expect(mails.rows).toEqual([{ status: 'pending', last_error_code: null }]);
  });

  test('断り: 送れない数・無い注文でも、PostgREST の誤りは固定の停止の記号で、旧の断りの記号（quantity_exceeds_ready など）へ訳さない', async () => {
    const order = await createMixedOrder(db());
    for (const orderId of [order.orderId, crypto.randomUUID()]) {
      const raw = await client.rpc('admin_create_fulfillment', {
        _order_id: orderId,
        _actor_id: actor.id,
        _request_key: crypto.randomUUID(),
        _shipping_carrier: 'yamato',
        _tracking_number: TRACKING_NUMBER,
        _notify_customer: true,
        _lines: [{ order_item_id: order.madeItemId, quantity: 1 }],
      });
      expect(raw.data).toBeNull();
      expect(raw.error).toMatchObject({ message: 'LEGACY_FULFILLMENT_DISABLED', code: '55000' });
      expect(toFulfillmentErrorCode(raw.error?.message)).toBeNull();
    }

    // 断った発送は何も書かない
    expect(await storedCounts(db(), order.orderId)).toEqual({ fulfillments: 0, completions: 0, emails: 0 });
  });

  test('在庫の画面: list_variant_stock_states（bigint[]）と list_item_stock_history の列の名前と、数が number で来ること', async () => {
    const { orderId, stock, made } = await createMixedOrder(db());

    const states = await client.rpc('list_variant_stock_states', { _variant_ids: [stock.variantId, made.variantId] });

    expect(states.error).toBeNull();
    // pg で読むと bigint は文字列で来る。PostgREST は JSON の数で返す
    expect(states.data).toHaveLength(2);
    expect(states.data).toEqual(
      expect.arrayContaining([
        { variant_id: stock.variantId, committed: 2, backorder: 0 },
        { variant_id: made.variantId, committed: 0, backorder: 3 },
      ]),
    );

    const history = await client.rpc('list_item_stock_history', { _item_id: stock.itemId, _limit: 50 });

    expect(history.error).toBeNull();
    expect(history.data).toEqual([
      {
        movement_id: expect.any(Number),
        variant_id: stock.variantId,
        delta: -2,
        reason: 'purchase',
        note: null,
        created_at: expect.any(String),
        actor_email: null,
        order_id: orderId,
        balance_after: 3,
        refund_id: null,
        return_id: null,
      },
      {
        movement_id: expect.any(Number),
        variant_id: stock.variantId,
        delta: 5,
        reason: 'restock',
        note: expect.any(String),
        created_at: expect.any(String),
        actor_email: null,
        order_id: null,
        balance_after: 5,
        refund_id: null,
        return_id: null,
      },
    ]);
    const limited = await client.rpc('list_item_stock_history', { _item_id: stock.itemId, _limit: 1 });
    expect(limited.data).toHaveLength(1);
  });

  test('発送の画面の材料: 大文字の番号・決済完了でない注文・無い注文でも、PostgREST を1回も呼ばずに LEGACY_FULFILLMENT_DISABLED を投げる', async () => {
    const order = await createMixedOrder(db());
    await shipStock(order);
    const stock = await createCatalogFixture(db(), { stock: 1 });
    const { orderId: pendingOrderId } = await insertOrderWithLines(db(), {
      status: 'pending',
      lines: [{ itemId: stock.itemId, variantId: stock.variantId, quantity: 1, fulfillmentType: 'stock' }],
    });

    for (const orderId of [order.orderId.toUpperCase(), pendingOrderId, crypto.randomUUID()]) {
      const counting = countingClient(client);
      const error: unknown = await loadFulfillmentMaterials(counting.client, orderId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LegacyFulfillmentDisabledError);
      expect(error).toMatchObject({ code: 'LEGACY_FULFILLMENT_DISABLED', sqlstate: '55000' });
      expect(counting.calls).toEqual([]);
    }
  });
});
