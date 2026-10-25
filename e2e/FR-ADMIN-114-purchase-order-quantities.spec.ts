/**
 * FR-ADMIN-114 発注書の数量の確定・訂正・残りの打切り・発注の取消と、発注一覧表（グループ G-2）
 * 対応 FREQ: FREQ-527（AC-01・AC-02）、FREQ-528（AC-01・AC-02）、FREQ-526（AC-04）、FREQ-525（AC-02）
 *
 * 画面 → 窓口の差し替え（e2e/purchasing-test-utils.ts）→ 手元の DB の関数で確かめる。材料の発注書（数量確定待ち・確定済み・受け取り済み）は
 * DB の公開関数で作り、画面では数量の確定・訂正、打切り、取消、一覧を操作する。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・CSRF・回数の制限・監査 → FR-ADMIN-123 の G-2 の節（本物の窓口の 401/403）と各 route の単体
 * - 版の競合（GROUP_G_PO_VERSION_CONFLICT）・同じ request_key の再送・引数の検証・追記専用の履歴 → DB 結合 group_g2_purchase_quantities
 * - 表示の段階の導出（受け取り済み・完了など）の全場合 → DB 結合 group_g2_purchase_reads
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { viewports } from './order-fulfillment-test-utils';
import {
  callDb,
  confirmPurchaseOrderInDb,
  createCatalogMaterial,
  createPurchaseOrderInDb,
  createWaitingOrder,
  expectNoPageOverflow,
  inventoryRowOf,
  lineRowOf,
  preparePurchasingPage,
  readInventoryRow,
  readInventoryRowOnScreen,
  readLineQuantities,
  readPurchaseOrder,
  receivePurchaseOrderInDb,
  withPurchasingScenario,
  type CatalogMaterial,
  type PurchasingContext,
} from './purchasing-test-utils';

test.describe.configure({ timeout: 120_000 });

async function openDetail(page: Page, ctx: PurchasingContext, purchaseOrderId: string, number: string): Promise<void> {
  await preparePurchasingPage(page, ctx);
  await page.goto(`/admin/purchase-orders/${purchaseOrderId}`);
  await expect(page.getByRole('heading', { name: `発注書 ${number}`, level: 1, exact: true })).toBeVisible();
}

const notice = (page: Page, text: string): Locator => page.getByRole('status').filter({ hasText: text });
const stageOf = (page: Page, text: string): Locator => page.locator('dd').filter({ hasText: text });

/** 数量の確定・訂正のダイアログの、その商品の行 */
const quantityRowOf = (dialog: Locator, material: CatalogMaterial): Locator =>
  dialog.getByTestId('purchase-order-quantity-row').filter({ hasText: material.itemName });

async function shortCloseInDb(ctx: PurchasingContext, purchaseOrderId: string, lineIds: string[], reason: string): Promise<void> {
  const detail = await readPurchaseOrder(ctx.client, ctx.actorId, purchaseOrderId);
  await callDb(ctx.client, 'admin_short_close_purchase_order', [
    ['_purchase_order_id', purchaseOrderId, 'uuid'], ['_expected_version', detail.version], ['_line_ids', lineIds, 'uuid[]'],
    ['_reason', reason, 'text'], ['_actor_id', ctx.actorId, 'uuid'], ['_request_key', randomUUID(), 'uuid'],
  ]);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-114 purchase order quantities (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('数量確定で各行を増減し、単価は未入力と0円を区別して保存される', async ({ page }) => {
      // FREQ-527-AC-01
      await withPurchasingScenario(async (ctx) => {
        const first = await createCatalogMaterial(ctx.client);
        const second = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, {
          lines: [{ variantId: first.variantId, quantity: 5 }, { variantId: second.variantId, quantity: 4 }],
        });
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: '数量確定', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '数量の確定', exact: true });
        await expect(dialog).toBeVisible();
        // 仮数量が初期値。1行目は増やして単価は未入力、2行目は減らして単価は 0
        await expect(quantityRowOf(dialog, first).getByLabel('数量', { exact: true })).toHaveValue('5');
        await quantityRowOf(dialog, first).getByLabel('数量', { exact: true }).fill('6');
        await expect(quantityRowOf(dialog, first).getByLabel('単価（円）', { exact: true })).toHaveValue('');
        await quantityRowOf(dialog, second).getByLabel('数量', { exact: true }).fill('3');
        await quantityRowOf(dialog, second).getByLabel('単価（円）', { exact: true }).fill('0');
        await dialog.getByRole('button', { name: '確定する', exact: true }).click();

        await expect(notice(page, '数量を確定しました。')).toBeVisible();
        await expect(dialog).toHaveCount(0);
        expect(await readLineQuantities(lineRowOf(page, first))).toEqual({ provisional: 5, ordered: 6, received: 0, outstanding: 6, unitPrice: '未登録' });
        expect(await readLineQuantities(lineRowOf(page, second))).toEqual({ provisional: 4, ordered: 3, received: 0, outstanding: 3, unitPrice: '0' });
        await expect(stageOf(page, '数量確定済み・受け取り待ち')).toBeVisible();
        // 単価が未登録の行があるので、バッジが出る
        await expect(page.getByText('単価未登録', { exact: true })).toBeVisible();

        // DB: 未入力は NULL、0 円は 0 として保存される
        const saved = await readPurchaseOrder(ctx.client, ctx.actorId, created.id);
        expect(saved.lines.map((line) => [line.orderQuantity, line.unitPriceYen])).toEqual([[6, null], [3, 0]]);
        await expect(page.getByTestId('purchase-order-revision').filter({ hasText: '数量の確定・訂正' }).first()).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('納品済みより少ない数量には訂正できず、訂正には理由が要る', async ({ page }) => {
      // FREQ-527-AC-01, FREQ-527-AC-02
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 5 }] });
        await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity: 5, unitPriceYen: 1200 }]);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: '数量を訂正', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '数量の訂正', exact: true });
        await expect(dialog).toBeVisible();
        const row = quantityRowOf(dialog, material);
        const submit = dialog.getByRole('button', { name: '確定する', exact: true });

        // 納品済み（3）より少ない数量: 行の下に文が出て、確定できない
        await row.getByLabel('数量', { exact: true }).fill('2');
        await expect(row.getByRole('alert')).toHaveText('納品済みの数より少ない数量には訂正できません。');
        await dialog.getByLabel('理由', { exact: true }).fill('数量の見直し');
        await expect(submit).toBeDisabled();

        // 納品済み以上なら文は消える。理由が空の間は確定できない
        await row.getByLabel('数量', { exact: true }).fill('4');
        await expect(row.getByRole('alert')).toHaveCount(0);
        await dialog.getByLabel('理由', { exact: true }).fill('');
        await expect(submit).toBeDisabled();

        // 理由を入れると確定できる（キーボードで押す）
        await dialog.getByLabel('理由', { exact: true }).fill('先方の都合で 4 に減らす');
        await expect(submit).toBeEnabled();
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect(notice(page, '数量を訂正しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 4, received: 3, outstanding: 1 });
        await expect(page.getByTestId('purchase-order-revision').filter({ hasText: '先方の都合で 4 に減らす' })).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('残りを打ち切ると発注数量が納品済みまで下がり、未納0・履歴に変更前の数量と理由が残る', async ({ page }) => {
      // FREQ-528-AC-01
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 5 }] });
        await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity: 5, unitPriceYen: 800 }]);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        await openDetail(page, ctx, created.id, created.number);

        // 理由が空の間は「打ち切る」を押せない。選んだ行だけが並ぶ
        await page.getByRole('button', { name: '未納のある行をすべて選ぶ', exact: true }).click();
        await page.getByRole('button', { name: '残りを打ち切る', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '残りを打ち切る', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('purchase-order-close-row')).toHaveCount(1);
        await expect(dialog.getByTestId('purchase-order-close-row')).toContainText('未納 2 → 0');
        const submit = dialog.getByRole('button', { name: '打ち切る', exact: true });
        await expect(submit).toBeDisabled();
        await dialog.getByLabel('理由', { exact: true }).fill('先方の欠品');
        await expect(submit).toBeEnabled();
        await submit.click();

        await expect(notice(page, '残りを打ち切りました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 3, received: 3, outstanding: 0 });
        await expect(stageOf(page, '完了（残りを打ち切り）')).toBeVisible();
        // 履歴: 変更前の数量（5 → 3）と理由が残る
        const history = page.getByTestId('purchase-order-revision').filter({ hasText: '打切り' });
        await expect(history).toHaveCount(1);
        await expect(history).toContainText('数量 5 → 3');
        await expect(history).toContainText('先方の欠品');
        await expectNoPageOverflow(page);
      });
    });

    test('発注一覧表は7列で「打切り」の列が無い', async ({ page }) => {
      // FREQ-526-AC-04
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 2 }] });
        await preparePurchasingPage(page, ctx);
        await page.goto('/admin/purchase-orders');
        await expect(page.getByRole('heading', { name: '発注一覧表', level: 1, exact: true })).toBeVisible();
        await expect(page.getByRole('columnheader')).toHaveText(['発注書番号', '商品名', '色', 'サイズ', '発注数量', '納品済み', '未納']);
        await expect(page.getByRole('columnheader', { name: '打切り' })).toHaveCount(0);

        // 数量確定前の行は発注数量と未納が「数量未確定」（納品済みは 0）
        const row = page.getByTestId('purchase-order-row').filter({ hasText: created.number });
        await expect(row).toHaveCount(1);
        const cells = row.getByRole('cell');
        await expect(cells.nth(4)).toHaveText('数量未確定');
        await expect(cells.nth(5)).toHaveText('0');
        await expect(cells.nth(6)).toHaveText('数量未確定');

        // 発注書番号の行はキーボードで開ける
        const link = row.getByRole('link', { name: created.number, exact: true });
        await link.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/admin/purchase-orders/${created.id}$`));
        await expectNoPageOverflow(page);
      });
    });

    test('誤った打切りは理由付きの再確定で戻せる', async ({ page }) => {
      // FREQ-528-AC-02
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 5 }] });
        const confirmed = await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity: 5, unitPriceYen: 500 }]);
        await receivePurchaseOrderInDb(ctx, created.id, [{ lineIndex: 0, quantity: 3 }]);
        await shortCloseInDb(ctx, created.id, [confirmed.lines[0].id], '誤って打ち切った');
        await openDetail(page, ctx, created.id, created.number);
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 3, received: 3, outstanding: 0 });
        await expect(stageOf(page, '完了（残りを打ち切り）')).toBeVisible();

        // 理由付きで元の数量 5 に戻す
        await page.getByRole('button', { name: '数量を訂正', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '数量の訂正', exact: true });
        await quantityRowOf(dialog, material).getByLabel('数量', { exact: true }).fill('5');
        await dialog.getByLabel('理由', { exact: true }).fill('打切りの誤りを戻す');
        await dialog.getByRole('button', { name: '確定する', exact: true }).click();

        await expect(notice(page, '数量を訂正しました。')).toBeVisible();
        expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ ordered: 5, received: 3, outstanding: 2 });
        await expect(stageOf(page, '一部受け取り済み')).toBeVisible();
        // 元の打切りと履歴は残る
        const closed = page.getByTestId('purchase-order-revision').filter({ hasText: '誤って打ち切った' });
        await expect(closed).toHaveCount(1);
        await expect(closed).toContainText('打切り');
        await expect(page.getByTestId('purchase-order-revision').filter({ hasText: '打切りの誤りを戻す' })).toHaveCount(1);
        await expectNoPageOverflow(page);
      });
    });

    test('打切り後は発注必要数が増える', async ({ page }) => {
      // FREQ-525-AC-02, FREQ-528-AC-01
      await withPurchasingScenario(async (ctx) => {
        const { client, actorId } = ctx;
        const material = await createCatalogMaterial(client);
        // 入金済みの待ち注文 10 と、数量確定済みの発注 6（発注済み 6 → 発注必要数 10 − 0 − 6 = 4）
        await createWaitingOrder(client, { catalog: material, quantity: 10 });
        const created = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 6 }] });
        await confirmPurchaseOrderInDb(ctx, created.id, [{ quantity: 6, unitPriceYen: 1000 }]);
        expect(await readInventoryRow(client, actorId, material.variantId)).toEqual({ orderQuantity: 10, onHand: 0, onOrder: 6, required: 4 });

        await openDetail(page, ctx, created.id, created.number);
        await page.getByRole('button', { name: '未納のある行をすべて選ぶ', exact: true }).click();
        await page.getByRole('button', { name: '残りを打ち切る', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '残りを打ち切る', exact: true });
        await dialog.getByLabel('理由', { exact: true }).fill('発注を取りやめる');
        await dialog.getByRole('button', { name: '打ち切る', exact: true }).click();
        await expect(notice(page, '残りを打ち切りました。')).toBeVisible();

        // 在庫一覧表: 発注済みは 0、発注必要数は 10 に増える
        await page.goto('/admin/inventory');
        await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
        expect(await readInventoryRowOnScreen(inventoryRowOf(page, material))).toEqual({ orderQuantity: 10, onHand: 0, onOrder: 0, required: 10 });
        await expectNoPageOverflow(page);
      });
    });

    test('数量確定前の発注書は「発注を取り消す」で全行0の完了にでき、履歴に仮数量と理由が残る', async ({ page }) => {
      // FREQ-528-AC-02, FREQ-527-AC-02
      await withPurchasingScenario(async (ctx) => {
        const first = await createCatalogMaterial(ctx.client);
        const second = await createCatalogMaterial(ctx.client);
        const created = await createPurchaseOrderInDb(ctx, {
          lines: [{ variantId: first.variantId, quantity: 4 }, { variantId: second.variantId, quantity: 4 }],
        });
        await openDetail(page, ctx, created.id, created.number);

        await page.getByRole('button', { name: '発注を取り消す', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '発注の取消', exact: true });
        await expect(dialog).toBeVisible();
        const submit = dialog.getByRole('button', { name: '取り消す', exact: true });
        await expect(submit).toBeDisabled();
        await dialog.getByLabel('理由', { exact: true }).fill('発注先を変えるため取り消す');
        await submit.click();

        await expect(notice(page, '発注を取り消しました。')).toBeVisible();
        await expect(stageOf(page, '完了（残りを打ち切り）')).toBeVisible();
        for (const material of [first, second]) {
          expect(await readLineQuantities(lineRowOf(page, material))).toMatchObject({ provisional: 4, ordered: 0, received: 0, outstanding: 0 });
        }
        // 履歴: 行ごとに仮数量 4 → 0 と理由が残る
        const history = page.getByTestId('purchase-order-revision').filter({ hasText: '打切り' });
        await expect(history).toHaveCount(2);
        await expect(history.first()).toContainText('数量 4 → 0');
        await expect(history.first()).toContainText('発注先を変えるため取り消す');
        // 取消のあとは数量の確定も受け取りも出ない
        await expect(page.getByRole('button', { name: '全部受け取る', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '数量確定', exact: true })).toHaveCount(0);
        await expectNoPageOverflow(page);
      });
    });
  });
}
