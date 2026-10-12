/**
 * FR-ACCOUNT-034 お客様の注文の画面の交換の品
 * 対応 FREQ: FREQ-473（AC-01〜AC-04）
 *
 * 窓口（GET /api/orders/[id]）は差し替えない。手元の Supabase に会員を作ってログインし、その会員の注文に、返品の受け取りで
 * 交換の品の行（line_kind = 'exchange'）を作り（窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼ぶ。実装計画 P11）、
 * 本物の窓口と画面で確かめる（e2e/member-session-helpers.ts。手元以外では動かない。FR-ACCOUNT-033 と同じ作り）。
 * 窓口の答えの形は実装計画 Task 13、印の名前（data-testid）も Task 13 が決める
 * （order-item-exchange = ご注文商品の印、order-shipment-exchange = 配送情報の品の印）。
 */
import { expect, test, type Page } from '@playwright/test';
import { PRICE, uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';
import { createTestMember, loginAsMember } from './member-session-helpers';
import { createFulfillment, withLocalDb } from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { formatYen } from './refund-test-utils';
import {
  addVariant,
  createReturnInDb,
  createShippedOrder,
  exchangeItemRows,
  receiveReturnInDb,
} from './return-test-utils';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

const EXCHANGE_MARK = '交換の品';
/** 交換の品の行の値段の字（0円と出さない）。実装計画 C-5 */
const EXCHANGE_PRICE = '—';

type LineKind = 'order' | 'exchange';
type DetailBody = {
  items: Array<{ id: string; name: string; amount: string; lineKind: LineKind }>;
  shipments: Array<{ number: number; items: Array<{ orderItemId: string; name: string; lineKind: LineKind }> }>;
};

/**
 * 手元の Supabase に会員を作ってログインし、その会員の注文（シャツ1枚を発送済み）に、返品の受け取りで交換の品（同じ商品の
 * L サイズを在庫から。手数料なし）を足す。shipExchange を付けると、交換の品を2回目の発送で送る
 */
async function memberWithExchangeOrder(page: Page, label: string, options: { shipExchange: boolean }) {
  const member = await createTestMember(label);
  await loginAsMember(page, member);
  return withLocalDb(async (db) => {
    const fx = await createShippedOrder(db, label, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }], {
      userId: member.userId,
      email: member.email,
    });
    const shirt = fx.orderItemIds[0];
    const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
    const created = await createReturnInDb(db, fx, {
      lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
      notify: false,
    });
    await receiveReturnInDb(db, created.returnId, fx.actorId, {
      units: [{ lineId: created.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
      choice: 'none',
      notify: false,
    });
    const [exchange] = await exchangeItemRows(db, fx.orderId);
    if (options.shipExchange) {
      await createFulfillment(db, fx.orderId, fx.actorId, {
        trackingNumber: `E2E-EX-${uniqueSuffix()}`,
        notify: false,
        lines: [{ orderItemId: exchange.id, quantity: 1 }],
      });
    }
    return { orderId: fx.orderId, shirtId: shirt, exchangeItemId: exchange.id };
  });
}

/** その会員の、交換の品の無い注文（シャツとスカートを発送済み） */
async function memberWithPlainOrder(page: Page, label: string) {
  const member = await createTestMember(label);
  await loginAsMember(page, member);
  return withLocalDb(async (db) => {
    const fx = await createShippedOrder(
      db,
      label,
      [
        { name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' },
        { name: 'E2Eスカート', quantity: 2, fulfillmentType: 'stock' },
      ],
      { userId: member.userId, email: member.email },
    );
    return { orderId: fx.orderId };
  });
}

async function readDetail(page: Page, orderId: string): Promise<DetailBody> {
  const response = await page.request.get(`/api/orders/${orderId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as DetailBody;
}

async function openDetailPage(page: Page, orderId: string): Promise<void> {
  await page.goto(`/account/orders/${orderId}`);
  await expect(page.getByText(orderNumberOf(orderId))).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
  expect(hasHorizontalOverflow).toBe(false);
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-034 order exchange items (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('ご注文商品の交換の品の行に「交換の品」の印が付き、値段は「—」になる。ふつうの行は金額のままで、印を付けない。窓口は行ごとに lineKind を返す（本物の窓口と手元の DB）', async ({ page }) => {
      // FREQ-473-AC-01, FREQ-473-AC-03
      test.setTimeout(180_000);
      const { orderId, shirtId, exchangeItemId } = await memberWithExchangeOrder(page, `exchange-items-${viewport.name}`, {
        shipExchange: false,
      });

      // 窓口: 元の品は order、交換の品は exchange。金額は DB の値のまま（交換の品は ￥0。「—」にするのは画面）
      const body = await readDetail(page, orderId);
      expect(body.items).toHaveLength(2);
      const original = body.items.find((item) => item.id === shirtId);
      const exchange = body.items.find((item) => item.id === exchangeItemId);
      expect(original).toMatchObject({ lineKind: 'order', amount: formatYen(PRICE) });
      expect(exchange).toMatchObject({ lineKind: 'exchange', amount: formatYen(0) });

      // 画面: 印は交換の品の行だけに1つ。値段は「—」で、「￥0」と出さない
      await openDetailPage(page, orderId);
      const rows = page.locator('.account-order-item');
      await expect(rows).toHaveCount(2);
      const marks = page.getByTestId('order-item-exchange');
      await expect(marks).toHaveCount(1);
      await expect(marks).toHaveText(EXCHANGE_MARK);
      const exchangeRow = rows.filter({ has: marks });
      const ordinaryRow = rows.filter({ hasNot: marks });
      await expect(exchangeRow).toHaveCount(1);
      await expect(ordinaryRow).toHaveCount(1);
      await expect(exchangeRow.locator('p.account-value').last()).toHaveText(EXCHANGE_PRICE);
      await expect(exchangeRow).not.toContainText(formatYen(0));
      await expect(ordinaryRow).toContainText(formatYen(PRICE));
      await expect(ordinaryRow).not.toContainText(EXCHANGE_PRICE);
      await expect(ordinaryRow).not.toContainText(EXCHANGE_MARK);
      // 配送情報にはまだ交換の品を送っていないので、配送情報の印は出ない
      await expect(page.getByTestId('order-shipment-exchange')).toHaveCount(0);
    });

    test('交換の品を送ると、2回目の配送情報の品に「交換の品」の印が付き、1回目の品には付かない。窓口は発送の品にも lineKind を返す（本物の窓口と手元の DB）', async ({ page }) => {
      // FREQ-473-AC-02, FREQ-473-AC-03
      test.setTimeout(180_000);
      const { orderId, shirtId, exchangeItemId } = await memberWithExchangeOrder(page, `exchange-ship-${viewport.name}`, {
        shipExchange: true,
      });

      // 窓口: 発送の品ごとに lineKind。1回目は元の品、2回目は交換の品
      const body = await readDetail(page, orderId);
      const first = body.shipments.find((shipment) => shipment.number === 1);
      const second = body.shipments.find((shipment) => shipment.number === 2);
      expect(body.shipments).toHaveLength(2);
      expect(first?.items).toEqual([expect.objectContaining({ orderItemId: shirtId, quantity: 1, lineKind: 'order' })]);
      expect(second?.items).toEqual([expect.objectContaining({ orderItemId: exchangeItemId, quantity: 1, lineKind: 'exchange' })]);

      // 画面: 配送情報（2回目）の品だけに印
      await openDetailPage(page, orderId);
      const firstRegion = page.getByRole('region', { name: '配送情報（1回目）' });
      const secondRegion = page.getByRole('region', { name: '配送情報（2回目）' });
      await expect(firstRegion).toBeVisible();
      await expect(secondRegion).toBeVisible();
      await expect(firstRegion.getByTestId('order-shipment-exchange')).toHaveCount(0);
      await expect(secondRegion.getByTestId('order-shipment-exchange')).toHaveText(EXCHANGE_MARK);
      await expect(page.getByTestId('order-shipment-exchange')).toHaveCount(1);
      // ご注文商品の印と「—」も残る
      await expect(page.getByTestId('order-item-exchange')).toHaveCount(1);
      await expect(page.locator('.account-order-item').filter({ has: page.getByTestId('order-item-exchange') }).locator('p.account-value').last()).toHaveText(EXCHANGE_PRICE);
      // 印が増えても、横にはみ出さない。目で見るための写し
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `test-results/group-e3/account-order-exchange-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('交換の品が無い注文には、ご注文商品にも配送情報にも印を出さず、値段の「—」も出さない。窓口の lineKind はすべて order で、横方向のページスクロールも発生しない（本物の窓口と手元の DB）', async ({ page }) => {
      // FREQ-473-AC-04, FREQ-473-AC-03
      test.setTimeout(180_000);
      const { orderId } = await memberWithPlainOrder(page, `plain-order-${viewport.name}`);

      const body = await readDetail(page, orderId);
      expect(body.items.map((item) => item.lineKind)).toEqual(['order', 'order']);
      expect(body.shipments).toHaveLength(1);
      expect(body.shipments[0].items.map((item) => item.lineKind)).toEqual(['order', 'order']);

      await openDetailPage(page, orderId);
      const rows = page.locator('.account-order-item');
      await expect(rows).toHaveCount(2);
      await expect(page.getByTestId('order-item-exchange')).toHaveCount(0);
      await expect(page.getByTestId('order-shipment-exchange')).toHaveCount(0);
      for (const index of [0, 1]) {
        await expect(rows.nth(index)).not.toContainText(EXCHANGE_PRICE);
        await expect(rows.nth(index)).not.toContainText(EXCHANGE_MARK);
      }
      await expect(page.getByRole('region', { name: '配送情報（1回目）' })).not.toContainText(EXCHANGE_MARK);
      await expectNoHorizontalScroll(page);
    });
  });
}
