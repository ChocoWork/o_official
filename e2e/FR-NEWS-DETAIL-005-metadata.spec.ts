import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-005 metadata', () => {
  test('generateMetadataでtitleとdescriptionを設定する', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    const title = await page.title();
    expect(title.trim().length).toBeGreaterThan(0);
    expect(title).toContain('NEWS');

    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect((description ?? '').trim().length).toBeGreaterThan(0);
  });
});
