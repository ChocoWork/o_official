import { expect, test, type Page } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844, direction: 'column' },
  { name: 'tablet', width: 768, height: 1024, direction: 'row' },
  { name: 'desktop', width: 1280, height: 900, direction: 'row' },
] as const;

/** 頁の URL を起点に、相対でも絶対でも URL にして返す。 */
function resolveAgainstPage(page: Page, value: string): URL {
  return new URL(value, page.url());
}

test.describe('FR-ABOUT-009 ABOUT の並び・題・alt・画像のオリジン（残りの受け入れ条件）', () => {
  for (const viewport of viewports) {
    test(`FR-ABOUT-004-AC-02 ${viewport.name}: CTA が 390px で縦、768px 以上で横に並び、横にずれない`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');

      const collectionLink = page.getByRole('link', { name: 'VIEW COLLECTION' });
      await expect(collectionLink).toBeVisible();
      await expect(page.getByRole('link', { name: 'VIEW LOOKBOOK' })).toBeVisible();

      // 2つの CTA を包む入れ物の並びの向き
      const ctaContainer = collectionLink.locator('..');
      await expect(ctaContainer).toHaveCSS('flex-direction', viewport.direction);

      // どの幅でも横のスクロールが出ない
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    });

    test(`FR-ABOUT-005-AC-02 ${viewport.name}: ページの題に ABOUT か Le Fil des Heures があり、description が空でない`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');

      await expect(page).toHaveTitle(/ABOUT|Le Fil des Heures/i);
      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveCount(1);
      const content = await description.getAttribute('content');
      expect((content ?? '').trim().length).toBeGreaterThan(0);
    });

    test(`FR-ABOUT-007-AC-02 ${viewport.name}: 画像の alt が全部 16 字以上である`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');

      // 今の /about には画像が無い。0 枚なら全件の条件は空で満たされる（画像が戻ったら全部が対象になる）。
      const alts = await page.locator('img').evaluateAll((imgs) =>
        imgs.map((img) => ({ src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') })),
      );
      for (const { src, alt } of alts) {
        expect(alt, `alt が無い画像: ${src}`).not.toBeNull();
        expect((alt ?? '').length, `alt が 16 字未満: ${src}`).toBeGreaterThanOrEqual(16);
      }
    });

    test(`SEC-ABOUT-001-AC-01 ${viewport.name}: 本文の画像と og:image が頁と同じオリジンで、外の配信元を含まない`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');
      const pageOrigin = new URL(page.url()).origin;

      // 本文の全部の img の src（画像が 0 枚でも落ちない）
      const srcs = await page
        .locator('img')
        .evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src') ?? ''));
      for (const src of srcs) {
        const resolved = resolveAgainstPage(page, src);
        expect(resolved.origin, `img src のオリジン: ${src}`).toBe(pageOrigin);
        // /_next/image は url パラメータ（最適化する元の画像）も外を指さない
        if (resolved.pathname === '/_next/image') {
          const inner = resolved.searchParams.get('url');
          expect(inner, `/_next/image の url パラメータ: ${src}`).not.toBeNull();
          expect(resolveAgainstPage(page, inner ?? '').origin, `/_next/image の元画像: ${src}`).toBe(pageOrigin);
        }
      }

      // og:image
      const ogImage = page.locator('meta[property="og:image"]');
      expect(await ogImage.count()).toBeGreaterThan(0);
      const ogContents = await ogImage.evaluateAll((metas) =>
        metas.map((meta) => meta.getAttribute('content') ?? ''),
      );
      for (const content of ogContents) {
        expect(content.length).toBeGreaterThan(0);
        expect(resolveAgainstPage(page, content).origin, `og:image のオリジン: ${content}`).toBe(pageOrigin);
      }

      // readdy.ai・placehold.co を含む URL が頁のどこにも出ない（src・srcset・og:image・本文の HTML）
      const html = await page.content();
      expect(html).not.toContain('readdy.ai');
      expect(html).not.toContain('placehold.co');
    });
  }
});
