import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { withHomeCatalogLock } from './home-test-utils';

// ホームの ITEM・LOOK の幅ごとの表示数・VIEW ALL の出し分け、ABOUT の導線、価格の字の大きさ。
// 対象: FREQ-147-AC-02・AC-03、FREQ-148-AC-01〜03、FR-HOME-003-AC-01、FREQ-280-AC-01。
// 匿名の訪問者、seed.sql そのまま（公開 ITEM 7・公開 LOOK 7）の手元の Supabase を前提にする。
// AC-03 は公開の総数を読むので、公開の行を足し引きする他の HOME の試験と home-test-utils の withHomeCatalogLock（共有）で重ならないようにする。
// FREQ-147-AC-02・FREQ-148-AC-02 は受け入れ条件の文のとおり「最大 10 件・最大 8 件」を上限として確かめる。
// 実装は FREQ-276・277 で 1280px の表示数が 6 件になっており、ちょうどの件数は FR-HOME-013 が確かめる。

const MOBILE = { name: 'mobile', width: 390, height: 844 } as const;
const TABLET = { name: 'tablet', width: 768, height: 1024 } as const;
const DESKTOP = { name: 'desktop', width: 1280, height: 800 } as const;
const WIDE = { name: 'wide', width: 1536, height: 900 } as const;

const ITEM_CARD = '#items [data-testid="item-card-link"]:visible';
const LOOK_CARD = '#look [data-testid="look-card"]:visible';

// 幅ごとの表示数（FREQ-276・277: 2xl（1536px）未満は 6 件、2xl 以上は 8 件）
function homeDisplayLimit(width: number): number {
  return width >= 1536 ? 8 : 6;
}

async function publishedCount(request: APIRequestContext, table: 'items' | 'looks'): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !isLocalUrl(url)) {
    throw new Error('公開の件数を数えられるのは手元の Supabase だけ（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY を確かめる）');
  }
  const response = await request.head(`${url}/rest/v1/${table}?select=id&status=eq.published`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Prefer: 'count=exact' },
  });
  expect(response.ok(), `${table} の件数の取得: ${response.status()}`).toBe(true);
  const range = response.headers()['content-range'] ?? '';
  const match = /\/(\d+)$/.exec(range);
  expect(match, `${table} の content-range: ${range}`).not.toBeNull();
  return Number(match?.[1]);
}

async function openHome(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto('/');
}

test.describe('FR-HOME-021 ホームの ITEM・LOOK の件数と VIEW ALL、ABOUT の導線、価格の字の大きさ', () => {
  // FREQ-147-AC-02: desktop（1280px）で ITEM カードが最大 10 件表示される
  test(`FREQ-147-AC-02 ${DESKTOP.name} ITEM カードが 1 件以上 10 件以下で表示される`, async ({ page }) => {
    await openHome(page, DESKTOP);
    const cards = page.locator(ITEM_CARD);
    await expect(cards.first()).toBeVisible();
    const visible = await cards.count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThanOrEqual(10);
  });

  // FREQ-148-AC-01: mobile（390px）/ tablet（768px）で LOOK カードが最大 6 件表示される
  for (const vp of [MOBILE, TABLET]) {
    test(`FREQ-148-AC-01 ${vp.name} LOOK カードが 1 件以上 6 件以下で表示される`, async ({ page }) => {
      await openHome(page, vp);
      const cards = page.locator(LOOK_CARD);
      await expect(cards.first()).toBeVisible();
      const visible = await cards.count();
      expect(visible).toBeGreaterThan(0);
      expect(visible).toBeLessThanOrEqual(6);
    });
  }

  // FREQ-148-AC-02: desktop（1280px）で LOOK カードが最大 8 件表示される
  test(`FREQ-148-AC-02 ${DESKTOP.name} LOOK カードが 1 件以上 8 件以下で表示される`, async ({ page }) => {
    await openHome(page, DESKTOP);
    const cards = page.locator(LOOK_CARD);
    await expect(cards.first()).toBeVisible();
    const visible = await cards.count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThanOrEqual(8);
  });

  // FREQ-147-AC-03 / FREQ-148-AC-03: 総数が表示数以下の帯域では VIEW ALL が無く、多ければある。
  // 名前の先頭の ID は字のまま書く必要があるので（ID の取り出しは先頭の字を読む）、ITEM と LOOK で別々に回す。
  // 公開の商品・LOOK の総数を読んで画面と比べるので、公開の行を足し引きする HOME の試験（排他）と重ならないよう共有の lock を持つ。
  const sections = {
    ITEM: { sectionId: 'items', table: 'items' },
    LOOK: { sectionId: 'look', table: 'looks' },
  } as const;

  async function expectViewAllMatchesTotal(
    page: Page,
    request: APIRequestContext,
    section: (typeof sections)[keyof typeof sections],
    label: 'ITEM' | 'LOOK',
    vp: { width: number; height: number },
  ): Promise<void> {
    await withHomeCatalogLock('shared', async () => {
      const total = await publishedCount(request, section.table);
      const limit = homeDisplayLimit(vp.width);
      // seed の総数（6 より多く 8 以下）で「多い帯域」と「以下の帯域」の両側が試される前提
      expect(total, `公開 ${label} の総数（seed: 6 より多く 8 以下）`).toBeGreaterThan(6);
      expect(total, `公開 ${label} の総数（seed: 6 より多く 8 以下）`).toBeLessThanOrEqual(8);

      await openHome(page, vp);
      const viewAll = page.locator(`#${section.sectionId} [data-testid="home-section-view-all"]`);
      await expect(viewAll).toBeAttached();
      if (total > limit) {
        await expect(viewAll).toBeVisible();
      } else {
        await expect(viewAll).toBeHidden();
      }
    });
  }

  for (const vp of [MOBILE, TABLET, DESKTOP, WIDE]) {
    test(`FREQ-147-AC-03 ${vp.name}(${vp.width}px) 公開 ITEM の総数が表示数より多い時だけ VIEW ALL が出る`, async ({ page, request }) => {
      test.setTimeout(120_000);
      await expectViewAllMatchesTotal(page, request, sections.ITEM, 'ITEM', vp);
    });
  }

  for (const vp of [MOBILE, TABLET, DESKTOP, WIDE]) {
    test(`FREQ-148-AC-03 ${vp.name}(${vp.width}px) 公開 LOOK の総数が表示数より多い時だけ VIEW ALL が出る`, async ({ page, request }) => {
      test.setTimeout(120_000);
      await expectViewAllMatchesTotal(page, request, sections.LOOK, 'LOOK', vp);
    });
  }

  // FR-HOME-003-AC-01: ABOUT の区画に /about へのリンクがあり、押すと /about が開く
  for (const vp of [MOBILE, TABLET, DESKTOP]) {
    test(`FR-HOME-003-AC-01 ${vp.name} ABOUT の区画のリンクを押すと /about が開く`, async ({ page }) => {
      await openHome(page, vp);
      const link = page.locator('#about a[href="/about"]');
      await expect(link).toHaveCount(1);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/about\/?$/);
    });
  }

  // FREQ-280-AC-01: style 属性で --lk-size-2xs を当てて描く価格の font-size が、--lk-size-2xs の算出値と一致する
  for (const vp of [MOBILE, TABLET, DESKTOP]) {
    test(`FREQ-280-AC-01 ${vp.name} ホームの価格の font-size が --lk-size-2xs の算出値と一致する`, async ({ page }) => {
      await openHome(page, vp);
      const price = page.locator('#items [data-testid="item-price"]:visible').first();
      await expect(price).toBeVisible();
      const [actual, expected] = await Promise.all([
        price.evaluate((el) => getComputedStyle(el).fontSize),
        page.evaluate(() => {
          const probe = document.createElement('div');
          probe.style.fontSize = 'var(--lk-size-2xs)';
          document.body.appendChild(probe);
          const size = getComputedStyle(probe).fontSize;
          probe.remove();
          return size;
        }),
      ]);
      expect(actual).toBe(expected);
    });
  }
});
