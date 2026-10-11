/**
 * FR-ADMIN-076 注文の一覧の「支払い」の列
 * 対応 FREQ: FREQ-458（AC-01〜AC-05）
 *
 * 管理画面の注文の一覧を、窓口を差し替えて確かめる（実装計画 P16）。窓口の答えは共通の約束（C-2）の形。
 * 支払いの言葉6つが、進み具合の言葉・小さな印・操作のボタンの字と1つも重ならないこと（Task 12 の T12-3）は、
 * 行の中の言葉を exact: true で探す今の E2E（FR-ADMIN-061・063・070）が1つに決まったままである前提なので、ここで守る。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  adminOrder,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  viewports,
} from './order-fulfillment-test-utils';
import {
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openPaidCancelDialog,
  openRefundDialog,
  refundMaterialsOf,
} from './refund-test-utils';

const PAYMENT_WORDS = ['未入金', '支払い済み', '一部返金', '返金済み', '支払いの失敗', '支払いなし'] as const;

/** 8つの行。支払いの言葉の6つが全部出る。DB の状態が paid の行は4つ（CSV の対象） */
const ROWS = [
  adminOrder({
    id: 'order-unpaid', customerName: '未入金 太郎', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid',
    canShip: false, canCancel: true, cancelKind: 'unpaid', paymentStatusKey: 'unpaid', refundedAmountLabel: '-',
  }),
  adminOrder({
    id: 'order-failed', customerName: '失敗 次郎', status: '決済失敗', orderStatus: 'failed', progressKey: 'failed',
    canShip: false, paymentStatusKey: 'failed', refundedAmountLabel: '-',
  }),
  adminOrder({
    id: 'order-abandoned', customerName: '放棄 三郎', status: '放棄', orderStatus: 'abandoned', progressKey: 'abandoned',
    canShip: false, paymentStatusKey: 'none', refundedAmountLabel: '-',
  }),
  adminOrder({
    id: 'order-paid', customerName: '入金 四郎', canShip: false, canRefund: true, canCancel: true, cancelKind: 'paid',
    paymentStatusKey: 'paid', refundedAmountLabel: '-',
  }),
  adminOrder({
    id: 'order-partial', customerName: '一部 五郎', canShip: false, canRefund: true, canCancel: false, cancelKind: null,
    paymentStatusKey: 'partially_refunded', refundedAmountLabel: formatYen(5_000),
  }),
  adminOrder({
    id: 'order-refunded', customerName: '済み 六郎', status: 'キャンセル', orderStatus: 'cancelled', progressKey: 'cancelled',
    canShip: false, canRefund: false, canCancel: false, cancelKind: null, paymentStatusKey: 'refunded',
    refundedAmountLabel: formatYen(28_800),
  }),
  adminOrder({
    id: 'order-cancel-pending', customerName: '手続き 七郎', status: 'キャンセルの手続き中', progressKey: 'cancel_pending',
    canShip: false, canRefund: false, canCancel: false, cancelKind: null, paymentStatusKey: 'paid', refundPending: true,
    refundedAmountLabel: '-',
  }),
  adminOrder({
    id: 'order-refund-failed', customerName: '失敗の印 八郎', canShip: false, canRefund: true, canCancel: false,
    cancelKind: null, paymentStatusKey: 'paid', refundFailed: true, refundedAmountLabel: '-',
  }),
];

const rowOf = (page: Page, id: string) => page.getByRole('row', { name: new RegExp(id) });

/** CSV の1行を、引用符つきの値に分ける（値の中の "" は ". カンマは値の一部） */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function openList(page: Page) {
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => ROWS);
  await openOrderTab(page);
  await expect(rowOf(page, 'order-paid')).toBeVisible();
  return list;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-076 order list payment column (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('列の見出しは「支払い」と「進み具合」になり、「決済状況」は無い', async ({ page }) => {
      // FREQ-458-AC-02
      await openList(page);

      expect(await page.getByRole('columnheader').allTextContents()).toEqual([
        '注文ID', '顧客名', '注文日', '購入商品', '商品数', '合計金額', '支払い', '進み具合', '操作',
      ]);
      await expect(page.getByRole('columnheader', { name: '決済状況' })).toHaveCount(0);
    });

    test('「支払い」の列に6つの言葉のどれかが1つだけ出て、進み具合の言葉と重ならない', async ({ page }) => {
      // FREQ-458-AC-01
      await openList(page);
      const expectedPayment = {
        'order-unpaid': '未入金',
        'order-failed': '支払いの失敗',
        'order-abandoned': '支払いなし',
        'order-paid': '支払い済み',
        'order-partial': '一部返金',
        'order-refunded': '返金済み',
        'order-cancel-pending': '支払い済み',
        'order-refund-failed': '支払い済み',
      } as const;
      for (const [id, word] of Object.entries(expectedPayment)) {
        for (const candidate of PAYMENT_WORDS) {
          await expect(rowOf(page, id).getByText(candidate, { exact: true }), `${id} の「${candidate}」`).toHaveCount(
            candidate === word ? 1 : 0,
          );
        }
      }

      // 進み具合の言葉は、支払いの言葉とは別に、1つだけ出る
      const expectedProgress = {
        'order-unpaid': '未決済',
        'order-failed': '決済失敗',
        'order-abandoned': '放棄',
        'order-paid': '発送準備中',
        'order-refunded': 'キャンセル',
        'order-cancel-pending': 'キャンセルの手続き中',
      } as const;
      for (const [id, word] of Object.entries(expectedProgress)) {
        await expect(rowOf(page, id).getByText(word, { exact: true }), `${id} の「${word}」`).toHaveCount(1);
      }
      await page.screenshot({ path: `test-results/group-e2/order-list-payment-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('「返金の手続き中」と「返金の失敗」の小さな印は、その注文の行にだけ付く', async ({ page }) => {
      // FREQ-458-AC-03
      await openList(page);

      for (const id of ['order-unpaid', 'order-failed', 'order-abandoned', 'order-paid', 'order-partial', 'order-refunded']) {
        await expect(rowOf(page, id).getByText('返金の手続き中', { exact: true })).toHaveCount(0);
        await expect(rowOf(page, id).getByText('返金の失敗', { exact: true })).toHaveCount(0);
      }
      await expect(rowOf(page, 'order-cancel-pending').getByText('返金の手続き中', { exact: true })).toBeVisible();
      await expect(rowOf(page, 'order-cancel-pending').getByText('返金の失敗', { exact: true })).toHaveCount(0);
      await expect(rowOf(page, 'order-refund-failed').getByText('返金の失敗', { exact: true })).toBeVisible();
      await expect(rowOf(page, 'order-refund-failed').getByText('返金の手続き中', { exact: true })).toHaveCount(0);
      // 返金の失敗の印が付いた行も、支払いの言葉は「支払い済み」のまま
      await expect(rowOf(page, 'order-refund-failed').getByText('支払い済み', { exact: true })).toHaveCount(1);
    });

    test('返金とキャンセルのボタンは、窓口の判定のとおりに出る。返金は返金の画面、支払い済みのキャンセルは新しい画面、未入金は今の取消の画面が開く', async ({ page }) => {
      // FREQ-458-AC-04
      const state = newRefundRouteState(
        refundMaterialsOf({
          orderId: 'order-paid',
          shippingAmount: 800,
          lines: [materialLineOf({ orderItemId: 'c5b2c3d4-0000-4000-8000-000000000001', itemPrice: 12_000 })],
        }),
      );
      await mockAdminSession(page);
      await mockOrderList(page, () => ROWS);
      await mockRefundRoutes(page, 'order-paid', state);
      await openOrderTab(page);
      await expect(rowOf(page, 'order-paid')).toBeVisible();

      const expected: Record<string, { refund: boolean; cancel: boolean }> = {
        'order-unpaid': { refund: false, cancel: true },
        'order-failed': { refund: false, cancel: false },
        'order-abandoned': { refund: false, cancel: false },
        'order-paid': { refund: true, cancel: true },
        'order-partial': { refund: true, cancel: false },
        'order-refunded': { refund: false, cancel: false },
        'order-cancel-pending': { refund: false, cancel: false },
        'order-refund-failed': { refund: true, cancel: false },
      };
      for (const [id, buttons] of Object.entries(expected)) {
        await expect(rowOf(page, id).getByRole('button', { name: '返金', exact: true }), `${id} の返金`).toHaveCount(buttons.refund ? 1 : 0);
        await expect(rowOf(page, id).getByRole('button', { name: 'キャンセル', exact: true }), `${id} のキャンセル`).toHaveCount(
          buttons.cancel ? 1 : 0,
        );
      }

      const refundDialog = await openRefundDialog(page, 'order-paid');
      await expect(refundDialog.getByRole('region', { name: '発送前の商品', exact: true })).toBeVisible();
      await refundDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const cancelDialog = await openPaidCancelDialog(page, 'order-paid');
      await expect(cancelDialog.getByText(`返金する額: ${formatYen(12_800)}（全額）`)).toBeVisible();
      await cancelDialog.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await rowOf(page, 'order-unpaid').getByRole('button', { name: 'キャンセル', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '注文を取り消す', exact: true })).toBeVisible();
    });

    test('CSV の見出しは10列で、発送待ちの注文の行に、進み具合・支払い・返金額を書く', async ({ page }) => {
      // FREQ-458-AC-05
      await openList(page);

      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: '表示中の注文をCSV出力' }).click();
      const stream = await (await downloading).createReadStream();
      if (!stream) throw new Error('CSV の中身を読めなかった');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const lines = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').split('\n');

      expect(lines[0]).toBe('注文ID,顧客名,顧客メール,注文日,購入商品,商品数,合計金額,進み具合,支払い,返金額');
      // 書き出すのは DB の状態が決済完了（paid）の注文だけ。進み具合・支払い・返金額は、一覧に出ている言葉と文字のまま
      expect(lines.slice(1).map((line) => parseCsvLine(line)).map((values) => [values[0], values[7], values[8], values[9]])).toEqual([
        ['order-paid', '発送準備中', '支払い済み', '-'],
        ['order-partial', '発送準備中', '一部返金', formatYen(5_000)],
        ['order-cancel-pending', 'キャンセルの手続き中', '支払い済み', '-'],
        ['order-refund-failed', '発送準備中', '支払い済み', '-'],
      ]);
    });

    test('支払いの列を足しても、横方向のページスクロールが発生しない', async ({ page }) => {
      await openList(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);

      // 実際の注文（番号が36字の UUID）の表は 1280px でも枠に入りきらず、中だけ横に動く。「操作」の列は右に貼り付いているので、
      // 表を横に動かさなくてもボタンが画面の中に見える
      if (viewport.width >= 1280) {
        await expect(rowOf(page, 'order-unpaid').getByRole('button', { name: 'キャンセル', exact: true })).toBeInViewport();
      }
    });
  });
}
