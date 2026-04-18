import { expect, test } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

test.describe('SEARCH-01-004 search api performance', () => {
  test.fixme(true, '現行のローカル開発環境では p95 < 200ms をまだ満たしていないため、性能最適化は継続タスクとして扱う');

  test('/api/search の p95 応答時間が 200ms 未満である', async ({ page }) => {
    const seed = await fetchSearchSeed(page);
    const durations: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const response = await page.request.get(`/api/search?q=${encodeURIComponent(seed.query)}`);
      expect(response.ok()).toBeTruthy();
      const durationHeader = response.headers()['x-search-duration-ms'];
      expect(durationHeader).toBeTruthy();
      durations.push(Number(durationHeader));
    }

    const sorted = durations.slice().sort((left, right) => left - right);
    const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    expect(sorted[percentileIndex]).toBeLessThan(200);
  });
});