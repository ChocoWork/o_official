/**
 * FR-ADMIN-070 注文の進み具合の言葉
 * 対応 FREQ: FREQ-441（AC-01〜AC-03）
 *
 * 管理画面の注文の一覧とお客様の購入履歴の一覧に出る言葉を、窓口を差し替えて確かめる。
 * 管理画面の絞り込みは DB の状態で働く（窓口は status=paid・status=shipped、2つ以上選んだ時は画面が orderStatus で絞る）。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { adminOrder, mockAdminSession, mockOrderList, openOrderTab, orderLine, viewports } from './order-fulfillment-test-utils';

const ORDERS = [
  adminOrder({
    // 取消のボタンを出さない（出すと、絞り込みの「キャンセル」と同じ名前のボタンが2つになる）
    id: 'order-unpaid', customerName: '未決済 太郎', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid',
    canShip: false,
  }),
  adminOrder({
    id: 'order-production', customerName: '受注 次郎', status: '受注生産中', progressKey: 'in_production', canRecordCompletion: true,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000001', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, inProduction: 2, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-ready', customerName: '準備 三郎',
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000002', name: 'シルクブラウス', quantity: 1, readyUnshipped: 1 })],
  }),
  adminOrder({
    id: 'order-partial', customerName: '一部 四郎', status: '受注生産中', progressKey: 'in_production', partiallyShipped: true,
    canRecordCompletion: true,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000003', name: 'ウールコート', fulfillmentType: 'backorder', quantity: 2, shipped: 1, inProduction: 1, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-transit', customerName: '配送 五郎', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
    items: [orderLine({ id: 'd1000000-0000-4000-8000-000000000004', name: 'リネンシャツ', quantity: 1, shipped: 1, readyUnshipped: 0 })],
  }),
  adminOrder({
    id: 'order-cancelled', customerName: '取消 六郎', status: 'キャンセル', orderStatus: 'cancelled', progressKey: 'cancelled', canShip: false,
  }),
];

const CHIPS = [
  'すべて',
  '支払い手続き中',
  '未決済',
  '発送待ち（受注生産中・発送準備中）',
  '発送済み（配送中・配達済み）',
  '決済失敗',
  '放棄',
  'キャンセル',
];

function lastUrl(urls: string[]): string {
  return urls[urls.length - 1] ?? '';
}

function orderRow(page: Page, id: string) {
  return page.getByRole('row', { name: new RegExp(id) });
}

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

    test('管理画面の一覧に、未決済・受注生産中・発送準備中・配送中の言葉と、一部発送済みの印が出る', async ({ page }) => {
      // FREQ-441-AC-01
      await mockAdminSession(page);
      await mockOrderList(page, () => ORDERS);
      await openOrderTab(page);
      await expect(orderRow(page, 'order-unpaid')).toBeVisible();

      const words: Array<[string, string]> = [
        ['order-unpaid', '未決済'],
        ['order-production', '受注生産中'],
        ['order-ready', '発送準備中'],
        ['order-partial', '受注生産中'],
        ['order-transit', '配送中'],
        ['order-cancelled', 'キャンセル'],
      ];
      for (const [id, word] of words) {
        await expect(orderRow(page, id).getByText(word, { exact: true })).toBeVisible();
      }
      // 状態の印は1行で出る（狭い画面幅で、5文字の言葉が「発送準備/中」のように途中で割れない。FR-ACCOUNT-019 の「1行で表示」と同じ考え）
      for (const [id, word] of words) {
        expect(await textLineCount(orderRow(page, id).getByText(word, { exact: true })), `${id} の「${word}」の印の行数`).toBe(1);
      }
      // 「一部発送済み」の印は、一部だけ送った注文にだけ付く
      await expect(orderRow(page, 'order-partial').getByText('一部発送済み', { exact: true })).toBeVisible();
      for (const id of ['order-unpaid', 'order-production', 'order-ready', 'order-transit', 'order-cancelled']) {
        await expect(orderRow(page, id).getByText('一部発送済み', { exact: true })).toHaveCount(0);
      }
      // 商品の欄は、0でない数だけを括弧の中に出す
      await expect(orderRow(page, 'order-partial')).toContainText(/ウールコート（ホワイト \/ M）\s*×\s*2/);
      await expect(orderRow(page, 'order-partial')).toContainText('受注生産中 1・発送済み 1');
      // 受注生産中の数がある注文にだけ「仕上がりを記録する」が出る
      await expect(orderRow(page, 'order-production').getByRole('button', { name: '仕上がりを記録する' })).toBeVisible();
      await expect(orderRow(page, 'order-ready').getByRole('button', { name: '仕上がりを記録する' })).toHaveCount(0);
      await page.screenshot({ path: `test-results/group-e1/order-list-labels-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('絞り込みの名前が決めた8つになり、DB の状態（paid・shipped）で働く', async ({ page }) => {
      // FREQ-441-AC-02
      await mockAdminSession(page);
      const list = await mockOrderList(page, () => ORDERS);
      await openOrderTab(page);
      await expect(orderRow(page, 'order-unpaid')).toBeVisible();

      for (const name of CHIPS) {
        await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: '決済完了', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '発送済み', exact: true })).toHaveCount(0);

      const waiting = page.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）', exact: true });
      const sent = page.getByRole('button', { name: '発送済み（配送中・配達済み）', exact: true });

      // 1つだけ選ぶと、DB の状態で窓口を絞る
      await waiting.click();
      await expect(waiting).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => lastUrl(list.urls)).toContain('status=paid');

      // 2つ選ぶと窓口は status を送らず、画面が DB の状態で絞る（窓口の答えは全部の行を返しているままでも、絞られる）
      await sent.click();
      await expect.poll(() => lastUrl(list.urls)).not.toContain('status=');
      await expect(orderRow(page, 'order-unpaid')).toHaveCount(0);
      await expect(orderRow(page, 'order-cancelled')).toHaveCount(0);
      for (const id of ['order-production', 'order-ready', 'order-partial', 'order-transit']) {
        await expect(orderRow(page, id)).toBeVisible();
      }

      // 発送済みだけにすると、配送中の注文だけが残り、窓口には status=shipped を送る
      await waiting.click();
      await expect.poll(() => lastUrl(list.urls)).toContain('status=shipped');
      await expect(orderRow(page, 'order-transit')).toBeVisible();
      await expect(orderRow(page, 'order-ready')).toHaveCount(0);
    });

    test('お客様の購入履歴の一覧にも、同じ言葉が出る', async ({ page }) => {
      // FREQ-441-AC-03
      await openCustomerOrders(page);

      const expected: Array<[string, string]> = [
        ['LFH-261005-00001', '受注生産中'],
        ['LFH-261005-00002', '発送準備中'],
        ['LFH-261005-00003', '配送中'],
        ['LFH-261005-00004', '未決済'],
      ];
      for (const [orderNumber, word] of expected) {
        const row = page.getByRole('link', { name: new RegExp(orderNumber) });
        await expect(row.getByText(word, { exact: true })).toBeVisible();
      }
    });
  });
}
