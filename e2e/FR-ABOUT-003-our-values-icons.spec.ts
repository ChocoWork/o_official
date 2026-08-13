import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-003 OUR COMMITMENTS', () => {
  test('3つのブランド原則を番号と見出し付きで表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'OUR COMMITMENTS / 取り組み' })).toBeVisible();
    await expect(page.getByText('TIMELESS / UNISEX', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'タイムレス・ユニセックス' })).toBeVisible();
    await expect(page.getByText('NATURAL FIBERS', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '天然繊維' })).toBeVisible();
    await expect(page.getByText('DOMESTIC, MADE TO ORDER', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '国内受注生産' })).toBeVisible();
    await expect(page.getByText('01', { exact: true })).toBeVisible();
    await expect(page.getByText('02', { exact: true })).toBeVisible();
    await expect(page.getByText('03', { exact: true })).toBeVisible();
  });
});
