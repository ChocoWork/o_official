/**
 * FR-ADMIN-118 出荷日（グループ G-3）
 * 対応 FREQ: FREQ-535（AC-02〜AC-04）、FREQ-540（AC-10）、FREQ-489（出荷日と返品の期限の起点）。
 * 旧 FR-ADMIN-101 の「返品の期限が届いた日から数えられる」の出荷日が動いても期限が動かない側の確かめは、⑦が引き継ぐ。
 *
 * 出荷日は日本時間の暦日。下限は票の全注文の入金日（日本時間）の最も遅い日、上限は日本時間の今日。確定後の訂正は理由つきで店長だけができ、
 * 履歴に前後の日付と理由が残る。返品の期限は、出荷日ではなく発送した時刻（届いた後は届いた日）から数える。
 *
 * 画面 → 窓口の差し替え（e2e/shipping-test-utils.ts）→ 手元の DB の公開関数（admin_confirm_shipment_slip・admin_correct_shipment_date）。
 * 境界の組合せや拒否の答えは、画面を要らないので bridge の中核（callShippingApi）を直に呼ぶ。画面は初期値・確認の段・訂正のダイアログで確かめる。
 * 入金日は注文の作成時に決める材料（createShippingMaterial の paidAt）。e2e-disposition.md に処置を記録する。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・MFA・CSRF・回数の制限・操作の監査 → FR-ADMIN-123 と各 route の単体
 * - 日付の全組合せ・並行・履歴の追記専用 → DB 結合 group_g3_confirm・group_g3_date・group_g3_concurrency
 * - 会計の日付基準の接続（list_shipment_accounting_inputs）→ DB 結合 group_g3_date
 */
import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SHIPMENT_SLIP_ERRORS, SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { attachGroupG3SlipShipment, seedGroupG3Slip } from '../tests/integration/db/helpers/group-g3-fixtures';
import {
  addDays,
  jstDateOf,
  markDeliveredInDb,
  readFulfillment,
  returnDeadlineOf,
  returnWindowSettings,
} from './delivery-tracking-test-utils';
import { shipE2eOrder } from './group-g1-test-utils';
import { uniqueEmail } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { createPermissionActor } from './permission-settings-test-utils';
import { addVariant, ensureReturnSettings, createReturnInDb, receiveReturnInDb, recordFeePaymentInDb } from './return-test-utils';
import {
  callShippingApi as send,
  confirmOnSlipPage,
  createDraftInDb,
  createMemberUser,
  createShippingMaterial,
  expectNoPageOverflow,
  expectSlipHeading,
  fulfillmentsOf,
  jstToday,
  noticeOf,
  openSlip,
  packingIndexOf,
  prepareShippingPage,
  readPackingSnapshot,
  readSlip,
  shipMaterialsInDb,
  withShippingScenario,
  type ShippingContext,
  type ShippingMaterial,
} from './shipping-test-utils';

test.describe.configure({ timeout: 240_000 });

const SLIPS = '/api/admin/shipment-slips';
const INVALID = { code: 'GROUP_G_SHIPMENT_DATE_INVALID', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SHIPMENT_DATE_INVALID[2] };

const tracking = (label: string): string => `E2E-${label}-${randomUUID().slice(0, 8).toUpperCase()}`;
const paymentIntent = (): string => `pi_e2e_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

/** 日本時間のお昼ごろ（UTC 03:00）の時刻。日本時間の日付が、その暦日のまま動かない */
const noonJst = (day: string): string => `${day}T03:00:00Z`;

function fulfillmentIdOf(confirmed: { fulfillments: readonly { orderId: string; fulfillmentId: string }[] }, material: ShippingMaterial): string {
  const found = confirmed.fulfillments.find((entry) => entry.orderId === material.orderId);
  if (!found) throw new Error('E2E_SLIP_FULFILLMENT_MISSING');
  return found.fulfillmentId;
}

/** 下書きを、指定の出荷日で確定する（窓口を直に呼ぶ。メールなし・荷物の情報なし） */
function confirmOn(ctx: ShippingContext, draft: { id: string; version: number }, shipmentDate: string) {
  return send(ctx, 'POST', `${SLIPS}/${draft.id}/confirm`, {
    expectedVersion: draft.version, carrier: null, trackingNumber: null, shipmentDate, notifyCustomer: false, requestKey: randomUUID(),
  });
}

/** 確定の答えが出荷日の範囲の断りで、下書きのまま・発送が作られていない */
async function expectDateRefused(
  ctx: ShippingContext,
  reply: Awaited<ReturnType<typeof confirmOn>>,
  draft: { id: string },
  material: ShippingMaterial,
): Promise<void> {
  expect(reply).toEqual({ status: 400, body: INVALID });
  expect((await readSlip(ctx.client, ctx.actorId, draft.id)).stage).toBe('draft');
  expect(await fulfillmentsOf(ctx.client, material.orderId)).toEqual([]);
}

const operationButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-118 shipment dates (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('出荷日の初期値は日本時間の今日で、確定すると初回の出荷日が履歴に残る（初期値から変えた時も経緯が残る）', async ({ page }) => {
      // FREQ-535-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const earlier = addDays(today, -4);
        const keep = await createShippingMaterial(client, { quantity: 2 });
        const change = await createShippingMaterial(client, { quantity: 2, orderedDaysAgo: 10 });
        const keepDraft = await createDraftInDb(ctx, [keep]);
        const changeDraft = await createDraftInDb(ctx, [change]);
        await prepareShippingPage(page, ctx);

        // 初期値のまま確定: 出荷日は今日。初回の履歴は 今日 → 今日
        await openSlip(page, keepDraft.id);
        const date = page.getByLabel('出荷日', { exact: true });
        await expect(date).toHaveValue(today);
        await confirmOnSlipPage(page);
        await expect(page.getByText(`出荷日: ${today}`, { exact: true })).toBeVisible();
        await expect(page.getByText(new RegExp(`初回 ${today} → ${today}`))).toBeVisible();
        const kept = await readSlip(client, ctx.actorId, keepDraft.id);
        expect(kept).toMatchObject({ stage: 'confirmed', shipmentDate: today });
        expect(kept.dateHistory).toHaveLength(1);
        expect(kept.dateHistory[0]).toMatchObject({ kind: 'initial', previousDate: today, newDate: today, reason: null });
        expect((await fulfillmentsOf(client, keep.orderId))[0].shipmentDate).toBe(today);

        // 初期値から変えて確定: 出荷日は選んだ日。初回の履歴に 今日 → 選んだ日 が残る。発送した時刻は確定した時刻（今）のまま
        await openSlip(page, changeDraft.id);
        await expect(date).toHaveValue(today);
        await date.fill(earlier);
        await confirmOnSlipPage(page);
        await expect(page.getByText(`出荷日: ${earlier}`, { exact: true })).toBeVisible();
        await expect(page.getByText(new RegExp(`初回 ${today} → ${earlier}`))).toBeVisible();
        const changed = await readSlip(client, ctx.actorId, changeDraft.id);
        expect(changed).toMatchObject({ stage: 'confirmed', shipmentDate: earlier });
        expect(changed.dateHistory).toHaveLength(1);
        expect(changed.dateHistory[0]).toMatchObject({ kind: 'initial', previousDate: today, newDate: earlier, reason: null });
        const [fulfillment] = await fulfillmentsOf(client, change.orderId);
        expect(fulfillment.shipmentDate).toBe(earlier);
        expect(jstDateOf((await readFulfillment(client, fulfillment.id)).shipped_at)).toBe(today);
        expect(jstDateOf(changed.confirmedAt as string)).toBe(today);
        await expectNoPageOverflow(page);
      });
    });

    test('入金日（日本時間）より前の日と今日より後の日は確定できない。日本時間の日付の境目（23:59と0:00）で下限が切り替わる', async ({ page }) => {
      // FREQ-535-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const base = addDays(today, -6);
        const placedAt = `${addDays(base, -1)}T00:00:00Z`;
        // 同じ UTC の日付で、日本時間の 23:59:59（その日）と 0:00:00（翌日）の入金。下限は base と base+1
        const lateNight = await createShippingMaterial(client, { quantity: 1, orderedAt: placedAt, paidAt: `${base}T14:59:59Z` });
        const midnight = await createShippingMaterial(client, { quantity: 1, orderedAt: placedAt, paidAt: `${base}T15:00:00Z` });
        const recent = await createShippingMaterial(client, { quantity: 1, orderedDaysAgo: 8 });
        const lateNightDraft = await createDraftInDb(ctx, [lateNight]);
        const midnightDraft = await createDraftInDb(ctx, [midnight]);
        const recentDraft = await createDraftInDb(ctx, [recent]);
        await prepareShippingPage(page, ctx);

        // 今日より後の日は画面でも断られる（断りの文が出て、下書きのまま。発送は作られない）
        await openSlip(page, recentDraft.id);
        await page.getByLabel('出荷日', { exact: true }).fill(addDays(today, 1));
        await page.getByRole('button', { name: '発送票確認', exact: true }).click();
        await page.getByRole('button', { name: '発送確定', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: INVALID.error })).toBeVisible();
        expect((await readSlip(client, ctx.actorId, recentDraft.id)).stage).toBe('draft');
        expect(await fulfillmentsOf(client, recent.orderId)).toEqual([]);
        // 窓口を直に呼んでも同じ。今日（上限）は通る
        await expectDateRefused(ctx, await confirmOn(ctx, recentDraft, addDays(today, 1)), recentDraft, recent);
        const upper = await confirmOn(ctx, recentDraft, today);
        expect(upper.status).toBe(200);
        expect(upper.body).toMatchObject({ id: recentDraft.id, shipmentDate: today });

        // 入金が日本時間の 23:59:59 の注文: その日（base）から確定できる。前の日は断られる
        await expectDateRefused(ctx, await confirmOn(ctx, lateNightDraft, addDays(base, -1)), lateNightDraft, lateNight);
        const lateNightOk = await confirmOn(ctx, lateNightDraft, base);
        expect(lateNightOk.status).toBe(200);
        expect((await readSlip(client, ctx.actorId, lateNightDraft.id)).shipmentDate).toBe(base);

        // 入金が日本時間の 0:00:00 の注文（UTC では同じ日）: 翌日（base+1）からしか確定できない。base は断られる
        await expectDateRefused(ctx, await confirmOn(ctx, midnightDraft, addDays(base, -1)), midnightDraft, midnight);
        await expectDateRefused(ctx, await confirmOn(ctx, midnightDraft, base), midnightDraft, midnight);
        const midnightOk = await confirmOn(ctx, midnightDraft, addDays(base, 1));
        expect(midnightOk.status).toBe(200);
        expect((await readSlip(client, ctx.actorId, midnightDraft.id)).shipmentDate).toBe(addDays(base, 1));
        await expectNoPageOverflow(page);
      });
    });

    test('複数注文の票は、最も遅い入金日が下限になる', async ({ page }) => {
      // FREQ-535-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const member = await createMemberUser(client, 'g3d3');
        const early = await createShippingMaterial(client, {
          quantity: 2, orderedDaysAgo: 12, paidAt: noonJst(addDays(today, -9)),
          customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-d3-a') },
        });
        const late = await createShippingMaterial(client, {
          quantity: 2, orderedDaysAgo: 12, paidAt: noonJst(addDays(today, -3)),
          customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-d3-b') },
        });
        const draft = await createDraftInDb(ctx, [early, late]);

        // 早い方の入金日（-9）や、その間の日（-6）は、遅い方の入金日（-3）より前なので断られる
        for (const day of [addDays(today, -9), addDays(today, -6), addDays(today, -4)]) {
          expect(await confirmOn(ctx, draft, day), day).toEqual({ status: 400, body: INVALID });
        }
        expect((await readSlip(client, ctx.actorId, draft.id)).stage).toBe('draft');
        for (const material of [early, late]) expect(await fulfillmentsOf(client, material.orderId)).toEqual([]);
        // 遅い方の入金日（-3）なら確定でき、票の全注文の発送が同じ出荷日になる
        const ok = await confirmOn(ctx, draft, addDays(today, -3));
        expect(ok.status).toBe(200);
        for (const material of [early, late]) expect((await fulfillmentsOf(client, material.orderId))[0].shipmentDate).toBe(addDays(today, -3));

        await prepareShippingPage(page, ctx);
        await openSlip(page, draft.id);
        await expect(page.getByText(`出荷日: ${addDays(today, -3)}`, { exact: true })).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('交換手数料を後から入金しても、下限は元の入金日のまま', async ({ page }) => {
      // FREQ-535-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        await ensureReturnSettings(client);
        const today = jstToday();
        const paidDay = addDays(today, -9);
        const base = await createShippingMaterial(client, {
          quantity: 1, orderedDaysAgo: 12, paidAt: noonJst(paidDay), paymentIntentId: paymentIntent(),
        });
        const baseSlip = await shipMaterialsInDb(ctx, [base], { notifyCustomer: false });
        const paidAtOf = async () => (await client.query('select paid_at from public.orders where id = $1::uuid', [base.orderId])).rows[0].paid_at as Date;
        const paidAtBefore = await paidAtOf();

        // 交換の返品を受け取ると、手数料（500円 + 300円）のお支払いを待つ交換の品ができる。待っている間は票に選べない
        const variantL = await addVariant(client, base.itemId, { color: 'ホワイト', size: 'L', stock: 3 });
        const created = await createReturnInDb(client, { orderId: base.orderId, actorId: ctx.actorId, fulfillmentId: fulfillmentIdOf(baseSlip, base) }, {
          lines: [{ orderItemId: base.orderItemId, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          exchangeFee: 500,
          exchangeShippingFee: 300,
        });
        const received = await receiveReturnInDb(client, created.returnId, ctx.actorId, {
          units: [{ lineId: created.lineIds[base.orderItemId], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
        });
        expect(received.feeDueAmount).toBe(800);
        const exchangeItemId = received.exchangeOrderItemIds[0];
        // 設計 docs/superpowers/specs/2026-10-23-group-g-design.md:263 / :388: 荷作り表は発送準備中だけ。手数料待ちは自動割当・発送の対象外で、表に出ない。
        expect(packingIndexOf(await readPackingSnapshot(ctx.actorId), exchangeItemId)).toBe(-1);
        const waiting = await send(ctx, 'POST', SLIPS, { lines: [{ orderItemId: exchangeItemId, quantity: 1 }], requestKey: randomUUID() });
        expect(waiting).toEqual({
          status: 409,
          body: { code: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2] },
        });

        // 手数料の入金（今日）を記録すると交換の品は送れるが、入金日（orders.paid_at）は元のまま
        await recordFeePaymentInDb(client, created.returnId, ctx.actorId, '銀行振込');
        expect(await paidAtOf()).toEqual(paidAtBefore);
        await expect.poll(async () => {
          const snapshot = await readPackingSnapshot(ctx.actorId);
          const index = packingIndexOf(snapshot, exchangeItemId);
          if (index === -1) return null;
          const { readyQuantity, shippableQuantity } = snapshot[index];
          return { readyQuantity, shippableQuantity };
        }, { timeout: 30_000, message: '手数料の入金後は交換明細が荷作り表に発送準備中1点として出る' }).toEqual({
          readyQuantity: 1, shippableQuantity: 1,
        });
        const draft = await createDraftInDb(ctx, [{ ...base, orderItemId: exchangeItemId }], [1]);
        // 下限は元の入金日（-9）: その前の日は断られ、元の入金日は通る（手数料を入金した今日ではない）
        expect(await confirmOn(ctx, draft, addDays(paidDay, -1))).toEqual({ status: 400, body: INVALID });
        const ok = await confirmOn(ctx, draft, paidDay);
        expect(ok.status).toBe(200);
        expect((await readSlip(client, ctx.actorId, draft.id)).shipmentDate).toBe(paidDay);
        expect(await paidAtOf()).toEqual(paidAtBefore);

        await prepareShippingPage(page, ctx);
        await openSlip(page, draft.id);
        await expect(page.getByText(`出荷日: ${paidDay}`, { exact: true })).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('店長は確定後に理由つきで出荷日を訂正でき、全注文の発送に反映され、履歴に前後の日付・理由が残る。サポーター（初期値）は訂正できない', async ({ page }) => {
      // FREQ-535-AC-03, FREQ-535-AC-04, FREQ-540-AC-10
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const corrected = addDays(today, -3);
        const reason = '台帳の日付の誤り';
        const member = await createMemberUser(client, 'g3d5');
        const a = await createShippingMaterial(client, {
          quantity: 2, orderedDaysAgo: 12, customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-d5-a') },
        });
        const b = await createShippingMaterial(client, {
          quantity: 2, orderedDaysAgo: 12, customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-d5-b') },
        });
        const confirmed = await shipMaterialsInDb(ctx, [a, b], { carrier: 'yamato', trackingNumber: tracking('DATE'), notifyCustomer: false });
        const ids = [a, b].map((material) => fulfillmentIdOf(confirmed, material));
        const shippedBefore = await Promise.all(ids.map((id) => readFulfillment(client, id)));
        const deadlinesBefore = await Promise.all([a, b].map((material, index) => returnDeadlineOf(client, material.orderId, ids[index])));

        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        await operationButton(page, SHIPMENT_SLIP_TEXT.correctDate).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.correctDate, exact: true });
        await expect(dialog.getByText(SHIPMENT_SLIP_TEXT.dateDescription, { exact: true })).toBeVisible();
        const dateInput = dialog.getByLabel(SHIPMENT_SLIP_TEXT.newShipmentDate, { exact: true });
        await expect(dateInput).toHaveValue(today);
        // 理由が空のままでは送らずに止める（履歴は増えない）
        await dateInput.fill(corrected);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.correctDateSubmit, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_REASON_REQUIRED[2] })).toBeVisible();
        expect((await readSlip(client, ctx.actorId, confirmed.id)).dateHistory).toHaveLength(1);
        // 理由を入れて訂正する
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.dateReason, { exact: true }).fill(reason);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.correctDateSubmit, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.dateCorrected)).toBeVisible();
        await expect(dialog).toBeHidden();
        await expect(page.getByText(`出荷日: ${corrected}`, { exact: true })).toBeVisible();
        await expect(page.getByText(new RegExp(`訂正 ${today} → ${corrected} ${reason}`))).toBeVisible();

        // 票と全注文の発送の出荷日が変わり、履歴に前後の日付と理由が残る。発送した時刻と返品の期限は変わらない
        const after = await readSlip(client, ctx.actorId, confirmed.id);
        expect(after.shipmentDate).toBe(corrected);
        expect(after.dateHistory).toHaveLength(2);
        expect(after.dateHistory[0]).toMatchObject({ kind: 'initial', previousDate: today, newDate: today, reason: null });
        expect(after.dateHistory[1]).toMatchObject({ kind: 'correction', previousDate: today, newDate: corrected, reason });
        expect(after.versions[after.versions.length - 1]).toMatchObject({ kind: 'date_correction', reason, shipmentDate: corrected });
        for (const [index, material] of [a, b].entries()) {
          expect((await fulfillmentsOf(client, material.orderId))[0].shipmentDate, `注文 ${index + 1} の発送の出荷日`).toBe(corrected);
          expect((await readFulfillment(client, ids[index])).shipped_at).toEqual(shippedBefore[index].shipped_at);
          expect(await returnDeadlineOf(client, material.orderId, ids[index])).toBe(deadlinesBefore[index]);
        }

        // 同じ日・入金日より前・今日より後・理由が空白だけの訂正は、窓口を直に呼んでも断られ、何も変わらない
        const attempt = (shipmentDate: string, why = reason) => send(ctx, 'POST', `${SLIPS}/${confirmed.id}/shipment-date`, {
          expectedVersion: after.version, shipmentDate, reason: why, requestKey: randomUUID(),
        });
        expect(await attempt(corrected)).toEqual({
          status: 409, body: { code: 'GROUP_G_SHIPMENT_DATE_UNCHANGED', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SHIPMENT_DATE_UNCHANGED[2] },
        });
        expect(await attempt(addDays(today, -13))).toEqual({ status: 400, body: INVALID });
        expect(await attempt(addDays(today, 1))).toEqual({ status: 400, body: INVALID });
        expect(await attempt(addDays(today, -2), '   ')).toEqual({
          status: 400, body: { code: 'GROUP_G_SLIP_REASON_REQUIRED', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_REASON_REQUIRED[2] },
        });
        const unchanged = await readSlip(client, ctx.actorId, confirmed.id);
        expect(unchanged.version).toBe(after.version);
        expect(unchanged.dateHistory).toEqual(after.dateHistory);
        await expectNoPageOverflow(page);

        // サポーター（初期値）は、ボタンの代わりに店長だけの案内が出て、窓口を直に呼んでも DB の関数が断る
        const supporterId = await createPermissionActor(client, 'supporter');
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareShippingPage(supporterPage, ctx, { role: 'supporter', actorId: supporterId });
          await openSlip(supporterPage, confirmed.id);
          await expect(supporterPage.getByText(SHIPMENT_SLIP_TEXT.dateOwnerOnly, { exact: true })).toBeVisible();
          await expect(operationButton(supporterPage, SHIPMENT_SLIP_TEXT.correctDate)).toHaveCount(0);
          const refused = await send(ctx, 'POST', `${SLIPS}/${confirmed.id}/shipment-date`, {
            expectedVersion: after.version, shipmentDate: addDays(today, -2), reason, requestKey: randomUUID(),
          }, supporterId);
          expect(refused).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.dateForbidden } });
          expect((await readSlip(client, ctx.actorId, confirmed.id)).version).toBe(after.version);
          await expectNoPageOverflow(supporterPage);
        } finally {
          await supporterPage.close();
        }
      });
    });

    test('配達済みの日より後への訂正は断られる', async ({ page }) => {
      // FREQ-535-AC-03
      // 発送した時刻は確定した時刻（今）でしか作れないので、届いた日が今日より前の票は、過去の日付で作った合成の発送を確定済みの票へ付けて作る
      // （DB 結合 group_g3_date の材料と同じ形。e2e-disposition.md に処置を記録する）
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const shippedDay = addDays(today, -6);
        const deliveredDay = addDays(today, -4);
        const reason = '配達日との突き合わせ';
        const material = await createShippingMaterial(client, { quantity: 2, orderedDaysAgo: 14 });
        const number = tracking('PAST');
        const shipment = await shipE2eOrder(client, {
          orderId: material.orderId,
          actorId: ctx.actorId,
          lines: [{ orderItemId: material.orderItemId, quantity: 1 }],
          trackingNumber: number,
          carrier: 'yamato',
          notify: false,
          shippedAt: noonJst(shippedDay),
          deliveredAt: noonJst(deliveredDay),
        });
        // 数字8桁-4桁の CHECK と読み取りの形式を保つ。SL-0 は実際の日付の採番・fixture の SL-29991231 と分ける。
        // 7桁と4桁を独立した暗号学的乱数にし、10^11通りから選ぶ。fixture は失敗時に取引を戻すので、23505 の時だけ新しい番号で1回やり直す。
        const seedPastSlip = () => seedGroupG3Slip(client, {
          stage: 'confirmed',
          actorId: ctx.actorId,
          number: `SL-0${String(randomInt(10_000_000)).padStart(7, '0')}-${String(randomInt(10_000)).padStart(4, '0')}`,
          shipmentDate: shippedDay,
          shippingCarrier: 'yamato',
          trackingNumber: number,
          customerKind: 'guest',
          customerEmail: material.email,
        });
        const slipId = await seedPastSlip().catch((error: unknown) => {
          if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== '23505') throw error;
          return seedPastSlip();
        });
        await attachGroupG3SlipShipment(client, {
          slipId, orderId: material.orderId, orderItemId: material.orderItemId, fulfillmentId: shipment.fulfillmentId, quantity: 1, actorId: ctx.actorId,
        });
        const before = await readSlip(client, ctx.actorId, slipId);
        expect(before).toMatchObject({ stage: 'confirmed', shipmentDate: shippedDay });
        const deliveredBefore = await readFulfillment(client, shipment.fulfillmentId);
        expect(jstDateOf(deliveredBefore.delivered_at as Date)).toBe(deliveredDay);

        await prepareShippingPage(page, ctx);
        await openSlip(page, slipId);
        await operationButton(page, SHIPMENT_SLIP_TEXT.correctDate).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.correctDate, exact: true });
        // 配達済みの日（-4）より後の日（-3）は、断りの文がダイアログの中に出て、何も変わらない
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.newShipmentDate, { exact: true }).fill(addDays(deliveredDay, 1));
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.dateReason, { exact: true }).fill(reason);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.correctDateSubmit, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY[2] })).toBeVisible();
        await expect(dialog).toBeVisible();
        const refused = await readSlip(client, ctx.actorId, slipId);
        expect(refused.version).toBe(before.version);
        expect(refused.shipmentDate).toBe(shippedDay);
        expect(refused.dateHistory).toEqual(before.dateHistory);
        // 配達済みの日と同じ日は通る
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.newShipmentDate, { exact: true }).fill(deliveredDay);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.correctDateSubmit, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.dateCorrected)).toBeVisible();
        await expect(dialog).toBeHidden();
        const corrected = await readSlip(client, ctx.actorId, slipId);
        expect(corrected.shipmentDate).toBe(deliveredDay);
        expect(corrected.dateHistory[corrected.dateHistory.length - 1]).toMatchObject({
          kind: 'correction', previousDate: shippedDay, newDate: deliveredDay, reason,
        });
        // もう一度、配達済みの日より後を試しても同じ（窓口を直に呼ぶ）。前の日は通る
        const attempt = (shipmentDate: string, version: number) => send(ctx, 'POST', `${SLIPS}/${slipId}/shipment-date`, {
          expectedVersion: version, shipmentDate, reason, requestKey: randomUUID(),
        });
        expect(await attempt(addDays(deliveredDay, 2), corrected.version)).toEqual({
          status: 409, body: { code: 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY[2] },
        });
        expect((await attempt(addDays(deliveredDay, -1), corrected.version)).status).toBe(200);
        // 届いた時刻・発送した時刻は動かない
        const deliveredAfter = await readFulfillment(client, shipment.fulfillmentId);
        expect(deliveredAfter.delivered_at).toEqual(deliveredBefore.delivered_at);
        expect(deliveredAfter.shipped_at).toEqual(deliveredBefore.shipped_at);
        await expectNoPageOverflow(page);
      });
    });

    test('出荷日を過去にしても訂正しても、返品の期限は発送を確定した時刻（届いた場合は届いた日）から変わらない', async ({ page }) => {
      // FREQ-535-AC-04
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const today = jstToday();
        const pastDay = addDays(today, -5);
        const firstDay = addDays(today, -3);
        const secondDay = addDays(today, -4);
        const settings = await returnWindowSettings(client);
        const fromShipment = (day: string): string | null =>
          settings.windowDays === null ? null : addDays(addDays(day, settings.bufferDays), settings.windowDays);
        const material = await createShippingMaterial(client, { quantity: 3, orderedDaysAgo: 12 });
        const confirmed = await shipMaterialsInDb(ctx, [material], {
          quantities: [2], carrier: 'yamato', trackingNumber: tracking('RDL'), notifyCustomer: false, shipmentDate: pastDay,
        });
        const fulfillmentId = fulfillmentIdOf(confirmed, material);
        const deadlineOf = () => returnDeadlineOf(client, material.orderId, fulfillmentId);
        const correct = async (shipmentDate: string) => {
          const reply = await send(ctx, 'POST', `${SLIPS}/${confirmed.id}/shipment-date`, {
            expectedVersion: (await readSlip(client, ctx.actorId, confirmed.id)).version, shipmentDate, reason: '返品の期限の確認', requestKey: randomUUID(),
          });
          expect(reply.status, shipmentDate).toBe(200);
        };

        // 出荷日を過去（-5）にして確定しても、発送した時刻は確定した時刻（今日）。返品の期限は発送した時刻から数え、出荷日からは数えない
        const shipped = await readFulfillment(client, fulfillmentId);
        expect(jstDateOf(shipped.shipped_at)).toBe(today);
        expect((await fulfillmentsOf(client, material.orderId))[0].shipmentDate).toBe(pastDay);
        const deadline = await deadlineOf();
        expect(deadline).toBe(fromShipment(today));
        if (settings.windowDays !== null) expect(deadline).not.toBe(fromShipment(pastDay));

        // 出荷日を訂正しても、返品の期限と発送した時刻は変わらない
        await correct(firstDay);
        expect((await fulfillmentsOf(client, material.orderId))[0].shipmentDate).toBe(firstDay);
        expect(await deadlineOf()).toBe(deadline);
        expect((await readFulfillment(client, fulfillmentId)).shipped_at).toEqual(shipped.shipped_at);

        // 手で配達済みにすると、返品の期限は届いた日から数える。その後に出荷日を訂正しても変わらない
        await markDeliveredInDb(client, { orderId: material.orderId, fulfillmentId, actorId: ctx.actorId, deliveredOn: today, notify: false });
        const delivered = await readFulfillment(client, fulfillmentId);
        const deliveredDeadline = settings.windowDays === null ? null : addDays(jstDateOf(delivered.delivered_at as Date), settings.windowDays);
        expect(await deadlineOf()).toBe(deliveredDeadline);
        await correct(secondDay);
        expect(await deadlineOf()).toBe(deliveredDeadline);
        const after = await readFulfillment(client, fulfillmentId);
        expect(after.delivered_at).toEqual(delivered.delivered_at);
        expect(after.shipped_at).toEqual(shipped.shipped_at);
        const detail = await readSlip(client, ctx.actorId, confirmed.id);
        expect(detail.shipmentDate).toBe(secondDay);
        expect(detail.dateHistory.map((entry) => [entry.kind, entry.newDate])).toEqual([
          ['initial', pastDay], ['correction', firstDay], ['correction', secondDay],
        ]);

        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        await expect(page.getByText(`出荷日: ${secondDay}`, { exact: true })).toBeVisible();
        await expect(page.getByText(new RegExp(`訂正 ${firstDay} → ${secondDay} 返品の期限の確認`))).toBeVisible();
        await expectSlipHeading(page);
        await expectNoPageOverflow(page);
      });
    });
  });
}
