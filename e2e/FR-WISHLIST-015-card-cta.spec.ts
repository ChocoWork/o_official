import { expect, test } from '@playwright/test';

// 規約の3ビューポート（.claude/CLAUDE.md）。
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const MOCK_WISHLIST = [
  {
    id: 'wish-single-option',
    item_id: 101,
    added_at: '2026-04-15T00:00:00.000Z',
    items: {
      id: 101,
      name: 'Linen Knickerbockers Slacks',
      price: 24800,
      image_url: '/images/test-item.jpg',
      category: 'TOPS',
      colors: [{ name: 'BLACK', hex: '#000000' }],
      sizes: ['FREE'],
    },
  },
  {
    id: 'wish-multiple-options',
    item_id: 102,
    added_at: '2026-04-15T00:00:00.000Z',
    items: {
      id: 102,
      name: 'x',
      price: 24800,
      image_url: '/images/test-item.jpg',
      category: 'TOPS',
      colors: [
        { name: 'BLACK', hex: '#000000' },
        { name: 'ECRU', hex: '#f5f0e6' },
      ],
      sizes: ['M'],
    },
  },
  {
    id: 'wish-size-options',
    item_id: 103,
    added_at: '2026-04-15T00:00:00.000Z',
    items: {
      id: 103,
      name: 'Top',
      price: 24800,
      image_url: '/images/test-item.jpg',
      category: 'TOPS',
      colors: [{ name: 'BLACK', hex: '#000000' }],
      sizes: ['S', 'M'],
    },
  },
];

test.describe('FR-WISHLIST-015 card CTA', () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-391-AC-01 / FREQ-391-AC-02 / FREQ-391-AC-03
    test(`${viewport.name}: CTA label reflects option selection and fills the card`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.route('**/api/wishlist', async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_WISHLIST),
        });
      });

      await page.goto('/wishlist');

      const cards = page.getByRole('listitem');
      const addCard = cards.nth(0);
      const selectCard = cards.nth(1);
      const addButton = addCard.getByRole('button', { name: 'ADD TO CART', exact: true });
      const colorSelectLink = selectCard.getByRole('link', { name: 'SELECT OPTION', exact: true });
      const sizeSelectCard = cards.nth(2);
      const sizeSelectLink = sizeSelectCard.getByRole('link', { name: 'SELECT OPTION', exact: true });

      await expect(addButton).toBeVisible();
      await expect(colorSelectLink).toHaveAttribute('href', '/item/102');
      await expect(sizeSelectLink).toHaveAttribute('href', '/item/103');

      if (viewport.name === 'mobile') {
        const itemName = addCard.getByTestId('item-name');
        const itemNameBox = await itemName.boundingBox();
        const swatchesBox = await addCard.locator('[aria-label^="カラー"]').boundingBox();
        const addButtonBox = await addButton.boundingBox();
        const selectLinkBox = await colorSelectLink.boundingBox();
        expect(itemNameBox).not.toBeNull();
        expect(swatchesBox).not.toBeNull();
        expect(addButtonBox).not.toBeNull();
        expect(selectLinkBox).not.toBeNull();
        expect(itemNameBox!.height).toBeGreaterThan(20);
        const nameLineHeight = await itemName.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).lineHeight),
        );
        const firstLineCenter = itemNameBox!.y + nameLineHeight / 2;
        const swatchCenter = swatchesBox!.y + swatchesBox!.height / 2;
        expect(Math.abs(firstLineCenter - swatchCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(addButtonBox!.y - selectLinkBox!.y)).toBeLessThanOrEqual(1);
        const smallerFontSize = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.fontSize = "var(--lk-size-3xs)";
          document.body.append(probe);
          const fontSize = window.getComputedStyle(probe).fontSize;
          probe.remove();
          return fontSize;
        });
        for (const cta of [addButton, colorSelectLink]) {
          await expect(cta).toHaveCSS("font-size", smallerFontSize);
          await expect(cta).toHaveCSS("padding-top", "4px");
        }
      }
      await expect(addButton.locator('i.ri-shopping-bag-line')).toBeVisible();
      await expect(colorSelectLink.locator('i.ri-shopping-bag-line')).toBeVisible();
      await expect(sizeSelectLink.locator('i.ri-shopping-bag-line')).toBeVisible();

      for (const [card, cta] of [[addCard, addButton], [selectCard, colorSelectLink], [sizeSelectCard, sizeSelectLink]] as const) {
        const [cardBox, ctaBox] = await Promise.all([card.boundingBox(), cta.boundingBox()]);
        expect(cardBox).not.toBeNull();
        expect(ctaBox).not.toBeNull();
        expect(Math.abs(cardBox!.width - ctaBox!.width)).toBeLessThanOrEqual(1);
      }

      // 横スクロールが出ないこと（規約: .claude/CLAUDE.md）
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
