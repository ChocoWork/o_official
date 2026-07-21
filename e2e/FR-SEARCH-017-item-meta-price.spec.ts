import { expect, test } from '@playwright/test';

// FREQ-201: ITEM 検索結果行および POPULAR ITEMS のメタを種別カテゴリから価格に変更する。
// LOOK（シーズン）/ NEWS（公開日）のメタは変更しない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type Row = { label: string; meta: string };

async function readRows(page: import('@playwright/test').Page): Promise<Row[]> {
  await page.goto('/search?q=a');
  await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="search-result-row"]')].map((row) => {
      const paragraphs = row.querySelectorAll('p');
      return {
        label: paragraphs[0]?.textContent?.trim() ?? '',
        meta: paragraphs[2]?.textContent?.trim() ?? '',
      };
    }),
  );
}

test.describe('FR-SEARCH-017 ITEM メタの価格表示', () => {
  for (const vp of VIEWPORTS) {
    test(`AC-01/AC-02 ${vp.name} ITEM は価格・LOOK/NEWS は従来のメタ`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const rows = await readRows(page);

      const items = rows.filter((row) => row.label === 'ITEM');
      const looks = rows.filter((row) => row.label === 'LOOK');
      const news = rows.filter((row) => row.label === 'NEWS');

      // 前提: ITEM / LOOK / NEWS の各行が存在する（検証対象がある）
      expect(items.length).toBeGreaterThan(0);
      expect(looks.length).toBeGreaterThan(0);
      expect(news.length).toBeGreaterThan(0);

      // AC-01: ITEM のメタは「¥」始まりの価格。カテゴリ名ではない。
      for (const item of items) {
        expect(item.meta).toMatch(/^¥[0-9,]+$/);
      }

      // AC-02: LOOK はシーズン、NEWS は公開日のまま。
      for (const look of looks) {
        expect(look.meta).toMatch(/^\d{4}\s(SS|AW)$/);
      }
      for (const article of news) {
        expect(article.meta).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
      }
    });
  }

  test('AC-03 /api/search の items[].meta が価格・purchase_count 非公開', async ({ request }) => {
    const response = await request.get('/api/search?q=a');
    expect(response.ok()).toBe(true);

    const payload = await response.json();
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of [...payload.items, ...payload.popularItems]) {
      expect(item.meta).toMatch(/^¥[0-9,]+$/);
    }

    // 購入数はレスポンスに出さない
    expect(JSON.stringify(payload)).not.toContain('purchase_count');
  });
});
