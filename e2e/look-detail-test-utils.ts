import { expect, Page } from '@playwright/test';

export async function gotoFirstLookDetail(page: Page): Promise<string> {
  await page.goto('/look');

  const firstLookLink = page.locator('a[href^="/look/"]').first();
  await expect(firstLookLink).toBeVisible();

  const href = await firstLookLink.getAttribute('href');
  if (!href || !/^\/look\/\d+$/.test(href)) {
    throw new Error(`Invalid look detail href: ${href}`);
  }

  await page.goto(href);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  return href;
}
