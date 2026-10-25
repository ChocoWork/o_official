import { test, expect, Page } from '@playwright/test';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import {
  adminOrder,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  viewports,
} from './order-fulfillment-test-utils';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
// 2026-10-10（FREQ-439）: 発送は商品と数を選ぶ1回ごとの記録になった。発送の画面は、開く時に
// GET /api/admin/orders/[id]/fulfillments で材料を読み、POST で発送する。一覧の言葉は、送る前は「発送準備中」、全部を送ると「配送中」。
// FREQ-267-AC-01/02/03 は FREQ-439-AC-01/03/04 に引き継いだ（requirements.md の注記）。
// G-1: 旧の発送の画面（「発送済みにする」）は撤去した。G-3: 発送ボタンの出る条件と、配送業者・追跡番号を入れて発送する経路は、
// 発送票（FR-ADMIN-116 の ①②④）へ移した（旧の2つのケースは削除。配送先要確認の表示だけがここに残る）。
// 入口が出ないことと固定の停止文・HTTP 410 の確認は FR-ADMIN-123 が持つ。

const LINE_ID = 'c1000000-0000-4000-8000-000000000001';

const PAID = adminOrder({ id: 'order-paid', items: [orderLine({ id: LINE_ID })] });
const OTHERS = [
  adminOrder({
    id: 'order-missing-shipping',
    customerName: '配送先 未登録',
    customerEmail: 'missing@example.com',
    totalAmount: '¥18,000',
    canShip: false,
    missingShippingFields: ['address'],
  }),
  adminOrder({
    id: 'order-pending',
    customerName: '佐藤 太郎',
    customerEmail: 'taro@example.com',
    totalAmount: '¥32,000',
    status: '未決済',
    orderStatus: 'pending',
    progressKey: 'unpaid',
    canShip: false,
  }),
  adminOrder({
    id: 'order-shipped',
    customerName: '鈴木 次郎',
    customerEmail: 'jiro@example.com',
    totalAmount: '¥58,000',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canShip: false,
    items: [orderLine({ id: 'c1000000-0000-4000-8000-000000000002', shipped: 1, readyUnshipped: 0 })],
  }),
];

async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminSession(page);
  await mockOrderList(page, () => [PAID, ...OTHERS]);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('配送先が足りない注文に「配送先要確認」が出て、旧の発送の入口はどの注文にも出ず、固定の停止文が1回出る', async ({ page }) => {
      // FREQ-365-AC-09（G-1: 配送先の確認の表示は残る。発送ボタンは窓口が canShip=true と答えても出さない）
      await openOrderTab(page);

      await expect(page.getByText('配送先要確認')).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      // G-3: 旧い停止文は、発送票へ誘導する案内（荷作り表から行います）に置き換わった
      await expect(page.getByText(SHIPMENT_SLIP_TEXT.orderSectionGuide, { exact: true })).toHaveCount(1);
      await expect(page.getByText(SHIPMENT_SLIP_TEXT.orderSectionGuide, { exact: true })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrderTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
