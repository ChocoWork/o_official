/**
 * FR-ADMIN-074 返金の画面
 * 対応 FREQ: FREQ-448（AC-01〜AC-06）・FREQ-451（AC-05）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形で、「全額なのに未発送の商品が無い」の断りは
 * 試験の中で窓口の代わりに真似る（AC-06）。同じ二重防止の番号の送り直しで返金が二重にならないこと（AC-05 の DB の側。Review Focus 1）は、
 * 手元の DB の関数を直に呼んで確かめる。返金の画面は、目で見るために3つの画面幅の写しを test-results/group-e2/ に残す。
 * FREQ-451-AC-05（本計画 P27・P28。①がオフの時や①が断られた時も、取り消した注文に届いた入金を管理画面から全額返金できる）の2本は、
 * ショップの設定①を切り替えない。①は店全体の1行で、並んで流れる FR-CHECKOUT-051 を壊すため。取消の後に受け取った額が書かれた
 * 状態から確かめる。
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { PRICE, uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';
import type { RefundErrorResponse, RefundMaterials, RefundPaymentMethod } from '@/lib/orders/refund/refund-types';
import {
  beginRefund,
  createActor,
  createOrderWithLines,
  expectDbError,
  recordRefundResult,
  refundRows,
  stockLedger,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  UUID_PATTERN,
  adminOrder,
  fulfillJson,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  viewports,
} from './order-fulfillment-test-utils';
import {
  MINUS,
  REFUND_TEXT,
  TIMING_NOTES,
  acceptedRefund,
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openRefundDialog,
  quantityInput,
  readBreakdown,
  refundErrorMessage,
  refundMaterialsOf,
  refuseRefund,
} from './refund-test-utils';

const ORDER_ID = 'a4b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b4b2c3d4-0000-4000-8000-000000000001';
const COAT = 'b4b2c3d4-0000-4000-8000-000000000002';
const REFUND_ID = 'e4b2c3d4-0000-4000-8000-000000000001';
const BLOUSE_LABEL = 'シルクブラウス（ホワイト / M）';
const COAT_LABEL = 'ウールコート（ブラック / L）';
const BEFORE = '発送前の商品';
const AFTER = '発送済みの商品';

/** ブラウス（在庫。2つのうち1つは発送済み）とコート（受注生産。未発送）。送料 800、合計 ￥54,800 */
function partlyShipped(paymentMethod: RefundPaymentMethod = 'card'): RefundMaterials {
  return refundMaterialsOf({
    orderId: ORDER_ID,
    paymentMethod,
    shippingAmount: 800,
    lines: [
      materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000, quantity: 2, shipped: 1 }),
      materialLineOf({
        orderItemId: COAT, name: 'ウールコート', color: 'ブラック', size: 'L', fulfillmentType: 'backorder', itemPrice: 30_000,
      }),
    ],
  });
}

/** 1つも発送していない注文。ブラウス1つ（在庫）とコート1つ（受注生産）。送料 800、合計 ￥42,800 */
function unshipped(): RefundMaterials {
  return refundMaterialsOf({
    orderId: ORDER_ID,
    shippingAmount: 800,
    lines: [
      materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000 }),
      materialLineOf({
        orderItemId: COAT, name: 'ウールコート', color: 'ブラック', size: 'L', fulfillmentType: 'backorder', itemPrice: 30_000,
      }),
    ],
  });
}

const ROW = adminOrder({
  id: ORDER_ID,
  canShip: false,
  canRefund: true,
  paymentStatusKey: 'paid',
  refundedAmountLabel: '-',
  cancelKind: null,
});

async function mockApis(page: Page, materials: RefundMaterials) {
  const state = newRefundRouteState(materials);
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [ROW]);
  await mockRefundRoutes(page, ORDER_ID, state);
  return { state, list };
}

/** 返金の窓口の答えが届かない3つの形。どれも「返金を頼んだか分からない」になる */
const failures = [
  {
    name: '通信が切れた',
    fail: async (route: Route) => {
      await route.abort('failed');
    },
  },
  {
    name: 'サーバーが500を返した',
    fail: async (route: Route) => {
      await fulfillJson(route, { error: '返金の記録に失敗しました。', code: 'failed' } satisfies RefundErrorResponse, 500);
    },
  },
  {
    name: '窓口が「返金を頼んだか分からない」（502）を返した',
    fail: async (route: Route) => {
      await fulfillJson(
        route,
        { error: REFUND_TEXT.unknownOutcome, code: 'unknown_outcome', refundId: REFUND_ID } satisfies RefundErrorResponse,
        502,
      );
    },
  },
];

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-074 refund dialog (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送前の商品と発送済みの商品に分かれて並び、数は返せる数までに収まる。支払い方法に合う案内が出る', async ({ page }) => {
      // FREQ-448-AC-01
      await mockApis(page, partlyShipped());
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      const before = dialog.getByRole('region', { name: BEFORE, exact: true });
      const after = dialog.getByRole('region', { name: AFTER, exact: true });
      await expect(before.getByRole('group')).toHaveCount(2);
      await expect(before.getByRole('group', { name: BLOUSE_LABEL, exact: true })).toBeVisible();
      await expect(before.getByRole('group', { name: COAT_LABEL, exact: true })).toBeVisible();
      await expect(after.getByRole('group')).toHaveCount(1);
      await expect(after.getByRole('group', { name: BLOUSE_LABEL, exact: true })).toBeVisible();
      // 品物が戻る時の注意は、発送済みの区分にだけ出る
      await expect(after.getByText(REFUND_TEXT.shippedNotice)).toBeVisible();
      await expect(before.getByText(REFUND_TEXT.shippedNotice)).toHaveCount(0);
      await expect(dialog.getByText(TIMING_NOTES.card)).toBeVisible();
      await expect(dialog.getByText(REFUND_TEXT.noUndo)).toBeVisible();

      // 返せる数（ブラウスの発送済みは1つ）を超えて入れても、返せる数に収まる
      const shippedBlouse = quantityInput(dialog, AFTER, BLOUSE_LABEL);
      await expect(shippedBlouse).toHaveAttribute('max', '1');
      await shippedBlouse.fill('9');
      await expect(shippedBlouse).toHaveValue('1');
    });

    test('「在庫に戻す」は発送前の在庫の品を選んだ時だけ出て、最初から入っている。受注生産の品には戻らない注意が出る', async ({ page }) => {
      // FREQ-448-AC-02
      await mockApis(page, partlyShipped());
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      const restock = dialog.getByRole('checkbox', { name: '在庫に戻す' });
      await expect(quantityInput(dialog, BEFORE, BLOUSE_LABEL)).toBeVisible();
      await expect(restock).toHaveCount(0);

      // 発送済みの品だけを選んでも出ない。発送済みの区分には、品物が戻る時の注意が出る
      await quantityInput(dialog, AFTER, BLOUSE_LABEL).fill('1');
      await expect(restock).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: AFTER, exact: true }).getByText(REFUND_TEXT.shippedNotice)).toBeVisible();

      // 受注生産の品を選んでも出ない。在庫には戻らない注意が出る
      await quantityInput(dialog, BEFORE, COAT_LABEL).fill('1');
      await expect(restock).toHaveCount(0);
      await expect(dialog.getByText(REFUND_TEXT.backorderNotice)).toBeVisible();

      // 発送前の在庫の品を選ぶと出て、最初から入っている
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      await expect(restock).toBeChecked();
      await expect(dialog.getByText(REFUND_TEXT.restockHint)).toBeVisible();

      // 選びを外すと、また出なくなる
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('0');
      await expect(restock).toHaveCount(0);
      await expect(dialog.getByText(REFUND_TEXT.restockHint)).toHaveCount(0);
    });

    test('ボタンに返金額が出て、選んだ数・送料・理由・メモ・お知らせがそのまま窓口へ届く。受け付けると、知らせを出して一覧を読み直す', async ({ page }) => {
      // FREQ-448-AC-04
      const nativeDialogs: string[] = [];
      page.on('dialog', (native) => {
        nativeDialogs.push(native.message());
        void native.dismiss();
      });
      const { state, list } = await mockApis(page, partlyShipped());
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      const button = (amount: number) =>
        dialog.getByRole('button', { name: `${formatYen(amount)} を返金する`, exact: true });

      // 何も選んでいない間は、額が 0 で押せない
      await expect(button(0)).toBeDisabled();

      // ブラウス（発送前）を1つ選ぶ
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      await expect
        .poll(() => readBreakdown(dialog))
        .toEqual({ 商品: formatYen(12_000), 割引: formatYen(0), 送料: formatYen(0), 返金額: formatYen(12_000) });
      await expect(button(12_000)).toBeEnabled();

      // 送料を足す。返せる送料（800）を超えて入れても、800 に収まる
      const shipping = dialog.getByLabel('送料', { exact: true });
      await expect(dialog.getByText(`返せる送料: ${formatYen(800)}`)).toBeVisible();
      await shipping.fill('5000');
      await expect(shipping).toHaveValue('800');
      await expect(button(12_800)).toBeEnabled();

      // 返金額は手で直せる。返せる額（￥54,800）を超えて入れても、返せる額に収まる
      const amount = dialog.getByLabel('返金額', { exact: true });
      await expect(dialog.getByText(`返せる額: ${formatYen(54_800)}`)).toBeVisible();
      await amount.fill('99999999');
      await expect(amount).toHaveValue('54800');
      await amount.fill('12300');
      await expect(button(12_300)).toBeEnabled();

      // 理由・メモ・お知らせ・在庫に戻すの選び。「不正の疑い」には注意が出る
      const reason = dialog.getByLabel('Stripe に伝える理由');
      await reason.selectOption('fraudulent');
      await expect(dialog.getByText(REFUND_TEXT.fraudNotice)).toBeVisible();
      await reason.selectOption('duplicate');
      await expect(dialog.getByText(REFUND_TEXT.fraudNotice)).toHaveCount(0);
      await dialog.getByLabel('メモ（お客様には見えません）').fill('お客様の都合で一部返品');
      const notify = dialog.getByRole('checkbox', { name: 'お客様に返金のメールを送る' });
      await expect(notify).toBeChecked();
      await notify.uncheck();
      await dialog.getByRole('checkbox', { name: '在庫に戻す' }).uncheck();

      await button(12_300).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.refundPosts).toHaveLength(1);
      expect(state.refundPosts[0]).toMatchObject({
        lines: [{ orderItemId: BLOUSE, quantity: 1, beforeShipment: true }],
        restock: false,
        shippingAmount: 800,
        amount: 12_300,
        note: 'お客様の都合で一部返品',
        stripeReason: 'duplicate',
        notifyCustomer: false,
      });
      expect(state.refundPosts[0].requestKey).toMatch(UUID_PATTERN);
      // 受け付けたら、一覧を読み直して知らせを出す。返金の確認は画面の中で済み、ブラウザの確認の画面は出ない
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toBeVisible();
      await expect.poll(() => list.urls.length).toBeGreaterThanOrEqual(2);
      expect(nativeDialogs).toEqual([]);
    });

    test('1つも発送していない注文で全部の商品を選ぶと、送料と返金額が全部に固定されて減らせない。商品を減らすと固定が外れる', async ({ page }) => {
      // FREQ-448-AC-03, FREQ-448-AC-04
      const { state } = await mockApis(page, unshipped());
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      const shipping = dialog.getByLabel('送料', { exact: true });
      const amount = dialog.getByLabel('返金額', { exact: true });

      await dialog.getByRole('button', { name: 'すべて選ぶ', exact: true }).click();
      await expect(quantityInput(dialog, BEFORE, BLOUSE_LABEL)).toHaveValue('1');
      await expect(quantityInput(dialog, BEFORE, COAT_LABEL)).toHaveValue('1');
      await expect(shipping).toHaveValue('800');
      await expect(shipping).not.toBeEditable();
      await expect(amount).toHaveValue('42800');
      await expect(amount).not.toBeEditable();
      await expect(dialog.getByText(REFUND_TEXT.fullRefundNotice)).toBeVisible();
      await expect
        .poll(() => readBreakdown(dialog))
        .toEqual({ 商品: formatYen(42_000), 割引: formatYen(0), 送料: formatYen(800), 返金額: formatYen(42_800) });
      await expect(dialog.getByRole('button', { name: `${formatYen(42_800)} を返金する`, exact: true })).toBeEnabled();

      // 商品を1つ減らすと固定が外れる。送料は 800 のまま、返金額は内訳の合計に戻る
      await quantityInput(dialog, BEFORE, COAT_LABEL).fill('0');
      await expect(dialog.getByText(REFUND_TEXT.fullRefundNotice)).toHaveCount(0);
      await expect(shipping).toBeEditable();
      await expect(amount).toBeEditable();
      await expect(amount).toHaveValue('12800');
      await shipping.fill('0');
      await expect(amount).toHaveValue('12000');

      // もう一度全部を選ぶと固定され、そのまま返金できる（送料は入れ直した 0 でなく、返せる送料の全部）
      await quantityInput(dialog, BEFORE, COAT_LABEL).fill('1');
      await expect(shipping).toHaveValue('800');
      await expect(amount).toHaveValue('42800');
      await dialog.getByRole('button', { name: `${formatYen(42_800)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.refundPosts).toHaveLength(1);
      expect(state.refundPosts[0]).toMatchObject({
        lines: [
          { orderItemId: BLOUSE, quantity: 1, beforeShipment: true },
          { orderItemId: COAT, quantity: 1, beforeShipment: true },
        ],
        restock: true,
        shippingAmount: 800,
        amount: 42_800,
      });
    });

    test('割引のある注文は、内訳に割引を引いた額が出て、ボタンもその額になる', async ({ page }) => {
      // FREQ-448-AC-04
      await mockApis(
        page,
        refundMaterialsOf({
          orderId: ORDER_ID,
          discountAmount: 333,
          lines: [materialLineOf({ orderItemId: BLOUSE, itemPrice: 5_000, lineDiscount: 333 })],
        }),
      );
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      await expect.poll(() => readBreakdown(dialog)).toEqual({
        商品: formatYen(5_000),
        割引: `${MINUS}${formatYen(333)}`,
        送料: formatYen(0),
        返金額: formatYen(4_667),
      });
      await expect(dialog.getByRole('button', { name: `${formatYen(4_667)} を返金する`, exact: true })).toBeEnabled();
    });

    test('全額なのに未発送の商品が選ばれていないと、窓口が断り、断りの文が出る。選び直して送る時は新しい二重防止の番号になる', async ({ page }) => {
      // FREQ-448-AC-06
      const { state } = await mockApis(page, partlyShipped());
      // 窓口の代わり: 返せる額の全部を、未発送の商品を全部選ばずに返そうとすると断る（DB の REFUND_MUST_INCLUDE_UNSHIPPED）
      state.answerRefund = async (route, body) => {
        const order = state.materials.order;
        const included = body.lines.filter((line) => line.beforeShipment).reduce((sum, line) => sum + line.quantity, 0);
        if (body.amount === order.refundableAmount && order.unshippedTotal - included > 0) {
          await refuseRefund(route, 'must_include_unshipped');
          return;
        }
        await fulfillJson(route, acceptedRefund({ amount: body.amount }));
      };
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      // 発送済みのブラウス1つと送料を選び、返金額を返せる額の全部（￥54,800）に直して送る
      await quantityInput(dialog, AFTER, BLOUSE_LABEL).fill('1');
      await dialog.getByLabel('送料', { exact: true }).fill('800');
      await dialog.getByLabel('返金額', { exact: true }).fill('54800');
      await dialog.getByRole('button', { name: `${formatYen(54_800)} を返金する`, exact: true }).click();

      await expect(dialog.getByRole('alert')).toHaveText(refundErrorMessage('must_include_unshipped'));
      expect(state.refundPosts).toHaveLength(1);
      expect(state.refundPosts[0].lines).toEqual([{ orderItemId: BLOUSE, quantity: 1, beforeShipment: false }]);
      // 画面は閉じず、入力を直して送り直せる
      await expect(dialog).toBeVisible();
      await expect(quantityInput(dialog, BEFORE, BLOUSE_LABEL)).toBeEnabled();

      // 未発送の商品も選ぶ。数を変えると返金額は内訳の合計（ブラウス2つ + コート + 送料 = ￥54,800）に戻る
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      await quantityInput(dialog, BEFORE, COAT_LABEL).fill('1');
      await dialog.getByRole('button', { name: `${formatYen(54_800)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.refundPosts).toHaveLength(2);
      expect(state.refundPosts[1].lines).toEqual([
        { orderItemId: BLOUSE, quantity: 1, beforeShipment: true },
        { orderItemId: COAT, quantity: 1, beforeShipment: true },
        { orderItemId: BLOUSE, quantity: 1, beforeShipment: false },
      ]);
      // 断られた後の送信は別の操作なので、新しい二重防止の番号になる
      expect(state.refundPosts[1].requestKey).toMatch(UUID_PATTERN);
      expect(state.refundPosts[1].requestKey).not.toBe(state.refundPosts[0].requestKey);
    });

    test('お金が戻る時期の案内は、支払い方法に合わせて出る', async ({ page }) => {
      // FREQ-448-AC-01
      const { state } = await mockApis(page, partlyShipped());
      await openOrderTab(page);

      for (const method of ['card', 'link', 'paypay', 'konbini', 'unknown'] as const) {
        state.materials = partlyShipped(method);
        const dialog = await openRefundDialog(page, ORDER_ID);
        await expect(dialog.getByText(TIMING_NOTES[method], { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    });

    for (const failure of failures) {
      test(`${failure.name}時は、入力を止めて「もう一度確かめる」だけを出し、同じ二重防止の番号と同じ中身で確かめ直す`, async ({ page }) => {
        // FREQ-448-AC-05（Review Focus 1）
        const { state, list } = await mockApis(page, partlyShipped());
        // サーバーは1回目を記録していたのに、答えが届かなかった
        state.answerRefund = async (route) => {
          await failure.fail(route);
        };
        await openOrderTab(page);
        const dialog = await openRefundDialog(page, ORDER_ID);
        await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
        await dialog.getByRole('button', { name: `${formatYen(12_000)} を返金する`, exact: true }).click();

        await expect(dialog.getByRole('alert')).toHaveText(REFUND_TEXT.unknownOutcome);
        // 押せるボタンは「閉じる」と「もう一度確かめる」だけ。入力は全部止まる
        await expect(dialog.locator('button:not([disabled])')).toHaveCount(2);
        await expect(dialog.getByRole('button', { name: 'もう一度確かめる', exact: true })).toBeEnabled();
        await expect(dialog.getByRole('button', { name: '閉じる', exact: true })).toBeEnabled();
        await expect(dialog.locator('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')).toHaveCount(0);
        expect(state.refundPosts).toHaveLength(1);

        // 同じ二重防止の番号の送り直しには、前の結果（replayed）が返る
        state.answerRefund = async (route, body) => {
          await fulfillJson(route, acceptedRefund({ refundId: REFUND_ID, amount: body.amount, replayed: true }));
        };
        await dialog.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();

        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.refundPosts).toHaveLength(2);
        expect(state.refundPosts[1]).toEqual(state.refundPosts[0]);
        await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toBeVisible();
        await expect.poll(() => list.urls.length).toBeGreaterThanOrEqual(2);
      });
    }

    test('答えが分からないまま「閉じる」を押すと、閉じて一覧を読み直す。返金を受け付けた知らせは出さない', async ({ page }) => {
      // FREQ-448-AC-05（Review Focus 1）
      const { state, list } = await mockApis(page, partlyShipped());
      state.answerRefund = async (route) => {
        await route.abort('failed');
      };
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      await dialog.getByRole('button', { name: `${formatYen(12_000)} を返金する`, exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText(REFUND_TEXT.unknownOutcome);
      const readsBefore = list.urls.length;

      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect.poll(() => list.urls.length).toBeGreaterThan(readsBefore);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticeSucceeded })).toHaveCount(0);
    });

    test('送っている間は画面を閉じられず、返事が来ると結果が出て閉じる', async ({ page }) => {
      // FREQ-448-AC-05（送っている間の扱い）
      const { state } = await mockApis(page, partlyShipped());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.answerRefund = async (route, body) => {
        await gate;
        await fulfillJson(route, acceptedRefund({ amount: body.amount }));
      };
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      const submit = dialog.getByRole('button', { name: `${formatYen(12_000)} を返金する`, exact: true });
      await submit.click();

      await expect.poll(() => state.refundPosts.length).toBe(1);
      await expect(dialog.getByRole('button', { name: 'キャンセル', exact: true })).toBeDisabled();
      await expect(submit).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      release();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toBeVisible();
    });

    test('確かめ中の返金がある注文は、入力を出さず「もう一度確かめる」と「閉じる」だけを出し、記録の番号で確かめ直す', async ({ page }) => {
      // FREQ-448-AC-05
      const { state } = await mockApis(
        page,
        refundMaterialsOf({
          orderId: ORDER_ID,
          shippingAmount: 800,
          openAmount: 12_800,
          awaitingRefund: { id: REFUND_ID, amount: 12_800, createdAt: '2026-10-11T01:00:00.000Z' },
          lines: [materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000 })],
        }),
      );
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      await expect(dialog.getByText(`確かめ中の返金があります（${formatYen(12_800)}）。`)).toBeVisible();
      await expect(dialog.locator('input, select, textarea')).toHaveCount(0);
      await expect(dialog.locator('button:not([disabled])')).toHaveCount(2);
      await expect(dialog.getByRole('button', { name: '閉じる', exact: true })).toBeEnabled();

      await dialog.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.confirmPosts).toEqual([{ refundId: REFUND_ID }]);
      expect(state.refundPosts).toHaveLength(0);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticeSucceeded })).toBeVisible();
    });

    test('返金を始める関数は、同じ二重防止の番号の送り直しに前の記録を返して二重にせず、中身の違う送り直しと返事待ちの間の別の返金を断る（手元の DB）', async () => {
      // FREQ-448-AC-05（DB の側。Review Focus 1）
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-replay-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }],
          { paidAmount: 'total' },
        );
        const [shirt] = order.orderItemIds;
        const input = {
          requestKey: randomUUID(),
          actorId,
          lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: true }],
          amount: PRICE,
        };

        const first = await beginRefund(db, order.orderId, input);
        expect(first).toMatchObject({ amount: PRICE, status: 'awaiting_response', replayed: false });
        // 通信が切れた後の送り直し: 同じ番号・同じ中身には前の記録を返し、記録は増えない
        expect(await beginRefund(db, order.orderId, input)).toEqual({ ...first, replayed: true });
        expect(await refundRows(db, order.orderId)).toHaveLength(1);
        // 中身の違う送り直しは断る
        await expectDbError(
          beginRefund(db, order.orderId, {
            ...input,
            lines: [{ orderItemId: shirt, quantity: 2, beforeShipment: true }],
            amount: PRICE * 2,
          }),
          'REFUND_REQUEST_MISMATCH',
        );
        // 返事待ちの間は、別の番号の返金を作れない
        await expectDbError(beginRefund(db, order.orderId, { ...input, requestKey: randomUUID() }), 'AWAITING_REFUND_EXISTS');
        expect(await refundRows(db, order.orderId)).toHaveLength(1);

        // 結果が書かれた後の送り直しも、前の記録（成功）を返すだけで、新しい返金を作らない
        await recordRefundResult(db, first.refundId);
        expect(await beginRefund(db, order.orderId, input)).toMatchObject({
          refundId: first.refundId,
          status: 'succeeded',
          replayed: true,
        });
        expect(await refundRows(db, order.orderId)).toHaveLength(1);
      });
    });

    test('取り消した注文に届いた入金（①がオフ・①が始める前に断られた時）も、返金の画面の「すべて選ぶ」で全額を返せる。在庫に戻すは出ない', async ({ page }) => {
      // FREQ-451-AC-05, FREQ-448-AC-03（本計画 P27・P28）
      const { state } = await mockApis(
        page,
        refundMaterialsOf({
          orderId: ORDER_ID,
          status: 'cancelled',
          shippingAmount: 800,
          lines: [
            // 確保は未入金の取消の時に戻したので、在庫に戻せる数は 0
            materialLineOf({ orderItemId: BLOUSE, itemPrice: 12_000, restockable: 0 }),
            materialLineOf({
              orderItemId: COAT, name: 'ウールコート', color: 'ブラック', size: 'L', fulfillmentType: 'backorder', itemPrice: 30_000,
            }),
          ],
        }),
      );
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);

      await dialog.getByRole('button', { name: 'すべて選ぶ', exact: true }).click();
      await expect(dialog.getByLabel('送料', { exact: true })).toHaveValue('800');
      await expect(dialog.getByLabel('送料', { exact: true })).not.toBeEditable();
      await expect(dialog.getByLabel('返金額', { exact: true })).toHaveValue('42800');
      await expect(dialog.getByRole('checkbox', { name: '在庫に戻す' })).toHaveCount(0);
      await dialog.getByRole('button', { name: `${formatYen(42_800)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.refundPosts).toHaveLength(1);
      expect(state.refundPosts[0]).toMatchObject({
        lines: [
          { orderItemId: BLOUSE, quantity: 1, beforeShipment: true },
          { orderItemId: COAT, quantity: 1, beforeShipment: true },
        ],
        shippingAmount: 800,
        amount: 42_800,
      });
    });

    test('取り消した注文に受け取った額を書いた後（P27）は、返せる額が出て、未発送の全部・全額の返金だけが通り、在庫は動かず取消のまま（手元の DB）', async () => {
      // FREQ-451-AC-05（本計画 P27・P28）
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`cancelled-paid-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }],
          { status: 'pending' },
        );
        const [shirt] = order.orderItemIds;
        // 未入金のまま取り消す（在庫の確保は戻る）
        const released = await db.query(
          `select released from public.release_stock_for_unpaid_order(
             $1::uuid, 'pending'::public.order_status, 'cancelled'::public.order_status, 'admin_cancel', $2::uuid, null,
             'customer_request', null, false)`,
          [order.orderId, actorId],
        );
        expect(released.rows[0].released).toBe(true);

        // 取消の後に入金が届き、照合が受け取った額と支払いの番号を書く（注文に番号が無い card の形）。2回目は何もしない
        const paymentIntentId = `pi_e2e${uniqueSuffix()}`;
        const write = async () =>
          (await db.query('select public.record_cancelled_order_paid_amount($1::uuid, $2::text, $3::integer) as written', [
            order.orderId, paymentIntentId, order.totalAmount,
          ])).rows[0].written as boolean;
        expect(await write()).toBe(true);
        expect(await write()).toBe(false);
        expect(
          (await db.query('select status::text as status, paid_amount, payment_intent_id from public.orders where id = $1', [order.orderId]))
            .rows[0],
        ).toEqual({ status: 'cancelled', paid_amount: order.totalAmount, payment_intent_id: paymentIntentId });

        // 一覧の返金のボタンの元（返せる額 > 0）と、返金の画面の材料（在庫に戻せる数は 0）
        const summary = (await db.query('select refundable_amount from public.list_order_refund_summaries(array[$1::uuid])', [order.orderId]))
          .rows[0];
        expect(Number(summary.refundable_amount)).toBe(order.totalAmount);
        const materials = (await db.query('select lines from public.load_order_refund_materials($1::uuid)', [order.orderId])).rows[0];
        expect(materials.lines).toEqual([expect.objectContaining({ order_item_id: shirt, unshipped: 2, restockable: 0 })]);

        // 未発送の全部を選んで額を減らすと断る（P28: 取り消した注文でも決まりは同じ）。全部を返すと通り、台帳は動かず、取消のまま
        const ledgerBefore = await stockLedger(db, order.orderId);
        const allLines = [{ orderItemId: shirt, quantity: 2, beforeShipment: true }];
        await expectDbError(
          beginRefund(db, order.orderId, { actorId, lines: allLines, shippingAmount: 0, amount: order.totalAmount - 1 }),
          'REFUND_MUST_BE_FULL',
        );
        const began = await beginRefund(db, order.orderId, { actorId, lines: allLines, shippingAmount: 0, amount: order.totalAmount });
        expect(await recordRefundResult(db, began.refundId)).toMatchObject({
          status: 'succeeded',
          orderStatus: 'cancelled',
          refundedAmount: order.totalAmount,
        });
        expect(await stockLedger(db, order.orderId)).toEqual(ledgerBefore);
      });
    });

    test('小さい画面では画面いっぱいに開き、広い画面では中央に収まる。横方向のページスクロールが発生しない', async ({ page }) => {
      await mockApis(page, partlyShipped());
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      await quantityInput(dialog, BEFORE, BLOUSE_LABEL).fill('1');
      const submit = dialog.getByRole('button', { name: `${formatYen(12_000)} を返金する`, exact: true });
      await expect(submit).toBeEnabled();
      // 確定のボタンの字は、3つの画面幅とも切れずに全部が見える（Button の既定は折り返さず、はみ出しを隠す）
      expect(await submit.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      const box = await dialog.boundingBox();
      if (!box) throw new Error('返金の画面の位置を取れなかった');
      if (viewport.width < 768) {
        expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
      } else {
        expect(box.width).toBeLessThan(viewport.width);
      }
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e2/refund-dialog-${viewport.width}.png`, animations: 'disabled' });
    });
  });
}
