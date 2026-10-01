/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, insertOrderWithStockLine } from './helpers/order-fixtures';

/**
 * 商品の非公開・削除（設計書 4-6 の①・R-44）。
 * 開いている決済は受付の済んでいない下書き（24時間以内）。削除できない理由は注文・在庫の記録・決済中。
 */
async function openSessions(db: PgClient, itemId: number): Promise<string[]> {
  const res = await db.query(
    'select checkout_session_id from public.find_open_checkout_sessions_for_item($1::bigint)',
    [itemId],
  );
  return res.rows.map((row) => row.checkout_session_id as string);
}

async function blockers(db: PgClient, itemIds: number[]) {
  const res = await db.query(
    'select item_id, has_orders, has_stock_movements, has_open_checkouts from public.item_delete_blockers($1::bigint[])',
    [itemIds],
  );
  return Object.fromEntries(res.rows.map((row) => [Number(row.item_id), {
    hasOrders: row.has_orders,
    hasStockMovements: row.has_stock_movements,
    hasOpenCheckouts: row.has_open_checkouts,
  }]));
}

const FUNCTION_SIGNATURES = [
  'public.find_open_checkout_sessions_for_item(bigint)',
  'public.item_delete_blockers(bigint[])',
];

describeLocalDb('integration: 商品の非公開・削除の確かめ', (db) => {
  test('受付の済んでいない開いている決済だけを返す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const open = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const placed = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(
      `select order_id from public.place_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
      [placed.draftId, placed.checkoutSessionId, placed.cartSessionId, placed.totalAmount],
    );
    const stale = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(`update public.checkout_drafts set created_at = now() - interval '25 hours' where id = $1`, [
      stale.draftId,
    ]);

    expect(await openSessions(db(), fx.itemId)).toEqual([open.checkoutSessionId]);
  });

  test('削除できない理由を商品ごとに返す', async () => {
    const plain = await createCatalogFixture(db(), { stock: 0 });
    const stocked = await createCatalogFixture(db(), { stock: 1 });
    const ordered = await createCatalogFixture(db(), { stock: 0 });
    await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: ordered.itemId, variantId: ordered.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_guard_${Date.now()}`,
    });
    const checkingOut = await createCatalogFixture(db(), { stock: 0 });
    await createDraft(db(), { itemId: checkingOut.itemId, quantity: 1 });

    expect(await blockers(db(), [plain.itemId, stocked.itemId, ordered.itemId, checkingOut.itemId])).toEqual({
      [plain.itemId]: { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false },
      [stocked.itemId]: { hasOrders: false, hasStockMovements: true, hasOpenCheckouts: false },
      [ordered.itemId]: { hasOrders: true, hasStockMovements: false, hasOpenCheckouts: false },
      [checkingOut.itemId]: { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: true },
    });
  });

  test('anon・authenticated は実行できない', async () => {
    for (const signature of FUNCTION_SIGNATURES) {
      for (const role of ['anon', 'authenticated']) {
        const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(res.rows[0].allowed).toBe(false);
      }
    }
  });

  test('service_role は実行できる（管理 API はこの権限で呼ぶ）', async () => {
    for (const signature of FUNCTION_SIGNATURES) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', ['service_role', signature, 'EXECUTE']);
      expect(res.rows[0].allowed).toBe(true);
    }
  });
});
