import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-DETAIL-007 navigation aria labels', () => {
  test('FR-NEWS-DETAIL-007-AC-01 前後リンクのaria-labelが「前の記事: <題>」「次の記事: <題>」になる', async ({ page }) => {
    // 並列の試験（FR-HOME-023）が足す公開の記事に前後を変えられないよう、前後が見本の行だけになる見本の id 3 を開く。
    // 前後は id 2 と id 4。題は一覧の写しでなく見本（supabase/seed.sql）の題と突き合わせる。
    const seedTitleByPath = new Map<string, string>([
      ['/news/2', 'Synthetic Collection Note'],
      ['/news/4', 'Synthetic Collaboration Story'],
    ]);

    await page.goto('/news/3', { waitUntil: 'domcontentloaded' });

    const prevLink = page.locator('a[aria-label^="前の記事: "]:visible');
    const nextLink = page.locator('a[aria-label^="次の記事: "]:visible');
    expect((await prevLink.count()) + (await nextLink.count())).toBeGreaterThan(0);

    for (const [link, prefix] of [
      [prevLink, '前の記事: '],
      [nextLink, '次の記事: '],
    ] as const) {
      if ((await link.count()) === 0) continue;
      const href = (await link.first().getAttribute('href')) ?? '';
      const title = seedTitleByPath.get(href.split('?')[0]);
      expect(title, `${href} は見本の id 2・4 のどちらか`).toBeTruthy();
      await expect(link.first()).toHaveAttribute('aria-label', `${prefix}${title}`);
    }
  });
});
