import { expect, test } from '@playwright/test';
import { createTestMember, loginAsMember } from './member-session-helpers';

// 会員の確認コードと Cookie を通信記録に残さないため。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test(`FR-WISHLIST-016 FREQ-429-AC-01: ゲストのお気に入りをログインで引き継ぐ (${viewport.name})`, async ({ page, context }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    const response = await page.request.get('/api/items?pageSize=20&sort=newest');
    expect(response.status()).toBe(200);
    const body = await response.json() as { items?: Array<{ id: number; name: string; price: number }> };
    const item = body.items?.find((entry) => entry.price >= 50);
    test.skip(!item, '公開中で50円以上の商品が無い');
    if (!item) return;
    await page.goto(`/item/${item.id}`);
    await expect(page.getByRole('heading', { level: 1, name: item.name, exact: true })).toBeVisible();
    const button = page.getByRole('button', { name: 'Add to wishlist', exact: true }).filter({ visible: true }).first();
    await expect(button).toBeEnabled();
    const addResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/wishlist' && r.request().method() === 'POST');
    await button.click();
    expect((await addResponse).status()).toBe(201);
    const cookie = (await context.cookies()).find((entry) => entry.name === 'wishlist');
    expect(cookie ? { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path } : null)
      .toEqual({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const lifetimeSeconds = (cookie?.expires ?? 0) - Date.now() / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(14 * 24 * 60 * 60 - 120);
    expect(lifetimeSeconds).toBeLessThanOrEqual(14 * 24 * 60 * 60 + 5);

    const member = await createTestMember(`wishlist-carry-${viewport.name}`);
    await loginAsMember(page, member);
    expect((await context.cookies()).some((entry) => entry.name === 'wishlist')).toBe(false);
    await page.goto('/wishlist');
    const list = page.getByRole('list', { name: 'ウィッシュリスト商品一覧' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByText(item.name, { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
