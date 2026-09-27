import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-311: ITEM一覧カードの公開状態を BASIC TAGS（角丸なし・2xs）、
// カテゴリを ROUNDED TAGS（角丸・subtle・2xs）にする。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'pc-l', width: 1920, height: 1080 },
  { name: '4k', width: 3840, height: 2160 },
];

// 2xs は --lk-size-md（約15px）を1段ずつ縮めた値なので必ず 13px を下回る。
const TAG_FONT_SIZE_MAX = 13;

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
  await mockAdminBackgroundApis(page);
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

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-311-AC-01: 公開状態が角丸なしの BASIC TAG で 13px 未満', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      const grid = page.getByTestId('admin-item-grid');
      await expect(grid).toBeVisible();

      const statusTag = grid.locator('[data-ui-tag-label]').first();
      await expect(statusTag).toHaveText('公開中');

      const style = await statusTag.evaluate((el) => {
        const s = getComputedStyle(el);
        return { radius: s.borderTopLeftRadius, fontSize: parseFloat(s.fontSize) };
      });

      expect(style.radius).toBe('0px');
      expect(style.fontSize).toBeLessThan(TAG_FONT_SIZE_MAX);
    });

    test('FREQ-311-AC-02: カテゴリが ROUNDED TAG で公開状態と同じ文字サイズ', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      const grid = page.getByTestId('admin-item-grid');
      await expect(grid).toBeVisible();

      const tags = grid.locator('[data-ui-tag-label]');
      const categoryTag = tags.nth(1);
      await expect(categoryTag).toHaveText('TOPS');

      const styles = await grid.evaluate((el) => {
        const list = el.querySelectorAll('[data-ui-tag-label]');
        const read = (node: Element) => {
          const s = getComputedStyle(node);
          return { radius: s.borderTopLeftRadius, fontSize: s.fontSize };
        };
        return { status: read(list[0]), category: read(list[1]) };
      });

      expect(styles.category.radius).toBe('9999px');
      expect(styles.category.fontSize).toBe(styles.status.fontSize);
    });

    test('FREQ-311-AC-03: 長いカテゴリでもタグがカードからはみ出さない', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      const grid = page.getByTestId('admin-item-grid');
      await expect(grid).toBeVisible();

      const overflow = await grid.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-ui-card]'));
        return cards.map((card) => {
          const cardRight = card.getBoundingClientRect().right;
          const tags = Array.from(card.querySelectorAll('[data-ui-tag-label]'));
          const worst = Math.max(
            ...tags.map((tag) => tag.getBoundingClientRect().right - cardRight),
          );
          return worst;
        });
      });

      for (const delta of overflow) {
        expect(delta).toBeLessThanOrEqual(1);
      }
    });
  });
}
