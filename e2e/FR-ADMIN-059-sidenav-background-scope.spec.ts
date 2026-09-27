import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-402: 管理画面の左の背景パネル（サイドナビの下地）は、サイドナビが出る管理トップだけに置く。
// このパネルは pointer-events: none で当たり判定に出ず、横スクロールも起こさないため、
// サイドナビの無いフォーム画面では「内容の左 224px が静かに隠れる」状態になっていた。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const SIDENAV_BACKGROUND = '[data-admin-sidenav-background]';

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // パネルは lg（1024px）以上でだけ出る作り。desktop だけが実際の検査になる。
    const showsPanel = viewport.width >= 1024;

    test('FREQ-402-AC-01: 管理トップには背景パネルがある', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin');

      const panel = page.locator(SIDENAV_BACKGROUND);
      await expect(panel).toHaveCount(1);
      if (showsPanel) {
        await expect(panel).toBeVisible();
      }
    });

    test('FREQ-402-AC-02: 商品の新規作成画面には背景パネルが無い', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByLabel('PRODUCT DETAILS')).toBeVisible();
      await expect(page.locator(SIDENAV_BACKGROUND)).toHaveCount(0);
    });

    /**
     * パネルが戻ると、フォームの左端がその下に入って読めなくなる。
     * 当たり判定に出ないので、要素の座標ではなくパネルの有無で確かめる。
     */
    test('FREQ-402-AC-03: フォームの左端が画面左 224px に入っていても隠されない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      const form = page.locator('form.item-form');
      await expect(form).toBeVisible();

      const formLeft = await form.evaluate((el) => el.getBoundingClientRect().left);
      const panelCount = await page.locator(SIDENAV_BACKGROUND).count();

      // 左端がパネルの幅（224px）の内側にあるなら、パネルが無いことが条件
      if (formLeft < 224) {
        expect(panelCount).toBe(0);
      }
    });

    test('FREQ-402-AC-04: 横スクロールが出ない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');
      await expect(page.getByLabel('PRODUCT DETAILS')).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
