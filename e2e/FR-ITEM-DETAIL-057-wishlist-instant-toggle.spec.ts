import { expect, Page, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

// FREQ-341: 解除を追加と同じ 1 往復にし、通信を待たずに表示へ反映する

const item = sampleItemDetail({ name: 'Instant Toggle Coat' });
const ROW_ID = 'wl-1';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type WishlistMock = {
  /** マウント時の一覧取得を含む GET の回数。解除で増えなければ往復が減っている。 */
  getCount: () => number;
  deletedIds: string[];
};

async function openWishlistedItem(
  page: Page,
  options: { deleteStatus?: number; deleteDelayMs?: number } = {},
): Promise<WishlistMock> {
  const { deleteStatus = 200, deleteDelayMs = 0 } = options;
  let getCount = 0;
  const deletedIds: string[] = [];

  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);

  await page.route('**/api/wishlist', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    getCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: ROW_ID, item_id: item.id, added_at: '2026-01-01T00:00:00Z' }]),
    });
  });

  await page.route('**/api/wishlist/*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }

    deletedIds.push(route.request().url().split('/').pop() ?? '');
    if (deleteDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, deleteDelayMs));
    }
    await route.fulfill({
      status: deleteStatus,
      contentType: 'application/json',
      body: JSON.stringify(deleteStatus === 200 ? { success: true } : { error: 'failed' }),
    });
  });

  await page.goto(`/item/${item.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  return { getCount: () => getCount, deletedIds };
}

function wishlistButton(page: Page, viewportName: string) {
  const scope =
    viewportName === 'mobile'
      ? page.getByTestId('item-actions-main')
      : page.getByTestId('item-wishlist-icon');

  return scope.getByRole('button', { name: 'Add to wishlist' });
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-ITEM-DETAIL-057 解除の往復削減 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-341-AC-01: 解除は一覧の取り直しを挟まず DELETE 1 回で終わる', async ({
      page,
    }) => {
      const mock = await openWishlistedItem(page);
      const button = wishlistButton(page, viewport.name);
      await expect(button.locator('.ri-bookmark-fill')).toBeVisible();
      const getCountBeforeToggle = mock.getCount();

      await button.click();

      await expect(button.locator('.ri-bookmark-line')).toBeVisible();
      expect(mock.deletedIds).toEqual([ROW_ID]);
      expect(mock.getCount()).toBe(getCountBeforeToggle);
    });

    test('FREQ-341-AC-02: 通信の完了を待たずにアイコンが解除表示になる', async ({
      page,
    }) => {
      await openWishlistedItem(page, { deleteDelayMs: 3000 });
      const button = wishlistButton(page, viewport.name);
      await expect(button.locator('.ri-bookmark-fill')).toBeVisible();

      await button.click();

      // DELETE は 3 秒返らないが、表示はすぐ解除済みになる
      await expect(button.locator('.ri-bookmark-line')).toBeVisible({ timeout: 1000 });
    });

    test('FREQ-341-AC-03: 解除に失敗したらアイコンが戻り通知が出る', async ({ page }) => {
      await openWishlistedItem(page, { deleteStatus: 500 });
      const button = wishlistButton(page, viewport.name);

      await button.click();

      await expect(page.getByTestId('item-wishlist-toast')).toBeVisible();
      await expect(page.getByTestId('item-wishlist-toast')).toHaveText(
        /ウィッシュリストから削除できません/,
      );
      await expect(button.locator('.ri-bookmark-fill')).toBeVisible();
    });

    test('FREQ-341-AC-04: 行が既に無い（404）ときは解除済みとして扱う', async ({ page }) => {
      await openWishlistedItem(page, { deleteStatus: 404 });
      const button = wishlistButton(page, viewport.name);

      await button.click();

      await expect(button.locator('.ri-bookmark-line')).toBeVisible();
      await expect(page.getByTestId('item-wishlist-toast')).toHaveCount(0);
    });
  });
}
