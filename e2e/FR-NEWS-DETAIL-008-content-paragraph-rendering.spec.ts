import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-008 content paragraph rendering', () => {
  test('本文を段落構造でレンダリングする', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    const paragraphs = page.locator('main p, p');
    await expect(paragraphs.first()).toBeVisible();
    await expect(paragraphs).toHaveCount(await paragraphs.count());
    expect(await paragraphs.count()).toBeGreaterThan(0);
  });
});
