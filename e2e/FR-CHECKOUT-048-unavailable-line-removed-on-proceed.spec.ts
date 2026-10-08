import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { fillShippingForm, proceedToFinal, stubPostalCode } from './checkout-flow-helpers';

// ゲストの Cookie も、失敗時の通信記録に残さないため。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];
type SeedVariant = {
  id: number;
  item_id: number;
  is_active: boolean;
  item: { name: string; status: string; price: number };
  color: { name: string };
  size: { label: string };
};

test.describe('FR-CHECKOUT-048 買えない明細を確認へ進む時に外す', () => {
  // 同じ種データのバリアントを一時的に変えるため、3画面幅を順番に実行する。
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ locale: 'ja-JP' });
  let client: SupabaseClient | null = null;
  let localUrl = '';
  let changedVariantId: number | null = null;

  async function selectSeedVariant(itemId: 5 | 6): Promise<SeedVariant> {
    if (!isLocalUrl(localUrl) || !client) throw new Error('バリアントの読み取り先は手元の Supabase に限る');
    // seedCart が使う商品1や FR-CHECKOUT-045 の商品7と重ならない専用の商品を選ぶ。
    const selected = await client.from('item_variants')
      .select('id, item_id, is_active, item:items!inner(name,status,price), color:item_colors!inner(name), size:item_sizes!inner(label)')
      .eq('item_id', itemId).like('sku', `E2E-ITEM-${itemId}-%`).eq('is_active', true)
      .eq('item.status', 'published').gte('item.price', 50)
      .not('color_id', 'is', null).not('size_id', 'is', null)
      .order('id', { ascending: true }).limit(1).single<SeedVariant>();
    if (selected.error || !selected.data || selected.data.is_active !== true) {
      throw new Error('公開中で50円以上の専用の商品5・6の色・サイズ付きバリアントが必要');
    }
    return selected.data;
  }

  async function setActive(variantId: number, active: boolean): Promise<void> {
    // FR-CHECKOUT-045 と同じ守りを、変更と復元のどちらにも掛ける。
    if (!isLocalUrl(localUrl) || !client) throw new Error('バリアントの書き込み先は手元の Supabase に限る');
    const result = await client.from('item_variants').update({ is_active: active }).eq('id', variantId)
      .like('sku', 'E2E-ITEM-6-%').select('id,is_active').single<{ id: number; is_active: boolean }>();
    if (result.error || !result.data) throw new Error('手元の種データのバリアントを変更・復元できない');
    expect(result.data.is_active).toBe(active);
  }

  async function restoreVariant(): Promise<void> {
    if (changedVariantId !== null) {
      await setActive(changedVariantId, true);
      changedVariantId = null;
    }
  }

  // finally の復元が失敗した場合にも再試行し、失敗をテスト結果へ残す。
  test.afterEach(restoreVariant);

  for (const viewport of viewports) {
    test(`FREQ-430-AC-08: 外した商品を案内し、残りの商品で押し直せる (${viewport.name})`, async ({ page }) => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key || !isLocalUrl(url)) throw new Error('手元の Supabase の住所と service role の鍵が必要');
      localUrl = url;
      client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      const remainingVariant = await selectSeedVariant(5);
      const unavailableVariant = await selectSeedVariant(6);
      expect(remainingVariant.item_id).not.toBe(unavailableVariant.item_id);
      const added = await page.request.post('/api/cart/add', {
        headers: { origin: new URL(page.url()).origin },
        data: { items: [remainingVariant, unavailableVariant].map((variant) => ({ id: variant.id, quantity: 1 })) },
      });
      expect(added.status()).toBe(200);

      changedVariantId = unavailableVariant.id;
      try {
        await setActive(changedVariantId, false);
        await stubPostalCode(page);
        await page.goto('/checkout');
        await fillShippingForm(page, `e2e-unavailable-${viewport.name}-${Date.now()}@example.com`);
        const proceed = page.getByRole('button', { name: '確認へ進む', exact: true });
        await expect(proceed).toBeEnabled({ timeout: 30_000 });
        const firstResponse = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/checkout/create-session');
        await proceed.click();
        const updated = await firstResponse;
        expect(updated.status()).toBe(409);
        expect(await updated.json()).toMatchObject({ error: 'cart_updated', retryable: true });
        const message = page.getByTestId('checkout-session-error');
        await expect(message).toContainText('次の商品はお求めいただけなくなったため、カートから外しました');
        await expect(message).toContainText(`${unavailableVariant.item.name}（${unavailableVariant.color.name} / ${unavailableVariant.size.label}）`);
        await expect(proceed).toBeEnabled();
        await proceedToFinal(page);
        const summary = page.locator('.checkout-summary');
        await expect(summary.getByText(remainingVariant.item.name, { exact: true })).toBeVisible();
        await expect(summary.getByText(unavailableVariant.item.name, { exact: true })).toHaveCount(0);
      } finally {
        // 元のアサーションの失敗を隠さず、復元の失敗は afterEach の再試行で結果に残す。
        await restoreVariant().catch(() => undefined);
      }
    });
  }
});
