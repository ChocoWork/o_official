import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-004/006/007/008 item detail actions and stock', () => {
  test('未選択エラー・在庫表示・モバイル固定CTA・カート追加を確認する', async ({ page }) => {
    const item = sampleItemDetail({ stockStatus: 'low_stock', stock_quantity: 2 });
    const cartMocks = await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/item/101');

    await expect(page.getByTestId('stock-status')).toHaveText('残りわずか');

    await page.getByRole('button', { name: 'ADD TO CART' }).first().click();
    await expect(page.getByText('すべてのオプションを選択してください')).toBeVisible();

    await page.getByRole('button', { name: 'M', exact: true }).click();
    await page.getByRole('button', { name: 'ADD TO CART' }).first().click();

    await expect.poll(() => cartMocks.postBodies.length).toBe(1);
    expect(cartMocks.postBodies[0]).toMatchObject({
      item_id: 101,
      quantity: 1,
      color: 'Black',
      size: 'M',
    });

    await expect(page.getByRole('button', { name: 'Add to wishlist' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ADD TO CART' }).last()).toBeVisible();
  });

  test('売り切れ商品では SOLD OUT 表示と disabled 状態になる', async ({ page }) => {
    const soldOutItem = sampleItemDetail({ stockStatus: 'sold_out', stock_quantity: 0, sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, soldOutItem, []);

    await page.goto('/item/101');

    await expect(page.getByTestId('stock-status')).toHaveText('SOLD OUT');
    await expect(page.getByRole('button', { name: 'SOLD OUT' }).first()).toBeDisabled();
  });

  test('Observerの初回通知を待たず本体CTAが画面外なら固定CTAを表示する', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'IntersectionObserver', {
        configurable: true,
        value: class {
          observe() {}
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        },
      });
    });

    const item = sampleItemDetail({ sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/item/101');

    await expect(page.getByTestId('item-actions-main')).not.toBeInViewport();
    await expect(page.getByTestId('item-actions-fixed')).toBeVisible();
  });

  test('モバイル固定CTAは本体CTAより上にいる間だけ表示される', async ({ page }) => {
    const item = sampleItemDetail({ sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/item/101');
    await page.addStyleTag({
      content: "body::after { content: ''; display: block; height: 1000px; }",
    });

    const mainActions = page.getByTestId('item-actions-main');
    const fixedActions = page.getByTestId('item-actions-fixed');

    await expect(mainActions).not.toBeInViewport();
    await expect(fixedActions).toBeVisible();

    await mainActions.scrollIntoViewIfNeeded();
    await expect(mainActions).toBeInViewport();
    await expect(fixedActions).toHaveCount(0);

    await mainActions.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + rect.bottom + window.innerHeight);
    });
    await expect(mainActions).not.toBeInViewport();
    await expect
      .poll(() => mainActions.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBeLessThan(0);
    await expect(fixedActions).toHaveCount(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(mainActions).not.toBeInViewport();
    await expect(fixedActions).toBeVisible();
  });
});
