/**
 * FR-ACCOUNT-032 お客様の注文の画面の進み具合と、発送ごとの配送情報
 * 対応 FREQ: FREQ-444（AC-01〜AC-04）
 *
 * 窓口（GET /api/orders/[id]）の答えを差し替えて、画面を確かめる。答えの形は共通の約束（実装計画 C-2、Task 8）。
 * 段のラベルの色（済み・今は text-black、これからは text-[#999]）は、今の画面（FR-ACCOUNT-015）から引き継ぐ。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { progressOf, shipmentOf } from './order-detail-fixtures';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'order-1';
const STEP_LABELS = ['お支払い', '受注生産中', '発送準備中', '配送中', '配達済み'] as const;

const BASE = {
  id: ORDER_ID,
  orderNumber: 'ORD-0001',
  orderDate: '2026/10/01 09:00',
  subtotalAmount: '¥60,000',
  shippingAmount: '¥500',
  discountAmount: '¥0',
  totalAmount: '¥60,500',
  paymentMethod: 'クレジットカード',
  shippingFullName: '山田 花子',
  shippingEmail: 'user@example.com',
  shippingPhone: '090-1111-2222',
  shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
};

function line(input: {
  id: string;
  name: string;
  quantity: number;
  shippedQuantity?: number;
  readyQuantity?: number;
  inProductionQuantity?: number;
}) {
  return {
    itemId: 10,
    imageUrl: null,
    color: 'ホワイト',
    size: 'M',
    amount: '¥20,000',
    stockStatus: 'in_stock',
    shippedQuantity: 0,
    readyQuantity: 0,
    inProductionQuantity: 0,
    ...input,
  };
}

async function openDetail(page: Page, detail: unknown): Promise<void> {
  await mockOtpAuthentication(page);
  await page.route(`**/api/orders/${ORDER_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));
  await page.goto(`/account/orders/${ORDER_ID}`);
  await expect(page.getByText('ORD-0001')).toBeVisible();
}

/** 進み具合の中に出ている段のラベルを、並びの順に返す */
async function stepLabelsOf(list: Locator): Promise<string[]> {
  const text = await list.innerText();
  return STEP_LABELS.filter((label) => text.includes(label)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/**
 * 画面の中でその文字を含む所（商品の欄は「名前（色 / サイズ） × 数」と続けて書かれるので、名前だけの一致にはしない）を探し、
 * その手前にいちばん近い見出し（h1〜h6）の文字を、見つかった所ごとに返す
 */
async function headingsBefore(page: Page, text: string): Promise<string[]> {
  return page.getByText(text).evaluateAll((nodes) =>
    nodes.map((node) => {
      let found = '';
      for (const heading of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        if (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = (heading.textContent ?? '').trim();
      }
      return found;
    }));
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-032 order progress and shipments (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('在庫の品だけの注文は4段の進み具合が出て、発送が1つも無いので配送情報の区切りは出ない', async ({ page }) => {
      // FREQ-444-AC-01, FREQ-444-AC-02
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'ready', label: '発送準備中', current: 'ready' }),
        shipments: [],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 1, readyQuantity: 1 })],
      });
      const four = page.getByRole('list', { name: '配送ステータス' });
      await expect(four).toBeVisible();
      expect(await stepLabelsOf(four)).toEqual(['お支払い', '発送準備中', '配送中', '配達済み']);
      // 済みと今の段は text-black、これからの段は text-[#999]
      await expect(four.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
      await expect(four.getByText('発送準備中', { exact: true })).toHaveClass(/text-black/);
      await expect(four.getByText('配送中', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(four.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(page.getByRole('region', { name: /^配送情報/ })).toHaveCount(0);
    });

    test('受注生産の品を含む注文は5段の進み具合が出る', async ({ page }) => {
      // FREQ-444-AC-01
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true }),
        shipments: [],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 1, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'ウールコート', quantity: 2, inProductionQuantity: 2 }),
        ],
      });
      const five = page.getByRole('list', { name: '配送ステータス' });
      await expect(five).toBeVisible();
      expect(await stepLabelsOf(five)).toEqual(['お支払い', '受注生産中', '発送準備中', '配送中', '配達済み']);
      await expect(five.getByText('お支払い', { exact: true })).toHaveClass(/text-black/);
      await expect(five.getByText('受注生産中', { exact: true })).toHaveClass(/text-black/);
      await expect(five.getByText('発送準備中', { exact: true })).toHaveClass(/text-\[#999\]/);
      await expect(five.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e1/account-order-progress-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('発送ごとに「配送情報（n回目）」の区切りが出て、配送業者・追跡番号・リンク・その発送の商品が並ぶ', async ({ page }) => {
      // FREQ-444-AC-02
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true, partiallyShipped: true }),
        shipments: [
          shipmentOf({
            number: 1,
            items: [{ orderItemId: 'item-1', name: 'シルクブラウス', color: 'ホワイト', size: 'M', quantity: 2 }],
          }),
          shipmentOf({
            number: 2,
            shippedAt: '2026-10-08T00:00:00.000Z',
            carrier: 'sagawa',
            carrierLabel: '佐川急便',
            trackingNumber: 'SG-777-888',
            trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=SG-777-888',
            items: [{ orderItemId: 'item-2', name: 'プリーツスカート', color: 'ホワイト', size: 'M', quantity: 2 }],
          }),
        ],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 3, shippedQuantity: 2, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'プリーツスカート', quantity: 2, shippedQuantity: 2 }),
          line({ id: 'item-3', name: 'ウールコート', quantity: 1, inProductionQuantity: 1 }),
        ],
      });

      await expect(page.getByRole('region', { name: /^配送情報（\d+回目）$/ })).toHaveCount(2);
      const first = page.getByRole('region', { name: '配送情報（1回目）' });
      await expect(first.getByText('ヤマト運輸')).toBeVisible();
      await expect(first.getByText('1234-5678-9012')).toBeVisible();
      const firstLink = first.getByRole('link', { name: '配送状況を確認する' });
      await expect(firstLink).toHaveAttribute('href', /toi\.kuronekoyamato\.co\.jp/);
      await expect(firstLink).toHaveAttribute('rel', /noopener/);
      await expect(first.getByText('シルクブラウス')).toBeVisible();
      await expect(first).toContainText(/(×|x|数量[:：]?)\s*2/);
      await expect(first.getByText('プリーツスカート')).toHaveCount(0);

      const second = page.getByRole('region', { name: '配送情報（2回目）' });
      await expect(second.getByText('佐川急便')).toBeVisible();
      await expect(second.getByText('SG-777-888')).toBeVisible();
      await expect(second.getByRole('link', { name: '配送状況を確認する' })).toHaveAttribute('href', /k2k\.sagawa-exp\.co\.jp/);
      await expect(second.getByText('プリーツスカート')).toBeVisible();
      await expect(second.getByText('シルクブラウス')).toHaveCount(0);
      await page.screenshot({ path: `test-results/group-e1/account-order-shipments-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('まだ送っていない商品が「発送準備中の商品」「受注生産中の商品」の見出しの下に並ぶ', async ({ page }) => {
      // FREQ-444-AC-03
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true }),
        shipments: [],
        items: [
          line({ id: 'item-1', name: 'ガーデンパンツ', quantity: 1, readyQuantity: 1 }),
          line({ id: 'item-2', name: 'ウールコート', quantity: 2, inProductionQuantity: 2 }),
        ],
      });

      await expect(page.getByRole('heading', { name: '発送準備中の商品' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '受注生産中の商品' })).toBeVisible();
      expect(await headingsBefore(page, 'ガーデンパンツ')).toContain('発送準備中の商品');
      expect(await headingsBefore(page, 'ガーデンパンツ')).not.toContain('受注生産中の商品');
      expect(await headingsBefore(page, 'ウールコート')).toContain('受注生産中の商品');
      expect(await headingsBefore(page, 'ウールコート')).not.toContain('発送準備中の商品');
    });

    test('取り消した発送は出ず、窓口が返した発送だけを、その番号で出す', async ({ page }) => {
      // FREQ-444-AC-04
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'ready', label: '発送準備中', current: 'ready', partiallyShipped: true }),
        // 1回目は取り消したので、窓口は2回目だけを返す
        shipments: [shipmentOf({ number: 2, trackingNumber: 'E2E-SECOND' })],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 2, shippedQuantity: 1, readyQuantity: 1 })],
      });
      await expect(page.getByRole('region', { name: '配送情報（2回目）' })).toBeVisible();
      await expect(page.getByRole('region', { name: '配送情報（1回目）' })).toHaveCount(0);
    });

    test('キャンセルした注文には進み具合の段を出さない', async ({ page }) => {
      // FREQ-444-AC-04
      await openDetail(page, {
        ...BASE,
        status: 'cancelled',
        progress: { key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null },
        shipments: [],
        items: [line({ id: 'item-1', name: 'シルクブラウス', quantity: 1 })],
      });
      await expect(page.getByRole('list', { name: '配送ステータス' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: /^配送情報/ })).toHaveCount(0);
    });

    test('5段の進み具合と2回分の配送情報でも、段のラベルが1行で並び、横方向のページスクロールが発生しない', async ({ page }) => {
      await openDetail(page, {
        ...BASE,
        status: 'paid',
        progress: progressOf({ key: 'in_production', label: '受注生産中', current: 'in_production', withProduction: true, partiallyShipped: true }),
        shipments: [shipmentOf({ number: 1 }), shipmentOf({ number: 2, carrier: 'sagawa', carrierLabel: '佐川急便', trackingNumber: 'SG-777-888' })],
        items: [
          line({ id: 'item-1', name: 'シルクブラウス', quantity: 2, shippedQuantity: 2 }),
          line({ id: 'item-3', name: 'ウールコート', quantity: 1, inProductionQuantity: 1 }),
        ],
      });
      const list = page.getByRole('list', { name: '配送ステータス' });
      await expect(list).toBeVisible();
      for (const label of STEP_LABELS) {
        const box = await list.getByText(label, { exact: true }).boundingBox();
        expect(box, `${label} の位置`).not.toBeNull();
        // 1行で表示される（2行になると高さが2倍近くになる）
        expect(box!.height).toBeLessThan(25);
      }
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
