/**
 * ホームの E2E の道具（FR-HOME-023 が使う）。手元の DB（E2E_LOCAL_DB_URL）と手元の Supabase の Auth だけを使う。
 *
 * - 下書き（status='private'）の商品・LOOK・NEWS・取扱店を、ホームの先頭に出る位置で入れる。
 *   漏れがあれば先頭に出るので、「出ない」ことの確かめが空振りにならない。
 * - 公開の商品・NEWS は、見本（supabase/seed.sql）でいちばん新しい日付（商品 2026-06-07 12:00・NEWS 2026-05-14）より
 *   古い日付で入れる。「いちばん新しい商品」を決め打ちする他の試験（検索・購入）の先頭を動かさないため。
 * - 管理者の session は、Google OAuth のログインが付ける Cookie（sb-<ref>-auth-token）と同じ形で用意する。
 *   メールとパスワードのログインは sb-access-token だけを付け、ホームの読みが anon の権限のまま動くので使えない。
 *   session は aal2（admin-session-test-utils の createAdminSessionActor が amr に totp を足して refresh する）で作る。
 * - 公開の行を足し引きする試験と、公開の総数・並びを読む試験は、withHomeCatalogLock（DB の advisory lock）でファイルをまたいで
 *   直列にする。ホームは新しい順の先頭 8 件しか描かないので、同時に足すと押し出されて前提が落ちる。
 * - 足した行は呼び出し側が withLocalDb の finally で deleteHomeRows に渡して消す。在庫を入れた下書きの商品は
 *   台帳（削除禁止）に残るので消せず、非公開のまま残る（db reset で消える）。
 * 手元の DB・手元の Supabase 以外では動かさない。JWT・パスワードは失敗の文面に出さない。
 */
import { randomUUID } from 'node:crypto';
import { createServerClient } from '@supabase/ssr';
import { createClient, type Session } from '@supabase/supabase-js';
import { expect } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, toSupabaseSession } from './admin-session-test-utils';
import { assertLocalE2eDb, seedE2eRestock } from './group-g1-test-utils';
import { withLocalDb } from './order-email-test-utils';

export { withLocalDb };

/** 手元の Storage に global-setup が置く見本の画像（署名できる本物の置き場の道筋） */
export const SEEDED_ITEM_IMAGE = 'e2e/item-3-1.png';
/** 公開の商品を入れる日付。見本のいちばん新しい商品（2026-06-07 12:00）より古く、2番目（2026-06-06 12:00）より新しい */
export const PUBLISHED_ITEM_TOP_AT = '2026-06-07T11:00:00Z';
/** 公開の NEWS を入れる日付。見本のいちばん新しい NEWS（2026-05-14）の次に新しい */
export const PUBLISHED_NEWS_DATE = '2026-05-13';

export function homeTag(label: string): string {
  return `E2E-HOME-${label}-${randomUUID().slice(0, 8)}`;
}

/** ホームの公開の行（商品・LOOK・NEWS・取扱店）の足し引きと、その総数・並びの読みを直列にする advisory lock の鍵（他の spec の鍵とは別） */
const HOME_CATALOG_LOCK = '240925, 1';

/**
 * ホームの公開の行を足し引きする試験は 'exclusive'、公開の総数・並びを読んで比べる試験は 'shared' で包む。
 * shared どうしは待たず、exclusive とは重ならない。専用の接続で session lock を取り、終わりに外す（接続を閉じても外れる）。
 * 待つ間は試験の時間を使うので、呼ぶ試験は test.setTimeout を長めにする。
 */
export async function withHomeCatalogLock<T>(mode: 'exclusive' | 'shared', run: () => Promise<T>): Promise<T> {
  return withLocalDb(async (lockDb) => {
    assertLocalE2eDb(lockDb);
    const [lock, unlock] =
      mode === 'exclusive'
        ? ['pg_catalog.pg_advisory_lock', 'pg_catalog.pg_advisory_unlock']
        : ['pg_catalog.pg_advisory_lock_shared', 'pg_catalog.pg_advisory_unlock_shared'];
    await lockDb.query(`select ${lock}(${HOME_CATALOG_LOCK})`);
    try {
      return await run();
    } finally {
      await lockDb.query(`select ${unlock}(${HOME_CATALOG_LOCK})`);
    }
  });
}

export type HomeRows = { itemIds: number[]; lookIds: number[]; newsIds: number[]; stockistIds: number[] };

export function emptyHomeRows(): HomeRows {
  return { itemIds: [], lookIds: [], newsIds: [], stockistIds: [] };
}

export type DraftNames = { item: string; look: string; news: string; stockist: string };

/**
 * 下書きの商品・LOOK・NEWS・取扱店を1件ずつ入れる。どれもホームの並びの先頭に出る位置
 * （商品・LOOK は今の時刻、NEWS は見本の最新より新しい日、取扱店は番号が最小）にする。
 */
export async function insertDraftContent(db: PgClient, rows: HomeRows, tag: string): Promise<DraftNames> {
  assertLocalE2eDb(db);
  const names: DraftNames = { item: `${tag}-draft-item`, look: `${tag}-draft-look`, news: `${tag}-draft-news`, stockist: `${tag}-draft-stockist` };

  const item = await db.query(
    `insert into public.items (name, description, price, category, image_url, status)
     values ($1, 'E2E home draft', 12000, 'TOPS', $2, 'private') returning id`,
    [names.item, SEEDED_ITEM_IMAGE],
  );
  rows.itemIds.push(Number(item.rows[0].id));

  const look = await db.query(
    `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status)
     values (2027, 'AW', $1, 'E2E home draft', ARRAY[]::text[], 'private') returning id`,
    [names.look],
  );
  rows.lookIds.push(Number(look.rows[0].id));

  const news = await db.query(
    `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
     values ($1, 'EVENT', '2026-05-15', 'e2e/news-1.png', 'E2E home draft', 'E2E home draft', 'private') returning id`,
    [names.news],
  );
  rows.newsIds.push(Number(news.rows[0].id));

  // 取扱店は番号の昇順で6件まで出る。負の番号なら、漏れた時に先頭へ出る
  const stockistId = -(Math.floor(Math.random() * 2_000_000_000) + 1);
  await db.query(
    `insert into public.stockists (id, type, name, address, phone, time, holiday, status)
     values ($1, 'STORE', $2, '東京都港区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'private')`,
    [stockistId, names.stockist],
  );
  rows.stockistIds.push(stockistId);
  return names;
}

/** 公開の商品を1件入れる。createdAt は見本の最新（2026-06-07 12:00）より前の日時にする */
export async function insertPublishedItem(
  db: PgClient,
  rows: HomeRows,
  input: { name: string; imageUrl: string; createdAt: string },
): Promise<void> {
  assertLocalE2eDb(db);
  const result = await db.query(
    `insert into public.items (name, description, price, category, image_url, image_urls, status, created_at)
     values ($1, 'E2E home published', 12000, 'TOPS', $2, ARRAY[]::text[], 'published', $3::timestamptz) returning id`,
    [input.name, input.imageUrl, input.createdAt],
  );
  rows.itemIds.push(Number(result.rows[0].id));
}

/** 公開の NEWS を1件入れる */
export async function insertPublishedNews(db: PgClient, rows: HomeRows, input: { title: string; publishedDate: string }): Promise<void> {
  assertLocalE2eDb(db);
  const result = await db.query(
    `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
     values ($1, 'EVENT', $2::date, 'e2e/news-1.png', 'E2E home published', 'E2E home published', 'published') returning id`,
    [input.title, input.publishedDate],
  );
  rows.newsIds.push(Number(result.rows[0].id));
}

/** 下書きの商品を、在庫つきで入れる（本物の入荷の入口を通す）。商品の名前を返す */
export async function insertDraftItemWithStock(db: PgClient, rows: HomeRows, stock: number): Promise<string> {
  assertLocalE2eDb(db);
  const fixture = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
  rows.itemIds.push(fixture.itemId);
  await seedE2eRestock(db, { itemId: fixture.itemId, variantId: fixture.variantId, quantity: stock });
  const named = await db.query('select name from public.items where id = $1', [fixture.itemId]);
  return String(named.rows[0].name);
}

export async function countPublishedItems(db: PgClient): Promise<number> {
  const result = await db.query(`select count(*)::int as n from public.items where status = 'published'`);
  return Number(result.rows[0].n);
}

/** 足した行を消す。在庫の台帳が残る商品は消せないので、その失敗だけは飲み込む（非公開のまま残る） */
export async function deleteHomeRows(db: PgClient, rows: HomeRows): Promise<void> {
  assertLocalE2eDb(db);
  await db.query('delete from public.look_items where look_id = any($1::bigint[])', [rows.lookIds]);
  await db.query('delete from public.looks where id = any($1::bigint[])', [rows.lookIds]);
  await db.query('delete from public.news_articles where id = any($1::bigint[])', [rows.newsIds]);
  await db.query('delete from public.stockists where id = any($1::bigint[])', [rows.stockistIds]);
  for (const itemId of rows.itemIds) {
    try {
      await db.query('delete from public.items where id = $1', [itemId]);
    } catch {
      // 台帳（stock_movements）が残る商品は削除禁止。非公開のまま残る
    }
  }
}

// ---- 管理者の session（Google OAuth の Cookie と同じ形） ----

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
// @supabase/ssr が Cookie を分ける時の 1 つの大きさ
const COOKIE_CHUNK_SIZE = 3180;
const createdUserIds: string[] = [];
let adminSessionPromise: Promise<Session> | null = null;

export function supabaseEnv(): { url: string; anonKey: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !anonKey || !serviceKey || !isLocalUrl(url)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
  return { url, anonKey, serviceKey };
}

/**
 * 役割 admin（admin.items.read・admin.stockists.read を持つ）の aal2 の session を返す。
 * 管理 API の試験と同じ道具（createAdminSessionActor）で、パスワードのログインの session に totp の印を足して refresh する。
 * worker ごとに1回だけ作る（ログインの回数の制限を使い切らない）。
 */
export function homeAdminSession(): Promise<Session> {
  adminSessionPromise ??= (async () => {
    supabaseEnv();
    const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
    createdUserIds.push(actor.userId);
    return toSupabaseSession(actor);
  })().catch((error: unknown) => {
    adminSessionPromise = null;
    throw error;
  });
  return adminSessionPromise;
}

/** 作った管理者を消す（消せなくても db reset で消える） */
export async function deleteHomeAdminUsers(): Promise<void> {
  // ファイルの afterAll は組の終わりごとに走る。消した利用者の session を同じ worker の次の組で使い回さない
  adminSessionPromise = null;
  if (createdUserIds.length === 0) return;
  const env = supabaseEnv();
  const admin = createClient(env.url, env.serviceKey, clientOptions);
  for (const userId of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}

/** Google OAuth のログインが付ける @supabase/ssr の認証 Cookie と同じ形（base64- + base64url の session、長ければ .N に分ける） */
export function authCookies(baseURL: string, session: Session): Array<{ name: string; value: string; url: string; sameSite: 'Lax' }> {
  const ref = new URL(supabaseEnv().url).hostname.split('.')[0];
  const name = `sb-${ref}-auth-token`;
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  if (encoded.length <= COOKIE_CHUNK_SIZE) return [{ name, value: encoded, url: baseURL, sameSite: 'Lax' }];
  const cookies: Array<{ name: string; value: string; url: string; sameSite: 'Lax' }> = [];
  for (let i = 0; i * COOKIE_CHUNK_SIZE < encoded.length; i += 1) {
    cookies.push({ name: `${name}.${i}`, value: encoded.slice(i * COOKIE_CHUNK_SIZE, (i + 1) * COOKIE_CHUNK_SIZE), url: baseURL, sameSite: 'Lax' });
  }
  return cookies;
}

/**
 * 管理者の Cookie が、サーバーの cookie 方式の client（@/lib/supabase/server の createServerClient）と同じ読み方で
 * 管理者の session として読め、その client が RLS で下書きの商品・取扱店の行まで読めること。
 * 「出ない」「同じ」の確かめが、サーバーが Cookie の形を読めず anon のまま動いて通る空振りになっていないことの前提。
 * （ホームの画面そのものは管理者かどうかを出さないので、ここでは同じライブラリ・同じ読み方で Cookie を解いて確かめる）
 */
export async function expectCookieSessionActsAsAdmin(
  cookies: Array<{ name: string; value: string }>,
  session: Session,
  names: DraftNames,
): Promise<void> {
  const env = supabaseEnv();
  // サーバー側（server.ts）と同じく Cookie ヘッダーを name=value に分け、値を URL デコードして getAll で渡す
  const header = cookies.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; ');
  const client = createServerClient(env.url, env.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    cookies: {
      getAll() {
        return header.split(';').flatMap((pair) => {
          const trimmed = pair.trim();
          const eq = trimmed.indexOf('=');
          return eq > 0 ? [{ name: trimmed.slice(0, eq), value: decodeURIComponent(trimmed.slice(eq + 1)) }] : [];
        });
      },
      setAll() {
        // 読むだけ
      },
    },
  });
  const user = await client.auth.getUser();
  // 読めなかった時に、GoTrue が返した理由（利用者の削除・session の失効・回数の制限など）を残す
  const reason = user.error ? `${user.error.status ?? '-'} ${user.error.code ?? user.error.message}` : '-';
  expect(user.data.user?.id, `Cookie の session が管理者の利用者として読める（GoTrue: ${reason}）`).toBe(session.user.id);
  const readable = [
    { table: 'items', name: names.item },
    { table: 'stockists', name: names.stockist },
  ] as const;
  for (const { table, name } of readable) {
    const result = await client.from(table).select('id').eq('name', name);
    expect(result.error, `Cookie の client で ${table} を読める`).toBeNull();
    expect(result.data?.length, `前提: Cookie の client は管理者の権限で下書きの ${table} の行を読める`).toBe(1);
  }
}

// ---- ホームの HTML の読み取り ----

export type SignedImageToken = { path: string; exp: number };

/** 署名つき URL（またはそれを含む文字列）の token から、置き場の道筋と期限（秒）を読む。token が無ければ null */
export function readSignedToken(text: string): SignedImageToken | null {
  const match = /token(?:=|%3D)(eyJ[\w-]+\.[\w-]+\.[\w-]+)/.exec(text);
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')) as { url?: unknown; exp?: unknown };
    if (typeof payload.url !== 'string' || typeof payload.exp !== 'number') return null;
    return { path: payload.url, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * <img src> の値から、元の画像の住所を取り出す。next/image の変換（/_next/image?url=…）なら url の引数、
 * そうでなければ src そのもの。
 */
export function originalImageUrl(src: string, baseURL: string): string {
  try {
    const parsed = new URL(src, baseURL);
    return parsed.pathname === '/_next/image' ? (parsed.searchParams.get('url') ?? src) : src;
  } catch {
    return src;
  }
}

/** ホームの HTML の中の、LOOK の関連商品の画像の住所（RSC の中の imageUrl の値）。引用符の逃がしの有無は問わない */
export function linkedItemImageUrls(html: string): string[] {
  return Array.from(html.matchAll(/imageUrl\\*":\\*"([^"\\]*)/g), (match) => match[1]);
}

/** ホームの HTML に、クライアントの部品へ渡った商品の記録（madeToOrder を持つ商品の DTO）が何件あるか */
export function countItemRecords(html: string): number {
  return (html.match(/madeToOrder\\*":(?:true|false)/g) ?? []).length;
}

/** ホームの HTML に、商品のカードが何枚あるか */
export function countItemCards(html: string): number {
  return (html.match(/data-testid="item-card-link"/g) ?? []).length;
}

/** HTML に在庫の数が単独の数として含まれるか（token・番号の一部の数字を除くため、前後が英数字・_・- でない場合だけ数える） */
export function containsStandaloneNumber(html: string, value: number): boolean {
  return new RegExp(`(?<![0-9A-Za-z_-])${value}(?![0-9A-Za-z_-])`).test(html);
}
