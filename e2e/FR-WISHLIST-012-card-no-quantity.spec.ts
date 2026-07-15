import { expect, test } from '@playwright/test';

// FREQ-124: WISHLIST カードから在庫（数量）表示を削除する。
// ITEM 一覧カードとの共通化（item-info/name/price）とカラースウォッチ（色）は維持する。
// 公開データに依存しないよう /api/wishlist をモックして安定検証する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const MOCK_WISHLIST = [
  {
    id: 'wish-1',
    item_id: 101,
    added_at: '2026-04-15T00:00:00.000Z',
    items: {
      id: 101,
      name: 'Test Vest',
      price: 24800,
      image_url: '/images/test-item.jpg',
      category: 'TOPS',
      colors: [
        { name: 'BLACK', hex: '#000000' },
        { name: 'ECRU', hex: '#f5f0e6' },
      ],
      sizes: ['FREE'],
    },
  },
];

test.describe('FR-WISHLIST-012 カードから在庫（数量）表示を削除', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: 共通カード＋色を表示し、item-stock は表示しない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.route('**/api/wishlist', async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_WISHLIST),
        });
      });

      await page.goto('/wishlist');

      const card = page.locator('[role="listitem"]').first();
      await expect(card).toBeVisible();

      // ITEM 一覧カードと同じ testid で共通化されている
      await expect(card.locator('[data-testid="item-info"]')).toBeVisible();
      await expect(card.locator('[data-testid="item-name"]')).toHaveText(
        'Test Vest',
      );
      await expect(card.locator('[data-testid="item-price"]')).toContainText(
        '24,800',
      );

      // FREQ-124-AC-04: 色（カラースウォッチ）は維持される
      await expect(card.locator('[aria-label^="カラー"]')).toBeVisible();

      // FREQ-124-AC-03: 在庫（数量）表示は存在しない
      await expect(card.locator('[data-testid="item-stock"]')).toHaveCount(0);
    });
  }
});
