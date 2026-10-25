/**
 * FR-ADMIN-113 在庫一覧表からの発注（入力 → 確認 → 確定）と、できた発注書（グループ G-2）
 * 対応 FREQ: FREQ-526（AC-01・AC-02・AC-03・AC-05）、FREQ-525（AC-02）
 *
 * 画面 → 窓口の差し替え（e2e/purchasing-test-utils.ts）→ 手元の DB の関数（admin_create_purchase_order ほか）で確かめる。
 * 管理者のログインは差し替え、権限の許否は DB の関数が決める。発注確定の後は /admin/purchase-orders/<id>?created=1 へ移る。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・CSRF・回数の制限・監査 → FR-ADMIN-123 の G-2 の節（本物の窓口の 401/403）と purchase-orders-route の単体
 * - 発注番号の採番の全場合（同日の2件目・日付の境・9999 超え）・引数の検証・同じ request_key の衝突 → DB 結合 group_g2_purchase_create
 * - 発注が在庫・割当・台帳・注文を動かさないこと → DB 結合 group_g2_purchase_create
 */
import { expect, test, type Page } from '@playwright/test';
import { viewports } from './order-fulfillment-test-utils';
import {
  createCatalogMaterial,
  expectNoPageOverflow,
  inventoryRowOf,
  lineRowOf,
  materialLabel,
  preparePurchasingPage,
  readInventoryRow,
  readInventoryRowOnScreen,
  readLineQuantities,
  withPurchasingScenario,
  type CatalogMaterial,
  type PurchasingContext,
} from './purchasing-test-utils';

test.describe.configure({ timeout: 120_000 });

const DETAIL_URL = /\/admin\/purchase-orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?created=1$/;
const NUMBER = /^PO-\d{8}-\d{4}$/;

const quantityInput = (page: Page, material: CatalogMaterial) => page.getByLabel(`${materialLabel(material)} の発注数量`, { exact: true });
const orderButton = (page: Page) => page.getByRole('button', { name: '発注', exact: true });
const reviewButton = (page: Page) => page.getByRole('button', { name: '発注書確認', exact: true });
const submitButton = (page: Page) => page.getByRole('button', { name: '発注確定', exact: true });

async function openInventory(page: Page, ctx: PurchasingContext): Promise<void> {
  await preparePurchasingPage(page, ctx);
  await page.goto('/admin/inventory');
  await expect(page.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
}

/** 発注を始め、数量を入れて確認の段へ進む（数量は画面と同じ入力欄に入れる） */
async function goToConfirmation(page: Page, entries: Array<{ material: CatalogMaterial; quantity: string }>): Promise<void> {
  await orderButton(page).click();
  for (const entry of entries) {
    const input = quantityInput(page, entry.material);
    await input.fill(entry.quantity);
  }
  await reviewButton(page).click();
  await expect(page.getByRole('heading', { name: '発注書の確認', level: 2, exact: true })).toBeVisible();
}

/** POST /api/admin/purchase-orders の要求を記録する（本文は再送の確認に使う） */
function recordCreatePosts(page: Page): Array<{ body: string | null }> {
  const posts: Array<{ body: string | null }> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/purchase-orders') {
      posts.push({ body: request.postData() });
    }
  });
  return posts;
}

async function createViaScreen(page: Page, material: CatalogMaterial, quantity: string, supplier: string): Promise<void> {
  await goToConfirmation(page, [{ material, quantity }]);
  await page.getByLabel('発注先', { exact: true }).fill(supplier);
  await submitButton(page).click();
  await expect(page).toHaveURL(DETAIL_URL);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-113 purchase order create (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('在庫一覧表から数量を空欄のまま発注を始め、正の整数の行だけが発注書の確認に並ぶ', async ({ page }) => {
      // FREQ-526-AC-01
      await withPurchasingScenario(async (ctx) => {
        const first = await createCatalogMaterial(ctx.client);
        const blank = await createCatalogMaterial(ctx.client);
        const zero = await createCatalogMaterial(ctx.client);
        await openInventory(page, ctx);

        await orderButton(page).click();
        // 数量は空欄で始まり、1行も入れていない間は「発注書確認」を押せない
        await expect(quantityInput(page, first)).toHaveValue('');
        await expect(reviewButton(page)).toBeDisabled();

        // キーボードで入れる: 欄へ移って打つ。0（正の整数でない）の行と空欄の行は発注書に入らない
        await quantityInput(page, first).focus();
        await page.keyboard.type('3');
        await quantityInput(page, zero).focus();
        await page.keyboard.type('0');
        await expect(quantityInput(page, blank)).toHaveValue('');
        await expect(reviewButton(page)).toBeEnabled();

        // 他の列の操作（在庫の内訳の開閉）で、入れた数量は消えない
        const toggle = inventoryRowOf(page, first).getByRole('button', { name: '在庫の内訳' });
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(quantityInput(page, first)).toHaveValue('3');

        // 「発注書確認」をキーボード（Enter）で押す
        await reviewButton(page).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: '発注書の確認', level: 2, exact: true })).toBeVisible();
        const region = page.getByRole('region', { name: '発注書の確認', exact: true });
        const rows = region.locator('tbody tr');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText(first.itemName);
        // 数量の欄（4列目）が 3（行全体の文字では商品名に含まれる数字と区別できない）
        await expect(rows.first().getByRole('cell').nth(3)).toHaveText('3');
        await expect(region).not.toContainText(blank.itemName);
        await expect(region).not.toContainText(zero.itemName);
        await expectNoPageOverflow(page);

        // 「戻る」で数量の入力へ戻ると、入れた数量はそのまま
        await page.getByRole('button', { name: '戻る', exact: true }).click();
        await expect(quantityInput(page, first)).toHaveValue('3');

        // 「キャンセル」で抜けて入れ直すと、空欄から始まる
        await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
        await orderButton(page).click();
        await expect(quantityInput(page, first)).toHaveValue('');
      });
    });

    test('発注先が空だと発注確定できず、納期の欄は無い', async ({ page }) => {
      // FREQ-526-AC-01
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        await openInventory(page, ctx);
        const posts = recordCreatePosts(page);
        await goToConfirmation(page, [{ material, quantity: '2' }]);

        // 発注先が空・空白だけ: 文を示して通信しない
        await submitButton(page).click();
        await expect(page.getByRole('alert').filter({ hasText: '発注先を入力してください。' })).toBeVisible();
        await page.getByLabel('発注先', { exact: true }).fill('   ');
        await submitButton(page).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert').filter({ hasText: '発注先を入力してください。' })).toBeVisible();
        expect(posts).toHaveLength(0);

        // 納期の欄は無い（発注先とメモだけ）
        await expect(page.getByLabel(/納期/)).toHaveCount(0);
        await expect(page.getByText('納期')).toHaveCount(0);
        await expect(page.getByLabel('メモ', { exact: true })).toBeVisible();

        // 入れ直した発注先は、誤りの後も保たれる（もう一度入れ直さなくてよい）
        const supplier = `E2E 発注先 ${Date.now().toString(36)}`;
        await page.getByLabel('発注先', { exact: true }).fill(supplier);
        await expect(page.getByLabel('発注先', { exact: true })).toHaveValue(supplier);
        await expectNoPageOverflow(page);
        expect(posts).toHaveLength(0);
      });
    });

    test('発注確定で発注番号が一度だけ付き、二重送信しても発注書は1件', async ({ page }) => {
      // FREQ-526-AC-02, FREQ-526-AC-03
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        await openInventory(page, ctx);
        const posts = recordCreatePosts(page);
        const supplier = `E2E 二重 ${Date.now().toString(36)}`;
        await goToConfirmation(page, [{ material, quantity: '4' }]);
        await page.getByLabel('発注先', { exact: true }).fill(supplier);
        await page.getByLabel('メモ', { exact: true }).fill('E2E の発注');
        await submitButton(page).dblclick();
        await expect(page).toHaveURL(DETAIL_URL);

        // 二重に押しても通信は1回、発注書は1件
        expect(posts).toHaveLength(1);
        const created = (await ctx.client.query(
          'select id, number, version, stage from public.purchase_orders where supplier_name = $1', [supplier],
        )).rows;
        expect(created).toHaveLength(1);
        expect(created[0].number).toMatch(NUMBER);
        expect(Number(created[0].version)).toBe(1);
        expect(created[0].stage).toBe('ordered');
        const lines = await ctx.client.query('select provisional_quantity from public.purchase_order_lines where purchase_order_id = $1', [created[0].id]);
        expect(lines.rows.map((row) => row.provisional_quantity)).toEqual([4]);
        await expect(page.getByRole('heading', { name: `発注書 ${created[0].number}`, level: 1, exact: true })).toBeVisible();

        // 同じ本文（同じ requestKey）をもう一度送っても、同じ発注書を「再送」として返し、増えない
        const replayed = await page.evaluate(async (body) => {
          const response = await fetch('/api/admin/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          return { status: response.status, json: (await response.json()) as { id: string; number: string; replayed: boolean } };
        }, posts[0].body as string);
        expect(replayed.status).toBe(201);
        expect(replayed.json).toMatchObject({ id: created[0].id, number: created[0].number, replayed: true });
        const count = (await ctx.client.query('select count(*)::int as n from public.purchase_orders where supplier_name = $1', [supplier])).rows[0].n;
        expect(count).toBe(1);

        // 開き直しても番号は同じ
        await page.reload();
        await expect(page.getByRole('heading', { name: `発注書 ${created[0].number}`, level: 1, exact: true })).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('確定直後の発注書は数量確定待ちで、発注数量は「数量未確定」、発注済みには数えない', async ({ page }) => {
      // FREQ-526-AC-01, FREQ-526-AC-05, FREQ-525-AC-02
      await withPurchasingScenario(async (ctx) => {
        const material = await createCatalogMaterial(ctx.client);
        await openInventory(page, ctx);
        const supplier = `E2E 確定待ち ${Date.now().toString(36)}`;
        await createViaScreen(page, material, '5', supplier);

        const number = (await ctx.client.query('select number from public.purchase_orders where supplier_name = $1', [supplier])).rows[0].number as string;
        // 作成の直後の通知（読み込んだ発注書の番号で出る）
        await expect(page.getByRole('status').filter({ hasText: `発注書 ${number} を作成しました。数量が確定するまで受け取りはできません。` })).toBeVisible();
        await expect(page.getByRole('heading', { name: `発注書 ${number}`, level: 1, exact: true })).toBeVisible();
        // 段階は数量確定待ち。発注数量と未納は「数量未確定」（納品済みは 0）
        await expect(page.locator('dd').filter({ hasText: '数量確定待ち' })).toBeVisible();
        const quantities = await readLineQuantities(lineRowOf(page, material));
        expect(quantities).toMatchObject({ provisional: 5, ordered: null, received: 0, outstanding: null });
        const line = lineRowOf(page, material);
        await expect(line.getByRole('cell').nth(4)).toHaveText('数量未確定');
        await expect(line.getByRole('cell').nth(6)).toHaveText('数量未確定');
        // 数量確定前は受け取れない
        await expect(page.getByRole('button', { name: '全部受け取る', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '数量確定', exact: true })).toBeVisible();

        // 発注済みには数えない: 在庫一覧表の発注済み・発注必要数は 0 のまま
        expect(await readInventoryRow(ctx.client, ctx.actorId, material.variantId)).toMatchObject({ onOrder: 0, required: 0 });
        await page.goto('/admin/inventory');
        expect(await readInventoryRowOnScreen(inventoryRowOf(page, material))).toMatchObject({ onOrder: 0, required: 0 });
        await expectNoPageOverflow(page);
      });
    });
  });
}
