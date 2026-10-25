/**
 * FR-ADMIN-115 発注書の受け取り（全部・一部・後日）と、受け取りの取消・数量訂正（グループ G-2）
 * 対応 FREQ: FREQ-529（AC-01・AC-02・AC-04・AC-05）、FREQ-525（AC-01）
 *
 * 画面 → 窓口の差し替え（e2e/purchasing-test-utils.ts）→ 手元の DB の関数（admin_receive_purchase_order・admin_reverse_purchase_order_receipt ほか）
 * で確かめる。材料の発注書・待ち注文は DB の公開関数で作り、画面では受け取りと取消を操作する。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・CSRF・回数の制限・監査 → FR-ADMIN-123 の G-2 の節（本物の窓口の 401/403）と各 route の単体
 * - 同じ request_key の再送・版の競合・並行した受け取りと取消の保存則・deadlock 0 → DB 結合 group_g2_purchase_receipts・group_g2_purchase_receipt_reversals・group_g2_concurrency
 * - 出荷で消費された割当は外せない（消費の入口は G-3 まで無い）→ DB 結合 group_g2_purchase_receipt_reversals
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatPurchaseOrderDay } from '@/lib/purchase-orders/purchase-order-types';
import { viewports } from './order-fulfillment-test-utils';
import {
  adjustStock,
  confirmPurchaseOrderInDb,
  createCatalogMaterial,
  createPurchaseOrderInDb,
  createWaitingOrder,
  expectNoPageOverflow,
  inventoryRowOf,
  jstToday,
  lineRowOf,
  materialLabel,
  paidAllocationOf,
  preparePurchasingPage,
  readInventoryRowOnScreen,
  readLineQuantities,
  readPurchaseOrder,
  receivePurchaseOrderInDb,
  restockStock,
  variantInventory,
  withPurchasingScenario,
  type CatalogMaterial,
  type PurchasingContext,
} from './purchasing-test-utils';

test.describe.configure({ timeout: 150_000 });

async function openDetail(page: Page, ctx: PurchasingContext, purchaseOrderId: string, number: string): Promise<void> {
  await preparePurchasingPage(page, ctx);
  await page.goto(`/admin/purchase-orders/${purchaseOrderId}`);
  await expect(page.getByRole('heading', { name: `発注書 ${number}`, level: 1, exact: true })).toBeVisible();
}

const notice = (page: Page, text: string): Locator => page.getByRole('status').filter({ hasText: text });
const stageOf = (page: Page, text: string): Locator => page.locator('dd').filter({ hasText: text });
const receivedInput = (dialog: Locator, material: CatalogMaterial): Locator =>
  dialog.getByLabel(`${materialLabel(material)} の今回受け取った数`, { exact: true });

/** 確定済みの発注書（1行・単価つき）を作り、画面で開ける形にする */
async function confirmedOrder(ctx: PurchasingContext, material: CatalogMaterial, quantity: number) {
  const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity }] });
  await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity, unitPriceYen: 1000 }]);
  return created;
}

/** 受取ごとのボタンの名前は日付つき（頁の「数量を訂正」と区別する）。同じ日の受取は同じ名前になるので、受取が1件の時に使う */
async function receiptDay(ctx: PurchasingContext, purchaseOrderId: string): Promise<string> {
  const detail = await readPurchaseOrder(ctx.client, ctx.actorId, purchaseOrderId);
  return formatPurchaseOrderDay(detail.receipts[0].receivedOn);
}

const stockMovementCount = async (ctx: PurchasingContext, variantId: number, delta: number): Promise<number> =>
  (await ctx.client.query(
    `select count(*)::int as n from public.stock_movements where variant_id = $1 and reason = 'restock' and delta = $2`, [variantId, delta],
  )).rows[0].n as number;

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-115 purchase order receipts (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('全部受け取るで未納が初期値になり、在庫と納品済みと未納と古い注文の割当が一度に変わる', async ({ page }) => {
      // FREQ-529-AC-01
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const older = await createWaitingOrder(client, { catalog: material, quantity: 2, orderedAt: '2026-01-01T00:00:00Z' });
        const newer = await createWaitingOrder(client, { catalog: material, quantity: 4, orderedAt: '2026-02-01T00:00:00Z' });
        const created = await confirmedOrder(ctx, material, 5);
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: '全部受け取る', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '全部を受け取る', exact: true });
        await expect(dialog).toBeVisible();
        // 今回受け取った数の初期値は未納（5）で、変えられない
        await expect(receivedInput(dialog, material)).toHaveValue('5');
        await expect(receivedInput(dialog, material)).toHaveAttribute('readonly', '');
        await dialog.getByRole('button', { name: '受け取りを確定', exact: true }).click();

        await expect(notice(page, '受け取りを記録しました。')).toBeVisible();
        await expect(dialog).toHaveCount(0);
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 5, received: 5, outstanding: 0 });
        await expect(stageOf(page, '受け取り完了')).toBeVisible();
        await expect(page.getByRole('listitem').filter({ hasText: '受け取り' }).filter({ hasText: '+5' })).toBeVisible();

        // 在庫・古い注文の割当が一度に変わる: 古い注文に 2 点、新しい注文に 3 点
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 5, onHand: 5 });
        expect(await paidAllocationOf(client, older.orderItemId)).toBe(2);
        expect(await paidAllocationOf(client, newer.orderItemId)).toBe(3);
        expect(await stockMovementCount(ctx, material.variantId, 5)).toBe(1);
        await expectNoPageOverflow(page);
      });
    });

    test('一部を受け取り、後日の未納も通常どおり受け取れる', async ({ page }) => {
      // FREQ-529-AC-01
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await confirmedOrder(ctx, material, 5);
        await openDetail(page, ctx, created.id, created.number);

        // 一部: 空欄で始まり、受け取る数だけを入れる
        await page.getByRole('button', { name: '一部を受け取る', exact: true }).click();
        const part = page.getByRole('dialog', { name: '一部を受け取る', exact: true });
        await expect(part).toBeVisible();
        await expect(receivedInput(part, material)).toHaveValue('');
        await expect(part.getByRole('button', { name: '受け取りを確定', exact: true })).toBeDisabled();
        await receivedInput(part, material).fill('2');
        await part.getByRole('button', { name: '受け取りを確定', exact: true }).click();
        await expect(notice(page, '受け取りを記録しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 5, received: 2, outstanding: 3 });
        await expect(stageOf(page, '一部受け取り済み')).toBeVisible();
        expect(await variantInventory(ctx.client, material.variantId)).toMatchObject({ free: 2, onHand: 2 });

        // 後日の未納: 全部受け取るの初期値は残りの 3
        await page.getByRole('button', { name: '全部受け取る', exact: true }).click();
        const rest = page.getByRole('dialog', { name: '全部を受け取る', exact: true });
        await expect(receivedInput(rest, material)).toHaveValue('3');
        await rest.getByRole('button', { name: '受け取りを確定', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(rest).toHaveCount(0);
        await expect.poll(async () => (await readLineQuantities(lineRowOf(page, material))).received).toBe(5);
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ outstanding: 0 });
        await expect(stageOf(page, '受け取り完了')).toBeVisible();
        expect(await variantInventory(ctx.client, material.variantId)).toMatchObject({ free: 5, onHand: 5 });
        await expectNoPageOverflow(page);
      });
    });

    test('二重送信しても在庫は一度しか増えない', async ({ page }) => {
      // FREQ-529-AC-02
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await confirmedOrder(ctx, material, 4);
        await openDetail(page, ctx, created.id, created.number);
        const posts: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/receipts')) posts.push(request.url());
        });

        await page.getByRole('button', { name: '全部受け取る', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '全部を受け取る', exact: true });
        await dialog.getByRole('button', { name: '受け取りを確定', exact: true }).dblclick();
        await expect(notice(page, '受け取りを記録しました。')).toBeVisible();

        expect(posts).toHaveLength(1);
        expect(await variantInventory(ctx.client, material.variantId)).toMatchObject({ free: 4, onHand: 4 });
        expect(await stockMovementCount(ctx, material.variantId, 4)).toBe(1);
        const receipts = (await ctx.client.query(
          `select count(*)::int as n from public.purchase_order_receipts where purchase_order_id = $1 and kind = 'receive'`, [created.id],
        )).rows[0].n;
        expect(receipts).toBe(1);
        await expectNoPageOverflow(page);
      });
    });

    test('数量確定前の発注書は受け取れず、未納を超える数は断られる', async ({ page }) => {
      // FREQ-529-AC-01, FREQ-529-AC-02
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 3 }] });
        await openDetail(page, ctx, created.id, created.number);

        // 数量確定前: 受け取りの入口は出ない。画面の通信の道（bridge。本物の route ではなく DB の関数の拒否）へ直に送っても断られ、何も変わらない
        await expect(page.getByRole('button', { name: '全部受け取る', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '一部を受け取る', exact: true })).toHaveCount(0);
        const before = await readPurchaseOrder(client, ctx.actorId, created.id);
        const post = (lineId: string, quantity: number, version: number) => page.evaluate(async (body) => {
          const response = await fetch(`/api/admin/purchase-orders/${body.id}/receipts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedVersion: body.version, receivedOn: body.day, lines: [{ lineId: body.lineId, quantity: body.quantity }], requestKey: body.key }),
          });
          return { status: response.status, json: (await response.json()) as { code?: string; error?: string } };
        }, { id: created.id, version, day: jstToday(), lineId, quantity, key: randomUUID() });
        const refused = await post(before.lines[0].id, 1, before.version);
        expect(refused).toEqual({ status: 409, json: { code: 'GROUP_G_PO_NOT_CONFIRMED', error: '数量が確定するまで受け取りはできません。' } });
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, onHand: 0 });

        // 確定した後: 未納（3）を超える数は、画面でも窓口でも断られる
        const confirmed = await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity: 3, unitPriceYen: 1000 }]);
        await page.reload();
        await expect(page.getByRole('heading', { name: `発注書 ${created.number}`, level: 1, exact: true })).toBeVisible();
        await page.getByRole('button', { name: '一部を受け取る', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '一部を受け取る', exact: true });
        await receivedInput(dialog, material).fill('4');
        await expect(dialog.getByRole('alert')).toHaveText('未納の数を超えて受け取ることはできません。先に数量を訂正してください。');
        await expect(dialog.getByRole('button', { name: '受け取りを確定', exact: true })).toBeDisabled();
        const exceeded = await post(confirmed.lines[0].id, 4, confirmed.version);
        expect(exceeded.status).toBe(409);
        expect(exceeded.json.code).toBe('GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING');
        expect(exceeded.json.error).toBe('未納の数を超えて受け取ることはできません。先に数量を訂正してください。');
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, onHand: 0 });
        await expectNoPageOverflow(page);
      });
    });

    test('受け取りを取り消すと納品済みが戻って未納が増え、在庫一覧表の在庫が減り、発注必要数は変わらない', async ({ page }) => {
      // FREQ-529-AC-04, FREQ-525-AC-01
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await confirmedOrder(ctx, material, 3);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        // 受け取りの「後」に入金済みの待ち注文 5 を作る（作るだけでは FIFO は走らないので、空き 3 が残る）。
        // 取消は空き 3 から減らすので、外す割当は無く、確認も出ない。発注必要数は 5 − 3 − 0 = 2 と 5 − 0 − 3 = 2 で、0 に張り付かない
        await createWaitingOrder(ctx.client, { catalog: material, quantity: 5 });
        expect(await variantInventory(ctx.client, material.variantId)).toMatchObject({ free: 3, paidAllocated: 0, onHand: 3 });

        await preparePurchasingPage(page, ctx);
        await page.goto('/admin/inventory');
        await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
        // 取消の前: 注文数 5・在庫 3・発注済み 0・発注必要数 2
        const before = await readInventoryRowOnScreen(inventoryRowOf(page, material));
        expect(before).toEqual({ orderQuantity: 5, onHand: 3, onOrder: 0, required: 2 });

        const day = await receiptDay(ctx, created.id);
        await page.goto(`/admin/purchase-orders/${created.id}`);
        await expect(page.getByRole('heading', { name: `発注書 ${created.number}`, level: 1, exact: true })).toBeVisible();
        await page.getByRole('button', { name: `この受け取りを取り消す（${day}）`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '受け取りの取消', exact: true });
        await expect(dialog).toBeVisible();
        const submit = dialog.getByRole('button', { name: '取り消す', exact: true });
        await expect(submit).toBeDisabled();
        await dialog.getByLabel('理由', { exact: true }).fill('検品で不良が見つかった');
        await submit.click();

        await expect(notice(page, '受け取りを取り消しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 3, received: 0, outstanding: 3 });
        await expect(stageOf(page, '数量確定済み・受け取り待ち')).toBeVisible();
        await expect(page.getByRole('listitem').filter({ hasText: '受け取りの取消' }).filter({ hasText: '-3' })).toBeVisible();

        // 在庫一覧表: 在庫は 3 → 0、発注済みは 0 → 3（未納が戻る）、発注必要数は 2 のまま
        await page.goto('/admin/inventory');
        await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
        const after = await readInventoryRowOnScreen(inventoryRowOf(page, material));
        expect(after).toEqual({ orderQuantity: 5, onHand: 0, onOrder: 3, required: before.required });
        expect(after.required).toBe(2);
        await expectNoPageOverflow(page);
      });
    });

    test('数量だけを訂正でき、取り消せる数が減る', async ({ page }) => {
      // FREQ-529-AC-04
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await confirmedOrder(ctx, material, 5);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 5 }]);
        const day = await receiptDay(ctx, created.id);
        await openDetail(page, ctx, created.id, created.number);

        // 訂正: 取り消す行と数を選ぶ（空欄で始まる）。取り消せる数は 5
        await page.getByRole('button', { name: `数量を訂正（${day}）`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '受け取り数量の訂正', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('purchase-order-reverse-row')).toContainText('取り消せる数 5');
        const entry = dialog.getByLabel('取り消す数', { exact: true });
        await expect(entry).toHaveValue('');
        await entry.fill('6');
        await expect(dialog.getByRole('alert').filter({ hasText: '取り消せる数を超えています。' })).toBeVisible();
        await entry.fill('2');
        await dialog.getByLabel('理由', { exact: true }).fill('数え間違い');
        await dialog.getByRole('button', { name: '訂正する', exact: true }).click();

        await expect(notice(page, '受け取り数量を訂正しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 5, received: 3, outstanding: 2 });
        await expect(stageOf(page, '一部受け取り済み')).toBeVisible();
        expect(await variantInventory(ctx.client, material.variantId)).toMatchObject({ free: 3, onHand: 3 });

        // 取り消せる数は 3 に減っている
        await page.getByRole('button', { name: `数量を訂正（${day}）`, exact: true }).click();
        const again = page.getByRole('dialog', { name: '受け取り数量の訂正', exact: true });
        await expect(again.getByTestId('purchase-order-reverse-row')).toContainText('取り消せる数 3');
        await expectNoPageOverflow(page);
      });
    });

    test('受け取った在庫が古い注文に割り当て済みで空き在庫が0だと、取消の最初の送信は確認の文「割り当て済みの品を〇点外し、受注生産中に戻します。」が出て何も変わらず、確認すると新しい注文の割当から外れて納品済みが戻る', async ({ page }) => {
      // FREQ-529-AC-04, FREQ-529-AC-05
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        // 古い待ち注文（3 点）と新しい待ち注文（1 点）。発注の受け取り 3 は古い順に古い注文へ入り、続く入荷 1 が新しい注文へ入る（空き在庫 0）
        const older = await createWaitingOrder(client, { catalog: material, quantity: 3, orderedAt: '2026-01-01T00:00:00Z' });
        const newer = await createWaitingOrder(client, { catalog: material, quantity: 1, orderedAt: '2026-02-01T00:00:00Z' });
        const created = await confirmedOrder(ctx, material, 3);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        await restockStock(client, { itemId: material.itemId, variantId: material.variantId, quantity: 1 });
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 4, onHand: 4 });
        expect(await paidAllocationOf(client, older.orderItemId)).toBe(3);
        expect(await paidAllocationOf(client, newer.orderItemId)).toBe(1);
        const day = await receiptDay(ctx, created.id);
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: `この受け取りを取り消す（${day}）`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '受け取りの取消', exact: true });
        await dialog.getByLabel('理由', { exact: true }).fill('取り違えて入荷した');
        await dialog.getByRole('button', { name: '取り消す', exact: true }).click();

        // 最初の送信: 確認の文が出て、何も変わらない（納品済み 3・割当 古い 3 + 新しい 1・在庫 4 のまま）
        await expect(dialog.getByTestId('purchase-order-release-confirmation')).toHaveText('割り当て済みの品を3点外し、受注生産中に戻します。');
        const unchanged = await readPurchaseOrder(client, ctx.actorId, created.id);
        expect(unchanged.lines[0].receivedQuantity).toBe(3);
        expect(unchanged.receipts).toHaveLength(1);
        expect(await paidAllocationOf(client, older.orderItemId)).toBe(3);
        expect(await paidAllocationOf(client, newer.orderItemId)).toBe(1);
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 4, onHand: 4 });

        // 確認して送り直す: 外れるのは新しい注文の割当から（新しい 1 → 0、古い 3 → 1）。納品済みが戻る
        await dialog.getByRole('button', { name: '取り消す', exact: true }).click();
        await expect(notice(page, '受け取りを取り消しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 3, received: 0, outstanding: 3 });
        expect(await paidAllocationOf(client, newer.orderItemId)).toBe(0);
        expect(await paidAllocationOf(client, older.orderItemId)).toBe(1);
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 0, paidAllocated: 1, onHand: 1 });
        await expectNoPageOverflow(page);
      });
    });

    test('取り消す数が空き在庫と外せる割当の合計を超えると断りの文が出て、何も変わらない', async ({ page }) => {
      // FREQ-529-AC-05
      await withPurchasingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createCatalogMaterial(client);
        const created = await confirmedOrder(ctx, material, 3);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        // 棚卸で 2 点減らし、空き在庫は 1（外せる割当は無い）。3 点の取消は合計を超える
        await adjustStock(client, { itemId: material.itemId, variantId: material.variantId, quantity: -2 });
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 1, paidAllocated: 0, onHand: 1 });
        const day = await receiptDay(ctx, created.id);
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: `この受け取りを取り消す（${day}）`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '受け取りの取消', exact: true });
        await dialog.getByLabel('理由', { exact: true }).fill('全部返す');
        await dialog.getByRole('button', { name: '取り消す', exact: true }).click();

        await expect(dialog.getByRole('alert')).toHaveText('在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。');
        await expect(dialog.getByTestId('purchase-order-release-confirmation')).toHaveCount(0);
        // 何も変わらない: 納品済み 3・受取 1 件・空き在庫 1
        const detail = await readPurchaseOrder(client, ctx.actorId, created.id);
        expect(detail.lines[0].receivedQuantity).toBe(3);
        expect(detail.receipts).toHaveLength(1);
        expect(await variantInventory(client, material.variantId)).toMatchObject({ free: 1, onHand: 1 });
        await expectNoPageOverflow(page);
      });
    });
  });
}
