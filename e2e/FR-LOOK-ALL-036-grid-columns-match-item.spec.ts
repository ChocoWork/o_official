import { expect, test, type Page } from '@playwright/test';

// FREQ-277: LOOK グリッドの列数を ITEM（FREQ-276）と同じブレークポイントの
// 組み合わせ（2 / md 3 / 2xl 4）に揃える。gap と左右余白は LOOK 固有のまま
// （FREQ-137 / FREQ-140 / FREQ-141）なので、ここでは列数と最小カード幅を検証する。

async function columnCount(page: Page, cardSelector: string): Promise<number> {
  const card = page.locator(cardSelector).first();
  await expect(card).toBeVisible();
  return card.evaluate((el) => {
    // LOOK カードはグリッドの直接の子、ITEM カードはリンクがグリッドの子。
    const grid = el.closest('.grid') as HTMLElement;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
      .length;
  });
}

async function firstCardWidth(page: Page, cardSelector: string): Promise<number> {
  const card = page.locator(cardSelector).first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  if (!box) {
    throw new Error('LOOK カードの矩形を取得できませんでした');
  }
  return box.width;
}

const LOOK_CARD = '[data-testid="look-card"]';
const ITEM_CARD = '[data-testid="item-card-link"]';

test.describe('FR-LOOK-ALL-036 LOOK グリッドの列数を ITEM に揃える', () => {
  for (const { name, width } of [
    { name: 'mobile', width: 390 },
    { name: 'tablet', width: 768 },
    { name: 'desktop', width: 1280 },
    { name: 'wide', width: 1536 },
  ] as const) {
    test(`FREQ-277-AC-01: ${name}(${width}px) で /look と /item の列数が一致する`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });

      await page.goto('/look');
      const lookColumns = await columnCount(page, LOOK_CARD);

      await page.goto('/item');
      const itemColumns = await columnCount(page, ITEM_CARD);

      expect(lookColumns).toBe(itemColumns);
    });
  }

  for (const width of [1024, 1280, 1536, 1920]) {
    test(`FREQ-277-AC-02: ${width}px で LOOK カード幅が 200px 以上`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/look');

      expect(await firstCardWidth(page, LOOK_CARD)).toBeGreaterThanOrEqual(200);
    });
  }

  // FREQ-277-AC-03: ホームの表示件数は列数に合わせて 2xl 未満 6 / 2xl 8。
  // 公開 LOOK の総数が上限に満たない場合もあるため「上限以下」で検証する。
  for (const { name, width, limit } of [
    { name: 'mobile', width: 390, limit: 6 },
    { name: 'tablet', width: 768, limit: 6 },
    { name: 'desktop', width: 1280, limit: 6 },
    { name: 'wide', width: 1536, limit: 8 },
  ] as const) {
    test(`FREQ-277-AC-03: ${name}(${width}px) のホーム LOOK 表示は最大 ${limit} 件`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scope = page.locator('#look');
      const domCount = await scope.locator(LOOK_CARD).count();
      const visibleCount = await scope.locator(`${LOOK_CARD}:visible`).count();

      expect(visibleCount).toBe(Math.min(domCount, limit));
    });
  }
});
