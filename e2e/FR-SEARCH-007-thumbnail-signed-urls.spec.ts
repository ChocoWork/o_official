import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

// FREQ-185: 画像バケットは private（migrations 030 / 044）で配信は署名付き URL が前提。
// 検索結果のサムネイルが public URL のまま返ると 400 になり表示されないため、
// 署名付き URL であることと、実際に画像が読み込まれることを検証する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-007 検索結果サムネイルの署名付き URL 配信', () => {
  test('AC-01 /api/search の imageUrl が署名付き URL であること', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    const response = await page.request.get(`/api/search?q=${encodeURIComponent(seed.query)}&tab=all`);
    expect(response.ok()).toBeTruthy();

    const payload = (await response.json()) as {
      items: Array<{ imageUrl: string | null }>;
      looks: Array<{ imageUrl: string | null }>;
      news: Array<{ imageUrl: string | null }>;
      popularItems: Array<{ imageUrl: string | null }>;
    };

    const imageUrls = [...payload.items, ...payload.looks, ...payload.news, ...payload.popularItems]
      .map((result) => result.imageUrl)
      .filter((url): url is string => Boolean(url));

    expect(imageUrls.length).toBeGreaterThan(0);
    for (const url of imageUrls) {
      expect(url).toContain('/storage/v1/object/sign/');
      expect(url).not.toContain('/storage/v1/object/public/');
    }
  });

  for (const vp of VIEWPORTS) {
    test(`AC-02 ${vp.name} サムネイル画像が実際に読み込まれること`, async ({ page }) => {
      const seed = await fetchSearchSeed(page);

      const failedImageRequests: string[] = [];
      page.on('response', (response) => {
        const url = response.url();
        if ((url.includes('/_next/image') || url.includes('/storage/v1/object/')) && response.status() >= 400) {
          failedImageRequests.push(`${response.status()} ${url}`);
        }
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/search?q=${encodeURIComponent(seed.query)}`);

      // ローディングのスケルトンには img が無いため、結果行の描画を待ってから数える
      await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

      const thumbnails = page.locator('[data-testid="search-result-row"] img');
      await expect.poll(async () => thumbnails.count()).toBeGreaterThan(0);
      const thumbnailCount = await thumbnails.count();

      for (let index = 0; index < thumbnailCount; index += 1) {
        const thumbnail = thumbnails.nth(index);
        await expect(thumbnail).toBeVisible();
        await expect
          .poll(async () => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
      }

      expect(failedImageRequests).toEqual([]);
    });
  }
});
