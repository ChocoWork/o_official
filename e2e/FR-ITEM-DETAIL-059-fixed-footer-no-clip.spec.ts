import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-346: モバイル固定フッターが横スクロールバーに下部を削られないこと、
// 左右余白が本文と揃っていること

const item = sampleItemDetail();

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('FR-ITEM-DETAIL-059 モバイル固定フッターの欠けと左右余白', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('FREQ-346-AC-01: 横スクロールが発生しない', async ({ page }) => {
    await openItemDetail(page);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

});

// 本体 CTA が画面外（下）にある間だけ固定フッターが出るため、
// 本体 CTA が初期表示で収まらない高さで検証する
test.describe('FR-ITEM-DETAIL-059 固定フッター表示時', () => {
  test.use({ viewport: { width: 390, height: 500 } });

  test('FREQ-346-AC-02: 固定フッターの下端が viewport 下端と一致する', async ({
    page,
  }) => {
    await openItemDetail(page);
    await expect(page.getByTestId('item-actions-fixed')).toBeVisible();

    const gap = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="item-actions-fixed"]')!;
      return (
        document.documentElement.clientHeight - el.getBoundingClientRect().bottom
      );
    });
    expect(gap).toBeCloseTo(0, 0);
  });

  test('FREQ-346-AC-03: 固定フッターの左右余白が本文と一致する', async ({
    page,
  }) => {
    await openItemDetail(page);
    await expect(page.getByTestId('item-actions-fixed')).toBeVisible();

    const padding = await page.evaluate(() => {
      const main = getComputedStyle(document.querySelector('main')!);
      const fixed = getComputedStyle(document.querySelector('[data-testid="item-actions-fixed"]')!);
      return { main: parseFloat(main.paddingLeft), fixed: parseFloat(fixed.paddingLeft) };
    });
    expect(padding.fixed).toBeCloseTo(padding.main, 0);
  });
});
