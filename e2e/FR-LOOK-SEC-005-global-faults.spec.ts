/**
 * FR-LOOK-SEC-005 LOOK の読み出し・画像の置き場を全体で一時的に壊して、失敗の扱いを確かめる（LOOK 領域）
 * 対応: SEC-LOOK-009-AC-02 / SEC-LOOK-021-AC-01 / SEC-LOOK-022-AC-01 / SEC-LOOK-022-AC-02
 *
 * この3つは共有の手元の DB の設定（置き場 look-images の大きさの上限・looks の select 権限）を一時的に変えるので、
 * 同時に流れる他の spec の LOOK の表示・画像の書き込みを壊す。そのため playwright.config.ts の isolated-global の project
 * （chromium が全部終わった後に、4 つの file を 1 本ずつ直列で流す）に分けてある。
 * 他の worker が動いていない前提なので、test.skip は使わない。権限と上限は finally で必ず元へ戻す。
 *
 * - SEC-LOOK-021-AC-01: 置き場への書き込みが失敗した作成は 500 で、error が決まった文言になり、置き場の誤りの文言を含まない
 * - SEC-LOOK-009-AC-02: 公開の LOOK を 101 件入れた状態で、/look のカードは 100 以下で最も古い LOOK は並ばず、その詳細は開く（3つの幅）
 * - SEC-LOOK-022-AC-01: looks の読み出しが失敗している時の /look は、誤りの画面になり、LOOK が0件の時の表示にならない（3つの幅）
 * - SEC-LOOK-022-AC-02: looks の読みが DB の失敗になる時、管理の1件の取得は 404 ではなく 500 を返す
 * 021-AC-01（置き場の文言を応答に出さない）と 022-AC-02（DB の失敗を 404 にせず 500）は管理の窓口で直した。
 * 009-AC-02 は 101 件を 1 回だけ入れて 3 つの幅で読む（全体の並びを変えるので、この isolated-global の project に置く）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { bearerHeaders } from './admin-session-test-utils';
import { ANON_KEY, requireLocalSupabase, restHeaders, restUrl } from './home-grant-test-utils';
import { createLookAdmin, insertPrivateLook, purgeLooksByThemePrefix, tinyPng, uploadFixtureLookImage } from './look-admin-test-utils';
import { withLocalDb } from './order-email-test-utils';

// 管理者の JWT を通信記録に残さない
test.use({ trace: 'off' });
// 1本ずつ流すのは isolated-global の project（workers 1）が受け持つ。serial にすると、赤の試験の後ろが流れない
test.describe.configure({ mode: 'default' });

const BUCKET = 'look-images';
const EMPTY_STATE_TEXT = '公開中のLOOKがありません';
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const groups = randomBytes(12).toString('hex').match(/.{4}/g) ?? [];
  return `2001:db8:${groups.join(':')}`;
}

function storageClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が env に無い');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

test.describe('FR-LOOK-SEC-005 置き場の書き込みの失敗', () => {
  test('SEC-LOOK-021-AC-01 置き場への書き込みが失敗した作成は 500 になり、error が決まった文言で置き場の返した誤りの文言を含まない', async ({ request, baseURL }) => {
    test.setTimeout(120_000);
    requireLocalSupabase();
    if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
    const actor = await createLookAdmin();
    const prefix = `E2E-LOOK-SEC005-${randomBytes(4).toString('hex')}`;
    const probePath = `looks/e2e-sec005-probe/${prefix}.png`;
    const storage = storageClient();
    const original = await withLocalDb(async (db) => {
      const found = await db.query('select file_size_limit::text as file_size_limit from storage.buckets where id = $1', [BUCKET]);
      expect(found.rows, `前提: 置き場 ${BUCKET} がある`).toHaveLength(1);
      return found.rows[0].file_size_limit as string | null;
    });

    await withLocalDb((db) => db.query('update storage.buckets set file_size_limit = 1 where id = $1', [BUCKET]));
    try {
      // 置き場が実際に返す誤りの文言を、同じ状態で直に書き込んで控える
      const probe = await storage.storage.from(BUCKET).upload(probePath, tinyPng(), { contentType: 'image/png', upsert: false });
      expect(probe.error, '前提: 手元の置き場が書き込みを断る').not.toBeNull();
      const storageMessage = probe.error?.message ?? '';
      expect(storageMessage, '前提: 置き場が誤りの文言を返す').not.toBe('');

      const res = await request.post('/api/admin/looks', {
        headers: { ...bearerHeaders(actor), 'x-forwarded-for': uniqueIp(), origin: new URL(baseURL).origin },
        multipart: {
          seasonYear: '2099',
          seasonType: 'SS',
          theme: `${prefix} storage-failure`,
          themeDescription: 'E2E description',
          status: 'private',
          linkedItemIds: JSON.stringify([1]),
          images: { name: 'x.png', mimeType: 'image/png', buffer: tinyPng() },
        },
      });

      expect(res.status()).toBe(500);
      const error = ((await res.json()) as { error?: unknown }).error;
      expect(error).toBe('Failed to upload image');
      expect(String(error)).not.toContain(storageMessage);
    } finally {
      await withLocalDb((db) => db.query('update storage.buckets set file_size_limit = $2::bigint where id = $1', [BUCKET, original]));
      await storage.storage.from(BUCKET).remove([probePath]).catch(() => undefined);
      await purgeLooksByThemePrefix(prefix);
    }
  });
});

test.describe('FR-LOOK-SEC-005 一覧の件数の上限', () => {
  // 見本の LOOK より古い 1990 年に、1 分ずつずらした公開の LOOK を 101 件入れる。-101 が最も新しく、-1 が最も古い
  const prefix = `E2E-LOOK-SEC005-LIMIT-${randomBytes(4).toString('hex')}`;
  const LIMIT_FIXTURE_COUNT = 101;

  test.beforeAll(async () => {
    requireLocalSupabase();
    await purgeLooksByThemePrefix(prefix);
    // 見本の画像を指すと、後始末が見本を消す。101 件が共有する自分用の画像を 1 枚上げて指す
    const imagePath = await uploadFixtureLookImage(prefix);
    await withLocalDb((db) =>
      db.query(
        `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
         select 2026, 'SS', $1 || '-' || g, $1 || ' description ' || g, array[$3::text], 'published',
                '1990-01-01T00:00:00Z'::timestamptz + (g || ' minutes')::interval,
                '1990-01-01T00:00:00Z'::timestamptz + (g || ' minutes')::interval
           from generate_series(1, $2::int) as g`,
        [prefix, LIMIT_FIXTURE_COUNT, imagePath],
      ),
    );
  });

  test.afterAll(async () => {
    await purgeLooksByThemePrefix(prefix);
  });

  async function idOfTheme(theme: string): Promise<number> {
    return withLocalDb(async (db) => Number((await db.query('select id from public.looks where theme = $1', [theme])).rows[0].id));
  }

  for (const vp of VIEWPORTS) {
    test(`SEC-LOOK-009-AC-02 ${vp.name}: 上限より多い公開の LOOK があっても /look のカードは 100 以下で、最も古い LOOK は並ばず、その詳細は開く`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto('/look');
      const cards = page.locator('[data-testid="look-card"]');
      await expect(cards.first(), '一覧が表示されている（制御の確認）').toBeVisible();
      const hrefs = await cards.evaluateAll((nodes) => nodes.map((node) => node.querySelector('a')?.getAttribute('href') ?? ''));
      expect(new Set(hrefs).size, `カードの詳細へのリンクは重ならない（カード ${hrefs.length} 枚）`).toBe(hrefs.length);
      expect(hrefs.length, 'カードは 100 枚以下').toBeLessThanOrEqual(100);

      const themes = await page.locator('[data-testid="look-card-caption"] h3').allTextContents();
      expect(themes, '最も新しい側（-101）は並ぶ').toContain(`${prefix}-101`);
      expect(themes, '最も古い LOOK（-1）は並ばない').not.toContain(`${prefix}-1`);

      const oldestId = await idOfTheme(`${prefix}-1`);
      const newerId = await idOfTheme(`${prefix}-2`);
      await page.goto(`/look/${oldestId}`);
      await expect(page.getByRole('heading', { level: 1, name: `${prefix}-1` }), '最も古い LOOK の詳細が開く').toBeVisible();
      await expect(page.getByText(`${prefix} description 1`, { exact: true }), '詳細に説明文が出る').toBeVisible();

      const nav = page.getByTestId(vp.width >= 768 ? 'look-detail-bottom-nav' : 'look-detail-fixed-nav');
      const adjacentLinks = nav.locator('a[href^="/look/"]');
      await expect(adjacentLinks, '前後のリンクは PREV（1 つ新しい LOOK）だけで、NEXT は無効').toHaveCount(1);
      await expect(adjacentLinks.first()).toHaveAttribute('href', `/look/${newerId}`);
    });
  }
});

test.describe('FR-LOOK-SEC-005 looks の読み出しの失敗', () => {
  for (const vp of VIEWPORTS) {
    test(`SEC-LOOK-022-AC-01 ${vp.name}: looks の読み出しが失敗している時に /look を開くと、誤りの画面が表示され、LOOK が0件の時の表示にならない`, async ({ page, request }) => {
      test.setTimeout(120_000);
      requireLocalSupabase();
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await withLocalDb(async (db) => {
        const privilege = async () =>
          Boolean((await db.query(`select has_table_privilege('anon', 'public.looks', 'select') as ok`)).rows[0].ok);
        expect(await privilege(), 'anon が looks を読める（前提）').toBe(true);

        await db.query('revoke select on public.looks from anon');
        try {
          // 読み出しが本当に失敗する状態になった（制御の確認）
          const probe = await request.get(restUrl('looks', '?select=id&limit=1'), { headers: restHeaders(ANON_KEY), failOnStatusCode: false });
          expect([401, 403], `anon の looks の select が権限の誤りで失敗する（status: ${probe.status()}）`).toContain(probe.status());

          const response = await page.goto('/look');
          const status = response?.status() ?? 0;
          await expect(page.getByText(EMPTY_STATE_TEXT), '「LOOK が0件」の表示にならない').toHaveCount(0);
          await expect(page.locator('[data-testid="look-card"]'), 'LOOK のカードが並ばない').toHaveCount(0);
          const bodyText = await page.locator('body').innerText();
          expect(
            status >= 500 || /エラー|error|problem|失敗|障害/i.test(bodyText),
            `誤りの画面が表示される（status: ${status}）`,
          ).toBe(true);
        } finally {
          await db.query('grant select on public.looks to anon');
          expect(await privilege(), '後始末: anon の looks の select 権限を戻した').toBe(true);
        }
      });
    });
  }

  test('SEC-LOOK-022-AC-02 looks の読みが DB の失敗になる時、管理の1件の取得 GET /api/admin/looks/<id> は 404 ではなく 500 を返す', async ({ request, baseURL }) => {
    test.setTimeout(120_000);
    requireLocalSupabase();
    if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
    const actor = await createLookAdmin();
    const prefix = `E2E-LOOK-SEC005-${randomBytes(4).toString('hex')}`;
    try {
      const id = await insertPrivateLook(`${prefix}-read-failure`);
      await withLocalDb(async (db) => {
        const granted = await db.query(`select has_table_privilege('service_role', 'public.looks', 'select') as ok`);
        expect(granted.rows[0].ok, '前提: service_role が looks を読める').toBe(true);

        await db.query('revoke select on public.looks from service_role');
        try {
          const res = await request.get(`/api/admin/looks/${id}`, {
            headers: { ...bearerHeaders(actor), 'x-forwarded-for': uniqueIp(), origin: new URL(baseURL).origin },
          });
          expect(res.status()).toBe(500);
        } finally {
          await db.query('grant select on public.looks to service_role');
        }
      });
    } finally {
      await purgeLooksByThemePrefix(prefix);
    }
  });
});
