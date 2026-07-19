import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-178: LOOK詳細ページの通常表示から「Back to Lookbook」リンクを削除する。
// Look not found ページの戻りリンクは唯一の復帰導線のため維持する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-010 Back to Lookbook リンクの削除', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 通常表示に Back to Lookbook が表示されない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      // AC-01: 通常表示に Back to Lookbook リンクが無い
      await expect(
        page.getByRole('link', { name: /Back to Lookbook/i }),
      ).toHaveCount(0);
    });
  }

  test('存在しない LOOK では Back to Lookbook が表示される', async ({
    page,
  }) => {
    await page.goto('/look/999999');

    // AC-02: not found 表示では戻りリンクを維持
    const backLink = page.getByRole('link', { name: /Back to Lookbook/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/look');
  });
});
