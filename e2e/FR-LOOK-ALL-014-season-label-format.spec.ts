import { expect, test, type Page } from '@playwright/test';

// FREQ-127: LOOK カードのシーズンラベルは「2026AW」形式
// （COLLECTION なし・年とシーズンの間の空白なし）で表示する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

// mobile/tablet はキャプション、desktop はオーバーレイに表示される（FREQ-128）。
// ビューポートを問わず「表示されている方」のラベルを取得する。
async function readVisibleSeasonLabels(page: Page, scopeSelector: string): Promise<string[]> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const labels = Array.from(
      scope.querySelectorAll<HTMLElement>(
        '[data-testid="look-card-caption"] p, [data-testid="look-card-overlay"] p',
      ),
    );
    return labels
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => (el.textContent ?? '').trim());
  });
}

function assertSeasonLabelFormat(labels: string[], context: string): void {
  expect(labels.length, `${context} にシーズンラベルが見つかりませんでした`).toBeGreaterThan(0);
  for (const label of labels) {
    // AC-01: 「{4桁年}{SS|AW}」形式（例: 2026AW）
    expect(label, `${context} label="${label}"`).toMatch(/^\d{4}(SS|AW)$/);
    // AC-02: COLLECTION を含まない / AC-03: 空白を含まない
    expect(label).not.toContain('COLLECTION');
    expect(label).not.toMatch(/\s/);
  }
}

test.describe('FR-LOOK-ALL-014 シーズンラベルの表記（2026AW 形式）', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} HOME の LOOK セクションで {年}{SS|AW} 形式になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
      assertSeasonLabelFormat(
        await readVisibleSeasonLabels(page, '#look'),
        `HOME#look ${vp.name}`,
      );
    });

    test(`${vp.name} /look 一覧で {年}{SS|AW} 形式になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      assertSeasonLabelFormat(
        await readVisibleSeasonLabels(page, 'main'),
        `/look ${vp.name}`,
      );
    });
  }
});
