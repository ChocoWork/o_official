import { test, expect } from '@playwright/test';

test.describe('FR-HOME-007 hero image preload', () => {
  test('FR-HOME-007-AC-01 preloads hero image for LCP optimization', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const preload = page.locator('head link[rel="preload"][as="image"][href*="mainphoto.png"]');
    await expect(preload).toHaveCount(1);

    // ヒーローの img は遅延読み込み（loading="lazy"）でない
    const heroImage = page.getByRole('img', { name: /メインビジュアル/ });
    await expect(heroImage).toHaveCount(1);
    await expect(heroImage).not.toHaveAttribute('loading', 'lazy');
  });
});
