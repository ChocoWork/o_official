import { expect, test } from '@playwright/test';
import { fetchItemsViaApi } from './item-list-test-utils';

// FREQ-42-AC-01: 複数カテゴリ指定は OR 検索（AND による空結果にならない）。
test.describe('FR-ITEM-ALL-019 CATEGORY 複数選択は OR 検索', () => {
  test('TOPS,BOTTOMS は OR で取得され、件数が各単一カテゴリの合計に等しい', async ({ page }) => {
    const tops = await fetchItemsViaApi(page, '?category=TOPS&pageSize=60');
    const bottoms = await fetchItemsViaApi(page, '?category=BOTTOMS&pageSize=60');
    const both = await fetchItemsViaApi(page, '?category=TOPS,BOTTOMS&pageSize=60');

    // 返る商品はすべて TOPS か BOTTOMS のいずれか（OR）。
    for (const item of both) {
      expect(['TOPS', 'BOTTOMS']).toContain((item.category ?? '').toUpperCase());
    }

    // OR なので件数は各単一カテゴリの合計に一致（AND の交差＝0 ではない）。
    expect(both.length).toBe(tops.length + bottoms.length);
  });

  test('不正なカテゴリトークンは 400 を返す', async ({ page }) => {
    const response = await page.request.get('/api/items?category=TOPS,INVALID');
    expect(response.status()).toBe(400);
  });
});
