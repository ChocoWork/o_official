import { expect, test, type Page } from '@playwright/test';

type RelatedItemsGapMeasurement = {
  containerIndex: number;
  pairIndex: number;
  boxGap: number;
  fontSize: number;
  lineHeight: number;
  visibleGap: number;
  targetGap: number;
  deltaFromTarget: number;
  firstText: string;
  secondText: string;
};

async function collectRelatedItemSpacingPairs(
  page: Page,
  scopeSelector: string,
): Promise<RelatedItemsGapMeasurement[]> {
  return page.locator(scopeSelector).evaluate((scopeElement) => {
    const parsePx = (value: string): number => Number.parseFloat(value.replace('px', ''));
    const containers = Array.from(scopeElement.querySelectorAll('.look-related-items'));

    return containers.flatMap((container, containerIndex) => {
      const links = Array.from(container.querySelectorAll<HTMLElement>('a.look-related-item-text'));

      if (links.length < 2) {
        return [];
      }

      return links.slice(0, -1).map((link, pairIndex) => {
        const next = links[pairIndex + 1];
        const linkRect = link.getBoundingClientRect();
        const nextRect = next.getBoundingClientRect();
        const linkStyle = getComputedStyle(link);
        const fontSize = parsePx(linkStyle.fontSize);
        const lineHeight = parsePx(linkStyle.lineHeight);
        const boxGap = Number((nextRect.top - linkRect.bottom).toFixed(2));
        const visibleGap = Number((boxGap + (lineHeight - fontSize)).toFixed(2));
        const targetGap = Number((fontSize / 1.618).toFixed(2));

        return {
          containerIndex,
          pairIndex,
          boxGap,
          fontSize: Number(fontSize.toFixed(2)),
          lineHeight: Number(lineHeight.toFixed(2)),
          visibleGap,
          targetGap,
          deltaFromTarget: Number((visibleGap - targetGap).toFixed(2)),
          firstText: link.textContent?.trim() ?? '',
          secondText: next.textContent?.trim() ?? '',
        };
      });
    });
  });
}

function assertPhiSpacing(pairs: RelatedItemsGapMeasurement[], scopeLabel: string): void {
  expect(pairs, `${scopeLabel} に関連商品リンクのペアが見つかりませんでした`).not.toHaveLength(0);

  for (const pair of pairs) {
    expect(
      Math.abs(pair.deltaFromTarget),
      `${scopeLabel} container=${pair.containerIndex} pair=${pair.pairIndex} ${pair.firstText} -> ${pair.secondText} boxGap=${pair.boxGap} visibleGap=${pair.visibleGap} targetGap=${pair.targetGap} fontSize=${pair.fontSize} lineHeight=${pair.lineHeight}`,
    ).toBeLessThanOrEqual(0.25);
  }
}

test.describe('FR-LOOK-ALL-007 related item spacing', () => {
  test('HOME の LOOK セクションで関連商品の見た目 gap が phi 比率に一致する', async ({ page }) => {
    await test.step('HOME の LOOK セクションを開く', async () => {
      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
    });

    await test.step('関連商品の見た目 gap を測定する', async () => {
      const pairs = await collectRelatedItemSpacingPairs(page, '#look');
      assertPhiSpacing(pairs, 'HOME#look');
    });
  });

  test('/look 一覧で関連商品の見た目 gap が phi 比率に一致する', async ({ page }) => {
    await test.step('/look 一覧を開く', async () => {
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
    });

    await test.step('関連商品の見た目 gap を測定する', async () => {
      const pairs = await collectRelatedItemSpacingPairs(page, 'main');
      assertPhiSpacing(pairs, '/look main');
    });
  });
});