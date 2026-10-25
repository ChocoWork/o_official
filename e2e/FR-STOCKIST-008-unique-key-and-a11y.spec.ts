import { expect, test } from '@playwright/test';
import { SEED_STOCKISTS, stockistCardByName } from './stockist-test-utils';

test.describe('FR-STOCKIST-008 ユニークキーとa11y安定性', () => {
  test('FR-STOCKIST-008-AC-02 各カードに店舗名を文字に持つ h3 の見出しが1つある', async ({ page }) => {
    await page.goto('/stockist');

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();

    // どのカードにも h3 がちょうど1つあり、空でない文字を持つ
    const headingTexts = await cards.evaluateAll((els) =>
      els.map((el) => {
        const headings = el.querySelectorAll('h3');
        return headings.length === 1 ? (headings[0].textContent ?? '').trim() : null;
      }),
    );
    expect(headingTexts.length).toBeGreaterThan(0);
    for (const text of headingTexts) {
      expect(text, '各カードの h3 は1つで、文字が空でない').toBeTruthy();
    }

    // 見本の店は、その店舗名がそのまま h3 の文字になっている
    for (const shop of SEED_STOCKISTS) {
      const card = stockistCardByName(page, shop.name);
      await expect(card.locator('h3'), shop.name).toHaveCount(1);
      await expect(card.locator('h3'), shop.name).toHaveText(shop.name);
    }
  });
});
