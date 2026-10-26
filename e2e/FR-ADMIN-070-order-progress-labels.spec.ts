/**
 * FR-ADMIN-070 注文の進み具合の言葉
 * 対応 FREQ: FREQ-441（AC-01・AC-03）
 *
 * 管理画面の注文の詳細（/admin/orders/[id]）の進み具合とお客様の購入履歴の一覧に出る言葉を、窓口を差し替えて確かめる。
 * G-4 で旧い注文の一覧は撤去した。旧い一覧の確かめのうち、
 * - 進み具合の言葉と一部発送済みの印 → 詳細の注文情報の「進み具合」へ付け替え（下の1つめ）。商品の欄の数の書き方は品物の欄 → FR-ADMIN-110 ②
 * - 絞り込みの名前が決めた8つ（FREQ-441-AC-02）→ ステータスの12の絞り込み → FR-ADMIN-110 ① と FR-ADMIN-121 ④（ケースは削除）
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
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

const ORDERS = {
  unpaid: adminOrder({
    // 取消のボタンを出さない
    id: 'a7000000-0000-4000-8000-000000000001', customerName: '未決済 太郎', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid',
    canShip: false,
  }),
  production: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000002', customerName: '受注 次郎', status: '受注生産中', progressKey: 'in_production',
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000001', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, inProduction: 2, readyUnshipped: 0 })],
  }),
  ready: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000003', customerName: '準備 三郎',
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000002', name: 'シルクブラウス', quantity: 1, readyUnshipped: 1 })],
  }),
  partial: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000004', customerName: '一部 四郎', status: '受注生産中', progressKey: 'in_production', partiallyShipped: true,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000003', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, shipped: 1, inProduction: 1, readyUnshipped: 0 })],
  }),
  transit: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000005', customerName: '配送 五郎', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000004', name: 'リネンシャツ', quantity: 1, shipped: 1, readyUnshipped: 0 })],
  }),
  cancelled: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000006', customerName: '取消 六郎', status: 'キャンセル', orderStatus: 'cancelled', progressKey: 'cancelled', canShip: false,
  }),
  // グループ E-4: 取り消していない発送の全部が配達済みの注文は「配達済み」（DB の状態は shipped のまま）
  delivered: adminOrder({
    id: 'a7000000-0000-4000-8000-000000000007', customerName: '配達 七郎', status: '配達済み', orderStatus: 'shipped', progressKey: 'delivered', canShip: false,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000005', name: 'リネンシャツ', quantity: 1, shipped: 1, readyUnshipped: 0 })],
  }),
};

/** その印の文字が何行に並んでいるか（行ごとの上の位置の種類を数える。狭い画面幅で「発送準備/中」と割れると2になる） */
async function textLineCount(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
  });
}

async function openCustomerOrders(page: Page): Promise<void> {
  await mockOtpAuthentication(page);
  // ACCOUNT は配送先も取得する。実 API の 401 → refresh で認証モックが失効しないよう固定する
  await page.route('**/api/profile/addresses', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ addresses: [] }) }));
  await page.route('**/api/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'user@example.com', fullName: '山田 花子', kanaName: 'ヤマダ ハナコ', phone: '090-1111-2222', address: {} }),
    }));
  const customerOrder = (id: string, orderNumber: string, status: string) => ({
    id, orderNumber, orderDate: '2026/10/05', status, totalAmount: '¥28,800', itemCount: 1, items: [], detailHref: `/account/orders/${id}`,
  });
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          customerOrder('order-1', 'LFH-261005-00001', '受注生産中'),
          customerOrder('order-2', 'LFH-261005-00002', '発送準備中'),
          customerOrder('order-3', 'LFH-261005-00003', '配送中'),
          customerOrder('order-4', 'LFH-261005-00004', '未決済'),
          customerOrder('order-5', 'LFH-261005-00005', '配達済み'),
        ],
      }),
    }));
  await page.goto('/account?tab=orders');
  await expect(page.getByText('LFH-261005-00001')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-070 order progress labels (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('管理画面の注文の詳細の進み具合に、未決済・受注生産中・発送準備中・配送中・配達済み・キャンセルの言葉と、一部発送済みの印が出る', async ({ page }) => {
      // FREQ-441-AC-01（G-4: 旧い一覧の確かめを、詳細の注文情報の「進み具合」へ付け替えた）
      const byId = new Map(Object.values(ORDERS).map((order) => [order.id, order]));
      await mockAdminSession(page);
      await mockOrderDetail(page, (orderId) => {
        const order = byId.get(orderId);
        if (!order) throw new Error(`試験の注文が無い: ${orderId}`);
        return adminOrderDetail(order);
      });

      const words: Array<[keyof typeof ORDERS, string]> = [
        ['unpaid', '未決済'],
        ['production', '受注生産中'],
        ['ready', '発送準備中'],
        ['partial', '受注生産中'],
        ['transit', '配送中'],
        ['delivered', '配達済み'],
        ['cancelled', 'キャンセル'],
      ];
      for (const [key, word] of words) {
        await openOrderDetail(page, ORDERS[key].id);
        const info = detailSection(page, '注文情報');
        const badge = info.getByText(word, { exact: true });
        await expect(badge, `${key} の「${word}」`).toBeVisible();
        // 状態の印は1行で出る（狭い画面幅で、5文字の言葉が「発送準備/中」のように途中で割れない。FR-ACCOUNT-019 の「1行で表示」と同じ考え）
        expect(await textLineCount(badge), `${key} の「${word}」の印の行数`).toBe(1);
        // 「一部発送済み」の印は、一部だけ送った注文にだけ付く
        await expect(info.getByText('一部発送済み', { exact: true }), `${key} の一部発送済みの印`).toHaveCount(key === 'partial' ? 1 : 0);
        // G-1: 手動の仕上がりの記録は終了した。どの注文の詳細にも「仕上がりを記録する」は出ない（受注生産の品は入荷の自動の割当で発送準備中になる）
        await expect(page.getByRole('button', { name: '仕上がりを記録する' }), `${key} の仕上がりの入口`).toHaveCount(0);
      }
    });

    test('お客様の購入履歴の一覧にも、同じ言葉が出る', async ({ page }) => {
      // FREQ-441-AC-03
      await openCustomerOrders(page);

      const expected: Array<[string, string]> = [
        ['LFH-261005-00001', '受注生産中'],
        ['LFH-261005-00002', '発送準備中'],
        ['LFH-261005-00003', '配送中'],
        ['LFH-261005-00004', '未決済'],
        ['LFH-261005-00005', '配達済み'],
      ];
      for (const [orderNumber, word] of expected) {
        const row = page.getByRole('link', { name: new RegExp(orderNumber) });
        await expect(row.getByText(word, { exact: true })).toBeVisible();
      }
    });
  });
}
