/**
 * FR-ADMIN-112 / FREQ-523-AC-01〜05・FREQ-540-AC-13。
 * 画面 → DB bridge → 公開DB関数。認可/MFA/CSRF/回数制限/監査は123の実HTTPとroute単体が担当する。
 * 新しい注文・固有メール・固有variantを使い、保存則と拒否/再送は対象だけの一時点のDB写しで確かめる。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT, type AllocationSwapInput } from '@/lib/inventory/allocation-swap-types';
import {
  createOrderRowsMaterial, createSwapMaterial, mockOrderDetailBridge,
  readSwapSnapshot, swapInDb, withOrderAdminScenario,
  type OrderAdminContext,
} from './order-admin-test-utils';
import { detailSection, openOrderDetail, viewports } from './order-fulfillment-test-utils';
import { seedE2eRestock } from './group-g1-test-utils';
import { createPermissionActor, mockPermissionUiBridge } from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import { callFromPage, expectNoPageOverflow, setSupporterPermissionOnScreen, withShippingScenario } from './shipping-test-utils';

test.describe.configure({ timeout: 240_000 });
type Material = Awaited<ReturnType<typeof createSwapMaterial>>;
const SWAP = /の割り当てを入れ替える$/;
const pathOf = (m: Material) => `/api/admin/orders/${m.taker.orderId}/allocations/swap`;
const inputOf = (m: Material, quantity = 2): AllocationSwapInput => ({
  takerOrderItemId: m.takerOrderItemId, donorOrderItemId: m.donorOrderItemId,
  quantity, reason: 'お客様と確認した順序へ変更', requestKey: randomUUID(),
});
const snapshot = (ctx: OrderAdminContext, m: Material, extra: string[] = []) =>
  readSwapSnapshot(ctx.client, m.catalog.variantId, [m.donor.orderId, m.taker.orderId, ...extra]);

async function start(page: Page, ctx: OrderAdminContext, m: Material): Promise<void> {
  await mockAdminSessionAs(page, 'admin');
  await mockOrderDetailBridge(page, ctx.client, ctx.actorId, { id: m.taker.orderId });
  await openOrderDetail(page, m.taker.orderId);
}

// 入力欄は label に包まれ、label の文字に選択肢や入力済みの文字も入るので、getByLabel の完全一致ではなく役割と名前で探す
function donorSelect(dialog: Locator): Locator {
  return dialog.getByRole('combobox', { name: ALLOCATION_SWAP_TEXT.donorLabel, exact: true });
}

function quantityBox(dialog: Locator): Locator {
  return dialog.getByRole('spinbutton', { name: ALLOCATION_SWAP_TEXT.quantityLabel, exact: true });
}

function reasonBox(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: ALLOCATION_SWAP_TEXT.reasonLabel, exact: true });
}

async function openSwap(page: Page, m: Material): Promise<Locator> {
  await detailSection(page, '品物').getByRole('button', { name: SWAP }).click();
  const dialog = page.getByRole('dialog', { name: ALLOCATION_SWAP_TEXT.title(m.taker.orderNumber), exact: true });
  await expect(donorSelect(dialog)).toBeVisible();
  return dialog;
}

async function fillSwap(dialog: Locator, m: Material, quantity = 2, reason = 'お客様と確認した順序へ変更'): Promise<void> {
  await donorSelect(dialog).selectOption(m.donorOrderItemId);
  await quantityBox(dialog).fill(String(quantity));
  await reasonBox(dialog).fill(reason);
}

async function submitSwap(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.submit, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: ALLOCATION_SWAP_TEXT.success })).toBeVisible();
}

async function expectState(page: Page, itemName: string, status: string, quantity: number): Promise<void> {
  const row = detailSection(page, '品物').getByRole('row').filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .filter({ has: page.getByRole('cell', { name: status, exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').nth(4)).toHaveText(String(quantity));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-112 allocation swap (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: viewport.width, height: viewport.height }); });

    test('受注生産中の品物の「割り当てを入れ替える」から、候補の注文・数量・理由を選んで入れ替えると、両方の注文の品物のステータスと数量が変わり、割当の総数・空き在庫・手元の在庫は変わらない（DB で確かめる）', async ({ page }) => {
      // FREQ-523-AC-01・AC-03・AC-05
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        const before = await snapshot(ctx, m);
        await start(page, ctx, m);
        await expectState(page, m.taker.lines[0].itemName, '受注生産中', 2);
        const dialog = await openSwap(page, m);
        await expect(dialog.getByRole('option', { name: new RegExp(m.donor.orderNumber) })).toContainText('発送準備中 3');
        await fillSwap(dialog, m);
        await submitSwap(page, dialog);
        await expectState(page, m.taker.lines[0].itemName, '発送準備中', 2);
        await expect(detailSection(page, '品物').getByRole('row')
          .filter({ has: page.getByRole('cell', { name: '受注生産中', exact: true }) })).toHaveCount(0);
        await openOrderDetail(page, m.donor.orderId);
        await expectState(page, m.donor.lines[0].itemName, '受注生産中', 2);
        await expectState(page, m.donor.lines[0].itemName, '発送準備中', 1);
        const after = await snapshot(ctx, m);
        for (const key of ['allocated', 'free', 'held', 'onHand', 'ledger'] as const) expect(after[key], key).toBe(before[key]);
        expect(after.states).toEqual([
          { orderItemId: m.donorOrderItemId, status: 'in_production', quantity: 2 },
          { orderItemId: m.donorOrderItemId, status: 'ready', quantity: 1 },
          { orderItemId: m.takerOrderItemId, status: 'ready', quantity: 2 },
        ].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId) || a.status.localeCompare(b.status)));
        expect(after.transfers - before.transfers).toBe(2);
        expect(after.operations - before.operations).toBe(1);
      });
    });

    test('理由が空だと送れず、200字を超える理由は入力できない', async ({ page }) => {
      // FREQ-523-AC-05
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        await start(page, ctx, m);
        const dialog = await openSwap(page, m);
        const posts: string[] = [];
        page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === pathOf(m)) posts.push(r.url()); });
        const before = await snapshot(ctx, m);
        await fillSwap(dialog, m, 1, '   ');
        await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.submit, exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText(ALLOCATION_SWAP_ERRORS.GROUP_G_SWAP_REASON_REQUIRED[2]);
        const reason = reasonBox(dialog);
        await expect(reason).toHaveAttribute('maxlength', '200');
        await reason.fill('あ'.repeat(201));
        await expect(reason).toHaveValue('あ'.repeat(200));
        expect(posts).toEqual([]);
        expect(await snapshot(ctx, m)).toEqual(before);
      });
    });

    test('禁止の条件: 同じ注文と別の色サイズの品物と未入金の注文は候補に出ない／交換手数料待ち・支払額の確認の品物には入替のボタンが出ない／キャンセルの申し込みか返金処理中の区間を持つ出し手は候補に出ない／出荷済みの注文の交換の品〔受注生産中の在庫待ち〕には入替のボタンが出て入れ替えられる／数が足りなくなった候補は断りの文が出て何も変わらない', async ({ page }) => {
      // FREQ-523-AC-01・AC-02・AC-05。候補の不在は、候補読取1回の集合全体で確かめる。
      await withOrderAdminScenario(async (ctx) => {
        // 在庫を足す全ての出し手を先に作り、受け手の待ちへ材料の入荷が FIFO しないようにする。
        const cancelled = await createSwapMaterial(ctx.client, { donorReady: 2, donorCancelRequested: true, differentVariant: true });
        const catalog = cancelled.catalog;
        const refunding = await createSwapMaterial(ctx.client, { catalog, donorReady: 2, donorRefundProcessing: true, differentVariant: true });
        const unpaid = await createOrderRowsMaterial(ctx, { catalog, status: 'pending' });
        const different = await createOrderRowsMaterial(ctx);
        const m = await createSwapMaterial(ctx.client, { catalog, donorReady: 2, sameOrderReady: true });
        const fee = await createSwapMaterial(ctx.client, { takerFeeWaiting: true });
        const review = await createSwapMaterial(ctx.client, { takerReview: true });
        const exchange = await createSwapMaterial(ctx.client, { takerExchange: true });
        const competitor = await createOrderRowsMaterial(ctx, { catalog, lines: [{ quantity: 1, allocated: 0 }] });
        await start(page, ctx, m);
        const dialog = await openSwap(page, m);
        const values = await dialog.getByRole('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
        expect(values).toContain(m.donorOrderItemId);
        for (const id of [m.taker.lines[1].orderItemId, different.lines[0].orderItemId, unpaid.lines[0].orderItemId, cancelled.donorOrderItemId, refunding.donorOrderItemId]) {
          expect(values).not.toContain(id);
        }
        await fillSwap(dialog, m, 2);
        // 別の操作が1点を先に取った後、画面の古い候補の2点を送る。
        await swapInDb(ctx.client, ctx.actorId, { ...inputOf(m, 1), orderId: competitor.orderId, takerOrderItemId: competitor.lines[0].orderItemId });
        const before = await snapshot(ctx, m, [competitor.orderId]);
        await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.submit, exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText(ALLOCATION_SWAP_ERRORS.GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR[2]);
        expect(await snapshot(ctx, m, [competitor.orderId])).toEqual(before);
        await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.back, exact: true }).click();
        for (const blocked of [fee, review]) {
          await openOrderDetail(page, blocked.taker.orderId);
          await expect(detailSection(page, '品物').getByRole('button', { name: SWAP })).toHaveCount(0);
          await expect(detailSection(page, '品物')).toContainText(blocked === fee ? '交換手数料' : '支払額');
        }
        await openOrderDetail(page, exchange.taker.orderId);
        await expectState(page, `${exchange.taker.lines[0].itemName}（交換品）`, '受注生産中', 2);
        expect((await ctx.client.query('select status::text as status from public.orders where id=$1', [exchange.taker.orderId])).rows[0].status).toBe('shipped');
        const exchangeDialog = await openSwap(page, exchange);
        await fillSwap(exchangeDialog, exchange);
        await submitSwap(page, exchangeDialog);
        await expectState(page, `${exchange.taker.lines[0].itemName}（交換品）`, '発送準備中', 2);
      });
    });

    test('履歴: 入替の後、両方の注文の「変更履歴」に品物の状態の変化として「割当の入替」の行が出て、相手の注文番号と理由が見える', async ({ page }) => {
      // FREQ-523-AC-03・AC-05
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        await start(page, ctx, m);
        const dialog = await openSwap(page, m);
        await fillSwap(dialog, m);
        await submitSwap(page, dialog);
        for (const [order, counterpart, from, to] of [
          [m.taker, m.donor, '受注生産中', '発送準備中'], [m.donor, m.taker, '発送準備中', '受注生産中'],
        ] as const) {
          await openOrderDetail(page, order.orderId);
          const history = detailSection(page, '変更履歴');
          await expect(history.getByRole('heading', { name: '品物の状態の変化', exact: true })).toBeVisible();
          const entry = history.getByRole('listitem').filter({ hasText: '割当の入替' });
          await expect(entry).toHaveCount(1);
          await expect(entry).toContainText(`2点 ${from} → ${to}`);
          await expect(entry).toContainText('お客様と確認した順序へ変更');
          await expect(entry.getByRole('link', { name: `相手の注文 ${counterpart.orderNumber}`, exact: true }))
            .toHaveAttribute('href', `/admin/orders/${counterpart.orderId}`);
        }
      });
    });

    test('自動FIFO: 入替の後に同じ variant を入荷すると、割当を失った注文が元の注文日の順で新しい入荷を受け取り、入替先の割当は動かない（DB で確かめる）', async ({ page }) => {
      // FREQ-523-AC-04
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client, { donorDaysAgo: 10, takerDaysAgo: 5 });
        const middle = await createOrderRowsMaterial(ctx, { catalog: m.catalog, orderedDaysAgo: 7, lines: [{ allocated: 0 }] });
        await start(page, ctx, m);
        const dialog = await openSwap(page, m);
        await fillSwap(dialog, m);
        await submitSwap(page, dialog);
        await expectState(page, m.taker.lines[0].itemName, '発送準備中', 2);
        // 成功の後は変更履歴も読み直す。入荷（同じ ctx.client の取引）に橋渡しの読みが入り込まないよう、履歴の入替の行が出るまで待つ
        await expect(detailSection(page, '変更履歴').getByRole('listitem').filter({ hasText: '割当の入替' })).toHaveCount(1);
        const takerAllocations = () => ctx.client.query('select id,remaining_quantity,version::text from public.order_item_allocations where order_item_id=$1 order by id', [m.takerOrderItemId]);
        const before = (await takerAllocations()).rows;
        await seedE2eRestock(ctx.client, { ...m.catalog, quantity: 2, actorId: ctx.actorId });
        const after = await snapshot(ctx, m, [middle.orderId]);
        expect(after.states).toEqual([
          { orderItemId: m.donorOrderItemId, status: 'ready', quantity: 3 },
          { orderItemId: m.takerOrderItemId, status: 'ready', quantity: 2 },
          { orderItemId: middle.lines[0].orderItemId, status: 'in_production', quantity: 1 },
        ].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId) || a.status.localeCompare(b.status)));
        expect((await takerAllocations()).rows).toEqual(before);
        expect(new Date((await ctx.client.query('select created_at from public.orders where id=$1', [m.donor.orderId])).rows[0].created_at).toISOString()).toBe(m.donor.orderedAt);
      });
    });

    test('二重押下は1回だけで、結果が分からない時は「もう一度確かめる」で二重にならない', async ({ page }) => {
      // FREQ-523-AC-03・AC-05。初回はDBに保存してから答えを失わせる（保存前の通信失敗ではない）。
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        await start(page, ctx, m);
        const dialog = await openSwap(page, m);
        await fillSwap(dialog, m);
        const bodies: AllocationSwapInput[] = [];
        const results: Awaited<ReturnType<typeof swapInDb>>[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        await page.route((url) => url.pathname === pathOf(m), async (route) => {
          const body = route.request().postDataJSON() as AllocationSwapInput;
          bodies.push(body);
          const result = await swapInDb(ctx.client, ctx.actorId, { ...body, orderId: m.taker.orderId });
          results.push(result);
          if (bodies.length === 1) { await gate; await route.abort('failed'); }
          else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
        });
        const before = await snapshot(ctx, m);
        try {
          await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.submit, exact: true }).dblclick();
          await expect.poll(() => results.length).toBe(1);
          expect(bodies).toHaveLength(1);
          await expect(dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.submit, exact: true })).toBeDisabled();
        } finally { release(); }
        await expect(dialog.getByText(ALLOCATION_SWAP_TEXT.unknown, { exact: true })).toBeVisible();
        for (const field of [donorSelect(dialog), quantityBox(dialog), reasonBox(dialog)]) {
          await expect(field).toBeDisabled();
        }
        const saved = await snapshot(ctx, m);
        expect(saved.operations - before.operations).toBe(1);
        expect(saved.transfers - before.transfers).toBe(2);
        await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.checkAgain, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('status').filter({ hasText: ALLOCATION_SWAP_TEXT.success })).toBeVisible();
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(results[1]).toEqual({ ...results[0], replayed: true });
        expect(await snapshot(ctx, m)).toEqual(saved);
      });
    });

    test('入口は orders.allocate を持つ人だけ。サポーター〔初期値〕には入口が無く、窓口を直接呼んでも DB が断る。店長が権限画面でサポーターに orders.allocate を付けると入口が出て、外すと消える〔権限の付け外しは `withPermissionScenario` の中だけで行い、ほかの case は `withOrderAdminScenario`〕', async ({ page }) => {
      // FREQ-523-AC-05・FREQ-540-AC-13
      await withShippingScenario(async (ctx) => {
        const { client, actorId } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const supporter = await page.context().newPage();
        try {
          const m = await createSwapMaterial(client, { context: ctx });
          await mockAdminSessionAs(page, 'admin');
          await mockPermissionUiBridge(page, client, actorId);
          await supporter.setViewportSize({ width: viewport.width, height: viewport.height });
          await mockAdminSessionAs(supporter, 'supporter');
          await mockOrderDetailBridge(supporter, client, supporterId, { id: m.taker.orderId });
          await openOrderDetail(supporter, m.taker.orderId);
          await expect(detailSection(supporter, '品物').getByRole('button', { name: SWAP })).toHaveCount(0);
          const before = await snapshot(ctx, m);
          expect(await callFromPage(supporter, 'POST', pathOf(m), inputOf(m))).toEqual({ status: 403, body: {
            code: 'GROUP_G_FORBIDDEN', error: ALLOCATION_SWAP_TEXT.forbidden,
          } });
          expect(await snapshot(ctx, m)).toEqual(before);
          await setSupporterPermissionOnScreen(page, 'admin.orders.allocate', true);
          await openOrderDetail(supporter, m.taker.orderId);
          const dialog = await openSwap(supporter, m);
          await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.back, exact: true }).click();
          await setSupporterPermissionOnScreen(page, 'admin.orders.allocate', false);
          await openOrderDetail(supporter, m.taker.orderId);
          await expect(detailSection(supporter, '品物').getByRole('button', { name: SWAP })).toHaveCount(0);
          expect(await callFromPage(supporter, 'POST', pathOf(m), inputOf(m))).toMatchObject({ status: 403, body: { code: 'GROUP_G_FORBIDDEN' } });
          expect(await snapshot(ctx, m)).toEqual(before);
        } finally {
          await supporter.close();
        }
      }, { changesPermissions: true });
    });

    test('dialog は390pxで画面いっぱいに開いて右上の×で閉じられ、閉じるとフォーカスが入替のボタンに戻る。頁全体が横にはみ出さない', async ({ page }) => {
      // FREQ-523-AC-05
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        await start(page, ctx, m);
        const trigger = detailSection(page, '品物').getByRole('button', { name: SWAP });
        const dialog = await openSwap(page, m);
        await expectNoPageOverflow(page);
        if (viewport.width === 390) {
          const box = await dialog.boundingBox();
          expect(box).not.toBeNull();
          // 位置は端数の px で揺れる（実測 y=0.93）ので、FR-ADMIN-107 と同じく 1px 以内を画面いっぱいとみなす
          expect(Math.abs(box!.x)).toBeLessThanOrEqual(1); expect(Math.abs(box!.y)).toBeLessThanOrEqual(1);
          expect(box!.width).toBeGreaterThanOrEqual(390 - 1); expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 1);
          const close = dialog.getByRole('button', { name: '閉じる', exact: true });
          const closeBox = await close.boundingBox();
          expect(closeBox!.x).toBeGreaterThan(300); expect(closeBox!.y).toBeLessThan(80);
          await close.click();
        } else await dialog.getByRole('button', { name: ALLOCATION_SWAP_TEXT.back, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        await expectNoPageOverflow(page);
      });
    });
  });
}
