import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-005 API GET/POST/DELETE', () => {
  test('GETは配列を返す', async ({ request }) => {
    const res = await request.get('/api/wishlist');
    // 持ち主の印（wishlist の Cookie）が無いゲストは、持ち主がまだ無いので、400 ではなく空の配列を返す
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
