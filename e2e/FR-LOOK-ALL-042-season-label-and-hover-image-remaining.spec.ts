import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { withLocalDb } from './order-email-test-utils';

// FREQ-127 / FREQ-132 / FREQ-143 / FREQ-145 の、まだ E2E の無かった受け入れ基準をまとめて確かめる。
//   FREQ-127-AC-01〜03: シーズンの表記は「{4桁年}{SS|AW}」で、COLLECTION が無く、年とシーズンの間に空白が無い
//                       （空白なしの形が出るのは lg 以上のオーバーレイだけ）
//   FREQ-132-AC-03    : 2枚目の画像を持たないカードに hover 用の画像要素が描かれない
//   FREQ-143-AC-02/04 : mobile / tablet でシーズンの font-weight が 500 以上・「{4桁年} {SS|AW}」で番号が無い
//   FREQ-145-AC-02    : mobile / tablet でシーズンの強調（不透明度 0.5 超・font-weight 500 以上）が残る

const DESKTOP = { name: 'desktop', width: 1280, height: 800 } as const;
const COMPACT_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;
const ALL_VIEWPORTS = [COMPACT_VIEWPORTS[0], COMPACT_VIEWPORTS[1], DESKTOP] as const;
const PATHS = ['/', '/look'] as const;

// lg 以上のオーバーレイのシーズン表記（先頭の <p>）を全カード分読む。
async function readOverlaySeasonTexts(page: Page): Promise<string[]> {
  const overlays = page.locator('[data-testid="look-card-overlay"]');
  await expect(overlays.first()).toBeAttached();
  const labels = page.locator('[data-testid="look-card-overlay"] p');
  const texts = (await labels.allTextContents()).map((t) => t.trim());
  expect(texts.length, 'オーバーレイのシーズン表記が1つ以上ある').toBeGreaterThan(0);
  return texts;
}

// lg 未満のキャプションのシーズン表記（先頭の <p>）を全カード分読む。
async function readCaptionSeasonTexts(page: Page): Promise<string[]> {
  const captions = page.locator('[data-testid="look-card-caption"]');
  await expect(captions.first()).toBeAttached();
  const texts = (await captions.locator('p').allTextContents()).map((t) => t.trim());
  expect(texts.length, 'キャプションのシーズン表記が1つ以上ある').toBeGreaterThan(0);
  return texts;
}

type SeasonStyle = { text: string; opacity: number; fontWeight: number };

// mobile / tablet で表示されるキャプションのシーズンラベル（先頭の <p>）の算出スタイル
//（FR-LOOK-ALL-030 の読み取り方と同じ）。
async function readSeasonStyle(page: Page): Promise<SeasonStyle> {
  const caption = page.locator('[data-testid="look-card-caption"]').first();
  await caption.scrollIntoViewIfNeeded();
  const label = caption.locator('p').first();
  await expect(label).toBeVisible();
  return label.evaluate((el) => {
    const cs = getComputedStyle(el);
    const slashAlpha = cs.color.match(/\/\s*([\d.]+)\s*\)/);
    let opacity = 1;
    if (slashAlpha) opacity = parseFloat(slashAlpha[1]);
    else {
      const nums = cs.color.match(/[\d.]+/g) ?? [];
      opacity = nums.length >= 4 ? parseFloat(nums[3]) : 1;
    }
    return {
      text: (el.textContent ?? '').trim(),
      opacity,
      fontWeight: Number(cs.fontWeight),
    };
  });
}

test.describe('FR-LOOK-ALL-042 シーズン表記と hover 画像の残りの受け入れ基準', () => {
  // ---- FREQ-127: 空白なしの「2026AW」形は lg 以上のオーバーレイ ----
  for (const path of PATHS) {
    test(`FREQ-127-AC-01 desktop ${path} でオーバーレイのシーズン表記が「{4桁年}{SS|AW}」の形で出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
      await page.goto(path);
      const texts = await readOverlaySeasonTexts(page);
      for (const text of texts) {
        expect(text).toMatch(/^\d{4}(SS|AW)$/);
      }
    });

    test(`FREQ-127-AC-03 desktop ${path} でオーバーレイのシーズン表記の年とシーズンの間に空白が無い`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
      await page.goto(path);
      const texts = await readOverlaySeasonTexts(page);
      for (const text of texts) {
        expect(text).not.toMatch(/\s/);
        expect(text).toMatch(/^\d{4}(SS|AW)$/);
      }
    });
  }

  // ---- FREQ-127-AC-02: どの幅でもシーズン表記に COLLECTION が出ない ----
  for (const vp of ALL_VIEWPORTS) {
    for (const path of PATHS) {
      test(`FREQ-127-AC-02 ${vp.name} ${path} でシーズン表記に COLLECTION が出ない`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const texts =
          vp.name === 'desktop'
            ? await readOverlaySeasonTexts(page)
            : await readCaptionSeasonTexts(page);
        for (const text of texts) {
          expect(text.toUpperCase()).not.toContain('COLLECTION');
        }
      });
    }
  }

  // ---- FREQ-143 / FREQ-145: mobile / tablet のシーズン表記の強調 ----
  for (const vp of COMPACT_VIEWPORTS) {
    for (const path of PATHS) {
      test(`FREQ-143-AC-02 ${vp.name} ${path} でシーズンの font-weight が 500 以上になる`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const style = await readSeasonStyle(page);
        expect(style.fontWeight, `font-weight (${style.text})`).toBeGreaterThanOrEqual(500);
      });

      test(`FREQ-143-AC-04 ${vp.name} ${path} でシーズンが「{4桁年} {SS|AW}」の形のままで番号が無い`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const texts = await readCaptionSeasonTexts(page);
        for (const text of texts) {
          expect(text).toMatch(/^\d{4} (SS|AW)$/);
          expect(text).not.toContain('/');
        }
      });

      test(`FREQ-145-AC-02 ${vp.name} ${path} でシーズンの濃さと太さの強調が残っている`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const style = await readSeasonStyle(page);
        expect(style.opacity, `color alpha (${style.text})`).toBeGreaterThan(0.5);
        expect(style.fontWeight, `font-weight (${style.text})`).toBeGreaterThanOrEqual(500);
      });
    }
  }

  // ---- FREQ-132-AC-03: 2枚目の無いカードに hover 用の画像が描かれない ----
  // 手元の seed の LOOK は全部2枚あるので、画像が1枚だけの公開 LOOK を作って確かめ、終わったら消す。
  for (const vp of ALL_VIEWPORTS) {
    test(`FREQ-132-AC-03 ${vp.name} で2枚目の無いカードに hover 用の画像要素が描かれない`, async ({
      page,
    }) => {
      const theme = `E2E Single Image ${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
      const lookId = await withLocalDb(async (db) => {
        const res = await db.query(
          `insert into public.looks
             (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
           values (2026, 'SS', $1, 'zq', ARRAY['e2e/look-1-1.png']::text[], 'published',
                   '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
           returning id`,
          [theme],
        );
        return Number(res.rows[0].id);
      });
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/look');

        // 対照: 2枚あるカードには hover 用の画像があり、探し方が空振りでないこと。
        await expect(page.locator('[data-testid="look-card-image-hover"]').first()).toBeAttached();

        const card = page.locator('[data-testid="look-card"]').filter({ hasText: theme });
        await expect(card).toHaveCount(1);
        await expect(card.locator('img')).toHaveCount(1);
        await expect(card.locator('[data-testid="look-card-image-hover"]')).toHaveCount(0);
      } finally {
        await withLocalDb((db) => db.query('delete from public.looks where id = $1', [lookId]));
      }
    });
  }
});
