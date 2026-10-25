/**
 * FR-ADMIN-116 荷作り表と発送票（グループ G-3）
 * 対応 FREQ: FREQ-531（AC-01〜AC-04）、FREQ-532（AC-03・AC-04）、FREQ-533（AC-01〜AC-04）、FREQ-535（AC-02）、FREQ-540（AC-10）
 *
 * 画面 → 窓口の差し替え（e2e/shipping-test-utils.ts）→ 手元の DB の公開関数（list_admin_packing・admin_save_shipment_slip_draft・
 * admin_confirm_shipment_slip ほか）で確かめる。材料の注文は DB へ直に作り（会員/ゲスト・古い注文日・配送先・割当済み）、画面では選択・発送・票の確定を操作する。
 * 荷作り表は古い注文から 50 行ずつ。他の試験が残した準備中の行が先にあっても、頁を送って自分の行を探す（試験ごとに新しい商品・新しい注文で作る）。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・MFA・CSRF・回数の制限・操作の監査 → FR-ADMIN-123 の G-3 の節（本物の窓口の 401/403）と各 route の単体
 * - 発送票の確定の保存則（割当の消費・手元の在庫・二重確定・再送・取消での戻し）・同梱の判定の全組合せ・並行 → DB 結合 group_g3_confirm・group_g3_cancel・group_g3_draft・group_g3_concurrency
 * - 取消・伝票番号・配達済み・出荷日の訂正の画面 → 各ダイアログの単体と DB 結合（この spec は荷作りと確定まで）
 * - 発送メールの本文・件数 → FR-ADMIN-120
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  PACKING_COLUMN_HEADINGS,
  PACKING_HOLD_LABELS,
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_TEXT,
  formatOtherSlipNotice,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';
import { beginRefund, recordRefundResult, uniqueEmail } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { createPermissionActor, mockPermissionUiBridge } from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  UNIT_PRICE,
  adjustStock,
  callFromPage,
  confirmOnSlipPage,
  confirmSlipInDb,
  createDraftInDb,
  createExchangeFeeMaterial,
  createMemberUser,
  createShippingMaterial,
  dispatchShippingRequest,
  expectNoPageOverflow,
  expectSlipHeading,
  fulfillmentsOf,
  holdPaymentReview,
  jstToday,
  noticeOf,
  openPacking,
  openSlip,
  orderStatusOf,
  outboxCount,
  packingIndexOf,
  packingNoteOf,
  packingTable,
  prepareShippingPage,
  readPackingSnapshot,
  readSlip,
  readyQuantityOf,
  revealPackingRow,
  selectBoxOf,
  sendQuantityOf,
  setSupporterPermissionOnScreen,
  shipMaterialsInDb,
  slipIdOfUrl,
  waitForPackingTable,
  withShippingScenario,
  type ShippingContext,
  type ShippingMaterial,
} from './shipping-test-utils';

test.describe.configure({ timeout: 180_000 });

const SLIP_URL = /\/admin\/shipment-slips\/[0-9a-f-]{36}$/;
const UNKNOWN_TEXT = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

const shipButton = (page: Page) => page.getByRole('button', { name: SHIPMENT_SLIP_TEXT.ship, exact: true });

/** 日本時間の日付（荷作り表の注文日と同じ書き方） */
function jstDay(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

async function startPacking(page: Page, ctx: ShippingContext): Promise<void> {
  await prepareShippingPage(page, ctx);
  await openPacking(page);
}

/** 荷作り表でその品の行を選ぶ（送る数を渡すと入れ替える） */
async function pick(page: Page, material: ShippingMaterial, quantity?: number): Promise<void> {
  const row = await revealPackingRow(page, material);
  const box = selectBoxOf(row, material.label);
  await expect(box).toBeEnabled();
  await box.check();
  if (quantity !== undefined) await sendQuantityOf(row, material.label).fill(String(quantity));
}

/** 「発送」を押して票の頁へ移り、票の id と番号を返す */
async function shipSelected(page: Page): Promise<{ slipId: string; number: string }> {
  await shipButton(page).click();
  await expect(page).toHaveURL(SLIP_URL);
  const number = await expectSlipHeading(page);
  return { slipId: slipIdOfUrl(page), number };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-116 packing and shipment slips (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('荷作り表は9列で、発送準備中の行だけを古い注文から表示する（受注生産中・未払い・発送済みの行は出ない）', async ({ page }) => {
      // FREQ-531-AC-01（古い注文日は材料の注文の注文日。e2e-disposition.md に処置を記録）
      // 並びと「出ない」は、荷作り表の全部の行を一時点の1回の読み取り（readPackingSnapshot）で確かめる。頁を歩いて探すと、他の試験（4 worker）が
      // 行を足したり閉じたりして行がずれた時に、見落としや見かけ上の「出ない」が起きる。画面は自分の行を見せて、列と中身を確かめるのに使う。
      // 手元の DB に準備中の行が溜まっているほど読み取りに時間がかかるので、待ちを長めに取る
      test.setTimeout(300_000);
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const older = await createShippingMaterial(client, { orderedDaysAgo: 90, quantity: 3 });
        const newer = await createShippingMaterial(client, { orderedDaysAgo: 30, quantity: 2 });
        const madeToOrder = await createShippingMaterial(client, { orderedDaysAgo: 80, quantity: 2, fulfillmentType: 'backorder' });
        const unpaid = await createShippingMaterial(client, { orderedDaysAgo: 70, quantity: 2, status: 'pending' });
        const shipped = await createShippingMaterial(client, { orderedDaysAgo: 60, quantity: 2 });
        await shipMaterialsInDb(ctx, [shipped], { notifyCustomer: false });
        // 発送前に返金した商品は出ない（一部だけ返金した行は、残りの数だけ出る）。返金は本物の入口で受け付けて結果を記録する
        const paymentIntent = () => `pi_e2e_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        const partlyRefunded = await createShippingMaterial(client, { orderedDaysAgo: 55, quantity: 3, paymentIntentId: paymentIntent() });
        const fullyRefunded = await createShippingMaterial(client, { orderedDaysAgo: 54, quantity: 2, paymentIntentId: paymentIntent() });
        for (const material of [partlyRefunded, fullyRefunded]) {
          const began = await beginRefund(client, material.orderId, {
            actorId: ctx.actorId, lines: [{ orderItemId: material.orderItemId, quantity: 2, beforeShipment: true }], amount: UNIT_PRICE * 2,
          });
          await recordRefundResult(client, began.refundId);
        }
        await startPacking(page, ctx);

        // 9列の見出し（選択欄の列は見出しを視覚的に隠す）
        const table = packingTable(page);
        await expect(table.getByRole('columnheader')).toHaveCount(PACKING_COLUMN_HEADINGS.length + 1);
        for (const heading of PACKING_COLUMN_HEADINGS) {
          await expect(table.getByRole('columnheader', { name: heading, exact: true })).toHaveCount(1);
        }

        // 荷作り表の全部の行を、ある一時点の1回の読み取りで取る: 準備中の2行は出て、古い注文が先。受注生産中・未払い・発送済みの行はどこにも無い
        const snapshot = await readPackingSnapshot(ctx.actorId);
        const olderIndex = packingIndexOf(snapshot, older.orderItemId);
        const newerIndex = packingIndexOf(snapshot, newer.orderItemId);
        expect(olderIndex, '古い注文の準備中の行が出る').toBeGreaterThanOrEqual(0);
        expect(newerIndex, '新しい注文の準備中の行が出る').toBeGreaterThanOrEqual(0);
        expect(olderIndex, '古い注文が先').toBeLessThan(newerIndex);
        const times = snapshot.map((entry) => Date.parse(entry.orderCreatedAt));
        expect(times, '全体が注文日時の古い順').toEqual([...times].sort((a, b) => a - b));
        for (const absent of [madeToOrder, unpaid, shipped]) {
          expect(packingIndexOf(snapshot, absent.orderItemId), `${absent.itemName} は荷作り表に出ない`).toBe(-1);
        }
        expect(await readyQuantityOf(client, older)).toBe(3);
        expect(await readyQuantityOf(client, shipped)).toBe(0);
        // 発送前に全部返金した行は出ない。一部だけ返金した行は、返金していない残りの数（1点）だけが出る
        expect(packingIndexOf(snapshot, fullyRefunded.orderItemId), '発送前に全部返金した行は荷作り表に出ない').toBe(-1);
        const partlyIndex = packingIndexOf(snapshot, partlyRefunded.orderItemId);
        expect(partlyIndex, '一部だけ返金した行は残りが出る').toBeGreaterThanOrEqual(0);
        expect(snapshot[partlyIndex].readyQuantity).toBe(1);
        expect(await readyQuantityOf(client, partlyRefunded)).toBe(1);
        expect(await readyQuantityOf(client, fullyRefunded)).toBe(0);
        // 返金した分は画面を通さずに窓口を直に呼んでも送らせない（下書きも作られない）
        const refundedDraft = await callFromPage(page, 'POST', '/api/admin/shipment-slips', {
          lines: [{ orderItemId: partlyRefunded.orderItemId, quantity: 2 }], requestKey: randomUUID(),
        });
        expect(refundedDraft).toEqual({
          status: 409,
          body: { code: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2] },
        });

        // 画面: 自分の行を出して、1行の中身（左から 選択・注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価）を確かめる
        const row = await revealPackingRow(page, older);
        // 同じ頁の中の並びも古い注文日から（1頁は1回の読み込みなので、他の試験の動きで崩れない）
        const days = await page.getByTestId('packing-row').evaluateAll((rows) => rows.map((entry) => entry.querySelectorAll('td')[2]?.textContent?.trim() ?? ''));
        expect(days).toEqual([...days].sort());
        const cells = row.getByRole('cell');
        await expect(cells).toHaveCount(PACKING_COLUMN_HEADINGS.length + 1);
        await expect(cells.nth(1).getByRole('button', { name: `${older.orderNumber} の履歴を開く`, exact: true })).toHaveText(older.orderNumber);
        await expect(cells.nth(2)).toHaveText(jstDay(older.orderedAt));
        await expect(cells.nth(3)).toHaveText(older.shipTo.fullName);
        await expect(cells.nth(4)).toHaveText(older.email);
        await expect(cells.nth(5)).toHaveText(older.itemName);
        await expect(cells.nth(6)).toHaveText(older.colorName);
        await expect(cells.nth(7)).toHaveText(older.sizeLabel);
        await expect(cells.nth(8)).toHaveText('3');
        await expect(cells.nth(9)).toContainText('5,000');
        await expect(packingNoteOf(row)).toHaveCount(0);
        await expectNoPageOverflow(page);
      });
    });

    test('選べない行は理由つきで選択できない（支払額の確認・交換手数料待ち・配送先不足）。交換の品には印が付く', async ({ page }) => {
      // FREQ-531-AC-02, FREQ-532-AC-04
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const review = await createShippingMaterial(client, { orderedDaysAgo: 100, quantity: 2 });
        await holdPaymentReview(client, review.orderId);
        const incomplete = await createShippingMaterial(client, { orderedDaysAgo: 99, quantity: 2, shipTo: { phone: ' ' } });
        // 割当済みの交換品が exchange_fee_waiting を持つ合成状態。実際には「相談」で受け取って割当が付いた後に手数料より少ない返金をした時などに起きる。普通の未割当で表に出ない手数料待ちは118④で確かめる。
        const exchange = await createExchangeFeeMaterial(client, ctx.actorId, { orderedDaysAgo: 98 });
        const ok = await createShippingMaterial(client, { orderedDaysAgo: 97, quantity: 2 });
        await startPacking(page, ctx);

        const blocked = [
          { name: '支払額の確認', find: review, label: review.label, reason: PACKING_HOLD_LABELS.payment_review },
          { name: '配送先不足', find: incomplete, label: incomplete.label, reason: PACKING_HOLD_LABELS.address_incomplete },
          {
            name: '交換手数料待ち',
            find: { itemName: exchange.exchangeName, orderItemId: exchange.exchangeOrderItemId },
            label: exchange.exchangeLabel,
            reason: PACKING_HOLD_LABELS.exchange_fee_waiting,
          },
        ];
        for (const entry of blocked) {
          const row = await revealPackingRow(page, entry.find);
          await expect(selectBoxOf(row, entry.label), `${entry.name} の行は選べない`).toBeDisabled();
          await expect(packingNoteOf(row), `${entry.name} の理由`).toContainText(entry.reason);
        }
        // 交換の品には印が付く（元の品の行には付かない）
        const exchangeRow = await revealPackingRow(page, { itemName: exchange.exchangeName, orderItemId: exchange.exchangeOrderItemId });
        await expect(exchangeRow).toContainText(SHIPMENT_SLIP_TEXT.exchangeMark);
        const baseRow = await revealPackingRow(page, exchange.base);
        await expect(baseRow).not.toContainText(SHIPMENT_SLIP_TEXT.exchangeMark);
        // 理由のない行は選べる
        const okRow = await revealPackingRow(page, ok);
        await expect(selectBoxOf(okRow, ok.label)).toBeEnabled();
        await expect(packingNoteOf(okRow)).toHaveCount(0);
        await expectNoPageOverflow(page);

        // 画面を開いた後に止めが付いた行（画面は古いまま）を選んで発送すると、DB の断りの文が画面の中に出て、票の頁へは移らず、下書きも作られない
        await selectBoxOf(okRow, ok.label).check();
        await holdPaymentReview(client, ok.orderId);
        await shipButton(page).click();
        await expect(page.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED[2] })).toBeVisible();
        await expect(page).toHaveURL(/\/admin\/packing$/);

        // 画面を通さずに窓口を直接呼んでも、DB が同じ理由で断り、下書きは作られない
        const refuse = async (orderItemId: string, code: string): Promise<void> => {
          const result = await callFromPage(page, 'POST', '/api/admin/shipment-slips', { lines: [{ orderItemId, quantity: 1 }], requestKey: randomUUID() });
          expect(result.status, code).toBe(409);
          expect(result.body, code).toEqual({ code, error: SHIPMENT_SLIP_ERRORS[code][2] });
        };
        await refuse(review.orderItemId, 'GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED');
        await refuse(incomplete.orderItemId, 'GROUP_G_SLIP_ADDRESS_INCOMPLETE');
        await refuse(exchange.exchangeOrderItemId, 'GROUP_G_SLIP_EXCHANGE_ON_HOLD');
      });
    });

    test('一部の数量で下書きを作って確定すると部分発送になり、残りを別の票で送ると全部発送済みになる', async ({ page }) => {
      // FREQ-531-AC-03, FREQ-533-AC-01, FREQ-533-AC-02
      // 行を出すたびに荷作り表の位置を一時点の1回の読み取りで決める。準備中の行が溜まっているほど長くかかるので、待ちを長めに取る
      test.setTimeout(300_000);
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createShippingMaterial(client, { quantity: 5 });
        await startPacking(page, ctx);

        // 5 点のうち 2 点だけを選ぶ（送る数の初期値は準備中の数）
        let row = await revealPackingRow(page, material);
        await selectBoxOf(row, material.label).check();
        await expect(sendQuantityOf(row, material.label)).toHaveValue('5');
        await sendQuantityOf(row, material.label).fill('2');
        const first = await shipSelected(page);
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.draftSaved)).toBeVisible();
        const line = page.getByTestId('slip-line');
        await expect(line).toHaveCount(1);
        await expect(line.getByRole('cell').nth(5)).toHaveText('2');
        await expect(line.getByRole('cell').nth(6)).toHaveText('5');
        // 「お客様に発送のメールを送る」は最初から入っている（そのまま確定すると発送のメールの予定が1つできる）
        const notifyBox = page.getByRole('checkbox', { name: 'お客様に発送のメールを送る', exact: true });
        await expect(notifyBox).toBeChecked();
        await confirmOnSlipPage(page);

        // 部分発送: 注文は入金済みのまま、発送は 2 点、準備中は 3 点
        expect(await orderStatusOf(client, material.orderId)).toBe('paid');
        expect(await fulfillmentsOf(client, material.orderId)).toMatchObject([{ number: 1, quantity: 2, completesOrder: false, notifyCustomer: true }]);
        expect(await outboxCount(client, [material.orderId], ['shipped'])).toBe(1);
        expect(await readyQuantityOf(client, material)).toBe(3);
        expect((await readSlip(client, ctx.actorId, first.slipId)).stage).toBe('confirmed');

        // 荷作り表に戻ると数量は 3。残りを別の票で送る
        await page.getByRole('link', { name: SHIPMENT_SLIP_TEXT.slipBack, exact: true }).click();
        await waitForPackingTable(page);
        row = await revealPackingRow(page, material);
        await expect(row.getByRole('cell').nth(8)).toHaveText('3');
        await selectBoxOf(row, material.label).check();
        await expect(sendQuantityOf(row, material.label)).toHaveValue('3');
        const second = await shipSelected(page);
        expect(second.slipId).not.toBe(first.slipId);
        // チェックを外して確定すると「送らない」になり、この発送のメールの予定は作られない（先の発送の予定は1つのまま）
        await expect(notifyBox).toBeChecked();
        await notifyBox.uncheck();
        await confirmOnSlipPage(page);

        expect(await orderStatusOf(client, material.orderId)).toBe('shipped');
        expect(await fulfillmentsOf(client, material.orderId)).toMatchObject([
          { number: 1, quantity: 2, completesOrder: false, notifyCustomer: true },
          { number: 2, quantity: 3, completesOrder: true, notifyCustomer: false },
        ]);
        expect(await outboxCount(client, [material.orderId], ['shipped'])).toBe(1);
        expect(await readyQuantityOf(client, material)).toBe(0);

        // 全部送ったので、荷作り表のどこにも出ない（一時点の1回の読み取りで確かめる。頁を歩いた「どの頁にも無い」は、行がずれても通ってしまう）
        await page.getByRole('link', { name: SHIPMENT_SLIP_TEXT.slipBack, exact: true }).click();
        await waitForPackingTable(page);
        expect(packingIndexOf(await readPackingSnapshot(ctx.actorId), material.orderItemId)).toBe(-1);
      });
    });

    test('同じお客様の別の日の注文を同梱して1つの票で確定すると、注文ごとに発送ができる', async ({ page }) => {
      // FREQ-532-AC-02, FREQ-533-AC-01, FREQ-533-AC-02（別の日の注文は注文日が違う材料。e2e-disposition.md に処置を記録）
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const email = uniqueEmail('g3-bundle');
        const first = await createShippingMaterial(client, { orderedDaysAgo: 40, quantity: 2, customer: { kind: 'guest', email } });
        const second = await createShippingMaterial(client, { orderedDaysAgo: 12, quantity: 3, customer: { kind: 'guest', email } });
        const stranger = await createShippingMaterial(client, { orderedDaysAgo: 11, quantity: 2 });
        await startPacking(page, ctx);

        await pick(page, first);
        // 1行目を選ぶと、別のお客様の行は選べず、案内が出る。同じお客様の行は選べる
        const strangerRow = await revealPackingRow(page, stranger);
        await expect(selectBoxOf(strangerRow, stranger.label)).toBeDisabled();
        await expect(packingNoteOf(strangerRow)).toContainText(SHIPMENT_SLIP_TEXT.bundleHint);
        const secondRow = await revealPackingRow(page, second);
        await expect(selectBoxOf(secondRow, second.label)).toBeEnabled();
        await expect(packingNoteOf(secondRow)).toHaveCount(0);
        await pick(page, second);

        const slip = await shipSelected(page);
        await expect(page.getByTestId('slip-line')).toHaveCount(2);
        // 荷物の情報（運送会社と伝票番号）を入れる。票の全注文に同じ値が入る
        const trackingNumber = `E2E-BUNDLE-${randomUUID().slice(0, 8).toUpperCase()}`;
        await page.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true }).selectOption('yamato');
        await page.getByLabel('伝票番号', { exact: true }).fill(trackingNumber);

        // 確認の段: 注文ごとに品物と数が並び、運送会社と伝票番号が出る
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        for (const order of [first, second]) {
          const section = page.getByRole('heading', { level: 3, name: `注文 ${order.orderNumber}`, exact: true });
          await expect(section).toBeVisible();
          await expect(section.locator('xpath=following-sibling::ul[1]')).toContainText(`${order.label} ×${order.quantity}`);
        }
        await expect(page.getByText(`運送会社: ${SHIPPING_CARRIERS.yamato.label}`, { exact: true })).toBeVisible();
        await expect(page.getByText(`伝票番号: ${trackingNumber}`, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '発送確定', exact: true }).click();
        await expect(noticeOf(page, '発送を確定しました。')).toBeVisible();

        // 注文ごとに発送が 1 つ（その注文の品の全部）。どちらの注文も発送済みで、運送会社と伝票番号が入る
        expect(await fulfillmentsOf(client, first.orderId)).toMatchObject([
          { number: 1, quantity: 2, completesOrder: true, carrier: 'yamato', trackingNumber },
        ]);
        expect(await fulfillmentsOf(client, second.orderId)).toMatchObject([
          { number: 1, quantity: 3, completesOrder: true, carrier: 'yamato', trackingNumber },
        ]);
        expect(await orderStatusOf(client, first.orderId)).toBe('shipped');
        expect(await orderStatusOf(client, second.orderId)).toBe('shipped');
        expect((await client.query(
          'select shipping_carrier, tracking_number from public.orders where id = any($1::uuid[]) order by id', [[first.orderId, second.orderId]],
        )).rows).toEqual([{ shipping_carrier: 'yamato', tracking_number: trackingNumber }, { shipping_carrier: 'yamato', tracking_number: trackingNumber }]);
        const detail = await readSlip(client, ctx.actorId, slip.slipId);
        expect(detail.orders.map((order) => order.orderId).sort()).toEqual([first.orderId, second.orderId].sort());
        await expectNoPageOverflow(page);
      });
    });

    test('会員とゲストの混在・別住所・別IDで同じメールは候補に出ず、窓口を直接呼んでも拒否の文が出る', async ({ page }) => {
      // FREQ-532-AC-01〜AC-04
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const memberA = await createMemberUser(client, 'g3a');
        const memberB = await createMemberUser(client, 'g3b');
        const sameEmail = uniqueEmail('g3-same');
        const anchor = await createShippingMaterial(client, { orderedDaysAgo: 50, quantity: 2, customer: { kind: 'member', userId: memberA.userId, email: sameEmail } });
        const guest = await createShippingMaterial(client, { orderedDaysAgo: 49, quantity: 2, customer: { kind: 'guest', email: sameEmail } });
        const otherMember = await createShippingMaterial(client, { orderedDaysAgo: 48, quantity: 2, customer: { kind: 'member', userId: memberB.userId, email: sameEmail } });
        const otherAddress = await createShippingMaterial(client, {
          orderedDaysAgo: 47, quantity: 2, customer: { kind: 'member', userId: memberA.userId, email: sameEmail }, shipTo: { address: '神宮前2-2-2' },
        });
        const sameMember = await createShippingMaterial(client, {
          orderedDaysAgo: 46, quantity: 2, customer: { kind: 'member', userId: memberA.userId, email: uniqueEmail('g3-other') },
        });
        await startPacking(page, ctx);

        await pick(page, anchor);
        // 候補に出ない（選べない）行: 会員とゲストの混在・別ID（同じメールでも）・別住所
        for (const blocked of [guest, otherMember, otherAddress]) {
          const row = await revealPackingRow(page, blocked);
          await expect(selectBoxOf(row, blocked.label), `${blocked.orderNumber} は選べない`).toBeDisabled();
          await expect(packingNoteOf(row)).toContainText(SHIPMENT_SLIP_TEXT.bundleHint);
        }
        // 同じ会員は、メールが違っても同梱できる
        const okRow = await revealPackingRow(page, sameMember);
        await expect(selectBoxOf(okRow, sameMember.label)).toBeEnabled();
        await expect(packingNoteOf(okRow)).toHaveCount(0);

        // 窓口を直接呼んでも、DB が同じ判定で断る（画面の絞り込みに頼らない）
        const draftOf = (...materials: ShippingMaterial[]) =>
          callFromPage(page, 'POST', '/api/admin/shipment-slips', {
            lines: materials.map((material) => ({ orderItemId: material.orderItemId, quantity: 1 })), requestKey: randomUUID(),
          });
        const expectRefused = async (code: string, ...materials: ShippingMaterial[]): Promise<void> => {
          const result = await draftOf(...materials);
          expect(result.status, code).toBe(409);
          expect(result.body, code).toEqual({ code, error: SHIPMENT_SLIP_ERRORS[code][2] });
        };
        await expectRefused('GROUP_G_SLIP_CUSTOMER_MISMATCH', anchor, guest);
        await expectRefused('GROUP_G_SLIP_CUSTOMER_MISMATCH', anchor, otherMember);
        await expectRefused('GROUP_G_SLIP_CUSTOMER_MISMATCH', guest, otherMember);
        await expectRefused('GROUP_G_SLIP_ADDRESS_MISMATCH', anchor, otherAddress);
        // 同じ会員同士は通る（下書きが作られる）
        expect((await draftOf(anchor, sameMember)).status).toBe(201);
        await expectNoPageOverflow(page);
      });
    });

    test('同じ行を選んだ2つの下書きは、先に確定した後の確定が拒否の文で止まる', async ({ page }) => {
      // FREQ-531-AC-03, FREQ-533-AC-03
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createShippingMaterial(client, { quantity: 3 });
        await startPacking(page, ctx);

        // 1つ目の下書き（2 点）
        await pick(page, material, 2);
        const first = await shipSelected(page);

        // 2つ目の下書き（同じ行の 2 点）。荷作り表の行に、別の票にも選ばれている通知が出る
        await page.getByRole('link', { name: SHIPMENT_SLIP_TEXT.slipBack, exact: true }).click();
        await waitForPackingTable(page);
        const row = await revealPackingRow(page, material);
        await expect(packingNoteOf(row)).toContainText(formatOtherSlipNotice([first.number]));
        await pick(page, material, 2);
        const second = await shipSelected(page);
        expect(second.slipId).not.toBe(first.slipId);
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        await expect(page.getByRole('heading', { name: '発送票の確認', level: 2, exact: true })).toBeVisible();

        // 2つ目の画面が確認の段のまま、1つ目を先に確定する（準備中の 3 点のうち 2 点が出る）
        await confirmSlipInDb(client, ctx.actorId, await readSlip(client, ctx.actorId, first.slipId), { notifyCustomer: true });
        expect(await readyQuantityOf(client, material)).toBe(1);

        // 2つ目の確定は、準備中の数を超えるので拒否の文で止まる。何も増えない
        await page.getByRole('button', { name: '発送確定', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2] })).toBeVisible();
        expect(await fulfillmentsOf(client, material.orderId)).toMatchObject([{ number: 1, quantity: 2 }]);
        expect(await orderStatusOf(client, material.orderId)).toBe('paid');
        expect(await readyQuantityOf(client, material)).toBe(1);
        expect(await outboxCount(client, [material.orderId], ['shipped'])).toBe(1);
        expect((await readSlip(client, ctx.actorId, second.slipId)).stage).toBe('draft');
        await expectNoPageOverflow(page);
      });
    });

    test('下書きの後に準備中の数が減る（棚卸減で割当が外れる）と票の上で知らせ、確定できない', async ({ page }) => {
      // FREQ-531-AC-03, FREQ-533-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createShippingMaterial(client, { quantity: 3 });
        const draft = await createDraftInDb(ctx, [material]);
        await prepareShippingPage(page, ctx);
        await openSlip(page, draft.id);
        await expect(page.getByTestId('slip-line-note')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '発送票確認', exact: true })).toBeEnabled();

        // 棚卸で 2 点減らす: 空きが 0 なので、この注文の割当が 2 点外れて、準備中は 1 点になる
        expect(await adjustStock(client, { itemId: material.itemId, variantId: material.variantId, quantity: -2 })).toEqual({ releasedQuantity: 2 });
        expect(await readyQuantityOf(client, material)).toBe(1);

        // 読み直すと、行の下に知らせが出て、今の準備中の数は 1。発送票確認は押せない
        await page.reload();
        await expectSlipHeading(page);
        const line = page.getByTestId('slip-line');
        await expect(line.getByRole('cell').nth(5)).toHaveText('3');
        await expect(line.getByRole('cell').nth(6)).toHaveText('1');
        await expect(page.getByTestId('slip-line-note')).toContainText(SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2]);
        await expect(page.getByRole('button', { name: '発送票確認', exact: true })).toBeDisabled();

        // 窓口を直接呼んでも、DB が拒否の文で止める。何も変わらない
        const detail = await readSlip(client, ctx.actorId, draft.id);
        const refused = await callFromPage(page, 'POST', `/api/admin/shipment-slips/${draft.id}/confirm`, {
          expectedVersion: detail.version, carrier: null, trackingNumber: null, shipmentDate: jstToday(), notifyCustomer: false, requestKey: randomUUID(),
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual({ code: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2] });
        expect(await fulfillmentsOf(client, material.orderId)).toEqual([]);
        expect((await readSlip(client, ctx.actorId, draft.id)).stage).toBe('draft');
        await expectNoPageOverflow(page);
      });
    });

    test('発送確定の二重押下は1回だけで、結果が分からない時は「もう一度確かめる」で二重にならない', async ({ page }) => {
      // FREQ-533-AC-03
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        await prepareShippingPage(page, ctx);
        const confirmRequests: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && /\/api\/admin\/shipment-slips\/[0-9a-f-]{36}\/confirm$/.test(new URL(request.url()).pathname)) {
            confirmRequests.push(request.url());
          }
        });

        // 二重押下: 通信は 1 回で、発送もメールの予定も 1 つ
        const doubled = await createShippingMaterial(client, { quantity: 2 });
        const doubledDraft = await createDraftInDb(ctx, [doubled]);
        await openSlip(page, doubledDraft.id);
        // 「お客様に発送のメールを送る」は最初から入っているので、そのまま確定すると発送のメールの予定が1つできる（下の outbox の数）
        await expect(page.getByRole('checkbox', { name: 'お客様に発送のメールを送る', exact: true })).toBeChecked();
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        await expect(page.getByRole('heading', { name: '発送票の確認', level: 2, exact: true })).toBeVisible();
        await page.getByRole('button', { name: '発送確定', exact: true }).dblclick();
        await expect(noticeOf(page, '発送を確定しました。')).toBeVisible();
        expect(confirmRequests).toHaveLength(1);
        expect(await fulfillmentsOf(client, doubled.orderId)).toHaveLength(1);
        expect(await outboxCount(client, [doubled.orderId], ['shipped'])).toBe(1);

        // 結果が分からない: DB には届いて記録されるが、応答が画面に届かない
        const lost = await createShippingMaterial(client, { quantity: 2 });
        const lostDraft = await createDraftInDb(ctx, [lost]);
        confirmRequests.length = 0;
        let dropped = 0;
        await page.route(/\/api\/admin\/shipment-slips\/[0-9a-f-]{36}\/confirm$/, async (route) => {
          if (dropped > 0) {
            await route.fallback();
            return;
          }
          dropped += 1;
          const request = route.request();
          await dispatchShippingRequest(client, ctx.actorId, request.method(), new URL(request.url()), request.postDataJSON() as Record<string, unknown>);
          await route.abort('failed');
        });
        await openSlip(page, lostDraft.id);
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        await page.getByRole('button', { name: '発送確定', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: UNKNOWN_TEXT })).toBeVisible();
        expect(await fulfillmentsOf(client, lost.orderId)).toHaveLength(1);

        // 「もう一度確かめる」は同じ要求番号で送り直し、DB は前の結果を返す。発送も予定も増えない
        await page.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();
        await expect(noticeOf(page, '発送を確定しました。')).toBeVisible();
        expect(confirmRequests).toHaveLength(2);
        expect(await fulfillmentsOf(client, lost.orderId)).toHaveLength(1);
        expect(await outboxCount(client, [lost.orderId], ['shipped'])).toBe(1);
        expect((await readSlip(client, ctx.actorId, lostDraft.id)).stage).toBe('confirmed');

        // サーバーが 500 を返した時も同じ: DB には記録されたが、画面は結果を知らない。「もう一度確かめる」で二重にならない
        const failedOrder = await createShippingMaterial(client, { quantity: 2 });
        const failedDraft = await createDraftInDb(ctx, [failedOrder]);
        confirmRequests.length = 0;
        let answered500 = 0;
        await page.route(/\/api\/admin\/shipment-slips\/[0-9a-f-]{36}\/confirm$/, async (route) => {
          if (answered500 > 0) {
            await route.fallback();
            return;
          }
          answered500 += 1;
          const request = route.request();
          await dispatchShippingRequest(client, ctx.actorId, request.method(), new URL(request.url()), request.postDataJSON() as Record<string, unknown>);
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: SHIPMENT_SLIP_TEXT.failed }) });
        });
        await openSlip(page, failedDraft.id);
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        await page.getByRole('button', { name: '発送確定', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: UNKNOWN_TEXT })).toBeVisible();
        // 結果が分からない間は「もう一度確かめる」と「戻る」だけが出て、入力は止まる
        await expect(page.getByRole('button', { name: 'もう一度確かめる', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '発送確定', exact: true })).toBeDisabled();
        expect(await fulfillmentsOf(client, failedOrder.orderId)).toHaveLength(1);
        await page.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();
        await expect(noticeOf(page, '発送を確定しました。')).toBeVisible();
        expect(confirmRequests).toHaveLength(2);
        expect(await fulfillmentsOf(client, failedOrder.orderId)).toHaveLength(1);
        expect(await outboxCount(client, [failedOrder.orderId], ['shipped'])).toBe(1);
        expect((await readSlip(client, ctx.actorId, failedDraft.id)).stage).toBe('confirmed');
        await expectNoPageOverflow(page);
      });
    });

    test('サポーター（初期値）は荷作りと発送ができ、店長が発送の操作権限を外すと表だけ見えて選べない', async ({ page }) => {
      // FREQ-540-AC-10, FREQ-531-AC-04
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const shipped = await createShippingMaterial(client, { quantity: 2 });
        const waiting = await createShippingMaterial(client, { quantity: 2 });
        // 店長の画面（権限の保存は bridge 経由で DB の関数へ）と、サポーターの画面は別のタブ
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, ctx.actorId);
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareShippingPage(supporterPage, ctx, { role: 'supporter', actorId: supporterId });
          await openPacking(supporterPage);

          // 初期値: 選んで発送し、票を確定できる
          await pick(supporterPage, shipped);
          await shipSelected(supporterPage);
          await confirmOnSlipPage(supporterPage);
          expect(await fulfillmentsOf(client, shipped.orderId)).toMatchObject([{ number: 1, quantity: 2 }]);

          // 店長が発送の操作権限を外す
          await setSupporterPermissionOnScreen(page, 'admin.shipping.manage', false);

          // 表は見える（9列）が、選択欄も発送も無く、権限の文が1回出る
          await openPacking(supporterPage);
          const row = await revealPackingRow(supporterPage, waiting);
          await expect(row).toBeVisible();
          await expect(row.getByRole('checkbox')).toHaveCount(0);
          await expect(packingTable(supporterPage).getByRole('columnheader')).toHaveCount(PACKING_COLUMN_HEADINGS.length);
          await expect(shipButton(supporterPage)).toHaveCount(0);
          await expect(supporterPage.getByText(SHIPMENT_SLIP_TEXT.createForbidden, { exact: true })).toHaveCount(1);
          await expectNoPageOverflow(supporterPage);
          // 窓口を直接呼んでも、DB の関数が断る
          const refused = await callFromPage(supporterPage, 'POST', '/api/admin/shipment-slips', {
            lines: [{ orderItemId: waiting.orderItemId, quantity: 1 }], requestKey: randomUUID(),
          });
          expect(refused).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.forbidden } });

          // 戻すと、選べる
          await setSupporterPermissionOnScreen(page, 'admin.shipping.manage', true);
          await openPacking(supporterPage);
          const restored = await revealPackingRow(supporterPage, waiting);
          await expect(selectBoxOf(restored, waiting.label)).toBeEnabled();
          await expect(shipButton(supporterPage)).toBeVisible();
          await expect(supporterPage.getByText(SHIPMENT_SLIP_TEXT.createForbidden, { exact: true })).toHaveCount(0);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });

    test('頁全体が横にはみ出さず、選択と送る数がキーボードで操作でき、入力が他の操作で消えない', async ({ page }) => {
      // FREQ-531-AC-01, FREQ-533-AC-01
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createShippingMaterial(client, { quantity: 4 });
        await startPacking(page, ctx);
        await expectNoPageOverflow(page);

        // キーボード: 選択欄にフォーカスして Space で選び、送る数を入れ替える
        const row = await revealPackingRow(page, material);
        const box = selectBoxOf(row, material.label);
        await box.focus();
        await page.keyboard.press('Space');
        await expect(box).toBeChecked();
        const quantity = sendQuantityOf(row, material.label);
        await expect(quantity).toHaveValue('4');
        await quantity.focus();
        await page.keyboard.press('Control+A');
        await page.keyboard.type('2');
        await expect(quantity).toHaveValue('2');
        // 送る数が0（または準備中の数を超える）では発送を押せない。送らずに、入力が無効の印になる
        await quantity.fill('0');
        await expect(quantity).toHaveAttribute('aria-invalid', 'true');
        await expect(shipButton(page)).toBeDisabled();
        await quantity.fill(String(material.quantity + 1));
        await expect(shipButton(page)).toBeDisabled();
        await quantity.fill('2');
        await expect(quantity).toHaveAttribute('aria-invalid', 'false');

        // 注文IDを押して履歴のダイアログを開いて閉じても、遷移せず、選択と送る数は消えない
        const history = row.getByRole('button', { name: `${material.orderNumber} の履歴を開く`, exact: true });
        await history.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'この注文の履歴', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(`${material.orderNumber}（`)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(/\/admin\/packing$/);
        await expect(box).toBeChecked();
        await expect(quantity).toHaveValue('2');
        await expect(shipButton(page)).toBeEnabled();
        await expectNoPageOverflow(page);

        // 発送 → 票の頁。荷物の情報を入れて確認の段へ進み、戻っても入力は消えない
        await shipSelected(page);
        await expectNoPageOverflow(page);
        // 運送会社の選択欄は、ラベルの文字に選択肢の文字が混ざる（getByLabel の exact が当たらない）ので、役割と名前で探す
        const carrier = page.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true });
        await carrier.selectOption('yamato');
        await page.getByLabel('伝票番号', { exact: true }).fill('E2E-KEY-123');
        const review = page.getByRole('button', { name: '発送票確認', exact: true });
        await review.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: '発送票の確認', level: 2, exact: true })).toBeVisible();
        await expect(page.getByText('伝票番号: E2E-KEY-123', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '戻る', exact: true }).click();
        await expect(carrier).toHaveValue('yamato');
        await expect(page.getByLabel('伝票番号', { exact: true })).toHaveValue('E2E-KEY-123');
        await expectNoPageOverflow(page);
      });
    });
  });
}
