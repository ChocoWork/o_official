import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

const item = sampleItemDetail({
  image_url: '/original.jpg',
  image_urls: ['/original.jpg', '/mainphoto.png'],
  material: 'リネン100%',
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('FR-ITEM-DETAIL-032 description font size', () => {
  for (const viewport of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`FREQ-170: ${viewport.name}（${viewport.width}px）で説明文が1段階小さいフォントで表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      const description = page.getByTestId('item-detail-description');
      await expect(description).toBeVisible();

      // AC-01: 説明文の算出 font-size が var(--lk-size-2xs) の算出値と一致する
      const { actual, expected } = await description
        .locator('p')
        .first()
        .evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.fontSize = 'var(--lk-size-2xs)';
          el.parentElement!.appendChild(probe);
          const expectedSize = parseFloat(getComputedStyle(probe).fontSize);
          probe.remove();
          return {
            actual: parseFloat(getComputedStyle(el).fontSize),
            expected: expectedSize,
          };
        });
      expect(actual).toBeCloseTo(expected, 1);

      // AC-02: 説明文が仕様テーブルの値テキスト（--lk-size-xs）より小さい
      const materialFontSize = await page
        .getByTestId('item-material')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(actual).toBeLessThan(materialFontSize);
    });
  }
});
