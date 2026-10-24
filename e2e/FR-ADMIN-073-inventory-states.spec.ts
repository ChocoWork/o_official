/**
 * FR-ADMIN-073 在庫の4つの数と在庫の履歴
 * 対応 FREQ: FREQ-445（AC-01〜AC-03）
 *
 * 商品の編集画面の在庫の欄は窓口を差し替えて確かめる（FR-ADMIN-058 と同じやり方）。
 * 引き当て済みと受注生産の数え方・履歴の変わった後の数（AC-03）は、手元の DB の関数を直に呼んで確かめる。
 * G-1: 手動の仕上がりの記録は終了した。数は空き（F）・入金済みの割当（A）・支払い前の仮確保（H）・待ちで数え、入荷や棚卸の増加の余りは
 * 古い入金済みの注文から順に自動で割り当てる（FIFO）。在庫の増減は本物の入口（public.admin_record_stock_movement）だけで入れる。
 * 在庫の欄は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { AllocationHistoryEvent } from '@/lib/inventory/allocation-types';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { localFixtureAdminId, seedE2eRestock, withGroupG1Material } from './group-g1-test-utils';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
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

/**
 * 自動の割当の履歴（新しい順の台帳とは別の配列）。1つ目は台帳の行9（注文への確保）に結び付く自動割当で、その行に並べて出る。
 * 2つ目は台帳を動かさない入金による切替で、履歴に1行として出る。
 */
const ALLOCATION_EVENTS: AllocationHistoryEvent[] = [
  {
    id: 'e1000000-0000-4000-8000-000000000001',
    allocationId: 'a1000000-0000-4000-8000-000000000001',
    orderId: 'a4b2c3d4-1111-2222-8333-444455556666',
    orderItemId: 'c1000000-0000-4000-8000-000000000001',
    variantId: 11,
    type: 'allocate',
    quantity: 7,
    operationId: 'b1000000-0000-4000-8000-000000000001',
    counterpartAllocationId: null,
    reversesEventId: null,
    stockMovementId: '9',
    reason: 'fifo',
    actorId: null,
    createdAt: '2026-10-09T05:00:00Z',
  },
  {
    id: 'e1000000-0000-4000-8000-000000000002',
    allocationId: 'a1000000-0000-4000-8000-000000000001',
    orderId: 'a4b2c3d4-1111-2222-8333-444455556666',
    orderItemId: 'c1000000-0000-4000-8000-000000000001',
    variantId: 11,
    type: 'promote',
    quantity: 1,
    operationId: 'b1000000-0000-4000-8000-000000000002',
    counterpartAllocationId: null,
    reversesEventId: null,
    stockMovementId: null,
    reason: 'stripe_payment_paid',
    actorId: null,
    createdAt: '2026-10-09T04:00:00Z',
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
    fulfillJson(route, { variants: [VARIANT], movements: MOVEMENTS, allocationEvents: ALLOCATION_EVENTS }));
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
      // 注文の処理が動かした確保: 動かした人は空なので「自動」、注文番号、変わった後の数。G-1: 結び付く自動割当の出来事の名前も同じ行に並ぶ
      await expect(rows.nth(0)).toContainText('注文への確保');
      await expect(rows.nth(0)).toContainText('-7');
      await expect(rows.nth(0)).toContainText('自動');
      await expect(rows.nth(0)).toContainText('ORD-A4B2C3D4');
      await expect(rows.nth(0)).toContainText('38');
      await expect(rows.nth(0)).toContainText('注文への割当');
      // 店の人の入荷: 動かした人のメール、備考。注文は無い
      await expect(rows.nth(1)).toContainText('入荷');
      await expect(rows.nth(1)).toContainText('+45');
      await expect(rows.nth(1)).toContainText('初回入荷');
      await expect(rows.nth(1)).toContainText('admin@example.com');
      await expect(rows.nth(1)).not.toContainText('自動');
      await expect(rows.nth(1)).not.toContainText('ORD-');
      // 台帳を動かさない自動割当の出来事（入金による切替）は、別の1行に理由つきで出る。増減と変わった後の数は持たない
      const event = page.getByTestId(`allocation-event-${ALLOCATION_EVENTS[1].id}`);
      await expect(event).toHaveCount(1);
      await expect(event).toContainText('入金による割当への切替');
      await expect(event).toContainText('割当 1点');
      await expect(event.getByTestId('allocation-event-reason')).toHaveText('入金の確認');
      await expect(event.getByTestId('allocation-event-delta')).toHaveText('—');
      await expect(event.getByTestId('allocation-event-balance')).toHaveText('—');
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
        // G-1: 入荷と棚卸の実行者は、入口が権限（admin.items.manage）を再確認する手元の有効な管理者。発送の材料の実行者（actorId）は外部キーだけ
        const stockAdminId = await withGroupG1Material(db, () => localFixtureAdminId(db));
        const stockAdminEmail = (await db.query('select email from auth.users where id = $1', [stockAdminId])).rows[0].email as string;
        const fx = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
        const catalog = { itemId: fx.itemId, variantId: fx.variantId };
        const email = (label: string) => uniqueEmail(`stock-${label}-${viewport.name}`);
        const inventory = async () => {
          const row = (await db.query(
            'select free, paid_allocated, payment_held, on_hand, waiting from public.list_group_g_variant_inventory(array[$1::bigint])',
            [fx.variantId],
          )).rows[0];
          return {
            free: Number(row.free),
            paidAllocated: Number(row.paid_allocated),
            paymentHeld: Number(row.payment_held),
            onHand: Number(row.on_hand),
            waiting: Number(row.waiting),
          };
        };

        // 本物の入荷の入口で 10 入れる（空き 10）
        await seedE2eRestock(db, { ...catalog, quantity: 10, actorId: stockAdminId });

        // 入金済みの割当（A）: 入金済みの注文の在庫の品4つ（空きから 4 を確保）のうち1つを発送して 3。
        // 支払い前の仮確保（H）: 支払い手続き中の注文の在庫の品1つ。空きは 10 - 4 - 1 = 5
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

        // 受注生産（待ち）: 入金済みの注文の受注生産の品3つが、在庫が入るまで待つ。未入金の3つと、取り消した注文の5つは待ちに数えない。
        // 受注生産の品は注文の時点では割り当てない（A も H も 0）
        const pending = await createOrderWithLines(
          db, email('pending'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { status: 'pending', catalog });
        const made = await createOrderWithLines(
          db, email('made'), [{ name: 'E2Eコート', quantity: 3, fulfillmentType: 'backorder' }], { catalog });
        const cancelled = await createOrderWithLines(
          db, email('cancelled'), [{ name: 'E2Eコート', quantity: 5, fulfillmentType: 'backorder' }], { status: 'cancelled', catalog });

        // 調整の前: 空き 5・A 3・H 1・手元 9・待ち 3。互換の読み取り（引き当て済み = A + H、受注生産 = 待ち）も同じ
        expect(await inventory()).toEqual({ free: 5, paidAllocated: 3, paymentHeld: 1, onHand: 9, waiting: 3 });
        const before = (await db.query('select * from public.list_variant_stock_states(array[$1::bigint])', [fx.variantId])).rows;
        expect(before).toHaveLength(1);
        expect(Number(before[0].variant_id)).toBe(fx.variantId);
        expect(before[0]).toMatchObject({ committed: 4, backorder: 3 });

        // 店の人の手の調整 +2（本物の入口。理由 adjustment・備考 E2E・動かした人が入る）。送信ごとの新しい要求番号。
        // 増えた空きの余り（5 + 2 = 7）から、最も古い入金済みの待ち 3 つへ自動で割り当てる（FIFO）
        await withGroupG1Material(db, async () => {
          const moved = (await db.query(
            "select public.admin_record_stock_movement($1::bigint, $2::bigint, 2, 'adjustment', 'E2E', $3::uuid, $4::uuid, NULL) as result",
            [fx.itemId, fx.variantId, stockAdminId, randomUUID()],
          )).rows[0].result as { movementId?: unknown; releasedQuantity?: unknown; allocatedQuantity?: unknown };
          expect(typeof moved.movementId).toBe('string');
          expect(moved.releasedQuantity).toBe(0);
          expect(moved.allocatedQuantity).toBe(3);
        });

        // 調整の後: 空き 4（7 - 割り当て 3）・A 6（3 + 3）・H 1・手元 11・待ち 0。すぐ出せる数（item_variants の数）は空きと同じ
        expect(await inventory()).toEqual({ free: 4, paidAllocated: 6, paymentHeld: 1, onHand: 11, waiting: 0 });
        const after = (await db.query('select * from public.list_variant_stock_states(array[$1::bigint])', [fx.variantId])).rows;
        expect(after[0]).toMatchObject({ committed: 7, backorder: 0 });
        const stock = (await db.query('select stock_quantity from public.item_variants where id = $1', [fx.variantId])).rows[0];
        expect(Number(stock.stock_quantity)).toBe(4);

        // 自動割当の出来事: 入金済みの待ちの注文にだけ、古い順の自動割当（fifo）で A 3 が付く。未入金・取消の注文には何も付かない
        const madeAllocations = (await db.query(
          `select a.kind, a.quantity, a.remaining_quantity, e.event_type, e.reason
             from public.order_item_allocations as a
             join public.order_item_allocation_events as e on e.allocation_id = a.id
            where a.order_item_id = $1 order by e.sequence, e.created_at`,
          [made.orderItemIds[0]],
        )).rows;
        expect(madeAllocations).toEqual([
          { kind: 'paid', quantity: 3, remaining_quantity: 3, event_type: 'allocate', reason: 'fifo' },
        ]);
        const unallocated = await db.query(
          'select count(*)::integer as n from public.order_item_allocations where order_item_id = any($1::uuid[])',
          [[...pending.orderItemIds, ...cancelled.orderItemIds]],
        );
        expect(Number(unallocated.rows[0].n)).toBe(0);

        // 履歴は新しい順（台帳の番号の大きい順）で、返った配列をそのまま確かめる。変わった後の数は、今の数（4）から、その行より後の動きを引いて出す。
        // 最も新しい行は、調整の余りを古い注文へ割り当てた自動の確保（購入 -3）。割り当ては台帳に1行だけ足し、重ねて数えない
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
          { reason: 'purchase', delta: -3, balance: 4, order: made.orderId, actor: stockAdminEmail },
          { reason: 'adjustment', delta: 2, balance: 7, order: null, actor: stockAdminEmail },
          { reason: 'purchase', delta: -1, balance: 5, order: inProgress.orderId, actor: null },
          { reason: 'purchase', delta: -4, balance: 6, order: paid.orderId, actor: null },
          { reason: 'restock', delta: 10, balance: 10, order: null, actor: stockAdminEmail },
        ]);
      });
    });
  });
}
