import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-306: Admin の ITEM 登録フォームから PRODUCT DETAILS（素材・洗濯の情報）欄を削除し、
// 「商品情報」ラベルを PRODUCT DETAILS に変更する。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
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

  await page.route('**/api/admin/item-color-presets**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-306-AC-01: PRODUCT DETAILS（素材・洗濯の情報）の入力欄が表示されない', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByLabel('PRODUCT DETAILS')).toBeVisible();
      await expect(
        page.getByText('PRODUCT DETAILS（素材・洗濯の情報）'),
      ).toHaveCount(0);
    });

    test('FREQ-306-AC-02: 商品情報ラベルが無く PRODUCT DETAILS のテキストエリアが表示される', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByText('商品情報')).toHaveCount(0);

      const details = page.getByLabel('PRODUCT DETAILS');
      await expect(details).toBeVisible();
      expect(await details.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    });

    test('FREQ-306-AC-03: フォームのテキストエリアが1つだけ', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByLabel('PRODUCT DETAILS')).toBeVisible();
      await expect(page.locator('form textarea')).toHaveCount(1);
    });
  });
}
