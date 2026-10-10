/**
 * FR-ADMIN-073 在庫の4つの数と在庫の履歴
 * 対応 FREQ: FREQ-445（AC-01〜AC-03）
 *
 * 商品の編集画面の在庫の欄は窓口を差し替えて確かめる（FR-ADMIN-058 と同じやり方）。
 * 引き当て済みと受注生産の数え方・履歴の変わった後の数（AC-03）は、手元の DB の関数を直に呼んで確かめる。
 * 在庫の欄は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import { mockAdminBackgroundApis } from './admin-test-utils';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  recordCompletion,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import { fulfillJson, viewports } from './order-fulfillment-test-utils';

const ITEM_ID = '7';
const EXPLANATION =
  'すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。';

/** 棚に45入れ、注文のために7を取ってある。すぐ出せる数は38、受注生産の数は2 */
const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 38,
  isActive: true,
  committedQuantity: 7,
  onHandQuantity: 45,
  backorderQuantity: 2,
};

/** 新しい順。最後の入荷は店の人の操作、販売は注文の処理（動かした人が空なら「自動」） */
const MOVEMENTS = [
  {
    id: 9,
    variantId: 11,
    delta: -7,
    reason: 'purchase',
    note: null,
    createdAt: '2026-10-09T05:00:00Z',
    actorEmail: null,
    orderId: 'a4b2c3d4-1111-2222-8333-444455556666',
    orderNumber: 'ORD-A4B2C3D4',
    balanceAfter: 38,
  },
  {
    id: 8,
    variantId: 11,
    delta: 45,
    reason: 'restock',
    note: '初回入荷',
    createdAt: '2026-10-09T01:00:00Z',
    actorEmail: 'admin@example.com',
    orderId: null,
    orderNumber: null,
    balanceAfter: 45,
  },
];

async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, { authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }));
  await page.route('**/api/admin/item-color-presets**', (route) => fulfillJson(route, { data: [] }));
  await page.route(`**/api/admin/items/${ITEM_ID}`, (route) =>
    fulfillJson(route, {
      data: {
        id: Number(ITEM_ID),
        name: 'リネンシャツ',
        description: '説明',
        price: 28000,
        category: 'TOPS',
        colors: [{ name: 'BLACK', hex: '#000000' }],
        sizes: ['M'],
        material: '',
        origin: '',
        care: '',
        product_note: '',
        status: 'published',
        image_url: null,
        image_urls: [],
      },
    }));
  await page.route(`**/api/admin/items/${ITEM_ID}/variants`, (route) =>
    fulfillJson(route, { variants: [VARIANT], movements: MOVEMENTS }));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-073 inventory states (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('色・サイズごとに、すぐ出せる数・引き当て済み・手元の数・受注生産の4つの数と、言葉の説明が出る', async ({ page }) => {
      // FREQ-445-AC-01
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = page.getByTestId('variant-row-11');
      await expect(row).toBeVisible();
      await expect(row).toContainText(/すぐ出せる数\s*38/);
      await expect(row).toContainText(/引き当て済み\s*7/);
      await expect(row).toContainText(/手元の数\s*45/);
      await expect(row).toContainText(/受注生産\s*2/);
      await expect(row.getByTestId('variant-stock')).toHaveText('38');
      await expect(row.getByTestId('variant-backorder')).toHaveText('2');
      // 言葉の説明は画面に1回だけ
      await expect(page.getByText(EXPLANATION)).toHaveCount(1);
      await page.screenshot({ path: `test-results/group-e1/item-stock-states-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('履歴に、動かした人（空なら「自動」）・どの注文か・変わった後の数が出る', async ({ page }) => {
      // FREQ-445-AC-02
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const rows = page.getByTestId('stock-movement-row');
      await expect(rows).toHaveCount(2);
      // 注文の処理が動かした販売: 動かした人は空なので「自動」、注文番号、変わった後の数
      await expect(rows.nth(0)).toContainText('販売');
      await expect(rows.nth(0)).toContainText('-7');
      await expect(rows.nth(0)).toContainText('自動');
      await expect(rows.nth(0)).toContainText('ORD-A4B2C3D4');
      await expect(rows.nth(0)).toContainText('38');
      // 店の人の入荷: 動かした人のメール、備考。注文は無い
      await expect(rows.nth(1)).toContainText('入荷');
      await expect(rows.nth(1)).toContainText('+45');
      await expect(rows.nth(1)).toContainText('初回入荷');
      await expect(rows.nth(1)).toContainText('admin@example.com');
      await expect(rows.nth(1)).not.toContainText('自動');
      await expect(rows.nth(1)).not.toContainText('ORD-');
    });

    test('4つの数と履歴を出しても、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);
      await expect(page.getByTestId('variant-row-11')).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('引き当て済みは発送した数を引いた数、受注生産は未入金・入金済みの注文のまだ仕上がっていない数だけで、履歴は動かした人・注文・変わった後の数を返す（手元の DB）', async () => {
      // FREQ-445-AC-03
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const actorEmail = (await db.query('select email from auth.users where id = $1', [actorId])).rows[0].email as string;
        const fx = await createCatalogFixture(db, { stock: 10, itemStatus: 'private' });
        const catalog = { itemId: fx.itemId, variantId: fx.variantId };
        const email = (label: string) => uniqueEmail(`stock-${label}-${viewport.name}`);

        // 引き当て済み: 入金済みの注文の在庫の品4つのうち1つを発送（4 - 1 = 3）と、
        // 支払い手続き中の注文の在庫の品1つ（棚にあるので数える）で、合わせて4
        const paid = await createOrderWithLines(
          db, email('paid'), [{ name: 'E2E在庫のシャツ', quantity: 4, fulfillmentType: 'stock' }], { catalog });
        const inProgress = await createOrderWithLines(
          db, email('progress'), [{ name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' }],
          { status: 'payment_in_progress', catalog });
        // この試験はメールを確かめないので、知らせない発送にする（知らせる発送は、ほかの spec の worker が送るメールの行を残す）
        await createFulfillment(db, paid.orderId, actorId, {
          trackingNumber: 'E2E-STOCK-1',
          notify: false,
          lines: [{ orderItemId: paid.orderItemIds[0], quantity: 1 }],
        });

        // 受注生産: 未入金の3つ + 入金済みの3つのうち1つが仕上がった残り2つ = 5。取り消した注文の5つは数えない
        await createOrderWithLines(
          db, email('pending'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { status: 'pending', catalog });
        const made = await createOrderWithLines(
          db, email('made'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { catalog });
        await recordCompletion(db, made.orderId, actorId, [{ orderItemId: made.orderItemIds[0], quantity: 1 }]);
        await createOrderWithLines(
          db, email('cancelled'), [{ name: 'E2Eコート', quantity: 5, fulfillmentType: 'backorder' }], { status: 'cancelled', catalog });

        // 店の人の手の調整（動かした人が入る）
        await db.query(
          `insert into public.stock_movements (variant_id, delta, reason, note, created_by)
           values ($1, 2, 'adjustment', 'E2E', $2)`,
          [fx.variantId, actorId],
        );

        const states = (await db.query('select * from public.list_variant_stock_states(array[$1::bigint])', [fx.variantId])).rows;
        expect(states).toHaveLength(1);
        expect(Number(states[0].variant_id)).toBe(fx.variantId);
        expect(states[0]).toMatchObject({ committed: 4, backorder: 5 });
        const stock = (await db.query('select stock_quantity from public.item_variants where id = $1', [fx.variantId])).rows[0];
        expect(Number(stock.stock_quantity)).toBe(7);

        // 履歴は新しい順。変わった後の数は、今の数（7）から、その行より後の動きを引いて出す
        const history = (await db.query('select * from public.list_item_stock_history($1::bigint, 50)', [fx.itemId])).rows;
        expect(
          history.map((row) => ({
            reason: row.reason as string,
            delta: Number(row.delta),
            balance: Number(row.balance_after),
            order: row.order_id as string | null,
            actor: row.actor_email as string | null,
          })),
        ).toEqual([
          { reason: 'adjustment', delta: 2, balance: 7, order: null, actor: actorEmail },
          { reason: 'purchase', delta: -1, balance: 5, order: inProgress.orderId, actor: null },
          { reason: 'purchase', delta: -4, balance: 6, order: paid.orderId, actor: null },
          { reason: 'restock', delta: 10, balance: 10, order: null, actor: null },
        ]);
      });
    });
  });
}
