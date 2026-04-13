import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-007 aria-hidden と alt改善', () => {
  test('装飾アイコンに aria-hidden=true、画像altが具体的である', async ({ page }) => {
    await page.goto('/about');

    const valuesSection = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Our Values' }) }).first();
    const icons = valuesSection.locator('i.ri-time-line, i.ri-leaf-line, i.ri-heart-line');
    await expect(icons).toHaveCount(3);

    for (let i = 0; i < 3; i += 1) {
      await expect(icons.nth(i)).toHaveAttribute('aria-hidden', 'true');
    }

    const images = page.locator('img');
    const count = await images.count();
    expect(count).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < Math.min(count, 2); i += 1) {
      const alt = await images.nth(i).getAttribute('alt');
      expect((alt ?? '').length).toBeGreaterThan(15);
    }
  });
});
