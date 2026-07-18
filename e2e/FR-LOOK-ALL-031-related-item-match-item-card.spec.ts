import { expect, test, type Page } from '@playwright/test';

// FREQ-144: mobile / tablet の LOOK カードに表示される関連 ITEM の
// 商品名・価格の文字を、ITEM カード（ItemCardInfo）と同じ見た目に揃える。
// desktop はオーバーレイ表示のため対象外。

type TextStyle = {
  fontFamily: string;
  fontWeight: string;
  fontSize: string;
  letterSpacing: string;
  color: string;
  text: string;
};

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

function readStyle(): (el: HTMLElement) => TextStyle {
  return (el) => {
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontSize: cs.fontSize,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      text: (el.textContent ?? '').trim(),
    };
  };
}

// ITEM 一覧の ITEM カードから商品名・価格の算出スタイルを参照値として読む。
async function readItemCardStyles(page: Page) {
  await page.goto('/item');
  const name = await page
    .locator('[data-testid="item-name"]')
    .first()
    .evaluate(readStyle());
  const price = await page
    .locator('[data-testid="item-price"]')
    .first()
    .evaluate(readStyle());
  return { name, price };
}

// LOOK 一覧の、関連 ITEM を持つカードから商品名・価格の算出スタイルを読む。
async function readLookRelatedStyles(page: Page) {
  await page.goto('/look');
  const card = page
    .locator('[data-testid="look-card"]')
    .filter({ has: page.locator('.look-related-item-text') })
    .first();
  await card.scrollIntoViewIfNeeded();
  const spans = card.locator('.look-related-item-text span');
  const name = await spans.first().evaluate(readStyle());
  const price = await spans.nth(1).evaluate(readStyle());
  return { name, price };
}

test.describe('FR-LOOK-ALL-031 関連 ITEM の文字を ITEM カードと同一の見た目にする', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 関連 ITEM の商品名・価格が ITEM カードと一致する`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const item = await readItemCardStyles(page);
      const look = await readLookRelatedStyles(page);

      // AC-01: 商品名の書体・太さ・字間が ITEM カードと一致
      expect(look.name.fontFamily).toBe(item.name.fontFamily);
      expect(look.name.fontWeight).toBe(item.name.fontWeight);
      expect(look.name.letterSpacing).toBe(item.name.letterSpacing);

      // AC-02: 価格の太さ・文字色が ITEM カードと一致
      expect(look.price.fontWeight).toBe(item.price.fontWeight);
      expect(look.price.color).toBe(item.price.color);

      // AC-03: 価格は半角「¥」始まりの表記
      expect(look.price.text.startsWith('¥')).toBeTruthy();

      // AC-04: 商品名・価格は黒（従来のグレー #474747 ではない）
      expect(look.name.color).toBe('rgb(0, 0, 0)');
      expect(look.price.color).toBe('rgb(0, 0, 0)');
    });
  }
});
