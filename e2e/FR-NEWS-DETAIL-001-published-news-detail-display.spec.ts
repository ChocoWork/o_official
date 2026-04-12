import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-001 published news detail display', () => {
  test('公開済みニュース記事の詳細ページを表示できる', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+(\?.*)?$/);
  });
});
