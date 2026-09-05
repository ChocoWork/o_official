import { expect, test, type Page } from '@playwright/test';

// FREQ-337: sm 未満は関連アイテムの商品名と価格を縦積みするため、
// 同一アイテムの「商品名↔価格」と別アイテムへの「価格↔次の商品名」の余白が
// 拮抗し、どこまでが 1 アイテムか読めない（近接の破綻）。
// 縦積みのときだけアイテム間の見た目 gap を φ 倍へ広げてグループ境界を示す。
// sm 以上は商品名と価格が横並び 1 行になるため、FR-LOOK-ALL-007 の φ 比率のまま。

const PHI = 1.618;

type StackedGapMeasurement = {
  containerIndex: number;
  pairIndex: number;
  innerGap: number;
  betweenGap: number;
  ratio: number;
  firstText: string;
  secondText: string;
};

type RowGapMeasurement = {
  containerIndex: number;
  pairIndex: number;
  visibleGap: number;
  targetGap: number;
  deltaFromTarget: number;
  sameRow: boolean;
  firstText: string;
  secondText: string;
};

// 縦積み時の「見た目の余白」= 矩形の隙間 + 上下テキストの行送り半分ずつ
async function collectStackedGaps(
  page: Page,
  scopeSelector: string,
): Promise<StackedGapMeasurement[]> {
  return page.locator(scopeSelector).evaluate((scopeElement) => {
    const parsePx = (value: string): number => Number.parseFloat(value);
    const halfLeading = (element: Element): number => {
      const style = getComputedStyle(element);
      return (parsePx(style.lineHeight) - parsePx(style.fontSize)) / 2;
    };
    const visibleGap = (upper: Element, lower: Element): number => {
      const boxGap =
        lower.getBoundingClientRect().top - upper.getBoundingClientRect().bottom;
      return Number((boxGap + halfLeading(upper) + halfLeading(lower)).toFixed(2));
    };

    const containers = Array.from(
      scopeElement.querySelectorAll('.look-related-items'),
    );

    return containers.flatMap((container, containerIndex) => {
      const links = Array.from(
        container.querySelectorAll<HTMLElement>('a.look-related-item-text'),
      );

      if (links.length < 2) {
        return [];
      }

      // 各リンクは「商品名」「価格」の 2 つの span を持つ（下線アニメーション用の
      // span は div の外なので div > span で除外できる）
      const textsOf = (link: HTMLElement): HTMLElement[] =>
        Array.from(link.querySelectorAll<HTMLElement>('div > span'));

      return links.slice(0, -1).flatMap((link, pairIndex) => {
        const [name, price] = textsOf(link);
        const [nextName] = textsOf(links[pairIndex + 1]);

        if (!name || !price || !nextName) {
          return [];
        }

        const innerGap = visibleGap(name, price);
        const betweenGap = visibleGap(price, nextName);

        return [
          {
            containerIndex,
            pairIndex,
            innerGap,
            betweenGap,
            ratio: Number((betweenGap / innerGap).toFixed(3)),
            firstText: name.textContent?.trim() ?? '',
            secondText: nextName.textContent?.trim() ?? '',
          },
        ];
      });
    });
  });
}

// 横並び 1 行のときのアイテム間 gap（FR-LOOK-ALL-007 と同じ計測）
async function collectRowGaps(
  page: Page,
  scopeSelector: string,
): Promise<RowGapMeasurement[]> {
  return page.locator(scopeSelector).evaluate((scopeElement) => {
    const parsePx = (value: string): number => Number.parseFloat(value);
    const containers = Array.from(
      scopeElement.querySelectorAll('.look-related-items'),
    );

    return containers.flatMap((container, containerIndex) => {
      const links = Array.from(
        container.querySelectorAll<HTMLElement>('a.look-related-item-text'),
      );

      if (links.length < 2) {
        return [];
      }

      return links.slice(0, -1).flatMap((link, pairIndex) => {
        const next = links[pairIndex + 1];
        const style = getComputedStyle(link);
        const fontSize = parsePx(style.fontSize);
        const lineHeight = parsePx(style.lineHeight);
        const boxGap =
          next.getBoundingClientRect().top - link.getBoundingClientRect().bottom;
        const visibleGap = Number((boxGap + (lineHeight - fontSize)).toFixed(2));
        const targetGap = Number((fontSize / 1.618).toFixed(2));

        const spans = Array.from(link.querySelectorAll<HTMLElement>('div > span'));
        const [name, price] = spans;
        const sameRow =
          !!name &&
          !!price &&
          price.getBoundingClientRect().top <
            name.getBoundingClientRect().bottom;

        return [
          {
            containerIndex,
            pairIndex,
            visibleGap,
            targetGap,
            deltaFromTarget: Number((visibleGap - targetGap).toFixed(2)),
            sameRow,
            firstText: link.textContent?.trim() ?? '',
            secondText: next.textContent?.trim() ?? '',
          },
        ];
      });
    });
  });
}

test.describe('FR-LOOK-ALL-038 モバイルの関連アイテムのグループ間隔', () => {
  test('FREQ-337-AC-01: mobile(390px) でアイテム間の余白が商品名↔価格の φ 倍以上', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const pairs = await collectStackedGaps(page, 'main');

    expect(
      pairs,
      '関連アイテムが 2 件以上ある LOOK カードが見つかりませんでした',
    ).not.toHaveLength(0);

    for (const pair of pairs) {
      expect(
        pair.ratio,
        `container=${pair.containerIndex} pair=${pair.pairIndex} ${pair.firstText} -> ${pair.secondText} innerGap=${pair.innerGap} betweenGap=${pair.betweenGap}`,
      ).toBeGreaterThanOrEqual(PHI);
    }
  });

  test('FREQ-337-AC-02: tablet(768px) は横並び 1 行のまま φ 比率の gap を保つ', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const pairs = await collectRowGaps(page, 'main');

    expect(
      pairs,
      '関連アイテムが 2 件以上ある LOOK カードが見つかりませんでした',
    ).not.toHaveLength(0);

    for (const pair of pairs) {
      expect(
        pair.sameRow,
        `container=${pair.containerIndex} pair=${pair.pairIndex} で商品名と価格が横並びになっていません`,
      ).toBe(true);
      expect(
        Math.abs(pair.deltaFromTarget),
        `container=${pair.containerIndex} pair=${pair.pairIndex} ${pair.firstText} -> ${pair.secondText} visibleGap=${pair.visibleGap} targetGap=${pair.targetGap}`,
      ).toBeLessThanOrEqual(0.25);
    }
  });

  test('FREQ-337-AC-03: desktop(1280px) はカード下の関連アイテムを表示しない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    await expect(page.locator('.look-related-items:visible')).toHaveCount(0);
  });
});
