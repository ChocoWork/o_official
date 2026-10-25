import { test, expect } from '@playwright/test';

test.describe('FR-HOME-008 about section image', () => {
  test('FR-HOME-008-AC-01 uses static local asset for ABOUT section image', async ({ page, baseURL }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const aboutImage = page.locator('#about img[alt="About Le Fil des Heures"]');
    await expect(aboutImage).toHaveCount(1);

    // 読み込み先は、このサイトの /about.png（next/image の最適化を通した /_next/image?url=/about.png を含む）で、外のドメインを指さない
    const src = await aboutImage.getAttribute('src');
    expect(src).toBeTruthy();
    const resolved = new URL(src as string, baseURL);
    expect(resolved.origin, '外のドメインを指していない').toBe(new URL(baseURL as string).origin);
    const original = resolved.pathname === '/_next/image' ? new URL(resolved.searchParams.get('url') ?? '', baseURL) : resolved;
    expect(original.origin, '元の画像もこのサイトのもの').toBe(new URL(baseURL as string).origin);
    expect(original.pathname).toBe('/about.png');
  });
});
