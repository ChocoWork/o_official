import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { withLocalDb } from './order-email-test-utils';

// LOOK 一覧・ホームの LOOK の区画の振る舞い（非公開の除外・カードの遷移・ホームから一覧への入口・
// シーズンの絞り込み）と、格子の gap・リビール後の transform の残りの受け入れ条件。
// 手元の DB に足す（非公開の LOOK・表示数を超えるための公開の LOOK。2000-01-01 で並びの最後。finally で必ず消す）。
// 同時に流れる他の spec も公開の LOOK を足すことがあるので、全体の件数の一致は見ない。
// 見本の LOOK（supabase/seed.sql の 1〜7。SS は 1・3・5、AW は 2・4・6・7）が出ているか・出ていないかで確かめる。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const LOOK_CARD = '[data-testid="look-card"]';
const IDENTITY_TRANSFORMS = ['none', 'matrix(1, 0, 0, 1, 0, 0)'];

/** 見本の LOOK の id（supabase/seed.sql）。シーズンで分ける */
const SEED_SS_IDS = [1, 3, 5] as const;
const SEED_AW_IDS = [2, 4, 6, 7] as const;
const ALL_SEED_IDS = [1, 2, 3, 4, 5, 6, 7] as const;

/** 公開の LOOK を count 件足す（並びの最後。返すのは消すための印）。表示数を超えるために使う */
async function insertPublishedLooks(count: number, tag: string): Promise<void> {
  await withLocalDb(async (db) => {
    for (let index = 0; index < count; index += 1) {
      await db.query(
        `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
         values (2000, 'SS', $1, 'Synthetic extra look.', ARRAY['looks/e2e/look-1-1.png'], 'published', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`,
        [`${tag}-${index}`],
      );
    }
  });
}

async function deleteLooksByThemePrefix(tag: string): Promise<void> {
  await withLocalDb(async (db) => {
    await db.query('delete from public.looks where theme like $1', [`${tag}%`]);
  });
}

/** React が要素を引き継いだ（イベントの処理が付いた）ことを待つ。付く前の操作は落ちるので、操作の前に必ず待つ */
async function waitUntilHydrated(target: Locator) {
  await expect
    .poll(() => target.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps'))), { timeout: 15_000 })
    .toBe(true);
}

/** 一覧のカードの中の LOOK への入口（id 指定）。desktop・mobile どちらのカードにも同じリンクがある */
function lookLink(page: Page, id: number) {
  return page.locator(`${LOOK_CARD} a[href="/look/${id}"]`);
}

/** 見本の LOOK のカードが出ているか・出ていないかを、id ごとに確かめる */
async function expectSeedLooks(page: Page, shown: readonly number[], hidden: readonly number[]) {
  for (const id of hidden) await expect(lookLink(page, id), `見本の LOOK ${id} のカードが出ない`).toHaveCount(0);
  for (const id of shown) await expect(lookLink(page, id).first(), `見本の LOOK ${id} のカードが出る`).toBeAttached();
}

/** 表示されているカードのシーズンの表記（lg 未満は情報パネル、lg 以上は画像のオーバーレイ）を、いま描かれている全部のカードについて返す */
function visibleSeasonLabels(page: Page): Promise<string[]> {
  return page.locator(LOOK_CARD).evaluateAll((cards) =>
    cards.map((card) => {
      const label = Array.from(card.querySelectorAll('p')).find((p) => {
        const box = p.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(p).visibility !== 'hidden';
      });
      return (label?.textContent ?? '').trim();
    }),
  );
}

/** シーズンの絞り込みを開いて、指定のシーズンを選ぶ（desktop はサイドバー、mobile・tablet は FILTER の引き出し） */
async function chooseSeason(page: Page, width: number, season: 'ALL' | 'SS' | 'AW') {
  if (width >= 1024) {
    const checkbox = page.getByRole('complementary').getByRole('checkbox', { name: season, exact: true });
    await expect(checkbox).toBeEnabled();
    await waitUntilHydrated(checkbox);
    await checkbox.click();
    return;
  }
  const drawer = page.getByRole('dialog');
  if (!(await drawer.isVisible())) {
    const filterButton = page.locator('[data-filter-button="floating"]');
    await expect(filterButton).toBeEnabled();
    await waitUntilHydrated(filterButton);
    await filterButton.click();
  }
  await expect(drawer).toBeVisible();
  await drawer.getByRole('checkbox', { name: season, exact: true }).click();
}

async function closeDrawerIfOpen(page: Page, width: number) {
  if (width >= 1024) return;
  const drawer = page.getByRole('dialog');
  if (await drawer.isVisible()) {
    await page.getByRole('button', { name: 'Close filter drawer' }).click();
    await expect(drawer).toBeHidden();
  }
}

function gapsOf(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        row: Number.parseFloat(style.rowGap),
        column: Number.parseFloat(style.columnGap),
      };
    });
}

test.describe('FR-LOOK-ALL-044 LOOK 一覧の振る舞いと格子の残りの受け入れ条件', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-ALL-001-AC-02 ${vp.name} 非公開の LOOK は /look の一覧に出ない`, async ({ page }) => {
      const theme = `E2E-LOOK044-PRIVATE-${randomUUID().slice(0, 8)}`;
      try {
        const lookId = await withLocalDb(async (db) => {
          const inserted = await db.query(
            `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
             values (2026, 'SS', $1, 'Synthetic private look.', ARRAY['looks/e2e/look-1-1.png'], 'private', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
             returning id::text as id`,
            [theme],
          );
          const id = String(inserted.rows[0].id);
          await db.query('insert into public.look_items (look_id, item_id) values ($1, 1)', [id]);
          return id;
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/look');

        // 公開済みの LOOK は出ている（一覧が描画された上で、非公開だけが出ない）
        await expect(page.locator(LOOK_CARD).first()).toBeVisible();

        const main = page.locator('main');
        await expect(main).not.toContainText(theme);
        await expect(main.locator(`img[alt="${theme}"]`)).toHaveCount(0);
        await expect(main.locator(`a[href="/look/${lookId}"]`)).toHaveCount(0);
      } finally {
        await withLocalDb(async (db) => {
          await db.query('delete from public.looks where theme = $1', [theme]);
        });
      }
    });
  }

  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-ALL-002-AC-02 ${vp.name} カードを押すと /look/{id} に移り、そのカードのテーマが h1 に出る`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      const card = page.locator(LOOK_CARD).first();
      await expect(card).toBeVisible();
      // 押したカードのテーマ（lg 未満は情報パネルの見出し、lg 以上は画像のオーバーレイの見出し。見えている h3）
      const theme = (await card.locator('h3:visible').first().innerText()).trim();
      expect(theme.length).toBeGreaterThan(0);

      await card.locator('a[href^="/look/"]').first().click();

      await expect(page).toHaveURL(/\/look\/\d+$/);
      // 見出しは CSS で大文字化されるため、大文字小文字は区別せずに突き合わせる
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        new RegExp(`^\\s*${theme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'),
      );
    });
  }

  // 表示数を超えている時だけ入口が出る。「超えている」状態は、見本の 7 件が 6 件を超えること（mobile・tablet・desktop）と、
  // wide（2xl 以上。8 件）では 2 件足して 9 件にすることで作る。足した LOOK は 2000-01-01 で並びの最後なので、ホームの表示には入らない。
  // 同時に他の spec が公開の LOOK を足しても件数は増えるだけなので、「超えている」ことは変わらない。
  for (const { name, width, height, limit, extra } of [
    { name: 'mobile', width: 390, height: 844, limit: 6, extra: 0 },
    { name: 'tablet', width: 768, height: 1024, limit: 6, extra: 0 },
    { name: 'desktop', width: 1280, height: 800, limit: 6, extra: 0 },
    { name: 'wide', width: 1536, height: 900, limit: 8, extra: 2 },
  ] as const) {
    test(`FR-LOOK-ALL-004-AC-02 ${name}(${width}px) 公開の LOOK が表示数(${limit}件)より多い時、ホームの LOOK の区画から /look へ移れる`, async ({
      page,
    }) => {
      const tag = `E2E-LOOK044-EXTRA-${randomUUID().slice(0, 8)}`;
      try {
        await insertPublishedLooks(extra, tag);
        await page.setViewportSize({ width, height });
        await page.goto('/');

        const entrance = page.locator('#look a[href="/look"]');
        await expect(entrance).toHaveCount(1);
        await expect(entrance).toBeVisible();
        await entrance.click();
        await expect(page).toHaveURL(/\/look$/);
      } finally {
        await deleteLooksByThemePrefix(tag);
      }
    });
  }

  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-ALL-006-AC-01 ${vp.name} SS を選ぶと、表示される LOOK のカードのシーズンの表記が全部 SS になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator(LOOK_CARD).first()).toBeVisible();

      await chooseSeason(page, vp.width, 'SS');
      await expect(page).toHaveURL(/\/look\?season=SS$/);
      await closeDrawerIfOpen(page, vp.width);

      // 見本の AW の LOOK は消え、見本の SS の LOOK は残る（絞り込みが済んだ印）。出ているカードのシーズンの表記は全部 SS
      await expectSeedLooks(page, SEED_SS_IDS, SEED_AW_IDS);
      const labels = await visibleSeasonLabels(page);
      expect(labels.length).toBeGreaterThanOrEqual(SEED_SS_IDS.length);
      for (const label of labels) expect(label).toMatch(/SS$/);
    });

    test(`FR-LOOK-ALL-006-AC-02 ${vp.name} AW を選んだ後に ALL を選ぶと、公開済みの LOOK のカードが全部出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator(LOOK_CARD).first()).toBeVisible();

      await chooseSeason(page, vp.width, 'AW');
      await expect(page).toHaveURL(/\/look\?season=AW$/);
      // AW だけになった（見本の SS の LOOK が消え、AW の LOOK が残る）
      await expectSeedLooks(page, SEED_AW_IDS, SEED_SS_IDS);

      await chooseSeason(page, vp.width, 'ALL');
      await expect(page).toHaveURL(/\/look$/);
      await closeDrawerIfOpen(page, vp.width);

      // 見本の 7 件が全部出る（SS も AW も）
      await expectSeedLooks(page, ALL_SEED_IDS, []);
    });
  }

  for (const vp of VIEWPORTS.filter((v) => v.width < 1024)) {
    test(`FREQ-140-AC-03 ${vp.name} /look の一覧で row-gap が column-gap より大きい`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator(LOOK_CARD).first()).toBeVisible();

      const { row, column } = await gapsOf(page, '[data-testid="look-content-column"] .grid');
      expect(row).toBeGreaterThan(column);
    });

    test(`FREQ-140-AC-03 ${vp.name} ホームの LOOK の区画で row-gap が column-gap より大きい`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator(`#look ${LOOK_CARD}`).first()).toBeVisible();

      const { row, column } = await gapsOf(page, '#look .grid');
      expect(row).toBeGreaterThan(column);
    });
  }

  test('FREQ-141-AC-02 tablet /look 一覧の column-gap が 24px になる', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/look');
    await expect(page.locator(LOOK_CARD).first()).toBeVisible();

    const { column } = await gapsOf(page, '[data-testid="look-content-column"] .grid');
    expect(column).toBe(24);
  });

  for (const vp of VIEWPORTS) {
    test(`FREQ-279-AC-03 ${vp.name} リビール完了後の LOOK タイトルの transform が none（元の位置）になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      const card = page.locator(LOOK_CARD).first();
      await expect(card).toBeVisible();
      // 文字ブロック自身が画面に入って data-reveal が true になるまで待つ
      const mask = card.locator('.reveal-mask').first();
      await mask.scrollIntoViewIfNeeded();
      await expect(mask).toHaveAttribute('data-reveal', 'true');

      // 迫り上がり（delay 1000ms + duration 500ms）が終わると定位置（恒等変換）に戻る
      const rise = card.locator('.reveal-rise').first();
      await expect
        .poll(
          async () => {
            const transform = await rise.evaluate((el) => getComputedStyle(el).transform);
            return IDENTITY_TRANSFORMS.includes(transform) ? 'none' : transform;
          },
          { timeout: 10_000 },
        )
        .toBe('none');
    });
  }

  // FREQ-279-AC-03 は「商品名・LOOK のテーマ」の両方。LOOK のテーマは上、商品名は /item の ITEM カードで確かめる
  for (const vp of VIEWPORTS) {
    test(`FREQ-279-AC-03 ${vp.name} リビール完了後の ITEM の商品名の transform が none（元の位置）になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');

      const card = page.locator('[data-testid="item-card"]').first();
      await expect(card).toBeVisible();
      const mask = card.locator('.reveal-mask').first();
      await mask.scrollIntoViewIfNeeded();
      await expect(mask).toHaveAttribute('data-reveal', 'true');

      const rise = card.locator('.reveal-rise').first();
      await expect
        .poll(
          async () => {
            const transform = await rise.evaluate((el) => getComputedStyle(el).transform);
            return IDENTITY_TRANSFORMS.includes(transform) ? 'none' : transform;
          },
          { timeout: 10_000 },
        )
        .toBe('none');
    });
  }
});
