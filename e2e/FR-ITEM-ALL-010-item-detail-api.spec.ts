import { expect, test } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-010 /api/items/:id 商品詳細', () => {
  test('一覧のIDで詳細データを取得できる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    const response = await page.request.get(`/api/items/${item!.id}`);
    expect(response.ok()).toBeTruthy();

    const detail = (await response.json()) as { id?: number | string; name?: string };
    expect(String(detail.id)).toBe(String(item!.id));
    expect(typeof detail.name).toBe('string');
  });
});
