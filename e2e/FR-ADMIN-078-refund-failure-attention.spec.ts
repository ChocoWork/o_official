/**
 * FR-ADMIN-078 要対応の「返金の失敗」
 * 対応 FREQ: FREQ-457（AC-01・AC-02）
 *
 * 要対応の欄を、窓口を差し替えて確かめる（実装計画 P16。FR-ADMIN-060 と同じやり方）。窓口の答えは共通の約束（C-2）の形。
 * AC-03 の「店へのメールに『Stripe ダッシュボードで返金』の案内が無い」は、本物のメールで確かめる FR-CHECKOUT-051 が持つ。
 */
import { expect, test, type Page } from '@playwright/test';
import type { AttentionException, AttentionReview } from '@/lib/orders/order-payment-types';
import { adminOrder, fulfillJson, mockOrderList, openOrderTab, orderNumberOf, viewports } from './order-fulfillment-test-utils';
import {
  REFUND_TEXT,
  formatYen,
  materialLineOf,
  mockAdminSessionAs,
  mockRefundRoutes,
  newRefundRouteState,
  refundMaterialsOf,
} from './refund-test-utils';

const ORDER_ID = 'a8b2c3d4-1111-2222-8333-444455556666';
const ORDER_NUMBER = orderNumberOf(ORDER_ID);
const RESOLVE_SENTENCE = '返金やお客様への連絡を済ませてから、解決済みにしてください。';

/** 開いている「返金の失敗」。注文には返せる額が残っているので、もう一度返金できる */
const EXCEPTION = {
  id: 'f8b2c3d4-1111-2222-8333-444455556666',
  reason: 'refund_failed',
  reasonLabel: '返金の失敗',
  detail: 'expired',
  orderId: ORDER_ID,
  orderNumber: ORDER_NUMBER,
  orderStatus: 'paid',
  // Stripe の返金の番号の形（本計画 P29。英数字だけ）にする。要対応の窓口はこの形で返金の記録を探す
  paymentRef: 're_e2eFailed1',
  firstDetectedAt: '2026-10-12T01:00:00.000Z',
  lastDetectedAt: '2026-10-12T01:00:00.000Z',
  detectionCount: 1,
  canCancelOrder: false,
  canRetryRefund: true,
  // 行の細目の材料（Task 10）。失敗の理由の言葉は、窓口が Stripe の失敗の理由の記号（detail の expired）から出した物
  refundFailure: {
    amount: 12_800,
    failureReasonLabel: '口座の入力の期限が過ぎました',
    shortages: [{ name: 'シルクブラウス（ホワイト / M）', quantity: 1 }],
  },
} satisfies AttentionException;

/** 失敗で確保し直せなかった商品がある注文には、要確認の印が付く */
const REVIEW = {
  orderId: ORDER_ID,
  orderNumber: ORDER_NUMBER,
  orderStatus: 'paid',
  reviewReason: 'stock_not_reserved',
  reviewReasonLabel: '在庫を確保できなかった注文',
  reviewMarkedAt: '2026-10-12T01:00:00.000Z',
} satisfies AttentionReview;

type AttentionState = {
  exceptions: AttentionException[];
  reviews: AttentionReview[];
  resolveBodies: unknown[];
  reads: number;
};

async function mockApis(page: Page, role: 'admin' | 'supporter', exceptions: AttentionException[] = [EXCEPTION]) {
  const attention: AttentionState = { exceptions, reviews: [REVIEW], resolveBodies: [], reads: 0 };
  const refund = newRefundRouteState(
    refundMaterialsOf({
      orderId: ORDER_ID,
      shippingAmount: 800,
      lines: [materialLineOf({ orderItemId: 'c8b2c3d4-0000-4000-8000-000000000001', itemPrice: 12_000 })],
    }),
  );
  await mockAdminSessionAs(page, role);
  await mockOrderList(page, () => [
    adminOrder({ id: ORDER_ID, canShip: false, canRefund: true, paymentStatusKey: 'paid', refundedAmountLabel: '-', cancelKind: null }),
  ]);
  await mockRefundRoutes(page, ORDER_ID, refund);
  // 後から登録した窓口が先に効く。管理画面が裏で読む要対応の空の答えを、この試験の状態で上書きする
  await page.route('**/api/admin/order-attention', (route) => {
    attention.reads += 1;
    return fulfillJson(route, {
      data: {
        exceptions: attention.exceptions,
        reviews: attention.reviews,
        counts: { exceptions: attention.exceptions.length, reviews: attention.reviews.length },
      },
    });
  });
  await page.route(`**/api/admin/payment-exceptions/${EXCEPTION.id}/resolve`, async (route) => {
    attention.resolveBodies.push(route.request().postDataJSON());
    attention.exceptions = [];
    await fulfillJson(route, { success: true, orderCancelled: false });
  });
  return { attention, refund };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-078 refund failure attention (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('要対応に「返金の失敗」が出て、確保し直せなかった注文には要確認が付く', async ({ page }) => {
      // FREQ-457-AC-01
      await mockApis(page, 'admin');
      await openOrderTab(page);

      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 1件' })).toBeVisible();
      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toBeVisible();
      await expect(page.getByText(EXCEPTION.paymentRef, { exact: false })).toBeVisible();
      await expect(page.getByText(`在庫を確保できなかった注文（${ORDER_NUMBER}）`)).toBeVisible();
      // 行の細目: 返金の額・失敗の理由・確保し直せなかった商品と数
      const inbox = page.getByRole('region', { name: /要対応/ });
      await expect(inbox.getByText(`返金 ${formatYen(12_800)}`)).toBeVisible();
      await expect(inbox.getByText('失敗の理由: 口座の入力の期限が過ぎました')).toBeVisible();
      await expect(inbox.getByText('確保し直せなかった商品: シルクブラウス（ホワイト / M） × 1')).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度返金する', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '解決済みにする', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '確認済みにする', exact: true })).toBeVisible();
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e2/attention-refund-failed-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('「もう一度返金する」を押すと、その注文の返金の画面が開き、返金を受け付けると要対応を読み直す', async ({ page }) => {
      // FREQ-457-AC-02
      const { attention, refund } = await mockApis(page, 'admin');
      await openOrderTab(page);
      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toBeVisible();
      const readsBefore = attention.reads;

      await page.getByRole('button', { name: 'もう一度返金する', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `返金（注文 ${ORDER_NUMBER}）`, exact: true });
      await expect(dialog.getByRole('region', { name: '発送前の商品', exact: true })).toBeVisible();
      expect(refund.materialsReads).toBe(1);

      // 1つも発送していない注文の全部を選ぶと、送料と額が全部に固定される
      await dialog.getByRole('button', { name: 'すべて選ぶ', exact: true }).click();
      await dialog.getByRole('button', { name: `${formatYen(12_800)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(refund.refundPosts).toHaveLength(1);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticePending })).toBeVisible();
      await expect.poll(() => attention.reads).toBeGreaterThan(readsBefore);
    });

    test('サポートの人には「もう一度返金する」が出ない。「解決済みにする」は出る', async ({ page }) => {
      // FREQ-457-AC-02
      await mockApis(page, 'supporter');
      await openOrderTab(page);
      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度返金する', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '解決済みにする', exact: true })).toBeVisible();
    });

    test('返せる額が残っていない注文の「返金の失敗」には「もう一度返金する」が出ない', async ({ page }) => {
      // FREQ-457-AC-02
      await mockApis(page, 'admin', [{ ...EXCEPTION, canRetryRefund: false }]);
      await openOrderTab(page);
      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'もう一度返金する', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '解決済みにする', exact: true })).toBeVisible();
    });

    test('「解決済みにする」の画面は、返金とお客様への連絡を済ませる案内を出し、メモを付けて送ると欄から消える', async ({ page }) => {
      // FREQ-457-AC-02
      const { attention } = await mockApis(page, 'admin');
      await openOrderTab(page);

      await page.getByRole('button', { name: '解決済みにする', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '解決済みにする', exact: true });
      await expect(dialog.getByText(RESOLVE_SENTENCE)).toBeVisible();
      // 返金は管理画面から行うので、Stripe ダッシュボードへは誘導しない
      await expect(dialog.getByText('Stripe ダッシュボード')).toHaveCount(0);
      await dialog.getByRole('textbox', { name: /メモ/ }).fill('銀行振込で返金した');
      await dialog.getByRole('button', { name: '解決する', exact: true }).click();

      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '要対応 0件・要確認 1件' })).toBeVisible();
      expect(attention.resolveBodies).toEqual([{ note: '銀行振込で返金した' }]);
    });

    test('「返金の失敗」の行が並んだ要対応の欄でも、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockApis(page, 'admin');
      await openOrderTab(page);
      await expect(page.getByText(`返金の失敗（${ORDER_NUMBER}）`)).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
