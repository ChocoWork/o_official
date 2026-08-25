import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-300: 情報カラムの縦間隔を φ の3段ラダー（選択 < アクション < グループ境界）にする

const PHI = 1.618;

const item = {
  ...sampleItemDetail({
    name: 'Short Sleeveless Vest',
    price: 24800,
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
  }),
  material: 'リネン100%',
  origin: 'Japan',
};

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** 実測ギャップと、トークンを probe で解決した期待値をまとめて取得する */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`not found: ${selector}`);
      return el.getBoundingClientRect();
    };

    const identity = rect('[data-testid="item-detail-identity"]');
    const description = rect('[data-testid="item-detail-description"]');
    const specTable = rect('[data-testid="item-spec-table"]');
    const swatchRow = rect(
      '[data-testid="item-spec-table"] > div:first-child',
    );
    const sizeSelect = rect('[data-testid="item-size-select"]');
    const actions = rect('[data-testid="item-actions-main"]');
    const specList = rect('[data-testid="item-spec-list"]');

    // 期待値は px 直値ではなくトークンから解決する
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const resolve = (token: string) => {
      probe.style.marginTop = `var(${token})`;
      return parseFloat(getComputedStyle(probe).marginTop);
    };
    const expected = {
      select: resolve('--lk-item-detail-select-gap'),
      action: resolve('--lk-item-detail-action-gap'),
      section: resolve('--lk-item-detail-section-gap'),
    };
    probe.remove();

    return {
      selectGap: sizeSelect.top - swatchRow.bottom,
      actionGap: actions.top - sizeSelect.bottom,
      sectionGaps: [
        description.top - identity.bottom,
        specTable.top - description.bottom,
        specList.top - actions.bottom,
      ],
      expected,
    };
  });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-050 近接ラダー (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-300-AC-01: 選択 < アクション < グループ境界 の順に広がる', async ({
      page,
    }) => {
      await openItemDetail(page);
      const m = await measure(page);

      expect(m.selectGap).toBeCloseTo(m.expected.select, 0);
      expect(m.actionGap).toBeCloseTo(m.expected.action, 0);
      expect(m.sectionGaps[0]).toBeCloseTo(m.expected.section, 0);

      expect(m.selectGap).toBeLessThan(m.actionGap);
      expect(m.actionGap).toBeLessThan(m.sectionGaps[0]);
    });

    test('FREQ-300-AC-02: 各段の比が φ になっている', async ({ page }) => {
      await openItemDetail(page);
      const m = await measure(page);

      expect(m.actionGap / m.selectGap).toBeCloseTo(PHI, 1);
      expect(m.sectionGaps[0] / m.actionGap).toBeCloseTo(PHI, 1);
    });

    test('FREQ-300-AC-03: 3つのグループ境界が同じ間隔である', async ({
      page,
    }) => {
      await openItemDetail(page);
      const m = await measure(page);

      for (const gap of m.sectionGaps) {
        expect(Math.abs(gap - m.expected.section)).toBeLessThanOrEqual(1);
      }
    });
  });
}
