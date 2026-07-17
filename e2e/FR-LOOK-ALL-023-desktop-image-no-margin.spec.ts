import { expect, test, type Page } from '@playwright/test';

// FREQ-136: PC（lg 以上）ではキャプションがオーバーレイ表示に置き換わるため、
// LOOK カード画像コンテナの margin-bottom を 0 にする。
// モバイル・タブレットは従来どおり mb-3 / sm:mb-4 を維持する。

async function readImageContainerMarginBottom(
  page: Page,
  scopeSelector: string,
): Promise<number | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>(
      '[data-testid="look-card-overlay"]',
    );
    const container = overlay?.parentElement;
    if (!container) return null;
    return parseFloat(getComputedStyle(container).marginBottom);
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-023 PC では画像コンテナの下マージンをなくす', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} で margin-bottom が 0px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const marginBottom = await readImageContainerMarginBottom(
        page,
        target.scope,
      );
      expect(
        marginBottom,
        `${target.label} に LOOK カードが見つかりませんでした`,
      ).not.toBeNull();

      // AC-01: lg 以上では mb を 0 にする
      expect(marginBottom!).toBe(0);
    });
  }

  // AC-02: モバイル・タブレットは従来どおり mb を維持する
  for (const vp of [
    { name: 'mobile', width: 390, height: 844, expected: 12 },
    { name: 'tablet', width: 768, height: 1024, expected: 16 },
  ] as const) {
    test(`${vp.name} では margin-bottom が ${vp.expected}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();

      const marginBottom = await readImageContainerMarginBottom(page, 'main');
      expect(marginBottom).not.toBeNull();
      expect(marginBottom!).toBe(vp.expected);
    });
  }
});
