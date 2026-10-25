import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { withLocalDb } from './order-email-test-utils';

// LOOK 詳細の受け入れ条件のうち、まだ試していなかった物をまとめて試す。
// 手元の Supabase の見本（supabase/seed.sql）を前提にする。
//   - 公開の LOOK は 7 件。並びは created_at の新しい順（一覧・前後ナビと同じ）なので、LOOK 1 が先頭。
//     末尾は、同時に流れる他の spec が足す 2000-01-01 の LOOK と入れ替わるので、末尾の試験は自分で最も古い LOOK を足す
//   - LOOK 1 の紐づけ商品は 商品1（Aoi Linen Tunic）と 商品3（Mizu Wide Trousers）
//   - LOOK 2 の前（新しい側）は LOOK 1、次（古い側）は LOOK 3

// 回数の制限: どの頁も開くたびに CartContext が GET /api/wishlist（wishlist:get 120 回/60 秒、送り元ごと）を呼ぶ。
// 並列の他の spec と共有の送り元 127.0.0.1 の枠を取り合うと 429 が返り、端末の記録に
// 「Failed to load resource: … 429」が出て、下の「端末にエラーが無い」の確認が落ちる。
// このファイルだけの x-forwarded-for を付けて枠を分ける。ただし SEC-SEARCH-006 が直って x-forwarded-for を信用しなくなると
// この分離は効かなくなる（全部が接続の送り元の 1 つの枠になる）。
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '198.18.26.26' } });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const LOOK_1_THEME = 'Aoi Weekend Layers';
const LOOK_3_THEME = 'Quiet Morning Form';

/**
 * 前後ナビのリンクを返す。
 * md 未満は固定ボトムナビ（項目名が PREV LOOK / NEXT LOOK）、md 以上はインラインナビ（aria-label が Previous look: … / Next look: …）。
 * 行き先が無い側はリンクにならない（モバイルは span、md 以上は aria-hidden の div）。
 */
function navLinks(page: Page, viewportName: string) {
  if (viewportName === 'mobile') {
    const nav = page.locator('[data-testid="look-detail-fixed-nav"]');
    return {
      prev: nav.getByRole('link', { name: 'PREV LOOK', exact: true }),
      next: nav.getByRole('link', { name: 'NEXT LOOK', exact: true }),
    };
  }
  const nav = page.locator('[data-testid="look-detail-bottom-nav"]');
  return {
    prev: nav.getByRole('link', { name: /^Previous look/ }),
    next: nav.getByRole('link', { name: /^Next look/ }),
  };
}

test.describe('FR-LOOK-DETAIL-001 公開済みの LOOK の詳細', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-DETAIL-001-AC-02 ${vp.name} 非公開の LOOK の詳細は中身を出さない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const token = randomBytes(6).toString('hex');
      const theme = `E2E Private Theme ${token}`;
      const description = `E2E private description ${token}`;
      // 画像の道筋にも印を付け、画面にも応答の本文にも出ないことを確かめる
      const imageToken = randomUUID();
      const imagePath = `looks/2000-01-01/${imageToken}.png`;

      const lookId = await withLocalDb(async (db) => {
        const result = await db.query(
          `INSERT INTO public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
           VALUES (2026, 'SS', $1, $2, ARRAY[$3]::text[], 'private', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
           RETURNING id`,
          [theme, description, imagePath],
        );
        return Number(result.rows[0].id);
      });

      try {
        await page.goto(`/look/${lookId}`);

        // 非公開の LOOK は「見つからない」と同じ表示になる
        await expect(page.getByRole('heading', { name: 'Look not found' })).toBeVisible();

        // テーマ・説明文は、画面にもタブの題（metadata）にも出ない
        await expect(page.getByText(theme)).toHaveCount(0);
        await expect(page.getByText(description)).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(theme);
        expect(html).not.toContain(description);
        expect(html, '画像の道筋が頁に出ない').not.toContain(imageToken);
        await expect(page.locator(`img[src*="${imageToken}"], img[srcset*="${imageToken}"]`), 'その LOOK の画像が表示されない').toHaveCount(0);
        await expect(page).not.toHaveTitle(new RegExp(token));
      } finally {
        await withLocalDb(async (db) => {
          await db.query('DELETE FROM public.looks WHERE id = $1', [lookId]);
        });
      }
    });
  }
});

test.describe('FR-LOOK-DETAIL-002 詳細に紐づけた商品へのリンク', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-DETAIL-002-AC-02 ${vp.name} 商品を押すとその商品の頁へ移る`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look/1');

      const firstItemLink = page
        .locator('[data-testid="look-detail-layout"] a[href^="/item/"]')
        .first();
      await expect(firstItemLink).toBeVisible();

      const href = await firstItemLink.getAttribute('href');
      expect(href).toMatch(/^\/item\/\d+$/);
      // LOOK 1 に紐づく商品は 1 と 3
      expect(['/item/1', '/item/3']).toContain(href);

      await firstItemLink.click();

      // 押した商品の頁（/item/<数>）に移る
      await expect(page).toHaveURL(/\/item\/\d+$/);
      expect(new URL(page.url()).pathname).toBe(href);
    });
  }
});

test.describe('FR-LOOK-DETAIL-003 前後の LOOK へのリンク', () => {
  // 末尾の LOOK を試す節が、ほかのどれより古い公開の LOOK を足す。3 つの幅が同時に流れると
  // 足した LOOK どうしで末尾が入れ替わる（created_at が同じ・近い）ので、3 つの幅を 1 本ずつ順に流す
  test.describe.configure({ mode: 'serial' });

  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-DETAIL-003-AC-02 ${vp.name} 先頭の LOOK は前へ、末尾の LOOK は次へのリンクが無い`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 先頭（LOOK 1。見本でいちばん新しい。足される試験用の LOOK は 2000-01-01 以前で、これより古い）:
      // 前へのリンクが無く、次へのリンクはある
      await page.goto('/look/1');
      const first = navLinks(page, vp.name);
      await expect(first.next).toBeVisible();
      await expect(first.next).toHaveAttribute('href', '/look/2');
      await expect(first.prev).toHaveCount(0);

      // 末尾: 同時に流れる他の spec が 2000-01-01 の公開の LOOK を足すことがあるので、
      // 見本の LOOK 7 ではなく、ほかのどれより古い（1999-12-31）公開の LOOK をこの試験で足して末尾にする
      const theme = `E2E-LOOK-DETAIL019-LAST-${randomBytes(4).toString('hex')}`;
      const lastId = await withLocalDb(async (db) => {
        const result = await db.query(
          `INSERT INTO public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
           VALUES (2000, 'SS', $1, 'Synthetic last look.', ARRAY['e2e/look-1-1.png'], 'published', '1999-12-31T00:00:00Z', '1999-12-31T00:00:00Z')
           RETURNING id`,
          [theme],
        );
        return Number(result.rows[0].id);
      });
      try {
        // 次へのリンクが無く、前へのリンクはある（行き先はこの LOOK ではない別の LOOK）
        await page.goto(`/look/${lastId}`);
        const last = navLinks(page, vp.name);
        await expect(last.prev).toBeVisible();
        await expect(last.prev).toHaveAttribute('href', /^\/look\/\d+$/);
        await expect(last.prev).not.toHaveAttribute('href', `/look/${lastId}`);
        await expect(last.next).toHaveCount(0);
      } finally {
        await withLocalDb(async (db) => {
          await db.query('DELETE FROM public.looks WHERE id = $1', [lastId]);
        });
      }
    });
  }
});

test.describe('FR-LOOK-DETAIL-004 無い LOOK の ID', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-DETAIL-004-AC-01 ${vp.name} 無い ID の詳細に「Look not found」が出る`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look/999999999');

      await expect(page.getByRole('heading', { name: /Look not found/i })).toBeVisible();
    });
  }
});

test.describe('FR-LOOK-DETAIL-006 前後のリンクの aria-label', () => {
  for (const vp of VIEWPORTS) {
    test(`FR-LOOK-DETAIL-006-AC-02 ${vp.name} 前後のリンクに行き先のテーマを含む aria-label が付く`, async ({ page }) => {
      test.fail(vp.name === 'mobile', 'FR-LOOK-DETAIL-006-AC-02 文書に無い食い違い（ユーザーの判断待ち）');
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look/2');

      if (vp.name === 'mobile') {
        // md 未満の人（と読み上げ）に届くのは、画面下の固定ナビのリンク（インラインナビは display:none）。
        // その読み上げの名前に、行き先の LOOK のテーマが含まれること。今のコードは名前が PREV LOOK / NEXT LOOK だけで、赤。
        const { prev, next } = navLinks(page, vp.name);
        await expect(prev).toHaveAttribute('href', '/look/1');
        await expect(next).toHaveAttribute('href', '/look/3');
        await expect(prev).toHaveAccessibleName(new RegExp(LOOK_1_THEME, 'i'));
        await expect(next).toHaveAccessibleName(new RegExp(LOOK_3_THEME, 'i'));
        return;
      }

      // md 以上: インラインナビのリンクに aria-label が付く
      const prev = page.locator('a[aria-label^="Previous look"]');
      const next = page.locator('a[aria-label^="Next look"]');
      await expect(prev).toHaveCount(1);
      await expect(next).toHaveCount(1);
      await expect(prev).toBeVisible();
      await expect(next).toBeVisible();

      // 前（LOOK 1）と次（LOOK 3）のテーマが、それぞれの側の aria-label に入る
      const prevLabel = await prev.getAttribute('aria-label');
      const nextLabel = await next.getAttribute('aria-label');
      expect(prevLabel).toContain(LOOK_1_THEME);
      expect(prevLabel).not.toContain(LOOK_3_THEME);
      expect(nextLabel).toContain(LOOK_3_THEME);
      expect(nextLabel).not.toContain(LOOK_1_THEME);

      // ラベルの行き先とリンクの行き先が合っている
      await expect(prev).toHaveAttribute('href', '/look/1');
      await expect(next).toHaveAttribute('href', '/look/3');
    });
  }
});

test.describe('FREQ-11 コーディネートを見る', () => {
  for (const vp of VIEWPORTS) {
    // 解釈（look.md の未確認事項）: FREQ-11-AC-01 の「関連コーディネート」は、どの画面かも何が「関連」かも書かれていない。
    // ここでは「コーディネート（LOOK）を見る画面 = LOOK 詳細」で、そのコーディネートに紐づく商品（STYLING ITEMS）が
    // 出ることを「関連」と読む。LOOK 1 を開き、エラー無しで紐づけ商品の 1 と 3 が並ぶことを確かめる。
    test(`FREQ-11-AC-01 ${vp.name} コーディネートを見る時にエラーが出ず関連コーディネート（紐づけ商品）が出る`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => {
        consoleErrors.push(error.message);
      });

      const response = await page.goto('/look/1');

      // エラーが出ない: 応答が成功・エラーの表示が無い・コンソールにエラーが無い
      expect(response).not.toBeNull();
      expect(response!.ok()).toBe(true);
      await expect(page.getByRole('heading', { level: 1, name: LOOK_1_THEME })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Look not found' })).toHaveCount(0);
      await expect(
        page.getByText(/Application error|This page couldn.t load|Something went wrong|Internal Server Error/i),
      ).toHaveCount(0);

      // 関連コーディネート（STYLING ITEMS）: LOOK 1 に紐づく商品 1 と 3 が並ぶ
      const layout = page.locator('[data-testid="look-detail-layout"]');
      const item1 = layout.locator('a[href="/item/1"]').filter({ hasText: 'Aoi Linen Tunic' }).first();
      const item3 = layout.locator('a[href="/item/3"]').filter({ hasText: 'Mizu Wide Trousers' }).first();
      await expect(item1).toBeVisible();
      await expect(item3).toBeVisible();
      await expect(layout.getByText('紐づけ商品はありません')).toHaveCount(0);

      expect(consoleErrors).toEqual([]);
    });
  }
});
