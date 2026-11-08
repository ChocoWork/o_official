import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-004/006/007/008 item detail actions and stock', () => {
  test('未選択エラー・在庫表示・モバイル固定CTA・カート追加を確認する', async ({ page }) => {
    const item = sampleItemDetail({ stockStatus: 'low_stock', stock_quantity: 2 });
    const cartMocks = await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/item/101');

    // FREQ-400: 商品単位の在庫表示は廃止。組み合わせを選ぶまでは納期も出さない。
    await expect(page.getByTestId('stock-status')).toHaveCount(0);
    await expect(page.getByTestId('delivery-note')).toHaveCount(0);

    const fixedActions = page.getByTestId('item-actions-fixed');
    const selectOptions = fixedActions.getByRole('button', { name: 'SELECT OPTIONS' });
    await expect(selectOptions).toBeEnabled();
    await selectOptions.click();

    const sheet = page.getByTestId('item-option-sheet');
    const options = sheet.getByTestId('item-sheet-options');
    const addToCart = sheet.getByRole('button', { name: 'ADD TO CART' });
    await expect(options).toBeVisible();
    // FREQ-345/347: シート内では COLOR / SIZE の両方を選ぶまで押せない。
    await expect(addToCart).toBeDisabled();
    await options.getByRole('button', { name: 'Black', exact: true }).click();
    await expect(addToCart).toBeDisabled();
    await expect(sheet.getByTestId('delivery-note')).toHaveCount(0);
    await options.getByRole('button', { name: 'M', exact: true }).click();
    await expect(sheet.getByTestId('delivery-note')).toHaveText('在庫あり・3〜7営業日で発送');
    await expect(sheet.getByTestId('delivery-note')).toHaveAttribute('data-in-stock', 'true');
    await expect(addToCart).toBeEnabled();
    await addToCart.click();

    await expect.poll(() => cartMocks.postBodies.length).toBe(1);
    // カートの窓口へはバリアントの番号を送る。Black / M の番号は sampleItemDetail の variantAvailability の 1012
    expect(cartMocks.postBodies[0]).toEqual({ items: [{ id: 1012, quantity: 1 }] });

    await expect(sheet).toBeHidden();
    await expect(fixedActions.getByRole('button', { name: 'Add to wishlist' })).toBeVisible();
    await expect(fixedActions.getByRole('button', { name: 'ADDED' })).toBeVisible();
  });

  // FREQ-400: 在庫の有無は「買えるか」ではなく「納期」を分ける。在庫が無くても受注生産として買える。
  test('すぐ出せる在庫が無い組み合わせでも、受注生産として買える', async ({ page }) => {
    const madeToOrderItem = sampleItemDetail({
      sizes: ['M'],
      madeToOrder: true,
      variantAvailability: [{ colorName: 'Black', sizeLabel: 'M', inStock: false, variantId: 1012 }],
    });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, madeToOrderItem, []);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/item/101');

    // Black / Ivory の複数色なので、Black を選ぶ前に納期を断定しない。
    await expect(page.getByTestId('delivery-note')).toHaveCount(0);
    await page.getByTestId('item-spec-table').getByRole('button', { name: 'Black', exact: true }).click();
    await expect(page.getByTestId('delivery-note')).toHaveText('受注生産・数週間〜2ヶ月');
    await expect(page.getByRole('button', { name: 'SOLD OUT' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ADD TO CART' }).first()).toBeEnabled();
  });

  test('モバイルでは固定CTAから選択シートを開ける', async ({ page }) => {
    const item = sampleItemDetail({ sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/item/101');

    await expect(page.getByTestId('item-actions-main')).toBeHidden();
    const fixedActions = page.getByTestId('item-actions-fixed');
    await expect(fixedActions).toBeVisible();
    await fixedActions.getByRole('button', { name: 'SELECT OPTIONS' }).click();
    await expect(page.getByTestId('item-sheet-options')).toBeVisible();
    await expect(page.getByTestId('item-option-sheet').getByRole('button', { name: 'ADD TO CART' })).toBeDisabled();
  });

  test('モバイル固定CTAはスクロール位置によらず表示され選択シートの選択を反映する', async ({ page }) => {
    const item = sampleItemDetail({ sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/item/101');
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '1000px';
      document.body.append(spacer);
    });

    const mainActions = page.getByTestId('item-actions-main');
    const fixedActions = page.getByTestId('item-actions-fixed');

    await expect(mainActions).toBeHidden();
    await expect(fixedActions).toBeVisible();

    await page.getByTestId('item-detail-information').scrollIntoViewIfNeeded();
    await expect(fixedActions).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(fixedActions).toBeInViewport();

    await fixedActions.getByRole('button', { name: 'SELECT OPTIONS' }).click();
    const sheet = page.getByTestId('item-option-sheet');
    await expect(sheet.getByTestId('item-sheet-options')).toBeVisible();
    await sheet.getByRole('button', { name: 'Black', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'ADD TO CART' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(fixedActions.getByRole('button', { name: 'ADD TO CART' })).toBeEnabled();

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(mainActions).toBeHidden();
    await expect(fixedActions).toBeVisible();
  });
});
