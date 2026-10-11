/**
 * FR-ACCOUNT-033 お客様の注文の画面の返金
 * 対応 FREQ: FREQ-460（AC-01〜AC-05）
 *
 * 画面は窓口（GET /api/orders/[id]）の答えを差し替えて確かめる。答えの形は共通の約束（実装計画 C-2、Task 14）。
 * 失敗・エラーの返金が窓口にも画面にも出ないこと（Review Focus 2 の本物の側）と、「キャンセルの手続き中」は、手元の Supabase に
 * 会員を作ってログインし、本物の窓口で確かめる（e2e/member-session-helpers.ts。手元以外では動かない。実装計画 E2-8）。
 */
import { expect, test, type Page } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import { mockOtpAuthentication } from './account-test-utils';
import { createTestMember, loginAsMember } from './member-session-helpers';
import { withReadyProgress, type DetailRefund } from './order-detail-fixtures';
import {
  beginRefund,
  createActor,
  createOrderWithLines,
  markRefundError,
  recordRefundResult,
  withLocalDb,
} from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { formatYen } from './refund-test-utils';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

const ORDER_ID = 'order-refund-1';
const ORDER_NUMBER = 'ORD-0033';
const BLOUSE = 'シルクブラウス';
const SKIRT = 'プリーツスカート';
const CANCEL_PENDING = 'キャンセルの手続き中';
const KONBINI_SENTENCE = '返金先の口座の入力をお願いしています';
/**
 * 日本時間では 2030年11月25日 23:59:59。画面とメールの日付は「その日のうちに入れれば必ず間に合う最後の日」＝期限の1分後の日付の前日
 * （決め事 E2。konbiniDeadlineLastDay）なので、この期限は 11月25日 と出る。日付が試験の実行日に左右されないよう、遠い先の日にする
 */
const KONBINI_DEADLINE = '2030-11-25T14:59:59.000Z';

/** 窓口の古い形の答え（在庫の品2つの入金済みの注文）。withReadyProgress で E-1・E-2 の欄を足す */
const OLD_DETAIL = {
  id: ORDER_ID,
  orderNumber: ORDER_NUMBER,
  orderDate: '2026/10/01 09:00',
  status: 'paid',
  subtotalAmount: formatYen(60_000),
  shippingAmount: formatYen(500),
  discountAmount: formatYen(0),
  totalAmount: formatYen(60_500),
  paymentMethod: 'クレジットカード',
  shippingFullName: '山田 花子',
  shippingEmail: 'user@example.com',
  shippingPhone: '090-1111-2222',
  shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
  items: [
    { id: 'item-1', itemId: 10, name: BLOUSE, imageUrl: null, color: 'ホワイト', size: 'M', quantity: 3, amount: formatYen(36_000), stockStatus: 'in_stock' },
    { id: 'item-2', itemId: 11, name: SKIRT, imageUrl: null, color: 'ホワイト', size: 'M', quantity: 2, amount: formatYen(24_000), stockStatus: 'in_stock' },
  ],
};

const COMPLETED: DetailRefund = {
  id: 'refund-1', date: '2026/10/12', amount: formatYen(12_000), status: 'completed', customerActionDeadline: null,
};
const PROCESSING: DetailRefund = {
  id: 'refund-2', date: '2026/10/13', amount: formatYen(8_000), status: 'processing', customerActionDeadline: null,
};
const KONBINI: DetailRefund = { ...PROCESSING, id: 'refund-3', customerActionDeadline: '11月25日' };

type DetailInput = {
  refunds?: DetailRefund[];
  refundTotal?: string;
  /** 商品ごとの返金した数（OLD_DETAIL の商品の並び） */
  refundedQuantities?: number[];
  /** 全部の商品を返金した形（発送準備中の数は 0 になる） */
  fullyRefunded?: boolean;
  progress?: { key: 'cancel_pending'; label: string; partiallyShipped: false; steps: null };
};

function detailOf(input: DetailInput = {}) {
  const base = withReadyProgress(OLD_DETAIL);
  return {
    ...base,
    ...(input.progress ? { progress: input.progress } : {}),
    refunds: input.refunds ?? [],
    refundTotal: input.refundTotal ?? null,
    items: base.items.map((item, index) => ({
      ...item,
      refundedQuantity: input.fullyRefunded ? item.quantity : (input.refundedQuantities?.[index] ?? 0),
      // withReadyProgress は商品を全部、発送準備中の数（= 数）に入れる。全部返金した形では 0
      readyQuantity: input.fullyRefunded ? 0 : item.quantity,
    })),
  };
}

async function openDetail(page: Page, detail: unknown): Promise<void> {
  await mockOtpAuthentication(page);
  await page.route(`**/api/orders/${ORDER_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));
  await page.goto(`/account/orders/${ORDER_ID}`);
  await expect(page.getByText(ORDER_NUMBER)).toBeVisible();
}

/** 手元の Supabase に会員を作ってログインし、その会員の入金済みの注文（シャツ n 枚。受け取った額は合計と同じ）を作る */
async function memberWithOrder(page: Page, label: string, quantity: number) {
  const member = await createTestMember(label);
  await loginAsMember(page, member);
  return withLocalDb(async (db) => {
    const actorId = await createActor(db);
    const order = await createOrderWithLines(
      db,
      member.email,
      [{ name: 'E2Eシャツ', quantity, fulfillmentType: 'stock' }],
      { userId: member.userId, paidAmount: 'total' },
    );
    return { actorId, orderId: order.orderId, shirt: order.orderItemIds[0] };
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-033 order refunds (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('返金ごとに「ご返金」の行が、日付・額・状態つきで古い順に、支払金額の欄の中に出る。2件なので合計の行も出る', async ({ page }) => {
      // FREQ-460-AC-01
      await openDetail(page, detailOf({ refunds: [COMPLETED, PROCESSING], refundTotal: formatYen(20_000), refundedQuantities: [2, 0] }));
      const region = page.getByRole('region', { name: 'ご返金' });
      const rows = region.getByTestId('order-refund-row');

      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('2026/10/12');
      await expect(rows.nth(0)).toContainText(formatYen(12_000));
      await expect(rows.nth(0)).toContainText('完了');
      await expect(rows.nth(1)).toContainText('2026/10/13');
      await expect(rows.nth(1)).toContainText(formatYen(8_000));
      await expect(rows.nth(1)).toContainText('手続き中');
      const total = region.getByTestId('order-refund-total');
      await expect(total).toContainText('ご返金の合計');
      await expect(total).toContainText(formatYen(20_000));

      // 「支払金額」の欄（見出しが支払金額の区切り）の中の、支払金額の行より下に出る
      const paymentSection = page.locator('section').filter({ has: page.getByRole('heading', { name: '支払金額', level: 2 }) });
      await expect(paymentSection.getByRole('region', { name: 'ご返金' })).toHaveCount(1);
      const paidRow = await page.locator('dt').filter({ hasText: /^\s*支払金額\s*$/ }).first().boundingBox();
      const refundBox = await region.boundingBox();
      expect(paidRow, '支払金額の行の位置').not.toBeNull();
      expect(refundBox, 'ご返金の欄の位置').not.toBeNull();
      expect(refundBox!.y).toBeGreaterThan(paidRow!.y);
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e2/account-order-refunds-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('返金した数が1以上の商品だけに「返金済み n点」の印が出る', async ({ page }) => {
      // FREQ-460-AC-02
      await openDetail(page, detailOf({ refunds: [COMPLETED], refundedQuantities: [2, 0] }));
      const marks = page.getByTestId('order-item-refunded');

      await expect(marks).toHaveCount(1);
      await expect(marks).toHaveText('返金済み 2点');
      // 印はシルクブラウスの行の中にあり、プリーツスカートの行には無い（印から見て、商品名を含む一番近い外側の要素を取る）
      const row = marks.locator(`xpath=ancestor::*[contains(., "${BLOUSE}")][1]`);
      await expect(row).toContainText(BLOUSE);
      await expect(row).not.toContainText(SKIRT);
    });

    test('コンビニ払いの手続き中の返金だけに、返金先の口座の入力をお願いする文が期限つきで出る。期限が無い返金には出ない', async ({ page }) => {
      // FREQ-460-AC-03
      await openDetail(page, detailOf({ refunds: [COMPLETED, KONBINI], refundTotal: formatYen(20_000) }));
      const rows = page.getByTestId('order-refund-row');

      await expect(rows.nth(1)).toContainText(`${KONBINI_SENTENCE}（11月25日まで）`);
      await expect(rows.nth(0)).not.toContainText(KONBINI_SENTENCE);
      await expect(page.getByText(KONBINI_SENTENCE)).toHaveCount(1);
    });

    test('返金が1件だけの注文には合計の行を出さない', async ({ page }) => {
      // FREQ-460-AC-01
      await openDetail(page, detailOf({ refunds: [COMPLETED], refundedQuantities: [1, 0] }));

      await expect(page.getByTestId('order-refund-row')).toHaveCount(1);
      await expect(page.getByTestId('order-refund-total')).toHaveCount(0);
    });

    test('返金が無い注文には「ご返金」の欄も返金済みの印も出さない', async ({ page }) => {
      // FREQ-460-AC-01
      await openDetail(page, detailOf());

      await expect(page.getByRole('region', { name: 'ご返金' })).toHaveCount(0);
      await expect(page.getByTestId('order-refund-row')).toHaveCount(0);
      await expect(page.getByTestId('order-item-refunded')).toHaveCount(0);
    });

    test('全部の商品を返金して手続き中の注文は「キャンセルの手続き中」と出て、進み具合の段は出ない', async ({ page }) => {
      // FREQ-460-AC-05
      await openDetail(
        page,
        detailOf({
          refunds: [PROCESSING],
          fullyRefunded: true,
          progress: { key: 'cancel_pending', label: CANCEL_PENDING, partiallyShipped: false, steps: null },
        }),
      );

      await expect(page.getByTestId('order-progress-status')).toContainText(CANCEL_PENDING);
      await expect(page.getByRole('list', { name: '配送ステータス' })).toHaveCount(0);
      await expect(page.getByTestId('order-item-refunded')).toHaveCount(2);
    });

    test('返金の行が3件並んでも、横方向のページスクロールが発生しない', async ({ page }) => {
      await openDetail(
        page,
        detailOf({
          refunds: [COMPLETED, KONBINI, { ...PROCESSING, id: 'refund-4' }],
          refundTotal: formatYen(28_000),
          refundedQuantities: [3, 1],
        }),
      );
      await expect(page.getByTestId('order-refund-row')).toHaveCount(3);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('失敗・エラーの返金は、額も期限もお客様の窓口にも画面にも出ず、手続き中と完了の返金だけが古い順に出る（本物の窓口と手元の DB）', async ({ page }) => {
      // FREQ-460-AC-01, FREQ-460-AC-02, FREQ-460-AC-03, FREQ-460-AC-04（Review Focus 2）
      test.setTimeout(180_000);
      const { actorId, orderId, shirt } = await memberWithOrder(page, `refunds-${viewport.name}`, 12);
      await withLocalDb(async (db) => {
        // 額は返金ごとに変えて、出てはいけない額を見分けられるようにする（シャツ1枚 = PRICE）
        const begin = (quantity: number) =>
          beginRefund(db, orderId, { actorId, lines: [{ orderItemId: shirt, quantity, beforeShipment: true }], amount: PRICE * quantity });
        // 1) 完了: シャツ1枚
        await recordRefundResult(db, (await begin(1)).refundId);
        // 2) 手続き中: シャツ2枚。コンビニ払いで、返金先の口座の入力の期限つき
        await recordRefundResult(db, (await begin(2)).refundId, {
          stripeStatus: 'requires_action',
          paymentMethodType: 'konbini',
          customerActionExpiresAt: KONBINI_DEADLINE,
        });
        // 3) 失敗: シャツ4枚。Stripe の返事で失敗（在庫は動かさず、要対応が出る。お客様には出さない）
        await recordRefundResult(db, (await begin(4)).refundId, { stripeStatus: 'failed', failureReason: 'declined' });
        // 4) エラー: シャツ5枚。Stripe に断られた
        await markRefundError(db, (await begin(5)).refundId, 'stripe_rejected');
      });

      // 本物の窓口: 手続き中と完了の返金だけ。返金の数は完了と手続き中の分（3枚）だけ。行は名指しした5項目だけ
      const response = await page.request.get(`/api/orders/${orderId}`);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        refunds: Array<Record<string, unknown>>;
        refundTotal: string | null;
        items: Array<{ refundedQuantity: number }>;
      };
      expect(body.refunds.map((refund) => [refund.status, refund.amount, refund.customerActionDeadline])).toEqual([
        ['completed', formatYen(PRICE), null],
        ['processing', formatYen(PRICE * 2), '11月25日'],
      ]);
      expect(Object.keys(body.refunds[0]).sort()).toEqual(['amount', 'customerActionDeadline', 'date', 'id', 'status']);
      expect(body.refunds[0].date).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
      expect(body.refundTotal).toBe(formatYen(PRICE * 3));
      expect(body.items.map((item) => item.refundedQuantity)).toEqual([3]);
      const raw = JSON.stringify(body);
      for (const hidden of [formatYen(PRICE * 4), formatYen(PRICE * 5), 'declined', 'stripe_rejected']) {
        expect(raw, `答えに ${hidden} が出ないこと`).not.toContain(hidden);
      }

      // 画面: 2行と合計、期限の文、返金済みの印。失敗・エラーの額は出ない
      await page.goto(`/account/orders/${orderId}`);
      await expect(page.getByText(orderNumberOf(orderId))).toBeVisible();
      const region = page.getByRole('region', { name: 'ご返金' });
      const rows = region.getByTestId('order-refund-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('完了');
      await expect(rows.nth(0)).toContainText(formatYen(PRICE));
      await expect(rows.nth(1)).toContainText('手続き中');
      await expect(rows.nth(1)).toContainText(`${KONBINI_SENTENCE}（11月25日まで）`);
      await expect(region.getByTestId('order-refund-total')).toContainText(formatYen(PRICE * 3));
      await expect(page.getByTestId('order-item-refunded')).toHaveText('返金済み 3点');
      const text = await page.locator('body').innerText();
      expect(text).not.toContain(formatYen(PRICE * 4));
      expect(text).not.toContain(formatYen(PRICE * 5));
    });

    test('全部の商品を発送前に返金して保留の返金がある注文は、窓口の答えにも画面にも一覧にも「キャンセルの手続き中」と出て、進み具合の段は出ない（本物の窓口と手元の DB）', async ({ page }) => {
      // FREQ-460-AC-05
      test.setTimeout(180_000);
      const { actorId, orderId, shirt } = await memberWithOrder(page, `cancel-pending-${viewport.name}`, 2);
      await withLocalDb(async (db) => {
        const began = await beginRefund(db, orderId, {
          actorId,
          lines: [{ orderItemId: shirt, quantity: 2, beforeShipment: true }],
          amount: PRICE * 2,
        });
        // 保留（お金はまだ戻っていないので、注文は支払い済みのまま）
        await recordRefundResult(db, began.refundId, { stripeStatus: 'pending', pendingReason: 'processing' });
      });

      const detail = (await (await page.request.get(`/api/orders/${orderId}`)).json()) as {
        progress: { key: string; label: string; steps: unknown };
      };
      expect(detail.progress).toMatchObject({ key: 'cancel_pending', label: CANCEL_PENDING, steps: null });
      const list = (await (await page.request.get('/api/orders')).json()) as { data: Array<{ orderNumber: string; status: string }> };
      expect(list.data.find((order) => order.orderNumber === orderNumberOf(orderId))?.status).toBe(CANCEL_PENDING);

      await page.goto(`/account/orders/${orderId}`);
      await expect(page.getByText(orderNumberOf(orderId))).toBeVisible();
      await expect(page.getByTestId('order-progress-status')).toContainText(CANCEL_PENDING);
      await expect(page.getByRole('list', { name: '配送ステータス' })).toHaveCount(0);
      await expect(page.getByTestId('order-item-refunded')).toHaveText('返金済み 2点');
    });
  });
}
