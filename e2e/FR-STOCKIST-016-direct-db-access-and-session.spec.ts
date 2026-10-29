/**
 * FR-STOCKIST-016 管理の権限の道が、公開の画面と DB の直接の道で閉じていることを確かめる
 * 対応: SEC-STOCKIST-002-AC-01 / SEC-STOCKIST-003-AC-01 / SEC-STOCKIST-003-AC-02 / SEC-STOCKIST-003-AC-03
 *
 * 手元の Supabase（NEXT_PUBLIC_SUPABASE_URL が localhost）と手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）だけで流す。
 * - SEC-STOCKIST-002-AC-01: 管理者の session の Cookie（sb-<ref>-auth-token）を持たせて公開の画面を開き、
 *   非公開の店の名前が出ないこと・ログインしていない時と店の数が同じことを確かめる
 * - SEC-STOCKIST-003-AC-01/02: aal1 の JWT で PostgREST の /rest/v1/stockists を直接叩き、DB が変わらないことを pg で確かめる
 * - SEC-STOCKIST-003-AC-02/03: 書き込みは窓口の service role だけで、利用者の JWT の insert・update・delete は表の権限の段で断られる（sec_grants_admin_tables）
 * - SEC-STOCKIST-003-AC-03: aal2 の session を auth.sessions から消した後、残った access token で update を送る（失効の前も後も変わらない）
 * 足した行は finally で消す。JWT・パスワードが通信記録に残らないよう trace は切る。
 * - ファイルの中は serial にしない（赤が出た時に、最初の失敗で残りが流れず赤の中身が隠れるのを避ける）。003-AC-01 は波 5 の移行 M2（has_permission に aal2 と結び付いた生きた session を求める）を当てた DB で通る。
 * - 003-AC-01〜03 は画面を描かない HTTP だけの試験なので、幅ごとには繰り返さず各 AC に1本（FR-STOCKIST-014・015 と同じ扱い）。
 * - 002-AC-01 は他の試験が足した公開の行に左右されないよう、E2E-STK- で始まらない店（見本）の名前の並びで比べる。
 *   非公開の行はホームの「最初の 6 件」に入る小さい id で足し、公開の絞りが壊れた時にホームにも出るようにする。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';
import {
  randomLowId,
  requireLocalSupabaseEnv,
  SEED_STOCKISTS,
  STOCKIST_VIEWPORTS as VIEWPORTS,
  stockistTag as tag,
  withStockists,
} from './stockist-test-utils';

test.use({ trace: 'off' });

// 手元の Supabase の値は使う時に読む（一覧を作る時に env が無くても読み込みで落ちないように）
const env = requireLocalSupabaseEnv;


// @supabase/ssr が Cookie を分ける時の 1 つの大きさ
const COOKIE_CHUNK_SIZE = 3180;
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

type StockistRow = { id: string; name: string; status: string };

async function readRows(where: 'ids' | 'names', values: Array<number | string>): Promise<StockistRow[]> {
  return withLocalDb(async (db) => {
    const column = where === 'ids' ? 'id = any($1::bigint[])' : 'name = any($1::text[])';
    const result = await db.query(
      `select id::text, name, status from public.stockists where ${column} order by id`,
      [values],
    );
    return result.rows as StockistRow[];
  });
}

// 作った利用者は afterAll で消す（消せなくても db reset で消える）
const createdUserIds: string[] = [];

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  aal1Promise = null;
  cookieSessionPromise = null;
  if (createdUserIds.length === 0) return;
  const admin = createClient(env().url, env().serviceKey, clientOptions);
  for (const userId of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

async function newActor(role: 'admin', aal: 'aal1' | 'aal2'): Promise<AdminSessionActor> {
  return withLocalDb(async (db) => {
    const actor = await createAdminSessionActor(db, role, aal);
    createdUserIds.push(actor.userId);
    return actor;
  });
}

// aal1 の管理者（店長）は worker ごとに 1 回だけ作る（ログインの回数の制限を使い切らない）
let aal1Promise: Promise<AdminSessionActor> | null = null;
function aal1Admin(): Promise<AdminSessionActor> {
  aal1Promise ??= newActor('admin', 'aal1');
  return aal1Promise;
}

function postgrestHeaders(token: string): Record<string, string> {
  return { apikey: env().anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}

function stockistsUrl(query: string): string {
  return `${env().url}/rest/v1/stockists${query}`;
}

async function jsonRows(response: APIResponse): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * 「表の権限が無い」ことで断られたこと（403・SQLSTATE 42501・文が permission denied for table <表>）。
 * RLS の違反（new row violates row-level security policy）や 0 件の成功は通さない。JWT は有効なので 401 も通さない
 */
async function expectPermissionDenied(response: APIResponse, table: string, label: string): Promise<void> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  expect(response.status(), `${label}: 権限の誤りの状態`).toBe(403);
  expect(body.code, `${label}: SQLSTATE`).toBe('42501');
  expect(String(body.message), `${label}: 権限の誤りの文（RLS の誤りでも 0 件の成功でもない）`).toBe(`permission denied for table ${table}`);
}

/** Google OAuth のログインが付ける @supabase/ssr の認証 Cookie と同じ形（base64- + base64url の session、長ければ .N に分ける） */
function authCookies(baseURL: string, session: Record<string, unknown>): Array<{ name: string; value: string; url: string; sameSite: 'Lax' }> {
  const ref = new URL(env().url).hostname.split('.')[0];
  const name = `sb-${ref}-auth-token`;
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  if (encoded.length <= COOKIE_CHUNK_SIZE) return [{ name, value: encoded, url: baseURL, sameSite: 'Lax' }];
  const cookies: Array<{ name: string; value: string; url: string; sameSite: 'Lax' }> = [];
  for (let i = 0; i * COOKIE_CHUNK_SIZE < encoded.length; i += 1) {
    cookies.push({ name: `${name}.${i}`, value: encoded.slice(i * COOKIE_CHUNK_SIZE, (i + 1) * COOKIE_CHUNK_SIZE), url: baseURL, sameSite: 'Lax' });
  }
  return cookies;
}

// Cookie 用の管理者の session（メールとパスワードのログインで得た、supabase-js の session の形）も worker ごとに 1 回だけ作る
let cookieSessionPromise: Promise<Record<string, unknown>> | null = null;
function adminCookieSession(): Promise<Record<string, unknown>> {
  cookieSessionPromise ??= (async () => {
    const email = `e2e-stockist016-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
    const password = `E2e-${randomBytes(12).toString('hex')}!`;
    const admin = createClient(env().url, env().serviceKey, clientOptions);
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'admin' } });
    if (created.error || !created.data.user) {
      throw new Error(`手元の管理者を作れない（status: ${created.error?.status ?? '不明'}）`);
    }
    const userId = created.data.user.id;
    createdUserIds.push(userId);
    await withLocalDb(async (db) => {
      const assigned = await db.query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1::uuid, r.id, true, null from public.roles r where r.code = 'admin'`,
        [userId],
      );
      if (assigned.rowCount !== 1) throw new Error('役割 admin の行が手元の DB に無い');
    });
    const signedIn = await createClient(env().url, env().anonKey, clientOptions).auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) {
      throw new Error(`手元の管理者でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
    }
    return signedIn.data.session as unknown as Record<string, unknown>;
  })();
  return cookieSessionPromise;
}

async function useViewport(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
}

/**
 * /stockist とホームの取扱店の節の、店の名前の並びと本文を読む。
 * 他の試験が足した試験用の店（E2E-STK- で始まる）は並びから外す（同時に流れる試験の行で、比べが揺れないように）。
 */
async function readPublicScreens(page: Page): Promise<{ stockistNames: string[]; homeNames: string[]; html: string }> {
  const shopNames = async (headings: Locator): Promise<string[]> =>
    (await headings.allInnerTexts()).filter((name) => !name.startsWith('E2E-STK-'));

  await page.goto('/stockist');
  await expect(page.locator('article').first()).toBeVisible();
  const stockistNames = await shopNames(page.locator('article h3'));
  let html = await page.content();

  await page.goto('/');
  const homeArticles = page.locator('section#stockist article');
  await expect(homeArticles.first()).toBeAttached();
  const homeNames = await shopNames(page.locator('section#stockist article h3'));
  html += await page.content();
  return { stockistNames, homeNames, html };
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-STOCKIST-016 管理者の session を持ったまま公開の画面を開く (${vp.name})`, () => {
    test(`SEC-STOCKIST-002-AC-01 ${vp.name}: admin.stockists.read を持つ利用者が sb-<ref>-auth-token の Cookie を持ってログインした状態で、/stockist とホームの取扱店の節に非公開の店の名前が表示されず、店の数がログインしていない時と同じ`, async ({ page, baseURL }) => {
      expect(baseURL).toBeTruthy();
      await useViewport(page, vp);
      const privateName = tag();
      const session = await adminCookieSession();

      await withStockists([{ name: privateName, status: 'private', id: randomLowId() }], async () => {
        // ログインしていない時（Cookie なし）の店の数
        await page.context().clearCookies();
        const loggedOut = await readPublicScreens(page);
        expect(loggedOut.html).not.toContain(privateName);

        // 管理者の session の Cookie を持たせて同じ 2 つの画面を開く
        await page.context().addCookies(authCookies(baseURL as string, session));
        const cookieNames = (await page.context().cookies()).map((cookie) => cookie.name);
        expect(cookieNames.some((name) => /^sb-.+-auth-token(\.\d+)?$/.test(name)), 'sb-<ref>-auth-token の Cookie を持たせた').toBe(true);

        const loggedIn = await readPublicScreens(page);
        expect(loggedIn.html, 'ログインした状態の /stockist とホームの本文にその店の名前が出ない').not.toContain(privateName);
        await page.goto('/stockist');
        await expect(page.getByText(privateName)).toHaveCount(0);
        await expect(page.locator('article', { hasText: privateName })).toHaveCount(0);
        await page.goto('/');
        await expect(page.locator('section#stockist').getByText(privateName)).toHaveCount(0);

        expect(loggedOut.stockistNames.length, '見本の公開の店が /stockist に出ている').toBeGreaterThan(0);
        expect(loggedIn.stockistNames, '/stockist の店がログインしていない時と同じ').toEqual(loggedOut.stockistNames);
        expect(loggedIn.homeNames, 'ホームの取扱店の節の店がログインしていない時と同じ').toEqual(loggedOut.homeNames);
      });
    });
  });
}

test.describe('FR-STOCKIST-016 aal1 の JWT で PostgREST を直接叩く', () => {
  test('SEC-STOCKIST-003-AC-01 admin.stockists.read を持つ利用者の aal1 の JWT で select した時、非公開の店が結果に含まれない', async ({ request }) => {
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    const privateName = tag();

    await withStockists(
      [{ name: privateName, status: 'private', id: randomLowId() }],
      async ([privateId]) => {
        // 見本の公開の店は読め（JWT が通っている）、足した非公開の店は含まれない
        const byId = await request.get(stockistsUrl(`?select=id,name,status&or=(id.eq.${privateId},name.eq.${encodeURIComponent(SEED_STOCKISTS[0].name)})`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        expect(byId.status(), 'aal1 の JWT の select の状態').toBe(200);
        const byIdRows = (await byId.json()) as Array<{ id: number; name: string; status: string }>;
        expect(byIdRows.map((row) => row.name), '公開の店は読める').toContain(SEED_STOCKISTS[0].name);
        expect(byIdRows.map((row) => row.id), '非公開の店の id が含まれない').not.toContain(privateId);
        expect(byIdRows.map((row) => row.name), '非公開の店の名前が含まれない').not.toContain(privateName);

        // 絞らない select（非公開の店を指して取る）でも、非公開の店は 1 件も含まれない
        const privateOnly = await request.get(stockistsUrl('?select=id,name,status&status=eq.private'), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        const privateRows = privateOnly.status() === 200 ? ((await privateOnly.json()) as Array<{ id: number }>) : [];
        expect(privateRows.map((row) => row.id), '非公開の店を指した select の結果').not.toContain(privateId);
        expect(privateRows, '非公開の店を指した select の結果が空').toHaveLength(0);

        const all = await request.get(stockistsUrl('?select=id,name,status'), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        const allRows = all.status() === 200 ? ((await all.json()) as Array<{ status: string }>) : [];
        expect(allRows.filter((row) => row.status !== 'published'), '全件の select に非公開の店が含まれない').toHaveLength(0);
      },
    );
  });

  test('SEC-STOCKIST-003-AC-02 admin.stockists.manage を持つ利用者の aal1 の JWT の insert・update・delete が、どれも行を変えずに終わる', async ({ request }) => {
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    const insertName = tag();
    const updateName = tag();
    const updatedName = tag();
    const deleteName = tag();

    await withStockists(
      [
        { name: updateName, status: 'published' },
        { name: deleteName, status: 'published' },
      ],
      async ([updateId, deleteId]) => {
        // JWT 自体は通っている（公開の店を読める）うえで、書く道が閉じていることを確かめる
        const readable = await request.get(stockistsUrl(`?select=id&id=eq.${updateId}`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        expect(readable.status(), 'aal1 の JWT で公開の店は読める').toBe(200);
        expect((await jsonRows(readable)).length, 'aal1 の JWT で公開の店は読める（件数）').toBe(1);

        const inserted = await request.post(stockistsUrl(''), {
          headers: postgrestHeaders(actor.accessToken),
          data: { type: 'STORE', name: insertName, address: '東京都港区0-0-1', phone: '000-0000-0000', time: '11:00-18:00', holiday: 'Synthetic schedule', status: 'published' },
          failOnStatusCode: false,
        });
        await expectPermissionDenied(inserted, 'stockists', 'stockists の insert');

        const updated = await request.patch(stockistsUrl(`?id=eq.${updateId}`), {
          headers: postgrestHeaders(actor.accessToken),
          data: { name: updatedName },
          failOnStatusCode: false,
        });
        await expectPermissionDenied(updated, 'stockists', 'stockists の update');

        const deleted = await request.delete(stockistsUrl(`?id=eq.${deleteId}`), {
          headers: postgrestHeaders(actor.accessToken),
          failOnStatusCode: false,
        });
        await expectPermissionDenied(deleted, 'stockists', 'stockists の delete');

        // DB の行が変わっていない
        expect(await readRows('names', [insertName]), 'insert した行が DB に無い').toHaveLength(0);
        const updateRows = await readRows('ids', [updateId]);
        expect(updateRows.map((row) => row.name), 'update した行の名前が変わっていない').toEqual([updateName]);
        expect(await readRows('names', [updatedName]), 'update 後の名前の行が DB に無い').toHaveLength(0);
        const deleteRows = await readRows('ids', [deleteId]);
        expect(deleteRows.map((row) => row.name), 'delete した行が DB に残っている').toEqual([deleteName]);
      },
      [insertName, updatedName],
    );
  });
});

test.describe('FR-STOCKIST-016 失効させた session の token で PostgREST を直接叩く', () => {
  test('SEC-STOCKIST-003-AC-03 aal2 の利用者の session を失効させた後、その access token の update が行を変えずに終わる', async ({ request }) => {
    const actor = await newActor('admin', 'aal2');
    expect(actor.aal).toBe('aal2');
    const originalName = tag();
    const beforeRevokeName = tag();
    const afterRevokeName = tag();

    await withStockists([{ name: originalName, status: 'published' }], async ([id]) => {
      // token は PostgREST に受け入れられている（失効の前は同じ token で公開の店を読める）
      const readable = await request.get(stockistsUrl(`?select=id&id=eq.${id}`), {
        headers: postgrestHeaders(actor.accessToken),
        failOnStatusCode: false,
      });
      expect(readable.status(), '失効させる前の token で公開の店は読める').toBe(200);
      expect((await jsonRows(readable)).length, '失効させる前の token で公開の店は読める（件数）').toBe(1);

      // 失効させる前でも、利用者の JWT では update が通らない（書き込みは窓口の service role だけ。権限を外してある）
      const before = await request.patch(stockistsUrl(`?id=eq.${id}`), {
        headers: postgrestHeaders(actor.accessToken),
        data: { name: beforeRevokeName },
        failOnStatusCode: false,
      });
      await expectPermissionDenied(before, 'stockists', '失効させる前の update');
      expect((await readRows('ids', [id])).map((row) => row.name), '失効させる前の update で名前が変わっていない').toEqual([originalName]);

      // session を失効させる（auth.sessions の行を消す）
      const revoked = await withLocalDb((db) => db.query('delete from auth.sessions where id = $1::uuid', [actor.sessionId]));
      expect(revoked.rowCount, 'session の行を 1 件消した').toBe(1);

      // 失効させた session の access token で update を送る
      const after = await request.patch(stockistsUrl(`?id=eq.${id}`), {
        headers: postgrestHeaders(actor.accessToken),
        data: { name: afterRevokeName },
        failOnStatusCode: false,
      });
      await expectPermissionDenied(after, 'stockists', '失効後の update');

      expect((await readRows('ids', [id])).map((row) => row.name), '失効後の update で名前が変わっていない').toEqual([originalName]);
      expect(await readRows('names', [beforeRevokeName]), '失効前に送った名前の行が DB に無い').toHaveLength(0);
      expect(await readRows('names', [afterRevokeName]), '失効後の名前の行が DB に無い').toHaveLength(0);
    }, [beforeRevokeName, afterRevokeName]);
  });
});
