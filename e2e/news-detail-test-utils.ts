import { expect, Page } from '@playwright/test';

export async function gotoNewsList(page: Page): Promise<void> {
  await page.goto('/news', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/news(\?.*)?$/);
  await expect(page.locator('a[href^="/news/"]').first()).toBeVisible();
}

export async function getNewsDetailHrefs(page: Page): Promise<string[]> {
  const hrefs = await page.locator('a[href^="/news/"]').evaluateAll((links) =>
    links
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => typeof href === 'string' && href.startsWith('/news/')),
  );

  return [...new Set(hrefs)];
}

export async function gotoNewsDetailByIndex(page: Page, index: number): Promise<string> {
  await gotoNewsList(page);
  const hrefs = await getNewsDetailHrefs(page);

  if (hrefs.length === 0) {
    throw new Error('No news detail links were found on /news.');
  }

  const safeIndex = Math.min(index, hrefs.length - 1);
  const targetHref = hrefs[safeIndex];
  await page.goto(targetHref, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`${targetHref.replace('?', '\\?')}(\\?.*)?$`));

  return targetHref;
}

export async function gotoFirstNewsDetail(page: Page): Promise<string> {
  return gotoNewsDetailByIndex(page, 0);
}

export async function gotoSecondNewsDetail(page: Page): Promise<string> {
  return gotoNewsDetailByIndex(page, 1);
}
