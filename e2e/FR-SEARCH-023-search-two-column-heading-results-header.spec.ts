import { expect, test, type Page } from '@playwright/test';

// FREQ-188-AC-03 / FREQ-191-AC-02 / FREQ-196-AC-01・02 / FREQ-197-AC-01〜03 / FREQ-198-AC-01・03:
// searchページの2カラム化（md 以上）、モバイルの見出し、結果ヘッダーの表示を、
// 匿名の訪問者が /search?q=a を開いた状態で確かめる。
// 見出しの無い要求が集まる送り元 null の枠（search:public 120 回/600 秒）を他の検索の試験と取り合わないよう、このファイルだけの
// x-real-ip を付ける（E2E の固定の環境 CLIENT_IP_HEADER=x-real-ip が信頼する見出し。x-forwarded-for は読まれない）。
test.use({ extraHTTPHeaders: { 'x-real-ip': '198.18.23.23' } });

const MOBILE = { name: 'mobile', width: 390, height: 844 } as const;
const TABLET = { name: 'tablet', width: 768, height: 1024 } as const;
const DESKTOP = { name: 'desktop', width: 1280, height: 800 } as const;
const ALL_VIEWPORTS = [MOBILE, TABLET, DESKTOP] as const;

async function openSearch(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto('/search?q=a');
  // 結果行の表示（＝ローディング完了）を待ってから計測する
  await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.scrollingElement!;
    return el.scrollWidth > el.clientWidth;
  });
}

test.describe('FR-SEARCH-023 searchページの2カラム・見出し・結果ヘッダー', () => {
  for (const vp of ALL_VIEWPORTS) {
    test(`FREQ-188-AC-03 ${vp.name} 3つの幅で横にはみ出さない`, async ({ page }) => {
      await openSearch(page, vp);
      expect(await hasHorizontalScroll(page)).toBe(false);
    });

    test(`FREQ-191-AC-02 ${vp.name} 「{件数} RESULTS」が今までどおり出る`, async ({ page }) => {
      await openSearch(page, vp);
      await expect(page.getByText(/\d+ RESULTS/)).toBeVisible();
    });

    test(`FREQ-196-AC-01 ${vp.name} 結果を出した時に RELEVANCE が出ない`, async ({ page }) => {
      await openSearch(page, vp);
      await expect(page.getByText('RELEVANCE', { exact: true })).toBeHidden();
    });

    test(`FREQ-196-AC-02 ${vp.name} 「{件数} RESULTS」が従来どおり維持される`, async ({ page }) => {
      await openSearch(page, vp);
      await expect(page.getByText(/\d+ RESULTS/)).toBeVisible();
    });

    test(`FREQ-197-AC-03 ${vp.name} 横スクロールが発生しない`, async ({ page }) => {
      await openSearch(page, vp);
      expect(await hasHorizontalScroll(page)).toBe(false);
    });
  }

  test(`FREQ-197-AC-01 ${TABLET.name} 2カラムでタブが縦に並び左カラムが sticky`, async ({ page }) => {
    await openSearch(page, TABLET);

    const resultsHeader = page.getByText(/\d+ RESULTS/);
    await expect(resultsHeader).toBeVisible();

    const measured = await page.evaluate(() => {
      const field = document.querySelector('input[type="search"]')!.getBoundingClientRect();
      const header = [...document.querySelectorAll('p')]
        .find((p) => /\d+ RESULTS/.test(p.textContent ?? ''))!
        .getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect());
      const leftColumn = document.querySelector('h1')!.parentElement!;
      return {
        fieldRight: field.x + field.width,
        headerX: header.x,
        tabCount: tabs.length,
        tabsSameX: tabs.every((t) => Math.abs(t.x - tabs[0].x) <= 2),
        tabsStacked: tabs.every((t, i) => i === 0 || t.y > tabs[i - 1].y + tabs[i - 1].height - 1),
        leftColumnPosition: getComputedStyle(leftColumn).position,
      };
    });

    // 検索フィールドと結果ヘッダーが横並びの2カラム
    expect(measured.headerX).toBeGreaterThan(measured.fieldRight);
    // 種別フィルタが縦並び
    expect(measured.tabCount).toBeGreaterThanOrEqual(2);
    expect(measured.tabsSameX).toBe(true);
    expect(measured.tabsStacked).toBe(true);
    // 左カラムの position が sticky
    expect(measured.leftColumnPosition).toBe('sticky');
  });

  test(`FREQ-197-AC-02 ${TABLET.name} 左カラムの内容が縦中央寄りにある`, async ({ page }) => {
    await openSearch(page, TABLET);

    const heading = page.getByRole('heading', { level: 1, name: 'SEARCH' });
    const lastTab = page.getByRole('tab').last();
    await expect(heading).toBeVisible();
    await expect(lastTab).toBeVisible();

    const headingBox = (await heading.boundingBox())!;
    const lastTabBox = (await lastTab.boundingBox())!;

    // 見出し上端 > ビューポート高の 10%
    expect(headingBox.y).toBeGreaterThan(TABLET.height * 0.1);
    // 最後のフィルタ下端 < ビューポート高の 95%
    expect(lastTabBox.y + lastTabBox.height).toBeLessThan(TABLET.height * 0.95);
  });

  test(`FREQ-197-AC-03 ${MOBILE.name} 縦積み1カラムで種別フィルタが横並び`, async ({ page }) => {
    await openSearch(page, MOBILE);

    const measured = await page.evaluate(() => {
      const field = document.querySelector('input[type="search"]')!.getBoundingClientRect();
      const header = [...document.querySelectorAll('p')]
        .find((p) => /\d+ RESULTS/.test(p.textContent ?? ''))!
        .getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect());
      return {
        fieldBottom: field.y + field.height,
        headerY: header.y,
        tabCount: tabs.length,
        tabsSameY: tabs.every((t) => Math.abs(t.y - tabs[0].y) <= 2),
        tabsSideBySide: tabs.every((t, i) => i === 0 || t.x > tabs[i - 1].x + tabs[i - 1].width - 1),
      };
    });

    // 縦積み1カラム: 結果ヘッダーは検索フィールドより下
    expect(measured.headerY).toBeGreaterThan(measured.fieldBottom - 1);
    // 種別フィルタ横並び: y が揃い x が右へ進む
    expect(measured.tabCount).toBeGreaterThanOrEqual(2);
    expect(measured.tabsSameY).toBe(true);
    expect(measured.tabsSideBySide).toBe(true);
  });

  test(`FREQ-198-AC-01 ${MOBILE.name} h1 の描画高さが 1px 以下`, async ({ page }) => {
    await openSearch(page, MOBILE);
    const heading = page.locator('h1');
    await expect.poll(() => heading.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  });

  for (const vp of [TABLET, DESKTOP]) {
    test(`FREQ-198-AC-03 ${vp.name} h1 が今までどおり見える`, async ({ page }) => {
      await openSearch(page, vp);
      const heading = page.getByRole('heading', { level: 1, name: 'SEARCH' });
      await expect(heading).toBeVisible();
      const height = await heading.evaluate((el) => el.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(20);
    });
  }
});
