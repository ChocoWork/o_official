/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  movementsOf,
  orderRow,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 受付 RPC（設計書 4-3）。注文を支払い手続き中で作り、在庫を確保する。
 * 金額・通貨は Stripe から取り直した Session の値を引数で受け取り、下書きと照らす。
 */
jest.setTimeout(30000);

const SESSION_CREATED_AT = '2026-09-27T01:00:00.000Z';
const SHIPPING = 500;

function place(
  db: PgClient,
  args: {
    draftId: string;
    checkoutSessionId: string;
    cartSessionId: string;
    amountTotal: number;
    amountDiscount?: number;
    currency?: string;
    paymentIntentId?: string | null;
  },
) {
  return db.query(
    `select order_id, order_status::text as order_status, created, rejection
     from public.place_order_from_checkout_draft(
       $1::uuid, $2::text, $3::text, $4::integer, $5::integer, $6::text, $7::timestamptz, $8::text)`,
    [
      args.draftId,
      args.checkoutSessionId,
      args.cartSessionId,
      args.amountTotal,
      args.amountDiscount ?? 0,
      args.currency ?? 'jpy',
      SESSION_CREATED_AT,
      args.paymentIntentId ?? null,
    ],
  );
}

async function draftRow(db: PgClient, draftId: string) {
  const res = await db.query(
    'select status, total_amount, discount_amount, payment_intent_id from public.checkout_drafts where id = $1',
    [draftId],
  );
  return res.rows[0];
}

async function cartLineExists(db: PgClient, cartLineId: string | null): Promise<boolean> {
  if (cartLineId === null) return false;
  const res = await db.query('select 1 from public.cart_lines where id = $1', [cartLineId]);
  return res.rowCount > 0;
}

/**
 * 後発の呼び出しが行ロック待ちに入るまで待つ。固定の待ち時間だと、遅い環境ではロックを待つ前に先発を
 * コミットしてしまい、ロックを待った後の再確認を通らないまま、先発の注文が見つかって通ってしまう。
 */
async function waitUntilWaitingForLock(observer: PgClient, pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await observer.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
    if (res.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('後発の呼び出しがロック待ちにならなかった');
}

describeLocalDb('integration: 受付 RPC', (db) => {
  test('支払い手続き中の注文を作り、在庫を確保し、下書きを受付済みにする。カートは残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    const order = await orderRow(db(), res.rows[0].order_id);
    expect(order).toMatchObject({
      status: 'payment_in_progress',
      payment_intent_id: null,
      total_amount: PRICE * 2,
      discount_amount: 0,
    });
    expect(new Date(order.checkout_session_created_at).toISOString()).toBe(SESSION_CREATED_AT);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
    ]);
    expect(await variantStock(db(), fx.variantId)).toBe(3);
    expect((await draftRow(db(), draft.draftId)).status).toBe('completed');
    expect(await cartLineExists(db(), draft.cartLineId)).toBe(true);
  });

  test('同じ Session で2回呼んでも注文は1件、在庫の確保も1回（二重送信・再読込）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const args = {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    };

    const first = await place(db(), args);
    const second = await place(db(), args);

    expect(second.rows[0]).toMatchObject({ order_id: first.rows[0].order_id, created: false, rejection: null });
    const count = await db().query('select count(*)::int as n from public.orders where checkout_session_id = $1', [
      draft.checkoutSessionId,
    ]);
    expect(count.rows[0].n).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('在庫が足りない明細は受注生産にし、台帳は動かさない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select variant_id, fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    // 受注生産でも、明細はバリアントに結ばれたまま（variant_id は bigint なので文字列で返る）
    expect(lines.rows).toEqual([{ variant_id: String(fx.variantId), fulfillment_type: 'backorder' }]);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('割引は Stripe の値で注文に入れ、下書きは割引額だけを書き戻す（R-26）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    // 送料のある下書きにして、小計と送料が下書きから注文へそのまま入ることも見る（送料 0 では取りこぼしに気づけない）
    await db().query('update public.checkout_drafts set shipping_amount = $2, total_amount = total_amount + $2 where id = $1', [
      draft.draftId,
      SHIPPING,
    ]);

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: PRICE + SHIPPING - 1000,
      amountDiscount: 1000,
    });

    expect(await orderRow(db(), res.rows[0].order_id)).toMatchObject({
      total_amount: PRICE + SHIPPING - 1000,
      discount_amount: 1000,
      subtotal_amount: PRICE,
      shipping_amount: SHIPPING,
    });
    expect(await draftRow(db(), draft.draftId)).toMatchObject({
      total_amount: PRICE + SHIPPING,
      discount_amount: 1000,
    });
  });

  test('割引後の合計へ書き換え済みの古い下書きも受け付ける', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('update public.checkout_drafts set total_amount = $2, discount_amount = 1000 where id = $1', [
      draft.draftId,
      PRICE - 1000,
    ]);

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: PRICE - 1000,
      amountDiscount: 1000,
    });

    expect(res.rows[0]).toMatchObject({ created: true, rejection: null });
  });

  test.each([
    ['別のお客様のセッション', { cartSessionId: 'someone-else' }, 'draft_not_found'],
    ['別の Session', { checkoutSessionId: 'cs_other' }, 'draft_not_found'],
    ['0円', { amountTotal: 0, amountDiscount: PRICE }, 'zero_amount'],
    ['通貨の違い', { currency: 'usd' }, 'currency_mismatch'],
    ['金額の違い', { amountTotal: PRICE + 1 }, 'amount_mismatch'],
  ])('%s は理由コードを返し、何も書かない', async (_label, override, rejection) => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
      ...override,
    });

    expect(res.rows[0]).toMatchObject({ order_id: null, created: false, rejection });
    expect((await draftRow(db(), draft.draftId)).status).toBe('created');
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
  });

  test('受付済みの下書きは draft_not_found', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(`update public.checkout_drafts set status = 'failed' where id = $1`, [draft.draftId]);

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    expect(res.rows[0].rejection).toBe('draft_not_found');
  });

  test('非公開の商品と存在しない商品は item_unavailable', async () => {
    const hidden = await createCatalogFixture(db(), { stock: 1, itemStatus: 'private' });
    const hiddenDraft = await createDraft(db(), { itemId: hidden.itemId, quantity: 1 });
    const missing = await createCatalogFixture(db(), { stock: 1 });
    const missingDraft = await createDraft(db(), { itemId: missing.itemId, quantity: 1 });
    await db().query(
      `update public.checkout_drafts set items_snapshot = jsonb_set(items_snapshot, '{0,item_id}', '999999999') where id = $1`,
      [missingDraft.draftId],
    );

    for (const draft of [hiddenDraft, missingDraft]) {
      const res = await place(db(), {
        draftId: draft.draftId,
        checkoutSessionId: draft.checkoutSessionId,
        cartSessionId: draft.cartSessionId,
        amountTotal: draft.totalAmount,
      });
      expect(res.rows[0]).toMatchObject({ order_id: null, rejection: 'item_unavailable' });
    }
  });

  test('商品行は FOR KEY SHARE。カートの数量変更と非公開は待たせず、削除だけ待たせる（R-42）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const other = await connectLocalDb();
    try {
      await other.query(`set lock_timeout = '1s'`);
      await db().query('begin');
      await place(db(), {
        draftId: draft.draftId,
        checkoutSessionId: draft.checkoutSessionId,
        cartSessionId: draft.cartSessionId,
        amountTotal: draft.totalAmount,
      });

      await other.query('begin');
      await other.query('select id from public.items where id = $1 for share', [fx.itemId]);
      await other.query('rollback');
      await other.query(`update public.items set status = 'private' where id = $1`, [fx.itemId]);
      await expect(other.query('delete from public.items where id = $1', [fx.itemId])).rejects.toMatchObject({
        code: '55P03',
      });
    } finally {
      await db().query('rollback');
      await other.end();
    }
  });

  test('同じ Session の受付が並行しても、後発はロックを待ってから先発の注文を返す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const args = {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    };
    const other = await connectLocalDb();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid;
    let committed = false;
    try {
      await db().query('begin');
      const first = await place(db(), args);
      // 後発は下書きの行ロックで待つ。ロック待ちに入ったことを確かめてから先発をコミットし、
      // 先発のコミット後に、先発の注文を見つけて返す（ロックを待った後の再確認）を必ず通す
      const second = place(other, args);
      // 待っている間に失敗して後始末で切断されても、後発のエラーが未処理のまま残らないようにする
      second.catch(() => undefined);
      await waitUntilWaitingForLock(db(), otherPid);
      await db().query('commit');
      committed = true;

      expect((await second).rows[0]).toMatchObject({ order_id: first.rows[0].order_id, created: false, rejection: null });
    } finally {
      if (!committed) await db().query('rollback');
      await other.end();
    }
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('同じバリアントの明細が分かれていても、合算で在庫を判定する', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, lines: [{ quantity: 1 }, { quantity: 2 }] });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    // 合計 3 > 在庫 2 なので、明細を分けて確保せず、どちらも受注生産にする
    expect(lines.rows.map((row) => row.fulfillment_type)).toEqual(['backorder', 'backorder']);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
  });

  test('停止中のバリアントは在庫があっても受注生産にする', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5, isActive: false });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    expect(lines.rows[0].fulfillment_type).toBe('backorder');
    expect(await variantStock(db(), fx.variantId)).toBe(5);
  });

  test('対応するバリアントが無い色・サイズは variant_id が空のまま注文になる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1, colorName: 'WHITE', sizeLabel: 'L' });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select variant_id, fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    expect(lines.rows).toEqual([{ variant_id: null, fulfillment_type: 'backorder' }]);
  });

  test('受付で確保した分は、在庫を戻す処理でそのまま台帳へ戻る（確保と戻しの往復）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });
    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });
    expect(await variantStock(db(), fx.variantId)).toBe(3);

    // 戻す処理は、受付が台帳に書いた purchase を明細で引いて戻す。受付の書き方（order_item_id）が変わると戻らない。
    const released = await db().query(
      `select released, status::text as status from public.release_stock_for_unpaid_order(
         $1::uuid, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')`,
      [res.rows[0].order_id],
    );

    expect(released.rows[0]).toEqual({ released: true, status: 'abandoned' });
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
      { delta: 2, reason: 'cancel' },
    ]);
    expect(await variantStock(db(), fx.variantId)).toBe(5);
  });

  test('受注生産の注文を放棄にしても、台帳には何も書かない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    await db().query(
      `select released from public.release_stock_for_unpaid_order(
         $1::uuid, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')`,
      [res.rows[0].order_id],
    );

    expect(await movementsOf(db(), fx.variantId)).toEqual([]);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test('台帳の合計とバリアントの在庫がずれていない', async () => {
    const res = await db().query('select count(*)::int as mismatches from public.verify_stock_integrity()');
    expect(res.rows[0].mismatches).toBe(0);
  });

  test('anon・authenticated は実行できない', async () => {
    const signature =
      'public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)';
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
