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
 * 後片付けはしない。試験の注文は削除禁止のトリガーで、発送・仕上がりの行は追記だけのトリガーで消せないので、ほかの DB 結合テストと
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
  FulfillmentOperationError,
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
import { describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

  test('仕上がりの記録: 受注生産の品の仕上がりが一覧に出る。同じ requestKey の送り直しは replayed で、行は増えない', async () => {
    const { orderId, madeItemId } = await createMixedOrder(db());
    const input = {
      orderId,
      actorId: actor.id,
      requestKey: crypto.randomUUID(),
      lines: [{ orderItemId: madeItemId, quantity: 2 }],
    };

    const recorded = await recordCompletion(client, input);

    expect(recorded).toEqual({ completionIds: [expect.stringMatching(UUID_PATTERN)], replayed: false });
    const [completionId] = recorded.completionIds;
    expect(await listOrderCompletions(client, orderId)).toEqual([
      {
        completionId,
        orderItemId: madeItemId,
        quantity: 2,
        createdAt: expect.any(String),
        createdByEmail: actor.email,
        cancelledAt: null,
        cancelledByEmail: null,
        legacy: false,
      },
    ]);
    const stored = await db().query(
      `select order_item_id, quantity, created_by, cancelled_at is not null as cancelled
       from public.order_item_completions where order_id = $1`,
      [orderId],
    );
    expect(stored.rows).toEqual([{ order_item_id: madeItemId, quantity: 2, created_by: actor.id, cancelled: false }]);

    expect(await recordCompletion(client, input)).toEqual({ completionIds: [completionId], replayed: true });
    expect((await listOrderCompletions(client, orderId)).map((row) => row.completionId)).toEqual([completionId]);
  });

  test('仕上がりの取消: 発送した数を下回らない取消は cancelled、もう一度押すと already_cancelled', async () => {
    const { orderId, madeItemId } = await createMixedOrder(db());
    const {
      completionIds: [completionId],
    } = await recordCompletion(client, {
      orderId,
      actorId: actor.id,
      requestKey: crypto.randomUUID(),
      lines: [{ orderItemId: madeItemId, quantity: 2 }],
    });
    const target = { orderId, completionId, actorId: actor.id };

    expect(await cancelCompletion(client, target)).toEqual({ outcome: 'cancelled' });
    expect(await cancelCompletion(client, target)).toEqual({ outcome: 'already_cancelled' });

    expect(await listOrderCompletions(client, orderId)).toEqual([
      expect.objectContaining({ completionId, cancelledAt: expect.any(String), cancelledByEmail: actor.email }),
    ]);
    const stored = await db().query(
      'select cancelled_by, cancelled_at is not null as cancelled from public.order_item_completions where id = $1',
      [completionId],
    );
    expect(stored.rows).toEqual([{ cancelled_by: actor.id, cancelled: true }]);
    // 取り消した仕上がりは数に入らない
    const counts = countsByItem((await listOrderLineFulfillment(client, [orderId])).get(orderId));
    expect(counts[madeItemId]).toMatchObject({ completed: 0, inProduction: 3 });
  });

  test('発送: 在庫の品だけを送ると completesOrder は false で、注文は決済完了のまま。同じ requestKey の送り直しは replayed', async () => {
    const order = await createMixedOrder(db());
    const input = shipStockInput(order);

    const created = await createFulfillment(client, input);

    expect(created).toEqual({
      fulfillmentId: expect.stringMatching(UUID_PATTERN),
      number: 1,
      completesOrder: false,
      orderStatus: 'paid',
      replayed: false,
    });
    expect(await createFulfillment(client, input)).toEqual({ ...created, replayed: true });

    // 送り直しで行は増えない。発送の行・商品・発送のメールの予定は、その発送に付く
    const fulfillments = await db().query(
      `select id, number, shipping_carrier, tracking_number, notify_customer, completes_order, created_by
       from public.order_fulfillments where order_id = $1`,
      [order.orderId],
    );
    expect(fulfillments.rows).toEqual([
      {
        id: created.fulfillmentId,
        number: 1,
        shipping_carrier: 'yamato',
        tracking_number: TRACKING_NUMBER,
        notify_customer: true,
        completes_order: false,
        created_by: actor.id,
      },
    ]);
    const lines = await db().query(
      'select order_item_id, quantity from public.order_fulfillment_lines where fulfillment_id = $1',
      [created.fulfillmentId],
    );
    expect(lines.rows).toEqual([{ order_item_id: order.stockItemId, quantity: 2 }]);
    const mails = await db().query(
      "select status from private.order_email_outbox where fulfillment_id = $1 and kind = 'shipped'",
      [created.fulfillmentId],
    );
    expect(mails.rows).toEqual([{ status: 'pending' }]);
  });

  test('商品ごとの数: uuid[] で複数の注文を引き、数が合う。大文字の番号を渡しても、渡した文字のキーで引ける', async () => {
    const first = await createMixedOrder(db());
    const second = await createMixedOrder(db());
    const unknownOrderId = crypto.randomUUID();
    await recordCompletion(client, {
      orderId: first.orderId,
      actorId: actor.id,
      requestKey: crypto.randomUUID(),
      lines: [{ orderItemId: first.madeItemId, quantity: 2 }],
    });
    await createFulfillment(client, shipStockInput(first));

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
      inProduction: 0,
      readyUnshipped: 0,
      unshipped: 0,
    });
    expect(firstRows[first.madeItemId]).toEqual({
      orderId: first.orderId,
      orderItemId: first.madeItemId,
      variantId: first.made.variantId,
      fulfillmentType: 'backorder',
      quantity: 3,
      shipped: 0,
      completed: 2,
      inProduction: 1,
      readyUnshipped: 2,
      unshipped: 3,
    });
    const secondRows = countsByItem(counts.get(second.orderId));
    expect(secondRows[second.stockItemId]).toMatchObject({ shipped: 0, completed: 2, readyUnshipped: 2, unshipped: 2 });
    expect(secondRows[second.madeItemId]).toMatchObject({ shipped: 0, completed: 0, inProduction: 3, unshipped: 3 });
  });

  test('発送の一覧: 発送の行と商品が出る（実行した人のメールも）', async () => {
    const order = await createMixedOrder(db());
    const created = await createFulfillment(client, shipStockInput(order));

    expect(await listOrderFulfillments(client, order.orderId)).toEqual([
      {
        fulfillmentId: created.fulfillmentId,
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

  test('発送の取消: cancelled、もう一度押すと already_cancelled。数は戻り、送る前の発送のメールは取りやめになる', async () => {
    const order = await createMixedOrder(db());
    const created = await createFulfillment(client, shipStockInput(order));
    const target = { orderId: order.orderId, fulfillmentId: created.fulfillmentId, actorId: actor.id };

    expect(await cancelFulfillment(client, target)).toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
    expect(await cancelFulfillment(client, target)).toEqual({ outcome: 'already_cancelled', orderStatus: 'paid' });

    expect(await listOrderFulfillments(client, order.orderId)).toEqual([
      expect.objectContaining({
        fulfillmentId: created.fulfillmentId,
        cancelledAt: expect.any(String),
        cancelledByEmail: actor.email,
      }),
    ]);
    const counts = countsByItem((await listOrderLineFulfillment(client, [order.orderId])).get(order.orderId));
    expect(counts[order.stockItemId]).toMatchObject({ shipped: 0, readyUnshipped: 2, unshipped: 2 });
    const mails = await db().query(
      "select status, last_error_code from private.order_email_outbox where fulfillment_id = $1 and kind = 'shipped'",
      [created.fulfillmentId],
    );
    expect(mails.rows).toEqual([{ status: 'skipped', last_error_code: 'fulfillment_cancelled' }]);
  });

  test('断り: 送れない数を送ると、DB の言葉が PostgREST を通っても quantity_exceeds_ready の記号に直る', async () => {
    const order = await createMixedOrder(db());
    // 受注生産の品はまだ仕上がっていない（発送準備中が0）ので、1つも送れない
    const madeLines = [{ orderItemId: order.madeItemId, quantity: 1 }];
    const input: FulfillmentInput = { ...shipStockInput(order), lines: madeLines };

    const refusal = await createFulfillment(client, input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(FulfillmentOperationError);
    expect(refusal).toMatchObject({ code: 'quantity_exceeds_ready' });

    // 窓口が拾う前の、PostgREST の誤りの文から DB の言葉を拾えること
    const raw = await client.rpc('admin_create_fulfillment', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _shipping_carrier: input.carrier,
      _tracking_number: input.trackingNumber,
      _notify_customer: input.notifyCustomer,
      _lines: [{ order_item_id: order.madeItemId, quantity: 1 }],
    });
    expect(raw.data).toBeNull();
    expect(toFulfillmentErrorCode(raw.error?.message)).toBe('quantity_exceeds_ready');

    // 存在しない注文は別の SQLSTATE（P0002）で止まるが、同じように記号に直る
    await expect(createFulfillment(client, { ...input, orderId: crypto.randomUUID() })).rejects.toMatchObject({
      name: 'FulfillmentOperationError',
      code: 'order_not_found',
    });

    // 断った発送は何も書かない
    const stored = await db().query('select count(*)::int as count from public.order_fulfillments where order_id = $1', [
      order.orderId,
    ]);
    expect(stored.rows[0].count).toBe(0);
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
      },
    ]);
    const limited = await client.rpc('list_item_stock_history', { _item_id: stock.itemId, _limit: 1 });
    expect(limited.data).toHaveLength(1);
  });

  test('発送の画面の材料: 商品の行・発送・発送できない理由が出る。大文字の番号でも商品の行は空にならない', async () => {
    const order = await createMixedOrder(db());
    const created = await createFulfillment(client, shipStockInput(order));

    const materials = await loadFulfillmentMaterials(client, order.orderId.toUpperCase());

    expect(materials).toEqual({
      order: {
        id: order.orderId,
        orderNumber: `ORD-${order.orderId.slice(0, 8).toUpperCase()}`,
        status: 'paid',
        progress: { key: 'in_production', label: '受注生産中', partiallyShipped: true },
      },
      blockedReason: null,
      // 商品の行の並びは作った時刻の順だが、ここでは中身だけを見る（並べ替えの指定を PostgREST が受け付けることは、答えが返ることで分かる）
      lines: expect.arrayContaining([
        {
          orderItemId: order.stockItemId,
          name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          fulfillmentType: 'stock',
          quantity: 2,
          shipped: 2,
          inProduction: 0,
          readyUnshipped: 0,
          unshipped: 0,
        },
        {
          orderItemId: order.madeItemId,
          name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          fulfillmentType: 'backorder',
          quantity: 3,
          shipped: 0,
          inProduction: 3,
          readyUnshipped: 0,
          unshipped: 3,
        },
      ]),
      fulfillments: [
        {
          id: created.fulfillmentId,
          number: 1,
          carrier: 'yamato',
          trackingNumber: TRACKING_NUMBER,
          shippedAt: expect.any(String),
          notifyCustomer: true,
          completesOrder: false,
          cancelledAt: null,
          lines: [{ orderItemId: order.stockItemId, quantity: 2 }],
        },
      ],
    });

    expect(materials?.lines).toHaveLength(2);

    // 決済完了でない注文は発送できない理由が出る。注文が無ければ null
    const stock = await createCatalogFixture(db(), { stock: 1 });
    const { orderId: pendingOrderId } = await insertOrderWithLines(db(), {
      status: 'pending',
      lines: [{ itemId: stock.itemId, variantId: stock.variantId, quantity: 1, fulfillmentType: 'stock' }],
    });
    expect(await loadFulfillmentMaterials(client, pendingOrderId)).toMatchObject({
      blockedReason: 'not_shippable',
      order: { status: 'pending', progress: { key: 'unpaid' } },
    });
    expect(await loadFulfillmentMaterials(client, crypto.randomUUID())).toBeNull();
  });
});
