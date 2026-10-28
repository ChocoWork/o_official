import { expect, test, type Locator, type Page } from '@playwright/test';

// SEARCH の画面の流れ（/search と /?q=）を、ログインせずに 3 つの幅で確かめる。
// 見本のデータは supabase/seed.sql（手元の Supabase）の商品 Tsubame Brass Brooch・
// ルック Paper Moon・ニュース Synthetic Sustainability Note を使う。
// 対象: FREQ-01-AC-01 / FR-SEARCH-001-AC-02・AC-03 / FR-SEARCH-002-AC-02 / FR-SEARCH-003-AC-02 /
//       FREQ-189-AC-02 / SEC-SEARCH-011-AC-01 / SEC-SEARCH-021-AC-01 / SEC-SEARCH-021-AC-02
// SEC-SEARCH-017-AC-01（検索の関数が失敗した時の表示）は DB の関数の権限を外すので、他の試験を壊さないよう
// 最後に単独で流す FR-SEARCH-022 に置く。
//
// 回数の制限: 見出しの無い要求が集まる 1 つの枠（送り元 null。search:public 120 回/600 秒）を他の検索の試験と取り合わないよう、
// このファイルだけの x-real-ip を付ける（E2E の固定の環境 CLIENT_IP_HEADER=x-real-ip が信頼する見出し。x-forwarded-for は読まれない）。
// 付け忘れると送り元 null の 1 つの枠を全部の試験で取り合う。
test.use({ extraHTTPHeaders: { 'x-real-ip': '198.18.18.18' } });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type TabLabel = 'ALL' | 'ITEM' | 'LOOK' | 'NEWS';

const OTHER_TYPES: Record<Exclude<TabLabel, 'ALL'>, string> = {
  ITEM: 'LOOK|NEWS',
  LOOK: 'ITEM|NEWS',
  NEWS: 'ITEM|LOOK',
};

function resultRows(page: Page): Locator {
  return page.getByTestId('search-result-row');
}

// 結果の行の 1 つ目の p が種別（ITEM / LOOK / NEWS）。
function rowsOfType(page: Page, type: string): Locator {
  return resultRows(page).filter({ has: page.locator('p', { hasText: new RegExp(`^(${type})$`) }) });
}

function searchTab(page: Page, label: TabLabel): Locator {
  return page.getByRole('tab', { name: label, exact: true });
}

async function selectTab(page: Page, label: TabLabel): Promise<void> {
  await searchTab(page, label).click();
  await expect(searchTab(page, label)).toHaveAttribute('aria-selected', 'true');
}

// 一覧が読み込み中でなく、件数の見出しが出るまで待つ（読み込み中の骨組みでの見かけの成功を避ける）。
async function waitForResultsHeader(page: Page): Promise<void> {
  await expect(page.getByText(/^\d+ RESULTS$/)).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-SEARCH-018 search page flows (${vp.name} ${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test(`FREQ-01-AC-01 ${vp.name} ヘッダーの虫眼鏡から単語で商品を検索すると、エラーが出ず関連する商品が表示される`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto('/');
      await page.getByRole('link', { name: '検索', exact: true }).first().click();
      await expect(page).toHaveURL(/\/search$/);

      const searchResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/search' &&
          new URL(response.url()).searchParams.get('q') === 'Tsubame',
      );
      await page.getByRole('combobox', { name: 'Search' }).fill('Tsubame');
      await page.getByRole('combobox', { name: 'Search' }).press('Enter');
      expect((await searchResponse).status()).toBe(200);

      await waitForResultsHeader(page);
      await expect(rowsOfType(page, 'ITEM').filter({ hasText: 'Tsubame Brass Brooch' })).toBeVisible();
      await expect(page.getByText('検索結果を読み込めませんでした')).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    });

    test(`FR-SEARCH-001-AC-02 ${vp.name} ITEM・LOOK・NEWS のタブを押すと tab が item・look・news に変わり、その種別の結果だけが表示される`, async ({
      page,
    }) => {
      // 'Synthetic' は商品の説明・ルックの説明・ニュースの題のどれにも含まれる（seed.sql）。
      await page.goto('/search?q=Synthetic');
      await waitForResultsHeader(page);
      await expect(rowsOfType(page, 'ITEM').first()).toBeVisible();
      await expect(rowsOfType(page, 'LOOK').first()).toBeVisible();
      await expect(rowsOfType(page, 'NEWS').first()).toBeVisible();

      for (const [label, param] of [
        ['ITEM', 'item'],
        ['LOOK', 'look'],
        ['NEWS', 'news'],
      ] as const) {
        await selectTab(page, label);
        await expect(page).toHaveURL(new RegExp(`[?&]tab=${param}(&|$)`));
        await waitForResultsHeader(page);
        await expect(rowsOfType(page, label).first()).toBeVisible();
        await expect(rowsOfType(page, OTHER_TYPES[label])).toHaveCount(0);
      }
    });

    test(`FR-SEARCH-001-AC-03 ${vp.name} /search?q=<語>&tab=look を開くと LOOK のタブが選ばれ、LOOK の結果だけが表示される`, async ({
      page,
    }) => {
      await page.goto('/search?q=Paper&tab=look');

      await expect(searchTab(page, 'LOOK')).toHaveAttribute('aria-selected', 'true');
      for (const other of ['ALL', 'ITEM', 'NEWS'] as const) {
        await expect(searchTab(page, other)).toHaveAttribute('aria-selected', 'false');
      }
      await waitForResultsHeader(page);
      await expect(rowsOfType(page, 'LOOK').filter({ hasText: 'Paper Moon' })).toBeVisible();
      await expect(rowsOfType(page, 'ITEM|NEWS')).toHaveCount(0);
    });

    test(`FR-SEARCH-002-AC-02 ${vp.name} /?q=<語> を開くとホームに Search Preview の見出しと商品の名前が表示される`, async ({
      page,
    }) => {
      await page.goto('/?q=Tsubame');

      const preview = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Search Preview' }),
      });
      await expect(page.getByRole('heading', { name: 'Search Preview' })).toBeVisible();
      await expect(preview.getByRole('heading', { name: 'Tsubame Brass Brooch' })).toBeVisible();
    });

    test(`FR-SEARCH-003-AC-02 ${vp.name} 商品・ルック・ニュースの題に含まれる語で、ITEM・LOOK・NEWS のタブにそれぞれその行が表示される`, async ({
      page,
    }) => {
      const cases = [
        { query: 'Tsubame', title: 'Tsubame Brass Brooch', tab: 'ITEM' },
        { query: 'Paper Moon', title: 'Paper Moon', tab: 'LOOK' },
        { query: 'Sustainability Note', title: 'Synthetic Sustainability Note', tab: 'NEWS' },
      ] as const;

      for (const { query, title, tab } of cases) {
        await page.goto(`/search?q=${encodeURIComponent(query)}`);
        await waitForResultsHeader(page);

        for (const label of ['ITEM', 'LOOK', 'NEWS'] as const) {
          await selectTab(page, label);
          await waitForResultsHeader(page);
          const titledRow = rowsOfType(page, label).filter({ hasText: title });
          if (label === tab) {
            await expect(titledRow).toBeVisible();
          } else {
            // 他の種別のタブには、その行が出ない（0 件の見出しまで待ってから確かめる）。
            await expect(page.getByText('0 RESULTS', { exact: true })).toBeVisible();
            await expect(titledRow).toHaveCount(0);
            await expect(resultRows(page).filter({ hasText: title })).toHaveCount(0);
          }
        }
      }
    });

    test(`FREQ-189-AC-02 ${vp.name} 検索を実行しても localStorage に search.history が保存されない`, async ({
      page,
    }) => {
      await page.goto('/search');
      await page.getByRole('combobox', { name: 'Search' }).fill('Tsubame');
      await page.getByRole('combobox', { name: 'Search' }).press('Enter');
      await expect(page).toHaveURL(/[?&]q=Tsubame(&|$)/);
      await waitForResultsHeader(page);
      await expect(rowsOfType(page, 'ITEM').filter({ hasText: 'Tsubame Brass Brooch' })).toBeVisible();

      const stored = await page.evaluate(() => ({
        history: window.localStorage.getItem('search.history'),
        keys: Object.keys(window.localStorage),
      }));
      expect(stored.history).toBeNull();
      expect(stored.keys).not.toContain('search.history');
    });

    test(`SEC-SEARCH-011-AC-01 ${vp.name} 目印の語で検索した後、localStorage・sessionStorage の全部の値と document.cookie にその語が含まれない`, async ({
      page,
    }) => {
      const marker = 'Tsubame';
      await page.goto('/search');
      await page.getByRole('combobox', { name: 'Search' }).fill(marker);
      await page.getByRole('combobox', { name: 'Search' }).press('Enter');
      await expect(page).toHaveURL(/[?&]q=Tsubame(&|$)/);
      await waitForResultsHeader(page);
      await expect(rowsOfType(page, 'ITEM').filter({ hasText: 'Tsubame Brass Brooch' })).toBeVisible();

      const holders = await page.evaluate(() => {
        const dump = (storage: Storage): string[] =>
          Object.keys(storage).map((key) => storage.getItem(key) ?? '');
        return {
          local: dump(window.localStorage),
          session: dump(window.sessionStorage),
          cookie: document.cookie,
        };
      });
      const needle = marker.toLowerCase();
      const decoded = (value: string): string => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const containing = (value: string) => decoded(value).toLowerCase().includes(needle);

      expect(holders.local.filter(containing)).toEqual([]);
      expect(holders.session.filter(containing)).toEqual([]);
      expect(containing(holders.cookie)).toBe(false);
    });

    test(`SEC-SEARCH-021-AC-01 ${vp.name} /?q=<文> で開いても、プレビューの区画の説明の文にその文が含まれない`, async ({
      page,
    }) => {
      const sentence = '本日休業のお知らせ';
      await page.goto(`/?q=${encodeURIComponent(`Tsubame ${sentence}`)}`);

      // 見出しと説明は同じ描画で出るので、見出しが出てから説明の文を確かめる（描画前の 0 件での見かけの成功を避ける）
      const previewSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Search Preview' }),
      });
      await expect(previewSection.getByRole('heading', { name: 'Search Preview' })).toBeVisible();
      await expect(previewSection.locator('p').filter({ hasText: sentence })).toHaveCount(0);
    });

    // 文言と枠の見た目は案。ユーザーが写真で確かめるまで確定しない（ADR-0314）。写真は controller が回収する。
    test(`SEC-SEARCH-021-AC-02 ${vp.name} /?q=<語> のプレビューの区画に固定の説明の文と「検索した語」の枠があり、語は説明の文に無く枠に出る`, async ({
      page,
    }) => {
      // 結果のカードが出る実在の語を使う（カードの無い写真では見た目が確かめられない）。細工した文での確かめは AC-01。
      const term = 'Tsubame';
      const fixedSentence = '入力した語に関連する結果をホーム上で即時プレビューしています。';
      await page.goto(`/?q=${encodeURIComponent(term)}`);

      const previewSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Search Preview' }),
      });
      await expect(previewSection.getByRole('heading', { name: 'Search Preview' })).toBeVisible();
      // 説明の文は固定で、語を含まない（カードの題・説明は別の要素）
      await expect(previewSection.locator('p', { hasText: fixedSentence })).toHaveText(fixedSentence);

      const termBox = previewSection.getByTestId('search-preview-term');
      await expect(termBox).toBeVisible();
      await expect(termBox.locator('dt')).toHaveText('検索した語');
      await expect(termBox.locator('dd')).toHaveText(term);
      // 結果のカードが出てから写真を撮る（描画前の写真を避ける）
      await expect(previewSection.getByRole('heading', { name: 'Tsubame Brass Brooch' })).toBeVisible();

      await previewSection.screenshot({
        path: `test-results/wave1c/search-021-preview-${vp.width}.png`,
        animations: 'disabled',
      });
      await page.screenshot({
        path: `test-results/wave1c/search-021-page-${vp.width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    });
  });
}
