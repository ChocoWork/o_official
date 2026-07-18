import { expect, test, type Page } from '@playwright/test';

// FREQ-138: mobile/tablet のキャプションは「2026 AW」形式
// （COLLECTION なし・年とシーズンの間に半角スペース1つ）。
// FREQ-127/128: desktop はオーバーレイに「2026AW」形式（空白なし）で表示する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, format: /^\d{4} (SS|AW)$/ },
  { name: 'tablet', width: 768, height: 1024, format: /^\d{4} (SS|AW)$/ },
  { name: 'desktop', width: 1280, height: 800, format: /^\d{4}(SS|AW)$/ },
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

function assertSeasonLabelFormat(labels: string[], format: RegExp, context: string): void {
  expect(labels.length, `${context} にシーズンラベルが見つかりませんでした`).toBeGreaterThan(0);
  for (const label of labels) {
    // AC-01: mobile/tablet は「{4桁年} {SS|AW}」形式（例: 2026 AW）、
    // desktop は「{4桁年}{SS|AW}」形式（例: 2026AW）
    expect(label, `${context} label="${label}"`).toMatch(format);
    // AC-02: COLLECTION を含まない
    expect(label).not.toContain('COLLECTION');
  }
}

test.describe('FR-LOOK-ALL-014 シーズンラベルの表記', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} HOME の LOOK セクションで所定形式になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
      assertSeasonLabelFormat(
        await readVisibleSeasonLabels(page, '#look'),
        vp.format,
        `HOME#look ${vp.name}`,
      );
    });

    test(`${vp.name} /look 一覧で所定形式になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      assertSeasonLabelFormat(
        await readVisibleSeasonLabels(page, 'main'),
        vp.format,
        `/look ${vp.name}`,
      );
    });
  }
});
