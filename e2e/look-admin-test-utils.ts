/**
 * 管理画面の LOOK の E2E の道具。本物の管理者（admin.looks.manage を持つ店長、aal2）の画面を、手元の Supabase の上で開く。
 *
 * 手元の Supabase は2要素（TOTP）が無効で、管理画面のログインは通れない。そこで次の道を使う。
 * 1. admin-session-test-utils.ts で、aal2 の JWT を持つ店長の利用者を手元の Auth と DB に作る
 * 2. アプリが読む印の Cookie（sb-access-token）にその JWT を入れて、ブラウザの文脈に足す
 *    アプリ・窓口は本物のまま動く。JWT の検証・session の生存確認・DB の ACL・aal2 の確認は全部通る
 * 作った LOOK・置き場の画像は、テーマの前方一致で見つけて消す（失敗しても残さない）。作った利用者は消さない（db reset で消える）。
 * この道具を呼ぶ spec は、ファイルの最上位に `test.use({ trace: 'off' })` が必須。JWT の Cookie が通信記録に残るため。
 */
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import type { BrowserContext, Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { accessCookieName } from '../src/lib/cookie';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

const LOOK_IMAGES_BUCKET = 'look-images';
/** 並び順の最後に置く日付。他の spec が「最初の LOOK」を選ぶ並びに、この道具の LOOK を入れない */
const SINK_DATE = '2000-01-01T00:00:00Z';
/** この道具が試験ごとに上げる画像の置き場所。見本の画像（looks/e2e/）と分け、後始末とアプリの削除が見本を消さないようにする */
const FIXTURE_IMAGE_FOLDER = 'looks/e2e-fixture';

/** 店長（admin.looks.manage・admin.looks.read・admin.items.manage を持つ）の aal2 の利用者を作る */
export async function createLookAdmin(): Promise<AdminSessionActor> {
  return withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
}

/** ブラウザの文脈を、その店長のログイン済みにする。以後 /admin・/admin/look/* と /api/admin/* が本物の認可で通る */
export async function signInAsLookAdmin(context: BrowserContext, actor: AdminSessionActor, baseURL: string): Promise<void> {
  await context.addCookies([
    { name: accessCookieName, value: actor.accessToken, url: baseURL, httpOnly: true, sameSite: 'Lax' },
  ]);
}

/**
 * この試験のページの要求を、この試験だけの送り元の住所（x-real-ip）で送る。
 * 管理の LOOK の窓口の回数の制限は送り元ごとにも数えるので、他の spec と同じ住所で数えて巻き込まれないようにする。
 * 回数の制限の鍵は getClientIp（ADR-0416）が信じる見出しだけから取る。E2E の固定の環境が CLIENT_IP_HEADER を立てるので x-real-ip を読む
 * （x-forwarded-for は読まない。FR-SEARCH-018 と同じ分け方）。
 */
export async function useOwnClientAddress(page: Page): Promise<void> {
  const [a, b, c] = randomBytes(3);
  await page.setExtraHTTPHeaders({ 'x-real-ip': `10.${a}.${b}.${c}` });
}

/** 画像の作り方: 試験の中で 1×1 の PNG を組み立てる（リポジトリに画像ファイルを置かない） */
export function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // 幅
  header.writeUInt32BE(1, 4); // 高さ
  header[8] = 8; // 1 色 8 ビット
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x40, 0x40, 0x40]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function assertThemePrefix(prefix: string): void {
  // LIKE の記号（% と _）を含めない。前方一致で他の LOOK まで消さないため
  if (!/^[A-Za-z0-9-]{12,}$/.test(prefix)) throw new Error('テーマの前方一致の印は英数字とハイフンの12文字以上にしてください');
}

function localStorageApi() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('置き場の画像を扱えるのは手元の Supabase だけ');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(LOOK_IMAGES_BUCKET);
}

/**
 * この試験だけの画像を置き場（looks/e2e-fixture/<name>.png）に上げて、その道筋を返す。
 * 見本の画像（looks/e2e/look-1-1.png）を行が指すと、purgeLooksByThemePrefix やアプリの削除が見本を消して他の試験が赤になる。
 * 上げた画像は purgeLooksByThemePrefix が（行が指していれば）消す。
 */
export async function uploadFixtureLookImage(name: string): Promise<string> {
  assertThemePrefix(name);
  const imagePath = `${FIXTURE_IMAGE_FOLDER}/${name}.png`;
  const uploaded = await localStorageApi().upload(imagePath, tinyPng(), { contentType: 'image/png', upsert: true });
  if (uploaded.error) throw new Error('試験用の画像を置き場に上げられなかった');
  return imagePath;
}

/**
 * 非公開の LOOK を DB に直に作る（編集・削除の試験の材料）。商品1を紐づけ、画像はこの LOOK だけの画像（uploadFixtureLookImage）を指す。
 * 並びの最後に置く（created_at = 2000-01-01）。返すのは作った LOOK の id。
 */
export async function insertPrivateLook(theme: string): Promise<number> {
  assertThemePrefix(theme);
  const imagePath = await uploadFixtureLookImage(theme);
  return withLocalDb(async (db) => {
    const created = await db.query(
      `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at)
       values (2026, 'SS', $1, 'E2E fixture', array[$3::text], 'private', $2::timestamptz, $2::timestamptz)
       returning id`,
      [theme, SINK_DATE, imagePath],
    );
    const id = Number(created.rows[0].id);
    await db.query('insert into public.look_items (look_id, item_id) values ($1, 1)', [id]);
    return id;
  });
}

/** テーマが一致する LOOK の id（ちょうど1件でなければ失敗） */
export async function lookIdByTheme(theme: string): Promise<number> {
  return withLocalDb(async (db) => {
    const res = await db.query('select id from public.looks where theme = $1', [theme]);
    if (res.rowCount !== 1) throw new Error(`テーマ ${theme} の LOOK が ${res.rowCount} 件ある（1件のはず）`);
    return Number(res.rows[0].id);
  });
}

/** テーマが一致する LOOK の数 */
export async function countLooksByTheme(theme: string): Promise<number> {
  return withLocalDb(async (db) => {
    const res = await db.query('select count(*)::int as n from public.looks where theme = $1', [theme]);
    return Number(res.rows[0].n);
  });
}

/** LOOK の公開の一覧（/look）で他の spec の「最初の LOOK」にならないよう、並びの最後へ送る */
export async function sinkLook(id: number): Promise<void> {
  await withLocalDb((db) =>
    db.query('update public.looks set created_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1', [id, SINK_DATE]),
  );
}

/**
 * テーマが前方一致する LOOK（と商品のつながり）を DB から消し、行が指す置き場の画像（looks/ 配下）も消す。
 * 見本の画像（looks/e2e/ 配下）は、行が指していても消さない（他の試験が読む）。
 */
export async function purgeLooksByThemePrefix(prefix: string): Promise<void> {
  assertThemePrefix(prefix);
  const paths = await withLocalDb(async (db) => {
    const found = await db.query('select id, image_urls from public.looks where theme like $1', [`${prefix}%`]);
    const ids = found.rows.map((row) => Number(row.id));
    if (ids.length > 0) {
      await db.query('delete from public.look_items where look_id = any($1::bigint[])', [ids]);
      await db.query('delete from public.looks where id = any($1::bigint[])', [ids]);
    }
    const own = found.rows.flatMap((row) =>
      (row.image_urls as string[]).filter((p) => p.startsWith('looks/') && !p.startsWith('looks/e2e/')),
    );
    return [...new Set(own)];
  });
  if (paths.length === 0) return;
  const removed = await localStorageApi().remove(paths);
  if (removed.error) throw new Error('作った LOOK の置き場の画像を消せなかった');
}
