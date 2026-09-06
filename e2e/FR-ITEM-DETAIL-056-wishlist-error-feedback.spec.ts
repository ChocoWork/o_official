import { expect, Page, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

// FREQ-340: ウィッシュリスト操作の失敗を無反応にせず Toast で伝える

const item = sampleItemDetail({ name: 'Wishlist Feedback Vest' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

async function openItemDetail(page: Page, wishlistPostStatus: number): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);

  await page.route('**/api/wishlist', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }

    if (method === 'POST') {
      await route.fulfill({
        status: wishlistPostStatus,
        contentType: 'application/json',
        body: JSON.stringify(
          wishlistPostStatus === 201
            ? { id: 'wishlist-1', item_id: item.id }
            : { error: 'Failed to add to wishlist' },
        ),
      });
      return;
    }

    await route.fallback();
  });

  await page.goto(`/item/${item.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * そのビューポートで実際に押せるウィッシュリストボタン。
 * md 未満は ADD TO CART の右隣、md 以上は商品名の右のアイコン（FREQ-299）。
 */
function wishlistButton(page: Page, viewportName: string) {
  const scope =
    viewportName === 'mobile'
      ? page.getByTestId('item-actions-main')
      : page.getByTestId('item-wishlist-icon');

  return scope.getByRole('button', { name: 'Add to wishlist' });
}

function toast(page: Page) {
  return page.getByTestId('item-wishlist-toast');
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-ITEM-DETAIL-056 ウィッシュリスト失敗の通知 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-340-AC-01: 追加に失敗するとエラーが表示され、アイコンは未登録のまま', async ({
      page,
    }) => {
      await openItemDetail(page, 500);

      await wishlistButton(page, viewport.name).click();

      await expect(toast(page)).toBeVisible();
      await expect(toast(page)).toHaveText(/ウィッシュリストに追加できません/);
      await expect(toast(page)).toHaveAttribute('role', 'alert');
      await expect(
        wishlistButton(page, viewport.name).locator('.ri-bookmark-line'),
      ).toBeVisible();
    });

    test('FREQ-340-AC-02: 閉じるとエラー表示が消える', async ({ page }) => {
      await openItemDetail(page, 500);

      await wishlistButton(page, viewport.name).click();
      await expect(toast(page)).toBeVisible();

      await toast(page).getByRole('button', { name: '閉じる' }).click();

      await expect(toast(page)).toHaveCount(0);
    });

    test('FREQ-340-AC-04: 成功時はエラーを表示しない', async ({ page }) => {
      await openItemDetail(page, 201);

      await wishlistButton(page, viewport.name).click();

      await expect(
        wishlistButton(page, viewport.name).locator('.ri-bookmark-fill'),
      ).toBeVisible();
      await expect(toast(page)).toHaveCount(0);
    });
  });
}

test.describe('FR-ITEM-DETAIL-056 固定フッターからの操作 (mobile)', () => {
  // 本体 CTA を画面外へ押し出して固定フッターを出す（FR-ITEM-DETAIL-006 と同じ手）
  const VIEWPORT_HEIGHT = 500;
  test.use({ viewport: { width: 390, height: VIEWPORT_HEIGHT } });

  test('FREQ-340-AC-03: 固定フッターから押してもエラーが重ならずに見える', async ({
    page,
  }) => {
    await openItemDetail(page, 500);

    const footer = page.getByTestId('item-actions-fixed');
    await expect(footer).toBeVisible();

    await footer.getByRole('button', { name: 'Add to wishlist' }).click();
    await expect(toast(page)).toBeVisible();

    const toastBox = await toast(page).boundingBox();
    const footerBox = await footer.boundingBox();
    expect(toastBox).not.toBeNull();
    expect(footerBox).not.toBeNull();

    // ビューポート内に収まっている
    expect(toastBox!.y).toBeGreaterThanOrEqual(0);
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
    // 固定フッターと重ならない
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(footerBox!.y);
  });
});
