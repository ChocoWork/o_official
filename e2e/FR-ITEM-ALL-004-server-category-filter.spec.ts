import { expect, test } from '@playwright/test';

test.describe('FR-ITEM-ALL-004 サーバカテゴリ絞り込み', () => {
  test('categoryクエリでサーバ側絞り込みが行われる', async ({ page }) => {
    const response = await page.request.get('/api/items?category=TOPS&page=1&pageSize=24');
    expect(response.ok()).toBeTruthy();

    const payload = (await response.json()) as { items?: Array<{ category?: string }> };
    const items = payload.items ?? [];
    for (const item of items) {
      expect(String(item.category ?? '').toUpperCase()).toBe('TOPS');
    }
  });
});
