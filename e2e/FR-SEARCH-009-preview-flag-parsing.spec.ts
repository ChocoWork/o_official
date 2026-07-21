import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

// FREQ-187: z.coerce.boolean() は Boolean('false') === true のため、preview 未指定時の
// 既定値 'false' が true と解釈され、通常検索が常にプレビュー扱い（レート上限 20・
// 1種別3件）になっていた。preview は 'true' のときだけ真とする。

type SearchResponse = {
  items: unknown[];
  looks: unknown[];
  news: unknown[];
  counts: { item: number; look: number; news: number; all: number };
};

test.describe('FR-SEARCH-009 preview フラグの解釈', () => {
  test('AC-01/AC-02 preview 未指定は 1種別最大8件、preview=true は最大3件', async ({ page }) => {
    const seed = await fetchSearchSeed(page);

    const normalResponse = await page.request.get(`/api/search?q=${encodeURIComponent(seed.query)}`);
    expect(normalResponse.ok()).toBeTruthy();
    const normal = (await normalResponse.json()) as SearchResponse;

    const previewResponse = await page.request.get(`/api/search?q=${encodeURIComponent(seed.query)}&preview=true`);
    expect(previewResponse.ok()).toBeTruthy();
    const preview = (await previewResponse.json()) as SearchResponse;

    // preview は 1種別あたり 3 件以下
    expect(preview.counts.item).toBeLessThanOrEqual(3);
    expect(preview.counts.look).toBeLessThanOrEqual(3);
    expect(preview.counts.news).toBeLessThanOrEqual(3);

    // 通常検索は 1種別あたり 8 件まで許容され、preview を下回らない
    expect(normal.counts.item).toBeLessThanOrEqual(8);
    expect(normal.counts.look).toBeLessThanOrEqual(8);
    expect(normal.counts.news).toBeLessThanOrEqual(8);
    expect(normal.counts.all).toBeGreaterThanOrEqual(preview.counts.all);
  });

  test('AC-03 preview 未指定は search:public として計上され 20 回連続でも 429 にならない', async ({ page }) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await page.request.get('/api/search?q=');
      statuses.push(response.status());
    }

    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });
});
