/**
 * FR-CHECKOUT-045 在庫ありの明細をカートから確定メールまで通して確かめる
 * 対応 FREQ: FREQ-419 / FREQ-422（在庫ありの側）。実行は controller。
 * 新しい順の最初の商品を避け、他の購入 spec が指定していない種データの商品7（Brass/FREE）を使う。
 * 在庫は台帳への追記で動かし、失敗しても afterAll で元の数へ戻す。手元以外には書かない。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { FINAL_FULFILLMENT_LABELS, FULFILLMENT_HEADINGS } from '../src/features/checkout/utils/fulfillment-labels';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, stubPostalCode } from './checkout-flow-helpers';

type StockVariant = {
  id: number;
  item_id: number;
  stock_quantity: number;
  item: { name: string; status: string };
  color: { name: string };
  size: { label: string };
};
type MailpitSearch = { messages: Array<{ ID: string; Subject: string }> };
const STOCK_TEXT = `${FULFILLMENT_HEADINGS.stock}・${FINAL_FULFILLMENT_LABELS.stock}`;

test.describe('FR-CHECKOUT-045 在庫ありの注文と確定メール', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ locale: 'ja-JP' });
  let client: SupabaseClient | null = null;
  let variant: StockVariant | null = null;
  let originalStock: number | null = null;
  let localUrl = '';

  async function setStockCount(target: number): Promise<void> {
    if (!isLocalUrl(localUrl) || !client || !variant) throw new Error('在庫の書き込み先は手元の Supabase に限る');
    const current = await client.from('item_variants').select('stock_quantity').eq('id', variant.id).single<{ stock_quantity: number }>();
    if (current.error || !current.data || !Number.isSafeInteger(current.data.stock_quantity)) throw new Error('手元の在庫数を読めない');
    const delta = target - current.data.stock_quantity;
    if (delta !== 0) {
      const movement = await client.from('stock_movements').insert({
        variant_id: variant.id, delta, reason: 'adjustment', note: 'FR-CHECKOUT-045 の一時在庫・復元',
      });
      if (movement.error) throw new Error('手元の一時在庫を調整できない');
    }
    const restored = await client.from('item_variants').select('stock_quantity').eq('id', variant.id).single<{ stock_quantity: number }>();
    if (restored.error) throw new Error('手元の調整後の在庫数を読めない');
    expect(restored.data?.stock_quantity).toBe(target);
  }

  test.beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || !isLocalUrl(url)) throw new Error('手元の Supabase の住所と service role の鍵が必要');
    localUrl = url;
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    // seedCart と同じ「公開中・50円以上・新しい順の最初」を在庫の対象から除く。
    const newest = await client.from('items').select('id').eq('status', 'published').gte('price', 50).order('created_at', { ascending: false }).limit(1).single<{ id: number }>();
    if (newest.error || !newest.data) throw new Error('種データの公開中の商品を読めない');
    const selected = await client.from('item_variants')
      .select('id, item_id, stock_quantity, item:items!inner(name,status), color:item_colors!inner(name), size:item_sizes!inner(label)')
      .eq('item_id', 7).like('sku', 'E2E-ITEM-7-%').eq('is_active', true).eq('item.status', 'published')
      .neq('item_id', newest.data.id).not('color_id', 'is', null).not('size_id', 'is', null).limit(1).single<StockVariant>();
    if (selected.error || !selected.data) throw new Error('専用の種データの色・サイズ付きバリアントが必要');
    if (!Number.isSafeInteger(selected.data.stock_quantity) || selected.data.stock_quantity < 0) throw new Error('元の在庫数が不正');
    variant = selected.data;
    originalStock = variant.stock_quantity;
    await setStockCount(5);
  });

  test.afterAll(async () => {
    // beforeAll の在庫追記後や途中の失敗でも、読む時点の残数との差分を台帳に追記して戻す。
    if (client && variant && originalStock !== null) await setStockCount(originalStock);
  });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）在庫ありの明細を注文すると、確定メールにも在庫ありの目安が出る`, async ({ page, request }) => {
      if (!variant) throw new Error('一時在庫のバリアントが未準備');
      const mailUrl = process.env.MAIL_LOCAL_URL;
      if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
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
      const deliveryLine = page.getByTestId('checkout-terms').getByRole('listitem').filter({ hasText: variant.item.name });
      await expect(deliveryLine).toHaveCount(1);
      await expect(deliveryLine).toContainText(STOCK_TEXT);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });

      // FR-CHECKOUT-041 と同じ Mailpit の読み方。宛先をテストごとに分け、確定メールが届くまで条件で待つ。
      await expect.poll(async () => {
        const searchResponse = await request.get(new URL('/api/v1/search', mailUrl).toString(), { params: { query: `to:${email}` }, timeout: 5_000 });
        await expect(searchResponse).toBeOK();
        const search = await searchResponse.json() as MailpitSearch;
        const confirmation = search.messages.find((message) => message.Subject.includes('ご注文ありがとうございます'));
        if (!confirmation) return '';
        const messageResponse = await request.get(new URL(`/api/v1/message/${encodeURIComponent(confirmation.ID)}`, mailUrl).toString(), { timeout: 5_000 });
        await expect(messageResponse).toBeOK();
        const message = await messageResponse.json() as { Text: string };
        return message.Text;
      }, { timeout: 60_000, message: '在庫ありの目安を含む確定メールが届くこと' }).toContain(STOCK_TEXT);
    });
  }
});
