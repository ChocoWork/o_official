import { expect, test } from '@playwright/test';
import { gotoItemList, itemCards } from './item-list-test-utils';

// FREQ-122: 商品名・価格の font-size は黄金比スケール（--lk-size-2xs）を使用し、
// font-weight は 400（500 の擬似ボールドにじみと 300 の細すぎの中間）とする。

test.describe('FR-ITEM-ALL-028 商品名・価格のフォント（黄金比サイズ・weight 400）', () => {
  test('FREQ-122-AC-01/02/03: font-size=--lk-size-2xs, font-weight=400', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoItemList(page);

    const card = itemCards(page).first();
    await expect(card).toBeVisible();

    const m = await card.evaluate((el) => {
      // 黄金比スケールの基準値を実測（--lk-size-2xs）
      const probe = document.createElement('span');
      probe.style.fontSize = 'var(--lk-size-2xs)';
      document.body.appendChild(probe);
      const size2xs = getComputedStyle(probe).fontSize;
      probe.remove();

      const pick = (sel: string) => {
        const node = el.querySelector(sel) as HTMLElement;
        const s = getComputedStyle(node);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight };
      };
      return {
        size2xs,
        name: pick('[data-testid="item-name"]'),
        price: pick('[data-testid="item-price"]'),
      };
    });

    // font-size は黄金比スケール（--lk-size-2xs）に一致（固定 px ではない）
    expect(m.name.fontSize).toBe(m.size2xs);
    expect(m.price.fontSize).toBe(m.size2xs);
    // weight は 400（視認性とにじみ回避の中間）
    expect(m.name.fontWeight).toBe('400');
    expect(m.price.fontWeight).toBe('400');
  });
});
