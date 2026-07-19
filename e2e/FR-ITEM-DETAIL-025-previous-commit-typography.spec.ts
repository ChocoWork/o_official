import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

const item = sampleItemDetail({
  name: 'Short Sleeveless Vest',
  price: 24800,
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function itemTypography(page: Page) {
  return page.evaluate(() => {
    const title = document.querySelector('h1');
    const price = document.querySelector('[data-testid="item-detail-price"]');
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);

    probe.style.fontSize = 'var(--lk-size-3xl)';
    const previousItemNameSize = getComputedStyle(probe).fontSize;
    probe.style.fontSize = '1rem';
    const previousPriceSize = getComputedStyle(probe).fontSize;
    probe.remove();

    return {
      itemNameSize: title ? getComputedStyle(title).fontSize : null,
      priceSize: price ? getComputedStyle(price).fontSize : null,
      previousItemNameSize,
      previousPriceSize,
    };
  });
}

for (const viewport of [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-025 previous commit typography (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-163: ITEM name and price use their previous-commit sizes', async ({
      page,
    }) => {
      await openItemDetail(page);

      const typography = await itemTypography(page);
      expect(typography.itemNameSize).toBe(typography.previousItemNameSize);
      expect(typography.priceSize).toBe(typography.previousPriceSize);
    });
  });
}
