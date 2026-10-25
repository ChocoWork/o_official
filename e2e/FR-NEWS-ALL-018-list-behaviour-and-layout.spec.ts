import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';

// NEWS 一覧の振る舞い（非公開の除外・分類の絞り込み・URL の復元・詳細への遷移）と、
// FILTER 選択肢の字間・4ページのサイドバー幅と本文の左余白の一致を確かめる。
// 前提: 手元の Supabase に supabase/seed.sql の公開ニュース8件
// （COLLECTION×4・EVENT・COLLABORATION・SUSTAINABILITY・STORE）が入っている。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** aside（左サイドバー）が出るのは lg(1024px) 以上。未満は FILTER ボタンの Drawer に入る。 */
const LG_MIN_WIDTH = 1024;

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('非公開の記事を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function cardLocator(page: Page) {
  return page.locator('a[href^="/news/"]:has(article)');
}

type Card = { href: string; title: string; category: string };

async function readCards(page: Page): Promise<Card[]> {
  return cardLocator(page).evaluateAll((links) =>
    links.map((link) => ({
      href: link.getAttribute('href') ?? '',
      title: link.querySelector('article h2')?.textContent?.trim() ?? '',
      category: link.querySelector('[data-ui-tag-label]')?.textContent?.trim() ?? '',
    })),
  );
}

async function openNews(page: Page, path = '/news') {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(cardLocator(page).first()).toBeVisible();
}

/** デスクトップは左サイドバーの中、モバイル・タブレットは FILTER の Drawer を開いた中から探す。 */
async function categoryCheckboxes(page: Page, width: number) {
  if (width >= LG_MIN_WIDTH) {
    return (name: string) => page.locator('aside').getByRole('checkbox', { name, exact: true });
  }
  await page.locator('[data-filter-button=floating]').click();
  const checkbox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  await expect(checkbox('ALL')).toBeVisible();
  return checkbox;
}

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`FR-NEWS-ALL-018 NEWS 一覧の振る舞い (${name} ${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test(`FR-NEWS-ALL-001-AC-02 ${name}: 非公開の記事の題が一覧に表示されない`, async ({ page }) => {
      const title = `E2E private news ${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
      const admin = localAdmin();
      const { data, error } = await admin
        .from('news_articles')
        .insert({
          title,
          category: 'EVENT',
          // 表示されるなら先頭に来る日付にして、見落としにくくする。
          published_date: '2099-01-01',
          image_url: 'e2e/private.png',
          content: 'E2E private news content.',
          detailed_content: 'E2E private news detail.',
          status: 'private',
        })
        .select('id')
        .single();
      if (error || !data) {
        throw new Error(`非公開の記事を作れない（code: ${error?.code ?? '不明'}）`);
      }

      try {
        await openNews(page);
        // 公開済みの記事は出ているが、非公開の記事の題はどこにも出ない。
        expect((await readCards(page)).length).toBeGreaterThan(0);
        await expect(page.getByText(title)).toHaveCount(0);
        expect((await readCards(page)).map((card) => card.title)).not.toContain(title);
      } finally {
        await admin.from('news_articles').delete().eq('id', data.id);
      }
    });

    test(`FR-NEWS-ALL-002-AC-02 ${name}: 1つの分類を選ぶと表示される記事カードの分類がすべて選んだ分類になる`, async ({ page }) => {
      await openNews(page);
      const before = await readCards(page);
      // 絞る前は複数の分類が並んでいる（絞り込みが効いたことを区別できる）。
      expect(new Set(before.map((card) => card.category)).size).toBeGreaterThan(1);

      const checkbox = await categoryCheckboxes(page, width);
      await checkbox('EVENT').click();
      await expect(page).toHaveURL(/\/news\?category=EVENT$/);

      // 1件以上あり、分類が選んだ EVENT だけになる。
      await expect
        .poll(async () => [...new Set((await readCards(page)).map((card) => card.category))])
        .toEqual(['EVENT']);
    });

    test(`FR-NEWS-ALL-002-AC-03 ${name}: ALL を選ぶと公開済みの記事がすべて表示される`, async ({ page }) => {
      // 他のテストが同時に公開日 2000-01-01 の行を足し引きするので、一覧全体の一致ではなく
      // 見本の公開済み記事（id 1〜8）がすべて並ぶことを見る。
      const { data, error } = await localAdmin()
        .from('news_articles')
        .select('title')
        .lte('id', 8)
        .eq('status', 'published');
      expect(error).toBeNull();
      const seedTitles = (data ?? []).map((row) => (row as { title: string }).title);
      expect(seedTitles.length).toBeGreaterThan(1);

      await openNews(page);
      const checkbox = await categoryCheckboxes(page, width);
      await checkbox('EVENT').click();
      await expect(page).toHaveURL(/\/news\?category=EVENT$/);
      // 絞った間は見本の全題は並ばない。
      await expect
        .poll(async () => {
          const titles = (await readCards(page)).map((card) => card.title);
          return seedTitles.every((title) => titles.includes(title));
        })
        .toBe(false);

      await checkbox('ALL').click();
      await expect(page).toHaveURL(/\/news$/);
      await expect
        .poll(async () => (await readCards(page)).map((card) => card.title))
        .toEqual(expect.arrayContaining(seedTitles));
    });

    test(`FR-NEWS-ALL-003-AC-02 ${name}: /news?category=EVENT を開くと EVENT が選ばれた状態で表示される`, async ({ page }) => {
      await openNews(page, '/news?category=EVENT');

      const checkbox = await categoryCheckboxes(page, width);
      await expect(checkbox('EVENT')).toBeChecked();
      await expect(checkbox('ALL')).not.toBeChecked();
      await expect(checkbox('COLLECTION')).not.toBeChecked();
    });

    test(`FR-NEWS-ALL-004-AC-02 ${name}: 記事カードを押すとその記事の詳細ページ（/news/<id>）が表示される`, async ({ page }) => {
      await openNews(page);
      const [first] = await readCards(page);
      expect(first.href).toMatch(/^\/news\/[0-9a-f-]+$/);
      expect(first.title).not.toBe('');

      await cardLocator(page).first().click();

      await expect(page).toHaveURL(new RegExp(`${first.href}$`));
      await expect(page.getByRole('heading', { level: 1, name: first.title, exact: true })).toBeVisible();
    });

    test(`FREQ-48-AC-02 ${name}: FILTER 選択肢ラベルの letter-spacing が ITEM 一覧と一致する`, async ({ page }) => {
      async function labelLetterSpacing(path: string): Promise<string> {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        if (width < LG_MIN_WIDTH) {
          await page.locator('[data-filter-button=floating]').click();
        }
        const label = page
          .locator('.multiselect__option-list:visible')
          .first()
          .locator('[data-ui-checkbox-label]')
          .first();
        await expect(label).toBeVisible();
        return label.evaluate((el) => getComputedStyle(el).letterSpacing);
      }

      const news = await labelLetterSpacing('/news');
      const item = await labelLetterSpacing('/item');

      expect(news).not.toBe('');
      expect(news).toBe(item);
    });
  });
}

// FREQ-119: NEWS / ITEM / LOOK / STOCKIST の4ページで、左サイドバー幅と本文の左余白を統一する。
// 左サイドバーは lg(1024px) 以上でだけ出るため、デスクトップの xl(1280) と 2xl(1536) で確かめる。
const LIST_PAGES = [
  { name: 'ITEM', path: '/item' },
  { name: 'NEWS', path: '/news' },
  { name: 'LOOK', path: '/look' },
  { name: 'STOCKIST', path: '/stockist' },
] as const;

async function measureSidebar(page: Page, path: string): Promise<{ width: number; gapPaddingLeft: number }> {
  await page.goto(path);
  const aside = page.locator('aside').first();
  await expect(aside).toBeVisible();

  return aside.evaluate((el) => {
    const width = el.getBoundingClientRect().width;
    // aside の次の兄弟が本文の列。その左パディングがフィルターとの間隔になる。
    const content = el.nextElementSibling as HTMLElement;
    const gapPaddingLeft = parseFloat(getComputedStyle(content).paddingLeft);
    return { width: Math.round(width), gapPaddingLeft: Math.round(gapPaddingLeft) };
  });
}

for (const { label, width } of [
  { label: 'desktop 1280px', width: 1280 },
  { label: 'desktop 1536px', width: 1536 },
] as const) {
  test.describe(`FR-NEWS-ALL-018 4ページのフィルター幅と本文の左余白 (${label})`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test(`FREQ-119-AC-01 ${label}: 4ページ（ITEM・NEWS・LOOK・STOCKIST）の左サイドバー幅が一致する`, async ({ page }) => {
      const widths: Array<{ name: string; width: number }> = [];
      for (const { name, path } of LIST_PAGES) {
        widths.push({ name, width: (await measureSidebar(page, path)).width });
      }

      const [reference] = widths;
      expect(reference.width).toBeGreaterThan(0);
      for (const measured of widths) {
        expect(measured.width, `${measured.name} sidebar width`).toBe(reference.width);
      }
    });

    test(`FREQ-119-AC-02 ${label}: 4ページのメインコンテンツ列の左余白（フィルターとの間隔）が一致する`, async ({ page }) => {
      const gaps: Array<{ name: string; gapPaddingLeft: number }> = [];
      for (const { name, path } of LIST_PAGES) {
        gaps.push({ name, gapPaddingLeft: (await measureSidebar(page, path)).gapPaddingLeft });
      }

      const [reference] = gaps;
      expect(reference.gapPaddingLeft).toBeGreaterThan(0);
      for (const measured of gaps) {
        expect(measured.gapPaddingLeft, `${measured.name} gap to main`).toBe(reference.gapPaddingLeft);
      }
    });
  });
}
