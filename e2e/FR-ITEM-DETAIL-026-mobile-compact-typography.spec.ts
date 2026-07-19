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

async function typographyAndSpacing(
  page: Page,
  titleToken: string,
  priceToken: string,
) {
  return page.evaluate(
    ({ titleToken, priceToken }) => {
      const title = document.querySelector('h1');
      const price = document.querySelector('[data-testid="item-detail-price"]');
      const priceRow = document.querySelector(
        '[data-testid="item-detail-price-row"]',
      );
      const identity = document.querySelector(
        '[data-testid="item-detail-identity"]',
      );
      const description = document.querySelector(
        '[data-testid="item-detail-description"]',
      );
      const layout = document.querySelector('[data-testid="item-detail-layout"]');
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);

      probe.style.fontSize = titleToken;
      const expectedTitleSize = getComputedStyle(probe).fontSize;
      probe.style.fontSize = priceToken;
      const expectedPriceSize = getComputedStyle(probe).fontSize;
      probe.remove();

      return {
        titleSize: title ? getComputedStyle(title).fontSize : null,
        priceSize: price ? getComputedStyle(price).fontSize : null,
        priceRowMarginTop: priceRow
          ? getComputedStyle(priceRow).marginTop
          : null,
        identityToDescriptionGap:
          identity && description
            ? description.getBoundingClientRect().top -
              identity.getBoundingClientRect().bottom
            : null,
        layoutRowGap: layout ? getComputedStyle(layout).rowGap : null,
        expectedTitleSize,
        expectedPriceSize,
      };
    },
    { titleToken, priceToken },
  );
}

// FREQ-165 がモバイルの価格サイズ・余白を置換したため、
// モバイルは FR-ITEM-DETAIL-027 で検証し、本テストは tablet / desktop の維持のみ検証する
for (const viewport of [
  {
    name: 'tablet',
    width: 768,
    height: 1024,
    titleToken: 'var(--lk-size-3xl)',
    priceToken: '1rem',
    priceRowMarginTop: '8px',
    identityToDescriptionGap: 20,
    layoutRowGap: '0px',
  },
  {
    name: 'desktop',
    width: 1280,
    height: 800,
    titleToken: 'var(--lk-size-3xl)',
    priceToken: '1rem',
    priceRowMarginTop: '8px',
    identityToDescriptionGap: 20,
    layoutRowGap: '0px',
  },
]) {
  test.describe(`FR-ITEM-DETAIL-026 compact mobile typography (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-164: type and surrounding spacing change on mobile only', async ({
      page,
    }) => {
      await openItemDetail(page);

      const result = await typographyAndSpacing(
        page,
        viewport.titleToken,
        viewport.priceToken,
      );
      expect(result.titleSize).toBe(result.expectedTitleSize);
      expect(result.priceSize).toBe(result.expectedPriceSize);
      expect(result.priceRowMarginTop).toBe(viewport.priceRowMarginTop);
      expect(result.identityToDescriptionGap).toBeCloseTo(
        viewport.identityToDescriptionGap,
        0,
      );
      expect(result.layoutRowGap).toBe(viewport.layoutRowGap);
    });
  });
}
