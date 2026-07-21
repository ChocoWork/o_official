import { expect, test } from '@playwright/test';

// FREQ-186: POPULAR ITEMS は購入数（status='paid' の注文数量合計）の多い順。
// 検索語が未入力でも表示する。購入数そのものはレスポンスに含めない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type PopularItem = {
  id: string;
  type: string;
  title: string;
  imageUrl: string | null;
};

test.describe('FR-SEARCH-008 POPULAR ITEMS の購入数順表示', () => {
  // 購入数の降順そのものは RPC 定義側で担保する（購入数は API に出さないため
  // HTTP からは観測できない）。ここでは公開 ITEM のみが並ぶことと、
  // 購入数が外部へ漏れないことを検証する。
  test('AC-01/AC-02 公開 ITEM のみが並び、購入数はレスポンスに含めない', async ({ page }) => {
    const response = await page.request.get('/api/search?q=');
    expect(response.ok()).toBeTruthy();

    const payload = (await response.json()) as { popularItems: PopularItem[] };
    const popularItems = payload.popularItems;

    expect(popularItems.length).toBeGreaterThan(0);

    for (const item of popularItems) {
      expect(item.type).toBe('item');
      expect(item).not.toHaveProperty('purchase_count');
      expect(item).not.toHaveProperty('purchaseCount');

      // 非公開 ITEM が混ざっていないこと
      const itemResponse = await page.request.get(`/item/${item.id}`);
      expect(itemResponse.status()).toBeLessThan(400);
    }
  });

  for (const vp of VIEWPORTS) {
    test(`AC-03 ${vp.name} 検索語なしで POPULAR ITEMS が表示されること`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');

      await expect(page.getByText('POPULAR ITEMS')).toBeVisible();

      const rows = page.locator('[data-testid="search-result-row"]');
      await expect(rows.first()).toBeVisible();
      expect(await rows.count()).toBeGreaterThan(0);

      // 未入力時の案内文は、一覧が出ている間は表示しない
      await expect(page.getByText('気になる商品名やトピックを入力すると')).toBeHidden();

      // 行は ITEM のみ
      const labels = await rows.locator('p').filter({ hasText: /^(ITEM|LOOK|NEWS)$/ }).allInnerTexts();
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label).toBe('ITEM');
      }
    });
  }
});
