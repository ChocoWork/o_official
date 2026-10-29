/**
 * FR-NEWS-SEC-002 お知らせ（news_articles）の PostgREST・RPC の直接の道が閉じていることを確かめる
 * 対応: SEC-NEWS-001-AC-01 / SEC-NEWS-002-AC-01 / SEC-NEWS-002-AC-02 / SEC-NEWS-002-AC-03
 *       / SEC-NEWS-010-AC-01 / SEC-NEWS-010-AC-02 / SEC-NEWS-022-AC-01 / SEC-NEWS-025-AC-01
 *
 * 画面は開かない（HTTP だけの試験なので画面幅の 3 つには繰り返さない。FR-NEWS-SEC-004 と同じ扱い）。
 * 手元の Supabase（NEXT_PUBLIC_SUPABASE_URL が localhost）の /rest/v1 を anon の鍵・一般会員の JWT・
 * 店長（役割 admin。admin.news.read・admin.news.manage を持つ）の aal1・aal2 の JWT・service role の鍵で直接叩き、
 * 手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）で行が変わっていないことを確かめる。
 * - SEC-NEWS-001-AC-01: 非公開の記事が anon と一般会員の select に出ない
 * - SEC-NEWS-002-AC-01/02: aal1 の JWT の select に非公開の記事が出ず、insert・update・delete が行を変えない
 * - SEC-NEWS-002-AC-03: aal2 の session をログアウトした後、残った access token の select に非公開の記事が出ない
 * - SEC-NEWS-010-AC-01/02: anon の search_news は件数の上限があり、search_public_news は権限の誤りで断られる
 * - SEC-NEWS-025-AC-01: 201字の題と置き場の外の image_url の insert が CHECK の違反で断られる
 * - SEC-NEWS-022-AC-01: anon が news_articles の TRUNCATE・INSERT・UPDATE・DELETE・TRIGGER の権限を持たない
 * 足した行・利用者は試験ごとの finally と afterAll で消す。JWT・パスワードが通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, test, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { createTestMember } from './member-session-helpers';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
// 表の CHECK（置き場の中の news/ の下）が入った後も通る、足す行の画像の道
const VALID_IMAGE = 'news/e2e-sec-002.png';

type Seed = { title: string; status: 'private' | 'published' };
type NewsRow = { id: number; title: string; status: string };
type JsonRow = Record<string, unknown>;

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外ではお知らせを足さない');
}

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  requireLocalEnv();
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function tag(label: string): string {
  return `E2E-NEWS-${label}-${randomUUID()}`;
}

function newsUrl(query: string): string {
  return `${SUPABASE_URL}/rest/v1/news_articles${query}`;
}

function postgrestHeaders(bearer: string, apikey: string = ANON_KEY): Record<string, string> {
  return { apikey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}

function newsBody(title: string, status: 'private' | 'published', imageUrl: string = VALID_IMAGE): JsonRow {
  return {
    title,
    category: 'EVENT',
    published_date: '2000-01-01',
    image_url: imageUrl,
    content: 'Synthetic content',
    detailed_content: 'Synthetic detailed content',
    status,
  };
}

async function insertNews(seeds: Seed[]): Promise<number[]> {
  return withDb(async (db) => {
    const ids: number[] = [];
    for (const seed of seeds) {
      const result = await db.query<{ id: string }>(
        `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
         values ($1, 'EVENT', '2000-01-01', $2, 'Synthetic content', 'Synthetic detailed content', $3)
         returning id`,
        [seed.title, VALID_IMAGE, seed.status],
      );
      ids.push(Number(result.rows[0].id));
    }
    return ids;
  });
}

/** 行を足して場面を流し、finally で必ず消す（足した id と、場面の中で作られうる題の行の両方を消す） */
async function withNews<T>(seeds: Seed[], extraTitles: string[], scenario: (ids: number[]) => Promise<T>): Promise<T> {
  const ids = await insertNews(seeds);
  try {
    return await scenario(ids);
  } finally {
    const titles = [...seeds.map((seed) => seed.title), ...extraTitles];
    await withDb((db) =>
      db.query('delete from public.news_articles where id = any($1::bigint[]) or title = any($2::text[])', [ids, titles]),
    );
  }
}

async function readRows(where: 'ids' | 'titles', values: Array<number | string>): Promise<NewsRow[]> {
  return withDb(async (db) => {
    const column = where === 'ids' ? 'id = any($1::bigint[])' : 'title = any($1::text[])';
    const result = await db.query<{ id: string; title: string; status: string }>(
      `select id::text, title, status from public.news_articles where ${column} order by id`,
      [values],
    );
    return result.rows.map((row) => ({ id: Number(row.id), title: row.title, status: row.status }));
  });
}

async function jsonRows(response: APIResponse): Promise<JsonRow[]> {
  const text = await response.text();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as JsonRow[]) : [];
  } catch {
    return [];
  }
}

async function jsonObject(response: APIResponse): Promise<JsonRow> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRow) : {};
  } catch {
    return {};
  }
}

/**
 * 「表の権限が無い」ことで断られたこと（403・SQLSTATE 42501・文が permission denied for table <表>）。
 * RLS の違反（new row violates row-level security policy）や 0 件の成功は通さない。JWT は有効なので 401 も通さない
 */
async function expectPermissionDenied(response: APIResponse, table: string, label: string): Promise<void> {
  const body = await jsonObject(response);
  expect(response.status(), `${label}: 権限の誤りの状態`).toBe(403);
  expect(body.code, `${label}: SQLSTATE`).toBe('42501');
  expect(String(body.message), `${label}: 権限の誤りの文（RLS の誤りでも 0 件の成功でもない）`).toBe(`permission denied for table ${table}`);
}

// 作った利用者は afterAll で消す（消せなくても db reset で消える）
const createdUserIds: string[] = [];

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  aal1Promise = null;
  memberPromise = null;
  if (createdUserIds.length === 0) return;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
  for (const userId of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

async function newActor(aal: 'aal1' | 'aal2'): Promise<AdminSessionActor> {
  return withDb(async (db) => {
    const actor = await createAdminSessionActor(db as unknown as PgClient, 'admin', aal);
    createdUserIds.push(actor.userId);
    return actor;
  });
}

// aal1 の店長は worker ごとに 1 回だけ作る（Auth のログインの回数の制限を使い切らない）
let aal1Promise: Promise<AdminSessionActor> | null = null;
function aal1Admin(): Promise<AdminSessionActor> {
  aal1Promise ??= newActor('aal1');
  return aal1Promise;
}

// 一般会員（役割なし）の JWT も worker ごとに 1 回だけ作る。createTestMember のパスワードは返らないので、service role で決め直す
let memberPromise: Promise<string> | null = null;
function memberAccessToken(): Promise<string> {
  memberPromise ??= (async () => {
    requireLocalEnv();
    const member = await createTestMember('news-sec-001');
    createdUserIds.push(member.userId);
    const password = `E2e-${randomBytes(12).toString('hex')}!`;
    const updated = await createClient(SUPABASE_URL, SERVICE_KEY, clientOptions).auth.admin.updateUserById(member.userId, { password });
    if (updated.error) throw new Error(`手元の会員のパスワードを決められない（status: ${updated.error.status ?? '不明'}）`);
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.email, password }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error('手元の会員の password grant の要求に失敗した');
    });
    if (!res.ok) throw new Error(`手元の会員の password grant が通らない: ${res.status}`);
    const reply = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!reply.access_token) throw new Error('手元の会員の password grant の応答に token が無い');
    return reply.access_token;
  })();
  return memberPromise;
}

test.describe(`FR-NEWS-SEC-002 anon と一般会員の直接の読み出し`, () => {
  test(`SEC-NEWS-001-AC-01 非公開の記事を1件入れた状態で、anon の鍵と一般会員の JWT の news_articles の select の結果にその記事が含まれない`, async ({ page }) => {
    const member = await memberAccessToken();
    const privateTitle = tag('SEC001-PRIVATE');
    const publishedTitle = tag('SEC001-PUBLISHED');

    await withNews(
      [
        { title: privateTitle, status: 'private' },
        { title: publishedTitle, status: 'published' },
      ],
      [],
      async ([privateId, publishedId]) => {
        const credentials = [
          { name: 'anon の鍵', bearer: ANON_KEY },
          { name: '一般会員の JWT', bearer: member },
        ];
        for (const credential of credentials) {
          // 足した 2 件を id で指す select。公開の記事は読め（鍵・JWT が通っている）、非公開の記事は含まれない
          const byId = await page.request.get(newsUrl(`?select=id,title,status&id=in.(${privateId},${publishedId})`), {
            headers: postgrestHeaders(credential.bearer),
            failOnStatusCode: false,
          });
          expect(byId.status(), `${credential.name} の select の状態`).toBe(200);
          const byIdRows = (await byId.json()) as NewsRow[];
          expect(byIdRows.map((row) => row.id), `${credential.name}: 公開の記事は読める`).toContain(publishedId);
          expect(byIdRows.map((row) => row.id), `${credential.name}: 非公開の記事の id が含まれない`).not.toContain(privateId);
          expect(byIdRows.map((row) => row.title), `${credential.name}: 非公開の記事の題が含まれない`).not.toContain(privateTitle);

          // 非公開の記事を題で指す select でも、非公開の状態を指す select でも、その記事は含まれない
          const byTitle = await page.request.get(newsUrl(`?select=id,title,status&title=eq.${encodeURIComponent(privateTitle)}`), {
            headers: postgrestHeaders(credential.bearer),
            failOnStatusCode: false,
          });
          expect(byTitle.status(), `${credential.name}: 題で指す select の状態`).toBe(200);
          expect(await jsonRows(byTitle), `${credential.name}: 題で指す select の結果が空`).toHaveLength(0);

          const privateOnly = await page.request.get(newsUrl('?select=id,title,status&status=eq.private'), {
            headers: postgrestHeaders(credential.bearer),
            failOnStatusCode: false,
          });
          expect(privateOnly.status(), `${credential.name}: 非公開を指す select の状態`).toBe(200);
          const privateRows = (await privateOnly.json()) as NewsRow[];
          expect(privateRows.map((row) => row.id), `${credential.name}: 非公開を指す select の結果`).not.toContain(privateId);
          expect(privateRows, `${credential.name}: 非公開を指す select の結果が空`).toHaveLength(0);
        }
      },
    );
  });
});

test.describe(`FR-NEWS-SEC-002 aal1 の JWT で PostgREST を直接叩く`, () => {
  test(`SEC-NEWS-002-AC-01 admin.news.read を持つ利用者の aal1 の JWT で select した時、非公開の記事が結果に含まれない`, async ({ page }) => {
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    const privateTitle = tag('SEC002-PRIVATE');
    const publishedTitle = tag('SEC002-PUBLISHED');

    await withNews(
      [
        { title: privateTitle, status: 'private' },
        { title: publishedTitle, status: 'published' },
      ],
      [],
      async ([privateId, publishedId]) => {
        // 足した 2 件を id で指す select。公開の記事は読め（JWT が通っている）、非公開の記事は含まれない
        const byId = await page.request.get(newsUrl(`?select=id,title,status&id=in.(${privateId},${publishedId})`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        expect(byId.status(), 'aal1 の JWT の select の状態').toBe(200);
        const byIdRows = (await byId.json()) as NewsRow[];
        expect(byIdRows.map((row) => row.id), '公開の記事は読める').toContain(publishedId);
        expect(byIdRows.map((row) => row.id), '非公開の記事の id が含まれない').not.toContain(privateId);
        expect(byIdRows.map((row) => row.title), '非公開の記事の題が含まれない').not.toContain(privateTitle);

        // 非公開の記事を指して取る select と、絞らない select でも、非公開の記事は 1 件も含まれない
        const privateOnly = await page.request.get(newsUrl('?select=id,title,status&status=eq.private'), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        const privateRows = privateOnly.status() === 200 ? ((await privateOnly.json()) as NewsRow[]) : [];
        expect(privateRows.map((row) => row.id), '非公開を指した select の結果').not.toContain(privateId);
        expect(privateRows, '非公開を指した select の結果が空').toHaveLength(0);

        const all = await page.request.get(newsUrl('?select=id,title,status'), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        const allRows = all.status() === 200 ? ((await all.json()) as NewsRow[]) : [];
        expect(allRows.filter((row) => row.status !== 'published'), '全件の select に非公開の記事が含まれない').toHaveLength(0);
      },
    );
  });

  test(`SEC-NEWS-002-AC-02 admin.news.manage を持つ利用者の aal1 の JWT の insert・update・delete が、どれも行を変えずに終わる`, async ({ page }) => {
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    const insertTitle = tag('SEC002-INSERT');
    const updateTitle = tag('SEC002-UPDATE');
    const updatedTitle = tag('SEC002-UPDATED');
    const deleteTitle = tag('SEC002-DELETE');

    await withNews(
      [
        { title: updateTitle, status: 'published' },
        { title: deleteTitle, status: 'published' },
      ],
      [insertTitle, updatedTitle],
      async ([updateId, deleteId]) => {
        // JWT 自体は通っている（公開の記事を読める）うえで、書く道が閉じていることを確かめる
        const readable = await page.request.get(newsUrl(`?select=id&id=eq.${updateId}`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        expect(readable.status(), 'aal1 の JWT で公開の記事は読める').toBe(200);
        expect((await jsonRows(readable)).length, 'aal1 の JWT で公開の記事は読める（件数）').toBe(1);

        const inserted = await page.request.post(newsUrl(''), {
          headers: postgrestHeaders(actor.accessToken),
          data: newsBody(insertTitle, 'published'),
          failOnStatusCode: false,
        });
        await expectPermissionDenied(inserted, 'news_articles', 'news_articles の insert');

        const updated = await page.request.patch(newsUrl(`?id=eq.${updateId}`), {
          headers: postgrestHeaders(actor.accessToken),
          data: { title: updatedTitle },
          failOnStatusCode: false,
        });
        await expectPermissionDenied(updated, 'news_articles', 'news_articles の update');

        const deleted = await page.request.delete(newsUrl(`?id=eq.${deleteId}`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        await expectPermissionDenied(deleted, 'news_articles', 'news_articles の delete');

        // DB の行が変わっていない
        expect(await readRows('titles', [insertTitle]), 'insert した行が DB に無い').toHaveLength(0);
        const updateRows = await readRows('ids', [updateId]);
        expect(updateRows.map((row) => row.title), 'update した行の題が変わっていない').toEqual([updateTitle]);
        expect(await readRows('titles', [updatedTitle]), 'update 後の題の行が DB に無い').toHaveLength(0);
        const deleteRows = await readRows('ids', [deleteId]);
        expect(deleteRows.map((row) => row.title), 'delete した行が DB に残っている').toEqual([deleteTitle]);
      },
    );
  });
});

test.describe(`FR-NEWS-SEC-002 ログアウトした session の token で PostgREST を直接叩く`, () => {
  test(`SEC-NEWS-002-AC-03 admin.news.read を持つ利用者の token をログアウトの後（token の期限の前）に使った select の結果に、非公開の記事が含まれない`, async ({ page }) => {
    // 対照を取れるよう aal2 の session を使う（aal1 だと、ログアウトの前から非公開の記事が読めない形でも通ってしまう）
    const actor = await newActor('aal2');
    expect(actor.aal).toBe('aal2');
    const privateTitle = tag('SEC002-LOGOUT');

    await withNews([{ title: privateTitle, status: 'private' }], [], async ([privateId]) => {
      // ログアウトの前は、同じ access token の select に非公開の記事が含まれる（token が有効だった確かめ）
      const before = await page.request.get(newsUrl(`?select=id,title,status&id=eq.${privateId}`), {
        headers: postgrestHeaders(actor.accessToken),
        failOnStatusCode: false,
      });
      expect(before.status(), 'ログアウトの前の select の状態').toBe(200);
      expect((await jsonRows(before)).map((row) => row.id), 'ログアウトの前は非公開の記事が読める').toEqual([privateId]);

      // ログアウト（Auth の /logout。session の行が消える）
      const logout = await page.request.post(`${SUPABASE_URL}/auth/v1/logout`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${actor.accessToken}`, 'Content-Type': 'application/json' },
        failOnStatusCode: false,
      });
      expect(logout.status(), 'ログアウトの状態').toBeLessThan(300);
      const remaining = await withDb((db) => db.query('select 1 from auth.sessions where id = $1::uuid', [actor.sessionId]));
      expect(remaining.rowCount, 'ログアウトで session の行が消えた').toBe(0);

      // ログアウトの後（JWT の期限の前）に、控えた token で select する
      const after = await page.request.get(newsUrl(`?select=id,title,status&id=eq.${privateId}`), {
        headers: postgrestHeaders(actor.accessToken),
        failOnStatusCode: false,
      });
      expect(after.status(), 'ログアウトの後の select がサーバーの誤りで終わらない').toBeLessThan(500);
      const afterRows = (await jsonRows(after)) as unknown as NewsRow[];
      expect(afterRows.map((row) => row.id), 'ログアウトの後の select に非公開の記事の id が含まれない').not.toContain(privateId);
      expect(afterRows.map((row) => row.title), 'ログアウトの後の select に非公開の記事の題が含まれない').not.toContain(privateTitle);

      const afterPrivate = await page.request.get(newsUrl('?select=id,title,status&status=eq.private'), {
        headers: postgrestHeaders(actor.accessToken),
        failOnStatusCode: false,
      });
      const afterAllRows = (await jsonRows(afterPrivate)) as unknown as NewsRow[];
      expect(afterAllRows.filter((row) => row.status !== 'published'), 'ログアウトの後の select に非公開の記事が 1 件も含まれない').toHaveLength(0);
    });
  });
});

const SEARCH_ROWS = 25;

test.describe(`FR-NEWS-SEC-002 anon が検索の RPC を直接叩く`, () => {
  test(`SEC-NEWS-010-AC-01 anon で search_news を limit_count=10000 で呼んだ時、返る行が20以下であるか、呼び出しが断られる`, async ({ page }) => {
    requireLocalEnv();
    const marker = tag('SEC010');
    const seeds: Seed[] = Array.from({ length: SEARCH_ROWS }, (_, index) => ({ title: `${marker}-${index}`, status: 'published' }));

    await withNews(seeds, [], async (ids) => {
      // 検索に当たる公開の記事が上限の20より多く DB にある（20以下に見えるのが、当たりが少ないだけではないという確かめ）
      const stored = await readRows('ids', ids);
      expect(stored.filter((row) => row.status === 'published'), '当たる公開の記事の数').toHaveLength(SEARCH_ROWS);

      const response = await page.request.post(`${SUPABASE_URL}/rest/v1/rpc/search_news`, {
        headers: postgrestHeaders(ANON_KEY),
        data: { search_query: marker, limit_count: 10000 },
        failOnStatusCode: false,
      });
      const status = response.status();
      if (status === 401 || status === 403) return; // 呼び出しが断られた
      expect(status, '断られないなら 200 で返る').toBe(200);
      const rows = await jsonRows(response);
      expect(rows.length, 'limit_count=10000 でも返る行は20以下').toBeLessThanOrEqual(20);
    });
  });

  test(`SEC-NEWS-010-AC-02 anon で search_public_news を呼ぶと、権限の誤りで断られる`, async ({ page }) => {
    requireLocalEnv();
    const response = await page.request.post(`${SUPABASE_URL}/rest/v1/rpc/search_public_news`, {
      headers: postgrestHeaders(ANON_KEY),
      data: { p_query: 'E2E', p_limit: 6 },
      failOnStatusCode: false,
    });
    expect([401, 403], `権限の誤りの状態（実際: ${response.status()}）`).toContain(response.status());
    const body = await jsonObject(response);
    expect(body.code, '権限の誤りの SQLSTATE（42501）').toBe('42501');
  });
});

test.describe(`FR-NEWS-SEC-002 表の段の CHECK`, () => {
  test(`SEC-NEWS-025-AC-01 service role の201字の題の insert と image_url が other/x.png の insert が、どちらも CHECK の違反（23514）で断られ、行が増えない`, async ({ page }) => {
    requireLocalEnv();
    const longTitle = tag('SEC025-LONG').padEnd(201, 'x');
    const outsideTitle = tag('SEC025-OUTSIDE');
    expect(longTitle).toHaveLength(201);
    const serviceHeaders = postgrestHeaders(SERVICE_KEY, SERVICE_KEY);

    try {
      const tooLong = await page.request.post(newsUrl(''), {
        headers: serviceHeaders,
        data: newsBody(longTitle, 'private'),
        failOnStatusCode: false,
      });
      expect(tooLong.status(), '201字の題の insert の状態').toBe(400);
      expect((await jsonObject(tooLong)).code, '201字の題の insert の SQLSTATE（CHECK の違反）').toBe('23514');
      expect(await readRows('titles', [longTitle]), '201字の題の行が増えない').toHaveLength(0);

      const outside = await page.request.post(newsUrl(''), {
        headers: serviceHeaders,
        data: newsBody(outsideTitle, 'private', 'other/x.png'),
        failOnStatusCode: false,
      });
      expect(outside.status(), 'image_url が other/x.png の insert の状態').toBe(400);
      expect((await jsonObject(outside)).code, 'image_url が other/x.png の insert の SQLSTATE（CHECK の違反）').toBe('23514');
      expect(await readRows('titles', [outsideTitle]), 'image_url が other/x.png の行が増えない').toHaveLength(0);
    } finally {
      await withDb((db) =>
        db.query('delete from public.news_articles where title = any($1::text[])', [[longTitle, outsideTitle]]),
      );
    }
  });
});

test.describe(`FR-NEWS-SEC-002 表の権限`, () => {
  test(`SEC-NEWS-022-AC-01 anon は news_articles の TRUNCATE・INSERT・UPDATE・DELETE・TRIGGER の権限を持たない（has_table_privilege がすべて false）`, async () => {
    requireLocalEnv();
    const privileges = ['TRUNCATE', 'INSERT', 'UPDATE', 'DELETE', 'TRIGGER'] as const;

    const granted = await withDb(async (db) => {
      const result: Record<string, boolean> = {};
      for (const privilege of privileges) {
        const row = await db.query<{ ok: boolean }>(
          `select has_table_privilege('anon', 'public.news_articles', $1) as ok`,
          [privilege],
        );
        result[privilege] = row.rows[0].ok;
      }
      return result;
    });

    expect(granted).toEqual({ TRUNCATE: false, INSERT: false, UPDATE: false, DELETE: false, TRIGGER: false });
  });
});
