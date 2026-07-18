import { test, expect, type Page } from '@playwright/test';

// FREQ-147〜149: ホーム各セクションの取得件数・ブレークポイント別表示数・
// VIEW ALL ボタンの条件表示を検証する。
// - ITEM: 取得10件 / 表示 lg未満6・lg8・xl10
// - LOOK: 取得8件 / 表示 xl未満6・xl8
// - NEWS: 取得6件 / 全サイズ6件表示
// VIEW ALL は「公開総数 > その帯域の表示数」の場合のみ表示される。
// DOM からは総数がフェッチ上限を超えるかどうか判定できないため、
// DOM 件数 == フェッチ上限 かつ 表示数 >= フェッチ上限 の場合の表示判定は行わない。

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type SectionSpec = {
  sectionId: string;
  cardSelector: string;
  fetchLimit: number;
  displayLimits: Record<(typeof viewports)[number]['name'], number>;
};

const sections: SectionSpec[] = [
  {
    sectionId: 'items',
    cardSelector: '[data-testid="item-card-link"]',
    fetchLimit: 10,
    displayLimits: { mobile: 6, tablet: 6, desktop: 10 },
  },
  {
    sectionId: 'look',
    cardSelector: '[data-testid="look-card"]',
    fetchLimit: 8,
    displayLimits: { mobile: 6, tablet: 6, desktop: 8 },
  },
  {
    sectionId: 'news',
    cardSelector: 'article',
    fetchLimit: 6,
    displayLimits: { mobile: 6, tablet: 6, desktop: 6 },
  },
];

async function assertSection(
  page: Page,
  section: SectionSpec,
  viewportName: (typeof viewports)[number]['name'],
): Promise<void> {
  const displayLimit = section.displayLimits[viewportName];
  const scope = page.locator(`#${section.sectionId}`);
  const cards = scope.locator(section.cardSelector);

  // 取得件数の上限（フェッチ上限を超える件数は DOM に描画されない）
  const domCount = await cards.count();
  expect(domCount, `${section.sectionId}: DOM 件数`).toBeLessThanOrEqual(
    section.fetchLimit,
  );

  // 表示件数 = min(DOM 件数, ブレークポイント別表示数)
  const visibleCount = await scope
    .locator(`${section.cardSelector}:visible`)
    .count();
  expect(visibleCount, `${section.sectionId}: 表示件数`).toBe(
    Math.min(domCount, displayLimit),
  );

  // VIEW ALL: 総数 > 表示数 の場合のみ表示
  const viewAll = scope.locator('[data-testid="home-section-view-all"]');
  if (domCount > displayLimit) {
    // 総数 >= DOM 件数 > 表示数 → 必ず表示される
    await expect(viewAll, `${section.sectionId}: VIEW ALL`).toBeVisible();
  } else if (domCount < section.fetchLimit) {
    // DOM 件数 = 総数 <= 表示数 → 表示されない
    await expect(viewAll, `${section.sectionId}: VIEW ALL`).toBeHidden();
  }
  // domCount == fetchLimit <= displayLimit の場合は総数を DOM から判定できないため断定しない
}

test.describe('FR-HOME-013 home section display limits', () => {
  for (const viewport of viewports) {
    test(`${viewport.name}: sections show breakpoint-specific counts with conditional VIEW ALL`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (const section of sections) {
        await assertSection(page, section, viewport.name);
      }
    });
  }
});
