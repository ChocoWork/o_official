import { expect, Page } from '@playwright/test';

type ApiItem = {
  id: number | string;
  name?: string;
  category?: string;
  price?: number;
  image_url?: string;
  sizes?: string[];
  colors?: Array<{ name: string; hex: string }> | string[];
};

type ItemsApiResponse = ApiItem[] | { items: ApiItem[] };

export async function gotoItemList(page: Page, query = ''): Promise<void> {
  await page.goto(`/item${query}`);
  await expect(page).toHaveURL(new RegExp('/item'));
}

export function itemCards(page: Page) {
  return page.locator('[data-testid="item-card"]');
}

export async function fetchItemsViaApi(page: Page, query = ''): Promise<ApiItem[]> {
  const response = await page.request.get(`/api/items${query}`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ItemsApiResponse;

  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.items)) {
    return payload.items;
  }

  return [];
}

export async function fetchFirstItemViaApi(page: Page): Promise<ApiItem | null> {
  const items = await fetchItemsViaApi(page, '?page=1&pageSize=1');
  if (items.length === 0) {
    return null;
  }
  return items[0];
}

export function computeP95(samples: number[]): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rawIndex = Math.ceil(sorted.length * 0.95) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rawIndex));
  return sorted[index];
}
