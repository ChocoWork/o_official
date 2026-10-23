/**
 * FR-ADMIN-084 返品を作る
 * 対応 FREQ: FREQ-462（AC-01〜AC-07・AC-09・AC-10）、FREQ-469（AC-01）
 *
 * 画面（返品の画面・返品を作る画面）は窓口の答えを差し替えて確かめ、作る DB の関数の動きと受付のお知らせのメールは、
 * 手元の DB の関数を直に呼び、worker の入口を叩いて手元のメール受け（Mailpit）で確かめる（実装計画 P11。FR-ADMIN-082・083 と同じやり方）。
 * 窓口の権限・CSRF・回数の制限（FREQ-462-AC-08）は単体の試験が確かめる。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import { dialogFooterClose } from './admin-test-utils';
import { expectDbError, runWorkerUntil, withLocalDb } from './order-email-test-utils';
import {
  UUID_PATTERN,
  fulfillJson,
  mockOrderList,
  openOrderTab,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  FULFILLMENT_ID,
  RETURN_ADDRESS,
  RETURN_MAIL,
  RETURN_TEXT,
  addVariant,
  createLineGroup,
  createReturnInDb,
  createShippedOrder,
  exchangeItemRows,
  materialsLineOf,
  materialsShipmentOf,
  mockReturnRoutes,
  newReturnRouteState,
  openCreateDialog,
  openReturnsDialog,
  orderWithReturns,
  returnCountOf,
  returnDetailOf,
  returnLabelOf,
  returnLineOf,
  returnLineRowOf,
  returnMaterialsOf,
  returnRowOf,
  returnSummaryOf,
  returnableByItem,
  sentReturnMailCount,
  waitForMails,
  type ReturnRouteState,
} from './return-test-utils';

const ORDER_ID = 'a4b2c3d4-0084-4000-8000-000000000084';
const SHIRT = 'c4b2c3d4-0000-4000-8000-000000000001';
const BELT = 'c4b2c3d4-0000-4000-8000-000000000002';
const SECOND_SHIPMENT = 'f4b2c3d4-0000-4000-8000-0000000000f2';

/** 返品の画面まで開く。一覧の窓口と返品の窓口を差し替えた上で、ORDER タブの「返品」を押す */
async function openReturns(page: Page, state: ReturnRouteState) {
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [
    orderWithReturns({
      id: ORDER_ID,
      summary: returnSummaryOf({ orderId: ORDER_ID, displayStatus: state.returns.length > 0 ? 'in_progress' : null }),
    }),
  ]);
  await mockReturnRoutes(page, ORDER_ID, state);
  await openOrderTab(page);
  return openReturnsDialog(page, ORDER_ID);
}

/** 返品を作る画面の材料。シャツ2点（1回目の発送・期限内）とベルト1点（2回目の発送・期限切れ） */
function twoShipmentMaterials() {
  return returnMaterialsOf({
    orderId: ORDER_ID,
    shipments: [
      materialsShipmentOf({
        number: 1,
        shippedAt: '2026-10-10T03:00:00.000Z',
        deadlineDate: '2026-10-20',
        lines: [materialsLineOf({ orderItemId: SHIRT, itemName: 'シルクブラウス', quantity: 2, returnable: 2 })],
      }),
      materialsShipmentOf({
        fulfillmentId: SECOND_SHIPMENT,
        number: 2,
        shippedAt: '2026-10-02T03:00:00.000Z',
        deadlineDate: '2026-10-11',
        pastDeadline: true,
        lines: [materialsLineOf({ orderItemId: BELT, itemName: 'レザーベルト', color: '茶', size: null, quantity: 1, returnable: 1 })],
      }),
    ],
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-084 return create (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('返品が無い注文の返品の画面に、空の文・「返品できる品: あと3点」・「返品を作る」が出る', async ({ page }) => {
      // FREQ-462-AC-01
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 3, materials: twoShipmentMaterials() });
      const dialog = await openReturns(page, state);

      await expect(dialog.getByText(RETURN_TEXT.empty)).toBeVisible();
      await expect(dialog.getByText(RETURN_TEXT.remaining(3))).toBeVisible();
      await expect(dialog.getByRole('button', { name: '返品を作る', exact: true })).toBeEnabled();
      await expect(dialogFooterClose(dialog)).toBeVisible();
    });

    test('作る画面は発送ごとに見出しと受付の期限を出し、期限を過ぎた発送の品も数を入れて作れる（警告だけ）', async ({ page }) => {
      // FREQ-462-AC-02
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 3, materials: twoShipmentMaterials() });
      await openReturns(page, state);
      const dialog = await openCreateDialog(page, ORDER_ID);

      const first = dialog.getByRole('region', { name: '1回目の発送（10月10日発送）', exact: true });
      await expect(first.getByText(RETURN_TEXT.deadline('10月20日'))).toBeVisible();
      await expect(createLineGroup(first, 'シルクブラウス（ホワイト / M）').getByText('返品できる数: 2')).toBeVisible();
      const second = dialog.getByRole('region', { name: '2回目の発送（10月2日発送）', exact: true });
      await expect(second.getByText(RETURN_TEXT.pastDeadline('10月11日'))).toBeVisible();
      const belt = createLineGroup(second, 'レザーベルト（茶）');
      await belt.getByLabel('返品する数', { exact: true }).fill('1');
      await expect(dialog.getByRole('button', { name: '返品を作る', exact: true })).toBeEnabled();
    });

    test('解決の方法を「交換」にすると、同じ商品の使える色・サイズだけが選べ、「在庫: n」と「送り方」が出る', async ({ page }) => {
      // FREQ-462-AC-03
      const materials = returnMaterialsOf({
        orderId: ORDER_ID,
        shipments: [
          materialsShipmentOf({ lines: [materialsLineOf({ orderItemId: SHIRT, itemName: 'シルクブラウス', quantity: 2, returnable: 2 })] }),
        ],
        exchangeOptions: [
          {
            itemId: 9001,
            variants: [
              { variantId: 9101, color: 'ホワイト', size: 'M', isActive: true, stockQuantity: 0, madeToOrderLeadDays: null },
              { variantId: 9102, color: 'ホワイト', size: 'L', isActive: true, stockQuantity: 3, madeToOrderLeadDays: null },
              { variantId: 9103, color: 'ブラック', size: 'L', isActive: false, stockQuantity: 5, madeToOrderLeadDays: null },
            ],
          },
        ],
      });
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 2, materials });
      await openReturns(page, state);
      const dialog = await openCreateDialog(page, ORDER_ID);
      const group = createLineGroup(dialog, 'シルクブラウス（ホワイト / M）');

      await group.getByLabel('返品する数', { exact: true }).fill('1');
      await group.getByRole('combobox', { name: '解決の方法', exact: true }).selectOption({ label: '交換' });
      const variants = group.getByRole('combobox', { name: '交換の色・サイズ', exact: true });
      // 使えない色・サイズ（ブラック / L）は選べない
      expect(await variants.locator('option').allTextContents()).toEqual(['ホワイト / M', 'ホワイト / L']);
      // 元と同じ色・サイズから始まり、在庫が返す数に足りないので「作って送る」から始まる
      await expect(variants).toHaveValue('9101');
      await expect(group.getByText('在庫: 0')).toBeVisible();
      await expect(group.getByRole('combobox', { name: '送り方', exact: true })).toHaveValue('make');

      // 在庫のある色・サイズを選び直すと、在庫の数が変わり、送り方は「在庫から」に決め直される
      await variants.selectOption({ label: 'ホワイト / L' });
      await expect(group.getByText('在庫: 3')).toBeVisible();
      await expect(group.getByRole('combobox', { name: '送り方', exact: true })).toHaveValue('stock');
    });

    test('返す数が2点以上で「交換」を選ぶと「交換にする数」が出て、返す数より少なくすると、同じ発送の行が返金の行と交換の行の2つに分かれて窓口へ届く', async ({ page }) => {
      // FREQ-462-AC-09
      const materials = returnMaterialsOf({
        orderId: ORDER_ID,
        shipments: [
          materialsShipmentOf({ lines: [materialsLineOf({ orderItemId: SHIRT, itemName: 'シルクブラウス', quantity: 2, returnable: 2 })] }),
        ],
        exchangeOptions: [
          {
            itemId: 9001,
            variants: [
              { variantId: 9101, color: 'ホワイト', size: 'M', isActive: true, stockQuantity: 0, madeToOrderLeadDays: null },
              { variantId: 9104, color: 'ブルー', size: 'M', isActive: true, stockQuantity: 1, madeToOrderLeadDays: null },
            ],
          },
        ],
      });
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 2, materials });
      await openReturns(page, state);
      const dialog = await openCreateDialog(page, ORDER_ID);
      const group = createLineGroup(dialog, 'シルクブラウス（ホワイト / M）');
      const quantity = group.getByLabel('返品する数', { exact: true });
      const resolution = group.getByRole('combobox', { name: '解決の方法', exact: true });
      const exchangeCount = group.getByLabel('交換にする数', { exact: true });
      const shipping = group.getByRole('combobox', { name: '送り方', exact: true });
      const create = dialog.getByRole('button', { name: '返品を作る', exact: true });

      // 返金のままでも、返す数が1点でも出ない。返す数が2点以上で「交換」を選ぶと出て、最初は返す数の全部
      await quantity.fill('2');
      await expect(exchangeCount).toHaveCount(0);
      await resolution.selectOption({ label: '交換' });
      await expect(exchangeCount).toHaveValue('2');
      await expect(exchangeCount).toHaveAttribute('max', '2');
      await quantity.fill('1');
      await expect(exchangeCount).toHaveCount(0);
      await quantity.fill('2');
      await expect(exchangeCount).toBeVisible();

      // 在庫が1点の色・サイズは、2点には足りないので「作って送る」から始まる。交換にする数を1点にすると、足りるので「在庫から」に決め直される
      await group.getByRole('combobox', { name: '交換の色・サイズ', exact: true }).selectOption({ label: 'ブルー / M' });
      await expect(group.getByText('在庫: 1')).toBeVisible();
      await expect(shipping).toHaveValue('make');
      // 0にした間は作れない
      await exchangeCount.fill('0');
      await expect(create).toBeDisabled();
      await exchangeCount.fill('1');
      await expect(create).toBeEnabled();
      await expect(shipping).toHaveValue('stock');

      await create.click();
      await expect(page.getByRole('dialog', { name: `返品を作る（${orderNumberOf(ORDER_ID)}）` })).toHaveCount(0);
      // 同じ発送の同じ商品が、返金1点の行と交換1点の行の2つに分かれて、1つの返品として届く
      expect(state.createPosts).toHaveLength(1);
      expect(state.createPosts[0].lines).toMatchObject([
        { fulfillmentId: FULFILLMENT_ID, orderItemId: SHIRT, quantity: 1, resolution: 'refund', exchangeVariantId: null, exchangeMethod: null },
        { fulfillmentId: FULFILLMENT_ID, orderItemId: SHIRT, quantity: 1, resolution: 'exchange', exchangeVariantId: 9104, exchangeMethod: 'stock' },
      ]);
    });

    test('円の欄（返送料・交換の手数料・交換の送料）が上限を超えるか、返品の手数料（%）が0〜100の整数でないと、欄の下に誤りが出て作れず、範囲ちょうどなら作れる', async ({ page }) => {
      // FREQ-462-AC-10
      const materials = returnMaterialsOf({
        orderId: ORDER_ID,
        shipments: [
          materialsShipmentOf({ lines: [materialsLineOf({ orderItemId: SHIRT, itemName: 'シルクブラウス', quantity: 2, returnable: 2 })] }),
        ],
        exchangeOptions: [
          {
            itemId: 9001,
            variants: [
              { variantId: 9101, color: 'ホワイト', size: 'M', isActive: true, stockQuantity: 5, madeToOrderLeadDays: null },
              { variantId: 9102, color: 'ホワイト', size: 'L', isActive: true, stockQuantity: 5, madeToOrderLeadDays: null },
            ],
          },
        ],
        // お店の送り状で送る（返送料を差し引く）と、返品の手数料、交換の手数料・交換の送料を使う設定：円の欄が3つと割合の欄が出る
        settings: {
          customerPaidMethod: 'shop_label',
          shopLabelFee: 800,
          restockingFeeEnabled: true,
          restockingFeePercent: 10,
          exchangeFeesEnabled: true,
          exchangeFee: 500,
          exchangeShippingFee: 300,
        },
      });
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 2, materials });
      await openReturns(page, state);
      const dialog = await openCreateDialog(page, ORDER_ID);
      const group = createLineGroup(dialog, 'シルクブラウス（ホワイト / M）');
      const resolution = group.getByRole('combobox', { name: '解決の方法', exact: true });
      const create = dialog.getByRole('button', { name: '返品を作る', exact: true });
      const shippingFee = dialog.getByLabel('返送料（円）', { exact: true });
      const exchangeFee = dialog.getByLabel('交換の手数料（円）', { exact: true });
      const exchangeShippingFee = dialog.getByLabel('交換の送料（円）', { exact: true });
      const limitMessage = dialog.getByText(RETURN_TEXT.yenLimit, { exact: true });
      const percent = dialog.getByLabel('返品の手数料（%）', { exact: true });
      const percentMessage = dialog.getByText(RETURN_TEXT.percentLimit, { exact: true });

      await group.getByLabel('返品する数', { exact: true }).fill('1');
      // 返送料（円）は設定の定額から始まる。上限を超えた数は収めずに残し、欄の下に誤りを出して、直るまで作れない
      await expect(shippingFee).toHaveValue('800');
      await shippingFee.fill('1000001');
      await expect(shippingFee).toHaveValue('1000001');
      await expect(shippingFee).toHaveAttribute('aria-invalid', 'true');
      await expect(limitMessage).toHaveCount(1);
      await expect(create).toBeDisabled();
      await shippingFee.fill('1000000');
      await expect(shippingFee).not.toHaveAttribute('aria-invalid', 'true');
      await expect(limitMessage).toHaveCount(0);
      await expect(create).toBeEnabled();

      // 返品の手数料（%）は設定の割合から始まる。0〜100の整数でない入力（範囲外・小数）は収めずに残し、欄の下に誤りを出して、直るまで作れない
      await expect(percent).toHaveValue('10');
      await percent.fill('101');
      await expect(percent).toHaveValue('101');
      await expect(percent).toHaveAttribute('aria-invalid', 'true');
      await expect(percentMessage).toHaveCount(1);
      await expect(create).toBeDisabled();
      await percent.fill('1.5');
      await expect(percentMessage).toHaveCount(1);
      await expect(create).toBeDisabled();
      // 0と100は通る
      await percent.fill('0');
      await expect(percent).not.toHaveAttribute('aria-invalid', 'true');
      await expect(percentMessage).toHaveCount(0);
      await expect(create).toBeEnabled();
      await percent.fill('100');
      await expect(percentMessage).toHaveCount(0);
      await expect(create).toBeEnabled();

      // 交換の手数料・交換の送料は、交換を選んだ時に出る。どちらも超えると誤りが2つ
      await resolution.selectOption({ label: '交換' });
      await expect(exchangeFee).toHaveValue('500');
      await expect(exchangeShippingFee).toHaveValue('300');
      await exchangeFee.fill('1000001');
      await exchangeShippingFee.fill('2000000');
      await expect(limitMessage).toHaveCount(2);
      await expect(create).toBeDisabled();
      // 欄を出していない間は送らない値なので、止めない
      await resolution.selectOption({ label: '返金' });
      await expect(exchangeFee).toHaveCount(0);
      await expect(limitMessage).toHaveCount(0);
      await expect(create).toBeEnabled();
      await resolution.selectOption({ label: '交換' });
      await exchangeFee.fill('1000000');
      await exchangeShippingFee.fill('0');
      await expect(limitMessage).toHaveCount(0);
      await expect(create).toBeEnabled();

      // 範囲ちょうどの額と割合は、そのまま（割合は整数で）窓口へ届く
      await create.click();
      await expect(page.getByRole('dialog', { name: `返品を作る（${orderNumberOf(ORDER_ID)}）` })).toHaveCount(0);
      expect(state.createPosts).toHaveLength(1);
      expect(state.createPosts[0]).toMatchObject({
        returnMethod: 'shop_label',
        returnShippingFee: 1_000_000,
        restockingFeePercent: 100,
        exchangeFee: 1_000_000,
        exchangeShippingFee: 0,
      });
    });

    test('返送先が設定されていない時は、その文が出て、返品を作れない', async ({ page }) => {
      // FREQ-462-AC-04
      const materials = returnMaterialsOf({
        orderId: ORDER_ID,
        settings: { returnAddressSet: false },
        shipments: [materialsShipmentOf({ lines: [materialsLineOf({ orderItemId: SHIRT, quantity: 2, returnable: 2 })] })],
      });
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 2, materials });
      await openReturns(page, state);
      const dialog = await openCreateDialog(page, ORDER_ID);

      await expect(dialog.getByText(RETURN_TEXT.addressMissing)).toBeVisible();
      await createLineGroup(dialog, 'シルクブラウス（ホワイト / M）').getByLabel('返品する数', { exact: true }).fill('1');
      await expect(dialog.getByRole('button', { name: '返品を作る', exact: true })).toBeDisabled();
      expect(state.createPosts).toHaveLength(0);
    });

    test('作ると、品・数・理由・解決・返送・メモ・知らせ・二重防止の番号が窓口へ届き、「返品を作りました。」が出て、返品の欄を読み直す', async ({ page }) => {
      // FREQ-462-AC-05
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 3, materials: twoShipmentMaterials() });
      const created = returnDetailOf({
        orderId: ORDER_ID,
        lines: [returnLineOf({ id: 'd4b2c3d4-0000-4000-8000-000000000001', orderItemId: SHIRT, quantity: 2, reason: 'defective' })],
      });
      state.answerCreate = async (route) => {
        state.returns = [created];
        await fulfillJson(route, { data: { returnId: created.id, number: 1, status: 'open', replayed: false } });
      };
      const dialog = await openReturns(page, state);
      expect(state.listReads).toBe(1);
      const create = await openCreateDialog(page, ORDER_ID);
      const group = createLineGroup(create, 'シルクブラウス（ホワイト / M）');

      await group.getByLabel('返品する数', { exact: true }).fill('2');
      await group.getByRole('combobox', { name: '理由', exact: true }).selectOption({ label: '破損・不良' });
      await group.getByRole('textbox', { name: '理由のメモ', exact: true }).fill('ほつれ');
      await create.getByRole('textbox', { name: '返送の伝票番号（任意）', exact: true }).fill('ABC-123');
      await create.getByRole('textbox', { name: 'メモ（お客様には見えません）', exact: true }).fill('お客様の電話で受付');
      await create.getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る', exact: true }).uncheck();
      await create.getByRole('button', { name: '返品を作る', exact: true }).click();

      await expect(dialog.getByRole('status')).toContainText(RETURN_TEXT.created);
      await expect(page.getByRole('dialog', { name: `返品を作る（${orderNumberOf(ORDER_ID)}）` })).toHaveCount(0);
      expect(state.createPosts).toHaveLength(1);
      expect(state.createPosts[0]).toMatchObject({
        lines: [
          {
            fulfillmentId: FULFILLMENT_ID,
            orderItemId: SHIRT,
            quantity: 2,
            reason: 'defective',
            reasonNote: 'ほつれ',
            resolution: 'refund',
            exchangeVariantId: null,
            exchangeMethod: null,
          },
        ],
        returnMethod: 'customer_ships',
        returnShippingPayer: 'shop',
        returnTrackingNumber: 'ABC-123',
        returnShippingFee: 0,
        restockingFeePercent: 0,
        exchangeFee: 0,
        exchangeShippingFee: 0,
        shopNote: 'お客様の電話で受付',
        notifyCustomer: false,
      });
      expect(String(state.createPosts[0].requestKey)).toMatch(UUID_PATTERN);
      // 作った返品が、返品の欄に出る（読み直した）。知らせは読み直しより先に出るので、欄が出てから読んだ回数を見る
      await expect(dialog.getByRole('group', { name: returnLabelOf(ORDER_ID, 1), exact: true })).toBeVisible();
      expect(state.listReads).toBeGreaterThanOrEqual(2);
    });

    test('窓口が断った時は、断りの文が画面の中に出て入力が残り、送り直しは新しい二重防止の番号で送られる', async ({ page }) => {
      // FREQ-462-AC-06
      const state = newReturnRouteState({ orderId: ORDER_ID, returnableUnits: 3, materials: twoShipmentMaterials() });
      const refusal = '返品できる数を超えています。画面を開き直してください。';
      let attempts = 0;
      state.answerCreate = async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await fulfillJson(route, { error: refusal, code: 'RETURN_QUANTITY_EXCEEDS' }, 409);
          return;
        }
        await fulfillJson(route, { data: { returnId: randomUUID(), number: 1, status: 'open', replayed: false } });
      };
      await openReturns(page, state);
      const create = await openCreateDialog(page, ORDER_ID);
      const quantity = createLineGroup(create, 'シルクブラウス（ホワイト / M）').getByLabel('返品する数', { exact: true });

      await quantity.fill('2');
      await create.getByRole('button', { name: '返品を作る', exact: true }).click();
      await expect(create.getByRole('alert')).toContainText(refusal);
      // 画面は閉じず、入力は残る
      await expect(quantity).toHaveValue('2');
      await expect(create.getByRole('button', { name: '返品を作る', exact: true })).toBeEnabled();

      await create.getByRole('button', { name: '返品を作る', exact: true }).click();
      await expect(page.getByRole('dialog', { name: `返品を作る（${orderNumberOf(ORDER_ID)}）` })).toHaveCount(0);
      expect(state.createPosts).toHaveLength(2);
      expect(state.createPosts[1].requestKey).not.toBe(state.createPosts[0].requestKey);
      expect(state.createPosts[1].lines).toEqual(state.createPosts[0].lines);
    });

    test('作る DB の関数は、返品（R1・受付中）と行を記録し、二重防止・返品できる数・交換の色・サイズ・理由「その他」のメモを守る。2件目は R2 になる（手元の DB）', async () => {
      // FREQ-462-AC-07
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `create-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [shirt, skirt] = fx.orderItemIds;
        const key = randomUUID();

        // 作る: R1・受付中。行は返金で、理由は入れた物
        const first = await createReturnInDb(db, fx, { requestKey: key, lines: [{ orderItemId: shirt, quantity: 1 }] });
        expect(first).toMatchObject({ number: 1, status: 'open', replayed: false });
        expect(await returnRowOf(db, first.returnId)).toMatchObject({
          number: 1,
          source: 'shop',
          status: 'open',
          return_method: 'customer_ships',
          notify_customer: true,
        });
        expect(await returnLineRowOf(db, first.lineIds[shirt])).toMatchObject({
          quantity: 1,
          reason: 'size_too_small',
          resolution: 'refund',
          exchange_variant_id: null,
          exchange_method: null,
        });
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 1, [skirt]: 1 });

        // 二重防止: 同じ番号で同じ中身は前の結果、違う中身は断る
        expect(await createReturnInDb(db, fx, { requestKey: key, lines: [{ orderItemId: shirt, quantity: 1 }] })).toMatchObject({
          returnId: first.returnId,
          number: 1,
          replayed: true,
        });
        await expectDbError(createReturnInDb(db, fx, { requestKey: key, lines: [{ orderItemId: shirt, quantity: 2 }] }), 'RETURN_REQUEST_MISMATCH');

        // 断り: 返品できる数の超過・「その他」のメモ・交換の色・サイズ（別の商品の物）
        await expectDbError(createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 2 }] }), 'RETURN_QUANTITY_EXCEEDS');
        await expectDbError(
          createReturnInDb(db, fx, { lines: [{ orderItemId: skirt, quantity: 1, reason: 'other' }] }),
          'RETURN_REASON_NOTE_REQUIRED',
        );
        const otherItem = await createCatalogFixture(db, { stock: 1, itemStatus: 'private' });
        await expectDbError(
          createReturnInDb(db, fx, { lines: [{ orderItemId: skirt, quantity: 1, exchange: { variantId: otherItem.variantId, method: 'stock' } }] }),
          'RETURN_EXCHANGE_VARIANT_INVALID',
        );
        // 断られた操作は何も残さない
        expect(await returnCountOf(db, fx.orderId)).toBe(1);

        // 2件目: 同じ商品の別の色・サイズへの交換。番号は R2
        const variantId = await addVariant(db, fx.itemId, { color: 'ブラック', size: 'L', stock: 2 });
        const second = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: skirt, quantity: 1, reason: 'other', reasonNote: '色味が違う', exchange: { variantId, method: 'stock' } }],
        });
        expect(second).toMatchObject({ number: 2, status: 'open', replayed: false });
        expect(await returnLineRowOf(db, second.lineIds[skirt])).toMatchObject({
          reason: 'other',
          reason_note: '色味が違う',
          resolution: 'exchange',
          exchange_method: 'stock',
        });
        expect(Number((await returnLineRowOf(db, second.lineIds[skirt])).exchange_variant_id)).toBe(variantId);
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 1, [skirt]: 0 });
        // 交換の品の行は、受け取るまで足されない
        expect(await exchangeItemRows(db, fx.orderId)).toEqual([]);
      });
    });

    test('同じ発送の同じ商品を、返金の行と交換の行の2つに分けて、1つの返品に作れる。2行の合計が返品できる数を超えると断る（手元の DB）', async () => {
      // FREQ-462-AC-09
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `create-split-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantId = await addVariant(db, fx.itemId, { color: 'ブラック', size: 'L', stock: 2 });
        const split = (): Parameters<typeof createReturnInDb>[2] => ({
          lines: [
            { orderItemId: shirt, quantity: 1 },
            { orderItemId: shirt, quantity: 1, exchange: { variantId, method: 'stock' } },
          ],
        });

        // 3点のうち、返金1点と交換1点。返品は1つ、行は2つ（返金の行と交換の行）
        const created = await createReturnInDb(db, fx, split());
        expect(created).toMatchObject({ number: 1, status: 'open', replayed: false });
        expect(created.lineRows.map((line) => [line.resolution, line.quantity])).toEqual([
          ['exchange', 1],
          ['refund', 1],
        ]);
        const exchangeLine = created.lineRows.find((line) => line.resolution === 'exchange');
        expect(exchangeLine && (await returnLineRowOf(db, exchangeLine.id))).toMatchObject({ exchange_method: 'stock' });
        // 返品できる数は、2行の合計（2点）だけ減る
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 1 });

        // 1行ずつなら残り（1点）に収まるが、2行の合計（2点）は超える。合計で確かめて断り、何も残さない
        await expectDbError(createReturnInDb(db, fx, split()), 'RETURN_QUANTITY_EXCEEDS');
        expect(await returnCountOf(db, fx.orderId)).toBe(1);
        expect(await returnableByItem(db, fx.orderId)).toEqual({ [shirt]: 1 });
      });
    });

    test('お知らせを入れて作ると、返品の受付のお知らせが1通届き、返品番号・返送する品・返送のしかた・返送先が載る（手元の DB・Mailpit）', async ({ request }) => {
      // FREQ-469-AC-01
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(180_000);
      const { fx, created } = await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `create-mail-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], notify: true });
        return { fx, created };
      });
      const orderNumber = orderNumberOf(fx.orderId);
      const label = returnLabelOf(fx.orderId, 1);

      const mails = await waitForMails(request, fx.email, RETURN_MAIL.accepted);
      await runWorkerUntil(
        request,
        async () => (await sentReturnMailCount(fx.orderId, 'return_accepted')) >= 1,
        '返品の受付のお知らせが送信済みになること',
      );
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${RETURN_MAIL.accepted}（${orderNumber}）`);
      const text = mails[0].Text;
      expect(text).toContain(RETURN_MAIL.accepted1(orderNumber, label));
      expect(text).toContain('ご返送いただく商品:');
      expect(text).toContain('・E2Eシャツ（ホワイト / M） × 1');
      expect(text).toContain(RETURN_MAIL.sendTo);
      expect(text).toContain(RETURN_MAIL.customerPays);
      expect(text).toContain('返送先:');
      expect(text).toContain(RETURN_ADDRESS.name);
      expect(text).toContain(RETURN_ADDRESS.address);
      expect(text).toContain(RETURN_ADDRESS.phone);
      // 受付のお知らせの予定は、この返品に結び付いた1行だけ
      const rows = await withLocalDb(async (db) =>
        (await db.query(`select return_id from private.order_email_outbox where order_id = $1 and kind = 'return_accepted'`, [fx.orderId])).rows,
      );
      expect(rows).toEqual([{ return_id: created.returnId }]);
    });
  });
}
