import { test, expect, Page } from '@playwright/test';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import {
  adminOrder,
  adminOrderDetail,
  detailSection,
  mockAdminSession,
  mockOrderDetail,
  openOrderDetail,
  orderLine,
  viewports,
} from './order-fulfillment-test-utils';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
// 2026-10-10（FREQ-439）: 発送は商品と数を選ぶ1回ごとの記録になった。発送の画面は、開く時に
// GET /api/admin/orders/[id]/fulfillments で材料を読み、POST で発送する。一覧の言葉は、送る前は「発送準備中」、全部を送ると「配送中」。
// FREQ-267-AC-01/02/03 は FREQ-439-AC-01/03/04 に引き継いだ（requirements.md の注記）。
// G-1: 旧の発送の画面（「発送済みにする」）は撤去した。G-3: 発送ボタンの出る条件と、配送業者・追跡番号を入れて発送する経路は、
// 発送票（FR-ADMIN-116 の ①②④）へ移した（旧の2つのケースは削除。配送先要確認の表示だけがここに残る）。
// G-4: 旧い注文の一覧は撤去した。配送先の足りない注文の表示は注文の詳細の「注文情報」（配送先の情報が足りません（…））へ移り、
// 旧い発送の入口と旧い停止文（発送は荷作り表から行います。）が出ないことを、どの注文の詳細でも確かめる。
// 入口が出ないことと旧い窓口の確認は FR-ADMIN-123 が持つ。

const PAID_ID = 'a5000000-0000-4000-8000-000000000001';
const MISSING_ID = 'a5000000-0000-4000-8000-000000000002';
const LINE_ID = 'c1000000-0000-4000-8000-000000000001';

/** 窓口が canShip=true と答えても、旧い発送の入口は詳細に出ない */
const PAID = adminOrder({ id: PAID_ID, items: [orderLine({ id: LINE_ID })] });
const MISSING_SHIPPING = adminOrder({
  id: MISSING_ID,
  customerName: '配送先 未登録',
  customerEmail: 'missing@example.com',
  totalAmount: '¥18,000',
  canShip: false,
  missingShippingFields: ['address'],
});

async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminSession(page);
  await mockOrderDetail(page, (orderId) => adminOrderDetail(orderId === MISSING_ID ? MISSING_SHIPPING : PAID));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('配送先が足りない注文の詳細の注文情報に「配送先の情報が足りません（…）」が出て、旧の発送の入口と旧い停止文は、どの注文の詳細にも出ない', async ({ page }) => {
      // FREQ-365-AC-09（G-1: 配送先の確認の表示は残る。発送ボタンは窓口が canShip=true と答えても出さない。G-4: 表示は詳細の注文情報へ）
      await openOrderDetail(page, MISSING_ID);
      await expect(detailSection(page, '注文情報').getByText('配送先の情報が足りません（address）', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      // G-3 で旧い停止文は発送票へ誘導する案内に置き換わり、G-4 で一覧とともに無くなった
      await expect(page.getByText(SHIPMENT_SLIP_TEXT.orderSectionGuide, { exact: true })).toHaveCount(0);

      // 発送できる注文（窓口が canShip=true と答える注文）でも、旧い入口も停止文も出ず、配送先の足りない表示も出ない
      await openOrderDetail(page, PAID_ID);
      await expect(page.getByText('配送先の情報が足りません', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(page.getByText(SHIPMENT_SLIP_TEXT.orderSectionGuide, { exact: true })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrderDetail(page, MISSING_ID);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
