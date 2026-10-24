/**
 * FR-CHECKOUT-045 在庫ありの明細をカートから確定メールまで通して確かめる
 * 対応 FREQ: FREQ-419 / FREQ-422（在庫ありの側）。実行は controller。
 * 新しい順の最初の商品を避け、他の購入 spec が指定していない種データの商品7（Brass/FREE）を使う。
 * 在庫は G-1 の本物の入口（public.admin_record_stock_movement。手元の DB へ直に接続し、鍵・FIFO・履歴を通る）で動かし、
 * 失敗しても afterAll で元の数へ戻す。手元以外には書かない。台帳・在庫の表へ直には書かない。
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { FINAL_FULFILLMENT_LABELS, FULFILLMENT_HEADINGS } from '../src/features/checkout/utils/fulfillment-labels';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, stubPostalCode } from './checkout-flow-helpers';
import { localFixtureAdminId, lockE2eInventory, withGroupG1Material } from './group-g1-test-utils';
import { mailBodies, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

type StockVariant = {
  id: number;
  item_id: number;
  /** すぐ出せる数（F） */
  stock_quantity: number;
  item_name: string;
};
type VariantInventory = { free: number; paidAllocated: number; paymentHeld: number };
const STOCK_TEXT = `${FULFILLMENT_HEADINGS.stock}・${FINAL_FULFILLMENT_LABELS.stock}`;
const ADJUSTMENT_NOTE = 'FR-CHECKOUT-045 の一時在庫・復元';

/** 色・サイズの空き（F）・入金済みの割当（A）・支払い前の仮確保（H）を、公開の読み取り関数で読む */
async function readInventory(db: PgClient, variantId: number): Promise<VariantInventory> {
  const row = (await db.query(
    'select free, paid_allocated, payment_held from public.list_group_g_variant_inventory(array[$1::bigint])', [variantId],
  )).rows[0];
  if (!row) throw new Error('手元の在庫数を読めない');
  return { free: Number(row.free), paidAllocated: Number(row.paid_allocated), paymentHeld: Number(row.payment_held) };
}

test.describe('FR-CHECKOUT-045 在庫ありの注文と確定メール', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ locale: 'ja-JP' });
  let variant: StockVariant | null = null;
  let originalStock: number | null = null;

  /**
   * 空き（F）を target にそろえる。1つの G-1 の取引で、鍵の後に F・A・H を読み、差分を棚卸調整（delta=0 は呼ばない）で入れ、
   * 読み直して F が target で A・H が動いていないことを確かめる。実行者は手元の有効な管理者、要求番号は送信ごとの新しい UUID。
   */
  async function setStockCount(target: number): Promise<void> {
    if (!variant) throw new Error('在庫の対象のバリアントが未準備');
    const { id: variantId, item_id: itemId } = variant;
    await withLocalDb((db) => withGroupG1Material(db, async () => {
      const actorId = await localFixtureAdminId(db);
      await lockE2eInventory(db, { variantIds: [variantId] });
      const before = await readInventory(db, variantId);
      const delta = target - before.free;
      if (delta !== 0) {
        await db.query(
          "select public.admin_record_stock_movement($1::bigint, $2::bigint, $3::integer, 'adjustment', $4::text, $5::uuid, $6::uuid, NULL)",
          [itemId, variantId, delta, ADJUSTMENT_NOTE, actorId, randomUUID()],
        );
      }
      expect(await readInventory(db, variantId)).toEqual({ ...before, free: target });
    }));
  }

  test.beforeAll(async () => {
    const selected = await withLocalDb(async (db) => {
      // seedCart と同じ「公開中・50円以上・新しい順の最初」を在庫の対象から除く。
      const newest = (await db.query(
        "select id from public.items where status = 'published' and price >= 50 order by created_at desc limit 1",
      )).rows[0];
      if (!newest) throw new Error('種データの公開中の商品を読めない');
      return (await db.query(
        `select v.id, v.item_id, v.stock_quantity, i.name as item_name
           from public.item_variants as v
           join public.items as i on i.id = v.item_id
           join public.item_colors as c on c.id = v.color_id
           join public.item_sizes as s on s.id = v.size_id
          where v.item_id = 7 and v.sku like 'E2E-ITEM-7-%' and v.is_active and i.status = 'published' and v.item_id <> $1
          order by v.id limit 1`,
        [newest.id],
      )).rows[0];
    });
    if (!selected) throw new Error('専用の種データの色・サイズ付きバリアントが必要');
    const stock = Number(selected.stock_quantity);
    if (!Number.isSafeInteger(stock) || stock < 0) throw new Error('元の在庫数が不正');
    variant = { id: Number(selected.id), item_id: Number(selected.item_id), stock_quantity: stock, item_name: selected.item_name as string };
    originalStock = stock;
    await setStockCount(5);
  });

  test.afterAll(async () => {
    // beforeAll の調整後や途中の失敗でも、読む時点の空きとの差分を棚卸調整で入れて戻す。
    if (variant && originalStock !== null) await setStockCount(originalStock);
  });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）在庫ありの明細を注文すると、確定メールにも在庫ありの目安が出る`, async ({ page, request }) => {
      if (!variant) throw new Error('一時在庫のバリアントが未準備');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      // カートの窓口はバリアントの番号で受ける。DB から選んだこのバリアントの番号（variant.id）をそのまま送る
      await page.evaluate(async (variantId) => {
        const response = await fetch('/api/cart/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
        });
        if (!response.ok) throw new Error(`/api/cart/add returned ${response.status}`);
      }, variant.id);
      await stubPostalCode(page);
      const email = `e2e-in-stock-${viewport.name}-${Date.now()}@example.com`;
      await page.goto('/checkout');
      await fillShippingForm(page, email);
      await proceedToFinal(page);
      const deliveryLine = page.getByTestId('checkout-terms').getByRole('listitem').filter({ hasText: variant.item_name });
      await expect(deliveryLine).toHaveCount(1);
      await expect(deliveryLine).toContainText(STOCK_TEXT);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });

      // FR-CHECKOUT-041 と同じ Mailpit の読み方。宛先をテストごとに分け、確定メールが届くまで条件で待つ。
      await expect.poll(async () => {
        return (await mailBodies(request, email, 'ご注文ありがとうございます')).some((mail) => mail.Text.includes(STOCK_TEXT));
      }, { timeout: 60_000, message: '在庫ありの目安を含む確定メールが届くこと' }).toBe(true);
    });
  }
});
