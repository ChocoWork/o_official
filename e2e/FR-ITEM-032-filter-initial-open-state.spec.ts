import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-284: ITEM ページのフィルターは読み込み時、CATEGORY だけを常に開き、
// 他のセクションは URL に既定値以外の選択があるときだけ開く。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

// desktop は aside、mobile / tablet は FILTER ボタンで開く Drawer に描画される。
// aside は lg 未満でも DOM に残るためスコープを分ける。
async function openFilterPanel(page: Page, width: number): Promise<Locator> {
  if (width >= 1024) {
    const aside = page.locator('aside').filter({ hasText: 'CATEGORY' }).first();
    await expect(aside).toBeVisible();
    return aside;
  }

  const filterButton = page.locator('[data-filter-button="floating"]');
  await filterButton.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

function sectionTrigger(panel: Locator, title: string): Locator {
  return panel
    .locator('[data-ui-accordion-trigger]')
    .filter({ hasText: new RegExp(`^${title}$`) })
    .first();
}

async function expectExpanded(
  panel: Locator,
  title: string,
  expanded: boolean,
): Promise<void> {
  const trigger = sectionTrigger(panel, title);
  await expect(trigger).toHaveAttribute('aria-expanded', String(expanded));
}

test.describe('FR-ITEM-032 ITEM フィルターの初期開閉', () => {
  for (const { name, width, height } of VIEWPORTS) {
    test(`FREQ-284-AC-01: ${name}(${width}px) で CATEGORY が開いている`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await gotoItemList(page);
      const panel = await openFilterPanel(page, width);

      await expectExpanded(panel, 'CATEGORY', true);
    });

    test(`FREQ-284-AC-02: ${name}(${width}px) で既定値のセクションは閉じている`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await gotoItemList(page);
      const panel = await openFilterPanel(page, width);

      await expectExpanded(panel, 'STOCK', false);
      await expectExpanded(panel, 'SEASON', false);
      await expectExpanded(panel, 'PRICE', false);
    });

    test(`FREQ-284-AC-03: ${name}(${width}px) で選択のあるセクションだけ開く`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });

      await gotoItemList(page, '?stock=in');
      let panel = await openFilterPanel(page, width);
      await expectExpanded(panel, 'CATEGORY', true);
      await expectExpanded(panel, 'STOCK', true);
      await expectExpanded(panel, 'SEASON', false);
      await expectExpanded(panel, 'PRICE', false);

      await gotoItemList(page, '?priceMin=5000');
      panel = await openFilterPanel(page, width);
      await expectExpanded(panel, 'CATEGORY', true);
      await expectExpanded(panel, 'PRICE', true);
      await expectExpanded(panel, 'STOCK', false);
      await expectExpanded(panel, 'SEASON', false);
    });
  }
});
