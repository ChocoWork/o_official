import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-006 CTAリンク', () => {
  test('COLLECTION / LOOKBOOK / CONTACT のCTAを表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('link', { name: 'COLLECTIONを見る' })).toHaveAttribute('href', '/item');
    await expect(page.getByRole('link', { name: 'LOOKBOOKを見る' })).toHaveAttribute('href', '/look');
    await expect(page.getByRole('link', { name: 'CONTACTする' })).toHaveAttribute('href', '/contact');
  });
});
