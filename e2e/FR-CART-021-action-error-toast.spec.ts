import { expect, Page, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

// FREQ-342: /cart の操作失敗を alert() ではなく商品詳細と同じ Toast で伝える
// FREQ-376-AC-03: その Toast の中に読み上げ領域を入れ子にしない

const cartItem = sampleCartItem();

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/** alert() が出たら握りつぶさず記録する。Toast へ置き換わったことを確かめるため。 */
async function trackDialogs(page: Page): Promise<string[]> {
  const messages: string[] = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.dismiss();
  });
  return messages;
}

async function openCart(
  page: Page,
  options: { wishlistPostStatus?: number; cartDeleteStatus?: number } = {},
): Promise<string[]> {
  const { wishlistPostStatus = 201, cartDeleteStatus = 200 } = options;
  const dialogs = await trackDialogs(page);

  await mockCartApis(page, [cartItem]);

  await page.route('**/api/wishlist', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }

    await route.fulfill({
      status: wishlistPostStatus,
      contentType: 'application/json',
      body: JSON.stringify(
        wishlistPostStatus === 201
          ? { id: 'wl-1', item_id: cartItem.item_id }
          : { error: 'failed' },
      ),
    });
  });

  // mockCartApis のあとに登録して、削除（数量0の変更）だけ上書きする。
  // 削除は POST /api/cart/change の数量0なので、数量1以上の変更と、成功させる時は mockCartApis に任せる
  await page.route('**/api/cart/change', async (route) => {
    const body = route.request().postDataJSON() as { quantity?: number } | null;
    if (cartDeleteStatus === 200 || body?.quantity !== 0) {
      await route.fallback();
      return;
    }

    // 窓口の断りの形（Shopify の Ajax Cart API と同じ）。画面は description をそのまま通知に出す
    await route.fulfill({
      status: cartDeleteStatus,
      contentType: 'application/json',
      body: JSON.stringify({ status: cartDeleteStatus, message: 'Cart Error', description: '削除に失敗しました' }),
    });
  });

  await page.goto('/cart');
  await expect(page.getByRole('button', { name: 'ウィッシュリストに追加' })).toBeVisible();

  return dialogs;
}

function toast(page: Page) {
  return page.getByTestId('cart-action-toast');
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-CART-021 操作失敗の通知 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-342-AC-01: ウィッシュリスト操作の失敗が Toast で出る', async ({ page }) => {
      const dialogs = await openCart(page, { wishlistPostStatus: 500 });

      await page.getByRole('button', { name: 'ウィッシュリストに追加' }).click();

      await expect(toast(page)).toBeVisible();
      await expect(toast(page)).toHaveText(/ウィッシュリストに追加できません/);
      await expect(toast(page)).toHaveAttribute('role', 'alert');
      expect(dialogs).toEqual([]);
    });

    test('FREQ-376-AC-03: Toast の中に読み上げ領域を入れ子にしない', async ({ page }) => {
      await openCart(page, { wishlistPostStatus: 500 });

      await page.getByRole('button', { name: 'ウィッシュリストに追加' }).click();

      await expect(toast(page)).toHaveAttribute('role', 'alert');
      // 外側の読み上げ領域の中に、さらに読み上げ領域を置かない（二重に読まれないよう）
      await expect(toast(page).locator('[role="status"], [role="alert"], [aria-live]')).toHaveCount(0);
    });

    test('FREQ-342-AC-02: カート削除の失敗も同じ Toast で出る', async ({ page }) => {
      const dialogs = await openCart(page, { cartDeleteStatus: 500 });

      await page.getByRole('button', { name: 'カートから削除' }).click();

      await expect(toast(page)).toBeVisible();
      await expect(toast(page)).toHaveText(/削除に失敗しました/);
      expect(dialogs).toEqual([]);
    });

    test('FREQ-342-AC-03: 閉じると通知が消える', async ({ page }) => {
      await openCart(page, { wishlistPostStatus: 500 });

      await page.getByRole('button', { name: 'ウィッシュリストに追加' }).click();
      await expect(toast(page)).toBeVisible();

      await toast(page).getByRole('button', { name: '閉じる' }).click();

      await expect(toast(page)).toHaveCount(0);
    });
  });
}
