/**
 * FR-ADMIN-111 在庫一覧表と、入荷・解放・棚卸が古い待ち注文へ回る FIFO（グループ G-2）
 * 対応 FREQ: FREQ-525（AC-01・AC-02）、FREQ-529（AC-01・AC-05）、FREQ-521（AC-01）、FREQ-522（AC-01・AC-02）
 *
 * この spec が確かめる所: 在庫一覧表（/admin/inventory。G-2 で作る画面）の注文数・在庫・発注済み・発注必要数と「在庫の内訳」。
 * 画面 → 窓口の差し替え（e2e/purchasing-test-utils.ts）→ 手元の DB の関数で読む。管理者のログインは差し替え、権限は DB の関数が確かめる。
 *
 * この spec が確かめない所（照合先）:
 * - 要確認の解消・取消申請のお断り・取消による解放・返品の受け取り・棚卸の増減の「画面の操作」は、この spec の対象ではない
 *   （E2E には管理者の aal2 ログインと、注文・返品の窓口の橋渡しが無い）。原因の操作は G-1 の公開 DB 関数をテストから直接呼び
 *   （中身は G-1 の DB 結合 group_g1_* が証明する）、結果が在庫一覧表に出ることだけを確かめる。画面操作の移設は G-4。
 * - 窓口の認可・MFA・CSRF・回数の制限・監査 → FR-ADMIN-123 の G-2 の節（本物の窓口の 401/403）と各 route の単体
 * - 一覧の絞り込み・並び・数式の全組み合わせ → DB 結合 group_g2_inventory_list
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { insertOrderWithLines } from '../tests/integration/db/helpers/order-fixtures';
import { createShippedOrder, createReturnInDb, receiveReturnInDb } from './return-test-utils';
import { createOrderWithLines, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { releaseE2eUnpaidOrder, seedE2eAllocation, lockE2eInventory, withGroupG1Material } from './group-g1-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import {
  adjustStock,
  createCatalogMaterial,
  createPurchaseOrderInDb,
  confirmPurchaseOrderInDb,
  createWaitingOrder,
  expectNoPageOverflow,
  inventoryRowOf,
  paidAllocationOf,
  preparePurchasingPage,
  readInventoryRowOnScreen,
  receivePurchaseOrderInDb,
  restockStock,
  variantInventory,
  withPurchasingScenario,
  PRICE,
  type CatalogMaterial,
  type InventoryListNumbers,
  type InventoryNumbers,
  type PurchasingContext,
} from './purchasing-test-utils';

test.describe.configure({ timeout: 180_000 });

/**
 * 返品の設定（shop_return_settings の1行）を触る場面の鍵 14314,2 を、別の接続で先に取る（返品の試験の fixture と同じ鍵）。
 * 鍵の順は 14314,2 → 190520,0（権限）。逆の順で取る所は無い。
 */
async function withReturnSettingsLock<T>(run: () => Promise<T>): Promise<T> {
  return withLocalDb(async (lockClient) => {
    await lockClient.query('select pg_catalog.pg_advisory_lock(14314, 2)');
    try {
      return await run();
    } finally {
      await lockClient.query('select pg_catalog.pg_advisory_unlock(14314, 2)');
    }
  });
}

const breakdownText = (free: number, paid: number, held: number): string =>
  `空き ${free}・入金済みの割当 ${paid}・支払い前の仮確保 ${held}`;

async function openInventory(page: Page, ctx: PurchasingContext): Promise<void> {
  await preparePurchasingPage(page, ctx);
  await page.goto('/admin/inventory');
  await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
}

/** 行の数と、在庫の内訳の文（キーボードで開く）を確かめる */
async function expectInventoryRow(
  page: Page,
  material: CatalogMaterial,
  expected: InventoryListNumbers,
  breakdown: string,
): Promise<void> {
  const row = inventoryRowOf(page, material);
  expect(await readInventoryRowOnScreen(row)).toEqual(expected);
  const toggle = row.getByRole('button', { name: '在庫の内訳' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.focus();
    await page.keyboard.press('Enter');
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`#inventory-breakdown-${material.variantId}`)).toHaveText(breakdown);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-111 inventory list and FIFO (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('在庫一覧表の注文数・在庫・発注済み・発注必要数が、入金済みの待ち注文と仮確保から作られる（未払いの仮確保は在庫に入り注文数に入らない）', async ({ page }) => {
      // FREQ-525-AC-01, FREQ-525-AC-02
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const catalog = { itemId: material.itemId, variantId: material.variantId };
        // 空き 6 を入れ、支払い手続き中の注文が 2 を仮確保（空き 4・仮確保 2）。そのあとで入金済みの待ち注文 9（割当なし）
        await restockStock(client, { ...catalog, quantity: 6 });
        await createOrderWithLines(
          client, uniqueEmail('g2-111-hold'), [{ name: 'E2E仮確保', quantity: 2, fulfillmentType: 'stock' }],
          { status: 'payment_in_progress', catalog },
        );
        await createWaitingOrder(client, { catalog, quantity: 9 });
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 4, paidAllocated: 0, paymentHeld: 2, onHand: 6 });

        await openInventory(page, ctx);
        // 列は7つ。この順（キーボードで開く内訳は expectInventoryRow が確かめる）
        await expect(page.getByRole('columnheader')).toHaveText(['商品名', '色', 'サイズ', '注文数', '在庫', '発注済み', '発注必要数']);
        // 注文数 9（仮確保の 2 は入らない）・在庫 6（仮確保 2 を含む）・発注済み 0・発注必要数 9 − 6 − 0 = 3
        await expectInventoryRow(page, material, { orderQuantity: 9, onHand: 6, onOrder: 0, required: 3 }, breakdownText(4, 0, 2));
        await expectNoPageOverflow(page);
      });
    });

    test('発注の受け取りで入庫すると古い待ち注文から順に割り当てられ、一覧と商品の在庫の履歴が更新される（買い手本人の仮確保は奪われない）', async ({ page }) => {
      // FREQ-529-AC-01, FREQ-525-AC-01, FREQ-522-AC-01
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const catalog = { itemId: material.itemId, variantId: material.variantId };
        await restockStock(client, { ...catalog, quantity: 1 });
        const hold = await createOrderWithLines(
          client, uniqueEmail('g2-111-own-hold'), [{ name: 'E2E仮確保', quantity: 1, fulfillmentType: 'stock' }],
          { status: 'payment_in_progress', catalog },
        );
        // 注文日の古い順: 先の注文 2 点・後の注文 2 点（どちらも割当なしの待ち）
        const older = await createWaitingOrder(client, { catalog, quantity: 2, orderedAt: '2026-01-01T00:00:00Z' });
        const newer = await createWaitingOrder(client, { catalog, quantity: 2, orderedAt: '2026-02-01T00:00:00Z' });
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 3 }] });
        await confirmPurchaseOrderInDb(ctx, created.id);

        // 受け取りの前: 注文数 4・在庫 1（仮確保）・発注済み 3 → 発注必要数 0
        await openInventory(page, ctx);
        expect(await readInventoryRowOnScreen(inventoryRowOf(page, material))).toEqual({ orderQuantity: 4, onHand: 1, onOrder: 3, required: 0 });

        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);

        // 古い待ち注文から順に 2 点・1 点。買い手本人の仮確保は奪われない
        expect(await paidAllocationOf(client, older.orderItemId)).toBe(2);
        expect(await paidAllocationOf(client, newer.orderItemId)).toBe(1);
        const heldLeft = (await client.query(
          `select coalesce(sum(remaining_quantity), 0)::int as n from public.order_item_allocations where order_item_id = $1 and kind = 'payment_hold'`,
          [hold.orderItemIds[0]],
        )).rows[0].n as number;
        expect(heldLeft).toBe(1);
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 3, paymentHeld: 1, onHand: 4 });

        // 一覧を開き直すと反映される: 在庫 4・発注済み 0
        await page.reload();
        await expectInventoryRow(page, material, { orderQuantity: 4, onHand: 4, onOrder: 0, required: 0 }, breakdownText(0, 3, 1));

        // 商品の在庫の履歴（商品の編集画面が読む DB の関数）: 受け取りの入庫と、古い注文への確保
        const history = (await client.query('select * from public.list_item_stock_history($1::bigint, 50)', [material.itemId])).rows;
        expect(history.some((row) => row.reason === 'restock' && Number(row.delta) === 3 && String(row.note ?? '').includes(created.number))).toBe(true);
        const purchased = history.filter((row) => row.reason === 'purchase' && [older.orderId, newer.orderId].includes(row.order_id as string));
        expect(purchased.reduce((sum, row) => sum + Number(row.delta), 0)).toBe(-3);
        await expectNoPageOverflow(page);
      });
    });

    test('要確認の解消・取消申請のお断り・取消による解放・返品の受け取り・棚卸の増で空きが古い待ち注文へ回った結果が、在庫一覧表を開き直すと反映される', async ({ page }) => {
      // FREQ-522-AC-01, FREQ-522-AC-02, FREQ-521-AC-01。原因の操作は G-1 の公開 DB 関数を直に呼ぶ（この spec の先頭のとおり）
      await withReturnSettingsLock(() => withPurchasingScenario(async (ctx) => {
        const { client, actorId } = ctx;
        const checks: Array<{ name: string; material: CatalogMaterial; screen: InventoryListNumbers; breakdown: string }> = [];
        const expectDb = async (material: CatalogMaterial, expected: Partial<InventoryNumbers>): Promise<void> => {
          expect(await variantInventory(client, material.variantId)).toMatchObject(expected);
        };

        // (1) 棚卸の増: 待ち 3 に +2 → 古い待ち注文が 2 点の割当を受ける
        {
          const material = await createCatalogMaterial(client);
          const catalog = { itemId: material.itemId, variantId: material.variantId };
          await createWaitingOrder(client, { catalog, quantity: 3 });
          await expectDb(material, { free: 0, paidAllocated: 0, onHand: 0 });
          await adjustStock(client, { ...catalog, quantity: 2 });
          await expectDb(material, { free: 0, paidAllocated: 2, onHand: 2 });
          checks.push({ name: '棚卸の増', material, screen: { orderQuantity: 3, onHand: 2, onOrder: 0, required: 1 }, breakdown: breakdownText(0, 2, 0) });
        }

        // (2) 取消による解放: 支払い手続き中の注文が仮確保 2 → 取消で空きに戻り、古い待ち注文へ
        {
          const material = await createCatalogMaterial(client);
          const catalog = { itemId: material.itemId, variantId: material.variantId };
          await restockStock(client, { ...catalog, quantity: 2 });
          const unpaid = await createOrderWithLines(
            client, uniqueEmail('g2-111-unpaid'), [{ name: 'E2E未払い', quantity: 2, fulfillmentType: 'stock' }],
            { status: 'payment_in_progress', catalog },
          );
          await createWaitingOrder(client, { catalog, quantity: 2 });
          await expectDb(material, { free: 0, paymentHeld: 2, paidAllocated: 0, onHand: 2 });
          await withGroupG1Material(client, () => releaseE2eUnpaidOrder(client, { orderId: unpaid.orderId, status: 'cancelled' }));
          await expectDb(material, { free: 0, paymentHeld: 0, paidAllocated: 2, onHand: 2 });
          checks.push({ name: '取消による解放', material, screen: { orderQuantity: 2, onHand: 2, onOrder: 0, required: 0 }, breakdown: breakdownText(0, 2, 0) });
        }

        // (3) 要確認の解消: 金額の違いで保留になった入金済みの注文は、空きがあっても割り当てられない → 解決で割り当てる
        {
          const material = await createCatalogMaterial(client);
          const catalog = { itemId: material.itemId, variantId: material.variantId };
          await restockStock(client, { ...catalog, quantity: 1 });
          const order = await withGroupG1Material(client, async () => {
            await lockE2eInventory(client, { variantIds: [material.variantId] });
            return insertOrderWithLines(client, {
              status: 'payment_in_progress',
              shippingEmail: uniqueEmail('g2-111-review'),
              lines: [{ itemId: material.itemId, variantId: material.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }],
            });
          });
          const marked = (await client.query(
            `select updated, amount_matches from public.mark_order_paid($1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', false, 'order_confirmed', null)`,
            [order.orderId, `pi_e2e_${Date.now().toString(36)}`, PRICE + 1],
          )).rows[0];
          expect(marked).toEqual({ updated: true, amount_matches: false });
          const exception = (await client.query('select id from public.payment_exceptions where order_id = $1 and resolved_at is null', [order.orderId])).rows[0];
          expect(typeof exception.id).toBe('string');
          await expectDb(material, { free: 1, paidAllocated: 0, onHand: 1 });
          const resolved = (await client.query(
            'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)', [exception.id, actorId, 'E2E の確認'],
          )).rows[0];
          expect(resolved.resolved).toBe(true);
          await expectDb(material, { free: 0, paidAllocated: 1, onHand: 1 });
          checks.push({ name: '要確認の解消', material, screen: { orderQuantity: 1, onHand: 1, onOrder: 0, required: 0 }, breakdown: breakdownText(0, 1, 0) });
        }

        // (4) 取消申請のお断り: 申請中の数は FIFO が飛ばし、お断りで戻った未割当の数が空きを受ける
        {
          const material = await createCatalogMaterial(client);
          const catalog = { itemId: material.itemId, variantId: material.variantId };
          const saved =(await client.query('select requests_enabled, request_types from public.shop_return_settings where id = 1')).rows[0];
          try {
            await client.query(
              `update public.shop_return_settings set requests_enabled = true, request_types = 'returns_and_cancellations' where id = 1`,
            );
            const ownerId = (await client.query(
              `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
               values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
              [uniqueEmail('g2-111-owner')],
            )).rows[0].id as string;
            await restockStock(client, { ...catalog, quantity: 1 });
            const older = await createWaitingOrder(client, { catalog, quantity: 2, orderedAt: '2026-01-01T00:00:00Z' });
            await withGroupG1Material(client, async () => {
              await lockE2eInventory(client, { variantIds: [material.variantId], orderIds: [older.orderId] });
              await seedE2eAllocation(client, { orderItemId: older.orderItemId, quantity: 1, kind: 'paid' });
            });
            await client.query('update public.orders set user_id = $1 where id = $2', [ownerId, older.orderId]);
            const newer = await createWaitingOrder(client, { catalog, quantity: 1, orderedAt: '2026-02-01T00:00:00Z' });
            const request = (await client.query(
              'select * from public.customer_request_cancel($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::text)',
              [older.orderId, ownerId, randomUUID(), JSON.stringify([{ order_item_id: older.orderItemId, quantity: 2 }]), null],
            )).rows[0];
            // 入荷 +2: 申請中の古い注文は飛ばされ、新しい注文が 1 点を受ける（空き 1 が残る）
            await restockStock(client, { ...catalog, quantity: 2 });
            expect(await paidAllocationOf(client, newer.orderItemId)).toBe(1);
            await expectDb(material, { free: 1, paidAllocated: 2, onHand: 3 });
            await client.query('select * from public.admin_decline_cancel_request($1::uuid, $2::uuid, $3::text, $4::text)', [
              request.cancel_request_id, actorId, 'other', '受付できません。',
            ]);
            expect(await paidAllocationOf(client, older.orderItemId)).toBe(2);
            await expectDb(material, { free: 0, paidAllocated: 3, onHand: 3 });
          } finally {
            await client.query('update public.shop_return_settings set requests_enabled = $1, request_types = $2 where id = 1', [
              saved.requests_enabled, saved.request_types,
            ]);
          }
          checks.push({ name: '取消申請のお断り', material, screen: { orderQuantity: 3, onHand: 3, onOrder: 0, required: 0 }, breakdown: breakdownText(0, 3, 0) });
        }

        // (5) 返品の受け取り: 戻って再販する品が、待ち注文へ割り当てられる
        {
          const fx = await createShippedOrder(client, 'g2-111-return', [{ name: 'E2E返品', quantity: 1, fulfillmentType: 'stock' }]);
          const itemName = (await client.query('select name from public.items where id = $1', [fx.itemId])).rows[0].name as string;
          const material: CatalogMaterial = { itemId: fx.itemId, variantId: fx.variantId, itemName, colorName: 'BLACK', sizeLabel: 'M' };
          await createWaitingOrder(client, { catalog: material, quantity: 1 });
          const created = await createReturnInDb(client, fx, { lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], notify: false });
          await expectDb(material, { free: 0, paidAllocated: 0, onHand: 0 });
          await receiveReturnInDb(client, created.returnId, fx.actorId, {
            units: [{ lineId: created.lineIds[fx.orderItemIds[0]], disposition: 'restocked', quantity: 1 }], notify: false,
          });
          await expectDb(material, { free: 0, paidAllocated: 1, onHand: 1 });
          checks.push({ name: '返品の受け取り', material, screen: { orderQuantity: 1, onHand: 1, onOrder: 0, required: 0 }, breakdown: breakdownText(0, 1, 0) });
        }

        // 一覧を開くと（開き直すと）、5つの結果が1つの表に出ている
        await openInventory(page, ctx);
        for (const check of checks) {
          await test.step(check.name, async () => {
            await expectInventoryRow(page, check.material, check.screen, check.breakdown);
          });
        }
        await page.reload();
        await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
        for (const check of checks) {
          expect(await readInventoryRowOnScreen(inventoryRowOf(page, check.material)), check.name).toEqual(check.screen);
        }
        await expectNoPageOverflow(page);
      }));
    });

    test('棚卸の減で新しい注文の割当から外れた結果が在庫一覧表に反映される', async ({ page }) => {
      // FREQ-521-AC-01, FREQ-522-AC-02。棚卸の減の画面操作はこの spec の対象ではない（先頭のとおり。入口の中身は G-1 の DB 結合 group_g1_stock_api）
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const catalog = { itemId: material.itemId, variantId: material.variantId };
        // 空き 2 を入れ、古い入金済みの注文と新しい入金済みの注文が 1 点ずつ割当を持つ（空き 0）
        await restockStock(client, { ...catalog, quantity: 2 });
        const older = await createOrderWithLines(client, uniqueEmail('g2-111-older'), [{ name: 'E2E古い注文', quantity: 1, fulfillmentType: 'stock' }], { catalog });
        const newer = await createOrderWithLines(client, uniqueEmail('g2-111-newer'), [{ name: 'E2E新しい注文', quantity: 1, fulfillmentType: 'stock' }], { catalog });
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 2, onHand: 2 });

        await openInventory(page, ctx);
        expect(await readInventoryRowOnScreen(inventoryRowOf(page, material))).toEqual({ orderQuantity: 2, onHand: 2, onOrder: 0, required: 0 });

        // 棚卸で 1 点減らす: 空きが 0 なので、新しい注文の割当が外れる（入口が返す確認の点数 1 で送り直す）
        expect(await adjustStock(client, { ...catalog, quantity: -1 })).toEqual({ releasedQuantity: 1 });
        expect(await paidAllocationOf(client, older.orderItemIds[0])).toBe(1);
        expect(await paidAllocationOf(client, newer.orderItemIds[0])).toBe(0);

        // 開き直すと: 在庫 1・注文数 2 のまま（新しい注文が待ちに戻る）・発注必要数 2 − 1 − 0 = 1
        await page.reload();
        await expectInventoryRow(page, material, { orderQuantity: 2, onHand: 1, onOrder: 0, required: 1 }, breakdownText(0, 1, 0));
        await expectNoPageOverflow(page);
      });
    });
  });
}
