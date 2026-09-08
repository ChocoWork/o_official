import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-347: モバイルの固定 CTA から選択シートを開き、往復スクロールなしで
// COLOR / SIZE を選んでカートに入れられること

const BLACK = { hex: '#000000', name: 'Black' };
const IVORY = { hex: '#f5f5f5', name: 'Ivory' };

type CartMocks = Awaited<ReturnType<typeof mockCartApis>>;

async function openItemDetail(
  page: Page,
  overrides: Parameters<typeof sampleItemDetail>[0] = {},
): Promise<CartMocks> {
  const item = sampleItemDetail(overrides);
  const cartMocks = await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return cartMocks;
}

function fixedCta(page: Page) {
  return page.getByTestId('item-actions-fixed').getByRole('button', {
    name: /ADD TO CART|SELECT OPTIONS|SOLD OUT/,
  });
}

function sheet(page: Page) {
  return page.getByTestId('item-option-sheet');
}

// 固定 CTA は本体 CTA が画面外（下）のときだけ出るため、低い viewport で検証する
test.describe('FR-ITEM-DETAIL-060 モバイル選択シート', () => {
  test.use({ viewport: { width: 390, height: 500 } });

  test('FREQ-347-AC-01: 未選択のとき固定 CTA は押せて SELECT OPTIONS と出る', async ({
    page,
  }) => {
    await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['S', 'M'] });

    const cta = fixedCta(page);
    await expect(cta).toBeEnabled();
    await expect(cta).toHaveText(/SELECT OPTIONS/);
  });

  test('FREQ-347-AC-02: 固定 CTA を押すとシートが開き、両方選ぶとカートに入る', async ({
    page,
  }) => {
    const cartMocks = await openItemDetail(page, {
      colors: [BLACK, IVORY],
      sizes: ['S', 'M'],
    });

    await fixedCta(page).click();
    await expect(sheet(page)).toBeVisible();

    const sheetCta = sheet(page).getByRole('button', { name: /ADD TO CART/ });
    await expect(sheetCta).toBeDisabled();

    await sheet(page).getByRole('button', { name: 'Ivory' }).click();
    await sheet(page)
      .getByTestId('item-sheet-size-select')
      .getByRole('button', { name: 'M', exact: true })
      .click();
    await expect(sheetCta).toBeEnabled();

    await sheetCta.click();

    await expect.poll(() => cartMocks.postBodies.length).toBe(1);
    expect(cartMocks.postBodies[0]).toMatchObject({
      item_id: 101,
      quantity: 1,
      color: 'Ivory',
      size: 'M',
    });
    await expect(sheet(page)).toBeHidden();
  });

  test('FREQ-347-AC-03: 選択肢が各1つならシートを出さずそのままカートに入る', async ({
    page,
  }) => {
    const cartMocks = await openItemDetail(page, {
      colors: [BLACK],
      sizes: ['M'],
    });

    const cta = fixedCta(page);
    await expect(cta).toHaveText(/ADD TO CART/);
    await cta.click();

    await expect.poll(() => cartMocks.postBodies.length).toBe(1);
    expect(cartMocks.postBodies[0]).toMatchObject({ color: 'Black', size: 'M' });
    await expect(sheet(page)).toBeHidden();
  });

  test('FREQ-347-AC-04: シートは Escape と背景タップで閉じる', async ({
    page,
  }) => {
    await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['S', 'M'] });

    await fixedCta(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();

    await fixedCta(page).click();
    await expect(sheet(page)).toBeVisible();
    // 背景（シートの外）をタップ
    await page.mouse.click(195, 40);
    await expect(sheet(page)).toBeHidden();
  });

  test('FREQ-347-AC-05: シートは dialog として開き、開いている間は背景をスクロールしない', async ({
    page,
  }) => {
    await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['S', 'M'] });

    await fixedCta(page).click();
    await expect(page.getByRole('dialog')).toHaveAttribute(
      'aria-modal',
      'true',
    );
    await expect(page.getByRole('dialog')).toHaveAttribute(
      'aria-label',
      'COLOR / SIZE を選択',
    );
    expect(
      await page.evaluate(() => getComputedStyle(document.body).overflow),
    ).toBe('hidden');
  });
});

test.describe('FR-ITEM-DETAIL-060 デスクトップでは固定 CTA を出さない', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FREQ-347-AC-06: desktop では固定 CTA もシートも出ない', async ({
    page,
  }) => {
    await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['S', 'M'] });

    await expect(page.getByTestId('item-actions-fixed')).toBeHidden();
    await expect(sheet(page)).toBeHidden();
  });
});
