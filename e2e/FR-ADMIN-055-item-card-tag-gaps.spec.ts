import { test, expect, Page } from '@playwright/test';

// FREQ-314: Admin ITEM 一覧カードの近接ラダー。
//   画像 ↔ タグ行  = --card-media-gap（font）        …別グループの境界なので最も広い
//   公開状態 ↔ カテゴリ = --card-gap（font ÷ φ）      …同じ行の別属性なので中段
// 「タグ同士 < 画像との境界」という大小関係そのものを検証する（px 直値は
// ビューポートで変わるため）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'pc-l', width: 1920, height: 1080 },
  { name: '4k', width: 3840, height: 2160 },
];

const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'];

function buildItems() {
  return CATEGORIES.map((category, index) => ({
    id: index + 1,
    name: `テスト商品 ${index + 1}`,
    category,
    price: 24000 + index * 1000,
    image_url: '/placeholder.png',
    status: index === 0 ? 'published' : 'private',
  }));
}

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );

  await page.route('**/api/admin/items', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: buildItems() }),
    }),
  );
}

async function measureCards(page: Page) {
  await mockAdminApis(page);
  await page.goto('/admin?tab=ITEM');

  const grid = page.getByTestId('admin-item-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-ui-card]').first()).toBeVisible();

  return grid.evaluate(() =>
    Array.from(document.querySelectorAll('[data-ui-card]')).map((card) => {
      const image = card.querySelector('img') as HTMLElement;
      const tagRow = card.querySelector(
        '[data-testid="admin-item-tags"]',
      ) as HTMLElement;
      const [status, category] = Array.from(
        tagRow.querySelectorAll('[data-ui-tag-label]'),
      ).map((tag) => tag.getBoundingClientRect());

      return {
        tagGap: category.left - status.right,
        mediaGap:
          tagRow.getBoundingClientRect().top -
          image.getBoundingClientRect().bottom,
      };
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-314-AC-01: 公開状態タグとカテゴリタグの間に隙間がある', async ({
      page,
    }) => {
      const cards = await measureCards(page);

      expect(cards.length).toBe(CATEGORIES.length);
      for (const card of cards) {
        expect(card.tagGap).toBeGreaterThanOrEqual(4);
      }
      // 反復：どのカードでも同じ間隔
      const [first] = cards;
      for (const card of cards) {
        expect(Math.abs(card.tagGap - first.tagGap)).toBeLessThanOrEqual(1);
      }
    });

    test('FREQ-314-AC-02: 画像とタグ行の間に隙間があり、タグ同士より広い', async ({
      page,
    }) => {
      const cards = await measureCards(page);

      expect(cards.length).toBe(CATEGORIES.length);
      for (const card of cards) {
        expect(card.mediaGap).toBeGreaterThanOrEqual(8);
        // 近接：別グループの境界はグループ内の間隔より広い
        expect(card.mediaGap).toBeGreaterThan(card.tagGap);
      }
    });
  });
}
