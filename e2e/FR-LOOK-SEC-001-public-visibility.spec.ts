/**
 * FR-LOOK-SEC-001 公開の LOOK の見え方（非公開の遮断・画像の URL・外の値・件数と項目・id の形・文字のエスケープ・取り出しの失敗）
 * 対応: SEC-LOOK-001-AC-01 / SEC-LOOK-001-AC-02 / SEC-LOOK-006-AC-01 / SEC-LOOK-006-AC-02 / SEC-LOOK-007-AC-01 /
 *       SEC-LOOK-008-AC-01 / SEC-LOOK-009-AC-01 / SEC-LOOK-016-AC-01 / SEC-LOOK-017-AC-01
 *
 * ログインしない公開の道だけを見る。手元の Supabase に足す LOOK は created_at を 2000-01-01、テーマを一意の印つきにし、
 * 各試験の finally で消す（見本の LOOK 1〜7 には触らない）。署名つき URL が出る試験は、置き場（look-images）に本物の画像を置いて消す。
 * - 001-AC-01: 手元の PostgREST を anon の鍵と一般会員の JWT で直接叩く（looks の select と search_looks）
 * - 006・007・008・009: ページの HTML（応答の本文）に、画像の道筋・署名つき URL・外の URL・説明文が出るかを見る
 * - SEC-LOOK-022-AC-01（looks の読み出しの失敗）は、共有の DB の権限を外すので FR-LOOK-SEC-005（isolated-global の project）にある
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { SEED_IMAGE_PNG_BASE64 } from '../scripts/e2e/seed-storage';
import {
  ANON_KEY,
  SUPABASE_URL,
  createMemberActor,
  deleteHomeGrantUsers,
  jsonRows,
  requireLocalSupabase,
  restHeaders,
  restUrl,
  type MemberActor,
} from './home-grant-test-utils';
import { insertLegacyImageRow } from './legacy-image-rows';
import { withLocalDb } from './order-email-test-utils';

// 一般会員の JWT を通信記録に残さない
test.use({ trace: 'off' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const LOOK_IMAGES_BUCKET = 'look-images';
const NOT_FOUND_HEADING = 'Look not found';

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  memberPromise = null;
  await deleteHomeGrantUsers();
});

let memberPromise: Promise<MemberActor> | null = null;
function memberActor(): Promise<MemberActor> {
  memberPromise ??= createMemberActor();
  return memberPromise;
}

// ---------------------------------------------------------------------------
// 手元の Supabase に足す LOOK と画像
// ---------------------------------------------------------------------------

function uniqueLookTag(label: string): string {
  return `E2E-LOOK-SEC-${label}-${randomBytes(4).toString('hex')}`;
}

/** 管理の窓口が作る形（looks/日付/uuid.拡張子）の画像の道筋 */
function newImagePath(): { path: string; token: string } {
  const token = randomUUID();
  return { path: `looks/2000-01-01/${token}.png`, token };
}

type LookSeed = {
  theme: string;
  description?: string;
  status: 'published' | 'private';
  imageUrls?: string[];
  /** true なら imageUrls は DB の CHECK（looks/ の下だけ）に合わない旧い行として入れる（ADR-0162。e2e/legacy-image-rows.ts） */
  legacyImageUrls?: boolean;
};

class LookFixtures {
  readonly ids: number[] = [];
  private readonly storagePaths: string[] = [];

  async addLook(seed: LookSeed): Promise<number> {
    const id = await withLocalDb(async (db) => {
      const insertSql = `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
         values (2000, 'SS', $1, $2, $3::text[], $4, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
         returning id`;
      const params = [seed.theme, seed.description ?? '', seed.imageUrls ?? [], seed.status];
      if (seed.legacyImageUrls) {
        return insertLegacyImageRow(db, 'looks', 'looks_image_urls_path_check', insertSql, params);
      }
      const inserted = await db.query(insertSql, params);
      return Number(inserted.rows[0].id);
    });
    this.ids.push(id);
    return id;
  }

  async setStatus(id: number, status: 'published' | 'private'): Promise<void> {
    await withLocalDb(async (db) => {
      const updated = await db.query('update public.looks set status = $2 where id = $1', [id, status]);
      expect(updated.rowCount, `LOOK ${id} の状態を ${status} に変えられた`).toBe(1);
    });
  }

  /** 置き場に本物の画像を置く（署名つき URL は、置き場に物がある時だけ作られる） */
  async uploadImage(path: string): Promise<void> {
    requireLocalSupabase();
    const { error } = await storageAdmin()
      .storage.from(LOOK_IMAGES_BUCKET)
      .upload(path, Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64'), { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`試験用の画像を置けない: ${path}（${error.message}）`);
    this.storagePaths.push(path);
  }

  async cleanup(): Promise<void> {
    if (this.ids.length > 0) {
      await withLocalDb((db) => db.query('delete from public.looks where id = any($1::bigint[])', [this.ids]));
    }
    if (this.storagePaths.length > 0) {
      await storageAdmin()
        .storage.from(LOOK_IMAGES_BUCKET)
        .remove(this.storagePaths)
        .catch(() => undefined);
    }
  }
}

function storageAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY が env に無い');
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------------------------------------------------------------------------
// ページの中身の読み方
// ---------------------------------------------------------------------------

/** ページを開き、応答の本文（HTML）をそのまま返す。ブラウザ側で組み直した DOM ではない */
async function openHtml(page: Page, path: string): Promise<{ status: number; html: string }> {
  const response = await page.goto(path);
  if (!response) throw new Error(`${path} の応答が無い`);
  return { status: response.status(), html: await response.text() };
}

/**
 * 画像の URL の探し物をしやすくする。HTML の実体参照・RSC の JSON の逃がし・URL の符号（/_next/image?url=...）を戻す。
 * 戻した文字は「出ていないこと」を確かめる時の探し先にだけ使う。
 */
function normalize(text: string): string {
  const unescaped = text
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  const decodeOnce = (value: string) =>
    value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return decodeOnce(decodeOnce(unescaped));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** `<meta property="og:image" content="...">` の content を全部返す */
function ogImages(html: string): string[] {
  const values: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (!/\bproperty="og:image"/.test(tag)) continue;
    const content = tag.match(/\bcontent="([^"]*)"/);
    if (content) values.push(decodeEntities(content[1]));
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visibleImageSources(page: Page): Promise<string[]> {
  return page.locator('img').evaluateAll((images) =>
    images.map((image) => {
      const element = image as HTMLImageElement;
      return [element.getAttribute('src'), element.getAttribute('srcset'), element.currentSrc].filter(Boolean).join(' ');
    }),
  );
}

function expectNotFoundScreen(page: Page) {
  return expect(page.getByRole('heading', { name: NOT_FOUND_HEADING })).toBeVisible();
}

function expectResponseOk(response: APIResponse, label: string): void {
  expect(response.status(), `${label}: 応答が読める（制御の確認）`).toBe(200);
}

// ---------------------------------------------------------------------------
// SEC-LOOK-001
// ---------------------------------------------------------------------------

test.describe('FR-LOOK-SEC-001 DB の直接の読み出しに非公開の LOOK が出ない', () => {
  test('SEC-LOOK-001-AC-01: 非公開の LOOK を1件入れた状態で、anon と一般会員の JWT の select の結果と search_looks の結果に、その LOOK が含まれない', async ({ request }) => {
    test.setTimeout(120_000);
    requireLocalSupabase();
    const member = await memberActor();
    const tag = uniqueLookTag('direct');
    const privateTheme = `${tag}-private`;
    const publishedTheme = `${tag}-published`;
    const fx = new LookFixtures();
    try {
      const privateId = await fx.addLook({ theme: privateTheme, status: 'private' });
      const publishedId = await fx.addLook({ theme: publishedTheme, status: 'published' });

      const callers = [
        { label: 'anon の鍵', token: ANON_KEY },
        { label: '一般会員の JWT', token: member.accessToken },
      ];
      for (const caller of callers) {
        const headers = restHeaders(caller.token);

        // looks の select: 公開の LOOK は読め、非公開の LOOK は含まれない
        const all = await request.get(restUrl('looks', '?select=id,theme,status&limit=1000'), { headers, failOnStatusCode: false });
        expectResponseOk(all, `${caller.label}: looks の select`);
        const allRows = await jsonRows(all);
        expect(allRows.map((row) => Number(row.id)), `${caller.label}: 公開の LOOK は select で読める（制御の確認）`).toContain(publishedId);
        expect(allRows.map((row) => Number(row.id)), `${caller.label}: select の結果に非公開の LOOK が含まれない`).not.toContain(privateId);
        expect(allRows.map((row) => row.theme), `${caller.label}: select の結果に非公開の LOOK のテーマが含まれない`).not.toContain(privateTheme);
        expect(allRows.filter((row) => row.status !== 'published'), `${caller.label}: select の結果に公開でない LOOK が1件も無い`).toHaveLength(0);

        const byId = await request.get(restUrl('looks', `?select=id,theme&id=eq.${privateId}`), { headers, failOnStatusCode: false });
        expectResponseOk(byId, `${caller.label}: 非公開の LOOK の id を指した select`);
        expect(await jsonRows(byId), `${caller.label}: 非公開の LOOK の id を指した select が 0 件`).toHaveLength(0);

        // search_looks: 同じ印で検索して、公開の LOOK だけが返る
        const searched = await request.post(restUrl('rpc/search_looks'), {
          headers,
          data: { search_query: tag, limit_count: 50 },
          failOnStatusCode: false,
        });
        expectResponseOk(searched, `${caller.label}: search_looks`);
        const searchedText = await searched.text();
        const searchedRows = (JSON.parse(searchedText) as Array<Record<string, unknown>>) ?? [];
        expect(searchedRows.map((row) => Number(row.id)), `${caller.label}: search_looks が公開の LOOK を返す（制御の確認）`).toEqual([publishedId]);
        expect(searchedText.includes(privateTheme), `${caller.label}: search_looks の結果に非公開の LOOK のテーマが含まれない`).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 公開の画面に非公開の LOOK が出ない (${vp.name})`, () => {
    test(`SEC-LOOK-001-AC-02 ${vp.name}: 非公開の LOOK の id で /look/<id> を開くと「Look not found」が表示され、頁の題と og:image にテーマと画像が出ず、/look の一覧にテーマが表示されない`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const theme = uniqueLookTag(`private-${vp.name}`);
      const image = newImagePath();
      const fx = new LookFixtures();
      try {
        const id = await fx.addLook({ theme, status: 'private', imageUrls: [image.path] });

        const detail = await openHtml(page, `/look/${id}`);
        await expectNotFoundScreen(page);
        const title = await page.title();
        expect(title.includes(theme), '頁の題に非公開の LOOK のテーマが出ない').toBe(false);
        expect(normalize(title).includes(image.token), '頁の題に画像の道筋が出ない').toBe(false);
        const og = normalize(ogImages(detail.html).join('\n'));
        expect(og.includes(theme), 'og:image にテーマが出ない').toBe(false);
        expect(og.includes(image.token), 'og:image に画像の道筋が出ない').toBe(false);

        const list = await openHtml(page, '/look');
        await expect(page.locator('[data-testid="look-card"]').first(), '一覧は開けている（制御の確認）').toBeAttached();
        await expect(page.getByText(theme), '/look の一覧に非公開の LOOK のテーマが表示されない').toHaveCount(0);
        expect(normalize(list.html).includes(theme), '/look の応答にも非公開の LOOK のテーマが含まれない').toBe(false);
      } finally {
        await fx.cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SEC-LOOK-006
// ---------------------------------------------------------------------------

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 非公開にした後の頁に画像の URL が出ない (${vp.name})`, () => {
    test(`SEC-LOOK-006-AC-01 ${vp.name}: 公開の LOOK を開いた後に非公開にして /look と /look/<id> を開き直すと、頁の HTML（og:image を含む）にその LOOK の画像の道筋を含む URL が出ない`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const theme = uniqueLookTag(`unpublish-${vp.name}`);
      const image = newImagePath();
      const fx = new LookFixtures();
      try {
        await fx.uploadImage(image.path);
        const id = await fx.addLook({ theme, status: 'published', imageUrls: [image.path] });

        // 公開の間は開ける（制御の確認）
        const publishedDetail = await openHtml(page, `/look/${id}`);
        expect(normalize(publishedDetail.html).includes(theme), '公開の間は詳細の頁にその LOOK が出る').toBe(true);
        const publishedList = await openHtml(page, '/look');
        expect(normalize(publishedList.html).includes(theme), '公開の間は一覧の頁にその LOOK が出る').toBe(true);

        await fx.setStatus(id, 'private');

        for (const path of ['/look', `/look/${id}`]) {
          const reopened = await openHtml(page, path);
          expect(reopened.status, `${path}: 非公開にした後も頁は誤りにならない`).toBeLessThan(500);
          expect(
            normalize(reopened.html).includes(image.token),
            `${path}: 非公開にした後の HTML にその LOOK の画像の道筋を含む URL が出ない`,
          ).toBe(false);
          expect(
            normalize(ogImages(reopened.html).join('\n')).includes(image.token),
            `${path}: 非公開にした後の og:image にその LOOK の画像の道筋を含む URL が出ない`,
          ).toBe(false);
        }
      } finally {
        await fx.cleanup();
      }
    });
  });
}

test.describe('FR-LOOK-SEC-001 og:image が期限の切れる署名つき URL でない', () => {
  test('SEC-LOOK-006-AC-02: 公開の LOOK の /look/<id> の og:image の値に、署名つき URL の token の問い合わせが含まれない', async ({ request }) => {
    test.fail(true, 'SEC-LOOK-006-AC-02 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
    test.setTimeout(120_000);
    const theme = uniqueLookTag('og');
    const image = newImagePath();
    const fx = new LookFixtures();
    try {
      await fx.uploadImage(image.path);
      const id = await fx.addLook({ theme, status: 'published', imageUrls: [image.path] });

      const response = await request.get(`/look/${id}`, { failOnStatusCode: false });
      expectResponseOk(response, `/look/${id}`);
      const html = await response.text();
      expect(normalize(html).includes(theme), '詳細の頁にその公開の LOOK が出ている（制御の確認）').toBe(true);

      for (const value of ogImages(html)) {
        expect(/[?&]token=/.test(value), `og:image の値に token の問い合わせが含まれない（値: ${value.replace(/token=[^&]+/, 'token=…')}）`).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-LOOK-007
// ---------------------------------------------------------------------------

test.describe('FR-LOOK-SEC-001 決まりの外の道筋は署名されない', () => {
  test('SEC-LOOK-007-AC-01: image_urls に ../other/x.png と other/x.png を入れた公開の LOOK の /look/<id> と /look の HTML に、other/x.png を指す署名つき URL が出ない', async ({ request }) => {
    test.fail(true, 'SEC-LOOK-007-AC-01 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
    test.setTimeout(120_000);
    // 置き場の他の物と重ならないよう、other の下の階層名に試験ごとの印を付ける
    const dir = `other-${randomBytes(4).toString('hex')}`;
    const theme = uniqueLookTag('path');
    const fx = new LookFixtures();
    try {
      // 署名は物があって初めて作られるので、決まりの外の道筋の先に本物の画像を置く
      await fx.uploadImage(`${dir}/x.png`);
      const id = await fx.addLook({ theme, status: 'published', imageUrls: [`../${dir}/x.png`, `${dir}/x.png`], legacyImageUrls: true });

      const signedForOther = new RegExp(`${escapeRegExp(dir)}/x\\.png[^\\s"'<>]*token=|object/sign/[^\\s"'<>]*${escapeRegExp(dir)}`);
      for (const path of [`/look/${id}`, '/look']) {
        const response = await request.get(path, { failOnStatusCode: false });
        expectResponseOk(response, path);
        const text = normalize(await response.text());
        expect(text.includes(theme), `${path}: その公開の LOOK が頁に出ている（制御の確認）`).toBe(true);
        expect(signedForOther.test(text), `${path}: other/x.png を指す署名つき URL が HTML に出ない`).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-LOOK-008
// ---------------------------------------------------------------------------

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 外の URL が画像の読み込み先にならない (${vp.name})`, () => {
    test(`SEC-LOOK-008-AC-01 ${vp.name}: image_urls に外のサイトの URL を入れた公開の LOOK の /look と /look/<id> の画像の src と og:image に、その外のサイトの URL が出ない`, async ({ page }) => {
      test.fail(true, 'SEC-LOOK-008-AC-01 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // 外のサイトへは実際に出ない
      await page.route(/evil\.example/, (route) => route.abort());
      const theme = uniqueLookTag(`external-${vp.name}`);
      const fx = new LookFixtures();
      try {
        const id = await fx.addLook({ theme, status: 'published', imageUrls: ['https://evil.example/x.png'], legacyImageUrls: true });

        for (const path of [`/look/${id}`, '/look']) {
          const opened = await openHtml(page, path);
          expect(opened.status, `${path}: 頁が開く`).toBeLessThan(500);
          expect(normalize(opened.html).includes(theme), `${path}: その公開の LOOK が頁に出ている（制御の確認）`).toBe(true);

          const sources = normalize((await visibleImageSources(page)).join('\n'));
          expect(sources.includes('evil.example'), `${path}: 画像の src に外のサイトの URL が出ない`).toBe(false);
          const og = normalize(ogImages(opened.html).join('\n'));
          expect(og.includes('evil.example'), `${path}: og:image に外のサイトの URL が出ない`).toBe(false);
        }
      } finally {
        await fx.cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SEC-LOOK-009
// ---------------------------------------------------------------------------

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 一覧の頁に表示しない項目が含まれない (${vp.name})`, () => {
    test(`SEC-LOOK-009-AC-01 ${vp.name}: /look の応答の中身に、見本の LOOK の説明文の文字が含まれない`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // 見本（seed.sql の LOOK 1〜7）の説明文。関連商品の価格は今のカードが出すので確かめない（Q11。2026-10-26）
      const seed = await withLocalDb(async (db) => {
        const descriptions = await db.query(
          `select distinct theme_description from public.looks where id between 1 and 7 and status = 'published' and theme_description <> ''`,
        );
        return { descriptions: descriptions.rows.map((row) => String(row.theme_description)) };
      });
      expect(seed.descriptions.length, '見本の LOOK の説明文が手元の DB にある（前提）').toBeGreaterThan(0);

      const { status, html } = await openHtml(page, '/look');
      expect(status, '/look が開く').toBe(200);
      const text = normalize(html);
      await expect(page.locator('[data-testid="look-card"]').first(), '一覧が表示されている（制御の確認）').toBeAttached();

      for (const description of seed.descriptions) {
        expect(text.includes(description), `/look の応答（HTML と受け渡し）に見本の説明文「${description}」が含まれない`).toBe(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SEC-LOOK-016
// ---------------------------------------------------------------------------

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 形の合わない id の詳細 (${vp.name})`, () => {
    test(`SEC-LOOK-016-AC-01 ${vp.name}: /look/abc・/look/1.5・/look/-1 を開くと、どれも「Look not found」の画面が表示される`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const path of ['/look/abc', '/look/1.5', '/look/-1']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: NOT_FOUND_HEADING }), `${path}: 「Look not found」の画面`).toBeVisible();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SEC-LOOK-017
// ---------------------------------------------------------------------------

const XSS_PAYLOAD = '<script>window.__xss=1</script><img src=x onerror=window.__xss=1>';

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-SEC-001 テーマと説明文のタグは文字として出る (${vp.name})`, () => {
    test(`SEC-LOOK-017-AC-01 ${vp.name}: テーマと説明文に script のタグと onerror の属性を入れた公開の LOOK が、/look と /look/<id> で文字として表示され、スクリプトが動かない`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const tag = uniqueLookTag(`xss-${vp.name}`);
      const theme = `${tag} ${XSS_PAYLOAD}`;
      const fx = new LookFixtures();
      try {
        const id = await fx.addLook({ theme, description: XSS_PAYLOAD, status: 'published' });

        const expectNothingExecuted = async (path: string, html: string) => {
          expect(html.includes('<script>window.__xss=1</script>'), `${path}: 応答の本文に生の script のタグが入らない`).toBe(false);
          expect(html.includes('<img src=x'), `${path}: 応答の本文に生の img のタグが入らない`).toBe(false);
          const state = await page.evaluate(() => ({
            xss: (window as unknown as { __xss?: unknown }).__xss,
            injectedScripts: Array.from(document.scripts).filter((script) => (script.textContent ?? '').trim() === 'window.__xss=1').length,
            injectedImages: document.querySelectorAll('img[src="x"]').length,
          }));
          expect(state.xss, `${path}: window.__xss が定義されない（スクリプトが動かない）`).toBeUndefined();
          expect(state.injectedScripts, `${path}: 頁に差し込まれた script の要素が無い`).toBe(0);
          expect(state.injectedImages, `${path}: 頁に差し込まれた img[src=x] が無い`).toBe(0);
          expect(dialogs, `${path}: ダイアログが出ない`).toEqual([]);
        };

        // 詳細: テーマと説明文が文字として出る
        const detail = await openHtml(page, `/look/${id}`);
        await expect(page.getByRole('heading', { level: 1 }), '詳細のテーマの見出しが入れた文字のまま').toHaveText(theme);
        await expect(page.getByText(XSS_PAYLOAD, { exact: true }), '詳細の説明文が入れた文字のまま').toHaveCount(1);
        expect(await page.title(), '頁の題にテーマが文字として入る').toContain(theme);
        await expectNothingExecuted(`/look/${id}`, detail.html);

        // 一覧: テーマが文字として出る
        const list = await openHtml(page, '/look');
        const card = page.locator('[data-testid="look-card"]', { hasText: tag });
        await expect(card.first(), '一覧にその LOOK のカードが出る').toBeAttached();
        await expect(card.first().locator('h3').first(), '一覧のテーマが入れた文字のまま').toContainText(XSS_PAYLOAD);
        await expectNothingExecuted('/look', list.html);
      } finally {
        await fx.cleanup();
      }
    });
  });
}
