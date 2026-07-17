import { expect, test, type Page } from '@playwright/test';

// FREQ-54: LOOK カードのコレクション時期・名前・関連アイテムの縦間隔を近接の原則で整える。
// 「時期↔名前」の間隔が「名前↔関連アイテム」の間隔より狭いことを検証する。

type CardGap = {
  cardIndex: number;
  periodToName: number;
  nameToRelated: number;
};

async function collectCardGaps(
  page: Page,
  scopeSelector: string,
): Promise<CardGap[]> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const cards = Array.from(
      scope.querySelectorAll<HTMLElement>('.look-related-items'),
    );

    return cards.flatMap((related, cardIndex) => {
      // 関連アイテムグループの親（テキストブロック）から時期 p と名前 h3 を辿る。
      const textBlock = related.parentElement;
      if (!textBlock) return [];
      const period = textBlock.querySelector<HTMLElement>('p');
      const name = textBlock.querySelector<HTMLElement>('h3');
      const firstRelated = related.querySelector<HTMLElement>(
        'a.look-related-item-text',
      );
      if (!period || !name || !firstRelated) return [];

      const periodRect = period.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const relatedRect = firstRelated.getBoundingClientRect();

      return [
        {
          cardIndex,
          periodToName: Number((nameRect.top - periodRect.bottom).toFixed(2)),
          nameToRelated: Number((relatedRect.top - nameRect.bottom).toFixed(2)),
        },
      ];
    });
  });
}

function assertProximity(gaps: CardGap[], label: string): void {
  expect(gaps.length, `${label} に LOOK カードが見つかりませんでした`).toBeGreaterThan(0);
  for (const gap of gaps) {
    expect(
      gap.periodToName,
      `${label} card=${gap.cardIndex} periodToName=${gap.periodToName} nameToRelated=${gap.nameToRelated}`,
    ).toBeLessThan(gap.nameToRelated);
  }
}

// FREQ-133 により PC（lg 以上）はカード下のテキスト（時期・名前・関連アイテム）を
// 表示しないため、近接の検証は mobile / tablet のみ対象とする。
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

test.describe('FR-LOOK-ALL-011 カードテキストの近接', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} HOME の LOOK で 時期↔名前 < 名前↔関連 になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
      assertProximity(await collectCardGaps(page, '#look'), `HOME#look ${vp.name}`);
    });

    test(`${vp.name} /look 一覧で 時期↔名前 < 名前↔関連 になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      assertProximity(await collectCardGaps(page, 'main'), `/look ${vp.name}`);
    });
  }
});
