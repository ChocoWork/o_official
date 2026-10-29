/**
 * FR-SEARCH-020 検索の DB の関数を、アプリを通さず PostgREST から直接呼んでも、権限・公開の絞り・件数の上限が守られる
 * 対応: FREQ-186-AC-02 / SEC-SEARCH-002-AC-01 / SEC-SEARCH-007-AC-01 / SEC-SEARCH-008-AC-01 / SEC-SEARCH-009-AC-01
 *
 * 手元の Supabase（NEXT_PUBLIC_SUPABASE_URL が localhost）の PostgREST（/rest/v1/rpc/<関数>）を、anon の鍵・一般会員の JWT・
 * 管理の読み取りの権限を持つ人の aal1・aal2 の JWT（どちらもアプリの sessions に結び付けた本物。aal2 は同じ session を TOTP 済みに上げたもの）で直接叩く。画面は開かない
 * （HTTP の試験なので幅で結果は変わらない。幅のくり返しはせず AC ごとに1本だけ流す）。
 *
 * - FREQ-186-AC-02 / SEC-SEARCH-009-AC-01: get_popular_items の EXECUTE（pg の has_function_privilege）と、anon・一般会員の直接の呼び出しの断り。
 *   /api/search の応答に purchase_count が無いこと
 * - SEC-SEARCH-002-AC-01: 手元の DB に非公開・公開の商品・ルック・お知らせを足し、search_items/looks/news が非公開を返さないこと
 * - SEC-SEARCH-007-AC-01: 公開の商品・ルックを上限より多く足し、limit_count=100000・null・-1 でも上限以下で誤りにならないこと
 * - SEC-SEARCH-008-AC-01: search_public_items/looks/news を anon の鍵で呼ぶと、権限か「関数が無い」の誤りで、行が返らないこと
 *
 * 足した行は finally で消す（語は試験ごとの一意の印を含み、ほかの試験の行に一致しない）。足した公開の行は、ほかの試験の `q=a` や
 * `q=Synthetic` に混ざらないよう、印に母音の a を含めず、説明は `zq`、作成日は 2000-01-01（/item の先頭に来ない）にする。
 * /api/search を呼ぶ道は、見出しの無い要求が集まる送り元 null の枠を使い切らないよう、このファイルだけの x-real-ip を付ける
 * （E2E の固定の環境 CLIENT_IP_HEADER=x-real-ip が信頼する見出し。x-forwarded-for は読まれない）。JWT が通信記録に残らないよう trace は切る。
 * 007 と 008 は今の移行では赤になる（search_* は limit_count を丸めず、search_public_* は PUBLIC に開いている）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, elevateAdminSessionToAal2 } from './admin-session-test-utils';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const MAX_ROWS = 8;
const API_FORWARDED_FOR = { 'x-real-ip': '198.18.20.20' };
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

// ---- 手元の環境と DB ----

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL) || !isLocalUrl(LOCAL_DB_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

async function withDb<T>(run: (db: Client) => Promise<T>): Promise<T> {
  requireLocalEnv();
  const db = new Client({ connectionString: LOCAL_DB_URL });
  try {
    await db.connect();
  } catch {
    await db.end().catch(() => undefined);
    throw new Error('手元の DB へ接続できない');
  }
  try {
    return await run(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ---- 呼び手（anon・一般会員・管理の読み取りの権限を持つ人の aal1） ----

// 作った利用者は afterAll で消す（消せなくても db reset で消える）
const createdUserIds: string[] = [];

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  memberTokenPromise = null;
  adminAal1Promise = null;
  if (createdUserIds.length === 0) return;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
  for (const userId of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

// ログインの回数の枠を使い切らないよう、ログインで作る呼び手は worker ごとに1回だけ作る
let memberTokenPromise: Promise<string> | null = null;
function memberToken(): Promise<string> {
  memberTokenPromise ??= (async () => {
    requireLocalEnv();
    const email = `e2e-search020-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
    const password = `E2e-${randomBytes(12).toString('hex')}!`;
    const created = await createClient(SUPABASE_URL, SERVICE_KEY, clientOptions).auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}）`);
    createdUserIds.push(created.data.user.id);
    const signedIn = await createClient(SUPABASE_URL, ANON_KEY, clientOptions).auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw new Error(`手元の会員でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
    return signedIn.data.session.access_token;
  })();
  return memberTokenPromise;
}

// 同じ利用者・同じ（アプリに結び付いた）session の aal1 と aal2 の JWT。M2 の has_permission は aal2 と生きた結び付きを求めるので、
// 非公開の行が見える対照は aal2、見えない側は aal1
type AdminTokens = { userId: string; aal1Token: string; aal2Token: string };
let adminAal1Promise: Promise<AdminTokens> | null = null;
function adminTokens(): Promise<AdminTokens> {
  adminAal1Promise ??= withDb(async (db) => {
    const aal1 = await createAdminSessionActor(db as unknown as PgClient, 'admin', 'aal1');
    createdUserIds.push(aal1.userId);
    const aal2 = await elevateAdminSessionToAal2(db as unknown as PgClient, aal1);
    return { userId: aal1.userId, aal1Token: aal1.accessToken, aal2Token: aal2.accessToken };
  });
  return adminAal1Promise;
}

// ---- PostgREST ----

type Reply = { status: number; code: string | null; rows: Array<Record<string, unknown>> };

function postgrestHeaders(bearer: string): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };
}

async function readReply(response: { status(): number; text(): Promise<string> }): Promise<Reply> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const code = body && !Array.isArray(body) && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null;
  return { status: response.status(), code, rows: Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [] };
}

async function callRpc(request: APIRequestContext, fn: string, args: Record<string, unknown>, bearer: string): Promise<Reply> {
  requireLocalEnv();
  const response = await request.post(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    headers: postgrestHeaders(bearer),
    data: args,
    failOnStatusCode: false,
  });
  return readReply(response);
}

async function selectRows(request: APIRequestContext, table: string, id: number, bearer: string): Promise<Reply> {
  requireLocalEnv();
  const response = await request.get(`${SUPABASE_URL}/rest/v1/${table}?select=id&id=eq.${id}`, {
    headers: postgrestHeaders(bearer),
    failOnStatusCode: false,
  });
  return readReply(response);
}

const idsOf = (reply: Reply): number[] => reply.rows.map((row) => Number(row.id));

// ---- 手元の DB に足す行（試験ごとの一意の印を語に含める） ----

type Fixture = {
  tag: string;
  items: { published: number[]; private: number[] };
  looks: { published: number[]; private: number[] };
  news: { published: number[]; private: number[] };
};

type FixtureSpec = { publishedItems: number; privateItems: number; publishedLooks: number; privateLooks: number; publishedNews: number; privateNews: number };

async function insertFixture(db: Client, tag: string, spec: FixtureSpec): Promise<Fixture> {
  const fixture: Fixture = { tag, items: { published: [], private: [] }, looks: { published: [], private: [] }, news: { published: [], private: [] } };
  const add = async (status: 'published' | 'private', count: number, sql: string, into: number[]): Promise<void> => {
    for (let n = 0; n < count; n += 1) {
      const result = await db.query<{ id: string }>(sql, [`${tag} ${status} ${n}`, status]);
      into.push(Number(result.rows[0].id));
    }
  };
  const itemSql = `insert into public.items (name, description, price, category, image_url, status, created_at)
                   values ($1, 'zq', 1000, 'TOPS', 'items/e2e/item-1-1.png', $2, '2000-01-01') returning id::text as id`;
  const lookSql = `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at)
                   values (2026, 'SS', $1, 'zq', ARRAY['looks/e2e/look-1-1.png'], $2, '2000-01-01') returning id::text as id`;
  const newsSql = `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
                   values ($1, 'EVENT', '2000-01-01', 'news/e2e/news-1.png', 'zq', 'zq', $2) returning id::text as id`;
  await add('published', spec.publishedItems, itemSql, fixture.items.published);
  await add('private', spec.privateItems, itemSql, fixture.items.private);
  await add('published', spec.publishedLooks, lookSql, fixture.looks.published);
  await add('private', spec.privateLooks, lookSql, fixture.looks.private);
  await add('published', spec.publishedNews, newsSql, fixture.news.published);
  await add('private', spec.privateNews, newsSql, fixture.news.private);
  return fixture;
}

async function deleteFixture(tag: string, fixture: Fixture | null): Promise<void> {
  await withDb(async (db) => {
    const like = `${tag}%`;
    await db.query('delete from public.items where name like $1 or id = any($2::bigint[])', [like, [...(fixture?.items.published ?? []), ...(fixture?.items.private ?? [])]]);
    await db.query('delete from public.looks where theme like $1 or id = any($2::bigint[])', [like, [...(fixture?.looks.published ?? []), ...(fixture?.looks.private ?? [])]]);
    await db.query('delete from public.news_articles where title like $1 or id = any($2::bigint[])', [like, [...(fixture?.news.published ?? []), ...(fixture?.news.private ?? [])]]);
  });
}

/** 行を足して場面を流し、finally で必ず消す */
async function withFixture<T>(label: string, spec: FixtureSpec, scenario: (fixture: Fixture, db: Client) => Promise<T>): Promise<T> {
  // 印に母音の a を含めない（16進の a〜f を数字に替える）
  const tag = `E2E-SRCH020-${label}-${randomUUID().slice(0, 8).replace(/[a-f]/g, (hex) => String('abcdef'.indexOf(hex)))}`;
  let fixture: Fixture | null = null;
  try {
    return await withDb(async (db) => {
      fixture = await insertFixture(db, tag, spec);
      return scenario(fixture, db);
    });
  } finally {
    await deleteFixture(tag, fixture);
  }
}

// ---- 断りの形 ----

/** 権限の誤り（401・403 と 42501）で、行が返らない */
function expectPermissionDenied(reply: Reply, label: string): void {
  expect([401, 403], `${label}: status`).toContain(reply.status);
  expect(reply.code, `${label}: 誤りの code（権限の誤り）`).toBe('42501');
  expect(reply.rows, `${label}: 返った行`).toEqual([]);
}

test.describe('FR-SEARCH-020 検索の DB の関数への直接の道', () => {
  test(`FREQ-186-AC-02 anon・authenticated に get_popular_items の EXECUTE が無く、直接呼ぶと断られ、/api/search の応答に purchase_count が無い`, async ({ request }) => {
    // anon / authenticated ロールに RPC の EXECUTE 権限が付与されていないこと（PUBLIC 経由の付与も含めて pg に聞く）
    await withDb(async (db) => {
      const held = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
        `select has_function_privilege('anon', 'public.get_popular_items(integer)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.get_popular_items(integer)', 'execute') as authenticated,
                has_function_privilege('service_role', 'public.get_popular_items(integer)', 'execute') as service_role`,
      );
      expect(held.rows[0].anon, 'anon の EXECUTE').toBe(false);
      expect(held.rows[0].authenticated, 'authenticated の EXECUTE').toBe(false);
      // 関数が無い・名前の違いで false になったのではないことの対照
      expect(held.rows[0].service_role, 'service_role の EXECUTE（対照）').toBe(true);
    });

    // 直接呼んでも断られる（PostgREST の道）
    expectPermissionDenied(await callRpc(request, 'get_popular_items', { limit_count: 4 }, ANON_KEY), 'anon の鍵');
    expectPermissionDenied(await callRpc(request, 'get_popular_items', { limit_count: 4 }, await memberToken()), '一般会員の JWT');

    // /api/search のレスポンスに購入数（purchase_count）が含まれない
    for (const query of ['', 'Aoi']) {
      const response = await request.get(`/api/search?q=${encodeURIComponent(query)}`, { headers: API_FORWARDED_FOR, failOnStatusCode: false });
      expect(response.status(), `/api/search?q=${query} の status`).toBe(200);
      const text = await response.text();
      const payload = JSON.parse(text) as { popularItems?: unknown[] };
      expect(Array.isArray(payload.popularItems) && payload.popularItems.length > 0, `/api/search?q=${query} の popularItems が空でない（対照）`).toBe(true);
      expect(text, `/api/search?q=${query} の本文`).not.toContain('purchase_count');
      expect(text, `/api/search?q=${query} の本文`).not.toContain('purchaseCount');
    }
  });

  test(`SEC-SEARCH-002-AC-01 非公開の商品・ルック・お知らせは、anon・一般会員・管理の読み取りの権限を持つ人の aal1・aal2 の JWT のどれで search_items/looks/news を呼んでも返らない`, async ({ request }) => {
    const admin = await adminTokens();
    const callers = [
      { name: 'anon の鍵', bearer: ANON_KEY },
      { name: '一般会員の JWT', bearer: await memberToken() },
      { name: '管理者(admin.items.read・admin.looks.read・admin.news.read)の aal1 の JWT', bearer: admin.aal1Token },
      { name: '管理者(同上)の aal2 の JWT', bearer: admin.aal2Token },
    ];

    await withFixture('002', { publishedItems: 1, privateItems: 1, publishedLooks: 1, privateLooks: 1, publishedNews: 1, privateNews: 1 }, async (fixture, db) => {
      const held = await db.query<{ n: number }>(
        `select count(distinct p.code)::int as n
           from public.user_roles ur
           join public.role_permissions rp on rp.role_id = ur.role_id
           join public.permissions p on p.id = rp.permission_id
          where ur.user_id = $1::uuid and ur.active = true and (ur.expires_at is null or ur.expires_at > now())
            and p.code = any($2::text[])`,
        [admin.userId, ['admin.items.read', 'admin.looks.read', 'admin.news.read']],
      );
      expect(held.rows[0].n, '管理者が持つ閲覧の権限の数').toBe(3);

      // 対照: 結び付いた aal2 の管理者は、表を直接読むと非公開の行が見える（has_permission が通る。関数の絞りだけが守っていることの確かめ）。
      // aal1 の JWT は M2 の has_permission が断るので、同じ行が見えない
      for (const [table, id] of [['items', fixture.items.private[0]], ['looks', fixture.looks.private[0]], ['news_articles', fixture.news.private[0]]] as const) {
        const control = await selectRows(request, table, id, admin.aal2Token);
        expect(control.status, `対照: 管理者の aal2 の JWT で ${table} を読む status`).toBe(200);
        expect(idsOf(control), `対照: 管理者の aal2 の JWT で見える ${table} の非公開の行`).toEqual([id]);
        const aal1 = await selectRows(request, table, id, admin.aal1Token);
        expect(idsOf(aal1), `管理者の aal1 の JWT で見える ${table} の非公開の行（無い）`).toEqual([]);
      }

      for (const caller of callers) {
        // 足した公開の行が返り（対照）、同じ語の非公開の行は返らない
        const items = await callRpc(request, 'search_items', { search_query: fixture.tag, limit_count: MAX_ROWS }, caller.bearer);
        expect(items.status, `${caller.name}: search_items の status`).toBe(200);
        expect(idsOf(items), `${caller.name}: search_items の結果`).toEqual(fixture.items.published);

        const looks = await callRpc(request, 'search_looks', { search_query: fixture.tag, limit_count: MAX_ROWS }, caller.bearer);
        expect(looks.status, `${caller.name}: search_looks の status`).toBe(200);
        expect(idsOf(looks), `${caller.name}: search_looks の結果`).toEqual(fixture.looks.published);

        const news = await callRpc(request, 'search_news', { search_query: fixture.tag, limit_count: MAX_ROWS }, caller.bearer);
        expect(news.status, `${caller.name}: search_news の status`).toBe(200);
        expect(idsOf(news), `${caller.name}: search_news の結果`).toEqual(fixture.news.published);

        // 見本の非公開の商品 8（Yoru Private Tee）・10（Kohaku Private Dress）も返らない
        const seeded = await callRpc(request, 'search_items', { search_query: 'Private', limit_count: MAX_ROWS }, caller.bearer);
        expect(seeded.status, `${caller.name}: search_items('Private') の status`).toBe(200);
        expect(idsOf(seeded), `${caller.name}: search_items('Private') に見本の非公開の商品`).not.toContain(8);
        expect(idsOf(seeded), `${caller.name}: search_items('Private') に見本の非公開の商品`).not.toContain(10);
      }
    });
  });

  test(`SEC-SEARCH-007-AC-01 search_items/looks を limit_count=100000・null で呼んでも上限以下の行で、-1 でも誤りにならず上限以下の行を返す`, async ({ request }) => {
    requireLocalEnv();
    await withFixture('007', { publishedItems: MAX_ROWS + 2, privateItems: 0, publishedLooks: MAX_ROWS + 2, privateLooks: 0, publishedNews: 0, privateNews: 0 }, async (fixture) => {
      // 語に一致する公開の行が上限より多い（上限が効いていることの確かめになる）
      expect(fixture.items.published.length, '足した公開の商品の数').toBeGreaterThan(MAX_ROWS);
      expect(fixture.looks.published.length, '足した公開のルックの数').toBeGreaterThan(MAX_ROWS);

      for (const fn of ['search_items', 'search_looks']) {
        // 語に一致する場合と、空の語（全部の公開の行に一致する）の場合
        for (const term of [fixture.tag, '']) {
          for (const limit of [100000, null, -1]) {
            const label = `${fn}(search_query=${term === '' ? '空' : '印'}, limit_count=${limit})`;
            const reply = await callRpc(request, fn, { search_query: term, limit_count: limit }, ANON_KEY);
            expect.soft(reply.status, `${label}: status（誤りにならない）`).toBe(200);
            expect.soft(reply.rows.length, `${label}: 返った行の数（上限 ${MAX_ROWS} 以下）`).toBeLessThanOrEqual(MAX_ROWS);
            expect.soft(reply.rows.length, `${label}: 返った行の数（上限以下の行を返す）`).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  test(`SEC-SEARCH-008-AC-01 anon の鍵で search_public_items/looks/news を呼ぶと、権限か「関数が無い」の誤りが返り、行が返らない`, async ({ request }) => {
    for (const fn of ['search_public_items', 'search_public_looks', 'search_public_news']) {
      // 語 'e' は見本の公開の行に一致する（開いていれば行が返る語）
      const reply = await callRpc(request, fn, { p_query: 'e', p_limit: 6 }, ANON_KEY);
      expect([401, 403, 404], `${fn}: status（権限の誤りか関数が無い誤り）`).toContain(reply.status);
      expect(['42501', 'PGRST202'], `${fn}: 誤りの code（権限の誤りか関数が無い誤り）`).toContain(reply.code);
      expect(reply.rows, `${fn}: 返った行`).toEqual([]);
    }
  });

  test(`SEC-SEARCH-009-AC-01 get_popular_items を anon の鍵と一般会員の JWT で呼ぶと、どちらも権限の誤りが返り、行が返らない`, async ({ request }) => {
    expectPermissionDenied(await callRpc(request, 'get_popular_items', { limit_count: 4 }, ANON_KEY), 'anon の鍵');
    expectPermissionDenied(await callRpc(request, 'get_popular_items', { limit_count: 4 }, await memberToken()), '一般会員の JWT');
  });
});
