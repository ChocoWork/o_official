/**
 * ホームに出る商品の表（items）と原価の履歴の表（item_cost_history）の権限の E2E の道具。FR-HOME-024 が使う。
 *
 * 手元の Supabase の PostgREST（NEXT_PUBLIC_SUPABASE_URL/rest/v1）を、anon の鍵・一般会員の JWT・管理者の aal1 の JWT で直接叩く。
 * 手元の DB への足し込みは pg で行う。足した行は呼び出し側の finally で消す。JWT・パスワードは失敗の文面に出さない。
 * 作った利用者は消さない（db reset で消える）。deleteHomeGrantUsers で消せるものは消す。
 *
 * 公開の商品は、見本のいちばん新しい商品の直後（PUBLISHED_ITEM_TOP_AT）の日時で入れる。ホームは新しい順の先頭 8 件しか描かないので、
 * 「ホームの ITEM の節に出る」前提を落とさないため。いちばん新しい商品は奪わない。公開の行を足す試験は、
 * home-test-utils の withHomeCatalogLock('exclusive') で包み、ほかの HOME の試験が同時に足して押し出さないようにする。
 * 下書きの商品はホームに出ないので created_at は遠い過去にする。
 * 画像は seed の公開の商品の物を写す（ホームの画像の署名・next/image の許可を通すため）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, type APIResponse, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { PUBLISHED_ITEM_TOP_AT } from './home-test-utils';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const HOME_ITEM_NAME = '#items [data-testid="item-name"]';

export const COST_VALUES = { pattern: 98765, massProduction: 87654 } as const;

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

export function requireLocalSupabase(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

export function uniqueTag(label: string): string {
  return `E2E-HOME-GRANT-${label}-${randomUUID().slice(0, 8)}`;
}

export type HomeGrantItem = {
  id: number;
  name: string;
  note: string;
};

/** 原価と注記が入った商品を足す。name・product_note は一意の印つき。公開は見本の最新の直後、下書きは遠い過去の created_at */
export async function seedHomeItem(db: PgClient, label: string, status: 'published' | 'private'): Promise<HomeGrantItem> {
  const name = uniqueTag(label);
  const note = `${name}-internal-note`;
  const image = await db.query(
    `select image_url, image_urls from public.items where status = 'published' and image_url <> '' order by id limit 1`,
  );
  if (image.rows.length !== 1) throw new Error('画像を写す公開の商品が手元の DB に無い（seed.sql を入れる）');
  const inserted = await db.query(
    `insert into public.items (name, description, price, category, image_url, image_urls, status,
                               pattern_cost, mass_production_cost, product_note, created_at)
     values ($1, 'E2E 権限の試験用', 1000, 'TOPS', $2, $3::text[], $4, $5, $6, $7, $8::timestamptz)
     returning id`,
    [
      name,
      image.rows[0].image_url,
      image.rows[0].image_urls,
      status,
      COST_VALUES.pattern,
      COST_VALUES.massProduction,
      note,
      status === 'published' ? PUBLISHED_ITEM_TOP_AT : '2016-01-01T00:00:00Z',
    ],
  );
  return { id: Number(inserted.rows[0].id), name, note };
}

export type CostHistorySeed = { id: number; seasonKey: string; patternCost: number; massProductionCost: number; pdfUrl: string };

export const COST_HISTORY_VALUES = { pattern: 1357911, massProduction: 2468102 } as const;

/** 原価の履歴の行を足す（item_id の外部キーは ON DELETE CASCADE なので、商品を消せば一緒に消える） */
export async function seedCostHistory(db: PgClient, itemId: number, label: string): Promise<CostHistorySeed> {
  const seasonKey = uniqueTag(`${label}-season`);
  const pdfUrl = `https://example.com/${seasonKey}.pdf`;
  const inserted = await db.query(
    `insert into public.item_cost_history (item_id, season_key, pattern_cost, mass_production_cost, pdf_url)
     values ($1, $2, $3, $4, $5) returning id`,
    [itemId, seasonKey, COST_HISTORY_VALUES.pattern, COST_HISTORY_VALUES.massProduction, pdfUrl],
  );
  return {
    id: Number(inserted.rows[0].id),
    seasonKey,
    patternCost: COST_HISTORY_VALUES.pattern,
    massProductionCost: COST_HISTORY_VALUES.massProduction,
    pdfUrl,
  };
}

/** 足した商品と、場面の中で作られうる名前・季節の印の行を消す（原価の履歴は商品の削除で一緒に消える） */
export async function cleanupHomeRows(
  db: PgClient,
  itemIds: number[],
  extra: { itemNames?: string[]; seasonKeys?: string[] } = {},
): Promise<void> {
  await db.query('delete from public.item_cost_history where item_id = any($1::bigint[]) or season_key = any($2::text[])', [
    itemIds,
    extra.seasonKeys ?? [],
  ]);
  await db.query('delete from public.items where id = any($1::bigint[]) or name = any($2::text[])', [itemIds, extra.itemNames ?? []]);
}

export type MemberActor = { userId: string; accessToken: string };

const createdUserIds: string[] = [];

/** 一般会員（role=user、user_roles なし）を作り、パスワードのログインで得た aal1 の JWT を返す */
export async function createMemberActor(): Promise<MemberActor> {
  requireLocalSupabase();
  const email = `e2e-home-grant-member-${randomUUID().slice(0, 8)}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
  const created = await admin.auth.admin
    .createUser({ email, password, email_confirm: true, app_metadata: { role: 'user' } })
    .catch(() => {
      throw new Error('手元の一般会員を作る要求に失敗した');
    });
  if (created.error || !created.data.user) {
    throw new Error(`手元の一般会員を作れない（status: ${created.error?.status ?? '不明'}）`);
  }
  const userId = created.data.user.id;
  createdUserIds.push(userId);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    // 呼ぶごとに別の送り元として数えさせる（admin-session-test-utils の uniqueSourceIp と同じ注記。x-forwarded-for を送り元に数える作りに頼る分離で、効かなくなっても害は無い）
    headers: { apikey: ANON_KEY, 'content-type': 'application/json', 'x-forwarded-for': `10.${[...randomBytes(3)].join('.')}` },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error('手元の Auth のパスワードのログインの要求に失敗した');
  });
  if (!res.ok) throw new Error(`手元の Auth のパスワードのログインが通らない: ${res.status}`);
  const reply = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!reply.access_token) throw new Error('手元の Auth の応答に access_token が無い');
  const claims = JSON.parse(Buffer.from(reply.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { aal?: string; sub?: string };
  if (claims.sub !== userId || claims.aal !== 'aal1') throw new Error('作った JWT の利用者か aal が合わない');
  return { userId, accessToken: reply.access_token };
}

/** 後始末のため、作った利用者の id を登録する（管理者の aal1 の JWT を作る道具が返す物など） */
export function trackHomeGrantUser(userId: string): void {
  createdUserIds.push(userId);
}

export async function deleteHomeGrantUsers(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
  for (const userId of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}

/** admin ロールに admin.items.read・admin.items.manage を付ける（無い時だけ足す。withPermissionScenario の終わりの差分の戻しで元に戻る） */
export async function ensureAdminItemsPermissions(db: PgClient): Promise<void> {
  const codes = ['admin.items.read', 'admin.items.manage'];
  const have = await db.query(
    `select p.code from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
      where r.code = 'admin' and p.code = any($1::text[])`,
    [codes],
  );
  if (have.rows.length !== codes.length) {
    await db.query(
      `insert into public.role_permissions (role_id, permission_id)
       select r.id, p.id from public.roles r cross join public.permissions p
        where r.code = 'admin' and p.code = any($1::text[])
       on conflict do nothing`,
      [codes],
    );
  }
  const after = await db.query(
    `select count(*)::int as n from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
      where r.code = 'admin' and p.code = any($1::text[])`,
    [codes],
  );
  if (after.rows[0].n !== codes.length) throw new Error('admin ロールに admin.items.read・admin.items.manage を付けられない');
}

export function restHeaders(token: string): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}

export function restUrl(table: string, query = ''): string {
  return `${SUPABASE_URL}/rest/v1/${table}${query}`;
}

export async function jsonRows(response: APIResponse): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** 権限の誤り（401 または 403）で終わったこと。200 で 0 件・204・404（表が無い）は権限の誤りではない */
export function expectPermissionError(response: APIResponse, label: string): void {
  expect([401, 403], `${label}: 権限の誤り（401・403）で終わる（status: ${response.status()}）`).toContain(response.status());
}

/** 応答の本文に、原価・注記の値の印が1つも含まれないこと */
export async function expectNoLeak(response: APIResponse, label: string, secrets: Array<string | number>): Promise<void> {
  const text = await response.text();
  for (const secret of secrets) {
    expect(text.includes(String(secret)), `${label}: 応答に ${String(secret).slice(0, 12)}… の値が含まれない`).toBe(false);
  }
}

/** ホームの ITEM の節に出ている商品の名前（表示順）。節の最初の名前が出るのを待ってから読む */
export async function readHomeItemNames(page: Page): Promise<string[]> {
  await page.goto('/');
  await expect(page.locator(HOME_ITEM_NAME).first()).toBeAttached();
  return page.locator(HOME_ITEM_NAME).allTextContents();
}
