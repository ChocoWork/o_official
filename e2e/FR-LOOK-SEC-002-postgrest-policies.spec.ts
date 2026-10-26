/**
 * FR-LOOK-SEC-002 LOOK（looks・look_items）の PostgREST・Storage・RPC の直接の道が閉じていることを確かめる
 * 対応: SEC-LOOK-002-AC-01 / SEC-LOOK-002-AC-02 / SEC-LOOK-003-AC-01 / SEC-LOOK-003-AC-02
 *       / SEC-LOOK-004-AC-01 / SEC-LOOK-004-AC-02 / SEC-LOOK-005-AC-01 / SEC-LOOK-005-AC-02 / SEC-LOOK-010-AC-02 / SEC-LOOK-023-AC-01
 *
 * 画面は開かない。手元の Supabase（NEXT_PUBLIC_SUPABASE_URL が localhost）の /rest/v1・/storage/v1 を、
 * anon の鍵・一般会員の JWT・店長（役割 admin。admin.looks.read・admin.looks.manage を持つ）の aal1 の JWT・
 * service role の鍵で直接叩き、手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）で行が変わっていないことを確かめる。
 * 通信は Playwright の request fixture だけで、ブラウザの画面は使わない。画面の幅は結果に関係しないので、
 * 3つの幅の繰り返しはせず、各試験を1回だけ流す（足す行の見える時間を短くし、他の spec の並びに入る窓を3分の1にする）。
 * - SEC-LOOK-004-AC-01/02: 手元の DB の権限（has_table_privilege）が false で、anon の書き込みが権限の誤り（permission denied）で断られる
 * - SEC-LOOK-005-AC-01: 置き場 look-images が非公開で、大きさ（5MB）と種類（4つ）の上限を移行が持つ（見本の SQL は上限を入れない）
 * - SEC-LOOK-002-AC-01/02: 公開の LOOK に非公開の商品を紐づけても、anon と一般会員の look_items の select にその item_id が出ない
 * - SEC-LOOK-003-AC-01/02: aal1 の JWT の select に非公開の LOOK が出ず、looks・look_items の insert・update・delete が行を変えない
 * - SEC-LOOK-005-AC-02: 公開の URL（/storage/v1/object/public/look-images/...）では LOOK の画像が返らない
 * - SEC-LOOK-010-AC-02: anon が search_public_looks を呼べない
 * - SEC-LOOK-023-AC-01: 201字のテーマと置き場の外の image_urls の insert が CHECK の違反（23514）で断られ、行が増えない
 * 足した行・利用者は試験ごとの finally と afterAll で消す。JWT・パスワードが通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { createTestMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
// 表の CHECK（置き場の中の looks/ の下）が入った後も通る、足す行の画像の道
const VALID_IMAGE = 'looks/e2e-look-sec-002.png';
// 見本の画像（scripts/e2e/seed-storage.ts が look-images に置く）
const SEEDED_LOOK_IMAGE = 'looks/e2e/look-1-1.png';
const ITEM_IMAGE = 'items/e2e/item-3-1.png';

type JsonRow = Record<string, unknown>;
type Fixture = {
  tag: string;
  publishedLookId: number;
  privateLookId: number;
  deleteLookId: number;
  privateItemId: number;
  publishedItemId: number;
  spareItemId: number;
};

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function tag(label: string): string {
  return `E2E-LOOK-${label}-${randomUUID()}`;
}

function lookUrl(table: 'looks' | 'look_items', query: string): string {
  return `${SUPABASE_URL}/rest/v1/${table}${query}`;
}

function postgrestHeaders(bearer: string, apikey: string = ANON_KEY): Record<string, string> {
  return { apikey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}

function lookBody(theme: string, status: 'private' | 'published', imageUrl: string = VALID_IMAGE): JsonRow {
  return { season_year: 2027, season_type: 'AW', theme, theme_description: 'Synthetic description', image_urls: [imageUrl], status };
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

/**
 * 公開の LOOK・非公開の LOOK・消去用の（非公開の）LOOK と、非公開・公開・予備の（非公開の）商品を足し、
 * 公開の LOOK に非公開の商品と公開の商品を紐づける。場面が終わったら（落ちても）tag で始まる行を全部消す。
 */
async function withFixture<T>(label: string, scenario: (fixture: Fixture) => Promise<T>): Promise<T> {
  requireLocalEnv();
  const id = tag(label);
  try {
    const fixture = await withLocalDb(async (db) => {
      // 公開で足す行は created_at を 2000-01-01 にして並びの最後へ送る。ほかの spec が「先頭の LOOK・商品」を選ぶ並びに入れない。
      // 公開でなくてよい行は非公開にする。画像は見本の画像を指す（画像の無い LOOK が一覧の先頭に出ないように）
      const look = async (theme: string, status: 'private' | 'published'): Promise<number> => {
        const result = await db.query(
          `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
           values (2027, 'AW', $1, 'Synthetic description', ARRAY[$3]::text[], $2, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z') returning id`,
          [theme, status, SEEDED_LOOK_IMAGE],
        );
        return Number(result.rows[0].id);
      };
      const item = async (name: string, status: 'private' | 'published'): Promise<number> => {
        const result = await db.query(
          `insert into public.items (name, description, price, category, image_url, status, created_at, updated_at)
           values ($1, 'E2E look sec', 12000, 'TOPS', $2, $3, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z') returning id`,
          [name, ITEM_IMAGE, status],
        );
        return Number(result.rows[0].id);
      };
      const publishedLookId = await look(`${id}-published`, 'published');
      const privateLookId = await look(`${id}-private`, 'private');
      const deleteLookId = await look(`${id}-delete`, 'private');
      const privateItemId = await item(`${id}-private-item`, 'private');
      const publishedItemId = await item(`${id}-published-item`, 'published');
      const spareItemId = await item(`${id}-spare-item`, 'private');
      await db.query(
        `insert into public.look_items (look_id, item_id) values ($1, $2), ($1, $3)`,
        [publishedLookId, privateItemId, publishedItemId],
      );
      return { tag: id, publishedLookId, privateLookId, deleteLookId, privateItemId, publishedItemId, spareItemId };
    });
    return await scenario(fixture);
  } finally {
    await withLocalDb(async (db) => {
      // look_items は looks・items の削除で連鎖して消える。場面の中で足された LOOK も、テーマが tag で始まるので拾う
      await db.query('delete from public.looks where theme like $1', [`${id}%`]);
      await db.query('delete from public.items where name like $1', [`${id}%`]);
    });
  }
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

// aal1 の店長は worker ごとに 1 回だけ作る（Auth のログインの回数の制限を使い切らない）
let aal1Promise: Promise<AdminSessionActor> | null = null;
function aal1Admin(): Promise<AdminSessionActor> {
  aal1Promise ??= (async () => {
    requireLocalEnv();
    const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal1'));
    createdUserIds.push(actor.userId);
    return actor;
  })();
  return aal1Promise;
}

// 一般会員（役割なし）の JWT も worker ごとに 1 回だけ作る。createTestMember のパスワードは返らないので、service role で決め直す
let memberPromise: Promise<string> | null = null;
function memberAccessToken(): Promise<string> {
  memberPromise ??= (async () => {
    requireLocalEnv();
    const member = await createTestMember('look-sec-002');
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

async function readLooks(where: 'ids' | 'themes', values: Array<number | string>): Promise<Array<{ id: number; theme: string }>> {
  return withLocalDb(async (db) => {
    const column = where === 'ids' ? 'id = any($1::bigint[])' : 'theme = any($1::text[])';
    const result = await db.query(`select id::text as id, theme from public.looks where ${column} order by public.looks.id`, [values]);
    return result.rows.map((row) => ({ id: Number(row.id), theme: row.theme as string }));
  });
}

async function readLookItems(lookId: number): Promise<Array<{ item_id: number; created_at: string }>> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      'select item_id::text as item_id, created_at::text as created_at from public.look_items where look_id = $1 order by public.look_items.item_id',
      [lookId],
    );
    return result.rows.map((row) => ({ item_id: Number(row.item_id), created_at: row.created_at as string }));
  });
}

test.describe('FR-LOOK-SEC-002 anon と一般会員の look_items の直接の読み出し', () => {
  test('SEC-LOOK-002-AC-01 公開の LOOK に非公開の商品を1件紐づけた状態で、anon の select の結果にその商品の item_id が含まれない', async ({ request }) => {
    await withFixture('SEC002A', async (fx) => {
      const headers = postgrestHeaders(ANON_KEY);
      // 公開の LOOK の紐づきを LOOK の id で指す select。公開の商品の紐づきは読め（鍵が通っている）、非公開の商品は含まれない
      const byLook = await request.get(lookUrl('look_items', `?select=look_id,item_id&look_id=eq.${fx.publishedLookId}`), { headers, failOnStatusCode: false });
      expect(byLook.status(), 'anon の select の状態').toBe(200);
      const byLookIds = (await jsonRows(byLook)).map((row) => Number(row.item_id));
      expect(byLookIds, '公開の商品の紐づきは読める').toContain(fx.publishedItemId);
      expect(byLookIds, '非公開の商品の item_id が含まれない').not.toContain(fx.privateItemId);

      // 非公開の商品の id を直に指す select でも、絞らない select でも、その item_id は含まれない
      const byItem = await request.get(lookUrl('look_items', `?select=look_id,item_id&item_id=eq.${fx.privateItemId}`), { headers, failOnStatusCode: false });
      expect(byItem.status(), 'anon の item_id 指定の select の状態').toBe(200);
      expect(await jsonRows(byItem), 'anon の item_id 指定の select の結果が空').toHaveLength(0);

      const all = await request.get(lookUrl('look_items', '?select=look_id,item_id'), { headers, failOnStatusCode: false });
      expect(all.status(), 'anon の全件の select の状態').toBe(200);
      expect((await jsonRows(all)).map((row) => Number(row.item_id)), '全件の select に非公開の商品の item_id が含まれない').not.toContain(fx.privateItemId);
    });
  });

  test('SEC-LOOK-002-AC-02 権限の無い一般会員の JWT の look_items の select の結果にも、非公開の商品の item_id が含まれない', async ({ request }) => {
    const member = await memberAccessToken();
    await withFixture('SEC002B', async (fx) => {
      const headers = postgrestHeaders(member);
      const byLook = await request.get(lookUrl('look_items', `?select=look_id,item_id&look_id=eq.${fx.publishedLookId}`), { headers, failOnStatusCode: false });
      expect(byLook.status(), '一般会員の select の状態').toBe(200);
      const byLookIds = (await jsonRows(byLook)).map((row) => Number(row.item_id));
      expect(byLookIds, '公開の商品の紐づきは読める').toContain(fx.publishedItemId);
      expect(byLookIds, '非公開の商品の item_id が含まれない').not.toContain(fx.privateItemId);

      const byItem = await request.get(lookUrl('look_items', `?select=look_id,item_id&item_id=eq.${fx.privateItemId}`), { headers, failOnStatusCode: false });
      expect(byItem.status(), '一般会員の item_id 指定の select の状態').toBe(200);
      expect(await jsonRows(byItem), '一般会員の item_id 指定の select の結果が空').toHaveLength(0);

      const all = await request.get(lookUrl('look_items', '?select=look_id,item_id'), { headers, failOnStatusCode: false });
      expect(all.status(), '一般会員の全件の select の状態').toBe(200);
      expect((await jsonRows(all)).map((row) => Number(row.item_id)), '全件の select に非公開の商品の item_id が含まれない').not.toContain(fx.privateItemId);
    });
  });
});

test.describe('FR-LOOK-SEC-002 aal1 の JWT で PostgREST を直接叩く', () => {
  test('SEC-LOOK-003-AC-01 admin.looks.read を持つ利用者の aal1 の JWT で looks を select した時、非公開の LOOK が結果に含まれない', async ({ request }) => {
    test.fail(true, 'SEC-LOOK-003-AC-01 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    await withFixture('SEC003A', async (fx) => {
      const headers = postgrestHeaders(actor.accessToken);
      // 足した 2 件を id で指す select。公開の LOOK は読め（JWT が通っている）、非公開の LOOK は含まれない
      const byId = await request.get(lookUrl('looks', `?select=id,theme,status&id=in.(${fx.publishedLookId},${fx.privateLookId})`), { headers, failOnStatusCode: false });
      expect(byId.status(), 'aal1 の JWT の select の状態').toBe(200);
      const byIdRows = await jsonRows(byId);
      expect(byIdRows.map((row) => Number(row.id)), '公開の LOOK は読める').toContain(fx.publishedLookId);
      expect(byIdRows.map((row) => Number(row.id)), '非公開の LOOK の id が含まれない').not.toContain(fx.privateLookId);
      expect(byIdRows.map((row) => row.theme), '非公開の LOOK のテーマが含まれない').not.toContain(`${fx.tag}-private`);

      // 非公開を指した select と絞らない select でも、非公開の LOOK は 1 件も含まれない
      const privateOnly = await request.get(lookUrl('looks', '?select=id,theme,status&status=eq.private'), { headers, failOnStatusCode: false });
      const privateRows = privateOnly.status() === 200 ? await jsonRows(privateOnly) : [];
      expect(privateRows.map((row) => Number(row.id)), '非公開を指した select の結果').not.toContain(fx.privateLookId);
      expect(privateRows, '非公開を指した select の結果が空').toHaveLength(0);

      const all = await request.get(lookUrl('looks', '?select=id,theme,status'), { headers, failOnStatusCode: false });
      const allRows = all.status() === 200 ? await jsonRows(all) : [];
      expect(allRows.filter((row) => row.status !== 'published'), '全件の select に非公開の LOOK が含まれない').toHaveLength(0);
    });
  });

  test('SEC-LOOK-003-AC-02 admin.looks.manage を持つ利用者の aal1 の JWT の looks・look_items への insert・update・delete が、どれも行を変えずに終わる', async ({ request }) => {
    const actor = await aal1Admin();
    expect(actor.aal).toBe('aal1');
    await withFixture('SEC003B', async (fx) => {
      const headers = postgrestHeaders(actor.accessToken);
      const insertTheme = `${fx.tag}-insert`;
      const updatedTheme = `${fx.tag}-updated`;
      const linkBefore = await readLookItems(fx.publishedLookId);
      expect(linkBefore.map((row) => row.item_id), '場面の前の紐づき').toEqual([fx.publishedItemId, fx.privateItemId].sort((a, b) => a - b));

      // JWT 自体は通っている（公開の LOOK を読める）うえで、書く道が閉じていることを確かめる
      const readable = await request.get(lookUrl('looks', `?select=id&id=eq.${fx.publishedLookId}`), { headers, failOnStatusCode: false });
      expect(readable.status(), 'aal1 の JWT で公開の LOOK は読める').toBe(200);
      expect((await jsonRows(readable)).length, 'aal1 の JWT で公開の LOOK は読める（件数）').toBe(1);

      // looks の insert・update・delete
      const insertedLook = await request.post(lookUrl('looks', ''), { headers, data: lookBody(insertTheme, 'private'), failOnStatusCode: false });
      await expectPermissionDenied(insertedLook, 'looks', 'looks の insert');
      const updatedLook = await request.patch(lookUrl('looks', `?id=eq.${fx.publishedLookId}`), { headers, data: { theme: updatedTheme }, failOnStatusCode: false });
      await expectPermissionDenied(updatedLook, 'looks', 'looks の update');
      const deletedLook = await request.delete(lookUrl('looks', `?id=eq.${fx.deleteLookId}`), { headers, failOnStatusCode: false });
      await expectPermissionDenied(deletedLook, 'looks', 'looks の delete');

      // look_items の insert・update・delete
      const insertedLink = await request.post(lookUrl('look_items', ''), {
        headers,
        data: { look_id: fx.publishedLookId, item_id: fx.spareItemId },
        failOnStatusCode: false,
      });
      await expectPermissionDenied(insertedLink, 'look_items', 'look_items の insert');
      const updatedLink = await request.patch(lookUrl('look_items', `?look_id=eq.${fx.publishedLookId}&item_id=eq.${fx.publishedItemId}`), {
        headers,
        data: { created_at: '2000-01-01T00:00:00Z' },
        failOnStatusCode: false,
      });
      await expectPermissionDenied(updatedLink, 'look_items', 'look_items の update');
      const deletedLink = await request.delete(lookUrl('look_items', `?look_id=eq.${fx.publishedLookId}&item_id=eq.${fx.privateItemId}`), {
        headers,
        failOnStatusCode: false,
      });
      await expectPermissionDenied(deletedLink, 'look_items', 'look_items の delete');

      // DB の行が変わっていない
      expect(await readLooks('themes', [insertTheme]), 'insert した LOOK が DB に無い').toHaveLength(0);
      expect(await readLooks('themes', [updatedTheme]), 'update 後のテーマの LOOK が DB に無い').toHaveLength(0);
      expect((await readLooks('ids', [fx.publishedLookId])).map((row) => row.theme), 'update した LOOK のテーマが変わっていない').toEqual([`${fx.tag}-published`]);
      expect((await readLooks('ids', [fx.deleteLookId])).map((row) => row.theme), 'delete した LOOK が DB に残っている').toEqual([`${fx.tag}-delete`]);
      expect(await readLookItems(fx.publishedLookId), 'look_items の insert・update・delete が行を変えていない').toEqual(linkBefore);
    });
  });
});

/** has_table_privilege の結果を「表.権限」の名前で返す（手元の DB の権限の表を直に読む） */
async function tablePrivileges(role: 'anon' | 'authenticated', privileges: readonly string[]): Promise<Record<string, boolean>> {
  return withLocalDb(async (db) => {
    const found: Record<string, boolean> = {};
    for (const table of ['looks', 'look_items']) {
      for (const privilege of privileges) {
        const result = await db.query('select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, privilege]);
        found[`${table}.${privilege}`] = Boolean(result.rows[0].ok);
      }
    }
    return found;
  });
}

function allFalse(privileges: readonly string[]): Record<string, boolean> {
  const expected: Record<string, boolean> = {};
  for (const table of ['looks', 'look_items']) for (const privilege of privileges) expected[`${table}.${privilege}`] = false;
  return expected;
}

test.describe('FR-LOOK-SEC-002 LOOK の表の権限の段', () => {
  test('SEC-LOOK-004-AC-01 anon について looks・look_items の INSERT・UPDATE・DELETE・TRUNCATE の権限が全部 false で、anon の書き込みが RLS ではなく権限の誤りで断られる', async ({ request }) => {
    requireLocalEnv();
    const privileges = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
    expect(await tablePrivileges('anon', privileges), 'anon の権限（has_table_privilege）が全部 false').toEqual(allFalse(privileges));

    // HTTP でも確かめる。権限を外した表は「permission denied for table」、権限が残って RLS だけが断る表は
    // 「new row violates row-level security policy」か 0 件の 200 になるので、権限の段が閉じているかを区別できる。
    // 存在しない id を指すので、権限が残っていても行は変わらない。
    const headers = postgrestHeaders(ANON_KEY);
    const writes = [
      { label: 'looks の insert', send: () => request.post(lookUrl('looks', ''), { headers, data: lookBody(tag('SEC004'), 'private'), failOnStatusCode: false }) },
      { label: 'looks の update', send: () => request.patch(lookUrl('looks', '?id=eq.-1'), { headers, data: { theme: 'x' }, failOnStatusCode: false }) },
      { label: 'looks の delete', send: () => request.delete(lookUrl('looks', '?id=eq.-1'), { headers, failOnStatusCode: false }) },
      { label: 'look_items の insert', send: () => request.post(lookUrl('look_items', ''), { headers, data: { look_id: -1, item_id: -1 }, failOnStatusCode: false }) },
      { label: 'look_items の update', send: () => request.patch(lookUrl('look_items', '?look_id=eq.-1'), { headers, data: { created_at: '2000-01-01T00:00:00Z' }, failOnStatusCode: false }) },
      { label: 'look_items の delete', send: () => request.delete(lookUrl('look_items', '?look_id=eq.-1'), { headers, failOnStatusCode: false }) },
    ];
    for (const write of writes) {
      const response = await write.send();
      const body = await jsonObject(response);
      expect([401, 403], `${write.label}: 権限の誤りの状態（実際: ${response.status()}）`).toContain(response.status());
      expect(body.code, `${write.label}: SQLSTATE`).toBe('42501');
      expect(String(body.message), `${write.label}: 権限の誤りの文（RLS の誤りではない）`).toMatch(/^permission denied for table (looks|look_items)$/);
    }
  });

  test('SEC-LOOK-004-AC-02 authenticated について looks・look_items の TRUNCATE・TRIGGER・REFERENCES の権限が全部 false', async () => {
    requireLocalEnv();
    // この 3 つの権限は PostgREST の道が無い（TRUNCATE などは HTTP で届かない）ので、権限の表だけを見る
    const privileges = ['TRUNCATE', 'TRIGGER', 'REFERENCES'] as const;
    expect(await tablePrivileges('authenticated', privileges)).toEqual(allFalse(privileges));
  });
});

test.describe('FR-LOOK-SEC-002 LOOK の画像の置き場の設定', () => {
  // 見本の SQL（supabase/seed.sql）は置き場を (id, name, public) だけで入れ、大きさと種類の上限を入れない（ON CONFLICT DO NOTHING）。
  // 手元の DB で上限が 5MB と 4 種類になっているなら、それは移行 sec_storage_buckets が置いたもの（ADR-0164）。
  test('SEC-LOOK-005-AC-01 置き場 look-images が非公開で、大きさの上限が 5MB、種類の上限が JPEG・PNG・WebP・GIF の4つで、移行がその設定を持つ', async () => {
    requireLocalEnv();
    const bucket = await withLocalDb(async (db) => {
      const result = await db.query(`select public, file_size_limit::text as file_size_limit, allowed_mime_types from storage.buckets where id = 'look-images'`);
      return result.rows;
    });
    expect(bucket, '置き場 look-images の行がある').toHaveLength(1);
    expect(bucket[0].public, 'public が false').toBe(false);
    expect(Number(bucket[0].file_size_limit), '大きさの上限が 5MB').toBe(5 * 1024 * 1024);
    expect([...((bucket[0].allowed_mime_types as string[] | null) ?? [])].sort(), '種類の上限が4つの画像の種類').toEqual(
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
    );
  });
});

test.describe('FR-LOOK-SEC-002 LOOK の画像の置き場の公開の URL', () => {
  test('SEC-LOOK-005-AC-02 公開の URL /storage/v1/object/public/look-images/<道筋> で LOOK の画像を開くと、画像が返らない（4xx）', async ({ request }) => {
    requireLocalEnv();
    // 対照: 同じ道筋の画像は置き場にあり、service role なら取れる（4xx が「画像が無い」ためではないという確かめ）
    const present = await request.get(`${SUPABASE_URL}/storage/v1/object/authenticated/look-images/${SEEDED_LOOK_IMAGE}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      failOnStatusCode: false,
    });
    expect(present.status(), 'service role なら見本の LOOK の画像が取れる（global-setup が置いた画像）').toBe(200);

    const response = await request.get(`${SUPABASE_URL}/storage/v1/object/public/look-images/${SEEDED_LOOK_IMAGE}`, { failOnStatusCode: false });
    expect(response.status(), `公開の URL の状態（実際: ${response.status()}）`).toBeGreaterThanOrEqual(400);
    expect(response.status(), `公開の URL の状態（実際: ${response.status()}）`).toBeLessThan(500);
    expect(response.headers()['content-type'] ?? '', '画像が返らない').not.toMatch(/^image\//);
  });
});

test.describe('FR-LOOK-SEC-002 anon が検索の RPC を直接叩く', () => {
  test('SEC-LOOK-010-AC-02 anon の鍵で search_public_looks を呼ぶと、権限の誤りか関数が無い誤りで断られる', async ({ request }) => {
    requireLocalEnv();
    const response = await request.post(`${SUPABASE_URL}/rest/v1/rpc/search_public_looks`, {
      headers: postgrestHeaders(ANON_KEY),
      data: { p_query: 'E2E', p_limit: 6 },
      failOnStatusCode: false,
    });
    const status = response.status();
    const body = await jsonObject(response);
    // 権限の誤りは 401・403（SQLSTATE 42501）、関数が無い誤りは 404（PostgREST の PGRST202）
    const deniedByPermission = (status === 401 || status === 403) && body.code === '42501';
    const missingFunction = status === 404 && body.code === 'PGRST202';
    expect(deniedByPermission || missingFunction, `権限の誤りでも関数が無い誤りでもない（status: ${status}, code: ${String(body.code)}）`).toBe(true);
  });
});

test.describe('FR-LOOK-SEC-002 表の段の CHECK', () => {
  test('SEC-LOOK-023-AC-01 service role の201字のテーマの insert と image_urls が other/x.png の insert が、どちらも CHECK の違反（23514）で断られ、行が増えない', async ({ request }) => {
    requireLocalEnv();
    const id = tag('SEC023');
    const longTheme = `${id}-long`.padEnd(201, 'x');
    const outsideTheme = `${id}-outside`;
    expect(longTheme).toHaveLength(201);
    const serviceHeaders = postgrestHeaders(SERVICE_KEY, SERVICE_KEY);

    try {
      const tooLong = await request.post(lookUrl('looks', ''), { headers: serviceHeaders, data: lookBody(longTheme, 'private'), failOnStatusCode: false });
      expect(tooLong.status(), '201字のテーマの insert の状態').toBe(400);
      expect((await jsonObject(tooLong)).code, '201字のテーマの insert の SQLSTATE（CHECK の違反）').toBe('23514');
      expect(await readLooks('themes', [longTheme]), '201字のテーマの行が増えない').toHaveLength(0);

      const outside = await request.post(lookUrl('looks', ''), { headers: serviceHeaders, data: lookBody(outsideTheme, 'private', 'other/x.png'), failOnStatusCode: false });
      expect(outside.status(), 'image_urls が other/x.png の insert の状態').toBe(400);
      expect((await jsonObject(outside)).code, 'image_urls が other/x.png の insert の SQLSTATE（CHECK の違反）').toBe('23514');
      expect(await readLooks('themes', [outsideTheme]), 'image_urls が other/x.png の行が増えない').toHaveLength(0);
    } finally {
      await withLocalDb((db) => db.query('delete from public.looks where theme like $1', [`${id}%`]));
    }
  });
});
