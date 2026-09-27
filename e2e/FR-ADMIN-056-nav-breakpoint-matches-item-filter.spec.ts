import { test, expect, Page } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-315: Admin のタブが「上部バー ↔ 左サイドナビ」に切り替わる幅を、
// 公開 ITEM 一覧のフィルターが「上部ボタン ↔ 左サイドバー」に切り替わる幅
// （PublicItemGrid の hidden lg:flex / lg:hidden ＝ lg）と一致させる。
// 境界そのものを見るため 1023 / 1024 を挟む。
const cases = [
  { name: 'tablet', width: 768, expectSide: false },
  { name: 'lg 直前', width: 1023, expectSide: false },
  { name: 'lg 直後', width: 1024, expectSide: true },
  { name: 'desktop', width: 1280, expectSide: true },
];

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
      body: JSON.stringify({
        data: [
          {
            id: 1,
            name: 'テスト商品 1',
            category: 'TOPS',
            price: 24000,
            image_url: '/placeholder.png',
            status: 'published',
          },
        ],
      }),
    }),
  );
}

/** Admin のナビが本文の左にあるか（false なら本文の上）。 */
async function isAdminNavOnSide(page: Page): Promise<boolean> {
  await mockAdminApis(page);
  await page.goto('/admin?tab=ITEM');

  const nav = page.getByRole('navigation', { name: '管理メニュー' });
  await expect(nav).toBeVisible();
  await expect(page.getByTestId('admin-content-column')).toBeVisible();

  return page.evaluate(() => {
    const nav = document.querySelector(
      'nav[aria-label="管理メニュー"]',
    ) as HTMLElement;
    const content = document.querySelector(
      '[data-testid="admin-content-column"]',
    ) as HTMLElement;
    const navRect = nav.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    return navRect.right <= contentRect.left + 1;
  });
}

/** 公開 ITEM 一覧のフィルターがサイドバーとして出ているか（false なら上部ボタン）。 */
async function isItemFilterOnSide(page: Page): Promise<boolean> {
  await gotoItemList(page);

  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeAttached();

  return sidebar.evaluate((el) => (el as HTMLElement).offsetParent !== null);
}

for (const testCase of cases) {
  test.describe(`${testCase.name}（${testCase.width}px）`, () => {
    test.use({ viewport: { width: testCase.width, height: 900 } });

    test('FREQ-315-AC-01: Admin ナビと ITEM フィルターの切り替わり方が一致する', async ({
      page,
    }) => {
      const itemFilterOnSide = await isItemFilterOnSide(page);
      const adminNavOnSide = await isAdminNavOnSide(page);

      expect(itemFilterOnSide).toBe(testCase.expectSide);
      expect(adminNavOnSide).toBe(itemFilterOnSide);
    });

    test('FREQ-315-AC-02: lg 未満では Admin ナビが本文の上に積まれる', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      const nav = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(nav).toBeVisible();

      const stacked = await page.evaluate(() => {
        const nav = document.querySelector(
          'nav[aria-label="管理メニュー"]',
        ) as HTMLElement;
        const content = document.querySelector(
          '[data-testid="admin-content-column"]',
        ) as HTMLElement;
        return (
          nav.getBoundingClientRect().bottom <=
          content.getBoundingClientRect().top + 1
        );
      });

      expect(stacked).toBe(!testCase.expectSide);
    });

    test('FREQ-315-AC-03: 横スクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');
      await expect(
        page.getByRole('navigation', { name: '管理メニュー' }),
      ).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth > root.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
