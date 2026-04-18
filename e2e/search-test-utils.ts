import { expect, Page } from '@playwright/test';

type PublicNewsArticle = {
  id: string | number;
  title: string;
};

function tokenize(value: string): string[] {
  return value
    .split(/[\s/|:：,，.。!！?？()（）\[\]「」『』・-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export async function fetchSearchSeed(page: Page): Promise<{ query: string; itemName: string; newsTitle: string }> {
  await page.goto('/item');
  await expect(page.locator('[data-testid="item-name"]').first()).toBeVisible();
  const itemName = (await page.locator('[data-testid="item-name"]').first().textContent())?.trim() ?? '';
  expect(itemName.length).toBeGreaterThan(0);

  const newsResponse = await page.request.get('/api/news?limit=1');
  expect(newsResponse.ok()).toBeTruthy();
  const newsPayload = (await newsResponse.json()) as PublicNewsArticle[];
  const firstNews = newsPayload[0];
  expect(firstNews).toBeTruthy();

  const query = tokenize(itemName)[0] ?? itemName.slice(0, 2);

  return {
    query,
    itemName,
    newsTitle: firstNews!.title,
  };
}