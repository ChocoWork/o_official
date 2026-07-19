import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-165: モバイルの商品名・価格をデザイン4原則で改善
// - 反復: 価格をアドホック値から LiftKit トークン var(--lk-size-md) へ
// - 対比: 商品名(2xl) > 価格(md) > 本文(xs) の階層
// - 近接: 商品名↔価格 4px（ペア） < グループ間 14px（画像↔情報欄・identity↔説明）

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
      const descriptionText = description?.querySelector('p') ?? null;
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
        bodySize: descriptionText
          ? getComputedStyle(descriptionText).fontSize
          : null,
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

for (const viewport of [
  {
    name: 'mobile',
    width: 390,
    height: 844,
    titleToken: 'var(--lk-size-2xl)',
    priceToken: 'var(--lk-size-md)',
    priceRowMarginTop: '4px',
    identityToDescriptionGap: 14,
    layoutRowGap: '14px',
  },
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
  test.describe(`FR-ITEM-DETAIL-027 mobile identity hierarchy (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-165: token-based sizes and proximity-driven spacing', async ({
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

      // 対比: 商品名 > 価格 > 本文 の3階層が成立していること
      const titlePx = parseFloat(result.titleSize ?? '0');
      const pricePx = parseFloat(result.priceSize ?? '0');
      const bodyPx = parseFloat(result.bodySize ?? '0');
      expect(titlePx).toBeGreaterThan(pricePx);
      expect(pricePx).toBeGreaterThan(bodyPx);
    });
  });
}
