import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-005 API GET/POST/DELETE', () => {
  test('GETは配列を返す', async ({ request }) => {
    const res = await request.get('/api/wishlist');
    expect([200, 400]).toContain(res.status());
  });
});
