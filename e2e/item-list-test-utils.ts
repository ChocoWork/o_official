import { expect, Locator, Page } from '@playwright/test';

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

export async function openItemFilters(page: Page): Promise<Locator> {
  const width = await page.evaluate(() => window.innerWidth);
  if (width < 1024) {
    await page.locator('[data-filter-button="floating"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }
  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

export async function closeItemFilters(filters: Locator): Promise<void> {
  if (await filters.getAttribute('role') === 'dialog') {
    await filters.getByRole('button', { name: 'Close filter drawer' }).click();
    await expect(filters).toBeHidden();
  }
}

export async function expandItemFilterSection(filters: Locator, name: string): Promise<Locator> {
  const trigger = filters.getByRole('button', { name, exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return trigger.locator('..');
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
