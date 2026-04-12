import { test, expect } from '@playwright/test';

test.describe('FR-HOME-006 / 007 / 011 home quality checks', () => {
  test('sets home metadata, prioritizes hero image, and keeps accessible structure', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveTitle('Le Fil des Heures');

    const metaDescription = page.locator('meta[name="description"]');
    await expect(metaDescription).toHaveAttribute(
      'content',
      'Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。',
    );

    const heroImage = page.locator('img[alt="Hero Background"]');
    await expect(heroImage).toHaveCount(1);
    await expect(heroImage).toHaveAttribute('sizes', '100vw');
    await expect(heroImage).not.toHaveAttribute('loading', 'lazy');

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('section.relative div[aria-hidden="true"].bg-gradient-to-b')).toBeVisible();

    const aboutSection = page.locator('#about');
    await expect(aboutSection).toBeVisible();

    const aboutTextColor = await aboutSection.locator('p').first().evaluate((element) => {
      return window.getComputedStyle(element).color;
    });
    expect(aboutTextColor).toBe('rgb(71, 71, 71)');
  });
});
