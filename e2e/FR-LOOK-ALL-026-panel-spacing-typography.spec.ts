import { expect, test, type Page } from '@playwright/test';

// FREQ-139: LOOK カード情報パネル（lg 未満）の余白・文字サイズを
// デザイン4原則で調整する。
// 対比: タイトル font-size = 関連アイテム文字（2xs）× φ（1.5 倍以上）
// 反復・整列: 画像↔パネル間隔はフィボナッチ 13px（mobile）/ 21px（tablet）
// 近接: シーズン↔タイトル（2px）はタイトル↔罫線（8px/13px）より密
// 整列・反復: 罫線の上余白 = 下余白

type PanelMetrics = {
  imageMarginBottom: number;
  titleFontSize: number;
  itemFontSize: number | null;
  seasonToTitleGap: number;
  titleToDividerGap: number | null;
  dividerMarginTop: number | null;
  dividerMarginBottom: number | null;
};

async function readPanelMetrics(
  page: Page,
  scopeSelector: string,
): Promise<PanelMetrics | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    // 関連アイテム（罫線）を持つカードを優先して計測する
    const divider = scope.querySelector<HTMLElement>(
      '[data-testid="look-card-divider"]',
    );
    const caption = divider
      ? divider.parentElement?.querySelector<HTMLElement>(
          '[data-testid="look-card-caption"]',
        )
      : scope.querySelector<HTMLElement>('[data-testid="look-card-caption"]');
    if (!caption) return null;

    const card = caption.closest('div')?.parentElement;
    const imageContainer = card?.querySelector<HTMLElement>(
      'a[href^="/look/"] > div',
    );
    const season = caption.querySelector<HTMLElement>('p');
    const title = caption.querySelector<HTMLElement>('h3');
    const item = divider?.parentElement?.querySelector<HTMLElement>(
      '.look-related-item-text span',
    );
    if (!imageContainer || !season || !title) return null;

    const seasonRect = season.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const dividerRect = divider?.getBoundingClientRect();
    const dividerStyle = divider ? getComputedStyle(divider) : null;

    return {
      imageMarginBottom: parseFloat(
        getComputedStyle(imageContainer).marginBottom,
      ),
      titleFontSize: parseFloat(getComputedStyle(title).fontSize),
      itemFontSize: item ? parseFloat(getComputedStyle(item).fontSize) : null,
      seasonToTitleGap: Number((titleRect.top - seasonRect.bottom).toFixed(2)),
      titleToDividerGap: dividerRect
        ? Number((dividerRect.top - titleRect.bottom).toFixed(2))
        : null,
      dividerMarginTop: dividerStyle
        ? parseFloat(dividerStyle.marginTop)
        : null,
      dividerMarginBottom: dividerStyle
        ? parseFloat(dividerStyle.marginBottom)
        : null,
    };
  });
}

const TARGETS = [
  { name: 'HOME LOOK セクション', path: '/', scope: '#look' },
  { name: '/look 一覧', path: '/look', scope: 'main' },
] as const;

const PANEL_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, imageGap: 13 },
  { name: 'tablet', width: 768, height: 1024, imageGap: 21 },
] as const;

test.describe('FR-LOOK-ALL-026 情報パネルの余白・文字サイズ（デザイン4原則）', () => {
  for (const vp of PANEL_VIEWPORTS) {
    for (const target of TARGETS) {
      test(`${vp.name} ${target.name} 余白と文字サイズが4原則に従う`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(target.path);
        await expect(page.locator(target.scope)).toBeVisible();

        const m = await readPanelMetrics(page, target.scope);
        expect(m, `${target.name} に LOOK カードが見つかりませんでした`).not.toBeNull();

        // AC-01（反復・整列）: 画像↔パネル間隔がフィボナッチ値
        expect(m!.imageMarginBottom).toBe(vp.imageGap);

        // AC-02（対比）: タイトル font-size ≥ アイテム文字 × 1.5（φ 比）
        if (m!.itemFontSize !== null) {
          expect(m!.titleFontSize / m!.itemFontSize).toBeGreaterThanOrEqual(1.5);
        }

        // AC-03（近接）: シーズン↔タイトルはタイトル↔罫線より密
        if (m!.titleToDividerGap !== null) {
          expect(m!.seasonToTitleGap).toBeLessThan(m!.titleToDividerGap);
        }

        // AC-04（整列・反復）: 罫線の上余白 = 下余白
        if (m!.dividerMarginTop !== null && m!.dividerMarginBottom !== null) {
          expect(m!.dividerMarginTop).toBe(m!.dividerMarginBottom);
        }
      });
    }
  }

  // AC-05: desktop はキャプション非表示・画像 mb 0 のまま（FREQ-136 維持）
  test('desktop /look ではキャプションが表示されず画像 mb が 0', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    await expect(
      page.locator('main [data-testid="look-card-caption"]').first(),
    ).toBeHidden();
    const marginBottom = await page
      .locator('main [data-testid="look-card-overlay"]')
      .first()
      .evaluate((overlay) =>
        parseFloat(getComputedStyle(overlay.parentElement!).marginBottom),
      );
    expect(marginBottom).toBe(0);
  });
});
