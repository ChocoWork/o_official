import { expect, test, type Page } from '@playwright/test';
import {
  checkArea,
  closeDrawer,
  expandRegion,
  KINKI_PREFECTURES,
  openFilterScope,
  SEED_STOCKISTS,
  STOCKIST_VIEWPORTS as VIEWPORTS,
  stockistCardByName,
} from './stockist-test-utils';

// FR-STOCKIST-011: 取扱店の公開の頁（/stockist とホーム）の格子の列・カードの中身・WONT の部品が無いこと・
// フィルターの出し分けを、3つの幅で確かめる。
// 前提: 手元の Supabase の見本の取扱店 6 件（全部公開）。
//   Aoyama Sample Select（東京都）/ Osaka Sample Select（大阪府）/ Kyoto Sample Select（京都府）/
//   Ginza Sample Store（東京都）/ Kobe Sample Store（兵庫県）/ Tokyo Synthetic Flagship（東京都）
// 読むだけで、ログイン・DB の書き込みは無い。
// 他のファイルの試験が公開の店を足す・消すことがあるので、件数は「見本の店の名前で絞ったカード」で数える
// （カードの総数を 6 と決めつけない）。全件を非公開にする・1001 件を足す試験は FR-STOCKIST-017 に分けてあり、全部の後に流れる。

const SEED_NAME_PATTERN = new RegExp(`^(${SEED_STOCKISTS.map((shop) => shop.name).join('|')})$`);
const GRID = '.stockist-grid-catalog';
const MAPS_LINK = 'a[href^="https://www.google.com/maps"]';

const INVALID_PREF_QUERY = `?pref=${encodeURIComponent('<script>,存在しない県')}`;

async function openCatalog(page: Page, width: number, height: number, query = '') {
  await page.setViewportSize({ width, height });
  await page.goto(`/stockist${query}`);
  await expect(stockistCardByName(page, SEED_STOCKISTS[0].name)).toBeVisible();
}

/** 格子の中のカードのうち、見本の店のもの */
function seedCards(page: Page) {
  return page
    .locator(`${GRID} article`)
    .filter({ has: page.getByRole('heading', { level: 3, name: SEED_NAME_PATTERN }) });
}

/** 見本の 6 件のうち、names の店だけがちょうど 1 枚ずつ出て、ほかの見本の店は出ていない */
async function expectOnlySeedStores(page: Page, names: readonly string[]) {
  for (const shop of SEED_STOCKISTS) {
    await expect(stockistCardByName(page, shop.name), shop.name).toHaveCount(names.includes(shop.name) ? 1 : 0);
  }
}

/** 格子に出ているカード全部の住所の字 */
async function shownAddresses(page: Page): Promise<string[]> {
  return page.locator(`${GRID} article ${MAPS_LINK}`).allInnerTexts();
}

// 格子の列の数 = カードの左端の位置の種類の数。
async function countColumns(page: Page): Promise<number> {
  return page
    .locator(`${GRID} article`)
    .evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size);
}

test.describe('FR-STOCKIST-011 公開の頁の格子・カード・フィルターの出し分け', () => {
  // ---- FR-STOCKIST-001-AC-01 / AC-02: 列の数 ----
  for (const { name, width, height, columns } of [
    { name: 'mobile', width: 390, height: 844, columns: 1 },
    { name: 'tablet', width: 768, height: 1024, columns: 2 },
    { name: 'desktop', width: 1280, height: 800, columns: 3 },
  ]) {
    test(`FR-STOCKIST-001-AC-01 ${name}(${width}px): カードの格子が${columns}列になる`, async ({ page }) => {
      await openCatalog(page, width, height);
      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);
      expect(await countColumns(page)).toBe(columns);
    });
  }

  test('FR-STOCKIST-001-AC-02 wide(1536px): カードの格子が4列になる', async ({ page }) => {
    await openCatalog(page, 1536, 900);
    await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);
    expect(await countColumns(page)).toBe(4);
  });

  // ---- FR-STOCKIST-002-AC-02: モバイルのカード ----
  test('FR-STOCKIST-002-AC-02 mobile(390px): 各カードに店舗名（見出し）と住所が出る', async ({ page }) => {
    await openCatalog(page, 390, 844);
    for (const shop of SEED_STOCKISTS) {
      const card = stockistCardByName(page, shop.name);
      await expect(card).toHaveCount(1);
      await expect(card.getByRole('heading', { level: 3 })).toBeVisible();
      await expect(card.getByRole('link', { name: shop.address, exact: true })).toBeVisible();
    }
  });

  // ---- FR-STOCKIST-004-AC-02: ホームの取扱店は最大6件を全部出す ----
  for (const { name, width, height } of [
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`FR-STOCKIST-004-AC-02 ${name}(${width}px): ホームの取扱店の節に見えているカードがちょうど6件`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const section = page.locator('#stockist');
      await expect(section).toBeVisible();
      // ホームは id の小さい公開の 6 件。見本の店（id 1〜6）が全部ある限り、他の試験の足した行は入らない
      await expect(section.locator('article:visible')).toHaveCount(6);
      for (const shop of SEED_STOCKISTS) {
        await expect(section.locator('article:visible').filter({ hasText: shop.name })).toHaveCount(1);
      }
    });
  }

  // ---- FR-STOCKIST-006-AC-01 / 007-AC-01: WONT の部品が無い ----
  for (const vp of VIEWPORTS) {
    test(`FR-STOCKIST-006-AC-01 ${vp.name}: 検索の入力欄・並び替え・ページ送りが無く、全部の店が1つの格子に出る`, async ({ page }) => {
      await openCatalog(page, vp.width, vp.height);
      // 本文の領域（ヘッダー・フッターは除く）。格子とフィルターはこの中にある。
      const content = page.getByRole('main');
      const controlName = /次|前|next|prev|more|もっと|ページ|page|sort|並び替え|並べ替え/i;
      await expect(content.getByRole('searchbox')).toHaveCount(0);
      await expect(content.getByRole('textbox')).toHaveCount(0);
      await expect(content.getByRole('combobox')).toHaveCount(0);
      await expect(content.getByRole('listbox')).toHaveCount(0);
      await expect(content.locator('select, input[type="search"], input[type="text"]')).toHaveCount(0);
      await expect(content.getByRole('navigation')).toHaveCount(0);
      await expect(content.getByRole('button', { name: controlName })).toHaveCount(0);
      await expect(content.getByRole('link', { name: controlName })).toHaveCount(0);

      // 格子は1つで、見本の店は全部その中に1枚ずつ出る。格子の外にカードは無い（ページ送りで分けていない）
      const grid = page.locator(GRID);
      await expect(grid).toHaveCount(1);
      for (const shop of SEED_STOCKISTS) {
        await expect(stockistCardByName(page, shop.name), shop.name).toHaveCount(1);
        await expect(grid.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: shop.name, exact: true }) }), shop.name).toHaveCount(1);
      }
      await expect(page.locator('article')).toHaveCount(await grid.locator('article').count());
    });

    test(`FR-STOCKIST-007-AC-01 ${vp.name}: 各カードに img と取扱の分類の表示が無い`, async ({ page }) => {
      await openCatalog(page, vp.width, vp.height);
      const cards = seedCards(page);
      await expect(cards).toHaveCount(SEED_STOCKISTS.length);
      await expect(cards.locator('img, picture, svg, [role="img"]')).toHaveCount(0);
      // 見本の分類: SELECT SHOP / STORE / FLAGSHIP STORE（店名の Store とは大文字小文字で区別する）。
      for (const text of await cards.allInnerTexts()) {
        expect(text).not.toMatch(/SELECT SHOP|FLAGSHIP STORE|\bSTORE\b/);
      }
    });
  }

  // ---- FR-STOCKIST-010-AC-03: ALL ----
  for (const vp of VIEWPORTS) {
    test(`FR-STOCKIST-010-AC-03 ${vp.name}: 県を選んだ後に ALL を選ぶと ALL に印が付き、公開の店が全部出る`, async ({ page }) => {
      await openCatalog(page, vp.width, vp.height);
      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);

      // 大阪（子）だけを選んで絞る。
      await expandRegion(page, vp.drawer, '近畿');
      await checkArea(page, vp.drawer, '大阪');
      await expect(page).toHaveURL(/pref=/);
      await expectOnlySeedStores(page, ['Osaka Sample Select']);
      for (const address of await shownAddresses(page)) {
        expect(address).toMatch(/^大阪府/);
      }

      // ALL を選ぶ。
      const scope = await openFilterScope(page, vp.drawer);
      const all = scope.getByRole('checkbox', { name: 'ALL', exact: true });
      await expect(all).not.toBeChecked();
      await scope.getByText('ALL', { exact: true }).click();
      await expect(all).toBeChecked();
      await closeDrawer(page, vp.drawer);

      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);
      await expect(page).toHaveURL((url) => !url.searchParams.has('pref'));
    });
  }

  // ---- FR-STOCKIST-010-AC-04: 1024px を境にフィルターの出し方が変わる ----
  for (const vp of VIEWPORTS) {
    const expected = vp.drawer ? '左の列が見えず FILTER のボタンが見える' : '左の列にフィルターが見え FILTER のボタンが見えない';
    test(`FR-STOCKIST-010-AC-04 ${vp.name}(${vp.width}px): ${expected}`, async ({ page }) => {
      await openCatalog(page, vp.width, vp.height);
      const filterButton = page.locator('[data-filter-button="floating"]');
      if (vp.drawer) {
        // 隠れた要素も数える指定にして、「無いから見えない」でなく「あるが隠れている」ことを確かめる
        await expect(page.getByRole('complementary', { includeHidden: true })).toBeHidden();
        await expect(filterButton).toBeVisible();
        await expect(filterButton).toHaveText('FILTER');
      } else {
        const sidebar = page.getByRole('complementary');
        await expect(sidebar).toBeVisible();
        await expect(sidebar.getByText('ALL', { exact: true })).toBeVisible();
        await expect(filterButton).toBeHidden();
        await expect(page.getByRole('button', { name: 'FILTER', exact: true })).toHaveCount(0);
      }
    });
  }

  // ---- FREQ-57-AC-03: FILTER の引き出し（モバイル・タブレット） ----
  for (const vp of VIEWPORTS.filter((v) => v.drawer)) {
    test(`FREQ-57-AC-03 ${vp.name}: FILTER ボタンで drawer が開き、近畿を選ぶと大阪・京都・兵庫の店だけが出る`, async ({ page }) => {
      await openCatalog(page, vp.width, vp.height);
      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);

      await page.locator('[data-filter-button="floating"]').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('近畿', { exact: true })).toBeVisible();
      await dialog.getByText('近畿', { exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: '近畿', exact: true })).toBeChecked();
      await dialog.getByLabel('Close filter drawer').click();

      await expect(page).toHaveURL(/pref=/);
      await expectOnlySeedStores(page, ['Osaka Sample Select', 'Kyoto Sample Select', 'Kobe Sample Store']);
      const addresses = await shownAddresses(page);
      expect(addresses.length).toBeGreaterThanOrEqual(3);
      for (const address of addresses) {
        expect(KINKI_PREFECTURES.some((prefecture) => address.startsWith(prefecture)), address).toBe(true);
      }
    });
  }

  // ---- SEC-STOCKIST-017-AC-01: 一覧に無い pref は無視される ----
  for (const vp of VIEWPORTS) {
    test(`SEC-STOCKIST-017-AC-01 ${vp.name}: 一覧に無い pref は無視され、全件が出て県の印が付かない`, async ({ page }) => {
      // 条件なしで開いた時の見本の店のカード。
      await openCatalog(page, vp.width, vp.height);
      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);
      const baseline = await seedCards(page).allInnerTexts();

      await page.goto(`/stockist${INVALID_PREF_QUERY}`);
      await expect(seedCards(page)).toHaveCount(SEED_STOCKISTS.length);
      expect(await seedCards(page).allInnerTexts()).toEqual(baseline);

      // 県の印が1つも付かない（ALL だけが付いている）。
      const scope = await openFilterScope(page, vp.drawer);
      await expect(scope.getByRole('checkbox', { name: 'ALL', exact: true })).toBeChecked();
      await expect(scope.getByRole('checkbox', { checked: true })).toHaveCount(1);
    });
  }
});
