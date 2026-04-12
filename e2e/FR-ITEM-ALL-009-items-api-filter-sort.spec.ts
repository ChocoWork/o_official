import { expect, test } from '@playwright/test';

test.describe('FR-ITEM-ALL-009 /api/items フィルタ・ソート', () => {
  test('filter/sort/pageパラメータでAPI応答を返す', async ({ page }) => {
    const response = await page.request.get('/api/items?category=TOPS&sort=price_asc&page=1&pageSize=12');
    expect(response.ok()).toBeTruthy();

    const payload = (await response.json()) as {
      items: Array<{ category?: string; price?: number }>;
      page: number;
      pageSize: number;
      hasMore: boolean;
    };

    expect(Array.isArray(payload.items)).toBeTruthy();
    expect(payload.page).toBe(1);
    expect(payload.pageSize).toBe(12);
    expect(typeof payload.hasMore).toBe('boolean');

    for (const item of payload.items) {
      expect(String(item.category ?? '').toUpperCase()).toBe('TOPS');
    }
  });
});
