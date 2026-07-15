import { expect, test } from '@playwright/test';

// FREQ-125: WISHLIST カードのグリッドを、ホームページ ITEM セクションのカードの
// サイズ・間隔に合わせて改善し、1行あたりの表示商品数も ITEM セクションと同数
// （mobile:2 / tablet:3 / desktop(xl):5）にする。
// 公開データに依存しないよう /api/wishlist をモックして安定検証する。

const MOCK_WISHLIST = Array.from({ length: 10 }).map((_, i) => ({
  id: `wish-${i + 1}`,
  item_id: 100 + i,
  added_at: '2026-04-15T00:00:00.000Z',
  items: {
    id: 100 + i,
    name: `Test Item ${i + 1}`,
    price: 24800,
    image_url: '/images/test-item.jpg',
    category: 'TOPS',
    colors: [
      { name: 'BLACK', hex: '#000000' },
      { name: 'ECRU', hex: '#f5f0e6' },
    ],
    sizes: ['FREE'],
  },
}));

async function gotoWishlist(page: import('@playwright/test').Page) {
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
}

function grid(page: import('@playwright/test').Page) {
  return page.locator('[role="list"][aria-label="ウィッシュリスト商品一覧"]');
}

async function columnCount(page: import('@playwright/test').Page): Promise<number> {
  return grid(page).evaluate(
    (el) =>
      getComputedStyle(el as HTMLElement)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length,
  );
}

test.describe('FR-WISHLIST-013 グリッドをホーム ITEM セクションに合わせる', () => {
  test('FREQ-125-AC-01: モバイル(390px)で2列', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoWishlist(page);
    await expect(grid(page)).toBeVisible();
    expect(await columnCount(page)).toBe(2);
  });

  test('FREQ-125-AC-02: タブレット(768px)で3列', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoWishlist(page);
    await expect(grid(page)).toBeVisible();
    expect(await columnCount(page)).toBe(3);
  });

  test('FREQ-125-AC-03: デスクトップ(1280px)で5列（ホーム ITEM と同数）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWishlist(page);
    await expect(grid(page)).toBeVisible();
    expect(await columnCount(page)).toBe(5);
  });

  test('FREQ-125-AC-04: デスクトップで列間隔が 5px 以下', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWishlist(page);
    await expect(grid(page)).toBeVisible();

    const colGap = await grid(page).evaluate((el) =>
      parseFloat(getComputedStyle(el as HTMLElement).columnGap),
    );
    expect(colGap).toBeLessThanOrEqual(5);
  });
});
