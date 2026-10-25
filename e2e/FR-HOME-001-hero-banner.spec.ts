import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-HOME-001 hero banner', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-HOME-001-AC-01 ${vp.name}(${vp.width}px) 最初の画面いっぱいにヒーローの画像が出て、ブランド名の h1 が重なる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const heroImage = page.getByRole('img', { name: /メインビジュアル/ });
      await expect(heroImage).toHaveCount(1);
      await expect(heroImage).toBeVisible();

      const heading = page.getByRole('heading', { level: 1, name: 'Le Fil des Heures' });
      await expect(heading).toBeVisible();

      const imageBox = await heroImage.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(imageBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      if (!imageBox || !headingBox) return;

      // 最初の画面の高さをヒーローの画像が満たす
      expect(imageBox.y).toBeLessThanOrEqual(1);
      expect(imageBox.height).toBeGreaterThanOrEqual(vp.height - 1);
      expect(imageBox.width).toBeGreaterThanOrEqual(vp.width - 1);

      // h1 は画像の箱の中に重なっている
      expect(headingBox.x).toBeGreaterThanOrEqual(imageBox.x);
      expect(headingBox.y).toBeGreaterThanOrEqual(imageBox.y);
      expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(imageBox.x + imageBox.width + 1);
      expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(imageBox.y + imageBox.height + 1);
    });
  }
});
