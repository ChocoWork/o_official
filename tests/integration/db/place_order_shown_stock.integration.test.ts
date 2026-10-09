/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  movementsOf,
  variantStock,
  uniqueSuffix,
} from './helpers/order-fixtures';

/**
 * 最終確認画面の「注文する」の受け付け（グループ F 設計書 5-3・6-2、計画の決め事 D1〜D3）。
 * 在庫ありと見せたバリアントが受注生産に変わっていれば、注文も在庫の確保も作らずに stock_changed を返す。
 * 引数を渡さない呼び出し（照合の見回りの予備処理）は今までどおり注文を作る。
 */
jest.setTimeout(30000);

const SESSION_CREATED_AT = '2026-10-08T01:00:00.000Z';

type DraftRef = { draftId: string; checkoutSessionId: string; cartSessionId: string; totalAmount: number };

function placeWithShown(db: PgClient, draft: DraftRef, shownInStockVariantIds: number[]) {
  return db.query(
    `select order_id, order_status::text as order_status, created, rejection
     from public.place_order_from_checkout_draft(
       _draft_id => $1::uuid,
       _checkout_session_id => $2::text,
       _cart_session_id => $3::text,
       _stripe_amount_total => $4::integer,
       _stripe_amount_discount => 0,
       _stripe_currency => 'jpy',
       _checkout_session_created_at => $5::timestamptz,
       _payment_intent_id => null,
       _shown_in_stock_variant_ids => $6::bigint[])`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, SESSION_CREATED_AT, shownInStockVariantIds],
  );
}

/** 引数を8つだけ渡す今の呼び出し方（照合の見回りの予備処理と同じ） */
function placeWithoutShown(db: PgClient, draft: DraftRef) {
  return db.query(
    `select order_id, order_status::text as order_status, created, rejection
     from public.place_order_from_checkout_draft(
       $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', $5::timestamptz, null::text)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, SESSION_CREATED_AT],
  );
}

async function orderCount(db: PgClient, checkoutSessionId: string): Promise<number> {
  const res = await db.query('select count(*)::int as n from public.orders where checkout_session_id = $1', [
    checkoutSessionId,
  ]);
  return res.rows[0].n;
}

async function draftStatus(db: PgClient, draftId: string): Promise<string> {
  const res = await db.query('select status from public.checkout_drafts where id = $1', [draftId]);
  return res.rows[0].status;
}

async function fulfillmentTypes(db: PgClient, orderId: string): Promise<string[]> {
  const res = await db.query(
    'select fulfillment_type from public.order_items where order_id = $1 order by fulfillment_type',
    [orderId],
  );
  return res.rows.map((row: { fulfillment_type: string }) => row.fulfillment_type);
}

function preview(db: PgClient, lines: Array<Record<string, unknown>>) {
  return db.query(
    `select line_no, item_id, color, size, quantity, variant_id, fulfillment
     from public.preview_checkout_fulfillment($1::jsonb)`,
    [JSON.stringify(lines)],
  );
}

describeLocalDb('integration: お届けの目安の関数', (db) => {
  test('数量の分の在庫があれば stock、足りなければ backorder。渡した順に line_no を振る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });

    const res = await preview(db(), [{ item_id: fx.itemId, color: fx.colorName, size: fx.sizeLabel, quantity: 2 }]);
    const short = await preview(db(), [{ item_id: fx.itemId, color: fx.colorName, size: fx.sizeLabel, quantity: 3 }]);

    expect(res.rows).toEqual([
      {
        line_no: 1,
        item_id: String(fx.itemId),
        color: fx.colorName,
        size: fx.sizeLabel,
        quantity: 2,
        variant_id: String(fx.variantId),
        fulfillment: 'stock',
      },
    ]);
    expect(short.rows[0].fulfillment).toBe('backorder');
  });

  test('同じバリアントの明細は数量を合わせて比べる（受付 RPC と同じ規則）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });

    const res = await preview(db(), [
      { item_id: fx.itemId, color: fx.colorName, size: fx.sizeLabel, quantity: 1 },
      { item_id: fx.itemId, color: fx.colorName, size: fx.sizeLabel, quantity: 2 },
    ]);

    expect(res.rows.map((row: { line_no: number; fulfillment: string }) => [row.line_no, row.fulfillment])).toEqual([
      [1, 'backorder'],
      [2, 'backorder'],
    ]);
  });

  test('止めたバリアント・見つからない色は backorder（バリアントが無ければ variant_id は null）', async () => {
    const inactive = await createCatalogFixture(db(), { stock: 5, isActive: false });
    const fx = await createCatalogFixture(db(), { stock: 5 });

    const res = await preview(db(), [
      { item_id: inactive.itemId, color: inactive.colorName, size: inactive.sizeLabel, quantity: 1 },
      { item_id: fx.itemId, color: 'NO-SUCH-COLOR', size: fx.sizeLabel, quantity: 1 },
    ]);

    expect(res.rows[0]).toMatchObject({ variant_id: String(inactive.variantId), fulfillment: 'backorder' });
    expect(res.rows[1]).toMatchObject({ variant_id: null, fulfillment: 'backorder' });
  });

  test('anon と authenticated は実行できない', async () => {
    const res = await db().query(
      `select has_function_privilege('anon', 'public.preview_checkout_fulfillment(jsonb)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.preview_checkout_fulfillment(jsonb)', 'EXECUTE') as authed,
              has_function_privilege('service_role', 'public.preview_checkout_fulfillment(jsonb)', 'EXECUTE') as service`,
    );
    expect(res.rows[0]).toEqual({ anon: false, authed: false, service: true });
  });
});

describeLocalDb('integration: 受付 RPC の在庫と価格の確かめ', (db) => {
  test('配列ありで受け付け済みの画面も、カート行を消した後の押し直しは cart_changed。注文・明細・在庫の動きを増やさない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const first = await placeWithShown(db(), draft, [fx.variantId]);
    expect(first.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    const itemsBefore = await db().query('select * from public.order_items where order_id = $1 order by id', [first.rows[0].order_id]);
    const movementsBefore = await movementsOf(db(), fx.variantId);
    const stockBefore = await variantStock(db(), fx.variantId);
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);

    for (const shown of [[], [fx.variantId]]) {
      const res = await placeWithShown(db(), draft, shown);
      expect(res.rows[0]).toEqual({ order_id: null, order_status: null, created: false, rejection: 'cart_changed' });
    }

    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
    const itemsAfter = await db().query('select * from public.order_items where order_id = $1 order by id', [first.rows[0].order_id]);
    expect(itemsAfter.rows).toEqual(itemsBefore.rows);
    expect(await movementsOf(db(), fx.variantId)).toEqual(movementsBefore);
    expect(await variantStock(db(), fx.variantId)).toBe(stockBefore);
    expect(await draftStatus(db(), draft.draftId)).toBe('completed');
  });

  test('配列ありで受け付け済みなら、カート行を消した後も NULL の呼び出し（照合器）は既存の注文を返す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const first = await placeWithShown(db(), draft, [fx.variantId]);
    expect(first.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);

    const res = await placeWithoutShown(db(), draft);

    expect(res.rows[0]).toEqual({
      order_id: first.rows[0].order_id, order_status: 'payment_in_progress', created: false, rejection: null,
    });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
    expect(await fulfillmentTypes(db(), first.rows[0].order_id)).toEqual(['stock']);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 2, reason: 'restock' }, { delta: -1, reason: 'purchase' }]);
  });

  test.each(['paid', 'pending'])('既存の注文が %s なら、カート行が消えても配列ありの押し直しは既存の注文を返す', async (status) => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const first = await placeWithShown(db(), draft, [fx.variantId]);
    expect(first.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    const orderId = first.rows[0].order_id;
    const paymentIntentId = `pi_${uniqueSuffix()}`;
    const marked = status === 'paid'
      ? await db().query(
        `select updated from public.mark_order_paid($1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', true, 'order_confirmed', null)`,
        [orderId, paymentIntentId, draft.totalAmount],
      )
      : await db().query(
        'select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, null)', [orderId, paymentIntentId],
      );
    expect(marked.rows[0].updated).toBe(true);
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);
    expect((await db().query('select id from public.cart_lines where id = $1 and cart_id = $2', [draft.cartLineId, draft.cartId])).rowCount).toBe(0);
    const itemsBefore = await db().query('select * from public.order_items where order_id = $1 order by id', [orderId]);
    const movementsBefore = await movementsOf(db(), fx.variantId);
    const stockBefore = await variantStock(db(), fx.variantId);

    for (const shown of [[], [fx.variantId]]) {
      const res = await placeWithShown(db(), draft, shown);
      expect(res.rows[0]).toEqual({ order_id: orderId, order_status: status, created: false, rejection: null });
    }

    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
    expect((await db().query('select * from public.order_items where order_id = $1 order by id', [orderId])).rows).toEqual(itemsBefore.rows);
    expect(await movementsOf(db(), fx.variantId)).toEqual(movementsBefore);
    expect(await variantStock(db(), fx.variantId)).toBe(stockBefore);
  });

  test('source_cart_line_id が NULL の明細だけなら、カート行が無くても配列ありで受け付け・押し直しを断らない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(
      `update public.checkout_drafts set items_snapshot = jsonb_set(items_snapshot, '{0,source_cart_line_id}', 'null'::jsonb) where id = $1`,
      [draft.draftId],
    );
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);

    const first = await placeWithShown(db(), draft, [fx.variantId]);
    const second = await placeWithShown(db(), draft, [fx.variantId]);

    expect(first.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(second.rows[0]).toEqual({
      order_id: first.rows[0].order_id, order_status: 'payment_in_progress', created: false, rejection: null,
    });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
    expect(await fulfillmentTypes(db(), first.rows[0].order_id)).toEqual(['stock']);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('カートの行が消えていれば配列ありの受付は cart_changed。注文も在庫の確保も作らない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);

    for (const shown of [[], [fx.variantId]]) {
      const res = await placeWithShown(db(), draft, shown);
      expect(res.rows[0]).toEqual({ order_id: null, order_status: null, created: false, rejection: 'cart_changed' });
    }
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(0);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 2, reason: 'restock' }]);
    expect(await draftStatus(db(), draft.draftId)).toBe('created');
  });

  test('カートの行が消えていても NULL の呼び出し（照合器）は今までどおり注文を作る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('delete from public.cart_lines where id = $1', [draft.cartLineId]);

    const res = await placeWithoutShown(db(), draft);

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
  });

  test('本人のカート行が残っていれば配列ありの受付は今までどおり注文を作る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const cart = await db().query('select id from public.cart_lines where id = $1 and cart_id = $2', [draft.cartLineId, draft.cartId]);
    expect(cart.rowCount).toBe(1);

    const res = await placeWithShown(db(), draft, [fx.variantId]);

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('在庫ありと見せたバリアントの在庫が足りなければ stock_changed。注文も在庫の確保も作らず、下書きは作成中のまま', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await placeWithShown(db(), draft, [fx.variantId]);

    expect(res.rows[0]).toEqual({ order_id: null, order_status: null, created: false, rejection: 'stock_changed' });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(0);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await draftStatus(db(), draft.draftId)).toBe('created');
  });

  test('在庫ありと見せたバリアントの在庫が足りれば、今までどおり在庫で受け付ける', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await placeWithShown(db(), draft, [fx.variantId]);

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await fulfillmentTypes(db(), res.rows[0].order_id)).toEqual(['stock']);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test('受注生産と見せた明細（空の配列）は、在庫が足りなくても受注生産で受け付ける', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await placeWithShown(db(), draft, []);

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await fulfillmentTypes(db(), res.rows[0].order_id)).toEqual(['backorder']);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('下書きに無いバリアントを送られても無視する（在庫の確保はサーバーが決める）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const other = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await placeWithShown(db(), draft, [other.variantId, 999999999]);

    expect(res.rows[0]).toMatchObject({ created: true, rejection: null });
    expect(await fulfillmentTypes(db(), res.rows[0].order_id)).toEqual(['stock']);
  });

  test('受注生産の予定だった明細に在庫が入っていれば、止めずに在庫で受け付ける', async () => {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await placeWithShown(db(), draft, []);

    expect(res.rows[0]).toMatchObject({ created: true, rejection: null });
    expect(await fulfillmentTypes(db(), res.rows[0].order_id)).toEqual(['stock']);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('確認の後に商品の価格が変わっていれば price_changed。注文は作らない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('update public.items set price = $1 where id = $2', [PRICE + 1000, fx.itemId]);

    const res = await placeWithShown(db(), draft, [fx.variantId]);

    expect(res.rows[0]).toEqual({ order_id: null, order_status: null, created: false, rejection: 'price_changed' });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(0);
    expect(await variantStock(db(), fx.variantId)).toBe(5);
  });

  test('引数を渡さない呼び出し（見回り）は、在庫が足りなくても価格が変わっていても今までどおり注文を作る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });
    await db().query('update public.items set price = $1 where id = $2', [PRICE + 1000, fx.itemId]);

    const res = await placeWithoutShown(db(), draft);

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await fulfillmentTypes(db(), res.rows[0].order_id)).toEqual(['backorder']);
  });

  test('受け付け済みの決済の画面なら、在庫が変わっていても同じ注文を返す（二重の申し込み）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const first = await placeWithShown(db(), draft, [fx.variantId]);
    const cart = await db().query('select id from public.cart_lines where id = $1 and cart_id = $2', [draft.cartLineId, draft.cartId]);
    expect(cart.rowCount).toBe(1);
    const second = await placeWithShown(db(), draft, [fx.variantId]);

    expect(second.rows[0]).toEqual({
      order_id: first.rows[0].order_id,
      order_status: 'payment_in_progress',
      created: false,
      rejection: null,
    });
    expect(await orderCount(db(), draft.checkoutSessionId)).toBe(1);
    expect(await fulfillmentTypes(db(), first.rows[0].order_id)).toEqual(['stock']);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
  });

  test('新しい形だけが残り、anon と authenticated は実行できない', async () => {
    const res = await db().query(
      `select p.oid::regprocedure::text as signature,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'place_order_from_checkout_draft'`,
    );
    expect(res.rows).toEqual([
      {
        signature:
          'place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamp with time zone,text,bigint[],uuid)',
        anon: false,
        authed: false,
        service: true,
      },
    ]);
  });
});
