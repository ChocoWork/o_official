import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-180: PC 表示（lg以上）でメイン画像が右のテキスト列にかぶらないよう、
// 画像枠を幅基準（列内に収まる）に変更し、aspect 2/3 を維持する。

const LG_VIEWPORTS = [
  { name: 'lg-min (iPad Pro 縦)', width: 1024, height: 1366 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-DETAIL-012 PC 表示で画像とテキストが重ならない', () => {
  for (const vp of LG_VIEWPORTS) {
    test(`${vp.name} 画像枠がテキスト列に重ならず aspect 2/3 を保つ`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      const frame = page.locator(
        '[data-testid="look-detail-main-image-frame"]',
      );
      await expect(frame).toBeVisible();

      const frameBox = await frame.boundingBox();
      const headingBox = await page
        .getByRole('heading', { level: 1 })
        .boundingBox();
      expect(frameBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      if (!frameBox || !headingBox) return;

      // AC-01: 画像枠の右端がテキスト列（h1）の左端より左にあること
      expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(headingBox.x);

      // AC-02: 画像枠の縦横比が 2/3（±2%）
      const ratio = frameBox.width / frameBox.height;
      expect(ratio).toBeGreaterThan((2 / 3) * 0.98);
      expect(ratio).toBeLessThan((2 / 3) * 1.02);
    });
  }

  test('tablet（768px）ではメイン画像枠が表示されない（カルーセルのまま）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoFirstLookDetail(page);

    await expect(
      page.locator('[data-testid="look-detail-main-image-frame"]'),
    ).toBeHidden();
    await expect(
      page.locator('[data-testid="look-detail-tablet-carousel"]'),
    ).toBeVisible();
  });
});
