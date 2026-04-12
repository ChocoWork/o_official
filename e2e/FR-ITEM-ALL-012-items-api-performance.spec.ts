import { expect, test } from '@playwright/test';
import { computeP95 } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-012 /api/items パフォーマンス', () => {
  test('P95が200ms未満（目標）', async ({ request }) => {
    test.setTimeout(90_000);
    const samples: number[] = [];
    const warmupCount = 2;
    const sampleCount = 12;

    for (let i = 0; i < sampleCount + warmupCount; i += 1) {
      const response = await request.get('/api/items?page=1&pageSize=12&sort=newest');
      expect(response.ok()).toBeTruthy();

      const headerValue = response.headers()['x-response-time-ms'];
      const elapsed = Number(headerValue ?? 'NaN');
      expect(Number.isFinite(elapsed)).toBeTruthy();

      if (i >= warmupCount) {
        samples.push(elapsed);
      }
    }

    const p95 = computeP95(samples);
    expect(p95).toBeLessThan(200);
  });
});
